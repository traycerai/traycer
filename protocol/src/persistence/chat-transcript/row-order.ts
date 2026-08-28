import type { ChatEvent } from "@traycer/protocol/persistence/epic/chat-events";

/**
 * # Canonical transcript row order
 *
 * The comparator and the row-materializing event predicates, shared by the host
 * (which numbers rows for the windowed `chat.subscribe` line) and the renderer
 * (which draws them).
 *
 * ## The ENUMERATION lives in `row-projection.ts`, not here
 *
 * This module briefly claimed to be "the one definition of row order" and
 * shipped a `buildCanonicalTranscriptRows` that mapped one persisted record to
 * one row. A cold review found that false three ways over - records to rows is
 * many-to-many, rows exist that no record produces, and an assistant row's sort
 * key is `rowAnchorAt` rather than the record timestamp. What survived is what
 * this file is now: a comparator, and the two content-dependent predicates that
 * decide whether an event draws a row at all.
 *
 * ## Why this has to be shared code rather than two agreeing implementations
 *
 * Under the windowed transcript a row is addressed by its ORDINAL - its index
 * in this order under a given transcript epoch. The host resolves
 * `loadRange {fromOrdinal, toOrdinal}` against its own ordering and the client
 * places the returned bodies against its own. If the two ever disagree by one
 * row, the client renders bodies under the wrong rows, and nothing about that
 * failure is loud: it looks like a chat whose messages are subtly shuffled.
 *
 * Two implementations that agree by inspection is exactly the arrangement that
 * drifts the first time someone adds a row-materializing event kind on one
 * side. So the comparator lives here and both sides call it.
 *
 * ## What the order IS
 *
 * `createdAt` ascending, STABLY - ties keep their input order, which is the
 * order the projection assembled its rows in.
 *
 * Stability is load-bearing rather than incidental here. Every row of one
 * assistant turn carries the SAME `createdAt` (the turn's `rowAnchorAt`), so a
 * turn's internal order - slice, steer bubble, slice - is carried entirely by
 * the sort keeping input order. Breaking ties on anything would scramble it.
 *
 * ### Why NOT the authority's own array order
 *
 * It is tempting, because the host already holds it and it needs no sort. It
 * is also wrong. `applyChatOp`'s `upsertEntry` appends a record it has not
 * seen before at the TAIL, and a checkpoint restore removes a record and later
 * re-adds it - so a restored row's projection position is the end of the chat
 * while its `timestamp` is unchanged. The renderer sorts it back into place
 * today; serving projection order would durably move it to the bottom of the
 * transcript.
 */

/**
 * The row's sort key. `Message` and `ChatEvent` spell it differently
 * (`timestamp` on both, but they are separate unions), so the comparator takes
 * this rather than either record type - and the renderer, whose rows carry it
 * as `createdAt` alongside synthesized rows the host has no knowledge of, can
 * use the same comparator without converting back.
 */
export interface CanonicalRowOrderKey {
  readonly createdAt: number;
}

/**
 * Compares two rows by canonical order.
 *
 * Returns 0 for equal `createdAt`, which is what makes a stable sort keep the
 * input order for ties - `Array.prototype.sort` has been required to be stable
 * since ES2019. Do not "improve" this by breaking ties on id: that would
 * reorder existing transcripts, because the input order it would displace is
 * the projection's insert order, which is meaningful.
 */
export function compareCanonicalRowOrder(
  a: CanonicalRowOrderKey,
  b: CanonicalRowOrderKey,
): number {
  return a.createdAt - b.createdAt;
}

/**
 * Sorts into canonical order without mutating the input.
 *
 * Takes the sort key as a projection so callers can order their own row types
 * (the host orders a union of persisted messages and events; the renderer
 * orders view models) through the one comparator.
 */
export function sortIntoCanonicalRowOrder<T>(
  rows: readonly T[],
  keyOf: (row: T) => CanonicalRowOrderKey,
): readonly T[] {
  return [...rows].sort((a, b) => compareCanonicalRowOrder(keyOf(a), keyOf(b)));
}

/**
 * A metadata value the renderer would accept as present.
 *
 * Mirrors `metadataString` in `rendered-messages.ts`, and the EMPTY-STRING case
 * is the whole reason this is a named function rather than a `typeof` check
 * inline: the renderer treats `""` as absent. A predicate that accepted it
 * would materialize a row the renderer does not draw, and every ordinal after
 * that event would be off by one - bodies under the wrong rows, silently, for
 * the rest of the transcript.
 */
function renderableMetadataString(
  metadata: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = metadata[key];
  if (typeof value !== "string") return null;
  return value.length > 0 ? value : null;
}

/** The origin a forked-chat link row points at. */
export interface ForkedChatLinkRowSource {
  readonly sourceChatId: string;
  readonly sourceHostId: string;
  /**
   * The source chat's title as captured at fork time, or `null` when the event
   * carried none. Rides along because it comes out of the same metadata bag -
   * extracting it separately would put a second reader of these keys beside the
   * one that decides whether the row exists. The placeholder for `null` is the
   * renderer's to choose.
   */
  readonly sourceChatTitle: string | null;
}

/**
 * The forked-chat link row's source, or `null` when this event draws no row.
 *
 * Returns the extracted fields rather than a boolean so the renderer can use
 * THIS as its filter instead of writing an equivalent one beside it. That is
 * not a stylistic preference: the first version of this module tested
 * `typeof value === "string"` while the renderer's `metadataString` also
 * rejects the EMPTY string, so an event carrying `sourceChatId: ""` would have
 * occupied an ordinal here and drawn nothing there - putting every later row's
 * body under the wrong row, silently, for the rest of the transcript.
 *
 * A predicate that can disagree with its consumer is the failure this module
 * exists to prevent, so it does not get to have one.
 */
export function forkedChatLinkRowSource(
  event: ChatEvent,
): ForkedChatLinkRowSource | null {
  if (event.type !== "chat.forked") return null;
  const metadata = event.metadata;
  if (metadata === null) return null;
  const sourceChatId = renderableMetadataString(metadata, "sourceChatId");
  const sourceHostId = renderableMetadataString(metadata, "sourceHostId");
  if (sourceChatId === null || sourceHostId === null) return null;
  return {
    sourceChatId,
    sourceHostId,
    sourceChatTitle: renderableMetadataString(metadata, "sourceChatTitle"),
  };
}

/** What a notification-anchor error row renders. */
export interface NotificationAnchorRowSource {
  readonly message: string;
  /** Provider error code, when the event carried one. */
  readonly code: string | null;
}

/**
 * The notification-anchor error row's content, or `null` when this event draws
 * no row.
 *
 * A plain `send.failed` is history with no row; only one carrying a message and
 * an explicit `notificationAnchor` marker occupies an ordinal. Shaped like
 * {@link forkedChatLinkRowSource} and for the same reason - the renderer filters
 * on this rather than on a copy of it.
 */
export function notificationAnchorRowSource(
  event: ChatEvent,
): NotificationAnchorRowSource | null {
  if (event.type !== "send.failed") return null;
  const metadata = event.metadata;
  if (metadata === null) return null;
  if (metadata.notificationAnchor !== true) return null;
  if (event.message === null) return null;
  return {
    message: event.message,
    code: renderableMetadataString(metadata, "code"),
  };
}

export function eventMaterializesTranscriptRow(event: ChatEvent): boolean {
  return (
    forkedChatLinkRowSource(event) !== null ||
    notificationAnchorRowSource(event) !== null
  );
}
