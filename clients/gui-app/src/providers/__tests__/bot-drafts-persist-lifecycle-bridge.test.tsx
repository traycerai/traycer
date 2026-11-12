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
    const IMAGE_STORE = "@/lib/composer/landing-image-store";
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
    const run = await startOver();
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
    await run.rtl.act(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
    });

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
    const IMAGE_STORE = "@/lib/composer/landing-image-store";
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
    const run = await startOver();
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
    await run.rtl.act(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
    });

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

    run.rtl.act(() => {
      run.auth.useAuthStore.setState({
        status: "signed-out",
        profile: null,
        contextMetadata: null,
      });
    });
    await run.rtl.act(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
    });

    expect(run.app.drafts.getState().threadBoxes).toEqual({});
    expect(localStorage.getItem(anonKey)).toBe(
      storedBox("Left under anon", null),
    );
  });
});
