import { commonRecordRegistry } from "@traycer/protocol/common/registry";
import { providerWorkspaceSchema } from "@traycer/protocol/common/workspace-association";
import {
  DEFAULT_ACCOUNT_CONTEXT,
  accountContextSchema,
} from "@traycer/protocol/common/schemas";
import { guiHarnessIdSchema } from "@traycer/protocol/host/agent/shared";
import { getRecordSchema } from "@traycer/protocol/framework/index";
import {
  interviewAnswerSchema,
  interviewQuestionOptionSchema,
  interviewQuestionSchema,
} from "@traycer/protocol/persistence/epic/schemas";
import {
  agentMessageSendSchema,
  artifactOperationActionSchema,
  backgroundTaskOutputSchema,
  diffSourceSchema,
  fileEditReasonSchema,
} from "@traycer/protocol/persistence/epic/content-blocks";

export {
  agentMessageSendSchema,
  backgroundTaskOutputSchema,
  diffSourceSchema,
  fileEditReasonSchema,
  type AgentMessageSend,
  type BackgroundTaskOutput,
  type DiffSource,
  type FileEditReason,
} from "@traycer/protocol/persistence/epic/content-blocks";
import { z } from "zod";

const attachmentMentionAttrsSchema = getRecordSchema(
  commonRecordRegistry,
  "attachment-mention-attrs",
  "latest",
);

const jsonContentSchema = getRecordSchema(
  commonRecordRegistry,
  "json-content",
  "latest",
);

// Canonical artifact-kind vocabulary, reused for the `artifact_operation` event
// so the wire kind matches the persisted block kind (both resolve from the same
// `epic-artifact-kind` registry record).
const artifactOperationKindSchema = getRecordSchema(
  commonRecordRegistry,
  "epic-artifact-kind",
  "latest",
);

export const runtimeTokenUsageSchema = z.object({
  // Raw per-call SDK fields. Semantics differ across harnesses (Anthropic
  // treats input_tokens as NEW input with cache_read/cache_creation as
  // separate additive buckets; OpenAI treats input_tokens as the full input
  // with cached_input_tokens as a SUBSET) - the chip MUST NOT compute the
  // context-window denominator from these alone, or it will double-count
  // cache reads on OpenAI-style adapters. Use `contextTokens` instead.
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  cacheReadInputTokens: z.number().optional(),
  cacheCreationInputTokens: z.number().optional(),
  /**
   * Adapter-normalized "tokens currently occupying the context window" -
   * the canonical numerator for the "% context left" chip. Each adapter
   * computes this from its SDK's per-call snapshot (NOT the cumulative
   * thread total) and resolves its own cache-vs-input semantics, so the
   * renderer can divide `contextTokens / contextWindow` without knowing
   * which SDK produced the event. Optional only so legacy harness paths
   * that don't yet populate it parse cleanly; the chip hides without it.
   */
  contextTokens: z.number().optional(),
  /**
   * Model context window for this turn. Adapters source this from their
   * own SDK (Claude: `getContextUsage().rawMaxTokens`; Codex:
   * `tokenUsage.modelContextWindow`; OpenCode: `model.limit.context`).
   * Never hardcoded - if the SDK doesn't expose it, the chip hides.
   */
  contextWindow: z.number().optional(),
  /**
   * Tokens that are ALWAYS present in the window regardless of conversation
   * length (fixed system prompt + tool instructions). Adapters set this only
   * when `contextTokens` excludes that fixed baseline; the renderer folds it
   * into the displayed used total while keeping `contextWindow` as the reported
   * model capacity. Omitted (treated as 0) by harnesses with no separate
   * baseline convention.
   */
  contextBaselineTokens: z.number().optional(),
  /**
   * Cumulative billed cost for the turn in USD. Populated only where the SDK
   * reports it (Claude: `SDKResultSuccess.total_cost_usd`; OpenCode:
   * `StepFinishPart.cost` where available). Omitted by harnesses that don't
   * surface a price (Codex/Cursor); the cost chip hides without it.
   */
  costUsd: z.number().optional(),
});
export type RuntimeTokenUsage = z.infer<typeof runtimeTokenUsageSchema>;

