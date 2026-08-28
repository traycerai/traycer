import { z } from "zod";

import type { ContentBlock } from "@traycer/protocol/persistence/epic/content-blocks";
import type { Message } from "@traycer/protocol/persistence/epic/messages";

import type { TranscriptRowDescriptor } from "@traycer/protocol/persistence/chat-transcript/row-projection";

/**
 * # Locating a row the client cannot name
 *
 * A cross-tile jump has to end at an ORDINAL: on the windowed line the target
 * row is routinely cold, and the only way to get a cold row fetched is to name
 * where it sits. For some target kinds the client derives the row id itself - a
 * delivered USER message's row id IS its message id, an event's is
 * `chatTranscriptEventRowId` - and then reads the ordinal straight off the
 * skeleton it already holds.
 *
 * Three kinds cannot be derived that way, and they are the reason this module
 * exists. A `block` target is identified by walking the RENDERED segment tree,
 * and a `sent-message` target by matching an `agentMessageSend` enrichment
 * inside one - and a cold row has no rendered models at all. So the client can
 * neither find the row nor learn that it exists, and waiting for it to appear
 * deadlocks: the scroll is what drives hydration and the scroll is what is
 * being held back.
 *
 * A `message` target is the third, and it fails for a different reason worth
 * stating separately, because "a message id is a row id" holds often enough to
 * look like a rule. It is one only for USER records. An assistant record is
 * projected into TURN-KEYED rows (`assistant:<turnKey>`, and one per slice when
 * the turn is split), and keeps its durable id only as the rendered model's
 * `persistentMessageId` - so the id-as-row-id lookup silently misses, and the
 * jump waits forever for a row that can never carry that id. The client's own
 * fallback reads `persistentMessageId` off its RENDERED models, which puts it
 * back in the cold-row hole above. Terminal notifications point at exactly this
 * durable id, so the miss lands on "take me to the turn that just finished" in
 * a chat long enough for that turn to be cold.
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
 * The three jump targets whose row a client cannot identify on its own.
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
  /**
   * A durable record id, for the case the client's own id-as-row-id read
   * cannot cover: an ASSISTANT record, whose rows are turn-keyed.
   *
   * The client asks for this only after its own lookups miss, so answering a
   * user record here too is not redundancy to remove - it makes the search
   * total over "the row that renders this record", which is what the caller
   * asked. A caller that can already place the row does not send the request.
   */
  z.object({ kind: z.literal("message"), messageId: z.string() }),
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
 * The row that RENDERS this record, or `null`.
 *
 * "Renders" is the discriminating word, and it is what keeps this from being a
 * scan for the id. A turn's records are named by every row of that turn - an
 * assistant slice carries the whole turn's `messageIds`, and a steered user
 * record appears in `steeredMessageIds` on rows that only need it to fold the
 * turn - so matching anywhere the id occurs would answer with whichever row
 * happened to mention it. Only the sources that render a record AS THEIR BODY
 * are consulted: a `user` row, a `steer` row's steered record, and an
 * assistant slice's own turn records.
 *
 * A `stopped-turn` row is deliberately excluded even though it names a
 * `triggeringMessageId`. That row reports a stop; the record itself has its own
 * row elsewhere, and that is the one a jump means.
 *
 * The LAST match wins, which matters only for a split assistant turn - every
 * slice names the same records. It is the trailing slice on purpose: the
 * client's own `messageIdForTranscriptTarget` chooses the trailing match for
 * the reason it documents (a completion or failure notification describes the
 * terminal edge of that record), and the two must not disagree, since either
 * may be the one that answers a given jump.
 */
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
 *
 * `null` is an ordinary answer, not a fault: the block may belong to a turn a
 * checkpoint restore removed, the A2A send may have been captured on the
 * receiver's side only, or the record may have been trimmed away. The caller's
 * degrade for all of them is the same one it already has for a target that
 * never arrives.
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
