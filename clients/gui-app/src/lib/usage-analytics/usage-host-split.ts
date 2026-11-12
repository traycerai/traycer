import { hostNameFromLabel, UNNAMED_HOST_LABEL } from "@/lib/host/host-name";
import type { UsageSummaryResponse } from "@/hooks/usage-analytics/use-usage-summary-query";
import { sumTokenTotals } from "@/lib/usage-analytics/usage-chart-data";
import type { UsageCostProvenance } from "@/lib/usage-analytics/usage-breakdown";

type UsageHostBucket = UsageSummaryResponse["summary"]["hostBuckets"][number];

export function resolveUsageHostName(
  hostId: string,
  hostNames: ReadonlyMap<string, string>,
): string {
  const name = hostNameFromLabel(hostNames.get(hostId) ?? null, hostId);
  return name === UNNAMED_HOST_LABEL ? "Unnamed computer" : name;
}

export interface UsageHostSplitRow {
  readonly hostId: string;
  readonly name: string;
  /** No directory entry supplied a recognizable name for this computer. */
  readonly nameIsFallback: boolean;
  readonly costUsd: number;
  readonly tokens: number;
  readonly factCount: number;
  /** This host's share of the window's total known cost, `0..1`. `0` (not `NaN`) when the window has no priced cost at all. */
  readonly shareOfCost: number;
  readonly provenance: UsageCostProvenance;
}

/**
 * The window's `hostBuckets`, named and sorted by cost descending - the
 * per-host equivalent of `buildUsageHarnessSplitRows`, and deliberately its
 * twin so the two lists read as one vocabulary.
 *
 * Unlike the harness split there is no folding to do: the aggregator already
 * emits one bucket per host. `shareOfCost` is still computed against the sum
 * of these rows' OWN costs rather than `totals.knownCostUsd`, so the shares
 * foot to 100% whatever the coverage looks like upstream.
 */
export function buildUsageHostSplitRows(
  buckets: readonly UsageHostBucket[],
  hostNames: ReadonlyMap<string, string>,
): readonly UsageHostSplitRow[] {
  const totalCost = buckets.reduce(
    (sum, bucket) => sum + bucket.knownCostUsd,
    0,
  );
  return buckets
    .map((bucket) => {
      const name = hostNames.get(bucket.hostId);
      return {
        hostId: bucket.hostId,
        name: resolveUsageHostName(bucket.hostId, hostNames),
        nameIsFallback:
          hostNameFromLabel(name ?? null, bucket.hostId) === UNNAMED_HOST_LABEL,
        costUsd: bucket.knownCostUsd,
        tokens: sumTokenTotals(bucket.tokens),
        factCount: bucket.factCount,
        shareOfCost: totalCost > 0 ? bucket.knownCostUsd / totalCost : 0,
        provenance: bucket.costProvenance,
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd || a.hostId.localeCompare(b.hostId));
}

/**
 * "No host filter", as a value a Radix `Select` will accept: it refuses an
 * empty-string item value and has no concept of `null`.
 *
 * The sentinel and its two mapping functions live HERE rather than beside
 * the control, for two reasons: a component module that also exports plain
 * functions breaks Fast Refresh, and this round trip is worth testing
 * without driving a popover through jsdom - where a click on a
 * pointer-inert trigger can pass for reasons that have nothing to do with
 * the mapping being right.
 */
export const USAGE_ALL_HOSTS_VALUE = "__usage_all_hosts__";

export function usageHostFilterValue(hostId: string | null): string {
  return hostId ?? USAGE_ALL_HOSTS_VALUE;
}

export function usageHostFilterHostId(value: string): string | null {
  return value === USAGE_ALL_HOSTS_VALUE ? null : value;
}

export interface UsageHostFilterOption {
  readonly hostId: string;
  readonly name: string;
  /** No directory entry supplied a recognizable name for this computer. */
  readonly nameIsFallback: boolean;
}

/**
 * The hosts the filter offers, sorted by name.
 *
 * Union of three sources rather than any one of them, because each alone
 * loses a real host:
 *
 *   - the DIRECTORY alone drops a host that has usage on the account but is
 *     no longer listed here (removed, or not dialable from this client);
 *   - the current response's HOST BUCKETS alone collapse the moment a filter
 *     is applied - picking one host would leave a picker holding only that
 *     host, with no way back to any other;
 *   - `selectedHostId` keeps the active pick present even when it resolved to
 *     an empty window, so the control never shows a selection it cannot
 *     re-offer.
 */
export function buildUsageHostFilterOptions(input: {
  readonly hostNames: ReadonlyMap<string, string>;
  readonly hostIdsWithUsage: readonly string[];
  readonly selectedHostId: string | null;
}): readonly UsageHostFilterOption[] {
  const ids = new Set<string>([
    ...input.hostNames.keys(),
    ...input.hostIdsWithUsage,
  ]);
  if (input.selectedHostId !== null) ids.add(input.selectedHostId);
  const options = [...ids]
    .map((hostId) => {
      const name = input.hostNames.get(hostId);
      return {
        hostId,
        name: resolveUsageHostName(hostId, input.hostNames),
        nameIsFallback:
          hostNameFromLabel(name ?? null, hostId) === UNNAMED_HOST_LABEL,
      };
    })
    .sort(
      (a, b) =>
        // Named hosts first, as a block. Interleaving them by locale order
        // scatters unnamed computers through the list, so the reader has to
        // scan every row to find the machine they actually recognize.
        Number(a.nameIsFallback) - Number(b.nameIsFallback) ||
        a.name.localeCompare(b.name) ||
        a.hostId.localeCompare(b.hostId),
    );
  const reservedNames = new Set(options.map((option) => option.name));
  const usedNames = new Set<string>();
  return options.map((option) => {
    let name = option.name;
    let ordinal = 2;
    while (
      usedNames.has(name) ||
      (name !== option.name && reservedNames.has(name))
    ) {
      name = `${option.name} ${ordinal}`;
      ordinal += 1;
    }
    usedNames.add(name);
    return { ...option, name };
  });
}