export const runtimePermissionModeSchema = z.enum([
  "supervised",
  "auto_accept_edits",
  "full_access",
]);
export type RuntimePermissionMode = z.infer<typeof runtimePermissionModeSchema>;

export const runtimeImageAttachmentSchema = attachmentMentionAttrsSchema.omit({
  contextType: true,
});
export type RuntimeImageAttachment = z.infer<
  typeof runtimeImageAttachmentSchema
>;

export const runtimeSessionInfoSchema = z.object({
  id: z.string(),
  harnessId: guiHarnessIdSchema,
  createdAt: z.number(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type RuntimeSessionInfo = z.infer<typeof runtimeSessionInfoSchema>;

export const runtimeApprovalDecisionSchema = z.object({
  approved: z.boolean(),
  reason: z.string().optional(),
});
export type RuntimeApprovalDecision = z.infer<
  typeof runtimeApprovalDecisionSchema
>;

export const runtimeApprovalRequestSchema = z.object({
  approvalId: z.string(),
  toolName: z.string(),
  description: z.string(),
  input: z.unknown().optional(),
});
export type RuntimeApprovalRequest = z.infer<
  typeof runtimeApprovalRequestSchema
>;

/**
 * Reasoning effort on the wire is a free-form string. Each harness advertises
 * its model's selectable levels via `supportedReasoningEfforts` on the
 * model-list response (sourced from the provider SDK at list time), and
 * adapters validate the chosen value at their own SDK boundary. Keeping the
 * wire open lets new provider levels (e.g. `"minimal"`, `"none"`,
 * `"extra-high"`) flow through without a protocol bump.
 *
 * `null` is reserved for non-reasoning models that bypass reasoning entirely
 * and is distinct from an explicit `"none"` level a provider may expose as a
 * selectable variant.
 */
export const runtimeReasoningEffortSchema = z.string().nullable();
export type RuntimeReasoningEffort = z.infer<
  typeof runtimeReasoningEffortSchema
>;

export const runtimeSlashInvocationSchema = z.object({
  kind: z.enum(["slash-command", "skill"]),
  name: z.string(),
  arguments: z.string(),
  path: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type RuntimeSlashInvocation = z.infer<
  typeof runtimeSlashInvocationSchema
>;

export const runtimeAgentRunInputSchema = z.object({
  harnessId: guiHarnessIdSchema,
  prompt: z.string(),
  contextPrelude: z.string().nullable().default(null),
  sessionId: z.string().nullable().default(null),
  // Concrete model slug the run executes; resolved upstream (the renderer/
  // caller always selects a real model - there is no "use the harness default"
  // sentinel anymore).
  model: z.string().min(1),
  reasoningEffort: runtimeReasoningEffortSchema.default(null),
  serviceTier: z.string().nullable().default(null),
  imageAttachments: z.array(runtimeImageAttachmentSchema).default([]),
  permissionMode: runtimePermissionModeSchema,
  // Live provider launch/workspace payload for this turn. This must be derived
  // from the current visible binding, not copied from session history.
  providerWorkspace: providerWorkspaceSchema,
  systemPrompt: z.string().nullable().default(null),
  slashInvocation: runtimeSlashInvocationSchema.nullable().default(null),
  // Billing/account context for the turn, sourced from the turn-bearing frame's
  // `accountContext` (a global app-wide selection), not from per-chat
  // `chatRunSettings`. The Traycer harness threads this to its per-user
  // OpenCode server so the inference call bills the right account; other
  // harnesses ignore it.
  accountContext: accountContextSchema.default(DEFAULT_ACCOUNT_CONTEXT),
});
export type RuntimeAgentRunInput = z.infer<typeof runtimeAgentRunInputSchema>;

export const runtimeTodoStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);
export type RuntimeTodoStatus = z.infer<typeof runtimeTodoStatusSchema>;

export const runtimeTodoItemSchema = z.object({
  id: z.string().optional(),
  text: z.string(),
  status: runtimeTodoStatusSchema,
  priority: z.string().optional(),
  activeForm: z.string().optional(),
});
export type RuntimeTodoItem = z.infer<typeof runtimeTodoItemSchema>;

export const runtimePlanStatusSchema = z.enum([
  "drafting",
  "ready",
  "awaiting_approval",
  "approved",
  "rejected",
  "superseded",
]);
export type RuntimePlanStatus = z.infer<typeof runtimePlanStatusSchema>;

export const runtimePlanSourceSchema = z.object({
  harnessId: guiHarnessIdSchema,
  sessionId: z.string().nullable(),
  turnId: z.string().nullable(),
  kind: z.string(),
});
export type RuntimePlanSource = z.infer<typeof runtimePlanSourceSchema>;

export const runtimePlanStepSchema = z.object({
  id: z.string().nullable(),
  text: z.string(),
  status: runtimeTodoStatusSchema,
  activeForm: z.string().nullable(),
});
export type RuntimePlanStep = z.infer<typeof runtimePlanStepSchema>;

export const runtimePlanActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  decision: z.enum(["approve", "reject", "dismiss"]),
  variant: z.enum(["primary", "secondary", "danger"]),
});
export type RuntimePlanAction = z.infer<typeof runtimePlanActionSchema>;

export const runtimePlanContentRefSchema = z.object({
  kind: z.literal("plan_content"),
  hash: z.string(),
});
export type RuntimePlanContentRef = z.infer<typeof runtimePlanContentRefSchema>;

// Interview option/question/answer shapes are shared with the persistence
// layer - see `interviewQuestionOptionSchema`, `interviewQuestionSchema`,
// `interviewAnswerSchema` in `protocol/persistence/epic/schemas.ts`. The
// runtime aliases re-export those schemas/types so wire frames and stored
// chat history use one canonical shape (nullable string fields, not
// optional). Producers must emit `null` for absent values.
export const runtimeInterviewQuestionOptionSchema =
  interviewQuestionOptionSchema;
export type RuntimeInterviewQuestionOption = z.infer<
  typeof runtimeInterviewQuestionOptionSchema
>;

export const runtimeInterviewQuestionSchema = interviewQuestionSchema;
export type RuntimeInterviewQuestion = z.infer<
  typeof runtimeInterviewQuestionSchema
>;

export const runtimeInterviewAnswerSchema = interviewAnswerSchema;
export type RuntimeInterviewAnswer = z.infer<
  typeof runtimeInterviewAnswerSchema
>;

const baseRuntimeEventFields = {
  blockId: z.string(),
  timestamp: z.number(),
  // Owner of this event for nested rendering. When set, the produced block is
  // a CHILD of the block with this id (currently: a subagent's own tool_call /
  // file_change activity nests under its `subagent.*` block, keyed by the
  // subagent's task id). Absent/null for top-level (main-agent) activity.
  parentBlockId: z.string().nullish(),
} as const;

export const textDeltaEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("text.delta"),
  delta: z.string(),
});
export type TextDeltaEvent = z.infer<typeof textDeltaEventSchema>;

