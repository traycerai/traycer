import type { UsageSummaryResponse } from "@/hooks/usage-analytics/use-usage-summary-query";
import {
  totalTokensForBucket,
  type UsageBucket,
} from "@/lib/usage-analytics/usage-chart-data";

export type UsageCostProvenance =
  UsageSummaryResponse["summary"]["buckets"][number]["costProvenance"];

export interface UsageBreakdownRow {
  readonly harnessId: string;
  readonly model: string;
  readonly costUsd: number;
  readonly tokens: number;
  readonly factCount: number;
  /** Weakest provenance across every bucket folded into this row (pricing-provenance artifact: aggregations report the weakest label present). */
  readonly provenance: UsageCostProvenance;
}

/** Exported so other client-side folds (harness split, day breakdown) share one ladder instead of redefining it. */
export const PROVENANCE_RANK: Record<UsageCostProvenance, number> = {
  unpriced: 0,
  modelPriced: 1,
  providerReported: 2,
};

export function weakestProvenance(
  a: UsageCostProvenance,
  b: UsageCostProvenance,
): UsageCostProvenance {
  return PROVENANCE_RANK[a] <= PROVENANCE_RANK[b] ? a : b;
}

function breakdownKey(harnessId: string, model: string): string {
  return `${harnessId}\0${model}`;
}

/**
 * Folds the window's buckets into one row per (harness, model), sorted by
 * cost descending - the harness/model breakdown,
 * independent of the day axis.
 */
export function buildUsageBreakdownRows(
  buckets: readonly UsageBucket[],
): readonly UsageBreakdownRow[] {
  const byKey = new Map<string, UsageBreakdownRow>();
  for (const bucket of buckets) {
    const key = breakdownKey(bucket.harnessId, bucket.model);
    const tokens = totalTokensForBucket(bucket);
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        harnessId: bucket.harnessId,
        model: bucket.model,
        costUsd: bucket.knownCostUsd,
        tokens,
        factCount: bucket.factCount,
        provenance: bucket.costProvenance,
      });
      continue;
    }
    byKey.set(key, {
      ...existing,
      costUsd: existing.costUsd + bucket.knownCostUsd,
      tokens: existing.tokens + tokens,
      factCount: existing.factCount + bucket.factCount,
      provenance: weakestProvenance(existing.provenance, bucket.costProvenance),
    });
  }
  return [...byKey.values()].sort((a, b) => b.costUsd - a.costUsd);
}

export interface UsageDayBreakdownRow {
  readonly day: string;
  readonly costUsd: number;
  readonly tokens: number;
  readonly factCount: number;
  /** Weakest provenance across every bucket folded into this day (same rule as {@link UsageBreakdownRow}). */
  readonly provenance: UsageCostProvenance;
}

/**
 * Folds the window's buckets into one row per day (across every harness and
 * model), newest first - the "Day" arm of the breakdown's Model/Day toggle.
 * The day axis already exists on every bucket; this only re-groups it.
 */
export function buildUsageDayBreakdownRows(
  buckets: readonly UsageBucket[],
): readonly UsageDayBreakdownRow[] {
  const byDay = new Map<string, UsageDayBreakdownRow>();
  for (const bucket of buckets) {
    const tokens = totalTokensForBucket(bucket);
    const existing = byDay.get(bucket.day);
    if (existing === undefined) {
      byDay.set(bucket.day, {
        day: bucket.day,
        costUsd: bucket.knownCostUsd,
        tokens,
        factCount: bucket.factCount,
        provenance: bucket.costProvenance,
      });
      continue;
    }
    byDay.set(bucket.day, {
      ...existing,
      costUsd: existing.costUsd + bucket.knownCostUsd,
      tokens: existing.tokens + tokens,
      factCount: existing.factCount + bucket.factCount,
      provenance: weakestProvenance(existing.provenance, bucket.costProvenance),
    });
  }
  return [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day));
}
