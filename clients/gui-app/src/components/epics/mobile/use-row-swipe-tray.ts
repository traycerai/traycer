import {
  useCallback,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  classifyDirectionalIntent,
  commitsDirectionalGesture,
} from "@/components/layout/shell/shell-gestures";
import { readSafeAreaInsets } from "@/lib/safe-area-insets";

/** 44px is the touch-target floor, and the tray is sized from it rather than measured: the reveal distance has
 * to be known on the first move of the drag, before the tray has ever been painted. */
export const TRAY_ACTION_PX = 44;

/** Reveal that commits on release however slowly it was dragged - half the tray, the point past which the
 * actions read as intentionally exposed. */
const COMMIT_FRACTION = 0.5;

/** Release speed that commits before half the tray is reached. */
const COMMIT_VELOCITY_PX_PER_MS = 0.5;

/** Without it the row stops dead under a finger that is still moving, which reads as a dropped gesture rather
 * than a limit. */
const OVERPULL_PX = 40;

/** Deliberately smaller than the activation distance: a drag that never declared an axis still must not
 * navigate, because a finger that moved at all was not pointing at anything. */
const TAP_SLOP_PX = 6;

/** Width of the strip along the screen's leading edge that a row swipe leaves alone, reserved for whatever
 * gesture the shell claims that edge with. */
const EDGE_ZONE_PX = 32;

/** Measured from the safe-area inset rather than from zero. */
function withinEdgeZone(clientX: number): boolean {
  const left = readSafeAreaInsets().left;
  return clientX >= left && clientX <= left + EDGE_ZONE_PX;
}

/** Which way that is depends on where the tray already sits, and every threshold in the recognizer - the
 * classifier's counter-direction arm, the tap slop, the commit distance. */
function forwardTravelPx(startX: number, x: number, isOpen: boolean): number {
  return isOpen ? x - startX : startX - x;
}

function overpulled(beyondPx: number): number {
  // Asymptotic: every further pixel of finger travel yields less row travel, so
  // the row never reaches the limit and never visibly stops.
  return (OVERPULL_PX * beyondPx) / (beyondPx + OVERPULL_PX);
}

interface SwipeTracking {
  /** A pointer can stay down across one: selection mode entered from another input while a finger is already on a
   * row, then left again before that finger lifts. */
  readonly epoch: number;
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly at: number;
  activated: boolean;
  moved: boolean;
}

export interface RowSwipeTray {
  readonly offsetPx: number;
  /** The row is following a finger, so its motion must not be eased. */
  readonly isDragging: boolean;
  readonly trayWidthPx: number;
  readonly close: () => void;
  readonly handlers: RowSwipeHandlers;
  /** Whether the interaction that just ended was a drag rather than a tap. Read synchronously by the row's click
   * handler, which fires after `pointerup` and must not navigate on the tail of a swipe. */
  readonly consumedTap: () => boolean;
}

export interface RowSwipeHandlers {
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
}

export interface RowSwipeTrayArgs {
  readonly actionCount: number;
  /** The tray is open according to the list, which allows only one at a time. Ownership lives up there rather
   * than here so opening one row closes the others without rows having to know about each other. */
  readonly isOpen: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly disabled: boolean;
  readonly onDragStart: () => void;
}

