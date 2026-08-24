import type { ChatEvent } from "@traycer/protocol/persistence/epic/chat-events";
import type { Message } from "@traycer/protocol/persistence/epic/messages";

import type { CanonicalTranscriptRow } from "@traycer/protocol/persistence/chat-transcript/row-order";
import type { RowSkeletonRowId } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
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
 */

/** What a range request asks for. Ordinal bounds are INCLUSIVE at both ends. */
export interface TranscriptRangeRequest {
  readonly fromOrdinal: number;
  readonly toOrdinal: number;
  /**
   * Byte budget for the bodies in the response.
   *
   * A CEILING that yields to progress: if the very first row of the span is
   * larger than the whole budget it is served ALONE and over budget, because
   * the alternative is a row that can never be fetched at any budget - a
   * permanent hole in the transcript. Single records reach 1.27 MB in practice,
   * so this is a case that happens rather than a theoretical one.
   */
  readonly maxBytes: number;
}

export interface TranscriptRangeSlice {
  /** Where the served span actually starts, after clamping. */
  readonly fromOrdinal: number;
  /**
   * The identity of every row served, in order.
   *
   * The client checks these against its own skeleton at the same ordinals
   * before applying the bodies. That check is what makes a missed epoch bump
   * degrade to a refetch instead of to bodies rendered under the wrong rows.
   */
  readonly rowIds: readonly RowSkeletonRowId[];
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

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * Slices `[fromOrdinal, toOrdinal]` out of canonical order, under a byte
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
  rows: readonly CanonicalTranscriptRow[],
  request: TranscriptRangeRequest,
): TranscriptRangeSlice {
  if (rows.length === 0) {
    return {
      fromOrdinal: 0,
      rowIds: [],
      messages: [],
      events: [],
      reachedStart: true,
      reachedEnd: true,
      truncatedAtOrdinal: undefined,
    };
  }

  const lastOrdinal = rows.length - 1;
  const from = clamp(request.fromOrdinal, 0, lastOrdinal);
  const to = clamp(request.toOrdinal, from, lastOrdinal);

  const rowIds: RowSkeletonRowId[] = [];
  const messages: Message[] = [];
  const events: ChatEvent[] = [];
  let spent = 0;
  let truncatedAtOrdinal: number | undefined = undefined;

  for (let ordinal = from; ordinal <= to; ordinal += 1) {
    const row = rows[ordinal];
    const record = row.kind === "message" ? row.message : row.event;
    const cost = recordByteLength(record);
    // The first row is always served, whatever it costs - see `maxBytes`.
    if (rowIds.length > 0 && spent + cost > request.maxBytes) {
      truncatedAtOrdinal = ordinal;
      break;
    }
    spent += cost;
    if (row.kind === "message") {
      rowIds.push({ kind: "message", id: row.message.messageId });
      messages.push(row.message);
    } else {
      rowIds.push({ kind: "event", id: row.event.eventId });
      events.push(row.event);
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
