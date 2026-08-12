import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import {
  clipboardImageMediaTypes,
  type ClipboardImageMediaType,
} from "@traycer-clients/shared/images/clipboard-image-media";
import { MAX_ARTIFACT_IMAGE_BYTES } from "@traycer/protocol/host/epic/unary-schemas";
import { RunnerHostInvoke } from "../../../ipc-contracts/ipc-channels";
import { registerPlatformIpc } from "../platform-ipc";

const writeImageMock = vi.hoisted(() => vi.fn());
const createFromBufferMock = vi.hoisted(() =>
  vi.fn((buffer: Buffer) => ({
    isEmpty: () => buffer.byteLength === 0,
    getSize: () => ({ width: 32, height: 24 }),
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

type InvokeHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown | Promise<unknown>;

const IPC_EVENT = {} as IpcMainInvokeEvent;

function installPlatformHandlers(): Map<string, InvokeHandler> {
  const handlers = new Map<string, InvokeHandler>();
  registerPlatformIpc({
    handleInvoke: (channel, handler) => {
      handlers.set(channel, handler);
    },
  });
  return handlers;
}

/** PNG magic + IHDR with arbitrary dimensions (header-only; enough for sniff). */
function pngWithDimensions(width: number, height: number): ArrayBuffer {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8;
  bytes[25] = 2;
  return bytes.buffer;
}

/** JPEG SOI + SOF0 with given dimensions. */
function jpegWithDimensions(width: number, height: number): ArrayBuffer {
  const bytes = new Uint8Array(20);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes[3] = 0xc0;
  bytes[4] = 0x00;
  bytes[5] = 0x0b;
  bytes[6] = 0x08;
  bytes[7] = (height >> 8) & 0xff;
  bytes[8] = height & 0xff;
  bytes[9] = (width >> 8) & 0xff;
  bytes[10] = width & 0xff;
  bytes[11] = 0x01;
  bytes[12] = 0x01;
  bytes[13] = 0x11;
  bytes[14] = 0x00;
  return bytes.buffer;
}

function jpegWithLargeMetadata(width: number, height: number): ArrayBuffer {
  const metadataLength = 70_000;
  const sofOffset = 4 + metadataLength;
  const bytes = new Uint8Array(sofOffset + 16);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes[3] = 0xe1;
  bytes[4] = (metadataLength >> 8) & 0xff;
  bytes[5] = metadataLength & 0xff;
  bytes[sofOffset] = 0xff;
  bytes[sofOffset + 1] = 0xc0;
  bytes[sofOffset + 2] = 0x00;
  bytes[sofOffset + 3] = 0x0b;
  bytes[sofOffset + 4] = 0x08;
  bytes[sofOffset + 5] = (height >> 8) & 0xff;
  bytes[sofOffset + 6] = height & 0xff;
  bytes[sofOffset + 7] = (width >> 8) & 0xff;
  bytes[sofOffset + 8] = width & 0xff;
  bytes[sofOffset + 9] = 0x01;
  bytes[sofOffset + 10] = 0x01;
  bytes[sofOffset + 11] = 0x11;
  bytes[sofOffset + 12] = 0x00;
  return bytes.buffer;
}

const ALLOWLISTED_IMAGE_CASES: ReadonlyArray<{
  readonly type: ClipboardImageMediaType;
  readonly bytes: ArrayBuffer;
  readonly label: string;
}> = [
  {
    type: "image/png",
    bytes: pngWithDimensions(32, 24),
    label: "PNG IHDR",
  },
  {
    type: "image/jpeg",
    bytes: jpegWithDimensions(32, 24),
    label: "JPEG SOF0",
  },
];

describe("platform IPC clipboard.writeImage validation", () => {
  beforeEach(() => {
    writeImageMock.mockReset();
    createFromBufferMock.mockClear();
  });

  it.each(ALLOWLISTED_IMAGE_CASES)(
    "writes allowlisted $type ($label) through nativeImage",
    async ({ type, bytes }) => {
      const handlers = installPlatformHandlers();
      const handler = handlers.get(RunnerHostInvoke.clipboardWriteImage);
      expect(handler).toBeTypeOf("function");

      await handler?.(IPC_EVENT, { type, bytes });

      expect(createFromBufferMock).toHaveBeenCalledTimes(1);
      expect(writeImageMock).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps the native clipboard allowlist to formats Electron decodes", () => {
    expect(clipboardImageMediaTypes).toEqual(["image/png", "image/jpeg"]);
  });

  it("rejects a non-object payload without decoding", async () => {
    const handlers = installPlatformHandlers();
    const handler = handlers.get(RunnerHostInvoke.clipboardWriteImage);
    await expect(
      Promise.resolve().then(() => handler?.(IPC_EVENT, "not-an-object")),
    ).rejects.toThrow(/object payload/i);
    expect(createFromBufferMock).not.toHaveBeenCalled();
    expect(writeImageMock).not.toHaveBeenCalled();
  });

  it("rejects non-allowlisted image/* MIME types before nativeImage", async () => {
    const handlers = installPlatformHandlers();
    const handler = handlers.get(RunnerHostInvoke.clipboardWriteImage);
    for (const type of [
      "text/plain",
      "image/bmp",
      "image/tiff",
      "image/gif",
      "image/webp",
      "image/svg+xml",
      "image/heic",
      "image/x-icon",
    ] as const) {
      createFromBufferMock.mockClear();
      await expect(
        Promise.resolve().then(() =>
          handler?.(IPC_EVENT, {
            type,
            bytes: pngWithDimensions(8, 8),
          }),
        ),
      ).rejects.toThrow(/image MIME type/i);
      expect(createFromBufferMock).not.toHaveBeenCalled();
    }
  });

  it("rejects image bytes over 30 MB without decoding", async () => {
    const handlers = installPlatformHandlers();
    const handler = handlers.get(RunnerHostInvoke.clipboardWriteImage);
    const oversized = new ArrayBuffer(MAX_ARTIFACT_IMAGE_BYTES + 1);
    await expect(
      Promise.resolve().then(() =>
        handler?.(IPC_EVENT, {
          type: "image/png",
          bytes: oversized,
        }),
      ),
    ).rejects.toThrow(/image bytes under 30 MB/i);
    expect(createFromBufferMock).not.toHaveBeenCalled();
  });

  it("rejects payloads Electron cannot decode", async () => {
    createFromBufferMock.mockImplementationOnce(() => ({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
    }));
    const handlers = installPlatformHandlers();
    const handler = handlers.get(RunnerHostInvoke.clipboardWriteImage);
    await expect(
      Promise.resolve().then(() =>
        handler?.(IPC_EVENT, {
          type: "image/png",
          bytes: pngWithDimensions(8, 8),
        }),
      ),
    ).rejects.toThrow(/clipboard image bytes are invalid/i);
    expect(createFromBufferMock).toHaveBeenCalledTimes(1);
    expect(writeImageMock).not.toHaveBeenCalled();
  });

  it("rejects decoded images over 64 MP", async () => {
    createFromBufferMock.mockImplementationOnce(() => ({
      isEmpty: () => false,
      getSize: () => ({ width: 10_000, height: 10_000 }),
    }));
    const handlers = installPlatformHandlers();
    const handler = handlers.get(RunnerHostInvoke.clipboardWriteImage);
    await expect(
      Promise.resolve().then(() =>
        handler?.(IPC_EVENT, {
          type: "image/png",
          bytes: pngWithDimensions(8, 8),
        }),
      ),
    ).rejects.toThrow(/clipboard image bytes are invalid/i);
    expect(writeImageMock).not.toHaveBeenCalled();
  });

  it("rejects oversized encoded PNG dimensions before native decoding", async () => {
    const handlers = installPlatformHandlers();
    const handler = handlers.get(RunnerHostInvoke.clipboardWriteImage);
    await expect(
      Promise.resolve().then(() =>
        handler?.(IPC_EVENT, {
          type: "image/png",
          bytes: pngWithDimensions(10_000, 10_000),
        }),
      ),
    ).rejects.toThrow(/clipboard image bytes are invalid/i);
    expect(createFromBufferMock).not.toHaveBeenCalled();
  });

  it("rejects oversized encoded JPEG dimensions before native decoding", async () => {
    const handlers = installPlatformHandlers();
    const handler = handlers.get(RunnerHostInvoke.clipboardWriteImage);
    await expect(
      Promise.resolve().then(() =>
        handler?.(IPC_EVENT, {
          type: "image/jpeg",
          bytes: jpegWithDimensions(10_000, 10_000),
        }),
      ),
    ).rejects.toThrow(/clipboard image bytes are invalid/i);
    expect(createFromBufferMock).not.toHaveBeenCalled();
  });

  it("scans past large JPEG metadata before reading dimensions", async () => {
    const handlers = installPlatformHandlers();
    const handler = handlers.get(RunnerHostInvoke.clipboardWriteImage);
    await handler?.(IPC_EVENT, {
      type: "image/jpeg",
      bytes: jpegWithLargeMetadata(32, 24),
    });
    expect(createFromBufferMock).toHaveBeenCalledTimes(1);
    expect(writeImageMock).toHaveBeenCalledTimes(1);
  });
});
