import { useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  applyUsageSeriesVisibility,
  type UsageChartColumn,
  type UsageMetric,
} from "@/lib/usage-analytics/usage-chart-data";
import { buildUsageChartOption } from "@/lib/usage-analytics/usage-chart-option";
import {
  formatDayLabel,
  formatMetricValue,
} from "@/lib/usage-analytics/format-metric-value";
import type { UsageSeriesScale } from "@/lib/usage-analytics/usage-series-scale";
import { EChartsContainer } from "@/components/usage-analytics/echarts-container";

export interface UsageDailyChartProps {
  readonly columns: readonly UsageChartColumn[];
  readonly scale: UsageSeriesScale;
  readonly metric: UsageMetric;
}

/**
 * Per-day stacked AREA chart, one point per calendar day, one band per
 * harness, drawn by ECharts (2026-08-11 feedback round: the hand-rolled
 * bars truncated every x-axis label past ~10 days, and the team asked for
 * the area-chart look). Data flow is unchanged from the bar era:
 * `columns`/`scale` in, the legend-chip filter zeroes hidden series via
 * `applyUsageSeriesVisibility`, and `buildUsageChartOption` maps the result
 * onto an ECharts option. Exact values stay reachable without a pointer
 * through the breakdown tables beneath the chart - that has been their
 * documented relief-channel role since the bar version.
 */
export function UsageDailyChart(props: UsageDailyChartProps): ReactNode {
  const { columns, scale, metric } = props;
  // Self-contained: which series the legend chips have hidden. Toggling never
  // changes `scale.order` or its color assignment (see
  // `applyUsageSeriesVisibility`'s doc comment) - only which bands render.
  const [hiddenSeries, setHiddenSeries] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const visibleColumns = useMemo(
    () => applyUsageSeriesVisibility(columns, hiddenSeries),
    [columns, hiddenSeries],
  );
  const option = useMemo(
    () =>
      buildUsageChartOption({
        columns: visibleColumns,
        scale,
        metric,
        hiddenSeries,
      }),
    [visibleColumns, hiddenSeries, scale, metric],
  );
  const toggleSeries = (seriesKey: string) => {
    setHiddenSeries((prev) => {
      const next = new Set(prev);
      if (next.has(seriesKey)) {
        next.delete(seriesKey);
      } else {
        next.add(seriesKey);
      }
      return next;
    });
  };

  return (
    <div
      className="usage-chart-root flex w-full flex-col gap-2"
      data-testid="usage-daily-chart"
    >
      <EChartsContainer
        option={option}
        className="h-[clamp(11rem,26vh,16rem)] w-full"
        ariaLabel="Daily usage chart"
        testId="usage-daily-chart-canvas"
      />
      <UsageDailyChartDataTable
        columns={visibleColumns}
        scale={scale}
        metric={metric}
        hiddenSeries={hiddenSeries}
      />
      {/* The `>= 2` gate keeps a one-chip legend off a single-series chart,
          where filtering is meaningless. It must not apply when that lone
          series is HIDDEN, though: `hiddenSeries` outlives a prop change, so
          a refetch that narrows the window to only the hidden harness would
          otherwise zero the whole chart (see `applyUsageSeriesVisibility`)
          while removing the only control that can bring it back. */}
      {scale.order.length >= 2 ||
      scale.order.some((seriesKey) => hiddenSeries.has(seriesKey)) ? (
        <UsageChartLegend
          scale={scale}
          hiddenSeries={hiddenSeries}
          onToggle={toggleSeries}
        />
      ) : null}
    </div>
  );
}

/**
 * The chart's values as a real table, visually hidden but fully in the
 * accessibility tree and reachable by keyboard.
 *
 * The bar version made every day a focusable button, so tabbing through the
 * chart read out each day's total; ECharts draws one opaque graphic whose
 * per-day values live only in a POINTER-triggered tooltip. The Settings
 * dashboard has a by-day breakdown table underneath, but the epic dialog's
 * table is grouped by chat, so without this there is no non-pointer path to
 * the plotted values there at all.
 *
 * Hidden series are omitted, matching what the chart draws - the table is
 * the same view by another means, not a second, contradictory dataset.
 */
function UsageDailyChartDataTable(props: {
  readonly columns: readonly UsageChartColumn[];
  readonly scale: UsageSeriesScale;
  readonly metric: UsageMetric;
  readonly hiddenSeries: ReadonlySet<string>;
}): ReactNode {
  const { columns, scale, metric, hiddenSeries } = props;
  const visibleKeys = scale.order.filter((key) => !hiddenSeries.has(key));
  return (
    <table className="sr-only" data-testid="usage-daily-chart-data-table">
      <caption>Daily usage by harness</caption>
      <thead>
        <tr>
          <th scope="col">Day</th>
          {visibleKeys.map((seriesKey) => (
            <th key={seriesKey} scope="col">
              {scale.labelFor(seriesKey)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {columns.map((column) => (
          <tr key={column.day}>
            <th scope="row">{formatDayLabel(column.day)}</th>
            {visibleKeys.map((seriesKey) => (
              <td key={seriesKey}>
                {formatMetricValue(
                  column.segments.find(
                    (segment) => segment.seriesKey === seriesKey,
                  )?.value ?? 0,
                  metric,
                )}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Legend chips double as the chart's series filter: clicking one hides its
 * band from the chart (see `applyUsageSeriesVisibility`) without changing
 * `scale.order` or any chip's color, so a filtered-out series can always be
 * brought back in the same slot. `aria-pressed` carries the on/off state
 * for assistive tech since the visual cue is opacity alone.
 */
function UsageChartLegend(props: {
  readonly scale: UsageSeriesScale;
  readonly hiddenSeries: ReadonlySet<string>;
  readonly onToggle: (seriesKey: string) => void;
}): ReactNode {
  return (
    <ul
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-ui-xs text-muted-foreground"
      data-testid="usage-daily-chart-legend"
    >
      {props.scale.order.map((seriesKey) => {
        const hidden = props.hiddenSeries.has(seriesKey);
        return (
          <li key={seriesKey}>
            <button
              type="button"
              aria-pressed={hidden ? "false" : "true"}
              data-testid={`usage-daily-chart-legend-chip-${seriesKey}`}
              className={cn(
                "flex items-center gap-1.5 rounded-sm outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-ring",
                hidden ? "opacity-40" : "opacity-100",
              )}
              onClick={() => props.onToggle(seriesKey)}
            >
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: props.scale.colorVar(seriesKey) }}
              />
              {props.scale.labelFor(seriesKey)}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
