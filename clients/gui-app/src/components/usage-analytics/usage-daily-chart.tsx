import { useState, type ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  applyUsageSeriesVisibility,
  type UsageChartColumn,
  type UsageMetric,
} from "@/lib/usage-analytics/usage-chart-data";
import type { UsageSeriesScale } from "@/lib/usage-analytics/usage-series-scale";
import {
  formatDayLabel,
  formatMetricValue,
  niceCeil,
} from "@/lib/usage-analytics/format-metric-value";

const MAX_X_AXIS_LABELS = 9;
const Y_AXIS_TICK_FRACTIONS = [1, 0.5, 0] as const;

export interface UsageDailyChartProps {
  readonly columns: readonly UsageChartColumn[];
  readonly scale: UsageSeriesScale;
  readonly metric: UsageMetric;
}

/**
 * Per-day stacked bar chart, one bar per calendar day, segmented by harness.
 * Mark specs and spacing follow the dataviz skill: 2px surface gaps between
 * stacked segments, 4px rounded top cap on the outer segment only, no bar
 * over 24px thick. The three/one WARN-band contrast slots in the palette
 * (`usage-analytics-chart.css`) get their relief from the tooltip (hover
 * AND keyboard focus, via the shared `Tooltip` primitive) plus the
 * breakdown table beneath the chart - every value stays reachable without
 * landing exactly on a segment.
 */
export function UsageDailyChart(props: UsageDailyChartProps): ReactNode {
  const { columns, scale, metric } = props;
  // Self-contained: which series the legend chips have hidden. Toggling never
  // changes `scale.order` or its color assignment (see
  // `applyUsageSeriesVisibility`'s doc comment) - only which segments render.
  const [hiddenSeries, setHiddenSeries] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const visibleColumns = applyUsageSeriesVisibility(columns, hiddenSeries);
  const maxTotal = niceCeil(
    Math.max(0, ...visibleColumns.map((column) => column.total)),
  );
  const tickEvery = Math.max(1, Math.ceil(columns.length / MAX_X_AXIS_LABELS));
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
      <div className="flex h-[clamp(11rem,26vh,16rem)] w-full gap-3">
        <YAxis maxValue={maxTotal} metric={metric} />
        <div className="flex min-w-0 flex-1 items-stretch gap-px border-l border-b border-border/60 pl-1">
          {visibleColumns.map((column) => (
            <DayColumn
              key={column.day}
              column={column}
              scale={scale}
              metric={metric}
              maxValue={maxTotal}
            />
          ))}
        </div>
      </div>
      <XAxis days={columns.map((column) => column.day)} tickEvery={tickEvery} />
      {/* The `>= 2` gate keeps a one-chip legend off a single-series chart,
          where filtering is meaningless. It must not apply when that lone
          series is HIDDEN, though: `hiddenSeries` outlives a prop change, so
          a refetch that narrows the window to only the hidden harness would
          otherwise zero every bar (see `applyUsageSeriesVisibility`) while
          removing the only control that can bring it back. */}
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

function YAxis(props: {
  readonly maxValue: number;
  readonly metric: UsageMetric;
}): ReactNode {
  return (
    <div
      className="flex w-12 shrink-0 flex-col justify-between py-0.5 text-right text-ui-xs text-muted-foreground"
      aria-hidden
    >
      {Y_AXIS_TICK_FRACTIONS.map((fraction) => (
        <span key={fraction} className="tabular-nums">
          {formatMetricValue(props.maxValue * fraction, props.metric)}
        </span>
      ))}
    </div>
  );
}

function XAxis(props: {
  readonly days: readonly string[];
  readonly tickEvery: number;
}): ReactNode {
  return (
    <div className="flex w-full gap-px pl-[3.25rem]">
      {props.days.map((day, index) => (
        <span
          key={day}
          className="min-w-0 flex-1 truncate text-center text-ui-xs text-muted-foreground"
        >
          {index % props.tickEvery === 0 ? formatDayLabel(day) : ""}
        </span>
      ))}
    </div>
  );
}

function DayColumn(props: {
  readonly column: UsageChartColumn;
  readonly scale: UsageSeriesScale;
  readonly metric: UsageMetric;
  readonly maxValue: number;
}): ReactNode {
  const { column, scale, metric, maxValue } = props;
  // Stacking order: `scale.order` is bottom-up (matches the legend/table
  // order), but the DOM renders top-to-bottom inside a `flex-col
  // justify-end` column, so the LAST non-zero segment lands at the bottom
  // (the baseline, square) and the FIRST lands at the top (the outer edge,
  // rounded) - reversing here keeps that one rule in one place instead of
  // recomputing "which end is this" per segment.
  const nonZeroSegments = [...column.segments]
    .filter((segment) => segment.value > 0)
    .reverse();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          // The bars inside are decorative, so without this the control has
          // no accessible name at all - and a tooltip wired up as a
          // DESCRIPTION is announced inconsistently on a control that has
          // none.
          aria-label={formatDayLabel(column.day)}
          data-testid="usage-daily-chart-column"
          data-day={column.day}
          className="group flex min-w-0 flex-1 flex-col justify-end rounded-t-[4px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {nonZeroSegments.length === 0 ? (
            <span className="block h-px w-full bg-border/60" />
          ) : (
            nonZeroSegments.map((segment, index) => (
              <span
                key={segment.seriesKey}
                className={cn(
                  "block w-full transition-opacity group-hover:opacity-80",
                  index === 0 && "rounded-t-[4px]",
                )}
                style={{
                  height: `${String(maxValue > 0 ? (segment.value / maxValue) * 100 : 0)}%`,
                  backgroundColor: scale.colorVar(segment.seriesKey),
                  marginBottom:
                    index === nonZeroSegments.length - 1 ? 0 : "2px",
                }}
              />
            ))
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <DayTooltipBody column={column} scale={scale} metric={metric} />
      </TooltipContent>
    </Tooltip>
  );
}

function DayTooltipBody(props: {
  readonly column: UsageChartColumn;
  readonly scale: UsageSeriesScale;
  readonly metric: UsageMetric;
}): ReactNode {
  const { column, scale, metric } = props;
  const nonZero = column.segments.filter((segment) => segment.value > 0);
  return (
    <div className="flex flex-col gap-1">
      <p className="font-medium">{formatDayLabel(column.day)}</p>
      {nonZero.length === 0 ? (
        <p className="text-muted-foreground">No usage</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {nonZero.map((segment) => (
            <li
              key={segment.seriesKey}
              className="flex items-center justify-between gap-3"
            >
              <span className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: scale.colorVar(segment.seriesKey) }}
                />
                {scale.labelFor(segment.seriesKey)}
              </span>
              <span className="tabular-nums font-medium">
                {formatMetricValue(segment.value, metric)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Legend chips double as the chart's series filter: clicking one hides its
 * segments from every bar (see `applyUsageSeriesVisibility`) without
 * changing `scale.order` or any chip's color, so a filtered-out series can
 * always be brought back in the same slot. `aria-pressed` carries the
 * on/off state for assistive tech since the visual cue is opacity alone.
 */
function UsageChartLegend(props: {
  readonly scale: UsageSeriesScale;
  readonly hiddenSeries: ReadonlySet<string>;
  readonly onToggle: (seriesKey: string) => void;
}): ReactNode {
  return (
    <ul
      className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-[3.25rem] text-ui-xs text-muted-foreground"
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
