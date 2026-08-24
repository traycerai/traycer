import { z } from "zod";

import { agentSenderSchema } from "@traycer/protocol/persistence/epic/senders";
import { tokenUsageSchema } from "@traycer/protocol/persistence/epic/foundation";
import { chatEventTypeSchema } from "@traycer/protocol/persistence/epic/chat-events";

/**
 * # The row skeleton
 *
 * One entry per transcript ROW, in canonical order (`row-order.ts`), carrying
 * everything the renderer needs to draw the chat WITHOUT the row's body:
 * lay out the scrollback, populate the minimap, answer "can this be forked",
 * and size the context-usage chip.
 *
 * The same type serves both windowed paths - the live host's
 * `chat.subscribe` snapshot and the published head's index section - so that a
 * chat opened live and the same chat opened as a published copy render from
 * one shape rather than two that have to be kept in step.
 *
 * ## What is deliberately NOT here
 *
 * **No position field.** A row's address is its ORDINAL - its index in this
 * array - under the transcript epoch that produced the array. Carrying a
 * separate per-row cursor would be a second coordinate whose only consumer is
 * a check the epoch already performs.
 *
 * **No per-row write stamp.** Staleness is carried by `indexChanged`'s
 * `changedEntries`: inclusion IS the signal, and the client drops the body of
 * every id it names. A `lastWriteSeq` to compare against would be redundant
 * with the list that is already on the wire.
 *
 * **No body, and no field derived from a body that can grow.** `byteLength` is
 * the exception and it is a HINT (see its doc). Everything else here is either
 * fixed at write time or bounded by construction, which is what keeps a
 * 20k-row skeleton to ~1-2 MB.
 *
 * ## Absent vs null
 *
 * Fields that most rows do not carry are `.optional()` rather than nullable,
 * because an omitted key costs nothing on the wire and a skeleton is the one
 * frame where per-row bytes multiply by the length of the chat. Fields every
 * row carries are required.
 */

/**
 * How long the row's body is, for scroll-height estimation.
 *
 * A HINT, not a contract: it lets the list give an unhydrated row a plausible
 * height instead of the flat default, which is what stops the scrollbar from
 * lurching as rows hydrate. Nothing may treat it as authoritative - a row
 * whose body arrives longer or shorter than advertised is ordinary, not an
 * error, and the list re-measures on hydration either way.
 */
const byteLengthSchema = z.number().int().nonnegative();

/** ≤200 chars. Enforced here so a host bug cannot inflate every skeleton row. */
export const ROW_SKELETON_PREVIEW_MAX_CHARS = 200;

export const messageRowSkeletonEntrySchema = z.object({
  kind: z.literal("message"),
  /** The persisted `messageId`. The identity every cross-reference uses. */
  id: z.string(),
  /**
   * The canonical-order sort key (`Message.timestamp`). Present so a client can
   * verify the ordering it was handed rather than trust it - a host and client
   * that disagree about order put bodies under the wrong rows, and this is the
   * field that makes that detectable rather than silent.
   */
  createdAt: z.number(),
  role: z.enum(["user", "assistant", "system"]),
  byteLength: byteLengthSchema,
  /**
   * Minimap text for HUMAN user turns only. Assistant rows get their minimap
   * label from role and status, and an A2A row from its sender - so previewing
   * them would be bytes nothing reads.
   */
  preview: z.string().max(ROW_SKELETON_PREVIEW_MAX_CHARS).optional(),
  /**
   * Present when the row was sent by an agent rather than a person. The
   * minimap renders human and A2A user turns differently, so it cannot infer
   * this from `role` alone.
   */
  agentSenderInfo: agentSenderSchema.optional(),
  /**
   * The three fields fork eligibility is decided from, together with `role`.
   * `forkableAssistantMessageId` requires an assistant row that has completed
   * (`completedAt` present), is not still running (`runState` absent), and
   * carries a non-transient `persistentMessageId`. Role alone is not enough,
   * which is why all three ride the skeleton: the "latest forkable" scan walks
   * the whole transcript and must answer without hydrating it.
   */
  completedAt: z.number().optional(),
  runState: z.string().optional(),
  persistentMessageId: z.string().optional(),
  /**
   * Present on assistant rows that reported usage. The context chip scans
   * backwards for the most recent one, so it must be answerable from the
   * skeleton alone.
   */
  usage: tokenUsageSchema.optional(),
});
export type MessageRowSkeletonEntry = z.infer<
  typeof messageRowSkeletonEntrySchema
>;

/**
 * A row materialized by an EVENT rather than a message - the forked-chat link
 * and the notification anchor (see `eventMaterializesTranscriptRow`).
 *
 * These occupy ordinals like any other row. Omitting them would make every
 * ordinal after the first one wrong, which is the failure this entry exists to
 * prevent; they are cheap because the row's content is derived from the
 * event's own metadata rather than from a body.
 */
export const eventRowSkeletonEntrySchema = z.object({
  kind: z.literal("event"),
  /** The persisted `eventId`. */
  id: z.string(),
  createdAt: z.number(),
  eventType: chatEventTypeSchema,
  byteLength: byteLengthSchema,
});
export type EventRowSkeletonEntry = z.infer<
  typeof eventRowSkeletonEntrySchema
>;

export const rowSkeletonEntrySchema = z.discriminatedUnion("kind", [
  messageRowSkeletonEntrySchema,
  eventRowSkeletonEntrySchema,
]);
export type RowSkeletonEntry = z.infer<typeof rowSkeletonEntrySchema>;

/**
 * The id of a skeleton row, for the identity check a `range` response carries.
 *
 * `kind` is part of it because a message and an event are separate id spaces:
 * nothing guarantees a `messageId` and an `eventId` cannot collide, and a
 * check that could confuse them is not a check.
 */
export interface RowSkeletonRowId {
  readonly kind: RowSkeletonEntry["kind"];
  readonly id: string;
}

export function rowSkeletonRowId(entry: RowSkeletonEntry): RowSkeletonRowId {
  return { kind: entry.kind, id: entry.id };
}

export function rowSkeletonRowIdEquals(
  a: RowSkeletonRowId,
  b: RowSkeletonRowId,
): boolean {
  return a.kind === b.kind && a.id === b.id;
}
