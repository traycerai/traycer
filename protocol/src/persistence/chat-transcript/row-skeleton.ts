import { z } from "zod";

import { tokenUsageSchema } from "@traycer/protocol/persistence/epic/foundation";

/**
 * # The row skeleton
 *
 * One entry per transcript ROW, in projection order (`row-projection.ts`),
 * carrying
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
 * **No per-row write stamp.** Staleness is carried by the `updated` member of
 * an `indexChanged` frame's `changes` array, whose `entries` are
 * `{ordinal, entry}` pairs: inclusion IS the signal, and the client drops the
 * body of every ordinal it names. A `lastWriteSeq` to compare against would be
 * a second coordinate for a question the list already answers.
 *
 * That argument is about the WIRE, and an earlier draft over-read it as also
 * settling how the host decides what to put in that list. It does not: the
 * producer of `updated` is a field-by-field comparison of two skeletons, so it
 * can only see changes some field expresses. `bodyDigest` is that field. It is
 * not a write stamp - it is not monotonic, not a version, and carries no
 * ordering - and the client never compares it against anything, because
 * inclusion in `updated` is still the whole signal it reads.
 *
 * **No body, and no field derived from a body that can grow WITH the body.**
 * `byteLength` and `bodyDigest` are both derived from bodies and both bounded -
 * a hint and a fixed-width fingerprint. What the rule excludes is a field whose
 * own size tracks the body's, which is what would turn a 20k-row skeleton from
 * ~1-2 MB into the transcript it exists to avoid shipping.
 *
 * **No record identity.** An entry is keyed by its ROW id, not by a
 * `(kind, messageId|eventId)` pair. The first version of this schema used
 * record identity and it was wrong in both directions: one assistant turn's
 * several records produce ONE row (so the id was ambiguous), one turn can
 * produce SEVERAL rows (so the id was not unique), and a setup card or a
 * synthesized stopped row has no single record to name at all. A row id is the
 * only thing that addresses a row.
 *
 * **No `eventType`.** It followed from record identity and admitted every event
 * kind, including kinds that can never draw a row. With rows keyed by row id
 * the field has no consumer and the invariant is structural.
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
 * A fingerprint of everything about the row a client must DROP what it holds
 * for - its body and its projection context - for change detection only.
 *
 * ## Why this exists when `updated` already carries staleness
 *
 * The `updated` member of an `indexChanged` frame is produced by comparing two
 * skeletons field by field, so what it can detect is bounded by what those
 * fields SAY. Every other field here is display metadata, and a row can be
 * rewritten without moving any of them: a same-length block or status
 * replacement leaves `byteLength` equal, and `preview` is human-user-rows-only
 * by design, so an assistant row has no body-derived field at all. The
 * comparison then reports "unchanged", no `updated` entry is emitted, and a
 * client that already loaded that row keeps rendering the old body for the
 * life of the connection - `updated` is its only eviction signal.
 *
 * ## Why it covers the row CONTEXT as well as the body
 *
 * The same failure, one field over. `transcriptRowContextSchema`'s values are
 * derived from WHOLE history - a later `queue.fallback` retracts a steer badge,
 * a later checkpoint starts overlapping an earlier one - so a LATER event flips
 * an EARLIER row's context with every field of this entry byte-identical. The
 * context does not ride the skeleton (it rides the range, per its own doc), so
 * absent this there is nothing in the entry that could differ, and the stale
 * context is permanent for the connection.
 *
 * Folding it in here rather than shipping a second digest is deliberate: this
 * frame's per-row bytes multiply by the length of the chat, and the two ask one
 * question with one answer - the client's remedy for either is to drop the row
 * and refetch it, which is what an `updated` means.
 *
 * That is the one failure this whole line cannot recover from on its own. A
 * missing row gets re-requested; a row nobody knows is stale does not.
 *
 * ## Why it is admissible under "no field derived from a body that can grow"
 *
 * The rule above bounds the skeleton's SIZE, and this is fixed-width by
 * construction (see `finishContentFingerprint`) however large the body is. It
 * is derived from a growing body and is itself bounded, which is exactly the
 * shape the rule permits - `byteLength` is the same bargain.
 *
 * ## Not a contract, and not an identity
 *
 * Nothing may treat equal digests as proof two rows are interchangeable, or
 * unequal ones as proof of a MEANINGFUL change: a rebuild that re-encodes a
 * record identically produces the same digest, and that is the point. It
 * answers one question - "must I drop what I am holding for this ordinal" -
 * and a false "yes" costs one refetch while a false "no" is the bug above.
 */
const bodyDigestSchema = z.string().min(1).max(32);

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

export const rowSkeletonEntrySchema = z.object({
  /**
   * The row's identity, built by `row-projection.ts`. Opaque here on purpose -
   * a client matches it, it does not parse it.
   */
  rowId: z.string(),
  /**
   * The projection's placement key. Present so a client can verify the ordering
   * it was handed rather than trust it - a host and client that disagree about
   * order put bodies under the wrong rows, and this is the field that makes
   * that detectable rather than silent.
   *
   * For an assistant row this is `rowAnchorAt`, NOT the record timestamp: every
   * row of one turn shares the same value and their relative order comes from
   * sort stability. So equal `createdAt` across neighbouring rows is ordinary
   * here, not a tie to break.
   */
  createdAt: z.number(),
  /**
   * The role the row RENDERS as, which is not the same as a record's role.
   * `system` is the setup card and the forked-chat link; a notification anchor
   * and a synthesized stopped-turn boundary render as `assistant`; a steer
   * bubble renders as `user`.
   *
   * An earlier draft narrowed this to the two persisted roles on the grounds
   * that `system` had no persisted counterpart. That was right about records
   * and wrong about rows - which is the whole distinction this schema now
   * carries.
   */
  role: z.enum(["user", "assistant", "system"]),
  byteLength: byteLengthSchema,
  bodyDigest: bodyDigestSchema,
  /**
   * Minimap text for HUMAN user rows only. Assistant rows get their minimap
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
   *
   * Carried by the turn's LAST row, so a split turn reports its usage once.
   */
  usage: tokenUsageSchema.optional(),
});
export type RowSkeletonEntry = z.infer<typeof rowSkeletonEntrySchema>;
