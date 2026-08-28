import {
  NAV_DRAWER_SETTLE,
  resolvesToOpen,
} from "@/components/layout/shell/nav-drawer-motion";
import type { EdgeNavDirection } from "@/components/layout/shell/use-edge-nav-swipe";

/**
 * The physics and the geometry of the follow-the-finger history transition,
 * kept apart from the surface that renders it so both the release decision and
 * every layer transform are pure functions with no DOM in reach.
 */

/**
 * The settle, and the release rule, are the navigation drawer's - imported
 * rather than restated.
 *
 * Two direct-manipulation gestures live on the same phone screen, and a user
 * pulling the drawer out and swiping a screen away within the same second is
 * feeling for ONE set of physical constants. Deriving a second spring here, or
 * a second commit threshold, would make the app's weight depend on which
 * gesture you happened to make - which is how a surface starts feeling
 * arbitrary rather than physical.
 */
export const SWIPE_NAV_SETTLE = NAV_DRAWER_SETTLE;

/**
 * How far the destination trails the finger, as a fraction of its own travel.
 *
 * The destination does not move with the outgoing card; it moves a THIRD as
 * far, starting displaced behind the screen edge and arriving as the card
 * leaves. That difference in speed is the entire depth cue - two planes at
 * different distances, which is what makes the pair read as a stack rather
 * than as one strip of content sliding past a window.
 */
const DESTINATION_PARALLAX = 1 / 3;

/**
 * Peak dim over the plane that is BEHIND at rest.
 *
 * Kept low deliberately. The dim exists to seat the far plane under the near
 * one, not to announce itself; anything heavier reads as a modal scrim and
 * makes a cancelled swipe look like a dialog that failed to open.
 */
const RECEDED_DIM_OPACITY = 0.25;

export interface SwipeNavRelease {
  /** Inward travel at release, in px. */
  readonly travelPx: number;
  /** Measured width of the moving layer, so nothing here assumes a viewport. */
  readonly widthPx: number;
  /** Signed pointer velocity along the swipe's own inward axis, px per second. */
  readonly velocityPxPerS: number;
  /**
   * The system ended the gesture rather than the user - a call arriving, a palm
   * on the glass. Nothing the pointer did on its way out was a choice.
   */
  readonly cancelled: boolean;
}

/**
 * Whether a released swipe navigates or springs back.
 *
 * Delegates to the drawer's rule rather than restating it: velocity first and
 * in absolute terms, so a flick commits however short it was; then a share of
 * the travel the layer actually has; and cancellation beating both. The drawer
 * expresses that rule over a panel that can be released from either resting
 * position, and a navigation swipe only ever starts from one - so it is passed
 * as a drag that began closed, which is what this gesture is.
 */
export function swipeNavCommits(release: SwipeNavRelease): boolean {
  return resolvesToOpen({
    positionPx: release.travelPx,
    widthPx: release.widthPx,
    velocityPxPerS: release.velocityPxPerS,
    openAtGestureStart: false,
    cancelled: release.cancelled,
  });
}

export interface SwipeNavLayerTransform {
  /** Ready for a motion `style`; a plain object so this stays testable. */
  readonly x: number;
  /** Opacity of the dim laid OVER this layer. 0 leaves it undimmed. */
  readonly dimOpacity: number;
}

export interface SwipeNavComposition {
  readonly outgoing: SwipeNavLayerTransform;
  readonly destination: SwipeNavLayerTransform;
  /** Which layer is nearest the viewer for the whole gesture. */
  readonly nearLayer: "outgoing" | "destination";
}

export type SwipeNavPlane = "near" | "far";

/**
 * The transform belonging to a plane rather than to a named screen.
 *
 * The renderer stacks by DEPTH - it paints the far plane and then the near one
 * - while the composition names the two screens. This is the one place the two
 * vocabularies meet, so no caller has to re-derive which screen is in front for
 * a given direction, and get it backwards for one of them.
 */
export function swipeNavPlaneTransform(
  composition: SwipeNavComposition,
  plane: SwipeNavPlane,
): SwipeNavLayerTransform {
  const nearIsOutgoing = composition.nearLayer === "outgoing";
  if (plane === "near") {
    return nearIsOutgoing ? composition.outgoing : composition.destination;
  }
  return nearIsOutgoing ? composition.destination : composition.outgoing;
}

/**
 * Where both layers sit at a given progress.
 *
 * ONE function for both directions, because the two directions are the same
 * transition with the roles exchanged: going BACK, the screen you are on is
 * the near plane and it leaves; going FORWARD, the screen you are heading to
 * is the near plane and it arrives. Deriving them separately is how a back
 * that feels right ends up paired with a forward that feels inverted.
 *
 * `progress` is 0 at the resting position the gesture began from and 1 at the
 * committed one, and is the only quantity the caller animates - so an
 * interrupted settle resumes from wherever it had reached rather than from a
 * position recomputed out of the pointer.
 */
export function composeSwipeNavLayers(
  direction: EdgeNavDirection,
  progress: number,
  widthPx: number,
): SwipeNavComposition {
  // A back drag carries the near plane OUT (0 -> 1 of its own travel); a
  // forward drag carries it IN (1 -> 0). Reading them as one advance of the
  // near plane is what lets a single composition answer both.
  const nearAdvance = direction === "back" ? progress : 1 - progress;
  const plane = (side: SwipeNavPlane): SwipeNavLayerTransform =>
    popPlane(nearAdvance, widthPx, side);
  const near = plane("near");
  const far = plane("far");
  return direction === "back"
    ? { outgoing: near, destination: far, nearLayer: "outgoing" }
    : { outgoing: far, destination: near, nearLayer: "destination" };
}

/**
 * The stacked-card plane. The near one rides the finger the whole width; the
 * far one covers a third of that distance from behind the opposite edge, and
 * its dim lifts as it arrives.
 *
 * No direction reaches this function, and that is the invariant: the stack has
 * ONE orientation. The near plane's off-screen slot is past the trailing edge
 * and the far plane recedes toward the leading one, whichever way the finger
 * is moving - a back swipe pushes the near plane out to that slot, a forward
 * swipe pulls it in from there, and both are under the finger the whole way.
 * Mirroring the geometry with the direction is how a forward ends up moving
 * against the finger that is dragging it: direction belongs entirely to how
 * `nearAdvance` evolves with the gesture's progress.
 */
function popPlane(
  nearAdvance: number,
  widthPx: number,
  plane: "near" | "far",
): SwipeNavLayerTransform {
  if (plane === "near") {
    return {
      x: nearAdvance * widthPx,
      dimOpacity: 0,
    };
  }
  return {
    x: -(1 - nearAdvance) * widthPx * DESTINATION_PARALLAX,
    dimOpacity: (1 - nearAdvance) * RECEDED_DIM_OPACITY,
  };
}
