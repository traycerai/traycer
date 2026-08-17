/**
 * `chat.subscribe@1.6` - versioned streaming-RPC contract for a single
 * host-owned GUI chat session. `chat.subscribe@1.0`–`@1.5`
 * (frozen, near the bottom of this file) are the exact shapes shipped in
 * earlier hosts; later minors only add to them, so a `1.6` app still bridges to
 * hosts that only know `1.0`–`1.5`. Streams have no cross-major downgrade
 * bridge (see `stream-compat.ts`'s `canBridgeStream()`), so once a method
 * ships, its major must never move again - only additive minors.
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
  chatEventSchemaPreInReplyTo,
  chatRunSettingsSchema,
  chatSchema,
  chatSchemaPreInReplyTo,
  chatSchemaV14,
  chatSchemaV15,
  userMessagePayloadSchema,
  userMessageSchema,
  userMessageSchemaPreInReplyTo,
  userMessageSenderSchema,
  userMessageSenderSchemaPreInReplyTo,
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
  runtimeEventSchemaV12PreInReplyTo,
  runtimeInterviewAnswerSchema,
  runtimePlanActionSchema,
  type ImageResolutionUpdatedEvent,
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
  worktreeIntentSchemaV10,
} from "@traycer/protocol/host/worktree-schemas";
import {
  heldManagedCommandUpdateSchema,
  managedCommandSchema,
} from "@traycer/protocol/host/managed-command/unary-schemas";

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
  "activeProfileUpdate",
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

// ─── Frozen `chat.subscribe@1.3` background-item shapes (pre-`mcp`) ────────
//
// `1.4` adds the `mcp` kind below. A released ≤1.3 peer must never observe
// it - the host degrades `mcp` items to `command` for those lines - and these
// frozen schemas keep the `1.3` frames parsing only shapes a real 1.3 peer
// could produce. Do not add `1.4`-only kinds here.
export const backgroundItemKindSchemaV13 = z.enum([
  ...backgroundItemKindSchemaV12.options,
  "workflow",
]);
export const backgroundItemSchemaV13 = z.discriminatedUnion("kind", [
  ...backgroundItemSchemaV12.def.options,
  workflowBackgroundItemSchema,
]);

// One currently-running MCP background item (`chat.subscribe@1.4`) - an MCP
// tool call the CLI moved to the background after it outlived the
// auto-background threshold (CLI 2.1.212+, `task_started` with task_type
// "mcp_task"). Unlike a `command` row there is no shell command line to echo:
// `serverName`/`toolName` carry the MCP identity (split from
// `mcp__<server>__<tool>`) so the renderer can title the row and give MCP
// work its own presentation instead of a pseudo-command one.
const mcpBackgroundItemSchema = z.object({
  ...backgroundItemBaseFields,
  kind: z.literal("mcp"),
  serverName: z.string(),
  toolName: z.string(),
  // Epoch ms of the promotion moment (the CLI's `task_started`), anchoring the
  // row's live elapsed counter. Nullable-defaulted so a frame from a host that
  // predates the field still parses; the renderer hides the counter on null.
  startedAt: z.number().nullable().default(null),
});

export const backgroundItemKindSchema = z.enum([
  ...backgroundItemKindSchemaV13.options,
  "mcp",
]);
export type BackgroundItemKind = z.infer<typeof backgroundItemKindSchema>;

export const backgroundItemSchema = z.discriminatedUnion("kind", [
  ...backgroundItemSchemaV13.def.options,
  mcpBackgroundItemSchema,
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

/**
 * A prompt someone put in the queue - a user send, or an A2A response received
 * from another agent (the `sender` discriminates). Carries the message content
 * and the settings tuple its turn will run under.
 */
