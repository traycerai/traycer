import { describe, expect, it } from "vitest";
import type { LineSeriesOption } from "echarts/charts";
import {
  buildUsageChartColumns,
  applyUsageSeriesVisibility,
} from "@/lib/usage-analytics/usage-chart-data";
import type { UsageBucket } from "@/lib/usage-analytics/usage-chart-data";
import {
  buildUsageChartOption,
  buildUsageTooltipHtml,
  type UsageChartOption,
} from "@/lib/usage-analytics/usage-chart-option";
import { buildUsageSeriesScale } from "@/lib/usage-analytics/usage-series-scale";

function bucket(overrides: Partial<UsageBucket>): UsageBucket {
  return {
    day: "2026-08-01",
    harnessId: "claude",
    model: "claude-sonnet-5",
    factCount: 1,
    tokens: {
      uncachedInputTokens: 10,
      cacheReadInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
    },
    knownCostUsd: 1,
    knownCacheSavingsUsd: 0,
    knownReasoningTokens: 0,
    costProvenance: "providerReported",
    ...overrides,
  };
}

function seriesList(option: UsageChartOption): readonly LineSeriesOption[] {
  const { series } = option;
  if (series === undefined) return [];
  return Array.isArray(series) ? series : [series];
}

const scale = buildUsageSeriesScale(["claude", "codex"]);
const days = ["2026-08-01", "2026-08-02"] as const;
const columns = buildUsageChartColumns({
  days: [...days],
  buckets: [
    bucket({ day: "2026-08-01", harnessId: "claude", knownCostUsd: 3 }),
    bucket({ day: "2026-08-02", harnessId: "codex", knownCostUsd: 5 }),
  ],
  scale,
  metric: "cost",
  groupBy: "harness",
});

