import {
  useCallback,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  classifyDirectionalIntent,
  commitsDirectionalGesture,
} from "@/components/layout/shell/shell-gestures";
import { readSafeAreaInsets } from "@/lib/safe-area-insets";

/**
 * Width of one tray action. 44px is the touch-target floor, and the tray is
 * sized from it rather than measured: the reveal distance has to be known on
 * the first move of the drag, before the tray has ever been painted.
 */
export const TRAY_ACTION_PX = 44;

/**
 * Reveal that commits on release however slowly it was dragged - half the
 * tray, the point past which the actions read as intentionally exposed.
 */
const COMMIT_FRACTION = 0.5;

/** Release speed that commits before half the tray is reached. */
const COMMIT_VELOCITY_PX_PER_MS = 0.5;

/**
 * Travel past the tray's own width that the drag still tracks, at a decaying
 * rate. Without it the row stops dead under a finger that is still moving,
 * which reads as a dropped gesture rather than a limit.
 */
const OVERPULL_PX = 40;

/**
 * Movement that cancels a pending tap. Deliberately smaller than the
 * activation distance: a drag that never declared an axis still must not
 * navigate, because a finger that moved at all was not pointing at anything.
 */
const TAP_SLOP_PX = 6;

/**
 * Width of the strip along the screen's leading edge that a row swipe leaves
 * alone, reserved for whatever gesture the shell claims that edge with.
 *
 * Absolute because the thing it describes is: a fingertip is the same size on a
 * 4.7" phone as on a tablet, so a zone expressed as a fraction of the viewport
 * would be an unhittable sliver on one and a wide dead band on the other.
 */
const EDGE_ZONE_PX = 32;

/**
 * Whether a touch landed in the strip a row swipe yields.
 *
 * Measured from the safe-area inset rather than from zero: on a device with a
 * landscape sensor housing the app does not start at x=0, and a strip pinned
 * to the raw viewport edge would sit beside the reserved one rather than over
 * it.
 */
function withinEdgeZone(clientX: number): boolean {
  const left = readSafeAreaInsets().left;
  return clientX >= left && clientX <= left + EDGE_ZONE_PX;
}

/**
 * Travel along the gesture's own forward direction, positive in it. Which way
 * that is depends on where the tray already sits, and every threshold in the
 * recognizer - the classifier's counter-direction arm, the tap slop, the commit
 * distance - is expressed in this one signed number so both directions get
 * identical treatment.
 */
function forwardTravelPx(startX: number, x: number, isOpen: boolean): number {
  return isOpen ? x - startX : startX - x;
}

function overpulled(beyondPx: number): number {
  // Asymptotic: every further pixel of finger travel yields less row travel, so
  // the row never reaches the limit and never visibly stops.
  return (OVERPULL_PX * beyondPx) / (beyondPx + OVERPULL_PX);
}

interface SwipeTracking {
  /**
   * Which stand-down cycle this tracker belongs to. A pointer can stay down
   * across one: selection mode entered from another input while a finger is
   * already on a row, then left again before that finger lifts. Matching on
   * `pointerId` alone would let the second half of that contact resume travel
   * measured from an origin the row has since stopped believing in.
   */
  readonly epoch: number;
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly at: number;
  /** The classifier has claimed this drag; stop re-asking it. */
  activated: boolean;
  /** The pointer has moved far enough that a release is no longer a tap. */
  moved: boolean;
}

export interface RowSwipeTray {
  /** Pixels the row is shifted left; the tray occupies the gap it leaves. */
  readonly offsetPx: number;
  /** The row is following a finger, so its motion must not be eased. */
  readonly isDragging: boolean;
  readonly trayWidthPx: number;
  readonly close: () => void;
  readonly handlers: RowSwipeHandlers;
  /**
   * Whether the interaction that just ended was a drag rather than a tap.
   * Read synchronously by the row's click handler, which fires after
   * `pointerup` and must not navigate on the tail of a swipe.
   */
  readonly consumedTap: () => boolean;
}

export interface RowSwipeHandlers {
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
}

export interface RowSwipeTrayArgs {
  /** Number of actions the tray will render; zero disables the gesture. */
  readonly actionCount: number;
  /**
   * The tray is open according to the list, which allows only one at a time.
   * Ownership lives up there rather than here so opening one row closes the
   * others without rows having to know about each other.
   */
  readonly isOpen: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Suppresses the gesture entirely (selection mode, inline rename). */
  readonly disabled: boolean;
  /** Called when a drag declares itself, so the row can cancel its long press. */
  readonly onDragStart: () => void;
}

