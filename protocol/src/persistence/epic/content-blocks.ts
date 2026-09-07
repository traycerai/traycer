import { commonRecordRegistry } from "@traycer/protocol/common/registry";
import { getRecordSchema } from "@traycer/protocol/framework/index";
import { managedCommandStatusSchema } from "@traycer/protocol/host/managed-command/unary-schemas";
import {
  userMessageSenderSchema,
  userMessageSenderSchemaPreReasonix,
} from "@traycer/protocol/persistence/epic/senders";
import { z } from "zod";
import {
  imageByteLengthSchema,
  imageDimensionSchema,
  imageSha256HexSchema,
  supportedImageMediaTypeSchema,
} from "@traycer/protocol/persistence/epic/images";

/** Discriminated union of content blocks rendered inside an assistant message. */

const baseBlockFields = {
  blockId: z.string(),
  status: z.enum(["streaming", "completed", "errored"]),
  timestamp: z.number(),
  // Owner block id for nested rendering.
  // Additive + nullable so blocks persisted before this field stay valid.
  parentBlockId: z.string().nullish(),
} as const;

// ACTION blocks (tool_call / command / file_change / subagent) can be force-finalized to two extra TERMINAL states when a turn ends before the block's own completion event arrives: `interrupted` (user hit Stop) or.
// Scoped to action schemas only - text/reasoning/todo/error/compaction/steer/ approval/interview never carry these (the accumulator never assigns them), so the schema models exactly what the system produces.
const actionBlockStatus = z.enum([
  "streaming",
  "completed",
  "errored",
  "interrupted",
  "superseded",
]);

const jsonContentSchema = getRecordSchema(
  commonRecordRegistry,
  "json-content",
  "latest",
);

const harnessIdSchema = getRecordSchema(
  commonRecordRegistry,
  "harness-id",
  "latest",
);

// Frozen pre-Reasonix copy of the canonical harness enum, for the three block members that carry a harness id onto a released `chat.subscribe` line (see `contentBlockSchemaPreReasonix`).
// Derived with `.extract()` off the live enum rather than re-spelled, so adding a vendor to the canonical list without deciding its freeze story is a compile error here.
const harnessIdSchemaPreReasonix = harnessIdSchema.extract([
  "claude",
  "codex",
  "opencode",
  "traycer",
  "cursor",
  "grok",
  "qwen",
  "kiro",
  "droid",
  "kimi",
  "copilot",
  "kilocode",
  "openrouter",
  "amp",
  "devin",
  "pi",
  "hermes",
  "omp",
  "huggingface",
]);

// Canonical artifact-kind vocabulary (spec / ticket / story / review), shared with the artifact metadata + tombstone schemas and the GUI node registries.
// Reused here (not re-spelled) so the `artifact_operation` block can never drift from the kinds the rest of the system recognizes.
const artifactKindSchema = getRecordSchema(
  commonRecordRegistry,
  "epic-artifact-kind",
  "latest",
);

// Durable provider-generated notice (Codex model reroute / safety verification / buffering, and future equivalents from other harnesses), carried as an ADDITIVE enrichment on `textBlockSchema` rather than a new.
// `harnessId` uses the persistence-layer's broad `harnessIdSchema`, not the host layer's narrower `GuiHarnessId` (persistence cannot import that layer - the dependency runs host -> persistence); mirrors.
export const providerNoticeKindSchema = z.enum([
  "model_rerouted",
  "model_verification",
  "safety_buffering",
  "harness_message",
]);
export type ProviderNoticeKind = z.infer<typeof providerNoticeKindSchema>;

/**
 * The notice kinds as every RELEASED line shipped them - `host-v1.2.0`, which carries epic record `2.0` and `chat.subscribe@1.0`-`1.6`.
 * Exported for `host/agent/gui/agent-runtime.ts`, whose frozen `provider_notice.upsert` event carries the same enum on the same lines.
 */
export const providerNoticeKindSchemaPreHarnessMessage = z.enum([
  "model_rerouted",
  "model_verification",
  "safety_buffering",
]);

export const providerNoticeToneSchema = z.enum(["info", "warning"]);
export type ProviderNoticeTone = z.infer<typeof providerNoticeToneSchema>;

export const providerNoticeDetailSchema = z.object({
  label: z.string(),
  value: z.string(),
});
export type ProviderNoticeDetail = z.infer<typeof providerNoticeDetailSchema>;

// Narrow, JSON-serializable per-notice-kind facts - normalized from the raw provider payload at conversion time.
// Never carries the raw payload or user code; only the specific fields each notice kind needs to render/search.
export const providerNoticeNormalizedMetadataSchema = z.discriminatedUnion(
  "type",
  [
    z.object({
      type: z.literal("model_rerouted"),
      fromModel: z.string(),
      toModel: z.string(),
      reason: z.string(),
    }),
    z.object({
      type: z.literal("model_verification"),
      verifications: z.array(z.string()),
    }),
    z.object({
      type: z.literal("safety_buffering"),
      model: z.string(),
      fasterModel: z.string().nullable(),
      useCases: z.array(z.string()),
      reasons: z.array(z.string()),
      terminalReason: z.string().nullable(),
    }),
  ],
);
export type ProviderNoticeNormalizedMetadata = z.infer<
  typeof providerNoticeNormalizedMetadataSchema
>;

