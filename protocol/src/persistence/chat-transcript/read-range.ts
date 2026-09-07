import type { ChatEvent } from "@traycer/protocol/persistence/epic/chat-events";
import type { Message } from "@traycer/protocol/persistence/epic/messages";

import type {
  TranscriptRowDescriptor,
  TranscriptRowSource,
} from "@traycer/protocol/persistence/chat-transcript/row-projection";
import type { TranscriptRowContext } from "@traycer/protocol/persistence/chat-transcript/row-context";
import { recordByteLength } from "@traycer/protocol/persistence/chat-transcript/record-bytes";
import { utf8ByteLength } from "@traycer/protocol/utils/text/utf8";

/**
 * The read behind `loadRange`.
 * Stateless and idempotent by construction - it is a function of the rows and the request, holding no per-subscriber cursor - so a repeated request is the same answer and a lost response costs a retry rather than a desync.
 */

/** The server-side ceiling on a range response, regardless of what the client asked for. */
export const TRANSCRIPT_RANGE_MAX_BYTES = 1024 * 1024;

/** Bytes held back from the budget for the parts of the frame that are not rows. */
export const TRANSCRIPT_RANGE_ENVELOPE_RESERVE_BYTES = 512;

/** The byte budget for the hydrated tail a bounded snapshot ships inline. */
export const TRANSCRIPT_TAIL_MAX_BYTES = 256 * 1024;

/** What a range request asks for. Ordinal bounds are INCLUSIVE at both ends. */
export interface TranscriptRangeRequest {
  readonly fromOrdinal: number;
  readonly toOrdinal: number;
  /**
   * The client's byte budget for the response, clamped to {@link TRANSCRIPT_RANGE_MAX_BYTES}.
   * But it is a genuinely unbounded frame, not a slightly-over-budget one, and anything downstream that assumed "at most one oversized record" was assuming something this never promised.
   */
  readonly maxBytes: number;
}

export interface TranscriptRangeSlice {
  /** Where the served span actually starts, after clamping. */
  readonly fromOrdinal: number;
  /** The row id of every row served, in order. */
  readonly rowIds: readonly string[];
  /** Served rows whose required record set is incomplete in the lookup. */
  readonly incompleteRowIds: readonly string[];
  /** Deduplicated union of the records the served rows render from. */
  readonly messages: readonly Message[];
  readonly events: readonly ChatEvent[];
  /** Per-row projection context, by row id - see {@link TranscriptRowContext}. */
  readonly rowContext: Readonly<Record<string, TranscriptRowContext>>;
  /** The span reaches the first row of the transcript. */
  readonly reachedStart: boolean;
  /** The span reaches the last row of the transcript. */
  readonly reachedEnd: boolean;
  /** The first ordinal the budget could NOT fit, when it ran out early. */
  readonly truncatedAtOrdinal: number | undefined;
}

/** The records a row renders from, by id. */
export interface RowRecordIds {
  readonly messageIds: readonly string[];
  readonly eventIds: readonly string[];
}

const NO_IDS: readonly string[] = [];

/**
 * `base` widened by `extra`, allocating only when there is something to add.
 * The two lists name records of different ROLES - a turn's assistant records and its steered user records - so they cannot collide, and the range reader deduplicates its record union regardless.
 */
function widenedIds(
  base: readonly string[],
  extra: readonly string[],
): readonly string[] {
  return extra.length === 0 ? base : [...base, ...extra];
}

/** Which records a row needs. */
export function rowRecordIds(source: TranscriptRowSource): RowRecordIds {
  switch (source.kind) {
    case "user":
      return { messageIds: [source.messageId], eventIds: NO_IDS };
    case "assistant-slice":
      // The turn's records build the row; its decorating events are what the renderer folds into the elapsed counter and the restore affordance.
      // Both must arrive, or hydration succeeds and the row comes back poorer than the one legacy mode draws.
      return {
        messageIds: widenedIds(source.messageIds, source.steeredMessageIds),
        eventIds: source.decoratingEventIds,
      };
    case "steer":
      // The turn's records carry the steer BLOCK (badge, mode, sender); the steered user records carry the messages themselves.
      return {
        messageIds: widenedIds(source.messageIds, source.steeredMessageIds),
        eventIds: NO_IDS,
      };
    case "stopped-turn":
      // The event alone is not enough.
      return {
        messageIds: [source.triggeringMessageId],
        eventIds: [source.eventId],
      };
    case "forked-chat-link":
    case "notification-anchor":
    case "imported-chat-marker":
      return { messageIds: NO_IDS, eventIds: [source.eventId] };
    case "setup-card":
      return { messageIds: NO_IDS, eventIds: source.eventIds };
  }
}

/** Resolves record ids to bodies. Both maps are the authority's own state. */
export interface TranscriptRecordLookup {
  readonly messagesById: ReadonlyMap<string, Message>;
  readonly eventsById: ReadonlyMap<string, ChatEvent>;
}

