import { z } from "zod";

import { defineRpcContract } from "@traycer/protocol/framework/index";
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
import {
  rowSkeletonEntrySchema,
  type RowSkeletonEntry,
} from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import { transcriptRowContextSchema } from "@traycer/protocol/persistence/chat-transcript/row-context";
import {
  interviewAnswerabilitySchema,
  judgeInterviewAnswerability,
  type InterviewAnswerability,
} from "@traycer/protocol/persistence/chat-transcript/interview-answerability";
import { latestAssistantAuthFailureTurnKey } from "@traycer/protocol/persistence/chat-transcript/provider-auth-failure";
import {
  LOCATOR_MESSAGE_TEXT_MAX_CHARS,
  transcriptRowLocatorSchema,
  type TranscriptRowLocator,
} from "@traycer/protocol/persistence/chat-transcript/locate-row";
import {
  restorableSetupInterruptionSchema,
  selectRestorableSetupInterruption,
  type RestorableSetupInterruption,
} from "@traycer/protocol/persistence/chat-transcript/setup-interruption";
import { utf8ByteLength } from "@traycer/protocol/utils/text/utf8";
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
 * turns a missed coordinate invalidation into a wasted round trip instead of bodies
 * rendered under the wrong rows.
 */

/**
 * Bound on a client-chosen `requestId`.
 *
 * The host reserves a FIXED number of bytes for the range frame's envelope when
 * it budgets a response (`TRANSCRIPT_RANGE_ENVELOPE_RESERVE_BYTES`), and
 * `requestId` is the only envelope field the client fills in. Without a bound
 * here that reserve would be a guess about a value the other side controls -
 * i.e. a way to push the frame past the relay's 1 MiB threshold from outside
 * the host. 128 is far more than any id generator needs.
 */
export const RANGE_REQUEST_ID_MAX_CHARS = 128;

/**
 * And a CHARSET, because a character bound is not a byte bound.
 *
 * The reserve is measured in bytes; `z.string().max(128)` counts UTF-16 code
 * units. `"\u0000".repeat(128)` satisfies that bound and JSON-encodes to 770
 * bytes - it escapes to six characters each - against 130 for 128 ASCII
 * characters. That single field can exceed the whole 512-byte reserve on its
 * own, which is exactly the class of hole the reserve was added to close.
 *
 * Restricting the alphabet is better than inflating the reserve: it makes the
 * worst case EQUAL the bound rather than six times it, and every id generator
 * anyone would reach for (uuid, nanoid, a counter) already lives inside it.
 */
export const RANGE_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** A `requestId` bounded in bytes, not just in code units. */
const rangeRequestIdSchema = z
  .string()
  .min(1)
  .max(RANGE_REQUEST_ID_MAX_CHARS)
  .regex(RANGE_REQUEST_ID_PATTERN);

/**
 * Bound on the host-minted accumulated-change digest.
 *
 * Bounded for the same class of reason as `requestId`: it appears once per
 * summary and the snapshot carries every summary, so an unbounded token would
 * multiply by the number of files a chat has touched.
 */
export const ACCUMULATED_CHANGE_DIGEST_MAX_CHARS = 128;

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
  /**
   * Which VERSION of this file's accumulated change the summary describes.
   *
   * Opaque to the client: echo it verbatim on
   * {@link chatReadAccumulatedFileChangeRequestSchema}, never parse it. The host
   * mints it and is free to change how.
   *
   * Present because a path is not a version. The client renders the summary
   * (operation, reason, undoable) at one instant and asks for contents at
   * another, and the agent can edit the same file in between - so a request
   * keyed on `{chatId, path}` alone can pair NEWER bodies with the STALE
   * metadata still on screen, with nothing in either message able to detect it.
   * The digest makes that a rejected request rather than a wrong diff.
   */
  digest: z.string().max(ACCUMULATED_CHANGE_DIGEST_MAX_CHARS),
  /**
   * The `+`/`-` the panel shows BEFORE anyone opens a diff.
   *
   * Host-computed, because on this line the client has no contents to count
   * from. The panel derives every row's magnitude and its collapsed header
   * total from `beforeContent`/`afterContent` today
   * (`chat-accumulated-changes-panel.tsx`), so a summary without these renders
   * every file as `+0 / -0` and the header as nothing - a plain regression a
   * cold review caught, and exactly the kind the zero-regression bar is about.
   *
   * `null` when there is nothing to count: a change whose `diffSource` is
   * `none` has no before/after at all, which the panel must render as a bare
   * row rather than as a zero-line diff. Distinct from `{0, 0}`, which means
   * "counted, and the file came back unchanged".
   *
   * The active turn is NOT counted here. Its rows carry per-edit streaming
   * counts the panel already overlays, and the host only recomputes cumulative
   * contents at turn end - so a host-computed value mid-turn would be the
   * stale one, and would replace a live number with an older one.
   */
  counts: z
    .object({
      additions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
    })
    .nullable(),
  artifact: checkpointArtifactTagSchema.nullish(),
});
export type ChatAccumulatedFileChangeSummary = z.infer<
  typeof chatAccumulatedFileChangeSummarySchema
