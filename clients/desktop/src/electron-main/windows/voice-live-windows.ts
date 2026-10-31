/**
 * The windows whose renderer holds a live voice session, by registry id, as
 * each renderer reports it (`IRunnerHost.setVoiceSessionLive`). The
 * microphone and the vendor session live in that renderer, so the close
 * intercept hides such a window instead of destroying it (Tanveer,
 * 2026-10-29: window close keeps the session; lock, sleep and quit end it).
 * One per process, shared by the IPC handler that writes it and the close
 * intercept that reads it; a later ticket's tray item shows the window again.
 *
 * The flag is the RENDERER's, not the window's: a new document (a reload, a
 * navigation), a renderer that is gone, or a destroyed window starts or ends
 * idle whatever the last document reported, through
 * {@link installVoiceLiveReset}. Without that a crashed or reloaded voice
 * window would stay "live" in main and its close would hide it.
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

/** The renderer lifecycle a window exposes, as far as the reset reads it. */
export interface VoiceLiveResetTarget {
  readonly webContents: {
    on(
      event: "did-start-navigation",
      listener: (details: { readonly isMainFrame: boolean }) => void,
    ): unknown;
    on(event: "render-process-gone", listener: () => void): unknown;
  };
  on(event: "closed", listener: () => void): unknown;
}

/**
 * Starts `windowId` idle in `windows` and returns it to idle on every edge
 * that replaces or ends its renderer: a main-frame navigation beginning (a
 * reload included; a subframe's does not touch the flag), the renderer
 * process going, and the window's destruction.
 */
export function installVoiceLiveReset(
  target: VoiceLiveResetTarget,
  windowId: string,
  windows: VoiceLiveWindows,
): void {
  const reset = (): void => windows.set(windowId, false);
  reset();
  target.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame) reset();
  });
  target.webContents.on("render-process-gone", reset);
  target.on("closed", reset);
}