/** The row declares `touch-action: pan-y`, which is what makes this work without ever calling `preventDefault`. */
export function useRowSwipeTray(args: RowSwipeTrayArgs): RowSwipeTray {
  const { actionCount, isOpen, onOpenChange, disabled, onDragStart } = args;
  const trayWidthPx = actionCount * TRAY_ACTION_PX;
  const [dragOffsetPx, setDragOffsetPx] = useState<number | null>(null);
  const trackingRef = useRef<SwipeTracking | null>(null);
  const consumedTapRef = useRef(false);

  const enabled = !disabled && actionCount > 0;

  // A row that loses its tray while a drag is live - selection mode entered from elsewhere, the list re-sorting
  // under the finger - must not keep a stale offset painted, and must not still be believed once it comes back.
  const [enableState, setEnableState] = useState({ enabled, epoch: 0 });
  if (enableState.enabled !== enabled) {
    setEnableState({ enabled, epoch: enableState.epoch + 1 });
    setDragOffsetPx(null);
  }
  const enableEpoch = enableState.epoch;

  const close = useCallback(() => {
    trackingRef.current = null;
    setDragOffsetPx(null);
    onOpenChange(false);
  }, [onOpenChange]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled) return;
      if (event.pointerType !== "touch") return;
      if (!event.isPrimary) return;
      // Nothing is captured until the drag activates, so a pointer that never declared itself and then ended off
      // this element leaves its tracker behind.
      trackingRef.current = null;
      setDragOffsetPx(null);
      // A tap inside the strip is still the row's - only a directed drag is
      // ever yielded - so the tap flag clears here too rather than below.
      consumedTapRef.current = false;
      // Only the open state can contend for the edge: a closed tray's forward
      // direction is leftward, away from the reserved strip.
      if (isOpen && withinEdgeZone(event.clientX)) return;
      trackingRef.current = {
        epoch: enableEpoch,
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        at: event.timeStamp,
        activated: false,
        moved: false,
      };
    },
    [enableEpoch, enabled, isOpen],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      // A gesture can be stood down mid-drag, and a tracker created while the row still had a tray must not keep
      // driving it afterwards.
      if (!enabled) return;
      const tracking = trackingRef.current;
      if (tracking === null) return;
      if (tracking.epoch !== enableEpoch) return;
      if (event.pointerId !== tracking.pointerId) return;
      const travelPx = forwardTravelPx(tracking.x, event.clientX, isOpen);
      if (
        !tracking.moved &&
        (Math.abs(travelPx) > TAP_SLOP_PX ||
          Math.abs(event.clientY - tracking.y) > TAP_SLOP_PX)
      ) {
        tracking.moved = true;
      }
      if (!tracking.activated) {
        const intent = classifyDirectionalIntent({
          primaryPx: travelPx,
          crossPx: event.clientY - tracking.y,
          elapsedMs: event.timeStamp - tracking.at,
        });
        if (intent === "fail") {
          // Handing the touch back does not hand back the tap: a finger that travelled and then released was scrolling
          // or swiping the wrong way, and opening the task on it would be a navigation nobody asked for.
          trackingRef.current = null;
          consumedTapRef.current = tracking.moved;
          return;
        }
        if (intent === "wait") return;
        // Direction lock: from here the drag is the tray's, and a finger that curves vertically keeps it.
        tracking.activated = true;
        consumedTapRef.current = true;
        onDragStart();
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      // Travel is measured from wherever the tray already was, so the row
      // picks up under the finger instead of snapping to an end state first.
      const raw = isOpen ? trayWidthPx - travelPx : travelPx;
      if (raw <= 0) {
        setDragOffsetPx(0);
        return;
      }
      setDragOffsetPx(
        raw <= trayWidthPx ? raw : trayWidthPx + overpulled(raw - trayWidthPx),
      );
    },
    [enableEpoch, enabled, isOpen, onDragStart, trayWidthPx],
  );

  const settle = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled) return;
      const tracking = trackingRef.current;
      if (tracking === null) return;
      if (tracking.epoch !== enableEpoch) return;
      if (event.pointerId !== tracking.pointerId) return;
      trackingRef.current = null;
      consumedTapRef.current = tracking.moved;
      if (!tracking.activated) {
        setDragOffsetPx(null);
        return;
      }
      // Distance OR speed, evaluated at release rather than per move.
      const travelPx = forwardTravelPx(tracking.x, event.clientX, isOpen);
      const commits = commitsDirectionalGesture(
        {
          primaryPx: travelPx,
          crossPx: event.clientY - tracking.y,
          elapsedMs: event.timeStamp - tracking.at,
        },
        {
          commitPx: trayWidthPx * COMMIT_FRACTION,
          velocityPxPerMs: COMMIT_VELOCITY_PX_PER_MS,
        },
      );
      setDragOffsetPx(null);
      // Committing means the gesture completed its forward direction, which is
      // "reveal" from rest and "put away" from open.
      onOpenChange(isOpen ? !commits : commits);
    },
    [enableEpoch, enabled, isOpen, onOpenChange, trayWidthPx],
  );

  const onPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled) return;
      const tracking = trackingRef.current;
      if (tracking === null) return;
      if (tracking.epoch !== enableEpoch) return;
      if (event.pointerId !== tracking.pointerId) return;
      trackingRef.current = null;
      setDragOffsetPx(null);
    },
    [enableEpoch, enabled],
  );

  const consumedTap = useCallback(() => consumedTapRef.current, []);

  return {
    // Making that true here rather than at each call site is what keeps "disabled" from meaning only "cannot be
    // dragged" while a row left over from before still sits translated with its actions on show.
    offsetPx: enabled ? (dragOffsetPx ?? (isOpen ? trayWidthPx : 0)) : 0,
    isDragging: dragOffsetPx !== null,
    trayWidthPx,
    close,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: settle,
      onPointerCancel,
    },
    consumedTap,
  };
}
