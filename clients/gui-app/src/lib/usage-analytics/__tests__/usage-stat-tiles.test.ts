import { describe, expect, it } from "vitest";
import {
  buildUsageStatTiles,
  usageCompletenessAbsentNote,
} from "@/lib/usage-analytics/usage-stat-tiles";
import type { UsageSummaryResponse } from "@/hooks/usage-analytics/use-usage-summary-query";
import type { UsageBucket } from "@/lib/usage-analytics/usage-chart-data";

type UsageSummaryTotals = UsageSummaryResponse["summary"]["totals"];

const ZERO_PROVENANCE_SPLIT: UsageSummaryTotals["provenanceSplit"] = {
  unpriced: { costUsd: 0, factCount: 0, tokenCount: 0 },
  modelPriced: { costUsd: 0, factCount: 0, tokenCount: 0 },
  providerReported: { costUsd: 0, factCount: 0, tokenCount: 0 },
};

function totals(overrides: Partial<UsageSummaryTotals>): UsageSummaryTotals {
  return {
    factCount: 1,
    tokens: {
      uncachedInputTokens: 100,
      cacheReadInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 50,
    },
    knownCostUsd: 1,
    knownCacheSavingsUsd: 0,
    knownReasoningTokens: 0,
    costProvenance: "providerReported",
    provenanceSplit: ZERO_PROVENANCE_SPLIT,
    ...overrides,
  };
}

function bucket(overrides: Partial<UsageBucket>): UsageBucket {
  return {
    day: "2026-08-01",
    harnessId: "claude",
    model: "claude-sonnet-5",
    factCount: 1,
    tokens: {
      uncachedInputTokens: 100,
      cacheReadInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 50,
    },
    knownCostUsd: 1,
    knownCacheSavingsUsd: 0,
    knownReasoningTokens: 0,
    costProvenance: "providerReported",
    ...overrides,
  };
}

describe("buildUsageStatTiles", () => {
  it("sums processed tokens across every bucket and divides by active days", () => {
    const tiles = buildUsageStatTiles(
      totals({
        tokens: {
          uncachedInputTokens: 100,
          cacheReadInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 100,
        },
      }),
      [
        bucket({ day: "2026-08-01", factCount: 1 }),
        bucket({ day: "2026-08-02", factCount: 1 }),
      ],
    );
    expect(tiles.processedTokens.totalTokens).toBe(200);
    expect(tiles.processedTokens.perActiveDay).toBe(100);
  });

  it("reports null per-active-day when nothing is active", () => {
    const tiles = buildUsageStatTiles(totals({}), []);
    expect(tiles.processedTokens.perActiveDay).toBeNull();
  });

  it("computes cached input as a share of OBSERVED input, excluding cache writes", () => {
    const tiles = buildUsageStatTiles(
      totals({
        tokens: {
          uncachedInputTokens: 60,
          cacheReadInputTokens: 40,
          cacheCreationTokens: 500,
          outputTokens: 0,
        },
      }),
      [],
    );
    expect(tiles.cachedInput.percentOfObservedInput).toBe(40);
    expect(tiles.uncachedInput.cacheCreationTokens).toBe(500);
  });

  it("reports null percent-cached when no input was observed", () => {
    const tiles = buildUsageStatTiles(
      totals({
        tokens: {
          uncachedInputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 10,
        },
      }),
      [],
    );
    expect(tiles.cachedInput.percentOfObservedInput).toBeNull();
  });

  it("reports reasoning tokens only when the known sum is positive - never an implied zero", () => {
    expect(
      buildUsageStatTiles(totals({ knownReasoningTokens: 0 }), []).output
        .reasoningTokens,
    ).toBeNull();
    expect(
      buildUsageStatTiles(totals({ knownReasoningTokens: 42 }), []).output
        .reasoningTokens,
    ).toBe(42);
  });

  it("computes the cache-savings multiple against the raw (pre-savings) cost", () => {
    const tiles = buildUsageStatTiles(
      totals({ knownCostUsd: 4, knownCacheSavingsUsd: 1 }),
      [],
    );
    // raw = 4 + 1 = 5; multiple = 5 / 4
    expect(tiles.cacheSavings.multipleOfRawCost).toBeCloseTo(1.25, 10);
  });

  it("reports no multiple when there is nothing known to divide", () => {
    expect(
      buildUsageStatTiles(
        totals({ knownCostUsd: 0, knownCacheSavingsUsd: 0 }),
        [],
      ).cacheSavings.multipleOfRawCost,
    ).toBeNull();
    expect(
      buildUsageStatTiles(
        totals({ knownCostUsd: 0, knownCacheSavingsUsd: 3 }),
        [],
      ).cacheSavings.multipleOfRawCost,
    ).toBeNull();
  });
});

describe("usageCompletenessAbsentNote", () => {
  it("is null when nothing in the window is absent", () => {
    expect(
      usageCompletenessAbsentNote({ measured: 5, partial: 0, absent: 0 }),
    ).toBeNull();
  });

  it("names the excluded turn count, singular and plural", () => {
    expect(
      usageCompletenessAbsentNote({ measured: 5, partial: 0, absent: 1 }),
    ).toBe("Excludes 1 turn with no usage reported.");
    expect(
      usageCompletenessAbsentNote({ measured: 5, partial: 0, absent: 3 }),
    ).toBe("Excludes 3 turns with no usage reported.");
  });
});