export const textCompletedEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("text.completed"),
});
export type TextCompletedEvent = z.infer<typeof textCompletedEventSchema>;

export const reasoningDeltaEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("reasoning.delta"),
  delta: z.string(),
});
export type ReasoningDeltaEvent = z.infer<typeof reasoningDeltaEventSchema>;

export const reasoningCompletedEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("reasoning.completed"),
});
export type ReasoningCompletedEvent = z.infer<
  typeof reasoningCompletedEventSchema
>;

export const toolCallStartedEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("tool_call.started"),
  toolName: z.string(),
  input: z.unknown().optional(),
  agentMessageSend: agentMessageSendSchema.nullable().default(null),
  // Explicit call/task start time. Optional so older emitters remain valid; the
  // accumulator falls back to the event timestamp when absent.
  startedAt: z.number().optional(),
  // True when this call is a backgrounded command/Monitor (Bash with
  // `run_in_background`, or the Monitor tool). Stamped at started so the
  // persistent block marker is set before any terminal path.
  backgroundTask: z.boolean().optional(),
});
export type ToolCallStartedEvent = z.infer<typeof toolCallStartedEventSchema>;

export const toolCallCompletedEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("tool_call.completed"),
  toolName: z.string(),
  agentMessageSend: agentMessageSendSchema.nullable().default(null),
  backgroundOutput: backgroundTaskOutputSchema.nullable().optional(),
  // For detached background command/Monitor completion, this is the SDK task's
  // own start time from BackgroundItem, not the short foreground spawn call.
  backgroundStartedAt: z.number().optional(),
  // Reinforces the persistent background marker at terminal (the runtime now
  // knows for certain this was a backgrounded task). Optional/preserved.
  backgroundTask: z.boolean().optional(),
});
export type ToolCallCompletedEvent = z.infer<
  typeof toolCallCompletedEventSchema
