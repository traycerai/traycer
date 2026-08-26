import type { ValueAnimationTransition } from "motion/react";

/**
 * The physical constants and the release rule for the navigation drawer's
 * follow-the-finger drag. Kept apart from the surface that renders it so the
 * decision the release makes is a pure function with no DOM in reach.
 */

/**
 * Release speed that commits the gesture on its own, in px per SECOND - the
 * unit motion reports pointer velocity in, so it crosses no conversion.
 *
 * The speed arm is what separates a gesture that feels connected to the hand
 * from one that feels dutiful: a flick that has barely travelled still commits,
 * the way every platform drawer behaves. It needs no minimum distance of its
 * own, because the intent classifier already required travel before the drag
 * could begin.
 */
export const NAV_DRAWER_COMMIT_VELOCITY_PX_PER_S = 500;

/**
 * Fraction of the PANEL's own travel a slow release must have covered to
 * commit.
 *
 * Measured against the panel rather than the viewport, and that distinction is
 * load-bearing rather than cosmetic. The panel is `w-3/4` capped at a maximum,
 * so on a wide screen it stops growing while the viewport keeps going: a
 * viewport-derived arm on a landscape tablet lands further out than the panel
 * can ever travel, and no slow drag commits in either direction - the gesture
 * silently degrades to flick-only. Deriving from the travel that actually
 * exists makes the arm reachable at every size by construction, and asks for
 * the same share of the panel on every device.
 */
export const NAV_DRAWER_COMMIT_TRAVEL_FRACTION = 1 / 3;

/**
 * Euclidean travel a pointer may cover and still count as a tap.
 *
 * Needed because "the drag engine never reported a gesture" is NOT the same
 * question as "the pointer never moved". The engine batches pointer moves to
 * the next frame and drops the pending one when the pointer lifts, so a flick
 * fast enough to start and finish inside a single frame arrives looking exactly
 * like a press that never travelled. Anything acting on a release has to decide
 * for itself, from coordinates it kept, rather than inferring it from silence.
 *
 * Matches the slop the shell's other tap detector uses, because a tap is a tap
 * wherever it lands and two different answers on one screen is how a surface
 * starts feeling arbitrary.
 */
export const NAV_DRAWER_TAP_SLOP_PX = 8;

/**
 * The settle. One spring for both directions, because one physical object
 * cannot arrive by one rule and leave by another - a drawer that opens with a
 * different weight than it closes reads as two surfaces wearing the same
 * pixels.
 *
 * `visualDuration` describes the time to visually arrive rather than the time
 * for the spring's tail to decay, so this stays a ~220ms settle regardless of
 * how far the panel has left to travel; the near-zero bounce keeps it from
 * overshooting into the gap it just closed.
 */
export const NAV_DRAWER_SETTLE: ValueAnimationTransition<number> = {
  type: "spring",
  visualDuration: 0.22,
  bounce: 0.05,
};

/**
 * The settle under a reduced-motion preference: arrive, do not travel. The drag
 * itself is untouched - direct manipulation is not motion the interface chose
 * to play, it is the finger, and taking it away would leave no gesture at all.
 */
export const NAV_DRAWER_SETTLE_REDUCED: ValueAnimationTransition<number> = {
  duration: 0,
};

export interface NavDrawerRelease {
  /** Panel travel at release: 0 fully closed, `widthPx` fully open. */
  readonly positionPx: number;
  /** Measured panel width, so nothing here assumes a drawer size. */
  readonly widthPx: number;
  /** Signed pointer velocity along x at release, px per second. */
  readonly velocityPxPerS: number;
  /** Which resting position the gesture began from. */
  readonly openAtGestureStart: boolean;
  /**
   * The system ended the gesture rather than the user - a call arriving, the
   * notification shade, a palm on the glass. Nothing the pointer did on its way
   * out was a choice, so none of it may be read as one.
   */
  readonly cancelled: boolean;
}

/**
 * Where a released drag settles to.
 *
 * For a completed gesture, velocity is read before distance, and in absolute
 * terms: a fast flick decides the direction whatever the distance says,
 * including the flick that reverses a drag most of the way through. Only a
 * release that is effectively stationary
 * falls through to the distance arm, and that arm measures travel FROM the
 * resting position the gesture started at - so the same share of the panel
 * opens a closed drawer and closes an open one.
 *
 * The distance arm is derived here rather than passed in, which is what keeps
 * it inside the travel the panel actually has. A caller that computed the
 * threshold from anything else - a viewport, a breakpoint, a constant - could
 * hand in a distance the drag can never reach, and the failure would look like
 * a drawer that simply ignores slow drags rather than like a bad number.
 *
 * Cancellation is answered before either arm, and it beats both. A gesture the
 * system took away expressed no intent, however far it had travelled or however
 * fast it was moving when it was interrupted - so the panel returns to the side
 * it started from. Deciding it here rather than at the call site is what gives
 * every entry into the drag the same answer: a push from the scrim and a drag
 * on the panel itself both release through this.
 */
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
