import { z } from "zod";

import { chatSchema } from "@traycer/protocol/persistence/epic/chat";
import { chatEventSchema } from "@traycer/protocol/persistence/epic/chat-events";
import { messageSchema } from "@traycer/protocol/persistence/epic/messages";
import { tokenUsageSchema } from "@traycer/protocol/persistence/epic/foundation";
import {
  checkpointArtifactTagSchema,
  checkpointFileOperationSchema,
} from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import {
  diffSourceSchema,
  fileEditReasonSchema,
} from "@traycer/protocol/persistence/epic/content-blocks";
import { rowSkeletonEntrySchema } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import { runtimeTodoStatusSchema } from "@traycer/protocol/host/agent/gui/agent-runtime";

/**
 * The pinned todo stack's state, as the host folds it.
 *
 * Mirrors the renderer's `PinnedTodoSnapshot` / `SegmentTodoItem`. It is
 * modelled here rather than imported from the GUI because the fold moves
 * host-side: the host is the only party that can see the whole transcript once
 * the client holds a window, and the published index section stores the same
 * shape so a published copy shows the todos a live one does.
 */
export const pinnedTodoItemSchema = z.object({
  id: z.string(),
  // The runtime's own status enum, not a restatement of it: a hand-copied
  // union here would be a second list to keep in step with the harness
  // adapters that produce these.
  status: runtimeTodoStatusSchema,
  text: z.string(),
  priority: z.string().nullable(),
  activeForm: z.string().nullable(),
});
export type PinnedTodoItem = z.infer<typeof pinnedTodoItemSchema>;

export const pinnedTodoSnapshotSchema = z.object({
  id: z.string(),
  items: z.array(pinnedTodoItemSchema),
});
export type PinnedTodoSnapshot = z.infer<typeof pinnedTodoSnapshotSchema>;

/**
 * # The windowed `chat.subscribe` line
 *
 * Frames for a transcript the host serves in PIECES rather than whole.
 *
 * Today's snapshot embeds the entire persisted chat - 20-40 MB on a long one -
 * and every history mutation re-sends it. These schemas replace that with a
 * bounded snapshot, a row skeleton the client holds for the whole session, and
 * ranges of bodies fetched on demand.
 *
 * ## Version implies behaviour; there is no `windowed` flag
 *
 * A peer that negotiates this line gets windowed frames, full stop. There is
 * deliberately no per-connection opt-in and no full-snapshot mode on the same
 * line: two behaviours behind one version is the arrangement where a host and
 * a client can each believe the other is in the mode it is not. A peer too old
 * for this negotiates an older minor and the host serves it whole snapshots
 * from its own fallback path.
 *
 * ## The 1 MiB frame invariant
 *
 * The relay reclassifies any body over 1 MiB onto the BULK QoS lane
 * PER-MESSAGE (`host-transport/chunking.ts`), where it can be reordered
 * against INTERACTIVE deltas. Same-pump ordering is the whole safety argument
 * for serving ranges on the subscribe stream, so it holds only while every
 * frame here stays under that threshold. Two consequences are structural
 * rather than advisory:
 *
 * - the skeleton is delivered in CHUNKS, never as one array, because a
 *   20k-row skeleton is ~1-2 MB;
 * - `indexChanged` carries a DELTA, never a fresh index.
 *
 * ## The coordinate
 *
 * A row is addressed by its ORDINAL - its index in canonical order
 * (`persistence/chat-transcript/row-order.ts`) under a given
 * `transcriptEpoch`. Ordinals are only meaningful relative to their epoch, so
 * every frame that names one also names the epoch, and every response carries
 * the row IDS it is answering for. A client that receives a range whose ids do
 * not match its skeleton at that span discards it and refetches. That is what
 * turns a missed epoch bump into a wasted round trip instead of bodies
 * rendered under the wrong rows.
 */

/**
 * The chat record WITHOUT its transcript.
 *
 * The snapshot's `chat` field used to be the whole persisted record, arrays
 * and all - which is most of what made the snapshot unbounded. Here it carries
 * only the scalars a renderer reads from the record itself (title, settings,
 * archive state, and the identity fields); the transcript arrives as skeleton
 * plus ranges.
 *
 * Derived from `chatSchema` by omission rather than restated, so a field added
 * to the persisted record appears here automatically and only the two
 * transcript arrays are excluded by hand.
 */
