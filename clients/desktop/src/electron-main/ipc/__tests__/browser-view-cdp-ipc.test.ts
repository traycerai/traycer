import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindowConstructorOptions } from "electron";
import type {
  BrowserViewElectronTabControl,
  BrowserViewNativeTabCapability,
} from "@traycer-clients/shared/platform/browser-view";
import type {
  BrowserViewElectronTabCdpDispatch,
  BrowserViewEnsureTab,
} from "../../browser-view/browser-view-port";

type DispatchElectronTabCdpCall = BrowserViewElectronTabCdpDispatch;

type EnsureTabCall = {
  readonly windowId: string;
  readonly input: BrowserViewEnsureTab;
};

type ControlElectronTabCall = {
  readonly windowId: string;
  readonly input: BrowserViewElectronTabControl;
};

type InvokeHandler = (
  event: unknown,
  payload: unknown,
) => unknown | Promise<unknown>;

interface AuthSnapshot {
  readonly status: string;
  readonly token: string | null;
  readonly profile: { readonly userId: string } | null;
  /**
   * Whether main itself checked the bearer against authn's signing keys. The
   * renderer hands main the token; only a verified one is a principal.
   */
  readonly verified: boolean;
}

const SIGNED_OUT: AuthSnapshot = {
  status: "signed-out",
  token: null,
  profile: null,
  verified: false,
};

type BrowserViewManagerFactoryOptions = {
  readonly createDevToolsWindow: (windowId: string) => unknown;
  readonly createPopupWindowOptions: (
    request: { readonly profile: string; readonly sessionId: string },
  ) => BrowserWindowConstructorOptions;
};

const captured = vi.hoisted(() => ({
  dispatchedTabs: [] as DispatchElectronTabCdpCall[],
  ensuredTabs: [] as EnsureTabCall[],
  controlledTabs: [] as ControlElectronTabCall[],
  /** The account each jar-plane dial was opened for. */
  transportOpens: [] as string[],
  /** Transports the registry tore back down. */
  transportCloses: 0,
  /** Everyone main told to re-read the auth session. */
  authChangeListeners: [] as Array<() => void>,
  authSnapshot: {
    status: "signed-out",
    token: null,
    profile: null,
    verified: false,
  } as AuthSnapshot,
  browserWindowOptions: [] as BrowserWindowConstructorOptions[],
  webPreferencesRequests: [] as unknown[],
  managerOptions: null as BrowserViewManagerFactoryOptions | null,
}));

vi.mock("electron", () => {
  class BrowserWindow {
    constructor(options: BrowserWindowConstructorOptions) {
      captured.browserWindowOptions.push(options);
    }
  }
  class WebContentsView {
    readonly webContents = {
      id: 1,
      once: () => undefined,
    };
    constructor(_options: unknown) {}
  }
  return {
    app: {
      getPath: (_key: string): string => "/tmp/traycer-desktop-test",
      // Read when a jar-plane transport is dialed.
      getVersion: (): string => "1.0.0",
      relaunch: (): void => undefined,
      exit: (_code: number): void => undefined,
    },
    BrowserWindow,
    WebContentsView,
    dialog: {
      showSaveDialogSync: () => undefined,
      // The destructive handlers ask asynchronously; nothing here raises one.
      showMessageBox: (): Promise<{ readonly response: number }> =>
        Promise.resolve({ response: 0 }),
      showMessageBoxSync: () => 0,
    },
    session: {
      fromPartition: () => ({
        setPermissionRequestHandler: () => undefined,
        setPermissionCheckHandler: () => undefined,
        setDevicePermissionHandler: () => undefined,
        setUSBProtectedClassesHandler: () => undefined,
        setBluetoothPairingHandler: () => undefined,
        setDisplayMediaRequestHandler: () => undefined,
        on: () => undefined,
      }),
    },
    safeStorage: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "unknown",
    },
  };
});

/**
 * The dial itself, over the registry's own fake stream client - so the stream
 * really opens, and a torn-down one really closes.
 */
vi.mock("../../browser-sessions/browser-sessions-transport", async () => {
  const { FakeStreamClient, LOCAL_HOST_ENTRY } =
    await import("../../browser-sessions/__tests__/browser-sessions-stream-fixture");
  return {
    createBrowserSessionsHostDirectory: () => ({
      invalidate: (): void => undefined,
      reset: (): void => undefined,
      resolve: () => Promise.resolve(LOCAL_HOST_ENTRY),
      endpoint: () => ({
        hostId: LOCAL_HOST_ENTRY.hostId,
        websocketUrl: LOCAL_HOST_ENTRY.websocketUrl,
      }),
    }),
    openBrowserSessionsTransport: (_target: unknown, userId: string) => {
      captured.transportOpens.push(userId);
      return {
        wsStreamClient: new FakeStreamClient(false),
        close: (): void => {
          captured.transportCloses += 1;
        },
      };
    },
  };
});

vi.mock("../../app/logger", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
  },
  describeLogError: (err: unknown) => String(err),
}));

