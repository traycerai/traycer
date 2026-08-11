import { describe, expect, it } from "vitest";
import {
  applyUsageSeriesVisibility,
  bucketMetricValue,
  buildUsageChartColumns,
  totalTokensForBucket,
  type UsageBucket,
} from "@/lib/usage-analytics/usage-chart-data";
import {
  buildUsageSeriesScale,
  USAGE_SERIES_OTHER_KEY,
} from "@/lib/usage-analytics/usage-series-scale";

function bucket(overrides: Partial<UsageBucket>): UsageBucket {
  return {
    day: "2026-08-01",
    harnessId: "claude",
    model: "claude-sonnet-5",
    factCount: 1,
    tokens: {
      uncachedInputTokens: 10,
      cacheReadInputTokens: 20,
      cacheCreationTokens: 30,
      outputTokens: 40,
    },
    knownCostUsd: 1.5,
    knownCacheSavingsUsd: 0,
    knownReasoningTokens: 0,
    costProvenance: "providerReported",
    ...overrides,
  };
}

describe("totalTokensForBucket / bucketMetricValue", () => {
  it("sums all four mutually-exclusive token buckets", () => {
    expect(totalTokensForBucket(bucket({}))).toBe(10 + 20 + 30 + 40);
  });

  it("selects cost or tokens per the metric argument", () => {
    const b = bucket({ knownCostUsd: 3.25 });
    expect(bucketMetricValue(b, "cost")).toBe(3.25);
    expect(bucketMetricValue(b, "tokens")).toBe(100);
  });
});

describe("buildUsageChartColumns", () => {
  const scale = buildUsageSeriesScale(["claude", "codex"]);

  it("zero-fills a day with no buckets rather than compressing the axis", () => {
    const columns = buildUsageChartColumns(
      ["2026-08-01", "2026-08-02", "2026-08-03"],
      [bucket({ day: "2026-08-01", knownCostUsd: 5 })],
      scale,
      "cost",
    );
    expect(columns.map((c) => c.day)).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
    ]);
    expect(columns[1]?.total).toBe(0);
    expect(columns[2]?.total).toBe(0);
    expect(columns[0]?.total).toBe(5);
  });

  it("sums same-day, same-harness buckets (different models) into one series segment", () => {
    const columns = buildUsageChartColumns(
      ["2026-08-01"],
      [
        bucket({ harnessId: "claude", model: "a", knownCostUsd: 1 }),
        bucket({ harnessId: "claude", model: "b", knownCostUsd: 2 }),
      ],
      scale,
      "cost",
    );
    const claudeSegment = columns[0]?.segments.find(
      (s) => s.seriesKey === "claude",
    );
    expect(claudeSegment?.value).toBe(3);
  });

  it("routes a harness past the scale's 8-slot cap into the Other segment, and the value is still counted in the day total", () => {
    const nineHarnessScale = buildUsageSeriesScale([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
      "overflow-harness",
    ]);
    const columns = buildUsageChartColumns(
      ["2026-08-01"],
      [bucket({ harnessId: "overflow-harness", knownCostUsd: 4 })],
      nineHarnessScale,
      "cost",
    );
    const otherSegment = columns[0]?.segments.find(
      (s) => s.seriesKey === USAGE_SERIES_OTHER_KEY,
    );
    expect(otherSegment?.value).toBe(4);
    expect(columns[0]?.total).toBe(4);
  });
});

describe("applyUsageSeriesVisibility", () => {
  const scale = buildUsageSeriesScale(["claude", "codex"]);
  const columns = buildUsageChartColumns(
    ["2026-08-01"],
    [
      bucket({ harnessId: "claude", knownCostUsd: 3 }),
      bucket({ harnessId: "codex", knownCostUsd: 5 }),
    ],
    scale,
    "cost",
  );

  it("returns the columns unchanged when nothing is hidden", () => {
    expect(applyUsageSeriesVisibility(columns, new Set())).toBe(columns);
  });

  it("zeroes a hidden series' segment without removing it, and recomputes the total", () => {
    const filtered = applyUsageSeriesVisibility(columns, new Set(["codex"]));
    const codexSegment = filtered[0]?.segments.find(
      (s) => s.seriesKey === "codex",
    );
    const claudeSegment = filtered[0]?.segments.find(
      (s) => s.seriesKey === "claude",
    );
    expect(codexSegment?.value).toBe(0);
    expect(claudeSegment?.value).toBe(3);
    expect(filtered[0]?.total).toBe(3);
  });

  it("leaves the original columns' series order/keys untouched", () => {
    const filtered = applyUsageSeriesVisibility(columns, new Set(["codex"]));
    expect(filtered[0]?.segments.map((s) => s.seriesKey)).toEqual(
      columns[0]?.segments.map((s) => s.seriesKey),
    );
  });
});