export const providerNoticeMetadataSchema = z
  .object({
    harnessId: harnessIdSchema,
    noticeKind: providerNoticeKindSchema,
    tone: providerNoticeToneSchema,
    title: z.string(),
    message: z.string().nullable(),
    details: z.array(providerNoticeDetailSchema),
    metadata: providerNoticeNormalizedMetadataSchema.nullable(),
  })
  .superRefine((notice, ctx) => {
    if (
      notice.metadata !== null &&
      notice.noticeKind !== notice.metadata.type
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "noticeKind must match metadata.type",
        path: ["metadata", "type"],
      });
    }
  });
export type ProviderNoticeMetadata = z.infer<
  typeof providerNoticeMetadataSchema
>;

export const textBlockSchema = z.object({
  ...baseBlockFields,
  type: z.literal("text"),
  text: z.string(),
  // Additive enrichment: when set, this text block is a durable provider notice (Codex model reroute / safety verification / buffering) and a `chat.subscribe@1.3`+ reader projects it to a compact provider-notice segment.
  // Nullable + defaulted so blocks persisted before this field parse cleanly, and so pre-1.3 stream subscribers can be projected down to the fallback text (see `chat-frame-projection.ts`).
  providerNotice: providerNoticeMetadataSchema.nullable().default(null),
});
export type TextBlock = z.infer<typeof textBlockSchema>;

export const reasoningBlockSchema = z.object({
  ...baseBlockFields,
  type: z.literal("reasoning"),
  content: z.string(),
  // Wall-clock start of the reasoning stream (first delta).
  startedAt: z.number().nullable().default(null),
});
export type ReasoningBlock = z.infer<typeof reasoningBlockSchema>;

export const agentMessageSendSchema = z.object({
  receiverAgentId: z.string(),
  message: z.string(),
  responseId: z.string().nullable(),
  expectReply: z.boolean(),
});
export type AgentMessageSend = z.infer<typeof agentMessageSendSchema>;

// Structured rendering of a tool call's input - the collapsed summary line (`inputSummary`) plus this optional expand body.
// Displayed fields are kept in full; the never-displayed bulk carriers (`old_string`/`new_string`/ `content`/patch) are dropped.
export const toolInputDetailEntrySchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.string(),
});

export const toolInputDetailSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("command"), command: z.string() }),
  z.object({
    kind: z.literal("fields"),
    entries: z.array(toolInputDetailEntrySchema),
  }),
]);
export type ToolInputDetail = z.infer<typeof toolInputDetailSchema>;

// A single task-todo tool call (TaskCreate / TaskUpdate / …) parsed into its todo item(s) at block-build time, so the GUI's pinned-todo stack reads structured items instead of re-parsing raw input (no longer persisted).
// The status/action vocabularies mirror `RuntimeTodoStatus` / `TaskTodoAction` in the host layer; re-declared here because persistence cannot import that layer (the dependency runs host -> persistence).
const taskTodoItemStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);
const taskTodoItemActionSchema = z.enum([
  "create",
  "update",
  "start",
  "complete",
  "cancel",
  "list",
]);
export const parsedTaskTodoSchema = z.object({
  id: z.string().nullable(),
  text: z.string().nullable(),
  status: taskTodoItemStatusSchema.nullable(),
  priority: z.string().nullable(),
  activeForm: z.string().nullable(),
  action: taskTodoItemActionSchema,
});
export type ParsedTaskTodoPersisted = z.infer<typeof parsedTaskTodoSchema>;

export const backgroundTaskOutputSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
});
export type BackgroundTaskOutput = z.infer<typeof backgroundTaskOutputSchema>;

// One generated/edited image produced by a tool call (Codex `image_generation` and future equivalents), carried on the `tool_call` content block and its `tool_call.completed` runtime event.
// `attachmentHash` is the render source (SHA-256 content address into the epic attachment map); `filePath` is display-only metadata, never the render source.
export const imageGenerationResultSchema = z.object({
  attachmentHash: imageSha256HexSchema,
  mediaType: supportedImageMediaTypeSchema,
  byteLength: imageByteLengthSchema,
  width: imageDimensionSchema.default(null),
  height: imageDimensionSchema.default(null),
  alt: z.string().nullable().default(null),
  revisedPrompt: z.string().nullable().default(null),
  filePath: z.string().nullable().default(null),
});
export type ImageGenerationResult = z.infer<typeof imageGenerationResultSchema>;

/** The identity every shell-tool correlation carries. */
const toolCallManagedCommandIdentityFields = {
  commandId: z.string(),
  description: z.string(),
  monitoring: z.boolean(),
};

/**
 * The shell a `traycer_run_shell` call created, stamped onto the call's own block so the transcript's start card can find it again.
 * The id is the whole point and cannot be derived: it is minted by the host inside the call and comes back only in the tool RESULT, which is never persisted.
 */
export const toolCallManagedCommandStartedSchema = z.object({
  event: z.literal("started").default("started"),
  ...toolCallManagedCommandIdentityFields,
  cwd: z.string().nullable().default(null),
});
export type ToolCallManagedCommandStarted = z.infer<
  typeof toolCallManagedCommandStartedSchema
>;

/**
 * One successful `traycer_restart_shell`, stamped onto its own call's block as an immutable event.
 * Never a second live card and never a mutation of the start card: a transcript with three restarts holds three of these, in order, and together they are the shell's spec history.
 */
