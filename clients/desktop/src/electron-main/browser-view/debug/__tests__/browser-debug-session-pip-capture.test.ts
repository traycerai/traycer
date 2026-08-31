import { describe, expect, it, vi } from "vitest";
import { BrowserDebugSession } from "../browser-debug-session";
import type { PipCaptureIpcPayload } from "../../../../ipc-contracts/pip-capture-types";
import { createHarness } from "./browser-debug-session-test-support";

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