describe("buildUsageChartOption", () => {
  const option = buildUsageChartOption({
    columns,
    scale,
    metric: "cost",
    hiddenSeries: new Set(),
  });

  it("emits one stacked area series per scale slot, in slot order", () => {
    const series = seriesList(option);
    expect(series.map((entry) => entry.name)).toEqual(["claude", "codex"]);
    // One shared stack id is what turns adjacent lines into stacked areas.
    expect(new Set(series.map((entry) => entry.stack)).size).toBe(1);
    for (const entry of series) {
      expect(entry.type).toBe("line");
      expect(entry.areaStyle).toBeDefined();
    }
  });

  it("maps per-day segment values into each series, keeping explicit zeros", () => {
    const series = seriesList(option);
    expect(series[0]?.data).toEqual([3, 0]);
    expect(series[1]?.data).toEqual([0, 5]);
  });

  it("colors every series with a var() reference, never a resolved value", () => {
    // The SVG renderer writes these strings into DOM attributes where the
    // `.usage-chart-root` scoped palette (and its `.dark` override) resolves
    // them live - a resolved hex here would freeze the mount-time theme.
    for (const entry of seriesList(option)) {
      expect(entry.color).toMatch(/^var\(--usage-series-/);
    }
  });

  it("pins explicit emphasis colors so hover never runs the default color lift", () => {
    // Regression: with no explicit emphasis color, ECharts "lifts" the
    // series color on hover by parsing it - `var(...)` doesn't parse, the
    // lift returns undefined, and the whole chart blanked out under the
    // axis pointer (2026-08-11 live report).
    for (const entry of seriesList(option)) {
      const emphasis = entry.emphasis;
      expect(emphasis?.lineStyle?.color).toMatch(/^var\(--usage-series-/);
      expect(emphasis?.areaStyle?.color).toMatch(/^var\(--usage-series-/);
      expect(emphasis?.itemStyle?.color).toMatch(/^var\(--usage-series-/);
    }
  });

  it("labels the x-axis with formatted day labels", () => {
    const { xAxis } = option;
    const axis = Array.isArray(xAxis) ? xAxis[0] : xAxis;
    expect(axis).toMatchObject({ data: ["Aug 1", "Aug 2"] });
  });

  it("shows point symbols only when a single day leaves nothing else visible", () => {
    expect(
      seriesList(option).every((entry) => entry.showSymbol === false),
    ).toBe(true);
    const single = buildUsageChartOption({
      columns: columns.slice(0, 1),
      scale,
      metric: "cost",
      hiddenSeries: new Set(),
    });
    // Only series with something to mark: a zero-valued series draws
    // nothing at all (see the all-zero suppression), symbol included.
    const singleSeries = seriesList(single);
    expect(
      singleSeries.find((entry) => entry.name === "claude")?.showSymbol,
    ).toBe(true);
    expect(
      singleSeries.find((entry) => entry.name === "codex")?.showSymbol,
    ).toBe(false);
  });

  it("keeps a hidden series present as zeros so slots and colors never shift", () => {
    const filtered = buildUsageChartOption({
      columns: applyUsageSeriesVisibility(columns, new Set(["codex"])),
      scale,
      metric: "cost",
      hiddenSeries: new Set(["codex"]),
    });
    const series = seriesList(filtered);
    expect(series.map((entry) => entry.name)).toEqual(["claude", "codex"]);
    expect(series[1]?.data).toEqual([0, 0]);
  });

  it("draws nothing for a hidden series - zeroed values alone still stroke a line", () => {
    // A stacked line at zero rides the baseline (or the series below it) and
    // stays visible with its 2px stroke, so filtering it out of the legend
    // has to suppress the stroke/area/symbol too, not just the values.
    const filtered = buildUsageChartOption({
      columns: applyUsageSeriesVisibility(columns, new Set(["codex"])),
      scale,
      metric: "cost",
      hiddenSeries: new Set(["codex"]),
    });
    const codex = seriesList(filtered).find((entry) => entry.name === "codex");
    expect(codex?.lineStyle?.width).toBe(0);
    expect(codex?.areaStyle?.opacity).toBe(0);
    expect(codex?.showSymbol).toBe(false);
    expect(codex?.emphasis?.lineStyle?.width).toBe(0);
    // The visible series keeps its full treatment.
    const claude = seriesList(filtered).find(
      (entry) => entry.name === "claude",
    );
    expect(claude?.lineStyle?.width).toBe(2);
    expect(claude?.areaStyle?.opacity).toBe(0.3);
  });
});

describe("buildUsageChartOption — all-zero visible series", () => {
  it("draws no stroke for a series whose every value is zero", () => {
    // Ticket 19 (live staging): an unpriced grok turn contributed $0, yet
    // its stacked boundary line traced the top of claude's mass in grok's
    // color - a $0 harness read as owning the whole total. All-zero
    // series render nothing; the legend chip and tooltip stay.
    const zeroScale = buildUsageSeriesScale(["claude", "grok"]);
    const option = buildUsageChartOption({
      columns: buildUsageChartColumns({
        days: [...days],
        buckets: [
          bucket({ day: "2026-08-01", harnessId: "claude", knownCostUsd: 9 }),
        ],
        scale: zeroScale,
        metric: "cost",
        groupBy: "harness",
      }),
      scale: zeroScale,
      metric: "cost",
      hiddenSeries: new Set(),
    });
    const grok = seriesList(option).find((entry) => entry.name === "grok");
    expect(grok?.lineStyle?.width).toBe(0);
    expect(grok?.areaStyle?.opacity).toBe(0);
    const claude = seriesList(option).find((entry) => entry.name === "claude");
    expect(claude?.lineStyle?.width).toBe(2);
  });
});

describe("buildUsageTooltipHtml", () => {
  it("drops zero-value entries and formats the rest for the metric", () => {
    const html = buildUsageTooltipHtml(
      "Aug 1",
      [
        { label: "claude", colorVar: "var(--usage-series-1)", value: 3 },
        { label: "codex", colorVar: "var(--usage-series-2)", value: 0 },
      ],
      "cost",
    );
    expect(html).toContain("Aug 1");
    expect(html).toContain("claude");
    expect(html).toContain("$3.00");
    expect(html).not.toContain("codex");
  });

  it("says no-usage instead of rendering an empty body", () => {
    const html = buildUsageTooltipHtml("Aug 1", [], "cost");
    expect(html).toContain("No usage");
  });

  it("escapes wire-provided labels - the tooltip is injected as innerHTML", () => {
    const html = buildUsageTooltipHtml(
      "Aug 1",
      [{ label: "<img src=x>", colorVar: "red", value: 1 }],
      "tokens",
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x&gt;");
  });
});
