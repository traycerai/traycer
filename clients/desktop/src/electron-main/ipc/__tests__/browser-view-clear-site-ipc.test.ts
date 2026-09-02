import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which jars "clear cookies for this site" and its host-driven twin reach.
 *
 * The durable `persist:` jar outlives the saved-logins pref, so a clear taken
 * while saving is OFF has to reach it anyway - otherwise the login stays on
 * disk and turning the pref back on restores the site the user cleared. The
 * jar the tiles are actually on has to be cleared too, or the open tile keeps
 * showing the site signed in. These pin both, plus the snapshot memory the
 * clear has to prune with them.
 */

interface ClearCall {
  readonly domain: string;
  readonly partition: string;
}

const fixture = vi.hoisted(() => ({
  durablePartition: "persist:traycer-browser",
  ephemeralPartition: "traycer-browser-ephemeral",
  /** Which jar `primary` guests are born into right now - the pref's answer. */
  activePartition: "persist:traycer-browser",
  clears: [] as ClearCall[],
  /** Partitions whose per-site clear rejects, so a jar can be made to fail. */
  failingSiteClears: [] as string[],
  /** Whole-jar `clearStorageData()` calls, by partition ("forget all"). */
  jarClears: [] as string[],
  /** Partitions whose whole-jar `clearStorageData()` rejects. */
  failingJarClears: [] as string[],
  forgottenOrigins: [] as string[],
  forgetAllResets: 0,
  tabRecreations: 0,
  suppressedAll: 0,
  /** What the main-process confirmation dialog answers: 1 confirms. */
  confirmAnswer: 1,
  /** Every confirmation main actually raised, by title. */
  confirmations: [] as string[],
  trustedCertificates: [] as string[],
  /**
   * A fresh userData directory per test. The forget ledger is the REAL module
   * here, and it persists: a test that leaves a clear pending (the ones that
   * make a jar fail) would otherwise have the NEXT test's registration re-run
   * that forget as its boot reconciliation, and every count below would be
   * measuring the previous test.
   */
  userDataDir: "/tmp/traycer-desktop-test-0",
}));

vi.mock("electron", () => {
  class BrowserWindow {
    constructor(_options: unknown) {}
  }
  class WebContentsView {
    readonly webContents = { id: 1, once: () => undefined };
    constructor(_options: unknown) {}
  }
  return {
    app: {
      getPath: (_key: string): string => fixture.userDataDir,
      relaunch: (): void => undefined,
      exit: (_code: number): void => undefined,
    },
    BrowserWindow,
    WebContentsView,
    dialog: {
      showSaveDialogSync: () => undefined,
      showMessageBoxSync: (options: { readonly title: string }): number => {
        fixture.confirmations.push(options.title);
        return fixture.confirmAnswer;
      },
    },
    session: { fromPartition: () => ({}) },
    safeStorage: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "unknown",
    },
  };
});

vi.mock("../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn() },
  describeLogError: (error: unknown) => String(error),
}));

vi.mock("../../app/cert-trust", () => ({
  trustBrowserCertificate: vi.fn((hostname: string) => {
    fixture.trustedCertificates.push(hostname);
    return Promise.resolve();
  }),
}));

vi.mock("../../browser-view/browser-view-manager", () => ({
  BOUNDS_STREAM_LOG_INTERVAL_MS: 1_000,
  BrowserViewManager: class {
    constructor(_options: unknown) {}

    readClearSiteTarget(): string {
      return "example.com";
    }

    canTrustCertificateError(): boolean {
      return true;
    }

    clearCertificateError(): void {}

    recreateNativeTabsOnCurrentPartition(): Promise<void> {
      fixture.tabRecreations += 1;
      return Promise.resolve();
    }

    dispose(): void {}
  },
}));

/**
 * A jar here is just its partition name: what matters is WHICH one each clear
 * was handed. Memoised per partition, as the real module is - the handler tells
 * the two jars apart by object identity, so equal names must be one object.
 */
