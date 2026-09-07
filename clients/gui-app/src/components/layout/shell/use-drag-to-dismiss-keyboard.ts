import { useEffect } from "react";
import {
  classifyDirectionalIntent,
  commitsDirectionalGesture,
  declaresOwnTouchHandling,
  isTextEntryFocused,
  isWithinFocusedTextEntry,
  verticalScrollTargetForDownwardDrag,
  type DirectionalCommitLimits,
} from "@/components/layout/shell/shell-gestures";
import { isMobileApp } from "@/lib/mobile-app";

/** Downward scroll speed, in CSS px per ms, that reads as "put the keyboard away" rather than "show me what is
 * above". */
const DISMISS_SCROLL_VELOCITY_PX_PER_MS = 1.5;

/** Scroll samples closer together than this are noise: browsers coalesce scroll events, and dividing a
 * sub-frame delta by a sub-frame duration produces velocities that have nothing to do with the finger. */
const MIN_SCROLL_SAMPLE_MS = 30;

/** Shorter than the drawer's because there is no competing gesture left to protect: the scroll case has already
 * been routed away by the time this applies. */
const DISMISS_DRAG_COMMIT: DirectionalCommitLimits = {
  commitPx: 40,
  velocityPxPerMs: 0.5,
};

/** Generous enough to survive the wobble of a thumb on glass, tight enough that the first moments of a scroll
 * are never mistaken for one. */
const TAP_SLOP_PX = 8;

interface TapTracking {
  readonly x: number;
  readonly y: number;
  readonly target: EventTarget | null;
  cancelled: boolean;
}

interface DragTracking {
  readonly x: number;
  readonly y: number;
  readonly at: number;
  activated: boolean;
}

interface ScrollSample {
  readonly node: Element;
  readonly top: number;
  readonly at: number;
  readonly previousTop: number;
  readonly previousAt: number;
}

