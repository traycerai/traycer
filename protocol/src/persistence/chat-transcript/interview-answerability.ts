import { z } from "zod";

import type { TranscriptRowDescriptor } from "@traycer/protocol/persistence/chat-transcript/row-projection";
import type { ContentBlock } from "@traycer/protocol/persistence/epic/schemas";

/**
 * # "Is this pending question askable, and where?"
 *
 * The GUI renders an interview's answer card only for a `streaming` interview
 * block it can find in the transcript. A host-pending interview with no such
 * block is a question nobody can answer while the host keeps rejecting every
 * send, so the composer offers to settle it as errored - a DESTRUCTIVE action,
 * and the only escape from a chat wedged that way.
 *
 * `findUnanswerableInterviews` decides that from the absence of a rendered
 * block, and on the legacy line absence is proof: the client holds the whole
 * transcript. On the windowed line it is not. The block can be perfectly
 * answerable and merely COLD - its row outside the inline tail because the
 * turn's last row exceeded the tail budget, or a detached wait sitting far
 * enough back that the eager range has not reached it - and the notice appears
 * with its Dismiss button before hydration has had a chance to contradict it.
 * A user who takes the offer errors out a question they could have answered.
 *
 * So the host answers it from the whole transcript, and the client stops
 * reading absence as evidence.
 *
 * ## Why this is indexed by the PENDING set
 *
 * Every other value on `chatTranscriptDerived` is a function of the transcript
 * alone. This one is too - "does a row render an answerable block for id X" is
 * a whole-transcript fact - but the SET of ids worth answering it for is the
 * host's pending set, which is the same set the client already has and is small
 * by construction (it is what the runtime is actually blocked on). Shipping
 * every streaming interview block in the transcript instead would be unbounded:
 * a hard crash leaves its block `streaming` forever, so a long-lived chat
 * accumulates them, and the client would filter them all back down to the
 * pending set anyway.
 *
 * The cost is that the derivation is no longer keyed on the transcript alone -
 * see `ChatTranscriptDerivedCache`, whose key had to grow with it.
 *
 * ## Why a MISSING entry is not the same as `ordinal: null`
 *
 * The list has one entry per interview the host had pending when it built the
 * snapshot, so the two absences are different facts and the client needs both:
 *
 * - **`ordinal: null`** - judged, and no row renders an answerable block. The
 *   question is genuinely stuck and Dismiss is the right affordance.
 * - **no entry at all** - the id became pending AFTER this snapshot, so the
 *   host has not judged it. The client must not offer Dismiss for it yet.
 *
 * That second case is real on this line and is not on the legacy one. The store
 * flushes an interview's `blockDelta` before publishing its pending id, which
 * is what makes "pending with no rendered block" mean "stuck" today - but a
 * delta targeting an EVICTED row is dropped rather than seated, so on a
 * windowed client the flush can leave nothing behind. The next snapshot carries
 * both halves and settles it; until then, unjudged.
 */

export const interviewAnswerabilitySchema = z.object({
  blockId: z.string(),
  /**
   * The ordinal of the row that renders this question's card, or `null` when
   * no row does.
   *
   * The ordinal is what makes the answer actionable rather than merely
   * non-destructive: the client hydrates it, the row seats, the card appears
   * and the question can be answered. Without it a cold question would only
   * stop being mis-reported as stuck - it would still render nothing, and the
   * chat would sit blocked with no affordance at all.
   */
  ordinal: z.number().int().nonnegative().nullable(),
});
export type InterviewAnswerability = z.infer<
  typeof interviewAnswerabilitySchema
>;

/**
 * Where each pending interview's answer card would render, one entry per id.
 *
 * ## Why it walks ROWS rather than the records
 *
 * Because of what the client does with the answer. The question is not "does
 * this block exist" - a records walk answers that - it is "which ordinal do I
 * hydrate to make a card appear", and only the projection knows. Hydration is
 * addressed by ordinal, so a records walk could report the question answerable
 * and leave the client with nowhere to send the request.
 *
 * That makes the `null` here structural rather than defensive: this returns an
 * ordinal only for a row that DECLARES the block, so an id no row declares is
 * reported unrenderable and the dismiss affordance stays available. Whether the
 * projection can currently produce such a block is not the point - the client
 * would be stuck either way, and the affordance is the only escape.
 *
 * @param rows The projected transcript rows, in canonical order - the array
 * whose indices ARE the ordinals.
 * @param blocksById The transcript's content blocks, as `contentBlocksById`
 * builds them. Passed in rather than rebuilt because the caller already has one
 * for the pinned-todo fold, and two passes over every block of every record is
 * the kind of cost this line exists to remove.
 * @param pendingBlockIds The host's pending interview ids. The result has one
 * entry per id, in the same order.
 */
export function judgeInterviewAnswerability(
  rows: readonly TranscriptRowDescriptor[],
  blocksById: ReadonlyMap<string, ContentBlock>,
  pendingBlockIds: readonly string[],
): InterviewAnswerability[] {
  if (pendingBlockIds.length === 0) return [];
  const pending = new Set(pendingBlockIds);
  const ordinalByBlockId = new Map<string, number>();
  for (let ordinal = 0; ordinal < rows.length; ordinal += 1) {
    const source = rows[ordinal].source;
    if (source.kind !== "assistant-slice") continue;
    for (const blockId of source.blockIds) {
      if (!pending.has(blockId)) continue;
      // First row wins. A block belongs to exactly one slice, so this cannot
      // fire today - guarded rather than asserted because the split rule is
      // `planAssistantTurnRows`'s to change, and the failure it would cause
      // here is a card hydrated at the wrong ordinal.
      if (ordinalByBlockId.has(blockId)) continue;
      const block = blocksById.get(blockId);
      if (block === undefined || block.type !== "interview") continue;
      // The renderer's own condition for drawing an answer card, verbatim: a
      // settled block renders as history, not as a question.
      if (block.status !== "streaming") continue;
      ordinalByBlockId.set(blockId, ordinal);
    }
  }
  return pendingBlockIds.map((blockId) => ({
    blockId,
    ordinal: ordinalByBlockId.get(blockId) ?? null,
  }));
}
