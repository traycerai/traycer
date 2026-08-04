import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { LegendListRef } from "@legendapp/list/react";

/** Matches the library's own strict-edge tolerance (`EDGE_POSITION_EPSILON`
 *  in `@legendapp/list`), so "at the strict bottom" means the same thing on
 *  both sides. */
export const CHAT_TIMELINE_STRICT_BOTTOM_EPSILON_PX = 1;

export interface ChatTimelineScrollGeometry {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/**
 * A `display:none` (or not-yet-laid-out) pane reports `scrollTop=
 * scrollHeight=clientHeight=0`. That is UNKNOWN geometry, never a confirmed
 * edge - treating it as "at the bottom" would let a restored free-reading
 * position get silently overwritten the moment the pane becomes visible
 * again (fixup review P1 finding 3).
 */
export function isChatTimelineGeometryMeasurable(
  geometry: ChatTimelineScrollGeometry,
): boolean {
  return geometry.clientHeight > 0;
}

export function isChatTimelineAtStrictBottom(
  geometry: ChatTimelineScrollGeometry,
): boolean {
  return (
    geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight <=
    CHAT_TIMELINE_STRICT_BOTTOM_EPSILON_PX
  );
}

export interface ChatTimelineFollowLatch {
  /**
   * Imperatively re-issues `list.scrollToEnd()` iff the latch currently
   * grants strict-bottom permission - a no-op otherwise. Call this from
   * every real LegendList maintain trigger (data change, item resize,
   * footer/header resize, viewport resize, content-inset change) - never
   * from a component's render body.
   */
  readonly followEndIfPermitted: () => void;
  /** Explicit controller transition (pill click / navigation fallback). */
  readonly setFollowIntent: (isFollowing: boolean) => void;
  /** Cancels any app-owned correction before a real reader gesture. */
  readonly noteReaderGesture: (intent: ChatTimelineReaderGestureIntent) => void;
  /** Owns an explicit animated/non-animated "go live" operation. */
  readonly beginOwnedEndNavigation: () => void;
  /** Resolves owned navigation without letting its intermediate reports flap. */
  readonly completeOwnedEndNavigation: (didLandAtEnd: boolean) => void;
  /** Fresh DOM validation for explicit-navigation settle loops. */
  readonly isAtStrictEnd: () => boolean;
  /** Routes every native or library scroll report through this authority. */
  readonly observeLiveGeometry: () => void;
}

export type ChatTimelineReaderScrollDirection =
  "away-from-end" | "toward-end" | "indeterminate";

export interface ChatTimelineReaderGestureIntent {
  readonly direction: ChatTimelineReaderScrollDirection;
  readonly freezeInFlightScroll: boolean;
  readonly publishesReaderPosition: boolean;
}

interface ActiveEndCorrection {
  readonly generation: number;
  readonly readerGestureGeneration: number;
  attempts: number;
  animationFrameId: number | null;
  highWaterScrollTop: number;
}

interface ReaderEndCandidate {
  readonly readerGestureGeneration: number;
  readonly targetScrollTop: number;
}

/** One immediate issue plus four measured reissues, each after two frames. */
export const CHAT_TIMELINE_FOLLOW_CORRECTION_MAX_ATTEMPTS = 5;

interface ChatTimelineFollowLatchOptions {
  readonly onFollowIntentChange: ((isFollowing: boolean) => void) | undefined;
  readonly onReaderGesture:
    ((intent: ChatTimelineReaderGestureIntent) => void) | undefined;
  readonly isCorrectionSuppressed: (() => boolean) | undefined;
  readonly resolveSuppressedEndLanding: (() => boolean) | undefined;
}

function readScrollGeometry(node: HTMLElement): ChatTimelineScrollGeometry {
  return {
    scrollTop: node.scrollTop,
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
  };
}

/**
 * Fixup (fix-detached-streaming-yank/callback-synchronous-follow): replaces
 * the rejected render-gated `maintainScrollAtEnd` design entirely.
 *
 * The installed `@legendapp/list` source shows every one of its own
 * `doMaintainScrollAtEnd` call sites (data change, item-layout, footer-
 * layout, viewport-layout) gates on `state.props.maintainScrollAtEnd` being
 * truthy, then reads a CACHED `isWithinMaintainScrollAtEndThreshold` signal
 * that only the library's own (rAF-coalesced) scroll processing refreshes -
 * never a fresh geometry read. A previous fix tried to keep the library's
 * own `maintainScrollAtEnd` and gate the PROP value by a React-render-time
 * check; review rejected it for three independent reasons: (1) item-size,
 * footer-size, and viewport-layout measurement all call
 * `doMaintainScrollAtEnd` directly, with no intervening `ChatTimeline`
 * render to re-evaluate a render-gated prop; (2) a numeric "did scrollTop
 * decrease since some remembered baseline" heuristic is not sound bottom
 * ownership - a reader can detach, drift downward without ever reaching the
 * edge, and still read as "following" against a stale baseline; (3) mutating
 * a ref inside a `useSyncExternalStore` snapshot is impure and can retain
 * state from an abandoned/retried render.
 *
 * This version disables the library's own `maintainScrollAtEnd` UNCONDITIONALLY
 * (chat-timeline.tsx never passes it at all) - since every one of the library's
 * own call sites already no-ops when that prop is falsy, this makes
 * `doMaintainScrollAtEnd` categorically unreachable from ANY of those four
 * triggers, independent of render timing or cache freshness. Bottom-follow is
 * reimplemented here instead, owned entirely by the app:
 *
 * - `permissionRef` is the single live follow authority. Native and LegendList
 *   scroll delivery both route through the same fresh DOM geometry observer;
 *   the latter closes bootstrap ordering gaps without introducing another
 *   state owner. `initialScrollAtEnd` seeds the ref once and never resets it.
 * - An app-owned correction carries a generation and reader-gesture token.
 *   Its intermediate non-bottom scroll reports cannot revoke permission;
 *   validation reissues after two-frame measurement windows with a bounded
 *   retry budget. Wheel/touch/key intent cancels ownership before its scroll
 *   report; opposed scrollTop motion also detects OS-scrollbar departures
 *   that have no precursor event, so reader departure revokes immediately.
 * - `followEndIfPermitted` is the one automatic path that turns permission
 *   into an actual scroll. Explicit go-live navigation declares its own
 *   ownership through the same latch and uses the same fresh-DOM authority.
 *   Every real maintain trigger funnels through `followEndIfPermitted` - see
 *   `chat-timeline.tsx`'s wiring.
 * - Both the listener and the observer skip unmeasurable geometry
 *   (`clientHeight === 0`, e.g. a `display:none` pane) rather than treating it
 *   as a confirmed edge - the permission ref is simply left as whatever it
 *   last legitimately was.
 *
 * Nothing here reads or writes `permissionRef` during render - the ref is
 * only ever touched inside an event handler (`scroll`/`ResizeObserver`
 * callback) or an effect, so there is no "which speculative render committed
 * this write" ambiguity for React to retry or abandon.
 */
export function useChatTimelineFollowLatch(
  listRef: RefObject<LegendListRef | null>,
  initialScrollAtEnd: boolean,
  hasRows: boolean,
  options: ChatTimelineFollowLatchOptions,
): ChatTimelineFollowLatch {
  const {
    onFollowIntentChange,
    onReaderGesture,
    isCorrectionSuppressed,
    resolveSuppressedEndLanding,
  } = options;
  const permissionRef = useRef(initialScrollAtEnd);
  const hasConfirmedStrictEndRef = useRef(false);
  const [scrollNode, setScrollNode] = useState<HTMLElement | null>(null);
  const onFollowIntentChangeRef = useRef(onFollowIntentChange);
  const onReaderGestureRef = useRef(onReaderGesture);
  const correctionGenerationRef = useRef(0);
  const readerGestureGenerationRef = useRef(0);
  const activeCorrectionRef = useRef<ActiveEndCorrection | null>(null);
  const readerEndCandidateRef = useRef<ReaderEndCandidate | null>(null);
  const lastTouchClientYRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    onFollowIntentChangeRef.current = onFollowIntentChange;
  }, [onFollowIntentChange]);

  useLayoutEffect(() => {
    onReaderGestureRef.current = onReaderGesture;
  }, [onReaderGesture]);

  const cancelActiveCorrection = useCallback((): void => {
    const correction = activeCorrectionRef.current;
    if (correction !== null && correction.animationFrameId !== null) {
      cancelAnimationFrame(correction.animationFrameId);
    }
    activeCorrectionRef.current = null;
  }, []);

  const setFollowIntent = useCallback(
    (isFollowing: boolean): void => {
      if (!isFollowing) cancelActiveCorrection();
      if (permissionRef.current === isFollowing) return;
      permissionRef.current = isFollowing;
      onFollowIntentChangeRef.current?.(isFollowing);
    },
    [cancelActiveCorrection],
  );

  const noteReaderGesture = useCallback(
    (intent: ChatTimelineReaderGestureIntent): void => {
      readerGestureGenerationRef.current += 1;
      cancelActiveCorrection();
      const node = listRef.current?.getScrollableNode();
      const geometry = node ? readScrollGeometry(node) : null;
      readerEndCandidateRef.current =
        intent.direction === "toward-end" &&
        geometry !== null &&
        isChatTimelineGeometryMeasurable(geometry)
          ? {
              readerGestureGeneration: readerGestureGenerationRef.current,
              targetScrollTop: Math.max(
                0,
                geometry.scrollHeight - geometry.clientHeight,
              ),
            }
          : null;
      onReaderGestureRef.current?.(intent);
    },
    [cancelActiveCorrection, listRef],
  );

  const captureActiveCorrectionHighWater = useCallback((): void => {
    const correction = activeCorrectionRef.current;
    const node = listRef.current?.getScrollableNode();
    if (correction === null || !node) return;
    correction.highWaterScrollTop = Math.max(
      correction.highWaterScrollTop,
      node.scrollTop,
    );
  }, [listRef]);

  const createActiveCorrection = useCallback(
    (node: HTMLElement): ActiveEndCorrection => {
      cancelActiveCorrection();
      const correction: ActiveEndCorrection = {
        generation: correctionGenerationRef.current + 1,
        readerGestureGeneration: readerGestureGenerationRef.current,
        attempts: 0,
        animationFrameId: null,
        highWaterScrollTop: node.scrollTop,
      };
      correctionGenerationRef.current = correction.generation;
      activeCorrectionRef.current = correction;
      return correction;
    },
    [cancelActiveCorrection],
  );

  const startEndCorrection = useCallback(
    (list: LegendListRef, node: HTMLElement): void => {
      const correction = createActiveCorrection(node);

      const isCurrent = (): boolean =>
        activeCorrectionRef.current?.generation === correction.generation &&
        permissionRef.current &&
        readerGestureGenerationRef.current ===
          correction.readerGestureGeneration;

      const validateAndReissue = (): void => {
        correction.animationFrameId = null;
        if (!isCurrent()) return;
        const liveGeometry = readScrollGeometry(node);
        if (!isChatTimelineGeometryMeasurable(liveGeometry)) {
          cancelActiveCorrection();
          return;
        }
        if (isChatTimelineAtStrictBottom(liveGeometry)) {
          cancelActiveCorrection();
          return;
        }
        issue();
      };

      const scheduleValidation = (): void => {
        correction.animationFrameId = requestAnimationFrame(() => {
          if (!isCurrent()) return;
          correction.animationFrameId =
            requestAnimationFrame(validateAndReissue);
        });
      };

      const issue = (): void => {
        if (!isCurrent()) return;
        if (
          correction.attempts >= CHAT_TIMELINE_FOLLOW_CORRECTION_MAX_ATTEMPTS
        ) {
          // A mount seed may begin correcting before LegendList has finished
          // its own initial measurement/positioning. Do not turn that
          // bootstrap ordering into a reader-visible departure. Once this
          // mount has confirmed a real strict edge, however, an exhausted
          // correction is an honest loss of follow and must surface the pill.
          if (hasConfirmedStrictEndRef.current) setFollowIntent(false);
          else cancelActiveCorrection();
          return;
        }
        correction.attempts += 1;
        void list.scrollToEnd({ animated: false });
        captureActiveCorrectionHighWater();
        scheduleValidation();
      };

      issue();
    },
    [
      cancelActiveCorrection,
      captureActiveCorrectionHighWater,
      createActiveCorrection,
      setFollowIntent,
    ],
  );

  const isAtStrictEnd = useCallback((): boolean => {
    const node = listRef.current?.getScrollableNode();
    if (!node) return false;
    const geometry = readScrollGeometry(node);
    return (
      isChatTimelineGeometryMeasurable(geometry) &&
      isChatTimelineAtStrictBottom(geometry)
    );
  }, [listRef]);

  const beginOwnedEndNavigation = useCallback((): void => {
    const node = listRef.current?.getScrollableNode();
    if (!node) return;
    setFollowIntent(true);
    createActiveCorrection(node);
  }, [createActiveCorrection, listRef, setFollowIntent]);

  const completeOwnedEndNavigation = useCallback(
    (didLandAtEnd: boolean): void => {
      cancelActiveCorrection();
      setFollowIntent(didLandAtEnd);
    },
    [cancelActiveCorrection, setFollowIntent],
  );

  const reconcileStrictBottom = useCallback((): void => {
    cancelActiveCorrection();
    readerEndCandidateRef.current = null;
    const isSuppressed = isCorrectionSuppressed?.() === true;
    const mayReleaseSuppression =
      isSuppressed && resolveSuppressedEndLanding?.() === true;
    const mayFollow = !isSuppressed || mayReleaseSuppression;
    if (mayFollow) hasConfirmedStrictEndRef.current = true;
    setFollowIntent(mayFollow);
  }, [
    cancelActiveCorrection,
    isCorrectionSuppressed,
    resolveSuppressedEndLanding,
    setFollowIntent,
  ]);

  const handleOwnedCorrectionReport = useCallback(
    (
      correction: ActiveEndCorrection | null,
      geometry: ChatTimelineScrollGeometry,
    ): boolean => {
      if (
        correction === null ||
        correction.readerGestureGeneration !==
          readerGestureGenerationRef.current
      ) {
        return false;
      }
      if (
        geometry.scrollTop <
        correction.highWaterScrollTop - CHAT_TIMELINE_STRICT_BOTTOM_EPSILON_PX
      ) {
        noteReaderGesture({
          direction: "away-from-end",
          freezeInFlightScroll: true,
          publishesReaderPosition: true,
        });
        setFollowIntent(false);
        return true;
      }
      correction.highWaterScrollTop = Math.max(
        correction.highWaterScrollTop,
        geometry.scrollTop,
      );
      return true;
    },
    [noteReaderGesture, setFollowIntent],
  );

  const tryReattachReader = useCallback(
    (node: HTMLElement, geometry: ChatTimelineScrollGeometry): boolean => {
      const readerCandidate = readerEndCandidateRef.current;
      const reachedGestureStartEnd =
        readerCandidate !== null &&
        readerCandidate.readerGestureGeneration ===
          readerGestureGenerationRef.current &&
        geometry.scrollTop >=
          readerCandidate.targetScrollTop -
            CHAT_TIMELINE_STRICT_BOTTOM_EPSILON_PX;
      if (!reachedGestureStartEnd || isCorrectionSuppressed?.() === true) {
        return false;
      }
      readerEndCandidateRef.current = null;
      setFollowIntent(true);
      const list = listRef.current;
      if (list) startEndCorrection(list, node);
      return true;
    },
    [isCorrectionSuppressed, listRef, setFollowIntent, startEndCorrection],
  );

  const observeLiveGeometry = useCallback((): void => {
    const node = listRef.current?.getScrollableNode();
    if (!node) return;
    const geometry = readScrollGeometry(node);
    if (!isChatTimelineGeometryMeasurable(geometry)) return;
    if (isChatTimelineAtStrictBottom(geometry)) {
      reconcileStrictBottom();
      return;
    }

    if (handleOwnedCorrectionReport(activeCorrectionRef.current, geometry))
      return;
    if (tryReattachReader(node, geometry)) return;
    setFollowIntent(false);
  }, [
    handleOwnedCorrectionReport,
    listRef,
    reconcileStrictBottom,
    setFollowIntent,
    tryReattachReader,
  ]);

  const followEndIfPermitted = useCallback((): void => {
    if (!permissionRef.current) return;
    if (isCorrectionSuppressed?.() === true) return;
    // Skip when a fresh read shows the reader is ALREADY at the edge -
    // e.g. a destructive deletion the UA itself already clamped to the new
    // max. `scrollToEnd()` there would be a geometric no-op but still reads
    // as "the app issued imperative navigation" to anything watching the
    // list's own imperative API, which the destructive-mutation contract
    // ("no invented destination") explicitly forbids - passive landings are
    // not reader-earned follow, but they also need no correction.
    const list = listRef.current;
    const node = list?.getScrollableNode();
    if (!list || !node) return;
    const geometry = readScrollGeometry(node);
    if (!isChatTimelineGeometryMeasurable(geometry)) return;
    if (isChatTimelineAtStrictBottom(geometry)) {
      cancelActiveCorrection();
      return;
    }

    startEndCorrection(list, node);
  }, [
    cancelActiveCorrection,
    isCorrectionSuppressed,
    listRef,
    startEndCorrection,
  ]);

  // The empty state does not mount LegendList. Re-resolve when the rendered
  // timeline crosses that boundary so the first row attaches the listener,
  // and returning to empty cleans it up.
  useLayoutEffect(() => {
    const current = listRef.current?.getScrollableNode() ?? null;
    setScrollNode((previous) => (previous === current ? previous : current));
  }, [listRef, hasRows]);

  useLayoutEffect(() => {
    const node = scrollNode;
    if (!node) return;

    node.addEventListener("scroll", observeLiveGeometry, {
      passive: true,
    });
    const handleWheel = (event: WheelEvent): void => {
      if (event.deltaY === 0) return;
      noteReaderGesture({
        direction: event.deltaY > 0 ? "toward-end" : "away-from-end",
        freezeInFlightScroll: true,
        publishesReaderPosition: true,
      });
    };
    const handleTouchStart = (event: TouchEvent): void => {
      lastTouchClientYRef.current = event.touches.item(0)?.clientY ?? null;
    };
    const handleTouchMove = (event: TouchEvent): void => {
      const clientY = event.touches.item(0)?.clientY;
      const previousClientY = lastTouchClientYRef.current;
      if (clientY === undefined || previousClientY === null) return;
      lastTouchClientYRef.current = clientY;
      if (clientY === previousClientY) return;
      noteReaderGesture({
        direction: clientY < previousClientY ? "toward-end" : "away-from-end",
        freezeInFlightScroll: true,
        publishesReaderPosition: true,
      });
    };
    const clearTouch = (): void => {
      lastTouchClientYRef.current = null;
    };
    node.addEventListener("wheel", handleWheel, { passive: true });
    node.addEventListener("touchstart", handleTouchStart, { passive: true });
    node.addEventListener("touchmove", handleTouchMove, { passive: true });
    node.addEventListener("touchend", clearTouch, { passive: true });
    node.addEventListener("touchcancel", clearTouch, { passive: true });
    // Viewport-layout trigger (divider drag / pane resize): fires with no
    // ChatTimeline render at all. Deliberately does NOT also refresh
    // permission from the post-resize geometry - a container resize alone
    // (clientHeight changing with scrollTop untouched) moves the strict-edge
    // distance exactly like content growth does, for the same reason: it is
    // not reader motion. Only an ACTUAL scrollTop change (the scroll
    // listener above) is trusted to grant or revoke permission; a resize is
    // purely a maintain TRIGGER that re-consults whatever permission already
    // holds.
    const resizeObserver = new ResizeObserver(() => {
      followEndIfPermitted();
    });
    resizeObserver.observe(node);
    followEndIfPermitted();

    return () => {
      node.removeEventListener("scroll", observeLiveGeometry);
      node.removeEventListener("wheel", handleWheel);
      node.removeEventListener("touchstart", handleTouchStart);
      node.removeEventListener("touchmove", handleTouchMove);
      node.removeEventListener("touchend", clearTouch);
      node.removeEventListener("touchcancel", clearTouch);
      resizeObserver.disconnect();
      cancelActiveCorrection();
    };
  }, [
    scrollNode,
    cancelActiveCorrection,
    followEndIfPermitted,
    noteReaderGesture,
    observeLiveGeometry,
  ]);

  return useMemo(
    () => ({
      followEndIfPermitted,
      setFollowIntent,
      noteReaderGesture,
      beginOwnedEndNavigation,
      completeOwnedEndNavigation,
      isAtStrictEnd,
      observeLiveGeometry,
    }),
    [
      beginOwnedEndNavigation,
      completeOwnedEndNavigation,
      followEndIfPermitted,
      isAtStrictEnd,
      noteReaderGesture,
      observeLiveGeometry,
      setFollowIntent,
    ],
  );
}
