import { describe, expect, it } from "vitest";
import {
  applyUsageSeriesVisibility,
  bucketMetricValue,
  buildUsageChartColumns,
  buildUsageSeriesScaleForBuckets,
  seriesKeysByTotalCost,
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
    const columns = buildUsageChartColumns({
      days: ["2026-08-01", "2026-08-02", "2026-08-03"],
      buckets: [bucket({ day: "2026-08-01", knownCostUsd: 5 })],
      scale,
      metric: "cost",
      groupBy: "harness",
    });
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
    const columns = buildUsageChartColumns({
      days: ["2026-08-01"],
      buckets: [
        bucket({ harnessId: "claude", model: "a", knownCostUsd: 1 }),
        bucket({ harnessId: "claude", model: "b", knownCostUsd: 2 }),
      ],
      scale,
      metric: "cost",
      groupBy: "harness",
    });
    const claudeSegment = columns[0]?.segments.find(
      (s) => s.seriesKey === "claude",
    );
    expect(claudeSegment?.value).toBe(3);
  });

  it("routes a harness past the scale's 16-slot cap into the Other segment, and the value is still counted in the day total", () => {
    const seventeenHarnessScale = buildUsageSeriesScale([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
      "i",
      "j",
      "k",
      "l",
      "m",
      "n",
      "o",
      "p",
      "overflow-harness",
    ]);
    const columns = buildUsageChartColumns({
      days: ["2026-08-01"],
      buckets: [bucket({ harnessId: "overflow-harness", knownCostUsd: 4 })],
      scale: seventeenHarnessScale,
      metric: "cost",
      groupBy: "harness",
    });
    const otherSegment = columns[0]?.segments.find(
      (s) => s.seriesKey === USAGE_SERIES_OTHER_KEY,
    );
    expect(otherSegment?.value).toBe(4);
    expect(columns[0]?.total).toBe(4);
  });
});

describe("seriesKeysByTotalCost / buildUsageSeriesScaleForBuckets (cost ranking)", () => {
  it("ranks a higher total cost first, regardless of day order or input order, summing across multiple buckets of the same key", () => {
    const buckets = [
      bucket({
        day: "2026-08-02",
        harnessId: "codex",
        model: "codex-model",
        knownCostUsd: 1,
      }),
      bucket({
        day: "2026-08-01",
        harnessId: "claude",
        model: "claude-model",
        knownCostUsd: 10,
      }),
      bucket({
        day: "2026-08-03",
        harnessId: "codex",
        model: "codex-model",
        knownCostUsd: 6,
      }),
    ];
    // codex totals 1 + 6 = 7, still less than claude's single 10 - and codex
    // appears FIRST in the input/day order, so a first-appearance or
    // input-order sort would wrongly rank it ahead of claude.
    expect(seriesKeysByTotalCost(buckets, "harness")).toEqual([
      "claude",
      "codex",
    ]);
  });

  it("breaks a cost tie on total tokens, descending", () => {
    const buckets = [
      bucket({
        harnessId: "low-tokens",
        knownCostUsd: 5,
        tokens: {
          uncachedInputTokens: 10,
          cacheReadInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 0,
        },
      }),
      bucket({
        harnessId: "high-tokens",
        knownCostUsd: 5,
        tokens: {
          uncachedInputTokens: 100,
          cacheReadInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 0,
        },
      }),
    ];
    expect(seriesKeysByTotalCost(buckets, "harness")).toEqual([
      "high-tokens",
      "low-tokens",
    ]);
  });

  it("breaks a cost+token tie alphabetically by key", () => {
    const buckets = [
      bucket({ harnessId: "zeta", knownCostUsd: 2 }),
      bucket({ harnessId: "alpha", knownCostUsd: 2 }),
    ];
    expect(seriesKeysByTotalCost(buckets, "harness")).toEqual([
      "alpha",
      "zeta",
    ]);
  });

  it("ranks within the key space selected by groupBy - harness ids vs model ids", () => {
    const buckets = [
      bucket({ harnessId: "claude", model: "model-a", knownCostUsd: 5 }),
      bucket({ harnessId: "codex", model: "model-b", knownCostUsd: 1 }),
    ];
    expect(seriesKeysByTotalCost(buckets, "harness")).toEqual([
      "claude",
      "codex",
    ]);
    expect(seriesKeysByTotalCost(buckets, "model")).toEqual([
      "model-a",
      "model-b",
    ]);
  });

  it("with seventeen distinct models, the cheapest folds into Other", () => {
    const models = Array.from({ length: 17 }, (_, index) => `model-${index}`);
    const buckets = models.map((model, index) =>
      bucket({ harnessId: "claude", model, knownCostUsd: 17 - index }),
    );
    const scale = buildUsageSeriesScaleForBuckets(buckets, "model");
    expect(scale.order[scale.order.length - 1]).toBe(USAGE_SERIES_OTHER_KEY);
    // model-16 was seeded with the lowest cost (17 - 16 = 1), so it is the
    // one long-tail key that overflows into Other.
    expect(scale.colorVar("model-16")).toBe("var(--usage-series-other)");
  });

  it("assigns slots alphabetically among the selected keys, NOT in spend order", () => {
    const scale = buildUsageSeriesScaleForBuckets(
      [
        bucket({ harnessId: "zeta", knownCostUsd: 100 }),
        bucket({ harnessId: "alpha", knownCostUsd: 1 }),
      ],
      "harness",
    );
    // Spend ranks zeta first; slot order is deliberately independent of it.
    expect(scale.order).toEqual(["alpha", "zeta"]);
    expect(scale.colorVar("alpha")).toBe("var(--usage-series-1)");
    expect(scale.colorVar("zeta")).toBe("var(--usage-series-2)");
  });

  it("applies harness brand anchors without applying them to model slugs", () => {
    const buckets = [
      bucket({ harnessId: "claude", model: "codex", knownCostUsd: 2 }),
      bucket({ harnessId: "codex", model: "claude", knownCostUsd: 1 }),
    ];
    const harnessScale = buildUsageSeriesScaleForBuckets(buckets, "harness");
    const modelScale = buildUsageSeriesScaleForBuckets(buckets, "model");

    expect(harnessScale.colorVar("claude")).toBe("var(--usage-harness-claude)");
    expect(harnessScale.colorVar("codex")).toBe("var(--usage-harness-codex)");
    expect(modelScale.colorVar("claude")).toBe("var(--usage-series-1)");
    expect(modelScale.colorVar("codex")).toBe("var(--usage-series-2)");
  });

  it("keeps each series' color when a refetch merely reorders magnitudes", () => {
    // The regression this decoupling exists for: B overtakes A between two
    // responses while both stay well inside the cap. Ranking the SLOTS by
    // spend would swap their colors under a mounted surface.
    const before = buildUsageSeriesScaleForBuckets(
      [
        bucket({ harnessId: "a-series", knownCostUsd: 10 }),
        bucket({ harnessId: "b-series", knownCostUsd: 9 }),
      ],
      "harness",
    );
    const after = buildUsageSeriesScaleForBuckets(
      [
        bucket({ harnessId: "a-series", knownCostUsd: 10 }),
        bucket({ harnessId: "b-series", knownCostUsd: 11 }),
      ],
      "harness",
    );
    expect(after.colorVar("a-series")).toBe(before.colorVar("a-series"));
    expect(after.colorVar("b-series")).toBe(before.colorVar("b-series"));
    expect(after.order).toEqual(before.order);
  });

  it("still SELECTS by spend, so an alphabetically-early but cheap key folds into Other", () => {
    // 16 expensive keys sorting AFTER "aaa-cheap" alphabetically: if
    // selection followed the alphabetical slot order rather than spend, the
    // cheap key would take a slot and an expensive one would fold.
    const expensive = Array.from(
      { length: 16 },
      (_, index) => `zz-${String(index).padStart(2, "0")}`,
    );
    const buckets = [
      ...expensive.map((harnessId) => bucket({ harnessId, knownCostUsd: 50 })),
      bucket({ harnessId: "aaa-cheap", knownCostUsd: 0.01 }),
    ];
    const scale = buildUsageSeriesScaleForBuckets(buckets, "harness");
    expect(scale.colorVar("aaa-cheap")).toBe("var(--usage-series-other)");
    expect(scale.order).not.toContain("aaa-cheap");
    expect(scale.colorVar("zz-00")).toBe("var(--usage-series-1)");
  });
});