export const toolCallManagedCommandRestartedSchema = z.object({
  event: z.literal("restarted"),
  ...toolCallManagedCommandIdentityFields,
  effectiveCommand: z.string(),
  effectiveCwd: z.string(),
  commandChanged: z.boolean(),
  cwdChanged: z.boolean(),
  outcome: managedCommandStatusSchema,
});
export type ToolCallManagedCommandRestarted = z.infer<
  typeof toolCallManagedCommandRestartedSchema
>;

/**
 * What a shell-tool call did, stamped on its `tool_call` block.
 * Nullable + defaulted on the block: every other tool call, and every block written before this existed, carries null.
 */
export const toolCallManagedCommandSchema = z.union([
  toolCallManagedCommandRestartedSchema,
  toolCallManagedCommandStartedSchema,
]);
export type ToolCallManagedCommand = z.infer<
  typeof toolCallManagedCommandSchema
>;

export const toolCallBlockSchema = z.object({
  ...baseBlockFields,
  status: actionBlockStatus,
  type: z.literal("tool_call"),
  toolName: z.string(),
  // Precomputed display data for the call's input - the ≤80-char header line and the optional expand body, each displayed field kept in full.
  // Nullable + defaulted so blocks persisted before this refactor parse cleanly.
  inputSummary: z.string().nullable().default(null),
  inputDetail: toolInputDetailSchema.nullable().default(null),
  // Task-todo tools (TaskCreate / TaskUpdate / …) carry their todo item(s) in the call input; parsed here so the pinned-todo stack reads structured items.
  taskTodoItems: z.array(parsedTaskTodoSchema).nullable().default(null),
  error: z.string().nullable(),
  agentMessageSend: agentMessageSendSchema.nullable().default(null),
  // The shell a `traycer_run_shell` call created - see
  // `toolCallManagedCommandSchema`. Null for every other tool call.
  managedCommand: toolCallManagedCommandSchema.nullable().default(null),
  // Latest intermediate progress line for an in-flight call (replace-latest, never an append-log).
  // Nullable + defaulted so blocks persisted before this field parse cleanly.
  progress: z.string().nullable().default(null),
  // Capped terminal output for a backgrounded command/monitor, populated from the SDK's terminal task notification when available.
  backgroundOutput: backgroundTaskOutputSchema.nullable().default(null),
  // Wall-clock start of the call.
  // Nullable for blocks persisted before this field existed.
  startedAt: z.number().nullable().default(null),
  // Wall-clock end of the call once a real terminal event arrives.
  // Nullable/defaulted for persisted blocks from older protocol versions.
  endedAt: z.number().nullable().default(null),
  // Persistent marker: true once this tool_call is identified as a backgrounded command/Monitor (stamped at started time from `run_in_background` / the Monitor tool, and reinforced by the terminal task notification).
  backgroundTask: z.boolean().nullable().default(false),
  // Set alongside `status: "errored"` when the terminal outcome was an explicit stop (deadline-killed Monitor, user-stopped command) rather than a genuine failure.
  stopped: z.boolean().default(false),
  // Images this call produced (`chat.subscribe@1.6`).
  imageResults: z.array(imageGenerationResultSchema).default([]),
});
export type ToolCallBlock = z.infer<typeof toolCallBlockSchema>;

// Wire-freeze copy of `toolCallBlockSchema` from before `imageResults` existed (`chat.subscribe@1.0-1.5`).
// Hand-frozen, NOT derived from the live shape via `.omit()`, so a future field added to the live block cannot silently leak onto a released wire line.
export const toolCallBlockSchemaPreImage = z.object({
  ...baseBlockFields,
  status: actionBlockStatus,
  type: z.literal("tool_call"),
  toolName: z.string(),
  inputSummary: z.string().nullable().default(null),
  inputDetail: toolInputDetailSchema.nullable().default(null),
  taskTodoItems: z.array(parsedTaskTodoSchema).nullable().default(null),
  error: z.string().nullable(),
  agentMessageSend: agentMessageSendSchema.nullable().default(null),
  progress: z.string().nullable().default(null),
  backgroundOutput: backgroundTaskOutputSchema.nullable().default(null),
  startedAt: z.number().nullable().default(null),
  endedAt: z.number().nullable().default(null),
  backgroundTask: z.boolean().nullable().default(false),
  stopped: z.boolean().default(false),
});

// `diffSource: "snapshot"` ⇒ `reason: "snapshot"` and contents non-null (or single-null for create/delete).
export const diffSourceSchema = z.enum(["snapshot", "none"]);
export type DiffSource = z.infer<typeof diffSourceSchema>;

export const fileEditReasonSchema = z.enum([
  "snapshot",
  "binary",
  "too_large",
  "blob_missing",
  "capture_failed",
  "not_intercepted",
  // The user denied the edit at the approval prompt - the file was never changed.
  "denied",
]);
export type FileEditReason = z.infer<typeof fileEditReasonSchema>;

export const fileChangeBlockSchema = z.object({
  ...baseBlockFields,
  status: actionBlockStatus,
  type: z.literal("file_change"),
  filePath: z.string(),
  operation: z.string(),
  diffSource: diffSourceSchema,
  // Content-addressed snapshot refs into the on-disk SnapshotStore (`~/.traycer/snapshots/<userId>/blobs/<sha>`).
  beforeHash: z.string().nullable().default(null),
  afterHash: z.string().nullable().default(null),
  additions: z.number().default(0),
  deletions: z.number().default(0),
  reason: fileEditReasonSchema,
});
export type FileChangeBlock = z.infer<typeof fileChangeBlockSchema>;

