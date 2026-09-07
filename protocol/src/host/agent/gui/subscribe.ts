/**
 * `chat.subscribe@1.8` - versioned streaming-RPC contract for a single host-owned GUI chat session.
 * Streams have no cross-major downgrade bridge (see `stream-compat.ts`'s `canBridgeStream()`), so once a method ships, its major must never move again - only additive minors.
 */
import { commonRecordRegistry } from "@traycer/protocol/common/registry";
import { getRecordSchema } from "@traycer/protocol/framework/index";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  browserAnnotationRecordSchema,
  chatEventSchema,
  chatEventSchemaPreInReplyTo,
  chatEventSchemaPreReasonix,
  chatRunSettingsSchema,
  chatRunSettingsSchemaPreReasonix,
  chatSchema,
  chatSchemaPreInReplyTo,
  chatSchemaV14,
  chatSchemaV15,
  chatSchemaV16,
  interviewDeliveryProjectionSchema,
  userMessagePayloadSchema,
  userMessagePayloadSchemaPreAnnotation,
  userMessageSchema,
  userMessageSchemaPreInReplyTo,
  userMessageSchemaPreReasonix,
  userMessageSchemaV16,
  userMessageSenderSchema,
  userMessageSenderSchemaPreInReplyTo,
  userMessageSenderSchemaPreReasonix,
  type ChatEvent,
  type ChatRunSettings,
  type Message,
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
  runtimeEventSchemaPreImage,
  runtimeEventSchemaPreInReplyTo,
  runtimeEventSchemaPreSettlement,
  runtimeEventSchemaV12PreInReplyTo,
  runtimeInterviewAnswerSchema,
  runtimeInterviewAnswerSchemaPreSettlement,
  runtimePlanActionSchema,
  type ImageResolutionUpdatedEvent,
} from "@traycer/protocol/host/agent/gui/agent-runtime";

export {
  chatQueueSteerModeSchema,
  type ChatQueueSteerMode,
} from "@traycer/protocol/host/agent/gui/agent-runtime";
import { z } from "zod";
import {
  guiHarnessIdSchema,
  guiHarnessIdSchemaPreReasonix,
} from "@traycer/protocol/host/agent/shared";
import {
  worktreeBindingSchema,
  worktreeIntentSchema,
  worktreeIntentSchemaV10,
} from "@traycer/protocol/host/worktree-schemas";
import {
  heldManagedCommandUpdateSchema,
  managedCommandSchema,
  managedCommandSchemaPreRelaunch,
} from "@traycer/protocol/host/managed-command/unary-schemas";
// The windowed line's payload shapes.
import {
  chatAccumulatedChangeChunkSchema,
  chatIndexChangeSchema,
  chatLoadRangeRequestSchema,
  chatRangeResponseSchema,
  chatRecordSchema,
  chatSkeletonChunkSchema,
  chatTranscriptDerivedSchema,
  chatTranscriptWindowSchema,
} from "@traycer/protocol/host/agent/gui/subscribe-windowed";

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

// Frozen action set of the RELEASED `chat.subscribe@≤1.5` lines.
// `actionAck` echoes the action kind back, so a new action literal is a host→client surface change and must not reach a released line - the frozen bundles below bind this copy while the live line binds `chatActionSchema`.
export const chatActionSchemaV15 = z.enum([
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
  "activeProfileUpdate",
  "approvalDecision",
  "fileEditApprovalDecision",
  "interviewAnswer",
  "interviewError",
  "restoreCheckpoint",
  "revertFileChanges",
  // Background-items controls for the v2 chat stream.
  "stopBackgroundItem",
  "stopAllBackgroundItems",
]);

export const chatActionSchema = z.enum([
  ...chatActionSchemaV15.options,
  // `1.6`: the session-scoped escalation for provider builds whose per-item command stop doesn't exist (see `individualStopUnavailable` on command background items).
  // The renderer gates sending on that capability field being present, so an old host is never asked for an action it lacks.
  "stopBackgroundSession",
  // `1.7`: requeue an existing detached interview delivery. The action names
  // immutable outbox identities so retry cannot create another settlement.
  "interviewDeliveryRetry",
]);
export type ChatAction = z.infer<typeof chatActionSchema>;

// `1.6` is a shipped RC line. Keep its action-ack vocabulary frozen instead
// of allowing the live `1.7` retry literal to leak through an ack.
export const chatActionSchemaV16 = z.enum([
  ...chatActionSchemaV15.options,
  "stopBackgroundSession",
]);

/** One file in the chat-level **accumulated changes** view (the pinned panel above the composer). */
export const chatAccumulatedFileChangeSchema = z.object({
  filePath: z.string(),
  operation: checkpointFileOperationSchema,
  diffSource: diffSourceSchema,
  beforeContent: z.string().nullable(),
  afterContent: z.string().nullable(),
  reason: fileEditReasonSchema,
  undoable: z.boolean(),
  // Present + non-null ⇒ this accumulated change is a Traycer artifact `index.md`.
  artifact: checkpointArtifactTagSchema.nullish(),
});
export type ChatAccumulatedFileChange = z.infer<
  typeof chatAccumulatedFileChangeSchema
>;

/**
 * One currently-running background work item in this chat - a backgrounded subagent, a `run_in_background` command, a Monitor, a scheduled wakeup, or (from `chat.subscribe@1.3`) a workflow run.
 * Host-internal scheduling metadata such as tool-use id and start time must not leak onto this wire contract.
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
// Do not add the 1.3-only `workflow` kind here - a 1.2 peer must never observe it.
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

// One currently-running WORKFLOW background item (`chat.subscribe@1.3`) - the aggregate view of a Workflow tool run, not a per-fleet-agent row (inner `agent()` calls have no individually addressable identity on the wire.
// All nullable-defaulted so a snapshot taken before any progress arrives still parses.
const workflowBackgroundItemSchema = z.object({
  ...backgroundItemBaseFields,
  kind: z.literal("workflow"),
  phase: z.string().nullable().default(null),
  activeLabel: z.string().nullable().default(null),
  agentsStarted: z.number().nullable().default(null),
  agentsFinished: z.number().nullable().default(null),
});

// ─── Frozen `chat.subscribe@1.3` background-item shapes (pre-`mcp`) ────────
// Do not add `1.4`-only kinds here.
export const backgroundItemKindSchemaV13 = z.enum([
  ...backgroundItemKindSchemaV12.options,
  "workflow",
]);
export const backgroundItemSchemaV13 = z.discriminatedUnion("kind", [
  ...backgroundItemSchemaV12.def.options,
  workflowBackgroundItemSchema,
]);

// One currently-running MCP background item (`chat.subscribe@1.4`) - an MCP tool call the CLI moved to the background after it outlived the auto-background threshold (CLI 2.1.212+, `task_started` with task_type.
const mcpBackgroundItemSchema = z.object({
  ...backgroundItemBaseFields,
  kind: z.literal("mcp"),
  serverName: z.string(),
  toolName: z.string(),
  // Epoch ms of the promotion moment (the CLI's `task_started`), anchoring the row's live elapsed counter.
  // Nullable-defaulted so a frame from a host that predates the field still parses; the renderer hides the counter on null.
  startedAt: z.number().nullable().default(null),
});

export const backgroundItemKindSchema = z.enum([
  ...backgroundItemKindSchemaV13.options,
  "mcp",
]);
export type BackgroundItemKind = z.infer<typeof backgroundItemKindSchema>;

// ─── Frozen `chat.subscribe@1.4-1.5` background-item shapes ────────────────
// Do not add `1.6`-only fields here.
export const backgroundItemSchemaV14ToV15 = z.discriminatedUnion("kind", [
  ...backgroundItemSchemaV13.def.options,
  mcpBackgroundItemSchema,
]);

// ─── Live background-item shapes (`chat.subscribe@1.6`) ────────────────────

const subagentOrMonitorBackgroundItemSchema = z.object({
  ...backgroundItemBaseFields,
  kind: z.enum(["subagent", "monitor"]),
  scheduledFor: z.number().nullable().default(null),
});

// A `command` row splits from the shared running-item shape on `1.6` to say whether its own stop button can work.
const commandBackgroundItemSchema = z.object({
  ...backgroundItemBaseFields,
  kind: z.literal("command"),
  scheduledFor: z.number().nullable().default(null),
  // Present ⇒ this command cannot be stopped individually on the provider build that owns it, and only a session-scoped stop can end it.
  // Carries the copy ingredients (provider display name, minimum version with the per-command lever) as DATA so the renderer never hardcodes a provider version.
  individualStopUnavailable: z
    .object({
      providerLabel: z.string(),
      minVersion: z.string().nullable(),
    })
    .nullable()
    .default(null),
});

export const backgroundItemSchema = z.discriminatedUnion("kind", [
  subagentOrMonitorBackgroundItemSchema,
  commandBackgroundItemSchema,
  wakeupBackgroundItemSchema,
  workflowBackgroundItemSchema,
  mcpBackgroundItemSchema,
]);
export type BackgroundItem = z.infer<typeof backgroundItemSchema>;
export type CommandBackgroundItem = z.infer<typeof commandBackgroundItemSchema>;

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

/**
 * A prompt someone put in the queue - a user send, or an A2A response received from another agent (the `sender` discriminates).
 */
