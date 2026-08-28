import { beforeEach, describe, expect, it, vi } from "vitest";
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

const captured = vi.hoisted(() => ({
  dispatchedTabs: [] as DispatchElectronTabCdpCall[],
  ensuredTabs: [] as EnsureTabCall[],
  controlledTabs: [] as ControlElectronTabCall[],
}));

vi.mock("electron", () => {
  class BrowserWindow {
    constructor(_options: unknown) {}
  }
  class WebContentsView {
    readonly webContents = {
      id: 1,
      once: () => undefined,
    };
    constructor(_options: unknown) {}
  }
  return {
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
    constructor(_options: unknown) {}

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
  createBrowserViewWebPreferences: vi.fn(() => ({})),
  cancelBrowserViewDownload: vi.fn(),
  clearBrowserViewPendingCertificateError: vi.fn(),
  ensureBrowserViewSession: vi.fn(),
  onBrowserViewCertificateError: vi.fn(),
  onBrowserViewDownloadChange: vi.fn(),
  readBrowserViewPendingCertificateError: vi.fn(() => null),
  registerBrowserViewWebContents: vi.fn(),
}));

vi.mock("../../browser-view/storage/browser-cookie-crypto", () => ({
  getBrowserCookieCryptoState: vi.fn(() =>
    Promise.resolve({
      mode: "real",
      persistence: "persistent",
      reason: "os-backed",
      storageBackend: null,
      encryptionAvailable: true,
    }),
  ),
}));

vi.mock("../../browser-view/storage/browser-storage-state", () => ({
  BrowserPrimaryProfileSnapshotCoordinator: class {
    observe(): void {}

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
  captureBrowserViewStorageState: vi.fn(() =>
    Promise.resolve({
      storageState: { cookies: [], origins: [] },
      cookieCount: 0,
      cookieDomains: [],
      localStorageCount: 0,
      localStorageAvailable: true,
      localStorageReason: null,
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
    safeSendToWindow: vi.fn(),
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
    vi.clearAllMocks();
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
