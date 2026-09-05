export const MINUTES_PER_HOUR = 60;
export const MINUTES_PER_DAY = MINUTES_PER_HOUR * 24;
export const MINUTES_PER_WEEK = MINUTES_PER_DAY * 7;

/** The shortest and longest a calendar month runs, in days. */
const MIN_DAYS_PER_MONTH = 28;
const MAX_DAYS_PER_MONTH = 31;

/**
 * A rolling window's length, when that length is a cadence with a NAME rather
 * than a number of days.
 */
export type NamedCadence = "hours" | "day" | "week" | "month";

/**
 * Which named cadence a duration is, or `null` for a length that has no name
 * and can only be counted.
 *
 * A month is the reason this is shared rather than inlined into either
 * formatter. Every other cadence is a fixed number of minutes, but a calendar
 * month is 28, 29, 30 or 31 days depending on which one it is — so a surface
 * that recognises a month only at exactly 30 days names a January period `31d`
 * and the February one `28d`, changing the word for a cadence that did not
 * change. Both duration formatters ask this question, so the strip's `mo` and
 * the provider page's `Monthly` are answers to the same test rather than two
 * thresholds that can drift apart.
 *
 * `hours` stops below a full day: 24 hours is a `day`, not `24h`.
 */
export function namedCadenceForDuration(minutes: number): NamedCadence | null {
  if (minutes <= 0) return null;
  if (minutes === MINUTES_PER_WEEK) return "week";
  if (minutes === MINUTES_PER_DAY) return "day";
  if (minutes % MINUTES_PER_HOUR === 0 && minutes < MINUTES_PER_DAY) {
    return "hours";
  }
  if (
    minutes >= MIN_DAYS_PER_MONTH * MINUTES_PER_DAY &&
    minutes <= MAX_DAYS_PER_MONTH * MINUTES_PER_DAY
  ) {
    return "month";
  }
  return null;
}
