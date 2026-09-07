/**
 * What each character on the floor is DOING, folded from the same three sources the graph mode already reads: the event prefix as of the time cursor, the live activity tiers, and whatever the app considers to need a person.
 */
import type { CommGraphEvent } from "@/lib/comm-graph/comm-graph-events";
import { openCommGraphRequests } from "@/lib/comm-graph/comm-graph-model";
import type { OfficeAgentStatus } from "@/lib/comm-graph/office/office-types";
import type { AgentActivityTier } from "@/lib/agent-activity";

/** Whether a record is archived AS OF a cursor. */
export function officeArchivedAsOf(
  archivedAt: number | null,
  cursorMs: number | null,
): boolean {
  if (archivedAt === null) return false;
  return cursorMs === null || archivedAt <= cursorMs;
}

export interface OfficeAgentStatusInput {
  readonly agents: ReadonlyArray<{
    readonly id: string;
    /** `null` for a live record; a timeline moment for an archived one. */
    readonly archivedAt: number | null;
  }>;
  /** Where the transport bar is; `null` means live. */
  readonly cursorMs: number | null;
  /** The as-of-cursor prefix, already sliced by the timeline. */
  readonly events: ReadonlyArray<CommGraphEvent>;
  readonly visibleAgentIds: ReadonlySet<string>;
  readonly activityTiers: ReadonlyMap<string, AgentActivityTier>;
  readonly attentionAgentIds: ReadonlySet<string>;
  /** Agents carrying an unread failure notification. */
  readonly failureAgentIds: ReadonlySet<string>;
}

/**
 * How many unanswered requests are sitting on each RECEIVER's desk, which is the pile of envelopes the office draws there.
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

/** Agents that are the SENDER of a request still waiting on its reply. */
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

/** Precedence, highest first: `failure`, `attention`, `awaiting`, `working`, `archived`, `background`, `idle`. */
function statusFor(
  agent: { readonly id: string; readonly archivedAt: number | null },
  sources: OfficeStatusSources,
  cursorMs: number | null,
): OfficeAgentStatus {
  if (sources.failureAgentIds.has(agent.id)) return "failure";
  if (sources.attentionAgentIds.has(agent.id)) return "attention";
  if (sources.awaiting.has(agent.id)) return "awaiting";
  const tier = sources.activityTiers.get(agent.id);
  if (tier === "turn") return "working";
  if (officeArchivedAsOf(agent.archivedAt, cursorMs)) return "archived";
  if (tier === "background") return "background";
  return "idle";
}

const NO_TIERS: ReadonlyMap<string, AgentActivityTier> = new Map();
const NO_AGENT_IDS: ReadonlySet<string> = new Set();

/** Statuses for the agents that exist as of the cursor; nobody else has one. */
export function officeAgentStatuses(
  args: OfficeAgentStatusInput,
): ReadonlyMap<string, OfficeAgentStatus> {
  const live = args.cursorMs === null;
  const sources: OfficeStatusSources = {
    awaiting: awaitingSenderIds(args.events, args.visibleAgentIds),
    activityTiers: live ? args.activityTiers : NO_TIERS,
    attentionAgentIds: live ? args.attentionAgentIds : NO_AGENT_IDS,
    failureAgentIds: live ? args.failureAgentIds : NO_AGENT_IDS,
  };
  const statuses = new Map<string, OfficeAgentStatus>();
  for (const agent of args.agents) {
    if (!args.visibleAgentIds.has(agent.id)) continue;
    statuses.set(agent.id, statusFor(agent, sources, args.cursorMs));
  }
  return statuses;
}
