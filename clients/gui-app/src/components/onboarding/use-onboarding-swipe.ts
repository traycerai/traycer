import { useEffect, useRef, type RefObject } from "react";
import {
  animate,
  useMotionValue,
  useReducedMotion,
  type AnimationPlaybackControls,
  type MotionValue,
} from "motion/react";
import { ownsHorizontalGesture } from "@/components/layout/shell/shell-gestures";
import { readSafeAreaInsets } from "@/lib/safe-area-insets";

/**
 * The tour's horizontal drag: one engine, two surfaces.
 *
 * The act layer and act 1's scene pager are the same gesture over different
 * content, so they share this. What a caller supplies is where the gesture may
 * commit, what committing means, and whether it has to keep its hands off the
 * platform's own edge strips.
 *
 * FOLLOW THE FINGER, THEN SPRING TO REST. The value this returns is the live
 * offset in px, written per pointer move and never latched to a step: the
 * surface moves 1:1 while the finger is down, resists past the ends, and
 * settles with a spring that inherits the release speed. A recognizer that only
 * reported a final swipe direction - which is what this replaced - throws away
 * every frame of that, so a half-committed drag shows nothing and a released
 * one has no velocity to hand on.
 *
 * A COMMITTED RELEASE DOES NOT WAIT FOR THE SETTLE. The offset stays where the
 * finger left it and springs home from there while the act (or the scene)
 * underneath has already swapped, so the arriving content glides in from the
 * direction it was thrown and the value is continuous across the swap. Zeroing
 * the offset at the swap instead is the one thing that reads as a jump.
 */

/** Which way the content is being asked to move. */
export type OnboardingDragDirection = "forward" | "back";

/**
 * Cross-axis travel that hands the pointer to the scroller underneath.
 *
 * Matches the shell's own tap slop (`NAV_DRAWER_TAP_SLOP_PX`), deliberately: a
 * drag is a drag at the same distance wherever it lands, and two answers on one
 * screen is how a surface starts feeling arbitrary.
 */
const AXIS_LOCK_PX = 8;

/**
 * Share of the surface's own width a slow release must have covered.
 *
 * Measured against the surface rather than the viewport, so the pager and the
 * act layer each ask for the same share of the distance they actually travel.
 */
const COMMIT_TRAVEL_FRACTION = 0.25;

/**
 * Release speed that commits on its own, px per second - the unit pointer
 * velocity is computed in here and the one the shell's drawer commits at, so a
 * flick that opens the navigation drawer also turns a page of the tour.
 */
const COMMIT_VELOCITY_PX_PER_S = 500;

/** The spring that takes the surface back to rest. No bounce: nothing overshoots. */
const SETTLE_VISUAL_DURATION_S = 0.4;

/**
 * Resistance past an end.
 *
 * `0.55` is the platform's own constant: the surface keeps moving, by less and
 * less, so a pull of its own width carries it about a third of that and it only
 * approaches the full width asymptotically. A hard stop at the end reads as
 * frozen; this reads as "responsive, but there is nothing more here".
 */
const RUBBER_BAND_CONSTANT = 0.55;

/** Strip at each screen edge the platform's own gestures own. */
const EDGE_ZONE_PX = 32;

/** Controls own their taps, and a text field owns horizontal drags in its line. */
const EXEMPT_TARGETS =
  'button, a, input, textarea, select, [contenteditable], [role="slider"]';

/** The nested pager declares itself, so the act layer can stand aside for it. */
const NESTED_PAGER_SELECTOR = "[data-onboarding-pager]";

/** How long a sample stays worth reading when the release speed is computed. */
const VELOCITY_WINDOW_MS = 100;

export interface OnboardingDragOptions {
  readonly enabled: boolean;
  /** Whether a release that passed the threshold may commit that way. */
  readonly canCommit: (direction: OnboardingDragDirection) => boolean;
  readonly onCommit: (direction: OnboardingDragDirection) => void;
  /**
   * A throw that met the threshold in a direction `canCommit` refused: the
   * surface rubber-banded, and whoever is outside it may want the gesture. Act
   * 1's pager hands its last scene's forward throw to the act layer this way.
   */
  readonly onRefused: (direction: OnboardingDragDirection) => void;
  /**
   * Whether the platform's edge strips are this surface's to refuse. True for
   * the act layer, which reaches the screen edges; false for a pager nested
   * inside it, whose own edges are not the screen's.
   */
  readonly respectsEdgeZones: boolean;
  /** Whether a pointer that lands in a nested pager belongs to that pager. */
  readonly yieldsToNestedPager: boolean;
}

