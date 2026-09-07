import { useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  applyUsageSeriesVisibility,
  type UsageChartColumn,
  type UsageChartGroupBy,
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
  /** The dimension `columns`/`scale` were folded by - names the series dimension in the accessible data table's
   * caption. */
  readonly groupBy: UsageChartGroupBy;
}

/** Exact values stay reachable without a pointer through the breakdown tables beneath the chart - that has been
 * their documented relief-channel role since the bar version. */
export function UsageDailyChart(props: UsageDailyChartProps): ReactNode {
  const { columns, scale, metric, groupBy } = props;
  // Toggling never changes `scale.order` or its color assignment (see `applyUsageSeriesVisibility`'s doc
  // comment) - only which bands render.
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
        groupBy={groupBy}
      />
      {/* It must not apply when that lone series is hidden, though. */}
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

/** The bar version made every day a focusable button, so tabbing through the chart read out each day's total;
 * ECharts draws one opaque graphic whose per-day values live only in a pointer-triggered tooltip. */
function UsageDailyChartDataTable(props: {
  readonly columns: readonly UsageChartColumn[];
  readonly scale: UsageSeriesScale;
  readonly metric: UsageMetric;
  readonly hiddenSeries: ReadonlySet<string>;
  readonly groupBy: UsageChartGroupBy;
}): ReactNode {
  const { columns, scale, metric, hiddenSeries, groupBy } = props;
  const visibleKeys = scale.order.filter((key) => !hiddenSeries.has(key));
  return (
    <table className="sr-only" data-testid="usage-daily-chart-data-table">
      <caption>
        {groupBy === "harness"
          ? "Daily usage by harness"
          : "Daily usage by model"}
      </caption>
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

/** Legend chips double as the chart's series filter. */
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
