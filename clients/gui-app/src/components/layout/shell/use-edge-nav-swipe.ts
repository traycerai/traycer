import { useEffect, useRef } from "react";
import {
  classifyDirectionalIntent,
  ownsHorizontalGesture,
  withinTextEntry,
} from "@/components/layout/shell/shell-gestures";
import { isMobileApp } from "@/lib/mobile-app";
import { readSafeAreaInsets } from "@/lib/safe-area-insets";

/** The only absolute measurement here, and it is absolute because the thing it describes is: a fingertip is the
 * same size on a 4.7" phone as on a tablet. */
const EDGE_ZONE_PX = 32;

export type EdgeNavDirection = "back" | "forward";

/** Three outcomes rather than a boolean, because "nothing will follow the finger" splits into two answers with
 * opposite remedies: `instant` means this step cannot be animated but is still owed its navigation. */
export type EdgeNavDragResponse = "follow" | "instant" | "decline";

export interface EdgeNavSwipeRelease {
  readonly travelPx: number;
  readonly velocityPxPerS: number;
  /** The system ended the gesture rather than the user - a call arriving, the notification shade, a palm on the
   * glass. */
  readonly cancelled: boolean;
}

export interface EdgeNavSwipeHandlers {
  /** `decline` consumes the gesture outright: no follow, no step, nothing - the answer for a moment when a
   * navigation is already in flight and a second one would land under it. */
  readonly onDragStart: (direction: EdgeNavDirection) => EdgeNavDragResponse;
  readonly onDragMove: (travelPx: number) => void;
  readonly onDragEnd: (release: EdgeNavSwipeRelease) => void;
  /** The discrete step, for a swipe nothing can follow. */
  readonly onNavigate: (direction: EdgeNavDirection) => void;
  /** Asked at pointer-down and on every move the gesture has not yet committed to, so a surface that appears
   * mid-contact takes the edges with it rather than inheriting a swipe aimed at the screen it replaced. */
  readonly edgesClaimed: () => boolean;
}

interface EdgeNavSwipeTracking {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly at: number;
  readonly direction: EdgeNavDirection;
  following: boolean;
  travelPx: number;
  lastAt: number;
  velocityPxPerS: number;
}

/** Listens in the capture phase at the document, so a surface that stops propagation for its own handling
 * cannot silently disable navigation. */
