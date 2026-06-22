import { useElapsedSeconds } from "@/hooks/use-elapsed-seconds";
import { formatClockDuration } from "@/lib/format-duration";

// Shared style for every chat "elapsed / how long" counter (activity-group
// header, sub-agent card) so they stay visually in lockstep.
const ELAPSED_CLASS =
  "shrink-0 tabular-nums text-ui-xs text-muted-foreground/60";

/**
 * Live-ticking elapsed since `startedAt`, floored to whole seconds. The 1s tick
 * lives in this leaf so only this span re-renders, not the surrounding card.
 * Mounted only while the work is in flight (the caller unmounts it on finish),
 * which is exactly when the interval should run.
 */
export function LiveElapsed({ startedAt }: { startedAt: number }) {
  const elapsedSeconds = useElapsedSeconds(startedAt, 0, null);
  return (
    <span className={ELAPSED_CLASS}>{formatClockDuration(elapsedSeconds)}</span>
  );
}

/**
 * Elapsed time for an action surface: ticks live from `startedAt` while running,
 * then shows the static total once finished. The static value FLOORS (matching
 * the live tick, so the number settles instead of jumping +1 at completion) and
 * clamps to >= 1s so a sub-second run never reads "0s". Renders nothing when the
 * anchor/duration is unknown (e.g. blocks persisted before the field existed).
 */
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
