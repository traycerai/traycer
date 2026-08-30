import type { LineSeriesOption } from "echarts/charts";
import type {
  GridComponentOption,
  TooltipComponentOption,
} from "echarts/components";
import type { ComposeOption } from "echarts/core";
import {
  formatDayLabel,
  formatMetricValue,
} from "@/lib/usage-analytics/format-metric-value";
import type {
  UsageChartColumn,
  UsageMetric,
} from "@/lib/usage-analytics/usage-chart-data";
import type { UsageSeriesScale } from "@/lib/usage-analytics/usage-series-scale";

export type UsageChartOption = ComposeOption<
  LineSeriesOption | GridComponentOption | TooltipComponentOption
>;

/**
 * Every color in the option is a series/harness CSS variable or theme token
 * REFERENCE, never a resolved value: the chart renders through ECharts' SVG
 * renderer, which writes these strings into DOM attributes and inline
 * styles where Chromium resolves them live against `.usage-chart-root`'s
 * scoped palette (and its `.dark` override). Resolving at build time would
 * freeze the first theme's colors into the option and miss a live theme
 * switch. This is why the canvas renderer is not an option here.
 */
export function buildUsageChartOption(input: {
  readonly columns: readonly UsageChartColumn[];
  readonly scale: UsageSeriesScale;
  readonly metric: UsageMetric;
  /**
   * Legend-filtered series keys. Zeroing a series' VALUES is not enough to
   * hide it: a stacked line at zero still draws its 2px stroke, so a
   * filtered harness stays visible riding the baseline or the series
   * below it. The series stays in the option (slot order and color
   * assignment never shift) but renders nothing.
   */
  readonly hiddenSeries: ReadonlySet<string>;
}): UsageChartOption {
  const { columns, scale, metric, hiddenSeries } = input;
  // A one-point line with hidden symbols renders zero visible pixels - an
  // epic whose whole life fits in one day would show an empty chart. The
  // dot only appears when it is the ONLY mark available.
  const showSymbol = columns.length === 1;
  return {
    animationDuration: 300,
    grid: { left: 4, right: 12, top: 12, bottom: 4, containLabel: true },
    xAxis: {
      type: "category",
      // The area should span the full plot, not start half a slot in - and
      // labels are thinned by ECharts (`hideOverlap`), never truncated,
      // which is the fix for the "Jul …" feedback.
      boundaryGap: false,
      data: columns.map((column) => formatDayLabel(column.day)),
      axisLabel: {
        color: "var(--muted-foreground)",
        fontSize: 11,
        hideOverlap: true,
      },
      axisLine: { lineStyle: { color: "var(--border)" } },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      axisLabel: {
        color: "var(--muted-foreground)",
        fontSize: 11,
        formatter: (value: number) => formatMetricValue(value, metric),
      },
      splitLine: { lineStyle: { color: "var(--border)", opacity: 0.5 } },
    },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "line", lineStyle: { color: "var(--border)" } },
      backgroundColor: "var(--popover)",
      borderColor: "var(--border)",
      textStyle: { color: "var(--popover-foreground)", fontSize: 12 },
      formatter: (params) => {
        const list = Array.isArray(params) ? params : [params];
        const day = list[0]?.name ?? "";
        return buildUsageTooltipHtml(
          day,
          list.map((param) => ({
            label: param.seriesName ?? "",
            colorVar:
              typeof param.color === "string" ? param.color : "currentColor",
            value: typeof param.value === "number" ? param.value : 0,
          })),
          metric,
        );
      },
    },
    series: scale.order.map((seriesKey) => {
      const colorVar = scale.colorVar(seriesKey);
      // Draw nothing for a series that contributes nothing - whether the
      // LEGEND hid it or its data is genuinely all zero (ticket 19: an
      // unpriced grok turn contributed $0, yet its stacked boundary line
      // traced the TOP of claude's mass in grok's color, so a $0 harness
      // read as owning the whole total). The series stays in the option
      // (slot order, color, legend chip, tooltip filtering all unchanged).
      const hidden =
        hiddenSeries.has(seriesKey) ||
        columns.every(
          (column) =>
            (column.segments.find((segment) => segment.seriesKey === seriesKey)
              ?.value ?? 0) === 0,
        );
      return {
        name: scale.labelFor(seriesKey),
        type: "line" as const,
        // One shared stack id turns adjacent lines into a stacked area - the
        // same accumulate-by-slot semantics the bars had.
        stack: "usage",
        smooth: true,
        showSymbol: showSymbol && !hidden,
        symbolSize: 6,
        color: colorVar,
        lineStyle: { width: hidden ? 0 : 2 },
        areaStyle: { opacity: hidden ? 0 : 0.3 },
        // Every emphasis color is pinned to the series' own var() reference.
        // This is not decorative: with no explicit emphasis color, ECharts
        // applies its default hover "color lift" (states.js -> zrender
        // `liftColor`), which parses the color to brighten it - `var(...)`
        // strings don't parse, `lift` returns undefined, and the whole
        // band/line renders as fill:none for as long as the axis pointer
        // hovers the chart. Explicit colors make `hasFillOrStroke` true and
        // skip that lift branch entirely.
        emphasis: {
          focus: "none" as const,
          lineStyle: { color: colorVar, width: hidden ? 0 : 2 },
          areaStyle: { color: colorVar, opacity: hidden ? 0 : 0.3 },
          itemStyle: { color: colorVar },
        },
        data: columns.map(
          (column) =>
            column.segments.find((segment) => segment.seriesKey === seriesKey)
              ?.value ?? 0,
        ),
      };
    }),
  };
}

export interface UsageTooltipEntry {
  readonly label: string;
  readonly colorVar: string;
  readonly value: number;
}

/**
 * The axis tooltip's body. Zero-value entries are dropped - a series the
 * legend filter zeroed out (or that simply had no usage that day) must not
 * pad the list, matching the old per-bar tooltip's behavior. The tooltip
 * element mounts INSIDE the chart container, so usage palette variables
 * marker colors resolve against the same scoped palette as the areas.
 */
export function buildUsageTooltipHtml(
  day: string,
  entries: readonly UsageTooltipEntry[],
  metric: UsageMetric,
): string {
  const nonZero = entries.filter((entry) => entry.value > 0);
  const header = `<div style="font-weight:500;margin-bottom:2px">${escapeHtml(day)}</div>`;
  if (nonZero.length === 0) {
    return `${header}<div style="opacity:0.7">No usage</div>`;
  }
  const rows = nonZero
    .map(
      (entry) =>
        `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px">` +
        `<span style="display:inline-flex;align-items:center;gap:6px">` +
        `<span style="width:8px;height:8px;border-radius:9999px;background:${escapeHtml(entry.colorVar)}"></span>` +
        `${escapeHtml(entry.label)}</span>` +
        `<span style="font-variant-numeric:tabular-nums;font-weight:500">${escapeHtml(formatMetricValue(entry.value, metric))}</span>` +
        `</div>`,
    )
    .join("");
  return `${header}${rows}`;
}

/**
 * Series labels are wire-provided harness ids and the tooltip is injected
 * as `innerHTML` by ECharts - escape rather than trust the 64-char id
 * grammar to stay markup-free forever.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
