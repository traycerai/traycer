import {
  bucketMetricValue,
  type UsageBucket,
  type UsageMetric,
} from "@/lib/usage-analytics/usage-chart-data";

/** One calendar tile. `level` 0 = no usage, 1-4 = intensity quartile. */
export interface UsageActivityCell {
  readonly day: string;
  readonly value: number;
  readonly level: 0 | 1 | 2 | 3 | 4;
}

export interface UsageActivityWeek {
  /** The week's earliest in-window day - a stable render key for the column. */
  readonly firstDay: string;
  /**
   * Always 7 slots, Sunday-first; `null` pads the partial first and last
   * weeks so every column renders the same 7-row shape.
   */
  readonly cells: ReadonlyArray<UsageActivityCell | null>;
}

export interface UsageActivityMonthLabel {
  /** Which week column the label sits above. */
  readonly weekIndex: number;
  readonly label: string;
}

export interface UsageActivityCalendar {
  readonly weeks: readonly UsageActivityWeek[];
  readonly monthLabels: readonly UsageActivityMonthLabel[];
  readonly stats: UsageActivityStats;
}

export interface UsageActivityStats {
  /** "Mar 2026" - carries the year because a 365-day span repeats month names. */
  readonly mostActiveMonth: string | null;
  /** "Nov 30, 2025" */
  readonly mostActiveDay: string | null;
  readonly longestStreakDays: number;
  readonly currentStreakDays: number;
}

const MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Folds the summary's day×harness×model buckets into one calendar of
 * per-day tiles for the activity heatmap. `days` must be the response
 * window's own oldest-first calendar-day list (`lastNCalendarDays` over the
 * RESPONSE window, same discipline as the daily chart - never a client
 * clock), so a day with no usage still gets a level-0 tile instead of
 * compressing the grid.
 */
export function buildUsageActivityCalendar(
  days: readonly string[],
  buckets: readonly UsageBucket[],
  metric: UsageMetric,
): UsageActivityCalendar {
  const valueByDay = new Map<string, number>();
  for (const bucket of buckets) {
    valueByDay.set(
      bucket.day,
      (valueByDay.get(bucket.day) ?? 0) + bucketMetricValue(bucket, metric),
    );
  }
  const cells = days.map((day) => {
    const value = valueByDay.get(day) ?? 0;
    return { day, value };
  });
  const thresholds = quartileThresholds(
    cells.map((cell) => cell.value).filter((value) => value > 0),
  );
  const leveled: UsageActivityCell[] = cells.map((cell) => ({
    ...cell,
    level: levelFor(cell.value, thresholds),
  }));
  return {
    weeks: intoWeeks(leveled),
    monthLabels: monthLabelsFor(leveled),
    stats: buildStats(leveled),
  };
}

/**
 * Quartiles over the NONZERO day values (GitHub's approach): a single
 * enormous day must not wash every ordinary day down to the faintest step,
 * which a linear-to-max scale does to any long-tailed usage history.
 */
function quartileThresholds(
  nonZeroValues: readonly number[],
): readonly [number, number, number] | null {
  if (nonZeroValues.length === 0) return null;
  const sorted = [...nonZeroValues].sort((a, b) => a - b);
  const at = (fraction: number): number => {
    const index = Math.min(
      sorted.length - 1,
      Math.floor(fraction * sorted.length),
    );
    return sorted[index] ?? 0;
  };
  return [at(0.25), at(0.5), at(0.75)];
}

/**
 * Descending comparisons so a degenerate distribution (every active day
 * equal) reads as full intensity, not the faintest step.
 */
function levelFor(
  value: number,
  thresholds: readonly [number, number, number] | null,
): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0 || thresholds === null) return 0;
  const [q1, q2, q3] = thresholds;
  if (value >= q3) return 4;
  if (value >= q2) return 3;
  if (value >= q1) return 2;
  return 1;
}

