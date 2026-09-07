import { useLayoutEffect, useRef, type ReactNode } from "react";
import { motion, useTransform, type MotionValue } from "motion/react";
import {
  composeSwipeNavLayers,
  swipeNavPlaneTransform,
  type SwipeNavPlane,
} from "@/components/layout/shell/swipe-nav-transition-motion";
import {
  applyScreenSnapshotScroll,
  SWIPE_NAV_EXCLUDE_ATTRIBUTE,
  type ScreenSnapshot,
} from "@/components/layout/shell/screen-snapshot";
import type { EdgeNavDirection } from "@/components/layout/shell/use-edge-nav-swipe";
import { cn } from "@/lib/utils";

export interface SwipeNavTransitionView {
  readonly direction: EdgeNavDirection;
  readonly outgoing: ScreenSnapshot;
  readonly destination: ScreenSnapshot;
  /** The commit re-resolves and compares against this, because a store mutation under the held pointer can move
   * the step's landing: a settle must not carry a screen to completion and then navigate somewhere else. */
  readonly destinationKey: string;
  /** Measured once, at the gesture's start; never re-read mid-drag. */
  readonly widthPx: number;
}

interface SwipeNavTransitionLayersProps {
  readonly view: SwipeNavTransitionView;
  readonly progress: MotionValue<number>;
}

/** Carries the exclusion marker, because a snapshot taken while a transition is on screen would otherwise clone
 * these layers into the next frozen screen - and the one after that would contain both. */
export function SwipeNavTransitionLayers(
  props: SwipeNavTransitionLayersProps,
): ReactNode {
  const { view, progress } = props;
  return (
    <div
      aria-hidden
      className="absolute inset-0 z-50 overflow-hidden bg-canvas"
      data-direction={view.direction}
      data-testid="swipe-nav-transition-layers"
      {...{ [SWIPE_NAV_EXCLUDE_ATTRIBUTE]: "" }}
    >
      {/* Painted far first, near second: that is the order they stack in, and the near plane is whichever screen the
         finger is carrying - the outgoing one going back, the destination one going forward. */}
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
  const { direction, widthPx } = view;
  const x = useTransform(
    progress,
    (value: number) =>
      swipeNavPlaneTransform(
        composeSwipeNavLayers(direction, value, widthPx),
        plane,
      ).x,
  );
  const dimOpacity = useTransform(
    progress,
    (value: number) =>
      swipeNavPlaneTransform(
        composeSwipeNavLayers(direction, value, widthPx),
        plane,
      ).dimOpacity,
  );
  const snapshot = planeSnapshot(view, plane);
  return (
    <motion.div
      className={cn("absolute inset-0", plane === "near" && "shadow-2xl")}
      data-plane={plane}
      style={{ x }}
    >
      <SnapshotMount snapshot={snapshot} />
      {/* A sibling rather than an opacity on the screen itself, so the frozen content keeps its own colours and only
         the light on it changes. */}
      <motion.div
        className="pointer-events-none absolute inset-0 bg-black"
        style={{ opacity: dimOpacity }}
      />
    </motion.div>
  );
}

/** The frozen screen a plane shows, taken from the composition's own answer. */
function planeSnapshot(
  view: SwipeNavTransitionView,
  plane: SwipeNavPlane,
): ScreenSnapshot {
  const composition = composeSwipeNavLayers(view.direction, 0, view.widthPx);
  const nearIsOutgoing = composition.nearLayer === "outgoing";
  const showsOutgoing = plane === "near" ? nearIsOutgoing : !nearIsOutgoing;
  return showsOutgoing ? view.outgoing : view.destination;
}

/** The snapshot is a detached element the cache owns rather than markup this component describes, so it is
 * appended. */
function SnapshotMount(props: {
  readonly snapshot: ScreenSnapshot;
}): ReactNode {
  const { snapshot } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
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
