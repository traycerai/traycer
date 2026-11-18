import type { AgentActivityByEpic } from "@traycer/protocol/host/agent/activity";

export type AgentActivityTier = "turn" | "background";

/**
 * What the served activity plane can say about ONE host's entities.
 *
 * The tier vocabulary above only ever describes an agent the union CONTAINS;
 * absence from it is read as idleness by every consumer. That reading is a
 * CLAIM, and the renderer only has standing to make it when the union it is
 * reading actually reaches the host the entity lives on. A local-served plane
 * (free tier, cloud sync off, the room unreachable) carries one host's agents,
 * so an agent working on another machine was rendering as nothing happening -
 * the exact defect `renderer-unserved-plane-assertions` describes, and the one
 * this type exists to make un-representable.
 *
 * - `covered` - an answering union reaches this host, so absence IS idleness.
 * - `unserved` - the plane ANSWERS and its union does not reach this host. No
 *   claim is available: render unknown, never idle.
 * - `indeterminate` - no answering union at all (pre-boot, the stream down, a
 *   shell that opens none), or the surface named no host to ask about. Keeps
 *   today's reading deliberately: "the activity plane is not vouching" is the
 *   Epic connection pill's sentence to say once
 *   (`useAgentActivityPresenceDegraded`), and repeating it per row would flash
 *   an unknown glyph on every icon in the window through every cold start and
 *   every socket flap.
 *
 * The two negative states are separate for that reason alone - they differ in
 * WHO reports the absence, and collapsing them would make the honest state the
 * noisy one.
 */
export type AgentActivityCoverage = "covered" | "unserved" | "indeterminate";

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

/**
 * Unions two hosts' views of the SAME epic.
 *
 * Two machines can each be running agents on one cloud-homed epic, and each
 * host's frame is authoritative only about its own agents - so the answer to
 * "what is running on this epic" is the union, not whichever frame arrived
 * last. Agent ids are globally unique, so a plain set union is correct and
 * needs no tie-break.
 *
 * Returns the left operand unchanged when the right adds nothing, so the
 * single-host case (still the common one) keeps object identity and does not
 * re-render every activity consumer.
 */
export function mergeEpicAgentActivity(
  left: EpicAgentActivity,
  right: EpicAgentActivity,
): EpicAgentActivity {
  const working = unionIdSets(left.working, right.working);
  const turn = unionIdSets(left.turn, right.turn);
  return working === left.working && turn === left.turn
    ? left
    : { working, turn };
}

function unionIdSets(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): ReadonlySet<string> {
  if (right.size === 0) return left;
  let grew = false;
  const next = new Set(left);
  for (const id of right) {
    if (next.has(id)) continue;
    next.add(id);
    grew = true;
  }
  return grew ? next : left;
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
