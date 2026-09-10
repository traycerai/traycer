/**
 * `chat.subscribe@1.10` - versioned streaming-RPC contract for a single
 * host-owned GUI chat session. `chat.subscribe@1.0`–`@1.9`
 * (frozen, near the bottom of this file) are the exact shapes shipped in
 * earlier hosts; later minors only add to them, so a `1.10` app still bridges
 * to hosts that only know `1.0`–`1.9`. Streams have no cross-major downgrade
 * bridge (see `stream-compat.ts`'s `canBridgeStream()`), so once a method
 * ships, its major must never move again - only additive minors.
 *
 * `1.8` is the WINDOWED line and is the one place that generalization bends:
 * it does not merely add to `1.7`, it replaces the snapshot's embedded
 * transcript with a skeleton plus on-demand ranges. That is a behaviour
 * change selected by version rather than by a flag, and the host serves whole
 * snapshots to anything below it. See `chatSubscribeV18` at the bottom. (It
 * was drafted as `1.7` and re-based when the interview-settlement + Reasonix
 * line took that minor first - see the note above `chatSubscribeV17`.)
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
  browserAnnotationRecordSchema,
  chatEventSchema,
  chatEventSchemaPreInReplyTo,
  chatEventSchemaPreReasonix,
  chatRunSettingsSchema,
  chatRunSettingsSchemaPreReasonix,
  chatSchema,
  chatSchemaV18,
  messageSchemaV18,
  chatSchemaPreInReplyTo,
  chatSchemaV14,
  chatSchemaV15,
  chatSchemaV16,
  interviewDeliveryProjectionSchema,
  userMessagePayloadSchema,
  userMessagePayloadSchemaPreAnnotation,
  userMessageSchema,
  userMessageSchemaV18,
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
  agentFailureSchema,
  diffSourceSchema,
  fileEditReasonSchema,
} from "@traycer/protocol/persistence/epic/content-blocks";
import {
  chatQueueSteerModeSchema,
  runtimeApprovalDecisionSchema,
  runtimeEventSchema,
  runtimeEventSchemaPreFallback,
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
// The windowed line's payload shapes. They live in their own module (and import
// nothing from here) so this file can stay the one place every `chat.subscribe`
// FRAME union is assembled - the aux frames are shared between the two lines,
// and splitting the unions across files would hide that.
import {
  chatAccumulatedChangeChunkSchema,
  chatIndexChangeSchema,
  chatLoadRangeRequestSchema,
  chatRangeResponseSchema,
  chatRangeResponseSchemaPreFallback,
  chatRecordSchema,
  chatSkeletonChunkSchema,
  chatTranscriptDerivedSchema,
  chatTranscriptWindowSchema,
  chatTranscriptWindowSchemaPreFallback,
} from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import { transcriptRowContextSchema } from "@traycer/protocol/persistence/chat-transcript/row-context";
import { transcriptRowContextSchemaPreAntigravity } from "@traycer/protocol/persistence/chat-transcript/row-context";

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

// Frozen action set of the RELEASED `chat.subscribe@≤1.5` lines. `actionAck`
// echoes the action kind back, so a new action literal is a host→client
// surface change and must not reach a released line - the frozen bundles below
// bind this copy while the live line binds `chatActionSchema`.
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
  // Background-items controls for the v2 chat stream. The renderer still gates
  // sends on the host advertising `backgroundItems` in snapshots so test hosts
  // and unsupported providers remain inert.
  "stopBackgroundItem",
  "stopAllBackgroundItems",
]);

// Frozen action set of the `chat.subscribe@1.7`-`@1.9` lines. Same reason
// `chatActionSchemaV15`/`V16` exist: `actionAck` echoes the action kind back,
// so a new literal is a host->client surface change, and those three minors
// have shipped (`1.7`/`1.8` in `host-v1.3.0`, `1.9` in the staging builds).
export const chatActionSchemaV17ToV19 = z.enum([
  ...chatActionSchemaV15.options,
  // `1.6`: the session-scoped escalation for provider builds whose per-item
  // command stop doesn't exist (see `individualStopUnavailable` on command
  // background items). The renderer gates sending on that capability field
  // being present, so an old host is never asked for an action it lacks.
  "stopBackgroundSession",
  // `1.7`: requeue an existing detached interview delivery. The action names
  // immutable outbox identities so retry cannot create another settlement.
  "interviewDeliveryRetry",
]);

export const chatActionSchema = z.enum([
  ...chatActionSchemaV17ToV19.options,
  // `1.10`: the fallback grace card's menu open/close.
  //
  // STREAM actions, not unary RPCs, and deliberately so: `holdForChoice`
  // freezes the remaining grace window and acks a lease token, and a lease
  // has to bind to the subscription that owns it. A unary call cannot name
  // its owning subscription - it has no `connectionId` on the wire - so two
  // windows opening the same menu would be indistinguishable. Sent here, the
  // lease binds to the stream's `connectionId` for free, and subscriber
  // detach resumes the frozen remainder with no extra message.
  "fallback.holdForChoice",
  "fallback.releaseChoice",
]);
export type ChatAction = z.infer<typeof chatActionSchema>;

// `1.6` is a shipped RC line. Keep its action-ack vocabulary frozen instead
// of allowing the live `1.7` retry literal to leak through an ack.
export const chatActionSchemaV16 = z.enum([
  ...chatActionSchemaV15.options,
  "stopBackgroundSession",
]);

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

export const backgroundItemKindSchemaV14ToV19 = z.enum([
  ...backgroundItemKindSchemaV13.options,
  "mcp",
]);

export const backgroundItemKindSchema = z.enum([
  ...backgroundItemKindSchemaV14ToV19.options,
  // `1.10`: a chat parked on a provider's rate-limit reset by the fallback
  // engine's wait rung. It is background work in the sense that matters to
  // this panel - the chat is doing something, the user can see when it will
  // end, and the user can stop it - even though nothing is executing.
  "fallback-wait",
]);
export type BackgroundItemKind = z.infer<typeof backgroundItemKindSchema>;

// ─── Frozen `chat.subscribe@1.4–1.5` background-item shapes ────────────────
//
// `1.6` splits `command` out of the shared running-item shape below so it can
// carry `individualStopUnavailable`. A released ≤1.5 peer must never observe
// that key - this frozen union keeps the released `1.4`/`1.5` frames parsing
// only shapes a real peer of those lines could produce. Do not add
// `1.6`-only fields here.
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

// A `command` row splits from the shared running-item shape on `1.6` to say
// whether its own stop button can work. Some provider builds run commands in
// the background but expose no per-command stop (e.g. codex below the
// background-terminals floor); the panel needs that fact BEFORE the user
// clicks, not as a failing ack after.
const commandBackgroundItemSchema = z.object({
  ...backgroundItemBaseFields,
  kind: z.literal("command"),
  scheduledFor: z.number().nullable().default(null),
  // Present ⇒ this command cannot be stopped individually on the provider
  // build that owns it, and only a session-scoped stop can end it. Carries
  // the copy ingredients (provider display name, minimum version with the
  // per-command lever) as DATA so the renderer never hardcodes a provider
  // version. Null (the default, and what every non-gated host sends) ⇒ the
  // per-item stop works normally.
  individualStopUnavailable: z
    .object({
      providerLabel: z.string(),
      minVersion: z.string().nullable(),
    })
    .nullable()
    .default(null),
});

// ─── Frozen `chat.subscribe@1.6–1.9` background-item shapes ────────────────
//
// `1.10` adds the `fallback-wait` kind below. Every line through `1.9` binds
// this union, which is a literal pre-image rather than an alias for the live
// one: `1.6`-`1.9` have all shipped, and an alias over a schema that grows is
// not a freeze. A released peer's decoder is a
// closed discriminated union - an unknown `kind` fails the WHOLE frame, not
// just the row - so the host degrades a wait item out of those lines'
// `backgroundItems` rather than sending one.
export const backgroundItemSchemaPreFallbackWait = z.discriminatedUnion(
  "kind",
  [
    subagentOrMonitorBackgroundItemSchema,
    commandBackgroundItemSchema,
    wakeupBackgroundItemSchema,
    workflowBackgroundItemSchema,
    mcpBackgroundItemSchema,
  ],
);

// ─── Live background-item shapes (`chat.subscribe@1.10`) ───────────────────

/**
 * A chat parked on a provider rate-limit reset by the fallback engine's wait
 * rung (`chat.subscribe@1.10`).
 *
 * `scheduledFor` is REQUIRED, like a wakeup's: a wait exists because a
 * verified reset boundary was read, so a wait row without one is a
 * contradiction, not a degraded row. `providerId` and `profileLabel` name the
 * account being waited on - the row's identity chip - so the panel never has
 * to join against a providers list to title itself; `profileLabel` is null for
 * the ambient (unnamed) profile, which is a real state and not a missing one.
 */
const fallbackWaitBackgroundItemSchema = z.object({
  ...backgroundItemBaseFields,
  kind: z.literal("fallback-wait"),
  scheduledFor: z.number(),
  providerId: z.string(),
  profileLabel: z.string().nullable(),
});

export const backgroundItemSchema = z.discriminatedUnion("kind", [
  ...backgroundItemSchemaPreFallbackWait.def.options,
  fallbackWaitBackgroundItemSchema,
]);
export type BackgroundItem = z.infer<typeof backgroundItemSchema>;
export type CommandBackgroundItem = z.infer<typeof commandBackgroundItemSchema>;
export type FallbackWaitBackgroundItem = z.infer<
  typeof fallbackWaitBackgroundItemSchema
>;

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
  message: userMessagePayloadSchemaPreAnnotation,
  // Pre-Reasonix freeze on BOTH leaves: an A2A queue item's sender carries the
  // sending agent's harness id, and the settings tuple carries the harness the
  // queued turn will run under. Released peers cannot decode `"reasonix"` in
  // either position.
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
// Every released ≤1.4 line binds this frozen copy so the host strips the newer
// field for those subscribers (see `chat-frame-projection.ts`).
//
// `harnessId` is ALSO pinned to the pre-Reasonix enum here: ≤1.4 needs both
// freezes, and the two later rungs re-widen exactly one field each -
// `chatActiveTurnSchemaPreReasonix` adds the `1.5` steering flag (and serves
// `1.5`/`1.6`), and the live `chatActiveTurnSchema` restores the full enum for
// the `1.7` line.
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

