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
  readonly noteReaderGesture: () => void;
  /** Routes every native or library scroll report through this authority. */
  readonly observeLiveGeometry: () => void;
}

interface ActiveEndCorrection {
  readonly generation: number;
  readonly readerGestureGeneration: number;
  attempts: number;
  animationFrameId: number | null;
}

/** One immediate issue plus four measured reissues, each after two frames. */
export const CHAT_TIMELINE_FOLLOW_CORRECTION_MAX_ATTEMPTS = 5;

interface ChatTimelineFollowLatchOptions {
  readonly onFollowIntentChange: ((isFollowing: boolean) => void) | undefined;
  readonly isCorrectionSuppressed: (() => boolean) | undefined;
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
 *   retry budget. A real gesture cancels that ownership before its scroll
 *   report, so reader departure still revokes immediately.
 * - `followEndIfPermitted` is the ONE place that turns permission into an
 *   actual scroll: read the ref, and if true, call the list's own imperative
 *   `scrollToEnd`. Every real maintain trigger funnels through this same
 *   function - see `chat-timeline.tsx`'s wiring.
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
  const { onFollowIntentChange, isCorrectionSuppressed } = options;
  const permissionRef = useRef(initialScrollAtEnd);
  const [scrollNode, setScrollNode] = useState<HTMLElement | null>(null);
  const onFollowIntentChangeRef = useRef(onFollowIntentChange);
  const correctionGenerationRef = useRef(0);
  const readerGestureGenerationRef = useRef(0);
  const activeCorrectionRef = useRef<ActiveEndCorrection | null>(null);

  useLayoutEffect(() => {
    onFollowIntentChangeRef.current = onFollowIntentChange;
  }, [onFollowIntentChange]);

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

  const noteReaderGesture = useCallback((): void => {
    readerGestureGenerationRef.current += 1;
    cancelActiveCorrection();
  }, [cancelActiveCorrection]);

  const observeLiveGeometry = useCallback((): void => {
    const node = listRef.current?.getScrollableNode();
    if (!node) return;
    const geometry = readScrollGeometry(node);
    if (!isChatTimelineGeometryMeasurable(geometry)) return;
    if (isChatTimelineAtStrictBottom(geometry)) {
      cancelActiveCorrection();
      setFollowIntent(true);
      return;
    }

    const correction = activeCorrectionRef.current;
    const isOwnedIntermediateReport =
      correction !== null &&
      correction.readerGestureGeneration === readerGestureGenerationRef.current;
    if (isOwnedIntermediateReport) return;
    setFollowIntent(false);
  }, [cancelActiveCorrection, listRef, setFollowIntent]);

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

    cancelActiveCorrection();
    const correction: ActiveEndCorrection = {
      generation: correctionGenerationRef.current + 1,
      readerGestureGeneration: readerGestureGenerationRef.current,
      attempts: 0,
      animationFrameId: null,
    };
    correctionGenerationRef.current = correction.generation;
    activeCorrectionRef.current = correction;

    const isCurrent = (): boolean =>
      activeCorrectionRef.current?.generation === correction.generation &&
      permissionRef.current &&
      readerGestureGenerationRef.current === correction.readerGestureGeneration;

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
        correction.animationFrameId = requestAnimationFrame(validateAndReissue);
      });
    };

    const issue = (): void => {
      if (!isCurrent()) return;
      if (correction.attempts >= CHAT_TIMELINE_FOLLOW_CORRECTION_MAX_ATTEMPTS) {
        cancelActiveCorrection();
        return;
      }
      correction.attempts += 1;
      void list.scrollToEnd({ animated: false });
      scheduleValidation();
    };

    issue();
  }, [cancelActiveCorrection, isCorrectionSuppressed, listRef]);

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
      resizeObserver.disconnect();
      cancelActiveCorrection();
    };
  }, [
    scrollNode,
    cancelActiveCorrection,
    followEndIfPermitted,
    observeLiveGeometry,
  ]);

  return useMemo(
    () => ({
      followEndIfPermitted,
      setFollowIntent,
      noteReaderGesture,
      observeLiveGeometry,
    }),
    [
      followEndIfPermitted,
      noteReaderGesture,
      observeLiveGeometry,
      setFollowIntent,
    ],
  );
}
