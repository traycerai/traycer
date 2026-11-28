import type { DidFailLoadListener } from "./voice-live-windows";

/** What the app icon shows, and the windows that have a taskbar button. */
export interface AppIconBadgeSnapshot {
  /** The count of the most recently focused visible window; `0` for none. */
  readonly count: number;
  /** Every visible window's registry id, most recently focused first. */
  readonly visibleWindowIds: readonly string[];
}

interface AppIconBadgeEntry {
  /** The renderer's latest count; `null` until its document publishes one. */
  count: number | null;
  visible: boolean;
}

/**
 * Every window's latest app icon count, by registry id, and which of them the
 * icon follows: the most recently focused window that is visible and has
 * published a count. No such window shows nothing.
 *
 * "Visible" starts at the window's first `show` or `focus` and ends only when
 * the app hides it itself ({@link hidden}: a close to the tray, or the close
 * of a window holding a live voice session). Not on Electron's `hide` event:
 * on macOS that also fires whenever the window is fully covered, minimized,
 * on another Space or the app is hidden, and the badge must stay then. A
 * window's next `show` or `focus` makes it count again.
 *
 * Every change is emitted, including a focus that changes nothing here: the
 * Windows overlay is drawn per taskbar button and a button created again by a
 * show has none until it is drawn again.
 */
export class AppIconBadgeWindows {
  private readonly entries = new Map<string, AppIconBadgeEntry>();
  /** Registry ids, most recently focused first. */
  private order: readonly string[] = [];
  private readonly listeners = new Set<
    (snapshot: AppIconBadgeSnapshot) => void
  >();

  track(windowId: string): void {
    this.entries.set(windowId, { count: null, visible: false });
    this.moveToFront(windowId);
  }

  setCount(windowId: string, count: number): void {
    const entry = this.entries.get(windowId);
    if (entry === undefined || entry.count === count) return;
    entry.count = count;
    this.emit();
  }

  focused(windowId: string): void {
    const entry = this.entries.get(windowId);
    if (entry === undefined) return;
    entry.visible = true;
    this.moveToFront(windowId);
    this.emit();
  }

  shown(windowId: string): void {
    const entry = this.entries.get(windowId);
    if (entry === undefined) return;
    entry.visible = true;
    this.emit();
  }

  /** The app hid the window: it stops counting until it is shown again. */
  hidden(windowId: string): void {
    const entry = this.entries.get(windowId);
    if (entry === undefined || !entry.visible) return;
    entry.visible = false;
    this.emit();
  }

  /** A new document replaced the renderer's: its count is unknown again. */
  rendererReplaced(windowId: string): void {
    const entry = this.entries.get(windowId);
    if (entry === undefined || entry.count === null) return;
    entry.count = null;
    this.emit();
  }

  /** The window closed: nothing of it is kept. */
  forget(windowId: string): void {
    if (!this.entries.delete(windowId)) return;
    this.order = this.order.filter((id) => id !== windowId);
    this.emit();
  }

  snapshot(): AppIconBadgeSnapshot {
    const visibleWindowIds = this.order.filter(
      (windowId) => this.entries.get(windowId)?.visible === true,
    );
    const counted = visibleWindowIds
      .map((windowId) => this.entries.get(windowId)?.count ?? null)
      .find((count) => count !== null);
    return { count: counted ?? 0, visibleWindowIds };
  }

  subscribe(listener: (snapshot: AppIconBadgeSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private moveToFront(windowId: string): void {
    this.order = [windowId, ...this.order.filter((id) => id !== windowId)];
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

export const appIconBadgeWindows = new AppIconBadgeWindows();

/** The window and renderer events the tracking reads. */
export interface AppIconBadgeTrackingTarget {
  readonly webContents: {
    on(event: "did-navigate", listener: () => void): unknown;
    on(event: "did-fail-load", listener: DidFailLoadListener): unknown;
    on(event: "render-process-gone", listener: () => void): unknown;
  };
  on(event: "focus" | "show" | "closed", listener: () => void): unknown;
}

/**
 * Tracks `window` as `windowId` in `windows` for its whole life. A document
 * replacing the renderer's (a committed navigation or reload, an error page,
 * the renderer gone) drops the count until the new document publishes, so a
 * crashed renderer's number does not stay on the icon.
 */
export function installAppIconBadgeTracking(
  window: AppIconBadgeTrackingTarget,
  windowId: string,
  windows: AppIconBadgeWindows,
): void {
  windows.track(windowId);
  const replaced = (): void => windows.rendererReplaced(windowId);
  window.webContents.on("did-navigate", replaced);
  window.webContents.on(
    "did-fail-load",
    (_event, _errorCode, _errorDescription, _validatedURL, isMainFrame) => {
      if (isMainFrame) replaced();
    },
  );
  window.webContents.on("render-process-gone", replaced);
  window.on("focus", () => windows.focused(windowId));
  window.on("show", () => windows.shown(windowId));
  window.on("closed", () => windows.forget(windowId));
}