export const chatRecordSchema = chatSchema.omit({
  messages: true,
  events: true,
});
export type ChatRecord = z.infer<typeof chatRecordSchema>;

/**
 * An accumulated file change with its before/after CONTENTS removed.
 *
 * The panel above the composer lists every file the chat has touched. Full
 * contents for all of them is one of the larger byte offenders in today's
 * snapshot and almost none of it is read: the contents matter only for the one
 * file whose diff the user opens. So the snapshot carries the summaries and
 * the contents come from `chat.readAccumulatedFileChange` on demand - a unary
 * call, where a body over 1 MiB riding the BULK lane is correct rather than a
 * hazard, because nothing about it is ordered against the delta stream.
 */
export const chatAccumulatedFileChangeSummarySchema = z.object({
  filePath: z.string(),
  operation: checkpointFileOperationSchema,
  diffSource: diffSourceSchema,
  reason: fileEditReasonSchema,
  undoable: z.boolean(),
  /**
   * Whether contents are fetchable at all. A change whose diff source is
   * `none` has no before/after to ask for, and the client must render it as a
   * plain row rather than offering a diff that would come back empty.
   */
  hasContents: z.boolean(),
  artifact: checkpointArtifactTagSchema.nullish(),
});
export type ChatAccumulatedFileChangeSummary = z.infer<
  typeof chatAccumulatedFileChangeSummarySchema
>;

/**
 * Values the host derives from the WHOLE transcript and the client therefore
 * cannot compute once it only holds a window.
 *
 * Each of these is a full-history scan today, done client-side on every token.
 * Moving them here is not only a correctness requirement of windowing - it
 * also deletes per-token O(history) work from the renderer.
 */
export const chatTranscriptDerivedSchema = z.object({
  /**
   * The most recent assistant usage report, for the context chip. Nullable
   * rather than optional: "no assistant row has reported usage" is a real
   * state on a fresh chat, and the client must render the chip's empty form
   * rather than treat it as "not supported".
   */
  latestAssistantUsage: tokenUsageSchema.nullable(),
  /**
   * The pinned-todo fold's result. The fold is a stateful accumulator with a
   * reset rule keyed on user rows, so it cannot be evaluated over a window -
   * a client holding the tail alone would show the todos of whatever turn it
   * happens to have hydrated. `null` means the fold found no live todo, which
   * is the ordinary state for most chats.
   */
  pinnedTodo: pinnedTodoSnapshotSchema.nullable(),
  /**
   * The message id a fork of this chat would cut at - what the composer's
   * switch-host gesture means by "fork the chat as it stands". `null` when the
   * chat has no boundary yet (the agent has never replied, or its only
   * assistant turn is the one running right now), which the gesture reports
   * rather than opening a dialog pointed at nothing.
   *
   * A scalar rather than per-row skeleton fields: see `fork-boundary.ts`, which
   * holds the derivation and the reasoning. Note this is only the CHAT-level
   * boundary - the per-message fork buttons read the row the user pointed at,
   * which is hydrated by construction.
   */
  latestForkableAssistantMessageId: z.string().nullable(),
});
export type ChatTranscriptDerived = z.infer<typeof chatTranscriptDerivedSchema>;

/**
 * The hydrated rows a snapshot ships inline - the streaming tail.
 *
 * Always present and always hydrated, because the tail is where a live turn
 * happens: the client must be able to render the active turn and the last few
 * rows the instant the snapshot lands, without a round trip. `fromOrdinal`
 * places it, so the client can seat the tail against a skeleton it has not
 * finished receiving yet.
 */
export const chatTranscriptWindowSchema = z.object({
  fromOrdinal: z.number().int().nonnegative(),
  messages: z.array(messageSchema),
  events: z.array(chatEventSchema),
});
export type ChatTranscriptWindow = z.infer<typeof chatTranscriptWindowSchema>;

/**
 * A slice of the skeleton.
 *
 * The skeleton is delivered in chunks rather than inline on the snapshot for
 * the 1 MiB reason above, and that turns out to be the better UX as well: the
 * snapshot carries the hydrated tail, so the client paints the live turn
 * immediately and the scrollback fills in behind it, instead of waiting on an
 * index it needs only to draw the minimap and size the scrollbar.
 *
 * Chunks are contiguous and in order. `isFinal` marks the last one - the point
 * at which the client's skeleton is complete and `rowCount` must agree with
 * what it has assembled. A mismatch means chunks were lost and the client
 * re-requests rather than rendering a short transcript.
 */
