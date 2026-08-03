/**
 * Time-cursor model for the communication graph.
 *
 * The canvas renders AS OF a cursor and the on-canvas transport owns that
 * cursor. Both read the SAME merged event array (`CommGraphSnapshot.events`) -
 * there is no second data path and nothing here mutates, reorders, or collapses
 * a row.
 *
 * THE CURSOR IS AN EVENT'S SORT KEY, NOT AN ARRAY INDEX. An index would look
 * simpler, but rows can legally land in the MIDDLE of the merged array: an
 * `event` frame carries snapshot overflow and reconnect gap-fill as well as
 * genuinely new rows (frame kind carries no activity semantics - see the
 * contract), and a second host's frames interleave by timestamp. An index would
 * silently slide onto a different row when that happens; the `(timestamp,
 * hostId, id)` key names one row for good and reuses the array's own total
 * order (`compareCommGraphEvents`).
 *
 * `null` is LIVE: the cursor tracks the newest row as rows arrive. Live and
 * playback are the same projection - one cursor moves by itself, the other is
 * held - so nothing here reads a clock either.
 */
import {
  commGraphEventDirection,
  compareCommGraphSortKeys,
  type CommGraphEvent,
} from "@/lib/comm-graph/comm-graph-events";
import { commGraphPairId } from "@/lib/comm-graph/comm-graph-model";

/**
 * A cursor is the full sort key of the row it sits on, so it stays comparable
 * against the merged array under `compareCommGraphEvents` even when rows are
 * inserted before it.
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
 * Compared through the SAME comparator the merged array is sorted by, so a
 * prefix taken here is always exactly a prefix of what the list displays.
 */
function compareEventToCursor(
  event: CommGraphEvent,
  cursor: CommGraphTimeCursor,
): number {
  return compareCommGraphSortKeys(event, cursor);
}

/**
 * The prefix of `events` at or before `cursor` - the graph "as of t".
 *
 * Binary search + `slice` rather than `filter`: a chatty epic's array runs to
 * tens of thousands of rows and playback re-derives this on every step.
 * `events` is already sorted by `compareCommGraphEvents`, which is the same
 * order this searches in.
 */
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
 * Index of the first row strictly AFTER `cursor` in an array sorted by
 * `compareCommGraphEvents` (`events.length` when no such row exists). THE one
 * upper-bound search: the as-of slice, the playback "next" step, and the
 * transport's cursor index all step through this - the rationale above (tens
 * of thousands of rows, re-derived every playback tick) applies to each of
 * them equally, so none may fall back to a linear scan or fork its own copy.
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
 * Agent ids that exist as of the cursor - an agent appears on the canvas at its
 * `createdAt`, so a replay does not show agents that had not been created yet.
 *
 * Only the RENDERED set is narrowed; the layout keeps working from the full
 * agent list so positions do not jump around as playback reveals nodes.
 */
export function commGraphAgentIdsAsOfCursor(
  agents: ReadonlyArray<{ readonly id: string; readonly createdAt: number }>,
  cursor: CommGraphTimeCursor | null,
): ReadonlySet<string> {
  if (cursor === null) return new Set(agents.map((agent) => agent.id));
  const visible = new Set<string>();
  for (const agent of agents) {
    if (agent.createdAt <= cursor.timestamp) visible.add(agent.id);
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

/**
 * The next row strictly after `cursor`, or null at the end.
 *
 * There is no filtered variant any more: the log is A2A-only and the density
 * controls are gone with the sidebar panel, so playback steps through exactly
 * the array the canvas projects. One list, one order, nothing to disagree about.
 */
export function nextCommGraphTimelineEvent(
  events: ReadonlyArray<CommGraphEvent>,
  cursor: CommGraphTimeCursor | null,
): CommGraphEvent | null {
  if (events.length === 0) return null;
  if (cursor === null) return null;
  return events[commGraphUpperBoundIndex(events, cursor)] ?? null;
}

/**
 * What the cursor event lights up on the canvas.
 *
 * `inReplyTo` is what separates "asked" from "answered": a row that answers an
 * earlier `responseId` pulses as a reply, anything else as a request. Notices
 * get their own pulse - they are the broker giving up, not a message.
 *
 * AN EDGE PULSE TRAVELS, so it names its own direction with `fromAgentId` /
 * `toAgentId` rather than a flag. The drawn edge is undirected and its endpoint
 * order is canonical (sorted), so "reversed" would only be meaningful next to
 * that edge's own source/target - the consumer compares ids and decides. A reply
 * therefore travels back along the same edge its request came down.
 *
 * A row whose other endpoint is outside the node set (a half-edge to an agent
 * this epic does not project) has no drawable edge, so it falls back to pulsing
 * whichever endpoint IS on the canvas rather than showing nothing. That is the
 * only node pulse there is.
 */
export type CommGraphPulseKind = "request" | "reply" | "notice" | "created";

export type CommGraphPulse =
  | {
      readonly kind: "edge";
      readonly edgeId: string;
      readonly pulseKind: CommGraphPulseKind;
      readonly fromAgentId: string;
      readonly toAgentId: string;
    }
  | { readonly kind: "agent"; readonly agentId: string };

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
      // Direction still lives in from/to ids; it just no longer needs a
      // directed edge to land on.
      edgeId: commGraphPairId(sender, receiver),
      pulseKind: a2aPulseKind(event),
      fromAgentId: sender,
      toAgentId: receiver,
    };
  }
  if (receiver !== null && visibleAgentIds.has(receiver)) {
    return { kind: "agent", agentId: receiver };
  }
  if (sender !== null && visibleAgentIds.has(sender)) {
    return { kind: "agent", agentId: sender };
  }
  return null;
}