export const chatQueuedPromptItemSchema = z.object({
  kind: z.literal("prompt").default("prompt"),
  queueItemId: z.string(),
  messageId: z.string(),
  message: userMessagePayloadSchema,
  sender: userMessageSenderSchema,
  settings: chatRunSettingsSchema,
  // Billing/account context the queued turn runs under.
  accountContext: accountContextSchema.default(DEFAULT_ACCOUNT_CONTEXT),
  delivery: chatQueueItemDeliverySchema.default("next_turn"),
  status: chatQueueItemStatusSchema.default("pending"),
  targetTurnId: z.string().nullable().default(null),
  steerRequest: chatQueueSteerRequestSchema.nullable().default(null),
  fallbackReason: z.string().nullable().default(null),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ChatQueuedPromptItem = z.infer<typeof chatQueuedPromptItemSchema>;

/**
 * A pending delivery of a managed command's output (a Monitor's log digest, a backgrounded shell's completion digest) into this chat's next turn.
 * There is no `steerRequest` either: a delivery is never hand-steered by a person, so that state stays unrepresentable rather than merely unused.
 */
export const chatQueuedManagedCommandItemSchema = z.object({
  kind: z.literal("managed-command"),
  queueItemId: z.string(),
  // Durable dispatch key: the render is keyed by this, not by a closure, so an
  // item rehydrated after a host restart dispatches identically.
  commandId: z.string(),
  // The command's human label (the shell's description), shown on the queue
  // chip.
  description: z.string(),
  // Whether the shell this delivery came from is monitoring, so the chip can carry the same watcher glyph its row does.
  // Absent means "not recorded", which the chip renders generically - it never stands in for a guessed flag.
  monitoring: z.boolean().nullable().default(null),
  // Whether this digest opens its own turn or lands inside the turn already running.
  delivery: chatQueueItemDeliverySchema.default("next_turn"),
  // The turn a `same_turn` delivery is aimed at.
  targetTurnId: z.string().nullable().default(null),
  // Narrower than the prompt lifecycle enum on purpose.
  status: z.enum(["pending", "steering", "paused"]).default("pending"),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ChatQueuedManagedCommandItem = z.infer<
  typeof chatQueuedManagedCommandItemSchema
>;

export const chatQueuedItemSchema = z.union([
  chatQueuedManagedCommandItemSchema,
  chatQueuedPromptItemSchema,
]);
export type ChatQueuedItem = z.infer<typeof chatQueuedItemSchema>;

export const chatQueueStateSchema = z.object({
  status: z.enum(["idle", "running", "paused"]),
  items: z.array(chatQueuedItemSchema),
});
export type ChatQueueState = z.infer<typeof chatQueueStateSchema>;

// Wire-freeze copies with the queue item's `sender` swapped for its pre-`inReplyTo` freeze.
// Hand-frozen, not derived from the live shape.
const chatQueuedItemSchemaPreInReplyTo = z.object({
  queueItemId: z.string(),
  messageId: z.string(),
  message: userMessagePayloadSchemaPreAnnotation,
  sender: userMessageSenderSchemaPreInReplyTo,
  // Pre-Reasonix freeze: a queued item's settings tuple carries the harness id
  // the turn will run under, and released peers cannot decode `"reasonix"`.
  settings: chatRunSettingsSchemaPreReasonix,
  accountContext: accountContextSchema.default(DEFAULT_ACCOUNT_CONTEXT),
  delivery: chatQueueItemDeliverySchema.default("next_turn"),
  status: chatQueueItemStatusSchema.default("pending"),
  targetTurnId: z.string().nullable().default(null),
  steerRequest: chatQueueSteerRequestSchema.nullable().default(null),
  fallbackReason: z.string().nullable().default(null),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const chatQueueStateSchemaPreInReplyTo = z.object({
  status: z.enum(["idle", "running", "paused"]),
  items: z.array(chatQueuedItemSchemaPreInReplyTo),
});

// Wire-freeze copy of the queue item as `chat.subscribe@1.5` shipped it: a plain object with a mandatory `message`, before `1.6` split it into the `prompt | managed-command` union.
// Hand-frozen, not derived from the live shape.
const chatQueuedItemSchemaPreManagedCommand = z.object({
  queueItemId: z.string(),
  messageId: z.string(),
  message: userMessagePayloadSchemaPreAnnotation,
  // Pre-Reasonix freeze on BOTH leaves: an A2A queue item's sender carries the sending agent's harness id, and the settings tuple carries the harness the queued turn will run under.
  // Released peers cannot decode `"reasonix"` in either position.
  sender: userMessageSenderSchemaPreReasonix,
  settings: chatRunSettingsSchemaPreReasonix,
  accountContext: accountContextSchema.default(DEFAULT_ACCOUNT_CONTEXT),
  delivery: chatQueueItemDeliverySchema.default("next_turn"),
  status: chatQueueItemStatusSchema.default("pending"),
  targetTurnId: z.string().nullable().default(null),
  steerRequest: chatQueueSteerRequestSchema.nullable().default(null),
  fallbackReason: z.string().nullable().default(null),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const chatQueueStateSchemaPreManagedCommand = z.object({
  status: z.enum(["idle", "running", "paused"]),
  items: z.array(chatQueuedItemSchemaPreManagedCommand),
});

export const chatRunStatusSchema = z.enum(["idle", "running", "stopping"]);
export type ChatRunStatus = z.infer<typeof chatRunStatusSchema>;

// Frozen `chat.subscribe@1.0-1.4` active-turn shape (pre-`sameTurnSteeringSupported`).
// Every released ≤1.4 line binds this frozen copy so the host strips the newer field for those subscribers (see `chat-frame-projection.ts`).
export const chatActiveTurnSchemaPreV15 = z.object({
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
  harnessId: guiHarnessIdSchemaPreReasonix,
  model: z.string().min(1),
  // Reasoning effort + service tier the active turn is running with, mirrored from its `ChatRunSettings` so the GUI can surface them per turn.
  reasoningEffort: z.string().nullable().default(null),
  serviceTier: z.string().nullable().default(null),
  // agentMode the turn started under, mirrored from its `ChatRunSettings`.
  agentMode: agentModeSchema.default("regular"),
  profileId: z.string().nullable().default(null),
  userMessageId: z.string().nullable(),
  startedAt: z.number(),
  updatedAt: z.number(),
});

// Frozen `chat.subscribe@1.5` active-turn shape: the steering-capability field that minor shipped, still on the pre-Reasonix harness enum.
// `1.5` is RELEASED, so it cannot follow the live shape by reference - binding the live schema here is exactly how `harnessId: "reasonix"` would reach an installed `1.5`/`1.6` client whose strict enum rejects the whole.
export const chatActiveTurnSchemaPreReasonix =
  chatActiveTurnSchemaPreV15.extend({
    // Whether the running turn's harness supports same-turn steering (`chat.subscribe@1.5`).
    sameTurnSteeringSupported: z.boolean().default(false),
  });

// Live shape, bound only to the unreleased `1.7` line: re-widens `harnessId` to
// the full enum so a Reasonix turn is expressible on the wire it ships with.
export const chatActiveTurnSchema = chatActiveTurnSchemaPreReasonix.extend({
  harnessId: guiHarnessIdSchema,
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
  // Local-only worktree binding projected from host SQLite at subscribe time.
  worktreeBinding: worktreeBindingSchema.nullable(),
  // Computed, ephemeral disk-truth: the `workspacePath` of every binding entry whose effective directory (`worktreePath ?? workspacePath`) is missing on disk, recomputed host-side whenever the binding changes.
  missingWorktreePaths: z.array(z.string()),
  pendingFileEditApprovals: z.array(chatFileEditApprovalStateSchema),
  // Cumulative file changes for the whole chat (first-snapshot → current), computed host-side from checkpoint manifests + current disk content.
  accumulatedFileChanges: z.array(chatAccumulatedFileChangeSchema),
  // In-flight background work (backgrounded subagents, run_in_background commands, Monitors).
  // OPTIONAL on purpose: `undefined` means this host/session does not expose background-item controls, so the renderer hides the Background section and never sends stop actions; a present (possibly empty) array means the.
  backgroundItems: z.array(backgroundItemSchema).optional(),
  managedCommands: z.array(managedCommandSchema).default([]),
  // The subset of this chat's shells whose last output a committed Stop fence is holding back (`chat.subscribe@1.6`).
  heldUpdates: z.array(heldManagedCommandUpdateSchema).default([]),
  // Whether the host considers a turn genuinely active or activating right now - exactly its own `isTurnInProgress()` (backs `stop`'s `NO_ACTIVE_TURN` rejection).
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
  runStatus: chatRunStatusSchema,
  activeTurn: chatActiveTurnSchema.nullable(),
  // Background-items deltas ride this same broadcast (added/settled/stopped).
  backgroundItems: z.array(backgroundItemSchema).optional(),
  // See `chatSnapshotSchema.turnInProgress` - same predicate, same
  // optionality, same conservative-fallback contract.
  turnInProgress: z.boolean().optional(),
});

/**
 * The chat's managed commands changed (`chat.subscribe@1.6`).
 * Never sent to a peer that negotiated ≤1.5: it has no variant for this kind, and the whole surface arrives together or not at all.
 */
// Parameterised over the command schema for the same reason `blockDelta` is parameterised over its event schema: a frozen bundle and the live one can disagree about the command shape.
// Only the LIVE `1.6` calls it today - the collapse deleted the frozen `1.6` bundle that was the second caller - so the parameter is momentarily single-use.
function managedCommandsChangedServerFrameSchema<
  CommandSchema extends z.ZodType,
>(commandSchema: CommandSchema) {
  return z.object({
    kind: z.literal("managedCommandsChanged"),
    ...textFrameFields,
    ...chatReferenceFields,
    // Defaulted for the same reason as the snapshot's field: a consumer reads
    // one array shape on both channels and never null-checks either.
    managedCommands: z.array(commandSchema).default([]),
  });
}

const chatSubscribeManagedCommandsChangedServerFrameSchema =
  managedCommandsChangedServerFrameSchema(managedCommandSchema);

const chatSubscribeManagedCommandsChangedServerFrameSchemaV16 =
  managedCommandsChangedServerFrameSchema(managedCommandSchemaPreRelaunch);

/** The chat's HELD updates changed (`chat.subscribe@1.6`). */
const chatSubscribeHeldUpdatesChangedServerFrameSchema = z.object({
  kind: z.literal("heldUpdatesChanged"),
  ...textFrameFields,
  ...chatReferenceFields,
  // Defaulted for the same reason the sibling frames' arrays are: one array
  // shape on both channels, and no consumer null-checks either.
  heldUpdates: z.array(heldManagedCommandUpdateSchema).default([]),
});

// ─── Interview lifecycle frames ────────────────────────────────────────────
// The frozen copies are what every line through `@1.6` binds.

const interviewAnsweredServerFrameSchemaPreSettlement = z.object({
  kind: z.literal("interviewAnswered"),
  ...textFrameFields,
  ...chatReferenceFields,
  blockId: z.string(),
  answers: z.array(runtimeInterviewAnswerSchemaPreSettlement),
  resolvedAt: z.number(),
});

const interviewErroredServerFrameSchemaPreSettlement = z.object({
  kind: z.literal("interviewErrored"),
  ...textFrameFields,
  ...chatReferenceFields,
  blockId: z.string(),
  reason: z.string(),
  resolvedAt: z.number(),
});

// Live (`chat.subscribe@1.7`).
// Defaulted null so an active waiter (which has no outbox item at all) is representable as "no delivery to speak of", never as failure.
const interviewAnsweredServerFrameSchema = z.object({
  kind: z.literal("interviewAnswered"),
  ...textFrameFields,
  ...chatReferenceFields,
  blockId: z.string(),
  answers: z.array(runtimeInterviewAnswerSchema),
  resolvedAt: z.number(),
  settlementId: z.string().nullable().default(null),
  settlementSource: z.enum(["gui", "runtime"]).nullable().default(null),
  delivery: interviewDeliveryProjectionSchema.nullable().default(null),
});

// Live (`chat.subscribe@1.7`).
// `outcome` here is `skipped | failed | null` - never `answered`.
const interviewErroredServerFrameSchema = z
  .object({
    kind: z.literal("interviewErrored"),
    ...textFrameFields,
    ...chatReferenceFields,
    blockId: z.string(),
    reason: z.string(),
    resolvedAt: z.number(),
    outcome: z.enum(["skipped", "failed"]).nullable().default(null),
    draftAnswers: z.array(runtimeInterviewAnswerSchema).default([]),
    settlementId: z.string().nullable().default(null),
    settlementSource: z.enum(["gui", "runtime"]).nullable().default(null),
    delivery: interviewDeliveryProjectionSchema.nullable().default(null),
  })
  .superRefine((frame, ctx) => {
    if (frame.draftAnswers.length === 0) return;
    if (frame.outcome === "skipped") return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["draftAnswers"],
      message:
        "interviewErrored.draftAnswers require outcome === 'skipped': saved drafts only exist for an explicit Skip.",
    });
  });

// `blockDelta`'s `event` schema is the one shared-frame shape that changes incompatibly across `chat.subscribe` minors (`runtimeEventSchema` gained `workflow.*` in `1.3`), so it is versioned separately from the rest of.
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

// Order-preserving factory for the common (non-blockDelta) shared frames.
// Everything else is byte-identical across live and frozen.
function buildChatSubscribeCommonServerFrameSchemas<
  MessageSchema extends z.ZodType,
  QueueSchema extends z.ZodType,
  EventSchema extends z.ZodType,
  ActionSchema extends z.ZodType,
  InterviewAnsweredSchema extends z.ZodType,
  InterviewErroredSchema extends z.ZodType,
>(schemas: {
  readonly message: MessageSchema;
  readonly queue: QueueSchema;
  readonly event: EventSchema;
  readonly action: ActionSchema;
  readonly interviewAnswered: InterviewAnsweredSchema;
  readonly interviewErrored: InterviewErroredSchema;
}) {
  return [
    z.object({
      kind: z.literal("actionAck"),
      ...textFrameFields,
      ...chatReferenceFields,
      clientActionId: z.string(),
      action: schemas.action,
      status: chatActionAckStatusSchema,
      reason: z.string().nullable(),
      code: z.string().nullable(),
      // `chat.subscribe@1.0` - For background stop-all, task ids whose provider stop request was accepted even when the aggregate action is rejected for partial failure.
      // Defaulted so a `chat.subscribe@1.0` host (no background-items support) still parses - it never emits a background-stop ack, so `[]` is the correct reading, not a lossy fallback.
      backgroundStopTaskIds: z.array(z.string()).default([]),
    }),
    z.object({
      kind: z.literal("messageAccepted"),
      ...textFrameFields,
      ...chatReferenceFields,
      message: schemas.message,
    }),
    z.object({
      kind: z.literal("queueChanged"),
      ...textFrameFields,
      ...chatReferenceFields,
      queue: schemas.queue,
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
    schemas.interviewAnswered,
    schemas.interviewErrored,
    z.object({
      kind: z.literal("eventAppended"),
      ...textFrameFields,
      ...chatReferenceFields,
      event: schemas.event,
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
}

const chatSubscribeCommonServerFrameSchemas =
  buildChatSubscribeCommonServerFrameSchemas({
    message: userMessageSchema,
    queue: chatQueueStateSchema,
    event: chatEventSchema,
    action: chatActionSchema,
    interviewAnswered: interviewAnsweredServerFrameSchema,
    interviewErrored: interviewErroredServerFrameSchema,
  });

// Frozen common frames bound to `chat.subscribe@1.0-1.3` (pre-`inReplyTo`).
const chatSubscribeCommonServerFrameSchemasPreInReplyTo =
  buildChatSubscribeCommonServerFrameSchemas({
    message: userMessageSchemaPreInReplyTo,
    queue: chatQueueStateSchemaPreInReplyTo,
    event: chatEventSchemaPreInReplyTo,
    action: chatActionSchemaV15,
    interviewAnswered: interviewAnsweredServerFrameSchemaPreSettlement,
    interviewErrored: interviewErroredServerFrameSchemaPreSettlement,
  });

// Frozen common frames bound to `chat.subscribe@1.4-1.5`: `inReplyTo` shipped in 1.4, but the message anchor remains on the pre-Reasonix union and the queue remains pre-managed-command.
// Released peers therefore cannot receive either an unknown harness discriminant or a managed-command queue item.
const chatSubscribeCommonServerFrameSchemasPreManagedCommand =
  buildChatSubscribeCommonServerFrameSchemas({
    message: userMessageSchemaPreReasonix,
    queue: chatQueueStateSchemaPreManagedCommand,
    // Frozen on both axes (pre-Reasonix actor, pre-`chat.imported` type): an A2A chat event names the acting agent's harness, `eventAppended` rides this released line, and a released client's strict enum accepts neither the.
    event: chatEventSchemaPreReasonix,
    action: chatActionSchemaV15,
    interviewAnswered: interviewAnsweredServerFrameSchemaPreSettlement,
    interviewErrored: interviewErroredServerFrameSchemaPreSettlement,
  });

// Frozen for `chat.subscribe@1.2` and earlier.
const chatSubscribeSharedServerFrameSchemasV12 = [
  ...chatSubscribeCommonServerFrameSchemasPreInReplyTo,
  blockDeltaServerFrameSchema(runtimeEventSchemaV12PreInReplyTo),
];

const chatSubscribeSharedServerFrameSchemas = [
  ...chatSubscribeCommonServerFrameSchemas,
  blockDeltaServerFrameSchema(runtimeEventSchema),
];

// Frozen live-shape shared frames for `chat.subscribe@1.3` (workflow-bearing
// blockDelta, but pre-`inReplyTo` senders throughout).
const chatSubscribeSharedServerFrameSchemasPreInReplyTo = [
  ...chatSubscribeCommonServerFrameSchemasPreInReplyTo,
  blockDeltaServerFrameSchema(runtimeEventSchemaPreInReplyTo),
];

export const chatSubscribeServerFrameSchema = z.discriminatedUnion("kind", [
  chatSubscribeSnapshotServerFrameSchema,
  chatSubscribeTurnStateChangedServerFrameSchema,
  chatSubscribeManagedCommandsChangedServerFrameSchema,
  chatSubscribeHeldUpdatesChangedServerFrameSchema,
  ...chatSubscribeSharedServerFrameSchemas,
]);
export type ChatSubscribeServerFrame = z.infer<
  typeof chatSubscribeServerFrameSchema
>;

/** Cheap structural stand-in for a deep parse: is it a plain object at all? */
function isStructuralRecord(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `snapshot` frame schema with the two unbounded arrays - `chat.messages` and `chat.events` - validated STRUCTURALLY (each element is a plain object) instead of deeply.
 */
export const chatSubscribeSnapshotServerFrameShallowSchema = z.object({
  kind: z.literal("snapshot"),
  ...textFrameFields,
  ...chatReferenceFields,
  snapshot: chatSnapshotSchema.extend({
    chat: chatSchema.extend({
      messages: z.array(z.custom<Message>(isStructuralRecord)),
      events: z.array(z.custom<ChatEvent>(isStructuralRecord)).default([]),
    }),
  }),
});

export function createImageResolutionUpdatedFrame(input: {
  readonly epicId: string;
  readonly chatId: string;
  readonly event: ImageResolutionUpdatedEvent;
}): Extract<ChatSubscribeServerFrame, { readonly kind: "blockDelta" }> {
  return {
    kind: "blockDelta",
    hasBinaryPayload: false,
    epicId: input.epicId,
    chatId: input.chatId,
    event: input.event,
  };
}

const pauseQueueClientFrameSchema = z.object({
  kind: z.literal("pauseQueue"),
  ...ownerActionFrameFields,
});

// Narrow live-turn field update, parallel to `activePermissionModeUpdate`: move the chat's IN-FLIGHT work onto another logged-in profile of the same harness.
const activeProfileUpdateClientFrameSchema = z.object({
  kind: z.literal("activeProfileUpdate"),
  ...ownerActionFrameFields,
  harnessId: guiHarnessIdSchema,
  profileId: z.string().nullable(),
});

// The client-frame options that precede the two interview actions.
const chatSubscribeClientFrameSchemaOptionsBeforeInterview = [
  z.object({
    kind: z.literal("send"),
    ...ownerActionFrameFields,
    messageId: z.string(),
    content: jsonContentSchema,
    sender: userMessageSenderSchema,
    settings: chatRunSettingsSchema,
    // Billing/account context the turn runs under (Personal vs a specific Team).
    accountContext: accountContextSchema,
    deliveryPolicy: chatQueueDeliveryPolicySchema.default("auto"),
    worktreeIntent: worktreeIntentSchemaV10.nullable().default(null),
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
    // Editing and resending a stopped message is another turn-start path.
    // A worktree staged in the composer (create or draft rebind) must ride on this frame just as it does on a normal send.
    worktreeIntent: worktreeIntentSchemaV10.nullable().default(null),
    revertFileChanges: z.boolean(),
    // When reverting (above), also revert the artifact changes in scope.
    revertArtifacts: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal("stop"),
    ...ownerActionFrameFields,
    turnId: z.string().nullable(),
  }),
  // Stop a single background item (subagent/command/monitor) by its SDK task id, WITHOUT aborting the foreground turn (unlike `stop`).
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
    newSettings: chatRunSettingsSchema.nullable().default(null),
  }),
  z.object({
    // Abort a steer that is still `steer_requested` (the harness has not begun folding it into the running turn): the item reverts to a plain pending queue item.
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
] as const;

// ─── Interview action frames ───────────────────────────────────────────────
//
// Frozen pre-`1.7` pair, bound to every line through `@1.6`.
const interviewAnswerClientFrameSchemaPreSettlement = z.object({
  kind: z.literal("interviewAnswer"),
  ...ownerActionFrameFields,
  blockId: z.string(),
  answers: z.array(runtimeInterviewAnswerSchemaPreSettlement),
});

const interviewErrorClientFrameSchemaPreSettlement = z.object({
  kind: z.literal("interviewError"),
  ...ownerActionFrameFields,
  blockId: z.string(),
  reason: z.string(),
});

/**
 * Explicit Skip intent (`chat.subscribe@1.7`), carried on the EXISTING `interviewError` wire kind rather than a new action literal.
 * The host persists them as history and never forwards them to the harness/provider result, so a Skip remains a Skip from the agent's point of view.
 */
const interviewSkipIntentSchema = z.object({
  outcome: z.literal("skipped"),
  draftAnswers: z.array(runtimeInterviewAnswerSchema),
});
export type InterviewSkipIntent = z.infer<typeof interviewSkipIntentSchema>;

// Live pair (`chat.subscribe@1.7`).
const interviewAnswerClientFrameSchema = z.object({
  kind: z.literal("interviewAnswer"),
  ...ownerActionFrameFields,
  blockId: z.string(),
  answers: z.array(runtimeInterviewAnswerSchema),
});

const interviewErrorClientFrameSchema = z.object({
  kind: z.literal("interviewError"),
  ...ownerActionFrameFields,
  blockId: z.string(),
  reason: z.string(),
  // Null (the default) ⇒ the pre-`1.7` meaning, unchanged: an error or an
  // unanswerable dismiss, with no drafts to save.
  settlement: interviewSkipIntentSchema.nullable().default(null),
});

/** Requeue the SAME durable detached delivery. */
const interviewDeliveryRetryClientFrameSchema = z.object({
  kind: z.literal("interviewDeliveryRetry"),
  ...ownerActionFrameFields,
  blockId: z.string(),
  settlementId: z.string(),
  deliveryId: z.string(),
  generation: z.number().int().nonnegative(),
});

// The client-frame options that follow the interview pair, split out for the
// same reason as the leading ones above.
const chatSubscribeClientFrameSchemaOptionsAfterInterview = [
  z.object({
    kind: z.literal("restoreCheckpoint"),
    ...ownerActionFrameFields,
    checkpointId: z.string(),
    // When false, the turn's artifact changes are excluded from the restore (the "Also revert N artifacts" opt-out, checked by default).
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
    // When false, artifact changes are excluded from the revert (the bulk "Also revert N artifacts" opt-out).
    revertArtifacts: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal("ping"),
    ...textFrameFields,
  }),
] as const;

const chatSubscribeClientFrameSchemaBeforeV13Options = [
  ...chatSubscribeClientFrameSchemaOptionsBeforeInterview,
  interviewAnswerClientFrameSchemaPreSettlement,
  interviewErrorClientFrameSchemaPreSettlement,
  ...chatSubscribeClientFrameSchemaOptionsAfterInterview,
] as const;

export const chatSubscribeClientFrameSchemaBeforeV13 = z.discriminatedUnion(
  "kind",
  chatSubscribeClientFrameSchemaBeforeV13Options,
);

const chatSubscribeClientFrameSchemaBeforeV14Options = [
  ...chatSubscribeClientFrameSchemaBeforeV13Options,
  pauseQueueClientFrameSchema,
] as const;

// Frozen client frame of the RELEASED `1.3` line (pauseQueue, but no `activeProfileUpdate`).
export const chatSubscribeClientFrameSchemaBeforeV14 = z.discriminatedUnion(
  "kind",
  chatSubscribeClientFrameSchemaBeforeV14Options,
);

const [
  ,
  deleteMessageSuffixClientFrameSchema,
  ,
  ...chatSubscribeClientFrameSchemaRestOptions
] = chatSubscribeClientFrameSchemaBeforeV14Options;

// The same drop-the-first-three destructure applied to the pre-interview segment alone, so the live `1.7` union can re-splice its own interview pair into the middle instead of inheriting the frozen one.
const [, , , ...chatSubscribeClientFrameSchemaMiddleOptions] =
  chatSubscribeClientFrameSchemaOptionsBeforeInterview;

// `1.6`: the session-scoped background stop - the escalation the renderer offers when a command item carries `individualStopUnavailable`.
// Live line only: a released ≤1.5 host has no handler for it, and the renderer's capability gate (the item field) means it never sends one there either.
const stopBackgroundSessionClientFrameSchema = z.object({
  kind: z.literal("stopBackgroundSession"),
  ...ownerActionFrameFields,
});

// Frozen client frame of the `1.6` line as `host-v1.2.0-rc.1` shipped it.
const chatSubscribeClientFrameSchemaV16Options = [
  chatSubscribeClientFrameSchemaOptionsBeforeInterview[0].extend({
    worktreeIntent: worktreeIntentSchema.nullable().default(null),
  }),
  deleteMessageSuffixClientFrameSchema,
  chatSubscribeClientFrameSchemaOptionsBeforeInterview[2].extend({
    worktreeIntent: worktreeIntentSchema.nullable().default(null),
  }),
  ...chatSubscribeClientFrameSchemaRestOptions,
  activeProfileUpdateClientFrameSchema,
  stopBackgroundSessionClientFrameSchema,
] as const;

export const chatSubscribeClientFrameSchemaV16 = z.discriminatedUnion(
  "kind",
  chatSubscribeClientFrameSchemaV16Options,
);

// Live client frame (`chat.subscribe@1.7`) - the `1.6` composition above with the interview pair swapped for the enhanced one.
const chatSubscribeClientFrameSchemaOptions = [
  chatSubscribeClientFrameSchemaOptionsBeforeInterview[0].extend({
    worktreeIntent: worktreeIntentSchema.nullable().default(null),
    // Browser annotations entered on the unreleased live line. Every
    // released 1.0-1.6 union above stays frozen without this field.
    browserAnnotations: z.array(browserAnnotationRecordSchema).default([]),
  }),
  deleteMessageSuffixClientFrameSchema,
  chatSubscribeClientFrameSchemaOptionsBeforeInterview[2].extend({
    worktreeIntent: worktreeIntentSchema.nullable().default(null),
  }),
  ...chatSubscribeClientFrameSchemaMiddleOptions,
  interviewAnswerClientFrameSchema,
  interviewErrorClientFrameSchema,
  interviewDeliveryRetryClientFrameSchema,
  ...chatSubscribeClientFrameSchemaOptionsAfterInterview,
  pauseQueueClientFrameSchema,
  activeProfileUpdateClientFrameSchema,
  stopBackgroundSessionClientFrameSchema,
] as const;

export const chatSubscribeClientFrameSchema = z.discriminatedUnion(
  "kind",
  chatSubscribeClientFrameSchemaOptions,
);
export type ChatSubscribeClientFrame = z.infer<
  typeof chatSubscribeClientFrameSchema
>;

// `1.4` and `1.5` are released lines.
// Exported so the host's stream resolver can parse a 1.4/1.5 connection against the contract it actually negotiated - the live schema would let a stale or crafted peer dispatch actions those lines do not contain (e.g.
export const chatSubscribeClientFrameSchemaV14ToV15 = z.discriminatedUnion(
  "kind",
  [
    ...chatSubscribeClientFrameSchemaBeforeV14Options,
    activeProfileUpdateClientFrameSchema,
  ],
);

// ─── Frozen `chat.subscribe@1.0` shape (host-v1.0.0, as shipped) ──────────
// Do not add fields or variants here; extend the live schemas above instead.

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

// Pinned field-for-field, not derived via `.omit()` from `chatSnapshotSchema` - a later required field added to the live schema must not silently leak into this frozen contract.
const chatSnapshotSchemaV10 = z.object({
  chat: chatSchemaPreInReplyTo,
  access: chatAccessSchema,
  queue: chatQueueStateSchemaPreInReplyTo,
  runStatus: chatRunStatusSchema,
  activeTurn: chatActiveTurnSchemaPreV15.nullable(),
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
    message: userMessageSchemaPreInReplyTo,
  }),
  z.object({
    kind: z.literal("queueChanged"),
    ...textFrameFields,
    ...chatReferenceFields,
    queue: chatQueueStateSchemaPreInReplyTo,
  }),
  z.object({
    kind: z.literal("turnStateChanged"),
    ...textFrameFields,
    ...chatReferenceFields,
    runStatus: chatRunStatusSchema,
    activeTurn: chatActiveTurnSchemaPreV15.nullable(),
  }),
  z.object({
    kind: z.literal("blockDelta"),
    ...textFrameFields,
    ...chatReferenceFields,
    event: runtimeEventSchemaPreInReplyTo,
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
    answers: z.array(runtimeInterviewAnswerSchemaPreSettlement),
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
    event: chatEventSchemaPreInReplyTo,
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
    settings: chatRunSettingsSchemaPreReasonix,
    accountContext: accountContextSchema,
    deliveryPolicy: chatQueueDeliveryPolicySchema.default("auto"),
    worktreeIntent: worktreeIntentSchemaV10.nullable().default(null),
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
    settings: chatRunSettingsSchemaPreReasonix,
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
    newSettings: chatRunSettingsSchemaPreReasonix.nullable().default(null),
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
    settings: chatRunSettingsSchemaPreReasonix,
    accountContext: accountContextSchema,
  }),
  z.object({
    kind: z.literal("queueSettingsRestamp"),
    ...ownerActionFrameFields,
    settings: chatRunSettingsSchemaPreReasonix,
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
    answers: z.array(runtimeInterviewAnswerSchemaPreSettlement),
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
// Do not add the 1.2-only wakeup enum or metadata fields here; old 1.1 peers must never receive those values on this line.

const backgroundItemKindSchemaV11 = z.enum(["subagent", "command", "monitor"]);

const backgroundItemSchemaV11 = z.object({
  taskId: z.string(),
  kind: backgroundItemKindSchemaV11,
  title: z.string(),
  blockId: z.string(),
});

const chatSnapshotSchemaV11 = z.object({
  chat: chatSchemaPreInReplyTo,
  access: chatAccessSchema,
  queue: chatQueueStateSchemaPreInReplyTo,
  runStatus: chatRunStatusSchema,
  activeTurn: chatActiveTurnSchemaPreV15.nullable(),
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
  activeTurn: chatActiveTurnSchemaPreV15.nullable(),
  backgroundItems: z.array(backgroundItemSchemaV11).optional(),
  turnInProgress: z.boolean().optional(),
});

// `1.1`'s shared frames are pinned to the frozen `1.2` set (not the live one) so this frozen contract can never silently absorb a construct added on a later minor - see `chatSubscribeSharedServerFrameSchemasV12` above.
// This is a pure pin, not a behavior change: until `1.3` added `workflow.*`, the live and frozen sets were byte-identical.
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
// Do not add post-1.2 fields or variants here.
const chatSnapshotSchemaV12 = z.object({
  chat: chatSchemaPreInReplyTo,
  access: chatAccessSchema,
  queue: chatQueueStateSchemaPreInReplyTo,
  runStatus: chatRunStatusSchema,
  activeTurn: chatActiveTurnSchemaPreV15.nullable(),
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
  activeTurn: chatActiveTurnSchemaPreV15.nullable(),
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

// ─── Frozen `chat.subscribe@1.3` shape (host-v1.x, as shipped) ──────────────
// Do not add `1.4`-only fields here.
const chatSnapshotSchemaV13 = z.object({
  chat: chatSchemaPreInReplyTo,
  access: chatAccessSchema,
  queue: chatQueueStateSchemaPreInReplyTo,
  runStatus: chatRunStatusSchema,
  activeTurn: chatActiveTurnSchemaPreV15.nullable(),
  pendingApprovals: z.array(chatApprovalStateSchema),
  pendingInterviews: z.array(chatPendingInterviewStateSchema),
  worktreeBinding: worktreeBindingSchema.nullable(),
  missingWorktreePaths: z.array(z.string()),
  pendingFileEditApprovals: z.array(chatFileEditApprovalStateSchema),
  accumulatedFileChanges: z.array(chatAccumulatedFileChangeSchema),
  backgroundItems: z.array(backgroundItemSchemaV13).optional(),
  turnInProgress: z.boolean().optional(),
});

const chatSubscribeSnapshotServerFrameSchemaV13 = z.object({
  kind: z.literal("snapshot"),
  ...textFrameFields,
  ...chatReferenceFields,
  snapshot: chatSnapshotSchemaV13,
});

// `turnStateChanged` carries no sender, so `1.3` originally reused the live frame - until `1.4` added the `mcp` background-item kind, which rides this broadcast too.
// Pinned with the pre-`mcp` item union so the released `1.3` line cannot observe the new kind.
const chatSubscribeTurnStateChangedServerFrameSchemaV13 = z.object({
  kind: z.literal("turnStateChanged"),
  ...textFrameFields,
  ...chatReferenceFields,
  runStatus: chatRunStatusSchema,
  activeTurn: chatActiveTurnSchemaPreV15.nullable(),
  backgroundItems: z.array(backgroundItemSchemaV13).optional(),
  turnInProgress: z.boolean().optional(),
});

const chatSubscribeServerFrameSchemaV13 = z.discriminatedUnion("kind", [
  chatSubscribeSnapshotServerFrameSchemaV13,
  chatSubscribeTurnStateChangedServerFrameSchemaV13,
  ...chatSubscribeSharedServerFrameSchemasPreInReplyTo,
]);

export const chatSubscribeV13 = defineStreamRpcContract({
  method: "chat.subscribe",
  schemaVersion: { major: 1, minor: 3 } as const,
  openRequestSchema: chatSubscribeOpenRequestSchema,
  serverFrameSchema: chatSubscribeServerFrameSchemaV13,
  clientFrameSchema: chatSubscribeClientFrameSchemaBeforeV14,
});

// ─── Frozen `chat.subscribe@1.4` shape (`inReplyTo` + `mcp` items) ──────────
const chatSnapshotSchemaV14 = z.object({
  chat: chatSchemaV14,
  access: chatAccessSchema,
  queue: chatQueueStateSchemaPreManagedCommand,
  runStatus: chatRunStatusSchema,
  activeTurn: chatActiveTurnSchemaPreV15.nullable(),
  pendingApprovals: z.array(chatApprovalStateSchema),
  pendingInterviews: z.array(chatPendingInterviewStateSchema),
  worktreeBinding: worktreeBindingSchema.nullable(),
  missingWorktreePaths: z.array(z.string()),
  pendingFileEditApprovals: z.array(chatFileEditApprovalStateSchema),
  accumulatedFileChanges: z.array(chatAccumulatedFileChangeSchema),
  backgroundItems: z.array(backgroundItemSchemaV14ToV15).optional(),
  turnInProgress: z.boolean().optional(),
});

const chatSubscribeSnapshotServerFrameSchemaV14 = z.object({
  kind: z.literal("snapshot"),
  ...textFrameFields,
  ...chatReferenceFields,
  snapshot: chatSnapshotSchemaV14,
});

const chatSubscribeTurnStateChangedServerFrameSchemaV14 = z.object({
  kind: z.literal("turnStateChanged"),
  ...textFrameFields,
  ...chatReferenceFields,
  runStatus: chatRunStatusSchema,
  activeTurn: chatActiveTurnSchemaPreV15.nullable(),
  backgroundItems: z.array(backgroundItemSchemaV14ToV15).optional(),
  turnInProgress: z.boolean().optional(),
});

const chatSubscribeServerFrameSchemaV14 = z.discriminatedUnion("kind", [
  chatSubscribeSnapshotServerFrameSchemaV14,
  chatSubscribeTurnStateChangedServerFrameSchemaV14,
  ...chatSubscribeCommonServerFrameSchemasPreManagedCommand,
  blockDeltaServerFrameSchema(runtimeEventSchemaPreImage),
]);

export const chatSubscribeV14 = defineStreamRpcContract({
  method: "chat.subscribe",
  schemaVersion: { major: 1, minor: 4 } as const,
  openRequestSchema: chatSubscribeOpenRequestSchema,
  serverFrameSchema: chatSubscribeServerFrameSchemaV14,
  clientFrameSchema: chatSubscribeClientFrameSchemaV14ToV15,
});

// ─── Frozen `chat.subscribe@1.5` shape (`archivedAt` + steering capability) ─
// Pinned here so `1.6` cannot mutate this released line: the queue stays the plain prompt shape.
const chatSnapshotSchemaV15 = z.object({
  chat: chatSchemaV15,
  access: chatAccessSchema,
  queue: chatQueueStateSchemaPreManagedCommand,
  runStatus: chatRunStatusSchema,
  activeTurn: chatActiveTurnSchemaPreReasonix.nullable(),
  pendingApprovals: z.array(chatApprovalStateSchema),
  pendingInterviews: z.array(chatPendingInterviewStateSchema),
  worktreeBinding: worktreeBindingSchema.nullable(),
  missingWorktreePaths: z.array(z.string()),
  pendingFileEditApprovals: z.array(chatFileEditApprovalStateSchema),
  accumulatedFileChanges: z.array(chatAccumulatedFileChangeSchema),
  backgroundItems: z.array(backgroundItemSchemaV14ToV15).optional(),
  turnInProgress: z.boolean().optional(),
});

const chatSubscribeSnapshotServerFrameSchemaV15 = z.object({
  kind: z.literal("snapshot"),
  ...textFrameFields,
  ...chatReferenceFields,
  snapshot: chatSnapshotSchemaV15,
});

// The retro-pin the `1.5` doc comment above promised: `1.5` originally reused the live `turnStateChanged` frame, which was safe only while nothing touched background items.
// `1.6`'s command stop-capability field ends that - pinned with the pre-capability item union so the released line cannot observe it.
const chatSubscribeTurnStateChangedServerFrameSchemaV15 = z.object({
  kind: z.literal("turnStateChanged"),
  ...textFrameFields,
  ...chatReferenceFields,
  runStatus: chatRunStatusSchema,
  activeTurn: chatActiveTurnSchemaPreReasonix.nullable(),
  backgroundItems: z.array(backgroundItemSchemaV14ToV15).optional(),
  turnInProgress: z.boolean().optional(),
});

const chatSubscribeServerFrameSchemaV15 = z.discriminatedUnion("kind", [
  chatSubscribeSnapshotServerFrameSchemaV15,
  chatSubscribeTurnStateChangedServerFrameSchemaV15,
  ...chatSubscribeCommonServerFrameSchemasPreManagedCommand,
  blockDeltaServerFrameSchema(runtimeEventSchemaPreImage),
]);

export const chatSubscribeV15 = defineStreamRpcContract({
  method: "chat.subscribe",
  schemaVersion: { major: 1, minor: 5 } as const,
  openRequestSchema: chatSubscribeOpenRequestSchema,
  serverFrameSchema: chatSubscribeServerFrameSchemaV15,
  clientFrameSchema: chatSubscribeClientFrameSchemaV14ToV15,
});

// ─── Frozen `chat.subscribe@1.6` shape (host-v1.2.0-rc.1, as shipped) ──────
// Every schema below is hand-frozen from the `host-v1.2.0` tag.
const chatQueuedPromptItemSchemaV16 = z.object({
  kind: z.literal("prompt").default("prompt"),
  queueItemId: z.string(),
  messageId: z.string(),
  message: userMessagePayloadSchemaPreAnnotation,
  sender: userMessageSenderSchemaPreReasonix,
  settings: chatRunSettingsSchemaPreReasonix,
  accountContext: accountContextSchema.default(DEFAULT_ACCOUNT_CONTEXT),
  delivery: chatQueueItemDeliverySchema.default("next_turn"),
  status: chatQueueItemStatusSchema.default("pending"),
  targetTurnId: z.string().nullable().default(null),
  steerRequest: chatQueueSteerRequestSchema.nullable().default(null),
  fallbackReason: z.string().nullable().default(null),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const chatQueuedItemSchemaV16 = z.union([
  chatQueuedManagedCommandItemSchema,
  chatQueuedPromptItemSchemaV16,
]);

const chatQueueStateSchemaV16 = z.object({
  status: z.enum(["idle", "running", "paused"]),
  items: z.array(chatQueuedItemSchemaV16),
});

const chatSnapshotSchemaV16 = z.object({
  chat: chatSchemaV16,
  access: chatAccessSchema,
  queue: chatQueueStateSchemaV16,
  runStatus: chatRunStatusSchema,
  activeTurn: chatActiveTurnSchemaPreReasonix.nullable(),
  pendingApprovals: z.array(chatApprovalStateSchema),
  pendingInterviews: z.array(chatPendingInterviewStateSchema),
  worktreeBinding: worktreeBindingSchema.nullable(),
  missingWorktreePaths: z.array(z.string()),
  pendingFileEditApprovals: z.array(chatFileEditApprovalStateSchema),
  accumulatedFileChanges: z.array(chatAccumulatedFileChangeSchema),
  backgroundItems: z.array(backgroundItemSchema).optional(),
  // The shipped command shape - see the `V16` managedCommandsChanged frame.
  managedCommands: z.array(managedCommandSchemaPreRelaunch).default([]),
  heldUpdates: z.array(heldManagedCommandUpdateSchema).default([]),
  turnInProgress: z.boolean().optional(),
});

const chatSubscribeSnapshotServerFrameSchemaV16 = z.object({
  kind: z.literal("snapshot"),
  ...textFrameFields,
  ...chatReferenceFields,
  snapshot: chatSnapshotSchemaV16,
});

// `turnStateChanged` carries no interview content, so `1.6` and the live line agree on it there.
const chatSubscribeTurnStateChangedServerFrameSchemaV16 = z.object({
  kind: z.literal("turnStateChanged"),
  ...textFrameFields,
  ...chatReferenceFields,
  runStatus: chatRunStatusSchema,
  activeTurn: chatActiveTurnSchemaPreReasonix.nullable(),
  backgroundItems: z.array(backgroundItemSchema).optional(),
  turnInProgress: z.boolean().optional(),
});

const chatSubscribeCommonServerFrameSchemasV16 =
  buildChatSubscribeCommonServerFrameSchemas({
    message: userMessageSchemaV16,
    queue: chatQueueStateSchemaV16,
    event: chatEventSchemaPreReasonix,
    action: chatActionSchemaV16,
    interviewAnswered: interviewAnsweredServerFrameSchemaPreSettlement,
    interviewErrored: interviewErroredServerFrameSchemaPreSettlement,
  });

const chatSubscribeServerFrameSchemaV16 = z.discriminatedUnion("kind", [
  chatSubscribeSnapshotServerFrameSchemaV16,
  chatSubscribeTurnStateChangedServerFrameSchemaV16,
  chatSubscribeManagedCommandsChangedServerFrameSchemaV16,
  chatSubscribeHeldUpdatesChangedServerFrameSchema,
  ...chatSubscribeCommonServerFrameSchemasV16,
  blockDeltaServerFrameSchema(runtimeEventSchemaPreSettlement),
]);

// `clientFrameSchema` is DELIBERATELY the live union, unlike the frozen serverFrame above.
// THEREFORE: the next action added to the live client frame must pin `1.6` to its own frozen option list FIRST.
export const chatSubscribeV16 = defineStreamRpcContract({
  method: "chat.subscribe",
  schemaVersion: { major: 1, minor: 6 } as const,
  openRequestSchema: chatSubscribeOpenRequestSchema,
  serverFrameSchema: chatSubscribeServerFrameSchemaV16,
  clientFrameSchema: chatSubscribeClientFrameSchemaV16,
});

/**
 * The same shallow snapshot frame for a peer that negotiated `@1.6`.
 * That is a performance cliff for the entire shipped RC cohort, caused by a change they cannot observe.
 */
export const chatSubscribeSnapshotServerFrameShallowSchemaV16 = z.object({
  kind: z.literal("snapshot"),
  ...textFrameFields,
  ...chatReferenceFields,
  snapshot: chatSnapshotSchemaV16.extend({
    chat: chatSchemaV16.extend({
      messages: z.array(z.custom<Message>(isStructuralRecord)),
      events: z.array(z.custom<ChatEvent>(isStructuralRecord)).default([]),
    }),
  }),
});

// ─── Live `chat.subscribe@1.7` contract ────────────────────────────────────
export const chatSubscribeV17 = defineStreamRpcContract({
  method: "chat.subscribe",
  schemaVersion: { major: 1, minor: 7 } as const,
  openRequestSchema: chatSubscribeOpenRequestSchema,
  serverFrameSchema: chatSubscribeServerFrameSchema,
  clientFrameSchema: chatSubscribeClientFrameSchema,
});

/**
 * The newest line whose snapshot embeds the whole chat record.
 * A future line bump MUST miss this one.
 */
export const chatSubscribeFullSnapshotSchemaVersion =
  chatSubscribeV17.schemaVersion;

// ─── The windowed `chat.subscribe@1.8` contract ────────────────────────────
// Binding by reference is what makes that automatic, and it is the reason a released line must NOT do the same (`chatSchemaV14`'s comment, and the `1.6` freeze above).

/** The bounded snapshot. */
export const chatWindowedSnapshotSchema = z.object({
  /** The chat record WITHOUT `messages` / `events` - see `chatRecordSchema`. */
  chat: chatRecordSchema,
  access: chatAccessSchema,
  queue: chatQueueStateSchema,
  runStatus: chatRunStatusSchema,
  activeTurn: chatActiveTurnSchema.nullable(),
  pendingApprovals: z.array(chatApprovalStateSchema),
  pendingInterviews: z.array(chatPendingInterviewStateSchema),
  worktreeBinding: worktreeBindingSchema.nullable(),
  missingWorktreePaths: z.array(z.string()),
  pendingFileEditApprovals: z.array(chatFileEditApprovalStateSchema),
  /**
   * How many files the chat has touched.
   * The SUMMARIES arrive on their own chunked frames, for the reason the skeleton never joined the snapshot: their count is a property of the chat's HISTORY, not of its current state, and a broad refactor touches thousands.
   */
  accumulatedFileChangeCount: z.number().int().nonnegative(),
  backgroundItems: z.array(backgroundItemSchema).optional(),
  managedCommands: z.array(managedCommandSchema).default([]),
  heldUpdates: z.array(heldManagedCommandUpdateSchema).default([]),
  turnInProgress: z.boolean().optional(),
  /** The epoch every ordinal in this session is relative to. */
  transcriptEpoch: z.number().int().nonnegative(),
  rowCount: z.number().int().nonnegative(),
  /**
   * The index revision this snapshot's skeleton corresponds to - see the same field on the `indexChanged` frame.
   * Present on EVERY snapshot, including an aux-only rebroadcast that restreams no skeleton, and that is the case it is for: it is how a client holding a same-epoch skeleton learns that deltas were emitted against it which.
   */
  indexRevision: z.number().int().nonnegative().nullable(),
  /**
   * The hydrated tail. Always present, because the tail is where a live turn
   * happens and the client must paint it without a round trip.
   */
  tail: chatTranscriptWindowSchema,
  /** Whole-transcript folds a windowed client cannot compute for itself. */
  derived: chatTranscriptDerivedSchema,
});
export type ChatWindowedSnapshot = z.infer<typeof chatWindowedSnapshotSchema>;

const chatSubscribeWindowedSnapshotServerFrameSchema = z.object({
  kind: z.literal("snapshot"),
  ...textFrameFields,
  ...chatReferenceFields,
  snapshot: chatWindowedSnapshotSchema,
});

const chatSubscribeAccumulatedChangesServerFrameSchema = z.object({
  kind: z.literal("accumulatedChanges"),
  ...textFrameFields,
  ...chatReferenceFields,
  chunk: chatAccumulatedChangeChunkSchema,
});

const chatSubscribeSkeletonChunkServerFrameSchema = z.object({
  kind: z.literal("skeletonChunk"),
  ...textFrameFields,
  ...chatReferenceFields,
  chunk: chatSkeletonChunkSchema,
});

const chatSubscribeIndexChangedServerFrameSchema = z.object({
  kind: z.literal("indexChanged"),
  ...textFrameFields,
  ...chatReferenceFields,
  /**
   * The epoch AFTER the change - what subsequent `loadRange`s must carry.
   * It advances on `reindexed`, which is exactly the case where a client's in-flight `range` must be discarded.
   */
  epoch: z.number().int().nonnegative(),
  /** Row count after the change, kept in step with the snapshot's field. */
  rowCount: z.number().int().nonnegative(),
  /**
   * A per-epoch counter of index deltas, incremented by every frame the host emits and restarted at 0 by the snapshot that seats a fresh index.
   * So a lost update-only frame left the client rendering a superseded body indefinitely - and a visible row's span is protected from eviction, so the ordinary churn that would have refetched it never fires either.
   */
  indexRevision: z.number().int().nonnegative(),
  /** Every change this frame applies, atomically. */
  changes: z.array(chatIndexChangeSchema),
});

const chatSubscribeRangeServerFrameSchema = z.object({
  kind: z.literal("range"),
  ...textFrameFields,
  ...chatReferenceFields,
  range: chatRangeResponseSchema,
});

export const chatSubscribeWindowedServerFrameSchema = z.discriminatedUnion(
  "kind",
  [
    chatSubscribeWindowedSnapshotServerFrameSchema,
    chatSubscribeSkeletonChunkServerFrameSchema,
    chatSubscribeAccumulatedChangesServerFrameSchema,
    chatSubscribeIndexChangedServerFrameSchema,
    chatSubscribeRangeServerFrameSchema,
    chatSubscribeTurnStateChangedServerFrameSchema,
    chatSubscribeManagedCommandsChangedServerFrameSchema,
    chatSubscribeHeldUpdatesChangedServerFrameSchema,
    ...chatSubscribeSharedServerFrameSchemas,
  ],
);
export type ChatSubscribeWindowedServerFrame = z.infer<
  typeof chatSubscribeWindowedServerFrameSchema
>;

/**
 * Ask for a span of bodies.
 * Not an owner action: it carries no `clientActionId` and is never acked, because it is a READ.
 */
const loadRangeClientFrameSchema = z.object({
  kind: z.literal("loadRange"),
  ...textFrameFields,
  ...chatReferenceFields,
  request: chatLoadRangeRequestSchema,
});

/**
 * Re-base from scratch: a fresh bounded snapshot and a fresh skeleton.
 * The client's recovery path for the cases where its own index cannot be trusted - a reconnect, an epoch it never saw the `indexChanged` for, a `reindexed` change.
 */
const resnapshotClientFrameSchema = z.object({
  kind: z.literal("resnapshot"),
  ...textFrameFields,
  ...chatReferenceFields,
});

export const chatSubscribeWindowedClientFrameSchema = z.discriminatedUnion(
  "kind",
  [
    ...chatSubscribeClientFrameSchemaOptions,
    loadRangeClientFrameSchema,
    resnapshotClientFrameSchema,
  ],
);
export type ChatSubscribeWindowedClientFrame = z.infer<
  typeof chatSubscribeWindowedClientFrameSchema
>;

/** The windowed line. */
export const chatSubscribeV18 = defineStreamRpcContract({
  method: "chat.subscribe",
  schemaVersion: { major: 1, minor: 8 } as const,
  openRequestSchema: chatSubscribeOpenRequestSchema,
  serverFrameSchema: chatSubscribeWindowedServerFrameSchema,
  clientFrameSchema: chatSubscribeWindowedClientFrameSchema,
});