vi.mock("../../app/cert-trust", () => ({
  trustBrowserCertificate: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../browser-view/browser-view-manager", () => ({
  BOUNDS_STREAM_LOG_INTERVAL_MS: 1_000,
  BrowserViewManager: class {
    constructor(options: BrowserViewManagerFactoryOptions) {
      captured.managerOptions = options;
    }

    dispatchElectronTabCdp(input: BrowserViewElectronTabCdpDispatch): Promise<{
      readonly kind: "cdpInsertText";
      readonly ok: true;
    }> {
      captured.dispatchedTabs.push(input);
      return Promise.resolve({
        kind: "cdpInsertText",
        ok: true,
      });
    }

    ensureTab(
      windowId: string,
      input: BrowserViewEnsureTab,
    ): Promise<BrowserViewNativeTabCapability> {
      captured.ensuredTabs.push({ windowId, input });
      return Promise.resolve({
        hostId: input.hostId,
        sessionId: input.sessionId,
        tabId: input.tabId,
        registrationId: "registration-1",
      });
    }

    acceptTab(): Promise<void> {
      return Promise.resolve();
    }

    controlElectronTab(
      windowId: string,
      input: BrowserViewElectronTabControl,
    ): Promise<boolean> {
      captured.controlledTabs.push({ windowId, input });
      return Promise.resolve(true);
    }

    dispose(): void {}
  },
}));

vi.mock("../../browser-view/browser-session", () => ({
  createBrowserViewWebPreferences: vi.fn((request: unknown) => {
    captured.webPreferencesRequests.push(request);
    return { request };
  }),
  cancelBrowserViewDownload: vi.fn(),
  clearBrowserViewPendingCertificateError: vi.fn(),
  ensureBrowserViewSession: vi.fn(),
  ensureBrowserViewSessionForPartition: vi.fn(),
  BROWSER_VIEW_PARTITION: "persist:traycer-browser",
  BROWSER_VIEW_EPHEMERAL_PARTITION: "traycer-browser-ephemeral",
  onBrowserPrimaryProfileDelta: vi.fn(() => () => undefined),
  onBrowserViewCertificateError: vi.fn(),
  onBrowserViewDownloadChange: vi.fn(),
  readBrowserViewPendingCertificateError: vi.fn(() => null),
  registerBrowserViewWebContents: vi.fn(),
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

    rememberedOrigins() {
      return [];
    }

    capture() {
      return Promise.resolve({
        status: "captured",
        storageState: { cookies: [], origins: [] },
        reason: null,
      });
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
}));

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
      get: () => captured.authSnapshot,
      on: vi.fn((_event: string, listener: () => void) => {
        captured.authChangeListeners.push(listener);
      }),
      off: vi.fn(),
    },
  };
}

