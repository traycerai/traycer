import type { ValueAnimationTransition } from "motion/react";

/** The physical constants and the release rule for the navigation drawer's follow-the-finger drag. */

/** It needs no minimum distance of its own, because the intent classifier already required travel before the
 * drag could begin. */
export const NAV_DRAWER_COMMIT_VELOCITY_PX_PER_S = 500;

/** Fraction of the panel's own travel a slow release must have covered to commit. Measured against the panel
 * rather than the viewport, and that distinction is load-bearing rather than cosmetic. */
export const NAV_DRAWER_COMMIT_TRAVEL_FRACTION = 1 / 3;

/** Needed because "the drag engine never reported a gesture" is not the same question as "the pointer never
 * moved". */
export const NAV_DRAWER_TAP_SLOP_PX = 8;

/** One spring for both directions, because one physical object cannot arrive by one rule and leave by another -
 * a drawer that opens with a different weight than it closes reads as two surfaces wearing the same pixels. */
export const NAV_DRAWER_SETTLE: ValueAnimationTransition<number> = {
  type: "spring",
  visualDuration: 0.22,
  bounce: 0.05,
};

/** The settle under a reduced-motion preference: arrive, do not travel. */
export const NAV_DRAWER_SETTLE_REDUCED: ValueAnimationTransition<number> = {
  duration: 0,
};

export interface NavDrawerRelease {
  readonly positionPx: number;
  readonly widthPx: number;
  readonly velocityPxPerS: number;
  readonly openAtGestureStart: boolean;
  /** The system ended the gesture rather than the user - a call arriving, the notification shade, a palm on the
   * glass. */
  readonly cancelled: boolean;
}

/** A caller that computed the threshold from anything else - a viewport, a breakpoint, a constant. */
export function resolvesToOpen(release: NavDrawerRelease): boolean {
  if (release.cancelled) return release.openAtGestureStart;
  if (release.velocityPxPerS > NAV_DRAWER_COMMIT_VELOCITY_PX_PER_S) return true;
  if (release.velocityPxPerS < -NAV_DRAWER_COMMIT_VELOCITY_PX_PER_S) {
    return false;
  }
  const commitTravelPx = release.widthPx * NAV_DRAWER_COMMIT_TRAVEL_FRACTION;
  if (release.openAtGestureStart) {
    return release.widthPx - release.positionPx < commitTravelPx;
  }
  return release.positionPx >= commitTravelPx;
}