>;

export const toolCallErroredEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("tool_call.errored"),
  toolName: z.string(),
  error: z.string(),
  // Distinguishes an explicit stop (deadline-killed Monitor, user-stopped
  // command) from a genuine failure. Optional/defaulted: an old emitter that
  // never sends this reproduces today's shipped behavior exactly - every
  // terminal failure rendered as a plain error.
  terminationReason: z.enum(["error", "stopped"]).default("error"),
  agentMessageSend: agentMessageSendSchema.nullable().default(null),
  backgroundOutput: backgroundTaskOutputSchema.nullable().optional(),
  // For detached background command/Monitor failure/stop, this is the SDK
  // task's own start time from BackgroundItem when available.
  backgroundStartedAt: z.number().optional(),
  // Reinforces the persistent background marker at terminal. Optional/preserved.
  backgroundTask: z.boolean().optional(),
});
export type ToolCallErroredEvent = z.infer<typeof toolCallErroredEventSchema>;

/**
 * Intermediate human progress line for an in-flight tool call (e.g. a long MCP
 * call reporting "Fetched 3/10 pages"). Replace-latest: the accumulator keeps
 * only the most recent `update` on the owning `tool_call` block and never
 * advances its `timestamp`, so the GUI's elapsed heartbeat stays anchored to
 * the tool's start. NOT a streaming log - carrying growing content here would
 * reintroduce the message-store memory blow-up that deferred streaming stdout.
 * `blockId` is the `tool_call` block; `parentBlockId` nests it under a subagent.
 */
export const toolCallProgressEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("tool_call.progress"),
  update: z.string(),
});
export type ToolCallProgressEvent = z.infer<typeof toolCallProgressEventSchema>;

export const approvalRequestedEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("approval.requested"),
  toolName: z.string(),
  description: z.string(),
  input: z.unknown().optional(),
});
export type ApprovalRequestedEvent = z.infer<
  typeof approvalRequestedEventSchema
>;

export const approvalResolvedEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("approval.resolved"),
  decision: runtimeApprovalDecisionSchema,
});
export type ApprovalResolvedEvent = z.infer<typeof approvalResolvedEventSchema>;

export const todoUpdatedEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("todo.updated"),
  items: z.array(runtimeTodoItemSchema),
});
export type TodoUpdatedEvent = z.infer<typeof todoUpdatedEventSchema>;

export const planDeltaEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("plan.delta"),
  planId: z.string(),
  source: runtimePlanSourceSchema,
  delta: z.string(),
});
export type PlanDeltaEvent = z.infer<typeof planDeltaEventSchema>;

export const planUpdatedEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("plan.updated"),
  planId: z.string(),
  source: runtimePlanSourceSchema,
  planStatus: runtimePlanStatusSchema.default("drafting"),
  title: z.string().nullable().default(null),
  summary: z.string().nullable().default(null),
  markdownPreview: z.string().default(""),
  fullContentRef: runtimePlanContentRefSchema.nullable().default(null),
  steps: z.array(runtimePlanStepSchema).default([]),
  actions: z.array(runtimePlanActionSchema).default([]),
  approvalId: z.string().nullable().default(null),
  supersededByPlanId: z.string().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).nullable().default(null),
});
export type PlanUpdatedEvent = z.infer<typeof planUpdatedEventSchema>;