export const commandBlockSchema = z.object({
  ...baseBlockFields,
  status: actionBlockStatus,
  type: z.literal("command"),
  command: z.string(),
  cwd: z.string().nullable(),
  exitCode: z.number().nullable(),
  // Command stdout/stderr are intentionally NOT persisted: they can be huge (e.g. grep over a large tree) and there is no durable store to lazy-fetch them from.
  backgroundTask: z.boolean().nullable().default(false),
  stopped: z.boolean().default(false),
});
export type CommandBlock = z.infer<typeof commandBlockSchema>;

export const workflowActivityEntrySchema = z.object({
  kind: z.enum(["phase", "label"]),
  text: z.string(),
});
export type WorkflowActivityEntry = z.infer<typeof workflowActivityEntrySchema>;

// Rich workflow data riding a `subagent` block (see `subAgentBlockSchema. workflowMeta` below) - deliberately NOT a new persisted block `type`, so any released host/GUI can still read a chat containing a workflow run.
export const workflowMetaSchema = z.object({
  name: z.string(),
  // The workflow script's `meta.description`, extracted best-effort at spawn
  // time. `null` on extraction failure - never the raw script source.
  intent: z.string().nullable(),
  activity: z.array(workflowActivityEntrySchema),
  agentsStarted: z.number().int().nullable(),
  agentsFinished: z.number().int().nullable(),
  totalTokens: z.number().int().nullable(),
});
export type WorkflowMeta = z.infer<typeof workflowMetaSchema>;

export const subAgentBlockSchema = z.object({
  ...baseBlockFields,
  status: actionBlockStatus,
  type: z.literal("subagent"),
  name: z.string().nullable(),
  // Agent role/type (e.g. "explorer"); null for harnesses without a role.
  // Defaulted so blocks persisted before this field parse cleanly.
  agentType: z.string().nullable().default(null),
  task: z.string().nullable(),
  progressUpdates: z.array(z.string()),
  result: z.string().nullable(),
  // Immutable wall-clock start (the first `subagent.*` event).
  startedAt: z.number().nullable().default(null),
  // The spawning tool_call block id, when the harness surfaces the spawn as a standalone tool call (Claude's `Task`/`Agent` tool).
  spawnToolCallId: z.string().nullable().default(null),
  stopped: z.boolean().default(false),
  // Present iff this card is a workflow run's dual-written card (see `workflow.*` runtime events) - the rich data an old reader can't render.
  workflowMeta: workflowMetaSchema.nullable().default(null),
});
export type SubAgentBlock = z.infer<typeof subAgentBlockSchema>;

export const approvalDecisionSchema = z.object({
  approved: z.boolean(),
  reason: z.string().nullable(),
});
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

export const approvalBlockSchema = z.object({
  ...baseBlockFields,
  type: z.literal("approval"),
  toolName: z.string().nullable(),
  description: z.string().nullable(),
  // Precomputed display data for the pending tool's input (same shape as a
  // tool_call block); the raw input is not persisted. See toolCallBlockSchema.
  inputSummary: z.string().nullable().default(null),
  inputDetail: toolInputDetailSchema.nullable().default(null),
  decision: approvalDecisionSchema.nullable(),
});
export type ApprovalBlock = z.infer<typeof approvalBlockSchema>;

export const todoItemSchema = z.object({
  id: z.string().nullable(),
  text: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
  priority: z.string().nullable(),
  activeForm: z.string().nullable(),
});
export type TodoItem = z.infer<typeof todoItemSchema>;

export const todoBlockSchema = z.object({
  ...baseBlockFields,
  type: z.literal("todo"),
  items: z.array(todoItemSchema),
});
export type TodoBlock = z.infer<typeof todoBlockSchema>;

export const planStatusSchema = z.enum([
  "drafting",
  "ready",
  "awaiting_approval",
  "approved",
  "rejected",
  "superseded",
]);
export type PlanStatus = z.infer<typeof planStatusSchema>;

export const planSourceSchema = z.object({
  harnessId: harnessIdSchema,
  sessionId: z.string().nullable().default(null),
  turnId: z.string().nullable().default(null),
  kind: z.string(),
});
export type PlanSource = z.infer<typeof planSourceSchema>;

export const planStepSchema = z.object({
  id: z.string().nullable().default(null),
  text: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
  activeForm: z.string().nullable().default(null),
});
export type PlanStep = z.infer<typeof planStepSchema>;

export const planActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  decision: z.enum(["approve", "reject", "dismiss"]),
  variant: z.enum(["primary", "secondary", "danger"]),
});
export type PlanAction = z.infer<typeof planActionSchema>;

export const planContentRefSchema = z.object({
  kind: z.literal("plan_content"),
  hash: z.string(),
});
export type PlanContentRef = z.infer<typeof planContentRefSchema>;