>;

/**
 * The unary fetch behind a summary - `chat.readAccumulatedFileChange`.
 *
 * Off-floor (`degrade: {kind: "unsupported"}`), which is what lets the GUI fall
 * back to its legacy full-contents-in-snapshot path against an older host.
 *
 * A body over 1 MiB riding the BULK lane is correct here rather than a hazard:
 * this is a unary call, ordered against nothing on the delta stream.
 */
export const chatReadAccumulatedFileChangeRequestSchema = z.object({
  /**
   * Present because a chat id alone does not address a chat on this host: live
   * sessions are keyed by `(epicId, chatId)`, exactly as every chat-scoped
   * stream frame is (`chatReferenceFields`). An earlier draft of this schema
   * carried only `chatId` and there was no way to resolve it.
   */
  epicId: z.string(),
  chatId: z.string(),
  filePath: z.string(),
  /** Copied verbatim from the summary being displayed. */
  digest: z.string().max(ACCUMULATED_CHANGE_DIGEST_MAX_CHARS),
});
export type ChatReadAccumulatedFileChangeRequest = z.infer<
  typeof chatReadAccumulatedFileChangeRequestSchema
>;

/**
 * Contents for one accumulated change.
 *
 * `stale: true` is the answer when the digest names a version the host no
 * longer holds - the file was edited again between render and click. It carries
 * no contents, and the client re-reads the summary rather than showing a diff
 * whose metadata describes a different edit. Modelled as a normal response
 * rather than an error because it is an ordinary race, not a fault.
 */
export const chatReadAccumulatedFileChangeResponseSchema = z.discriminatedUnion(
  "stale",
  [
    z.object({
      stale: z.literal(false),
      beforeContent: z.string().nullable(),
      afterContent: z.string().nullable(),
    }),
    z.object({ stale: z.literal(true) }),
  ],
);
export type ChatReadAccumulatedFileChangeResponse = z.infer<
  typeof chatReadAccumulatedFileChangeResponseSchema
>;

/**
 * The contents fetch behind an accumulated-change summary.
 *
 * Registered `degrade: { kind: "unsupported" }`, which is what lets a GUI fall
 * back to its legacy full-contents-in-snapshot path against an older host
 * rather than failing the panel. Safe to register immediately, unlike the
 * windowed stream line: a unary method flips no negotiation, so a client that
 * never calls it is unaffected by its presence.
 */
export const chatReadAccumulatedFileChangeV10 = defineRpcContract({
  method: "chat.readAccumulatedFileChange",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: chatReadAccumulatedFileChangeRequestSchema,
  responseSchema: chatReadAccumulatedFileChangeResponseSchema,
});

/**
 * The locator shape a `chat.locateRow` request carries, and its search.
 *
 * Re-exported here for the same reason the setup interruption is: a producer
 * reads the windowed line's payloads from this module alone. Both live in
 * `persistence/chat-transcript/locate-row.ts`, beside the row projection whose
 * enumeration defines what an ordinal MEANS.
 */
export {
  transcriptRowLocatorSchema,
  type TranscriptRowLocator,
  LOCATOR_MESSAGE_TEXT_MAX_CHARS,
};

/**
 * Where a jump target sits in the transcript - `chat.locateRow`.
 *
 * The windowed line's other half of a cross-tile jump. A client resolves some
 * targets itself and reads the ordinal off the skeleton it holds, but `block`
 * and `sent-message` anchors are identified by walking RENDERED models, which a
 * cold row has none of - and a `message` anchor naming an ASSISTANT record has
 * no row id to read at all, because those rows are turn-keyed and keep the
 * durable id only on the rendered model. Without this the jump deadlocks rather
 * than degrading: the scroll drives hydration and the scroll is what is being
 * held back, so the target is never requested and the request parks forever.
 */
export const chatLocateRowRequestSchema = z.object({
  /**
   * Present for the same reason it is on
   * {@link chatReadAccumulatedFileChangeRequestSchema}: a chat id alone does not
   * address a chat on this host - sessions are keyed by `(epicId, chatId)`.
   */
  epicId: z.string(),
  chatId: z.string(),
  target: transcriptRowLocatorSchema,
});
export type ChatLocateRowRequest = z.infer<typeof chatLocateRowRequestSchema>;

