import { useEffect, useRef } from "react";
import {
  classifyDirectionalIntent,
  ownsHorizontalGesture,
  withinTextEntry,
} from "@/components/layout/shell/shell-gestures";
import { isMobileApp } from "@/lib/mobile-app";
import { readSafeAreaInsets } from "@/lib/safe-area-insets";

/**
 * Width of the strip at each screen edge that answers a navigation swipe.
 *
 * The only absolute measurement here, and it is absolute because the thing it
 * describes is: a fingertip is the same size on a 4.7" phone as on a tablet, so
 * a zone expressed as a fraction of the viewport would be an unhittable sliver
 * on one and a wide dead band on the other.
 *
 * The strip is carved out of whichever surface is underneath - a chat timeline,
 * the canvas, a terminal - so every pixel of it is a pixel those surfaces lose.
 * Wide enough for a thumb reaching across the screen, narrow enough that
 * content is not routinely touched here. The epic row's swipe tray reserves a
 * strip of the same width for the same reason, and yields it to this.
 */
const EDGE_ZONE_PX = 32;

export type EdgeNavDirection = "back" | "forward";

export interface EdgeNavSwipeHandlers {
  /**
   * Called once, on the move that declares the drag a navigation swipe. The
   * caller performs the navigation; nothing about the gesture survives past
   * this call.
   */
  readonly onNavigate: (direction: EdgeNavDirection) => void;
  /**
   * Whether something on screen already owns the screen edges - the navigation
   * drawer while it is out, a modal layer, a surface blocking the app by its
   * own means. Asked at pointer-down AND on every move the gesture has not yet
   * committed to, so a surface that appears mid-contact takes the edges with it
   * rather than inheriting a swipe aimed at the screen it replaced.
   */
  readonly edgesClaimed: () => boolean;
}

interface EdgeNavSwipeTracking {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly at: number;
  readonly direction: EdgeNavDirection;
}

/**
 * The platform's navigation swipes: a drag inward from the leading edge goes
 * BACK, a drag inward from the trailing edge goes FORWARD. Both are
 * accelerators for navigation the app offers elsewhere, which is what lets them
 * be invisible - a gesture with no affordance may never be the only way to
 * reach something.
 *
 * Each edge answers ONE direction, the one that travels inward from it, and the
 * classifier's counter-direction arm enforces it: a leftward drag that starts
 * at the leading edge is a swipe away from the screen, not a back that changed
 * its mind. That is what keeps the two zones from ever both claiming a gesture,
 * and it matches every system where the same strip does not answer both ways.
 *
 * The zones are measured from the app surface rather than from raw viewport
 * coordinates. In landscape the sensor housing's inset can be wider than a zone
 * itself, which would leave the whole strip inside the cutout with no touch
 * able to reach it - so the inset moves where a zone starts without changing
 * how wide it is. Bounded on both sides for that reason: one bound alone would
 * stretch the strip back over the cutout it was moved out of.
 *
 * A pointer passes through two states. It is unclaimed until the motion
 * declares an axis (`classifyDirectionalIntent`), which is what lets a vertical
 * scroll that starts in a zone stay a scroll and a tap near the edge stay a
 * tap. Once it activates the classifier is never consulted again - the gesture
 * is over at that instant, since navigation is a discrete step rather than
 * something the finger drags.
 *
 * Two surfaces are refused outright, both because the finger is already inside
 * a gesture of their own: anything that pans sideways
 * (`ownsHorizontalGesture` - a tab rail, a code block, the attachment strip),
 * and any text entry (`withinTextEntry`), where a horizontal drag is the caret
 * being dragged through the text. The composer spans the full width, so its own
 * left edge sits in the leading zone; without that second check every attempt
 * to select a word at the start of a line would navigate away from the draft.
 *
 * Listens in the CAPTURE phase at the document, so a surface that stops
 * propagation for its own handling cannot silently disable navigation.
 *
 * TWO EVENT FAMILIES, for two different jobs. The pointer listeners recognize
 * the gesture and are passive - they never cancel anything. The touch listeners
 * do not recognize anything at all; their only job is to RESERVE the gesture
 * from the browser's own scrolling, which on a real touch screen is a race the
 * pointer stream loses. A web view arbitrates every touch against its scroll
 * view first: unless something says otherwise before the drag gets going, it
 * may claim the drag as a pan and cancel the pointer sequence, and by then no
 * amount of recognizer quality matters because the events have stopped
 * arriving. This is invisible under a mouse - a simulator's synthesized touches
 * drive no such arbitration - which is exactly how a gesture ships working and
 * arrives dead on a phone.
 *
 * Every other horizontal gesture in this app reserves its axis in CSS
 * (`touch-pan-y` on the swipeable row, on the drawer panel), which is the right
 * answer when the gesture belongs to an ELEMENT. These strips belong to no
 * element - they are coordinates over whatever surface happens to be underneath
 * - and a real element spanning each edge would swallow every tap in a 32px
 * column, the header's own menu button among them. So the reservation is made
 * per gesture instead, and only for touches that start where this recognizer
 * listens.
 *
 * @see reserveEdgeGesture for the timing rules that make it work.
 */
