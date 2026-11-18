import { afterEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { RunnerHostInvoke } from "../../../ipc-contracts/ipc-channels";
import { registerPlatformIpc } from "../platform-ipc";

const setLogLevelMock = vi.hoisted(() => vi.fn());
const setLogLevelsMock = vi.hoisted(() => vi.fn());
const setDesktopLogLevelMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  app: {
    getPath: (name: string): string => `/tmp/traycer-test-${name}`,
  },
  BrowserWindow: {
    fromWebContents: (): null => null,
  },
  clipboard: {
    writeImage: vi.fn(),
    readBuffer: (): Buffer => Buffer.alloc(0),
  },
  dialog: {
    showSaveDialog: vi.fn(async () => ({ canceled: true })),
  },
  nativeImage: {
    createFromBuffer: vi.fn(),
  },
}));

vi.mock("../../app/recent-documents", () => ({
  rememberRecentDocument: vi.fn(),
}));
vi.mock("../../app/window-effects", () => ({
  handleFlashFrame: vi.fn(),
  handleSetBadge: vi.fn(),
  handleSetContentProtection: vi.fn(),
  handleSetDocumentEdited: vi.fn(),
  handleSetOverlayIcon: vi.fn(),
  handleSetProgressBar: vi.fn(),
  handleSetRepresentedFilename: vi.fn(),
  handleSetTitleBarOverlay: vi.fn(),
}));
vi.mock("../../app/diagnostics", () => ({
  handleGetMetrics: vi.fn(),
  handleTakeHeapSnapshot: vi.fn(),
  handleTraceStart: vi.fn(),
  handleTraceStop: vi.fn(),
}));
vi.mock("../../app/system-prefs", () => ({
  canPromptTouchID: vi.fn(() => false),
  getAccentColor: vi.fn(() => null),
  getEffectiveAppearance: vi.fn(() => "light"),
  handleSetBackgroundMaterial: vi.fn(),
  handleSetVibrancy: vi.fn(),
  handleSetVisibleOnAllWorkspaces: vi.fn(),
  promptTouchID: vi.fn(async () => false),
}));
vi.mock("../../app/resilience", () => ({
  readAccessibilityTheme: vi.fn(() => null),
}));
vi.mock("../../app/installed-fonts", () => ({
  listInstalledFonts: vi.fn(async () => []),
}));
vi.mock("../../app/proxy-auth", () => ({
  clearProxyCredentials: vi.fn(),
  listKnownProxyCredentials: vi.fn(() => []),
  resolveProxyForUrl: vi.fn(async () => null),
  saveProxyCredentials: vi.fn(),
  setSessionProxy: vi.fn(),
}));
vi.mock("../../app/cert-trust", () => ({
  dismissPendingCertificateError: vi.fn(),
  listPendingCertificateErrors: vi.fn(() => []),
  listTrustedCertificates: vi.fn(() => []),
  showSystemCertificateTrustDialog: vi.fn(async () => false),
  trustCertificate: vi.fn(),
  untrustCertificate: vi.fn(),
}));
vi.mock("../../app/screen-monitor", () => ({
  readDisplayTopology: vi.fn(() => ({ displays: [] })),
}));
vi.mock("../../clipboard/native-clipboard-file-paths", () => ({
  readNativeClipboardFilePaths: vi.fn(() => []),
}));
vi.mock("../../app/gpu-acceleration", () => ({
  getHardwareAccelerationPreference: vi.fn(() => true),
  setHardwareAccelerationPreference: vi.fn(),
}));
vi.mock("../../app/desktop-log-level", () => ({
  getDesktopLogLevel: vi.fn(() => "info"),
  setDesktopLogLevel: setDesktopLogLevelMock,
}));
vi.mock("@traycer/protocol/config/store", () => ({
  readFeatureSettings: vi.fn(() => ({ agentRolesEnabled: false })),
  readLogLevels: vi.fn(async () => ({
    cliLogLevel: "info",
    hostLogLevel: "info",
  })),
  setAgentRolesEnabled: vi.fn(),
  setLogLevel: setLogLevelMock,
  setLogLevels: setLogLevelsMock,
}));
vi.mock("@traycer/protocol/config/log-level", () => ({
  isLogLevel: () => true,
}));

type InvokeHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown | Promise<unknown>;

const IPC_EVENT = {} as IpcMainInvokeEvent;

function logLevelsSet(): InvokeHandler {
  const handlers = new Map<string, InvokeHandler>();
  registerPlatformIpc({
    handleInvoke: (channel, handler) => {
      handlers.set(channel, handler);
    },
  });
  const handler = handlers.get(RunnerHostInvoke.logLevelsSet);
  if (handler === undefined) {
    throw new Error("logLevels:set handler not registered");
  }
  return handler;
}

describe("logLevels:set", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // Each scoped change must reach the store as one scoped write: reading both
  // thresholds first and writing both back reverts a concurrent change to the
  // other one.
  it.each(["host", "cli"] as const)(
    "sets only the %s threshold through the scoped store setter",
    async (scope) => {
      await logLevelsSet()(IPC_EVENT, { scope, level: "debug" });

      expect(setLogLevelMock).toHaveBeenCalledTimes(1);
      expect(setLogLevelMock).toHaveBeenCalledWith(scope, "debug");
      expect(setLogLevelsMock).not.toHaveBeenCalled();
      expect(setDesktopLogLevelMock).not.toHaveBeenCalled();
    },
  );

  it("sets the desktop threshold without touching config.json", async () => {
    await logLevelsSet()(IPC_EVENT, { scope: "desktop", level: "warn" });

    expect(setDesktopLogLevelMock).toHaveBeenCalledTimes(1);
    expect(setDesktopLogLevelMock).toHaveBeenCalledWith("warn");
    expect(setLogLevelMock).not.toHaveBeenCalled();
    expect(setLogLevelsMock).not.toHaveBeenCalled();
  });
});
