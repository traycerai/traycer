/**
 * Reader for the agent-activity presence published on the per-user
 * notification room (`notifications:<userId>`) - the cross-epic, cross-host
 * source every activity indicator in the app reads.
 *
 * One awareness entry per host, merged by the cloud. The entry shape is FROZEN
 * (see `AGENT_ACTIVITY_AWARENESS_FIELD` in the protocol) and rides an opaque
 * binary payload outside `major`/`minor` negotiation, so this module never
 * assumes a peer publishes anything: every field is shape-checked where it is
 * read, and an unreadable piece degrades that piece alone.
 *
 * The four reader rules, all load-bearing:
 *
 * 1. Shape-check PER ENTRY: an entry whose activity field is not a plain
 *    object is skipped whole. One malformed publisher must not blank out the
 *    other hosts.
 * 2. Shape-check PER EPIC BUCKET: a bucket whose `working` is not an array is
 *    skipped, leaving the SAME host's other epics intact.
 * 3. Absence is per-HOST: a bucket with no usable `turn` array has an UNKNOWN
 *    tier, so its working ids degrade to turns (the conservative pre-existing
 *    reading). A sibling host that does publish `turn` is unaffected.
 * 4. Ids in `working` but not `turn` are genuinely background-only, and
 *    `"turn"` wins when the same agent shows up under two hosts.
 *
 * An epicId absent from every entry's map is idle.
 */
import {
  AGENT_ACTIVITY_AWARENESS_FIELD,
  AGENT_ACTIVITY_HOST_ID_AWARENESS_FIELD,
} from "@traycer/protocol/host/notifications/subscribe";

/**
 * Live-activity tier of a working agent, as classified by the host running it.
 * A host that publishes no usable tier information leaves its agents unknown,
 * which reads as `"turn"`.
 */
export type AgentActivityTier = "turn" | "background";

/**
 * One epic's slice of the cross-host union. `turn` is always a subset of
 * `working`; ids in `working` alone are background-only. The unknown-tier
 * degrade is already applied, so a consumer never has to know which host
 * contributed which id.
 */
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectStringIds(value: readonly unknown[], into: Set<string>): void {
  for (const id of value) {
    if (typeof id === "string") into.add(id);
  }
}

interface MutableEpicActivity {
  readonly working: Set<string>;
  readonly turn: Set<string>;
}

/**
 * Folds every awareness entry into `epicId -> {working, turn}`.
 *
 * `previous` is the last result this reader produced; buckets whose membership
 * is byte-for-byte unchanged are returned by REFERENCE, and an entirely
 * unchanged union returns `previous` itself. Consumers subscribe through
 * per-epic selectors, so identity reuse is what stops one host's unrelated
 * epic from re-rendering every other epic's indicator.
 */
export function readAgentActivityByEpic(
  states: Iterable<Record<string, unknown>>,
  previous: ReadonlyMap<string, EpicAgentActivity>,
): ReadonlyMap<string, EpicAgentActivity> {
  const merged = new Map<string, MutableEpicActivity>();
  for (const state of states) {
    // Rule 1: per-entry shape check. `agentActivityHostId` is optional by
    // design and is never a key or a filter - an entry missing it is still a
    // valid activity entry.
    const byEpic: unknown = state[AGENT_ACTIVITY_AWARENESS_FIELD];
    if (!isPlainObject(byEpic)) continue;
    for (const epicId of Object.keys(byEpic)) {
      // Rule 2: per-bucket shape check, skipping only the offending bucket.
      const bucket: unknown = byEpic[epicId];
      if (!isPlainObject(bucket)) continue;
      const working: unknown = bucket.working;
      if (!Array.isArray(working)) continue;
      let slot = merged.get(epicId);
      if (slot === undefined) {
        slot = { working: new Set<string>(), turn: new Set<string>() };
        merged.set(epicId, slot);
      }
      mergeBucket(slot, working, bucket.turn);
    }
  }
  return reconcileWithPrevious(merged, previous);
}

/**
 * Folds one host's bucket for one epic into the accumulating union.
 *
 * `turn` decides the tier rule: an array means this host classified its agents,
 * so working-minus-turn is genuinely background-only (rule 4); anything else
 * (absent, or malformed) means an UNKNOWN tier for this host alone, so its
 * working ids degrade to turns (rule 3). `"turn"` therefore wins whenever any
 * host reports the agent as one.
 */
function mergeBucket(
  slot: MutableEpicActivity,
  working: readonly unknown[],
  turnField: unknown,
): void {
  // Narrow inside the guard: `Array.isArray` only refines `turnField` within
  // this block, so collecting here is what lets `collectStringIds` take a typed
  // array instead of re-asserting one.
  let classified: Set<string> | null = null;
  if (Array.isArray(turnField)) {
    classified = new Set<string>();
    collectStringIds(turnField, classified);
  }
  for (const id of working) {
    if (typeof id !== "string") continue;
    slot.working.add(id);
    if (classified === null || classified.has(id)) slot.turn.add(id);
  }
}

function reconcileWithPrevious(
  merged: ReadonlyMap<string, MutableEpicActivity>,
  previous: ReadonlyMap<string, EpicAgentActivity>,
): ReadonlyMap<string, EpicAgentActivity> {
  if (merged.size === 0) {
    return previous.size === 0 ? previous : EMPTY_AGENT_ACTIVITY_BY_EPIC;
  }
  const next = new Map<string, EpicAgentActivity>();
  let changed = merged.size !== previous.size;
  for (const [epicId, slot] of merged) {
    const prior = previous.get(epicId);
    if (
      prior !== undefined &&
      sameIdSet(prior.working, slot.working) &&
      sameIdSet(prior.turn, slot.turn)
    ) {
      next.set(epicId, prior);
      continue;
    }
    changed = true;
    next.set(epicId, { working: slot.working, turn: slot.turn });
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

/**
 * Projects one epic's activity to `agentId -> tier`. Cached on the activity
 * object's identity, so a consumer reading tiers gets the same Map back for as
 * long as its epic's slice is unchanged.
 */
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

/**
 * The awareness fields this reader understands, re-exported so a test (or a
 * future publisher-side check) names the same constants the protocol froze
 * rather than re-typing the string literals.
 */
export {
  AGENT_ACTIVITY_AWARENESS_FIELD,
  AGENT_ACTIVITY_HOST_ID_AWARENESS_FIELD,
};