export const runtimePlanCompletionStatusSchema = z.enum([
  "ready",
  "awaiting_approval",
]);
export type RuntimePlanCompletionStatus = z.infer<
  typeof runtimePlanCompletionStatusSchema
>;

export const planCompletedEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("plan.completed"),
  planId: z.string(),
  source: runtimePlanSourceSchema,
  planStatus: runtimePlanCompletionStatusSchema.default("ready"),
  markdownPreview: z.string().nullable().default(null),
  fullContentRef: runtimePlanContentRefSchema.nullable().default(null),
  actions: z.array(runtimePlanActionSchema).default([]),
  approvalId: z.string().nullable().default(null),
});
export type PlanCompletedEvent = z.infer<typeof planCompletedEventSchema>;

export const compactionStartedEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("compaction.started"),
  trigger: z.enum(["auto", "manual"]).optional(),
  preTokens: z.number().optional(),
  summary: z.string().optional(),
});
export type CompactionStartedEvent = z.infer<
  typeof compactionStartedEventSchema
>;

export const compactionCompletedEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("compaction.completed"),
  trigger: z.enum(["auto", "manual"]).optional(),
  preTokens: z.number().optional(),
  postTokens: z.number().optional(),
  durationMs: z.number().optional(),
  summary: z.string().optional(),
});
export type CompactionCompletedEvent = z.infer<
  typeof compactionCompletedEventSchema
>;

export const compactionErroredEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("compaction.errored"),
  trigger: z.enum(["auto", "manual"]).optional(),
  preTokens: z.number().optional(),
  error: z.string(),
});
export type CompactionErroredEvent = z.infer<
  typeof compactionErroredEventSchema
>;

export const chatQueueSteerModeSchema = z.enum([
  "safe_point",
  "interrupt_restart",
]);
export type ChatQueueSteerMode = z.infer<typeof chatQueueSteerModeSchema>;

export const steerSubmittedEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("steer.submitted"),
  queueItemId: z.string(),
  messageId: z.string(),
  content: jsonContentSchema,
  mode: chatQueueSteerModeSchema.default("safe_point"),
});
export type SteerSubmittedEvent = z.infer<typeof steerSubmittedEventSchema>;

export const interviewRequestedEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("interview.requested"),
  toolName: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  questions: z.array(runtimeInterviewQuestionSchema),
  input: z.unknown().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type InterviewRequestedEvent = z.infer<
  typeof interviewRequestedEventSchema
>;

export const interviewResolvedEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("interview.resolved"),
  answers: z.array(runtimeInterviewAnswerSchema),
  output: z.unknown().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type InterviewResolvedEvent = z.infer<
  typeof interviewResolvedEventSchema
>;

export const interviewErroredEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("interview.errored"),
  error: z.string(),
  output: z.unknown().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type InterviewErroredEvent = z.infer<typeof interviewErroredEventSchema>;

export const subAgentStartedEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("subagent.started"),
  name: z.string(),
  task: z.string().optional(),
  // Agent role/type (e.g. "explorer"), shown as a distinct title segment.
  // Optional so harnesses without a role concept simply omit it.
  agentType: z.string().nullable().optional(),
  // The spawning tool_call block id, when the harness emits the spawn as a
  // standalone tool call (Claude). Lets the GUI suppress that duplicate tool row
  // in favor of the sub-agent card. Omitted by harnesses that emit no separate
  // spawn tool call (Codex `collabAgentToolCall`, OpenCode `task` part).
  spawnToolCallId: z.string().optional(),
});
export type SubAgentStartedEvent = z.infer<typeof subAgentStartedEventSchema>;

export const subAgentProgressEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("subagent.progress"),
  update: z.string(),
});
export type SubAgentProgressEvent = z.infer<typeof subAgentProgressEventSchema>;

