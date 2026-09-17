import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type InvokeHandler = (
  event: unknown,
  payload: unknown,
) => unknown | Promise<unknown>;

const captured = vi.hoisted(() => ({
  transportOpens: [] as string[],
  transportCloses: 0,
  markedRendererUnavailable: [] as string[],
}));

vi.mock("electron", () => {
  class BrowserWindow {
    readonly webContents = new EventEmitter();
    isDestroyed(): boolean {
      return false;
    }
  }
  return {
    app: {
      getPath: (): string => "/tmp/traycer-desktop-test",
      getVersion: (): string => "1.0.0",
      relaunch: (): void => undefined,
      exit: (): void => undefined,
    },
    BrowserWindow,
    dialog: {
      showSaveDialogSync: () => undefined,
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
 * The dial itself, over the registry's own fake stream client - so opening a
 * stream really registers a client, and closing it really tears one down.
 * Mirrors `browser-view-cdp-ipc.test.ts`'s mock of the same module.
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
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  describeLogError: (err: unknown) => String(err),
}));

vi.mock("../../app/cert-trust", () => ({
  trustBrowserCertificate: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../browser-view/browser-session", () => ({
  createBrowserViewWebPreferences: vi.fn((request: unknown) => ({ request })),
  cancelBrowserViewDownload: vi.fn(),
  clearBrowserViewPendingCertificateError: vi.fn(),
  ensureBrowserViewSession: vi.fn(),
  ensureBrowserViewSessionForPartition: vi.fn(),
  BROWSER_VIEW_PARTITION: "persist:traycer-browser",
  BROWSER_VIEW_EPHEMERAL_PARTITION: "traycer-browser-ephemeral",
  onBrowserPrimaryProfileDelta: vi.fn(() => () => undefined),
  onBrowserViewCertificateError: vi.fn(() => () => undefined),
  onBrowserViewDownloadChange: vi.fn(() => () => undefined),
  readBrowserViewPendingCertificateError: vi.fn(() => null),
  registerBrowserViewWebContents: vi.fn(),
  suppressAllBrowserPrimaryProfileDeltas: vi.fn(
    (action: () => Promise<unknown>) => action(),
  ),
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

function makeBridge(windows: Record<string, unknown>) {
  return {
    handleInvoke: vi.fn(),
    disposeFns: [] as Array<() => void>,
    windowRegistry: {
      getRecordById: vi.fn((windowId: string) => {
        const window = windows[windowId];
        return window === undefined ? null : { window };
      }),
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
    markRendererUnavailable: vi.fn((windowId: string) => {
      captured.markedRendererUnavailable.push(windowId);
    }),
    options: {
      authnBaseUrl: "https://authn.test",
      host: {
        getSnapshot: () => null,
        on: vi.fn(),
        off: vi.fn(),
      },
    },
    authSession: {
      get: () => ({
        status: "signed-in",
        token: "test-token",
        profile: { userId: "user-1" },
        verified: true,
      }),
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

function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then().then().then().then();
}

const STREAM_KEY = {
  scope: { kind: "epic", epicId: "epic-1" },
  hostId: "host-1",
  identityKey: "identity-1",
};

describe("browser.sessions stream reset on a host window reload", () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
  });
  beforeEach(() => {
    captured.transportOpens = [];
    captured.transportCloses = 0;
    captured.markedRendererUnavailable = [];
    vi.clearAllMocks();
  });

  it("reopens a no-guest window's stream after a main-frame reload", async () => {
    const { registerBrowserViewIpc } = await import("../browser-view-ipc");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const { BrowserWindow } = await import("electron");
    const hostWindow = new BrowserWindow({});
    const bridge = makeBridge({ "window-1": hostWindow });
    registerBrowserViewIpc(bridge as never);
    disposers.push(...bridge.disposeFns);
    const openSessions = findInvokeHandler(
      bridge,
      RunnerHostInvoke.browserViewSessionsOpen,
    );

    await openSessions({}, STREAM_KEY);
    await flushMicrotasks();
    expect(captured.transportOpens).toHaveLength(1);

    await openSessions({}, STREAM_KEY);
    expect(hostWindow.webContents.listenerCount("did-start-navigation")).toBe(
      1,
    );
    expect(hostWindow.webContents.listenerCount("render-process-gone")).toBe(1);
    hostWindow.webContents.emit(
      "did-start-navigation",
      {},
      "about:blank",
      true,
      true,
    );
    hostWindow.webContents.emit(
      "did-start-navigation",
      {},
      "about:blank",
      false,
      false,
    );
    expect(captured.transportCloses).toBe(0);

    hostWindow.webContents.emit(
      "did-start-navigation",
      {},
      "http://localhost/",
      false,
      true,
    );

    expect(captured.transportCloses).toBe(1);
    expect(captured.markedRendererUnavailable).toEqual(["window-1"]);

    await openSessions({}, STREAM_KEY);
    await flushMicrotasks();
    expect(captured.transportOpens).toHaveLength(2);
  });
});
