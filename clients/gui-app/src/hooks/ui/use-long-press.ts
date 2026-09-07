import {
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";

/** The platform context-menu tier rather than the shorter drag-arm one: this opens a mode, and a mode that appears while someone is still deciding whether to scroll is worse than one that takes a beat. */
const LONG_PRESS_MS = 450;

/** Fingers are never still, so a zero budget would make the gesture unreachable; 6px is under the swipe recognizer's own activation distance, so the two never both claim one drag. */
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
   * One-shot: report and clear so exactly one click is swallowed. Leaving the flag armed would eat a later keyboard activation, which has no pointerdown.
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
 * Touch only. Do not `preventDefault` to kill the iOS callout; that would also kill the tap. Callout suppression is the row's `pointer-coarse:touch-chrome`.
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