/**
 * Swipe-to-reveal for one list row, and swipe back to put it away.
 *
 * The gesture's forward direction is whichever way the tray still has to
 * travel: leftward while it is closed, rightward once it is open. Only one of
 * those is ever live, so a rightward drag on a row AT REST is dead - it trips
 * the classifier's counter-direction arm and the touch goes straight back to
 * whatever else wanted it. That is the property the mobile shell's left-edge
 * drawer pull depends on.
 *
 * Retracting an OPEN tray is rightward too, and there the row and the drawer
 * want the same axis at the same time. The row spans the full width, so a
 * close swipe can begin inside the drawer's edge strip, where the drawer's
 * document-capture recognizer is already tracking - `touch-action: pan-y` is
 * not `pan-x`, so `ownsHorizontalGesture` does not see the row and nothing
 * upstream stands the drawer down. Two recognizers would then animate one
 * pointer. The row yields: inside the strip it does not claim at all, and the
 * navigation gesture keeps the screen edge it owns everywhere else in the app.
 *
 * Nothing commits on the swipe itself. The tray opens and waits to be tapped,
 * because the actions behind it include a destructive one and a full-swipe
 * commit puts it one over-eager flick away with no confirmation step in
 * between.
 *
 * Touch pointers only. The same list renders in a narrow desktop window, where
 * a horizontal mouse drag is a text selection or a trackpad scroll rather than
 * a row swipe.
 *
 * The row declares `touch-action: pan-y`, which is what makes this work without
 * ever calling `preventDefault`: the browser keeps the vertical axis and
 * scrolls the list normally, and the horizontal axis is delivered here.
 */
