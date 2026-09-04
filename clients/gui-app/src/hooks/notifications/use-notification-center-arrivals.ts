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
 *   if it sorts ahead of wherever the previous front `feedId` of ITS OWN PLANE
 *   now sits: a genuine live arrival is always the newest thing in its lane's
 *   chronological order, while an appended older page (Load more attention /
 *   Load older activity) can only ever land after everything already loaded.
 *   The reference point is the previous front's `feedId` (not its occurrence
 *   key), since a recurring front row keeps its `feedId` even as its own key
 *   changes - this keeps the positional split well-defined even when the
 *   front row itself recurred in the same update.
 *
 * ## Why the positional rule is PER PLANE
 *
 * Mixed mode is two ordered lanes concatenated, not one clock: every local row
 * precedes every cloud row regardless of timestamp, because `updatedAt` means
 * different things in the two origins. A single global front therefore made
 * the rule unsatisfiable for the trailing lane - with any local row loaded, a
 * brand-new cloud occurrence lands after the global front by construction and
 * read as paginated history, so live cloud arrivals never reached the "N new"
 * affordance while the reader was scrolled away. Comparing within the lane
 * restores the meaning the rule had when there was only one.
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
  // Each lane's own prior rows IN ORDER, and each lane's own position index. A
  // lane the reader has nothing loaded from has no boundary, so its first rows
  // are a first page rather than an arrival - the same rule the whole list
  // already had.
  //
  // The whole ordered lane rather than just its front, because the front is the
  // boundary only while it SURVIVES. A cloud snapshot is an authoritative
  // replacement, so one pass can drop the previous front and introduce a new
  // row together - another window clearing the old front while a notification
  // lands. Anchoring on the front alone then found no boundary at all and
  // rejected every genuinely new row in that lane, so a reader scrolled away
  // got no "N new" affordance for arrivals `applySnapshot()` had really
  // installed.
  const previousFeedIdsByPlane = new Map<string, string[]>();
  for (const entry of previousEntries) {
    const plane = arrivalPlaneOf(entry.feedId);
    const lane = previousFeedIdsByPlane.get(plane);
    if (lane === undefined) {
      previousFeedIdsByPlane.set(plane, [entry.feedId]);
      continue;
    }
    lane.push(entry.feedId);
  }
  const indexWithinPlane = new Map<string, number>();
  const planeIndexByEntry: number[] = [];
  const planeOfEntry: string[] = [];
  currentEntries.forEach((entry) => {
    const plane = arrivalPlaneOf(entry.feedId);
    const next = indexWithinPlane.get(plane) ?? 0;
    indexWithinPlane.set(plane, next + 1);
    planeIndexByEntry.push(next);
    planeOfEntry.push(plane);
  });
  const currentPlaneIndexByFeedId = new Map<string, number>();
  currentEntries.forEach((entry, index) => {
    currentPlaneIndexByFeedId.set(entry.feedId, planeIndexByEntry[index]);
  });
  // The first prior row of the lane that is still on screen. It sat behind
  // every arrival exactly as the front did, so the positional rule below is
  // unchanged - only its ANCHOR is now one a removal cannot delete. The front
  // is still chosen whenever it survived, which is every ordinary pass.
  //
  // A lane whose prior rows are ALL gone still yields no boundary, and that
  // stays deliberate: nothing distinguishes a wholesale replacement from a
  // fresh baseline positionally, and calling a first page "N new" is the
  // louder mistake.
  const previousFrontIndexByPlane = new Map<string, number>();
  for (const [plane, laneFeedIds] of previousFeedIdsByPlane) {
    for (const feedId of laneFeedIds) {
      const planeIndex = currentPlaneIndexByFeedId.get(feedId);
      if (planeIndex === undefined) continue;
      previousFrontIndexByPlane.set(plane, planeIndex);
      break;
    }
  }

  const arrivals: string[] = [];
  currentEntries.forEach((entry, index) => {
    const priorOccurrenceKey = previousOccurrenceKeyByFeedId.get(entry.feedId);
    if (priorOccurrenceKey === entry.occurrenceKey) return;
    if (priorOccurrenceKey !== undefined) {
      arrivals.push(entry.occurrenceKey);
      return;
    }
    const previousFrontIndex = previousFrontIndexByPlane.get(
      planeOfEntry[index],
    );
    if (
      previousFrontIndex !== undefined &&
      planeIndexByEntry[index] < previousFrontIndex
    ) {
      arrivals.push(entry.occurrenceKey);
    }
  });
  return arrivals;
}

/**
 * Which ordered lane a feed id belongs to.
 *
 * Derived from the id rather than passed in: `MergedNotificationOccurrenceEntry`
 * is deliberately just `(feedId, occurrenceKey)`, and the `cloud:` prefix is
 * the same discriminator `parseFeedId` reads. Host / app-local / global rows
 * are one interleaved lane (the protocol's `local` home), matching how
 * `useMergedNotificationRows` concatenates them.
 */
function arrivalPlaneOf(feedId: string): string {
  return feedId.startsWith("cloud:") ? "cloud" : "local";
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
