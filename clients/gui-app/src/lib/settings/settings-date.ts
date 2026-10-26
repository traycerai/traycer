const MONTHS = [
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
] as const;

function twoDigits(value: number): string {
  return value.toString().padStart(2, "0");
}

function clock(date: Date): string {
  return `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * The one way Settings writes a moment, read against now: today `08:35`;
 * earlier this year `25 Oct`, or `25 Oct 08:35` with `withTime`; another
 * year `25 Oct 2025`.
 */
export function formatSettingsDate(at: number, withTime: boolean): string {
  const date = new Date(at);
  const now = new Date();
  if (sameDay(date, now)) return clock(date);
  const day = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  if (date.getFullYear() !== now.getFullYear())
    return `${day} ${date.getFullYear()}`;
  return withTime ? `${day} ${clock(date)}` : day;
}

/**
 * The same moment after a verb, as in "Moved to Personal on 25 Oct": `on`
 * before a date, `at` before today's time.
 */
export function onSettingsDate(at: number): string {
  const formatted = formatSettingsDate(at, false);
  return sameDay(new Date(at), new Date())
    ? `at ${formatted}`
    : `on ${formatted}`;
}
