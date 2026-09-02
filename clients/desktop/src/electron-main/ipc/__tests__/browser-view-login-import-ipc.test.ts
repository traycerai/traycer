import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LoginImportRequest,
  LoginImportResult,
} from "@traycer-clients/shared/platform/browser-view";

/**
 * The one link between a committed import and the hosts: main pushes the
 * freshly imported jar itself, because the import writes with the delta
 * observer muted, so no ordinary capture fires for it. The push is
 * best-effort - the cookies are already durably written - so a host-push
 * failure must not turn a completed import into a rejected invoke.
 *
 * `LoginImportService` itself is exercised end to end by
 * `import-logins.test.ts`; this suite is only the IPC handler's OWN
 * behaviour around the result it gets back, so the service is a stub that
 * hands back whatever result the test queues.
 */

type ImportOutcome = Omit<
  Extract<LoginImportResult, { status: "imported" }>,
  "notifiedHosts"
>;

const fixture = vi.hoisted(() => ({
  importResult: null as ImportOutcome | null,
  captureShouldReject: false,
  captureCalls: 0,
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
      getPath: (_key: string): string =>
        "/tmp/traycer-desktop-login-import-ipc-test",
      relaunch: (): void => undefined,
      exit: (_code: number): void => undefined,
    },
    BrowserWindow,
    WebContentsView,
    dialog: {
      showSaveDialogSync: () => undefined,
      showMessageBox: () => Promise.resolve({ response: 1 }),
      showMessageBoxSync: (): number => {
        throw new Error("must not use the synchronous dialog");
      },
      showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
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

    canTrustCertificateError(): boolean {
      return true;
    }

    clearCertificateError(): void {}

    recreateNativeTabsOnCurrentPartition(): Promise<void> {
      return Promise.resolve();
    }

    dispose(): void {}
  },
}));

vi.mock("../../browser-view/browser-session", () => {
  const fakeSession = { partition: "persist:traycer-browser" };
  return {
    BROWSER_VIEW_PARTITION: "persist:traycer-browser",
    BROWSER_VIEW_EPHEMERAL_PARTITION: "traycer-browser-ephemeral",
    createBrowserViewWebPreferences: vi.fn(() => ({})),
    cancelBrowserViewDownload: vi.fn(),
    clearBrowserViewPendingCertificateError: vi.fn(),
    ensureBrowserViewSession: vi.fn(() => fakeSession),
    ensureBrowserViewSessionForPartition: vi.fn(() => fakeSession),
    isBrowserPrimaryProfileClearInProgress: vi.fn(() => false),
    onBrowserPrimaryProfileDelta: vi.fn(() => () => undefined),
    onBrowserViewCertificateError: vi.fn(),
    onBrowserViewDownloadChange: vi.fn(),
    partitionForProfile: vi.fn(() => "persist:traycer-browser"),
    readBrowserViewPendingCertificateError: vi.fn(() => null),
    registerBrowserViewWebContents: vi.fn(),
    releaseBrowserViewSession: vi.fn(() => Promise.resolve()),
    suppressAllBrowserPrimaryProfileDeltas: vi.fn(
      (action: () => Promise<unknown>) => action(),
    ),
  };
});

/**
 * The jar-plane registry. Only `capturePrimaryProfileOnEveryHost` matters
 * here - it is the call the import handler wraps in try/catch - so it is the
 * one method whose outcome the test controls.
 */
vi.mock("../../browser-sessions/browser-sessions-owner", () => ({
  BrowserSessionsRegistry: class {
    constructor(_options: unknown) {}

    open(): void {}

    close(): void {}

    closeWindow(): void {}

    send(): void {}

    capturePrimaryProfileOnEveryHost(): Promise<number> {
      fixture.captureCalls += 1;
      return fixture.captureShouldReject
        ? Promise.reject(new Error("push to hosts failed"))
        : Promise.resolve(0);
    }

    dispose(): void {}
  },
}));

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

    forgetOriginsUnder(): void {}

    reset(): void {}
  },
  captureBrowserOriginLocalStorage: vi.fn(() => Promise.resolve(null)),
  captureBrowserPrimaryProfile: vi.fn(() =>
    Promise.resolve({
      status: "captured",
      storageState: { cookies: [], origins: [] },
      reason: null,
    }),
  ),
  clearBrowserSite: vi.fn(() => Promise.resolve()),
  cookieKeyId: (key: {
    readonly domain: string;
    readonly name: string;
    readonly path: string;
  }) => `${key.domain} ${key.name} ${key.path}`,
}));

vi.mock("../../browser-view/storage/login-import/login-import-runtime", () => ({
  LOGIN_IMPORT_JAR_BARRIER_TIMEOUT_MS: 10 * 60_000,
  createLoginImportService: () => ({
    listSources: vi.fn(() => Promise.resolve([])),
    registerFile: vi.fn(() => Promise.resolve(null)),
    scan: vi.fn(),
    import: vi.fn((): Promise<ImportOutcome> => {
      if (fixture.importResult === null) {
        throw new Error("test did not queue an import result");
      }
      return Promise.resolve(fixture.importResult);
    }),
  }),
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
    zoomController: {
      getZoomPercent: vi.fn(() => 100),
      getZoomFactor: vi.fn(() => 1),
      onChange: vi.fn(() => () => undefined),
    },
    safeSendToWindow: vi.fn(),
    fanOut: vi.fn(),
    resolveSenderWindowId: vi.fn(() => "window-1"),
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

async function runLoginImport(payload: LoginImportRequest): Promise<unknown> {
  const { registerBrowserViewIpc } = await import("../browser-view-ipc");
  const { RunnerHostInvoke } =
    await import("../../../ipc-contracts/ipc-channels");
  const bridge = makeBridge();
  registerBrowserViewIpc(bridge as never);
  const handler = findInvokeHandler(
    bridge,
    RunnerHostInvoke.browserViewLoginImportRun,
  );
  return handler({}, payload);
}

describe("browserViewLoginImportRun IPC handler", () => {
  beforeEach(() => {
    fixture.importResult = null;
    fixture.captureShouldReject = false;
    fixture.captureCalls = 0;
    vi.resetModules();
  });

  it("answers the committed import with zero notified hosts when the push to the hosts throws", async () => {
    fixture.importResult = {
      status: "imported",
      importedSites: 1,
      importedCookies: 3,
      replacedSites: 0,
      skippedInvalid: 0,
    };
    fixture.captureShouldReject = true;

    const result = await runLoginImport({
      sourceId: "source-1",
      scanId: "scan-1",
      domains: ["example.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual({
      status: "imported",
      importedSites: 1,
      importedCookies: 3,
      replacedSites: 0,
      skippedInvalid: 0,
      notifiedHosts: 0,
    });
    expect(fixture.captureCalls).toBe(1);
  });
});
