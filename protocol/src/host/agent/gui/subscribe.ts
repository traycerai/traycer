/**
 * `chat.subscribe@1.3` - versioned streaming-RPC contract for a single
 * host-owned GUI chat session. `chat.subscribe@1.0`/`@1.1`/`@1.2` (frozen, near
 * the bottom of this file) are the exact shapes shipped in earlier hosts; later
 * minors only add to them, so a `1.3` app still bridges to hosts that only know
 * `1.0`/`1.1`/`1.2`. Streams have no cross-major downgrade bridge (see
 * `stream-compat.ts`'s `canBridgeStream()`), so once a method ships, its major
 * must never move again - only additive minors.
 *
 * This stream is intentionally text-frame-only. The existing `epic.subscribe`
 * stream remains responsible for Y.Doc binary updates; chat execution frames
 * carry typed snapshots, action acknowledgements, live turn deltas, queue
 * state, approval state, durable event appends, and concise error notices.
 */
import { commonRecordRegistry } from "@traycer/protocol/common/registry";
import { getRecordSchema } from "@traycer/protocol/framework/index";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  chatEventSchema,
  chatRunSettingsSchema,
  chatSchema,
  userMessagePayloadSchema,
  userMessageSchema,
  userMessageSenderSchema,
  type ChatRunSettings,
} from "@traycer/protocol/persistence/epic/schemas";
import {
  agentModeSchema,
  permissionModeSchema,
} from "@traycer/protocol/persistence/epic/foundation";
import {
  DEFAULT_ACCOUNT_CONTEXT,
  accountContextSchema,
} from "@traycer/protocol/common/schemas";
import {
  checkpointArtifactTagSchema,
  checkpointFileOperationSchema,
  restoreResultEntrySchema,
  restoreStartedManifestSchema,
} from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import {
  diffSourceSchema,
  fileEditReasonSchema,
} from "@traycer/protocol/persistence/epic/content-blocks";
import {
  chatQueueSteerModeSchema,
  runtimeApprovalDecisionSchema,
  runtimeEventSchema,
  runtimeEventSchemaV12,
  runtimeInterviewAnswerSchema,
  runtimePlanActionSchema,
} from "@traycer/protocol/host/agent/gui/agent-runtime";

export {
  chatQueueSteerModeSchema,
  type ChatQueueSteerMode,
} from "@traycer/protocol/host/agent/gui/agent-runtime";
import { z } from "zod";
import { guiHarnessIdSchema } from "@traycer/protocol/host/agent/shared";
import {
  worktreeBindingSchema,
  worktreeIntentSchema,
} from "@traycer/protocol/host/worktree-schemas";

const jsonContentSchema = getRecordSchema(
  commonRecordRegistry,
  "json-content",
  "latest",
);

const textFrameFields = {
  hasBinaryPayload: z.literal(false),
} as const;

const chatReferenceFields = {
  epicId: z.string(),
  chatId: z.string(),
} as const;

const ownerActionFrameFields = {
  ...textFrameFields,
  ...chatReferenceFields,
  clientActionId: z.string(),
} as const;

export const chatSubscribeOpenRequestSchema = z.object({
  epicId: z.string(),
  chatId: z.string(),
});
export type ChatSubscribeOpenRequest = z.infer<
  typeof chatSubscribeOpenRequestSchema
>;

export const chatActionSchema = z.enum([
  "send",
  "deleteMessageSuffix",
  "editUserMessage",
  "stop",
  "pauseQueue",
  "resumeQueue",
  "queueEdit",
  "queueCancel",
  "queueReorder",
  "queueSteerNow",
  "queueAbortSteer",
  "queueSettingsUpdate",
  "queueSettingsRestamp",
  "activePermissionModeUpdate",
  "approvalDecision",
  "fileEditApprovalDecision",
  "interviewAnswer",
  "interviewError",
  "restoreCheckpoint",
  "revertFileChanges",
  // Background-items controls for the v2 chat stream. The renderer still gates
  // sends on the host advertising `backgroundItems` in snapshots so test hosts
  // and unsupported providers remain inert.
  "stopBackgroundItem",
  "stopAllBackgroundItems",
]);
export type ChatAction = z.infer<typeof chatActionSchema>;

/**
 * One file in the chat-level **accumulated changes** view (the pinned panel
 * above the composer). Mirrors the `file_change` content block so the
 * renderer can reuse its diff components, but the `before`/`after` here are
 * cumulative: `beforeContent` is the snapshot captured the *first* time the
 * file was edited in the chat, `afterContent` is the file's *current* on-disk
 * content. Files whose current content equals their first snapshot are omitted
 * (already reverted / unchanged). `undoable` reflects whether that first
 * snapshot can be restored.
 */
export const chatAccumulatedFileChangeSchema = z.object({
  filePath: z.string(),
  operation: checkpointFileOperationSchema,
  diffSource: diffSourceSchema,
  beforeContent: z.string().nullable(),
  afterContent: z.string().nullable(),
  reason: fileEditReasonSchema,
  undoable: z.boolean(),
  // Present + non-null ⇒ this accumulated change is a Traycer artifact
  // `index.md`. The panel renders it as a titled artifact row (click → diff,
  // per-row undo) rather than a raw file path. Carried through from the manifest
  // entry's tag. Optional for the same reasons as the manifest entry's tag.
  artifact: checkpointArtifactTagSchema.nullish(),
});
export type ChatAccumulatedFileChange = z.infer<
  typeof chatAccumulatedFileChangeSchema
>;

/**
 * One currently-running background work item in this chat - a backgrounded
 * subagent, a `run_in_background` command, a Monitor, a scheduled wakeup, or
 * (from `chat.subscribe@1.3`) a workflow run. The host is the only
 * correctness source for the running set: it removes an item in the same update
 * cycle that finalizes the originating transcript card. Surfaced so the
 * renderer can list running items above the composer, scroll to / expand the
 * originating card, and stop them.
 *
 * `taskId` is the SDK task id - the stop handle and identity. `blockId` is the
 * rendered card's block id (a subagent's `blockId` equals its `taskId`; a
 * command/monitor's equals its originating `toolUseId`), used to scroll/expand.
 * Host-internal scheduling metadata such as tool-use id and start time must not
 * leak onto this wire contract.
 */
