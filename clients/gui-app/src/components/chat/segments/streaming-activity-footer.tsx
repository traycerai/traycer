interface StreamingActivityFooterProps {
  /**
   * Latest harness progress line. Non-empty by construction - callers render
   * this footer only when there is a line to show, because an empty one still
   * costs the row a second line of vertical space.
   */
  readonly progress: string;
}

/**
 * The latest progress line, on its own line under a streaming tool header. Long
 * enough to want the full width, and it changes as the tool works, so it reads
 * as the tool talking rather than as part of the title.
 *
 * The elapsed counter used to share this line, pinned right. That put a lone
 * "37s" on a second row under every streaming command - commands report no
 * progress at all, so the row existed purely to hold the number - and split one
 * activity across two lines. It now sits in the header row itself, immediately
 * left of the live pulse, which is where the standalone card variant always
 * showed it. See `resolveToolHeaderElapsed` and `CommandSegment`'s status span.
 */
export function StreamingActivityFooter(props: StreamingActivityFooterProps) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-ui-xs text-muted-foreground">
      <span className="min-w-0 flex-1 truncate">{props.progress}</span>
    </div>
  );
}
