import type { CSSProperties, ReactNode } from "react";
import type { AgentActivityCoverage } from "@/lib/agent-activity";
import { useMotionEnabled } from "@/lib/animation/use-motion-enabled";
import { cn } from "@/lib/utils";
import type { RailBadgeKind } from "./rail-badge-kind";
import { sideTabAgentsAreFloor } from "./side-tab-live-agents";
import {
  PIP_FILL,
  type MeterPip,
  SIDE_TAB_METER_CLASS,
  SIDE_TAB_METER_MORE_CLASS,
  SIDE_TAB_METER_PIP_CLASS,
} from "./side-strip-tokens";

/**
 * A task's live agents by tier, from `useEpicAgentActivity`, and whether the
 * activity plane reaches every machine they could be on. Under `unserved` the
 * counts are what is known, a floor, and the meter says so.
 */
export interface SideTabLiveAgents {
  readonly turn: number;
  readonly background: number;
  readonly coverage: AgentActivityCoverage;
}

/** The most pips a meter draws; the rest become "+N". */
const METER_MAX_PIPS = 4;
/** The breathing pips' stagger, so a run of them reads as a wave. */
const BREATHE_STAGGER_MS = 250;

const ATTENTION_PIP: Readonly<Record<RailBadgeKind, MeterPip>> = {
  approval: "waiting",
  reply: "waiting",
  failed: "failed",
  unread: "unread",
};

/**
 * "2 running, 1 background, waiting for you" - the meter's accessible name.
 * A floor says "2+ running", the account row's "N+" language.
 */
function sideTabMeterLabel(
  agents: SideTabLiveAgents,
  attention: RailBadgeKind | null,
): string {
  const floor = sideTabAgentsAreFloor(agents) ? "+" : "";
  const parts: string[] = [];
  if (agents.turn > 0) parts.push(`${String(agents.turn)}${floor} running`);
  if (agents.background > 0) {
    parts.push(`${String(agents.background)}${floor} background`);
  }
  if (attention !== null) parts.push(ATTENTION_LABEL[attention]);
  return parts.join(", ");
}

const ATTENTION_LABEL: Readonly<Record<RailBadgeKind, string>> = {
  approval: "waiting for your approval",
  reply: "waiting for your reply",
  failed: "failed",
  unread: "done, unread",
};

/**
 * The meter (D5): one pip per live agent - a breathing pip for a turn, a
 * hollow one for background work - then one coloured pip for the task's
 * attention state, which is never the one cut. At most four pips; the agents
 * that do not fit become "+N". A trailing "+" marks known agents on a plane
 * that misses a machine: two pips and "+" read as the account row's "2+".
 * Static when motion is off.
 *
 * The tile always mounts it, empty or not, so the monogram above it stays put;
 * the row mounts it only when it has something to say.
 */
export function SideTabMeter(props: {
  readonly agents: SideTabLiveAgents;
  readonly attention: RailBadgeKind | null;
  readonly size: "tile" | "row";
}): ReactNode {
  const motionEnabled = useMotionEnabled();
  const { agents, attention, size } = props;
  const agentCount = agents.turn + agents.background;
  const attentionSlots = attention === null ? 0 : 1;
  const shownAgents = Math.min(agentCount, METER_MAX_PIPS - attentionSlots);
  // A pip's slot is its identity: the order is the meaning.
  const pips: { readonly kind: MeterPip; readonly slot: number }[] = [];
  for (let slot = 0; slot < shownAgents; slot += 1) {
    pips.push({ kind: slot < agents.turn ? "turn" : "background", slot });
  }
  if (attention !== null) {
    pips.push({ kind: ATTENTION_PIP[attention], slot: pips.length });
  }
  const more = agentCount - shownAgents;
  const floor = sideTabAgentsAreFloor(agents);
  const label = sideTabMeterLabel(agents, attention);
  return (
    <span
      data-testid="side-tab-meter"
      role={pips.length === 0 ? undefined : "img"}
      aria-label={pips.length === 0 ? undefined : label}
      className={cn("flex shrink-0 items-center", SIDE_TAB_METER_CLASS[size])}
    >
      {pips.map((pip) => {
        const breathing = pip.kind === "turn" && motionEnabled;
        const style: CSSProperties & { "--pip-delay": string } = {
          "--pip-delay": `${String(pip.slot * BREATHE_STAGGER_MS)}ms`,
        };
        return (
          <span
            key={pip.slot}
            data-pip={pip.kind}
            data-breathing={breathing ? true : undefined}
            className={cn(
              "block shrink-0",
              SIDE_TAB_METER_PIP_CLASS[size],
              PIP_FILL[pip.kind],
            )}
            style={breathing ? style : undefined}
          />
        );
      })}
      {more > 0 ? (
        <span
          data-testid="side-tab-meter-more"
          className={cn(
            "text-muted-foreground tabular-nums",
            SIDE_TAB_METER_MORE_CLASS[size],
          )}
        >
          +{more}
        </span>
      ) : null}
      {floor ? (
        <span
          aria-hidden
          data-testid="side-tab-meter-floor"
          className={cn(
            "text-muted-foreground",
            SIDE_TAB_METER_MORE_CLASS[size],
          )}
        >
          +
        </span>
      ) : null}
    </span>
  );
}