export const subAgentCompletedEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("subagent.completed"),
  // Defaulted to "completed" so an old emitter that never sends this
  // reproduces today's shipped (if imprecise) behavior exactly, rather than
  // failing to parse. Only an emitter that knows the real outcome sets this
  // explicitly to "failed"/"stopped".
  outcome: z.enum(["completed", "failed", "stopped"]).default("completed"),
  result: z.string().optional(),
});
export type SubAgentCompletedEvent = z.infer<
  typeof subAgentCompletedEventSchema
>;

export const fileChangeStartedEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("file_change.started"),
  filePath: z.string(),
  operation: z.string(),
});
export type FileChangeStartedEvent = z.infer<
  typeof fileChangeStartedEventSchema
>;

// The `FileEditCoordinator` is the sole emitter of this event; adapters
// MUST NOT yield it directly.
export const fileChangeCompletedEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("file_change.completed"),
  filePath: z.string(),
  operation: z.string(),
  diffSource: diffSourceSchema,
  // Content-addressed snapshot refs (see `fileChangeBlockSchema`); the
  // coordinator no longer ships the decoded before/after content over the wire.
  beforeHash: z.string().nullable(),
  afterHash: z.string().nullable(),
  additions: z.number(),
  deletions: z.number(),
  reason: fileEditReasonSchema,
});
export type FileChangeCompletedEvent = z.infer<
  typeof fileChangeCompletedEventSchema
>;

/**
 * A semantic artifact create / update / delete inferred from the agent's
 * filesystem actions during a turn and emitted by the chat session (NOT a
 * harness adapter). Replaces the raw `file_change` / bash noise for
 * artifact-root paths with one card. The GUI resolves live title / status /
 * tombstone from its projection; `title` is only a fallback for the short
 * delete window before the tombstone projects. `blockId` follows
 * `artifactOperationBlockId(actionId, index)` - indexed so one bash action
 * deleting N artifacts yields N distinct keys.
 */
export const artifactOperationEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("artifact_operation"),
  operation: artifactOperationActionSchema,
  kind: artifactOperationKindSchema,
  artifactId: z.string(),
  title: z.string().nullable().optional(),
  // Merged-change snapshot refs (first-before → last-after) so the card's diff
  // is available immediately, without waiting for the turn-end checkpoint.
  beforeHash: z.string().nullable().optional(),
  afterHash: z.string().nullable().optional(),
});
export type ArtifactOperationEvent = z.infer<
  typeof artifactOperationEventSchema
>;

export const commandStartedEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("command.started"),
  command: z.string(),
  cwd: z.string().optional(),
});
export type CommandStartedEvent = z.infer<typeof commandStartedEventSchema>;

export const commandCompletedEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("command.completed"),
  command: z.string(),
  exitCode: z.number().optional(),
});
export type CommandCompletedEvent = z.infer<typeof commandCompletedEventSchema>;

export const sessionCreatedEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("session.created"),
  session: runtimeSessionInfoSchema,
});
export type SessionCreatedEvent = z.infer<typeof sessionCreatedEventSchema>;

export const sessionResumedEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("session.resumed"),
  session: runtimeSessionInfoSchema,
});
export type SessionResumedEvent = z.infer<typeof sessionResumedEventSchema>;

export const turnStartedEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("turn.started"),
  turnId: z.string(),
});
export type TurnStartedEvent = z.infer<typeof turnStartedEventSchema>;

export const claudeUserMessageAnchorResolvedSchema = z.object({
  harnessId: z.literal("claude"),
  sessionId: z.string(),
  claudeMessageUuid: z.string(),
});

export const codexUserMessageAnchorResolvedSchema = z.object({
  harnessId: z.literal("codex"),
  sessionId: z.string(),
  codexTurnId: z.string(),
  codexUserMessageId: z.string().nullable(),
});

export const openCodeUserMessageAnchorResolvedSchema = z.object({
  harnessId: z.literal("opencode"),
  sessionId: z.string(),
  opencodeUserMessageId: z.string(),
});

export const cursorUserMessageAnchorResolvedSchema = z.object({
  harnessId: z.literal("cursor"),
  sessionId: z.string(),
  cursorRunId: z.string().nullable(),
});

export const traycerUserMessageAnchorResolvedSchema = z.object({
  harnessId: z.literal("traycer"),
  sessionId: z.string(),
  opencodeUserMessageId: z.string(),
});

