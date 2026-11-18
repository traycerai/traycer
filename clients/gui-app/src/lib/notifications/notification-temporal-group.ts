export type NotificationTemporalGroup = "today" | "yesterday" | "earlier";

const DAY_MS = 86_400_000;

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Calendar-day bucket for Recent's temporal separators, based on local
 * midnight boundaries. Distinct from `relative-time.ts`'s elapsed-duration
 * buckets, which only flip to "Yesterday" after a full 24h rather than at
 * the calendar day boundary.
 */
export function temporalGroupForTimestamp(
  timestamp: number,
  now: number,
): NotificationTemporalGroup {
  const dayDelta = Math.round(
    (startOfDay(now) - startOfDay(timestamp)) / DAY_MS,
  );
  if (dayDelta <= 0) return "today";
  if (dayDelta === 1) return "yesterday";
  return "earlier";
}
