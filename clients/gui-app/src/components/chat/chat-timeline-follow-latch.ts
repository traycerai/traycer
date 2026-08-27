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
   * Reconciles fresh strict-bottom geometry, otherwise re-issues
   * `list.scrollToEnd()` iff the latch currently grants permission. Call this
   * from every real LegendList maintain trigger (data change, item resize,
   * footer/header resize, viewport resize, content-inset change) - never from
   * a component's render body.
   */
  readonly followEndIfPermitted: () => void;
  /** Explicit controller transition (pill click / navigation fallback). */
  readonly setFollowIntent: (isFollowing: boolean) => void;
  /** Cancels any app-owned correction before a real reader gesture. */
  readonly noteReaderGesture: (intent: ChatTimelineReaderGestureIntent) => void;
  /** Owns an explicit animated/non-animated "go live" operation. */
  readonly beginOwnedEndNavigation: () => void;
  /** Arms an explicit programmatic navigation to publish free-scrolling only
   *  if its live geometry actually leaves the strict bottom. */
  readonly beginOwnedFreeNavigation: () => void;
  /** Releases a settled no-op free navigation that never left the strict end. */
  readonly completeOwnedFreeNavigation: () => void;
  /** Resolves owned navigation without letting its intermediate reports flap. */
  readonly completeOwnedEndNavigation: (didLandAtEnd: boolean) => void;
  /** Fresh DOM validation for explicit-navigation settle loops. */
  readonly isAtStrictEnd: () => boolean;
  /** Routes every native or library scroll report through this authority. */
  readonly observeLiveGeometry: () => void;
}

export type ChatTimelineReaderScrollDirection =
  | "away-from-end"
  | "toward-end"
  | "indeterminate";

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
}

interface ReaderEndCandidate {
  readonly readerGestureGeneration: number;
  readonly targetScrollTop: number;
}

type ArmedReaderDeparture =
  | {
      readonly source: "gesture";
      readonly direction: ChatTimelineReaderScrollDirection;
      /** False when fresh issue-time geometry proves this gesture cannot move
       *  in its requested direction (for example, wheel-up at scrollTop=0). */
      readonly blocksAutomaticCorrection: boolean;
    }
  | { readonly source: "owned-navigation" }
  | null;

/** One immediate issue plus four measured reissues, each after two frames.
 *  Exhaustion ends only the current correction burst; reader intent is never
 *  inferred from a layout operation failing to settle inside this window. */
export const CHAT_TIMELINE_FOLLOW_CORRECTION_MAX_ATTEMPTS = 5;