interface VelocitySample {
  readonly x: number;
  readonly at: number;
}

interface DragTracking {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  /** Where the surface already was when this pointer took it over. */
  readonly bankedPx: number;
  readonly widthPx: number;
  /** Null until the drag has declared an axis. */
  axis: "x" | "y" | null;
  samples: VelocitySample[];
}

function withinEdgeZone(clientX: number): boolean {
  const insets = readSafeAreaInsets();
  if (clientX <= insets.left + EDGE_ZONE_PX) return true;
  return clientX >= window.innerWidth - insets.right - EDGE_ZONE_PX;
}

/**
 * How far the surface follows a finger that has pulled past an end. Apple's
 * own curve: the overshoot is divided by how much of it there already is, so
 * resistance grows with the pull instead of arriving as a wall.
 */
export function rubberBandOffset(overshootPx: number, widthPx: number): number {
  if (widthPx <= 0) return 0;
  const magnitude = Math.abs(overshootPx);
  const damped =
    (magnitude * widthPx * RUBBER_BAND_CONSTANT) /
    (widthPx + RUBBER_BAND_CONSTANT * magnitude);
  return Math.sign(overshootPx) * damped;
}

/** Signed px per second over the tail of the gesture, 0 when it has stalled. */
function releaseVelocity(samples: readonly VelocitySample[]): number {
  const last = samples.at(-1);
  if (last === undefined) return 0;
  const first =
    samples.find((sample) => last.at - sample.at <= VELOCITY_WINDOW_MS) ?? last;
  const elapsedMs = last.at - first.at;
  // A zero span is what a coalesced or synthetic move looks like, and treating
  // it as infinitely fast would commit on a twitch.
  if (elapsedMs <= 0) return 0;
  return ((last.x - first.x) / elapsedMs) * 1000;
}

/** Which way a signed offset is asking to go. Leftward travel is forward. */
function directionOf(offsetPx: number): OnboardingDragDirection {
  return offsetPx < 0 ? "forward" : "back";
}