vi.mock("../../browser-view/browser-session", () => {
  interface FakeSession {
    readonly partition: string;
    clearStorageData(): Promise<void>;
  }
  const sessions = new Map<string, FakeSession>();
  const ensureBrowserViewSessionForPartition = (
    partition: string,
  ): FakeSession => {
    const existing = sessions.get(partition);
    if (existing !== undefined) return existing;
    const created: FakeSession = {
      partition,
      clearStorageData: (): Promise<void> => {
        fixture.jarClears.push(partition);
        return fixture.failingJarClears.includes(partition)
          ? Promise.reject(new Error(`jar clear failed on ${partition}`))
          : Promise.resolve();
      },
    };
    sessions.set(partition, created);
    return created;
  };
  return {
    BROWSER_VIEW_PARTITION: fixture.durablePartition,
    BROWSER_VIEW_EPHEMERAL_PARTITION: fixture.ephemeralPartition,
    createBrowserViewWebPreferences: vi.fn(() => ({})),
    cancelBrowserViewDownload: vi.fn(),
    clearBrowserViewPendingCertificateError: vi.fn(),
    ensureBrowserViewSession: vi.fn(() =>
      ensureBrowserViewSessionForPartition(fixture.activePartition),
    ),
    ensureBrowserViewSessionForPartition: vi.fn(
      ensureBrowserViewSessionForPartition,
    ),
    isBrowserPrimaryProfileClearInProgress: vi.fn(() => false),
    onBrowserPrimaryProfileDelta: vi.fn(() => () => undefined),
    onBrowserViewCertificateError: vi.fn(),
    onBrowserViewDownloadChange: vi.fn(),
    partitionForProfile: vi.fn(() => fixture.activePartition),
    readBrowserViewPendingCertificateError: vi.fn(() => ({
      hostname: "expired.test",
      certificate: { data: "pem" },
    })),
    registerBrowserViewWebContents: vi.fn(),
    releaseBrowserViewSession: vi.fn(() => Promise.resolve()),
    suppressAllBrowserPrimaryProfileDeltas: vi.fn(
      (action: () => Promise<unknown>) => {
        fixture.suppressedAll += 1;
        return action();
      },
    ),
  };
});

vi.mock("../../browser-view/storage/browser-saved-logins", () => ({
  isBrowserSavedLoginsEnabled: vi.fn(() => true),
  setBrowserSavedLoginsEnabled: vi.fn(() => Promise.resolve(true)),
  wrapStoreKey: vi.fn(() => "wrapped"),
  unwrapStoreKey: vi.fn(() => "unwrapped"),
}));

vi.mock("../../browser-view/storage/browser-storage-state", () => ({
  BrowserPrimaryProfileSnapshotCoordinator: class {
    observe(): void {}

    retainSeededOrigins(): void {}

    rememberedOrigins(): readonly { readonly origin: string }[] {
      return [];
    }

    forgetOriginsUnder(domain: string): void {
      fixture.forgottenOrigins.push(domain);
    }

    reset(): void {
      fixture.forgetAllResets += 1;
    }
  },
  captureBrowserOriginLocalStorage: vi.fn(() => Promise.resolve(null)),
  captureBrowserPrimaryProfile: vi.fn(() =>
    Promise.resolve({
      status: "captured",
      storageState: { cookies: [], origins: [] },
      reason: null,
    }),
  ),
  clearBrowserSite: vi.fn(
    (domain: string, browserSession: { readonly partition: string }) => {
      fixture.clears.push({ domain, partition: browserSession.partition });
      return fixture.failingSiteClears.includes(browserSession.partition)
        ? Promise.reject(
            new Error(`site clear failed on ${browserSession.partition}`),
          )
        : Promise.resolve();
    },
  ),
  // The real one: the forget ledger keys its headless-origin custody set by it
  // (universal-sign-in ticket 08), and a stub id would make the set's own
  // behaviour untestable from here rather than merely unexercised.
  cookieKeyId: (key: {
    readonly domain: string;
    readonly name: string;
    readonly path: string;
  }) => `${key.domain}\u0000${key.name}\u0000${key.path}`,
}));

type InvokeHandler = (
  event: unknown,
  payload: unknown,
) => unknown | Promise<unknown>;

function makeBridge() {
  return {
    handleInvoke: vi.fn(),
    disposeFns: [] as Array<() => void>,
    windowRegistry: {
      getRecordById: vi.fn(() => null),
      on: vi.fn(),
      off: vi.fn(),
    },
    safeSendToWindow: vi.fn(),
    fanOut: vi.fn(),
    resolveSenderWindowId: vi.fn(() => "window-1"),
    // The jar-plane registry is built during registration (H10), so a bridge
    // double now has to answer for the host snapshot it subscribes to and the
    // auth session its bearer comes from. Nothing here dials: no stream is
    // opened unless a renderer asks for one.
    options: {
      authnBaseUrl: "https://authn.test",
      host: {
        getSnapshot: () => null,
        on: vi.fn(),
        off: vi.fn(),
      },
    },
    authSession: {
      get: () => ({ status: "signed-out", token: null, profile: null }),
      on: vi.fn(),
      off: vi.fn(),
    },
  };
}

