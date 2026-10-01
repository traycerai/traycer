import { useAccountActivityCoverage } from "@/hooks/agent/use-account-activity-coverage";
import { agentActivityTiers } from "@/lib/agent-activity";
import { useEpicAgentActivity } from "@/stores/agent-activity-store";
import type { SideTabLiveAgents } from "./agent-meter";

/** A tab that is not a task: no agents, and no claim about any machine. */
export const NO_LIVE_AGENTS: SideTabLiveAgents = {
  turn: 0,
  background: 0,
  coverage: "indeterminate",
};

/**
 * A task's live agents by tier, with whether the plane reaches every machine
 * they could be on ({@link useAccountActivityCoverage}). Only `covered` makes
 * an empty count mean idle; `unserved` makes it unknown and a positive count a
 * floor; `indeterminate` keeps the plain reading. Nothing for a tab that is
 * not a task.
 */
export function useSideTabLiveAgents(epicId: string | null): SideTabLiveAgents {
  const activity = useEpicAgentActivity(epicId);
  const coverage = useAccountActivityCoverage();
  let turn = 0;
  for (const tier of agentActivityTiers(activity).values()) {
    if (tier === "turn") turn += 1;
  }
  return { turn, background: activity.working.size - turn, coverage };
}

/** Whether the counts are a floor: agents known, on a plane that misses a machine. */
export function sideTabAgentsAreFloor(agents: SideTabLiveAgents): boolean {
  return agents.coverage === "unserved" && agents.turn + agents.background > 0;
}

/** "3 running · 1 background", or `null` with no live agent. */
export function sideTabAgentCounts(agents: SideTabLiveAgents): string | null {
  const parts: string[] = [];
  if (agents.turn > 0) parts.push(`${String(agents.turn)} running`);
  if (agents.background > 0) {
    parts.push(`${String(agents.background)} background`);
  }
  return parts.length === 0 ? null : parts.join(" · ");
}
