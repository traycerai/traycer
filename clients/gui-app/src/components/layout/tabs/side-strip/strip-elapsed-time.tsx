import type { ReactNode } from "react";
import { useSampledNow } from "@/lib/relative-time";

const MINUTE_MS = 60_000;

/** "<1m", "12m", "2h 5m", "3d": how long something has gone, never an age. */
function formatElapsed(elapsedMs: number): string {
  const minutes = Math.floor(Math.max(0, elapsedMs) / MINUTE_MS);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `${String(Math.floor(hours / 24))}d`;
  const rest = minutes % 60;
  return rest === 0
    ? `${String(hours)}h`
    : `${String(hours)}h ${String(rest)}m`;
}

/**
 * The time since `since`, in its own leaf so the shared minute tick repaints
 * this span and not the row that holds it.
 */
export function StripElapsedTime(props: {
  readonly since: number;
  readonly className: string;
  readonly testId: string | undefined;
}): ReactNode {
  const now = useSampledNow();
  return (
    <span data-testid={props.testId} className={props.className}>
      {formatElapsed(now - props.since)}
    </span>
  );
}
