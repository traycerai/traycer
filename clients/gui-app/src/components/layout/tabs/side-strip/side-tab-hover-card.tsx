import { useMemo, type ReactNode } from "react";
import {
  agentActivityTiers,
  type AgentActivityTier,
} from "@/lib/agent-activity";
import { agentLabelUnder } from "@/lib/display-title";
import {
  useRegisteredEpicLiveAgentIds,
  useRegisteredEpicLiveAgents,
  useRegisteredEpicTitle,
} from "@/lib/epic-selectors";
import { cn } from "@/lib/utils";
import { useEpicAgentActivity } from "@/stores/agent-activity-store";
import type { SideTabLiveAgents } from "./agent-meter";
import { sideTabAgentCounts } from "./side-tab-live-agents";
import { RAIL_BADGE_TONE, type RailBadgeKind } from "./rail-badge-kind";
import {
  BACKGROUND_ACTIVITY_TITLE,
  PARTIAL_ACTIVITY_NOTICE,
  UNKNOWN_ACTIVITY_TITLE,
} from "@/components/notifications/notification-indicator-icon";
import { StatusGlyph } from "@/components/notifications/status-glyph";
import { UnknownActivityGlyph } from "@/components/notifications/unknown-activity-glyph";

/**
 * The state line's words: short, since they sit under the task's own title.
 * The icon and any accessible name come from the tone.
 */
const HOVER_CARD_STATE_TEXT: Readonly<Record<RailBadgeKind, string>> = {
  approval: "Needs approval",
  reply: "Needs a reply",
  failed: "Failed",
  unread: "Done, unread",
};

/** The most agents the card names; the rest are counted. */
const HOVER_CARD_MAX_AGENTS = 6;

function tierOrder(tier: AgentActivityTier): number {
  return tier === "turn" ? 0 : 1;
}

/**
 * A strip row's or rail tile's hover card: the title, a state line (the
 * waiting reason first), the live-agent counts and, for an epic this window
 * holds a live session for, the working agents by name. A cold epic shows the
 * counts only, never invented rows. Mounted only while the card is open, so a
 * closed row subscribes to nothing here.
 *
 * Only the agent rows draw a running or background glyph (G5): the counts are
 * plain text, so one running agent never reads as two spinners. An attention
 * state keeps its glyph and words, since no agent row shows it.
 *
 * Under `unserved` coverage (a known machine the plane does not reach) an
 * empty count is not idleness: the state line says the status is unknown, and
 * a positive count carries the notice that more may be running out of view.
 * `indeterminate` keeps the plain reading, because "nothing is answering" is
 * the connection pill's to say, once.
 */
export function SideTabHoverCardBody(props: {
  readonly title: string;
  readonly epicId: string | null;
  readonly badge: RailBadgeKind | null;
  readonly agents: SideTabLiveAgents;
}): ReactNode {
  const counts = sideTabAgentCounts(props.agents);
  const unserved = props.agents.coverage === "unserved";
  const unknown = unserved && props.badge === null && counts === null;
  return (
    <div data-testid="side-tab-hover-card-body" className="flex flex-col gap-2">
      <div className="text-ui-sm font-medium break-words text-foreground">
        {props.title}
      </div>
      <div
        data-testid="side-tab-hover-card-state"
        className="flex items-center gap-1.5 text-muted-foreground"
      >
        <HoverCardState
          badge={props.badge}
          unknown={unknown}
          idle={counts === null}
        />
        {counts === null ? null : (
          <span
            data-testid="side-tab-hover-card-counts"
            className={cn("tabular-nums", props.badge !== null && "ms-auto")}
          >
            {counts}
          </span>
        )}
      </div>
      {unserved && !unknown ? (
        <div
          data-testid="side-tab-hover-card-partial"
          className="text-muted-foreground"
        >
          {PARTIAL_ACTIVITY_NOTICE}
        </div>
      ) : null}
      {props.epicId === null || counts === null ? null : (
        <WarmAgentList epicId={props.epicId} />
      )}
    </div>
  );
}

/**
 * The state line's lead: what needs the user, else unknown, else "Idle" - and
 * nothing when agents are working, whose plain counts follow.
 */
function HoverCardState(props: {
  readonly badge: RailBadgeKind | null;
  readonly unknown: boolean;
  readonly idle: boolean;
}): ReactNode {
  if (props.badge !== null) {
    return (
      <>
        <StatusGlyph
          status={RAIL_BADGE_TONE[props.badge]}
          className="size-3.5"
          testId={undefined}
          label={null}
        />
        <span>{HOVER_CARD_STATE_TEXT[props.badge]}</span>
      </>
    );
  }
  if (props.unknown) {
    return (
      <>
        {/* The sentence wraps: the glyph keeps its size and sits on the
            first line, one line box tall, not centred on the whole block. */}
        <span className="flex h-lh shrink-0 items-center self-start">
          <UnknownActivityGlyph testId="side-tab-hover-card-unknown" />
        </span>
        <span>{UNKNOWN_ACTIVITY_TITLE}</span>
      </>
    );
  }
  return props.idle ? <span>Idle</span> : null;
}

/**
 * The working agents by name, only when this window holds a live session for
 * the epic: names come from its projection, which a cold epic does not have.
 */
function WarmAgentList(props: { readonly epicId: string }): ReactNode {
  const liveAgentIds = useRegisteredEpicLiveAgentIds(props.epicId);
  const tiers = agentActivityTiers(useEpicAgentActivity(props.epicId));
  const working = useMemo(
    () =>
      // Turns first, the meter's order.
      [...tiers]
        .map(([agentId, tier]) => ({ agentId, tier }))
        .sort((a, b) => tierOrder(a.tier) - tierOrder(b.tier)),
    [tiers],
  );
  const refs = useMemo(
    () => working.map(({ agentId }) => ({ epicId: props.epicId, agentId })),
    [working, props.epicId],
  );
  const agents = useRegisteredEpicLiveAgents(refs);
  const taskTitle = useRegisteredEpicTitle(props.epicId);
  if (liveAgentIds === null) return null;
  const named = working.flatMap((entry, index) => {
    const agent = agents[index] ?? null;
    return agent === null ? [] : [{ ...entry, title: agent.title }];
  });
  if (named.length === 0) return null;
  const shown = named.slice(0, HOVER_CARD_MAX_AGENTS);
  const more = named.length - shown.length;
  return (
    <ul
      data-testid="side-tab-hover-card-agents"
      className="flex flex-col gap-1"
    >
      {shown.map((agent) => {
        const name = agentLabelUnder(taskTitle, agent.title);
        return (
          <li
            key={agent.agentId}
            data-tier={agent.tier}
            className="flex min-w-0 items-center gap-1.5"
          >
            <StatusGlyph
              status={agent.tier === "turn" ? "running" : "background"}
              className="size-3.5 text-muted-foreground"
              testId={undefined}
              label={
                agent.tier === "turn"
                  ? "Agent in progress"
                  : BACKGROUND_ACTIVITY_TITLE
              }
            />
            <span
              className={cn(
                "min-w-0 truncate",
                name.main ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {name.text}
            </span>
          </li>
        );
      })}
      {more > 0 ? (
        <li className="text-muted-foreground">+{more} more</li>
      ) : null}
    </ul>
  );
}
