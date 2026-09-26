/**
 * The window registry reads a quit makes to keep the app reachable and its
 * progress visible. `WindowRegistry` satisfies it; tests pass a real one.
 */
export interface QuitWindowRegistry {
  records(): readonly {
    readonly windowId: string;
    readonly window: { isDestroyed(): boolean; isVisible(): boolean };
  }[];
  getMruRecord(): { readonly windowId: string } | null;
  /** Shows the window when hidden, then focuses it; `false` if it is gone. */
  focusById(windowId: string): boolean;
}

/**
 * A quit that stays open must leave the app reachable. On macOS the dock
 * always is (`activate` reopens a window). On Windows and Linux a process
 * with no window has no way back: without a tray there is no surface at all,
 * and the tray's "Open Traycer" only shows the MRU window - it cannot create
 * one. That state is reachable once a quit whose windows are already gone
 * (a `window-all-closed` quit, or the window closed under the quit prompt) is
 * cancelled at the native prompt, so a window is opened again: the preserved
 * one when there is one, like `activate`.
 *
 * Returns whether it opened a window.
 */
export function ensureReachableAfterStayOpen(deps: {
  readonly platform: NodeJS.Platform;
  /** Registered windows; hidden ones count (the tray shows them). */
  readonly windows: Pick<QuitWindowRegistry, "records">;
  readonly openWindow: () => void;
}): boolean {
  if (deps.platform === "darwin") {
    return false;
  }
  const live = deps.windows
    .records()
    .filter((record) => !record.window.isDestroyed()).length;
  if (live > 0) {
    return false;
  }
  deps.openWindow();
  return true;
}

/**
 * A stop still running `QUIT_STOPPING_REVEAL_DELAY_MS` after "stopping" was
 * published must not be a silent hang: when no window is visible - a
 * close-to-tray hid the last one - the MRU window is shown and focused, so
 * the stopping progress renders there. With no window at all (macOS after
 * the last close) nothing is created: a renderer is never booted mid-quit,
 * and the tray's "Stopping host…" line carries the state.
 *
 * Returns whether it showed a window.
 */
export function revealHiddenWindowForStopping(
  windows: QuitWindowRegistry,
): boolean {
  const visible = windows
    .records()
    .filter(
      (record) => !record.window.isDestroyed() && record.window.isVisible(),
    ).length;
  if (visible > 0) {
    return false;
  }
  const mru = windows.getMruRecord();
  if (mru === null) {
    return false;
  }
  return windows.focusById(mru.windowId);
}
