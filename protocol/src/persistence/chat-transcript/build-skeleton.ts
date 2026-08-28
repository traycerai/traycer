import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatEvent } from "@traycer/protocol/persistence/epic/chat-events";
import type { Message } from "@traycer/protocol/persistence/epic/messages";
import type { ContentBlock } from "@traycer/protocol/persistence/epic/content-blocks";

import { utf8ByteLength } from "@traycer/protocol/utils/text/utf8";
import {
  finishContentFingerprint,
  pushContentFingerprint,
  startContentFingerprint,
} from "@traycer/protocol/utils/text/digest";
import { extractPlainTextFromComposerJSONContent } from "@traycer/protocol/common/composer-plain-text";
import { encodeRecord } from "@traycer/protocol/persistence/chat-transcript/record-bytes";
import {
  buildTranscriptRecordLookup,
  type TranscriptRecordLookup,
} from "@traycer/protocol/persistence/chat-transcript/read-range";
import {
  projectTranscriptRows,
  type TranscriptRowDescriptor,
  type TranscriptRowProjectionInput,
  type TranscriptRowSource,
} from "@traycer/protocol/persistence/chat-transcript/row-projection";
import {
  ROW_SKELETON_PREVIEW_MAX_CHARS,
  type RowSkeletonEntry,
} from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import type { TranscriptRowContext } from "@traycer/protocol/persistence/chat-transcript/row-context";

/**
 * # Building the row skeleton
 *
 * Projects a chat's records into one skeleton entry per transcript ROW, in
 * projection order. Shared code because two producers must agree: the live host
 * serving `chat.subscribe`, and the publisher writing the head's index section.
 * A published copy and a live chat that disagreed about ordinals would be the
 * same chat rendering differently depending on how it was opened.
 *
 * The enumeration is entirely `row-projection.ts`'s; this is a projection OF
 * that one, which is what keeps the ordinal of a row equal to its index here.
 *
 * ## Why the preview projection is injected
 *
 * A user row's preview is the plain-text projection of its composer content -
 * `@mentions` resolved to paths, `/commands` to their names, quotes prefixed.
 * That projection is {@link transcriptPreviewProjection} below, and it is a
 * PARAMETER rather than a direct call for two reasons that outlived the move
 * that made it shareable.
 *
 * It is not something to APPROXIMATE. Reading `attrs.path` directly looks
 * equivalent and is not: every mention branch resolves its path as
 * `attrs.path ?? <branch-specific fallback>`, and a GitHub mention node carries
 * no `path` of its own at all. A preview built on the shortcut would silently
 * differ from the label the renderer shows for exactly those rows. Taking it as
 * a parameter is what keeps that shortcut from looking like a local decision a
 * producer is free to make.
 *
 * And it keeps this module's own dependencies to the transcript record shapes.
 * A producer that wants previews reaches the composer projection; one that does
 * not - a size-only consumer, a test fixture asserting ordinals - passes its own
 * and never loads it.
 */

/**
 * Projects a user message's composer content to the plain text its minimap
 * label is made from. Pass {@link transcriptPreviewProjection} unless you have
 * a specific reason not to.
 */
export type TranscriptPreviewProjection = (content: JsonContent) => string;

/**
 * The projection every real producer should pass - the one the GUI composer has
 * always used, re-exported here under the parameter's own type so a producer
 * does not have to know which module in `common/` it came from.
 *
 * This is the whole point of the injection seam being fillable: the live host,
 * the publisher, and the renderer now agree on a row's preview by running the
 * same function, not by three implementations that happen to match today.
 */
export const transcriptPreviewProjection: TranscriptPreviewProjection =
  extractPlainTextFromComposerJSONContent;

/**
 * How far into the source to look for non-whitespace before giving up.
 *
 * Mirrors the minimap's own `PREVIEW_SOURCE_SCAN_LIMIT`. Both bounds matter:
 * the output cap bounds an ordinary long message, and this bounds the
 * pathological one that opens with a megabyte of whitespace.
 */
const PREVIEW_SOURCE_SCAN_LIMIT = 16_384;

const WHITESPACE_RE = /\s/;

/**
 * Collapses runs of whitespace and caps the result one character past the
 * consumer's own budget.
 *
 * The overshoot is deliberate and load-bearing - see
 * `ROW_SKELETON_PREVIEW_MAX_CHARS`. Feeding the result back through the
 * minimap's compactor yields exactly what compacting the full text would have:
 * the first 200 characters are the same either way, and the only other thing
 * that compactor decides is whether a 201st exists.
 */