const backgroundItemBaseFields = {
  taskId: z.string(),
  title: z.string(),
  blockId: z.string(),
  // Parent task id for nested background items. Optional/defaulted so a
  // new-client parse of an old-host frame succeeds, while old clients strip it.
  parentTaskId: z.string().nullable().default(null),
} as const;

// ─── Frozen `chat.subscribe@1.2` background-item shapes (pre-`workflow`) ───
//
// Kept so frozen snapshot/turnStateChanged frame schemas parse only shapes a
// real 1.2 peer could produce. Do not add the 1.3-only `workflow` kind here -
// a 1.2 peer must never observe it.
export const backgroundItemKindSchemaV12 = z.enum([
  "subagent",
  "command",
  "monitor",
  "wakeup",
]);

const runningBackgroundItemKindSchema = z.enum([
  "subagent",
  "command",
  "monitor",
]);

const runningBackgroundItemSchema = z.object({
  ...backgroundItemBaseFields,
  kind: runningBackgroundItemKindSchema,
  // Epoch milliseconds when a wakeup item is scheduled to fire. Null for
  // ordinary background work and optional for old-host compatibility.
  scheduledFor: z.number().nullable().default(null),
});

const wakeupBackgroundItemSchema = z.object({
  ...backgroundItemBaseFields,
  kind: z.literal("wakeup"),
  // Wakeup items represent a concrete scheduled wake and must carry its due
  // timestamp. Parent metadata remains defaulted for old-host compatibility.
  scheduledFor: z.number(),
});

export const backgroundItemSchemaV12 = z.discriminatedUnion("kind", [
  runningBackgroundItemSchema,
  wakeupBackgroundItemSchema,
]);

// One currently-running WORKFLOW background item (`chat.subscribe@1.3`) - the
// aggregate view of a Workflow tool run, not a per-fleet-agent row (inner
// `agent()` calls have no individually addressable identity on the wire - see
// the detection findings). `phase`/`activeLabel` mirror the rotating
// `task_progress` line; `agentsStarted`/`agentsFinished` are fleet counts.
// All nullable-defaulted so a snapshot taken before any progress arrives still
// parses.
const workflowBackgroundItemSchema = z.object({
  ...backgroundItemBaseFields,
  kind: z.literal("workflow"),
  phase: z.string().nullable().default(null),
  activeLabel: z.string().nullable().default(null),
  agentsStarted: z.number().nullable().default(null),
  agentsFinished: z.number().nullable().default(null),
});

export const backgroundItemKindSchema = z.enum([
  ...backgroundItemKindSchemaV12.options,
  "workflow",
]);
export type BackgroundItemKind = z.infer<typeof backgroundItemKindSchema>;

export const backgroundItemSchema = z.discriminatedUnion("kind", [
  ...backgroundItemSchemaV12.def.options,
  workflowBackgroundItemSchema,
]);
export type BackgroundItem = z.infer<typeof backgroundItemSchema>;

export const chatActionAckStatusSchema = z.enum(["accepted", "rejected"]);
export type ChatActionAckStatus = z.infer<typeof chatActionAckStatusSchema>;

export { chatRunSettingsSchema };
export type { ChatRunSettings };

export const chatQueueDeliveryPolicySchema = z.enum([
  "auto",
  "after_safe_point",
  "after_turn",
]);
export type ChatQueueDeliveryPolicy = z.infer<
  typeof chatQueueDeliveryPolicySchema
>;

export const chatQueueItemDeliverySchema = z.enum(["same_turn", "next_turn"]);
export type ChatQueueItemDelivery = z.infer<typeof chatQueueItemDeliverySchema>;

export const chatQueueItemStatusSchema = z.enum([
  "pending",
  "steer_requested",
  "steering",
  "injected",
  "fallback",
  "paused",
]);
export type ChatQueueItemStatus = z.infer<typeof chatQueueItemStatusSchema>;

export const chatQueueSteerRequestSchema = z.object({
  mode: chatQueueSteerModeSchema,
  targetTurnId: z.string(),
  requestedAt: z.number(),
});
export type ChatQueueSteerRequest = z.infer<typeof chatQueueSteerRequestSchema>;

