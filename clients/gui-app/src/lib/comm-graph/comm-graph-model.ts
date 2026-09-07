/** Display-layer projection of the raw comm-graph event array. */
import type { GuiHarnessId } from "@traycer/protocol/persistence/epic/schemas";
import type { CommGraphEvent } from "@/lib/comm-graph/comm-graph-events";

export type CommGraphAgentKind = "chat" | "terminal-agent";

export interface CommGraphAgentNode {
  readonly id: string;
  readonly kind: CommGraphAgentKind;
  readonly name: string;
  /** Host the agent lives on; decides which subscription covers its edges. */
  readonly hostId: string | null;
  /**
   * Creator, when known.
   * A LAYOUT CONSTRAINT ONLY - lineage is never drawn as an edge: it is mutable via reparent and already visualized by the sidebar, so drawing it would duplicate the tree and imply a message that never happened.
   */
  readonly parentId: string | null;
  /**
   * The harness running this agent - a terminal agent's own brand, or a GUI chat's persisted run setting.
   * `null` when the record carries none, which for a chat means it has never been given run settings.
   */
  readonly harnessId: GuiHarnessId | null;
  /** The model slug the record carries, when it has one. Shown on hover only. */
  readonly model: string | null;
  /** Archived agents are ALWAYS shown, styled muted - the graph is historical. */
  readonly archived: boolean;
  /** WHEN the record was archived, or `null` while live. */
  readonly archivedAt: number | null;
  readonly createdAt: number;
}

/** One edge per UNORDERED pair {A, B}. */
export interface CommGraphAggregatedEdge {
  /** Order-independent pair id - see `commGraphPairId`. */
  readonly id: string;
  /** The endpoints in the pair id's canonical (sorted) order. */
  readonly agentAId: string;
  readonly agentBId: string;
  /**
   * True when EITHER direction has an unanswered `expectReply` send.
   * Derived purely from the log - the live broker is never consulted.
   */
  readonly hasOpenThread: boolean;
  /**
   * The contributing rows across BOTH directions, in the merged array's order, for the click-through.
   * Interleaved chronologically by construction: the input array is already sorted, so one pass preserves it.
   */
  readonly events: ReadonlyArray<CommGraphEvent>;
}

/**
 * The canvas edge id: order-independent, so a row in either direction lands on the same edge.
 * Sorted rather than "first seen wins" so the id is a pure function of the pair and cannot depend on which message happened to arrive first.
 */
export function commGraphPairId(
  agentOneId: string,
  agentTwoId: string,
): string {
  return agentOneId < agentTwoId
    ? `${agentOneId}<->${agentTwoId}`
    : `${agentTwoId}<->${agentOneId}`;
}

/** Thread key: `responseId` scoped to its HOST. */
function threadKey(hostId: string, responseId: string): string {
  return `${hostId} ${responseId}`;
}

/** Thread key to the latest reply seen on it. */
function compareThreadCausalOrder(
  left: CommGraphEvent,
  right: CommGraphEvent,
): number {
  if (
    left.ingestVersion !== undefined &&
    left.eventId !== undefined &&
    right.ingestVersion !== undefined &&
    right.eventId !== undefined
  ) {
    if (left.ingestVersion !== right.ingestVersion) {
      return left.ingestVersion - right.ingestVersion;
    }
    return left.eventId.localeCompare(right.eventId);
  }
  return left.id - right.id;
}

function latestReplyByThread(
  events: ReadonlyArray<CommGraphEvent>,
): ReadonlyMap<string, CommGraphEvent> {
  const latest = new Map<string, CommGraphEvent>();
  for (const event of events) {
    if (event.inReplyTo === null) continue;
    const key = threadKey(event.hostId, event.inReplyTo);
    const current = latest.get(key);
    if (current === undefined || compareThreadCausalOrder(current, event) < 0) {
      latest.set(key, event);
    }
  }
  return latest;
}

function isOpenRequest(
  event: CommGraphEvent,
  latestReply: ReadonlyMap<string, CommGraphEvent>,
): boolean {
  if (event.kind !== "a2a_message") return false;
  if (event.expectReply !== true) return false;
  if (event.responseId === null) return false;
  const reply = latestReply.get(threadKey(event.hostId, event.responseId));
  if (reply === undefined) return true;
  return compareThreadCausalOrder(reply, event) < 0;
}

/** The `expectReply` sends that still have no reply on their thread. */
export function openCommGraphRequests(
  events: ReadonlyArray<CommGraphEvent>,
): ReadonlyArray<CommGraphEvent> {
  const latestReply = latestReplyByThread(events);
  return events.filter((event) => isOpenRequest(event, latestReply));
}

interface MutablePairEntry {
  readonly agentAId: string;
  readonly agentBId: string;
  hasOpenThread: boolean;
  readonly events: CommGraphEvent[];
}

/** Fold A2A rows into one edge per UNORDERED pair. */
export function aggregateCommGraphEdges(
  events: ReadonlyArray<CommGraphEvent>,
  agentIds: ReadonlySet<string>,
): ReadonlyArray<CommGraphAggregatedEdge> {
  const latestReply = latestReplyByThread(events);
  const byPair = new Map<string, MutablePairEntry>();
  for (const event of events) {
    const sender = event.senderAgentId;
    const receiver = event.receiverAgentId;
    if (sender === null || receiver === null) continue;
    if (!agentIds.has(sender) || !agentIds.has(receiver)) continue;
    const id = commGraphPairId(sender, receiver);
    const existing = byPair.get(id);
    const entry: MutablePairEntry = existing ?? {
      // Canonical order, matching the id, so the endpoints a consumer reads
      // do not depend on which direction spoke first.
      agentAId: sender < receiver ? sender : receiver,
      agentBId: sender < receiver ? receiver : sender,
      hasOpenThread: false,
      events: [],
    };
    if (existing === undefined) byPair.set(id, entry);
    // The canvas dashes the pair when EITHER direction is waiting - the edge says "this conversation has an unanswered ask", and which way it points is the detail view's job (it labels every row).
    if (isOpenRequest(event, latestReply)) entry.hasOpenThread = true;
    entry.events.push(event);
  }
  return Array.from(byPair.entries(), ([id, entry]) => ({
    id,
    agentAId: entry.agentAId,
    agentBId: entry.agentBId,
    hasOpenThread: entry.hasOpenThread,
    events: entry.events,
  }));
}
