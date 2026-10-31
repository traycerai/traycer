/**
 * The windows whose renderer holds a live voice session, by registry id, as
 * each renderer reports it (`IRunnerHost.setVoiceSessionLive`). The
 * microphone and the vendor session live in that renderer, so the close
 * intercept hides such a window instead of destroying it (Tanveer,
 * 2026-10-29: window close keeps the session; lock, sleep and quit end it).
 * One per process, shared by the IPC handler that writes it and the close
 * intercept that reads it; a later ticket's tray item shows the window again.
 *
 * The flag is the DOCUMENT's, not the window's: a new document committing (a
 * reload, a navigation, an error page), a renderer that is gone, or a
 * destroyed window starts or ends idle whatever the last document reported,
 * through {@link installVoiceLiveReset}. Without that a crashed or reloaded
 * voice window would stay "live" in main and its close would hide it.
 */
export class VoiceLiveWindows {
  private readonly ids = new Set<string>();

  set(windowId: string, live: boolean): void {
    if (live) this.ids.add(windowId);
    else this.ids.delete(windowId);
  }

  isLive(windowId: string): boolean {
    return this.ids.has(windowId);
  }
}

export const voiceLiveWindows = new VoiceLiveWindows();

/** Electron's `did-fail-load` arguments, as far as the reset reads them. */
export type DidFailLoadListener = (
  event: unknown,
  errorCode: number,
  errorDescription: string,
  validatedURL: string,
  isMainFrame: boolean,
) => void;

/** The renderer lifecycle a window exposes, as far as the reset reads it. */
export interface VoiceLiveResetTarget {
  readonly webContents: {
    on(event: "did-navigate", listener: () => void): unknown;
    on(event: "did-fail-load", listener: DidFailLoadListener): unknown;
    on(event: "render-process-gone", listener: () => void): unknown;
  };
  on(event: "closed", listener: () => void): unknown;
}

/**
 * Starts `windowId` idle in `windows` and returns it to idle on every edge
 * that replaces or ends its document: a main-frame navigation that COMMITS
 * (`did-navigate`; a reload included), an error page committing for the
 * main frame (`did-fail-load`), the renderer process going, and the window's
 * destruction. Not on a navigation merely starting: that also fires for a
 * same-document (fragment, history) navigation and for one the navigation
 * guard then cancels, and in both the live document, its controller and its
 * microphone are still there; Electron emits no `did-fail-load` for such a
 * cancel. The same distinction `installBackgroundRenderingReset` draws.
 */
export function installVoiceLiveReset(
  target: VoiceLiveResetTarget,
  windowId: string,
  windows: VoiceLiveWindows,
): void {
  const reset = (): void => windows.set(windowId, false);
  reset();
  target.webContents.on("did-navigate", reset);
  target.webContents.on(
    "did-fail-load",
    (_event, _errorCode, _errorDescription, _validatedURL, isMainFrame) => {
      if (isMainFrame) reset();
    },
  );
  target.webContents.on("render-process-gone", reset);
  target.on("closed", reset);
}