export const chatQueuedItemSchema = z.object({
  queueItemId: z.string(),
  messageId: z.string(),
  message: userMessagePayloadSchema,
  sender: userMessageSenderSchema,
  settings: chatRunSettingsSchema,
  // Billing/account context the queued turn runs under. Global app-wide
  // selection (not per-chat), captured from the send frame at queue time.
  // Defaulted PERSONAL so older queued items still parse.
  accountContext: accountContextSchema.default(DEFAULT_ACCOUNT_CONTEXT),
  delivery: chatQueueItemDeliverySchema.default("next_turn"),
  status: chatQueueItemStatusSchema.default("pending"),
  targetTurnId: z.string().nullable().default(null),
  steerRequest: chatQueueSteerRequestSchema.nullable().default(null),
  fallbackReason: z.string().nullable().default(null),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ChatQueuedItem = z.infer<typeof chatQueuedItemSchema>;

export const chatQueueStateSchema = z.object({
  status: z.enum(["idle", "running", "paused"]),
  items: z.array(chatQueuedItemSchema),
});
export type ChatQueueState = z.infer<typeof chatQueueStateSchema>;

/**
 * Authoritative chat-level run state, owned by the host and the single source
 * the GUI reads for the in-progress indicator (assistant response row, composer
 * stop affordance, sidebar/tab marker). Unlike the per-turn `activeTurn` - which
 * is null between turns and only set once a turn is built - `runStatus` flips to
 * `running` the instant a turn is requested (before harness/worktree setup) and
 * to `stopping` the instant stop is pressed, so the UI always reflects what the
 * chat is actually doing across the first turn and every multi-turn send.
 */
export const chatRunStatusSchema = z.enum(["idle", "running", "stopping"]);
export type ChatRunStatus = z.infer<typeof chatRunStatusSchema>;

export const chatActiveTurnSchema = z.object({
  turnId: z.string(),
  status: z.enum([
    "starting",
    "running",
    "stopping",
    "completed",
    "stopped",
    "interrupted",
    "errored",
  ]),
  harnessId: guiHarnessIdSchema,
  model: z.string().min(1),
  // Reasoning effort + service tier the active turn is running with, mirrored
  // from its `ChatRunSettings` so the GUI can surface them per turn. `null`
  // when the harness/model exposes no such control (or uses the default tier).
  reasoningEffort: z.string().nullable().default(null),
  serviceTier: z.string().nullable().default(null),
  // agentMode the turn started under, mirrored from its `ChatRunSettings` so the
  // GUI can detect an epic<->regular change against the live toolbar. Defaults to
  // "regular" so turns persisted before this field was added still parse.
  agentMode: agentModeSchema.default("regular"),
  userMessageId: z.string().nullable(),
  startedAt: z.number(),
  updatedAt: z.number(),
});
export type ChatActiveTurn = z.infer<typeof chatActiveTurnSchema>;

export const chatApprovalStateSchema = z.object({
  approvalId: z.string(),
  toolName: z.string(),
  description: z.string(),
  input: z.unknown().nullable(),
  requestedAt: z.number(),
  kind: z.enum(["tool", "plan"]).default("tool"),
  planId: z.string().nullable().default(null),
  actions: z.array(runtimePlanActionSchema).default([]),
});
export type ChatApprovalState = z.infer<typeof chatApprovalStateSchema>;

export const chatFileEditApprovalStateSchema = z.object({
  approvalId: z.string(),
  toolName: z.string(),
  description: z.string(),
  paths: z.array(z.string()),
  operation: checkpointFileOperationSchema,
  input: z.unknown().nullable(),
  requestedAt: z.number(),
});
export type ChatFileEditApprovalState = z.infer<
  typeof chatFileEditApprovalStateSchema
>;

export const chatPendingInterviewStateSchema = z.object({
  blockId: z.string(),
  requestedAt: z.number(),
});
export type ChatPendingInterviewState = z.infer<
  typeof chatPendingInterviewStateSchema
>;

export const chatAccessSchema = z.object({
  role: z.enum(["owner", "viewer"]),
  ownerUserId: z.string(),
  canAct: z.boolean(),
});
export type ChatAccess = z.infer<typeof chatAccessSchema>;

export const chatSnapshotSchema = z.object({
  chat: chatSchema,
  access: chatAccessSchema,
  queue: chatQueueStateSchema,
  // Authoritative in-progress state (see `chatRunStatusSchema`). The GUI's
  // in-progress indicators read this, not `activeTurn`.
  runStatus: chatRunStatusSchema,
  activeTurn: chatActiveTurnSchema.nullable(),
  pendingApprovals: z.array(chatApprovalStateSchema),
  pendingInterviews: z.array(chatPendingInterviewStateSchema),
  // Local-only worktree binding projected from host SQLite at subscribe
  // time. `null` means the binding has not been decided for this owner yet.
  // Not part of the cloud-synced chat record - see worktree-schemas.ts.
  worktreeBinding: worktreeBindingSchema.nullable(),
  // Computed, ephemeral disk-truth: the `workspacePath` of every binding entry
  // whose effective directory (`worktreePath ?? workspacePath`) is missing on
  // disk, recomputed host-side whenever the binding changes. Drives the
  // composer's missing-worktree error + send gate. `[]` when the binding is null
  // or every bound directory exists. Never persisted - see worktree-schemas.ts.
  missingWorktreePaths: z.array(z.string()),
  pendingFileEditApprovals: z.array(chatFileEditApprovalStateSchema),
  // Cumulative file changes for the whole chat (first-snapshot → current),
  // computed host-side from checkpoint manifests + current disk content.
  // Drives the pinned accumulated-changes panel above the composer.
  accumulatedFileChanges: z.array(chatAccumulatedFileChangeSchema),
  // In-flight background work (backgrounded subagents, run_in_background
  // commands, Monitors). OPTIONAL on purpose: `undefined` means this host/session
  // does not expose background-item controls, so the renderer hides the
  // Background section and never sends stop actions; a present (possibly empty)
  // array means the controls are supported. This is the capability sentinel.
  backgroundItems: z.array(backgroundItemSchema).optional(),
  // Whether the host considers a turn genuinely active or activating right
  // now - exactly its own `isTurnInProgress()` (backs `stop`'s
  // `NO_ACTIVE_TURN` rejection). Narrower than `runStatus !== "idle"`, which
  // also reads "running" while a queued item is pending or visible
  // background work outlives the turn - neither of which corresponds to an
  // active turn. Consumers that need "is there a turn to stop/attribute an
  // indicator to/block a restore against" should read this, not derive it
  // from `runStatus`. OPTIONAL for the same rolling-update reason as
  // `backgroundItems`: an older host omits it, and the renderer falls back to
  // its own `runStatus`/`activeTurn`/`queue`/`backgroundItems`-derived
  // approximation (see `chat-tile-session-state.ts`) rather than treating a
  // missing value as either "always active" or "never active" - both would
  // be wrong for the whole session against an older host.
  turnInProgress: z.boolean().optional(),
});
export type ChatSnapshot = z.infer<typeof chatSnapshotSchema>;

export const chatErrorNoticeSchema = z.object({
  code: z.string(),
  message: z.string(),
  severity: z.enum(["info", "warning", "error"]),
  clientActionId: z.string().nullable(),
});
export type ChatErrorNotice = z.infer<typeof chatErrorNoticeSchema>;

const chatSubscribeSnapshotServerFrameSchema = z.object({
  kind: z.literal("snapshot"),
  ...textFrameFields,
  ...chatReferenceFields,
  snapshot: chatSnapshotSchema,
});

const chatSubscribeTurnStateChangedServerFrameSchema = z.object({
  kind: z.literal("turnStateChanged"),
  ...textFrameFields,
  ...chatReferenceFields,
  // `runStatus` rides every turn-state broadcast so the GUI's in-progress
  // indicator updates the instant a turn is requested, stops, or completes -
  // including the request→activeTurn window where `activeTurn` is still null.
  runStatus: chatRunStatusSchema,
  activeTurn: chatActiveTurnSchema.nullable(),
  // Background-items deltas ride this same broadcast (added/settled/stopped).
  // Optional for the same capability-sentinel reason as the snapshot field; an
  // older host omits it and the renderer keeps its last snapshot value.
  backgroundItems: z.array(backgroundItemSchema).optional(),
  // See `chatSnapshotSchema.turnInProgress` - same predicate, same
  // optionality, same conservative-fallback contract.
  turnInProgress: z.boolean().optional(),
});

// `blockDelta`'s `event` schema is the one shared-frame shape that changes
// incompatibly across `chat.subscribe` minors (`runtimeEventSchema` gained
// `workflow.*` in `1.3`), so it is versioned separately from the rest of the
// shared frames via this factory - see `chatSubscribeSharedServerFrameSchemasV12`
// (frozen) vs `chatSubscribeSharedServerFrameSchemas` (live) below.
function blockDeltaServerFrameSchema<EventSchema extends z.ZodType>(
  eventSchema: EventSchema,
) {
  return z.object({
    kind: z.literal("blockDelta"),
    ...textFrameFields,
    ...chatReferenceFields,
    event: eventSchema,
  });
}

const chatSubscribeCommonServerFrameSchemas = [
  z.object({
    kind: z.literal("actionAck"),
    ...textFrameFields,
    ...chatReferenceFields,
    clientActionId: z.string(),
    action: chatActionSchema,
    status: chatActionAckStatusSchema,
    reason: z.string().nullable(),
    code: z.string().nullable(),
    // For background stop-all, task ids whose provider stop request was accepted
    // even when the aggregate action is rejected for partial failure. Defaulted
    // so a `chat.subscribe@1.0` host (no background-items support) still
    // parses - it never emits a background-stop ack, so `[]` is the correct
    // reading, not a lossy fallback.
    backgroundStopTaskIds: z.array(z.string()).default([]),
  }),
  z.object({
    kind: z.literal("messageAccepted"),
    ...textFrameFields,
    ...chatReferenceFields,
    message: userMessageSchema,
  }),
  z.object({
    kind: z.literal("queueChanged"),
    ...textFrameFields,
    ...chatReferenceFields,
    queue: chatQueueStateSchema,
  }),
  z.object({
    kind: z.literal("approvalRequested"),
    ...textFrameFields,
    ...chatReferenceFields,
    approval: chatApprovalStateSchema,
  }),
  z.object({
    kind: z.literal("approvalResolved"),
    ...textFrameFields,
    ...chatReferenceFields,
    approvalId: z.string(),
    decision: runtimeApprovalDecisionSchema,
    resolvedAt: z.number(),
  }),
  z.object({
    kind: z.literal("fileEditApprovalRequested"),
    ...textFrameFields,
    ...chatReferenceFields,
    approval: chatFileEditApprovalStateSchema,
  }),
  z.object({
    kind: z.literal("fileEditApprovalResolved"),
    ...textFrameFields,
    ...chatReferenceFields,
    approvalId: z.string(),
    decision: runtimeApprovalDecisionSchema,
    resolvedAt: z.number(),
  }),
  z.object({
    kind: z.literal("interviewRequested"),
    ...textFrameFields,
    ...chatReferenceFields,
    blockId: z.string(),
    requestedAt: z.number(),
  }),
  z.object({
    kind: z.literal("interviewAnswered"),
    ...textFrameFields,
    ...chatReferenceFields,
    blockId: z.string(),
    answers: z.array(runtimeInterviewAnswerSchema),
    resolvedAt: z.number(),
  }),
  z.object({
    kind: z.literal("interviewErrored"),
    ...textFrameFields,
    ...chatReferenceFields,
    blockId: z.string(),
    reason: z.string(),
    resolvedAt: z.number(),
  }),
  z.object({
    kind: z.literal("eventAppended"),
    ...textFrameFields,
    ...chatReferenceFields,
    event: chatEventSchema,
  }),
  z.object({
    kind: z.literal("restoreStarted"),
    ...textFrameFields,
    ...chatReferenceFields,
    ...restoreStartedManifestSchema.shape,
  }),
  z.object({
    kind: z.literal("restoreProgress"),
    ...textFrameFields,
    ...chatReferenceFields,
    checkpointId: z.string(),
    processedCount: z.number(),
    totalCount: z.number(),
  }),
  z.object({
    kind: z.literal("restoreCompleted"),
    ...textFrameFields,
    ...chatReferenceFields,
    checkpointId: z.string(),
    finishedAt: z.number(),
    results: z.array(restoreResultEntrySchema),
  }),
  z.object({
    kind: z.literal("errorNotice"),
    ...textFrameFields,
    ...chatReferenceFields,
    notice: chatErrorNoticeSchema,
  }),
  z.object({
    kind: z.literal("worktreeStateChanged"),
    ...textFrameFields,
    ...chatReferenceFields,
    worktreeBinding: worktreeBindingSchema.nullable(),
    // Recomputed alongside `worktreeBinding` (see chatSnapshotSchema) so the
    // composer's missing-worktree gate updates reactively on every binding edit.
    missingWorktreePaths: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("pong"),
    ...textFrameFields,
  }),
];

// Frozen for `chat.subscribe@1.2` and earlier.
const chatSubscribeSharedServerFrameSchemasV12 = [
  ...chatSubscribeCommonServerFrameSchemas,
  blockDeltaServerFrameSchema(runtimeEventSchemaV12),
];

const chatSubscribeSharedServerFrameSchemas = [
  ...chatSubscribeCommonServerFrameSchemas,
  blockDeltaServerFrameSchema(runtimeEventSchema),
];

export const chatSubscribeServerFrameSchema = z.discriminatedUnion("kind", [
  chatSubscribeSnapshotServerFrameSchema,
  chatSubscribeTurnStateChangedServerFrameSchema,
  ...chatSubscribeSharedServerFrameSchemas,
]);
export type ChatSubscribeServerFrame = z.infer<
  typeof chatSubscribeServerFrameSchema
>;

const pauseQueueClientFrameSchema = z.object({
  kind: z.literal("pauseQueue"),
  ...ownerActionFrameFields,
});

const chatSubscribeClientFrameSchemaBeforeV13Options = [
  z.object({
    kind: z.literal("send"),
    ...ownerActionFrameFields,
    messageId: z.string(),
    content: jsonContentSchema,
    sender: userMessageSenderSchema,
    settings: chatRunSettingsSchema,
    // Billing/account context the turn runs under (Personal vs a specific
    // Team). Global app-wide selection (not per-chat), stamped onto the frame
    // at send time.
    accountContext: accountContextSchema,
    deliveryPolicy: chatQueueDeliveryPolicySchema.default("auto"),
    // A worktree staged in the composer (mid-chat "Create new worktree")
    // rides with the send so the host creates it at turn-start before
    // gating on setup - mirroring how the landing page bundles the intent
    // with `epic.create`. `null` for an ordinary send.
    worktreeIntent: worktreeIntentSchema.nullable().default(null),
  }),
  z.object({
    kind: z.literal("deleteMessageSuffix"),
    ...ownerActionFrameFields,
    fromMessageId: z.string(),
  }),
  z.object({
    kind: z.literal("editUserMessage"),
    ...ownerActionFrameFields,
    targetMessageId: z.string(),
    messageId: z.string(),
    content: jsonContentSchema,
    sender: userMessageSenderSchema,
    settings: chatRunSettingsSchema,
    // Billing/account context the turn runs under. Global app-wide selection
    // (not per-chat), stamped onto the frame at send time.
    accountContext: accountContextSchema,
    // When true, revert all file changes made by the edited message's turn
    // and every turn after it (cumulative, to the state before this message)
    // before trimming history and starting the new turn. Set by the
    // "Submit from a previous message?" modal's Revert action.
    revertFileChanges: z.boolean(),
    // When reverting (above), also revert the artifact changes in scope. The
    // revert dialog's checked-by-default "Also revert N artifacts" checkbox
    // sets this; unchecking leaves artifacts untouched. Defaulted true so
    // pre-existing clients keep reverting artifacts alongside files.
    revertArtifacts: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal("stop"),
    ...ownerActionFrameFields,
    turnId: z.string().nullable(),
  }),
  // Stop a single background item (subagent/command/monitor) by its SDK task id,
  // WITHOUT aborting the foreground turn (unlike `stop`). The host calls
  // `query.stopTask(taskId)`; the SDK emits a `stopped` notification that
  // finalizes the card. Renderer gates sending on snapshot `backgroundItems`.
  z.object({
    kind: z.literal("stopBackgroundItem"),
    ...ownerActionFrameFields,
    taskId: z.string(),
  }),
  // Stop every in-flight background item in this chat (the section's "Stop all").
  z.object({
    kind: z.literal("stopAllBackgroundItems"),
    ...ownerActionFrameFields,
  }),
  z.object({
    kind: z.literal("resumeQueue"),
    ...ownerActionFrameFields,
  }),
  z.object({
    kind: z.literal("queueEdit"),
    ...ownerActionFrameFields,
    queueItemId: z.string(),
    content: jsonContentSchema,
  }),
  z.object({
    kind: z.literal("queueCancel"),
    ...ownerActionFrameFields,
    queueItemId: z.string(),
  }),
  z.object({
    kind: z.literal("queueReorder"),
    ...ownerActionFrameFields,
    queueItemId: z.string(),
    beforeQueueItemId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("queueSteerNow"),
    ...ownerActionFrameFields,
    queueItemId: z.string(),
    // Settings to apply when steering forces an interrupt_restart (the live
    // toolbar differs from the running turn on a turn-start-baked setting:
    // model / reasoningEffort / serviceTier / agentMode). null = no override:
    // a silent safe_point inject that keeps the running turn's settings.
    newSettings: chatRunSettingsSchema.nullable().default(null),
  }),
  z.object({
    // Abort a steer that is still `steer_requested` (the harness has not begun
    // folding it into the running turn): the item reverts to a plain pending
    // queue item. Rejected once the steer advances to `steering`/`injected`.
    kind: z.literal("queueAbortSteer"),
    ...ownerActionFrameFields,
    queueItemId: z.string(),
  }),
  z.object({
    kind: z.literal("queueSettingsUpdate"),
    ...ownerActionFrameFields,
    queueItemId: z.string(),
    settings: chatRunSettingsSchema,
    // Billing/account context the turn runs under. Global app-wide selection
    // (not per-chat), stamped onto the frame at send time.
    accountContext: accountContextSchema,
  }),
  z.object({
    kind: z.literal("queueSettingsRestamp"),
    ...ownerActionFrameFields,
    settings: chatRunSettingsSchema,
    // Billing/account context the turn runs under. Global app-wide selection
    // (not per-chat), stamped onto the frame at send time.
    accountContext: accountContextSchema,
    excludeQueueItemId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("activePermissionModeUpdate"),
    ...ownerActionFrameFields,
    permissionMode: permissionModeSchema,
  }),
  z.object({
    kind: z.literal("approvalDecision"),
    ...ownerActionFrameFields,
    approvalId: z.string(),
    decision: runtimeApprovalDecisionSchema,
  }),
  z.object({
    kind: z.literal("fileEditApprovalDecision"),
    ...ownerActionFrameFields,
    approvalId: z.string(),
    decision: runtimeApprovalDecisionSchema,
  }),
  z.object({
    kind: z.literal("interviewAnswer"),
    ...ownerActionFrameFields,
    blockId: z.string(),
    answers: z.array(runtimeInterviewAnswerSchema),
  }),
  z.object({
    kind: z.literal("interviewError"),
    ...ownerActionFrameFields,
    blockId: z.string(),
    reason: z.string(),
  }),
  z.object({
    kind: z.literal("restoreCheckpoint"),
    ...ownerActionFrameFields,
    checkpointId: z.string(),
    // When false, the turn's artifact changes are excluded from the restore
    // (the "Also revert N artifacts" opt-out, checked by default). Defaulted
    // true so pre-existing clients keep restoring artifacts with the turn.
    revertArtifacts: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal("revertFileChanges"),
    ...ownerActionFrameFields,
    // null = revert from the start of the chat (whole-chat scope). Otherwise
    // revert the turn triggered by this message and every turn after it.
    fromMessageId: z.string().nullable(),
    // null = every file in scope. Otherwise restrict the revert to these
    // paths (used by the panel's per-file Undo).
    filePaths: z.array(z.string()).nullable(),
    // When false, artifact changes are excluded from the revert (the bulk
    // "Also revert N artifacts" opt-out). A per-row artifact Undo passes the
    // artifact path in `filePaths` with this true. Defaulted true.
    revertArtifacts: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal("ping"),
    ...textFrameFields,
  }),
] as const;

export const chatSubscribeClientFrameSchemaBeforeV13 = z.discriminatedUnion(
  "kind",
  chatSubscribeClientFrameSchemaBeforeV13Options,
);

const chatSubscribeClientFrameSchemaOptions = [
  ...chatSubscribeClientFrameSchemaBeforeV13Options,
  pauseQueueClientFrameSchema,
] as const;

export const chatSubscribeClientFrameSchema = z.discriminatedUnion(
  "kind",
  chatSubscribeClientFrameSchemaOptions,
);
export type ChatSubscribeClientFrame = z.infer<
  typeof chatSubscribeClientFrameSchema
>;

// ─── Frozen `chat.subscribe@1.0` shape (host-v1.0.0, as shipped) ──────────
//
// Sourced verbatim from `release-v1.0.0` and kept registered (never edited)
// so `chatSubscribeV10` below stays an honest record of what that host
// actually speaks - `canBridgeStream()` needs the `{1,0}` line to be present
// in the registry to bridge a `1.1` app down to it. Do not add fields or
// variants here; extend the live schemas above instead.

const chatActionSchemaV10 = z.enum([
  "send",
  "deleteMessageSuffix",
  "editUserMessage",
  "stop",
  "resumeQueue",
  "queueEdit",
  "queueCancel",
  "queueReorder",
  "queueSteerNow",
  "queueAbortSteer",
  "queueSettingsUpdate",
  "queueSettingsRestamp",
  "activePermissionModeUpdate",
  "approvalDecision",
  "fileEditApprovalDecision",
  "interviewAnswer",
  "interviewError",
  "restoreCheckpoint",
  "revertFileChanges",
]);

const chatSubscribeOpenRequestSchemaV10 = z.object({
  epicId: z.string(),
  chatId: z.string(),
});

// Pinned field-for-field, not derived via `.omit()` from `chatSnapshotSchema`
// - a later required field added to the live schema must not silently leak
// into this frozen contract.
const chatSnapshotSchemaV10 = z.object({
  chat: chatSchema,
  access: chatAccessSchema,
  queue: chatQueueStateSchema,
  runStatus: chatRunStatusSchema,
  activeTurn: chatActiveTurnSchema.nullable(),
  pendingApprovals: z.array(chatApprovalStateSchema),
  pendingInterviews: z.array(chatPendingInterviewStateSchema),
  worktreeBinding: worktreeBindingSchema.nullable(),
  missingWorktreePaths: z.array(z.string()),
  pendingFileEditApprovals: z.array(chatFileEditApprovalStateSchema),
  accumulatedFileChanges: z.array(chatAccumulatedFileChangeSchema),
});

const chatSubscribeServerFrameSchemaV10 = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("snapshot"),
    ...textFrameFields,
    ...chatReferenceFields,
    snapshot: chatSnapshotSchemaV10,
  }),
  z.object({
    kind: z.literal("actionAck"),
    ...textFrameFields,
    ...chatReferenceFields,
    clientActionId: z.string(),
    action: chatActionSchemaV10,
    status: chatActionAckStatusSchema,
    reason: z.string().nullable(),
    code: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("messageAccepted"),
    ...textFrameFields,
    ...chatReferenceFields,
    message: userMessageSchema,
  }),
  z.object({
    kind: z.literal("queueChanged"),
    ...textFrameFields,
    ...chatReferenceFields,
    queue: chatQueueStateSchema,
  }),
  z.object({
    kind: z.literal("turnStateChanged"),
    ...textFrameFields,
    ...chatReferenceFields,
    runStatus: chatRunStatusSchema,
    activeTurn: chatActiveTurnSchema.nullable(),
  }),
  z.object({
    kind: z.literal("blockDelta"),
    ...textFrameFields,
    ...chatReferenceFields,
    event: runtimeEventSchema,
  }),
  z.object({
    kind: z.literal("approvalRequested"),
    ...textFrameFields,
    ...chatReferenceFields,
    approval: chatApprovalStateSchema,
  }),
  z.object({
    kind: z.literal("approvalResolved"),
    ...textFrameFields,
    ...chatReferenceFields,
    approvalId: z.string(),
    decision: runtimeApprovalDecisionSchema,
    resolvedAt: z.number(),
  }),
  z.object({
    kind: z.literal("fileEditApprovalRequested"),
    ...textFrameFields,
    ...chatReferenceFields,
    approval: chatFileEditApprovalStateSchema,
  }),
  z.object({
    kind: z.literal("fileEditApprovalResolved"),
    ...textFrameFields,
    ...chatReferenceFields,
    approvalId: z.string(),
    decision: runtimeApprovalDecisionSchema,
    resolvedAt: z.number(),
  }),
  z.object({
    kind: z.literal("interviewRequested"),
    ...textFrameFields,
    ...chatReferenceFields,
    blockId: z.string(),
    requestedAt: z.number(),
  }),
  z.object({
    kind: z.literal("interviewAnswered"),
    ...textFrameFields,
    ...chatReferenceFields,
    blockId: z.string(),
    answers: z.array(runtimeInterviewAnswerSchema),
    resolvedAt: z.number(),
  }),
  z.object({
    kind: z.literal("interviewErrored"),
    ...textFrameFields,
    ...chatReferenceFields,
    blockId: z.string(),
    reason: z.string(),
    resolvedAt: z.number(),
  }),
  z.object({
    kind: z.literal("eventAppended"),
    ...textFrameFields,
    ...chatReferenceFields,
    event: chatEventSchema,
  }),
  z.object({
    kind: z.literal("restoreStarted"),
    ...textFrameFields,
    ...chatReferenceFields,
    ...restoreStartedManifestSchema.shape,
  }),
  z.object({
    kind: z.literal("restoreProgress"),
    ...textFrameFields,
    ...chatReferenceFields,
    checkpointId: z.string(),
    processedCount: z.number(),
    totalCount: z.number(),
  }),
  z.object({
    kind: z.literal("restoreCompleted"),
    ...textFrameFields,
    ...chatReferenceFields,
    checkpointId: z.string(),
    finishedAt: z.number(),
    results: z.array(restoreResultEntrySchema),
  }),
  z.object({
    kind: z.literal("errorNotice"),
    ...textFrameFields,
    ...chatReferenceFields,
    notice: chatErrorNoticeSchema,
  }),
  z.object({
    kind: z.literal("worktreeStateChanged"),
    ...textFrameFields,
    ...chatReferenceFields,
    worktreeBinding: worktreeBindingSchema.nullable(),
    missingWorktreePaths: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("pong"),
    ...textFrameFields,
  }),
]);

