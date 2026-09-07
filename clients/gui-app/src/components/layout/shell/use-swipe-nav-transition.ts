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
  swipeNavCommits,
} from "@/components/layout/shell/swipe-nav-transition-motion";
import type { SwipeNavTransitionView } from "@/components/layout/shell/swipe-nav-transition-layers";
import type {
  EdgeNavDirection,
  EdgeNavDragResponse,
} from "@/components/layout/shell/use-edge-nav-swipe";
import { isMobileApp } from "@/lib/mobile-app";

/** Narrowed for the same reason `HistoryNavRouter` is - callers pass `useRouter` directly and a test supplies a
 * small fake without a cast. */
export interface SwipeNavRouter {
  readonly history: RouterHistory;
  subscribe(
    eventType: "onBeforeNavigate",
    fn: (event: RouterEvents["onBeforeNavigate"]) => void,
  ): () => void;
}

export interface SwipeNavDragRelease {
  readonly travelPx: number;
  readonly velocityPxPerS: number;
  /** The system ended the gesture rather than the user. */
  readonly cancelled: boolean;
}

export interface SwipeNavTransition {
  /** `decline` consumes the gesture entirely: a committed settle is already navigating, and an instant step fired
   * under it would stack a second navigation onto layers still showing the first. */
  readonly beginDrag: (direction: EdgeNavDirection) => EdgeNavDragResponse;
  readonly updateDrag: (travelPx: number) => void;
  readonly endDrag: (release: SwipeNavDragRelease) => void;
  /** Non-null exactly while frozen screens should be on top of the app. */
  readonly view: SwipeNavTransitionView | null;
  readonly progress: MotionValue<number>;
}

/** The app is never navigated until the release commits. The consequence is that both screens on display during
 * a drag are copies, and the destination copy is as old as the last time the user was on that screen. */
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
  // The new pointer measures its own travel from zero, but the layers it inherited are not at zero.
  const takeoverTravelPxRef = useRef(0);
  const navigateRef = useRef(navigate);
  const resolveDestinationRef = useRef(resolveDestination);
  const reducedMotion = useReducedMotion();
  const reducedMotionRef = useRef(reducedMotion);
  useEffect(() => {
    navigateRef.current = navigate;
    resolveDestinationRef.current = resolveDestination;
    reducedMotionRef.current = reducedMotion;
  });

  // A plain "any navigation during a committed settle" test would also catch a redirect off the landed entry, or
  // a programmatic navigation inside the settle window.
  const ownDepartureRef = useRef(false);

  const clearView = useCallback((): void => {
    settleRef.current = null;
    committedRef.current = false;
    ownDepartureRef.current = false;
    viewRef.current = null;
    setView(null);
  }, []);

  // `onBeforeNavigate` is the last moment that is true: by `onLoad` the route has begun resolving and by the
  // time React commits the DOM is the next screen.
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
      // One-shot, consumed by the first departure the commit causes.
      const active = viewRef.current;
      if (active !== null && ownDepartureRef.current) {
        ownDepartureRef.current = false;
        rememberScreenSnapshot(leaving, active.outgoing);
        return;
      }
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
      // A remount refills the cache on the next navigation, and a gesture that arrives before then falls back to the
      // instant step it already has.
      clearScreenSnapshots();
    };
  }, []);

  const beginDrag = useCallback(
    (direction: EdgeNavDirection): EdgeNavDragResponse => {
      const active = viewRef.current;
      if (active !== null) {
        // One that has navigated cannot be taken over: the app underneath is already the destination, and reversing
        // would mean navigating again - the cost this design exists to refuse.
        if (committedRef.current) return "decline";
        if (active.direction !== direction) return "decline";
        settleRef.current?.stop();
        settleRef.current = null;
        // The layers stay wherever the settle had carried them, and the new
        // pointer's travel is measured on top of that - not from rest.
        takeoverTravelPxRef.current = progress.get() * active.widthPx;
        return "follow";
      }
      // Standing down entirely leaves the instant navigation this gesture has always performed.
      if (reducedMotionRef.current === true) return "instant";
      // The entry the navigation would land on, not the adjacent one: a semantic step skips ineligible entries, so
      // "one entry over" can be a screen the commit never reaches.
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
        destinationKey,
        widthPx,
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
      let commits = swipeNavCommits({
        // The distance the layers have covered, not the distance this pointer has.
        travelPx: takeoverTravelPxRef.current + release.travelPx,
        widthPx: active.widthPx,
        velocityPxPerS: release.velocityPxPerS,
        cancelled: release.cancelled,
      });
      // Re-asked at the commit, and a changed answer turns the release into a spring-back: carrying the frozen
      // destination to completion and then navigating somewhere else - or nowhere.
      if (
        commits &&
        resolveDestinationRef.current(active.direction) !==
          active.destinationKey
      ) {
        commits = false;
      }
      if (commits) {
        committedRef.current = true;
        ownDepartureRef.current = true;
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
