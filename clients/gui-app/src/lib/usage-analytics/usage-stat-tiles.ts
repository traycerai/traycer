import type { UsageSummaryResponse } from "@/hooks/usage-analytics/use-usage-summary-query";
import type { UsageBucket } from "@/lib/usage-analytics/usage-chart-data";

type UsageSummaryTotals = UsageSummaryResponse["summary"]["totals"];

export interface UsageProcessedTokensTile {
  readonly totalTokens: number;
  /** `null` when the window has no active day to divide by (nothing to show, not a zero rate). */
  readonly perActiveDay: number | null;
}

export interface UsageCachedInputTile {
  readonly cacheReadInputTokens: number;
  /** Share of OBSERVED input (uncached + cache-read, never cache-write) that came from cache, `0..100`. `null` when no input was observed at all. */
  readonly percentOfObservedInput: number | null;
}

export interface UsageUncachedInputTile {
  readonly uncachedInputTokens: number;
  readonly cacheCreationTokens: number;
}

export interface UsageOutputTile {
  readonly outputTokens: number;
  /** Subset of `outputTokens`, never additive - `null` (not `0`) when nothing in the window reported a reasoning split, per the absent-not-zero rule. */
  readonly reasoningTokens: number | null;
}

export interface UsageCacheSavingsTile {
  readonly knownCacheSavingsUsd: number;
  /**
   * How many times more the window's KNOWN priced cost would have been
   * without caching (`(knownCostUsd + knownCacheSavingsUsd) / knownCostUsd`).
   * `null` when there is no known cost to divide by, or no savings to show -
   * never a fabricated ratio.
   */
  readonly multipleOfRawCost: number | null;
}

export interface UsageStatTiles {
  readonly processedTokens: UsageProcessedTokensTile;
  readonly cachedInput: UsageCachedInputTile;
  readonly uncachedInput: UsageUncachedInputTile;
  readonly output: UsageOutputTile;
  readonly cacheSavings: UsageCacheSavingsTile;
}

/** Distinct calendar days in the window that saw at least one fact - the denominator for "per active day" figures. */
function countActiveDays(buckets: readonly UsageBucket[]): number {
  const days = new Set<string>();
  for (const bucket of buckets) {
    if (bucket.factCount > 0) days.add(bucket.day);
  }
  return days.size;
}

/**
 * Pure computation for the dashboard's stat-tiles row. Every "null means
 * absent, not zero" rule from the honesty framing lives here once, so no
 * render site has to re-derive it: a `null` field means the tile renders its
 * headline number alone, with no secondary line implying a signal that was
 * never reported.
 */
export function buildUsageStatTiles(
  totals: UsageSummaryTotals,
  buckets: readonly UsageBucket[],
): UsageStatTiles {
  const tokens = totals.tokens;
  const totalTokens =
    tokens.uncachedInputTokens +
    tokens.cacheReadInputTokens +
    tokens.cacheCreationTokens +
    tokens.outputTokens;
  const activeDays = countActiveDays(buckets);
  const observedInput =
    tokens.uncachedInputTokens + tokens.cacheReadInputTokens;
  const rawCostUsd = totals.knownCostUsd + totals.knownCacheSavingsUsd;

  return {
    processedTokens: {
      totalTokens,
      perActiveDay: activeDays > 0 ? totalTokens / activeDays : null,
    },
    cachedInput: {
      cacheReadInputTokens: tokens.cacheReadInputTokens,
      percentOfObservedInput:
        observedInput > 0
          ? (tokens.cacheReadInputTokens / observedInput) * 100
          : null,
    },
    uncachedInput: {
      uncachedInputTokens: tokens.uncachedInputTokens,
      cacheCreationTokens: tokens.cacheCreationTokens,
    },
    output: {
      outputTokens: tokens.outputTokens,
      reasoningTokens:
        totals.knownReasoningTokens > 0 ? totals.knownReasoningTokens : null,
    },
    cacheSavings: {
      knownCacheSavingsUsd: totals.knownCacheSavingsUsd,
      multipleOfRawCost:
        totals.knownCacheSavingsUsd > 0 && totals.knownCostUsd > 0
          ? rawCostUsd / totals.knownCostUsd
          : null,
    },
  };
}

/**
 * The one honesty note the stat-tiles row carries as a whole: turns with no
 * usage signal at all (`usageCompleteness: "absent"`) still contribute a
 * silent zero to every token sum above, which would otherwise read as "this
 * turn used no cache" rather than "this turn reported nothing" - the
 * distinction the pricing-provenance artifact's absent-not-zero rule exists
 * to preserve. `null` when every turn in the window reported real usage.
 */
export function usageCompletenessAbsentNote(
  breakdown: UsageSummaryResponse["summary"]["usageCompletenessBreakdown"],
): string | null {
  if (breakdown.absent === 0) return null;
  const turnWord = breakdown.absent === 1 ? "turn" : "turns";
  return `Excludes ${String(breakdown.absent)} ${turnWord} with no usage reported.`;
}