export const planBlockSchema = z.object({
  ...baseBlockFields,
  type: z.literal("plan"),
  planStatus: planStatusSchema,
  planId: z.string(),
  harnessId: harnessIdSchema,
  source: planSourceSchema,
  title: z.string().nullable().default(null),
  summary: z.string().nullable().default(null),
  markdownPreview: z.string().default(""),
  fullContentRef: planContentRefSchema.nullable().default(null),
  steps: z.array(planStepSchema).default([]),
  actions: z.array(planActionSchema).default([]),
  approvalId: z.string().nullable().default(null),
  supersededByPlanId: z.string().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).nullable().default(null),
});
export type PlanBlock = z.infer<typeof planBlockSchema>;

export const errorBlockSchema = z.object({
  ...baseBlockFields,
  type: z.literal("error"),
  message: z.string(),
  recoverable: z.boolean(),
  code: z.string().nullable(),
});
export type ErrorBlock = z.infer<typeof errorBlockSchema>;

export const compactionBlockSchema = z.object({
  ...baseBlockFields,
  type: z.literal("compaction"),
  trigger: z.enum(["auto", "manual"]).nullable(),
  preTokens: z.number().nullable(),
  postTokens: z.number().nullable(),
  durationMs: z.number().nullable(),
  summary: z.string().nullable(),
  error: z.string().nullable(),
});
export type CompactionBlock = z.infer<typeof compactionBlockSchema>;

export const autonomousResumeOutputFileSchema = z.object({
  workspacePath: z.string(),
  filePath: z.string(),
});
export type AutonomousResumeOutputFile = z.infer<
  typeof autonomousResumeOutputFileSchema
>;

// One background task whose terminal settle contributed to waking the agent into an autonomous (no-user-message) turn.
// `kind: "wakeup"` (a fired ScheduleWakeup) is never PERSISTED in this array - see `autonomousResumeWakeTriggerSchema` and the block-level codec below.
export const autonomousResumeTriggerSchema = z.object({
  kind: z.enum(["command", "monitor", "subagent", "wakeup"]),
  title: z.string(),
  status: z.enum(["completed", "failed", "stopped"]),
  summary: z.string(),
  blockId: z.string().default(""),
  outputFile: autonomousResumeOutputFileSchema.nullable().default(null),
  // Structured identity of an auto-backgrounded MCP tool call (CLI 2.1.212+).
  mcp: z
    .object({ serverName: z.string(), toolName: z.string() })
    .nullable()
    .default(null),
  // The producer was STILL RUNNING when this digest was rendered - a monitor that keeps watching, or a backgrounded shell streaming mid-run output.
  // `status` therefore still carries the command's terminal outcome; renderers that understand `live` must prefer it, because a running command has no terminal outcome and `status` is reporting the least-wrong of three.
  live: z.boolean().default(false),
  // Structured identity of the shell whose delivery woke this turn.
  managedCommand: z
    .object({
      commandId: z.string(),
      monitoring: z.boolean().default(false),
    })
    .nullable()
    .default(null),
});
export type AutonomousResumeTrigger = z.infer<
  typeof autonomousResumeTriggerSchema
>;

// A fired ScheduleWakeup that woke the agent, stored SEPARATELY from `triggers` so a v1.1.3-or-earlier host - whose `triggers[].kind` enum predates `"wakeup"` - can still parse the chat: an unknown defaulted key is.
export const autonomousResumeWakeTriggerSchema = z.object({
  title: z.string(),
  status: z.enum(["completed", "failed", "stopped"]),
  summary: z.string(),
  blockId: z.string().default(""),
  outputFile: autonomousResumeOutputFileSchema.nullable().default(null),
});
export type AutonomousResumeWakeTrigger = z.infer<
  typeof autonomousResumeWakeTriggerSchema
>;

// Compaction-style divider at the HEAD of an autonomous turn, explaining why the turn resumed (which backgrounded command/Monitor/subagent/wakeup completed).
const persistedAutonomousResumeBlockSchema = z.object({
  ...baseBlockFields,
  type: z.literal("autonomous_resume"),
  triggers: z.array(autonomousResumeTriggerSchema),
  wakeTriggers: z.array(autonomousResumeWakeTriggerSchema).default([]),
});
export type PersistedAutonomousResumeBlock = z.infer<
  typeof persistedAutonomousResumeBlockSchema
>;

const domainAutonomousResumeBlockSchema = z.object({
  ...baseBlockFields,
  type: z.literal("autonomous_resume"),
  triggers: z.array(autonomousResumeTriggerSchema),
});
export type AutonomousResumeBlock = z.infer<
  typeof domainAutonomousResumeBlockSchema
>;

// The raw stored shape of an `autonomous_resume` block as read straight off a Yjs doc, BEFORE any schema parse: every block written before the `wakeTriggers` key existed (v1.1.3 and every earlier build) simply lacks it.
// Any function consuming stored blocks must be total over this shape - `.default([])` only exists after a parse.
export type RawStoredAutonomousResumeBlock = Omit<
  PersistedAutonomousResumeBlock,
  "wakeTriggers"
> & { wakeTriggers: AutonomousResumeWakeTrigger[] | undefined };

