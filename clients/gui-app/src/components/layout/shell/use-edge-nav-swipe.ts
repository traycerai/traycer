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

/**
 * What activation leads to, answered by the owner of the gesture's effect.
 *
 * Three outcomes rather than a boolean, because "nothing will follow the
 * finger" splits into two answers with OPPOSITE remedies: `instant` means this
 * step cannot be animated but is still owed its navigation - the discrete step
 * this gesture has always performed - while `decline` means the gesture must
 * be consumed with NO navigation at all. Collapsing them into one `false`
 * is how a swipe landing during a committed settle once fired a second,
 * instant navigation under layers still showing the first.
 */
export type EdgeNavDragResponse = "follow" | "instant" | "decline";

export interface EdgeNavSwipeRelease {
  /** Inward travel when the pointer left, in px. */
  readonly travelPx: number;
  /** Speed along the inward axis at release, px per second, signed. */
  readonly velocityPxPerS: number;
  /**
   * The system ended the gesture rather than the user - a call arriving, the
   * notification shade, a palm on the glass. Nothing the pointer did on its way
   * out was a choice, so none of it may be read as one.
   */
  readonly cancelled: boolean;
}

export interface EdgeNavSwipeHandlers {
  /**
   * Called once, on the move that declares the drag a navigation swipe, and
   * answers what the rest of the pointer is spent on.
   *
   * `follow` keeps the pointer tracked to its release, and the drag becomes a
   * continuous gesture reported through `onDragMove` / `onDragEnd`. `instant`
   * says nothing can be shown travelling for this particular step, and the
   * swipe falls back to `onNavigate` - a discrete step taken at this instant,
   * which is the whole of what this gesture used to be. `decline` consumes
   * the gesture outright: no follow, no step, nothing - the answer for a
   * moment when a navigation is already in flight and a second one would
   * land under it.
   */
  readonly onDragStart: (direction: EdgeNavDirection) => EdgeNavDragResponse;
  /** Inward travel so far, on every move of a followed drag. */
  readonly onDragMove: (travelPx: number) => void;
  /** The release of a followed drag. Called exactly once per `follow` response. */
  readonly onDragEnd: (release: EdgeNavSwipeRelease) => void;
  /**
   * The discrete step, for a swipe nothing can follow. The caller performs the
   * navigation; nothing about the gesture survives past this call.
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
  /** False until the classifier activates and something takes the drag. */
  following: boolean;
  /** Inward travel at the last move, in px. */
  travelPx: number;
  /** Timestamp of that move, for the speed the release is judged on. */
  lastAt: number;
  velocityPxPerS: number;
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
 * tap. Once it activates the classifier is never consulted again: the direction
 * is locked, and a drag that curves downward afterwards is still this gesture's.
 *
 * What activation leads to is not fixed here. The navigation may be something
 * the finger CARRIES - a screen travelling with it, released at a threshold -
 * or a discrete step taken at the moment of activation, and which one it is
 * depends on whether the app can put a destination on screen for this
 * particular history entry. `onDragStart` answers that, so the recognizer
 * neither knows nor needs to know what is being moved; it only reports travel
 * and the release.
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

    /**
     * Drops the tracked pointer, telling whatever is following the drag that it
     * is over.
     *
     * TOTAL, by design: every path that stops tracking goes through here,
     * including the ones that are not releases. A drag that is being followed
     * has a surface travelling with it, and a path that merely forgot the
     * pointer would leave that surface stranded on screen with nothing left to
     * move it.
     */
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
      // A second pointer means a pinch or a two-finger pan; neither is a
      // navigation swipe, and the tracked pointer's coordinates stop describing
      // the gesture as a whole. A drag already under way did not choose to end
      // here, so it ends the way the system ending it would.
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
        // DIRECTION LOCK. Past activation the classifier is never consulted
        // again and neither is the edge claim: the drag belongs to this gesture
        // until the pointer leaves, and a surface arriving mid-flight cannot
        // take a screen out from under a finger that is already carrying it.
        //
        // Speed is measured over the LAST move rather than averaged over the
        // gesture, because a release is judged on what the hand was doing when
        // it let go - a long slow drag finished with a flick is a flick, and an
        // average would report it as the drag it mostly was.
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
      // Activation asks what kind of gesture this can be, and the answer
      // decides how the rest of the pointer is spent: followed to the release,
      // spent on a discrete step here and now, or consumed with nothing owed.
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
      // The ground covered reaching activation is the release's first speed
      // sample. Without it, a flick fast enough to activate on its only move
      // and release in place would be judged at zero velocity and spring back
      // - the quicker the flick, the more likely nothing updates this again.
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
      // The release is a sample too: a fast swipe covers real ground between
      // the last delivered move and the up, and judging the release on the
      // move's numbers alone can refuse a flick that crossed a threshold on
      // its way out. The two halves of the sample have different guards.
      // TRAVEL is taken whenever the up moved - even at a tied timestamp,
      // which precision-clamped event clocks produce for samples dispatched
      // together. VELOCITY additionally needs positive elapsed time: derived
      // over zero it is unbounded, and a release at the last move's position
      // carries no new motion to derive it from at all - either way the last
      // real sample stands.
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
      // A drag surviving the listeners' teardown has nothing left to move it,
      // so it is ended as the system ending it - the same answer a call
      // arriving mid-swipe gets.
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