// Frozen `chat.subscribe@1.5` active-turn shape: the steering-capability field
// that minor shipped, still on the pre-Reasonix harness enum. `1.5` is RELEASED,
// so it cannot follow the live shape by reference - binding the live schema here
// is exactly how `harnessId: "reasonix"` would reach an installed `1.5`/`1.6`
// client whose strict enum rejects the whole frame.
export const chatActiveTurnSchemaPreReasonix =
  chatActiveTurnSchemaPreV15.extend({
    // Whether the running turn's harness supports same-turn steering (`chat.subscribe@1.5`).
    // The renderer reads this to gate the Cmd+Enter steer behavior and its
    // discovery hints instead of duplicating the host's capability table. Defaults
    // to `false` so a ≤1.4 host (or a turn persisted before this field) parses as
    // "not steer-capable" - a safe, hint-suppressing fallback.
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

/**
 * The traversal states a client is ever shown (`chat.subscribe@1.10`).
 *
 * A strict SUBSET of the host's own record states, and the omissions are the
 * contract rather than an oversight. The three terminal states say only that a
 * traversal has finished, which is exactly when the DTO is absent; and
 * `completed_awaiting_return` is not a pending fallback at all - the gate is
 * open, the queue is running, and the chat is merely being asked whether to go
 * back. It has its own banner.
 */
export const pendingFallbackStateSchema = z.enum([
  "retrying",
  "hold",
  "choosing",
  "switching",
  "waiting",
]);
export type PendingFallbackState = z.infer<typeof pendingFallbackStateSchema>;

/**
 * The ladder rung an impending action will take (`chat.subscribe@1.10`).
 *
 * `retry` is here even though it is not a ladder rung: during the transient
 * pre-retry series the thing that happens when the countdown ends IS another
 * attempt on the same tuple, and a client asking "what happens next" wants that
 * answer in the same field as the others rather than by inferring it from
 * `state`.
 */
export const fallbackImpendingRungSchema = z.enum([
  /** The same tuple, again - the transient pre-retry series. */
  "retry",
  /** The same provider, a different account. */
  "profile",
  /** An equivalent model from the user's own groups, usually elsewhere. */
  "tier",
  /** Park until the failed tuple's verified reset boundary. */
  "wait",
  /** Nothing left to try: stop and say so. */
  "notify",
]);
export type FallbackImpendingRung = z.infer<typeof fallbackImpendingRungSchema>;

/** Why the host cannot name a destination yet (`chat.subscribe@1.10`). */
export const fallbackImpendingPendingSchema = z.enum([
  /** The candidate walk has not produced an answer. */
  "resolving",
  /** A provider reset probe is in flight and may change the plan. */
  "awaiting_reset_check",
]);
export type FallbackImpendingPending = z.infer<
  typeof fallbackImpendingPendingSchema
>;

/**
 * What the host will do when the current countdown ends
 * (`chat.subscribe@1.10`).
 *
 * ## The contract, in one sentence
 *
 * This is what happens when `pendingFallback.deadline` elapses - during
 * `retrying` another attempt on the same tuple, during `hold` the ladder rung
 * the cursor is on, walked forward past rungs that cannot be taken.
 *
 * ## Why it exists
 *
 * The whole point of the grace window is that the user can stop what is about
 * to happen. Before this the frame carried `targetTuple: null` for the entire
 * hold - the host resolved and COMMITTED its destination only after expiry - so
 * the card could say "deciding what to do in 12s" and nothing else. A cancel
 * window that will not say what it is cancelling is a countdown, not a choice.
 *
 * ## `impendingAction.target` versus `targetTuple`
 *
 * `targetTuple` is where the chat is GOING - written when a destination has
 * been chosen, by the user or by the host's own commit. This is the host's
 * PREDICTION, published before anything is committed. Once a destination is
 * settled both carry it, so a surface that reads only this one is still right.
 */
export const fallbackImpendingActionSchema = z.object({
  /**
   * The identity of this plan, opaque and for comparison only.
   *
   * Changes if and only if `rung`, `target`, `targetModelFamily`, `resumesAt`
   * or `pending` change. A `siblingSwitching` change, a `revision` bump that
   * moved nothing else, and every countdown tick all carry the SAME value -
   * which is what lets a screen-reader announcer speak a plan once instead of
   * once per frame, without diffing four fields itself and getting the
   * "unchanged" case subtly wrong.
   */
  planId: z.string(),
  rung: fallbackImpendingRungSchema,
  /**
   * Where a switch would move the chat. `null` for `wait`, `notify` and
   * `retry`, which move nothing, and while `pending` is non-null.
   */
  target: chatRunSettingsSchema.nullable(),
  /**
   * The equivalence-group family a `tier` hop matched, when it differs from the
   * resolved `target.model`. `null` on every other rung, and `null` when the
   * group names the resolved slug itself - so a row rendering "family · model"
   * never says the same word twice.
   */
  targetModelFamily: z.string().nullable(),
  /** When a `wait` rung would resume, epoch ms. `null` on every other rung. */
  resumesAt: z.number().nullable(),
  /** `null` once the plan is fully resolved. */
  pending: fallbackImpendingPendingSchema.nullable(),
});
export type FallbackImpendingAction = z.infer<
  typeof fallbackImpendingActionSchema
>;

/**
 * The live fallback traversal on this chat, derived from the durable record
 * (`chat.subscribe@1.10`).
 *
 * DERIVED, never authoritative, and the distinction is load-bearing: a
 * live-lane DTO does not survive idle eviction, so anything a client needs
 * after a reconnect has to be re-derivable from the record. What arrives here
 * is a projection of the record as of this frame - never a thing the client
 * accumulates.
 *
 * Additive-optional on the live line only. Every released `1.0`-`1.8` snapshot
 * and `turnStateChanged` shape is a hand-frozen literal pre-image, so none of
 * them can grow this key; `undefined` on the live line means "no traversal",
 * which is the same thing an older host's silence means, so a renderer needs
 * one code path rather than two.
 */
export const pendingFallbackSchema = z.object({
  traversalId: z.string(),
  /**
   * The client's expected-state handle. Every external action carries it back,
   * and a mismatch is `traversal_advanced` - so a menu rendered from a stale
   * frame refuses instead of acting on a world that moved.
   */
  revision: z.number().int().nonnegative(),
  state: pendingFallbackStateSchema,
  /**
   * Why the attempt failed, as the stopped-reason vocabulary spells it. An
   * open string rather than an enum: the reason travels from a provider
   * adapter, and a strict enum here would fail the WHOLE frame on a reason a
   * released client has not heard of - for a field it only renders as a label.
   */
  reason: z.string(),
  /** The tuple that failed. Never the chat's current settings, which a hop may already have moved. */
  failedTuple: chatRunSettingsSchema,
  /**
   * The tuple a switch is heading for, once one is COMMITTED.
   *
   * Null during the grace hold, and that no longer means the destination is
   * unknown: since F5 the host publishes its intended destination on
   * `impendingAction.target` while the hold is still cancellable. Read this
   * field for "where the chat has been moved", `impendingAction.target` for
   * "where it is about to move" - a card that waits for this one to render a
   * destination shows nothing for the entire window the user could act in.
   */
  targetTuple: chatRunSettingsSchema.nullable(),
  /**
   * What the host will do when this window ends - published DURING the hold and
   * before any settings commit.
   *
   * `null` in two unrelated cases, and a reader that treats them as one will
   * misread the second:
   *
   * 1. The host can name no takeable rung at all - a traversal about to settle
   *    as exhausted.
   * 2. The prediction has been SPENT because the chat already took the action.
   *    Both wait paths clear it - the automatic `waiting` transition and a
   *    manual `wait_once` - because `waitDeadline` then carries everything the
   *    card needs, and a plan left behind would keep announcing an impending
   *    action for a move that has already happened.
   *
   * So `null` means "nothing is coming from this field", never "nothing is
   * happening": in case 2 the chat is mid-wait and `waitDeadline` is non-null.
   *
   * Required-and-nullable rather than optional: `1.10` is the live line and
   * the host always sets this key, so `null` is a FACT - one of the two above -
   * rather than an absence a reader has to distinguish from an older host. It
   * is deliberately not restated here as "nothing is takeable": that is case 1
   * alone, and reading it as the meaning of `null` is exactly the collapse the
   * two cases above exist to prevent. Every
   * released `1.0`-`1.8` line drops the whole `pendingFallback` container at the
   * projector's explicit-delete sites, so a nested key never reaches one.
   */
  impendingAction: fallbackImpendingActionSchema.nullable(),
  /**
   * When the current state's countdown ends, epoch ms.
   *
   * `null` covers three genuinely different situations - an effect phase that
   * is due now, a `choosing` whose countdown a menu has frozen, and a state
   * with no timer at all - and the client does not need to tell them apart: in
   * all three there is no time to render. `graceRemainingMs` is what a frozen
   * countdown shows instead.
   */
  deadline: z.number().nullable(),
  /** The frozen remainder while `choosing`, so the menu can render a paused countdown. */
  graceRemainingMs: z.number().nullable(),
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().nonnegative(),
  /**
   * How many queued items this traversal is holding, and would carry across a
   * switch. Rendered as "N queued messages will move with it", which is the
   * one number that makes the consequence of the switch legible.
   */
  queuedItemsMoving: z.number().int().nonnegative(),
  /**
   * How many OTHER chats on this host are mid-switch right now
   * (`hold`/`choosing`/`switching`), so a user changing one chat's provider can
   * see they are not doing it alone.
   *
   * Re-derived and re-broadcast to every affected chat whenever any sibling
   * enters or leaves those states - which is why it is a count on the DTO
   * rather than something a client could total up from frames it happens to
   * hold: it has no view of its siblings at all.
   */
  siblingSwitching: z.number().int().nonnegative(),
});
export type PendingFallback = z.infer<typeof pendingFallbackSchema>;

/**
 * The offer to move this chat back to the provider it started on
 * (`chat.subscribe@1.10`).
 *
 * A separate key from {@link pendingFallbackSchema} rather than a sixth state
 * on it, because the two describe opposite situations. A pending fallback is a
 * chat whose dispatch is HELD while the host tries to rescue a failed turn; a
 * pending return is a chat that was already rescued, is running normally, and
 * is being asked one question. Folding them together would put the waiting
 * card's "N queued messages will move" and its cancel actions on a chat with
 * nothing to cancel.
 *
 * Present only once the offer has actually SURFACED - the traversal's return
 * deadline is the preferred provider's own reset boundary, and before it there
 * is nothing to ask. Absent for the `auto` policy, which acts instead of
 * asking, and for `stay`, which never arms a return at all.
 *
 * DERIVED per frame from the durable record, never accumulated: like the
 * pending fallback, this outlives the session that produced it, so a client
 * that reconnects re-reads it rather than remembering it.
 */
export const pendingReturnSchema = z.object({
  traversalId: z.string(),
  /**
   * The expected-state handle the banner's action carries back. A mismatch is
   * `traversal_advanced` - a new failure armed on this chat while the banner
   * was on screen, and the offer it describes no longer exists.
   */
  revision: z.number().int().nonnegative(),
  /** Where the chat would go back TO - the tuple the user last chose. */
  preferredTuple: chatRunSettingsSchema,
  /** Where the chat is NOW - the traversal's final committed target. */
  fallbackTuple: chatRunSettingsSchema,
  /**
   * How many queued messages the switch-back would move with it.
   *
   * Counted at frame time from the live queue rather than replayed from the
   * forward switch, because a message queued after the switch is stamped with
   * the fallback tuple too and moves as well. Rendered as the concrete half of
   * the one-sentence rule: switching back moves queued messages too.
   *
   * An UPPER bound, not a guarantee, and for one reason: the switch-back
   * re-validates each item's tuple as it moves it (the item keeps its own
   * permission mode, which the preferred harness may not support) and leaves a
   * failing item where it is rather than failing the whole return. Counting
   * that here would mean a model-catalog read per queued item on every frame,
   * which is not what a derived DTO may cost. The forward `pendingFallback`
   * count has the identical property, so the two agree.
   */
  queuedItemsMoving: z.number().int().nonnegative(),
  /** When the offer surfaced, epoch ms. */
  offeredAt: z.number(),
});
export type PendingReturn = z.infer<typeof pendingReturnSchema>;

/**
 * The failed attempt the error card's manual rungs act on
 * (`chat.subscribe@1.10`, D152).
 *
 * `chat.fallback.runManualRung` is bound to the FAILED ATTEMPT rather than to a
 * traversal, and it needs both halves of that identity - `userMessageId` alone
 * cannot name an attempt, because the reuse path deliberately re-sends the same
 * persisted user message across retries. After the turn ends nothing on the
 * frame carried the pair: `activeTurn` has it only while the turn is running,
 * the persisted assistant record has a `turnId` and no edge back to its user
 * message, and the transcript row key `assistant:<turnId>` is a presentation
 * key a client must not mine for wire identity. So the card either had this or
 * had to guess, and a guess here re-runs the wrong turn.
 *
 * DEFINED IFF THE HOST WOULD ADMIT A RUNG. The value is present only when the
 * chat's latest attempt is a terminal failure that passes the same eligibility
 * chain `runManualFallbackRungLocked` walks - it is the latest attempt, nothing
 * is running, no dispatch-holding traversal is live, and a terminal traversal
 * record counts as a failure only when its settlement notifies failure
 * (D122/D133). Three of those four are host facts a renderer cannot see without
 * racing, and a client that re-derived them would be a second decider that
 * disagrees on exactly the frames that matter.
 *
 * What it deliberately does NOT answer is whether any PARTICULAR rung is
 * available for this failure's reason - that stays the verb's, which answers
 * `rung_unavailable`. The card renders when this value is defined and sends the
 * ids it was given; the verb remains the single authority on the rung itself.
 *
 * DERIVED per frame, never accumulated, and the key is always present on a live
 * frame so an `undefined` VALUE clears a card that is no longer offered - the
 * `pendingReturn` contract exactly (D102/D115).
 */
/**
 * Why a failed attempt is not offering a wait (`chat.subscribe@1.10`).
 *
 * HOST-AUTHORED, every value. A client must not derive any of these from the
 * failure payload: the host is the only party that knows the user's wait cap,
 * whether a boundary was VERIFIED rather than estimated, whether a reset probe
 * is running, and whether the attempt's replay envelope survives.
 */
export const fallbackWaitDispositionSchema = z.enum([
  /** A wait is on offer - `wait_once` is in `eligibleRungs`. */
  "eligible",
  /**
   * A provider reset probe for THIS attempt is in flight. Transient by
   * construction, and asserted only while one is actually running - never as a
   * placeholder for "the host has not looked".
   */
  "checking",
  /**
   * No verified reset boundary exists for the failed tuple: the provider named
   * none, or what exists is a gauge estimate. A wait on a guessed boundary
   * parks a chat on nothing, which is the one thing the wait rung may not do.
   */
  "no_verified_reset",
  /**
   * A verified boundary exists but is further out than the longest wait the
   * user's policy allows. `failure.resetsAt` carries that boundary - the
   * failure payload is read WITHOUT a cap, because when a limit resets is a
   * fact and whether to wait for it is a decision.
   */
  "beyond_cap",
  /**
   * The failed attempt's replay envelope is not available, so no wait can be
   * armed for it whatever the provider says. The envelope carries the billing
   * account the attempt ran under and the error block a waiting row anchors to;
   * arming without it would re-dispatch billed to the wrong account.
   */
  "attempt_unavailable",
]);
export type FallbackWaitDisposition = z.infer<
  typeof fallbackWaitDispositionSchema
>;

export const lastFailedAttemptSchema = z.object({
  /** The persisted user message the attempt ran. */
  userMessageId: z.string(),
  /** What distinguishes this attempt from a retry of the same message. */
  turnId: z.string(),
  /**
   * The typed failure, as the error block already carries it.
   *
   * Reused rather than flattened to a reason string: `resetsAt` +
   * `resetsAtSource` are exactly what the `wait_once` rung's boundary copy
   * needs, and they arrive here under the same guarantee the block gives - a
   * provider-reported or probe-read boundary only, never a gauge estimate - so
   * a card may render it as a time without qualifying it.
   */
  failure: agentFailureSchema,
  /**
   * Which manual rungs the host would admit for THIS failure, right now
   * (D156).
   *
   * Without it the value could be defined with nothing offerable and the card
   * would render three buttons that all answer `rung_unavailable` - `auth` is
   * exactly that shape. A client cannot compute this itself without building a
   * per-reason table that has to agree with the ladder's and disagrees on
   * exactly the frames that matter, which is the second-decider problem this
   * whole DTO exists to avoid.
   *
   * An UPPER BOUND, not a guarantee - the same contract as
   * `pendingReturn.queuedItemsMoving`. It is computed at frame time and is
   * therefore already stale when a click arrives, so
   * `chat.fallback.runManualRung` stays the sole authority and still answers
   * `rung_unavailable` on a race. What this buys is not correctness at the
   * click, which the verb owns; it is not offering a button that was never
   * going to work.
   *
   * MAY BE EMPTY, and a client must render no actions rather than falling back
   * to offering all three: empty means the host walked the chain and admitted
   * nothing, which is a different fact from an older host that never sent the
   * key at all (absent value, no card).
   *
   * `wait_once` is present iff the failure carries a verified `resetsAt` within
   * the policy's longest-wait cap. That is the verb's own rule rather than a
   * second one - the host computes it from the same guard chain
   * `runManualFallbackRungLocked` walks, so a rung offered here and a rung
   * accepted there cannot diverge. It is also why the cap never reaches the
   * client: a renderer that had to know the policy to decide whether to draw a
   * button would be re-deciding eligibility by another name.
   */
  eligibleRungs: z.array(z.enum(["retry", "switch", "wait_once"])),
  /**
   * Why `wait_once` is absent from {@link eligibleRungs}, or `eligible` when it
   * is present (`chat.subscribe@1.10`).
   *
   * ONE host decision, not a second opinion: the host computes this and
   * `eligibleRungs` in the same pass, so `eligible` holds if and only if
   * `wait_once` is in the array.
   *
   * ## Why the host has to say this
   *
   * Four different situations used to render as the same missing button, and
   * the only thing a card could reason from was `failure.resetsAt` - which is
   * PRESENT for a boundary beyond the user's cap and ABSENT for one the host
   * never verified. So the two states a user can actually do something about
   * (raise the cap; wait for the provider to report a boundary) looked
   * identical, and the state where a wait is genuinely impossible looked like
   * the state where it is merely far away.
   *
   * Rendering rule: explain when this is not `eligible`, and never infer any of
   * these from the failure payload. `beyond_cap` is the one value that pairs
   * with `failure.resetsAt` - the boundary IS known, and the payload carries it
   * uncapped - so a card may name the time and point at Settings. The cap
   * itself deliberately never reaches the client, for the reason
   * {@link eligibleRungs} gives.
   */
  waitDisposition: fallbackWaitDispositionSchema,
});
export type LastFailedAttempt = z.infer<typeof lastFailedAttemptSchema>;

/**
 * Which automatic outcome the host CONFIRMED (D215).
 *
 * One member per caller of the host's notice funnel
 * (`appendFallbackNoticeBlock`) - the enum is closed against the FUNNEL, not
 * against a curated subset, so a new appender cannot ship without widening
 * this. `return_unavailable` and `return_limited` are two members rather than
 * one because they are two different statements: the preferred provider is
 * gone, versus it is still rate limited. `superseded` is D134's row for a
 * traversal the user's own `agent.configure` ended - not a failure, but an
 * outcome all the same.
 */
export const fallbackOutcomeKindSchema = z.enum([
  "applied",
  "wait_resumed",
  "switched_back",
  "return_unavailable",
  "return_limited",
  "settled",
  "superseded",
]);
export type FallbackOutcomeKind = z.infer<typeof fallbackOutcomeKindSchema>;

export const fallbackOutcomeDetailSchema = z.object({
  label: z.string(),
  value: z.string(),
});
export type FallbackOutcomeDetail = z.infer<typeof fallbackOutcomeDetailSchema>;

/**
 * The last automatic fallback outcome the host confirmed, independent of
 * whether the transcript row carrying its notice is still in the bounded tail
 * (D215).
 *
 * ## Why this key exists at all
 *
 * Every automatic outcome is written as a provider-notice block appended to
 * `record.failed.assistantMessageId` and broadcast as a snapshot. That row is
 * the FAILED turn's row, so on a chat that has kept talking it falls out of the
 * bounded tail - and a consumer that must SPEAK a confirmed outcome then never
 * receives the notice body at all. Transcript residency is not a channel.
 *
 * ## Absence is not an outcome
 *
 * The key is cleared when a new traversal arms. Absent therefore means "no
 * confirmed outcome for the current incident" - it never means success,
 * cancellation or failure. Do not infer an outcome from this key
 * disappearing, and do not infer one from `pendingFallback` disappearing
 * either: terminal success, cancel and failure are all absent there too.
 */
export const lastFallbackOutcomeSchema = z.object({
  /**
   * The notice block's id: `<prefix>:<traversalId>[:<hop>]`, minted
   * deterministically so a replayed phase re-derives the same string and the
   * funnel's idempotence makes it unique for the life of the outcome. THE
   * dedupe key for a consumer that must speak an outcome exactly once.
   */
  blockId: z.string(),
  /**
   * The assistant row the notice was appended to. May be OUTSIDE the bounded
   * tail - that is the whole reason this key exists - so treat it as an anchor
   * for later hydration, never as a row that can be read from this frame.
   */
  assistantMessageId: z.string(),
  kind: fallbackOutcomeKindSchema,
  title: z.string(),
  /**
   * The notice's explanatory sentence, or `null` when the title is the whole
   * statement.
   *
   * Not decorative, and not droppable: `return_unavailable`, `return_limited`,
   * `settled` and `superseded` carry their reason HERE and nowhere else. For
   * `superseded` the host picks between two sentences on the settlement's own
   * `heldCount`, so without this field a consumer cannot tell a settle that
   * paused the user's queue from one that did not.
   */
  message: z.string().nullable(),
  details: z.array(fallbackOutcomeDetailSchema),
  /**
   * A counter over writes to this slot, starting at 1 and reset when a new
   * traversal arms.
   *
   * Deliberately NOT the traversal's revision, which cannot order these: the
   * settled notice is written BEFORE the terminal transition commits, so a
   * settle with no transition between it and the preceding hop carries the
   * identical revision, and a consumer ordering by it would see a tie where
   * there is a real sequence.
   *
   * It orders writes within ONE incident and nothing else - it restarts across
   * the clear, so `2` on this incident is not "after" `7` on the last. It is
   * not an identity either: {@link blockId} is, and it is globally unique, so a
   * consumer that dedupes on `blockId` needs nothing from this field, and one
   * that asks "is this frame newer than what I hold" gets a total order.
   */
  sequence: z.number().int().positive(),
});
export type LastFallbackOutcome = z.infer<typeof lastFallbackOutcomeSchema>;

// Historical snapshot field set. The live snapshot grows from this base;
// additions must not flow backwards into chat.subscribe 1.7.
const chatSnapshotSchemaV17 = z.object({
  chat: chatSchemaV18,
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
  // Frozen at the arms 1.7 shipped (no `fallback-wait`); the live snapshot
  // below re-binds the live union.
  backgroundItems: z.array(backgroundItemSchemaPreFallbackWait).optional(),
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
export const chatSnapshotSchema = chatSnapshotSchemaV17.extend({
  chat: chatSchema,
  backgroundItems: z.array(backgroundItemSchema).optional(),
  // The live fallback traversal, or absent when there is none
  // (`chat.subscribe@1.10`). Optional rather than nullable so an older host's
  // silence and a newer host's "no traversal" are the same value to a
  // renderer - see `pendingFallbackSchema`.
  pendingFallback: pendingFallbackSchema.optional(),
  // The switch-back offer, or absent when none has surfaced
  // (`chat.subscribe@1.10`). Same optionality contract as `pendingFallback`,
  // and stripped by the same pre-1.10 projection.
  pendingReturn: pendingReturnSchema.optional(),
  // The failed attempt the error card's rungs act on, or absent when the chat
  // is not in the state those rungs are for at all (`chat.subscribe@1.10`,
  // D152). NOT "absent when the host would not admit a rung" - that was true
  // until F6, and `waitDisposition` falsified it: the DTO's job now includes
  // saying why a rung is WITHHELD, so it is present in exactly the cases where
  // `eligibleRungs` is missing one. Same optionality contract and the same
  // pre-1.10 strip as the two above.
  lastFailedAttempt: lastFailedAttemptSchema.optional(),
  // The last CONFIRMED automatic outcome (`chat.subscribe@1.10`, D215). A
  // FOURTH explicit key on the same 1.10 gate and the same pre-1.10 strip.
  // Unlike the three above it is not derived from the live traversal - it
  // outlives the traversal that produced it and is cleared by the next ARM,
  // because its whole job is to be readable after the incident's transcript
  // row has left the bounded tail.
  lastFallbackOutcome: lastFallbackOutcomeSchema.optional(),
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
  // Rides this broadcast for the same reason `backgroundItems` does: every
  // transition the DTO describes is a turn-state transition too, so a separate
  // frame would be a second ordering to get wrong. Absent means "no traversal",
  // and unlike `backgroundItems` the renderer must NOT keep its last value -
  // that is how a settled traversal's card would outlive it.
  pendingFallback: pendingFallbackSchema.optional(),
  // Same rule, same reason: the banner must vanish when the offer is answered,
  // so an absent key CLEARS rather than preserving the last value.
  pendingReturn: pendingReturnSchema.optional(),
  // Same rule again (D152). The card must vanish when a replacement lands or a
  // traversal takes the chat back over, so an absent key CLEARS - a renderer
  // that kept its last value would offer Retry on a turn that has since
  // succeeded, which is the exact defect D122 closed on the host side.
  lastFailedAttempt: lastFailedAttemptSchema.optional(),
  // The last confirmed automatic outcome (D215). The clearing rule is the same
  // in mechanism and OPPOSITE in timing: an absent key clears, but this one is
  // cleared by the next ARM rather than by the traversal ending - a settled
  // traversal's outcome is exactly what a consumer still needs to speak.
  lastFallbackOutcome: lastFallbackOutcomeSchema.optional(),
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

// `1.6` shipped (cli-v1.2.0) binding the command shape as it then was, so it
// is pinned to the pre-relaunch literal: the live schema's
// `relaunchOnHostRestart` belongs to `1.7`+ only, and the host strips it for a
// `1.6` peer (`chat-frame-projection.ts`).
const chatSubscribeManagedCommandsChangedServerFrameSchemaV16 =
  managedCommandsChangedServerFrameSchema(managedCommandSchemaPreRelaunch);

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

// ─── Interview lifecycle frames ────────────────────────────────────────────
//
// Both frames changed on `1.7`, so each has a hand-frozen pre-`1.7` copy and a
// live one, and the common-frame factory below is parameterized over the pair.
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

// Live (`chat.subscribe@1.7`). `answers` carries selection evidence, and
// `delivery` is the content-free outbox projection for a DETACHED settlement,
// joined by `settlementId`. It rides the lifecycle frame - rather than
// requiring a fresh settlement - precisely so a `pending → delivering →
// delivered` transition can be broadcast without inventing a second settlement
// for the same answer. Defaulted null so an active waiter (which has no outbox
// item at all) is representable as "no delivery to speak of", never as failure.
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

// Live (`chat.subscribe@1.7`). `reason` stays exactly what it was - the
// user-visible text - and the canonical facts ride ALONGSIDE it: `outcome`
// distinguishes an explicit Skip from a genuine failure (both of which this
// frame has always represented identically), and `draftAnswers` carries the
// saved-but-unsent values a Skip may have kept. Both defaulted, so a host that
// settles without canonical metadata produces the pre-`1.7` meaning unchanged.
//
// TWO LIFECYCLE INVARIANTS ARE ENCODED, not merely documented, because this
// frame is where an untruthful combination would enter history:
//
//   1. `outcome` here is `skipped | failed | null` - never `answered`. An
//      answered interview settles through `interviewAnswered`; the same block
//      arriving as "errored but answered" is a contradiction no consumer
//      should have to reconcile.
//   2. `draftAnswers` are saved-but-unsent values from an explicit Skip, so
//      they are only meaningful when `outcome === "skipped"`. Drafts attached
//      to a failure or to an unknown outcome would make the card claim the
//      user saved work it has no basis for.
//
// Enforced with `superRefine` rather than a discriminated union, deliberately.
// A union here would make `Extract<ChatSubscribeServerFrame, { kind:
// "interviewErrored" }>` a union of three shapes, so every consumer -
// `ChatStreamCallbacks.onInterviewErrored`, the GUI chat store - would have to
// narrow before reading `reason`, a field whose meaning does not vary. That
// trades real ergonomic cost across the client for no additional safety: the
// refinement rejects the same payloads at the same boundary. This file's
// `chatQueuedItemSchema` records the mirror-image tradeoff for a case where
// the union genuinely was worth it.
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

// Common frame membership through chat.subscribe 1.8. Add newer frame kinds
// to the current list rather than changing this shared historical factory.
// Order-preserving factory for the common (non-blockDelta) shared frames. The
// three sender-bearing frames (`messageAccepted`/`queueChanged`/`eventAppended`)
// are parameterized so the released `chat.subscribe@1.0–1.3` lines can bind the
// pre-`inReplyTo` frozen chat-tree while the live line binds the current one;
// `action` is parameterized because `actionAck` echoes the action-kind enum,
// which grew on `1.6` (`stopBackgroundSession`) after `1.5` shipped; and the
// two interview lifecycle frames are parameterized because `1.7` grows both
// (selection evidence, canonical outcome, saved drafts, and the detached
// delivery projection).
// Everything else is byte-identical across live and frozen. Variant order is
// preserved (the wire-compat differ matches union variants by `kind`, but
// keeping order avoids churn in any order-sensitive fixture).
function buildChatSubscribeCommonServerFrameSchemas<
  MessageSchema extends z.ZodType,
  QueueSchema extends z.ZodType,
  EventSchema extends z.ZodType,
  ActionSchema extends z.ZodType,
  InterviewAnsweredSchema extends z.ZodType,
  InterviewErroredSchema extends z.ZodType,
  LeaseFields extends z.ZodRawShape,
>(schemas: {
  readonly message: MessageSchema;
  readonly queue: QueueSchema;
  readonly event: EventSchema;
  readonly action: ActionSchema;
  readonly interviewAnswered: InterviewAnsweredSchema;
  readonly interviewErrored: InterviewErroredSchema;
  /**
   * Extra `actionAck` members that exist only on the lines that mint them -
   * `{}` on every released family, the fallback grace-hold `token` on the live
   * one.
   *
   * Parameterized rather than defaulted onto the shared shape, which is the
   * mistake this parameter exists to prevent. `backgroundStopTaskIds` above
   * looks like a precedent for adding a defaulted key here, and is not: it is
   * in the released baseline already, so it reads as always-present to every
   * shipped peer. A key added to this factory TODAY lands on all eleven
   * bindings at once, and `released-baseline-compat` calls that breaking on
   * each released host→client slot - correctly, since a released host never
   * emits it and a consumer that assumes it is populated reads undefined.
   */
  readonly lease: LeaseFields;
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
      // For background stop-all, task ids whose provider stop request was accepted
      // even when the aggregate action is rejected for partial failure. Defaulted
      // so a `chat.subscribe@1.0` host (no background-items support) still
      // parses - it never emits a background-stop ack, so `[]` is the correct
      // reading, not a lossy fallback.
      backgroundStopTaskIds: z.array(z.string()).default([]),
      // `token` on the lines that mint a lease - see `lease` on the parameter
      // object above for why it arrives that way and not as a member here.
      ...schemas.lease,
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

// Frozen common frames bound to `chat.subscribe@1.7`-`1.9`: the pre-fallback
// action set, and no grace-hold lease on `actionAck`. `1.10` added both, so
// the live list below is built on its own rather than aliasing this one.
const chatSubscribeCommonServerFrameSchemasV18 =
  buildChatSubscribeCommonServerFrameSchemas({
    message: userMessageSchemaV18,
    queue: chatQueueStateSchema,
    event: chatEventSchema,
    action: chatActionSchemaV17ToV19,
    interviewAnswered: interviewAnsweredServerFrameSchema,
    interviewErrored: interviewErroredServerFrameSchema,
    lease: {},
  });

// The live common frames (`chat.subscribe@1.10`).
const chatSubscribeCommonServerFrameSchemas =
  buildChatSubscribeCommonServerFrameSchemas({
    message: userMessageSchema,
    queue: chatQueueStateSchema,
    event: chatEventSchema,
    action: chatActionSchema,
    interviewAnswered: interviewAnsweredServerFrameSchema,
    interviewErrored: interviewErroredServerFrameSchema,
    // The grace-hold LEASE minted by an accepted `fallback.holdForChoice`,
    // and the handle a later `chat.fallback.chooseTarget` presents to prove it
    // is acting on the hold it took. One live lease per traversal; a stale or
    // foreign token is rejected `CHOICE_LEASE_STALE` (`actionAck.code` is an
    // open string, so the new rejection codes need no enum growth).
    //
    // It rides the ACK rather than a frame of its own so the lease and the
    // acceptance are one message: a token delivered separately could arrive
    // after the client had already given up on the hold.
    lease: { token: z.string().nullable().default(null) },
  });

// Frozen common frames bound to `chat.subscribe@1.0–1.3` (pre-`inReplyTo`).
const chatSubscribeCommonServerFrameSchemasPreInReplyTo =
  buildChatSubscribeCommonServerFrameSchemas({
    message: userMessageSchemaPreInReplyTo,
    queue: chatQueueStateSchemaPreInReplyTo,
    event: chatEventSchemaPreInReplyTo,
    action: chatActionSchemaV15,
    interviewAnswered: interviewAnsweredServerFrameSchemaPreSettlement,
    interviewErrored: interviewErroredServerFrameSchemaPreSettlement,
    lease: {},
  });

// Frozen common frames bound to `chat.subscribe@1.4–1.5`: `inReplyTo` shipped
// in 1.4, but the message anchor remains on the pre-Reasonix union and the
// queue remains pre-managed-command. Released peers therefore cannot receive
// either an unknown harness discriminant or a managed-command queue item.
const chatSubscribeCommonServerFrameSchemasPreManagedCommand =
  buildChatSubscribeCommonServerFrameSchemas({
    message: userMessageSchemaPreReasonix,
    queue: chatQueueStateSchemaPreManagedCommand,
    // Frozen on both axes (pre-Reasonix actor, pre-`chat.imported` type):
    // an A2A chat event names the acting agent's harness, `eventAppended`
    // rides this released line, and a released client's strict enum accepts
    // neither the new harness nor the new event type.
    event: chatEventSchemaPreReasonix,
    action: chatActionSchemaV15,
    interviewAnswered: interviewAnsweredServerFrameSchemaPreSettlement,
    interviewErrored: interviewErroredServerFrameSchemaPreSettlement,
    lease: {},
  });

// Frozen for `chat.subscribe@1.2` and earlier.
const chatSubscribeSharedServerFrameSchemasV12 = [
  ...chatSubscribeCommonServerFrameSchemasPreInReplyTo,
  blockDeltaServerFrameSchema(runtimeEventSchemaV12PreInReplyTo),
];

// The shared frames `chat.subscribe@1.7`-`1.9` ship, unchanged across the
// three. `1.10` changed both halves - the fallback actions and lease token on
// the common frames, and the fallback notice kinds and error `failure` on
// `blockDelta` - so the live list is built from the live halves rather than
// extending this one. New frame kinds belong in the live list.
const chatSubscribeSharedServerFrameSchemasV18 = [
  ...chatSubscribeCommonServerFrameSchemasV18,
  blockDeltaServerFrameSchema(runtimeEventSchemaPreFallback),
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
 * ONLY SOUND ON THE FULL-SNAPSHOT LINE (`chatSubscribeFullSnapshotSchemaVersion`). The deep
 * message/event schemas carry compatibility defaults (`imageResolutions`,
 * `serviceTier`, …) that up-convert a down-negotiated host's pre-image
 * objects; the structural check skips them, so a `1.5` assistant message
 * would reach consumers with `imageResolutions` genuinely absent while typed
 * as present. A host serving the client's own live line emits fully live
 * shapes (its in-memory objects are post-parse normalized and its frame
 * projection is the identity on the live line), so the shallow path is
 * exact there — callers MUST fall back to the deep parse for any other
 * negotiated version, EXCEPT `1.6` — see the companion schema below.
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

// The client-frame options that precede the two interview actions. Split out
// (rather than written inline in one array) because `1.7` swaps ONLY the
// interview pair: keeping the surrounding options in their own consts lets the
// frozen `≤1.6` union and the live one be composed from the same pieces in the
// same order, instead of one being a hand-maintained copy of the other.
const chatSubscribeClientFrameSchemaOptionsBeforeInterview = [
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
    // A worktree staged in the composer (mid-chat "Create new worktree",
    // and — from the lifecycle minors — a draft rebind committed at
    // send) rides with the send so the host materializes it at
    // turn-start. Same `WorktreeIntent` shape as `worktree.create`.
    // `null` / absent ⇒ binding-as-stored (today).
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
    // worktree staged in the composer (create or draft rebind) must ride on
    // this frame just as it does on a normal send.
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
 * Explicit Skip intent (`chat.subscribe@1.7`), carried on the EXISTING
 * `interviewError` wire kind rather than a new action literal.
 *
 * `actionAck` echoes the action-kind enum back, so a new literal would be a
 * host→client surface change on a line that already has peers. The GUI is free
 * to call this affordance `interviewSkip`; on the wire it stays
 * `interviewError` with this intent attached, which is also what makes the
 * ≤`1.6` downgrade a pure field strip rather than an action rewrite.
 *
 * Its presence - not a match against the reason string - is what distinguishes
 * a deliberate Skip from an unanswerable-dismiss or a genuine error. Those two
 * omit the intent entirely.
 *
 * `draftAnswers` are saved-but-unsent values. The host persists them as
 * history and never forwards them to the harness/provider result, so a Skip
 * remains a Skip from the agent's point of view.
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

/**
 * Requeue the SAME durable detached delivery. `blockId` selects the visible
 * card; settlement and delivery ids are the immutable join guard, while the
 * generation proves the visible failure is still the current attempt.
 */
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

// The same drop-the-first-three destructure applied to the pre-interview
// segment alone, so the live `1.7` union can re-splice its own interview pair
// into the middle instead of inheriting the frozen one.
const [, , , ...chatSubscribeClientFrameSchemaMiddleOptions] =
  chatSubscribeClientFrameSchemaOptionsBeforeInterview;

// `1.6`: the session-scoped background stop - the escalation the renderer
// offers when a command item carries `individualStopUnavailable`. Kills the
// chat's provider session process, ending every background item in it. Live
// line only: a released ≤1.5 host has no handler for it, and the renderer's
// capability gate (the item field) means it never sends one there either.
const stopBackgroundSessionClientFrameSchema = z.object({
  kind: z.literal("stopBackgroundSession"),
  ...ownerActionFrameFields,
});

// `1.10`: the fallback grace card's "Choose differently…" menu opening.
//
// Freezes the remaining grace window so the countdown cannot expire under an
// open menu, and acks a lease token (`actionAck.token`). `traversalId` names
// what is being held; a hold for a traversal that has already advanced is
// rejected rather than freezing the wrong thing.
const fallbackHoldForChoiceClientFrameSchema = z.object({
  kind: z.literal("fallback.holdForChoice"),
  ...ownerActionFrameFields,
  traversalId: z.string(),
});

// The menu closing. Resumes the frozen remainder - as do subscriber detach,
// chat close and host restart, none of which send anything, which is why the
// host can never treat this frame as the only way a hold ends.
//
// `token` proves the release belongs to the hold that was taken: a second
// window that never held the lease must not be able to resume someone else's
// frozen window.
const fallbackReleaseChoiceClientFrameSchema = z.object({
  kind: z.literal("fallback.releaseChoice"),
  ...ownerActionFrameFields,
  traversalId: z.string(),
  token: z.string(),
});

// Frozen client frame of the `1.6` line as `host-v1.2.0-rc.1` shipped it.
// Exported for the same reason `chatSubscribeClientFrameSchemaV14ToV15` is:
// the host's stream resolver must parse a `1.6` connection against the
// contract it actually negotiated, so a stale or crafted peer cannot dispatch
// `1.7`-only action fields (Skip intent, saved drafts, selection evidence) on
// a line that has no handling for them.
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

// Frozen client frame of the `chat.subscribe@1.7`-`@1.9` lines - the `1.6`
// composition with the interview pair swapped for the enhanced one, and
// nothing else. Variant order is preserved so the two unions differ only where
// `1.10` genuinely differs.
//
// The `1.6` block above warned that "the next action added to the live client
// frame must pin `1.6` to its own frozen option list FIRST" - `1.6` already
// has one (`chatSubscribeClientFrameSchemaV16Options`), and this is the same
// pin one line up, for the same reason: the compat checker's oracle only
// guards host->client additions, so a new action appended to the LIVE list
// would otherwise silently join `1.7`-`1.9` and let a stale or crafted peer of
// those lines dispatch it.
const chatSubscribeClientFrameSchemaV17ToV19Options = [
  chatSubscribeClientFrameSchemaOptionsBeforeInterview[0].extend({
    worktreeIntent: worktreeIntentSchema.nullable().default(null),
    // Browser annotations entered on the `1.7` line. Every released 1.0–1.6
    // union above stays frozen without this field.
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

export const chatSubscribeClientFrameSchemaV17ToV19 = z.discriminatedUnion(
  "kind",
  chatSubscribeClientFrameSchemaV17ToV19Options,
);

// Live client frame (`chat.subscribe@1.10`) - the `1.7`-`1.9` composition
// plus the two fallback grace-hold actions.
const chatSubscribeClientFrameSchemaOptions = [
  ...chatSubscribeClientFrameSchemaV17ToV19Options,
  fallbackHoldForChoiceClientFrameSchema,
  fallbackReleaseChoiceClientFrameSchema,
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
// Exported so the host's stream resolver can parse a 1.4/1.5 connection
// against the contract it actually negotiated - the live schema would let a
// stale or crafted peer dispatch actions those lines do not contain (e.g.
// `stopBackgroundSession`).
export const chatSubscribeClientFrameSchemaV14ToV15 = z.discriminatedUnion(
  "kind",
  [
    ...chatSubscribeClientFrameSchemaBeforeV14Options,
    activeProfileUpdateClientFrameSchema,
  ],
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
//
// `1.5` shipped `chat.archivedAt` on the snapshot and `sameTurnSteeringSupported`
// on `activeTurn` (so the renderer can gate Cmd+Enter steering without
// duplicating the harness capability table) - but PRE-managed-command queue
// items. Pinned here so `1.6` cannot mutate this released line: the queue stays
// the plain prompt shape. `turnStateChanged` originally reused the live frame
// ("retro-pin if a later minor touches background items again") - `1.6`'s
// command stop-capability field did exactly that, so it now binds the `V15`
// pin below.
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

// The retro-pin the `1.5` doc comment above promised: `1.5` originally reused
// the live `turnStateChanged` frame, which was safe only while nothing
// touched background items. `1.6`'s command stop-capability field ends that -
// pinned with the pre-capability item union so the released line cannot
// observe it.
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
// pair that gives `managedCommand.deliverHeld` something to act on. The
// background-command stop capability (`individualStopUnavailable` on command
// items, the `stopBackgroundSession` action) rides this same unreleased line.
//
// Those last two arrived on a `1.7` opened above a `1.6` that was itself
// pinned to a hand-written pre-image bundle, so that the live schemas could
// grow without mutating it. The release collapsed the two: at that point no
// peer in the field had ever negotiated `1.6` or `1.7`, so a pre-image that
// froze `1.6` against `1.7` froze it against nothing, and shipping both minors
// would have announced two negotiable lines where one peer set exists.
//
// `host-v1.2.0` then SHIPPED this line, and the note the collapse left behind
// said exactly what to do next: "the moment `1.6` ships, or the moment a `1.7`
// opens above it, whichever comes first, this line must be re-pinned to a
// hand-written pre-image bundle the way `1.4` and `1.5` are above." Both have
// now happened, and this block is that re-pin. Every schema below is
// hand-frozen from the `host-v1.2.0` tag.
//
// Because that tag is STABLE, `1.6` needs no line-specific fixture: it is an
// ordinary released baseline. The `protocol-compat` CI workflow resolves it
// from `git ls-remote` and dumps its surface from the tag, and the local
// tripwire (`__fixtures__/released-baseline-surface.json`) now carries `1.6`
// as well. Both read the tag and never the working tree, so neither can be
// regenerated to green around drift in the schemas below - a red there means
// freeze the offending sub-schema here. The support floor stays at `1.0.0`
// with `includeReleaseCandidates: false`; with `1.6` stable there is no longer
// an RC that would need to look released.
// ─── Frozen `chat.subscribe@1.6` shape (pre-settlement + pre-Reasonix) ───
//
// The comment above described `1.6` as peerless and therefore safe to leave on
// the live schemas, on the reading that no released baseline carried a minor
// above `1.5`. That is not true: the committed
// `released-baseline-surface.json` (synced by #1385, on `main`) advertises
// `chat.subscribe` `latestMinor: 6` with a NINETEEN-id harness enum. A shipped
// client can negotiate `1.6` and strict-decodes exactly those ids, so Reasonix
// on this line is the same break as Reasonix on `1.5`.
//
// This is the re-pinning that comment asked for, on the trigger it named ("the
// moment a `1.7` opens above it"). Every leaf below is a hand-frozen
// pre-Reasonix copy of the LIVE shape - `1.6` shipped the full live surface, so
// these freeze the harness enum ONLY, not the shape.
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

// Same `z.union` (not `discriminatedUnion`) ordering rationale as the live
// `chatQueuedItemSchema`: managed-command arm first, legacy no-`kind` payloads
// fall through to the defaulted prompt arm.
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
  backgroundItems: z.array(backgroundItemSchemaPreFallbackWait).optional(),
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

// `turnStateChanged` carries no interview content, so `1.6` and the live line
// agree on it there. It is pinned regardless - for the reason the `1.5`
// retro-pin above records, and because `activeTurn.harnessId` DOES differ:
// `1.6`'s enum has no Reasonix id.
const chatSubscribeTurnStateChangedServerFrameSchemaV16 = z.object({
  kind: z.literal("turnStateChanged"),
  ...textFrameFields,
  ...chatReferenceFields,
  runStatus: chatRunStatusSchema,
  activeTurn: chatActiveTurnSchemaPreReasonix.nullable(),
  backgroundItems: z.array(backgroundItemSchemaPreFallbackWait).optional(),
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
    lease: {},
  });

const chatSubscribeServerFrameSchemaV16 = z.discriminatedUnion("kind", [
  chatSubscribeSnapshotServerFrameSchemaV16,
  chatSubscribeTurnStateChangedServerFrameSchemaV16,
  chatSubscribeManagedCommandsChangedServerFrameSchemaV16,
  chatSubscribeHeldUpdatesChangedServerFrameSchema,
  ...chatSubscribeCommonServerFrameSchemasV16,
  blockDeltaServerFrameSchema(runtimeEventSchemaPreSettlement),
]);

// `clientFrameSchema` is DELIBERATELY the live union, unlike the frozen
// serverFrame above. `1.6`'s action set is identical to the live one - diffing
// its clientFrame against the released baseline shows only the deliberate
// post-freeze enum adds (`reasonix`, `antigravity`) - so nothing is
// unrepresentable today, and the enum grows on a client→HOST slot, where a
// wider host is the safe direction.
//
// It is not free, though, and the compat checker cannot catch the regression:
// its oracle only guards host→client additions, so a new action appended to
// `chatSubscribeClientFrameSchemaOptions` would silently join this released
// line and let a stale or crafted `1.6` peer dispatch it. That is exactly why
// `chatSubscribeClientFrameSchemaV14ToV15` exists below.
//
// THEREFORE: the next action added to the live client frame must pin `1.6` to
// its own frozen option list FIRST. Doing that today means naming the five
// settings-bearing frames, which the positional destructure above
// (`const [, deleteMessageSuffixClientFrameSchema, , ...rest] = …`) currently
// leaves anonymous.
export const chatSubscribeV16 = defineStreamRpcContract({
  method: "chat.subscribe",
  schemaVersion: { major: 1, minor: 6 } as const,
  openRequestSchema: chatSubscribeOpenRequestSchema,
  serverFrameSchema: chatSubscribeServerFrameSchemaV16,
  clientFrameSchema: chatSubscribeClientFrameSchemaV16,
});

/**
 * The same shallow snapshot frame for a peer that negotiated `@1.6`.
 *
 * Opening `1.7` moved the live line, and without this a `1.6` full-chat
 * snapshot — the biggest frame this stream has, 10s–100s of MB — would fall
 * straight into the generic deep parser it was explicitly built to avoid.
 * That is a performance cliff for the entire shipped RC cohort, caused by a
 * change they cannot observe. So the fast path is retained per-line, not
 * per-"is this the newest line".
 *
 * `1.6` lacks interview settlement and browser payload fields, and this schema
 * walks NEITHER history that can carry them: `chat.messages` holds the
 * interview blocks, and `chat.events` holds the same settlement facts as
 * metadata on a durable event. Both are `z.custom(isStructuralRecord)` below,
 * so nothing here validates or strips what is inside either.
 *
 * So this is deliberately paired with `normalizeV16InterviewFieldsInFrame`,
 * which covers both — it delegates the message history to
 * `normalizeV16MessagesInShallowSnapshot` and walks the event log beside it.
 * Callers MUST run it on the whole frame before handing the snapshot to
 * consumers, and the two omissions fail DIFFERENTLY. Omitting the pass
 * entirely leaves consumers reading message fields typed as present that are
 * genuinely missing — the exact hazard the live schema's doc above describes.
 * Pairing this schema with the message pass ALONE repairs the messages and
 * still hands the event log to consumers carrying `1.7` metadata this line
 * cannot express; nothing reads as missing, which is why it went unnoticed.
 *
 * Every bounded envelope field is still validated deeply, against the FROZEN
 * `1.6` shapes, which is what makes this exact rather than merely permissive.
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
//
// `1.7` carries TWO independent reasons to exist. It is the
// interview-history line, and it is the line Reasonix rides: `1.6` turned out
// to be released with a nineteen-id harness enum, so neither the interview
// fields nor a new harness id could grow on it.
//
// Everything the interview work adds is additive and
// defaulted, and all of it exists so a settled interview can state what
// actually happened instead of leaving a renderer to infer it:
//
//   - `interviewAnswer.answers[]` and every persisted/streamed answer carry
//     `selection` — structured provenance for what the user actually picked.
//     `values` stays canonical and is still the only form a provider sees.
//   - `interviewError` carries optional Skip intent plus saved `draftAnswers`,
//     over the existing wire kind (see `interviewSkipIntentSchema` for why no
//     new action literal). Drafts are history; they never reach the harness.
//   - `interviewAnswered`/`interviewErrored` echo the canonical outcome, the
//     saved drafts, and the content-free detached `delivery` projection, so
//     `pending → delivered` needs no second settlement.
//   - Snapshot/message interview blocks expose `outcome`, `draftAnswers`,
//     answer evidence, settlement authority, diagnostics, and `delivery`.
//
// A `1.6` peer sees none of it: the frozen bundle above strips every field,
// and a new client talking to a `1.6` host must strip them on the way OUT too
// (`projectChatClientFrameForVersion`) — negotiation is the mechanism, not
// permissive unknown-field parsing.
//
// The harness half is the same story in the enum dimension: every
// harness-bearing leaf on `1.6` is pinned to the nineteen-id set above, and
// `1.7` and up admit the ids added since (`reasonix`, `antigravity`).
//
// ─── Frozen `chat.subscribe@1.7` shape ─────────────────────────────────────
//
// `host-v1.3.0` shipped `1.7`, so the `1.6` block's own rule applies to it
// verbatim: "the moment a `1.8`/`1.9` opens above it, this line must be
// re-pinned to a hand-written pre-image bundle". This is that re-pin. It holds
// back what `1.9` added - delivery placement, through `chatSchemaV18` - and
// what `1.10` added: the `fallback-wait` background item, the fallback DTO
// keys, the two fallback stream actions (in the ack's action enum and the
// client union), the grace-hold `actionAck.token`, and the fallback
// provider-notice kinds and error `failure` (through `contentBlockSchemaV18`
// and `runtimeEventSchemaPreFallback`). Every other leaf stays the live
// sub-schema, which is what `1.7` genuinely ships.
const chatSubscribeSnapshotServerFrameSchemaV17 = z.object({
  kind: z.literal("snapshot"),
  ...textFrameFields,
  ...chatReferenceFields,
  snapshot: chatSnapshotSchemaV17,
});

// Shared by `1.7`-`1.9`: the three lines agree on turn state, and all of them
// hold back the `fallback-wait` item and the fallback DTO keys.
const chatSubscribeTurnStateChangedServerFrameSchemaV17ToV19 = z.object({
  kind: z.literal("turnStateChanged"),
  ...textFrameFields,
  ...chatReferenceFields,
  runStatus: chatRunStatusSchema,
  activeTurn: chatActiveTurnSchema.nullable(),
  backgroundItems: z.array(backgroundItemSchemaPreFallbackWait).optional(),
  turnInProgress: z.boolean().optional(),
});

const chatSubscribeServerFrameSchemaV17 = z.discriminatedUnion("kind", [
  chatSubscribeSnapshotServerFrameSchemaV17,
  chatSubscribeTurnStateChangedServerFrameSchemaV17ToV19,
  chatSubscribeManagedCommandsChangedServerFrameSchema,
  chatSubscribeHeldUpdatesChangedServerFrameSchema,
  ...chatSubscribeSharedServerFrameSchemasV18,
]);

export const chatSubscribeV17 = defineStreamRpcContract({
  method: "chat.subscribe",
  schemaVersion: { major: 1, minor: 7 } as const,
  openRequestSchema: chatSubscribeOpenRequestSchema,
  serverFrameSchema: chatSubscribeServerFrameSchemaV17,
  clientFrameSchema: chatSubscribeClientFrameSchemaV17ToV19,
});

/**
 * The newest line whose snapshot embeds the whole chat record.
 *
 * This is what `chatSubscribeSnapshotServerFrameShallowSchema` is gated on,
 * and the two must move together: the shallow parse exists only to skip a deep
 * zod walk over `chat.messages` / `chat.events`, and the windowed line
 * (`1.8`, below) has neither array on its snapshot at all. So this is
 * deliberately NOT "the highest minor" — it is "the highest minor with an
 * unbounded snapshot", and it stops moving once later minors are windowed.
 *
 * Renamed from `chatSubscribeLiveSchemaVersion` when the windowed line opened,
 * because "live" had quietly come to mean two things: the newest negotiable
 * line, and the line whose shapes the shallow parse is exact for. `1.8` is
 * registered, so those have already come apart: the newest negotiable line is
 * `1.8` and this stays at `1.7`. The old name invited exactly the edit that
 * would have broken it, since it was declared "next to the live contract so a
 * future line bump cannot miss it". A future line bump MUST miss this one.
 */
export const chatSubscribeFullSnapshotSchemaVersion =
  chatSubscribeV17.schemaVersion;

// ─── The windowed `chat.subscribe@1.8` contract ────────────────────────────
//
// `1.8` stops shipping the transcript with the snapshot. See
// `subscribe-windowed.ts` for the design; the short version is that today's
// snapshot embeds the entire persisted chat (20-40 MB on a long one) and every
// one of the host's ~27 emit sites re-serializes it, so this line replaces that
// with a bounded snapshot, a row skeleton streamed in chunks, and ranges of
// bodies fetched on demand.
//
// **It is `1.7` plus windowing, not an alternative to it.** This line was
// drafted as `1.7` while `1.7` was still free, and the number was taken in the
// meantime by the interview-settlement + Reasonix line. Re-basing it was not a
// renumber: everything below binds the LIVE schemas by reference - the chat
// record through `chatRecordSchema`, the transcript through `messageSchema` /
// `chatEventSchema`, the aux frames through the shared frame lists - so a
// windowed peer sees canonical interview outcomes, answer selection evidence,
// saved drafts, the detached delivery projection, and the twentieth harness id
// exactly as a `1.7` peer does. Binding by reference is what makes that
// automatic, and it is the reason a released line must NOT do the same
// (`chatSchemaV14`'s comment, and the `1.6` freeze above).
//
// **Version implies behaviour.** There is no `windowed` flag and no
// full-snapshot mode on this line. Two behaviours behind one version is the
// arrangement where a host and a client can each believe the other is in the
// mode it is not; a peer too old for this negotiates `1.7` or below and the
// host serves it whole snapshots from its own fallback path.
//
// That is also why this union is built from scratch rather than by extending
// `chatSubscribeServerFrameSchema`: the two lines do not differ by a few added
// variants, they carry different snapshots. Sharing the aux frames (everything
// that is not about the transcript) is deliberate and is what keeps the
// renderer's reducers identical across the two modes.

const chatTranscriptWindowSchemaV18 = z.object({
  fromOrdinal: z.number().int().nonnegative(),
  rowIds: z.array(z.string()).optional(),
  incompleteRowIds: z.array(z.string()).optional(),
  messages: z.array(messageSchemaV18),
  events: z.array(chatEventSchema),
  rowContext: z.record(z.string(), transcriptRowContextSchema).optional(),
});

/**
 * The bounded snapshot.
 *
 * Aux state exactly as `1.7` sends it, with three substitutions and four
 * additions. The substitutions are the transcript itself (`chat` loses its two
 * arrays), the accumulated-changes panel (summaries now, contents on demand -
 * full file bodies were one of the larger byte offenders), and nothing else:
 * every field a renderer already reads keeps its name, its type, and its
 * optionality, because the zero-regression bar is about mixed-version fleets
 * and a reducer that has to branch per line is where that bar gets missed.
 *
 * `backgroundItems` in particular keeps `.optional()` even though every `1.8`
 * host populates it. Its optionality is a capability sentinel on the older
 * lines, and making it required here would fork the one reducer that reads it
 * for no gain.
 */
// The pre-placement envelope is fixed; 1.9 binds its own frozen bundle and
// 1.10 the current message schema.
const chatWindowedSnapshotSchemaV18 = z.object({
  /** The chat record WITHOUT `messages` / `events` — see `chatRecordSchema`. */
  chat: chatSchemaV18.omit({ messages: true, events: true }),
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
   * How many files the chat has touched. The SUMMARIES arrive on their own
   * chunked frames, for the reason the skeleton never joined the snapshot:
   * their count is a property of the chat's HISTORY, not of its current state,
   * and a broad refactor touches thousands. This count is what lets the panel
   * paint its collapsed header immediately and tell a complete list from a
   * lossy one when the final chunk lands.
   */
  accumulatedFileChangeCount: z.number().int().nonnegative(),
  // Frozen at the arms 1.8 shipped (no `fallback-wait`); the live snapshot
  // below re-binds the live union.
  backgroundItems: z.array(backgroundItemSchemaPreFallbackWait).optional(),
  managedCommands: z.array(managedCommandSchema).default([]),
  heldUpdates: z.array(heldManagedCommandUpdateSchema).default([]),
  turnInProgress: z.boolean().optional(),
  /**
   * The epoch every ordinal in this session is relative to. The host advances
   * it only when an ordinal no longer names the row it named before; appends
   * and in-place row updates retain it. A `range` response carrying a different
   * epoch is discarded rather than applied.
   */
  transcriptEpoch: z.number().int().nonnegative(),
  /**
   * How many rows the transcript has, so the client can size the scrollbar and
   * seat the tail before the skeleton has finished arriving — and so it can
   * tell a complete skeleton from a lossy one when the final chunk lands.
   */
  rowCount: z.number().int().nonnegative(),
  /**
   * The index revision this snapshot's skeleton corresponds to - see the same
   * field on the `indexChanged` frame.
   *
   * Present on EVERY snapshot, including an aux-only rebroadcast that
   * restreams no skeleton, and that is the case it is for: it is how a client
   * holding a same-epoch skeleton learns that deltas were emitted against it
   * which the client never saw. Without it a lost update-only frame followed
   * by any number of auxiliary snapshots leaves the client's stale body
   * looking perfectly current on both sides.
   *
   * `null` means the host holds no index for this subscriber and is about to
   * stream a fresh skeleton - a bootstrap, or a rebuild after a `resnapshot`.
   * There is nothing to compare against then, and a client that treated it as
   * a gap would void the window the chunks are about to fill and request
   * another resnapshot for it, which is a loop.
   */
  indexRevision: z.number().int().nonnegative().nullable(),
  /**
   * The hydrated tail. Always present, because the tail is where a live turn
   * happens and the client must paint it without a round trip.
   */
  tail: chatTranscriptWindowSchemaV18,
  /** Whole-transcript folds a windowed client cannot compute for itself. */
  derived: chatTranscriptDerivedSchema,
});
export const chatWindowedSnapshotSchema = chatWindowedSnapshotSchemaV18.extend({
  chat: chatRecordSchema,
  tail: chatTranscriptWindowSchema,
  backgroundItems: z.array(backgroundItemSchema).optional(),
  /**
   * The live fallback traversal (`chat.subscribe@1.10`), same shape and same
   * optionality as on the full snapshot.
   *
   * It has to be on BOTH, and that is not redundancy: a windowed snapshot is
   * built by `windowedSnapshotPayload` and never passes through the projection
   * the full snapshot uses, so a field added only to the full shape simply
   * never reaches a windowed subscriber - which today is every up-to-date peer.
   */
  pendingFallback: pendingFallbackSchema.optional(),
  /** The switch-back offer, on both snapshot shapes for the same reason. */
  pendingReturn: pendingReturnSchema.optional(),
  /**
   * The failed attempt the rungs act on, on both snapshot shapes for the same
   * reason (D152) - the windowed payload is what every up-to-date peer
   * actually receives, so a field added only to the full shape reaches nobody.
   */
  lastFailedAttempt: lastFailedAttemptSchema.optional(),
  /**
   * The last confirmed automatic outcome (D215), on both snapshot shapes for
   * the same reason as the three above - and it matters MORE here than for
   * them, because the windowed payload is precisely the shape whose bounded
   * tail drops the notice row this key exists to survive.
   */
  lastFallbackOutcome: lastFallbackOutcomeSchema.optional(),
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
   * The epoch AFTER the change — what subsequent `loadRange`s must carry.
   *
   * Unchanged from the previous frame for an `appended` or `updated` change,
   * because neither renumbers an ordinal: the epoch versions the COORDINATE
   * SPACE, not the index's content. It advances on `reindexed`, which is
   * exactly the case where a client's in-flight `range` must be discarded.
   */
  epoch: z.number().int().nonnegative(),
  /** Row count after the change, kept in step with the snapshot's field. */
  rowCount: z.number().int().nonnegative(),
  /**
   * A per-epoch counter of index deltas, incremented by every frame the host
   * emits and restarted at 0 by the snapshot that seats a fresh index.
   *
   * ## What it makes detectable
   *
   * The pump is allowed to drop a queued frame on a non-deterministic send
   * failure while the stream survives, and backpressure compaction drops
   * queued `indexChanged` frames by design. For an `appended` change the loss
   * is self-announcing: `rowCount` moves, and the client's own append
   * accounting notices it.
   *
   * An `updated`-only change moves NOTHING observable. Same epoch (an update
   * renumbers no ordinal), same `rowCount` (it adds no row), and later
   * same-epoch snapshots retain the existing skeleton rather than restreaming
   * it. So a lost update-only frame left the client rendering a superseded
   * body indefinitely - and a visible row's span is protected from eviction,
   * so the ordinary churn that would have refetched it never fires either.
   *
   * A client that sees a gap here re-requests the index instead. Cheap enough
   * to spend on every frame: one small integer against the alternative of a
   * transcript that is quietly wrong at one row.
   *
   * Deliberately NOT the epoch. The epoch versions the coordinate SPACE, and
   * conflating "your ordinals moved" with "you missed an edit" would force a
   * full rebase for a one-row body change - the O(history) frame this whole
   * line exists to remove.
   */
  indexRevision: z.number().int().nonnegative(),
  /**
   * Every change this frame applies, atomically. See
   * {@link chatIndexChangeSchema} for why a mutation is routinely two of them
   * and why splitting them across frames is unsafe.
   */
  changes: z.array(chatIndexChangeSchema),
});

const chatSubscribeRangeServerFrameSchema = z.object({
  kind: z.literal("range"),
  ...textFrameFields,
  ...chatReferenceFields,
  range: chatRangeResponseSchema,
});

const chatRangeResponseSchemaV18 = z.object({
  // Reuse this unchanged scalar validator, not the live response's field set.
  requestId: chatRangeResponseSchema.shape.requestId,
  epoch: z.number().int().nonnegative(),
  fromOrdinal: z.number().int().nonnegative(),
  rowIds: z.array(z.string()),
  incompleteRowIds: z.array(z.string()).optional(),
  messages: z.array(messageSchemaV18),
  events: z.array(chatEventSchema),
  rowContext: z.record(z.string(), transcriptRowContextSchema).default({}),
  reachedStart: z.boolean(),
  reachedEnd: z.boolean(),
  truncatedAtOrdinal: z.number().int().nonnegative().optional(),
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

// ─── Frozen `chat.subscribe@1.8` shape (pre-fallback) ─────────────────────
//
// `1.9` is the windowed line as the `v1.3.x` staging builds shipped it:
// Antigravity anchors and delivery placement, no provider fallback. It bound
// the live windowed frames by reference until provider fallback took `1.10`
// above it, and it holds back exactly what `1.10` adds.
//
// The windowed line is the one where "freeze the notice enum" is genuinely
// THREE bindings, not one: message bodies reach a peer on the snapshot's
// tail, on a `range` response, AND on a live `blockDelta` upsert. That is
// round-4 finding F1, and it is why `chatTranscriptWindowSchemaPreFallback` /
// `chatRangeResponseSchemaPreFallback` exist beside the frozen event union
// rather than the upsert being frozen alone. Their `rowContext` stays live,
// which is what lets an Antigravity anchor reach this line.
//
// `chatRecordSchema` needs no freeze: it is `chatSchema` with `messages` and
// `events` omitted, so no notice kind can reach a `1.9` peer through it.
const chatWindowedSnapshotSchemaV19 = z.object({
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
  accumulatedFileChangeCount: z.number().int().nonnegative(),
  backgroundItems: z.array(backgroundItemSchemaPreFallbackWait).optional(),
  managedCommands: z.array(managedCommandSchema).default([]),
  heldUpdates: z.array(heldManagedCommandUpdateSchema).default([]),
  turnInProgress: z.boolean().optional(),
  transcriptEpoch: z.number().int().nonnegative(),
  rowCount: z.number().int().nonnegative(),
  indexRevision: z.number().int().nonnegative().nullable(),
  tail: chatTranscriptWindowSchemaPreFallback,
  derived: chatTranscriptDerivedSchema,
});

const chatSubscribeServerFrameSchemaV19 = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("snapshot"),
    ...textFrameFields,
    ...chatReferenceFields,
    snapshot: chatWindowedSnapshotSchemaV19,
  }),
  chatSubscribeSkeletonChunkServerFrameSchema,
  chatSubscribeAccumulatedChangesServerFrameSchema,
  chatSubscribeIndexChangedServerFrameSchema,
  z.object({
    kind: z.literal("range"),
    ...textFrameFields,
    ...chatReferenceFields,
    range: chatRangeResponseSchemaPreFallback,
  }),
  chatSubscribeTurnStateChangedServerFrameSchemaV17ToV19,
  chatSubscribeManagedCommandsChangedServerFrameSchema,
  chatSubscribeHeldUpdatesChangedServerFrameSchema,
  ...chatSubscribeSharedServerFrameSchemasV18,
]);

/**
 * Frozen windowed server frame as `cli-v1.3.0` / `host-v1.3.0` shipped `@1.8`.
 *
 * Against `@1.9`, the difference is delivery placement and the anchor union
 * reachable through `rowContext` on the two arms that carry one: 1.3.0 was cut
 * before Antigravity, so a released `@1.8` peer's `discriminatedUnion` has
 * twenty arms and rejects a frame carrying the twenty-first outright - the
 * whole frame, not the one row.
 *
 * Built from the pre-placement checkpoint (whose message bodies also hold back
 * `@1.10`'s fallback notice kinds and `failure`), overriding the two
 * anchor-bearing arms, plus the turn-state and shared frames `@1.7`-`@1.9`
 * ship. `@1.9` adds Antigravity anchors and delivery placement; `@1.10` adds
 * provider fallback.
 */
export const chatSubscribeWindowedServerFrameSchemaPreAntigravity =
  z.discriminatedUnion("kind", [
    chatSubscribeWindowedSnapshotServerFrameSchema.extend({
      snapshot: chatWindowedSnapshotSchemaV18.extend({
        tail: chatTranscriptWindowSchemaV18.extend({
          rowContext: z
            .record(z.string(), transcriptRowContextSchemaPreAntigravity)
            .optional(),
        }),
      }),
    }),
    chatSubscribeSkeletonChunkServerFrameSchema,
    chatSubscribeAccumulatedChangesServerFrameSchema,
    chatSubscribeIndexChangedServerFrameSchema,
    chatSubscribeRangeServerFrameSchema.extend({
      range: chatRangeResponseSchemaV18.extend({
        rowContext: z
          .record(z.string(), transcriptRowContextSchemaPreAntigravity)
          .default({}),
      }),
    }),
    chatSubscribeTurnStateChangedServerFrameSchemaV17ToV19,
    chatSubscribeManagedCommandsChangedServerFrameSchema,
    chatSubscribeHeldUpdatesChangedServerFrameSchema,
    ...chatSubscribeSharedServerFrameSchemasV18,
  ]);

/**
 * Ask for a span of bodies.
 *
 * Not an owner action: it carries no `clientActionId` and is never acked,
 * because it is a READ. A viewer scrolling a chat they do not own must be able
 * to hydrate what they are looking at, and routing that through the action
 * machinery would gate it on `canAct` and mint an ack per scroll.
 */
const loadRangeClientFrameSchema = z.object({
  kind: z.literal("loadRange"),
  ...textFrameFields,
  ...chatReferenceFields,
  request: chatLoadRangeRequestSchema,
});

/**
 * Re-base from scratch: a fresh bounded snapshot and a fresh skeleton.
 *
 * The client's recovery path for the cases where its own index cannot be
 * trusted — a reconnect, an epoch it never saw the `indexChanged` for, a
 * `reindexed` change. A read, so it is not an owner action either.
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

// The frozen `1.8`/`1.9` client union - the pre-fallback action set plus the
// two windowed reads. Declared here rather than beside the frozen server
// bundles above because the two read frames are `const`s declared between the
// two, and a frozen union may not reference them before they initialize.
export const chatSubscribeWindowedClientFrameSchemaV18ToV19 =
  z.discriminatedUnion("kind", [
    ...chatSubscribeClientFrameSchemaV17ToV19Options,
    loadRangeClientFrameSchema,
    resnapshotClientFrameSchema,
  ]);

/**
 * The windowed line.
 *
 * **Registered in `hostStreamRpcRegistry`, and that registration IS the
 * switch.** Stream minors are negotiated to the highest the two peers share,
 * so every `1.8`-capable GUI talking to a `1.8`-capable host now lands here;
 * anything older settles on its own minor and is served whole snapshots by the
 * legacy handlers. It was held out of the registry until this contract, the
 * host's windowed producers and the GUI's windowed appliers could land
 * together, because registering it alone would have left both sides
 * negotiating a line neither implements - on the one stream where a broken
 * subscribe means a blank chat.
 */
export const chatSubscribeV18 = defineStreamRpcContract({
  method: "chat.subscribe",
  schemaVersion: { major: 1, minor: 8 } as const,
  openRequestSchema: chatSubscribeOpenRequestSchema,
  serverFrameSchema: chatSubscribeWindowedServerFrameSchemaPreAntigravity,
  clientFrameSchema: chatSubscribeWindowedClientFrameSchemaV18ToV19,
});

/**
 * The windowed line, with Antigravity session anchors and delivery placement -
 * frozen as the `v1.3.x` staging builds shipped it.
 *
 * `@1.8` shipped in 1.3.0 and is frozen at the twenty-arm anchor union; this
 * is the first minor whose `rowContext` may carry an Antigravity anchor and
 * whose notification blocks carry recorded delivery placement. The windowing
 * design and open request are shared by reference; the server and client
 * frames are the frozen pre-fallback bundles, because provider fallback
 * re-minted above this line at `@1.10` rather than folding into it.
 *
 * Streams have no downgrade bridge, so the host must GATE on the negotiated
 * minor: an `@1.8` subscriber gets rows whose `sessionAnchor` is withheld
 * rather than a frame it cannot decode. That projection is
 * `projectChatHistoryForSchemaVersion` in the internal repo's
 * `traycer-host/src/domain/chat/chat-frame-projection.ts`, applied at
 * `emitWindowedFrameToSubscriber` - the same per-minor discipline
 * `chatSubscribeClientFrameSchemaForVersion` already applies in the client
 * direction.
 *
 * A SECOND, independent gate covers the harness id itself:
 * `HARNESS_MINIMUM_CHAT_SUBSCRIBE_MINOR` refuses to serve an Antigravity CHAT
 * below `1.9` at all. The two are not redundant - that one keys on the chat's
 * harness, this one on an anchor that can appear on a row of a chat the peer
 * can otherwise render.
 */
export const chatSubscribeV19 = defineStreamRpcContract({
  method: "chat.subscribe",
  schemaVersion: { major: 1, minor: 9 } as const,
  openRequestSchema: chatSubscribeOpenRequestSchema,
  serverFrameSchema: chatSubscribeServerFrameSchemaV19,
  clientFrameSchema: chatSubscribeWindowedClientFrameSchemaV18ToV19,
});

// ─── The live `chat.subscribe@1.10` contract ───────────────────────────────
//
// `1.9` plus provider fallback. WINDOWED, like `1.8` and unlike everything
// below it: registering a full-snapshot line above the windowed one would
// silently move every up-to-date peer back onto whole-transcript snapshots,
// which is the regression the windowed line exists to remove. So `1.10` binds
// the live windowed frames and `chatSubscribeFullSnapshotSchemaVersion` stays
// at `1.7`, exactly as its own doc says it must.
//
// What this line adds. Everything in the list below is host-gated so a lower
// peer never observes it; the lease `token` is not, and the paragraph after
// the list states what holds it back instead:
//
//   - the `fallback-wait` background item (a chat parked on a rate-limit
//     reset), which the host degrades OUT of a `≤1.9` peer's
//     `backgroundItems` rather than sending;
//   - the `fallback.holdForChoice` / `fallback.releaseChoice` stream actions,
//     which a `≤1.9` peer cannot dispatch: the host parses each client frame
//     against the union that peer negotiated, where neither exists, and drops
//     it as malformed before any session sees it;
//   - every provider-fallback attribution notice kind (`fallback_applied`,
//     `fallback_returned`, `fallback_return_blocked`, `fallback_wait_resumed`,
//     `fallback_settled`), which `chat-frame-projection.ts` strips for any peer
//     whose negotiated minor does not bind them - on live upserts, on persisted
//     snapshot bodies, and on the windowed tail/range bodies. The strip is
//     written as an allow-list read off the frozen enums, so a kind added after
//     this line was written is covered without editing it;
//   - the `pendingFallback`, `pendingReturn`, `lastFailedAttempt` and
//     `lastFallbackOutcome` DTOs on both snapshot shapes and on
//     `turnStateChanged`, stripped as whole KEYS by the same projection - both
//     funnels, since the windowed snapshot has its own producer.
//
// The grace-hold lease `token` on `actionAck` is NOT stripped: the host puts
// the key on every ack at every minor. A non-null token is minted only by an
// accepted `fallback.holdForChoice`, and that ack - first emission or replay
// to a re-sender - goes only to a connection that sent that frame, which the
// drop above confines to `1.10` and later. Every other ack carries
// `token: null`, and a `≤1.9` decoder drops the key as an unknown member (the
// frozen `actionAck` is built with `lease: {}` and is not strict).
//
// The typed `failure` payload on `error` / `turn.interrupted` and the
// persisted `error` block is held back by every frozen line's SCHEMA
// (`errorBlockSchemaPreFallback`, `runtimeEventSchemaPreFallback`) but is not
// stripped by the host: it is an additive-optional member, so a lower peer's
// deep decoder drops it as an unknown key and the shallow/raw paths carry it
// uninspected. What older lines owe it is tolerance, not stripping.
export const chatSubscribeV110 = defineStreamRpcContract({
  method: "chat.subscribe",
  schemaVersion: { major: 1, minor: 10 } as const,
  openRequestSchema: chatSubscribeOpenRequestSchema,
  serverFrameSchema: chatSubscribeWindowedServerFrameSchema,
  clientFrameSchema: chatSubscribeWindowedClientFrameSchema,
});