const chatSubscribeClientFrameSchemaV10 = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("send"),
    ...ownerActionFrameFields,
    messageId: z.string(),
    content: jsonContentSchema,
    sender: userMessageSenderSchema,
    settings: chatRunSettingsSchema,
    accountContext: accountContextSchema,
    deliveryPolicy: chatQueueDeliveryPolicySchema.default("auto"),
    worktreeIntent: worktreeIntentSchema.nullable().default(null),
  }),
  z.object({
    kind: z.literal("deleteMessageSuffix"),
    ...ownerActionFrameFields,
    fromMessageId: z.string(),
  }),
  z.object({
    kind: z.literal("editUserMessage"),
    ...ownerActionFrameFields,
    targetMessageId: z.string(),
    messageId: z.string(),
    content: jsonContentSchema,
    sender: userMessageSenderSchema,
    settings: chatRunSettingsSchema,
    accountContext: accountContextSchema,
    revertFileChanges: z.boolean(),
    revertArtifacts: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal("stop"),
    ...ownerActionFrameFields,
    turnId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("resumeQueue"),
    ...ownerActionFrameFields,
  }),
  z.object({
    kind: z.literal("queueEdit"),
    ...ownerActionFrameFields,
    queueItemId: z.string(),
    content: jsonContentSchema,
  }),
  z.object({
    kind: z.literal("queueCancel"),
    ...ownerActionFrameFields,
    queueItemId: z.string(),
  }),
  z.object({
    kind: z.literal("queueReorder"),
    ...ownerActionFrameFields,
    queueItemId: z.string(),
    beforeQueueItemId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("queueSteerNow"),
    ...ownerActionFrameFields,
    queueItemId: z.string(),
    newSettings: chatRunSettingsSchema.nullable().default(null),
  }),
  z.object({
    kind: z.literal("queueAbortSteer"),
    ...ownerActionFrameFields,
    queueItemId: z.string(),
  }),
  z.object({
    kind: z.literal("queueSettingsUpdate"),
    ...ownerActionFrameFields,
    queueItemId: z.string(),
    settings: chatRunSettingsSchema,
    accountContext: accountContextSchema,
  }),
  z.object({
    kind: z.literal("queueSettingsRestamp"),
    ...ownerActionFrameFields,
    settings: chatRunSettingsSchema,
    accountContext: accountContextSchema,
    excludeQueueItemId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("activePermissionModeUpdate"),
    ...ownerActionFrameFields,
    permissionMode: permissionModeSchema,
  }),
  z.object({
    kind: z.literal("approvalDecision"),
    ...ownerActionFrameFields,
    approvalId: z.string(),
    decision: runtimeApprovalDecisionSchema,
  }),
  z.object({
    kind: z.literal("fileEditApprovalDecision"),
    ...ownerActionFrameFields,
    approvalId: z.string(),
    decision: runtimeApprovalDecisionSchema,
  }),
  z.object({
    kind: z.literal("interviewAnswer"),
    ...ownerActionFrameFields,
    blockId: z.string(),
    answers: z.array(runtimeInterviewAnswerSchema),
  }),
  z.object({
    kind: z.literal("interviewError"),
    ...ownerActionFrameFields,
    blockId: z.string(),
    reason: z.string(),
  }),
  z.object({
    kind: z.literal("restoreCheckpoint"),
    ...ownerActionFrameFields,
    checkpointId: z.string(),
    revertArtifacts: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal("revertFileChanges"),
    ...ownerActionFrameFields,
    fromMessageId: z.string().nullable(),
    filePaths: z.array(z.string()).nullable(),
    revertArtifacts: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal("ping"),
    ...textFrameFields,
  }),
]);

