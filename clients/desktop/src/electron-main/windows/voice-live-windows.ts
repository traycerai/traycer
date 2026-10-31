/**
 * The windows whose renderer holds a live voice session, by registry id, as
 * each renderer reports it (`IRunnerHost.setVoiceSessionLive`). The
 * microphone and the vendor session live in that renderer, so the close
 * intercept hides such a window instead of destroying it (Tanveer,
 * 2026-10-29: window close keeps the session; lock, sleep and quit end it).
 * One per process, shared by the IPC handler that writes it and the close
 * intercept that reads it; a later ticket's tray item shows the window again.
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
