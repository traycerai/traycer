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

/**
 * The server-side ceiling on a range response, regardless of what the client
 * asked for.
 *
 * The relay reclassifies any body over 1 MiB onto the BULK QoS lane, so this is
 * the frame invariant expressed as a number. `maxBytes` on the request is the
 * client's own budget and is clamped to this - a client asking for 10 MiB is
 * not a reason to emit a 10 MiB frame, and a host that trusted it would let any
 * client disable the invariant.
 */
export const TRANSCRIPT_RANGE_MAX_BYTES = 1024 * 1024;

/**
 * Bytes held back from the budget for the parts of the frame that are not
 * rows.
 *
 * The response is not just the records: it also carries `requestId`, `epoch`,
 * `fromOrdinal`, `reachedStart`, `reachedEnd`, `truncatedAtOrdinal`, and the
 * field names and brackets around all of it. A cold review measured 4,378 small
 * rows served under a 1 MiB budget producing a **1,196,401-byte frame** - 148 KB
 * past the relay threshold with no oversized record anywhere in it, because the
 * budget counted only `JSON.stringify(record)`.
 *
 * The per-row overhead is now charged exactly (see {@link sliceTranscriptRange}),
 * so this covers only the fixed envelope. 512 is deliberately generous against a
 * hand-count of roughly 300 - it is 0.05% of the budget, and the failure it
 * prevents is silent lane reclassification.
 *
 * `requestId` is the one envelope field a client controls, which is why the wire
 * schema bounds its length. Without that bound this reserve would be a guess
 * about a value the client picks.
 */
export const TRANSCRIPT_RANGE_ENVELOPE_RESERVE_BYTES = 512;

/**
 * The byte budget for the hydrated tail a bounded snapshot ships inline.
 *
 * Deliberately a fraction of {@link TRANSCRIPT_RANGE_MAX_BYTES}, because the
 * tail is only PART of a snapshot - aux state, the derived scalars and the
 * accumulated-change summaries ride the same frame, and the snapshot has no
 * sanctioned over-budget exception to fall back on (see
 * {@link sliceTranscriptTail}).
 */
export const TRANSCRIPT_TAIL_MAX_BYTES = 256 * 1024;