export const chatSubscribeV10 = defineStreamRpcContract({
  method: "chat.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: chatSubscribeOpenRequestSchemaV10,
  serverFrameSchema: chatSubscribeServerFrameSchemaV10,
  clientFrameSchema: chatSubscribeClientFrameSchemaV10,
});

// ─── Frozen `chat.subscribe@1.1` shape (background-items controls) ──────────
//
// Kept registered so `chat.subscribe@1.2` clients can still bridge to a host
// that only advertises `1.1`. Do not add the 1.2-only wakeup enum or metadata
// fields here; old 1.1 peers must never receive those values on this line.

const backgroundItemKindSchemaV11 = z.enum(["subagent", "command", "monitor"]);

const backgroundItemSchemaV11 = z.object({
  taskId: z.string(),
  kind: backgroundItemKindSchemaV11,
  title: z.string(),
  blockId: z.string(),
});

const chatSnapshotSchemaV11 = z.object({
  chat: chatSchema,
  access: chatAccessSchema,
  queue: chatQueueStateSchema,
  runStatus: chatRunStatusSchema,
  activeTurn: chatActiveTurnSchema.nullable(),
  pendingApprovals: z.array(chatApprovalStateSchema),
  pendingInterviews: z.array(chatPendingInterviewStateSchema),
  worktreeBinding: worktreeBindingSchema.nullable(),
  missingWorktreePaths: z.array(z.string()),
  pendingFileEditApprovals: z.array(chatFileEditApprovalStateSchema),
  accumulatedFileChanges: z.array(chatAccumulatedFileChangeSchema),
  backgroundItems: z.array(backgroundItemSchemaV11).optional(),
  turnInProgress: z.boolean().optional(),
});

