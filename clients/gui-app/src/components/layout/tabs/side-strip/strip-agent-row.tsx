import { RectangleHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { displayTitle } from "@/lib/display-title";
import { useSampledNow } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import {
  PIP_FILL,
  STRIP_AGENT_DOT_CLASS,
  STRIP_AGENT_FOCUSED_CLASS,
  STRIP_AGENT_ON_SCREEN_CLASS,
  STRIP_AGENT_PANE_GLYPH_CLASS,
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

/** Where an agent's chat is, from the row's side: `null` is not on screen. */
export type StripAgentScreen = "focused" | "on-screen" | null;

/**
 * One agent nested under its task in the Activity view: the meter's pip as a
 * dot, the name, and the status or elapsed time. A chat that is on screen shows
 * a pane glyph after its name and reads in full-strength text, and the one in
 * the focused pane also takes the active row's tint; a chat that is not on
 * screen stays muted with no glyph. Presentational, so the layout editor's
 * pictures draw this same row from sample data and cannot drift from the live
 * strip.
 */
export function StripAgentRow(props: {
  readonly agent: StripAgent;
  readonly screen: StripAgentScreen;
  readonly onClick: (() => void) | undefined;
  readonly onHoverChange: ((hovering: boolean) => void) | undefined;
}): ReactNode {
  const { agent, screen, onHoverChange } = props;
  const title = displayTitle(agent.title ?? "", "agent");
  const label = `${title}, ${STATUS_LABEL[agent.status]}`;
  return (
    <button
      type="button"
      data-testid={`strip-agent-${agent.id}`}
      data-status={agent.status}
      aria-label={screen === null ? label : `${label}, on screen`}
      aria-current={screen === "focused" ? "true" : undefined}
      onClick={props.onClick}
      onPointerEnter={() => {
        onHoverChange?.(true);
      }}
      onPointerLeave={() => {
        onHoverChange?.(false);
      }}
      className={cn(
        STRIP_AGENT_ROW_CLASS,
        screen !== null && STRIP_AGENT_ON_SCREEN_CLASS,
        screen === "focused" && STRIP_AGENT_FOCUSED_CLASS,
      )}
    >
      <span
        aria-hidden
        className={cn(STRIP_AGENT_DOT_CLASS, PIP_FILL[agent.status])}
      />
      <span className="flex min-w-0 flex-1 items-center gap-1">
        <span className="min-w-0 truncate">{title}</span>
        {screen === null ? null : (
          <RectangleHorizontal
            aria-hidden
            data-testid="strip-agent-pane-glyph"
            className={STRIP_AGENT_PANE_GLYPH_CLASS}
          />
        )}
      </span>
      <Trailing agent={agent} />
    </button>
  );
}