export function useEdgeNavSwipe(handlers: EdgeNavSwipeHandlers): void {
  // Read at event time, never closed over: the listeners are installed once and
  // must not be torn down and rebuilt every time the shell re-renders.
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    // Product gate, not a layout one: a narrow desktop browser renders the mobile shell, and an edge drag there is
    // a trackpad user's horizontal scroll rather than a navigation swipe.
    if (!isMobileApp()) return;
    let tracking: EdgeNavSwipeTracking | null = null;

    /** A drag that is being followed has a surface travelling with it, and a path that merely forgot the pointer
     * would leave that surface stranded on screen with nothing left to move it. */
    const stopTracking = (cancelled: boolean): void => {
      const started = tracking;
      tracking = null;
      if (started === null) return;
      if (!started.following) return;
      handlersRef.current.onDragEnd({
        travelPx: started.travelPx,
        velocityPxPerS: started.velocityPxPerS,
        cancelled,
      });
    };

    const handlePointerDown = (event: PointerEvent): void => {
      // A drag already under way did not choose to end here, so it ends the way the system ending it would.
      if (tracking !== null) {
        stopTracking(true);
        return;
      }
      if (!event.isPrimary) return;
      if (handlersRef.current.edgesClaimed()) return;
      const direction = edgeDirectionAt(event.clientX);
      if (direction === null) return;
      if (ownsHorizontalGesture(event.target)) return;
      if (withinTextEntry(event.target)) return;
      tracking = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        at: event.timeStamp,
        direction,
        following: false,
        travelPx: 0,
        lastAt: event.timeStamp,
        velocityPxPerS: 0,
      };
    };

    const handlePointerMove = (event: PointerEvent): void => {
      const started = tracking;
      if (started === null) return;
      if (event.pointerId !== started.pointerId) return;
      // Travel along the swipe's own inward direction, so one classifier reads
      // both edges and each is positive to itself.
      const travelPx =
        started.direction === "back"
          ? event.clientX - started.x
          : started.x - event.clientX;
      if (started.following) {
        // Past activation the classifier is never consulted again and neither is the edge claim.
        const elapsedMs = event.timeStamp - started.lastAt;
        if (elapsedMs > 0) {
          started.velocityPxPerS =
            ((travelPx - started.travelPx) / elapsedMs) * 1000;
        }
        started.travelPx = travelPx;
        started.lastAt = event.timeStamp;
        handlersRef.current.onDragMove(travelPx);
        return;
      }
      // The gesture is dropped rather than held, because a claim that appears mid-contact does not retract when the
      // layer closes: the swipe that started under one screen is not owed to the next one.
      if (handlersRef.current.edgesClaimed()) {
        tracking = null;
        return;
      }
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
      // Activation asks what kind of gesture this can be, and the answer decides how the rest of the pointer is
      // spent: followed to the release, spent on a discrete step here and now, or consumed with nothing owed.
      const response = handlersRef.current.onDragStart(started.direction);
      if (response !== "follow") {
        tracking = null;
        if (response === "instant") {
          handlersRef.current.onNavigate(started.direction);
        }
        return;
      }
      started.following = true;
      started.travelPx = travelPx;
      started.lastAt = event.timeStamp;
      // Without it, a flick fast enough to activate on its only move and release in place would be judged at zero
      // velocity and spring back - the quicker the flick, the more likely nothing updates this again.
      const elapsedMs = event.timeStamp - started.at;
      if (elapsedMs > 0) {
        started.velocityPxPerS = (travelPx / elapsedMs) * 1000;
      }
      handlersRef.current.onDragMove(travelPx);
    };

    const handlePointerUp = (event: PointerEvent): void => {
      const started = tracking;
      if (started === null) return;
      if (event.pointerId !== started.pointerId) return;
      // Travel is taken whenever the up moved - even at a tied timestamp, which precision-clamped event clocks
      // produce for samples dispatched together.
      if (started.following) {
        const travelPx =
          started.direction === "back"
            ? event.clientX - started.x
            : started.x - event.clientX;
        if (travelPx !== started.travelPx) {
          const elapsedMs = event.timeStamp - started.lastAt;
          if (elapsedMs > 0) {
            started.velocityPxPerS =
              ((travelPx - started.travelPx) / elapsedMs) * 1000;
          }
          started.travelPx = travelPx;
        }
      }
      stopTracking(false);
    };

    const handlePointerCancel = (event: PointerEvent): void => {
      if (tracking === null) return;
      if (event.pointerId !== tracking.pointerId) return;
      stopTracking(true);
    };

    const releaseReservation = reserveEdgeGesture(handlersRef);

    const options = { capture: true, passive: true };
    document.addEventListener("pointerdown", handlePointerDown, options);
    document.addEventListener("pointermove", handlePointerMove, options);
    document.addEventListener("pointerup", handlePointerUp, options);
    document.addEventListener("pointercancel", handlePointerCancel, options);
    return () => {
      releaseReservation();
      // A drag surviving the listeners' teardown has nothing left to move it, so it is ended as the system ending it
      // - the same answer a call arriving mid-swipe gets.
      stopTracking(true);
      document.removeEventListener("pointerdown", handlePointerDown, {
        capture: true,
      });
      document.removeEventListener("pointermove", handlePointerMove, {
        capture: true,
      });
      document.removeEventListener("pointerup", handlePointerUp, {
        capture: true,
      });
      document.removeEventListener("pointercancel", handlePointerCancel, {
        capture: true,
      });
    };
  }, []);
}

/** Deliberately far below the recognizer's own 15px activation, because this decision has a deadline the
 * recognizer does not. */