/**
 * The ordinal, or the one opaque refusal.
 *
 * `found: false` answers all of "no live session", "no row matches this
 * target", and "you may not read this chat" - deliberately, and for the reason
 * spelled out on `ChatSessionManager.readAccumulatedFileChange`. Splitting them
 * would rebuild the liveness oracle that method closed: a caller holding chat
 * ids it may not read could sort them by which ones threw. A legitimate caller
 * loses nothing, because a chat it cannot read has no row for it to jump to.
 *
 * The ordinal is an index into the row enumeration the skeleton publishes, so
 * the client feeds it straight to its hydration planner - but only after
 * checking the `epoch` it came stamped with, which is what the rest of this
 * doc is about.
 *
 * ## Why an ordinal alone is not an answer
 *
 * An ordinal is a coordinate, and a coordinate means nothing without the space
 * it is in. This is a unary RPC on a different connection from the stream, so
 * between the host numbering the row and the client consuming the number the
 * transcript can be re-based - a restore, a checkpoint, a compaction. Every one
 * of those advances the epoch, and the client is then handed a position in a
 * space it has left. Nothing downstream can detect that: the ordinal is
 * in-range, the planner fetches it, and the reader is scrolled to a plausible
 * wrong row. So the space rides with the coordinate and the client refuses an
 * answer stamped with an epoch it is not in.
 *
 * The EPOCH and not the located row's id, and the distinction is worth stating
 * because an earlier draft of this doc argued against a second identifier
 * outright. That argument was about ANCHOR RESOLUTION - once the row is
 * hydrated the client resolves the anchor through its own rendered models
 * exactly as it does for a warm target, so a row id would ride the wire with no
 * reader. It was never about staleness, which is a different question and needs
 * an answer. The epoch is the one that answers it completely: within an epoch
 * an existing ordinal keeps naming the same row (an `appended` change only adds
 * beyond it, an `updated` moves no ordinal), and anything that MOVES a row is a
 * `reindexed`, which advances the epoch by the same predicate. A row id would
 * be a second, weaker check on top of a complete one.
 */
export const chatLocateRowResponseSchema = z.discriminatedUnion("found", [
  z.object({
    found: z.literal(true),
    ordinal: z.number().int().nonnegative(),
    /**
     * The transcript epoch the ordinal is numbered in.
     *
     * The client compares it against the epoch its own window is holding and
     * discards the answer on a mismatch, exactly as it does for a `loadRange`
     * response - same coordinate, same rule, so the two cannot disagree about
     * what makes an ordinal usable.
     */
    epoch: z.number().int().nonnegative(),
  }),
  z.object({ found: z.literal(false) }),
]);
export type ChatLocateRowResponse = z.infer<typeof chatLocateRowResponseSchema>;

/**
 * Registered `degrade: { kind: "unsupported" }`, like the accumulated-change
 * read beside it: a GUI meeting an older host falls back to waiting for the
 * target to arrive on its own, which is the pre-windowed behavior and correct
 * there, because that host serves the whole transcript and the row is never
 * cold. A unary method flips no negotiation, so registering it cannot disturb a
 * client that never calls it.
 */
export const chatLocateRowV10 = defineRpcContract({
  method: "chat.locateRow",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: chatLocateRowRequestSchema,
  responseSchema: chatLocateRowResponseSchema,
});

/**
 * Values the host derives from the WHOLE transcript and the client therefore
 * cannot compute once it only holds a window.
 *
 * Each of these is a full-history scan today, done client-side on every token.
 * Moving them here is not only a correctness requirement of windowing - it
 * also deletes per-token O(history) work from the renderer.
 */
/**
 * A setup failure or cancellation the composer can put a draft back from.
 *
 * The shape AND its selection rule live in
 * `persistence/chat-transcript/setup-interruption.ts`, and both are re-exported
 * here so this module stays the one place a producer reads the windowed line's
 * payloads from. The fields are exactly what the composer-restore driver reads
 * - not the whole event - because a wire shape that carried the event would
 * invite a second consumer to start reading something else off it, and then
 * this would be a transcript record again.
 */
export {
  restorableSetupInterruptionSchema,
  selectRestorableSetupInterruption,
  type RestorableSetupInterruption,
};

/**
 * The two answers a windowed client would otherwise read out of an ABSENCE.
 *
 * Both back a destructive consumer. `findUnanswerableInterviews` offers to
 * error out a question whose block it cannot find, and the store's persisted
 * auth nudge declines to mount the re-auth banner for a failure it cannot see -
 * one destroys an answer, the other leaves a chat sending against a credential
 * the host has already poisoned. Their derivations and the reasoning live in
 * `persistence/chat-transcript/`, beside the row projection they read; they are
 * re-exported here for the same reason the setup interruption is, so a producer
 * reads this module alone.
 */
export {
  interviewAnswerabilitySchema,
  judgeInterviewAnswerability,
  latestAssistantAuthFailureTurnKey,
  type InterviewAnswerability,
};

/**
 * One setup lifecycle window's identity, as the WHOLE-LOG partition sees it.
 *
 * Deliberately not the window's events or its view model - the card renders
 * from the events a range already serves it. What it cannot derive in isolation
 * is where the window sits in the sequence and whether it is still open, and
 * that is exactly what this carries.
 */
