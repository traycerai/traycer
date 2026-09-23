import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { JsonContent } from "@traycer/protocol/common/registry";

// In-memory stand-in for idb-keyval, mirroring landing-image-gc.test.ts. Keyed
// by string hash; the store argument is ignored.
const idbData = vi.hoisted(() => new Map<string, unknown>());

function idbStringKey(key: IDBValidKey): string {
  if (typeof key !== "string") {
    throw new Error("landing image store keys are string hashes");
  }
  return key;
}

vi.mock("idb-keyval", () => {
  const dummyStore = () => Promise.reject(new Error("unused"));
  return {
    createStore: vi.fn(() => dummyStore),
    get: vi.fn((key: string) => Promise.resolve(idbData.get(key))),
    set: vi.fn((key: string, value: unknown) => {
      idbData.set(key, value);
      return Promise.resolve();
    }),
    del: vi.fn((key: string) => {
      idbData.delete(key);
      return Promise.resolve();
    }),
    keys: vi.fn(() => Promise.resolve(Array.from(idbData.keys()))),
  };
});

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { info: vi.fn(), error: vi.fn() }),
}));

function bytesOf(values: readonly number[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(values);
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
  identityId: null,
};

function hashOnlyImageDoc(hash: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: "img-1",
              fileName: "shot.png",
              mimeType: "image/png",
              size: 3,
              byHashEligible: true,
              hash,
            },
          },
        ],
      },
    ],
  };
}

type Modules = {
  readonly gc: typeof import("@/lib/composer/landing-image-gc");
  readonly store: typeof import("@/lib/composer/landing-image-store");
  readonly handoff: typeof import("@/stores/epics/initial-chat-handoff-store");
};

async function loadModules(): Promise<Modules> {
  vi.resetModules();
  idbData.clear();
  Reflect.deleteProperty(globalThis, "runnerHost");
  const idb = await import("idb-keyval");
  vi.mocked(idb.set).mockImplementation((key, value) => {
    idbData.set(idbStringKey(key), value);
    return Promise.resolve();
  });
  vi.mocked(idb.get).mockImplementation((key) =>
    Promise.resolve(idbData.get(idbStringKey(key))),
  );
  vi.mocked(idb.del).mockImplementation((key) => {
    idbData.delete(idbStringKey(key));
    return Promise.resolve();
  });
  vi.mocked(idb.keys).mockImplementation(() =>
    Promise.resolve(Array.from(idbData.keys())),
  );
  const store = await import("@/lib/composer/landing-image-store");
  const gc = await import("@/lib/composer/landing-image-gc");
  const handoff = await import("@/stores/epics/initial-chat-handoff-store");
  handoff.useInitialChatHandoffStore.getState().resetForTests();
  return { gc, store, handoff };
}

let urlCounter = 0;

beforeEach(() => {
  vi.spyOn(URL, "createObjectURL").mockImplementation(
    () => `blob:mock/${++urlCounter}`,
  );
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "runnerHost");
});

describe("landing image GC: pending initial-chat handoff is a root source", () => {
  it("a hash referenced ONLY by a pending handoff survives the reconcile sweep", async () => {
    const m = await loadModules();
    // Browser runtime: readiness flips automatically on the queued microtask
    // from the draft store's module-bottom hook, which landing-image-store's
    // import chain does not itself pull in here - flip it directly since this
    // test is scoped to the handoff root source, not the landing draft store.
    m.gc.markLandingDraftsReady();
    await flush();

    const hash = await m.store.putImage(bytesOf([9, 9, 9]));
    // Nothing else references this hash: no draft, no live runtime mirror.
    // The pending handoff is the ONLY thing keeping it alive.
    m.handoff.useInitialChatHandoffStore.getState().register({
      hostId: "host-1",
      userId: "user-1",
      epicId: "epic-1",
      chatId: "chat-1",
      content: hashOnlyImageDoc(hash),
      settings: SETTINGS,
      worktreeIntent: null,
      placement: null,
      messageId: "msg-1",
      clientActionId: "cai-1",
      createdAt: 1,
    });

    // Drop the session cache's own protection so the ONLY thing left
    // rooting the hash is the handoff's extra-root-source registration -
    // otherwise the still-warm session entry would mask a broken root
    // source instead of proving it works.
    m.store.releaseSession(hash);

    await m.gc.reconcile();
    await flush();

    expect(await m.store.imageHashKeys()).toContain(hash);
  });

  it("control: the same hash IS collected once the handoff is consumed and nothing else references it", async () => {
    const m = await loadModules();
    m.gc.markLandingDraftsReady();
    await flush();

    const hash = await m.store.putImage(bytesOf([4, 4, 4]));
    m.handoff.useInitialChatHandoffStore.getState().register({
      hostId: "host-1",
      userId: "user-1",
      epicId: "epic-2",
      chatId: "chat-2",
      content: hashOnlyImageDoc(hash),
      settings: SETTINGS,
      worktreeIntent: null,
      placement: null,
      messageId: "msg-2",
      clientActionId: "cai-2",
      createdAt: 1,
    });
    m.store.releaseSession(hash);

    m.handoff.useInitialChatHandoffStore.getState().consume({
      hostId: "host-1",
      userId: "user-1",
      epicId: "epic-2",
    });

    await m.gc.reconcile();
    await flush();

    expect(await m.store.imageHashKeys()).not.toContain(hash);
  });
});