const chatSubscribeSnapshotServerFrameSchemaV11 = z.object({
  kind: z.literal("snapshot"),
  ...textFrameFields,
  ...chatReferenceFields,
  snapshot: chatSnapshotSchemaV11,
});

const chatSubscribeTurnStateChangedServerFrameSchemaV11 = z.object({
  kind: z.literal("turnStateChanged"),
  ...textFrameFields,
  ...chatReferenceFields,
  runStatus: chatRunStatusSchema,
  activeTurn: chatActiveTurnSchema.nullable(),
  backgroundItems: z.array(backgroundItemSchemaV11).optional(),
  turnInProgress: z.boolean().optional(),
});

// `1.1`'s shared frames are pinned to the frozen `1.2` set (not the live one)
// so this frozen contract can never silently absorb a construct added on a
// later minor - see `chatSubscribeSharedServerFrameSchemasV12` above. This is
// a pure pin, not a behavior change: until `1.3` added `workflow.*`, the live
// and frozen sets were byte-identical.
const chatSubscribeServerFrameSchemaV11 = z.discriminatedUnion("kind", [
  chatSubscribeSnapshotServerFrameSchemaV11,
  chatSubscribeTurnStateChangedServerFrameSchemaV11,
  ...chatSubscribeSharedServerFrameSchemasV12,
]);

