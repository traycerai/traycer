/**
 * The last `windowDays` calendar days, in the viewer's own IANA zone,
 * oldest first - the x-axis for the per-day chart. Generated independently
 * of the response's `buckets` (which only carry days WITH usage) so a day
 * with zero activity still gets its own zero-height column instead of
 * silently compressing the axis.
 *
 * Sampled at a fixed 24h stride and formatted through `Intl.DateTimeFormat`
 * (which resolves the real IANA zone, DST included) - `en-CA` gives an
 * ISO-shaped `YYYY-MM-DD`, matching the shared aggregator's `bucket.day`
 * format exactly. A DST-short or -long day can occasionally sample the
 * boundary date twice; deduping preserves order without ever inventing an
 * extra column.
 */
export function lastNCalendarDays(
  windowDays: number,
  timeZone: string,
  nowMs: number,
): readonly string[] {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const dayMs = 24 * 60 * 60 * 1000;
  const seen = new Set<string>();
  const days: string[] = [];
  for (let i = windowDays - 1; i >= 0; i -= 1) {
    const day = formatter.format(new Date(nowMs - i * dayMs));
    if (seen.has(day)) continue;
    seen.add(day);
    days.push(day);
  }
  return days;
}