export const setupCardWindowIdentitySchema = z.object({
  /**
   * The window's anchor - the earliest setup-event timestamp in it.
   *
   * The MATCH KEY, and the reason this works: a client re-partitioning one
   * window's events computes the same value, because it is a property of those
   * events and not of the window's position. Ties are broken by array order,
   * so two lifecycles stamped in the same millisecond still map one-to-one.
   */
  createdAt: z.number(),
  /** The window's position in the whole-log partition. */
  windowIndex: z.number().int().nonnegative(),
  /**
   * True only for the window still OPEN at the end of the log. A closed window
   * keeps whatever state its last event left it in - which CAN be `setting-up`
   * when the worktree vanished mid-setup - so a client must read this rather
   * than infer liveness from the state.
   */
  isActive: z.boolean(),
  /**
   * The timestamp of the event that CLOSED this window, or `null` while it is
   * still open.
   *
   * The boundary a slice cannot see, published because the client cannot derive
   * it. A lifecycle ends either at a `worktree.missing` - which is not a setup
   * event, so a range serving only setup rows never carries it - or at one of
   * `closesWindow`'s defensive re-bind boundaries. Either way the host holds
   * that stamp at partition time and the client holds nothing that implies it.
   *
   * What it settles: whether a live setup event stamped after the last known
   * window belongs to that window or opens a new lifecycle. Both look identical
   * from timestamps and window contents alone, and the client had been
   * inferring it - a guess with a counterexample either way.
   *
   * OPTIONAL, so a host that predates this field simply omits it and the client
   * degrades to that inference, with the ambiguity documented as a skew
   * limitation. Additive and optional, and the `1.8` line is unreleased, so no
   * version bump is owed.
   */
  closedAt: z.number().nullable().optional(),
  /**
   * Whether the window holds a `setup.creating` event, which is what
   * distinguishes a live mid-conversation creation from the back-filled genesis
   * worktree the transcript pins to the top.
   */
  hasCreatingEvent: z.boolean(),
});
export type SetupCardWindowIdentity = z.infer<
  typeof setupCardWindowIdentitySchema