function findInvokeHandler(
  bridge: {
    readonly handleInvoke: {
      readonly mock: { readonly calls: ReadonlyArray<ReadonlyArray<unknown>> };
    };
  },
  channel: string,
): InvokeHandler {
  const match = bridge.handleInvoke.mock.calls.find(
    (call) => call[0] === channel,
  );
  if (match === undefined) {
    throw new Error(`No invoke handler registered for ${channel}`);
  }
  const handler = match[1];
  if (typeof handler !== "function") {
    throw new Error(`Invoke handler for ${channel} is not a function`);
  }
  return handler as InvokeHandler;
}

const TILE_KEY = {
  viewTabId: "view-tab-1",
  paneId: "pane-1",
  tileInstanceId: "tile-1",
  pageSessionId: "page-session-1",
};

async function invokeHandler(
  channel:
    | "browserViewClearSavedLoginSite"
    | "browserViewClearSite"
    | "browserViewForgetLogins"
    | "browserViewTrustCertificate",
  payload: unknown,
): Promise<unknown> {
  const { registerBrowserViewIpc } = await import("../browser-view-ipc");
  const { RunnerHostInvoke } =
    await import("../../../ipc-contracts/ipc-channels");
  const bridge = makeBridge();
  registerBrowserViewIpc(bridge as never);
  return await findInvokeHandler(bridge, RunnerHostInvoke[channel])(
    {},
    payload,
  );
}

let ledgerRun = 0;

