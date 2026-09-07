import { useEffect, useRef } from "react";
import {
  classifyDirectionalIntent,
  ownsHorizontalGesture,
} from "@/components/layout/shell/shell-gestures";
import { isMobileApp } from "@/lib/mobile-app";

export interface NavDrawerClosePullHandlers {
  /** The caller hands the event straight to the drag engine and owns everything after this point; the recognizer
   * forgets the gesture. */
  readonly onActivate: (event: PointerEvent, travelPx: number) => void;
  readonly withinPanel: (target: EventTarget | null) => boolean;
}

interface NavDrawerClosePullTracking {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly at: number;
}

/** Passive throughout: it never calls `preventDefault`, and a non-passive document-level listener would tax
 * every scroll in the app for a gesture that fires rarely. */
export function useNavDrawerClosePull(
  handlers: NavDrawerClosePullHandlers,
): void {
  // Read at event time, never closed over: the listeners are installed once and
  // must not be torn down and rebuilt every time the surface re-renders.
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    // Product gate, not a layout one: a narrow desktop browser renders the mobile shell, and a drag across the
    // panel there is a trackpad user's horizontal scroll rather than a drawer pull.
    if (!isMobileApp()) return;
    let tracking: NavDrawerClosePullTracking | null = null;

    const handlePointerDown = (event: PointerEvent): void => {
      // A second pointer means a pinch or a two-finger pan; neither is a drawer pull, and the tracked pointer's
      // coordinates stop describing the gesture as a whole.
      if (tracking !== null) {
        tracking = null;
        return;
      }
      if (!event.isPrimary) return;
      // Landing ON the panel is what makes this a close pull, whatever the drawer's semantic state says: the panel
      // is `inert` whenever it is parked shut, so a pointer can only reach it while it is on screen.
      if (!handlersRef.current.withinPanel(event.target)) return;
      if (ownsHorizontalGesture(event.target)) return;
      tracking = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        at: event.timeStamp,
      };
    };

    const handlePointerMove = (event: PointerEvent): void => {
      const started = tracking;
      if (started === null) return;
      if (event.pointerId !== started.pointerId) return;
      // Positive along the pull's own direction, which is leftward, so the classifier's thresholds read the same way
      // here as in every other recognizer that shares them.
      const travelPx = started.x - event.clientX;
      const intent = classifyDirectionalIntent({
        primaryPx: travelPx,
        crossPx: event.clientY - started.y,
        elapsedMs: event.timeStamp - started.at,
      });
      if (intent === "fail") {
        tracking = null;
        return;
      }
      if (intent === "wait") return;
      // One activation per pointer: the rest of this gesture belongs to the
      // panel, which tracks the finger and decides for itself at release.
      tracking = null;
      handlersRef.current.onActivate(event, travelPx);
    };

    const endGesture = (event: PointerEvent): void => {
      if (tracking === null) return;
      if (event.pointerId !== tracking.pointerId) return;
      tracking = null;
    };

    const options = { capture: true, passive: true };
    document.addEventListener("pointerdown", handlePointerDown, options);
    document.addEventListener("pointermove", handlePointerMove, options);
    document.addEventListener("pointerup", endGesture, options);
    document.addEventListener("pointercancel", endGesture, options);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, {
        capture: true,
      });
      document.removeEventListener("pointermove", handlePointerMove, {
        capture: true,
      });
      document.removeEventListener("pointerup", endGesture, { capture: true });
      document.removeEventListener("pointercancel", endGesture, {
        capture: true,
      });
    };
  }, []);
}
