import { useEffect, useRef, type ReactNode } from "react";
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
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  // A year grid is wider than a narrow Settings pane, and a fresh scroller
  // starts at the OLDEST week - so the current period, the whole point of
  // opening this, would sit off-screen behind a scrollbar the reader has
  // to discover. Anchor to the newest week instead. Re-runs when the week
  // count changes (window/host filter), since that resizes the content.
  const weekCount = calendar.weeks.length;
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    scroller.scrollLeft = scroller.scrollWidth;
  }, [weekCount]);
  return (
    <div
      className="flex w-full flex-col gap-3"
      data-testid="usage-activity-heatmap"
    >
      {/* The grid is decorative for assistive tech - the data table below
          carries the same values in a navigable form. */}
      <div
        ref={scrollerRef}
        aria-hidden
        className="w-full overflow-x-auto"
        data-testid="usage-activity-scroller"
      >
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
      <UsageActivityDataTable calendar={calendar} metric={metric} />
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
    // the same leading gutter the grid itself sits behind - the 10px
    // weekday column plus the 6px gap between it and the tiles, i.e. 16px
    // - so each label lands exactly over its month's first week.
    <div className="flex gap-0.5 pl-4 text-ui-xs text-muted-foreground">
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

/**
 * A tile is a MARK, not a control: it carries no action, and making each
 * of 365 a tab stop turned the calendar into a keyboard trap - the first
 * Tab landed on an off-screen date a year back (the DOM is oldest-first,
 * the scroller is anchored right), yanked the scroll position with it, and
 * reaching the stats below took hundreds more presses. So the grid is
 * hidden from assistive tech entirely and {@link UsageActivityDataTable}
 * carries the same values in a form that is actually navigable. The
 * tooltip stays for pointer users.
 */
function DayTile(props: {
  readonly cell: UsageActivityCell;
  readonly metric: UsageMetric;
}): ReactNode {
  const { cell, metric } = props;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="usage-activity-day"
          data-day={cell.day}
          data-level={cell.level}
          className="size-2.5 rounded-[2px]"
          style={{ backgroundColor: `var(--usage-heat-${String(cell.level)})` }}
        />
      </TooltipTrigger>
      <TooltipContent>
        <p>
          <span className="font-medium">{cell.day}</span>
          {" · "}
          {activityValueLabel(cell, metric)}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * What a day reads as. A day can hold real turns whose cost was never
 * available: under the Cost metric its value is 0, and calling that
 * "No usage" would report work as inactivity. It says how many turns ran
 * and that they are not counted - the same words the headline footnote
 * uses, and never the banned vocabulary (see the pricing artifact's
 * product framing).
 */
function activityValueLabel(
  cell: UsageActivityCell,
  metric: UsageMetric,
): string {
  if (cell.value > 0) return formatMetricValue(cell.value, metric);
  if (cell.factCount === 0) return "No usage";
  const turnWord = cell.factCount === 1 ? "turn" : "turns";
  return `${String(cell.factCount)} ${turnWord} · not counted`;
}

/**
 * The calendar's values for anyone not using a pointer: one row per day
 * that saw activity. Days with none are omitted - a year of "No usage"
 * rows is noise, and their absence is itself the information.
 */
function UsageActivityDataTable(props: {
  readonly calendar: UsageActivityCalendar;
  readonly metric: UsageMetric;
}): ReactNode {
  const active = props.calendar.weeks
    .flatMap((week) => week.cells)
    .filter((cell) => cell !== null)
    // Presence, not value: a day of unpriced work belongs here too.
    .filter((cell) => cell.factCount > 0);
  return (
    <table className="sr-only" data-testid="usage-activity-data-table">
      <caption>Daily usage</caption>
      <thead>
        <tr>
          <th scope="col">Day</th>
          <th scope="col">Usage</th>
        </tr>
      </thead>
      <tbody>
        {active.map((cell) => (
          <tr key={cell.day}>
            <th scope="row">{cell.day}</th>
            <td>{activityValueLabel(cell, props.metric)}</td>
          </tr>
        ))}
      </tbody>
    </table>
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