// Merges `wakeTriggers` into `triggers` (wakeup entries last, matching construction order in `buildAutonomousResumeBlock`) and accepts legacy stored `kind: "wakeup"` entries already inline in `triggers` unchanged.
export function decodeAutonomousResumeBlock(
  stored: RawStoredAutonomousResumeBlock,
): AutonomousResumeBlock {
  const { wakeTriggers, ...rest } = stored;
  if (wakeTriggers === undefined || wakeTriggers.length === 0) return rest;
  return {
    ...rest,
    triggers: [
      ...rest.triggers,
      ...wakeTriggers.map((wake): AutonomousResumeTrigger => ({
        ...wake,
        kind: "wakeup",
        mcp: null,
        // A fired schedule is not a managed command and never had one.
        managedCommand: null,
        // A fired wake is terminal by construction: it happened, then it was
        // over. Nothing about a schedule keeps producing.
        live: false,
      })),
    ],
  };
}

// Splits wakeup triggers out of `triggers` into `wakeTriggers`.
// Must run before every raw storage write (see `toStoredBlock` in `chat-message-collections.ts`) - writing a domain-shaped block verbatim re-introduces `kind: "wakeup"` into persisted `triggers` and breaks v1.1.x hosts.
function isWakeupTrigger(
  trigger: AutonomousResumeTrigger,
): trigger is AutonomousResumeTrigger & { kind: "wakeup" } {
  return trigger.kind === "wakeup";
}

export function encodeAutonomousResumeBlock(
  domain: AutonomousResumeBlock,
): PersistedAutonomousResumeBlock {
  const triggers = domain.triggers.filter(
    (trigger) => !isWakeupTrigger(trigger),
  );
  const wakeTriggers = domain.triggers
    .filter(isWakeupTrigger)
    .map(
      ({
        kind: _kind,
        mcp: _mcp,
        live: _live,
        managedCommand: _managedCommand,
        ...wake
      }): AutonomousResumeWakeTrigger => wake,
    );
  return { ...domain, triggers, wakeTriggers };
}

export const autonomousResumeBlockSchema = z.codec(
  persistedAutonomousResumeBlockSchema,
  domainAutonomousResumeBlockSchema,
  {
    decode: decodeAutonomousResumeBlock,
    // `z.codec`'s `encode` callback receives the domain schema's INPUT shape (nested trigger defaults not yet applied) and must return the persisted schema's OUTPUT shape.
    encode: (domain) =>
      encodeAutonomousResumeBlock(
        domainAutonomousResumeBlockSchema.parse(domain),
      ),
  },
);

export const steerBlockSchema = z.object({
  ...baseBlockFields,
  type: z.literal("steer"),
  queueItemId: z.string(),
  messageId: z.string(),
  content: jsonContentSchema,
  mode: z.enum(["safe_point", "interrupt_restart"]).default("safe_point"),
  // Who authored the steered message.
  // Carrying the sender here means the fallback can never lose provenance.
  sender: userMessageSenderSchema.nullable().default(null),
});
export type SteerBlock = z.infer<typeof steerBlockSchema>;

export const interviewQuestionOptionSchema = z.object({
  label: z.string(),
  description: z.string().nullable(),
  preview: z.string().nullable(),
});
export type InterviewQuestionOption = z.infer<
  typeof interviewQuestionOptionSchema
>;

export const interviewQuestionSchema = z.object({
  questionId: z.string().nullable(),
  question: z.string(),
  header: z.string().nullable(),
  options: z.array(interviewQuestionOptionSchema),
  multiSelect: z.boolean(),
});
export type InterviewQuestion = z.infer<typeof interviewQuestionSchema>;

/**
 * Where a selected option actually came from, recorded at submission time.
 * `customText` is the free-text ("Other") value when the user typed one, and never stands in for a selection.
 */
export const interviewSelectionEvidenceSchema = z.object({
  questionIndex: z.number().int().nonnegative(),
  optionIndices: z.array(z.number().int().nonnegative()),
  optionLabels: z.array(z.string()),
  customText: z.string().nullable(),
});
export type InterviewSelectionEvidence = z.infer<
  typeof interviewSelectionEvidenceSchema
>;

export const interviewAnswerSchema = z.object({
  questionId: z.string().nullable(),
  question: z.string().nullable(),
  values: z.array(z.string()),
  notes: z.string().nullable(),
  // Structured provenance for a GUI-submitted answer.
  // `.catch(null)` on top of the default, and this is the load-bearing part: corrupt evidence must downgrade THIS FIELD to neutral, never reject the answer around it.
  selection: interviewSelectionEvidenceSchema
    .nullable()
    .default(null)
    .catch(null),
});
export type InterviewAnswer = z.infer<typeof interviewAnswerSchema>;

// Wire/persistence freeze of `interviewAnswerSchema` from before selection evidence existed.
// Hand-frozen field-for-field; NOT derived from the live shape.
export const interviewAnswerSchemaPreSettlement = z.object({
  questionId: z.string().nullable(),
  question: z.string().nullable(),
  values: z.array(z.string()),
  notes: z.string().nullable(),
});

/**
 * The canonical fact about how an interview ended, independent of the legacy block `status`/`error` projection.
 * That is WEAK authority - it blocks reopening but never manufactures an outcome.
 */
export const interviewOutcomeSchema = z.enum(["answered", "skipped", "failed"]);
export type InterviewOutcome = z.infer<typeof interviewOutcomeSchema>;

/** Who settled the interview and under which durable settlement identity. */
export const interviewSettlementAuthoritySchema = z.object({
  settlementId: z.string(),
  source: z.enum(["gui", "runtime"]),
});
export type InterviewSettlementAuthority = z.infer<
  typeof interviewSettlementAuthoritySchema