export const chatSubscribeV11 = defineStreamRpcContract({
  method: "chat.subscribe",
  schemaVersion: { major: 1, minor: 1 } as const,
  openRequestSchema: chatSubscribeOpenRequestSchema,
  serverFrameSchema: chatSubscribeServerFrameSchemaV11,
  clientFrameSchema: chatSubscribeClientFrameSchemaBeforeV13,
});

// ─── Frozen `chat.subscribe@1.2` shape (host-v1.1.4, as shipped) ──────────
//
// Kept so `chat.subscribe@1.3` clients can still bridge to a host that only
// advertises `1.2`, and so the in-repo `1.2` contract tests can't silently
// absorb a `1.3`-only construct (`pauseQueue` client frames, `workflow`
// background items, `workflow.*` blockDelta events). Do not add post-1.2
// fields or variants here.
const chatSnapshotSchemaV12 = z.object({
  chat: chatSchema,
  access: chatAccessSchema,
  queue: chatQueueStateSchema,
  runStatus: chatRunStatusSchema,
  activeTurn: chatActiveTurnSchema.nullable(),
  pendingApprovals: z.array(chatApprovalStateSchema),
  pendingInterviews: z.array(chatPendingInterviewStateSchema),
  worktreeBinding: worktreeBindingSchema.nullable(),
  missingWorktreePaths: z.array(z.string()),
  pendingFileEditApprovals: z.array(chatFileEditApprovalStateSchema),
  accumulatedFileChanges: z.array(chatAccumulatedFileChangeSchema),
  backgroundItems: z.array(backgroundItemSchemaV12).optional(),
  turnInProgress: z.boolean().optional(),
});