/** Sunday-first weekday index from a `YYYY-MM-DD` string, without `Date`'s local-zone re-interpretation. */
function weekdayIndex(day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(date)) {
    return 0;
  }
  // Date.UTC interprets the calendar tuple without any timezone - the day
  // string is already viewer-zone bucketed, so this never shifts a day.
  return new Date(Date.UTC(year, month - 1, date)).getUTCDay();
}

function intoWeeks(
  cells: readonly UsageActivityCell[],
): readonly UsageActivityWeek[] {
  const weeks: Array<{
    firstDay: string;
    cells: Array<UsageActivityCell | null>;
  }> = [];
  let current: Array<UsageActivityCell | null> | null = null;
  for (const cell of cells) {
    const weekday = weekdayIndex(cell.day);
    if (current === null || weekday === 0) {
      current = new Array<UsageActivityCell | null>(7).fill(null);
      weeks.push({ firstDay: cell.day, cells: current });
    }
    current[weekday] = cell;
  }
  return weeks;
}

/**
 * A label sits above the column where a month BEGINS. The window's first
 * month gets none - its start lies outside the window, and its stub column
 * would collide with the first real transition's label anyway. Transitions
 * are ≥4 weeks apart by construction, so labels never overlap.
 */
function monthLabelsFor(
  cells: readonly UsageActivityCell[],
): readonly UsageActivityMonthLabel[] {
  const labels: UsageActivityMonthLabel[] = [];
  let weekIndex = -1;
  let lastMonth: string | null = null;
  for (const cell of cells) {
    const weekday = weekdayIndex(cell.day);
    if (weekIndex === -1 || weekday === 0) weekIndex += 1;
    const month = cell.day.slice(0, 7);
    if (lastMonth !== null && month !== lastMonth) {
      labels.push({
        weekIndex,
        label: MONTH_ABBR.at(Number(month.slice(5, 7)) - 1) ?? month,
      });
    }
    lastMonth = month;
  }
  return labels;
}

/**
 * Counts back from the newest day, but an inactive TODAY (the last cell -
 * the day is not over yet) doesn't zero the streak.
 */
function currentStreak(cells: readonly UsageActivityCell[]): number {
  let current = 0;
  for (let i = cells.length - 1; i >= 0; i--) {
    const cell = cells[i];
    if (cell.value > 0) {
      current += 1;
    } else if (i === cells.length - 1) {
      continue;
    } else {
      break;
    }
  }
  return current;
}

function buildStats(cells: readonly UsageActivityCell[]): UsageActivityStats {
  const byMonth = new Map<string, number>();
  let bestDay: UsageActivityCell | null = null;
  let longest = 0;
  let run = 0;
  for (const cell of cells) {
    if (cell.value > 0) {
      byMonth.set(
        cell.day.slice(0, 7),
        (byMonth.get(cell.day.slice(0, 7)) ?? 0) + cell.value,
      );
      if (bestDay === null || cell.value > bestDay.value) bestDay = cell;
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  const current = currentStreak(cells);
  let mostActiveMonth: string | null = null;
  let bestMonthValue = 0;
  for (const [month, value] of byMonth) {
    if (value > bestMonthValue) {
      bestMonthValue = value;
      mostActiveMonth = month;
    }
  }
  return {
    mostActiveMonth:
      mostActiveMonth === null
        ? null
        : `${MONTH_ABBR.at(Number(mostActiveMonth.slice(5, 7)) - 1) ?? ""} ${mostActiveMonth.slice(0, 4)}`,
    mostActiveDay:
      bestDay === null
        ? null
        : `${MONTH_ABBR.at(Number(bestDay.day.slice(5, 7)) - 1) ?? ""} ${String(Number(bestDay.day.slice(8, 10)))}, ${bestDay.day.slice(0, 4)}`,
    longestStreakDays: longest,
    currentStreakDays: current,
  };
}

/**
 * The heatmap reads a fixed year of days regardless of the page's 7/30/90
 * picker - an activity calendar over one month is all padding. Exported so
 * the panel and tests share the constant.
 */
export const USAGE_ACTIVITY_WINDOW_DAYS = 365;