/** What a range request asks for. Ordinal bounds are INCLUSIVE at both ends. */
export interface TranscriptRangeRequest {
  readonly fromOrdinal: number;
  readonly toOrdinal: number;
  /**
   * The client's byte budget for the response, clamped to
   * {@link TRANSCRIPT_RANGE_MAX_BYTES}.
   *
   * A CEILING that yields to progress: if the very first row of the span needs
   * more than the whole budget it is served ALONE and over budget, because the
   * alternative is a row that can never be fetched at any budget - a permanent
   * hole in the transcript. Single records reach 1.27 MB in practice, so this
   * is a case that happens rather than a theoretical one.
   *
   * **The exception is per ROW, and a row is not one record.** An earlier
   * version of this doc said "a single record larger than the budget", which
   * understated it: an assistant row is a folded turn, so `rowRecordIds` can
   * introduce every record that turn wrote. Two 700 KiB records sharing one
   * turn key project to ONE row and are served together, ~1.4 MB - and N of
   * them make the overshoot unbounded rather than capped near the largest
   * single record.
   *
   * That is still the right call, for the same reason the exception exists at
   * all: the alternative is a row nothing can ever fetch. But it is a genuinely
   * unbounded frame, not a slightly-over-budget one, and anything downstream
   * that assumed "at most one oversized record" was assuming something this
   * never promised. A hard transport ceiling belongs at the transport, where a
   * frame too large to send is a connection-level concern, not here where the
   * only options are "serve it" and "make the transcript unreadable".
   *
   * That exception is the ONE sanctioned breach of the frame invariant, and it
   * is safe for a reason that does not generalize: a `range` response is
   * ordered against nothing (matched by `requestId`, validated by `epoch`,
   * applied by row identity), so arriving on the BULK lane costs it nothing.
   * A `snapshot` or an `indexChanged` has no such protection.
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
  /** Served rows whose required record set is incomplete in the lookup. */
  readonly incompleteRowIds: readonly string[];
  /** Deduplicated union of the records the served rows render from. */
  readonly messages: readonly Message[];
  readonly events: readonly ChatEvent[];
  /**
   * Per-row projection context, by row id - see {@link TranscriptRowContext}.
   *
   * A MAP holding only the rows that have something to say, not a parallel
   * array to {@link rowIds}. Most rows render from their own records alone, and
   * a parallel array would spend two bytes plus a separator on `{}` for every
   * one of them - about 13 KB across the 4,378-row response that already drove
   * this frame past its budget once.
   *
   * Keyed by row id rather than by ordinal offset because that is what the
   * client matches on everywhere else here, and an offset would break the
   * moment a response was applied at a different `fromOrdinal` than requested.
   */
  readonly rowContext: Readonly<Record<string, TranscriptRowContext>>;
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
 * `base` widened by `extra`, allocating only when there is something to add.
 *
 * The two lists name records of different ROLES - a turn's assistant records
 * and its steered user records - so they cannot collide, and the range reader
 * deduplicates its record union regardless. This exists for the empty case:
 * most turns carry no steers at all, and `rowRecordIds` runs once per row of
 * every range, so returning the existing array unchanged is worth the branch.
 */
function widenedIds(
  base: readonly string[],
  extra: readonly string[],
): readonly string[] {
  return extra.length === 0 ? base : [...base, ...extra];
}

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
      // The turn's records build the row; its decorating events are what the
      // renderer folds into the elapsed counter and the restore affordance.
      // Both must arrive, or hydration succeeds and the row comes back poorer
      // than the one legacy mode draws.
      //
      // The turn's STEERED user records travel with it for a different reason:
      // they are not this row's content at all. The renderer folds the whole
      // turn out of the shared assistant records, so hydrating any slice of a
      // steered turn regenerates that turn's steer rows too - and one whose
      // user record is absent regenerates as an ORPHAN, under a row id built
      // from the queue item instead of the message. See `steeredMessageIds`.
      return {
        messageIds: widenedIds(source.messageIds, source.steeredMessageIds),
        eventIds: source.decoratingEventIds,
      };
    case "steer":
      // The turn's records carry the steer BLOCK (badge, mode, sender); the
      // steered user records carry the messages themselves.
      //
      // ALL of the turn's steers, not just this row's: a turn with several of
      // them folds as one unit, so serving one steered record and withholding
      // its siblings renders those siblings as orphans at the tail. Two rows of
      // one turn hydrated separately also then agree about what the turn
      // contains, which they did not before.
      return {
        messageIds: widenedIds(source.messageIds, source.steeredMessageIds),
        eventIds: NO_IDS,
      };
    case "stopped-turn":
      // The event alone is not enough. `renderStoppedTurnsWithoutAssistantRecords`
      // emits no model unless the triggering user record is present, so serving
      // only the event is a hydration that reports success and draws nothing -
      // and the span counts the row hydrated either way, so the list suppresses
      // its ordinal instead of leaving the placeholder that would get retried.
      return {
        messageIds: [source.triggeringMessageId],
        eventIds: [source.eventId],
      };
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

/**
 * A string's cost as one object KEY: its encoding, plus both separators.
 *
 * Distinct from {@link encodedElementBytes} because `rowContext` serializes as
 * an OBJECT keyed by row id, not as an array - so each retained entry pays for
 * a `:` as well as a `,`. Charging it as an array element undercharges every
 * context-bearing row by exactly one byte, which the range's envelope reserve
 * absorbs and the tail's HARD ceiling does not.
 */
function encodedMemberKeyBytes(value: string): number {
  return utf8ByteLength(JSON.stringify(value)) + MEMBER_SEPARATOR_BYTES;
}

/** The always-serialized `incompleteRowIds: []` member, excluding elements. */
const INCOMPLETE_ROW_IDS_FIXED_BYTES =
  encodedMemberKeyBytes("incompleteRowIds") + 2;

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
  const incompleteRowIds: string[] = [];
  const messages: Message[] = [];
  const events: ChatEvent[] = [];
  const rowContext: Record<string, TranscriptRowContext> = {};
  const seenMessageIds = new Set<string>();
  const seenEventIds = new Set<string>();
  let spent = 0;
  let truncatedAtOrdinal: number | undefined = undefined;

