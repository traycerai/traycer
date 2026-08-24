import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

/** Press duration that separates a tap from a deliberate hold. */
const LONG_PRESS_MS = 450;

/**
 * Movement past this many pixels means the finger was starting a scroll, not
 * holding still.
 */
const LONG_PRESS_SLOP_PX = 10;

export interface LongPressHandlers {
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerUp: () => void;
  readonly onPointerCancel: () => void;
}

export interface LongPress {
  readonly handlers: LongPressHandlers;
  /**
   * Whether the press that produced the click in flight had already fired.
   * Reading it clears the flag, so one long press suppresses exactly one
   * click and the next tap starts clean.
   */
  readonly consumeFired: () => boolean;
}

/**
 * Long-press recognizer for an element whose tap already means something
 * else.
 *
 * Cancels on movement and on release before the threshold, and reports
 * whether it fired so the element's click handler can stand down - otherwise
 * the press would trigger both actions at once.
 */
export function useLongPress(onLongPress: () => void): LongPress {
  const timerRef = useRef<number | null>(null);
  const originRef = useRef<{ x: number; y: number } | null>(null);
  const firedRef = useRef(false);

  const clear = useCallback((): void => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    originRef.current = null;
  }, []);

  // A press in flight when the element unmounts must not fire into a handler
  // whose owner is gone.
  useEffect(() => clear, [clear]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      firedRef.current = false;
      originRef.current = { x: event.clientX, y: event.clientY };
      timerRef.current = window.setTimeout(() => {
        firedRef.current = true;
        timerRef.current = null;
        onLongPress();
      }, LONG_PRESS_MS);
    },
    [onLongPress],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      const origin = originRef.current;
      if (origin === null) return;
      const moved =
        Math.abs(event.clientX - origin.x) > LONG_PRESS_SLOP_PX ||
        Math.abs(event.clientY - origin.y) > LONG_PRESS_SLOP_PX;
      if (moved) clear();
    },
    [clear],
  );

  const consumeFired = useCallback((): boolean => {
    const fired = firedRef.current;
    firedRef.current = false;
    return fired;
  }, []);

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: clear,
      onPointerCancel: clear,
    },
    consumeFired,
  };
}