function collapsedPreview(text: string): string | undefined {
  let out = "";
  let pendingSpace = false;
  const scanLimit = Math.min(text.length, PREVIEW_SOURCE_SCAN_LIMIT);
  for (let index = 0; index < scanLimit; index += 1) {
    const char = text[index];
    if (WHITESPACE_RE.test(char)) {
      if (out.length > 0) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      out += " ";
      pendingSpace = false;
    }
    out += char;
    if (out.length >= ROW_SKELETON_PREVIEW_MAX_CHARS) break;
  }
  if (out.length === 0) return undefined;
  // The loop can overshoot by one: it appends the pending space AND the
  // character before testing, so `"x".repeat(200) + " y"` reaches 202 - one
  // past the cap, which `rowSkeletonEntrySchema` rejects outright. The check
  // cannot simply move before the append without also handling a surrogate
  // pair straddling the boundary, so the clamp lives here instead, where it is
  // one operation and obviously total.
  return sliceWholeCodePoints(out, ROW_SKELETON_PREVIEW_MAX_CHARS);
}

/**
 * Truncates to at most `maxUnits` UTF-16 units without splitting a surrogate
 * pair - dropping the trailing high surrogate rather than emitting half a code
 * point. Mirrors the minimap's own slice.
 */
function sliceWholeCodePoints(text: string, maxUnits: number): string {
  const cut = text.length <= maxUnits ? text : text.slice(0, maxUnits);
  return dropTrailingHighSurrogate(cut);
}

/**
 * Drop a lone high surrogate left at the end of a truncated string.
 *
 * Applied to a string that is already SHORT ENOUGH as well as to one that was
 * cut, and that is the whole point. `collapsedPreview` appends one UTF-16 unit
 * per iteration and stops at `out.length >= ROW_SKELETON_PREVIEW_MAX_CHARS`, so
 * a surrogate pair straddling the cap leaves `out` ending on its high half at
 * exactly the cap - and a length test then reports nothing to do.
 *
 * The result would be an ill-formed preview that still PARSES, because the
 * schema caps length and says nothing about well-formedness: the frame's UTF-8
 * encode substitutes U+FFFD, and the minimap draws a replacement character in
 * the row's label.
 */
