import { formatUsd } from "@/lib/usage-analytics/cost-format";
import type { UsageMetric } from "@/lib/usage-analytics/usage-chart-data";

export function formatMetricValue(value: number, metric: UsageMetric): string {
  if (metric === "cost") return formatUsd(value);
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
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
 * `day` is an already-bucketed `YYYY-MM-DD` string - split it directly
 * rather than parsing through `Date`, which would silently re-interpret the
 * calendar date through the BROWSER's local zone (not the viewer zone the
 * request/response already agreed on) and can shift the label by a day.
 * `.at()` (not bracket indexing) so a malformed string degrades to the raw
 * value instead of throwing - `Array#at` is typed `T | undefined`
 * regardless of `noUncheckedIndexedAccess`, so the fallback is real, not a
 * lint-only formality.
 */
export function formatDayLabel(day: string): string {
  const parts = day.split("-");
  const month = parts.at(1);
  const date = parts.at(2);
  if (month === undefined || date === undefined) return day;
  const monthIndex = Number(month) - 1;
  const monthLabel = MONTH_ABBR.at(monthIndex) ?? month;
  return `${monthLabel} ${String(Number(date))}`;
}

/**
 * The window picker's companion label - "Aug 1 – Aug 10, 2026" for the days
 * currently on the x-axis. Reads the year off the bucketed `YYYY-MM-DD`
 * strings directly (same reasoning as {@link formatDayLabel}: never through
 * `Date`, which would re-interpret the calendar date in the browser's local
 * zone). `days` is assumed non-empty and oldest-first, matching
 * `lastNCalendarDays`'s contract; an empty list renders nothing.
 *
 * Both endpoints carry their own year when they differ - a 30- or 90-day
 * window routinely straddles New Year, and reading the year off the last
 * day alone stamped the WRONG one on the first ("Dec 31 – Jan 1, 2026").
 */
export function formatDateRangeLabel(days: readonly string[]): string {
  const first = days.at(0);
  const last = days.at(-1);
  if (first === undefined || last === undefined) return "";
  const firstYear = first.split("-").at(0) ?? "";
  const lastYear = last.split("-").at(0) ?? "";
  const from = formatDayLabel(first);
  const to = formatDayLabel(last);
  if (firstYear.length === 0 || lastYear.length === 0) return `${from} – ${to}`;
  return firstYear === lastYear
    ? `${from} – ${to}, ${lastYear}`
    : `${from}, ${firstYear} – ${to}, ${lastYear}`;
}

const NICE_STEPS = [1, 2, 5, 10] as const;

/** Rounds up to a clean 1/2/5/10 step for y-axis ticks. */
export function niceCeil(value: number): number {
  if (value <= 0) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = NICE_STEPS.find((candidate) => normalized <= candidate) ?? 10;
  return step * magnitude;
}
