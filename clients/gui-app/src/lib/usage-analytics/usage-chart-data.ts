import type { UsageSummaryResponse } from "@/hooks/usage-analytics/use-usage-summary-query";
import {
  buildUsageSeriesScale,
  USAGE_SERIES_OTHER_KEY,
  USAGE_SERIES_SLOT_COUNT,
  type UsageSeriesScale,
} from "@/lib/usage-analytics/usage-series-scale";

export type UsageBucket = UsageSummaryResponse["summary"]["buckets"][number];
export type UsageMetric = "cost" | "tokens";
export type UsageTokenTotals = UsageBucket["tokens"];

/**
 * Which bucket dimension the daily chart stacks by. The buckets are
 * day×harness×model rows either way - grouping is a client-side fold, so
 * switching needs no second request.
 */
export type UsageChartGroupBy = "harness" | "model";

function bucketSeriesKey(
  bucket: UsageBucket,
  groupBy: UsageChartGroupBy,
): string {
  return groupBy === "harness" ? bucket.harnessId : bucket.model;
}

export interface UsageChartSegment {
  readonly seriesKey: string;
  readonly value: number;
}

export interface UsageChartColumn {
  readonly day: string;
  readonly segments: readonly UsageChartSegment[];
  readonly total: number;
}

/**
 * Sums the four mutually-exclusive token buckets. Takes just the `tokens`
 * shape (not a whole `UsageBucket`) so every row kind that carries it -
 * day×harness×model buckets, per-chat buckets, per-turn rows - can reuse
 * this one arithmetic instead of each row kind growing its own copy.
 */
export function sumTokenTotals(tokens: UsageTokenTotals): number {
  return (
    tokens.uncachedInputTokens +
    tokens.cacheReadInputTokens +
    tokens.cacheCreationTokens +
    tokens.outputTokens
  );
}

export function totalTokensForBucket(bucket: UsageBucket): number {
  return sumTokenTotals(bucket.tokens);
}

export function bucketMetricValue(
  bucket: UsageBucket,
  metric: UsageMetric,
): number {
  return metric === "cost" ? bucket.knownCostUsd : totalTokensForBucket(bucket);
}

/**
 * Builds the stacked-bar chart's per-day columns, one segment per series
 * (harness or model per `groupBy`, or "Other" for anything past the
 * slot cap), in the scale's fixed stacking order. `days` drives the
 * x-axis so a day with zero activity still gets a zero-height column instead
 * of compressing the axis. `groupBy` must match the one the `scale` was
 * built with, or every bucket folds into "Other".
 *
 * Takes one input object rather than positional arguments, matching its
 * sibling `buildUsageChartOption` - `groupBy` was the fifth dimension of the
 * same fold, and five positional arguments (four of them easy to transpose)
 * is what the `max-params` rule exists to stop.
 */
export function buildUsageChartColumns(input: {
  readonly days: readonly string[];
  readonly buckets: readonly UsageBucket[];
  readonly scale: UsageSeriesScale;
  readonly metric: UsageMetric;
  readonly groupBy: UsageChartGroupBy;
}): readonly UsageChartColumn[] {
  const { days, buckets, scale, metric, groupBy } = input;
  const seriesIndex = new Set(scale.order);
  const byDay = new Map<string, Map<string, number>>();
  for (const bucket of buckets) {
    const bucketKey = bucketSeriesKey(bucket, groupBy);
    const seriesKey = seriesIndex.has(bucketKey)
      ? bucketKey
      : USAGE_SERIES_OTHER_KEY;
    const perSeries = byDay.get(bucket.day) ?? new Map<string, number>();
    perSeries.set(
      seriesKey,
      (perSeries.get(seriesKey) ?? 0) + bucketMetricValue(bucket, metric),
    );
    byDay.set(bucket.day, perSeries);
  }
  return days.map((day) => {
    const perSeries = byDay.get(day) ?? new Map<string, number>();
    const segments = scale.order.map((seriesKey) => ({
      seriesKey,
      value: perSeries.get(seriesKey) ?? 0,
    }));
    return {
      day,
      segments,
      total: segments.reduce((sum, segment) => sum + segment.value, 0),
    };
  });
}

