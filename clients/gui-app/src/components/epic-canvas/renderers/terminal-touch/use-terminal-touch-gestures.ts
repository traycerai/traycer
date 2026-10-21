import {
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

import { LONG_PRESS_MS, LONG_PRESS_SLOP_PX } from "@/hooks/ui/use-long-press";

import {
  terminalBufferCellAtPoint,
  terminalSelectionSpan,
  type TerminalBufferCell,
  type TerminalClientPoint,
  type TerminalTouchTarget,
} from "./terminal-touch-selection";

/**
 * Hold after which a still finger is read as choosing a spot to select from,
 * rather than beginning a scroll. A pan moves within its first frames; a
 * finger still this long has stopped on a cell, and the drag that follows
 * extends a selection from it - the brief hold a phone's own text views ask
 * for before drag-selecting. Shorter than the context-menu tier so a hold
 * that keeps going simply graduates to the menu.
 */
export const SELECT_HOLD_MS = 200;

/** Finger travel beyond this is a scroll gesture, not a tap-to-focus. */
const TOUCH_TAP_SLOP_PX = 10;

type GesturePhase =
  /** Finger down, nothing decided. */
  | "pending"
  /** Held still past the select tier: a drag from here selects. */
  | "select-armed"
  /** Dragging a selection; xterm's touch scroll is held off. */
  | "selecting"
  /** Moved before any tier: xterm's own recognizer is scrolling. */
  | "scrolling"
  /** Held past the context-menu tier: the release opens the menu. */
  | "long-pressed";

interface GestureTracking {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  phase: GesturePhase;
  holdTimer: number | null;
  longPressTimer: number | null;
  anchor: TerminalBufferCell | null;
  captured: Element | null;
}

export interface TerminalTouchGestureArgs {
  readonly termRef: RefObject<TerminalTouchTarget | null>;
  /** The element the handlers are attached to; the touch-scroll guard binds here. */
  readonly mountRef: RefObject<HTMLElement | null>;
  /** A plain tap: focus the terminal, drop any selection. */
  readonly onTap: () => void;
  /** A long press, reported on RELEASE at the point the finger went down. */
  readonly onLongPress: (point: TerminalClientPoint) => void;
}

export interface TerminalTouchGestureHandlers {
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
}

/**
 * The one owner of touch over the terminal grid. Three gestures, told apart by
 * how long the finger stays still before it moves or lifts:
 *
 * - a TAP (lift before the select tier) focuses the terminal, which is what
 *   summons the keyboard on a phone, and clears a selection the way tapping
 *   beside selected text does in any text view;
 * - a SHORT PRESS (still for the select tier, then drag) selects from the
 *   cell under the hold to the cell under the finger, through xterm's
 *   public `select`. The drag is kept from xterm's own touch recognizer
 *   (below) so it does not also scroll;
 * - a LONG PRESS (still for the context-menu tier) reports on release, so
 *   the menu never opens under a finger that is still down - a release over
 *   a freshly opened menu would pick whatever item it landed on.
 *
 * A finger that moves before any tier is a scroll and is left entirely to
 * xterm. Mouse and pen are not handled: a mouse has a right button and
 * xterm's own drag selection, and both reach it through the mouse events the
 * touch path lacks.
 *
 * Why the recognizer sits on pointer events while the guard sits on a touch
 * event: xterm cancels `touchstart` on its screen, which suppresses the
 * compatibility mouse events (so neither xterm's selection nor its focus
 * sees a finger) but leaves pointer events flowing. Its scrolling, though,
 * listens to `touchmove` on the DOCUMENT; stopping that event at the mount
 * while a selection drag is in flight is what keeps the drag from scrolling.
 * `touchend` is left alone: the recognizer's ledger of active touches must
 * see every finger lift or its inertia maths counts a phantom finger forever.
 */
export function useTerminalTouchGestures(
  args: TerminalTouchGestureArgs,
): TerminalTouchGestureHandlers {
  const { termRef, mountRef, onTap, onLongPress } = args;
  const trackingRef = useRef<GestureTracking | null>(null);
  // Read at fire time so a re-render between press and release cannot act on
  // a stale callback.
  const onTapRef = useRef(onTap);
  const onLongPressRef = useRef(onLongPress);
  useEffect(() => {
    onTapRef.current = onTap;
    onLongPressRef.current = onLongPress;
  });

  const clearTimers = useCallback((tracking: GestureTracking): void => {
    if (tracking.holdTimer !== null) {
      window.clearTimeout(tracking.holdTimer);
      tracking.holdTimer = null;
    }
    if (tracking.longPressTimer !== null) {
      window.clearTimeout(tracking.longPressTimer);
      tracking.longPressTimer = null;
    }
  }, []);

  const releaseCapture = useCallback((tracking: GestureTracking): void => {
    const captured = tracking.captured;
    tracking.captured = null;
    if (captured === null) return;
    try {
      captured.releasePointerCapture(tracking.pointerId);
    } catch {
      // The pointer is already gone; nothing is held.
    }
  }, []);

  const abandon = useCallback((): void => {
    const tracking = trackingRef.current;
    if (tracking === null) return;
    clearTimers(tracking);
    releaseCapture(tracking);
    trackingRef.current = null;
  }, [clearTimers, releaseCapture]);

  // An unmount mid-hold would otherwise leave a timer firing into a dead
  // component.
  useEffect(() => abandon, [abandon]);

  useEffect(() => {
    const mount = mountRef.current;
    if (mount === null) return;
    const holdOffTouchScroll = (event: TouchEvent): void => {
      if (trackingRef.current?.phase !== "selecting") return;
      event.preventDefault();
      event.stopPropagation();
    };
    // Non-passive, because the guard cancels the event: the page must not pan
    // under a selection drag either.
    mount.addEventListener("touchmove", holdOffTouchScroll, { passive: false });
    return () => mount.removeEventListener("touchmove", holdOffTouchScroll);
  }, [mountRef]);

  const extendSelection = useCallback(
    (tracking: GestureTracking, point: TerminalClientPoint): void => {
      const term = termRef.current;
      const anchor = tracking.anchor;
      if (term === null || anchor === null) return;
      const head = terminalBufferCellAtPoint(term, point);
      if (head === null) return;
      const span = terminalSelectionSpan(anchor, head, term.cols);
      term.select(span.column, span.row, span.length);
    },
    [termRef],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      // A second finger, a pen or a mouse is not this gesture's business and
      // must not abort a selection drag the first finger is still making.
      if (event.pointerType !== "touch") return;
      if (!event.isPrimary) return;
      abandon();
      const tracking: GestureTracking = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        phase: "pending",
        holdTimer: null,
        longPressTimer: null,
        anchor: null,
        captured: null,
      };
      const start = { x: event.clientX, y: event.clientY };
      tracking.holdTimer = window.setTimeout(() => {
        tracking.holdTimer = null;
        if (tracking.phase !== "pending") return;
        const term = termRef.current;
        // The anchor is fixed at the hold, not at the first move: the cell
        // the finger settled on is the one the user chose.
        tracking.anchor =
          term === null ? null : terminalBufferCellAtPoint(term, start);
        tracking.phase = "select-armed";
      }, SELECT_HOLD_MS);
      tracking.longPressTimer = window.setTimeout(() => {
        tracking.longPressTimer = null;
        if (tracking.phase !== "pending" && tracking.phase !== "select-armed") {
          return;
        }
        tracking.phase = "long-pressed";
      }, LONG_PRESS_MS);
      trackingRef.current = tracking;
    },
    [abandon, termRef],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      const tracking = trackingRef.current;
      if (tracking === null) return;
      if (event.pointerId !== tracking.pointerId) return;
      const moved =
        Math.abs(event.clientX - tracking.startX) > LONG_PRESS_SLOP_PX ||
        Math.abs(event.clientY - tracking.startY) > LONG_PRESS_SLOP_PX;
      switch (tracking.phase) {
        case "pending":
          if (!moved) return;
          clearTimers(tracking);
          tracking.phase = "scrolling";
          return;
        case "select-armed": {
          if (!moved) return;
          clearTimers(tracking);
          tracking.phase = "selecting";
          // Keep the drag's events coming to this element after the finger
          // leaves it: selecting to the end of the output means dragging past
          // the pane's edge.
          const target = event.currentTarget;
          try {
            target.setPointerCapture(tracking.pointerId);
            tracking.captured = target;
          } catch {
            // The pointer is no longer active; the release is on its way.
          }
          extendSelection(tracking, { x: event.clientX, y: event.clientY });
          return;
        }
        case "selecting":
          extendSelection(tracking, { x: event.clientX, y: event.clientY });
          return;
        case "scrolling":
        case "long-pressed":
          return;
      }
    },
    [clearTimers, extendSelection],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      const tracking = trackingRef.current;
      if (tracking === null) return;
      if (event.pointerId !== tracking.pointerId) return;
      const phase = tracking.phase;
      const start = { x: tracking.startX, y: tracking.startY };
      abandon();
      switch (phase) {
        case "pending":
        case "select-armed": {
          const movedPx = Math.hypot(
            event.clientX - start.x,
            event.clientY - start.y,
          );
          if (movedPx > TOUCH_TAP_SLOP_PX) return;
          onTapRef.current();
          return;
        }
        case "long-pressed":
          onLongPressRef.current(start);
          return;
        case "selecting":
        case "scrolling":
          return;
      }
    },
    [abandon],
  );

  const onPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      const tracking = trackingRef.current;
      if (tracking === null) return;
      if (event.pointerId !== tracking.pointerId) return;
      abandon();
    },
    [abandon],
  );

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}