export const openRouterUserMessageAnchorResolvedSchema = z.object({
  harnessId: z.literal("openrouter"),
  sessionId: z.string(),
  opencodeUserMessageId: z.string(),
});

export const grokUserMessageAnchorResolvedSchema = z.object({
  harnessId: z.literal("grok"),
  sessionId: z.string(),
  // The ACP session id the `grok agent stdio` process assigned for this turn.
  // Null until `session/new` resolves; used to resume the same ACP session.
  grokSessionId: z.string().nullable(),
});

export const qwenUserMessageAnchorResolvedSchema = z.object({
  harnessId: z.literal("qwen"),
  sessionId: z.string(),
  // The ACP session id the `qwen --acp` process assigned for this turn. Null
  // until `session/new` resolves; used to resume the same ACP session.
  qwenSessionId: z.string().nullable(),
});

export const kiroUserMessageAnchorResolvedSchema = z.object({
  harnessId: z.literal("kiro"),
  sessionId: z.string(),
  // The ACP session id the `kiro-cli acp` process assigned for this turn.
  // Null until `session/new` resolves; used to resume the same ACP session.
  kiroSessionId: z.string().nullable(),
});

export const droidUserMessageAnchorResolvedSchema = z.object({
  harnessId: z.literal("droid"),
  sessionId: z.string(),
  // The native Droid session id (`@factory/droid-sdk` exec session) assigned for
  // this turn. Used to resume the same Droid session on a later turn via the
  // SDK's `resumeSession`. Null only when the session id was not yet resolved.
  droidSessionId: z.string().nullable(),
});

export const kimiUserMessageAnchorResolvedSchema = z.object({
  harnessId: z.literal("kimi"),
  sessionId: z.string(),
  // The ACP session id the `kimi acp` process assigned for this turn.
  // Null until `session/new` resolves; used to resume the same ACP session.
  kimiSessionId: z.string().nullable(),
});

export const copilotUserMessageAnchorResolvedSchema = z.object({
  harnessId: z.literal("copilot"),
  sessionId: z.string(),
  // The ACP session id the `copilot --acp` process assigned for this turn.
  // Null until `session/new` resolves; used to resume the same ACP session.
  copilotSessionId: z.string().nullable(),
});

export const kilocodeUserMessageAnchorResolvedSchema = z.object({
  harnessId: z.literal("kilocode"),
  sessionId: z.string(),
  // The ACP session id the `kilo acp` process assigned for this turn.
  // Null until `session/new` resolves; used to resume the same ACP session.
  kilocodeSessionId: z.string().nullable(),
});

export const userMessageAnchorResolvedEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("user_message.anchor_resolved"),
  messageId: z.string(),
  anchor: z.discriminatedUnion("harnessId", [
    claudeUserMessageAnchorResolvedSchema,
    codexUserMessageAnchorResolvedSchema,
    openCodeUserMessageAnchorResolvedSchema,
    cursorUserMessageAnchorResolvedSchema,
    traycerUserMessageAnchorResolvedSchema,
    openRouterUserMessageAnchorResolvedSchema,
    grokUserMessageAnchorResolvedSchema,
    qwenUserMessageAnchorResolvedSchema,
    kiroUserMessageAnchorResolvedSchema,
    droidUserMessageAnchorResolvedSchema,
    kimiUserMessageAnchorResolvedSchema,
    copilotUserMessageAnchorResolvedSchema,
    kilocodeUserMessageAnchorResolvedSchema,
  ]),
});
export type UserMessageAnchorResolvedEvent = z.infer<
  typeof userMessageAnchorResolvedEventSchema
>;

export const turnCompletedEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("turn.completed"),
  turnId: z.string(),
  usage: runtimeTokenUsageSchema.optional(),
  /**
   * Degraded-success channel: how the turn ended when it wasn't a clean finish
   * (e.g. `"max_tokens"` truncation). Mirrors `turn.stopped`/`turn.interrupted`,
   * which already carry a reason. Absent on a normal completion. A refusal is
   * NOT here - it routes to the `error` lane instead.
   */
  reason: z.string().optional(),
});
export type TurnCompletedEvent = z.infer<typeof turnCompletedEventSchema>;

