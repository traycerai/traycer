interface StreamingActivityFooterProps {
  /** Latest harness progress line. Non-empty by construction - callers render this footer only when there is a line to show, because an empty one still costs the row a second line of vertical space. */
  readonly progress: string;
}

/** Long enough to want the full width, and it changes as the tool works, so it reads as the tool talking rather than as part of the title. */
export function StreamingActivityFooter(props: StreamingActivityFooterProps) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-ui-xs text-muted-foreground">
      <span className="min-w-0 flex-1 truncate">{props.progress}</span>
    </div>
  );
}