const AXIS_DECISION_PX = 3;

interface ReservedTouch {
  readonly x: number;
  readonly y: number;
  readonly direction: EdgeNavDirection;
  /** Null until the first move that clears `AXIS_DECISION_PX` on either axis. */
  ours: boolean | null;
}

/** That is what keeps this from taxing scrolling. */
function reserveEdgeGesture(handlersRef: {
  readonly current: EdgeNavSwipeHandlers;
}): () => void {
  let reserved: ReservedTouch | null = null;

  const handleTouchMove = (event: TouchEvent): void => {
    const active = reserved;
    if (active === null) return;
    const touch = event.touches.item(0);
    if (touch === null) return;
    if (active.ours === true) {
      event.preventDefault();
      return;
    }
    const dx = touch.clientX - active.x;
    const dy = touch.clientY - active.y;
    const inwardPx = active.direction === "back" ? dx : -dx;
    if (Math.abs(dx) < AXIS_DECISION_PX && Math.abs(dy) < AXIS_DECISION_PX) {
      return;
    }
    if (inwardPx <= Math.abs(dy)) {
      // Let go entirely rather than keep watching: re-deciding later is the one thing that cannot work.
      detachMove();
      reserved = null;
      return;
    }
    active.ours = true;
    event.preventDefault();
  };

  const attachMove = (): void => {
    document.addEventListener("touchmove", handleTouchMove, {
      capture: true,
      passive: false,
    });
  };

  const detachMove = (): void => {
    document.removeEventListener("touchmove", handleTouchMove, {
      capture: true,
    });
  };

  const handleTouchStart = (event: TouchEvent): void => {
    if (reserved !== null) {
      detachMove();
      reserved = null;
    }
    // A second finger is a pinch or a two-finger pan, and the page is welcome
    // to both.
    if (event.touches.length !== 1) return;
    const touch = event.touches.item(0);
    if (touch === null) return;
    // The same entrance test the recognizer applies, so the two never disagree about whose gesture this is -
    // reserving a touch the recognizer will not answer would cancel a scroll for nothing.
    if (handlersRef.current.edgesClaimed()) return;
    const direction = edgeDirectionAt(touch.clientX);
    if (direction === null) return;
    if (ownsHorizontalGesture(event.target)) return;
    if (withinTextEntry(event.target)) return;
    reserved = {
      x: touch.clientX,
      y: touch.clientY,
      direction,
      ours: null,
    };
    attachMove();
  };

  const handleTouchEnd = (): void => {
    if (reserved === null) return;
    detachMove();
    reserved = null;
  };

  // Non-passive so the sequence stays cancellable; it never cancels anything itself, and a touch that turns out
  // not to be ours is released before the page has moved.
  document.addEventListener("touchstart", handleTouchStart, {
    capture: true,
    passive: false,
  });
  const endOptions = { capture: true, passive: true };
  document.addEventListener("touchend", handleTouchEnd, endOptions);
  document.addEventListener("touchcancel", handleTouchEnd, endOptions);
  return () => {
    detachMove();
    reserved = null;
    document.removeEventListener("touchstart", handleTouchStart, {
      capture: true,
    });
    document.removeEventListener("touchend", handleTouchEnd, {
      capture: true,
    });
    document.removeEventListener("touchcancel", handleTouchEnd, {
      capture: true,
    });
  };
}

/** Back wins that tie because it is the gesture with somewhere to go: forward only exists after a back. */
function edgeDirectionAt(clientX: number): EdgeNavDirection | null {
  const insets = readSafeAreaInsets();
  const surfaceLeft = insets.left;
  if (clientX >= surfaceLeft && clientX <= surfaceLeft + EDGE_ZONE_PX) {
    return "back";
  }
  const surfaceRight = window.innerWidth - insets.right;
  if (clientX <= surfaceRight && clientX >= surfaceRight - EDGE_ZONE_PX) {
    return "forward";
  }
  return null;
}
