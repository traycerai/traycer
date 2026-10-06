import { RunnerHostInvoke } from "../../ipc-contracts/ipc-channels";
import type { RunnerIpcBridge } from "../ipc/runner-ipc-bridge";

/**
 * Background throttling for GUI windows, and the one demand that turns it off.
 *
 * GUI windows keep Electron's default `backgroundThrottling: true`, so Chromium
 * treats a covered (macOS, Windows), minimised or hidden window the way a
 * browser treats a background tab: `document.visibilityState` reports
 * `"hidden"`, rAF and CSS animations stop, timers are throttled, and the
 * window's compositor stops drawing.
 *
 * The exception is the browser tile's WebRTC video plane (#1613). Throttled,
 * an occluded window's timers drop to about one wake-up a minute, which
 * collapses the receiver's own reporting and stops `requestVideoFrameCallback`
 * entirely; the tile's sender reads that silence as a path that cannot carry
 * frames and ratchets its capture rate down for the rest of the session. So a
 * renderer asks for throttling off while it holds a video-plane media entry
 * (`gui-app/src/lib/browser-view/tiles/desktop-background-rendering.ts`) and
 * hands it back when the last one is disposed.
 *
 * Why not leave throttling off for the whole window, as it was: Electron
 * implements `backgroundThrottling: false` by making
 * `RenderWidgetHostImpl::WasHidden()` return early
 * (`patches/chromium/disable_hidden.patch`) and by keeping the window's
 * compositor drawing (`NativeWindow::UpdateBackgroundThrottlingState`). A
 * window that had been shown once therefore stayed `"visible"` through
 * occlusion, minimise and hide for the rest of its life, kept every animation
 * and timer running, and kept swapping frames to the WindowServer while nobody
 * could see it (traycer#2355).
 *
 * Two Electron facts shape the code below.
 *
 * - `setBackgroundThrottling()` re-shows a hidden widget on EVERY call,
 *   whatever the value. So a call that changes nothing is never made: a
 *   redundant `true` on a window launched or reloaded behind another one
 *   would make it paint unseen again.
 * - A release that lands while the window is hidden cannot hide it: Chromium
 *   hides a widget only on a visibility transition, and the one that happened
 *   while the demand was on was swallowed. The window keeps rendering until
 *   its next show, restore or occlusion change. That is a known ceiling of
 *   the exception, not of the default.
 *
 * A demand belongs to the document that made it. Each new document re-asserts
 * its own demand when it installs (normally "not required"), and main also
 * restores throttling once a main-frame navigation has COMMITTED or the
 * renderer process is gone, because neither leaves anyone who would send the
 * release. Not on `did-start-navigation`: that also fires for a navigation the
 * navigation guard then cancels, and the live document would lose its demand.
 */

/** The slice of `WebContents` this module drives; narrow so tests can fake it. */
export interface BackgroundRenderingTarget {
  getBackgroundThrottling(): boolean;
  setBackgroundThrottling(allowed: boolean): void;
}

export interface BackgroundRenderingWindow extends BackgroundRenderingTarget {
  on(event: "did-navigate", listener: () => void): unknown;
  on(event: "render-process-gone", listener: () => void): unknown;
}

export function setBackgroundRenderingRequired(
  target: BackgroundRenderingTarget,
  required: boolean,
): void {
  const allowed = !required;
  if (target.getBackgroundThrottling() === allowed) return;
  target.setBackgroundThrottling(allowed);
}

export function installBackgroundRenderingReset(
  target: BackgroundRenderingWindow,
): void {
  const reset = (): void => {
    setBackgroundRenderingRequired(target, false);
  };
  target.on("did-navigate", reset);
  target.on("render-process-gone", reset);
}

/**
 * The renderer's own switch. `event.sender` is the asking window's
 * WebContents, already vetted as a registered top frame by `handleInvoke`, so
 * a window can only ever change itself.
 */
export function registerBackgroundRenderingIpc(
  bridge: Pick<RunnerIpcBridge, "handleInvoke">,
): void {
  bridge.handleInvoke(
    RunnerHostInvoke.backgroundRenderingSet,
    (event, required) => {
      if (typeof required !== "boolean") {
        throw new Error("backgroundRendering.set expects a boolean");
      }
      setBackgroundRenderingRequired(event.sender, required);
      return null;
    },
  );
}
