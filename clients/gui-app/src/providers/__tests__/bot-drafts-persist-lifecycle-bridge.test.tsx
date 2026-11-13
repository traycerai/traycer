/**
 * The bot boxes' drafts and the signed-in account (T186): the REAL
 * `BotDraftsPersistLifecycleBridge` over the real drafts store, its writer,
 * `localStorage` and the image store's roots. Each case starts the app afresh
 * (modules of its own over the same storage, as a restart leaves it), so the
 * bridge, the stores and the testing library share one set of modules.
 * Account switches over the real channel and its box are in
 * `bot-channel-question-card.test.tsx`.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import type * as LandingImageStore from "@/lib/composer/landing-image-store";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import {
  BOT_ID,
  CHANNEL,
  IMAGE_B64,
  LEGACY_BOX_DRAFTS_KEY,
  boxDoc,
  hashedImage,
  startSignedOutApp,
  storeImageBytes,
  type App,
} from "@/stores/bots/__tests__/bot-box-draft-persist-support";

const ACCOUNT_A = "user-secret-account-a";
const ACCOUNT_B = "user-account-b";

interface Run {
  readonly app: App;
  readonly rtl: typeof import("@testing-library/react");
  readonly bridge: typeof import("@/providers/bot-drafts-persist-lifecycle-bridge");
  readonly auth: typeof import("@/stores/auth/auth-store");
  readonly keys: typeof import("@/lib/persist/keys");
  readonly query: typeof import("@tanstack/react-query");
}

let running: Run | null = null;

/** The app starts over what the case stored; nothing is signed in. */
async function startOver(): Promise<Run> {
  const app = await startSignedOutApp();
  const run: Run = {
    app,
    rtl: await import("@testing-library/react"),
    bridge: await import("@/providers/bot-drafts-persist-lifecycle-bridge"),
    auth: await import("@/stores/auth/auth-store"),
    keys: await import("@/lib/persist/keys"),
    query: await import("@tanstack/react-query"),
  };
  running = run;
  return run;
}

function mountBridge(run: Run): void {
  run.rtl.render(
    <run.query.QueryClientProvider client={new run.query.QueryClient()}>
      <run.bridge.BotDraftsPersistLifecycleBridge>
        <div />
      </run.bridge.BotDraftsPersistLifecycleBridge>
    </run.query.QueryClientProvider>,
  );
}

function signInAs(run: Run, userId: string): void {
  run.rtl.act(() => {
    run.auth.useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId,
        userName: userId,
        email: `${userId}@example.com`,
        avatarUrl: null,
      },
      contextMetadata: { userId, username: userId },
    });
  });
}

const IMAGE_STORE = "@/lib/composer/landing-image-store";

/** Holds every stored image's read until the returned function releases them. */
function holdImageReads(): () => void {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.doMock(IMAGE_STORE, async (importOriginal) => {
    const real = await importOriginal<typeof LandingImageStore>();
    return {
      ...real,
      getImageBytes: async (hash: string) => {
        await gate;
        return real.getImageBytes(hash);
      },
    };
  });
  onTestFinished(() => {
    vi.doUnmock(IMAGE_STORE);
  });
  return release;
}

/** The storage's reads, as they are asked: each result is the read's own answer. */
function trackStoredReads(run: Run): () => Promise<void> {
  const storage = run.app.drafts.persist.getOptions().storage;
  if (storage === undefined) throw new Error("the drafts store persists");
  const reads = vi.spyOn(storage, "getItem");
  // Resolves once every read asked so far has answered, then lets the
  // hydration those answers feed finish: a stale one fires no event of its own.
  return async () => {
    await Promise.allSettled(
      reads.mock.results.map((result) => Promise.resolve(result.value)),
    );
    await run.rtl.act(async () => {});
  };
}

/**
 * Makes the real `localStorage.getItem` throw for `key`, as a browser's does
 * when storage cannot be read, until `readable` makes it readable again. Every
 * other key reads through, and `stored` reads `key` itself past the spy, so a
 * case can check what storage holds while it is unreadable.
 */
function makeKeyUnreadable(key: string): {
  readonly readable: () => void;
  readonly stored: () => string | null;
} {
  const read = Storage.prototype.getItem.bind(localStorage);
  let unreadable = true;
  const reads = vi
    .spyOn(Storage.prototype, "getItem")
    .mockImplementation((asked: string) => {
      if (unreadable && asked === key)
        throw new Error("storage cannot be read");
      return read(asked);
    });
  onTestFinished(() => reads.mockRestore());
  return {
    readable: () => {
      unreadable = false;
    },
    stored: () => read(key),
  };
}

