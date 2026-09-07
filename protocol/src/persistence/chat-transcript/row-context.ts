import { z } from "zod";

import { chatSessionAnchorSchema } from "@traycer/protocol/persistence/epic/senders";

/**
 * The host projects a row against whole history.
 * That is what keeps a host predating a field from silently asserting one, and it is why these are `.optional()` rather than nullable with a sentinel.
 */
export const transcriptRowContextSchema = z.object({
  /** The projection's anchor for this row, when it did NOT come from the turn's own `startedAt`. */
  legacyRowAnchorAt: z.number().optional(),
  /** The session anchor in effect for this assistant turn. */
  sessionAnchor: chatSessionAnchorSchema.optional(),
  /**
   * Whether any LATER checkpoint rewrites a file this row's checkpoint also touches, computed over whole history.
   */
  hasLaterOverlappingChanges: z.boolean().optional(),
  /** The setup card's window index, and whether that window is still open. */
  setupWindowIndex: z.number().int().nonnegative().optional(),
  setupWindowIsActive: z.boolean().optional(),
  /**
   * This user row completed an interrupt-restart steer, so it renders the steer badge.
   * A running fold over the chat's `queue.*` lifecycle (`steeredMessageIdsFromEvents`), which a later `queue.fallback` can retract - so the answer depends on events arbitrarily far from the row and `rowRecordIds` cannot.
   */
  completedSteer: z.boolean().optional(),
});

export type TranscriptRowContext = z.infer<typeof transcriptRowContextSchema>;

/** The many rows whose rendering depends on nothing around them. */
export const EMPTY_ROW_CONTEXT: TranscriptRowContext = {};
