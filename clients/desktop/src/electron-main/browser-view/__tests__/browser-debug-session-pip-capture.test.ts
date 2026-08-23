import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { BrowserDebugSession } from "../browser-debug-session";
import type { PipCaptureIpcPayload } from "../../../ipc-contracts/pip-capture-types";
import type {
  BrowserViewCapturedImage,
  BrowserViewDebugger,
  BrowserViewDevToolsWebContents,
  BrowserViewFindInPageOptions,
  BrowserViewOpenDevToolsOptions,
  BrowserViewWebContents,
  BrowserViewWindowOpenDetails,
  BrowserViewWindowOpenResult,
} from "../browser-view-manager";

vi.mock("../../app/logger", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
  },
  describeLogError: (err: unknown) => String(err),
}));

const CAPTURE_MAX_WIDTH = 400;
const CAPTURE_MAX_HEIGHT = 300;
const CAPTURE_QUALITY = 80;

class FakeDebugger implements BrowserViewDebugger {
  attached = false;
  private readonly events = new EventEmitter();

  isAttached(): boolean {
    return this.attached;
  }

  attach(_protocolVersion: string): void {
    this.attached = true;
  }

  detach(): void {
    this.attached = false;
  }

  sendCommand(
    _method: string,
    _commandParams: Record<string, unknown>,
    _sessionId: string | undefined,
  ): Promise<unknown> {
    return Promise.resolve(null);
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    this.events.on(event, listener);
  }

  off(event: string, listener: (...args: unknown[]) => void): void {
    this.events.off(event, listener);
  }
}

class FakeCapturedImage implements BrowserViewCapturedImage {
  constructor(
    private readonly bytes: Uint8Array,
    private readonly qualities: number[],
  ) {}

  getSize(): { readonly width: number; readonly height: number } {
    return { width: 800, height: 600 };
  }

  toJPEG(quality: number): Uint8Array {
    this.qualities.push(quality);
    return this.bytes;
  }

  toDataURL(): string {
    return "";
  }

  isEmpty(): boolean {
    return this.bytes.byteLength === 0;
  }

  crop(_rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): BrowserViewCapturedImage {
    return this;
  }

  toPNG(): Uint8Array {
    return this.bytes;
  }
}

class FakeWebContents implements BrowserViewWebContents {
  readonly id = 1;
  readonly debugger = new FakeDebugger();
  readonly navigationHistory = undefined;
  readonly qualities: number[] = [];
  captureCount = 0;
  deferCaptures = false;
  private bytes: Uint8Array = Uint8Array.from([1, 2, 3]);
  private readonly captureResolvers: Array<
    (image: BrowserViewCapturedImage) => void
  > = [];

  beginFrameSubscription(
    _callback: (image: BrowserViewCapturedImage) => void,
  ): void {}

  endFrameSubscription(): void {}

  setCaptureBytes(bytes: Uint8Array): void {
    this.bytes = bytes;
  }

  resolveNextCapture(bytes: Uint8Array): void {
    const resolve = this.captureResolvers.shift();
    if (resolve === undefined) throw new Error("No capture is pending");
    resolve(new FakeCapturedImage(bytes, this.qualities));
  }

  loadURL(_url: string): Promise<unknown> {
    return Promise.resolve();
  }

  executeJavaScript(
    _script: string,
    _userGesture: boolean,
  ): Promise<unknown> {
    return Promise.resolve();
  }

  capturePage(): Promise<BrowserViewCapturedImage> {
    this.captureCount += 1;
    if (this.deferCaptures) {
      return new Promise((resolve) => {
        this.captureResolvers.push(resolve);
      });
    }
    return Promise.resolve(new FakeCapturedImage(this.bytes, this.qualities));
  }

  getURL(): string {
    return "";
  }

  getTitle(): string {
    return "";
  }

  isDestroyed(): boolean {
    return false;
  }

  close(): void {}

  reload(): void {}

  findInPage(
    _text: string,
    _options: BrowserViewFindInPageOptions,
  ): number {
    return 0;
  }

  stopFindInPage(_action: "clearSelection"): void {}

  getZoomFactor(): number {
    return 1;
  }

  setZoomFactor(_factor: number): void {}

  setBackgroundThrottling(_allowed: boolean): void {}

  setDevToolsWebContents(
    _webContents: BrowserViewDevToolsWebContents,
  ): void {}

  openDevTools(_options: BrowserViewOpenDevToolsOptions): void {}

  setWindowOpenHandler(
    _handler: (
      details: BrowserViewWindowOpenDetails,
    ) => BrowserViewWindowOpenResult,
  ): void {}

  on(_event: string, _listener: (...args: unknown[]) => void): void {}

  off(_event: string, _listener: (...args: unknown[]) => void): void {}
}

interface CaptureHarness {
  readonly session: BrowserDebugSession;
  readonly webContents: FakeWebContents;
  readonly frames: PipCaptureIpcPayload[];
}

