import type { BrowserScreencastServerFrame } from "@traycer/protocol/host/browser/contracts";
import type { PipCaptureIpcPayload } from "../../../ipc-contracts/pip-capture-types";
import type { BrowserViewWebContents } from "../browser-view-port";
import { describeLogError, log } from "../../app/logger";

/**
 * The fastest cadence a mirror is paced at, and the slowest.
 *
 * The old fixed 200ms was a 5 fps ceiling justified by capture cost - which is
 * a real cost, but a constant is the wrong instrument for it: it charges a host
 * that captures a small mirror in 8ms exactly what it charges one that takes
 * 150ms, so a machine with headroom gets a slideshow and a loaded one still
 * queues work it cannot finish.
 *
 * The pacing is measured instead. Each frame's own capture duration sets the
 * delay before the next one, so the loop settles at whatever rate the host can
 * actually sustain and never has two captures outstanding. The floor keeps a
 * fast host from spending a core on a thumbnail; the ceiling keeps a slow one
 * from looking frozen.
 */
const PIP_MIN_CAPTURE_INTERVAL_MS = 40;
const PIP_MAX_CAPTURE_INTERVAL_MS = 500;

export interface BrowserPipCaptureStartInput {
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly quality: number;
  readonly deviceScaleFactor: number;
  readonly onFrame: (payload: PipCaptureIpcPayload) => void;
}

/**
 * Pace for the next capture, given how long the last one took.
 *
 * Exported for its suite: this is the whole of the adaptive behaviour, and it
 * is a pure function of one measurement.
 */
export function pipCaptureIntervalMs(lastCaptureMs: number): number {
  const cost = Number.isFinite(lastCaptureMs)
    ? Math.max(0, lastCaptureMs)
    : PIP_MAX_CAPTURE_INTERVAL_MS;
  return Math.min(
    PIP_MAX_CAPTURE_INTERVAL_MS,
    Math.max(PIP_MIN_CAPTURE_INTERVAL_MS, Math.round(cost)),
  );
}

interface ActivePipCapture {
  readonly onFrame: (payload: PipCaptureIpcPayload) => void;
  nextSequence: number;
  timer: NodeJS.Timeout | null;
}

type PipCaptureWebContents = Pick<BrowserViewWebContents, "capturePage">;

/**
 * Polls `capturePage()` into PiP frames. Owns nothing else: no debugger, no
 * CDP, no frame routes.
 */
export class BrowserPipCapture {
  private readonly webContents: PipCaptureWebContents;
  private active: ActivePipCapture | null = null;

  constructor(webContents: PipCaptureWebContents) {
    this.webContents = webContents;
  }

  isCapturing(): boolean {
    return this.active !== null;
  }

  start(input: BrowserPipCaptureStartInput): void {
    this.stop();
    const capture: ActivePipCapture = {
      onFrame: input.onFrame,
      nextSequence: 0,
      timer: null,
    };
    this.active = capture;
    this.emit(
      {
        kind: "started",
        hasBinaryPayload: false,
        frameWidth: input.maxWidth,
        frameHeight: input.maxHeight,
        deviceScaleFactor: input.deviceScaleFactor,
      },
      null,
    );
    void this.captureFrame(capture, input.quality);
  }

  stop(): void {
    this.teardown(false);
  }

  /** Stops and tells the current owner the stream died mid-flight. */
  stall(): void {
    this.teardown(true);
  }

  private async captureFrame(
    capture: ActivePipCapture,
    quality: number,
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      const image = await this.webContents.capturePage();
      if (this.active !== capture) return;
      const size = image.getSize();
      const jpegBytes = image.toJPEG(quality);
      if (jpegBytes.byteLength > 0) {
        const sequence = capture.nextSequence;
        capture.nextSequence += 1;
        this.emit(
          {
            kind: "frame",
            hasBinaryPayload: true,
            sequence,
            metadata: {
              offsetTop: 0,
              pageScaleFactor: 1,
              deviceWidth: size.width,
              deviceHeight: size.height,
              scrollOffsetX: 0,
              scrollOffsetY: 0,
              timestamp: Date.now() / 1_000,
            },
          },
          jpegBytes,
        );
      }
    } catch (err) {
      if (this.active === capture) {
        log.warn("[browser-view] pip frame capture failed", {
          error: describeLogError(err),
        });
      }
    }
    if (this.active !== capture) return;
    capture.timer = setTimeout(
      () => {
        capture.timer = null;
        void this.captureFrame(capture, quality);
      },
      pipCaptureIntervalMs(Date.now() - startedAt),
    );
  }

  private teardown(stalled: boolean): void {
    const capture = this.active;
    if (capture === null) return;
    this.active = null;
    if (capture.timer !== null) clearTimeout(capture.timer);
    if (stalled) {
      capture.onFrame({
        frame: { kind: "stalled", hasBinaryPayload: false },
        jpegBytes: null,
      });
    }
  }

  private emit(
    frame: BrowserScreencastServerFrame,
    jpegBytes: Uint8Array | null,
  ): void {
    const capture = this.active;
    if (capture === null) return;
    capture.onFrame({ frame, jpegBytes });
  }
}
