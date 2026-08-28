import { useCallback, useEffect, useRef, useState } from "react";
import {
  animate,
  useMotionValue,
  useReducedMotion,
  type AnimationPlaybackControls,
  type MotionValue,
} from "motion/react";
import type { RouterEvents, RouterHistory } from "@tanstack/react-router";
import {
  captureScreenSnapshot,
  findSnapshotSource,
} from "@/components/layout/shell/screen-snapshot";
import {
  clearScreenSnapshots,
  readHistoryEntryKey,
  readScreenSnapshot,
  rememberScreenSnapshot,
} from "@/components/layout/shell/screen-snapshot-cache";
import {
  SWIPE_NAV_SETTLE,
  SWIPE_NAV_SHAPE,
  swipeNavCommits,
} from "@/components/layout/shell/swipe-nav-transition-motion";
import type { SwipeNavTransitionView } from "@/components/layout/shell/swipe-nav-transition-layers";
import type {
  EdgeNavDirection,
  EdgeNavDragResponse,
} from "@/components/layout/shell/use-edge-nav-swipe";
import { isMobileApp } from "@/lib/mobile-app";

/**
 * The router surface this needs, and no more: the live history to read the
 * cursor from, and the event stream to learn that a screen is about to be left.
 * Narrowed for the same reason `HistoryNavRouter` is - callers pass
 * `useRouter()` directly and a test supplies a small fake without a cast.
 */
export interface SwipeNavRouter {
  readonly history: RouterHistory;
  subscribe(
    eventType: "onBeforeNavigate",
    fn: (event: RouterEvents["onBeforeNavigate"]) => void,
  ): () => void;
}

export interface SwipeNavDragRelease {
  /** Inward travel at release, in px. */
  readonly travelPx: number;
  /** Signed pointer velocity along the swipe's inward axis, px per second. */
  readonly velocityPxPerS: number;
  /** The system ended the gesture rather than the user. */
  readonly cancelled: boolean;
}

export interface SwipeNavTransition {
  /**
   * Takes the drag if a transition can be shown, and answers what the gesture
   * becomes. `follow` took it. `instant` is not a failure: this history step
   * has no frozen destination to move, and the caller navigates instantly
   * instead - which is what the gesture did before this existed. `decline`
   * consumes the gesture entirely: a committed settle is already navigating,
   * and an instant step fired under it would stack a second navigation onto
   * layers still showing the first.
   */
  readonly beginDrag: (direction: EdgeNavDirection) => EdgeNavDragResponse;
  readonly updateDrag: (travelPx: number) => void;
  readonly endDrag: (release: SwipeNavDragRelease) => void;
  /** Non-null exactly while frozen screens should be on top of the app. */
  readonly view: SwipeNavTransitionView | null;
  readonly progress: MotionValue<number>;
}

/**
 * Drives the follow-the-finger history transition: keeps a frozen copy of every
 * screen the app leaves, hands the two a swipe needs to the layers, and settles
 * the release.
 *
 * THE APP IS NEVER NAVIGATED UNTIL THE RELEASE COMMITS. That is the constraint
 * the whole shape follows from, and it is what makes an abandoned swipe free:
 * the live app underneath is untouched for the entire drag, so a cancel is two
 * frozen screens being taken away rather than a navigation being undone. The
 * alternative - navigate on the first pixel and step back if the finger changes
 * its mind - would remount the screen the user STAYED on and lose its scroll
 * position, which is a real cost charged for a gesture that expressed nothing.
 *
 * The consequence is that both screens on display during a drag are copies, and
 * the destination copy is as old as the last time the user was on that screen.
 * A chat that streamed while they were away shows its earlier state for the
 * length of the transition and lands live. Every platform's interactive pop has
 * this same seam, for the same reason, and it is the cheaper of the two errors.
 */
