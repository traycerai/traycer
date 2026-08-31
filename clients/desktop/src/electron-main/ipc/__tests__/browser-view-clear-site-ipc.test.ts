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
  /** Whole-jar `clearStorageData()` calls, by partition ("forget all"). */
  jarClears: [] as string[],
  forgottenOrigins: [] as string[],
  forgetAllResets: 0,
  suppressedDomains: [] as string[],
  suppressedAll: 0,
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
      getPath: (_key: string): string => "/tmp/traycer-desktop-test",
      relaunch: (): void => undefined,
      exit: (_code: number): void => undefined,
    },
    BrowserWindow,
    WebContentsView,
    dialog: {
      showSaveDialogSync: () => undefined,
      showMessageBoxSync: () => 0,
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
  trustBrowserCertificate: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../browser-view/browser-view-manager", () => ({
  BOUNDS_STREAM_LOG_INTERVAL_MS: 1_000,
  BrowserViewManager: class {
    constructor(_options: unknown) {}

    readClearSiteTarget(): string {
      return "example.com";
    }

    recreateNativeTabsOnCurrentPartition(): Promise<void> {
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
        return Promise.resolve();
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
    onBrowserPrimaryProfileDelta: vi.fn(() => () => undefined),
    onBrowserViewCertificateError: vi.fn(),
    onBrowserViewDownloadChange: vi.fn(),
    partitionForProfile: vi.fn(() => fixture.activePartition),
    readBrowserViewPendingCertificateError: vi.fn(() => null),
    registerBrowserViewWebContents: vi.fn(),
    releaseBrowserViewSession: vi.fn(() => Promise.resolve()),
    suppressAllBrowserPrimaryProfileDeltas: vi.fn(
      (action: () => Promise<unknown>) => {
        fixture.suppressedAll += 1;
        return action();
      },
    ),
    suppressBrowserPrimaryProfileDelta: vi.fn(
      (domain: string, action: () => Promise<unknown>) => {
        fixture.suppressedDomains.push(domain);
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
      return Promise.resolve();
    },
  ),
  seedBrowserViewCookies: vi.fn(() => Promise.resolve()),
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
    | "browserViewClearSite"
    | "browserViewEvictSite"
    | "browserViewForgetLogins",
  payload: unknown,
): Promise<void> {
  const { registerBrowserViewIpc } = await import("../browser-view-ipc");
  const { RunnerHostInvoke } =
    await import("../../../ipc-contracts/ipc-channels");
  const bridge = makeBridge();
  registerBrowserViewIpc(bridge as never);
  await findInvokeHandler(bridge, RunnerHostInvoke[channel])({}, payload);
}

describe("clear-site IPC jar targeting", () => {
  beforeEach(() => {
    fixture.clears = [];
    fixture.jarClears = [];
    fixture.forgottenOrigins = [];
    fixture.forgetAllResets = 0;
    fixture.suppressedDomains = [];
    fixture.suppressedAll = 0;
    fixture.activePartition = fixture.durablePartition;
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

  it("clears the durable jar as well as the live one when saving is off (host evict)", async () => {
    fixture.activePartition = fixture.ephemeralPartition;

    await invokeHandler("browserViewEvictSite", { domain: "example.com" });

    expect(fixture.clears).toEqual([
      { domain: "example.com", partition: fixture.durablePartition },
      { domain: "example.com", partition: fixture.ephemeralPartition },
    ]);
    expect(fixture.forgottenOrigins).toEqual(["example.com"]);
    // Still one suppressed action: the host recorded the tombstones before it
    // asked, so neither jar's removals may echo back to it as a delta.
    expect(fixture.suppressedDomains).toEqual(["example.com"]);
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

  it("forgets from the one shared jar when saving is on", async () => {
    await invokeHandler("browserViewForgetLogins", undefined);

    expect(fixture.jarClears).toEqual([fixture.durablePartition]);
    expect(fixture.forgetAllResets).toBe(1);
  });

  it("clears once when saving is on and the live jar IS the durable one", async () => {
    await invokeHandler("browserViewClearSite", TILE_KEY);
    await invokeHandler("browserViewEvictSite", { domain: "example.com" });

    expect(fixture.clears).toEqual([
      { domain: "example.com", partition: fixture.durablePartition },
      { domain: "example.com", partition: fixture.durablePartition },
    ]);
    expect(fixture.forgottenOrigins).toEqual(["example.com", "example.com"]);
  });
});
