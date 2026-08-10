import type { UsageSummaryResponse } from "@/hooks/usage-analytics/use-usage-summary-query";
import {
  buildUsageSeriesScale,
  harnessIdsByFirstAppearance,
  USAGE_SERIES_OTHER_KEY,
  type UsageSeriesScale,
} from "@/lib/usage-analytics/usage-series-scale";

export type UsageBucket = UsageSummaryResponse["summary"]["buckets"][number];
export type UsageMetric = "cost" | "tokens";

export interface UsageChartSegment {
  readonly seriesKey: string;
  readonly value: number;
}

export interface UsageChartColumn {
  readonly day: string;
  readonly segments: readonly UsageChartSegment[];
  readonly total: number;
}

export function totalTokensForBucket(bucket: UsageBucket): number {
  const t = bucket.tokens;
  return (
    t.uncachedInputTokens +
    t.cacheReadInputTokens +
    t.cacheCreationTokens +
    t.outputTokens
  );
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

/** Convenience: the fixed-order series scale for a response's buckets. */
export function buildUsageSeriesScaleForBuckets(
  buckets: readonly UsageBucket[],
): UsageSeriesScale {
  return buildUsageSeriesScale(harnessIdsByFirstAppearance(buckets));
}
