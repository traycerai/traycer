import { useLayoutEffect } from "react";

/**
 * The element `index.html` paints before any script runs. Declared here as
 * well as there because the removal below has to name the same thing the
 * markup does, and a rename on one side leaves a splash covering a working
 * app - a failure no rendering test would notice, since the app underneath it
 * renders perfectly.
 */
export const BOOT_SURFACE_ID = "boot-surface";

/**
 * Takes the boot surface down at the exact moment the app takes the screen.
 *
 * The timing is the whole component. Rendering a root does not put anything on
 * screen: `render()` SCHEDULES work, and React commits it later, so removing
 * the surface next to that call reopens the blank gap the surface exists to
 * close - a shorter one, and no longer visible in any test that only checks
 * that both things happened.
 *
 * A layout effect is the one hook that runs after React has written the app's
 * DOM and before the browser paints it, so the swap happens inside a single
 * frame: there is no moment where neither surface is present. It also inherits
 * the right behaviour for the cases that are not a plain success - a tree that
 * suspends or throws never commits, so the effect never runs and the visitor
 * keeps a legible screen instead of an empty one.
 *
 * Mounted as the first child of the root tree, not as a wrapper: it must not
 * be able to alter what the app itself renders.
 */
export function RetireBootSurface(): null {
  useLayoutEffect(() => {
    // Idempotent by construction, which is what makes a double-invoked mount
    // in development a no-op rather than a crash.
    document.getElementById(BOOT_SURFACE_ID)?.remove();
  }, []);
  return null;
}

/** What the surface says once the boot has failed rather than finished. */
export const BOOT_FAILURE_MESSAGE = "Traycer could not start.";

/** The label on the only action a failed boot offers. */
export const BOOT_RETRY_LABEL = "Try again";

/**
 * Turns the boot surface from "waiting" into "failed, and here is the way
 * out".
 *
 * The surface's whole reason to exist is that nothing else is on screen until
 * the boot commits - which makes an unfinished boot indistinguishable from a
 * slow one for as long as the document lives. Every path into `bootstrap()`
 * that can reject therefore has to end here, or "Signing you in…" pulses
 * forever with no error, no app and nothing to click.
 *
 * Plain DOM, like the markup it replaces: this runs on a boot that did not
 * reach React, so it cannot be a component, and it must not depend on the
 * bundle having initialized anything.
 *
 * Reload rather than a retry of `bootstrap()` in place: the boot mutates
 * module state (the analytics surface, the runner host, the mint's
 * scratchpad), so a fresh document is the only retry that starts from a state
 * this function can name.
 */
export function showBootFailure(): void {
  const surface = document.getElementById(BOOT_SURFACE_ID);
  if (surface === null) return;
  const wordmark = document.createElement("div");
  wordmark.className = "boot-wordmark";
  wordmark.textContent = "Traycer";
  const status = document.createElement("div");
  // `boot-failed` stops the pulse: an animation that reads as progress is
  // worse than none once there is no progress left to make.
  status.className = "boot-status boot-failed";
  status.textContent = BOOT_FAILURE_MESSAGE;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "boot-retry";
  retry.textContent = BOOT_RETRY_LABEL;
  retry.addEventListener("click", () => {
    window.location.reload();
  });
  // Replaces rather than appends, so a second failure cannot stack a second
  // message and a second button under the first.
  surface.replaceChildren(wordmark, status, retry);
}
