/**
 * What each character on the floor is DOING, folded from the same three
 * sources the graph mode already reads: the event prefix as of the time
 * cursor, the live activity tiers, and whatever the app considers to need a
 * person.
 *
 * Pure, and derived from a PREFIX - so scrubbing the cursor backwards recovers
 * exactly the statuses that were true at that moment, with no "now" leaking in.
 */
import type { CommGraphEvent } from "@/lib/comm-graph/comm-graph-events";
import { openCommGraphRequests } from "@/lib/comm-graph/comm-graph-model";
import type { OfficeAgentStatus } from "@/lib/comm-graph/office/office-types";
import type { AgentActivityTier } from "@/lib/agent-activity";

export interface OfficeAgentStatusInput {
  readonly agents: ReadonlyArray<{
    readonly id: string;
    readonly archived: boolean;
  }>;
  /** The as-of-cursor prefix, already sliced by the timeline. */
  readonly events: ReadonlyArray<CommGraphEvent>;
  readonly visibleAgentIds: ReadonlySet<string>;
  readonly activityTiers: ReadonlyMap<string, AgentActivityTier>;
  readonly attentionAgentIds: ReadonlySet<string>;
  /** Agents carrying an unread failure notification. */
  readonly failureAgentIds: ReadonlySet<string>;
}

/**
 * How many unanswered requests are sitting on each RECEIVER's desk, which is
 * the pile of envelopes the office draws there.
 *
 * The mirror image of `awaitingSenderIds`: the same open-request set read from
 * the other end. Only receivers on the floor are counted - a pile belongs to a
 * desk, and an id this epic does not project has none.
 */
export function officeOpenRequestCounts(
  events: ReadonlyArray<CommGraphEvent>,
  visibleAgentIds: ReadonlySet<string>,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const request of openCommGraphRequests(events)) {
    const receiver = request.receiverAgentId;
    if (receiver === null) continue;
    if (!visibleAgentIds.has(receiver)) continue;
    counts.set(receiver, (counts.get(receiver) ?? 0) + 1);
  }
  return counts;
}

/**
 * Agents that are the SENDER of a request still waiting on its reply.
 *
 * The receiver is deliberately not required to be on the floor: waiting is a
 * fact about the sender alone, and a half-edge to an agent this epic does not
 * project does not make the wait less real.
 */
function awaitingSenderIds(
  events: ReadonlyArray<CommGraphEvent>,
  visibleAgentIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const awaiting = new Set<string>();
  for (const request of openCommGraphRequests(events)) {
    const sender = request.senderAgentId;
    if (sender === null) continue;
    if (!visibleAgentIds.has(sender)) continue;
    awaiting.add(sender);
  }
  return awaiting;
}

/** Everything `statusFor` folds, as one argument - the lint caps parameters. */
interface OfficeStatusSources {
  readonly awaiting: ReadonlySet<string>;
  readonly activityTiers: ReadonlyMap<string, AgentActivityTier>;
  readonly attentionAgentIds: ReadonlySet<string>;
  readonly failureAgentIds: ReadonlySet<string>;
}

/**
 * Precedence, highest first: `failure`, `attention`, `awaiting`, `working`,
 * `archived`, `background`, `idle`.
 *
 * `failure` tops the list because it is the one reading that says the agent
 * cannot continue on its own. Everything below it describes work in some state
 * of progress; a crashed screen says there is none.
 *
 * `archived` sits in the MIDDLE rather than at the bottom on purpose. It
 * outranks `background` and `idle` because a ghosted desk is the more
 * informative reading of a quiet archived agent. It loses to the ones above it
 * because those describe the record actually saying something is happening -
 * an archived agent should not be mid-turn, but if the data says it is, the
 * floor shows what the data says instead of hiding it behind the archive flag.
 */
function statusFor(
  agent: { readonly id: string; readonly archived: boolean },
  sources: OfficeStatusSources,
): OfficeAgentStatus {
  if (sources.failureAgentIds.has(agent.id)) return "failure";
  if (sources.attentionAgentIds.has(agent.id)) return "attention";
  if (sources.awaiting.has(agent.id)) return "awaiting";
  const tier = sources.activityTiers.get(agent.id);
  if (tier === "turn") return "working";
  if (agent.archived) return "archived";
  if (tier === "background") return "background";
  return "idle";
}

/** Statuses for the agents that exist as of the cursor; nobody else has one. */
export function officeAgentStatuses(
  args: OfficeAgentStatusInput,
): ReadonlyMap<string, OfficeAgentStatus> {
  const sources: OfficeStatusSources = {
    awaiting: awaitingSenderIds(args.events, args.visibleAgentIds),
    activityTiers: args.activityTiers,
    attentionAgentIds: args.attentionAgentIds,
    failureAgentIds: args.failureAgentIds,
  };
  const statuses = new Map<string, OfficeAgentStatus>();
  for (const agent of args.agents) {
    if (!args.visibleAgentIds.has(agent.id)) continue;
    statuses.set(agent.id, statusFor(agent, sources));
  }
  return statuses;
}