export const chatQueuedPromptItemSchema = z.object({
  // Defaulted so every pre-`1.6` payload parses as a prompt item with no
  // migration: persisted `queue.added` metadata written by older hosts, and
  // frames from a `1.5` host parsed by a newer GUI, both carry no `kind`.
  kind: z.literal("prompt").default("prompt"),
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
export type ChatQueuedPromptItem = z.infer<typeof chatQueuedPromptItemSchema>;

/**
 * A pending delivery of a managed command's output (a Monitor's log digest, a
 * backgrounded shell's completion digest) into this chat's next turn.
 *
 * Deliberately CONTENT-FREE: the digest is rendered from the command's log and
 * delivery cursor at dispatch, so the item carries only the durable dispatch
 * key and a label for the queue chip. There is no `message`/`sender`/
 * `messageId` to fabricate, and no `settings`/`accountContext` stamp to go
 * stale - dispatch runs on the chat's *current* settings. There is no
 * `steerRequest` either: a delivery is never hand-steered by a person, so that
 * state stays unrepresentable rather than merely unused.
 *
 * `delivery`/`targetTurnId` ARE carried, because a digest that comes due while
 * the consuming agent is mid-turn on a harness that can take a mid-turn
 * injection AND report whether the provider consumed it is injected into that
 * turn rather than waiting for it to end. Every other case - unsupported
 * harness, idle agent, exhausted budget - stays `next_turn`, which is the
 * universal fallback.
 *
 * The shared `queueItemId`/`status`/timestamp fields are what keep the
 * status-only machinery (reorder, queue pause, runnability) working across the
 * union without narrowing.
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
  // Whether the shell this delivery came from is monitoring, so the chip can
  // carry the same watcher glyph its row does.
  //
  // Nullable and defaulted rather than required even though this line is
  // unshipped: the queue is DURABLE, so an item written by an earlier build of
  // this same line must still rehydrate. Absent means "not recorded", which the
  // chip renders generically - it never stands in for a guessed flag.
  monitoring: z.boolean().nullable().default(null),
  // Whether this digest opens its own turn or lands inside the turn already
  // running. Defaulted `next_turn` so a row written by an earlier build of this
  // line - and every delivery that has no eligible turn to join - rehydrates as
  // the fallback shape.
  delivery: chatQueueItemDeliverySchema.default("next_turn"),
  // The turn a `same_turn` delivery is aimed at. A turn that ends before the
  // injection lands leaves this pointing at a finished turn, which is exactly
  // the signal that returns the item to `next_turn`.
  targetTurnId: z.string().nullable().default(null),
  // Narrower than the prompt lifecycle enum on purpose. `steering` (handed to
  // the runtime, awaiting its delivery outcome) is the only steering state a
  // delivery can reach: `steer_requested` is a person hand-steering, `injected`
  // is a row rendered in the transcript, and `fallback` carries a reason string
  // the content-free variant has nowhere to put - all three stay
  // unrepresentable here.
  status: z.enum(["pending", "steering", "paused"]).default("pending"),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ChatQueuedManagedCommandItem = z.infer<
  typeof chatQueuedManagedCommandItemSchema
>;

// A plain `z.union` with the managed-command arm FIRST - deliberately not a
// `z.discriminatedUnion`, which rejects a payload missing the discriminant even
// when the literal is defaulted (verified against this repo's zod). Legacy
// payloads carry no `kind`: they fail the managed-command arm (whose `kind` is
// required) and land on the prompt arm, where the default fills the
// discriminant in. The inferred TS type is still a proper discriminated union
// on `kind`, so `switch`/narrowing stay exhaustive for consumers.
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

// Wire-freeze copies with the queue item's `sender` swapped for its
// pre-`inReplyTo` freeze. Bound to the released `chat.subscribe@1.0–1.3`
// snapshot + `queueChanged` serverFrames. `message` reuses the live
// `userMessagePayloadSchema` (unaffected — `inReplyTo` lives on the sender, not
// the message payload). Hand-frozen, not derived from the live shape.
const chatQueuedItemSchemaPreInReplyTo = z.object({
  queueItemId: z.string(),
  messageId: z.string(),
  message: userMessagePayloadSchema,
  sender: userMessageSenderSchemaPreInReplyTo,
  settings: chatRunSettingsSchema,
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

// Wire-freeze copy of the queue item as `chat.subscribe@1.5` shipped it: a
// plain object with a mandatory `message`, before `1.6` split it into the
// `prompt | managed-command` union. Senders here are the LIVE (`inReplyTo`-
// bearing) shape - `1.4` is the minor that introduced them. Hand-frozen, not
// derived from the live shape.
//
// Unlike the `mcp` background-item downgrade, a managed-command queue item has
// no sibling shape to degrade into: this schema cannot parse one at all
// (`message`/`sender`/`settings` are required and there is nothing honest to
// put in them). That is deliberate, and it is why the host's per-minor frame
// projection OMITS managed-command items for ≤1.5 peers rather than reshaping
// them - see `projectManagedCommandsForPreV16` in the host's
// `chat-frame-projection.ts`.
const chatQueuedItemSchemaPreManagedCommand = z.object({
  queueItemId: z.string(),
  messageId: z.string(),
  message: userMessagePayloadSchema,
  sender: userMessageSenderSchema,
  settings: chatRunSettingsSchema,
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

// Frozen `chat.subscribe@1.0–1.4` active-turn shape (pre-`sameTurnSteeringSupported`).
// The live shape below extends this with the `1.5` steering-capability field;
// every released ≤1.4 line binds this frozen copy so the host strips the new
// field for those subscribers (see `chat-frame-projection.ts`).
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
  harnessId: guiHarnessIdSchema,
  model: z.string().min(1),
  // Reasoning effort + service tier the active turn is running with, mirrored
  // from its `ChatRunSettings` so the GUI can surface them per turn. `null`
  // when the harness/model exposes no such control (or uses the default tier).
  reasoningEffort: z.string().nullable().default(null),
  serviceTier: z.string().nullable().default(null),
  // agentMode the turn started under, mirrored from its `ChatRunSettings`.
  // Epic Mode was removed from the product and nothing in a current client
  // reads this, but it is RETAINED until the released client floor passes this
  // version: a v1.1.8 client still compares it against its own persisted
  // settings, and an omitted field would default to "regular" there and
  // manufacture a spurious "agent mode changed" restart prompt on a legacy
  // Epic chat. Goes with `chatRunSettings.agentMode`, not before it.
  agentMode: agentModeSchema.default("regular"),
  // profileId the turn's provider process was spawned under, mirrored from its
  // `ChatRunSettings` so the GUI can detect a mid-turn profile switch against the
  // live toolbar (see `decideSteerSettings`) - steering a differently-profiled
  // prompt into the running turn would deliver it under the wrong account.
  // `null` for the ambient/default profile. Defaults to `null` so turns
  // persisted (or received from a host) before this field was added still
  // parse - see `decideSteerSettings` for how the renderer treats that case.
  profileId: z.string().nullable().default(null),
  userMessageId: z.string().nullable(),
  startedAt: z.number(),
  updatedAt: z.number(),
});

export const chatActiveTurnSchema = chatActiveTurnSchemaPreV15.extend({
  // Whether the running turn's harness supports same-turn steering (`chat.subscribe@1.5`).
  // The renderer reads this to gate the Cmd+Enter steer behavior and its
  // discovery hints instead of duplicating the host's capability table. Defaults
  // to `false` so a ≤1.4 host (or a turn persisted before this field) parses as
  // "not steer-capable" - a safe, hint-suppressing fallback.
  sameTurnSteeringSupported: z.boolean().default(false),
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
  // The shells this chat created (`createdByAgentId === chatId`), whatever
  // their state - a shell keeps running long after the turn that started it,
  // so this is NOT a subset of `backgroundItems`. Chat-scoped
  // because every surface that reads it is: the chat tile's menu and the
  // chat's Background panel.
  //
  // `default([])`, NOT `optional()`, unlike `backgroundItems`: optional only on
  // the wire INPUT, always present after parsing, so no consumer null-checks it
  // (the same input/output split the queue item's delivery fields use). That
  // deliberately gives up the capability sentinel `backgroundItems` gets from
  // its optionality - and nothing is lost with it. A host too old to send this
  // has no managed-command subsystem at all, so it genuinely owns no commands
  // and `[]` is the truth rather than a fallback; and the UI is presence-based,
  // rendering "old host" and "none yet" identically either way.
  managedCommands: z.array(managedCommandSchema).default([]),
  // The subset of this chat's shells whose last output a committed Stop fence
  // is holding back (`chat.subscribe@1.6`). A SUBSET, not a parallel set: every
  // entry has a `managedCommands` row under the same id, and this only marks
  // which of them are waiting on an explicit Deliver.
  //
  // It rides the snapshot rather than being derived client-side because a hold
  // is DURABLE - it outlives the host process that installed it, so the client
  // cannot reconstruct it from anything it watched happen, and a shell whose
  // FINAL batch was captured never produces the later output that would
  // otherwise reveal one.
  //
  // `default([])` for the same reason `managedCommands` is defaulted rather
  // than optional, and the capability sentinel is given up just as deliberately:
  // a host too old to send this cannot install holds either, so `[]` is the
  // truth and not a fallback.
  heldUpdates: z.array(heldManagedCommandUpdateSchema).default([]),
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

/**
 * The chat's managed commands changed (`chat.subscribe@1.6`). Carries the WHOLE
 * set, not a delta - the same "upsert the world" shape `backgroundItems` uses
 * on `turnStateChanged`, so the renderer's reducer is one assignment and a
 * dropped frame can never leave a stale row behind.
 *
 * It is its own frame rather than another field on `turnStateChanged` because
 * its trigger is not a turn: a shell exits, is restarted, or is deleted long
 * after the turn that created it ended, and the host's turn broadcast carries
 * run-status side effects (activity/presence tiering) that a command's
 * lifecycle must not fire.
 *
 * Never sent to a peer that negotiated ≤1.5: it has no variant for this kind,
 * and the whole surface arrives together or not at all.
 */
// Parameterised over the command schema for the same reason `blockDelta` is
// parameterised over its event schema: a frozen bundle and the live one can
// disagree about the command shape. Only the LIVE `1.6` calls it today - the
// collapse deleted the frozen `1.6` bundle that was the second caller - so the
// parameter is momentarily single-use. It stays because the freeze discipline
// above brings the second caller straight back: the moment `1.6` ships, this
// frame gets a hand-frozen command schema alongside the live one again.
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

/**
 * The chat's HELD updates changed (`chat.subscribe@1.6`). Same "upsert the
 * world" shape as `managedCommandsChanged`, and its own frame for the same
 * reason that one is: its trigger is neither a turn nor a command lifecycle
 * transition. A hold appears when a Stop commits and disappears when the
 * command's next line crosses the hold boundary or a Deliver releases it -
 * none of which move the command's own status, so a held change would ride
 * `managedCommandsChanged` only by re-broadcasting an unchanged command set.
 *
 * Sent only to a peer that negotiated ≥1.6. A `1.5` peer has no variant for
 * this kind and would fail its strict decode of the frame, so the host drops
 * it there rather than degrading the surface halfway - exactly how
 * `managedCommandsChanged` is withheld from ≤1.5.
 */
const chatSubscribeHeldUpdatesChangedServerFrameSchema = z.object({
  kind: z.literal("heldUpdatesChanged"),
  ...textFrameFields,
  ...chatReferenceFields,
  // Defaulted for the same reason the sibling frames' arrays are: one array
  // shape on both channels, and no consumer null-checks either.
  heldUpdates: z.array(heldManagedCommandUpdateSchema).default([]),
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

// Order-preserving factory for the common (non-blockDelta) shared frames. The
// three sender-bearing frames (`messageAccepted`/`queueChanged`/`eventAppended`)
// are parameterized so the released `chat.subscribe@1.0–1.3` lines can bind the
// pre-`inReplyTo` frozen chat-tree while the live line binds the current one.
// Everything else is byte-identical across live and frozen. Variant order is
// preserved (the wire-compat differ matches union variants by `kind`, but
// keeping order avoids churn in any order-sensitive fixture).
function buildChatSubscribeCommonServerFrameSchemas<
  MessageSchema extends z.ZodType,
  QueueSchema extends z.ZodType,
  EventSchema extends z.ZodType,
>(schemas: {
  readonly message: MessageSchema;
  readonly queue: QueueSchema;
  readonly event: EventSchema;
}) {
  return [
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
  });

// Frozen common frames bound to `chat.subscribe@1.0–1.3` (pre-`inReplyTo`).
const chatSubscribeCommonServerFrameSchemasPreInReplyTo =
  buildChatSubscribeCommonServerFrameSchemas({
    message: userMessageSchemaPreInReplyTo,
    queue: chatQueueStateSchemaPreInReplyTo,
    event: chatEventSchemaPreInReplyTo,
  });

// Frozen common frames bound to `chat.subscribe@1.4–1.5`: live message/event
// trees (`inReplyTo` shipped in 1.4) but the pre-union queue, so a released
// 1.4/1.5 `queueChanged` frame can never carry a managed-command item.
const chatSubscribeCommonServerFrameSchemasPreManagedCommand =
  buildChatSubscribeCommonServerFrameSchemas({
    message: userMessageSchema,
    queue: chatQueueStateSchemaPreManagedCommand,
    event: chatEventSchema,
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
 * `snapshot` frame schema with the two unbounded arrays — `chat.messages`
 * and `chat.events` — validated STRUCTURALLY (each element is a plain
 * object) instead of deeply. Snapshots are the one frame whose size scales
 * with chat history (10s–100s of MB under full-chat-on-subscribe), and a
 * deep zod parse over that is seconds of render-thread CPU per snapshot; the
 * arrays' elements live in the same trust domain as the `blockDelta` frames
 * that stream the same content, so validating the envelope + every bounded
 * field deeply and the histories structurally trades no trust for the time.
 * `z.custom<...>` keeps the inferred type identical to the deep schema's, so
 * a shallow-parsed snapshot IS a `ChatSubscribeServerFrame` to consumers.
 *
 * ONLY SOUND ON THE LIVE LINE (`chatSubscribeLiveSchemaVersion`). The deep
 * message/event schemas carry compatibility defaults (`imageResolutions`,
 * `serviceTier`, …) that up-convert a down-negotiated host's pre-image
 * objects; the structural check skips them, so a `1.6` assistant message
 * would reach consumers with `imageResolutions` genuinely absent while typed
 * as present. A host serving the client's own live line emits fully live
 * shapes (its in-memory objects are post-parse normalized and its frame
 * projection is the identity on the live line), so the shallow path is
 * exact there — callers MUST fall back to the deep parse for any other
 * negotiated version.
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

// Narrow live-turn field update, parallel to `activePermissionModeUpdate`:
// move the chat's IN-FLIGHT work onto another logged-in profile of the same
// harness. Sent by the composer on a profile switch while a run is in
// progress; the host stamps a pre-spawn profile override from it at frame
// intake, so a turn still parked on worktree setup adopts the switch before
// it spawns instead of erroring on the rate-limited profile the user just
// moved off. `harnessId` scopes application: profile ids are harness-scoped,
// so the switch only applies to a turn on the same harness. Deliberately NOT
// a whole-settings frame - model/harness never late-bind into an accepted
// turn (a model change invalidates the reasoning/thinking selection and is
// only expressible as a full tuple on a new send).
const activeProfileUpdateClientFrameSchema = z.object({
  kind: z.literal("activeProfileUpdate"),
  ...ownerActionFrameFields,
  harnessId: guiHarnessIdSchema,
  profileId: z.string().nullable(),
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
    // Editing and resending a stopped message is another turn-start path. A
    // worktree staged in the composer must ride on this frame just as it does
    // on a normal send, otherwise it is not created until the next message.
    worktreeIntent: worktreeIntentSchemaV10.nullable().default(null),
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

const chatSubscribeClientFrameSchemaBeforeV14Options = [
  ...chatSubscribeClientFrameSchemaBeforeV13Options,
  pauseQueueClientFrameSchema,
] as const;

// Frozen client frame of the RELEASED `1.3` line (pauseQueue, but no
// `activeProfileUpdate`). Kept as its own union so the shipped 1.3 shape
// stays verbatim while the live schema below grows the minor-4 delta.
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

const chatSubscribeClientFrameSchemaOptions = [
  chatSubscribeClientFrameSchemaBeforeV13Options[0].extend({
    worktreeIntent: worktreeIntentSchema.nullable().default(null),
  }),
  deleteMessageSuffixClientFrameSchema,
  chatSubscribeClientFrameSchemaBeforeV13Options[2].extend({
    worktreeIntent: worktreeIntentSchema.nullable().default(null),
  }),
  ...chatSubscribeClientFrameSchemaRestOptions,
  activeProfileUpdateClientFrameSchema,
] as const;

export const chatSubscribeClientFrameSchema = z.discriminatedUnion(
  "kind",
  chatSubscribeClientFrameSchemaOptions,
);
export type ChatSubscribeClientFrame = z.infer<
  typeof chatSubscribeClientFrameSchema
>;

// `1.4` and `1.5` are released lines. Keep their client frames on the
// pre-collision intent shape while the live `1.6` line uses the current one.
const chatSubscribeClientFrameSchemaV14ToV15 = z.discriminatedUnion(
  "kind",
  [...chatSubscribeClientFrameSchemaBeforeV14Options, activeProfileUpdateClientFrameSchema],
);

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
    settings: chatRunSettingsSchema,
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
//
// `1.3` shipped the live-shape serverFrame (workflow background items +
// `workflow.*` blockDelta events + `pauseQueue` client frames) but PRE-
// `inReplyTo`. Pinned here so `1.4` (which adds `inReplyTo` to every sender) can
// no longer mutate this released line: the frozen chat-tree / runtime-event
// variants strip `inReplyTo` for a `1.3` peer. `turnStateChanged` carries no
// sender, so it reuses the live frame. Do not add `1.4`-only fields here.
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

// `turnStateChanged` carries no sender, so `1.3` originally reused the live
// frame - until `1.4` added the `mcp` background-item kind, which rides this
// broadcast too. Pinned with the pre-`mcp` item union so the released `1.3`
// line cannot observe the new kind.
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
//
// `1.4` shipped `inReplyTo` on every agent sender (user-message, assistant,
// queue item, event `actor`, steer) and the `mcp` background-item kind (CLI
// auto-backgrounded MCP tool calls) - but PRE-`archivedAt`,
// PRE-`sameTurnSteeringSupported`, and PRE-managed-command queue items. Pinned
// here so no later minor can mutate this released line: the frozen snapshot has
// no `archivedAt` key on `chat`, `activeTurn` strips the steering-capability
// field in both the snapshot and `turnStateChanged` frames, and the queue stays
// the single plain-object prompt shape so a real 1.4 peer can never observe a
// managed-command item.
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
  backgroundItems: z.array(backgroundItemSchema).optional(),
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
  backgroundItems: z.array(backgroundItemSchema).optional(),
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
//
// `1.5` shipped `chat.archivedAt` on the snapshot and `sameTurnSteeringSupported`
// on `activeTurn` (so the renderer can gate Cmd+Enter steering without
// duplicating the harness capability table) - but PRE-managed-command queue
// items. Pinned here so `1.6` cannot mutate this released line: the queue stays
// the plain prompt shape. `turnStateChanged` carries no queue and `1.6` changes
// nothing else it holds, so it reuses the live frame - retro-pin it here if a
// later minor touches background items again (that is exactly what happened to
// `1.3` and `1.4`).
//
// `chat: chatSchemaV15` (not live `chatSchema`) for the same reason `1.4`
// uses `chatSchemaV14`: a released line must not follow the persistence
// schema by reference, or every later field addition to `chatSchema` (e.g.
// `pinnedUserProviderHandle`, `lastDeliveredRolesDigest`) silently leaks onto
// this frozen wire shape. Caught by `released-baseline-compat.test.ts`.
const chatSnapshotSchemaV15 = z.object({
  chat: chatSchemaV15,
  access: chatAccessSchema,
  queue: chatQueueStateSchemaPreManagedCommand,
  runStatus: chatRunStatusSchema,
  activeTurn: chatActiveTurnSchema.nullable(),
  pendingApprovals: z.array(chatApprovalStateSchema),
  pendingInterviews: z.array(chatPendingInterviewStateSchema),
  worktreeBinding: worktreeBindingSchema.nullable(),
  missingWorktreePaths: z.array(z.string()),
  pendingFileEditApprovals: z.array(chatFileEditApprovalStateSchema),
  accumulatedFileChanges: z.array(chatAccumulatedFileChangeSchema),
  backgroundItems: z.array(backgroundItemSchema).optional(),
  turnInProgress: z.boolean().optional(),
});

const chatSubscribeSnapshotServerFrameSchemaV15 = z.object({
  kind: z.literal("snapshot"),
  ...textFrameFields,
  ...chatReferenceFields,
  snapshot: chatSnapshotSchemaV15,
});

const chatSubscribeServerFrameSchemaV15 = z.discriminatedUnion("kind", [
  chatSubscribeSnapshotServerFrameSchemaV15,
  chatSubscribeTurnStateChangedServerFrameSchema,
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

// ─── Live `chat.subscribe@1.6` contract ────────────────────────────────────
//
// `1.6` is where the whole Shells surface joined the chat stream: the chat's
// own commands (`snapshot.managedCommands` + `managedCommandsChanged`) and the
// queue items their deliveries ride as. There is no epic-wide list stream to
// pair with it - see the re-entry note in `host/managed-command/subscribe.ts`.
//
// The serverFrame's queue is the `prompt | managed-command` union: a pending
// managed-command delivery (a monitoring shell's log digest, a shell's
// completion) is a first-class, content-free queue item the user can see,
// reorder, and cancel - and, on a harness that confirms it consumed a mid-turn
// steer, one that can be injected into the running turn rather than waiting
// for it (`delivery`/`targetTurnId` on the variant). A released ≤1.5 peer
// negotiates a frozen line above, which cannot represent the variant at all;
// the host's frame projection omits those items for such peers rather than
// fabricating a prompt shape for them. The client frame is unchanged from
// `1.4` - cancel/reorder of a managed-command item ride the existing
// `queueCancel`/`queueReorder` actions, which are keyed by `queueItemId` alone.
//
// It also carries image generation - `imageResults` on the `tool_call` content
// block and `tool_call.completed` runtime event, the durable image resolution
// record on assistant messages (`assistantMessageSchema.imageResolutions`), the
// typed `image_resolution.updated` runtime event - and the Stop fence's held
// updates: the snapshot's `heldUpdates` and the `heldUpdatesChanged` frame, the
// pair that gives `managedCommand.deliverHeld` something to act on.
//
// Those last two arrived on a `1.7` opened above a `1.6` that was itself
// pinned to a hand-written pre-image bundle, so that the live schemas could
// grow without mutating it. The release collapsed the two: no peer in the field
// has ever negotiated `1.6` or `1.7` (the highest minor any released
// `host-v*`/`cli-v*`/`desktop-v*` baseline carries is `1.5`), so a pre-image
// that froze `1.6` against `1.7` froze it against nothing, and shipping both
// minors would have announced two negotiable lines where one peer set exists.
//
// This line is therefore bound to the LIVE schemas, and that is what makes the
// freeze discipline start again cleanly: the moment `1.6` ships, or the moment
// a `1.7` opens above it, whichever comes first, this line must be re-pinned to
// a hand-written pre-image bundle the way `1.4` and `1.5` are above. The lines
// below it are frozen precisely because they HAVE peers; this one does not yet.
export const chatSubscribeV16 = defineStreamRpcContract({
  method: "chat.subscribe",
  schemaVersion: { major: 1, minor: 6 } as const,
  openRequestSchema: chatSubscribeOpenRequestSchema,
  serverFrameSchema: chatSubscribeServerFrameSchema,
  clientFrameSchema: chatSubscribeClientFrameSchema,
});

/**
 * The live line's version, declared HERE (next to the live contract) so a
 * future line bump cannot miss it. This is the one negotiated version on
 * which `chatSubscribeSnapshotServerFrameShallowSchema` is sound — see its
 * doc for why any down-negotiated line must take the deep parse instead.
 */
export const chatSubscribeLiveSchemaVersion = chatSubscribeV16.schemaVersion;
