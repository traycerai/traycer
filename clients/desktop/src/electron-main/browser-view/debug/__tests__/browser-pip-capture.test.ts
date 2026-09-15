import { describe, expect, it, vi } from "vitest";
import { BrowserPipCapture } from "../browser-pip-capture";
import type { PipCaptureIpcPayload } from "../../../../ipc-contracts/pip-capture-types";
import { FakeWebContents } from "./browser-debug-session-test-support";

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

interface PipHarness {
  readonly capture: BrowserPipCapture;
  readonly webContents: FakeWebContents;
  readonly frames: PipCaptureIpcPayload[];
}

function createHarness(): PipHarness {
  const webContents = new FakeWebContents();
  return {
    capture: new BrowserPipCapture(webContents),
    webContents,
    frames: [],
  };
}

function startCapture(
  capture: BrowserPipCapture,
  frames: PipCaptureIpcPayload[],
): void {
  capture.start({
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

describe("BrowserPipCapture", () => {
  it("emits started then captures an immediate seq-0 JPEG", async () => {
    const harness = createHarness();

    startCapture(harness.capture, harness.frames);
    await Promise.resolve();

    expect(harness.capture.isCapturing()).toBe(true);
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
    harness.capture.stop();
  });

  it("captures a fresh JPEG on the next polling interval", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    try {
      startCapture(harness.capture, harness.frames);
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
      harness.capture.stop();
      vi.useRealTimers();
    }
  });

  it("ignores an in-flight frame after stop", async () => {
    const harness = createHarness();
    harness.webContents.deferCaptures = true;
    startCapture(harness.capture, harness.frames);

    harness.capture.stop();
    harness.webContents.resolveNextCapture(Uint8Array.from([7, 8, 9]));
    await Promise.resolve();

    expect(harness.capture.isCapturing()).toBe(false);
    expect(harness.frames).toEqual([startedPayload()]);
  });

  it("routes a replacement capture only to its new owner", async () => {
    const harness = createHarness();
    harness.webContents.deferCaptures = true;
    startCapture(harness.capture, harness.frames);
    const owner2Frames: PipCaptureIpcPayload[] = [];

    startCapture(harness.capture, owner2Frames);
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
    harness.capture.stop();
  });

  it("emits stalled and ignores an in-flight frame when the tile goes", async () => {
    const harness = createHarness();
    harness.webContents.deferCaptures = true;
    startCapture(harness.capture, harness.frames);

    harness.capture.stall();
    harness.webContents.resolveNextCapture(Uint8Array.from([7, 8, 9]));
    await Promise.resolve();

    expect(harness.capture.isCapturing()).toBe(false);
    expect(harness.frames).toEqual([
      startedPayload(),
      {
        frame: { kind: "stalled", hasBinaryPayload: false },
        jpegBytes: null,
      },
    ]);
  });
});
