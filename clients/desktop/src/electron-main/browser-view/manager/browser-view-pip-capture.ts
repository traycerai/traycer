import type { PipCaptureStartInput } from "@traycer-clients/shared/platform/browser-view";
import type { PipCaptureIpcPayload } from "../../../ipc-contracts/pip-capture-types";
import type { BrowserViewEntry } from "./browser-view-entry";
import type { BrowserViewDebugSessions } from "./debug-session-for";

interface BrowserViewPipCaptureOptions {
  readonly debugSessions: BrowserViewDebugSessions;
}

/** At most one tab streams PiP frames at a time; starting a second stops the first. */
export class BrowserViewPipCapture {
  private readonly debugSessions: BrowserViewDebugSessions;
  private capturingEntry: BrowserViewEntry | null = null;

  constructor(options: BrowserViewPipCaptureOptions) {
    this.debugSessions = options.debugSessions;
  }

  isCapturing(entry: BrowserViewEntry): boolean {
    return this.capturingEntry === entry;
  }

  forget(entry: BrowserViewEntry): void {
    if (this.capturingEntry === entry) this.capturingEntry = null;
  }

  async start(
    entry: BrowserViewEntry,
    input: PipCaptureStartInput,
    onFrame: (payload: PipCaptureIpcPayload) => void,
  ): Promise<boolean> {
    this.stop();
    entry.webContents.setBackgroundThrottling(false);
    const session = this.debugSessions.ensure(entry);
    this.capturingEntry = entry;
    try {
      await session.startPipCapture({
        maxWidth: input.maxWidth,
        maxHeight: input.maxHeight,
        quality: input.quality,
        onFrame,
      });
    } catch (err) {
      if (this.capturingEntry === entry) this.capturingEntry = null;
      session.stopPipCapture();
      this.restoreEntry(entry);
      throw err;
    }
    if (!session.isPipCapturing() && this.capturingEntry === entry) {
      this.capturingEntry = null;
      this.restoreEntry(entry);
    }
    return session.isPipCapturing();
  }

  stop(): void {
    const entry = this.capturingEntry;
    this.capturingEntry = null;
    entry?.debugSession?.stopPipCapture();
    if (entry !== null) this.restoreEntry(entry);
  }

  private restoreEntry(entry: BrowserViewEntry): void {
    if (entry.webContents.isDestroyed()) return;
    entry.webContents.setBackgroundThrottling(true);
  }
}
