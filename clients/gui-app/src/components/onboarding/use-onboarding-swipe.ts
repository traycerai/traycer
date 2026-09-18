import { useEffect, useRef, type RefObject } from "react";
import { readSafeAreaInsets } from "@/lib/safe-area-insets";

const STEP_SWIPE_COMMIT_PX = 56;

const STEP_SWIPE_DOMINANCE = 1.5;

const STEP_SWIPE_CROSS_FAIL_PX = 24;

const STEP_SWIPE_EDGE_ZONE_PX = 32;

const STEP_SWIPE_EXEMPT_TARGETS =
  "button, a, input, textarea, select, [contenteditable]";

type StepSwipeDirection = "forward" | "back";

interface StepSwipeTracking {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  abandoned: boolean;
}

function withinStepSwipeEdgeZone(clientX: number): boolean {
  const insets = readSafeAreaInsets();
  if (clientX <= insets.left + STEP_SWIPE_EDGE_ZONE_PX) return true;
  return clientX >= window.innerWidth - insets.right - STEP_SWIPE_EDGE_ZONE_PX;
}

export function useOnboardingSwipe(
  surfaceRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  onSwipe: (direction: StepSwipeDirection) => void,
): void {
  // Read at event time, never closed over: the listeners are installed once and
  // must not be torn down and rebuilt on every step change.
  const onSwipeRef = useRef(onSwipe);
  useEffect(() => {
    onSwipeRef.current = onSwipe;
  });

  useEffect(() => {
    if (!enabled) return;
    const surface = surfaceRef.current;
    if (surface === null) return;
    let tracking: StepSwipeTracking | null = null;

    const handlePointerDown = (event: PointerEvent): void => {
      // A second finger is a pinch or a two-finger pan; the tracked pointer's
      // coordinates stop describing the gesture either way.
      tracking = null;
      if (!event.isPrimary) return;
      if (withinStepSwipeEdgeZone(event.clientX)) return;
      if (
        event.target instanceof Element &&
        event.target.closest(STEP_SWIPE_EXEMPT_TARGETS) !== null
      ) {
        return;
      }
      tracking = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        abandoned: false,
      };
    };

    const handlePointerMove = (event: PointerEvent): void => {
      const started = tracking;
      if (started === null) return;
      if (event.pointerId !== started.pointerId) return;
      if (started.abandoned) return;
      const crossPx = Math.abs(event.clientY - started.startY);
      if (crossPx <= STEP_SWIPE_CROSS_FAIL_PX) return;
      if (crossPx >= Math.abs(event.clientX - started.startX)) {
        started.abandoned = true;
      }
    };

    const handlePointerUp = (event: PointerEvent): void => {
      const started = tracking;
      if (started === null) return;
      if (event.pointerId !== started.pointerId) return;
      tracking = null;
      if (started.abandoned) return;
      const travelPx = event.clientX - started.startX;
      const crossPx = Math.abs(event.clientY - started.startY);
      if (Math.abs(travelPx) < STEP_SWIPE_COMMIT_PX) return;
      if (Math.abs(travelPx) < crossPx * STEP_SWIPE_DOMINANCE) return;
      onSwipeRef.current(travelPx < 0 ? "forward" : "back");
    };

    const handlePointerCancel = (event: PointerEvent): void => {
      if (tracking === null) return;
      if (event.pointerId !== tracking.pointerId) return;
      tracking = null;
    };

    const options = { passive: true };
    surface.addEventListener("pointerdown", handlePointerDown, options);
    window.addEventListener("pointermove", handlePointerMove, options);
    window.addEventListener("pointerup", handlePointerUp, options);
    window.addEventListener("pointercancel", handlePointerCancel, options);
    return () => {
      surface.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
    };
  }, [enabled, surfaceRef]);
}
