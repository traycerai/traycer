import { useEffect, useRef } from "react";
import {
  classifyDirectionalIntent,
  ownsHorizontalGesture,
} from "@/components/layout/shell/shell-gestures";
import { isMobileApp } from "@/lib/mobile-app";

export interface NavDrawerClosePullHandlers {
  /**
   * Called once, on the move that declares the drag ours: the pointer event
   * that declared it, and the leftward travel it has covered. The caller hands
   * the event straight to the drag engine and owns everything after this point;
   * the recognizer forgets the gesture.
   */
  readonly onActivate: (event: PointerEvent, travelPx: number) => void;
  /** Whether the pointer landed on the drawer panel itself. */
  readonly withinPanel: (target: EventTarget | null) => boolean;
}

interface NavDrawerClosePullTracking {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly at: number;
}

/**
 * Recognizer for the leftward pull on the drawer panel that pushes it back off
 * screen. Opening is the header's hamburger alone, so this is an accelerator on
 * a surface the user is already looking at, not the only way to reach anything.
 *
 * The panel is a scrolling surface, which is what makes a classifier necessary
 * here rather than a raw travel threshold: the finger is usually asking to
 * scroll, and a horizontal drag engine that claims on distance alone takes a
 * share of those. Any second answer to that question - a drag engine's own axis
 * lock, say - is a second set of thresholds deciding the same thing, and the
 * two disagree exactly where it shows: on the near-vertical drags a hand makes
 * by the hundred.
 *
 * This recognizer decides ONE thing - whether a pointer is a close pull - and
 * then gets out of the way. It does not decide whether the drawer ends up
 * closed; that is the release's job, and by then the panel has been tracking
 * the finger long enough for the user to have watched the answer coming and
 * changed their mind.
 *
 * The pointer passes through two states. It is unclaimed until the motion
 * declares an axis (`classifyDirectionalIntent`), which is what lets a vertical
 * scroll that starts on the panel stay a scroll. Once it activates the
 * classifier is never consulted again: a committed horizontal drag that later
 * curves downward is still the drawer's, and re-classifying per move is how a
 * recognizer cancels itself mid-gesture.
 *
 * Only pointers landing on the PANEL are tracked. The scrim claims its own the
 * instant they land and needs no classifier, and everything outside the
 * drawer's layer belongs to the surface underneath - so a pointer that is not
 * on the panel is not this recognizer's to arbitrate.
 *
 * Pointer events rather than touch events because the drag engine's gesture
 * stack is pointer-only and needs a real `PointerEvent` to adopt the gesture
 * from here. The classifier reads nothing but `clientX` / `clientY` /
 * `timeStamp`, all of which both event families carry.
 *
 * Listens in the CAPTURE phase at the document, so a surface that stops
 * propagation for its own handling cannot silently disable the pull. Passive
 * throughout: it never calls `preventDefault`, and a non-passive
 * document-level listener would tax every scroll in the app for a gesture that
 * fires rarely.
 */
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
    // PRODUCT gate, not a layout one: a narrow desktop browser renders the
    // mobile shell, and a drag across the panel there is a trackpad user's
    // horizontal scroll rather than a drawer pull.
    if (!isMobileApp()) return;
    let tracking: NavDrawerClosePullTracking | null = null;

    const handlePointerDown = (event: PointerEvent): void => {
      // A second pointer means a pinch or a two-finger pan; neither is a
      // drawer pull, and the tracked pointer's coordinates stop describing the
      // gesture as a whole.
      if (tracking !== null) {
        tracking = null;
        return;
      }
      if (!event.isPrimary) return;
      // Landing ON the panel is what makes this a close pull, whatever the
      // drawer's semantic state says: the panel is `inert` whenever it is
      // parked shut, so a pointer can only reach it while it is on screen -
      // settled open, or still travelling, which is what makes a settle
      // interruptible.
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
      // Positive along the pull's own direction, which is leftward, so the
      // classifier's thresholds read the same way here as in every other
      // recognizer that shares them.
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
