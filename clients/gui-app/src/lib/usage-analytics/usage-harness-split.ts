import {
  totalTokensForBucket,
  type UsageBucket,
} from "@/lib/usage-analytics/usage-chart-data";
import {
  weakestProvenance,
  type UsageCostProvenance,
} from "@/lib/usage-analytics/usage-breakdown";

export interface UsageHarnessSplitRow {
  readonly harnessId: string;
  readonly costUsd: number;
  readonly tokens: number;
  readonly factCount: number;
  /** This harness's share of the window's total known cost, `0..1`. `0` (not `NaN`) when the window has no priced cost at all. */
  readonly shareOfCost: number;
  /** Weakest provenance across every bucket folded into this harness. */
  readonly provenance: UsageCostProvenance;
}

/**
 * Folds the window's buckets into one row per harness (across every model
 * and day), sorted by cost descending - the per-harness split the t3code
 * shape shows under the headline. `shareOfCost` is computed against the sum
 * of every row's OWN cost (not `totals.knownCostUsd`) so the shares always
 * foot to 100% regardless of any coverage subtlety upstream.
 */
export function buildUsageHarnessSplitRows(
  buckets: readonly UsageBucket[],
): readonly UsageHarnessSplitRow[] {
  const byHarness = new Map<
    string,
    Omit<UsageHarnessSplitRow, "shareOfCost">
  >();
  for (const bucket of buckets) {
    const tokens = totalTokensForBucket(bucket);
    const existing = byHarness.get(bucket.harnessId);
    if (existing === undefined) {
      byHarness.set(bucket.harnessId, {
        harnessId: bucket.harnessId,
        costUsd: bucket.knownCostUsd,
        tokens,
        factCount: bucket.factCount,
        provenance: bucket.costProvenance,
      });
      continue;
    }
    byHarness.set(bucket.harnessId, {
      ...existing,
      costUsd: existing.costUsd + bucket.knownCostUsd,
      tokens: existing.tokens + tokens,
      factCount: existing.factCount + bucket.factCount,
      provenance: weakestProvenance(existing.provenance, bucket.costProvenance),
    });
  }
  const rows = [...byHarness.values()];
  const totalCost = rows.reduce((sum, row) => sum + row.costUsd, 0);
  return rows
    .map((row) => ({
      ...row,
      shareOfCost: totalCost > 0 ? row.costUsd / totalCost : 0,
    }))
    .sort((a, b) => b.costUsd - a.costUsd);
}
