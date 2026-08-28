import { useEffect, useRef, type ReactNode } from "react";
import { motion, useTransform, type MotionValue } from "motion/react";
import {
  composeSwipeNavLayers,
  swipeNavPlaneTransform,
  type SwipeNavPlane,
  type SwipeNavShape,
} from "@/components/layout/shell/swipe-nav-transition-motion";
import {
  applyScreenSnapshotScroll,
  SWIPE_NAV_EXCLUDE_ATTRIBUTE,
  type ScreenSnapshot,
} from "@/components/layout/shell/screen-snapshot";
import type { EdgeNavDirection } from "@/components/layout/shell/use-edge-nav-swipe";
import { cn } from "@/lib/utils";

/**
 * Depth of the box the cube shape turns inside. Perspective describes the
 * observer rather than the layout, so it is the one distance here that is not
 * derived from the surface it applies to.
 */
const CUBE_PERSPECTIVE_PX = 1200;

export interface SwipeNavTransitionView {
  readonly direction: EdgeNavDirection;
  readonly outgoing: ScreenSnapshot;
  readonly destination: ScreenSnapshot;
  /** Measured once, at the gesture's start; never re-read mid-drag. */
  readonly widthPx: number;
  readonly shape: SwipeNavShape;
}

interface SwipeNavTransitionLayersProps {
  readonly view: SwipeNavTransitionView;
  /** 0 at the resting position the gesture began from, 1 at the committed one. */
  readonly progress: MotionValue<number>;
}

/**
 * The two frozen screens, over the live app, for as long as a history swipe is
 * in flight.
 *
 * NOTHING HERE RE-RENDERS WITH THE FINGER. Every per-frame quantity is derived
 * from one motion value and written straight to the compositor, so a drag over
 * a streaming chat costs what a drag over a still one costs, and React is asked
 * for exactly two pieces of work per gesture: mount these layers and unmount
 * them.
 *
 * Carries the exclusion marker, because a snapshot taken while a transition is
 * on screen would otherwise clone these layers into the next frozen screen -
 * and the one after that would contain both.
 */
export function SwipeNavTransitionLayers(
  props: SwipeNavTransitionLayersProps,
): ReactNode {
  const { view, progress } = props;
  return (
    <div
      aria-hidden
      className="absolute inset-0 z-50 overflow-hidden bg-canvas"
      data-direction={view.direction}
      data-shape={view.shape}
      data-testid="swipe-nav-transition-layers"
      style={
        view.shape === "cube"
          ? { perspective: CUBE_PERSPECTIVE_PX, transformStyle: "preserve-3d" }
          : undefined
      }
      {...{ [SWIPE_NAV_EXCLUDE_ATTRIBUTE]: "" }}
    >
      {/* Painted far first, near second: that is the order they stack in, and
          the near plane is whichever screen the finger is carrying - the
          outgoing one going back, the destination one going forward. */}
      <SwipeNavLayer plane="far" progress={progress} view={view} />
      <SwipeNavLayer plane="near" progress={progress} view={view} />
    </div>
  );
}

function SwipeNavLayer(props: {
  readonly plane: SwipeNavPlane;
  readonly progress: MotionValue<number>;
  readonly view: SwipeNavTransitionView;
}): ReactNode {
  const { plane, progress, view } = props;
  const { direction, widthPx, shape } = view;
  const x = useTransform(
    progress,
    (value: number) =>
      swipeNavPlaneTransform(
        composeSwipeNavLayers(direction, value, widthPx, shape),
        plane,
      ).x,
  );
  const rotateY = useTransform(
    progress,
    (value: number) =>
      swipeNavPlaneTransform(
        composeSwipeNavLayers(direction, value, widthPx, shape),
        plane,
      ).rotateY,
  );
  const dimOpacity = useTransform(
    progress,
    (value: number) =>
      swipeNavPlaneTransform(
        composeSwipeNavLayers(direction, value, widthPx, shape),
        plane,
      ).dimOpacity,
  );
  // The hinge a face turns about does not move with the finger, so it is read
  // once from the resting composition rather than animated.
  const transformOrigin = swipeNavPlaneTransform(
    composeSwipeNavLayers(direction, 0, widthPx, shape),
    plane,
  ).transformOrigin;
  const snapshot = planeSnapshot(view, plane);
  return (
    <motion.div
      className={cn("absolute inset-0", plane === "near" && "shadow-2xl")}
      data-plane={plane}
      style={{ x, rotateY, transformOrigin }}
    >
      <SnapshotMount snapshot={snapshot} />
      {/* The dim seats the far plane under the near one. A sibling rather than
          an opacity on the screen itself, so the frozen content keeps its own
          colours and only the light on it changes. */}
      <motion.div
        className="pointer-events-none absolute inset-0 bg-black"
        style={{ opacity: dimOpacity }}
      />
    </motion.div>
  );
}

/**
 * The frozen screen a plane shows, taken from the composition's own answer.
 *
 * `nearLayer` is where the plane-to-screen mapping lives, and asking it is what
 * keeps this from being a SECOND copy of the direction rule. Two copies can
 * disagree, and a disagreement here pairs one plane's transform with the other
 * plane's screen - the same class of defect as a transition whose planes
 * travelled against the finger, and just as invisible in a still frame.
 */
function planeSnapshot(
  view: SwipeNavTransitionView,
  plane: SwipeNavPlane,
): ScreenSnapshot {
  const composition = composeSwipeNavLayers(
    view.direction,
    0,
    view.widthPx,
    view.shape,
  );
  const nearIsOutgoing = composition.nearLayer === "outgoing";
  const showsOutgoing = plane === "near" ? nearIsOutgoing : !nearIsOutgoing;
  return showsOutgoing ? view.outgoing : view.destination;
}

/**
 * Puts a frozen screen into the layer.
 *
 * The snapshot is a detached element the cache owns rather than markup this
 * component describes, so it is appended - and it is only ever MOVED, never
 * copied or destroyed: the same frozen screen is the destination of a back
 * swipe and, after that swipe commits, the outgoing screen of the forward swipe
 * that undoes it.
 *
 * The scroll offsets are applied HERE, immediately after the append, and the
 * order is the whole point: a detached element has no scroll box, so the same
 * assignment one moment earlier would be discarded and every scrollable region
 * would freeze at its top. Re-applied on every mount rather than once, because
 * a snapshot is remounted each time it changes plane.
 */
function SnapshotMount(props: {
  readonly snapshot: ScreenSnapshot;
}): ReactNode {
  const { snapshot } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    host.appendChild(snapshot.node);
    applyScreenSnapshotScroll(snapshot);
    return () => {
      snapshot.node.remove();
    };
  }, [snapshot]);
  return <div ref={hostRef} className="absolute inset-0 overflow-hidden" />;
}
