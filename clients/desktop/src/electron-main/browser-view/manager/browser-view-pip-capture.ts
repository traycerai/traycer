import type { PipCaptureStartInput } from "../../../ipc-contracts/browser-view-types";
import type { PipCaptureIpcPayload } from "../../../ipc-contracts/pip-capture-types";
import { log } from "../../app/logger";
import type { BrowserDebugSession } from "../debug/browser-debug-session";
import type { BrowserViewEntry } from "./browser-view-entry";
import { browserViewSurfaceKey as entryKeyId } from "./browser-view-entry-registry";
import {
  effectiveViewportBounds,
  type BrowserViewGeometry,
} from "./browser-view-geometry";
import type { BrowserViewWindow } from "../browser-view-port";

interface BrowserViewPipCaptureOptions {
  readonly getWindow: (windowId: string) => BrowserViewWindow | null;
  readonly geometry: BrowserViewGeometry;
  readonly ensureDebugSession: (entry: BrowserViewEntry) => BrowserDebugSession;
  readonly attachToCurrentWindow: (entry: BrowserViewEntry) => void;
}

/** At most one tab streams PiP frames at a time; starting a second stops the first. */
export class BrowserViewPipCapture {
  private readonly getWindow: (windowId: string) => BrowserViewWindow | null;
  private readonly geometry: BrowserViewGeometry;
  private readonly ensureDebugSession: (
    entry: BrowserViewEntry,
  ) => BrowserDebugSession;
  private readonly attachToCurrentWindow: (entry: BrowserViewEntry) => void;
  private capturingEntry: BrowserViewEntry | null = null;

  constructor(options: BrowserViewPipCaptureOptions) {
    this.getWindow = options.getWindow;
    this.geometry = options.geometry;
    this.ensureDebugSession = options.ensureDebugSession;
    this.attachToCurrentWindow = options.attachToCurrentWindow;
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
    const session = this.ensureDebugSession(entry);
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
   * window it was parked into. While that window lives the lease is kept and
   * the caller must leave the entry alone; once it dies the lease is dropped
   * and the entry falls back to normal reconciliation.
   */
  retainsUnboundLease(entry: BrowserViewEntry): boolean {
    if (this.capturingEntry !== entry) return false;
    const captureWindow =
      entry.parentWindowId === null
        ? null
        : this.getWindow(entry.parentWindowId);
    if (captureWindow !== null && !captureWindow.isDestroyed()) return true;
    this.stop();
    return false;
  }

  private restoreEntry(entry: BrowserViewEntry): void {
    if (entry.surface !== null) {
      this.geometry.applyBounds(entry);
      this.geometry.applyVisibility(entry);
      return;
    }
    const window =
      entry.parentWindowId === null
        ? null
        : this.getWindow(entry.parentWindowId);
    if (window !== null && !window.isDestroyed()) {
      window.contentView.removeChildView(entry.view);
    }
    entry.parentWindowId = null;
    entry.bounds = null;
    entry.lastAppliedBounds = null;
    entry.view.setVisible(false);
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
      const window = this.getWindow(windowId);
      if (window === null || window.isDestroyed()) return false;
      window.contentView.addChildView(entry.view);
      entry.parentWindowId = windowId;
    } else {
      this.attachToCurrentWindow(entry);
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
    if (captureOffscreen) {
      const bounds = effectiveViewportBounds(
        entry.bounds ?? { x: 0, y: 0, width: size.width, height: size.height },
        entry.viewportPreset,
      );
      entry.view.setBounds({
        x: -bounds.width,
        y: -bounds.height,
        width: bounds.width,
        height: bounds.height,
      });
      // The view now sits offscreen; forget the last onscreen rect so the
      // next `applyBounds` re-applies real geometry instead of coalescing
      // against a rect that no longer describes the view.
      entry.lastAppliedBounds = null;
      entry.view.setVisible(true);
    }
    log.info("[browser-view] pip capture prepared", {
      keyId: entry.surface === null ? null : entryKeyId(entry.surface),
      attached: entry.parentWindowId !== null,
      bounds: entry.bounds,
      captureOffscreen,
    });
    return true;
  }
}
