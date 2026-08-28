import type { Event, RenderProcessGoneDetails } from "electron";
import { log } from "../../app/logger";
import type {
  BrowserViewHostWebContents,
  BrowserViewWindow,
} from "../browser-view-port";
import type { BrowserViewAnnotationHost } from "./browser-view-annotation-host";
import type { BrowserViewEntry } from "./browser-view-entry";
import {
  browserViewSurfaceKey as entryKeyId,
  type BrowserViewEntryRegistry,
} from "./browser-view-entry-registry";
import type { BrowserViewGeometry } from "./browser-view-geometry";
import type { BrowserViewPipCapture } from "./browser-view-pip-capture";

interface HostWindowResetListeners {
  readonly webContents: BrowserViewHostWebContents;
  readonly onNavigate: (
    event: Event,
    url: string,
    isInPlace: boolean,
    isMainFrame: boolean,
  ) => void;
  readonly onGone: (event: Event, details: RenderProcessGoneDetails) => void;
}

interface BrowserViewWindowAttachmentOptions {
  readonly entries: BrowserViewEntryRegistry<BrowserViewEntry>;
  readonly getWindow: (windowId: string) => BrowserViewWindow | null;
  readonly geometry: BrowserViewGeometry;
  readonly annotations: BrowserViewAnnotationHost;
  readonly notifyHostWindowRendererReset: (windowId: string) => void;
  /** A guest whose owning renderer vanished before accepting it is orphaned. */
  readonly closeEntry: (entry: BrowserViewEntry) => void;
}

/**
 * Owns which host window a guest view is parented to, and the per-window
 * listeners that notice that window's own renderer reloading or crashing.
 * The reset-listener map is this module's state - nothing else may add or
 * remove a child view.
 */
export class BrowserViewWindowAttachment {
  private readonly entries: BrowserViewEntryRegistry<BrowserViewEntry>;
  private readonly getWindow: (windowId: string) => BrowserViewWindow | null;
  private readonly geometry: BrowserViewGeometry;
  private readonly annotations: BrowserViewAnnotationHost;
  private readonly notifyHostWindowRendererReset: (windowId: string) => void;
  private readonly closeEntry: (entry: BrowserViewEntry) => void;
  private readonly hostWindowResetListenersByWindowId = new Map<
    string,
    HostWindowResetListeners
  >();

  constructor(options: BrowserViewWindowAttachmentOptions) {
    this.entries = options.entries;
    this.getWindow = options.getWindow;
    this.geometry = options.geometry;
    this.annotations = options.annotations;
    this.notifyHostWindowRendererReset = options.notifyHostWindowRendererReset;
    this.closeEntry = options.closeEntry;
  }

  /** Re-parents a bound entry into the window its surface names. */
  attachToCurrentWindow(entry: BrowserViewEntry): void {
    const surface = entry.surface;
    if (surface === null) return;
    const targetWindow = this.getWindow(surface.windowId);
    if (targetWindow !== null) this.ensureResetListener(surface.windowId);
    const currentWindow =
      entry.parentWindowId === null
        ? null
        : this.getWindow(entry.parentWindowId);
    if (entry.parentWindowId === surface.windowId && targetWindow !== null) {
      return;
    }
    if (currentWindow !== null) {
      currentWindow.contentView.removeChildView(entry.view);
    }
    entry.parentWindowId = null;
    if (targetWindow === null || targetWindow.isDestroyed()) return;
    targetWindow.contentView.addChildView(entry.view);
    entry.parentWindowId = surface.windowId;
  }

  /**
   * Parents a surface-less guest (an agent-driven hidden tab) into a window so
   * it has a compositor. Reports whether that window was still alive.
   */
  attachUnbound(entry: BrowserViewEntry, windowId: string): boolean {
    const window = this.getWindow(windowId);
    if (window === null || window.isDestroyed()) return false;
    window.contentView.addChildView(entry.view);
    entry.parentWindowId = windowId;
    return true;
  }

  detachFromParentWindow(entry: BrowserViewEntry): void {
    const window =
      entry.parentWindowId === null
        ? null
        : this.getWindow(entry.parentWindowId);
    if (window !== null && !window.isDestroyed()) {
      window.contentView.removeChildView(entry.view);
    }
    entry.parentWindowId = null;
  }

