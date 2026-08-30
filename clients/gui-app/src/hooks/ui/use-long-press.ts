import {
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";

/**
 * Hold that fires the press. The platform context-menu tier rather than the
 * shorter drag-arm one: this opens a mode, and a mode that appears while
 * someone is still deciding whether to scroll is worse than one that takes a
 * beat.
 */
const LONG_PRESS_MS = 450;

/**
 * Movement that abandons the hold. Fingers are never still, so a zero budget
 * would make the gesture unreachable; 6px is under the swipe recognizer's own
 * activation distance, so the two never both claim one drag.
 */
const LONG_PRESS_SLOP_PX = 6;

interface LongPressTracking {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly timer: number;
}

export interface LongPress {
  readonly handlers: LongPressHandlers;
  /** Abandons a pending hold - the swipe recognizer calls this on activation. */
  readonly cancel: () => void;
  /**
   * Whether the press already fired for the gesture now ending. The row reads
   * it in its click handler: the browser still delivers a click after a long
   * press, and letting it through would open the task the press just selected.
   *
   * ONE-SHOT - it clears the flag as it reports it, so exactly one click is
   * swallowed per press. Reporting without clearing would leave the flag armed
   * until the next `pointerdown`, and a KEYBOARD activation delivers a click
   * with no pointerdown before it: on a focusable trigger, the Enter that
   * follows a long press would be eaten too, with nothing to re-arm from.
   * Every caller reads it once per click, which is what makes clearing safe.
   */
  readonly consumedTap: () => boolean;
}

export interface LongPressHandlers {
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
}

export interface LongPressArgs {
  readonly onLongPress: () => void;
  readonly disabled: boolean;
}

/**
 * Press-and-hold on a touch pointer.
 *
 * Touch only, because a mouse already has a right-click and a long left-click
 * there is an interrupted drag rather than an intent. The iOS copy/look-up
 * callout that a hold over chrome would otherwise raise is suppressed by the
 * row's `pointer-coarse:touch-chrome`, not here - it is a styling policy the
 * whole app shares, and a recognizer that reached for `preventDefault` instead
 * would also kill the tap it is trying to coexist with.
 */
export function useLongPress(args: LongPressArgs): LongPress {
  const { onLongPress, disabled } = args;
  const trackingRef = useRef<LongPressTracking | null>(null);
  const firedRef = useRef(false);
  // Read at fire time so a re-render between press and timeout cannot fire a
  // stale callback.
  const onLongPressRef = useRef(onLongPress);
  useEffect(() => {
    onLongPressRef.current = onLongPress;
  });

  const cancel = useCallback(() => {
    const tracking = trackingRef.current;
    if (tracking === null) return;
    window.clearTimeout(tracking.timer);
    trackingRef.current = null;
  }, []);

  // An unmount mid-hold (the list re-querying, the row filtered away) would
  // otherwise leave a timer that fires into a dead component.
  useEffect(() => cancel, [cancel]);

  useEffect(() => {
    if (!disabled) return;
    cancel();
  }, [cancel, disabled]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      cancel();
      firedRef.current = false;
      if (disabled) return;
      if (event.pointerType !== "touch") return;
      if (!event.isPrimary) return;
      const pointerId = event.pointerId;
      const timer = window.setTimeout(() => {
        trackingRef.current = null;
        firedRef.current = true;
        onLongPressRef.current();
      }, LONG_PRESS_MS);
      trackingRef.current = {
        pointerId,
        x: event.clientX,
        y: event.clientY,
        timer,
      };
    },
    [cancel, disabled],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const tracking = trackingRef.current;
      if (tracking === null) return;
      if (event.pointerId !== tracking.pointerId) return;
      const dx = event.clientX - tracking.x;
      const dy = event.clientY - tracking.y;
      if (
        Math.abs(dx) <= LONG_PRESS_SLOP_PX &&
        Math.abs(dy) <= LONG_PRESS_SLOP_PX
      ) {
        return;
      }
      cancel();
    },
    [cancel],
  );

  const consumedTap = useCallback(() => {
    const fired = firedRef.current;
    firedRef.current = false;
    return fired;
  }, []);

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: cancel,
      onPointerCancel: cancel,
    },
    cancel,
    consumedTap,
  };
}
