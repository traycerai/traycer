import { z } from "zod";

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
 * **No fork-eligibility fields.** An earlier draft put
 * `completedAt`/`runState`/`persistentMessageId` on every message entry so the
 * renderer's "latest forkable row" scan could run over the skeleton. Two of the
 * three are RENDERED fields with no persisted counterpart, and the answer is a
 * single scalar for the whole chat - so it travels as one, on
 * `chatTranscriptDerived`. See `fork-boundary.ts` for the derivation and why
 * the host can compute it without the renderer's turn-lifecycle fold.
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

/**
 * Preview length cap. Enforced here so a host bug cannot inflate every row.
 *
 * ## Why 201 and not 200
 *
 * The minimap's own budget is 200 (`CHAT_TURN_MINIMAP_PREVIEW_MAX_CHARS`), and
 * its compactor appends an ellipsis only when it can SEE a 201st character -
 * `compact.length > MAX` is how it distinguishes "this is the whole message"
 * from "this is the start of one". Handing it exactly 200 would make every long
 * user turn lose its "…", because a truncated preview and a message that
 * happens to be 200 characters long are then indistinguishable.
 *
 * So the producer ships one character past the consumer's budget and the
 * consumer truncates as it always has. The alternatives were a `truncated`
 * flag (a second field carrying one bit that the string itself already
 * implies) or moving the compactor into shared code (the right end state, and
 * part of the shared-derivation extraction - not something to half-do here).
 */
export const ROW_SKELETON_PREVIEW_MAX_CHARS = 201;

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
  /**
   * The persisted roles, and only those. `messageSchema` is a two-arm union of
   * user and assistant; the renderer's third role, `system`, belongs to WORKTREE
   * SETUP CARDS, which are derived from workspace state rather than from a chat
   * record and are woven by anchor rather than ordered by timestamp (see
   * `row-order.ts`). Admitting `system` here would advertise a row this side can
   * never produce.
   */
  role: z.enum(["user", "assistant"]),
  byteLength: byteLengthSchema,
  /**
   * Minimap text for HUMAN user turns only. Assistant rows get their minimap
   * label from role and status, and an A2A row from its sender - so previewing
   * them would be bytes nothing reads.
   *
   * Whitespace-collapsed by the producer, because that is the form the consumer
   * measures its budget in - see `ROW_SKELETON_PREVIEW_MAX_CHARS`.
   */
  preview: z.string().max(ROW_SKELETON_PREVIEW_MAX_CHARS).optional(),
  /**
   * Present (and always `true`) when the row was sent by another AGENT rather
   * than a person - `sender.type === "agent"`, an `agent.sendMessage` delivery.
   *
   * A flag rather than the sender record, because the only consumer that reads
   * an UNHYDRATED row is the minimap, and what it asks is a yes/no: it lists
   * human turns and skips A2A ones (`isHumanUserMessage`). Everything that
   * renders the agent's identity - the id, title, and reply affordance - runs
   * against a hydrated row, which carries the whole sender.
   */
  sentByAgent: z.boolean().optional(),
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
