import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { RunnerHostInvoke } from "../../../ipc-contracts/ipc-channels";
import { registerPlatformIpc } from "../platform-ipc";

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

type AllowlistedMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

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

/** GIF89a logical screen descriptor with given dimensions. */
function gifWithDimensions(width: number, height: number): ArrayBuffer {
  const bytes = new Uint8Array(13);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
  bytes[6] = width & 0xff;
  bytes[7] = (width >> 8) & 0xff;
  bytes[8] = height & 0xff;
  bytes[9] = (height >> 8) & 0xff;
  return bytes.buffer;
}

/** WebP VP8X canvas with given dimensions (stores width-1 / height-1). */
function webpVp8xWithDimensions(width: number, height: number): ArrayBuffer {
  const bytes = new Uint8Array(30);
  const view = new DataView(bytes.buffer);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, 22, true);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x58], 12);
  view.setUint32(16, 10, true);
  const canvasW = width - 1;
  const canvasH = height - 1;
  bytes[24] = canvasW & 0xff;
  bytes[25] = (canvasW >> 8) & 0xff;
  bytes[26] = (canvasW >> 16) & 0xff;
  bytes[27] = canvasH & 0xff;
  bytes[28] = (canvasH >> 8) & 0xff;
  bytes[29] = (canvasH >> 16) & 0xff;
  return bytes.buffer;
}

/** WebP VP8 lossy frame header with 14-bit dimensions. */
function webpVp8WithDimensions(width: number, height: number): ArrayBuffer {
  const payloadLen = 10;
  const bytes = new Uint8Array(20 + payloadLen);
  const view = new DataView(bytes.buffer);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, 12 + payloadLen, true);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x20], 12); // "VP8 "
  view.setUint32(16, payloadLen, true);
  bytes[20] = 0x00;
  bytes[21] = 0x00;
  bytes[22] = 0x00;
  bytes[23] = 0x9d;
  bytes[24] = 0x01;
  bytes[25] = 0x2a;
  view.setUint16(26, width & 0x3fff, true);
  view.setUint16(28, height & 0x3fff, true);
  return bytes.buffer;
}

/** WebP VP8L lossless header with encoded dimensions. */
function webpVp8lWithDimensions(width: number, height: number): ArrayBuffer {
  const payloadLen = 5;
  const bytes = new Uint8Array(20 + payloadLen);
  const view = new DataView(bytes.buffer);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, 12 + payloadLen, true);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x4c], 12); // "VP8L"
  view.setUint32(16, payloadLen, true);
  bytes[20] = 0x2f;
  const w = width - 1;
  const h = height - 1;
  const bits = w | (h << 14);
  bytes[21] = bits & 0xff;
  bytes[22] = (bits >> 8) & 0xff;
  bytes[23] = (bits >> 16) & 0xff;
  bytes[24] = (bits >> 24) & 0xff;
  return bytes.buffer;
}

const ALLOWLISTED_IMAGE_CASES: ReadonlyArray<{
  readonly type: AllowlistedMime;
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
  {
    type: "image/gif",
    bytes: gifWithDimensions(32, 24),
    label: "GIF89a screen",
  },
  {
    type: "image/webp",
    bytes: webpVp8WithDimensions(32, 24),
    label: "WebP VP8",
  },
  {
    type: "image/webp",
    bytes: webpVp8lWithDimensions(32, 24),
    label: "WebP VP8L",
  },
];

