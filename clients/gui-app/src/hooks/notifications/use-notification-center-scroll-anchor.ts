import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

/** Shared with N-new: within this many px of the top, new rows insert live
 * and the scroll-anchor correction must not run. */
export const NOTIFICATION_CENTER_SCROLL_TOP_THRESHOLD_PX = 8;

const FEED_ROW_ATTRIBUTE = "notificationId";

export interface NotificationCenterScrollAnchorInput {
  /** The rendered feed order (Attention ids, then Recent ids) - must match
   * DOM order exactly, since anchoring reads row positions by `feedId`. */
  readonly orderedFeedIds: ReadonlyArray<string>;
}

export interface NotificationCenterScrollAnchorResult {
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  /** Within the 8px top threshold - callers gate N-new baseline joins and
   * this hook's own compensation on the same flag so neither logic drifts
   * from the other's idea of "at top". */
  readonly isAtTop: boolean;
  readonly scrollToTop: () => void;
}

interface FeedRowMetrics {
  readonly offsetTopPx: number;
  readonly heightPx: number;
}

interface AnchorSnapshot {
  readonly feedId: string;
  readonly offsetTopPx: number;
}

/** One DOM read of every rendered row's position relative to the scrollport,
 * keyed by `feedId` - a single pass instead of one `querySelector` per
 * candidate row. */
export function collectFeedRowMetrics(
  scrollEl: HTMLElement,
): ReadonlyMap<string, FeedRowMetrics> {
  const scrollRect = scrollEl.getBoundingClientRect();
  const metrics = new Map<string, FeedRowMetrics>();
  const rows = scrollEl.querySelectorAll<HTMLElement>("[data-notification-id]");
  rows.forEach((row) => {
    const feedId = row.dataset[FEED_ROW_ATTRIBUTE];
    if (feedId === undefined) return;
    const rowRect = row.getBoundingClientRect();
    metrics.set(feedId, {
      offsetTopPx: rowRect.top - scrollRect.top,
      heightPx: rowRect.height,
    });
  });
  return metrics;
}

/** The first row (in render order) that is at least partially below the
 * scrollport's top edge - the topmost visible or partially-visible row. */
export function findFirstVisibleAnchor(
  orderedFeedIds: ReadonlyArray<string>,
  metrics: ReadonlyMap<string, FeedRowMetrics>,
): AnchorSnapshot | null {
  for (const feedId of orderedFeedIds) {
    const row = metrics.get(feedId);
    if (row === undefined) continue;
    if (row.offsetTopPx + row.heightPx > 0) {
      return { feedId, offsetTopPx: row.offsetTopPx };
    }
  }
  return null;
}

/**
 * `scrollTop` delta to keep the surviving anchor row visually fixed: the
 * same row if it survived, else the nearest surviving successor from its
 * prior position, else the nearest surviving predecessor. `null` when
 * nothing from the prior order survives at all.
 */
export function computeScrollAnchorCorrectionPx(input: {
  readonly previousAnchor: AnchorSnapshot;
  readonly previousOrderedFeedIds: ReadonlyArray<string>;
  readonly currentMetrics: ReadonlyMap<string, FeedRowMetrics>;
  /** scrollTop at the moment `previousAnchor` was captured, and now - folded
   * into the correction so a user scroll between commits isn't mistaken for
   * content shift and undone. */
  readonly previousScrollTop: number;
  readonly currentScrollTop: number;
}): number | null {
  const {
    previousAnchor,
    previousOrderedFeedIds,
    currentMetrics,
    previousScrollTop,
    currentScrollTop,
  } = input;
  const scrollDeltaPx = currentScrollTop - previousScrollTop;
  const exact = currentMetrics.get(previousAnchor.feedId);
  if (exact !== undefined) {
    return exact.offsetTopPx - previousAnchor.offsetTopPx + scrollDeltaPx;
  }
  const anchorIndex = previousOrderedFeedIds.indexOf(previousAnchor.feedId);
  if (anchorIndex === -1) return null;
  for (let i = anchorIndex + 1; i < previousOrderedFeedIds.length; i += 1) {
    const successor = currentMetrics.get(previousOrderedFeedIds[i]);
    if (successor !== undefined) {
      return successor.offsetTopPx - previousAnchor.offsetTopPx + scrollDeltaPx;
    }
  }
  for (let i = anchorIndex - 1; i >= 0; i -= 1) {
    const predecessor = currentMetrics.get(previousOrderedFeedIds[i]);
    if (predecessor !== undefined) {
      return (
        predecessor.offsetTopPx - previousAnchor.offsetTopPx + scrollDeltaPx
      );
    }
  }
  return null;
}

/**
 * Preserves the reader's visual place across live insertions, lifecycle
 * moves (read/resolution), and pagination: `overflow-anchor: none` stops the
 * browser's own heuristic from double-applying this explicit correction.
 * Each commit that changes `orderedFeedIds` re-measures every rendered row,
 * corrects `scrollTop` against the anchor captured from the PRIOR commit
 * (falling back to the nearest surviving successor, then predecessor, if
 * that exact row disappeared), then captures a fresh anchor for the next
 * commit. Skipped entirely within the 8px top threshold, where new rows must
 * insert live instead.
 */
export function useNotificationCenterScrollAnchor(
  input: NotificationCenterScrollAnchorInput,
): NotificationCenterScrollAnchorResult {
  const scrollRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<{
    readonly anchor: AnchorSnapshot;
    readonly orderedFeedIds: ReadonlyArray<string>;
    readonly scrollTop: number;
  } | null>(null);
  const [isAtTop, setIsAtTop] = useState(true);

  useLayoutEffect(() => {
    const scrollEl = scrollRef.current;
    if (scrollEl === null) return;
    const metrics = collectFeedRowMetrics(scrollEl);
    const previous = anchorRef.current;
    const currentScrollTop = scrollEl.scrollTop;
    if (
      previous !== null &&
      currentScrollTop > NOTIFICATION_CENTER_SCROLL_TOP_THRESHOLD_PX
    ) {
      const correction = computeScrollAnchorCorrectionPx({
        previousAnchor: previous.anchor,
        previousOrderedFeedIds: previous.orderedFeedIds,
        currentMetrics: metrics,
        previousScrollTop: previous.scrollTop,
        currentScrollTop,
      });
      if (correction !== null && correction !== 0) {
        scrollEl.scrollTop += correction;
      }
    }
    const nextAnchor = findFirstVisibleAnchor(input.orderedFeedIds, metrics);
    anchorRef.current =
      nextAnchor === null
        ? null
        : {
            anchor: nextAnchor,
            orderedFeedIds: input.orderedFeedIds,
            scrollTop: currentScrollTop,
          };
  }, [input.orderedFeedIds]);

  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (scrollEl === null) return;
    function handleScroll(): void {
      if (scrollEl === null) return;
      setIsAtTop(
        scrollEl.scrollTop <= NOTIFICATION_CENTER_SCROLL_TOP_THRESHOLD_PX,
      );
    }
    handleScroll();
    scrollEl.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      scrollEl.removeEventListener("scroll", handleScroll);
    };
  }, []);

  const scrollToTop = useCallback(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, []);

  return { scrollRef, isAtTop, scrollToTop };
}
