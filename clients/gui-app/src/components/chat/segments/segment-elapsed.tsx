import { useElapsedSeconds } from "@/hooks/use-elapsed-seconds";
import { formatClockDuration } from "@/lib/format-duration";

// Shared style for every chat "elapsed / how long" counter (activity-group
// header, sub-agent card) so they stay visually in lockstep.
const ELAPSED_CLASS =
  "shrink-0 tabular-nums text-ui-xs text-muted-foreground/60";

/** The 1s tick lives in this leaf so only this span re-renders, not the surrounding card. */
export function LiveElapsed({ startedAt }: { startedAt: number }) {
  const elapsedSeconds = useElapsedSeconds(startedAt, 0, null);
  return (
    <span className={ELAPSED_CLASS}>{formatClockDuration(elapsedSeconds)}</span>
  );
}

/** The static value FLOORS (matching the live tick, so the number settles instead of jumping +1 at completion) and clamps to >= 1s so a sub-second run never reads "0s". */
export function ElapsedTime(props: {
  startedAt: number | null;
  durationMs: number | null;
  isStreaming: boolean;
}) {
  const { startedAt, durationMs, isStreaming } = props;
  if (isStreaming) {
    return startedAt === null ? null : <LiveElapsed startedAt={startedAt} />;
  }
  if (durationMs === null) return null;
  return (
    <span className={ELAPSED_CLASS}>
      {formatClockDuration(Math.max(1, Math.floor(durationMs / 1000)))}
    </span>
  );
}
