import { z } from "zod";

import type { ContentBlock } from "@traycer/protocol/persistence/epic/content-blocks";
import type { Message } from "@traycer/protocol/persistence/epic/messages";

import type { TranscriptRowDescriptor } from "@traycer/protocol/persistence/chat-transcript/row-projection";

/**
 * # Locating a row the client cannot name
 *
 * A cross-tile jump has to end at an ORDINAL: on the windowed line the target
 * row is routinely cold, and the only way to get a cold row fetched is to name
 * where it sits. For most target kinds the client derives the row id itself - a
 * delivered message's row id IS its message id, an event's is
 * `chatTranscriptEventRowId` - and then reads the ordinal straight off the
 * skeleton it already holds.
 *
 * Two kinds cannot be derived that way, and they are the reason this module
 * exists. A `block` target is identified by walking the RENDERED segment tree,
 * and a `sent-message` target by matching an `agentMessageSend` enrichment
 * inside one - and a cold row has no rendered models at all. So the client can
 * neither find the row nor learn that it exists, and waiting for it to appear
 * deadlocks: the scroll is what drives hydration and the scroll is what is
 * being held back.
 *
 * The host holds the records, so the host answers. This is that answer.
 *
 * ## Why it is the same enumeration, not a similar one
 *
 * This takes the PROJECTED ROWS rather than the records to project, and both
 * halves of that matter.
 *
 * It is what makes the ordinal correct: the rows are the array
 * `buildRowSkeleton` maps over, so an index into them names the same row the
 * client's skeleton has at that index - by construction, not by two
 * implementations agreeing today. That is the discipline `row-projection.ts`
 * records under "consume, do not mirror": a predicate that can disagree with
 * its consumer does not get to have one, and a *position* that can disagree is
 * worse, because it fails by scrolling somewhere plausible instead of failing
 * visibly.
 *
 * And it is what keeps this cheap. The host holds these rows already
 * (`TranscriptViewCache`), so a locate costs a walk rather than a re-projection
 * of the whole history - which is the per-jump version of exactly the
 * full-history scan the windowed line exists to delete.
 *
 * ## Blocks are flat here and nested only when drawn
 *
 * A subagent's tool calls are persisted as ordinary blocks on the assistant
 * record with a `parentBlockId`; the nesting is a rendering-time grouping.
 * `planAssistantTurnRows` enumerates every block of a turn without regard to
 * that field, so each block - nested or not - belongs to exactly one slice, and
 * a direct block-to-row map covers a nested tool card without walking parents.
 */

/**
 * The message text a `sent-message` locator may carry.
 *
 * Bounded because this is the one locator field an untrusted caller can make
 * arbitrarily large, and it is compared against every tool block in the chat.
 * Well past any A2A message the composer produces; a longer one simply cannot
 * be the thing being looked for.
 */
export const LOCATOR_MESSAGE_TEXT_MAX_CHARS = 64_000;

/**
 * The two jump targets whose row a client cannot identify on its own.
 *
 * A zod schema rather than a bare type because it is also the wire shape - it
 * is re-exported by `host/agent/gui/subscribe-windowed.ts`, which is where a
 * producer reads the windowed line's payloads from. Declared HERE, beside the
 * function that consumes it, so the request shape and the search that answers
 * it cannot drift apart.
 */
export const transcriptRowLocatorSchema = z.discriminatedUnion("kind", [
  /** A tool / sub-agent card, by the block id the transcript rendered it from. */
  z.object({ kind: z.literal("block"), blockId: z.string() }),
  /**
   * The SENDER-side card of an A2A exchange, matched the way the renderer
   * matches it: on receiver and the verbatim message text, because those are
   * the only identifiers the send block and the comm-event row durably share -
   * the sender's block id is its harness's tool id and never reaches the host's
   * capture. `timestamp` breaks ties when the same text went to the same
   * receiver more than once, and both clocks are this host's.
   */
  z.object({
    kind: z.literal("sent-message"),
    receiverAgentId: z.string(),
    messageText: z.string().max(LOCATOR_MESSAGE_TEXT_MAX_CHARS),
    timestamp: z.number(),
  }),
]);
export type TranscriptRowLocator = z.infer<typeof transcriptRowLocatorSchema>;

/**
 * Every block id a row renders, mapped to that row's ordinal.
 *
 * Only the two sources that own blocks contribute. A `user` row's body is a
 * record rather than blocks; `stopped-turn`, `forked-chat-link`,
 * `notification-anchor` and `setup-card` rows are projected from events. None
 * of them can be a jump target of either kind here.
 */
function rowOrdinalByBlockId(
  rows: readonly TranscriptRowDescriptor[],
): ReadonlyMap<string, number> {
  const ordinals = new Map<string, number>();
  rows.forEach((row, ordinal) => {
    const { source } = row;
    if (source.kind === "assistant-slice") {
      for (const blockId of source.blockIds) {
        // First writer wins. A block cannot legitimately appear in two slices,
        // and if one ever did, the EARLIER row is the one the renderer draws
        // it in - so preferring it keeps this agreeing with the transcript
        // rather than with the last loop iteration.
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

/**
 * The `agentMessageSend` block this target names, or `null`.
 *
 * Mirrors `sentMessageAnchorId` in the chat tile: every tool block whose
 * enrichment matches receiver AND verbatim text is a candidate, and the one
 * whose start is nearest the event's capture time wins.
 *
 * Two details are matched to the renderer deliberately, because a host that
 * chose a DIFFERENT block would hand back an ordinal for a row the client is
 * not looking for - and the failure would be a confident scroll to the wrong
 * send, which nothing downstream can detect.
 *
 * 1. `startedAt ?? timestamp` is the renderer's own fallback for a tool block
 *    persisted before `startedAt` existed - `rendered-messages.ts` builds its
 *    tool segment with exactly that expression, and `sentMessageAnchorId`
 *    measures against the result.
 * 2. Ties go to the FIRST candidate found, which is what the tile's
 *    `candidate.distance < best.distance` does.
 */
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

/**
 * Where this target sits in the transcript, or `null` if nothing matches it.
 *
 * `null` is an ordinary answer, not a fault: the block may belong to a turn a
 * checkpoint restore removed, or the A2A send may have been captured on the
 * receiver's side only. The caller's degrade for both is the same one it
 * already has for a target that never arrives.
 */
export function locateTranscriptRowOrdinal(
  transcript: {
    /** As returned by `projectTranscriptRows` - see the note on ordering above. */
    readonly rows: readonly TranscriptRowDescriptor[];
    readonly messages: readonly Message[];
  },
  locator: TranscriptRowLocator,
): number | null {
  const blockId =
    locator.kind === "block"
      ? locator.blockId
      : sentMessageBlockId(transcript.messages, locator);
  if (blockId === null) return null;
  return rowOrdinalByBlockId(transcript.rows).get(blockId) ?? null;
}
