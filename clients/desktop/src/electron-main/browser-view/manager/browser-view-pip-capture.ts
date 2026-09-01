import type { PipCaptureStartInput } from "@traycer-clients/shared/platform/browser-view";
import type { PipCaptureIpcPayload } from "../../../ipc-contracts/pip-capture-types";
import { log } from "../../app/logger";
import type { BrowserViewEntry } from "./browser-view-entry";
import { browserViewSurfaceKey as entryKeyId } from "./browser-view-entry-registry";
import type { BrowserViewGeometry } from "./browser-view-geometry";
import type { BrowserViewWindowAttachment } from "./browser-view-window-attachment";
import type { BrowserViewDebugSessions } from "./debug-session-for";
import type { BrowserViewWindow } from "../browser-view-port";

interface BrowserViewPipCaptureOptions {
  readonly getWindow: (windowId: string) => BrowserViewWindow | null;
  readonly geometry: BrowserViewGeometry;
  readonly windows: BrowserViewWindowAttachment;
  readonly debugSessions: BrowserViewDebugSessions;
}

/** At most one tab streams PiP frames at a time; starting a second stops the first. */
export class BrowserViewPipCapture {
  private readonly getWindow: (windowId: string) => BrowserViewWindow | null;
  private readonly geometry: BrowserViewGeometry;
  private readonly windows: BrowserViewWindowAttachment;
  private readonly debugSessions: BrowserViewDebugSessions;
  private capturingEntry: BrowserViewEntry | null = null;

  constructor(options: BrowserViewPipCaptureOptions) {
    this.getWindow = options.getWindow;
    this.geometry = options.geometry;
    this.windows = options.windows;
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
    windowId: string,
    input: PipCaptureStartInput,
    onFrame: (payload: PipCaptureIpcPayload) => void,
  ): Promise<boolean> {
    this.stop();
    if (
      !this.prepareEntry(entry, windowId, {
        width: input.maxWidth,
        height: input.maxHeight,
      })
    ) {
      return false;
    }
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

  /**
   * A capturing tab with no surface holds a compositor lease on whatever
   * window it was parked into. While that window lives the caller must leave
   * the entry alone; once it dies the caller drops the lease
   * (`dropDeadLease`) and the entry falls back to normal reconciliation.
   * Kept a pure query so a reconcile pass does not mutate mid-iteration.
   */
  hasUnboundLease(entry: BrowserViewEntry): boolean {
    if (this.capturingEntry !== entry) return false;
    const captureWindow =
      entry.parentWindowId === null
        ? null
        : this.getWindow(entry.parentWindowId);
    return captureWindow !== null && !captureWindow.isDestroyed();
  }

  /** Tears down a lease whose window is gone. Call when the query says false. */
  dropDeadLease(entry: BrowserViewEntry): void {
    if (this.capturingEntry === entry) this.stop();
  }

  private restoreEntry(entry: BrowserViewEntry): void {
    if (entry.surface !== null) {
      this.geometry.applyBounds(entry);
      this.geometry.applyVisibility(entry);
      return;
    }
    this.windows.detachFromParentWindow(entry);
    entry.bounds = null;
    entry.lastAppliedBounds = null;
    this.geometry.hide(entry);
  }

  /**
   * Hidden agent-driven tabs are created unbound and without bounds.
   * Native page capture needs the view in a window with a compositor size.
   * Electron returns an empty NativeImage for a setVisible(false) view, so
   * present hidden views fully offscreen for the duration of PiP capture.
   */
  private prepareEntry(
    entry: BrowserViewEntry,
    windowId: string,
    size: { readonly width: number; readonly height: number },
  ): boolean {
    if (entry.surface === null) {
      if (!this.windows.attachUnbound(entry, windowId)) return false;
    } else {
      this.windows.attachToCurrentWindow(entry);
    }
    if (entry.parentWindowId === null) return false;
    const hasUsableBounds =
      entry.bounds !== null &&
      entry.bounds.width > 0 &&
      entry.bounds.height > 0;
    if (!hasUsableBounds) {
      entry.bounds = {
        x: 0,
        y: 0,
        width: size.width,
        height: size.height,
      };
      this.geometry.applyBounds(entry);
    }
    entry.view.webContents.setBackgroundThrottling(false);
    this.geometry.applyVisibility(entry);
    const captureOffscreen = entry.visible !== true;
    if (captureOffscreen) this.geometry.parkOffscreen(entry);
    log.info("[browser-view] pip capture prepared", {
      keyId: entry.surface === null ? null : entryKeyId(entry.surface),
      attached: entry.parentWindowId !== null,
      bounds: entry.bounds,
      captureOffscreen,
    });
    return true;
  }
}
