/**
 * Categorical color assignment for the per-day chart's harness breakdown.
 *
 * Fixed hue order per the dataviz skill's color-formula: eight slots,
 * assigned in first-appearance order (not sorted, not by volume - stable
 * across a refetch as long as the same harnesses are present), never
 * cycled. Past eight distinct harnesses, the tail folds into "Other" rather
 * than generating a ninth hue - a generated color is indistinguishable from
 * an existing one under CVD and breaks every validated-palette check.
 */
export const USAGE_SERIES_SLOT_COUNT = 8;
export const USAGE_SERIES_OTHER_KEY = "__usage_series_other__";

export interface UsageSeriesScale {
  /** Series keys in slot order - real harness ids, plus the "Other" sentinel if any harness overflowed. */
  readonly order: readonly string[];
  /** CSS `var(...)` reference for a series key - falls back to the "Other" token for an unrecognized key. */
  readonly colorVar: (seriesKey: string) => string;
  /** Display label - the raw harness id (no invented display-name catalog), or "Other". */
  readonly labelFor: (seriesKey: string) => string;
}

export function buildUsageSeriesScale(
  harnessIdsInFirstAppearanceOrder: readonly string[],
): UsageSeriesScale {
  const primary = harnessIdsInFirstAppearanceOrder.slice(
    0,
    USAGE_SERIES_SLOT_COUNT,
  );
  const overflow = harnessIdsInFirstAppearanceOrder.slice(
    USAGE_SERIES_SLOT_COUNT,
  );
  const order =
    overflow.length > 0 ? [...primary, USAGE_SERIES_OTHER_KEY] : primary;
  const slotIndex = new Map(primary.map((id, index) => [id, index]));

  return {
    order,
    colorVar: (seriesKey) => {
      if (seriesKey === USAGE_SERIES_OTHER_KEY) {
        return "var(--usage-series-other)";
      }
      const index = slotIndex.get(seriesKey);
      return index === undefined
        ? "var(--usage-series-other)"
        : `var(--usage-series-${String(index + 1)})`;
    },
    labelFor: (seriesKey) =>
      seriesKey === USAGE_SERIES_OTHER_KEY ? "Other" : seriesKey,
  };
}

/**
 * Harness ids in first-appearance order across the buckets, by earliest
 * `day`. `harnessId` breaks a same-day tie so the order - and therefore
 * every harness's color slot - is a function of the DATA rather than of the
 * order the host happened to return two buckets for one day in.
 */
export function harnessIdsByFirstAppearance(
  buckets: ReadonlyArray<{ readonly day: string; readonly harnessId: string }>,
): readonly string[] {
  const sorted = [...buckets].sort(
    (a, b) =>
      a.day.localeCompare(b.day) || a.harnessId.localeCompare(b.harnessId),
  );
  const seen = new Set<string>();
  const order: string[] = [];
  for (const bucket of sorted) {
    if (seen.has(bucket.harnessId)) continue;
    seen.add(bucket.harnessId);
    order.push(bucket.harnessId);
  }
  return order;
}
