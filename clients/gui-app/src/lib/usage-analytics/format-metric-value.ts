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
 * `day` is an already-bucketed `YYYY-MM-DD` string - split it directly rather than parsing through `Date`, which would silently re-interpret the calendar date through the BROWSER's local zone (not the viewer zone the request/response already agreed on) and.
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
 * The window picker's companion label - "Aug 1 - Aug 10, 2026" for the days currently on the x-axis.
 * Reads the year off the bucketed `YYYY-MM-DD` strings directly (same reasoning as {@link formatDayLabel}: never through `Date`, which would re-interpret the calendar date in the browser's local zone).
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