>;

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
   * The task-tool accumulator behind {@link pinnedTodo}, as of the same fold.
   *
   * Carried SEPARATELY because the fold maintains it separately: the task
   * tools are a delta protocol, and a semantic `todo` block outranks the task
   * list without stopping it. So `pinnedTodo` is regularly a semantic todo
   * while the accumulator holds an unrelated checklist that the live turn's
   * next `update`/`complete` is going to address.
   *
   * The client resumes the fold from this to overlay the running turn. Seeding
   * from `pinnedTodo.items` instead - the same field, read as if it were the
   * accumulator - drops an update whose id is absent, or rewrites a semantic
   * item on an id collision, and the dock then sits on the wrong checklist for
   * the rest of the turn.
   *
   * Empty for a chat that used no task tools, which is most of them.
   */
  pinnedTaskTodoItems: z.array(pinnedTodoItemSchema),
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
  /**
   * The setup interruption the composer would restore a draft from.
   *
   * Here rather than derived client-side because the event it comes from
   * OCCUPIES NO ORDINAL. `partitionSetupCardWindows` skips a path-less
   * `setup.failed` deliberately - it can neither name a workspace nor drive a
   * retry, so it forms no card - and the host and the renderer agree about that
   * by sharing the same partition. What neither noticed is that
   * `selectRestorableSetupInterruption` reads the SAME event straight off the
   * full array, for a purpose that has nothing to do with rows.
   *
   * A row-less event is in no row's record set, so `sliceTranscriptTail` never
   * includes it and `loadRange` - addressed by ordinal - can never ask for it.
   * It is not "evicted and refetchable"; on the windowed line it is unreachable
   * outright, and the composer would silently stop restoring drafts after a
   * setup failure.
   *
   * So it ships as what it always was: chat-level aux state. `null` when there
   * is no restorable interruption, which is the ordinary case.
   *
   * The general rule this settles: **an event the client reads but no row
   * renders must ride the snapshot.** Ordinals address rows; anything outside
   * that space needs its own carriage.
   */
  restorableSetupInterruption: restorableSetupInterruptionSchema.nullable(),
  /**
   * Where each host-pending interview's answer card would render.
   *
   * One entry per id in the same snapshot's own `pendingInterviews` (see
   * `chatWindowedSnapshotSchema`), so the two are read as a pair: an `ordinal`
   * says the card is merely cold and names the row to hydrate, a `null` ordinal
   * says no row can ever draw it, and a pending id with no entry at all says
   * the host has not judged it yet. The dismiss affordance is gated on the
   * second of those three and nothing else - see `interview-answerability.ts`
   * for why the third is a real state on this line and not on the legacy one.
   *
   * Empty for the overwhelming majority of snapshots, because it is bounded by
   * a pending set that is usually empty.
   */
  interviewAnswerability: z.array(interviewAnswerabilitySchema),
  /**
   * The nudge key of the latest assistant turn when that turn ended in a
   * recoverable provider-auth failure, `null` when it did not.
   *
   * `null` is the ordinary state and means "the last turn did not fail on a
   * credential" - never "not hydrated". That distinction is the whole point:
   * the store's own backwards scan cannot tell the two apart once `messages` is
   * a window, and it resolves the ambiguity by staying silent, so a headless
   * failure followed by a few user rows silently stops mounting the re-auth
   * banner. See `provider-auth-failure.ts`, which both lines call.
   */
  latestAssistantAuthFailureTurnKey: z.string().nullable(),
  /**
   * Every setup lifecycle window in the chat, in chronological order.
   *
   * ## Why this is chat-level and not per-row context
   *
   * A setup card's row id is `setup-card:<chatId>:<windowIndex>:<createdAt>`,
   * and `windowIndex` is a position in a partition over the chat's WHOLE event
   * log. A client hydrating one card in isolation re-runs that partition over
   * that window's events alone, renumbers the card to 0, and can revive a
   * historically closed window as active.
   *
   * `TranscriptRowContext` carries the right answers and cannot deliver them,
   * because the lookup is CIRCULAR: the context map is keyed by row id, and a
   * client that renumbered the window computes a different row id, so it cannot
   * find the entry that would have corrected it. Every repair keyed on the row
   * id has that shape.
   *
   * So the answer travels as chat-level aux, keyed on `createdAt` - which the
   * client derives identically from the window's own events, because it is the
   * earliest setup-event timestamp IN that window. That is what breaks the
   * circle: the match key is local, the index is not.
   *
   * Bounded by the number of setup lifecycles a chat has had - one for most
   * chats, a handful for a heavily re-bound one - never by rows.
   */
  setupCardWindows: z.array(setupCardWindowIdentitySchema),
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
  /**
   * One ROW id per row in the tail, in order - the same identity echo a
   * `range` carries, and read the same way.
   *
   * The tail is emitted BEFORE the skeleton streams, so the client cannot check
   * these against an index it does not have yet. That is not what they are for
   * here: without them the client has to take the tail's extent positionally
   * (`fromOrdinal` to `rowCount`) and leave every id blank until a skeleton
   * chunk supplies one, which also leaves {@link rowContext} with nothing to
   * key on.
   *
   * Optional rather than defaulted, for the reason `row-context.ts` gives:
   * absent is a producer that has nothing to say, not an empty answer. A host
   * that predates the field leaves the client on the positional read it used
   * before; an empty ARRAY would be indistinguishable from "this tail served no
   * rows", which is a real and different state.
   */
  rowIds: z.array(z.string()).optional(),
  messages: z.array(messageSchema),
  events: z.array(chatEventSchema),
  /**
   * What the tail's rows render WITH, by row id - see
   * {@link chatRangeResponseSchema}'s field of the same name.
   *
   * The tail needs this for the same reason a range does and with less chance
   * of repair: the planner counts these rows hydrated, so no range is ever
   * asked for them and a wrong elapsed time or profile label persists until the
   * rows are evicted. Most tails have nothing to say and omit it.
   */
  rowContext: z.record(z.string(), transcriptRowContextSchema).optional(),
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
 * ## One frame carries an ARRAY of these
 *
 * A single mutation is routinely two of these at once: a turn finishing APPENDS
 * rows and UPDATES the streaming row that preceded them with its final size and
 * usage. They ride one `indexChanged` frame together (see that frame's
 * `changes` field) rather than two frames, because after applying `appended`
 * alone the client's skeleton LENGTH already equals the frame's `rowCount` - so
 * a lost or dropped second frame leaves an index that looks complete and is
 * silently wrong at one entry, which neither side can detect. Same-pump
 * ordering makes that unlikely, not impossible: backpressure compaction
 * explicitly drops queued `indexChanged` frames.
 *
 * Within one frame the members' ordinals are disjoint by construction -
 * `appended` names only ordinals at or past the old length, `updated` only
 * ordinals below it - so they may be applied in either order and the frame is
 * atomic.
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
 * coordinate invalidation degrades to a wasted round trip instead of bodies
 * rendered under the wrong rows.
 *
 * `truncatedAtOrdinal` is present when the host stopped early to respect
 * `maxBytes` - a single message can be over a megabyte, so a range the client
 * asked for is not always a range that fits. The client requests the remainder
 * from there; it is not an error.
 */