const chatSubscribeSnapshotServerFrameSchemaV12 = z.object({
  kind: z.literal("snapshot"),
  ...textFrameFields,
  ...chatReferenceFields,
  snapshot: chatSnapshotSchemaV12,
});

const chatSubscribeTurnStateChangedServerFrameSchemaV12 = z.object({
  kind: z.literal("turnStateChanged"),
  ...textFrameFields,
  ...chatReferenceFields,
  runStatus: chatRunStatusSchema,
  activeTurn: chatActiveTurnSchema.nullable(),
  backgroundItems: z.array(backgroundItemSchemaV12).optional(),
  turnInProgress: z.boolean().optional(),
});

const chatSubscribeServerFrameSchemaV12 = z.discriminatedUnion("kind", [
  chatSubscribeSnapshotServerFrameSchemaV12,
  chatSubscribeTurnStateChangedServerFrameSchemaV12,
  ...chatSubscribeSharedServerFrameSchemasV12,
]);

// ─── `chat.subscribe@1.2` contract ─────────────────────────────────────────

export const chatSubscribeV12 = defineStreamRpcContract({
  method: "chat.subscribe",
  schemaVersion: { major: 1, minor: 2 } as const,
  openRequestSchema: chatSubscribeOpenRequestSchema,
  serverFrameSchema: chatSubscribeServerFrameSchemaV12,
  clientFrameSchema: chatSubscribeClientFrameSchemaBeforeV13,
});

// ─── Live `chat.subscribe@1.3` contract ────────────────────────────────────

export const chatSubscribeV13 = defineStreamRpcContract({
  method: "chat.subscribe",
  schemaVersion: { major: 1, minor: 3 } as const,
  openRequestSchema: chatSubscribeOpenRequestSchema,
  serverFrameSchema: chatSubscribeServerFrameSchema,
  clientFrameSchema: chatSubscribeClientFrameSchema,
});
