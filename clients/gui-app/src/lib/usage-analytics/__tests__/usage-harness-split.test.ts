import { describe, expect, it } from "vitest";
import { buildUsageHarnessSplitRows } from "@/lib/usage-analytics/usage-harness-split";
import type { UsageBucket } from "@/lib/usage-analytics/usage-chart-data";

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

describe("buildUsageHarnessSplitRows", () => {
  it("folds every model and day for a harness into one row", () => {
    const rows = buildUsageHarnessSplitRows([
      bucket({
        harnessId: "claude",
        model: "claude-sonnet-5",
        knownCostUsd: 1,
      }),
      bucket({
        harnessId: "claude",
        model: "claude-opus-5",
        day: "2026-08-02",
        knownCostUsd: 2,
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ harnessId: "claude", costUsd: 3 });
  });

  it("computes shares that foot to 100%", () => {
    const rows = buildUsageHarnessSplitRows([
      bucket({ harnessId: "claude", knownCostUsd: 3 }),
      bucket({ harnessId: "codex", knownCostUsd: 1 }),
    ]);
    const total = rows.reduce((sum, row) => sum + row.shareOfCost, 0);
    expect(total).toBeCloseTo(1, 10);
    const claude = rows.find((row) => row.harnessId === "claude");
    expect(claude?.shareOfCost).toBeCloseTo(0.75, 10);
  });

  it("sorts by cost descending", () => {
    const rows = buildUsageHarnessSplitRows([
      bucket({ harnessId: "cheap", knownCostUsd: 0.5 }),
      bucket({ harnessId: "expensive", knownCostUsd: 9 }),
    ]);
    expect(rows.map((row) => row.harnessId)).toEqual(["expensive", "cheap"]);
  });

  it("reports a zero share (never NaN) for a window with no cost at all", () => {
    const rows = buildUsageHarnessSplitRows([
      bucket({ harnessId: "claude", knownCostUsd: 0 }),
    ]);
    expect(rows[0]?.shareOfCost).toBe(0);
  });

  it("reports the weakest provenance across folded buckets", () => {
    const rows = buildUsageHarnessSplitRows([
      bucket({ harnessId: "claude", costProvenance: "providerReported" }),
      bucket({
        harnessId: "claude",
        model: "other",
        costProvenance: "unpriced",
      }),
    ]);
    expect(rows[0]?.provenance).toBe("unpriced");
  });

  it("returns nothing for an empty window", () => {
    expect(buildUsageHarnessSplitRows([])).toEqual([]);
  });
});