function createHarness(): CaptureHarness {
  const webContents = new FakeWebContents();
  const frames: PipCaptureIpcPayload[] = [];
  const session = new BrowserDebugSession({
    webContents,
    onSnapshotChange: () => undefined,
    onDetached: () => undefined,
    onTargetAttached: () => undefined,
  });
  return { session, webContents, frames };
}

function startCapture(
  session: BrowserDebugSession,
  frames: PipCaptureIpcPayload[],
): Promise<void> {
  return session.startPipCapture({
    maxWidth: CAPTURE_MAX_WIDTH,
    maxHeight: CAPTURE_MAX_HEIGHT,
    quality: CAPTURE_QUALITY,
    onFrame: (payload) => {
      frames.push(payload);
    },
  });
}

function startedPayload(): PipCaptureIpcPayload {
  return {
    frame: {
      kind: "started",
      hasBinaryPayload: false,
      frameWidth: CAPTURE_MAX_WIDTH,
      frameHeight: CAPTURE_MAX_HEIGHT,
      deviceScaleFactor: 1,
    },
    jpegBytes: null,
  };
}

describe("BrowserDebugSession PiP capture", () => {
  it("emits started then captures an immediate seq-0 JPEG", async () => {
    const harness = createHarness();

    await startCapture(harness.session, harness.frames);
    await Promise.resolve();

    expect(harness.session.isPipCapturing()).toBe(true);
    expect(harness.webContents.captureCount).toBe(1);
    expect(harness.webContents.qualities).toEqual([CAPTURE_QUALITY]);
    expect(harness.frames).toEqual([
      startedPayload(),
      {
        frame: {
          kind: "frame",
          hasBinaryPayload: true,
          sequence: 0,
          metadata: {
            offsetTop: 0,
            pageScaleFactor: 1,
            deviceWidth: 800,
            deviceHeight: 600,
            scrollOffsetX: 0,
            scrollOffsetY: 0,
            timestamp: expect.any(Number),
          },
        },
        jpegBytes: Uint8Array.from([1, 2, 3]),
      },
    ]);
    harness.session.stopPipCapture();
  });

  it("captures a fresh JPEG on the next polling interval", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    try {
      await startCapture(harness.session, harness.frames);
      await Promise.resolve();
      harness.webContents.setCaptureBytes(Uint8Array.from([4, 5, 6]));

      await vi.advanceTimersByTimeAsync(200);

      expect(harness.webContents.captureCount).toBe(2);
      expect(harness.frames[2]).toEqual({
        frame: {
          kind: "frame",
          hasBinaryPayload: true,
          sequence: 1,
          metadata: expect.objectContaining({
            deviceWidth: 800,
            deviceHeight: 600,
          }),
        },
        jpegBytes: Uint8Array.from([4, 5, 6]),
      });
    } finally {
      harness.session.stopPipCapture();
      vi.useRealTimers();
    }
  });

  it("ignores an in-flight frame after stop", async () => {
    const harness = createHarness();
    harness.webContents.deferCaptures = true;
    await startCapture(harness.session, harness.frames);

    harness.session.stopPipCapture();
    harness.webContents.resolveNextCapture(Uint8Array.from([7, 8, 9]));
    await Promise.resolve();

    expect(harness.session.isPipCapturing()).toBe(false);
    expect(harness.frames).toEqual([startedPayload()]);
  });

  it("routes a replacement capture only to its new owner", async () => {
    const harness = createHarness();
    harness.webContents.deferCaptures = true;
    await startCapture(harness.session, harness.frames);
    const owner2Frames: PipCaptureIpcPayload[] = [];

    await startCapture(harness.session, owner2Frames);
    harness.webContents.resolveNextCapture(Uint8Array.from([1, 1, 1]));
    harness.webContents.resolveNextCapture(Uint8Array.from([2, 2, 2]));
    await Promise.resolve();

    expect(harness.frames).toEqual([startedPayload()]);
    expect(owner2Frames).toEqual([
      startedPayload(),
      {
        frame: {
          kind: "frame",
          hasBinaryPayload: true,
          sequence: 0,
          metadata: expect.objectContaining({
            deviceWidth: 800,
            deviceHeight: 600,
          }),
        },
        jpegBytes: Uint8Array.from([2, 2, 2]),
      },
    ]);
    harness.session.stopPipCapture();
  });

  it("emits stalled and ignores an in-flight frame on dispose", async () => {
    const harness = createHarness();
    harness.webContents.deferCaptures = true;
    await startCapture(harness.session, harness.frames);

    harness.session.dispose();
    harness.webContents.resolveNextCapture(Uint8Array.from([7, 8, 9]));
    await Promise.resolve();

    expect(harness.session.isPipCapturing()).toBe(false);
    expect(harness.frames).toEqual([
      startedPayload(),
      {
        frame: { kind: "stalled", hasBinaryPayload: false },
        jpegBytes: null,
      },
    ]);
  });
});
