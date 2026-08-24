import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatEvent } from "@traycer/protocol/persistence/epic/chat-events";
import type {
  Message,
  UserMessage,
} from "@traycer/protocol/persistence/epic/messages";

import { buildCanonicalTranscriptRows } from "@traycer/protocol/persistence/chat-transcript/row-order";
import { recordByteLength } from "@traycer/protocol/persistence/chat-transcript/record-bytes";
import {
  ROW_SKELETON_PREVIEW_MAX_CHARS,
  type RowSkeletonEntry,
} from "@traycer/protocol/persistence/chat-transcript/row-skeleton";

/**
 * # Building the row skeleton
 *
 * Turns a chat's persisted records into one skeleton entry per transcript ROW,
 * in canonical order. Shared code because two producers must agree: the live
 * host serving `chat.subscribe`, and the publisher writing the head's index
 * section. A published copy and a live chat that disagreed about ordinals would
 * be the same chat rendering differently depending on how it was opened.
 *
 * ## Why the preview projection is injected
 *
 * A user row's preview is the plain-text projection of its composer content -
 * `@mentions` resolved to paths, `/commands` to their names, quotes prefixed.
 * That projection lives in the GUI today (`tiptap-json-content.ts`) and reaches
 * the whole mention type system, so it is part of the shared-derivation move,
 * not something to reimplement here.
 *
 * It is also not something to APPROXIMATE here. Reading `attrs.path` directly
 * looks equivalent and is not: every mention branch resolves its path as
 * `attrs.path ?? <branch-specific fallback>`, and a GitHub mention node carries
 * no `path` of its own at all. A preview built on the shortcut would silently
 * differ from the label the renderer shows for exactly those rows.
 *
 * So the projection is a parameter. A producer that has one passes it; one that
 * does not cannot invent it, which is the intended pressure.
 */

/**
 * Projects a user message's composer content to the plain text its minimap
 * label is made from. Supply `extractPlainTextFromComposerJSONContent`, or the
 * shared relocation of it.
 */
export type TranscriptPreviewProjection = (content: JsonContent) => string;

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
  // past the cap, which `messageRowSkeletonEntrySchema` rejects outright. The
  // check cannot simply move before the append without also handling a
  // surrogate pair straddling the boundary, so the clamp lives here instead,
  // where it is one operation and obviously total.
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

/**
 * The preview a HUMAN user row carries, or `undefined` for every other row.
 *
 * Assistant rows take their minimap label from role and status, and an A2A row
 * from its sender, so previewing either would be bytes nothing reads.
 */
function userRowPreview(
  message: UserMessage,
  previewText: TranscriptPreviewProjection,
): string | undefined {
  if (message.sender.type === "agent") return undefined;
  return collapsedPreview(previewText(message.message.content));
}

function messageSkeletonEntry(
  message: Message,
  previewText: TranscriptPreviewProjection,
): RowSkeletonEntry {
  const byteLength = recordByteLength(message);
  if (message.role === "user") {
    const preview = userRowPreview(message, previewText);
    return {
      kind: "message",
      id: message.messageId,
      createdAt: message.timestamp,
      role: "user",
      byteLength,
      ...(preview === undefined ? {} : { preview }),
      ...(message.sender.type === "agent" ? { sentByAgent: true } : {}),
    };
  }
  return {
    kind: "message",
    id: message.messageId,
    createdAt: message.timestamp,
    role: "assistant",
    byteLength,
    ...(message.usage === null ? {} : { usage: message.usage }),
  };
}

function eventSkeletonEntry(event: ChatEvent): RowSkeletonEntry {
  return {
    kind: "event",
    id: event.eventId,
    createdAt: event.timestamp,
    eventType: event.type,
    byteLength: recordByteLength(event),
  };
}

/**
 * One entry per transcript row, in canonical order.
 *
 * The ordinal of a row IS its index in the returned array, so this and
 * {@link buildCanonicalTranscriptRows} must stay the same enumeration - which
 * they do by construction, since this is a projection of that one. Events that
 * materialize no row are dropped there, not here.
 */
export function buildRowSkeleton(
  messages: readonly Message[],
  events: readonly ChatEvent[],
  previewText: TranscriptPreviewProjection,
): readonly RowSkeletonEntry[] {
  return buildCanonicalTranscriptRows(messages, events).map((row) =>
    row.kind === "message"
      ? messageSkeletonEntry(row.message, previewText)
      : eventSkeletonEntry(row.event),
  );
}
