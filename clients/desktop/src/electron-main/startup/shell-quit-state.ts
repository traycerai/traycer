/**
 * Tracks whether the desktop shell has begun quitting.
 *
 * Set once `before-quit` fires - on ANY quit path: Cmd+Q / "Quit Traycer",
 * the auto-update install re-quit, and the Win/Linux `window-all-closed` ->
 * `app.quit()` cascade. Read by the windows IPC registry-change listener so a
 * window `closed` event that is part of a quit never destroys the per-window
 * restore snapshot.
 *
 * This is deliberately a tiny, explicitly-injected service (not a module-global
 * singleton) so it composes through the same dependency wiring as the rest of
 * the shell services and stays trivially testable.
 */
export interface ShellQuitStateReader {
  isQuitting(): boolean;
}

export class ShellQuitState implements ShellQuitStateReader {
  private quitting = false;

  isQuitting(): boolean {
    return this.quitting;
  }

  markQuitting(): void {
    this.quitting = true;
  }

  /**
   * Reverts to not-quitting. Called from every `before-quit` stay-alive
   * branch (host-update-install failure, dirty-edit decision rejected/failed,
   * the user declining the quit outright via `userCancelled`, fresh-snapshot
   * query failed) so a later mid-session window close is not mistaken for part
   * of that aborted quit attempt. Idempotent - safe to call even when a quit
   * was never in progress.
   *
   * The `userCancelled` arm is the one that makes quitting a state the shell
   * enters and leaves DELIBERATELY, rather than only on failure, so
   * cancel-then-quit-again is a first-class sequence rather than an edge.
   */
  resetQuitting(): void {
    this.quitting = false;
  }
}
