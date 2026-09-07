/** Read by the windows IPC registry-change listener so a window `closed` event that is part of a quit never destroys the per-window restore snapshot. */
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

  /** Idempotent - safe to call even when a quit was never in progress. */
  resetQuitting(): void {
    this.quitting = false;
  }
}
