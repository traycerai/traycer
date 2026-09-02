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

/**
 * Precedence, highest first: `attention`, `awaiting`, `working`, `archived`,
 * `background`, `idle`.
 *
 * `archived` sits in the MIDDLE rather than at the bottom on purpose. It
 * outranks `background` and `idle` because a ghosted desk is the more
 * informative reading of a quiet archived agent. It loses to the three above it
 * because those describe the record actually saying something is happening -
 * an archived agent should not be mid-turn, but if the data says it is, the
 * floor shows what the data says instead of hiding it behind the archive flag.
 */
function statusFor(
  agent: { readonly id: string; readonly archived: boolean },
  awaiting: ReadonlySet<string>,
  activityTiers: ReadonlyMap<string, AgentActivityTier>,
  attentionAgentIds: ReadonlySet<string>,
): OfficeAgentStatus {
  if (attentionAgentIds.has(agent.id)) return "attention";
  if (awaiting.has(agent.id)) return "awaiting";
  const tier = activityTiers.get(agent.id);
  if (tier === "turn") return "working";
  if (agent.archived) return "archived";
  if (tier === "background") return "background";
  return "idle";
}

/** Statuses for the agents that exist as of the cursor; nobody else has one. */
export function officeAgentStatuses(
  args: OfficeAgentStatusInput,
): ReadonlyMap<string, OfficeAgentStatus> {
  const awaiting = awaitingSenderIds(args.events, args.visibleAgentIds);
  const statuses = new Map<string, OfficeAgentStatus>();
  for (const agent of args.agents) {
    if (!args.visibleAgentIds.has(agent.id)) continue;
    statuses.set(
      agent.id,
      statusFor(agent, awaiting, args.activityTiers, args.attentionAgentIds),
    );
  }
  return statuses;
}