describe("clear-site IPC jar targeting", () => {
  beforeEach(() => {
    fixture.clears = [];
    fixture.failingSiteClears = [];
    fixture.jarClears = [];
    fixture.failingJarClears = [];
    fixture.forgottenOrigins = [];
    fixture.forgetAllResets = 0;
    fixture.tabRecreations = 0;
    fixture.suppressedAll = 0;
    fixture.activePartition = fixture.durablePartition;
    fixture.confirmAnswer = 1;
    fixture.confirmations = [];
    fixture.trustedCertificates = [];
    fixture.userDataDir = `/tmp/traycer-desktop-test-${ledgerRun}`;
    ledgerRun += 1;
    // With the directory, the ledger module's own in-memory state has to go
    // too - it is loaded once per module registry, not once per directory.
    vi.resetModules();
  });

  it("clears the durable jar as well as the live one when saving is off (tile menu)", async () => {
    fixture.activePartition = fixture.ephemeralPartition;

    await invokeHandler("browserViewClearSite", TILE_KEY);

    // The durable jar first: it survives the pref, so skipping it leaves the
    // login on disk for the moment saving is switched back on.
    expect(fixture.clears).toEqual([
      { domain: "example.com", partition: fixture.durablePartition },
      { domain: "example.com", partition: fixture.ephemeralPartition },
    ]);
    // The retained localStorage goes after both, never before - the second
    // clear reads the same remembered origins as the first.
    expect(fixture.forgottenOrigins).toEqual(["example.com"]);
  });

  it("forgets ALL logins from the ephemeral jar too when saving is off", async () => {
    fixture.activePartition = fixture.ephemeralPartition;

    await invokeHandler("browserViewForgetLogins", undefined);

    // The ephemeral jar is not `persist:`, but it outlives the toggle for the
    // whole process run: without this the user clicks "Forget all browser
    // logins", the tiles reload, and they are still signed in until restart.
    expect(fixture.jarClears).toEqual([
      fixture.durablePartition,
      fixture.ephemeralPartition,
    ]);
    // Both clears are inside the ONE suppression window - their removals must
    // not echo back to a host that already shredded the slice - and the
    // localStorage memory is dropped before the tiles come back.
    expect(fixture.suppressedAll).toBe(1);
    expect(fixture.forgetAllResets).toBe(1);
  });

  it("confirms in main before clearing ONE saved login, and refuses a cancelled dialog", async () => {
    // H05's residual, closed by H10: a renderer looping the saved-sites list
    // used to reproduce forget-all one domain at a time with no dialog, because
    // it minted the `clearSite` frames itself. Main owns them now, so the ask
    // and the act are separated by a native dialog the renderer cannot draw
    // over.
    fixture.confirmAnswer = 0;

    const cancelled = await invokeHandler("browserViewClearSavedLoginSite", {
      domain: "example.com",
    });

    expect(cancelled).toBe(false);
    expect(fixture.confirmations).toEqual(["Clear this saved login?"]);
  });

  it("reports a confirmed saved-login clear so the settings row can hide", async () => {
    const confirmed = await invokeHandler("browserViewClearSavedLoginSite", {
      domain: "example.com",
    });

    expect(confirmed).toBe(true);
    expect(fixture.confirmations).toEqual(["Clear this saved login?"]);
  });

  it("forgets from the one shared jar when saving is on", async () => {
    await invokeHandler("browserViewForgetLogins", undefined);

    expect(fixture.jarClears).toEqual([fixture.durablePartition]);
    expect(fixture.forgetAllResets).toBe(1);
  });

  it("clears the live jar even when the durable clear fails, keeps the origins, and still rejects", async () => {
    fixture.activePartition = fixture.ephemeralPartition;
    fixture.failingSiteClears = [fixture.durablePartition];

    await expect(
      invokeHandler("browserViewClearSite", TILE_KEY),
    ).rejects.toThrow("site clear failed on persist:traycer-browser");

    // The jars hold independent copies of the same login: giving up on the
    // durable jar's failure would leave the open tile signed in.
    expect(fixture.clears).toEqual([
      { domain: "example.com", partition: fixture.durablePartition },
      { domain: "example.com", partition: fixture.ephemeralPartition },
    ]);
    // The remembered origins are the only record of which localStorage a clear
    // can name, so they survive a partial clear - pruning them would make the
    // failed jar's localStorage unreachable for the rest of the run.
    expect(fixture.forgottenOrigins).toEqual([]);
  });

  it("forgets from the live jar even when the durable jar clear fails, brings the tiles back, and still rejects", async () => {
    fixture.activePartition = fixture.ephemeralPartition;
    fixture.failingJarClears = [fixture.durablePartition];

    await expect(
      invokeHandler("browserViewForgetLogins", undefined),
    ).rejects.toThrow("jar clear failed on persist:traycer-browser");

    expect(fixture.jarClears).toEqual([
      fixture.durablePartition,
      fixture.ephemeralPartition,
    ]);
    // Unlike the per-site prune, this one is unconditional: a whole-jar clear
    // names no origins, so dropping the memory starves no retry, while keeping
    // it would let the next capture re-upload what the host just shredded.
    expect(fixture.forgetAllResets).toBe(1);
    // And the tiles are back before the failure is surfaced - they are sitting
    // on a jar the host no longer holds a key for.
    expect(fixture.tabRecreations).toBe(1);
  });

  // Root cause C: both of these were renderer-callable with nothing between
  // the invoke and the irreversible act. Main asks now, and a refusal has to
  // leave the world untouched - including the forget LEDGER, which is written
  // before the first cookie goes and is what tells every host to prune.
  it("forgets nothing, and records nothing, when the confirmation is declined", async () => {
    fixture.confirmAnswer = 0;

    await invokeHandler("browserViewForgetLogins", undefined);

    expect(fixture.confirmations).toEqual(["Forget browser logins?"]);
    expect(fixture.jarClears).toEqual([]);
    expect(fixture.forgetAllResets).toBe(0);
    expect(fixture.tabRecreations).toBe(0);
  });

  it("does not trust a certificate when the confirmation is declined", async () => {
    fixture.confirmAnswer = 0;

    await invokeHandler("browserViewTrustCertificate", {
      ...TILE_KEY,
      certificateErrorId: "certificate-error-1",
    });

    expect(fixture.confirmations).toEqual(["Trust this certificate?"]);
    expect(fixture.trustedCertificates).toEqual([]);
  });

  it("trusts a certificate once the confirmation is accepted", async () => {
    await invokeHandler("browserViewTrustCertificate", {
      ...TILE_KEY,
      certificateErrorId: "certificate-error-1",
    });

    expect(fixture.trustedCertificates).toEqual(["expired.test"]);
  });

  it("clears once when saving is on and the live jar IS the durable one", async () => {
    await invokeHandler("browserViewClearSite", TILE_KEY);

    expect(fixture.clears).toEqual([
      { domain: "example.com", partition: fixture.durablePartition },
    ]);
    expect(fixture.forgottenOrigins).toEqual(["example.com"]);
  });
});
