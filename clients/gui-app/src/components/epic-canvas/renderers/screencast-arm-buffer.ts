export const SCREENCAST_ARM_BUFFER_CLICK_SLOP_PX = 4;

export interface ScreencastArmGestureDown<T> {
  readonly payload: T;
  /**
   * The surface the buffered press was aimed at, as one comparable number:
   * the painted frame's sequence on the JPEG plane, the host's viewport epoch
   * on the video plane. The buffer never interprets it - it only replays a
   * gesture whose surface is still the one on screen when the arm lands.
   */
  readonly correlationToken: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly isPrimary: boolean;
}

export interface ScreencastArmGestureUp<T> {
  readonly payload: T;
  readonly isPrimary: boolean;
  readonly clientX: number;
  readonly clientY: number;
}

export interface ScreencastArmGesture<T> {
  readonly down: T;
  readonly up: T;
}

export interface ScreencastArmBuffer<T> {
  readonly storeDown: (down: ScreencastArmGestureDown<T>) => void;
  readonly storeMatchingUp: (up: ScreencastArmGestureUp<T>) => void;
  readonly noteMove: (clientX: number, clientY: number) => void;
  readonly takeIfCurrent: (
    currentToken: number | null,
  ) => ScreencastArmGesture<T> | null;
  readonly drop: () => void;
  readonly hasPending: () => boolean;
}

interface PendingArmGesture<T> {
  readonly down: ScreencastArmGestureDown<T>;
  up: T | null;
  readonly timeoutId: number;
}

/**
 * `readTimeoutMs` is read when a press is stored, not captured once: the
 * timeout is derived from the measured control-plane RTT (ticket 18), which
 * arrives after the buffer is built and refines while the tile lives.
 */
export function createScreencastArmBuffer<T>(
  onDropped: () => void,
  readTimeoutMs: () => number,
): ScreencastArmBuffer<T> {
  let pending: PendingArmGesture<T> | null = null;

  const clearPending = (): void => {
    if (pending === null) return;
    window.clearTimeout(pending.timeoutId);
    pending = null;
  };

  const drop = (): void => {
    if (pending === null) return;
    clearPending();
    onDropped();
  };

  return {
    storeDown: (down) => {
      if (pending !== null || !down.isPrimary) return;
      pending = {
        down,
        up: null,
        timeoutId: window.setTimeout(drop, readTimeoutMs()),
      };
    },
    storeMatchingUp: (up) => {
      if (pending === null) return;
      if (
        !up.isPrimary ||
        !isWithinClickSlop(
          pending.down.clientX,
          pending.down.clientY,
          up.clientX,
          up.clientY,
        )
      ) {
        drop();
        return;
      }
      pending.up = up.payload;
    },
    noteMove: (clientX, clientY) => {
      if (pending === null) return;
      if (
        isWithinClickSlop(
          pending.down.clientX,
          pending.down.clientY,
          clientX,
          clientY,
        )
      ) {
        return;
      }
      drop();
    },
    takeIfCurrent: (currentToken) => {
      if (pending === null) return null;
      const gesture = pending;
      if (
        currentToken !== gesture.down.correlationToken ||
        gesture.up === null
      ) {
        drop();
        return null;
      }
      clearPending();
      return { down: gesture.down.payload, up: gesture.up };
    },
    drop,
    hasPending: () => pending !== null,
  };
}

function isWithinClickSlop(
  originX: number,
  originY: number,
  x: number,
  y: number,
): boolean {
  return (
    Math.abs(x - originX) <= SCREENCAST_ARM_BUFFER_CLICK_SLOP_PX &&
    Math.abs(y - originY) <= SCREENCAST_ARM_BUFFER_CLICK_SLOP_PX
  );
}
