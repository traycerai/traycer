import { useElapsedSeconds } from "@/hooks/use-elapsed-seconds";
import { formatClockDuration } from "@/lib/format-duration";

interface StreamingActivityFooterProps {
  /** Wall-clock start (epoch ms) the elapsed counter ticks from. */
  readonly startedAt: number;
  /** Latest harness progress line, or null when none is reported. */
  readonly progress: string | null;
}

/**
 * Heartbeat shown under a streaming tool/command header: the latest progress
 * line (when the harness reports one) on the left and a 1s-ticking elapsed
 * counter on the right. Mounted only while the activity streams, so the
 * interval lives exactly the in-progress window. Replaces the "frozen card"
 * with a visible sign of life for long-running tools and MCP calls.
 */
export function StreamingActivityFooter(props: StreamingActivityFooterProps) {
  const { startedAt, progress } = props;
  const elapsedSeconds = useElapsedSeconds(startedAt, 0, null);
  const hasProgress = progress !== null && progress.length > 0;
  return (
    <div className="flex min-w-0 items-center gap-2 text-ui-xs text-muted-foreground">
      {hasProgress ? (
        <span className="min-w-0 flex-1 truncate">{progress}</span>
      ) : (
        <span aria-hidden className="flex-1" />
      )}
      <span className="shrink-0 tabular-nums opacity-70">
        {formatClockDuration(elapsedSeconds)}
      </span>
    </div>
  );
}
