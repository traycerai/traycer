import type { ChatEvent } from "@traycer/protocol/persistence/epic/chat-events";
import type { Message } from "@traycer/protocol/persistence/epic/messages";

import type {
  TranscriptRowDescriptor,
  TranscriptRowSource,
} from "@traycer/protocol/persistence/chat-transcript/row-projection";
import { recordByteLength } from "@traycer/protocol/persistence/chat-transcript/record-bytes";

/**
 * # Serving a span of bodies
 *
 * The read behind `loadRange`. Stateless and idempotent by construction - it is
 * a function of the rows and the request, holding no per-subscriber cursor - so
 * a repeated request is the same answer and a lost response costs a retry
 * rather than a desync.
 *
 * Shared between the live host and the published reader for the same reason
 * the skeleton builder is: a published copy and a live chat that sliced their
 * ordinals differently would be the same chat rendering differently depending
 * on how it was opened.
 *
 * ## Rows are not records, so a span is not a slice of records
 *
 * A row's body may be SEVERAL records (an assistant turn folded from three
 * records), and several rows may share ONE record set (that turn's slices, and
 * the steer bubbles between them). So the response carries the row ids it
 * answers for, plus the DEDUPLICATED union of records those rows need - not a
 * parallel array. Sending a turn's records once per slice would multiply the
 * largest bodies in the transcript by the number of steers in them.
 *
 * The byte budget is charged the same way: a row costs only the records it
 * INTRODUCES. A turn's second slice is free, which is both accurate and the
 * behaviour that keeps a heavily-steered turn from looking unfetchable.
 */

/** What a range request asks for. Ordinal bounds are INCLUSIVE at both ends. */
export interface TranscriptRangeRequest {
  readonly fromOrdinal: number;
  readonly toOrdinal: number;
  /**
   * Byte budget for the bodies in the response.
   *
   * A CEILING that yields to progress: if the very first row of the span needs
   * more than the whole budget it is served ALONE and over budget, because the
   * alternative is a row that can never be fetched at any budget - a permanent
   * hole in the transcript. Single records reach 1.27 MB in practice, so this
   * is a case that happens rather than a theoretical one.
   */
  readonly maxBytes: number;
}

export interface TranscriptRangeSlice {
  /** Where the served span actually starts, after clamping. */
  readonly fromOrdinal: number;
  /**
   * The row id of every row served, in order.
   *
   * The client checks these against its own skeleton at the same ordinals
   * before applying the bodies. That check is what makes a missed epoch bump
   * degrade to a refetch instead of to bodies rendered under the wrong rows.
   */
  readonly rowIds: readonly string[];
  /** Deduplicated union of the records the served rows render from. */
  readonly messages: readonly Message[];
  readonly events: readonly ChatEvent[];
  /** The span reaches the first row of the transcript. */
  readonly reachedStart: boolean;
  /** The span reaches the last row of the transcript. */
  readonly reachedEnd: boolean;
  /**
   * The first ordinal the budget could NOT fit, when it ran out early.
   *
   * So the served span is `[fromOrdinal, truncatedAtOrdinal - 1]` and the
   * client resumes at `truncatedAtOrdinal`. `undefined` means the whole
   * requested span fits, which is the ordinary case.
   */
  readonly truncatedAtOrdinal: number | undefined;
}

/** The records a row renders from, by id. */
export interface RowRecordIds {
  readonly messageIds: readonly string[];
  readonly eventIds: readonly string[];
}

const NO_IDS: readonly string[] = [];

/**
 * Which records a row needs.
 *
 * Enumerated per source kind rather than inferred, because a row that under-
 * reports renders blank after a hydration that reported success - the worst
 * shape of bug this system can have, since nothing retries.
 */
