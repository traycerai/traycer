import { BrowserDebugSession } from "../debug/browser-debug-session";
import type { BrowserViewEntry } from "./browser-view-entry";

interface BrowserViewDebugSessionsOptions {
  readonly onDetached: (
    entry: BrowserViewEntry,
    webContentsId: number,
    reason: string,
  ) => void;
}

export class BrowserViewDebugSessions {
  private readonly onDetached: (
    entry: BrowserViewEntry,
    webContentsId: number,
    reason: string,
  ) => void;

  constructor(options: BrowserViewDebugSessionsOptions) {
    this.onDetached = options.onDetached;
  }

  ensure(entry: BrowserViewEntry): BrowserDebugSession {
    if (entry.debugSession !== null) return entry.debugSession;
    const webContents = entry.webContents;
    const session = new BrowserDebugSession({
      webContents,
      onDetached: (reason) => {
        this.onDetached(entry, webContents.id, reason);
      },
    });
    entry.debugSession = session;
    return session;
  }
}