function dropTrailingHighSurrogate(text: string): string {
  if (text.length === 0) return text;
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

/** The role a row RENDERS as - not the role of the record behind it. */
function rowRole(source: TranscriptRowSource): RowSkeletonEntry["role"] {
  switch (source.kind) {
    case "user":
    case "steer":
      return "user";
    case "assistant-slice":
    case "stopped-turn":
    case "notification-anchor":
      return "assistant";
    case "forked-chat-link":
    case "setup-card":
      return "system";
  }
}

/**
 * A row's size hint and its body fingerprint, from ONE encoding pass.
 *
 * The two answers are together because they are computed from the same bytes
 * and the encoding is the expensive part: `JSON.stringify` over every record of
 * every row is the dominant cost of building a 20k-row skeleton, and doing it
 * once per row for the length and again for the digest would double it to
 * produce two views of one string.
 *
 * ## The size half
 *
 * Charged per ROW, not per record: an assistant turn's records are shared by
 * every slice of that turn, so billing each slice the whole turn would
 * over-estimate a heavily-steered turn's height several times over. A slice is
 * therefore measured by the blocks it actually renders, which is what the
 * `blockIds` provenance exists for.
 *
 * A hint, never a contract - see `byteLength`'s doc on the schema.
 *
 * ## The fingerprint half
 *
 * Over the same RECORDS, deliberately: the digest's job is to catch the body
 * changes `byteLength` cannot express, so a digest computed over a different
 * set of records than the length would leave a gap between the two that neither
 * one covers.
 *
 * It also covers two things the length does not: the row's projection CONTEXT
 * (see `contextFingerprint`) and an assistant slice's DECORATING events. Both
 * asymmetries run in the safe direction. The digest answers "must I drop what I
 * hold for this ordinal" and the length answers "how tall to draw it", so
 * anything a range serves for the row belongs in the first whether or not it
 * belongs in the second - and the decorating events are precisely a case where
 * it does not, being shared by every slice of one turn.
 *
 * A record the lookup cannot resolve contributes nothing to the length and a
 * MARKER to the digest. Those are different questions and the answers are
 * deliberately different: a missing record is worth zero bytes of height, but a
 * record that disappears - a checkpoint removing a steered user message, say -
 * is a body change, and folding it to "nothing" would make the row's before and
 * after fingerprint identically.
 */
interface RowBodyFingerprint {
  readonly byteLength: number;
  readonly bodyDigest: string;
}

/** Absorbed where a record was expected and not found. See above. */
const ABSENT_RECORD_MARKER = " absent";

/**
 * The row's projection CONTEXT, as a stable string.
 *
 * An array in a fixed order rather than `JSON.stringify(context)`: this value
 * is compared across two independent projection runs, and a stringify compares
 * key ORDER as much as content - the same reason the host's entry comparator is
 * field-by-field rather than a stringify.
 *
 * The mapped type is a drift guard, and a COMPILE-time one: a field added to
 * `transcriptRowContextSchema` and not fingerprinted here fails to type-check.
 * That is the same hazard the host's variants table covers for the entry
 * schema, and it has to be covered here too - the context is the half of a row
 * that no other skeleton field can see.
 *
 * Absent folds to `null` rather than being skipped, because absent is a real
 * answer here - "the projection declines to speak" - and has to stay
 * distinguishable from a value.
 */
function contextFingerprint(context: TranscriptRowContext): string {
  const fields: {
    readonly [K in keyof Required<TranscriptRowContext>]: unknown;
  } = {
    legacyRowAnchorAt: context.legacyRowAnchorAt ?? null,
    sessionAnchor: context.sessionAnchor ?? null,
    hasLaterOverlappingChanges: context.hasLaterOverlappingChanges ?? null,
    setupWindowIndex: context.setupWindowIndex ?? null,
    setupWindowIsActive: context.setupWindowIsActive ?? null,
    completedSteer: context.completedSteer ?? null,
  };
  // DERIVED from `fields`, not a second list beside it. The mapped type forces
  // every context field into the object above, but it cannot reach a
  // hand-written array - so a field added there and omitted here used to
  // compile silently and simply stop being fingerprinted, which is the exact
  // failure the guard is described as preventing.
  //
  // `Object.values` follows insertion order for string keys, and the literal
  // above fixes that order, so the digest is stable across builds. Reordering
  // the literal changes every row's digest and costs one `updated` per row on
  // upgrade - the same price any fingerprint change carries.
  return JSON.stringify(Object.values(fields));
}

function rowBodyFingerprint(
  source: TranscriptRowSource,
  context: TranscriptRowContext,
  lookup: TranscriptRecordLookup,
  blocksById: ReadonlyMap<string, ContentBlock>,
): RowBodyFingerprint {
  const digest = startContentFingerprint();
  let byteLength = 0;

  // The row's CONTEXT, first and unconditionally.
  //
  // `row-projection.ts` sets a row's context from the whole event list, so a
  // LATER event flips an EARLIER row's context - a `queue.fallback` retracting
  // a steer badge, a later checkpoint that starts overlapping this one - while
  // every other field of the entry stays byte-identical. Nothing else in the
  // skeleton can see that, so without this the comparison reports "unchanged",
  // no `updated` is emitted, and the client renders the stale context for the
  // life of the connection. It is `bodyDigest`'s own failure mode, one field
  // over.
  //
  // Not charged to `byteLength`: the context is a handful of scalars that
  // change no row's height, and the length is a scroll-height hint. That breaks
  // the "same material" symmetry above in the only safe direction - the digest
  // covers strictly more than the length, never less.
  pushContentFingerprint(digest, contextFingerprint(context));

  const absorbRecord = (record: Message | ChatEvent | undefined): void => {
    if (record === undefined) {
      pushContentFingerprint(digest, ABSENT_RECORD_MARKER);
      return;
    }
    const encoded = encodeRecord(record);
    byteLength += utf8ByteLength(encoded);
    pushContentFingerprint(digest, encoded);
  };

  // Digest-only, deliberately: see the call site. `byteLength` is charged per
  // ROW and these records belong to the turn.
  const absorbEvents = (eventIds: readonly string[]): void => {
    for (const eventId of eventIds) {
      const event = lookup.eventsById.get(eventId);
      pushContentFingerprint(
        digest,
        event === undefined ? ABSENT_RECORD_MARKER : encodeRecord(event),
      );
    }
  };

  /**
   * The turn's durable IMAGE RESOLUTION record, digest-only.
   *
   * Third member of the same family as the context and the decorating events:
   * something a row renders that no field of its skeleton entry can see.
   * `image_resolution.updated` rewrites the message-level `imageResolutions`
   * array and changes no content block, so a settled hydrated row whose consent
   * or error state has just been resolved rebuilds to a byte-identical entry -
   * no `updated`, and the client shows the superseded state until it reconnects.
   *
   * The WHOLE array, not the entries this slice's blocks reference. Entries are
   * keyed by image `source`, and mapping a source back to a block means
   * re-deriving the renderer's own scan here - a second copy of that rule, in
   * the module whose entire job is to be the one place the fingerprint is
   * decided. Every slice of the turn is invalidated instead, which is exactly
   * what the decorating events already do and for the same reason. The cost is
   * bounded: this record moves once per image resolved, not per token.
   *
   * Digest-only for the decorating events' reason - the record is shared by
   * every slice, so charging it per row would over-report a steered turn's
   * height several times over.
   */
  const absorbImageResolutions = (messageIds: readonly string[]): void => {
    for (const messageId of messageIds) {
      const message = lookup.messagesById.get(messageId);
      if (message === undefined || message.role !== "assistant") continue;
      pushContentFingerprint(digest, JSON.stringify(message.imageResolutions));
    }
  };

  const absorbBlocks = (blockIds: readonly string[]): void => {
    for (const blockId of blockIds) {
      const block = blocksById.get(blockId);
      if (block === undefined) {
        pushContentFingerprint(digest, ABSENT_RECORD_MARKER);
        continue;
      }
      const encoded = JSON.stringify(block);
      byteLength += utf8ByteLength(encoded);
      pushContentFingerprint(digest, encoded);
    }
  };

  switch (source.kind) {
    case "user":
      absorbRecord(lookup.messagesById.get(source.messageId));
      break;
    case "assistant-slice":
      absorbBlocks(source.blockIds);
      // The turn's DECORATING events, into the digest and not the length.
      //
      // A range serves these with the row (`rowRecordIds`) and the renderer
      // folds them into the elapsed counter and the restore affordance - so a
      // `checkpoint.captured` or a `turn.paused` landing on a turn whose rows
      // are already hydrated changes what those rows render while every field
      // of the entry, `blockIds` included, stays identical. No `updated` is
      // emitted and the row keeps a missing restore point for the connection,
      // which is the quietest possible failure: the row is there and merely
      // poorer than it was.
      //
      // Not charged to `byteLength` for the reason stated above: these records
      // are shared by every slice of the turn, and billing each slice for all
      // of them would over-estimate a steered turn's height several times over.
      // The digest has no such additivity to protect - it only has to move.
      absorbEvents(source.decoratingEventIds);
      absorbImageResolutions(source.messageIds);
      break;
    case "steer":
      // BOTH, summed: `rowRecordIds` serves the turn's records and the steered
      // user record for this row, and the renderer draws the steer block
      // (badge, mode, sender) above the message itself. Returning only the
      // message under-reports the row, and the list turns that hint into a
      // placeholder height - so the row reserves too little space and the
      // transcript jumps when the body lands.
      absorbBlocks([source.blockId]);
      // An ORPHANED steer has no steered record to name at all, which is a
      // different row from one whose record is merely unresolvable - so it
      // absorbs nothing rather than the absent marker.
      if (source.steeredMessageId !== null) {
        absorbRecord(lookup.messagesById.get(source.steeredMessageId));
      }
      break;
    case "stopped-turn":
    case "forked-chat-link":
    case "notification-anchor":
      absorbRecord(lookup.eventsById.get(source.eventId));
      break;
    case "setup-card":
      for (const eventId of source.eventIds) {
        absorbRecord(lookup.eventsById.get(eventId));
      }
      break;
  }

  return { byteLength, bodyDigest: finishContentFingerprint(digest) };
}

function blocksByIdFrom(
  messages: readonly Message[],
): ReadonlyMap<string, ContentBlock> {
  const blocks = new Map<string, ContentBlock>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.blocks) blocks.set(block.blockId, block);
  }
  return blocks;
}

