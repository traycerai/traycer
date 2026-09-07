import { z } from "zod";

import type { TranscriptRowDescriptor } from "@traycer/protocol/persistence/chat-transcript/row-projection";
import type { ContentBlock } from "@traycer/protocol/persistence/epic/schemas";

/**
 * The GUI renders an interview's answer card only for a `streaming` interview block it can find in the transcript.
 * The client must not offer Dismiss for it yet.
 */

export const interviewAnswerabilitySchema = z.object({
  blockId: z.string(),
  /** The ordinal of the row that renders this question's card, or `null` when no row does. */
  ordinal: z.number().int().nonnegative().nullable(),
});
export type InterviewAnswerability = z.infer<
  typeof interviewAnswerabilitySchema
>;

/** Where each pending interview's answer card would render, one entry per id. */
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
      // First row wins.
      // A block belongs to exactly one slice, so this cannot fire today - guarded rather than asserted because the split rule is `planAssistantTurnRows`'s to change, and the failure it would cause here is a card hydrated at.
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
