import type { PipCaptureStartInput } from "@traycer-clients/shared/platform/browser-view";
import type { PipCaptureIpcPayload } from "../../../ipc-contracts/pip-capture-types";
import { BrowserPipCapture } from "../debug/browser-pip-capture";
import type { BrowserViewEntry } from "./browser-view-entry";
import type {
  BrowserViewDrawHold,
  BrowserViewDrawHolds,
} from "./browser-view-draw-holds";

/**
 * At most one tab streams PiP frames at a time; starting a second stops the
 * first. Frames come from `webContents.capturePage()`, so this owns the poller
 * itself and never reaches the tab's CDP session - PiP needs no debugger and
 * takes no lease. It holds the guest drawn for as long as it streams: PiP is
 * how a person watches a tab no tile shows, and a parked guest draws nothing.
 */
export class BrowserViewPipCapture {
  private capturingEntry: BrowserViewEntry | null = null;
  private capture: BrowserPipCapture | null = null;
  private drawHold: BrowserViewDrawHold | null = null;

  constructor(private readonly drawHolds: BrowserViewDrawHolds) {}

  isCapturing(entry: BrowserViewEntry): boolean {
    return this.capturingEntry === entry;
  }

  /** The tile is gone: its owner is told the stream died mid-flight. */
  forget(entry: BrowserViewEntry): void {
    if (this.capturingEntry !== entry) return;
    this.capturingEntry = null;
    this.capture?.stall();
    this.capture = null;
    this.releaseDrawHold(this.drawHold);
  }

  start(
    entry: BrowserViewEntry,
    input: PipCaptureStartInput,
    onFrame: (payload: PipCaptureIpcPayload) => void,
  ): boolean {
    this.stop();
    entry.webContents.setBackgroundThrottling(false);
    const drawHold = this.drawHolds.hold(entry);
    this.drawHold = drawHold;
    const guest = entry.webContents;
    const capture = new BrowserPipCapture({
      capturePage: () => drawHold.ready.then(() => guest.capturePage()),
    });
    this.capturingEntry = entry;
    this.capture = capture;
    try {
      capture.start({
        maxWidth: input.maxWidth,
        maxHeight: input.maxHeight,
        quality: input.quality,
        onFrame,
      });
    } catch (err) {
      if (this.capturingEntry === entry) {
        this.capturingEntry = null;
        this.capture = null;
      }
      capture.stop();
      this.releaseDrawHold(drawHold);
      this.restoreEntry(entry);
      throw err;
    }
    if (!capture.isCapturing() && this.capturingEntry === entry) {
      this.capturingEntry = null;
      this.capture = null;
      this.releaseDrawHold(drawHold);
      this.restoreEntry(entry);
    }
    return capture.isCapturing();
  }

  stop(): void {
    const entry = this.capturingEntry;
    this.capturingEntry = null;
    this.capture?.stop();
    this.capture = null;
    this.releaseDrawHold(this.drawHold);
    if (entry !== null) this.restoreEntry(entry);
  }

  private restoreEntry(entry: BrowserViewEntry): void {
    if (entry.webContents.isDestroyed()) return;
    entry.webContents.setBackgroundThrottling(true);
  }

  private releaseDrawHold(drawHold: BrowserViewDrawHold | null): void {
    drawHold?.release();
    if (this.drawHold === drawHold) this.drawHold = null;
  }
}