>;

/**
 * A content-free cleanup/conflict/delivery code recorded ALONGSIDE the canonical outcome, never in place of it.
 * Diagnostics are separately deduplicated by `diagnosticId`, so replay cannot multiply them.
 */
export const interviewSettlementDiagnosticSchema = z.object({
  diagnosticId: z.string(),
  code: z.string(),
  source: z.enum(["runtime", "delivery", "reconcile"]),
});
export type InterviewSettlementDiagnostic = z.infer<
  typeof interviewSettlementDiagnosticSchema
>;

/**
 * Content-free projection of the host's delivery outbox item for a DETACHED settlement, joined by `settlementId`.
 * Null for active waiters, provider-originated settlement, legacy rows, and every pre-`1.7` peer - so "no delivery projection" never reads as "delivery failed".
 */
export const interviewDeliveryProjectionSchema = z.object({
  deliveryId: z.string(),
  status: z.enum(["pending", "delivering", "delivered", "failed"]),
  retryable: z.boolean(),
  /**
   * Monotonic attempt/revision counter for THIS `deliveryId`, incremented by the outbox each time it requeues the item.
   * Delivery is terminal - the provider has the answer - and an attempt counter cannot make that untrue.
   */
  generation: z.number().int().nonnegative().default(0).catch(0),
});
export type InterviewDeliveryProjection = z.infer<
  typeof interviewDeliveryProjectionSchema
>;

export const interviewBlockSchema = z.object({
  ...baseBlockFields,
  type: z.literal("interview"),
  toolName: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  questions: z.array(interviewQuestionSchema),
  answers: z.array(interviewAnswerSchema),
  // Raw tool input/output are NOT persisted: the card renders only the questions/answers/title/description above.
  // Interview detection consumes the raw event input pre-persist (interview-detection.ts), never the stored block.
  error: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  // ─── Canonical settlement facts (additive; every field defaulted so an old persisted row parses with no migration) ───────────────────────────────
  // First, the failure rule: malformed enhanced data downgrades to neutral and must never invalidate the legacy projection an old renderer still reads.
  outcome: interviewOutcomeSchema.nullable().default(null).catch(null),
  // Saved-but-unsent values from an explicit Skip.
  // These are history only: they must never reach a harness/provider result, which is why they live in their own field instead of being folded into `answers`.
  draftAnswers: z.array(interviewAnswerSchema).default([]).catch([]),
  settlement: interviewSettlementAuthoritySchema
    .nullable()
    .default(null)
    .catch(null),
  diagnostics: z
    .array(interviewSettlementDiagnosticSchema)
    .default([])
    .catch([]),
  delivery: interviewDeliveryProjectionSchema
    .nullable()
    .default(null)
    .catch(null),
  /**
   * The settlement-owned envelope for terminal facts a LATER minor adds.
   * Nothing in a flat shape prevents that, and no amount of documentation makes an older build clear a key it has never heard of.
   */
  settlementExtensions: z.record(z.string(), z.unknown()).default({}).catch({}),
});
export type InterviewBlock = z.infer<typeof interviewBlockSchema>;

// Wire-freeze copy of `interviewBlockSchema` from before canonical settlement existed.
// Hand-frozen field-for-field; NOT derived from the live shape (a later field added above must not silently leak in here).
export const interviewBlockSchemaPreSettlement = z.object({
  ...baseBlockFields,
  type: z.literal("interview"),
  toolName: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  questions: z.array(interviewQuestionSchema),
  answers: z.array(interviewAnswerSchemaPreSettlement),
  error: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
});

export const artifactOperationActionSchema = z.enum([
  "create",
  "update",
  "delete",
]);
export type ArtifactOperationAction = z.infer<
  typeof artifactOperationActionSchema
>;

/** Canonical `blockId` for an `artifact_operation` block. */
export function artifactOperationBlockId(
  actionId: string,
  index: number,
): string {
  return `${actionId}:artifact-op:${index}`;
}

// Semantic artifact create/update/delete card.
export const artifactOperationBlockSchema = z.object({
  ...baseBlockFields,
  type: z.literal("artifact_operation"),
  operation: artifactOperationActionSchema,
  kind: artifactKindSchema,
  artifactId: z.string(),
  title: z.string().nullable().default(null),
  beforeHash: z.string().nullable().default(null),
  afterHash: z.string().nullable().default(null),
});
export type ArtifactOperationBlock = z.infer<
  typeof artifactOperationBlockSchema
>;

export const contentBlockSchema = z.discriminatedUnion("type", [
  textBlockSchema,
  reasoningBlockSchema,
  toolCallBlockSchema,
  fileChangeBlockSchema,
  commandBlockSchema,
  subAgentBlockSchema,
  approvalBlockSchema,
  todoBlockSchema,
  planBlockSchema,
  errorBlockSchema,
  compactionBlockSchema,
  autonomousResumeBlockSchema,
  steerBlockSchema,
  interviewBlockSchema,
  artifactOperationBlockSchema,
]);
export type ContentBlock = z.infer<typeof contentBlockSchema>;

