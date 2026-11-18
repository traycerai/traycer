import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  classifyDirectionalIntent,
  isTextEntryFocused,
} from "@/components/layout/shell/shell-gestures";

/**
 * FINGER travel at which the release refreshes.
 *
 * Raw travel, not the damped distance the surface moves. The two diverge fast -
 * the band is what makes the pull feel attached, and reading the threshold off
 * it would silently mean the user has to drag twice as far as the number says.
 */
export const PULL_TRIGGER_PX = 64;

/**
 * How far the surface can travel however hard it is pulled. The band is
 * asymptotic, so this is approached and never reached - the resistance itself
 * is the signal that the gesture has nowhere further to go.
 */
const PULL_LIMIT_PX = 128;

function rubberBanded(rawPx: number): number {
  // Each further pixel of finger travel yields less surface travel. The curve
  // is what makes the pull feel attached to the finger rather than clamped:
  // a hard limit stops dead under a moving finger, which reads as a bug.
  return (PULL_LIMIT_PX * rawPx) / (rawPx + PULL_LIMIT_PX);
}

/**
 * Where the indicator parks while the refresh runs: exactly where the surface
 * stood at the moment the pull armed, so the release is a hand-off rather than
 * a jump.
 */
export const PULL_INDICATOR_REST_PX = rubberBanded(PULL_TRIGGER_PX);

interface PullTracking {
  readonly touchId: number;
  readonly x: number;
  readonly y: number;
  readonly at: number;
  activated: boolean;
}

export interface PullToRefresh {
  /** Pixels the list is pushed down; the indicator fills the gap it leaves. */
  readonly pullPx: number;
  /** A finger is driving the pull, so the surface must not be eased. */
  readonly isPulling: boolean;
  /** The refresh is in flight and the indicator is parked at the trigger. */
  readonly isRefreshing: boolean;
  /** Releasing now would refresh - the indicator says so before it happens. */
  readonly isArmed: boolean;
}

export interface PullToRefreshArgs {
  /** The scroll container the gesture is measured against and attached to. */
  readonly scrollRef: RefObject<HTMLElement | null>;
  readonly onRefresh: () => Promise<unknown>;
  readonly disabled: boolean;
}

/**
 * Pull-down-to-refresh over a scroll container.
 *
 * Touch events rather than the pointer events the shell recognizers use,
 * because this one has to call `preventDefault`. A pointer listener cannot stop
 * a scroll; only a non-passive `touchmove` can, and the whole gesture depends
 * on holding the list still while the finger drags past the top of its content.
 *
 * Implemented here rather than reached for from the native layer: the mobile
 * shell bundles no refresh plugin, and the gesture is a web one anyway - it
 * drives a React Query refetch and animates a DOM surface, neither of which a
 * native recognizer could see.
 *
 * Ending and cancelling are separate paths, and conflating them is the classic
 * bug in this gesture: `touchcancel` is the system taking the touch away - a
 * call arriving, the app backgrounding, a gesture the OS decided was its own -
 * and a refresh fired from there is one the user never asked for. Only a real
 * `touchend` can commit. Everything else unwinds.
 *
 * Two guards decide whether the gesture is even ours:
 *
 * - `scrollTop > 0` means the list can still scroll up, and taking the drag
 *   there would make the list feel stuck at every position but the top.
 * - A focused text entry means the shell's own downward drag is a request to
 *   put the keyboard away. That recognizer treats a container already at its
 *   top as its own, so standing down here is what keeps the two from both
 *   answering one drag.
 */