interface ChatTimelineFollowLatchOptions {
  readonly onFollowIntentChange: ((isFollowing: boolean) => void) | undefined;
  readonly onReaderGesture:
    | ((intent: ChatTimelineReaderGestureIntent) => void)
    | undefined;
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

function canReaderGestureMove(
  geometry: ChatTimelineScrollGeometry,
  direction: ChatTimelineReaderScrollDirection,
): boolean {
  if (direction === "indeterminate") return true;
  if (direction === "away-from-end") return geometry.scrollTop > 0;
  return geometry.scrollHeight - geometry.clientHeight - geometry.scrollTop > 0;
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
 *   scroll delivery both route through the same fresh DOM geometry observer.
 *   A non-bottom report revokes permission only when publishing reader input
 *   armed it; layout-owned scroll reports retain the current intent. While a
 *   movable gesture or owned free navigation is armed, maintain callbacks
 *   cannot create a correction that races and masks its pending scroll.
 *   `initialScrollAtEnd` seeds the ref once and never resets it.
 * - An app-owned correction carries a generation and reader-gesture token.
 *   Its intermediate non-bottom scroll reports cannot revoke permission;
 *   validation reissues after two-frame measurement windows with a bounded
 *   retry budget. Wheel/touch/key/pointer intent cancels ownership before its
 *   scroll report. Scroll direction during an owned correction is never used
 *   as reader-intent evidence because MVCP, ResizeObserver delivery, browser
 *   clamping, and content-inset compensation can all move `scrollTop` in the
 *   opposite direction without reader input.
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
  const [scrollNode, setScrollNode] = useState<HTMLElement | null>(null);
  const onFollowIntentChangeRef = useRef(onFollowIntentChange);
  const onReaderGestureRef = useRef(onReaderGesture);
  const correctionGenerationRef = useRef(0);
  const readerGestureGenerationRef = useRef(0);
  const armedReaderDepartureRef = useRef<ArmedReaderDeparture>(null);
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
      // Disarm only on an actual intent TRANSITION. An owned free navigation
      // (minimap/find/deep-link) arms departure while the viewport is still
      // latched at the bottom; an animated jump's first smooth-scroll frame
      // can report geometry still inside the strict-bottom epsilon, and that
      // report must not consume the armed flag - otherwise every subsequent
      // (genuinely departing) report reads as layout-owned and the latch
      // yanks the jump straight back to the tail.
      if (permissionRef.current === isFollowing) return;
      armedReaderDepartureRef.current = null;
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
      armedReaderDepartureRef.current = intent.publishesReaderPosition
        ? {
            source: "gesture",
            direction: intent.direction,
            // Unknown/hidden geometry cannot safely prove a no-op. When it is
            // measurable, an edge-directed gesture that cannot move must not
            // strand follow if no native scroll event is emitted.
            blocksAutomaticCorrection:
              geometry === null ||
              !isChatTimelineGeometryMeasurable(geometry) ||
              canReaderGestureMove(geometry, intent.direction),
          }
        : null;
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

  const createActiveCorrection = useCallback((): ActiveEndCorrection => {
    cancelActiveCorrection();
    const correction: ActiveEndCorrection = {
      generation: correctionGenerationRef.current + 1,
      readerGestureGeneration: readerGestureGenerationRef.current,
      attempts: 0,
      animationFrameId: null,
    };
    correctionGenerationRef.current = correction.generation;
    activeCorrectionRef.current = correction;
    return correction;
  }, [cancelActiveCorrection]);

  const startEndCorrection = useCallback(
    (list: LegendListRef, node: HTMLElement): void => {
      const correction = createActiveCorrection();

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
          // LegendList may still be settling a deferred web shrink, MVCP
          // adjustment, streaming row resize, or content-inset change. A
          // bounded correction is a CPU-safety mechanism, not evidence that
          // the reader left the tail. Retain permission; the final layout
          // callback (or the next stream mutation) will start a fresh burst.
          cancelActiveCorrection();
          return;
        }
        correction.attempts += 1;
        void list.scrollToEnd({ animated: false });
        scheduleValidation();
      };

      issue();
    },
    [cancelActiveCorrection, createActiveCorrection],
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
    // Explicit go-live supersedes any pending reader/free-navigation arm.
    armedReaderDepartureRef.current = null;
    setFollowIntent(true);
    createActiveCorrection();
  }, [createActiveCorrection, listRef, setFollowIntent]);

  const beginOwnedFreeNavigation = useCallback((): void => {
    cancelActiveCorrection();
    readerEndCandidateRef.current = null;
    armedReaderDepartureRef.current = { source: "owned-navigation" };
  }, [cancelActiveCorrection]);

  const completeOwnedFreeNavigation = useCallback((): void => {
    if (armedReaderDepartureRef.current?.source === "owned-navigation") {
      armedReaderDepartureRef.current = null;
    }
  }, []);

  const completeOwnedEndNavigation = useCallback(
    (didLandAtEnd: boolean): void => {
      cancelActiveCorrection();
      setFollowIntent(didLandAtEnd);
    },
    [cancelActiveCorrection, setFollowIntent],
  );

  const reconcileStrictBottom = useCallback(
    (isNativeScrollReport: boolean): void => {
      cancelActiveCorrection();
      readerEndCandidateRef.current = null;
      const armedDeparture = armedReaderDepartureRef.current;
      if (
        armedDeparture?.source === "gesture" &&
        (!armedDeparture.blocksAutomaticCorrection || isNativeScrollReport)
      ) {
        // Only issue-time geometry that proved this gesture cannot move can
        // release on a maintenance observation. A movable wheel/touch gesture
        // can still be awaiting its native scroll report, so treating unchanged
        // geometry as a no-op would let a subsequent maintain correction mask
        // the reader's departure. Once a native report confirms it remained at
        // the strict edge, though, release the arm so later streaming can follow.
        // Owned navigation deliberately survives: an animated free jump may
        // report a sub-epsilon first frame before it genuinely leaves the edge.
        armedReaderDepartureRef.current = null;
      }
      const isSuppressed = isCorrectionSuppressed?.() === true;
      const mayReleaseSuppression =
        isSuppressed && resolveSuppressedEndLanding?.() === true;
      const mayFollow = !isSuppressed || mayReleaseSuppression;
      setFollowIntent(mayFollow);
    },
    [
      cancelActiveCorrection,
      isCorrectionSuppressed,
      resolveSuppressedEndLanding,
      setFollowIntent,
    ],
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
      reconcileStrictBottom(true);
      return;
    }

    const correction = activeCorrectionRef.current;
    if (
      correction !== null &&
      correction.readerGestureGeneration === readerGestureGenerationRef.current
    ) {
      return;
    }
    if (tryReattachReader(node, geometry)) return;
    if (!permissionRef.current) return;
    if (armedReaderDepartureRef.current !== null) {
      armedReaderDepartureRef.current = null;
      setFollowIntent(false);
      return;
    }
    // A non-bottom scroll report with no publishing reader input is layout-
    // owned (MVCP, deferred row measurement, browser clamp, or inset
    // compensation). Preserve intent and immediately correct; waiting for a
    // separate maintain callback can leave the DOM parked away from the tail.
    if (isCorrectionSuppressed?.() === true) return;
    const list = listRef.current;
    if (list) startEndCorrection(list, node);
  }, [
    isCorrectionSuppressed,
    listRef,
    reconcileStrictBottom,
    setFollowIntent,
    startEndCorrection,
    tryReattachReader,
  ]);

  const followEndIfPermitted = useCallback((): void => {
    const list = listRef.current;
    const node = list?.getScrollableNode();
    if (!list || !node) return;
    const geometry = readScrollGeometry(node);
    if (!isChatTimelineGeometryMeasurable(geometry)) return;
    if (isChatTimelineAtStrictBottom(geometry)) {
      if (isCorrectionSuppressed?.() === true) {
        // A partial hydration restore may be temporarily clamped to its own
        // short snapshot's end. Maintenance is not reader evidence and must
        // not resolve that pending transaction; only a live scroll report can
        // validate its frozen target through `reconcileStrictBottom`.
        cancelActiveCorrection();
        return;
      }
      // Maintenance can be the only observable boundary after a collapsing
      // row or end-inset change passively clamps the DOM to the strict edge.
      // Reconcile before consulting permission so a stale false latch cannot
      // leave a jump pill visible when there is no useful bottom to reach.
      // This performs no imperative navigation, preserving destructive-clamp
      // behavior while allowing subsequent streaming growth to stay latched.
      reconcileStrictBottom(false);
      return;
    }
    if (!permissionRef.current) return;
    if (isCorrectionSuppressed?.() === true) return;
    const armedDeparture = armedReaderDepartureRef.current;
    if (
      armedDeparture?.source === "owned-navigation" ||
      armedDeparture?.blocksAutomaticCorrection === true
    ) {
      // Reader/free-navigation intent was published before its native scroll
      // report. Starting a correction here would inherit that gesture's
      // generation and then mask the departure as correction-owned.
      return;
    }

    startEndCorrection(list, node);
  }, [
    cancelActiveCorrection,
    isCorrectionSuppressed,
    listRef,
    reconcileStrictBottom,
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
    const completePointerPreflight = (): void => {
      const armedDeparture = armedReaderDepartureRef.current;
      if (
        armedDeparture?.source === "gesture" &&
        armedDeparture.direction === "indeterminate"
      ) {
        const liveNode = listRef.current?.getScrollableNode();
        const liveGeometry = liveNode ? readScrollGeometry(liveNode) : null;
        if (
          liveGeometry !== null &&
          isChatTimelineGeometryMeasurable(liveGeometry) &&
          !isChatTimelineAtStrictBottom(liveGeometry)
        ) {
          // A scrollbar drag can update live scrollTop before main-thread
          // pressure allows its coalesced native scroll event through. Publish
          // the already-visible departure now, while its arm is intact, so an
          // intervening ResizeObserver cannot classify it as layout-owned and
          // yank the viewport back to the tail.
          observeLiveGeometry();
          return;
        }
        // A click/release whose live geometry stayed at the strict edge was a
        // no-op and may emit no scroll event. Release only that preflight so a
        // later stream mutation can continue following normally.
        armedReaderDepartureRef.current = null;
      }
    };
    node.addEventListener("wheel", handleWheel, { passive: true });
    node.addEventListener("touchstart", handleTouchStart, { passive: true });
    node.addEventListener("touchmove", handleTouchMove, { passive: true });
    node.addEventListener("touchend", clearTouch, { passive: true });
    node.addEventListener("touchcancel", clearTouch, { passive: true });
    node.addEventListener("pointerup", completePointerPreflight, {
      passive: true,
    });
    node.addEventListener("pointercancel", completePointerPreflight, {
      passive: true,
    });
    // Viewport-layout trigger (divider drag / pane resize): fires with no
    // ChatTimeline render at all. Like every maintain trigger, it may heal a
    // stale false latch only when fresh geometry is already at the strict
    // edge; non-bottom geometry still preserves a detached reader's position.
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
      node.removeEventListener("pointerup", completePointerPreflight);
      node.removeEventListener("pointercancel", completePointerPreflight);
      resizeObserver.disconnect();
      cancelActiveCorrection();
    };
  }, [
    scrollNode,
    cancelActiveCorrection,
    followEndIfPermitted,
    listRef,
    noteReaderGesture,
    observeLiveGeometry,
  ]);

  return useMemo(
    () => ({
      followEndIfPermitted,
      setFollowIntent,
      noteReaderGesture,
      beginOwnedEndNavigation,
      beginOwnedFreeNavigation,
      completeOwnedFreeNavigation,
      completeOwnedEndNavigation,
      isAtStrictEnd,
      observeLiveGeometry,
    }),
    [
      beginOwnedEndNavigation,
      beginOwnedFreeNavigation,
      completeOwnedFreeNavigation,
      completeOwnedEndNavigation,
      followEndIfPermitted,
      isAtStrictEnd,
      noteReaderGesture,
      observeLiveGeometry,
      setFollowIntent,
    ],
  );
}
