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
  readonly annotations: BrowserViewAnnotationHost;
  readonly notifyHostWindowRendererReset: (windowId: string) => void;
  readonly emitStatus: (entry: BrowserViewEntry) => void;
  /** A guest whose owning renderer vanished before accepting it is orphaned. */
  readonly closeEntry: (entry: BrowserViewEntry) => void;
}

/**
 * Owns which host window a guest is bound to, and the per-window listeners
 * that notice that window's own renderer reloading or crashing.
 */
export class BrowserViewWindowAttachment {
  private readonly entries: BrowserViewEntryRegistry<BrowserViewEntry>;
  private readonly getWindow: (windowId: string) => BrowserViewWindow | null;
  private readonly annotations: BrowserViewAnnotationHost;
  private readonly notifyHostWindowRendererReset: (windowId: string) => void;
  private readonly emitStatus: (entry: BrowserViewEntry) => void;
  private readonly closeEntry: (entry: BrowserViewEntry) => void;
  private readonly hostWindowResetListenersByWindowId = new Map<
    string,
    HostWindowResetListeners
  >();

  constructor(options: BrowserViewWindowAttachmentOptions) {
    this.entries = options.entries;
    this.getWindow = options.getWindow;
    this.annotations = options.annotations;
    this.notifyHostWindowRendererReset = options.notifyHostWindowRendererReset;
    this.emitStatus = options.emitStatus;
    this.closeEntry = options.closeEntry;
  }

  /**
   * The host window itself (not any browser tile's own `webContents`) can
   * reload or crash - a vite HMR full reload in dev, a renderer crash in
   * production. When that happens every tile attached to this window keeps
   * `desiredVisible: true` in this (main-process, reload-surviving) manager
   * until the new renderer re-registers it. One listener per window, attached
   * lazily the first time an entry attaches to it.
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
   * Re-runs window binding for every guest after the set of host windows
   * changed. A capturing unbound tab does not need a compositor lease: the
   * renderer guest stays in the persistent DOM host.
   */
  reconcileBoundWindows(): void {
    for (const entry of Array.from(this.entries.guestValues())) {
      const surface = entry.surface;
      if (
        surface === null ||
        this.entries.getSurfaceByKey(entryKeyId(surface)) !== entry
      ) {
        this.markDetached(entry);
        continue;
      }
      const window = this.getWindow(surface.windowId);
      if (window === null || window.isDestroyed()) {
        this.markDetached(entry);
        continue;
      }
      this.ensureResetListener(surface.windowId);
    }
  }

  /**
   * A guest whose tile or window is gone stops being viewed - and SAYS so.
   *
   * `viewed` on `electronTabState` is read straight off `desiredVisible`, and a
   * silent hide left the host believing a tab was still on the user's screen
   * for the rest of the session. Emitted only on the edge, because this runs
   * over every entry on every visibility reconcile.
   */
  private markDetached(entry: BrowserViewEntry): void {
    const wasVisible = entry.desiredVisible;
    entry.desiredVisible = false;
    if (wasVisible) this.emitStatus(entry);
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