export function usePullToRefresh(args: PullToRefreshArgs): PullToRefresh {
  const { scrollRef, onRefresh, disabled } = args;
  // Raw finger travel, which is what every decision is made from. The damped
  // distance is derived for display only, at the boundary.
  const [rawPullPx, setRawPullPx] = useState<number | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const onRefreshRef = useRef(onRefresh);
  useEffect(() => {
    onRefreshRef.current = onRefresh;
  });
  // Mirrored into refs because the listeners are installed once: re-attaching a
  // non-passive touch listener on every pull frame would drop the very gesture
  // driving it.
  const isRefreshingRef = useRef(false);
  const rawPullPxRef = useRef<number | null>(null);

  const startRefresh = useCallback(() => {
    if (isRefreshingRef.current) return;
    isRefreshingRef.current = true;
    setIsRefreshing(true);
    void onRefreshRef.current().finally(() => {
      isRefreshingRef.current = false;
      setIsRefreshing(false);
    });
  }, []);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null) return;
    if (disabled) return;
    let tracking: PullTracking | null = null;

    // Unwinds the gesture without committing it. Every exit that is not a
    // deliberate release comes through here, and it clears the surface as well
    // as the tracker - dropping only the tracker would strand the list
    // translated with nothing left to settle it.
    const cancel = (): void => {
      tracking = null;
      rawPullPxRef.current = null;
      setRawPullPx(null);
    };

    const handleTouchStart = (event: TouchEvent): void => {
      // A second finger is a pinch or a two-finger pan; neither is a pull, and
      // the tracked touch's coordinates stop describing the gesture as a whole.
      cancel();
      if (event.touches.length !== 1) return;
      if (isRefreshingRef.current) return;
      if (scroller.scrollTop > 0) return;
      if (isTextEntryFocused()) return;
      // `item()` is the null-returning accessor; indexing types as always-
      // present here, which makes an `undefined` guard a lint error.
      const touch = event.touches.item(0);
      if (touch === null) return;
      tracking = {
        touchId: touch.identifier,
        x: touch.clientX,
        y: touch.clientY,
        at: event.timeStamp,
        activated: false,
      };
    };

    const handleTouchMove = (event: TouchEvent): void => {
      const started = tracking;
      if (started === null) return;
      const touch = Array.from(event.touches).find(
        (candidate) => candidate.identifier === started.touchId,
      );
      if (touch === undefined) return;
      const travelPx = touch.clientY - started.y;
      if (!started.activated) {
        // The list may have scrolled between the touch landing and the drag
        // declaring itself (a flick still settling), and pulling from a
        // scrolled position would tear the content away from the top.
        if (scroller.scrollTop > 0) {
          cancel();
          return;
        }
        const intent = classifyDirectionalIntent({
          primaryPx: travelPx,
          crossPx: touch.clientX - started.x,
          elapsedMs: event.timeStamp - started.at,
        });
        if (intent === "fail") {
          cancel();
          return;
        }
        if (intent === "wait") return;
        // DIRECTION LOCK: the drag is the pull's from here, and re-classifying
        // a finger that curves sideways would cancel it mid-gesture.
        started.activated = true;
      }
      if (travelPx <= 0) {
        // Dragged back above the start: let the list scroll again rather than
        // holding it pinned at zero pull for the rest of the gesture.
        cancel();
        return;
      }
      // The list would otherwise scroll (or, at its top, bounce) underneath the
      // surface being translated, and the two would move at once.
      if (event.cancelable) event.preventDefault();
      rawPullPxRef.current = travelPx;
      setRawPullPx(travelPx);
    };

    // The one path that may commit, and only from a release the user made.
    const handleTouchEnd = (): void => {
      if (tracking === null) return;
      const released = rawPullPxRef.current;
      cancel();
      if (released !== null && released >= PULL_TRIGGER_PX) startRefresh();
    };

    scroller.addEventListener("touchstart", handleTouchStart, {
      passive: true,
    });
    scroller.addEventListener("touchmove", handleTouchMove, { passive: false });
    scroller.addEventListener("touchend", handleTouchEnd, { passive: true });
    scroller.addEventListener("touchcancel", cancel, { passive: true });
    return () => {
      scroller.removeEventListener("touchstart", handleTouchStart);
      scroller.removeEventListener("touchmove", handleTouchMove);
      scroller.removeEventListener("touchend", handleTouchEnd);
      scroller.removeEventListener("touchcancel", cancel);
      // Unmounting, or losing the gesture to `disabled`, mid-pull: the surface
      // has to come back on its own, because nothing is left to release it.
      cancel();
    };
  }, [disabled, scrollRef, startRefresh]);

  const restingPx = isRefreshing ? PULL_INDICATOR_REST_PX : 0;
  return {
    pullPx: rawPullPx === null ? restingPx : rubberBanded(rawPullPx),
    isPulling: rawPullPx !== null,
    isRefreshing,
    isArmed: rawPullPx !== null && rawPullPx >= PULL_TRIGGER_PX,
  };
}
