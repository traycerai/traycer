import { BrowserDebugSession } from "../debug/browser-debug-session";
import type { BrowserViewEntry } from "./browser-view-entry";

interface BrowserViewDebugSessionsOptions {
  /**
   * A guest's CDP debugger can detach for reasons outside our control - the
   * target being destroyed, a renderer crash, or an explicit `Debugger.detach`.
   * Reported here once, for whichever entry owned the session.
   */
  readonly onDetached: (
    entry: BrowserViewEntry,
    webContentsId: number,
    reason: string,
  ) => void;
  /** Whether a person is in front of the entry's tab right now. */
  readonly isOnScreen: (entry: BrowserViewEntry) => boolean;
}

/**
 * Lazy per-entry CDP session construction, and the one place that decides a
 * guest's session identity. The annotation host, provisioning and the manager
 * all reach a session through this collaborator, so none of them needs the
 * manager's internals injected back.
 */
export class BrowserViewDebugSessions {
  private readonly onDetached: (
    entry: BrowserViewEntry,
    webContentsId: number,
    reason: string,
  ) => void;

  private readonly isOnScreen: (entry: BrowserViewEntry) => boolean;

  constructor(options: BrowserViewDebugSessionsOptions) {
    this.onDetached = options.onDetached;
    this.isOnScreen = options.isOnScreen;
  }

  ensure(entry: BrowserViewEntry): BrowserDebugSession {
    if (entry.debugSession !== null) return entry.debugSession;
    const webContents = entry.webContents;
    const session = new BrowserDebugSession({
      webContents,
      onDetached: (reason) => {
        this.onDetached(entry, webContents.id, reason);
      },
      interceptFileChooser: () => !this.isOnScreen(entry),
    });
    entry.debugSession = session;
    return session;
  }
}
