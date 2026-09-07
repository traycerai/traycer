import {
  NAV_DRAWER_SETTLE,
  resolvesToOpen,
} from "@/components/layout/shell/nav-drawer-motion";
import type { EdgeNavDirection } from "@/components/layout/shell/use-edge-nav-swipe";

/** The physics and the geometry of the follow-the-finger history transition, kept apart from the surface that
 * renders it so both the release decision and every layer transform are pure functions with no DOM in reach. */

/** Deriving a second spring here, or a second commit threshold, would make the app's weight depend on which
 * gesture you happened to make - which is how a surface starts feeling arbitrary rather than physical. */
export const SWIPE_NAV_SETTLE = NAV_DRAWER_SETTLE;

/** That difference in speed is the entire depth cue - two planes at different distances, which is what makes
 * the pair read as a stack rather than as one strip of content sliding past a window. */
const DESTINATION_PARALLAX = 1 / 3;

/** Peak dim over the plane that is behind at rest. */
const RECEDED_DIM_OPACITY = 0.25;

export interface SwipeNavRelease {
  readonly travelPx: number;
  readonly widthPx: number;
  readonly velocityPxPerS: number;
  /** The system ended the gesture rather than the user - a call arriving, a palm on the glass. */
  readonly cancelled: boolean;
}

/** Delegates to the drawer's rule rather than restating it: velocity first and in absolute terms, so a flick
 * commits however short it was; then a share of the travel the layer actually has. */
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
  readonly x: number;
  readonly dimOpacity: number;
}

export interface SwipeNavComposition {
  readonly outgoing: SwipeNavLayerTransform;
  readonly destination: SwipeNavLayerTransform;
  readonly nearLayer: "outgoing" | "destination";
}

export type SwipeNavPlane = "near" | "far";

/** The transform belonging to a plane rather than to a named screen. The renderer stacks by depth - it paints
 * the far plane and then the near one - while the composition names the two screens. */
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

/** `progress` is 0 at the resting position the gesture began from and 1 at the committed one, and is the only
 * quantity the caller animates. */
export function composeSwipeNavLayers(
  direction: EdgeNavDirection,
  progress: number,
  widthPx: number,
): SwipeNavComposition {
  // A back drag carries the near plane out (0 -> 1 of its own travel); a forward drag carries it IN (1 -> 0).
  const nearAdvance = direction === "back" ? progress : 1 - progress;
  const plane = (side: SwipeNavPlane): SwipeNavLayerTransform =>
    popPlane(nearAdvance, widthPx, side);
  const near = plane("near");
  const far = plane("far");
  return direction === "back"
    ? { outgoing: near, destination: far, nearLayer: "outgoing" }
    : { outgoing: far, destination: near, nearLayer: "destination" };
}

/** The stacked-card plane. */
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
