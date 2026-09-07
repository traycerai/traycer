import { z } from "zod";

import type { ContentBlock } from "@traycer/protocol/persistence/epic/content-blocks";
import type { Message } from "@traycer/protocol/persistence/epic/messages";

import type { TranscriptRowDescriptor } from "@traycer/protocol/persistence/chat-transcript/row-projection";

/**
 * A cross-tile jump has to end at an ORDINAL: on the windowed line the target row is routinely cold, and the only way to get a cold row fetched is to name where it sits.
 * Three kinds cannot be derived that way, and they are the reason this module exists.
 */

/**
 * The message text a `sent-message` locator may carry.
 * Well past any A2A message the composer produces; a longer one simply cannot be the thing being looked for.
 */
export const LOCATOR_MESSAGE_TEXT_MAX_CHARS = 64_000;

/**
 * The three jump targets whose row a client cannot identify on its own.
 * Declared HERE, beside the function that consumes it, so the request shape and the search that answers it cannot drift apart.
 */
export const transcriptRowLocatorSchema = z.discriminatedUnion("kind", [
  /** A tool / sub-agent card, by the block id the transcript rendered it from. */
  z.object({ kind: z.literal("block"), blockId: z.string() }),
  /**
   * The SENDER-side card of an A2A exchange, matched the way the renderer matches it: on receiver and the verbatim message text, because those are the only identifiers the send block and the comm-event row durably share -.
   */
  z.object({
    kind: z.literal("sent-message"),
    receiverAgentId: z.string(),
    messageText: z.string().max(LOCATOR_MESSAGE_TEXT_MAX_CHARS),
    timestamp: z.number(),
  }),
  /**
   * A durable record id, for the case the client's own id-as-row-id read cannot cover: an ASSISTANT record, whose rows are turn-keyed.
   */
  z.object({ kind: z.literal("message"), messageId: z.string() }),
]);
export type TranscriptRowLocator = z.infer<typeof transcriptRowLocatorSchema>;

/** Every block id a row renders, mapped to that row's ordinal. */
function rowOrdinalByBlockId(
  rows: readonly TranscriptRowDescriptor[],
): ReadonlyMap<string, number> {
  const ordinals = new Map<string, number>();
  rows.forEach((row, ordinal) => {
    const { source } = row;
    if (source.kind === "assistant-slice") {
      for (const blockId of source.blockIds) {
        // First writer wins.
        // A block cannot legitimately appear in two slices, and if one ever did, the EARLIER row is the one the renderer draws it in - so preferring it keeps this agreeing with the transcript rather than with the last loop.
        if (!ordinals.has(blockId)) ordinals.set(blockId, ordinal);
      }
      return;
    }
    if (source.kind === "steer" && !ordinals.has(source.blockId)) {
      ordinals.set(source.blockId, ordinal);
    }
  });
  return ordinals;
}

/** The `agentMessageSend` block this target names, or `null`. */
function sentMessageBlockId(
  messages: readonly Message[],
  target: Extract<TranscriptRowLocator, { kind: "sent-message" }>,
): string | null {
  let bestBlockId: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  const consider = (block: ContentBlock): void => {
    if (block.type !== "tool_call") return;
    const send = block.agentMessageSend;
    if (send === null) return;
    if (send.receiverAgentId !== target.receiverAgentId) return;
    if (send.message !== target.messageText) return;
    const startedAt = block.startedAt ?? block.timestamp;
    const distance = Math.abs(startedAt - target.timestamp);
    if (distance >= bestDistance) return;
    bestDistance = distance;
    bestBlockId = block.blockId;
  };
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.blocks) consider(block);
  }
  return bestBlockId;
}

/** The row that RENDERS this record, or `null`. */
function rowOrdinalByMessageId(
  rows: readonly TranscriptRowDescriptor[],
  messageId: string,
): number | null {
  let found: number | null = null;
  rows.forEach((row, ordinal) => {
    const { source } = row;
    if (source.kind === "user") {
      if (source.messageId === messageId) found = ordinal;
      return;
    }
    if (source.kind === "steer") {
      if (source.steeredMessageId === messageId) found = ordinal;
      return;
    }
    if (
      source.kind === "assistant-slice" &&
      source.messageIds.includes(messageId)
    ) {
      found = ordinal;
    }
  });
  return found;
}

/**
 * Where this target sits in the transcript, or `null` if nothing matches it.
 * The caller's degrade for all of them is the same one it already has for a target that never arrives.
 */
export function locateTranscriptRowOrdinal(
  transcript: {
    /** As returned by `projectTranscriptRows` - see the note on ordering above. */
    readonly rows: readonly TranscriptRowDescriptor[];
    readonly messages: readonly Message[];
  },
  locator: TranscriptRowLocator,
): number | null {
  if (locator.kind === "message") {
    return rowOrdinalByMessageId(transcript.rows, locator.messageId);
  }
  const blockId =
    locator.kind === "block"
      ? locator.blockId
      : sentMessageBlockId(transcript.messages, locator);
  if (blockId === null) return null;
  return rowOrdinalByBlockId(transcript.rows).get(blockId) ?? null;
}