export function useRowSwipeTray(args: RowSwipeTrayArgs): RowSwipeTray {
  const { actionCount, isOpen, onOpenChange, disabled, onDragStart } = args;
  const trayWidthPx = actionCount * TRAY_ACTION_PX;
  const [dragOffsetPx, setDragOffsetPx] = useState<number | null>(null);
  const trackingRef = useRef<SwipeTracking | null>(null);
  const consumedTapRef = useRef(false);

  const enabled = !disabled && actionCount > 0;

  // A row that loses its tray while a drag is live - selection mode entered
  // from elsewhere, the list re-sorting under the finger - must not keep a
  // stale offset painted, and must not still be believed once it comes back.
  //
  // Settled DURING the render that stands the recognizer down rather than in
  // an effect afterwards. An effect commits one frame with the row still
  // translated, which is a visible twitch at exactly the moment a mode is
  // changing under the finger; and an effect that invalidated the tracker
  // would leave a window, between the commit and the effect, in which a move
  // event could still be matched. Bumping the epoch here closes both: the
  // rejection is in force on the very next event, with nothing scheduled.
  const [enableState, setEnableState] = useState({ enabled, epoch: 0 });
  if (enableState.enabled !== enabled) {
    setEnableState({ enabled, epoch: enableState.epoch + 1 });
    setDragOffsetPx(null);
  }
  const enableEpoch = enableState.epoch;

  const close = useCallback(() => {
    trackingRef.current = null;
    setDragOffsetPx(null);
    onOpenChange(false);
  }, [onOpenChange]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled) return;
      if (event.pointerType !== "touch") return;
      if (!event.isPrimary) return;
      // Every contact that gets this far starts a fresh gesture, so anything
      // left over from the last one is dropped here - before any decision,
      // including the edge yield below, can return early past it.
      //
      // A resident tracker is not inert. Nothing is captured until the drag
      // activates, so a pointer that never declared itself and then ended off
      // this element leaves its tracker behind; touch pointer ids are reused
      // between contacts, and the next one to reuse that id would match it by
      // id and inherit its start coordinates. That is how a yielded touch
      // still ends up driving the row - the precise double-claim the yield
      // exists to prevent.
      trackingRef.current = null;
      setDragOffsetPx(null);
      // A tap inside the strip is still the row's - only a directed drag is
      // ever yielded - so the tap flag clears here too rather than below.
      consumedTapRef.current = false;
      // Only the open state can contend for the edge: a closed tray's forward
      // direction is leftward, away from the reserved strip.
      if (isOpen && withinEdgeZone(event.clientX)) return;
      trackingRef.current = {
        epoch: enableEpoch,
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        at: event.timeStamp,
        activated: false,
        moved: false,
      };
    },
    [enableEpoch, enabled, isOpen],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      // Every handler past the first asks this too. A gesture can be stood
      // down mid-drag, and a tracker created while the row still had a tray
      // must not keep driving it afterwards; `onPointerDown` drops the tracker
      // at the start of every contact, so nothing survives to a later one.
      if (!enabled) return;
      const tracking = trackingRef.current;
      if (tracking === null) return;
      if (tracking.epoch !== enableEpoch) return;
      if (event.pointerId !== tracking.pointerId) return;
      const travelPx = forwardTravelPx(tracking.x, event.clientX, isOpen);
      if (
        !tracking.moved &&
        (Math.abs(travelPx) > TAP_SLOP_PX ||
          Math.abs(event.clientY - tracking.y) > TAP_SLOP_PX)
      ) {
        tracking.moved = true;
      }
      if (!tracking.activated) {
        const intent = classifyDirectionalIntent({
          primaryPx: travelPx,
          crossPx: event.clientY - tracking.y,
          elapsedMs: event.timeStamp - tracking.at,
        });
        if (intent === "fail") {
          // Handing the touch back does not hand back the tap: a finger that
          // travelled and then released was scrolling or swiping the wrong way,
          // and opening the task on it would be a navigation nobody asked for.
          trackingRef.current = null;
          consumedTapRef.current = tracking.moved;
          return;
        }
        if (intent === "wait") return;
        // DIRECTION LOCK: from here the drag is the tray's, and a finger that
        // curves vertically keeps it. Re-classifying per move is how a
        // recognizer cancels itself mid-gesture.
        tracking.activated = true;
        consumedTapRef.current = true;
        onDragStart();
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      // Travel is measured from wherever the tray already was, so the row
      // picks up under the finger instead of snapping to an end state first.
      const raw = isOpen ? trayWidthPx - travelPx : travelPx;
      if (raw <= 0) {
        setDragOffsetPx(0);
        return;
      }
      setDragOffsetPx(
        raw <= trayWidthPx ? raw : trayWidthPx + overpulled(raw - trayWidthPx),
      );
    },
    [enableEpoch, enabled, isOpen, onDragStart, trayWidthPx],
  );

  const settle = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled) return;
      const tracking = trackingRef.current;
      if (tracking === null) return;
      if (tracking.epoch !== enableEpoch) return;
      if (event.pointerId !== tracking.pointerId) return;
      trackingRef.current = null;
      consumedTapRef.current = tracking.moved;
      if (!tracking.activated) {
        setDragOffsetPx(null);
        return;
      }
      // Distance OR speed, evaluated at release rather than per move: unlike a
      // drawer, a tray dragged part-way and then pushed back should end where
      // it started, and the user watching it track their finger has already
      // been shown that answer.
      const travelPx = forwardTravelPx(tracking.x, event.clientX, isOpen);
      const commits = commitsDirectionalGesture(
        {
          primaryPx: travelPx,
          crossPx: event.clientY - tracking.y,
          elapsedMs: event.timeStamp - tracking.at,
        },
        {
          commitPx: trayWidthPx * COMMIT_FRACTION,
          velocityPxPerMs: COMMIT_VELOCITY_PX_PER_MS,
        },
      );
      setDragOffsetPx(null);
      // Committing means the gesture completed its forward direction, which is
      // "reveal" from rest and "put away" from open.
      onOpenChange(isOpen ? !commits : commits);
    },
    [enableEpoch, enabled, isOpen, onOpenChange, trayWidthPx],
  );

  const onPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled) return;
      const tracking = trackingRef.current;
      if (tracking === null) return;
      if (tracking.epoch !== enableEpoch) return;
      if (event.pointerId !== tracking.pointerId) return;
      trackingRef.current = null;
      setDragOffsetPx(null);
    },
    [enableEpoch, enabled],
  );

  const consumedTap = useCallback(() => consumedTapRef.current, []);

  return {
    // A stood-down recognizer reveals NOTHING, whatever the list still thinks
    // is open. Making that true here rather than at each call site is what
    // keeps "disabled" from meaning only "cannot be dragged" while a row left
    // over from before still sits translated with its actions on show.
    offsetPx: enabled ? (dragOffsetPx ?? (isOpen ? trayWidthPx : 0)) : 0,
    isDragging: dragOffsetPx !== null,
    trayWidthPx,
    close,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: settle,
      onPointerCancel,
    },
    consumedTap,
  };
}
