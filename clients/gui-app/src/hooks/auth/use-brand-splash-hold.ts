import { useEffect, useState } from "react";
import { admitsLocalPlane, useAuthStore } from "@/stores/auth/auth-store";

/**
 * How long the signed-out launch splash owns the screen, measured from the
 * moment this module is first evaluated - which is app start, not the mount of
 * any one surface.
 *
 * The number is a CEILING on a purely decorative surface, never a floor under a
 * functional one. Nothing waits on it: it gates the sign-in page and only the
 * sign-in page, which has nothing to do until a human presses a button. Every
 * other launch shape keeps its own timing (see {@link useBrandSplashHold}).
 */
export const BRAND_SPLASH_MAX_MS = 2500;

/**
 * The crossfade at the end, and the reason the hold below is SHORTER than the
 * ceiling rather than equal to it: the ceiling is the moment the splash is
 * fully gone, so the fade has to happen inside it, not after it.
 */
export const BRAND_SPLASH_EXIT_MS = 240;

const BRAND_SPLASH_HOLD_MS = BRAND_SPLASH_MAX_MS - BRAND_SPLASH_EXIT_MS;

/**
 * App start. A module constant rather than a mount timestamp on purpose: this
 * is a LAUNCH splash, and reading the clock at mount would replay it on every
 * later arrival at the sign-in surface - signing out, a session expiring, a
 * refused shell admission. By the time any of those happen the ceiling is long
 * past, so the same expression that caps the splash also confines it to launch,
 * with no consumed-once flag to reset.
 */
const APP_START_MS = Date.now();

function remainingHoldMs(): number {
  return BRAND_SPLASH_HOLD_MS - (Date.now() - APP_START_MS);
}

/**
 * Time left until the splash must be GONE, measured from app start like the
 * hold is.
 *
 * Deliberately not a fresh {@link BRAND_SPLASH_EXIT_MS} countdown from whenever
 * the exit phase commits: that would start the fade after the hold deadline
 * rather than inside the budget, and every scheduling delay between the two
 * would push the real ceiling past the one this module advertises. Both
 * deadlines are absolute, so the ceiling is the ceiling.
 */
function remainingExitMs(): number {
  return Math.max(0, BRAND_SPLASH_MAX_MS - (Date.now() - APP_START_MS));
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export type BrandSplashPhase = "hold" | "exit" | "done";

/**
 * Whether the signed-out launch splash is still covering the sign-in page, and
 * whether it is on its way out.
 *
 * THE RULE THIS HOOK EXISTS TO KEEP: an admitted session is never held. The
 * check is {@link admitsLocalPlane}, so `signed-in` and `unverified` both leave
 * immediately and neither one consults a timer - the boot cover that serves
 * those launches fills a REAL wait and still yields the instant readiness
 * arrives. The splash is the one deliberate exception to "no artificial hold",
 * it applies to the signed-out arrival alone, and it is bounded.
 *
 * Auth resolving late does not extend it either. The ceiling is measured from
 * app start and nothing in here awaits an auth verdict, so a launch whose auth
 * is still pending at the ceiling drops the splash on schedule and shows
 * whatever the app would otherwise have shown.
 *
 * @param enabled - `false` where a splash would delay something a user needs to
 *   read. The refused-shell arm of the sign-in page is the case: that surface
 *   exists to explain why a session was turned away.
 */
export function useBrandSplashHold(enabled: boolean): BrandSplashPhase {
  const authStatus = useAuthStore((state) => state.status);
  const [phase, setPhase] = useState<BrandSplashPhase>(() =>
    remainingHoldMs() > 0 ? "hold" : "done",
  );

  useEffect(() => {
    if (phase !== "hold") return;
    const timer = setTimeout(() => setPhase("exit"), remainingHoldMs());
    return () => clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== "exit") return;
    const timer = setTimeout(() => setPhase("done"), remainingExitMs());
    return () => clearTimeout(timer);
  }, [phase]);

  if (!enabled) return "done";
  if (admitsLocalPlane(authStatus)) return "done";
  // Reduced motion takes the splash away entirely rather than showing a static
  // mark for a shortened beat. The surface has no content and no action on it -
  // its whole justification is the motion - so with the motion removed it is
  // just a delay in front of the sign-in button. `prefers-reduced-motion` asks
  // for less movement, not for a slower app.
  if (prefersReducedMotion()) return "done";
  return phase;
}
