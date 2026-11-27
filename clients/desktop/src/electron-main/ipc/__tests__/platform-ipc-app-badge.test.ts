import { afterEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { RunnerHostInvoke } from "../../../ipc-contracts/ipc-channels";
import { appIconBadgeWindows } from "../../windows/app-icon-badge-windows";
import { registerPlatformIpc } from "../platform-ipc";

vi.mock("electron", () => ({
  app: {
    getPath: (name: string): string => `/tmp/traycer-test-${name}`,
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
  setDesktopLogLevel: vi.fn(),
}));
vi.mock("@traycer/protocol/config/store", () => ({
  readFeatureSettings: vi.fn(() => ({ agentRolesEnabled: false })),
  readLogLevels: vi.fn(async () => ({
    cliLogLevel: "info",
    hostLogLevel: "info",
  })),
  setAgentRolesEnabled: vi.fn(),
  setLogLevel: vi.fn(),
  setLogLevels: vi.fn(),
}));
vi.mock("@traycer/protocol/config/log-level", () => ({
  isLogLevel: () => true,
}));

type InvokeHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown | Promise<unknown>;

const IPC_EVENT = {} as IpcMainInvokeEvent;
const sender: { windowId: string | null } = { windowId: null };
const live = new Set<string>();
let nextId = 0;

const handlers = new Map<string, InvokeHandler>();
registerPlatformIpc({
  handleInvoke: (channel, handler) => {
    handlers.set(channel, handler);
  },
  resolveSenderWindowId: () => sender.windowId,
});

function badgeHandler(): InvokeHandler {
  const handler = handlers.get(RunnerHostInvoke.appSetBadgeCount);
  if (handler === undefined) {
    throw new Error("appSetBadgeCount handler not registered");
  }
  return handler;
}

function trackWindow(): { readonly id: string } {
  const id = `badge-ipc-${String(nextId)}`;
  nextId += 1;
  appIconBadgeWindows.track(id);
  appIconBadgeWindows.focused(id);
  live.add(id);
  return { id };
}

afterEach(() => {
  for (const id of live) appIconBadgeWindows.forget(id);
  live.clear();
  sender.windowId = null;
});

describe("appSetBadgeCount", () => {
  it("rejects a count that is not a non-negative integer and leaves the badge", () => {
    const { id } = trackWindow();
    appIconBadgeWindows.setCount(id, 4);
    sender.windowId = id;
    const rejected: readonly unknown[] = [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "3",
      null,
    ];

    for (const count of rejected) {
      expect(() => badgeHandler()(IPC_EVENT, count)).toThrow(
        "app icon badge count must be a non-negative integer",
      );
    }
    expect(appIconBadgeWindows.snapshot().count).toBe(4);
  });

  it("stores 0 and a positive integer on the sender's window", () => {
    const older = trackWindow();
    const current = trackWindow();
    appIconBadgeWindows.setCount(older.id, 2);
    expect(appIconBadgeWindows.snapshot().count).toBe(2);

    sender.windowId = current.id;
    badgeHandler()(IPC_EVENT, 7);
    expect(appIconBadgeWindows.snapshot().count).toBe(7);

    badgeHandler()(IPC_EVENT, 0);
    expect(appIconBadgeWindows.snapshot().count).toBe(0);
  });

  it("ignores a sender that resolves to no window", () => {
    const { id } = trackWindow();
    appIconBadgeWindows.setCount(id, 4);
    sender.windowId = null;

    expect(badgeHandler()(IPC_EVENT, 9)).toBeUndefined();
    expect(appIconBadgeWindows.snapshot().count).toBe(4);
  });
});
