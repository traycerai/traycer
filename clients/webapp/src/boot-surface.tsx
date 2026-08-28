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
