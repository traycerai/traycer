import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindowConstructorOptions } from "electron";
import type {
  BrowserViewElectronTabCdpDispatch,
  BrowserViewElectronTabControl,
  BrowserViewEnsureTab,
  BrowserViewNativeTabCapability,
} from "@traycer-clients/shared/platform/browser-view";

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

type BrowserViewManagerFactoryOptions = {
  readonly createDevToolsWindow: (windowId: string) => unknown;
  readonly createPopupWindowOptions: (request: {
    readonly profile: string;
    readonly sessionId: string;
  }) => BrowserWindowConstructorOptions;
};

const captured = vi.hoisted(() => ({
  dispatchedTabs: [] as DispatchElectronTabCdpCall[],
  ensuredTabs: [] as EnsureTabCall[],
  controlledTabs: [] as ControlElectronTabCall[],
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
      relaunch: (): void => undefined,
      exit: (_code: number): void => undefined,
    },
    BrowserWindow,
    WebContentsView,
    dialog: {
      showSaveDialogSync: () => undefined,
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
  seedBrowserViewCookies: vi.fn(() => Promise.resolve()),
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

describe("native browser tab IPC", () => {
  beforeEach(() => {
    captured.dispatchedTabs = [];
    captured.ensuredTabs = [];
    captured.controlledTabs = [];
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

  it("dispatches a curated command with its logical frame target", async () => {
    const { registerBrowserViewIpc } = await import("../browser-view-ipc");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");

    const bridge = makeBridge();
    registerBrowserViewIpc(bridge as never);
    const handler = findInvokeHandler(
      bridge,
      RunnerHostInvoke.browserViewElectronTabCdpDispatch,
    );
    await handler(
      {},
      {
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
      },
    );

    expect(captured.dispatchedTabs).toEqual([
      {
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
      },
    ]);
  });

  it("passes the native tab storage seed through the IPC parser", async () => {
    const { registerBrowserViewIpc } = await import("../browser-view-ipc");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");

    const bridge = makeBridge();
    registerBrowserViewIpc(bridge as never);
    const handler = findInvokeHandler(
      bridge,
      RunnerHostInvoke.browserViewEnsureTab,
    );
    const seedStorageState = {
      cookies: [],
      origins: [
        {
          origin: "https://example.com",
          localStorage: [{ name: "token", value: "carried" }],
        },
      ],
    };

    await handler(
      {},
      {
        hostId: "host-1",
        sessionId: "session-1",
        tabId: "tab-1",
        requestedUrl: "https://example.com/background",
        seedStorageState,
      },
    );

    expect(captured.ensuredTabs).toEqual([
      {
        windowId: "window-1",
        input: expect.objectContaining({
          hostId: "host-1",
          sessionId: "session-1",
          tabId: "tab-1",
          requestedUrl: "https://example.com/background",
          seedStorageState,
        }),
      },
    ]);
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
});
