import type { ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type {
  UsageActivityCalendar,
  UsageActivityCell,
} from "@/lib/usage-analytics/usage-activity";
import { formatMetricValue } from "@/lib/usage-analytics/format-metric-value";
import type { UsageMetric } from "@/lib/usage-analytics/usage-chart-data";

const WEEKDAY_ROW_LABELS: ReadonlyArray<{
  readonly row: number;
  readonly label: string;
}> = [
  { row: 1, label: "M" },
  { row: 3, label: "W" },
  { row: 5, label: "F" },
];

const LEVELS = [0, 1, 2, 3, 4] as const;

const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** Pairs each fixed weekday slot with its cell so render keys are the weekday, not an array index. */
function zipWeekdays(
  cells: ReadonlyArray<UsageActivityCell | null>,
): ReadonlyArray<{
  readonly weekdayKey: string;
  readonly cell: UsageActivityCell | null;
}> {
  return WEEKDAY_KEYS.map((weekdayKey, slot) => ({
    weekdayKey,
    cell: cells[slot] ?? null,
  }));
}

/**
 * GitHub-style activity calendar: one column per week (Sunday-first rows),
 * one tile per day, intensity = the day's metric value quantized to
 * quartiles (`buildUsageActivityCalendar`). Colors come from the
 * `--usage-heat-N` sequential ramp (one hue, light→dark, its own dark-mode
 * steps) scoped under `.usage-chart-root` beside the categorical palette.
 * Tiles are marks, not layout, so their fixed pixel size is fine; the grid
 * itself scrolls horizontally rather than squeezing tiles unreadable.
 */
export function UsageActivityHeatmap(props: {
  readonly calendar: UsageActivityCalendar;
  readonly metric: UsageMetric;
}): ReactNode {
  const { calendar, metric } = props;
  return (
    <div
      className="flex w-full flex-col gap-3"
      data-testid="usage-activity-heatmap"
    >
      <div className="w-full overflow-x-auto">
        <div className="flex min-w-max flex-col gap-1">
          <MonthLabelRow calendar={calendar} />
          <div className="flex gap-1.5">
            <WeekdayLabelColumn />
            <div className="flex gap-0.5" data-testid="usage-activity-grid">
              {calendar.weeks.map((week) => (
                <div key={week.firstDay} className="flex flex-col gap-0.5">
                  {zipWeekdays(week.cells).map(({ weekdayKey, cell }) =>
                    cell === null ? (
                      <span key={weekdayKey} className="size-2.5" aria-hidden />
                    ) : (
                      <DayTile key={weekdayKey} cell={cell} metric={metric} />
                    ),
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ActivityStats stats={calendar.stats} />
        <LevelLegend />
      </div>
    </div>
  );
}

function MonthLabelRow(props: {
  readonly calendar: UsageActivityCalendar;
}): ReactNode {
  const { weeks, monthLabels } = props.calendar;
  const byWeek = new Map(
    monthLabels.map((label) => [label.weekIndex, label.label]),
  );
  return (
    // Same 12px column rhythm as the tile grid (10px tile + 2px gap), and
    // the same leading gutter as the weekday label column, so each label
    // lands exactly over its month's first week.
    <div className="flex gap-0.5 pl-[1.375rem] text-ui-xs text-muted-foreground">
      {weeks.map((week, weekIndex) => (
        <span key={week.firstDay} className="w-2.5 shrink-0 overflow-visible">
          <span className="block w-8">{byWeek.get(weekIndex) ?? ""}</span>
        </span>
      ))}
    </div>
  );
}

function WeekdayLabelColumn(): ReactNode {
  return (
    <div
      className="grid shrink-0 grid-rows-7 gap-0.5 text-ui-xs text-muted-foreground"
      aria-hidden
    >
      {Array.from({ length: 7 }, (_, row) => (
        <span key={row} className="flex size-2.5 items-center justify-end pr-1">
          {WEEKDAY_ROW_LABELS.find((entry) => entry.row === row)?.label ?? ""}
        </span>
      ))}
    </div>
  );
}

function DayTile(props: {
  readonly cell: UsageActivityCell;
  readonly metric: UsageMetric;
}): ReactNode {
  const { cell, metric } = props;
  const valueLabel =
    cell.value > 0 ? formatMetricValue(cell.value, metric) : "No usage";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`${cell.day}: ${valueLabel}`}
          data-testid="usage-activity-day"
          data-day={cell.day}
          data-level={cell.level}
          className="size-2.5 rounded-[2px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
          style={{ backgroundColor: `var(--usage-heat-${String(cell.level)})` }}
        />
      </TooltipTrigger>
      <TooltipContent>
        <p>
          <span className="font-medium">{cell.day}</span>
          {" · "}
          {valueLabel}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

function ActivityStats(props: {
  readonly stats: UsageActivityCalendar["stats"];
}): ReactNode {
  const { stats } = props;
  const entries: ReadonlyArray<{
    readonly label: string;
    readonly value: string;
  }> = [
    { label: "Most active month", value: stats.mostActiveMonth ?? "—" },
    { label: "Most active day", value: stats.mostActiveDay ?? "—" },
    { label: "Longest streak", value: `${String(stats.longestStreakDays)}d` },
    { label: "Current streak", value: `${String(stats.currentStreakDays)}d` },
  ];
  return (
    <dl
      className="flex flex-wrap gap-x-6 gap-y-1"
      data-testid="usage-activity-stats"
    >
      {entries.map((entry) => (
        <div key={entry.label} className="flex flex-col">
          <dt className="text-ui-xs text-muted-foreground">{entry.label}</dt>
          <dd className="text-ui-sm font-medium text-foreground">
            {entry.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function LevelLegend(): ReactNode {
  return (
    <div
      className="flex items-center gap-1 text-ui-xs text-muted-foreground"
      aria-hidden
    >
      Fewer
      {LEVELS.map((level) => (
        <span
          key={level}
          className={cn("size-2.5 rounded-[2px]")}
          style={{ backgroundColor: `var(--usage-heat-${String(level)})` }}
        />
      ))}
      More
    </div>
  );
}
