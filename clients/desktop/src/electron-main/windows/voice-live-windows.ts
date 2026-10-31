import type { VoiceSessionIndicator } from "../../ipc-contracts/host-types";

/**
 * The windows whose renderer holds a live voice session, by registry id, as
 * each renderer reports it (`IRunnerHost.setVoiceSessionLive`). The
 * microphone and the vendor session live in that renderer, so the close
 * intercept hides such a window instead of destroying it (Tanveer,
 * 2026-10-29: window close keeps the session; lock, sleep and quit end it).
 * One per process, shared by the IPC handlers that write it, the close
 * intercept that reads it, and the voice item that shows a live window's
 * session while it is away.
 *
 * The flag is the DOCUMENT's, not the window's: a new document committing (a
 * reload, a navigation, an error page), a renderer that is gone, or a
 * destroyed window starts or ends idle whatever the last document reported,
 * through {@link installVoiceLiveReset}. Without that a crashed or reloaded
 * voice window would stay "live" in main and its close would hide it.
 */
export class VoiceLiveWindows {
  private readonly live = new Map<string, VoiceLiveWindowState>();
  /** Windows known to have lost focus and not regained it, live or not. */
  private readonly unfocused = new Set<string>();
  private readonly listeners = new Set<() => void>();

  set(windowId: string, live: boolean): void {
    if (live === this.live.has(windowId)) return;
    if (live) {
      // A session that goes live in a window already in the background is
      // away from the start.
      this.live.set(windowId, {
        indicator: { muted: false, pausedForDictation: false },
        away: this.unfocused.has(windowId),
      });
    } else {
      this.live.delete(windowId);
    }
    this.emit();
  }

  isLive(windowId: string): boolean {
    return this.live.has(windowId);
  }

  /** What the live session in `windowId` reports; ignored while it is not live. */
  setIndicator(windowId: string, indicator: VoiceSessionIndicator): void {
    const state = this.live.get(windowId);
    if (
      state === undefined ||
      (state.indicator.muted === indicator.muted &&
        state.indicator.pausedForDictation === indicator.pausedForDictation)
    ) {
      return;
    }
    this.live.set(windowId, { ...state, indicator });
    this.emit();
  }

  /**
   * The window lost focus (blurred, or hidden by a close) or gained it. A
   * live window that loses focus is away until its session ends, whatever
   * focus does after: the item that shows it does not come and go with
   * every switch between windows.
   */
  setFocused(windowId: string, focused: boolean): void {
    if (focused) {
      this.unfocused.delete(windowId);
      return;
    }
    this.unfocused.add(windowId);
    const state = this.live.get(windowId);
    if (state === undefined || state.away) return;
    this.live.set(windowId, { ...state, away: true });
    this.emit();
  }

  /** The window is gone: nothing of it is kept. */
  forget(windowId: string): void {
    this.unfocused.delete(windowId);
    this.set(windowId, false);
  }

  /** Every live window that has been away since its session went live. */
  away(): ReadonlyArray<VoiceAwayWindow> {
    const windows: VoiceAwayWindow[] = [];
    for (const [windowId, state] of this.live) {
      if (state.away) windows.push({ windowId, indicator: state.indicator });
    }
    return windows;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

interface VoiceLiveWindowState {
  readonly indicator: VoiceSessionIndicator;
  /** The window has lost focus since its session went live. */
  readonly away: boolean;
}

/** A live window that is away, and what its session reports. */
export interface VoiceAwayWindow {
  readonly windowId: string;
  readonly indicator: VoiceSessionIndicator;
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
  target.on("closed", () => windows.forget(windowId));
}

/** The focus events a window raises, as far as the away tracking reads them. */
export interface VoiceAwayTarget {
  on(event: "focus" | "blur" | "hide", listener: () => void): unknown;
}

/**
 * Feeds `windowId`'s focus into `windows`: a blur, or the hide a close of a
 * live window turns into, is the window going away.
 */
export function installVoiceAwayTracking(
  target: VoiceAwayTarget,
  windowId: string,
  windows: VoiceLiveWindows,
): void {
  target.on("focus", () => windows.setFocused(windowId, true));
  target.on("blur", () => windows.setFocused(windowId, false));
  target.on("hide", () => windows.setFocused(windowId, false));
}