// ── Wire-freeze variants (pre-Reasonix) ───────────────────────────────────── These three block members carry harness ids through persisted assistant messages.
// Released `chat.subscribe@1.0-1.6` peers must never observe the Reasonix enum value, while keeping every other field they originally shipped.
const planSourceSchemaPreReasonix = z.object({
  harnessId: harnessIdSchemaPreReasonix,
  sessionId: z.string().nullable().default(null),
  turnId: z.string().nullable().default(null),
  kind: z.string(),
});

const planBlockSchemaPreReasonix = z.object({
  ...baseBlockFields,
  type: z.literal("plan"),
  planStatus: planStatusSchema,
  planId: z.string(),
  harnessId: harnessIdSchemaPreReasonix,
  source: planSourceSchemaPreReasonix,
  title: z.string().nullable().default(null),
  summary: z.string().nullable().default(null),
  markdownPreview: z.string().default(""),
  fullContentRef: planContentRefSchema.nullable().default(null),
  steps: z.array(planStepSchema).default([]),
  actions: z.array(planActionSchema).default([]),
  approvalId: z.string().nullable().default(null),
  supersededByPlanId: z.string().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).nullable().default(null),
});

// Carries a SECOND freeze the name does not record: `noticeKind` is pinned to the three kinds these lines shipped, so `harness_message` never reaches a released decoder.
export const providerNoticeMetadataSchemaPreReasonix = z
  .object({
    harnessId: harnessIdSchemaPreReasonix,
    noticeKind: providerNoticeKindSchemaPreHarnessMessage,
    tone: providerNoticeToneSchema,
    title: z.string(),
    message: z.string().nullable(),
    details: z.array(providerNoticeDetailSchema),
    metadata: providerNoticeNormalizedMetadataSchema.nullable(),
  })
  .superRefine((notice, ctx) => {
    if (
      notice.metadata !== null &&
      notice.noticeKind !== notice.metadata.type
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["metadata", "type"],
        message: "providerNotice.metadata.type must match noticeKind.",
      });
    }
  });

const textBlockSchemaPreReasonix = z.object({
  ...baseBlockFields,
  type: z.literal("text"),
  text: z.string(),
  providerNotice: providerNoticeMetadataSchemaPreReasonix
    .nullable()
    .default(null),
});

const steerBlockSchemaPreReasonix = z.object({
  ...baseBlockFields,
  type: z.literal("steer"),
  queueItemId: z.string(),
  messageId: z.string(),
  content: jsonContentSchema,
  mode: z.enum(["safe_point", "interrupt_restart"]).default("safe_point"),
  sender: userMessageSenderSchemaPreReasonix.nullable().default(null),
});

/**
 * Persistence freeze for the Epic 2.0 contract: the complete live block vocabulary with only harness-bearing members held to the pre-Reasonix enum.
 */
export const contentBlockSchemaPreReasonix = z.discriminatedUnion("type", [
  textBlockSchemaPreReasonix,
  reasoningBlockSchema,
  toolCallBlockSchema,
  fileChangeBlockSchema,
  commandBlockSchema,
  subAgentBlockSchema,
  approvalBlockSchema,
  todoBlockSchema,
  planBlockSchemaPreReasonix,
  errorBlockSchema,
  compactionBlockSchema,
  autonomousResumeBlockSchema,
  steerBlockSchemaPreReasonix,
  interviewBlockSchema,
  artifactOperationBlockSchema,
]);

// Wire-freeze copy of `contentBlockSchema` carrying THREE independent freezes, bound (via the frozen message/chat schemas) to every released `chat.subscribe@1.0-1.5` minor: `tool_call` swapped for its pre-image freeze.
// The name records the FIRST freeze only - see the stacked comments on each swapped member.
export const contentBlockSchemaPreImage = z.discriminatedUnion("type", [
  textBlockSchemaPreReasonix,
  reasoningBlockSchema,
  toolCallBlockSchemaPreImage,
  fileChangeBlockSchema,
  commandBlockSchema,
  subAgentBlockSchema,
  approvalBlockSchema,
  todoBlockSchema,
  planBlockSchemaPreReasonix,
  errorBlockSchema,
  compactionBlockSchema,
  autonomousResumeBlockSchema,
  steerBlockSchemaPreReasonix,
  interviewBlockSchemaPreSettlement,
  artifactOperationBlockSchema,
]);

// Wire-freeze copy of `contentBlockSchema` as `chat.subscribe@1.6` shipped it in `host-v1.2.0-rc.1`: the LIVE `tool_call` (that line does carry image results) with `interview` swapped for its pre-settlement freeze, so.
// `text`/`plan`/`steer` additionally take their pre-Reasonix freezes: `1.6` is released with a nineteen-id harness enum, so it cannot observe a Reasonix id either.
export const contentBlockSchemaPreSettlement = z.discriminatedUnion("type", [
  textBlockSchemaPreReasonix,
  reasoningBlockSchema,
  toolCallBlockSchema,
  fileChangeBlockSchema,
  commandBlockSchema,
  subAgentBlockSchema,
  approvalBlockSchema,
  todoBlockSchema,
  planBlockSchemaPreReasonix,
  errorBlockSchema,
  compactionBlockSchema,
  autonomousResumeBlockSchema,
  steerBlockSchemaPreReasonix,
  interviewBlockSchemaPreSettlement,
  artifactOperationBlockSchema,
]);

export type PersistedContentBlock =
  | Exclude<ContentBlock, AutonomousResumeBlock>
  | PersistedAutonomousResumeBlock;