  /**
   * The host window itself (not any browser tile's own `webContents`) can
   * reload or crash - a vite HMR full reload in dev, a renderer crash in
   * production. When that happens every tile attached to this window keeps
   * `desiredVisible: true` in this (main-process, reload-surviving) manager
   * and would otherwise keep compositing over the blank window until the
   * new renderer re-registers it. One listener per window, attached lazily
   * the first time an entry attaches to it.
   */
  ensureResetListener(windowId: string): void {
    if (this.hostWindowResetListenersByWindowId.has(windowId)) return;
    const window = this.getWindow(windowId);
    if (window === null) return;
    const webContents = window.webContents;
    if (webContents === null) return;
    const onNavigate = (
      _event: Event,
      _url: string,
      isInPlace: boolean,
      isMainFrame: boolean,
    ): void => {
      if (!isMainFrame || isInPlace) return;
      this.handleHostWindowRendererReset(windowId, "navigation", null);
    };
    const onGone = (_event: Event, details: RenderProcessGoneDetails): void => {
      this.handleHostWindowRendererReset(windowId, "crash", details.reason);
    };
    webContents.on("did-start-navigation", onNavigate);
    webContents.on("render-process-gone", onGone);
    this.hostWindowResetListenersByWindowId.set(windowId, {
      webContents,
      onNavigate,
      onGone,
    });
  }

  detachResetListenerIfUnused(windowId: string): void {
    const stillUsed = Array.from(this.entries.guestValues()).some(
      (entry) =>
        entry.surface?.windowId === windowId ||
        entry.identity.lifecycleWindowId === windowId,
    );
    if (stillUsed) return;
    const listeners = this.hostWindowResetListenersByWindowId.get(windowId);
    if (listeners === undefined) return;
    listeners.webContents.off("did-start-navigation", listeners.onNavigate);
    listeners.webContents.off("render-process-gone", listeners.onGone);
    this.hostWindowResetListenersByWindowId.delete(windowId);
  }

  /**
   * Re-runs parenting and visibility for every guest after the set of host
   * windows changed. Takes PiP as an argument rather than a field: a capturing
   * unbound tab holds a compositor lease this pass must not disturb, and the
   * two modules would otherwise reference each other.
   */
  reconcileVisibility(pip: BrowserViewPipCapture): void {
    for (const entry of Array.from(this.entries.guestValues())) {
      const surface = entry.surface;
      if (surface === null) {
        if (pip.hasUnboundLease(entry)) continue;
        pip.dropDeadLease(entry);
      }
      if (
        surface === null ||
        this.entries.getSurfaceByKey(entryKeyId(surface)) !== entry
      ) {
        this.hideDetached(entry);
        continue;
      }
      const window = this.getWindow(surface.windowId);
      if (window === null || window.isDestroyed()) {
        this.hideDetached(entry);
        continue;
      }
      this.attachToCurrentWindow(entry);
      this.geometry.applyVisibility(entry);
    }
  }

  private hideDetached(entry: BrowserViewEntry): void {
    entry.desiredVisible = false;
    entry.parentWindowId = null;
    this.geometry.hide(entry);
  }

  private handleHostWindowRendererReset(
    windowId: string,
    reason: "navigation" | "crash",
    detail: string | null,
  ): void {
    this.notifyHostWindowRendererReset(windowId);
    let affectedCount = 0;
    for (const entry of this.entries.guestValues()) {
      if (
        entry.identity.lifecycleWindowId !== windowId ||
        entry.identity.lifecycle.accepted
      ) {
        continue;
      }
      affectedCount += 1;
      this.closeEntry(entry);
    }
    for (const entry of this.entries.surfaceValues()) {
      if (entry.surface?.windowId !== windowId) continue;
      if (entry.rendererResetPending) continue;
      this.annotations.end(entry, reason === "crash" ? "crash" : "reload");
      entry.rendererResetPending = true;
      affectedCount += 1;
      this.geometry.applyVisibility(entry);
    }
    if (affectedCount === 0) return;
    log.info("[browser-view] host window renderer reset: hiding entries", {
      windowId,
      reason,
      detail,
      affectedCount,
    });
  }
}