function findInvokeHandler(
  bridge: {
    readonly handleInvoke: {
      readonly mock: {
        readonly calls: ReadonlyArray<ReadonlyArray<unknown>>;
      };
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

/** Drains the microtask queue without ordering anything by a clock. */
function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then().then().then().then();
}

const STREAM_KEY = {
  epicId: "epic-1",
  hostId: "host-1",
  identityKey: "identity-1",
};

/**
 * One renderer asking main to hold a jar-plane stream open, driven to the
 * point where the dial either happened or did not. The directory read is one
 * await wide, so the queue is drained before the answer is read.
 */
async function openSessionsStream(): Promise<void> {
  const { registerBrowserViewIpc } = await import("../browser-view-ipc");
  const { RunnerHostInvoke } =
    await import("../../../ipc-contracts/ipc-channels");
  const bridge = makeBridge();
  registerBrowserViewIpc(bridge as never);
  await findInvokeHandler(bridge, RunnerHostInvoke.browserViewSessionsOpen)(
    {},
    STREAM_KEY,
  );
  await flushMicrotasks();
}

describe("native browser tab IPC", () => {
  beforeEach(() => {
    captured.dispatchedTabs = [];
    captured.ensuredTabs = [];
    captured.controlledTabs = [];
    captured.transportOpens = [];
    captured.transportCloses = 0;
    captured.authChangeListeners = [];
    captured.authSnapshot = SIGNED_OUT;
    captured.browserWindowOptions = [];
    captured.webPreferencesRequests = [];
    captured.managerOptions = null;
    vi.clearAllMocks();
  });

  it("keeps detached DevTools windowed when the renderer is full screen", async () => {
    const { registerBrowserViewIpc } = await import("../browser-view-ipc");

    registerBrowserViewIpc(makeBridge() as never);
    const managerOptions = captured.managerOptions;
    if (managerOptions === null) throw new Error("manager was not registered");
    managerOptions.createDevToolsWindow("window-1");

    expect(captured.browserWindowOptions).toContainEqual(
      expect.objectContaining({
        show: true,
        width: 1200,
        height: 800,
        fullscreenable: false,
      }),
    );
  });

  it("creates a top-level secure popup with the opener's browser session", async () => {
    const { registerBrowserViewIpc } = await import("../browser-view-ipc");

    registerBrowserViewIpc(makeBridge() as never);
    const managerOptions = captured.managerOptions;
    if (managerOptions === null) throw new Error("manager was not registered");

    const request = { profile: "isolated", sessionId: "popup-session" };
    const popupOptions = managerOptions.createPopupWindowOptions(request);

    expect(popupOptions).toEqual(
      expect.objectContaining({
        show: true,
        width: 900,
        height: 700,
        backgroundColor: "#0b0b0d",
        fullscreen: false,
        fullscreenable: false,
        modal: false,
        kiosk: false,
      }),
    );
    expect(popupOptions).not.toHaveProperty("parent");
    expect(popupOptions.webPreferences).toEqual({ request });
    expect(captured.webPreferencesRequests).toEqual([request]);
  });

  // The renderer-facing CDP dispatch and ensure-tab invoke channels
  // (`browserViewElectronTabCdpDispatch`, `browserViewEnsureTab`) were
  // deleted under H10 - the jar/CDP plane moved into main's own
  // `browser-sessions` owner, which calls the manager directly rather than
  // crossing IPC. What is left to pin here is that `BrowserViewManager`
  // still exposes `dispatchElectronTabCdp` / `ensureTab` with the same
  // signatures, so it drives them directly instead of through a deleted
  // sender-scoped handler.
  it("dispatches a curated command with its logical frame target", async () => {
    const { BrowserViewManager } =
      await import("../../browser-view/browser-view-manager");
    const manager = new BrowserViewManager({} as never);
    const input: BrowserViewElectronTabCdpDispatch = {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
      target: {
        kind: "frame",
        frameId: "frame-1",
        parentFrameId: "root-frame",
      },
      command: { kind: "cdpInsertText", text: "hello" },
    };

    await manager.dispatchElectronTabCdp(input);

    expect(captured.dispatchedTabs).toEqual([input]);
  });

  it("passes the native tab storage seed through to the manager", async () => {
    const { BrowserViewManager } =
      await import("../../browser-view/browser-view-manager");
    const manager = new BrowserViewManager({} as never);
    const seedStorageState = {
      cookies: [],
      origins: [
        {
          origin: "https://example.com",
          localStorage: [{ name: "token", value: "carried" }],
        },
      ],
    };
    const input: BrowserViewEnsureTab = {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      requestedUrl: "https://example.com/background",
      profile: "primary",
      seedStorageState,
      // The provenance main prices the seed's jar write against.
      connectionId: "connection-1",
    };

    await manager.ensureTab("window-1", input);

    expect(captured.ensuredTabs).toEqual([{ windowId: "window-1", input }]);
  });

  it("parses native tab control without routing through a surface key", async () => {
    const { registerBrowserViewIpc } = await import("../browser-view-ipc");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");

    const bridge = makeBridge();
    registerBrowserViewIpc(bridge as never);
    const handler = findInvokeHandler(
      bridge,
      RunnerHostInvoke.browserViewControlElectronTab,
    );
    await handler(
      {},
      {
        hostId: "host-1",
        sessionId: "session-1",
        tabId: "tab-1",
        registrationId: "registration-1",
        action: { kind: "navigate", url: "https://example.com/next" },
      },
    );

    expect(captured.controlledTabs).toEqual([
      {
        windowId: "window-1",
        input: {
          hostId: "host-1",
          sessionId: "session-1",
          tabId: "tab-1",
          registrationId: "registration-1",
          action: { kind: "navigate", url: "https://example.com/next" },
        },
      },
    ]);
  });

  // The jar plane's principal is a VERIFIED session, not merely a signed-in
  // one. Main is handed its bearer by the renderer, so a session it has not
  // checked against authn's signing keys is not a degraded principal - it is
  // no principal at all, and everything on the plane (the dial, the relay
  // grant, the store-key wrap, the ledger's per-user match) reads the same
  // answer.
  it("opens no jar-plane stream for a signed-in session main has not verified", async () => {
    captured.authSnapshot = {
      status: "signed-in",
      token: "bearer-1",
      profile: { userId: "user-1" },
      verified: false,
    };

    await openSessionsStream();

    expect(captured.transportOpens).toEqual([]);
  });

  it("tears a live stream down when the session it was opened for stops being verified", async () => {
    captured.authSnapshot = {
      status: "signed-in",
      token: "bearer-1",
      profile: { userId: "user-1" },
      verified: true,
    };

    await openSessionsStream();

    expect(captured.transportOpens).toEqual(["user-1"]);

    // The same edge a sign-out takes: the account this stream speaks for is
    // read fresh, answers null, and no longer matches the one it was opened
    // for - so the socket goes rather than carrying a credential main can no
    // longer vouch for.
    captured.authSnapshot = {
      status: "signed-in",
      token: "bearer-1",
      profile: { userId: "user-1" },
      verified: false,
    };
    for (const listener of captured.authChangeListeners) listener();
    await flushMicrotasks();

    expect(captured.transportCloses).toBe(1);
    expect(captured.transportOpens).toEqual(["user-1"]);
  });
});