/**
 * Interim usage rollup emitted DURING a running turn so the renderer can
 * update the "% context left" composer chip without waiting for
 * `turn.completed`. Each adapter fires this from its SDK's own event
 * channel - no polling:
 *   - Claude: per `SDKAssistantMessage.message.usage` (BetaUsage) on each
 *     agent step; one-shot `getContextUsage()` at turn.started seeds the
 *     contextWindow that the adapter stamps onto every emit.
 *   - Codex: per `thread/tokenUsage/updated` notification (carries
 *     `tokenUsage.last` snapshot + `modelContextWindow` inline).
 *   - OpenCode: per `message.updated` on the primary agent's assistant
 *     message (info.agent filter); contextWindow from provider.list.
 *   - Cursor: per `TurnEndedUpdate` via `SendOptions.onDelta`; no
 *     public-API contextWindow source, so events flow without one and
 *     the chip hides for Cursor turns rather than guessing.
 */
export const usageUpdatedEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("usage.updated"),
  turnId: z.string(),
  usage: runtimeTokenUsageSchema,
});
export type UsageUpdatedEvent = z.infer<typeof usageUpdatedEventSchema>;

export const turnStoppedEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("turn.stopped"),
  turnId: z.string(),
  reason: z.string().optional(),
});
export type TurnStoppedEvent = z.infer<typeof turnStoppedEventSchema>;

export const turnInterruptedEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("turn.interrupted"),
  turnId: z.string(),
  reason: z.string(),
  code: z.string().optional(),
  recoverable: z.boolean().optional(),
});
export type TurnInterruptedEvent = z.infer<typeof turnInterruptedEventSchema>;

export const errorEventSchema = z.object({
  ...baseRuntimeEventFields,
  type: z.literal("error"),
  message: z.string(),
  recoverable: z.boolean(),
  code: z.string().optional(),
});
export type ErrorEvent = z.infer<typeof errorEventSchema>;

/**
 * Stable `ErrorEvent.code` flagging a *recoverable* provider auth failure (an
 * invalid/expired/missing credential the user can fix by reconnecting). Part of
 * the wire contract: host harnesses emit it and the renderer keys on it,
 * provider-agnostic, to suppress the transcript row, mount the composer re-auth
 * banner, and restore the doomed prompt for re-send. Lives here (next to
 * `errorEventSchema`) so both sides import the one definition.
 */
export const AUTH_ERROR_CODE = "auth";

export const runtimeEventSchema = z.discriminatedUnion("type", [
  textDeltaEventSchema,
  textCompletedEventSchema,
  reasoningDeltaEventSchema,
  reasoningCompletedEventSchema,
  toolCallStartedEventSchema,
  toolCallCompletedEventSchema,
  toolCallErroredEventSchema,
  toolCallProgressEventSchema,
  approvalRequestedEventSchema,
  approvalResolvedEventSchema,
  todoUpdatedEventSchema,
  planDeltaEventSchema,
  planUpdatedEventSchema,
  planCompletedEventSchema,
  compactionStartedEventSchema,
  compactionCompletedEventSchema,
  compactionErroredEventSchema,
  interviewRequestedEventSchema,
  interviewResolvedEventSchema,
  interviewErroredEventSchema,
  subAgentStartedEventSchema,
  subAgentProgressEventSchema,
  subAgentCompletedEventSchema,
  fileChangeStartedEventSchema,
  fileChangeCompletedEventSchema,
  artifactOperationEventSchema,
  commandStartedEventSchema,
  commandCompletedEventSchema,
  sessionCreatedEventSchema,
  sessionResumedEventSchema,
  turnStartedEventSchema,
  userMessageAnchorResolvedEventSchema,
  turnCompletedEventSchema,
  turnStoppedEventSchema,
  turnInterruptedEventSchema,
  steerSubmittedEventSchema,
  usageUpdatedEventSchema,
  errorEventSchema,
]);
export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;
