const FALLBACK_TIME_ZONE = "UTC";

/**
 * `en-CA` numeric formatting gives an ISO-shaped `YYYY-MM-DD`, matching the
 * shared aggregator's `bucket.day` format exactly. A zone name the runtime
 * does not know makes the constructor throw `RangeError` - the response's
 * `timezone` is echoed by the host and only schema-checked for length, so
 * degrade to UTC rather than letting an unknown zone take the whole chart
 * (and its dialog) down mid-render.
 */
function dayKeyFormatter(timeZone: string): Intl.DateTimeFormat {
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  };
  try {
    return new Intl.DateTimeFormat("en-CA", { ...options, timeZone });
  } catch {
    return new Intl.DateTimeFormat("en-CA", {
      ...options,
      timeZone: FALLBACK_TIME_ZONE,
    });
  }
}

/**
 * The calendar day before `dayKey`, as pure `YYYY-MM-DD` arithmetic through
 * a UTC `Date` - no zone is involved, because a calendar date has already
 * been resolved out of one. `Date.UTC` normalizes an out-of-range day
 * (`0`, `-1`) back across the month/year boundary for us.
 */
function previousCalendarDay(dayKey: string): string {
  const parts = dayKey.split("-");
  const year = Number(parts.at(0));
  const month = Number(parts.at(1));
  const day = Number(parts.at(2));
  const previous = new Date(Date.UTC(year, month - 1, day - 1));
  const pad = (value: number, width: number): string =>
    String(value).padStart(width, "0");
  return `${pad(previous.getUTCFullYear(), 4)}-${pad(previous.getUTCMonth() + 1, 2)}-${pad(previous.getUTCDate(), 2)}`;
}

/**
 * The last `windowDays` calendar days, in the viewer's own IANA zone,
 * oldest first - the x-axis for the per-day chart. Generated independently
 * of the response's `buckets` (which only carry days WITH usage) so a day
 * with zero activity still gets its own zero-height column instead of
 * silently compressing the axis.
 *
 * The anchor instant is resolved to a local calendar date ONCE, through
 * `Intl.DateTimeFormat` (which knows the real IANA zone, DST included), and
 * every earlier day is then produced by decrementing that date. Walking a
 * fixed 24h stride instead - the original shape - is wrong twice over,
 * because a local day is not always 24h long: the fall-back day is 25h, so
 * two samples land on the same date and the axis silently returns FEWER
 * than `windowDays` columns (a real 10-day New York window ending
 * 2026-11-05 returned 9, dropping its oldest day); the spring-forward day
 * is 23h, so a sample can skip a date entirely and the chart loses a column
 * whose usage is still counted in the totals.
 */
export function lastNCalendarDays(
  windowDays: number,
  timeZone: string,
  nowMs: number,
): readonly string[] {
  const formatter = dayKeyFormatter(timeZone);
  const days: string[] = [];
  let day = formatter.format(new Date(nowMs));
  for (let i = 0; i < windowDays; i += 1) {
    days.push(day);
    day = previousCalendarDay(day);
  }
  return days.reverse();
}