describe("platform IPC clipboard.writeImage validation", () => {
  beforeEach(() => {
    writeImageMock.mockReset();
    createFromBufferMock.mockClear();
  });

  it.each(ALLOWLISTED_IMAGE_CASES)(
    "writes allowlisted $type ($label) through nativeImage after header sniff",
    async ({ type, bytes }) => {
      const handlers = installPlatformHandlers();
      const handler = handlers.get(RunnerHostInvoke.clipboardWriteImage);
      expect(handler).toBeTypeOf("function");

      await handler?.(IPC_EVENT, { type, bytes });

      expect(createFromBufferMock).toHaveBeenCalledTimes(1);
      expect(writeImageMock).toHaveBeenCalledTimes(1);
    },
  );

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

  it("rejects magic/MIME mismatches without calling nativeImage.createFromBuffer", async () => {
    const handlers = installPlatformHandlers();
    const handler = handlers.get(RunnerHostInvoke.clipboardWriteImage);
    // Declared PNG but bytes are JPEG.
    await expect(
      Promise.resolve().then(() =>
        handler?.(IPC_EVENT, {
          type: "image/png",
          bytes: jpegWithDimensions(16, 16),
        }),
      ),
    ).rejects.toThrow(/valid PNG, JPEG, GIF, or WebP/i);
    expect(createFromBufferMock).not.toHaveBeenCalled();

    // Declared JPEG but bytes are PNG.
    await expect(
      Promise.resolve().then(() =>
        handler?.(IPC_EVENT, {
          type: "image/jpeg",
          bytes: pngWithDimensions(16, 16),
        }),
      ),
    ).rejects.toThrow(/valid PNG, JPEG, GIF, or WebP/i);
    expect(createFromBufferMock).not.toHaveBeenCalled();
  });

  it("rejects truncated and malformed headers without decoding", async () => {
    const handlers = installPlatformHandlers();
    const handler = handlers.get(RunnerHostInvoke.clipboardWriteImage);

    const pngMagicOnly = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]).buffer;
    await expect(
      Promise.resolve().then(() =>
        handler?.(IPC_EVENT, {
          type: "image/png",
          bytes: pngMagicOnly,
        }),
      ),
    ).rejects.toThrow(/valid PNG, JPEG, GIF, or WebP/i);
    expect(createFromBufferMock).not.toHaveBeenCalled();

    const truncatedIhdr = new Uint8Array(20);
    truncatedIhdr.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    await expect(
      Promise.resolve().then(() =>
        handler?.(IPC_EVENT, {
          type: "image/png",
          bytes: truncatedIhdr.buffer,
        }),
      ),
    ).rejects.toThrow(/valid PNG, JPEG, GIF, or WebP/i);
    expect(createFromBufferMock).not.toHaveBeenCalled();

    const jpegSoiOnly = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;
    await expect(
      Promise.resolve().then(() =>
        handler?.(IPC_EVENT, {
          type: "image/jpeg",
          bytes: jpegSoiOnly,
        }),
      ),
    ).rejects.toThrow(/valid PNG, JPEG, GIF, or WebP/i);
    expect(createFromBufferMock).not.toHaveBeenCalled();
  });

  it("rejects pre-decode pixel-bomb dimensions without calling nativeImage.createFromBuffer", async () => {
    const handlers = installPlatformHandlers();
    const handler = handlers.get(RunnerHostInvoke.clipboardWriteImage);
    // 10000 x 10000 = 100 MP > 64 MP ceiling. Header-only payload is tiny.
    const bomb = pngWithDimensions(10_000, 10_000);
    expect(bomb.byteLength).toBeLessThan(64);

    await expect(
      Promise.resolve().then(() =>
        handler?.(IPC_EVENT, {
          type: "image/png",
          bytes: bomb,
        }),
      ),
    ).rejects.toThrow(/64 MP|valid PNG, JPEG, GIF, or WebP/i);
    expect(createFromBufferMock).not.toHaveBeenCalled();
    expect(writeImageMock).not.toHaveBeenCalled();
  });

  it("rejects oversized JPEG and GIF dimensions before createFromBuffer", async () => {
    const handlers = installPlatformHandlers();
    const handler = handlers.get(RunnerHostInvoke.clipboardWriteImage);

    // JPEG SOF0: 10000x10000 exceeds 64 MP.
    await expect(
      Promise.resolve().then(() =>
        handler?.(IPC_EVENT, {
          type: "image/jpeg",
          bytes: jpegWithDimensions(10_000, 10_000),
        }),
      ),
    ).rejects.toThrow(/64 MP|valid PNG, JPEG, GIF, or WebP/i);
    expect(createFromBufferMock).not.toHaveBeenCalled();

    // GIF logical screen: same ceiling.
    createFromBufferMock.mockClear();
    await expect(
      Promise.resolve().then(() =>
        handler?.(IPC_EVENT, {
          type: "image/gif",
          bytes: gifWithDimensions(10_000, 10_000),
        }),
      ),
    ).rejects.toThrow(/64 MP|valid PNG, JPEG, GIF, or WebP/i);
    expect(createFromBufferMock).not.toHaveBeenCalled();
  });

  it("accepts plain VP8 and VP8L WebP, rejects VP8X before createFromBuffer", async () => {
    const handlers = installPlatformHandlers();
    const handler = handlers.get(RunnerHostInvoke.clipboardWriteImage);

    await handler?.(IPC_EVENT, {
      type: "image/webp",
      bytes: webpVp8WithDimensions(64, 48),
    });
    expect(createFromBufferMock).toHaveBeenCalledTimes(1);
    expect(writeImageMock).toHaveBeenCalledTimes(1);

    createFromBufferMock.mockClear();
    writeImageMock.mockClear();
    await handler?.(IPC_EVENT, {
      type: "image/webp",
      bytes: webpVp8lWithDimensions(64, 48),
    });
    expect(createFromBufferMock).toHaveBeenCalledTimes(1);
    expect(writeImageMock).toHaveBeenCalledTimes(1);

    // VP8X is no longer accepted at the clipboard boundary (extended WebP
    // features are out of scope for the pre-decode sniff).
    createFromBufferMock.mockClear();
    writeImageMock.mockClear();
    await expect(
      Promise.resolve().then(() =>
        handler?.(IPC_EVENT, {
          type: "image/webp",
          bytes: webpVp8xWithDimensions(64, 48),
        }),
      ),
    ).rejects.toThrow(/valid PNG, JPEG, GIF, or WebP/i);
    expect(createFromBufferMock).not.toHaveBeenCalled();
    expect(writeImageMock).not.toHaveBeenCalled();
  });

  it("rejects image bytes over 30 MB without decoding", async () => {
    const handlers = installPlatformHandlers();
    const handler = handlers.get(RunnerHostInvoke.clipboardWriteImage);
    const oversized = new ArrayBuffer(30 * 1024 * 1024 + 1);
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

  it("rejects nativeImage-empty payloads after header validation passes", async () => {
    createFromBufferMock.mockImplementationOnce(() => ({
      isEmpty: () => true,
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
});