/** The mode can be set and will silently never fire. */
export function useDragToDismissKeyboard(): void {
  useEffect(() => {
    if (!isMobileApp()) return;
    let tap: TapTracking | null = null;
    let drag: DragTracking | null = null;
    let scroll: ScrollSample | null = null;
    /** The node under the finger for the live single-touch sequence, and the entry that owned focus when it
     * started. Both are null between gestures, which is what makes every arm below inert outside one. */
    let touchedNode: Node | null = null;
    let focusedAtStart: Element | null = null;

    const handleScroll = (event: Event): void => {
      const node = event.target instanceof Element ? event.target : null;
      if (node === null) return;
      // Without both of these the sampler would take whichever element in the app happened to scroll fast while a
      // text entry was focused - a sibling list settling, a programmatic scroll correction, an animation.
      if (touchedNode === null) return;
      if (node !== touchedNode && !node.contains(touchedNode)) return;
      const previous = scroll !== null && scroll.node === node ? scroll : null;
      if (
        previous !== null &&
        event.timeStamp - previous.at < MIN_SCROLL_SAMPLE_MS
      ) {
        return;
      }
      scroll = {
        node,
        top: node.scrollTop,
        at: event.timeStamp,
        // A first sample has no span to measure, so it seeds one against
        // itself: velocity reads zero until a real second sample lands.
        previousTop: previous === null ? node.scrollTop : previous.top,
        previousAt: previous === null ? event.timeStamp : previous.at,
      };
    };

    const handleTouchStart = (event: TouchEvent): void => {
      tap = null;
      drag = null;
      scroll = null;
      touchedNode = null;
      focusedAtStart = null;
      if (event.touches.length !== 1) return;
      const touch = event.touches.item(0);
      if (touch === null) return;
      // Nothing to dismiss. Cheap enough to be the first gate on every touch.
      if (!isTextEntryFocused()) return;
      // The terminal key bar cancels its own touches precisely so a key press cannot blur the terminal; dismissing
      // from a drag that started there would undo that from the outside.
      if (declaresOwnTouchHandling(event.target)) return;
      touchedNode = event.target instanceof Node ? event.target : null;
      // Focus can move while a drag is in flight - a picker or a route change autofocusing its own field - and
      // dismissing then would blur a field the user was just given rather than the one they were trying to leave.
      focusedAtStart = document.activeElement;
      // Armed over scrollers too, unlike the drag arm below: a tap cannot be
      // confused with a scroll, so there is nothing to yield to.
      tap = {
        x: touch.clientX,
        y: touch.clientY,
        target: event.target,
        cancelled: false,
      };
      // A scroller that can still move down owns this drag. Its outcome is read
      // on release instead - the arm below never arms here.
      if (verticalScrollTargetForDownwardDrag(event.target) !== null) return;
      drag = {
        x: touch.clientX,
        y: touch.clientY,
        at: event.timeStamp,
        activated: false,
      };
    };

    const handleTouchMove = (event: TouchEvent): void => {
      const moved = event.touches.item(0);
      if (tap !== null && moved !== null) {
        const dx = moved.clientX - tap.x;
        const dy = moved.clientY - tap.y;
        // Euclidean, not per-axis: a diagonal drift of 8px on each axis is 11px of travel, and calling that a tap is
        // how a slow scroll starts dismissing keyboards.
        if (Math.hypot(dx, dy) > TAP_SLOP_PX) tap.cancelled = true;
      }
      const started = drag;
      if (started === null) return;
      if (event.touches.length !== 1) {
        drag = null;
        return;
      }
      const touch = event.touches.item(0);
      if (touch === null) return;
      const gesture = {
        // Downward is this gesture's own axis, so a growing `clientY` is
        // positive travel.
        primaryPx: touch.clientY - started.y,
        crossPx: touch.clientX - started.x,
        elapsedMs: event.timeStamp - started.at,
      };
      if (!started.activated) {
        const intent = classifyDirectionalIntent(gesture);
        if (intent === "fail") {
          drag = null;
          return;
        }
        if (intent === "wait") return;
        started.activated = true;
      }
      if (!commitsDirectionalGesture(gesture, DISMISS_DRAG_COMMIT)) return;
      drag = null;
      dismiss();
    };

    const releaseDismisses = (
      tapped: TapTracking | null,
      sampled: ScrollSample | null,
    ): boolean => {
      if (tapped !== null && !tapped.cancelled) {
        // Nothing else is exempt: taps on buttons and links still dismiss, and their own click runs regardless,
        // because these listeners are passive and never cancel anything.
        return !isWithinFocusedTextEntry(tapped.target);
      }
      if (sampled === null) return false;
      const elapsedMs = sampled.at - sampled.previousAt;
      if (elapsedMs <= 0) return false;
      // `scrollTop` falling is content travelling down under a finger that is dragging down; the sign is inverted
      // from the finger's own direction.
      const velocity = (sampled.previousTop - sampled.top) / elapsedMs;
      return velocity >= DISMISS_SCROLL_VELOCITY_PX_PER_MS;
    };

    const handleTouchEnd = (): void => {
      const tapped = tap;
      const sampled = scroll;
      tap = null;
      drag = null;
      scroll = null;
      if (releaseDismisses(tapped, sampled)) dismiss();
      // After the arms, never before: both read the gesture's pinned focus. Cleared here so the momentum scrolling
      // that follows a flick cannot go on feeding the sampler once the finger is gone.
      touchedNode = null;
      focusedAtStart = null;
    };

    const dismiss = (): void => {
      // "Some text entry is still focused" is satisfied by a different one.
      const entry = focusedAtStart;
      if (entry === null) return;
      if (document.activeElement !== entry) return;
      if (entry instanceof HTMLElement) entry.blur();
    };

    const handleTouchCancel = (): void => {
      tap = null;
      drag = null;
      scroll = null;
      touchedNode = null;
      focusedAtStart = null;
    };

    const options = { capture: true, passive: true };
    document.addEventListener("scroll", handleScroll, options);
    document.addEventListener("touchstart", handleTouchStart, options);
    document.addEventListener("touchmove", handleTouchMove, options);
    document.addEventListener("touchend", handleTouchEnd, options);
    document.addEventListener("touchcancel", handleTouchCancel, options);
    return () => {
      document.removeEventListener("scroll", handleScroll, { capture: true });
      document.removeEventListener("touchstart", handleTouchStart, {
        capture: true,
      });
      document.removeEventListener("touchmove", handleTouchMove, {
        capture: true,
      });
      document.removeEventListener("touchend", handleTouchEnd, {
        capture: true,
      });
      document.removeEventListener("touchcancel", handleTouchCancel, {
        capture: true,
      });
    };
  }, []);
}
