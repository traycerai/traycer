import type { BrowserScreencastServerFrame } from "@traycer/protocol/host/browser/contracts";
import type { PipCaptureIpcPayload } from "../../../ipc-contracts/pip-capture-types";
import type { BrowserViewWebContents } from "../browser-view-port";
import { describeLogError, log } from "../../app/logger";

// ponytail: Polling at 5 fps keeps hidden-tab painting reliable without paying
// full-frame capture cost; raise this ceiling only if PiP motion needs it.
const PIP_CAPTURE_INTERVAL_MS = 200;

export interface BrowserPipCaptureStartInput {
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly quality: number;
  readonly onFrame: (payload: PipCaptureIpcPayload) => void;
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
        deviceScaleFactor: 1,
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
    capture.timer = setTimeout(() => {
      capture.timer = null;
      void this.captureFrame(capture, quality);
    }, PIP_CAPTURE_INTERVAL_MS);
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
