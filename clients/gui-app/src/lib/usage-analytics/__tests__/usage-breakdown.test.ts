import { describe, expect, it } from "vitest";
import {
  buildUsageBreakdownRows,
  buildUsageDayBreakdownRows,
} from "@/lib/usage-analytics/usage-breakdown";
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

describe("buildUsageBreakdownRows", () => {
  it("folds multiple days of the same harness+model into one row", () => {
    const rows = buildUsageBreakdownRows([
      bucket({ day: "2026-08-01", knownCostUsd: 1, factCount: 2 }),
      bucket({ day: "2026-08-02", knownCostUsd: 2, factCount: 3 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      harnessId: "claude",
      model: "claude-sonnet-5",
      costUsd: 3,
      factCount: 5,
      tokens: 300, // (100+50) * 2
    });
  });

  it("keeps distinct (harness, model) pairs as separate rows", () => {
    const rows = buildUsageBreakdownRows([
      bucket({ harnessId: "claude", model: "claude-sonnet-5" }),
      bucket({ harnessId: "codex", model: "gpt-5.1-codex" }),
    ]);
    expect(rows.map((row) => `${row.harnessId}:${row.model}`).sort()).toEqual(
      ["claude:claude-sonnet-5", "codex:gpt-5.1-codex"].sort(),
    );
  });

  it("sorts by cost descending", () => {
    const rows = buildUsageBreakdownRows([
      bucket({ harnessId: "cheap", model: "m", knownCostUsd: 0.5 }),
      bucket({ harnessId: "expensive", model: "m", knownCostUsd: 9 }),
    ]);
    expect(rows.map((row) => row.harnessId)).toEqual(["expensive", "cheap"]);
  });

  it("reports the WEAKEST provenance across folded buckets (pricing-provenance artifact)", () => {
    const rows = buildUsageBreakdownRows([
      bucket({ costProvenance: "providerReported" }),
      bucket({ costProvenance: "unpriced" }),
      bucket({ costProvenance: "modelPriced" }),
    ]);
    expect(rows[0]?.provenance).toBe("unpriced");
  });

  it("returns nothing for an empty window", () => {
    expect(buildUsageBreakdownRows([])).toEqual([]);
  });
});

describe("buildUsageDayBreakdownRows", () => {
  it("folds every harness and model on a day into one row", () => {
    const rows = buildUsageDayBreakdownRows([
      bucket({ day: "2026-08-01", harnessId: "claude", knownCostUsd: 1 }),
      bucket({ day: "2026-08-01", harnessId: "codex", knownCostUsd: 2 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ day: "2026-08-01", costUsd: 3 });
  });

  it("sorts newest day first", () => {
    const rows = buildUsageDayBreakdownRows([
      bucket({ day: "2026-08-01" }),
      bucket({ day: "2026-08-05" }),
      bucket({ day: "2026-08-03" }),
    ]);
    expect(rows.map((row) => row.day)).toEqual([
      "2026-08-05",
      "2026-08-03",
      "2026-08-01",
    ]);
  });

  it("reports the weakest provenance across the day's folded buckets", () => {
    const rows = buildUsageDayBreakdownRows([
      bucket({ day: "2026-08-01", costProvenance: "providerReported" }),
      bucket({
        day: "2026-08-01",
        harnessId: "codex",
        costProvenance: "unpriced",
      }),
    ]);
    expect(rows[0]?.provenance).toBe("unpriced");
  });

  it("returns nothing for an empty window", () => {
    expect(buildUsageDayBreakdownRows([])).toEqual([]);
  });
});
