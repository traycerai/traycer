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
 * - `permissionRef` is a plain ref (not React state) holding the single
 *   question this whole mechanism answers: "as of the last REAL geometry
 *   observation, was the reader at the strict edge?" It is written ONLY by a
 *   direct, own `passive` native `scroll` listener attached straight to the
 *   scrollable DOM node (not the library's `onScroll` prop - that path can be
 *   internally deferred by the library, per its own `shouldDeferPublicOnScroll`
 *   gate, so it is not a reliable synchronous signal) and by a `ResizeObserver`
 *   on that same node (the viewport-layout trigger). Every write recomputes
 *   fresh from LIVE `scrollTop`/`scrollHeight`/`clientHeight` - there is no
 *   baseline, no direction heuristic, no memory of any past position. This is
 *   what makes it sound: permission can only ever be exactly what the last
 *   real measurement said, so a reader who scrolls downward but stops short of
 *   the edge, or is nudged by a fraction of a pixel while still far away, or
 *   gets remapped by MVCP/virtualization, is read correctly every single time
 *   - there is nothing stale to be fooled by.
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
): ChatTimelineFollowLatch {
  const permissionRef = useRef(initialScrollAtEnd);
  const [scrollNode, setScrollNode] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    permissionRef.current = initialScrollAtEnd;
  }, [initialScrollAtEnd]);

  const followEndIfPermitted = useCallback((): void => {
    if (!permissionRef.current) return;
    // Skip when a fresh read shows the reader is ALREADY at the edge -
    // e.g. a destructive deletion the UA itself already clamped to the new
    // max. `scrollToEnd()` there would be a geometric no-op but still reads
    // as "the app issued imperative navigation" to anything watching the
    // list's own imperative API, which the destructive-mutation contract
    // ("no invented destination") explicitly forbids - passive landings are
    // not reader-earned follow, but they also need no correction.
    const node = listRef.current?.getScrollableNode();
    if (node) {
      const geometry = readScrollGeometry(node);
      if (
        isChatTimelineGeometryMeasurable(geometry) &&
        isChatTimelineAtStrictBottom(geometry)
      ) {
        return;
      }
    }
    void listRef.current?.scrollToEnd({ animated: false });
  }, [listRef]);

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

    const refreshPermissionFromLiveGeometry = (): void => {
      const geometry = readScrollGeometry(node);
      if (!isChatTimelineGeometryMeasurable(geometry)) return;
      permissionRef.current = isChatTimelineAtStrictBottom(geometry);
    };

    node.addEventListener("scroll", refreshPermissionFromLiveGeometry, {
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

    return () => {
      node.removeEventListener("scroll", refreshPermissionFromLiveGeometry);
      resizeObserver.disconnect();
    };
  }, [scrollNode, followEndIfPermitted]);

  return useMemo(() => ({ followEndIfPermitted }), [followEndIfPermitted]);
}
