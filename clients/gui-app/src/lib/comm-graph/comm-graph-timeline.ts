/** Time-cursor model for the communication graph. */
import {
  commGraphEventDirection,
  compareCommGraphSortKeys,
  type CommGraphEvent,
} from "@/lib/comm-graph/comm-graph-events";
import { commGraphPairId } from "@/lib/comm-graph/comm-graph-model";

/**
 * A cursor is the full sort key of the row it sits on, so it stays comparable against the merged array under `compareCommGraphEvents` even when rows are inserted before it.
 */
export interface CommGraphTimeCursor {
  readonly timestamp: number;
  readonly hostId: string;
  readonly id: number;
  readonly eventId?: string;
}

/** Cloud rows use their canonical event id; local ids are scoped per host. */
export function commGraphEventKey(event: CommGraphEvent): string {
  return event.eventId ?? `${event.hostId}:${event.id}`;
}

/** Stable event identity formatted for the existing row test-id grammar. */
export function commGraphEventRowId(event: CommGraphEvent): string {
  return commGraphEventKey(event).replaceAll(":", "-");
}

export function commGraphCursorForEvent(
  event: CommGraphEvent,
): CommGraphTimeCursor {
  return {
    timestamp: event.timestamp,
    hostId: event.hostId,
    id: event.id,
    eventId: event.eventId,
  };
}

export function commGraphCursorMatchesEvent(
  cursor: CommGraphTimeCursor | null,
  event: CommGraphEvent,
): boolean {
  if (cursor === null) return false;
  return (
    cursor.id === event.id &&
    cursor.hostId === event.hostId &&
    cursor.timestamp === event.timestamp &&
    cursor.eventId === event.eventId
  );
}

/**
 * Compared through the SAME comparator the merged array is sorted by, so a prefix taken here is always exactly a prefix of what the list displays.
 */
function compareEventToCursor(
  event: CommGraphEvent,
  cursor: CommGraphTimeCursor,
): number {
  return compareCommGraphSortKeys(event, cursor);
}

/** The prefix of `events` at or before `cursor` - the graph "as of t". */
export function commGraphEventsAsOfCursor(
  events: ReadonlyArray<CommGraphEvent>,
  cursor: CommGraphTimeCursor | null,
): ReadonlyArray<CommGraphEvent> {
  if (cursor === null) return events;
  const upper = commGraphUpperBoundIndex(events, cursor);
  if (upper === events.length) return events;
  return events.slice(0, upper);
}

/**
 * Index of the first row strictly AFTER `cursor` in an array sorted by `compareCommGraphEvents` (`events.length` when no such row exists).
 * THE one upper-bound search: the as-of slice, the playback "next" step, and the transport's cursor index all step through this - the rationale above (tens of thousands of rows, re-derived every playback tick) applies to each of them equally, so none may.
 */
export function commGraphUpperBoundIndex(
  events: ReadonlyArray<CommGraphEvent>,
  cursor: CommGraphTimeCursor,
): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (compareEventToCursor(events[mid], cursor) <= 0) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * The first captured creation row for each agent.
 * The timeline array is already in its canonical total order, so keeping the first row makes the map an exact event-position boundary even when multiple rows share a millisecond.
 */
export function commGraphCreationCursorByAgentId(
  events: ReadonlyArray<CommGraphEvent>,
): ReadonlyMap<string, CommGraphTimeCursor> {
  const creationCursorByAgentId = new Map<string, CommGraphTimeCursor>();
  for (const event of events) {
    if (event.kind !== "agent_created") continue;
    if (event.receiverAgentId === null) continue;
    if (creationCursorByAgentId.has(event.receiverAgentId)) continue;
    creationCursorByAgentId.set(
      event.receiverAgentId,
      commGraphCursorForEvent(event),
    );
  }
  return creationCursorByAgentId;
}

/**
 * Agent ids that exist as of the cursor.
 * A captured `agent_created` row is the authoritative reveal boundary because the cursor names an ordered event, not merely a millisecond.
 */
export function commGraphAgentIdsAsOfCursor(
  agents: ReadonlyArray<{ readonly id: string; readonly createdAt: number }>,
  cursor: CommGraphTimeCursor | null,
  creationCursorByAgentId: ReadonlyMap<string, CommGraphTimeCursor>,
): ReadonlySet<string> {
  if (cursor === null) return new Set(agents.map((agent) => agent.id));
  const visible = new Set<string>();
  for (const agent of agents) {
    const creationCursor = creationCursorByAgentId.get(agent.id);
    if (
      creationCursor === undefined
        ? agent.createdAt <= cursor.timestamp
        : compareCommGraphSortKeys(creationCursor, cursor) <= 0
    ) {
      visible.add(agent.id);
    }
  }
  return visible;
}

/** Every row an agent takes part in, at either end. */
export function commGraphEventTouchesAgent(
  event: CommGraphEvent,
  agentId: string,
): boolean {
  return event.senderAgentId === agentId || event.receiverAgentId === agentId;
}

/** The next row strictly after `cursor`, or null at the end. */
export function nextCommGraphTimelineEvent(
  events: ReadonlyArray<CommGraphEvent>,
  cursor: CommGraphTimeCursor | null,
): CommGraphEvent | null {
  if (events.length === 0) return null;
  if (cursor === null) return null;
  return events[commGraphUpperBoundIndex(events, cursor)] ?? null;
}

/** What the cursor event lights up on the canvas. */
export type CommGraphPulseKind = "request" | "reply" | "notice" | "created";

export type CommGraphPulse =
  | {
      readonly kind: "edge";
      readonly edgeId: string;
      readonly pulseKind: CommGraphPulseKind;
      readonly fromAgentId: string;
      readonly toAgentId: string;
    }
  | {
      readonly kind: "agent";
      readonly agentId: string;
      /** Who sent the message - may differ from `agentId` on half-edges. */
      readonly senderAgentId: string;
    };

function a2aPulseKind(event: CommGraphEvent): CommGraphPulseKind {
  if (event.kind === "a2a_notice") return "notice";
  if (event.kind === "agent_created") return "created";
  return event.inReplyTo === null ? "request" : "reply";
}

export function commGraphPulseForEvent(
  event: CommGraphEvent | null,
  visibleAgentIds: ReadonlySet<string>,
): CommGraphPulse | null {
  if (event === null) return null;
  const { fromAgentId: sender, toAgentId: receiver } =
    commGraphEventDirection(event);
  if (
    sender !== null &&
    receiver !== null &&
    visibleAgentIds.has(sender) &&
    visibleAgentIds.has(receiver)
  ) {
    return {
      kind: "edge",
      // The canvas edge is per unordered PAIR, so the pulse addresses the pair.
      // Direction still lives in from/to ids; it just no longer needs a directed edge to land on.
      edgeId: commGraphPairId(sender, receiver),
      pulseKind: a2aPulseKind(event),
      fromAgentId: sender,
      toAgentId: receiver,
    };
  }
  if (receiver !== null && visibleAgentIds.has(receiver)) {
    return {
      kind: "agent",
      agentId: receiver,
      senderAgentId: sender ?? receiver,
    };
  }
  if (sender !== null && visibleAgentIds.has(sender)) {
    return { kind: "agent", agentId: sender, senderAgentId: sender };
  }
  return null;
}
