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

/** Empty previousEntries is not an arrival. A new feedId counts only if it sorts ahead of the previous front feedId. */
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

/** Filter changes must not mint a pre-baseline row as new. Track arrivals in render-time useState, not a ref or an effect. */
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
  // At top, arrivals join the baseline immediately (handled implicitly by the `previousEntries` update above) - the visible set must always read empty here, covering both "nothing arrived" and a stale count left over from before the reader scrolled back to top (which re-renders this hook with an unchanged `fullOrder`, so it must be checked independently of the order-change branch above).
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