export function buildTranscriptRecordLookup(
  messages: readonly Message[],
  events: readonly ChatEvent[],
): TranscriptRecordLookup {
  return {
    messagesById: new Map(
      messages.map((message) => [message.messageId, message]),
    ),
    eventsById: new Map(events.map((event) => [event.eventId, event])),
  };
}

/** The `,` between two elements of a JSON array. */
const ELEMENT_SEPARATOR_BYTES = 1;

/** A string's cost as one element of a JSON array: its encoding, plus the comma. */
function encodedElementBytes(value: string): number {
  return utf8ByteLength(JSON.stringify(value)) + ELEMENT_SEPARATOR_BYTES;
}

/** The `:` between a JSON object key and its value, plus the `,` after it. */
const MEMBER_SEPARATOR_BYTES = 2;

/** A string's cost as one object KEY: its encoding, plus both separators. */
function encodedMemberKeyBytes(value: string): number {
  return utf8ByteLength(JSON.stringify(value)) + MEMBER_SEPARATOR_BYTES;
}

/** The always-serialized `incompleteRowIds: []` member, excluding elements. */
const INCOMPLETE_ROW_IDS_FIXED_BYTES =
  encodedMemberKeyBytes("incompleteRowIds") + 2;

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/** Slices `[fromOrdinal, toOrdinal]` out of projection order, under a byte budget. */
export function sliceTranscriptRange(
  rows: readonly TranscriptRowDescriptor[],
  lookup: TranscriptRecordLookup,
  request: TranscriptRangeRequest,
): TranscriptRangeSlice {
  const empty: TranscriptRangeSlice = {
    fromOrdinal: 0,
    rowIds: [],
    incompleteRowIds: [],
    messages: [],
    events: [],
    rowContext: {},
    reachedStart: true,
    reachedEnd: true,
    truncatedAtOrdinal: undefined,
  };
  if (rows.length === 0) return empty;

  const lastOrdinal = rows.length - 1;
  // A span entirely past the end is nothing, not the last row.
  if (request.fromOrdinal > lastOrdinal) return empty;

  const from = clamp(request.fromOrdinal, 0, lastOrdinal);
  // `to` is NOT clamped up to `from`.
  // An inverted span (`toOrdinal` below `fromOrdinal`) is a request for nothing, and raising it to `from` would quietly serve one row the caller did not ask for - a client computing an empty viewport span would hydrate a.
  const to = Math.min(request.toOrdinal, lastOrdinal);

  const rowIds: string[] = [];
  const incompleteRowIds: string[] = [];
  const messages: Message[] = [];
  const events: ChatEvent[] = [];
  const rowContext: Record<string, TranscriptRowContext> = {};
  const seenMessageIds = new Set<string>();
  const seenEventIds = new Set<string>();
  let spent = 0;
  let truncatedAtOrdinal: number | undefined = undefined;

  // What the frame can actually spend on rows: the client's ask, clamped to the invariant, less the fixed envelope.
  const budget =
    Math.min(request.maxBytes, TRANSCRIPT_RANGE_MAX_BYTES) -
    TRANSCRIPT_RANGE_ENVELOPE_RESERVE_BYTES;

  for (let ordinal = from; ordinal <= to; ordinal += 1) {
    const needed = rowRecordIds(rows[ordinal].source);
    const freshMessages: Message[] = [];
    const freshEvents: ChatEvent[] = [];
    // The row id is a serialized array element too - it costs its JSON string plus a separator.
    let cost = encodedElementBytes(rows[ordinal].rowId);
    // Context is part of the frame, so it is part of the budget. Charged only
    // when the row has some - an empty one is not serialized at all.
    const context = rows[ordinal].context;
    const hasContext = Object.keys(context).length > 0;
    if (hasContext) {
      cost +=
        encodedMemberKeyBytes(rows[ordinal].rowId) +
        utf8ByteLength(JSON.stringify(context));
    }
    for (const messageId of needed.messageIds) {
      if (seenMessageIds.has(messageId)) continue;
      const message = lookup.messagesById.get(messageId);
      if (message === undefined) continue;
      freshMessages.push(message);
      cost += recordByteLength(message) + ELEMENT_SEPARATOR_BYTES;
    }
    for (const eventId of needed.eventIds) {
      if (seenEventIds.has(eventId)) continue;
      const event = lookup.eventsById.get(eventId);
      if (event === undefined) continue;
      freshEvents.push(event);
      cost += recordByteLength(event) + ELEMENT_SEPARATOR_BYTES;
    }
    const recordsComplete =
      needed.messageIds.every((messageId) =>
        lookup.messagesById.has(messageId),
      ) && needed.eventIds.every((eventId) => lookup.eventsById.has(eventId));
    if (!recordsComplete) cost += encodedElementBytes(rows[ordinal].rowId);
    // The first row is always served, whatever it costs - see `maxBytes`.
    if (rowIds.length > 0 && spent + cost > budget) {
      truncatedAtOrdinal = ordinal;
      break;
    }
    spent += cost;
    rowIds.push(rows[ordinal].rowId);
    if (!recordsComplete) incompleteRowIds.push(rows[ordinal].rowId);
    if (hasContext) rowContext[rows[ordinal].rowId] = context;
    for (const message of freshMessages) {
      seenMessageIds.add(message.messageId);
      messages.push(message);
    }
    for (const event of freshEvents) {
      seenEventIds.add(event.eventId);
      events.push(event);
    }
  }

  return {
    fromOrdinal: from,
    rowIds,
    incompleteRowIds,
    messages,
    events,
    rowContext,
    reachedStart: from === 0,
    // Truncation means the span did not finish, so it cannot have reached the
    // end even when the REQUEST named the last row.
    reachedEnd: truncatedAtOrdinal === undefined && to === lastOrdinal,
    truncatedAtOrdinal,
  };
}