  // What the frame can actually spend on rows: the client's ask, clamped to the
  // invariant, less the fixed envelope. Can go non-positive if a caller passes
  // an absurdly small budget - the always-serve-one rule below still applies,
  // so the result is one row rather than an empty response that would look like
  // "there is nothing here".
  const budget =
    Math.min(request.maxBytes, TRANSCRIPT_RANGE_MAX_BYTES) -
    TRANSCRIPT_RANGE_ENVELOPE_RESERVE_BYTES;

  for (let ordinal = from; ordinal <= to; ordinal += 1) {
    const needed = rowRecordIds(rows[ordinal].source);
    const freshMessages: Message[] = [];
    const freshEvents: ChatEvent[] = [];
    // The row id is a serialized array element too - it costs its JSON string
    // plus a separator. Charging only the records is what let 4,378 small rows
    // overshoot a 1 MiB budget by 148 KB.
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
      // A row naming a record the authority no longer holds is served without
      // it rather than dropped: the row still exists at this ordinal, and a
      // hole in the ids would shift everything after it.
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
   * Per-row projection context, by row id - exactly as a range carries it, and
   * for exactly the same reason (see {@link TranscriptRangeSlice.rowContext}).
   *
   * The tail is not the exception it looks like. Its rows are the NEWEST, so
   * the context they need is usually inside the tail - but "usually" is not
   * "always": a legacy assistant turn whose anchor came from a user record
   * below the tail boundary, or a session anchor established before it, is
   * derived by the renderer from the bounded subset and comes out wrong. And
   * the tail is the one hydration nothing ever repairs, because the planner
   * counts these rows hydrated and no range is ever asked for them.
   */
  readonly rowContext: Readonly<Record<string, TranscriptRowContext>>;
}

/**
 * The last rows that fit in `maxBytes`, walking BACKWARD from the end.
 *
 * A separate function rather than a flag on {@link sliceTranscriptRange}, because
 * the two differ in both direction and policy, and a boolean parameter would
 * hide the second difference behind the first.
 *
 * ## No always-serve-one exception, unlike a range
 *
 * `sliceTranscriptRange` serves an over-budget row ALONE rather than leave a row
 * that can never be fetched at any budget. That exception is safe there for a
 * reason that does not carry: a `range` response is ordered against nothing, so
 * the relay bumping it to the BULK lane costs it nothing.
 *
 * A snapshot has no such protection. It is ordered against every delta that
 * follows it, and a re-snapshot (the slow-subscriber backfill, a `resnapshot`)
 * is not even first on the wire. So the ceiling here is HARD, and a chat whose
 * final row is one 1.27 MB record gets an EMPTY tail.
 *
 * That is the honest trade and it is worth stating plainly: the client paints
 * one round trip later for that chat, because `loadRange` can serve the row the
 * snapshot could not. The alternative - an oversized snapshot - trades a rare
 * paint delay for a rare reordered frame, and a reordered snapshot is a
 * transcript rendering the wrong thing rather than rendering late.
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
    // Charged exactly as a range charges it - the tail's ceiling is HARD, so an
    // uncounted field here would push a snapshot past the frame invariant with
    // no over-budget exception to fall back on.
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
    // Unshift each row's fresh records as a BLOCK, not one at a time. Walking
    // backward and unshifting individually reverses a row's own records, and
    // record order is load-bearing: the client rebuilds a folded turn by
    // walking the array and concatenating blocks in that order, so a reversed
    // multi-record turn renders its content out of order. Caught by a test
    // written for a different property.
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
