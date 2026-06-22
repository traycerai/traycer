import type { SegmentEndState } from "@/stores/composer/chat-store";

// Neutral terminal badge for an action segment whose turn ended before its own
// completion arrived: "stopped" (user Stop → interrupted) or "superseded" (a
// steer-restart replaced the turn). Deliberately muted, NOT the destructive
// "error" styling - a user-initiated stop is not a failure. Shared by the tool,
// command, file-change, and subagent segments so all in-flight activity reads
// the same way when a turn is cut short.
export function SegmentEndStateBadge({
  endState,
}: {
  readonly endState: SegmentEndState;
}) {
  if (endState === null) return null;
  const label = endState === "interrupted" ? "stopped" : "superseded";
  return (
    <span className="shrink-0 rounded border border-border bg-muted px-1 text-overline font-medium uppercase text-muted-foreground">
      {label}
    </span>
  );
}
