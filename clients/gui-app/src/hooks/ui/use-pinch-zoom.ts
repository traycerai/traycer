import { useEffect, useRef, type RefObject } from "react";

/** Where the two fingers meet, in viewport (client) coordinates. */
export interface PinchFocal {
  readonly clientX: number;
  readonly clientY: number;
}

export interface PinchZoomUpdate {
  /**
   * Distance between the fingers now, over the distance when the pinch
   * began. Applied to the scale the surface had at `onPinchStart`, the zoom
   * tracks the fingers one to one - the same feel as the image viewers,
   * whose library maps finger distance to scale the same way.
   */
  readonly ratio: number;
  readonly focal: PinchFocal;
  /**
   * How far the midpoint travelled since the previous update, in CSS px. A
   * scrolling surface honours it as a scroll, so two fingers drag the
   * document the way one finger does.
   */
  readonly focalDeltaX: number;
  readonly focalDeltaY: number;
}

export interface PinchZoomCallbacks {
  readonly onPinchStart: (focal: PinchFocal) => void;
  readonly onPinchMove: (update: PinchZoomUpdate) => void;
  readonly onPinchEnd: () => void;
}

interface TouchPoint {
  readonly clientX: number;
  readonly clientY: number;
}

export interface PinchGeometry {
  readonly distance: number;
  readonly focal: PinchFocal;
}

export function pinchGeometry(
  first: TouchPoint,
  second: TouchPoint,
): PinchGeometry {
  return {
    distance: Math.hypot(
      second.clientX - first.clientX,
      second.clientY - first.clientY,
    ),
    focal: {
      clientX: (first.clientX + second.clientX) / 2,
      clientY: (first.clientY + second.clientY) / 2,
    },
  };
}

/** Two fingers that land on the same spot would divide by zero; treat them as a pixel apart. */
const MIN_START_DISTANCE_PX = 1;

interface ActivePinch {
  readonly startDistance: number;
  lastFocal: PinchFocal;
}

function geometryOf(touches: TouchList): PinchGeometry | null {
  const first = touches.item(0);
  const second = touches.item(1);
  if (touches.length !== 2 || first === null || second === null) return null;
  return pinchGeometry(first, second);
}

/**
 * Two-finger pinch on a scrolling surface - the document viewers, whose
 * content reflows with the zoom and so cannot sit inside a transform stage
 * the way an image does.
 *
 * Touch events rather than pointer events, on purpose: the surface keeps its
 * native one-finger scroll, and a browser that has decided a touch sequence
 * is a scroll cancels its pointer events, which would end the pinch the
 * moment it started. Cancelling the two-finger `touchmove` instead keeps the
 * browser out of the gesture, and a one-finger scroll already under way
 * simply carries on underneath the zoom (its moves are uncancelable). Page
 * zoom is off in every shell that runs this app, so nothing else claims the
 * gesture.
 *
 * `null` callbacks leave the surface untouched.
 */
export function usePinchZoom(
  targetRef: RefObject<HTMLElement | null>,
  callbacks: PinchZoomCallbacks | null,
): void {
  const callbacksRef = useRef(callbacks);
  useEffect(() => {
    callbacksRef.current = callbacks;
  });
  const enabled = callbacks !== null;

  useEffect(() => {
    const target = targetRef.current;
    if (target === null || !enabled) return;
    let active: ActivePinch | null = null;

    const begin = (geometry: PinchGeometry): ActivePinch => {
      const pinch: ActivePinch = {
        startDistance: Math.max(geometry.distance, MIN_START_DISTANCE_PX),
        lastFocal: geometry.focal,
      };
      active = pinch;
      callbacksRef.current?.onPinchStart(geometry.focal);
      return pinch;
    };
    const end = (): void => {
      if (active === null) return;
      active = null;
      callbacksRef.current?.onPinchEnd();
    };

    const handleTouchStart = (event: TouchEvent): void => {
      const geometry = geometryOf(event.touches);
      // A third finger ends the pinch rather than picking two of the three.
      if (geometry === null) {
        end();
        return;
      }
      begin(geometry);
    };
    const handleTouchMove = (event: TouchEvent): void => {
      const geometry = geometryOf(event.touches);
      if (geometry === null) return;
      const pinch = active ?? begin(geometry);
      if (event.cancelable) event.preventDefault();
      callbacksRef.current?.onPinchMove({
        ratio: geometry.distance / pinch.startDistance,
        focal: geometry.focal,
        focalDeltaX: geometry.focal.clientX - pinch.lastFocal.clientX,
        focalDeltaY: geometry.focal.clientY - pinch.lastFocal.clientY,
      });
      pinch.lastFocal = geometry.focal;
    };
    const handleTouchEnd = (event: TouchEvent): void => {
      if (event.touches.length < 2) end();
    };

    target.addEventListener("touchstart", handleTouchStart, { passive: true });
    target.addEventListener("touchmove", handleTouchMove, { passive: false });
    target.addEventListener("touchend", handleTouchEnd, { passive: true });
    target.addEventListener("touchcancel", handleTouchEnd, { passive: true });
    return () => {
      target.removeEventListener("touchstart", handleTouchStart);
      target.removeEventListener("touchmove", handleTouchMove);
      target.removeEventListener("touchend", handleTouchEnd);
      target.removeEventListener("touchcancel", handleTouchEnd);
    };
  }, [targetRef, enabled]);
}
