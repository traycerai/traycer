import type { ReactNode } from "react";
import { displayTitle } from "@/lib/display-title";
import { useSampledNow } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import {
  PIP_FILL,
  STRIP_AGENT_DOT_CLASS,
  STRIP_AGENT_ROW_CLASS,
  STRIP_AGENT_TRAILING_CLASS,
} from "./side-strip-tokens";
import type { StripAgent, StripAgentStatus } from "./strip-task-agents";

const MINUTE_MS = 60_000;

/** Each status's name, the row's accessible name after its title. */
const STATUS_LABEL: Readonly<Record<StripAgentStatus, string>> = {
  waiting: "needs you",
  failed: "failed",
  turn: "running",
  background: "background",
};

/** "<1m", "12m", "2h 5m": how long a running agent has gone, never an age. */
function formatElapsed(elapsedMs: number): string {
  const minutes = Math.floor(Math.max(0, elapsedMs) / MINUTE_MS);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0
    ? `${String(hours)}h`
    : `${String(hours)}h ${String(rest)}m`;
}

/** Its own leaf, so the shared minute tick repaints this span and not the row. */
function ElapsedTime(props: { readonly since: number }): ReactNode {
  const now = useSampledNow();
  return (
    <span className={STRIP_AGENT_TRAILING_CLASS}>
      {formatElapsed(now - props.since)}
    </span>
  );
}

function Trailing(props: { readonly agent: StripAgent }): ReactNode {
  const { agent } = props;
  if (agent.status === "turn") return <ElapsedTime since={agent.since} />;
  return (
    <span
      className={cn(
        STRIP_AGENT_TRAILING_CLASS,
        agent.status === "waiting" && "text-warning-foreground",
        agent.status === "failed" && "text-destructive",
      )}
    >
      {STATUS_LABEL[agent.status]}
    </span>
  );
}

/**
 * One agent nested under its task in the Activity view: the meter's pip as a
 * dot, the name, and the status or elapsed time. Presentational, so the layout
 * editor's pictures draw this same row from sample data and cannot drift from
 * the live strip.
 */
export function StripAgentRow(props: {
  readonly agent: StripAgent;
  readonly onClick: (() => void) | undefined;
}): ReactNode {
  const { agent } = props;
  const title = displayTitle(agent.title ?? "", "agent");
  return (
    <button
      type="button"
      data-testid={`strip-agent-${agent.id}`}
      data-status={agent.status}
      aria-label={`${title}, ${STATUS_LABEL[agent.status]}`}
      onClick={props.onClick}
      className={STRIP_AGENT_ROW_CLASS}
    >
      <span
        aria-hidden
        className={cn(STRIP_AGENT_DOT_CLASS, PIP_FILL[agent.status])}
      />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <Trailing agent={agent} />
    </button>
  );
}