/**
 * Zeroes out every segment whose series key is in `hiddenSeries` - the
 * legend-chip filter's effect on the stacked chart. Segments stay present in
 * the returned columns (their key, just a `0` value) rather than being
 * removed, so the stack order and the legend's color assignment never shift
 * as a series toggles - "color follows the entity, never its rank" (dataviz
 * skill). `total` is recomputed over the surviving segments only, so the
 * y-axis rescales to what is actually visible instead of leaving dead
 * headroom for a hidden series.
 */
export function applyUsageSeriesVisibility(
  columns: readonly UsageChartColumn[],
  hiddenSeries: ReadonlySet<string>,
): readonly UsageChartColumn[] {
  if (hiddenSeries.size === 0) return columns;
  return columns.map((column) => {
    const segments = column.segments.map((segment) =>
      hiddenSeries.has(segment.seriesKey) ? { ...segment, value: 0 } : segment,
    );
    return {
      ...column,
      segments,
      total: segments.reduce((sum, segment) => sum + segment.value, 0),
    };
  });
}

/**
 * Series keys ranked by the window's total known cost, descending. This
 * drives SELECTION only - which keys get a palette slot and which fold into
 * "Other" - so "Other" is always the long tail, never whichever series
 * happened to show up late in the window. Ties (most often a run of
 * unpriced series at $0) break on total tokens, then on the key itself, so
 * the ranking is a function of the DATA rather than of the order the host
 * happened to return buckets in.
 *
 * Deliberately NOT the slot order: see `buildUsageSeriesScaleForBuckets`.
 */
export function seriesKeysByTotalCost(
  buckets: readonly UsageBucket[],
  groupBy: UsageChartGroupBy,
): readonly string[] {
  const totals = new Map<string, { costUsd: number; tokens: number }>();
  for (const bucket of buckets) {
    const key = bucketSeriesKey(bucket, groupBy);
    const existing = totals.get(key) ?? { costUsd: 0, tokens: 0 };
    totals.set(key, {
      costUsd: existing.costUsd + bucket.knownCostUsd,
      tokens: existing.tokens + totalTokensForBucket(bucket),
    });
  }
  return [...totals.entries()]
    .sort(
      ([keyA, a], [keyB, b]) =>
        b.costUsd - a.costUsd ||
        b.tokens - a.tokens ||
        keyA.localeCompare(keyB),
    )
    .map(([key]) => key);
}

/**
 * The series scale for a response's buckets under the given grouping, on
 * two SEPARATE axes:
 *
 * - **Selection** is by spend (`seriesKeysByTotalCost`): the top
 *   `USAGE_SERIES_SLOT_COUNT` keys get palette slots and the rest fold into
 *   "Other", so the fold is always the long tail.
 * - **Slot assignment** among the selected keys is alphabetical, which is
 *   independent of the totals. Ranking cannot drive it: the scale is
 *   rebuilt from every response, so a refetch in which one series merely
 *   overtakes another ($9 -> $11 past a steady $10) would swap two entities'
 *   colors in the chart AND in the harness split beside it, while the
 *   surface stayed mounted. "Color follows the entity, never its rank"
 *   (dataviz skill) - the same rule `applyUsageSeriesVisibility` keeps when
 *   a series is toggled off. Changing magnitudes now move a series' place in
 *   the stack only if they move it across the selection cutoff.
 *
 * Overflow keys are appended after the selected ones purely so
 * `buildUsageSeriesScale` still sees them and emits the "Other" sentinel;
 * their relative order past the cap is immaterial.
 */
export function buildUsageSeriesScaleForBuckets(
  buckets: readonly UsageBucket[],
  groupBy: UsageChartGroupBy,
): UsageSeriesScale {
  const ranked = seriesKeysByTotalCost(buckets, groupBy);
  const selected = [...ranked.slice(0, USAGE_SERIES_SLOT_COUNT)].sort((a, b) =>
    a.localeCompare(b),
  );
  return buildUsageSeriesScale([
    ...selected,
    ...ranked.slice(USAGE_SERIES_SLOT_COUNT),
  ]);
}