/**
 * The usage a row reports, if any.
 *
 * Carried by a turn's LAST row so a split turn reports once. The context chip
 * scans backwards for the most recent, so reporting on every slice would be
 * harmless for that consumer and wrong for anything that sums.
 */
function rowUsage(
  source: TranscriptRowSource,
  lookup: TranscriptRecordLookup,
  isLastRowOfTurn: boolean,
): RowSkeletonEntry["usage"] {
  if (source.kind !== "assistant-slice" || !isLastRowOfTurn) return undefined;
  for (let index = source.messageIds.length - 1; index >= 0; index -= 1) {
    const message = lookup.messagesById.get(source.messageIds[index]);
    if (message === undefined || message.role !== "assistant") continue;
    if (message.usage !== null) return message.usage;
  }
  return undefined;
}

/**
 * Who authored the row, and the user record to preview it from.
 *
 * An ORPHANED steer - a steer block whose steered user record a checkpoint
 * removed - has no user record to read either answer from, and the block
 * itself is the fallback authority for both. `steerBlockSchema.sender` exists
 * precisely for this case (see its own comment: without it "an agent-to-agent
 * message would render as a plain user-authored bubble"), and the hydrated
 * renderer already falls back to it. The skeleton has to make the SAME call,
 * or the unhydrated row is listed in the human-turn minimap as an "Untitled
 * message" and then re-classifies and disappears the moment it hydrates.
 *
 * A `null` sender is a block persisted before that field existed, which the
 * renderer treats as a "you" row - so it stays human here too.
 */
