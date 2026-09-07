import { z } from "zod";

import { tokenUsageSchema } from "@traycer/protocol/persistence/epic/foundation";

/**
 * One entry per transcript ROW, in projection order (`row-projection.ts`), carrying everything the renderer needs to draw the chat WITHOUT the row's body: lay out the scrollback, populate the minimap, answer "can this be.
 * **No `eventType`.** It followed from record identity and admitted every event kind, including kinds that can never draw a row.
 */

/** How long the row's body is, for scroll-height estimation. */
const byteLengthSchema = z.number().int().nonnegative();

/**
 * A fingerprint of everything about the row a client must DROP what it holds for - its body and its projection context - for change detection only.
 * That is the one failure this whole line cannot recover from on its own.
 */
const bodyDigestSchema = z.string().min(1).max(32);

/**
 * Preview length cap.
 * Enforced here so a host bug cannot inflate every row.
 */
export const ROW_SKELETON_PREVIEW_MAX_CHARS = 201;

export const rowSkeletonEntrySchema = z.object({
  /**
   * The row's identity, built by `row-projection.ts`. Opaque here on purpose -
   * a client matches it, it does not parse it.
   */
  rowId: z.string(),
  /** The projection's placement key. */
  createdAt: z.number(),
  /** The role the row RENDERS as, which is not the same as a record's role. */
  role: z.enum(["user", "assistant", "system"]),
  byteLength: byteLengthSchema,
  bodyDigest: bodyDigestSchema,
  /** Minimap text for HUMAN user rows only. */
  preview: z.string().max(ROW_SKELETON_PREVIEW_MAX_CHARS).optional(),
  /**
   * Present (and always `true`) when the row was sent by another AGENT rather than a person - `sender.type === "agent"`, an `agent.sendMessage` delivery.
   */
  sentByAgent: z.boolean().optional(),
  /**
   * Present on assistant rows that reported usage.
   * The context chip scans backwards for the most recent one, so it must be answerable from the skeleton alone.
   */
  usage: tokenUsageSchema.optional(),
});
export type RowSkeletonEntry = z.infer<typeof rowSkeletonEntrySchema>;