export function useOnboardingHorizontalDrag(
  surfaceRef: RefObject<HTMLElement | null>,
  options: OnboardingDragOptions,
): MotionValue<number> {
  const offset = useMotionValue(0);
  const reducedMotion = useReducedMotion() === true;
  // Read at event time, never closed over: the listeners are installed once and
  // must not be torn down and rebuilt every time an act changes.
  const optionsRef = useRef(options);
  const reducedMotionRef = useRef(reducedMotion);
  useEffect(() => {
    optionsRef.current = options;
    reducedMotionRef.current = reducedMotion;
  });

  useEffect(() => {
    if (!options.enabled) return;
    const surface = surfaceRef.current;
    if (surface === null) return;
    let tracking: DragTracking | null = null;
    let settle: AnimationPlaybackControls | null = null;

    const settleHome = (velocityPxPerS: number): void => {
      settle?.stop();
      if (reducedMotionRef.current) {
        offset.set(0);
        settle = null;
        return;
      }
      settle = animate(offset, 0, {
        type: "spring",
        visualDuration: SETTLE_VISUAL_DURATION_S,
        bounce: 0,
        velocity: velocityPxPerS,
      });
    };

    const handlePointerDown = (event: PointerEvent): void => {
      // A second finger is a pinch or a two-finger pan; the tracked pointer's
      // coordinates stop describing the gesture either way.
      tracking = null;
      if (!event.isPrimary) return;
      const live = optionsRef.current;
      if (live.respectsEdgeZones && withinEdgeZone(event.clientX)) return;
      const target = event.target;
      if (target instanceof Element) {
        if (target.closest(EXEMPT_TARGETS) !== null) return;
        if (
          live.yieldsToNestedPager &&
          target.closest(NESTED_PAGER_SELECTOR) !== null
        ) {
          return;
        }
        // A rail that already pans sideways is mid-gesture, not available.
        if (ownsHorizontalGesture(target)) return;
      }
      // Whatever a settle had reached is where this pointer starts from, so a
      // finger arriving mid-flight takes the surface over instead of snapping
      // it back to rest first.
      settle?.stop();
      settle = null;
      tracking = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        bankedPx: offset.get(),
        // A surface with no measured width - a first frame before layout, a
        // jsdom node - is judged against the viewport, the only other width
        // that means anything here. Zero would make any travel at all a
        // commit, since the distance arm is a share of this.
        widthPx:
          surface.clientWidth > 0 ? surface.clientWidth : window.innerWidth,
        axis: null,
        samples: [{ x: event.clientX, at: event.timeStamp }],
      };
    };

    const handlePointerMove = (event: PointerEvent): void => {
      const started = tracking;
      if (started === null) return;
      if (event.pointerId !== started.pointerId) return;
      const travelX = event.clientX - started.startX;
      const travelY = event.clientY - started.startY;
      if (started.axis === null) {
        // Undecided until one axis clears the slop. Whichever does it first
        // owns the rest of the gesture: a horizontal drag that curves downward
        // later is still this one's, and a scroll is the scroller's.
        if (
          Math.abs(travelX) < AXIS_LOCK_PX &&
          Math.abs(travelY) < AXIS_LOCK_PX
        )
          return;
        started.axis = Math.abs(travelX) > Math.abs(travelY) ? "x" : "y";
        if (started.axis === "y") {
          tracking = null;
          return;
        }
      }
      started.samples = [
        ...started.samples.filter(
          (sample) => event.timeStamp - sample.at <= VELOCITY_WINDOW_MS * 2,
        ),
        { x: event.clientX, at: event.timeStamp },
      ];
      if (reducedMotionRef.current) return;
      // The slop is spent, not paid twice: subtracting it keeps the surface
      // under the finger rather than starting 8px behind it.
      // Clamped to the travel that exists: a finger coming back through its
      // start point would otherwise flip the compensation's sign and jump the
      // surface by twice the slop in one frame.
      const pulled =
        travelX -
        Math.sign(travelX) * Math.min(Math.abs(travelX), AXIS_LOCK_PX);
      const wanted = started.bankedPx + pulled;
      const live = optionsRef.current;
      if (live.canCommit(directionOf(pulled))) {
        offset.set(wanted);
        return;
      }
      offset.set(rubberBandOffset(wanted, started.widthPx));
    };

    const handlePointerUp = (event: PointerEvent): void => {
      const started = tracking;
      if (started === null) return;
      if (event.pointerId !== started.pointerId) return;
      tracking = null;
      if (started.axis !== "x") {
        // A tap that took over a running settle froze the surface where it
        // was; with no drag to answer, nothing else would bring it home.
        if (offset.get() !== 0) settleHome(0);
        return;
      }
      const samples = [
        ...started.samples,
        { x: event.clientX, at: event.timeStamp },
      ];
      const velocityPxPerS = releaseVelocity(samples);
      // THIS POINTER'S OWN TRAVEL, not the surface's absolute displacement.
      // The two differ only for a takeover, and there the banked part belongs
      // to a gesture that has already been answered: a swipe forward whose
      // content has swapped is still gliding home when the next swipe lands, and
      // charging that glide against the new gesture makes a fast pair of swipes
      // silently drop the second one.
      const travelPx = event.clientX - started.startX;
      const direction = directionOf(travelPx);
      const commits =
        Math.abs(velocityPxPerS) >= COMMIT_VELOCITY_PX_PER_S
          ? directionOf(velocityPxPerS) === direction
          : Math.abs(travelPx) >= started.widthPx * COMMIT_TRAVEL_FRACTION;
      const live = optionsRef.current;
      if (commits) {
        if (live.canCommit(direction)) live.onCommit(direction);
        else live.onRefused(direction);
      }
      settleHome(velocityPxPerS);
    };

    const handlePointerCancel = (event: PointerEvent): void => {
      const started = tracking;
      if (started === null) return;
      if (event.pointerId !== started.pointerId) return;
      tracking = null;
      // The system took the gesture away - a call, the notification shade, a
      // palm. Nothing it did was a choice, so the surface goes back.
      settleHome(0);
    };

    const listenerOptions = { passive: true };
    surface.addEventListener("pointerdown", handlePointerDown, listenerOptions);
    window.addEventListener("pointermove", handlePointerMove, listenerOptions);
    window.addEventListener("pointerup", handlePointerUp, listenerOptions);
    window.addEventListener(
      "pointercancel",
      handlePointerCancel,
      listenerOptions,
    );
    return () => {
      settle?.stop();
      offset.set(0);
      surface.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
    };
  }, [offset, options.enabled, surfaceRef]);

  return offset;
}
