import type { AgentActivityByEpic } from "@traycer/protocol/host/agent/activity";

export type AgentActivityTier = "turn" | "background";

export interface EpicAgentActivity {
  readonly working: ReadonlySet<string>;
  readonly turn: ReadonlySet<string>;
}

const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();

export const EMPTY_EPIC_AGENT_ACTIVITY: EpicAgentActivity = Object.freeze({
  working: EMPTY_ID_SET,
  turn: EMPTY_ID_SET,
});

export const EMPTY_AGENT_ACTIVITY_BY_EPIC: ReadonlyMap<
  string,
  EpicAgentActivity
> = new Map<string, EpicAgentActivity>();

export const EMPTY_AGENT_ACTIVITY_TIERS: ReadonlyMap<
  string,
  AgentActivityTier
> = new Map<string, AgentActivityTier>();

/**
 * Converts a host-served replacement into selector-friendly sets, preserving
 * bucket and map identity when membership did not change.
 */
export function reconcileAgentActivityByEpic(
  byEpic: AgentActivityByEpic,
  previous: ReadonlyMap<string, EpicAgentActivity>,
): ReadonlyMap<string, EpicAgentActivity> {
  const epicIds = Object.keys(byEpic);
  if (epicIds.length === 0) {
    return previous.size === 0 ? previous : EMPTY_AGENT_ACTIVITY_BY_EPIC;
  }
  const next = new Map<string, EpicAgentActivity>();
  let changed = epicIds.length !== previous.size;
  for (const epicId of epicIds) {
    const bucket = byEpic[epicId];
    const working = new Set(bucket.working);
    const turn = new Set(bucket.turn);
    const prior = previous.get(epicId);
    if (
      prior !== undefined &&
      sameIdSet(prior.working, working) &&
      sameIdSet(prior.turn, turn)
    ) {
      next.set(epicId, prior);
      continue;
    }
    changed = true;
    next.set(epicId, { working, turn });
  }
  return changed ? next : previous;
}

function sameIdSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
}

const tiersCache = new WeakMap<
  EpicAgentActivity,
  ReadonlyMap<string, AgentActivityTier>
>();

export function agentActivityTiers(
  activity: EpicAgentActivity,
): ReadonlyMap<string, AgentActivityTier> {
  if (activity.working.size === 0) return EMPTY_AGENT_ACTIVITY_TIERS;
  const cached = tiersCache.get(activity);
  if (cached !== undefined) return cached;
  const tiers = new Map<string, AgentActivityTier>();
  for (const id of activity.working) {
    tiers.set(id, activity.turn.has(id) ? "turn" : "background");
  }
  tiersCache.set(activity, tiers);
  return tiers;
}