function storedBox(text: string, content: JsonContent | null): string {
  return JSON.stringify({
    state: {
      threadBoxes: { [BOT_ID]: { [CHANNEL]: { text, content, seedId: 1 } } },
    },
    version: 1,
  });
}

beforeEach(() => {
  localStorage.clear();
  installFreshIndexedDb();
});

afterEach(() => {
  if (running !== null) {
    running.rtl.cleanup();
    running.auth.useAuthStore.setState({
      status: "signed-out",
      profile: null,
      contextMetadata: null,
    });
    running.app.close();
    running = null;
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("<BotDraftsPersistLifecycleBridge /> drafts stored before drafts belonged to an account", () => {
  it("removes the unscoped key when the first account signs in, and shows that account none of what it held", async () => {
    localStorage.setItem(LEGACY_BOX_DRAFTS_KEY, storedBox("Old draft", null));
    const run = await startOver();
    mountBridge(run);

    signInAs(run, ACCOUNT_A);

    await vi.waitFor(() =>
      expect(localStorage.getItem(LEGACY_BOX_DRAFTS_KEY)).toBeNull(),
    );
    expect(run.app.drafts.getState().threadBoxes).toEqual({});
  });
});

describe("<BotDraftsPersistLifecycleBridge /> what the drafts' writer logs", () => {
  it("names no account in any log line when the storage refuses a write whose error message carries the key", async () => {
    const run = await startOver();
    mountBridge(run);
    signInAs(run, ACCOUNT_A);
    await vi.waitFor(() =>
      expect(run.app.drafts.persist.hasHydrated()).toBe(true),
    );
    // Only the drafts are written while this runs; any other write is dropped.
    vi.spyOn(Storage.prototype, "setItem").mockImplementation((key: string) => {
      if (key.startsWith("traycer-gui-app:bot-box-drafts")) {
        throw new Error(
          `Failed to execute 'setItem' on 'Storage': Setting the value of '${key}' exceeded the quota.`,
        );
      }
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    run.app.drafts.getState().typeThreadBox(BOT_ID, CHANNEL, {
      text: "typed",
      content: null,
      held: [],
    });
    await vi.advanceTimersByTimeAsync(
      run.app.storage.BOT_BOX_DRAFT_WRITE_DEBOUNCE_MS * 3,
    );

    const logged = [...warn.mock.calls, ...error.mock.calls];
    expect(JSON.stringify(logged)).toContain("draft write failed");
    expect(JSON.stringify(logged)).not.toContain(ACCOUNT_A);
  });
});

describe("<BotDraftsPersistLifecycleBridge /> the images an account's stored drafts name", () => {
  it("keeps them as roots of the image store's sweeps while another account is signed in", async () => {
    const run = await startOver();
    const hash = await storeImageBytes();
    localStorage.setItem(
      run.keys.botBoxDraftsKey(ACCOUNT_A),
      storedBox("Look at this", boxDoc("Look at this ", [hashedImage(hash)])),
    );
    mountBridge(run);

    signInAs(run, ACCOUNT_B);

    await vi.waitFor(() =>
      expect(run.app.drafts.persist.hasHydrated()).toBe(true),
    );
    expect(run.app.imageRoots().has(hash)).toBe(true);
  });
});

describe("<BotDraftsPersistLifecycleBridge /> a read an account switch overtook", () => {
  it("shows account B nothing of account A's stored draft whose image read was still waiting at the switch, in the store or under B's key, when it answers after", async () => {
    const release = holdImageReads();
    const run = await startOver();
    const readsSettled = trackStoredReads(run);
    const hash = await storeImageBytes();
    localStorage.setItem(
      run.keys.botBoxDraftsKey(ACCOUNT_A),
      storedBox("A's own draft", boxDoc("A's own draft ", [hashedImage(hash)])),
    );
    mountBridge(run);
    signInAs(run, ACCOUNT_A);

    signInAs(run, ACCOUNT_B);
    await vi.waitFor(() =>
      expect(run.app.drafts.persist.hasHydrated()).toBe(true),
    );
    release();
    await readsSettled();

    expect(run.app.drafts.getState().threadBoxes).toEqual({});
    expect(JSON.stringify(run.app.drafts.getState())).not.toContain(
      "A's own draft",
    );
    expect(
      localStorage.getItem(run.keys.botBoxDraftsKey(ACCOUNT_B)) ?? "",
    ).not.toContain("A's own draft");
  });
});

describe("<BotDraftsPersistLifecycleBridge /> a read the account signing out overtook", () => {
  it("holds nothing of account A's stored draft while signed out, or for B who signs in after, when A's own image read answers after A signed out", async () => {
    const release = holdImageReads();
    const run = await startOver();
    const readsSettled = trackStoredReads(run);
    const hash = await storeImageBytes();
    localStorage.setItem(
      run.keys.botBoxDraftsKey(ACCOUNT_A),
      storedBox("A's own draft", boxDoc("A's own draft ", [hashedImage(hash)])),
    );
    mountBridge(run);
    signInAs(run, ACCOUNT_A);
    run.rtl.act(() => {
      run.auth.useAuthStore.setState({
        status: "signed-out",
        profile: null,
        contextMetadata: null,
      });
    });

    release();
    await readsSettled();

    expect(run.app.drafts.getState().threadBoxes).toEqual({});
    expect(JSON.stringify(run.app.drafts.getState())).not.toContain(
      "A's own draft",
    );

    signInAs(run, ACCOUNT_B);
    await vi.waitFor(() =>
      expect(run.app.drafts.persist.hasHydrated()).toBe(true),
    );
    expect(run.app.drafts.getState().threadBoxes).toEqual({});
    expect(
      localStorage.getItem(run.keys.botBoxDraftsKey(ACCOUNT_B)) ?? "",
    ).not.toContain("A's own draft");
  });
});

describe("<BotDraftsPersistLifecycleBridge /> signed out", () => {
  it("writes nothing under the anonymous key when a box changes after the account signed out", async () => {
    const run = await startOver();
    mountBridge(run);
    signInAs(run, ACCOUNT_A);
    await vi.waitFor(() =>
      expect(run.app.drafts.persist.hasHydrated()).toBe(true),
    );
    run.rtl.act(() => {
      run.auth.useAuthStore.setState({
        status: "signed-out",
        profile: null,
        contextMetadata: null,
      });
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    run.app.drafts.getState().typeThreadBox(BOT_ID, CHANNEL, {
      text: "typed signed out",
      content: null,
      held: [],
    });
    await vi.advanceTimersByTimeAsync(
      run.app.storage.BOT_BOX_DRAFT_WRITE_DEBOUNCE_MS * 3,
    );

    expect(localStorage.getItem(run.keys.botBoxDraftsKey(null))).toBeNull();
  });

  it("never reads a value stored under the anonymous key into the store when the account signs out", async () => {
    const run = await startOver();
    const anonKey = run.keys.botBoxDraftsKey(null);
    localStorage.setItem(anonKey, storedBox("Left under anon", null));
    mountBridge(run);
    signInAs(run, ACCOUNT_A);
    await vi.waitFor(() =>
      expect(run.app.drafts.persist.hasHydrated()).toBe(true),
    );

    const storage = run.app.drafts.persist.getOptions().storage;
    if (storage === undefined) throw new Error("the drafts store persists");
    const reads = vi.spyOn(storage, "getItem");
    run.rtl.act(() => {
      run.auth.useAuthStore.setState({
        status: "signed-out",
        profile: null,
        contextMetadata: null,
      });
    });

    // A read starts at once or not at all: the storage is asked synchronously.
    expect(reads).not.toHaveBeenCalled();
    expect(run.app.drafts.getState().threadBoxes).toEqual({});
    expect(localStorage.getItem(anonKey)).toBe(
      storedBox("Left under anon", null),
    );
  });
});

describe("<BotDraftsPersistLifecycleBridge /> an account that retires while its stored drafts are still being read", () => {
  it("keeps A's stored text and image under A's key, with the answer moved meanwhile below them, and gives all three back when A signs in again", async () => {
    const release = holdImageReads();
    const run = await startOver();
    const readsSettled = trackStoredReads(run);
    const hash = await storeImageBytes();
    const keyOfA = run.keys.botBoxDraftsKey(ACCOUNT_A);
    localStorage.setItem(
      keyOfA,
      storedBox("A's own draft", boxDoc("A's own draft ", [hashedImage(hash)])),
    );
    mountBridge(run);
    signInAs(run, ACCOUNT_A);
    // The move is put in the store directly: no UI can make one while the read
    // is held, because the bot tab waits for the read before it shows its box.
    run.rtl.act(() => {
      const drafts = run.app.drafts.getState();
      drafts.setAnswer(BOT_ID, "answer-1", {
        chosen: [],
        typed: "Hold the migration",
        sent: null,
        unsureSince: null,
        heldForSettlement: null,
      });
      drafts.moveAnswers(BOT_ID, CHANNEL, ["answer-1"], (taken) => ({
        block: taken.map(([, draft]) => draft.typed).join("\n"),
        notice: "Tess answered first.",
      }));
    });

    signInAs(run, ACCOUNT_B);
    await vi.waitFor(() =>
      expect(run.app.drafts.persist.hasHydrated()).toBe(true),
    );
    release();
    await readsSettled();

    const stored = localStorage.getItem(keyOfA) ?? "";
    expect(stored).toContain("A's own draft");
    expect(stored).toContain(hash);
    expect(stored).toContain("Hold the migration");
    expect(stored.indexOf("A's own draft")).toBeLessThan(
      stored.indexOf("Hold the migration"),
    );

    let finished = false;
    const stop = run.app.drafts.persist.onFinishHydration(() => {
      finished = true;
    });
    signInAs(run, ACCOUNT_A);
    await vi.waitFor(() => expect(finished).toBe(true));
    stop();

    const kept = JSON.stringify(
      run.app.drafts.getState().threadBoxes[BOT_ID]?.[CHANNEL],
    );
    expect(kept).toContain("A's own draft");
    expect(kept).toContain("imageAttachment");
    // In memory the image is inline, as the box holds it.
    expect(kept).toContain(IMAGE_B64);
    expect(kept).toContain("Hold the migration");
  });

  it("keeps what the person typed during the read, not A's stored draft, under A's key beside the moved answer when A retires before the read answers", async () => {
    const release = holdImageReads();
    const run = await startOver();
    const readsSettled = trackStoredReads(run);
    const hash = await storeImageBytes();
    const keyOfA = run.keys.botBoxDraftsKey(ACCOUNT_A);
    localStorage.setItem(
      keyOfA,
      storedBox("A's own draft", boxDoc("A's own draft ", [hashedImage(hash)])),
    );
    mountBridge(run);
    signInAs(run, ACCOUNT_A);
    // The typing and the move go through the store directly: no UI can change a
    // box during the read, because the bot tab waits for the read before it
    // shows its box. (A clear is no change here: the box holds nothing yet, so
    // the store records none.)
    run.rtl.act(() => {
      const drafts = run.app.drafts.getState();
      drafts.typeThreadBox(BOT_ID, CHANNEL, {
        text: "Typed meanwhile",
        content: null,
        held: [],
      });
      drafts.setAnswer(BOT_ID, "answer-1", {
        chosen: [],
        typed: "Hold the migration",
        sent: null,
        unsureSince: null,
        heldForSettlement: null,
      });
      drafts.moveAnswers(BOT_ID, CHANNEL, ["answer-1"], (taken) => ({
        block: taken.map(([, draft]) => draft.typed).join("\n"),
        notice: "Tess answered first.",
      }));
    });

    signInAs(run, ACCOUNT_B);
    await vi.waitFor(() =>
      expect(run.app.drafts.persist.hasHydrated()).toBe(true),
    );
    release();
    await readsSettled();

    const stored = localStorage.getItem(keyOfA) ?? "";
    expect(stored).toContain("Typed meanwhile");
    expect(stored).toContain("Hold the migration");
    expect(stored).not.toContain("A's own draft");
  });

  it("keeps the person's clear, not A's stored draft, under A's key beside the moved answer when the box was typed into and cleared during the read and A retires before the read answers", async () => {
    const release = holdImageReads();
    const run = await startOver();
    const readsSettled = trackStoredReads(run);
    const hash = await storeImageBytes();
    const keyOfA = run.keys.botBoxDraftsKey(ACCOUNT_A);
    localStorage.setItem(
      keyOfA,
      storedBox("A's own draft", boxDoc("A's own draft ", [hashedImage(hash)])),
    );
    mountBridge(run);
    signInAs(run, ACCOUNT_A);
    // The typing, the clear and the move go through the store directly: no UI
    // can change a box during the read, because the bot tab waits for the read
    // before it shows its box. The box ends changed and with no entry, which is
    // the one case where the store's "changed during the read" record decides.
    run.rtl.act(() => {
      const drafts = run.app.drafts.getState();
      drafts.typeThreadBox(BOT_ID, CHANNEL, {
        text: "x",
        content: null,
        held: [],
      });
      drafts.typeThreadBox(BOT_ID, CHANNEL, {
        text: "",
        content: null,
        held: [],
      });
      drafts.setAnswer(BOT_ID, "answer-1", {
        chosen: [],
        typed: "Hold the migration",
        sent: null,
        unsureSince: null,
        heldForSettlement: null,
      });
      drafts.moveAnswers(BOT_ID, CHANNEL, ["answer-1"], (taken) => ({
        block: taken.map(([, draft]) => draft.typed).join("\n"),
        notice: "Tess answered first.",
      }));
    });

    signInAs(run, ACCOUNT_B);
    await vi.waitFor(() =>
      expect(run.app.drafts.persist.hasHydrated()).toBe(true),
    );
    release();
    await readsSettled();

    const stored = localStorage.getItem(keyOfA) ?? "";
    expect(stored).toContain("Hold the migration");
    expect(stored).not.toContain("A's own draft");
  });
});

describe("<BotDraftsPersistLifecycleBridge /> a storage that cannot be read", () => {
  function storedBoxes(
    entries: Record<string, { text: string; content: JsonContent | null }>,
  ): string {
    return JSON.stringify({
      state: {
        threadBoxes: {
          [BOT_ID]: Object.fromEntries(
            Object.entries(entries).map(([key, draft]) => [
              key,
              { ...draft, seedId: 1 },
            ]),
          ),
        },
      },
      version: 1,
    });
  }

  it("writes nothing over A's drafts while their storage cannot be read, and merges the person's typing into them once it can", async () => {
    const run = await startOver();
    const keyOfA = run.keys.botBoxDraftsKey(ACCOUNT_A);
    localStorage.setItem(
      keyOfA,
      storedBoxes({
        [CHANNEL]: { text: "one", content: null },
        other: { text: "two", content: null },
      }),
    );
    mountBridge(run);
    signInAs(run, ACCOUNT_A);
    await vi.waitFor(() =>
      expect(run.app.drafts.persist.hasHydrated()).toBe(true),
    );
    const { readable, stored } = makeKeyUnreadable(keyOfA);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    run.rtl.act(() => {
      run.app.drafts.getState().typeThreadBox(BOT_ID, CHANNEL, {
        text: "typed",
        content: null,
        held: [],
      });
    });
    await vi.advanceTimersByTimeAsync(
      run.app.storage.BOT_BOX_DRAFT_WRITE_DEBOUNCE_MS * 3,
    );

    const unwritten = stored() ?? "";
    expect(unwritten).toContain('"text":"one"');
    expect(unwritten).toContain('"text":"two"');
    expect(unwritten).not.toContain("typed");

    readable();
    window.dispatchEvent(new Event("pagehide"));

    const merged = localStorage.getItem(keyOfA) ?? "";
    expect(merged).toContain('"text":"typed"');
    expect(merged).toContain('"text":"two"');
    expect(merged).not.toContain('"text":"one"');
  });

  it("leaves every one of A's stored drafts exactly as they were when A retires during the read and their storage cannot be read", async () => {
    const release = holdImageReads();
    const run = await startOver();
    const readsSettled = trackStoredReads(run);
    const hash = await storeImageBytes();
    const keyOfA = run.keys.botBoxDraftsKey(ACCOUNT_A);
    localStorage.setItem(
      keyOfA,
      storedBoxes({
        [CHANNEL]: {
          text: "A's own draft",
          content: boxDoc("A's own draft ", [hashedImage(hash)]),
        },
        other: { text: "two", content: null },
      }),
    );
    const before = localStorage.getItem(keyOfA);
    mountBridge(run);
    signInAs(run, ACCOUNT_A);
    // The move goes through the store directly: no UI can make one during the
    // read, because the bot tab waits for the read before it shows its box.
    run.rtl.act(() => {
      const drafts = run.app.drafts.getState();
      drafts.setAnswer(BOT_ID, "answer-1", {
        chosen: [],
        typed: "Hold the migration",
        sent: null,
        unsureSince: null,
        heldForSettlement: null,
      });
      drafts.moveAnswers(BOT_ID, CHANNEL, ["answer-1"], (taken) => ({
        block: taken.map(([, draft]) => draft.typed).join("\n"),
        notice: "Tess answered first.",
      }));
    });
    const { readable } = makeKeyUnreadable(keyOfA);

    signInAs(run, ACCOUNT_B);
    await vi.waitFor(() =>
      expect(run.app.drafts.persist.hasHydrated()).toBe(true),
    );
    release();
    await readsSettled();
    readable();

    expect(localStorage.getItem(keyOfA)).toBe(before);
  });
});