function isHumanUserRecord(
  source: TranscriptRowSource,
  lookup: TranscriptRecordLookup,
  blocksById: ReadonlyMap<string, ContentBlock>,
): { readonly message: Message | undefined; readonly sentByAgent: boolean } {
  const messageId =
    source.kind === "user"
      ? source.messageId
      : source.kind === "steer"
        ? source.steeredMessageId
        : null;
  if (messageId === null) {
    return source.kind === "steer"
      ? {
          message: undefined,
          sentByAgent: steerBlockSentByAgent(source.blockId, blocksById),
        }
      : { message: undefined, sentByAgent: false };
  }
  const message = lookup.messagesById.get(messageId);
  if (message === undefined || message.role !== "user") {
    return { message: undefined, sentByAgent: false };
  }
  return { message, sentByAgent: message.sender.type === "agent" };
}

/**
 * Read an orphaned steer's provenance off its own block.
 *
 * The blocks map is typed rather than `unknown`, so this is an ordinary
 * discriminated narrowing - no cast, and no zod parse on the skeleton's
 * per-row path to recover one nullable enum.
 */
function steerBlockSentByAgent(
  blockId: string,
  blocksById: ReadonlyMap<string, ContentBlock>,
): boolean {
  const block = blocksById.get(blockId);
  if (block === undefined || block.type !== "steer") return false;
  return block.sender !== null && block.sender.type === "agent";
}

/**
 * One entry per transcript row, in projection order.
 *
 * The ordinal of a row IS its index in the returned array, so this and
 * {@link projectTranscriptRows} are the same enumeration - which they are by
 * construction, since this maps over that one.
 */
export function buildRowSkeleton(
  input: TranscriptRowProjectionInput,
  previewText: TranscriptPreviewProjection,
): readonly RowSkeletonEntry[] {
  const rows = projectTranscriptRows(input);
  const lookup = buildTranscriptRecordLookup(input.messages, input.events);
  const blocksById = blocksByIdFrom(input.messages);
  const lastRowIndexByTurn = lastRowIndexByTurnKey(rows);

  return rows.map((row, index) => {
    const { source } = row;
    const human = isHumanUserRecord(source, lookup, blocksById);
    const preview =
      human.message === undefined || human.sentByAgent
        ? undefined
        : collapsedPreview(previewText(userContent(human.message)));
    const isLastOfTurn =
      source.kind === "assistant-slice" &&
      lastRowIndexByTurn.get(source.turnKey) === index;
    const body = rowBodyFingerprint(source, row.context, lookup, blocksById);
    return {
      rowId: row.rowId,
      createdAt: row.createdAt,
      role: rowRole(source),
      byteLength: body.byteLength,
      bodyDigest: body.bodyDigest,
      ...(preview === undefined ? {} : { preview }),
      ...(human.sentByAgent ? { sentByAgent: true } : {}),
      ...((): { usage?: RowSkeletonEntry["usage"] } => {
        const usage = rowUsage(source, lookup, isLastOfTurn);
        return usage === undefined ? {} : { usage };
      })(),
    };
  });
}

function userContent(message: Message): JsonContent {
  if (message.role !== "user") {
    throw new Error("build-skeleton: expected a user record");
  }
  return message.message.content;
}

function lastRowIndexByTurnKey(
  rows: readonly TranscriptRowDescriptor[],
): ReadonlyMap<string, number> {
  const lastIndex = new Map<string, number>();
  rows.forEach((row, index) => {
    if (row.source.kind !== "assistant-slice") return;
    lastIndex.set(row.source.turnKey, index);
  });
  return lastIndex;
}
