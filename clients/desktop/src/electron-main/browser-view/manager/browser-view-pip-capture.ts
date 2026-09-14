import type { PipCaptureStartInput } from "@traycer-clients/shared/platform/browser-view";
import type { PipCaptureIpcPayload } from "../../../ipc-contracts/pip-capture-types";
import { BrowserPipCapture } from "../debug/browser-pip-capture";
import type { BrowserViewEntry } from "./browser-view-entry";

/**
 * At most one tab streams PiP frames at a time; starting a second stops the
 * first. Frames come from `webContents.capturePage()`, so this owns the poller
 * itself and never reaches the tab's CDP session - PiP needs no debugger and
 * takes no lease.
 */
export class BrowserViewPipCapture {
  private capturingEntry: BrowserViewEntry | null = null;
  private capture: BrowserPipCapture | null = null;

  isCapturing(entry: BrowserViewEntry): boolean {
    return this.capturingEntry === entry;
  }

  /** The tile is gone: its owner is told the stream died mid-flight. */
  forget(entry: BrowserViewEntry): void {
    if (this.capturingEntry !== entry) return;
    this.capturingEntry = null;
    this.capture?.stall();
    this.capture = null;
  }

  start(
    entry: BrowserViewEntry,
    input: PipCaptureStartInput,
    onFrame: (payload: PipCaptureIpcPayload) => void,
  ): boolean {
    this.stop();
    entry.webContents.setBackgroundThrottling(false);
    const capture = new BrowserPipCapture(entry.webContents);
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
      this.restoreEntry(entry);
      throw err;
    }
    if (!capture.isCapturing() && this.capturingEntry === entry) {
      this.capturingEntry = null;
      this.capture = null;
      this.restoreEntry(entry);
    }
    return capture.isCapturing();
  }

  stop(): void {
    const entry = this.capturingEntry;
    this.capturingEntry = null;
    this.capture?.stop();
    this.capture = null;
    if (entry !== null) this.restoreEntry(entry);
  }

  private restoreEntry(entry: BrowserViewEntry): void {
    if (entry.webContents.isDestroyed()) return;
    entry.webContents.setBackgroundThrottling(true);
  }
}
