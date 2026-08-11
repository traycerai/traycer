import type { UsageSummaryResponse } from "@/hooks/usage-analytics/use-usage-summary-query";
import {
  buildUsageSeriesScale,
  harnessIdsByFirstAppearance,
  USAGE_SERIES_OTHER_KEY,
  type UsageSeriesScale,
} from "@/lib/usage-analytics/usage-series-scale";

export type UsageBucket = UsageSummaryResponse["summary"]["buckets"][number];
export type UsageMetric = "cost" | "tokens";
export type UsageTokenTotals = UsageBucket["tokens"];

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
 * (harness, or "Other" for anything past the eight-slot cap), in the
 * scale's fixed stacking order. `days` drives the x-axis so a day with zero
 * activity still gets a zero-height column instead of compressing the axis.
 */
export function buildUsageChartColumns(
  days: readonly string[],
  buckets: readonly UsageBucket[],
  scale: UsageSeriesScale,
  metric: UsageMetric,
): readonly UsageChartColumn[] {
  const seriesIndex = new Set(scale.order);
  const byDay = new Map<string, Map<string, number>>();
  for (const bucket of buckets) {
    const seriesKey = seriesIndex.has(bucket.harnessId)
      ? bucket.harnessId
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

/** Convenience: the fixed-order series scale for a response's buckets. */
export function buildUsageSeriesScaleForBuckets(
  buckets: readonly UsageBucket[],
): UsageSeriesScale {
  return buildUsageSeriesScale(harnessIdsByFirstAppearance(buckets));
}
