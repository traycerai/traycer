import type { ReactNode } from "react";
import { NestedChatStatusGlyph } from "@/components/epic-canvas/sidebar/epic-sidebar-chat-tree";
import { displayTitle } from "@/lib/display-title";
import { cn } from "@/lib/utils";
import {
  STRIP_AGENT_ON_SCREEN_CLASS,
  STRIP_AGENT_ROW_CLASS,
  STRIP_AGENT_TRAILING_CLASS,
} from "./side-strip-tokens";
import { StripElapsedTime } from "./strip-elapsed-time";
import { NEEDS_YOU_VERB } from "./strip-sections";
import type { StripAgent, StripAgentStatus } from "./strip-task-agents";

/** Each status's name, the row's accessible name after its title. */
const STATUS_LABEL: Readonly<Record<StripAgentStatus, string>> = {
  waiting: "needs you",
  failed: "failed",
  turn: "running",
  background: "background",
};

/** A waiting agent says what it asks, "Reply" or "Approve"; a pending fork just that it waits. */
function labelOf(agent: StripAgent): string {
  if (agent.kind === "approval") return NEEDS_YOU_VERB.approval;
  if (agent.kind === "interview") return NEEDS_YOU_VERB.reply;
  return STATUS_LABEL[agent.status];
}

function Trailing(props: { readonly agent: StripAgent }): ReactNode {
  const { agent } = props;
  if (agent.status === "turn") {
    // No start time known (`since` is 0): no time, rather than an epoch's worth.
    return agent.since > 0 ? (
      <StripElapsedTime
        since={agent.since}
        className={STRIP_AGENT_TRAILING_CLASS}
        testId={undefined}
      />
    ) : null;
  }
  return (
    <span
      className={cn(
        STRIP_AGENT_TRAILING_CLASS,
        agent.status === "waiting" && "text-warning-foreground",
        agent.status === "failed" && "text-destructive",
      )}
    >
      {labelOf(agent)}
    </span>
  );
}

/**
 * One agent nested under its task in the Activity view: the glyph its row
 * shows in the Agents panel, the name, and the status or elapsed time. A chat
 * that is on screen, in any pane, reads in full-strength text; one that is not
 * stays muted. Presentational, so the layout editor's pictures draw this same
 * row from sample data and cannot drift from the live strip.
 */
export function StripAgentRow(props: {
  readonly agent: StripAgent;
  readonly onScreen: boolean;
  readonly onClick: (() => void) | undefined;
  readonly onHoverChange: ((hovering: boolean) => void) | undefined;
}): ReactNode {
  const { agent, onScreen, onHoverChange } = props;
  const title = displayTitle(agent.title ?? "", "agent");
  const label = `${title}, ${labelOf(agent)}`;
  return (
    <button
      type="button"
      data-testid={`strip-agent-${agent.id}`}
      data-status={agent.status}
      aria-label={onScreen ? `${label}, on screen` : label}
      onClick={props.onClick}
      onPointerEnter={() => {
        onHoverChange?.(true);
      }}
      onPointerLeave={() => {
        onHoverChange?.(false);
      }}
      className={cn(
        STRIP_AGENT_ROW_CLASS,
        onScreen && STRIP_AGENT_ON_SCREEN_CLASS,
      )}
    >
      <NestedChatStatusGlyph kind={agent.kind} />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <Trailing agent={agent} />
    </button>
  );
}