/** The hydrated tail a bounded snapshot ships inline. */
export interface TranscriptTailSlice {
  /** Ordinal of the first row in the tail. `rows.length` when the tail is empty. */
  readonly fromOrdinal: number;
  readonly rowIds: readonly string[];
  /** Tail rows whose required record set is incomplete in the lookup. */
  readonly incompleteRowIds: readonly string[];
  readonly messages: readonly Message[];
  readonly events: readonly ChatEvent[];
  /**
   * Per-row projection context, by row id - exactly as a range carries it, and for exactly the same reason (see {@link TranscriptRangeSlice.rowContext}).
   */
  readonly rowContext: Readonly<Record<string, TranscriptRowContext>>;
}

/**
 * The last rows that fit in `maxBytes`, walking BACKWARD from the end.
 * `sliceTranscriptRange` serves an over-budget row ALONE rather than leave a row that can never be fetched at any budget.
 */
export function sliceTranscriptTail(
  rows: readonly TranscriptRowDescriptor[],
  lookup: TranscriptRecordLookup,
  maxBytes: number,
): TranscriptTailSlice {
  const budget = Math.max(
    0,
    Math.min(maxBytes, TRANSCRIPT_TAIL_MAX_BYTES) -
      INCOMPLETE_ROW_IDS_FIXED_BYTES,
  );
  const rowIds: string[] = [];
  const incompleteRowIds: string[] = [];
  const messages: Message[] = [];
  const events: ChatEvent[] = [];
  const rowContext: Record<string, TranscriptRowContext> = {};
  const seenMessageIds = new Set<string>();
  const seenEventIds = new Set<string>();
  let spent = 0;
  let fromOrdinal = rows.length;

  for (let ordinal = rows.length - 1; ordinal >= 0; ordinal -= 1) {
    const needed = rowRecordIds(rows[ordinal].source);
    const freshMessages: Message[] = [];
    const freshEvents: ChatEvent[] = [];
    let cost = encodedElementBytes(rows[ordinal].rowId);
    const context = rows[ordinal].context;
    const hasContext = Object.keys(context).length > 0;
    if (hasContext) {
      cost +=
        encodedMemberKeyBytes(rows[ordinal].rowId) +
        utf8ByteLength(JSON.stringify(context));
    }
    for (const messageId of needed.messageIds) {
      if (seenMessageIds.has(messageId)) continue;
      const message = lookup.messagesById.get(messageId);
      if (message === undefined) continue;
      freshMessages.push(message);
      cost += recordByteLength(message) + ELEMENT_SEPARATOR_BYTES;
    }
    for (const eventId of needed.eventIds) {
      if (seenEventIds.has(eventId)) continue;
      const event = lookup.eventsById.get(eventId);
      if (event === undefined) continue;
      freshEvents.push(event);
      cost += recordByteLength(event) + ELEMENT_SEPARATOR_BYTES;
    }
    const recordsComplete =
      needed.messageIds.every((messageId) =>
        lookup.messagesById.has(messageId),
      ) && needed.eventIds.every((eventId) => lookup.eventsById.has(eventId));
    if (!recordsComplete) cost += encodedElementBytes(rows[ordinal].rowId);
    // Hard ceiling, including for the very first row considered - see above.
    if (spent + cost > budget) break;
    spent += cost;
    fromOrdinal = ordinal;
    rowIds.unshift(rows[ordinal].rowId);
    if (!recordsComplete) incompleteRowIds.unshift(rows[ordinal].rowId);
    if (hasContext) rowContext[rows[ordinal].rowId] = context;
    // Unshift each row's fresh records as a BLOCK, not one at a time.
    for (const message of freshMessages) seenMessageIds.add(message.messageId);
    messages.unshift(...freshMessages);
    for (const event of freshEvents) seenEventIds.add(event.eventId);
    events.unshift(...freshEvents);
  }

  return {
    fromOrdinal,
    rowIds,
    incompleteRowIds,
    messages,
    events,
    rowContext,
  };
}