export function useEdgeNavSwipe(handlers: EdgeNavSwipeHandlers): void {
  // Read at event time, never closed over: the listeners are installed once and
  // must not be torn down and rebuilt every time the shell re-renders.
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    // PRODUCT gate, not a layout one: a narrow desktop browser renders the
    // mobile shell, and an edge drag there is a trackpad user's horizontal
    // scroll rather than a navigation swipe. It also has the header's
    // back/forward arrows, which this gesture is the phone's stand-in for.
    if (!isMobileApp()) return;
    let tracking: EdgeNavSwipeTracking | null = null;

    const handlePointerDown = (event: PointerEvent): void => {
      // A second pointer means a pinch or a two-finger pan; neither is a
      // navigation swipe, and the tracked pointer's coordinates stop describing
      // the gesture as a whole.
      if (tracking !== null) {
        tracking = null;
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
      };
    };

    const handlePointerMove = (event: PointerEvent): void => {
      const started = tracking;
      if (started === null) return;
      if (event.pointerId !== started.pointerId) return;
      // Asked again on every undecided move, not only at pointer-down. A
      // blocking surface can arrive DURING the contact - a migration frame
      // lands, a dialog opens on a keystroke elsewhere - and the finger that
      // was travelling over an ordinary screen is now travelling over a
      // surface the user has to address. Nothing about when a claimant
      // registers can cover that; only re-asking can. The gesture is dropped
      // rather than held, because a claim that appears mid-contact does not
      // retract when the layer closes: the swipe that started under one screen
      // is not owed to the next one.
      if (handlersRef.current.edgesClaimed()) {
        tracking = null;
        return;
      }
      // Travel along the swipe's own inward direction, so one classifier reads
      // both edges and each is positive to itself.
      const travelPx =
        started.direction === "back"
          ? event.clientX - started.x
          : started.x - event.clientX;
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
      // One navigation per pointer. The rest of the drag is nothing: the step
      // has already happened, and a second one would take the user two
      // surfaces back for a single swipe.
      tracking = null;
      handlersRef.current.onNavigate(started.direction);
    };

    const endGesture = (event: PointerEvent): void => {
      if (tracking === null) return;
      if (event.pointerId !== tracking.pointerId) return;
      tracking = null;
    };

    const releaseReservation = reserveEdgeGesture(handlersRef);

    const options = { capture: true, passive: true };
    document.addEventListener("pointerdown", handlePointerDown, options);
    document.addEventListener("pointermove", handlePointerMove, options);
    document.addEventListener("pointerup", endGesture, options);
    document.addEventListener("pointercancel", endGesture, options);
    return () => {
      releaseReservation();
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

/**
 * Cross-axis travel that settles which way a touch is going. Deliberately far
 * below the recognizer's own 15px activation, because this decision has a
 * deadline the recognizer does not: a browser that has already begun scrolling
 * stops accepting the answer, so waiting for certainty is the same as never
 * answering.
 */
const AXIS_DECISION_PX = 3;

interface ReservedTouch {
  readonly x: number;
  readonly y: number;
  readonly direction: EdgeNavDirection;
  /** Null until the first move that clears `AXIS_DECISION_PX` on either axis. */
  ours: boolean | null;
}

/**
 * Holds the browser off a touch that begins in an edge zone, so the pointer
 * stream survives long enough for the recognizer to read it. Returns the
 * teardown.
 *
 * THE TIMING IS THE MECHANISM. A browser decides whether a touch may be
 * cancelled at the START of the sequence - if nothing could possibly cancel it,
 * the drag is handed to the scroller and the web content is told about it
 * afterwards, if at all. So `touchstart` is registered non-passively and
 * permanently: it is what keeps the sequence cancellable. It costs one call per
 * gesture and cancels nothing itself.
 *
 * The per-move listener is added only once a touch has qualified, and dropped
 * the moment it turns out not to be ours. That is what keeps this from taxing
 * scrolling: a document-level non-passive `touchmove` is the one listener that
 * genuinely hurts, because the browser must wait for it before moving the page
 * on every frame of every scroll in the app. Here it exists only between the
 * touch-down and the axis decision of a drag that started at a screen edge.
 *
 * The decision itself is one-shot and made as early as the coordinates allow.
 * Vertical or outward is answered by dropping the listener without ever
 * cancelling, so a scroll that begins in the strip scrolls - late by nothing,
 * because nothing was prevented. Inward-horizontal is answered by cancelling
 * this move and every move after it, which is what stops the page from taking
 * the drag. There is no path that decides late: once the page is scrolling, a
 * cancel is refused, and a recognizer that asks for one anyway is only
 * pretending to have reserved anything.
 */
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
      // Someone else's drag - a scroll, or a swipe heading off the screen. Let
      // go entirely rather than keep watching: re-deciding later is the one
      // thing that cannot work.
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
    // The same entrance test the recognizer applies, so the two never disagree
    // about whose gesture this is - reserving a touch the recognizer will not
    // answer would cancel a scroll for nothing.
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

  // Non-passive so the sequence stays cancellable; it never cancels anything
  // itself, and a touch that turns out not to be ours is released before the
  // page has moved.
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

/**
 * Which navigation an edge answers, or `null` for the screen between them.
 *
 * The leading edge is checked first so a viewport narrow enough for the two
 * zones to overlap resolves to one of them rather than to whichever comparison
 * ran last. Back wins that tie because it is the gesture with somewhere to go:
 * forward only exists after a back.
 */
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
