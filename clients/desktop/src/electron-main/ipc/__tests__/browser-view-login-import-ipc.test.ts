import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LoginImportRequest,
  LoginImportResult,
} from "@traycer-clients/shared/platform/browser-view";
import type { LoginImportJarCoordination } from "../../browser-view/storage/login-import/login-import-runtime";

/**
 * The one link between a committed import and the hosts: main pushes the
 * freshly imported jar itself, because the import writes with the delta
 * observer muted, so no ordinary capture fires for it. That push now lives
 * entirely inside `pushJarToHosts`, the coordination member
 * `registerBrowserViewIpc` passes to `createLoginImportService` - it is
 * best-effort there (the cookies are already durably written), catching any
 * rejection and answering 0 rather than turning a committed import into a
 * rejected invoke.
 *
 * `LoginImportService` itself is exercised end to end by
 * `import-logins.test.ts`; the service is stubbed out here entirely, so this
 * suite covers two separate things: the IPC handler is now a pure passthrough
 * of whatever the (stubbed) service's `import` answers, and `pushJarToHosts`
 * - captured off the coordination object handed to the stub - is exercised
 * directly against its own real implementation.
 */

type ImportedResult = Extract<LoginImportResult, { status: "imported" }>;

const fixture = vi.hoisted(() => ({
  importResult: null as ImportedResult | null,
  captureShouldReject: false,
  captureResolvedHosts: 0,
  captureCalls: 0,
  coordination: null as LoginImportJarCoordination | null,
}));

vi.mock("electron", () => {
  class BrowserWindow {
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
 * here - it is the call `pushJarToHosts` wraps in try/catch - so it is the
 * one method whose outcome the test controls, both the count it resolves
 * with and whether it rejects.
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
        : Promise.resolve(fixture.captureResolvedHosts);
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

/**
 * The service itself is a stub - `LoginImportService` is covered end to end
 * by `import-logins.test.ts` - but the coordination object this module is
 * called with is real: `registerBrowserViewIpc` builds it (including the
 * `pushJarToHosts` closure this suite exercises directly), and this mock's
 * only job is to capture that object before handing back a canned service.
 */
vi.mock("../../browser-view/storage/login-import/login-import-runtime", () => ({
  LOGIN_IMPORT_JAR_BARRIER_TIMEOUT_MS: 10 * 60_000,
  createLoginImportService: (coordination: LoginImportJarCoordination) => {
    fixture.coordination = coordination;
    return {
      listSources: vi.fn(() => Promise.resolve([])),
      registerFile: vi.fn(() => Promise.resolve(null)),
      scan: vi.fn(),
      import: vi.fn((): Promise<LoginImportResult> => {
        if (fixture.importResult === null) {
          throw new Error("test did not queue an import result");
        }
        return Promise.resolve(fixture.importResult);
      }),
    };
  },
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

/**
 * Registers the IPC handlers, which is also what calls
 * `createLoginImportService` and so populates `fixture.coordination`.
 */
async function registerBridge() {
  const { registerBrowserViewIpc } = await import("../browser-view-ipc");
  const bridge = makeBridge();
  registerBrowserViewIpc(bridge as never);
  return bridge;
}

function requireCoordination(): LoginImportJarCoordination {
  const coordination = fixture.coordination;
  if (coordination === null) {
    throw new Error("createLoginImportService was not called");
  }
  return coordination;
}

async function runLoginImport(payload: LoginImportRequest): Promise<unknown> {
  const bridge = await registerBridge();
  const { RunnerHostInvoke } =
    await import("../../../ipc-contracts/ipc-channels");
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
    fixture.captureResolvedHosts = 0;
    fixture.captureCalls = 0;
    fixture.coordination = null;
    vi.resetModules();
  });

  it("returns the login import service's result untouched, notifiedHosts included", async () => {
    fixture.importResult = {
      status: "imported",
      importedSites: 1,
      importedCookies: 3,
      replacedSites: 0,
      skippedInvalid: 0,
      notifiedHosts: 2,
    };

    const result = await runLoginImport({
      sourceId: "source-1",
      scanId: "scan-1",
      domains: ["example.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual(fixture.importResult);
    // The handler is a pure passthrough now - the push to the hosts already
    // happened inside the (stubbed) service's own `import`, so nothing on
    // this path should call the host push a second time.
    expect(fixture.captureCalls).toBe(0);
  });
});

describe("the pushJarToHosts coordination member handed to createLoginImportService", () => {
  beforeEach(() => {
    fixture.importResult = null;
    fixture.captureShouldReject = false;
    fixture.captureResolvedHosts = 0;
    fixture.captureCalls = 0;
    fixture.coordination = null;
    vi.resetModules();
  });

  it("resolves 0 when the underlying host push rejects", async () => {
    fixture.captureShouldReject = true;
    await registerBridge();

    const result = await requireCoordination().pushJarToHosts();

    expect(result).toBe(0);
    expect(fixture.captureCalls).toBe(1);
  });

  it("resolves the acked host count when the underlying host push resolves", async () => {
    fixture.captureResolvedHosts = 3;
    await registerBridge();

    const result = await requireCoordination().pushJarToHosts();

    expect(result).toBe(3);
    expect(fixture.captureCalls).toBe(1);
  });
});