export const chatRangeResponseSchema = z.object({
  requestId: rangeRequestIdSchema,
  epoch: z.number().int().nonnegative(),
  fromOrdinal: z.number().int().nonnegative(),
  /**
   * One ROW id per served row, in order.
   *
   * Not `(kind, messageId | eventId)`: a row can be several records (a folded
   * assistant turn), several rows can share one record set (that turn's slices
   * and the steer bubbles between them), and a setup card or a synthesized
   * stopped row has no single record to name. Record identity cannot address a
   * row - see `row-projection.ts`.
   */
  rowIds: z.array(z.string()),
  /**
   * The DEDUPLICATED union of records the served rows render from - not a
   * parallel array to `rowIds`. A turn's records appear once however many of
   * its slices are in the span.
   */
  messages: z.array(messageSchema),
  events: z.array(chatEventSchema),
  /**
   * What the served rows render WITH, by row id.
   *
   * The host projects a row against whole history; this response serves that
   * row's records alone. Anything the renderer derives by looking at rows
   * AROUND the one it is drawing therefore gets a different answer from an
   * isolated span - and in two cases the re-derived row id then disagrees with
   * the skeleton, so the ordinal is suppressed and the row draws unplaced at
   * the tail. Those derivations read this instead.
   *
   * A map holding only rows with something to say, not a parallel array to
   * `rowIds`: most rows need none, and `{}` per row is real bytes on a frame
   * that has already overshot its budget once.
   *
   * Absent for a row means "the projection has nothing to add", NOT a default -
   * a consumer falls back to its own derivation, which is what keeps a host
   * predating a field from silently asserting one.
   */
  rowContext: z.record(z.string(), transcriptRowContextSchema).default({}),
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
 * `fromOrdinal` and `toOrdinal` are INCLUSIVE at both ends. The response's
 * `truncatedAtOrdinal` is the other convention on purpose - it names the first
 * ordinal that did NOT fit, so a client resumes at exactly that number without
 * an off-by-one at the seam.
 *
 * `maxBytes` is the client's budget for the response. It is a ceiling that
 * yields to progress: a single record larger than the whole budget is served
 * alone and over it, because a row that cannot be fetched at any budget is a
 * permanent hole in the transcript, and single records do reach ~1.27 MB.
 *
 * That is also the one sanctioned exception to the 1 MiB frame invariant, and
 * it is safe for a reason that does not generalize: the invariant exists
 * because the relay reclassifies an oversized body to the BULK lane, where it
 * can be reordered against INTERACTIVE deltas. A `range` response is ordered
 * against nothing - it is matched by `requestId`, validated by `epoch`, and
 * applied by row identity - so arriving late costs it nothing. A `snapshot` or
 * an `indexChanged` has no such protection and must stay under the ceiling.
 */
/**
 * # Keeping the invariant real
 *
 * `range` responses are budgeted by `sliceTranscriptRange`, and the snapshot's
 * tail by `sliceTranscriptTail`. The two frames below were left to their
 * producers' discretion, which is the same mistake `maxBytes` made before it
 * became a frame ceiling: an invariant every doc comment asserts and no code
 * enforces holds until the first chat large enough to break it.
 *
 * Both budgets are deliberately well under 1 MiB. These frames share the wire
 * with nothing else, but the relay's threshold is on the ENCODED body, and
 * leaving headroom is cheaper than discovering the encoder's overhead in
 * production.
 */
export const SKELETON_CHUNK_MAX_BYTES = 256 * 1024;
export const INDEX_CHANGE_MAX_BYTES = 256 * 1024;

/**
 * The ceiling on a bounded snapshot's ENCODED size.
 *
 * Named and enforced rather than assumed. Every other frame on this line is
 * budgeted - the tail by `sliceTranscriptTail`, the skeleton by
 * {@link chunkRowSkeleton}, the delta by {@link indexChangeFits} - and the
 * snapshot was the one left measuring nothing, which is precisely the shape
 * `maxBytes` had before it became a real frame ceiling.
 */
export const WINDOWED_SNAPSHOT_MAX_BYTES = 1024 * 1024;

/**
 * What the frame costs on top of the snapshot payload itself.
 *
 * {@link windowedSnapshotFitsFrame} is handed the SNAPSHOT, but what the relay
 * classifies is the encoded BODY: the frame's own `kind`, `epicId` and `chatId`
 * around it, plus the five-byte body header `encodeMuxMessageBody` prepends
 * before `BULK_QOS_BODY_THRESHOLD_BYTES` is applied. That threshold is 1 MiB -
 * the SAME value as the ceiling above - so without a reserve a snapshot
 * measuring just under the ceiling encodes to just over the threshold and is
 * put on the BULK lane, where it can reorder against the interactive deltas
 * this bound exists to stay ordered with. The check would pass and the
 * invariant it enforces would be the thing that broke.
 *
 * A RESERVE, not a measurement: the exact envelope is a few hundred bytes
 * (two uuids, a discriminator, the mux header), and this is rounded far above
 * it so that adding an envelope field later cannot silently consume the
 * margin. The cost of over-reserving is one more tail row shed on a snapshot
 * within 4 KiB of a 1 MiB ceiling; the cost of under-reserving is a
 * reordered transcript.
 */
export const WINDOWED_SNAPSHOT_FRAME_OVERHEAD_BYTES = 4 * 1024;

/** A contiguous run of items small enough to ship as one frame. */
export interface EncodedChunk<Item> {
  readonly fromIndex: number;
  readonly items: readonly Item[];
  readonly isFinal: boolean;
}

/**
 * Splits a list into frame-sized chunks, measured on the ENCODED bytes.
 *
 * Shared by the skeleton and the accumulated-change summaries because they have
 * the same shape of problem - a list whose length is a property of the chat's
 * history rather than of its current state - and a second chunker would be a
 * second set of boundary decisions for two producers to disagree about.
 *
 * An item too large for a whole chunk still ships ALONE rather than being
 * dropped: a list with a hole in it is worse than a list that took an extra
 * frame, and every item here is bounded by construction anyway.
 *
 * An EMPTY list yields one empty final chunk, not zero chunks. A client that
 * receives no chunk cannot tell "there is nothing" from "the chunks were lost".
 */
export function chunkByEncodedBytes<Item>(
  items: readonly Item[],
  maxBytes: number,
): readonly EncodedChunk<Item>[] {
  const chunks: EncodedChunk<Item>[] = [];
  let start = 0;
  let spent = 0;

  for (let index = 0; index < items.length; index += 1) {
    const cost = utf8ByteLength(JSON.stringify(items[index])) + 1;
    if (index > start && spent + cost > maxBytes) {
      chunks.push({
        fromIndex: start,
        items: items.slice(start, index),
        isFinal: false,
      });
      start = index;
      spent = 0;
    }
    spent += cost;
  }

  chunks.push({ fromIndex: start, items: items.slice(start), isFinal: true });
  return chunks;
}

/** A contiguous run of skeleton entries small enough to ship as one frame. */
export interface RowSkeletonChunkPlan {
  readonly fromOrdinal: number;
  readonly entries: readonly RowSkeletonEntry[];
  readonly isFinal: boolean;
}

/**
 * Splits a skeleton into frame-sized chunks.
 *
 * Shared rather than left to each producer, for the reason the whole design
 * rests on: the live host and the publisher must agree about ordinals, and a
 * chunker that disagreed about boundaries would be two producers disagreeing
 * about where `fromOrdinal` lands.
 *
 * An entry too large for a whole chunk still ships ALONE rather than being
 * dropped - a skeleton with a hole in it is a transcript that cannot be
 * navigated, and every entry is bounded by construction anyway
 * (`ROW_SKELETON_PREVIEW_MAX_CHARS` caps the only free-text field). This is the
 * opposite call from {@link sliceTranscriptTail}'s, and for the opposite
 * reason: a tail row the client can refetch is recoverable, a skeleton entry it
 * can never learn about is not.
 *
 * An EMPTY skeleton yields one empty final chunk, not zero chunks. A client
 * that receives no chunk at all cannot tell "this chat has no rows" from
 * "chunks were lost".
 */
export function chunkRowSkeleton(
  entries: readonly RowSkeletonEntry[],
  maxBytes: number,
): readonly RowSkeletonChunkPlan[] {
  return chunkByEncodedBytes(
    entries,
    Math.min(maxBytes, SKELETON_CHUNK_MAX_BYTES),
  ).map((chunk) => ({
    fromOrdinal: chunk.fromIndex,
    entries: chunk.items,
    isFinal: chunk.isFinal,
  }));
}

/**
 * Whether one frame's worth of index changes is small enough to send as one.
 *
 * Takes the whole ARRAY the frame carries, not a single change, because that is
 * the unit whose encoded size the relay threshold applies to - measuring the
 * members separately would pass a pair that individually fit and together did
 * not.
 *
 * The producer's fallback when this is `false` is **not** to split the delta -
 * it is to send `[{type: "reindexed"}]` and let the client re-request. That is
 * already the honest answer for anything that moves rows, and reusing it here
 * means the index-change path has exactly one oversized-delta behaviour instead
 * of a chunking protocol whose edge cases nobody would exercise often enough to
 * trust.
 *
 * Which is why the fallback array is exempt from the measurement: an answer
 * that could itself fail to fit is not an answer. The exemption is on an array
 * that is NOTHING BUT `reindexed` - the shape the fallback actually produces -
 * and deliberately not on any array that happens to contain one. Exempting the
 * latter would let `[{appended, 4000 entries}, {reindexed}]` skip the ceiling
 * altogether, which is the measurement being waived by the very member that
 * exists to make waiving unnecessary.
 */
export function indexChangeFits(
  changes: readonly ChatIndexChange[],
  maxBytes: number,
): boolean {
  const isFallback =
    changes.length > 0 &&
    changes.every((change) => change.type === "reindexed");
  if (isFallback) return true;
  return (
    utf8ByteLength(JSON.stringify(changes)) <
    Math.min(maxBytes, INDEX_CHANGE_MAX_BYTES)
  );
}

/**
 * The byte budget for one accumulated-change chunk.
 *
 * These summaries leave the snapshot for the same reason the skeleton never
 * joined it: their count is a property of the chat's HISTORY - one entry per
 * file ever touched - not of its current state. A broad refactor touches
 * thousands, and at ~200 encoded bytes each that is the whole frame budget
 * spent on a panel the user may never open.
 *
 * The other aux arrays stay inline deliberately, and the distinction is worth
 * stating because it is the rule for anything added later: `pendingApprovals`,
 * `queue`, `managedCommands` and `heldUpdates` scale with CONCURRENT state -
 * approvals in flight, shells alive, items queued - which is bounded by what a
 * user and an agent can hold open at once. History-scaled lists are chunked;
 * state-scaled lists ride the snapshot and are measured by
 * {@link windowedSnapshotFitsFrame}.
 */
export const ACCUMULATED_CHANGE_CHUNK_MAX_BYTES = 256 * 1024;

/**
 * A slice of the accumulated-change summaries.
 *
 * `isFinal` marks the last one, at which point the client's list must agree
 * with the snapshot's `accumulatedFileChangeCount`. A mismatch means chunks
 * were lost, and the panel re-requests rather than rendering a total that
 * silently under-counts the files it would revert.
 */
export const chatAccumulatedChangeChunkSchema = z.object({
  epoch: z.number().int().nonnegative(),
  /**
   * Which RE-STREAM this chunk belongs to. Incremented by the host every time
   * it starts the summary stream over, and unrelated to the transcript epoch.
   *
   * The client rebuilds from `fromIndex: 0` on every re-stream, so a chunk is
   * only ever an extension of chunks from its OWN generation. Without this the
   * client's only test is `fromIndex > assembled.length`, and the array it
   * measures is the PREVIOUS generation's - which the client deliberately
   * retains until a replacement chunk at index 0 arrives. Drop that first
   * chunk when an existing file changed without changing
   * `accumulatedFileChangeCount`, and the old array is still at the
   * authoritative length: a later chunk's `fromIndex` is not greater than it,
   * so it is accepted, and the panel ends up holding a prefix of the old set
   * spliced to a suffix of the new one. The stale digests then make every
   * content fetch return `stale`, and neither the gap check nor the
   * count-based watchdog has anything left to notice it with.
   */
  generation: z.number().int().nonnegative(),
  fromIndex: z.number().int().nonnegative(),
  summaries: z.array(chatAccumulatedFileChangeSummarySchema),
  isFinal: z.boolean(),
});
export type ChatAccumulatedChangeChunk = z.infer<
  typeof chatAccumulatedChangeChunkSchema
>;

/**
 * Whether a bounded snapshot actually fits the frame it claims to.
 *
 * The point is that it MEASURES. Every other frame on this line is budgeted by
 * code; the snapshot was budgeted by assertion, which is exactly what `maxBytes`
 * was before a cold review measured 4,378 small rows producing a 1,196,401-byte
 * frame. The history-scaled list is chunked out (see
 * {@link ACCUMULATED_CHANGE_CHUNK_MAX_BYTES}), so what remains is state-scaled -
 * bounded by what a user and an agent can hold open at once, which is a real
 * bound but not a provable one. This is how a producer checks rather than hopes.
 *
 * A producer that gets `false` cannot simply truncate: every field left inline
 * is something a renderer reads unconditionally. It must shed a `tail` row and
 * re-measure - the tail is the one inline field with a refetch path
 * (`loadRange`), which is why it is the one that yields.
 *
 * What is measured is the snapshot; what has to FIT is the encoded frame around
 * it, so the envelope is reserved rather than assumed away - see
 * {@link WINDOWED_SNAPSHOT_FRAME_OVERHEAD_BYTES}.
 */
export function windowedSnapshotFitsFrame(
  snapshot: unknown,
  maxBytes: number,
): boolean {
  return (
    utf8ByteLength(JSON.stringify(snapshot)) +
      WINDOWED_SNAPSHOT_FRAME_OVERHEAD_BYTES <
    Math.min(maxBytes, WINDOWED_SNAPSHOT_MAX_BYTES)
  );
}

export const chatLoadRangeRequestSchema = z.object({
  /**
   * Bounded, because it is the one envelope field a CLIENT chooses and the
   * host reserves a fixed number of bytes for the envelope when it budgets the
   * response (`TRANSCRIPT_RANGE_ENVELOPE_RESERVE_BYTES`). An unbounded
   * `requestId` would make that reserve a guess about a value the client
   * controls - i.e. a way for a client to push the frame past the relay
   * threshold from the outside. Bounded in BYTES via the charset, not merely
   * in code units - see {@link RANGE_REQUEST_ID_PATTERN}.
   */
  requestId: rangeRequestIdSchema,
  epoch: z.number().int().nonnegative(),
  fromOrdinal: z.number().int().nonnegative(),
  toOrdinal: z.number().int().nonnegative(),
  /**
   * The client's budget. The host CLAMPS this to
   * `TRANSCRIPT_RANGE_MAX_BYTES` - a client asking for 10 MiB is not a reason
   * to emit a 10 MiB frame. Positive rather than nonnegative because a zero
   * budget is a request that can only be answered by the always-serve-one
   * exception, which is a confusing thing to ask for deliberately.
   */
  maxBytes: z.number().int().positive(),
});
export type ChatLoadRangeRequest = z.infer<typeof chatLoadRangeRequestSchema>;
