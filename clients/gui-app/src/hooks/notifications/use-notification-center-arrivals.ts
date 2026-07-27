import { useCallback, useMemo, useState } from "react";
import type { MergedNotificationOccurrenceEntry } from "@/stores/notifications/merged-notifications";

export interface NotificationCenterArrivalsInput {
  /** Within the 8px top threshold - shares the exact flag the scroll-anchor
   * hook computes so both mechanisms agree on "at top". */
  readonly isAtTop: boolean;
  /** Full, unfiltered, newest-first occurrence order - the identity source
   * arrivals are detected against, independent of the active Recent filter. */
  readonly fullOrder: ReadonlyArray<MergedNotificationOccurrenceEntry>;
  /** Occurrence keys for what the current projection actually renders
   * (Attention, unfiltered, plus the filtered Recent projection) - the
   * arrival set is intersected against this to get the displayed count. */
  readonly visibleOccurrenceKeys: ReadonlyArray<string>;
}

export interface NotificationCenterArrivalsResult {
  readonly newCount: number;
  /** Clears the baseline - pair with the scroll-anchor's `scrollToTop()` at
   * the call site for the sticky affordance's click handler. */
  readonly reveal: () => void;
}

/**
 * Live arrivals in `currentEntries` relative to `previousEntries`, split by
 * two independent rules:
 *
 * - A `feedId` present in both with a CHANGED `occurrenceKey` is a genuine
 *   recurrence (a stable host/app-local ID re-emitted at a newer timestamp -
 *   e.g. a repeated approval or agent-stalled event) and always counts,
 *   regardless of position. The store holds at most one row per `feedId`
 *   (`applyUpsertFrame` replaces `byId[entry.id]` in place), so a recurrence's
 *   PRIOR occurrence key never survives into `currentEntries` for a
 *   positional comparison to find - it must be detected per-`feedId`, not by
 *   key membership. A retitle (same `feedId`, unchanged `occurrenceKey`)
 *   never reaches this branch, since the keys are equal.
 * - A brand-new `feedId` (absent from `previousEntries` entirely) counts only
 *   if it sorts ahead of wherever the previous front `feedId` now sits: a
 *   genuine live arrival is always the newest thing in the full chronological
 *   order, while an appended older page (Load more attention / Load older
 *   activity) can only ever land after everything already loaded. The
 *   reference point is the previous front's `feedId` (not its occurrence
 *   key), since a recurring front row keeps its `feedId` even as its own key
 *   changes - this keeps the positional split well-defined even when the
 *   front row itself recurred in the same update.
 *
 * Returns `[]` when `previousEntries` is empty (nothing loaded yet - not an
 * arrival).
 */
export function computeLiveArrivalKeys(
  previousEntries: ReadonlyArray<MergedNotificationOccurrenceEntry>,
  currentEntries: ReadonlyArray<MergedNotificationOccurrenceEntry>,
): ReadonlyArray<string> {
  if (previousEntries.length === 0) return [];
  const previousOccurrenceKeyByFeedId = new Map(
    previousEntries.map((entry) => [entry.feedId, entry.occurrenceKey]),
  );
  const previousFrontFeedId = previousEntries[0].feedId;
  const previousFrontIndexNow = currentEntries.findIndex(
    (entry) => entry.feedId === previousFrontFeedId,
  );

  const arrivals: string[] = [];
  currentEntries.forEach((entry, index) => {
    const priorOccurrenceKey = previousOccurrenceKeyByFeedId.get(entry.feedId);
    if (priorOccurrenceKey === entry.occurrenceKey) return;
    if (priorOccurrenceKey !== undefined) {
      arrivals.push(entry.occurrenceKey);
      return;
    }
    if (previousFrontIndexNow !== -1 && index < previousFrontIndexNow) {
      arrivals.push(entry.occurrenceKey);
    }
  });
  return arrivals;
}

/**
 * Post-baseline arrival tracking for the "N new" affordance. While at top,
 * newly observed occurrences join the baseline immediately (normal live
 * insertion, no count). While scrolled away, they accumulate in the arrival
 * set; the displayed count is that set intersected with the current
 * projection, so a filter change can only ever narrow or widen which
 * already-arrived rows are visible - never mint a pre-baseline row as new.
 *
 * Arrival-set bookkeeping happens directly in the render body via React's
 * "adjust state during render" recipe (the same pattern
 * `use-notification-center-geometry.ts` uses for its `open`-transition
 * reset) rather than an effect: comparing this render's occurrence order
 * against the previous one is a pure comparison, so it can land in the same
 * render as the data change instead of a follow-up effect pass. This is
 * plain `useState`, not a ref, precisely because that recipe requires
 * reading/writing the tracked "previous" value during render, which a ref
 * cannot do. Each branch only calls `setArrivalSet`/`setPreviousEntries` when
 * the value would actually change, so the conditional re-render this
 * triggers terminates immediately.
 */
export function useNotificationCenterArrivals(
  input: NotificationCenterArrivalsInput,
): NotificationCenterArrivalsResult {
  const [previousEntries, setPreviousEntries] =
    useState<ReadonlyArray<MergedNotificationOccurrenceEntry> | null>(null);
  const [arrivalSet, setArrivalSet] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  if (previousEntries !== input.fullOrder) {
    setPreviousEntries(input.fullOrder);
    if (!input.isAtTop && previousEntries !== null) {
      const liveArrivalKeys = computeLiveArrivalKeys(
        previousEntries,
        input.fullOrder,
      );
      if (liveArrivalKeys.length > 0) {
        setArrivalSet((prev) => {
          const next = new Set(prev);
          liveArrivalKeys.forEach((key) => next.add(key));
          return next;
        });
      }
    }
  }
  // At top, arrivals join the baseline immediately (handled implicitly by
  // the `previousEntries` update above) - the visible set must always read
  // empty here, covering both "nothing arrived" and a stale count left over
  // from before the reader scrolled back to top (which re-renders this hook
  // with an unchanged `fullOrder`, so it must be checked independently of
  // the order-change branch above).
  if (input.isAtTop && arrivalSet.size > 0) {
    setArrivalSet(new Set());
  }

  const visibleKeySet = useMemo(
    () => new Set(input.visibleOccurrenceKeys),
    [input.visibleOccurrenceKeys],
  );
  const newCount = useMemo(() => {
    let count = 0;
    arrivalSet.forEach((key) => {
      if (visibleKeySet.has(key)) count += 1;
    });
    return count;
  }, [arrivalSet, visibleKeySet]);

  const reveal = useCallback(() => {
    setArrivalSet((prev) => (prev.size === 0 ? prev : new Set()));
  }, []);

  return { newCount, reveal };
}
