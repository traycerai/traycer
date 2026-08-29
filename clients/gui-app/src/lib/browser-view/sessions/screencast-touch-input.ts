/**
 * Pure touch-drag-to-scroll math for the mobile screencast viewer
 * (`browser-peek-tile-mobile.tsx`). Kept separate from
 * `screencast-input-encoding.ts` because it answers a different question:
 * that module turns one DOM event into one protocol frame, this one turns
 * two successive touch points into a wheel delta - the "the screencast page
 * scrolls, the viewer does not" mapping decision #13 calls for.
 *
 * Inverted like native touch scrolling: dragging a finger UP moves the
 * content UP under it, which reads as scrolling DOWN, so `deltaY` is
 * `previous.clientY - next.clientY` (positive when the finger moves up).
 */
export interface TouchScreenPoint {
  readonly clientX: number;
  readonly clientY: number;
}

export interface WheelDelta {
  readonly deltaX: number;
  readonly deltaY: number;
}

export function touchMoveToWheelDelta(
  previous: TouchScreenPoint,
  next: TouchScreenPoint,
): WheelDelta {
  return {
    deltaX: previous.clientX - next.clientX,
    deltaY: previous.clientY - next.clientY,
  };
}