export function useSwipeNavTransition(
  router: SwipeNavRouter,
  navigate: (direction: EdgeNavDirection) => void,
  resolveDestination: (direction: EdgeNavDirection) => string | null,
): SwipeNavTransition {
  const progress = useMotionValue(0);
  const [view, setView] = useState<SwipeNavTransitionView | null>(null);
  // Read at event time from listeners installed once, so nothing here depends
  // on a re-render having happened first.
  const viewRef = useRef<SwipeNavTransitionView | null>(null);
  const settleRef = useRef<AnimationPlaybackControls | null>(null);
  // Whether the settle in flight has already navigated. A cancel settle has
  // not, which is what makes it safe to interrupt.
  const committedRef = useRef(false);
  // Travel already banked when a finger took the layers over mid-settle, in
  // px. The new pointer measures its own travel from zero, but the layers it
  // inherited are not at zero - without this offset the takeover's first move
  // would snap them back toward rest, and the release would be judged on a
  // fraction of the distance the layers have actually covered.
  const takeoverTravelPxRef = useRef(0);
  const navigateRef = useRef(navigate);
  const reducedMotion = useReducedMotion();
  const reducedMotionRef = useRef(reducedMotion);
  useEffect(() => {
    navigateRef.current = navigate;
    reducedMotionRef.current = reducedMotion;
  });

  const clearView = useCallback((): void => {
    settleRef.current = null;
    committedRef.current = false;
    viewRef.current = null;
    setView(null);
  }, []);

  // Freezes the screen the app is leaving, on the way out, while it is still
  // the screen on display. `onBeforeNavigate` is the last moment that is true:
  // by `onLoad` the route has begun resolving and by the time React commits the
  // DOM is the next screen.
  useEffect(() => {
    if (!isMobileApp()) return;
    return router.subscribe("onBeforeNavigate", (event) => {
      // A step that changes nothing visible is not a screen the user can swipe
      // back to - it is the one they are on.
      if (!event.hrefChanged) return;
      const from = event.fromLocation;
      if (from === undefined) return;
      const leaving = readHistoryEntryKey(from);
      if (leaving === null) return;
      const source = findSnapshotSource();
      if (source === null) return;
      const snapshot = captureScreenSnapshot(source);
      if (snapshot === null) return;
      rememberScreenSnapshot(leaving, snapshot);
    });
  }, [router]);

  useEffect(() => {
    return () => {
      settleRef.current?.stop();
      settleRef.current = null;
      // Up to four frozen DOM trees are held for the swipes this hook serves;
      // nothing else reads them, so they leave when it does. A remount refills
      // the cache on the next navigation, and a gesture that arrives before
      // then falls back to the instant step it already has.
      clearScreenSnapshots();
    };
  }, []);

  const beginDrag = useCallback(
    (direction: EdgeNavDirection): EdgeNavDragResponse => {
      const active = viewRef.current;
      if (active !== null) {
        // A settle that has not navigated yet is still just two frozen screens
        // travelling, so a finger arriving mid-flight takes them over from
        // wherever they had reached. One that HAS navigated cannot be taken
        // over: the app underneath is already the destination, and reversing
        // would mean navigating again - the cost this design exists to refuse.
        // Both refusals CONSUME the gesture rather than falling back to an
        // instant step: the step is already in flight (or its screens still
        // are), and a second navigation fired under the travelling layers is
        // exactly the stacking this surface exists to prevent.
        if (committedRef.current) return "decline";
        if (active.direction !== direction) return "decline";
        settleRef.current?.stop();
        settleRef.current = null;
        // The layers stay wherever the settle had carried them, and the new
        // pointer's travel is measured on top of that - not from rest.
        takeoverTravelPxRef.current = progress.get() * active.widthPx;
        return "follow";
      }
      // Direct manipulation is the finger, not motion the interface chose to
      // play - but the settle and the parallax are, and a reduced-motion
      // preference asks for neither. Standing down entirely leaves the instant
      // navigation this gesture has always performed.
      if (reducedMotionRef.current === true) return "instant";
      // The entry the NAVIGATION would land on, not the adjacent one: a
      // semantic step skips ineligible entries, so "one entry over" can be a
      // screen the commit never reaches - and a step nothing can resolve must
      // show nothing travelling.
      const destinationKey = resolveDestination(direction);
      if (destinationKey === null) return "instant";
      const destination = readScreenSnapshot(destinationKey);
      // No frozen destination: a cold start, a restored session, or the first
      // step of a run. Nothing is invented to slide in behind the finger.
      if (destination === null) return "instant";
      const source = findSnapshotSource();
      if (source === null) return "instant";
      const widthPx = source.clientWidth;
      if (widthPx <= 0) return "instant";
      const outgoing = captureScreenSnapshot(source);
      if (outgoing === null) return "instant";
      takeoverTravelPxRef.current = 0;
      progress.set(0);
      const next: SwipeNavTransitionView = {
        direction,
        outgoing,
        destination,
        widthPx,
        shape: SWIPE_NAV_SHAPE,
      };
      viewRef.current = next;
      setView(next);
      return "follow";
    },
    [progress, resolveDestination],
  );

  const updateDrag = useCallback(
    (travelPx: number): void => {
      const active = viewRef.current;
      if (active === null) return;
      const fraction =
        (takeoverTravelPxRef.current + travelPx) / active.widthPx;
      progress.set(Math.min(1, Math.max(0, fraction)));
    },
    [progress],
  );

  const endDrag = useCallback(
    (release: SwipeNavDragRelease): void => {
      const active = viewRef.current;
      if (active === null) return;
      settleRef.current?.stop();
      const commits = swipeNavCommits({
        // The distance the LAYERS have covered, not the distance this pointer
        // has: a takeover inherits the interrupted settle's travel, and a
        // release judged on the new pointer alone would spring back a screen
        // that is visibly most of the way there.
        travelPx: takeoverTravelPxRef.current + release.travelPx,
        widthPx: active.widthPx,
        velocityPxPerS: release.velocityPxPerS,
        cancelled: release.cancelled,
      });
      // Navigated at the START of the settle, not at its end. The live app
      // spends the settle rendering the destination behind two frozen screens
      // that already show it, so the layers come off onto a screen that is
      // finished rather than onto one that begins mounting at that instant.
      if (commits) {
        committedRef.current = true;
        navigateRef.current(active.direction);
      }
      settleRef.current = animate(progress, commits ? 1 : 0, {
        ...SWIPE_NAV_SETTLE,
        // Only an arrival takes the layers down. An interrupted settle was
        // overtaken by a new gesture, which owns them now.
        onComplete: clearView,
      });
    },
    [clearView, progress],
  );

  return { beginDrag, updateDrag, endDrag, view, progress };
}
