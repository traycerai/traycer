import type { SegmentEndState } from "@/stores/composer/chat-store";

// Neutral terminal badge for an action segment that ended without completing
// normally, for a reason that is NOT a genuine failure: the turn was cut short
// before the block's own completion arrived ("stopped" for user Stop →
// interrupted, "superseded" for a steer-restart), or the block reached
// `status: "errored"` but the host marked the terminal outcome as an explicit
// stop (deadline-killed Monitor, user-stopped command/subagent) rather than a
// real error. Deliberately muted, NOT the destructive "error" styling - a
// user-initiated stop is not a failure. Shared by the tool, command,
// file-change, and subagent segments so all in-flight activity reads the same
// way when cut short. `stopped` is always `false` for block types that carry
// no such field (e.g. file_change).
export function SegmentEndStateBadge({
  endState,
  stopped,
}: {
  readonly endState: SegmentEndState;
  readonly stopped: boolean;
}) {
  if (endState === null && !stopped) return null;
  const label = endState === "superseded" ? "superseded" : "stopped";
  return (
    <span className="shrink-0 rounded border border-border bg-muted px-1 text-overline font-medium uppercase text-muted-foreground">
      {label}
    </span>
  );
}