export function rowRecordIds(source: TranscriptRowSource): RowRecordIds {
  switch (source.kind) {
    case "user":
      return { messageIds: [source.messageId], eventIds: NO_IDS };
    case "assistant-slice":
      return { messageIds: source.messageIds, eventIds: NO_IDS };
    case "steer":
      // The turn's records carry the steer BLOCK (badge, mode, sender); the
      // steered user record, when it survives, carries the message itself.
      return {
        messageIds:
          source.steeredMessageId === null
            ? source.messageIds
            : [...source.messageIds, source.steeredMessageId],
        eventIds: NO_IDS,
      };
    case "stopped-turn":
      return { messageIds: NO_IDS, eventIds: [source.eventId] };
    case "forked-chat-link":
    case "notification-anchor":
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
    messagesById: new Map(messages.map((message) => [message.messageId, message])),
    eventsById: new Map(events.map((event) => [event.eventId, event])),
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * Slices `[fromOrdinal, toOrdinal]` out of projection order, under a byte
 * budget.
 *
 * Out-of-range bounds are CLAMPED rather than rejected: ordinals are meaningful
 * only under an epoch, and a client whose request raced a history mutation is
 * asking an ordinary stale question. The response carries the ids it served, so
 * a clamped answer is one the client can detect and refetch from - which is a
 * better failure than an error frame it has no state to recover from.
 *
 * An empty transcript, or a span entirely past the end, yields an empty slice
 * with both `reachedStart` and `reachedEnd` set - "there is nothing here", not
 * "you asked wrongly".
 */
export function sliceTranscriptRange(
  rows: readonly TranscriptRowDescriptor[],
  lookup: TranscriptRecordLookup,
  request: TranscriptRangeRequest,
): TranscriptRangeSlice {
  const empty: TranscriptRangeSlice = {
    fromOrdinal: 0,
    rowIds: [],
    messages: [],
    events: [],
    reachedStart: true,
    reachedEnd: true,
    truncatedAtOrdinal: undefined,
  };
  if (rows.length === 0) return empty;

  const lastOrdinal = rows.length - 1;
  // A span entirely past the end is nothing, not the last row. Clamping
  // `fromOrdinal` down would serve a row the caller did not ask for and report
  // it under an ordinal it did not request.
  if (request.fromOrdinal > lastOrdinal) return empty;

  const from = clamp(request.fromOrdinal, 0, lastOrdinal);
  // `to` is NOT clamped up to `from`. An inverted span (`toOrdinal` below
  // `fromOrdinal`) is a request for nothing, and raising it to `from` would
  // quietly serve one row the caller did not ask for - a client computing an
  // empty viewport span would hydrate a row and never know why. Left below
  // `from`, the loop simply does not run.
  const to = Math.min(request.toOrdinal, lastOrdinal);

  const rowIds: string[] = [];
  const messages: Message[] = [];
  const events: ChatEvent[] = [];
  const seenMessageIds = new Set<string>();
  const seenEventIds = new Set<string>();
  let spent = 0;
  let truncatedAtOrdinal: number | undefined = undefined;

  for (let ordinal = from; ordinal <= to; ordinal += 1) {
    const needed = rowRecordIds(rows[ordinal].source);
    const freshMessages: Message[] = [];
    const freshEvents: ChatEvent[] = [];
    let cost = 0;
    for (const messageId of needed.messageIds) {
      if (seenMessageIds.has(messageId)) continue;
      const message = lookup.messagesById.get(messageId);
      // A row naming a record the authority no longer holds is served without
      // it rather than dropped: the row still exists at this ordinal, and a
      // hole in the ids would shift everything after it.
      if (message === undefined) continue;
      freshMessages.push(message);
      cost += recordByteLength(message);
    }
    for (const eventId of needed.eventIds) {
      if (seenEventIds.has(eventId)) continue;
      const event = lookup.eventsById.get(eventId);
      if (event === undefined) continue;
      freshEvents.push(event);
      cost += recordByteLength(event);
    }
    // The first row is always served, whatever it costs - see `maxBytes`.
    if (rowIds.length > 0 && spent + cost > request.maxBytes) {
      truncatedAtOrdinal = ordinal;
      break;
    }
    spent += cost;
    rowIds.push(rows[ordinal].rowId);
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
    messages,
    events,
    reachedStart: from === 0,
    // Truncation means the span did not finish, so it cannot have reached the
    // end even when the REQUEST named the last row.
    reachedEnd: truncatedAtOrdinal === undefined && to === lastOrdinal,
    truncatedAtOrdinal,
  };
}
