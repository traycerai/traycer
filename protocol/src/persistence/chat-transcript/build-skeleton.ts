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
  if (text.length <= maxUnits) return text;
  const cut = text.slice(0, maxUnits);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
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
 * Over exactly the same material, deliberately: the digest's job is to catch
 * the body changes `byteLength` cannot express, so a digest computed over a
 * DIFFERENT set of records than the length would leave a gap between the two
 * that neither one covers.
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

function rowBodyFingerprint(
  source: TranscriptRowSource,
  lookup: TranscriptRecordLookup,
  blocksById: ReadonlyMap<string, ContentBlock>,
): RowBodyFingerprint {
  const digest = startContentFingerprint();
  let byteLength = 0;

  const absorbRecord = (record: Message | ChatEvent | undefined): void => {
    if (record === undefined) {
      pushContentFingerprint(digest, ABSENT_RECORD_MARKER);
      return;
    }
    const encoded = encodeRecord(record);
    byteLength += utf8ByteLength(encoded);
    pushContentFingerprint(digest, encoded);
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
    const body = rowBodyFingerprint(source, lookup, blocksById);
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