export const chatSkeletonChunkSchema = z.object({
  epoch: z.number().int().nonnegative(),
  fromOrdinal: z.number().int().nonnegative(),
  entries: z.array(rowSkeletonEntrySchema),
  isFinal: z.boolean(),
});
export type ChatSkeletonChunk = z.infer<typeof chatSkeletonChunkSchema>;

/**
 * What changed about the index, as a DELTA.
 *
 * Never a fresh index: on a long chat that would be a megabyte-scale frame per
 * mutation, which is both the cost this feature exists to remove and a
 * violation of the 1 MiB invariant.
 *
 * The three cases are not arbitrary - they are what the store can actually do
 * to the row set:
 *
 * - `appended` is the steady state. A new row at the tail shifts no existing
 *   ordinal, so the client appends and nothing it holds is invalidated.
 * - `updated` is a row rewritten in place (a streaming row finalizing, an
 *   image resolving). Ordinals are untouched; the named rows' bodies are
 *   stale and the client drops them. Inclusion IS the staleness signal - there
 *   is no per-row write stamp to compare, and none is needed.
 * - `reindexed` is the honest answer for anything that MOVES rows: a
 *   checkpoint trim removing rows, or a restore re-appending one whose
 *   timestamp seats it mid-history. Every ordinal after the change is
 *   different, so rather than describe the shift the host declares the index
 *   invalid and the client re-requests it. These are user-initiated history
 *   mutations - rare, and worth a refetch to avoid a delta format whose edge
 *   cases nobody would exercise often enough to trust.
 */
export const chatIndexChangeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("appended"),
    entries: z.array(rowSkeletonEntrySchema),
  }),
  z.object({
    type: z.literal("updated"),
    entries: z.array(
      z.object({
        ordinal: z.number().int().nonnegative(),
        entry: rowSkeletonEntrySchema,
      }),
    ),
  }),
  z.object({ type: z.literal("reindexed") }),
]);
export type ChatIndexChange = z.infer<typeof chatIndexChangeSchema>;

/**
 * A range of hydrated bodies, answering one `loadRange`.
 *
 * `rowIds` is the identity check and is not optional. The client compares it
 * against its own skeleton at `fromOrdinal` and discards the response on any
 * mismatch. That check is what makes the ordinal coordinate safe: a missed
 * epoch bump anywhere in the host's ~27 emit sites degrades to a wasted round
 * trip instead of bodies rendered under the wrong rows.
 *
 * `truncatedAtOrdinal` is present when the host stopped early to respect
 * `maxBytes` - a single message can be over a megabyte, so a range the client
 * asked for is not always a range that fits. The client requests the remainder
 * from there; it is not an error.
 */
export const chatRangeResponseSchema = z.object({
  requestId: z.string(),
  epoch: z.number().int().nonnegative(),
  fromOrdinal: z.number().int().nonnegative(),
  rowIds: z.array(
    z.object({ kind: z.enum(["message", "event"]), id: z.string() }),
  ),
  messages: z.array(messageSchema),
  events: z.array(chatEventSchema),
  reachedStart: z.boolean(),
  reachedEnd: z.boolean(),
  truncatedAtOrdinal: z.number().int().nonnegative().optional(),
});
export type ChatRangeResponse = z.infer<typeof chatRangeResponseSchema>;

/**
 * A request for a span of bodies.
 *
 * Stateless and idempotent on the host: it holds no per-subscriber cursor, so
 * a repeat of the same request is the same answer and a lost response costs a
 * retry rather than a desync.
 *
 * `epoch` is carried so the host can REJECT a request framed against a
 * superseded index instead of serving the wrong span - the client may not have
 * processed the `indexChanged` that raced its request.
 *
 * `maxBytes` is the client's budget for the response and must be at or under
 * the 1 MiB frame invariant.
 */
export const chatLoadRangeRequestSchema = z.object({
  requestId: z.string(),
  epoch: z.number().int().nonnegative(),
  fromOrdinal: z.number().int().nonnegative(),
  toOrdinal: z.number().int().nonnegative(),
  maxBytes: z.number().int().positive(),
});
export type ChatLoadRangeRequest = z.infer<typeof chatLoadRangeRequestSchema>;
