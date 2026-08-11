import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunnerHostInvoke } from "../../../ipc-contracts/ipc-channels";
import type { RunnerIpcBridge } from "../runner-ipc-bridge";

const writeImageMock = vi.hoisted(() => vi.fn());
const createFromBufferMock = vi.hoisted(() =>
  vi.fn((buffer: Buffer) => ({
    isEmpty: () => buffer.byteLength === 0,
  })),
);

vi.mock("electron", () => ({
  app: {
    getPath: (name: string): string => `/tmp/traycer-test-${name}`,
  },
  BrowserWindow: {
    fromWebContents: (): null => null,
  },
  clipboard: {
    writeImage: writeImageMock,
    readBuffer: (): Buffer => Buffer.alloc(0),
  },
  dialog: {
    showSaveDialog: vi.fn(async () => ({ canceled: true })),
  },
  nativeImage: {
    createFromBuffer: createFromBufferMock,
  },
}));

// Platform IPC pulls system helpers; keep them inert for this validation suite.
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
  setDesktopLogLevel: vi.fn(),
}));
vi.mock("@traycer/protocol/config/store", () => ({
  readFeatureSettings: vi.fn(() => ({ agentRolesEnabled: false })),
  readLogLevels: vi.fn(() => ({})),
  setAgentRolesEnabled: vi.fn(),
  setLogLevels: vi.fn(),
}));
vi.mock("@traycer/protocol/config/log-level", () => ({
  isLogLevel: () => true,
}));

import { registerPlatformIpc } from "../platform-ipc";

type InvokeHandler = (
  event: unknown,
  ...args: unknown[]
) => unknown | Promise<unknown>;

function installPlatformHandlers(): Map<string, InvokeHandler> {
  const handlers = new Map<string, InvokeHandler>();
  const bridge = {
    handleInvoke: (channel: string, handler: InvokeHandler) => {
      handlers.set(channel, handler);
    },
  } as RunnerIpcBridge;
  registerPlatformIpc(bridge);
  return handlers;
}

describe("platform IPC clipboard.writeImage validation", () => {
  beforeEach(() => {
    writeImageMock.mockReset();
    createFromBufferMock.mockClear();
  });

  it("writes a valid image payload through nativeImage + clipboard", async () => {
    const handlers = installPlatformHandlers();
    const handler = handlers.get(RunnerHostInvoke.clipboardWriteImage);
    expect(handler).toBeTypeOf("function");

    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]).buffer;
    await handler?.({}, { type: "image/png", bytes });

    expect(createFromBufferMock).toHaveBeenCalledTimes(1);
    expect(writeImageMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-object payload", async () => {
    const handlers = installPlatformHandlers();
    const handler = handlers.get(RunnerHostInvoke.clipboardWriteImage);
    await expect(
      Promise.resolve().then(() => handler?.({}, "not-an-object")),
    ).rejects.toThrow(/object payload/i);
    expect(writeImageMock).not.toHaveBeenCalled();
  });

  it("rejects a non-image MIME type", async () => {
    const handlers = installPlatformHandlers();
    const handler = handlers.get(RunnerHostInvoke.clipboardWriteImage);
    await expect(
      Promise.resolve().then(() =>
        handler?.({}, { type: "text/plain", bytes: new ArrayBuffer(4) }),
      ),
    ).rejects.toThrow(/image MIME type/i);
  });

  it("rejects missing ArrayBuffer bytes", async () => {
    const handlers = installPlatformHandlers();
    const handler = handlers.get(RunnerHostInvoke.clipboardWriteImage);
    await expect(
      Promise.resolve().then(() =>
        handler?.({}, { type: "image/png", bytes: [1, 2, 3] }),
      ),
    ).rejects.toThrow(/image bytes under 30 MB/i);
  });

  it("rejects image bytes over 30 MB", async () => {
    const handlers = installPlatformHandlers();
    const handler = handlers.get(RunnerHostInvoke.clipboardWriteImage);
    const oversized = new ArrayBuffer(30 * 1024 * 1024 + 1);
    await expect(
      Promise.resolve().then(() =>
        handler?.({}, { type: "image/png", bytes: oversized }),
      ),
    ).rejects.toThrow(/image bytes under 30 MB/i);
  });

  it("rejects nativeImage-empty payloads", async () => {
    const handlers = installPlatformHandlers();
    const handler = handlers.get(RunnerHostInvoke.clipboardWriteImage);
    await expect(
      Promise.resolve().then(() =>
        handler?.({}, { type: "image/png", bytes: new ArrayBuffer(0) }),
      ),
    ).rejects.toThrow(/clipboard image bytes are invalid/i);
    expect(writeImageMock).not.toHaveBeenCalled();
  });
});