describe("groupBy: model", () => {
  it("folds same-day buckets from different models into separate segments", () => {
    const scale = buildUsageSeriesScaleForBuckets(
      [
        bucket({ harnessId: "claude", model: "a", knownCostUsd: 1 }),
        bucket({ harnessId: "claude", model: "b", knownCostUsd: 2 }),
      ],
      "model",
    );
    const columns = buildUsageChartColumns({
      days: ["2026-08-01"],
      buckets: [
        bucket({ harnessId: "claude", model: "a", knownCostUsd: 1 }),
        bucket({ harnessId: "claude", model: "b", knownCostUsd: 2 }),
      ],
      scale,
      metric: "cost",
      groupBy: "model",
    });
    const segmentA = columns[0]?.segments.find((s) => s.seriesKey === "a");
    const segmentB = columns[0]?.segments.find((s) => s.seriesKey === "b");
    expect(segmentA?.value).toBe(1);
    expect(segmentB?.value).toBe(2);
  });

  it("folds two harnesses reporting the same model into one segment", () => {
    const scale = buildUsageSeriesScaleForBuckets(
      [bucket({ harnessId: "claude", model: "shared" })],
      "model",
    );
    const columns = buildUsageChartColumns({
      days: ["2026-08-01"],
      buckets: [
        bucket({ harnessId: "claude", model: "shared", knownCostUsd: 1 }),
        bucket({ harnessId: "codex", model: "shared", knownCostUsd: 2 }),
      ],
      scale,
      metric: "cost",
      groupBy: "model",
    });
    const sharedSegment = columns[0]?.segments.find(
      (s) => s.seriesKey === "shared",
    );
    expect(sharedSegment?.value).toBe(3);
    expect(columns[0]?.segments.length).toBe(scale.order.length);
  });
});

describe("applyUsageSeriesVisibility", () => {
  const scale = buildUsageSeriesScale(["claude", "codex"]);
  const columns = buildUsageChartColumns({
    days: ["2026-08-01"],
    buckets: [
      bucket({ harnessId: "claude", knownCostUsd: 3 }),
      bucket({ harnessId: "codex", knownCostUsd: 5 }),
    ],
    scale,
    metric: "cost",
    groupBy: "harness",
  });

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
