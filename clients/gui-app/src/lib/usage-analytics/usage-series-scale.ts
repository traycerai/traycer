/**
 * Categorical color assignment for the per-day chart's harness/model
 * breakdown.
 *
 * Sixteen fixed slots, assigned in the order the caller supplies - which
 * `buildUsageSeriesScaleForBuckets` splits deliberately: the keys past the
 * cap are chosen by SPEND (so "Other" is the long tail) while the order of
 * the ones that fit is total-independent (so a series does not change color
 * when a refetch merely reorders magnitudes). Slots 1-8 are the dataviz
 * skill's validated primary hues;
 * 9-16 are their shade/tint cousins (see `usage-analytics-chart.css`), a
 * deliberately weaker ring that only the cheaper series ever land in. Past
 * sixteen distinct keys the tail folds into "Other" rather than generating
 * a seventeenth color - a generated color is indistinguishable from an
 * existing one under CVD and breaks every validated-palette check.
 */
export const USAGE_SERIES_SLOT_COUNT = 16;
export const USAGE_SERIES_OTHER_KEY = "__usage_series_other__";

export interface UsageSeriesScale {
  /** Series keys in slot order - real harness ids / model ids, plus the "Other" sentinel if any key overflowed. */
  readonly order: readonly string[];
  /** CSS `var(...)` reference for a series key - falls back to the "Other" token for an unrecognized key. */
  readonly colorVar: (seriesKey: string) => string;
  /** Display label - the raw harness/model id (no invented display-name catalog), or "Other". */
  readonly labelFor: (seriesKey: string) => string;
}

export function buildUsageSeriesScale(
  seriesKeysInSlotOrder: readonly string[],
): UsageSeriesScale {
  const primary = seriesKeysInSlotOrder.slice(0, USAGE_SERIES_SLOT_COUNT);
  const overflow = seriesKeysInSlotOrder.slice(USAGE_SERIES_SLOT_COUNT);
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
