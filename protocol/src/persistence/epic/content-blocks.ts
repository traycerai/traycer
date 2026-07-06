import { commonRecordRegistry } from "@traycer/protocol/common/registry";
import { getRecordSchema } from "@traycer/protocol/framework/index";
import { z } from "zod";

/**
 * Discriminated union of content blocks rendered inside an assistant
 * message. Each variant carries the same `baseBlockFields` (`blockId`,
 * `status`, `timestamp`) plus its kind-specific fields.
 */

const baseBlockFields = {
  blockId: z.string(),
  status: z.enum(["streaming", "completed", "errored"]),
  timestamp: z.number(),
  // Owner block id for nested rendering. When set, this block is a CHILD of
  // the referenced block (a subagent's own tool_call / file_change activity
  // nests under its `subagent` block). Absent/null for top-level activity.
  // Additive + nullable so blocks persisted before this field stay valid.
  parentBlockId: z.string().nullish(),
} as const;

// ACTION blocks (tool_call / command / file_change / subagent) can be
// force-finalized to two extra TERMINAL states when a turn ends before the
// block's own completion event arrives: `interrupted` (user hit Stop) or
// `superseded` (a steer-restart replaced the turn). Distinct from `completed`
// (which would mislead with a success check) and `errored` (a genuine failure).
// Scoped to action schemas only - text/reasoning/todo/error/compaction/steer/
// approval/interview never carry these (the accumulator never assigns them), so
// the schema models exactly what the system produces. Additive: blocks persisted
// before these values only ever used the base three, so old data still parses.
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

// Canonical artifact-kind vocabulary (spec / ticket / story / review), shared
// with the artifact metadata + tombstone schemas and the GUI node registries.
// Reused here (not re-spelled) so the `artifact_operation` block can never drift
// from the kinds the rest of the system recognizes.
const artifactKindSchema = getRecordSchema(
  commonRecordRegistry,
  "epic-artifact-kind",
  "latest",
);

export const textBlockSchema = z.object({
  ...baseBlockFields,
  type: z.literal("text"),
  text: z.string(),
});
export type TextBlock = z.infer<typeof textBlockSchema>;

export const reasoningBlockSchema = z.object({
  ...baseBlockFields,
  type: z.literal("reasoning"),
  content: z.string(),
  // Wall-clock start of the reasoning stream (first delta). Immutable across
  // deltas and finalize - unlike `timestamp`, which tracks the latest update and
  // becomes the completion time on finalize - so the GUI can render a stable
  // "Thought for Xs" duration. Nullable for blocks persisted before this field.
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

// Structured rendering of a tool call's input - the collapsed summary line
// (`inputSummary`) plus this optional expand body. Computed on the host at
// block-build time from the raw harness input, which is itself NOT persisted (it
// can be a whole file body - the dominant chat-doc bloat). Displayed fields are
// kept in full; the never-displayed bulk carriers (`old_string`/`new_string`/
// `content`/patch) are dropped. The derivation lives in
// `host/agent/gui/tool-input-detail.ts`.
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

// A single task-todo tool call (TaskCreate / TaskUpdate / …) parsed into its
// todo item(s) at block-build time, so the GUI's pinned-todo stack reads
// structured items instead of re-parsing raw input (no longer persisted). The
// status/action vocabularies mirror `RuntimeTodoStatus` / `TaskTodoAction` in
// the host layer; re-declared here because persistence cannot import that
// layer (the dependency runs host -> persistence).
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

export const toolCallBlockSchema = z.object({
  ...baseBlockFields,
  status: actionBlockStatus,
  type: z.literal("tool_call"),
  toolName: z.string(),
  // Precomputed display data for the call's input - the ≤80-char header line and
  // the optional expand body, each displayed field kept in full. The raw harness
  // input is NOT persisted: for Edit/Write/apply_patch it IS the full file body
  // (old_string/new_string), the dominant chat-doc bloat, and those tool calls
  // are GUI-suppressed in favour of the file_change card, so their content is
  // dropped outright. Tool OUTPUT and command stdout are likewise not persisted.
  // Computed once on the host (agent-runtime-accumulator) so the live broadcast
  // and the persisted row carry the same structured fields.
  // Nullable + defaulted so blocks persisted before this refactor parse cleanly.
  inputSummary: z.string().nullable().default(null),
  inputDetail: toolInputDetailSchema.nullable().default(null),
  // Task-todo tools (TaskCreate / TaskUpdate / …) carry their todo item(s) in
  // the call input; parsed here so the pinned-todo stack reads structured items.
  // Null for every non-task-todo tool. Defaulted for pre-refactor blocks.
  taskTodoItems: z.array(parsedTaskTodoSchema).nullable().default(null),
  error: z.string().nullable(),
  agentMessageSend: agentMessageSendSchema.nullable().default(null),
  // Latest intermediate progress line for an in-flight call (replace-latest,
  // never an append-log). Shown by the GUI only while `status === "streaming"`.
  // Nullable + defaulted so blocks persisted before this field parse cleanly.
  progress: z.string().nullable().default(null),
  // Capped terminal output for a backgrounded command/monitor, populated from
  // the SDK's terminal task notification when available. Completion-only by
  // design: this is not a persisted streaming stdout log.
  backgroundOutput: backgroundTaskOutputSchema.nullable().default(null),
  // Wall-clock start of the call. Immutable across progress/completion - unlike
  // `timestamp`, which becomes the completion time once the block finalizes - so
  // background command/Monitor cards can preserve their final elapsed duration.
  // Nullable for blocks persisted before this field existed.
  startedAt: z.number().nullable().default(null),
  // Wall-clock end of the call once a real terminal event arrives. Kept
  // separate from `timestamp` so background command/Monitor duration is always
  // derived from explicit task timing, not from whichever lifecycle event last
  // touched the block. Nullable/defaulted for persisted blocks from older
  // protocol versions.
  endedAt: z.number().nullable().default(null),
  // Persistent marker: true once this tool_call is identified as a backgrounded
  // command/Monitor (stamped at started time from `run_in_background` / the
  // Monitor tool, and reinforced by the terminal task notification). Unlike the
  // transient host `backgroundItems` list (removed at completion) or
  // `backgroundOutput` (only set on some terminal paths), this survives EVERY
  // terminal path and reload - so the GUI keeps rendering it as a standalone
  // background card after it completes/stops/errors instead of collapsing into
  // the generic activity group. `null` means "not yet known" (the classifier
  // hasn't seen enough of the streamed input to tell) - distinct from a
  // confirmed `false`, so a brief mid-stream gap is never misrendered as a
  // definitive "not background." Defaulted to `false` (not `null`) for blocks
  // persisted before this field existed, since backgrounding didn't exist as a
  // concept then.
  backgroundTask: z.boolean().nullable().default(false),
  // Set alongside `status: "errored"` when the terminal outcome was an
  // explicit stop (deadline-killed Monitor, user-stopped command) rather than
  // a genuine failure. `status` itself is unchanged - this only adds the
  // finer distinction. Defaulted so pre-existing blocks parse cleanly.
  stopped: z.boolean().default(false),
});
export type ToolCallBlock = z.infer<typeof toolCallBlockSchema>;

// `diffSource: "snapshot"` ⇒ `reason: "snapshot"` and contents non-null
// (or single-null for create/delete). Any other reason ⇒ `"none"` and
// null contents - `reason` carries the actionable explanation.
export const diffSourceSchema = z.enum(["snapshot", "none"]);
export type DiffSource = z.infer<typeof diffSourceSchema>;

export const fileEditReasonSchema = z.enum([
  "snapshot",
  "binary",
  "too_large",
  "blob_missing",
  "capture_failed",
  "not_intercepted",
  // The user denied the edit at the approval prompt - the file was never
  // changed. Distinct from "capture_failed" (an actual error) so the renderer
  // can show a "Denied" status instead of a failure.
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
  // Content-addressed snapshot refs into the on-disk SnapshotStore
  // (`~/.traycer/snapshots/<userId>/blobs/<sha>`). The before/after file
  // contents are NOT inlined here (they were the dominant chat-doc bloat);
  // the GUI lazy-fetches them by hash on expand via `snapshots.readSnapshotDiff`.
  // Null on the side that doesn't exist (create ⇒ no before, delete ⇒ no after)
  // or when `diffSource === "none"` (see `reason`). Defaulted so file_change
  // blocks persisted before these fields existed parse cleanly (they degrade to
  // "no diff" rather than throwing) - matching the convention of every other
  // additive field in this file.
  beforeHash: z.string().nullable().default(null),
  afterHash: z.string().nullable().default(null),
  // +N/−M line counts computed at capture time (same `structuredPatch`
  // algorithm the GUI renders with) so the collapsed header shows the counts
  // without fetching any content. Both 0 when there is no renderable diff.
  // Defaulted so pre-existing blocks parse cleanly.
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
  // Command stdout/stderr are intentionally NOT persisted: they can be huge
  // (e.g. grep over a large tree) and there is no durable store to lazy-fetch
  // them from. The card shows command + cwd + exit code + status, which is the
  // load-bearing signal.
});
export type CommandBlock = z.infer<typeof commandBlockSchema>;

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
  // Immutable wall-clock start (the first `subagent.*` event). Unlike
  // `timestamp` - which advances with each progress update and on completion -
  // this stays the spawn time, so the card can render a stable elapsed
  // heartbeat / total duration. Nullable for blocks persisted before this field.
  startedAt: z.number().nullable().default(null),
  // The spawning tool_call block id, when the harness surfaces the spawn as a
  // standalone tool call (Claude's `Task`/`Agent` tool). The GUI suppresses that
  // duplicate tool row in favor of this card - the same policy that hides a
  // file-edit tool call behind its `file_change`. Null for harnesses that model
  // the spawn as the sub-agent itself (Codex `collabAgentToolCall`, OpenCode
  // `task` part) and therefore emit no separate tool call. Defaulted so blocks
  // persisted before this field parse cleanly.
  spawnToolCallId: z.string().nullable().default(null),
  // Set alongside `status: "errored"` when the subagent's terminal outcome
  // was an explicit stop rather than a genuine failure - mirrors
  // `toolCallBlockSchema.stopped`. Defaulted so pre-existing blocks parse
  // cleanly.
  stopped: z.boolean().default(false),
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

// One background task whose terminal settle contributed to waking the agent
// into an autonomous (no-user-message) turn. `kind` mirrors the live
// BackgroundItem vocabulary, while `status` is the terminal outcome; `title` is
// the same human label; `summary` is the task notification's summary / a short
// result line. `blockId` is the
// originating card's block id (the spawning tool_call / subagent block) so the
// resume marker can scroll back to it; defaulted for back-compat with any
// trigger persisted before this field existed (renders as non-clickable).
// `outputFile` points at an SDK task output file using the existing
// workspace.readFile address shape; the GUI lazy-fetches it only on expand.
//
// `kind: "wakeup"` (a fired ScheduleWakeup) is never PERSISTED in this array -
// see `autonomousResumeWakeTriggerSchema` and the block-level codec below. The
// enum keeps the value only to accept chats already written with it inline
// (pre-fix internal builds); the next full-block rewrite re-encodes them.
export const autonomousResumeTriggerSchema = z.object({
  kind: z.enum(["command", "monitor", "subagent", "wakeup"]),
  title: z.string(),
  status: z.enum(["completed", "failed", "stopped"]),
  summary: z.string(),
  blockId: z.string().default(""),
  outputFile: autonomousResumeOutputFileSchema.nullable().default(null),
});
export type AutonomousResumeTrigger = z.infer<
  typeof autonomousResumeTriggerSchema
>;

// A fired ScheduleWakeup that woke the agent, stored SEPARATELY from
// `triggers` so a v1.1.3-or-earlier host - whose `triggers[].kind` enum
// predates `"wakeup"` - can still parse the chat: an unknown defaulted key is
// silently stripped by a strict `z.object`, whereas a new enum value would
// fail the WHOLE chat's `chatSchema.safeParse` (see `readChatSnapshot` in
// `chat-session-manager.ts`). Same fields as a trigger minus `kind` - the
// field itself is the kind. Always empty for every OTHER block/trigger kind.
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

// Compaction-style divider at the HEAD of an autonomous turn, explaining why
// the turn resumed (which backgrounded command/Monitor/subagent/wakeup
// completed). The turn carries no user message, so without this the resume
// looks abrupt. Usually one trigger; can be several if multiple settled while
// idle before the model woke. This block is surfaced through
// `chat.subscribe@1.1+`; 1.2 adds the wakeup trigger kind, which the host
// projects out for older subscribers.
//
// PERSISTED shape carries wakeup triggers in the additive `wakeTriggers` key
// instead of inline in `triggers` - the only kind of change a v1.1.x host's
// strict `chatSchema.safeParse` can survive. The DOMAIN/wire shape (this
// block's inferred type, used by every consumer other than the storage
// read/write funnels) is unchanged: `triggers` alone, wakeup entries last.
// `decodeAutonomousResumeBlock`/`encodeAutonomousResumeBlock` are exported as
// plain functions (not just wrapped in the codec below) so the storage layer's
// hot read/write funnels - `denormalizeMessages` / `toStoredBlock` in
// `chat-message-collections.ts` - can normalize without a full schema parse.
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

// Merges `wakeTriggers` into `triggers` (wakeup entries last, matching
// construction order in `buildAutonomousResumeBlock`) and accepts legacy
// stored `kind: "wakeup"` entries already inline in `triggers` unchanged.
// Idempotent: decoding an already-domain-shaped block (no `wakeTriggers`) is a
// no-op, since a re-parse through `persistedAutonomousResumeBlockSchema`
// defaults the missing key to `[]`.
export function decodeAutonomousResumeBlock(
  stored: PersistedAutonomousResumeBlock,
): AutonomousResumeBlock {
  const { wakeTriggers, ...rest } = stored;
  if (wakeTriggers.length === 0) return rest;
  return {
    ...rest,
    triggers: [
      ...rest.triggers,
      ...wakeTriggers.map(
        (wake): AutonomousResumeTrigger => ({ ...wake, kind: "wakeup" }),
      ),
    ],
  };
}

// Splits wakeup triggers out of `triggers` into `wakeTriggers`. Must run
// before every raw storage write (see `toStoredBlock` in
// `chat-message-collections.ts`) - writing a domain-shaped block verbatim
// re-introduces `kind: "wakeup"` into persisted `triggers` and breaks v1.1.x
// hosts again.
function isWakeupTrigger(
  trigger: AutonomousResumeTrigger,
): trigger is AutonomousResumeTrigger & { kind: "wakeup" } {
  return trigger.kind === "wakeup";
}

export function encodeAutonomousResumeBlock(
  domain: AutonomousResumeBlock,
): PersistedAutonomousResumeBlock {
  const triggers = domain.triggers.filter((trigger) => !isWakeupTrigger(trigger));
  const wakeTriggers = domain.triggers
    .filter(isWakeupTrigger)
    .map(({ kind: _kind, ...wake }): AutonomousResumeWakeTrigger => wake);
  return { ...domain, triggers, wakeTriggers };
}

export const autonomousResumeBlockSchema = z.codec(
  persistedAutonomousResumeBlockSchema,
  domainAutonomousResumeBlockSchema,
  {
    decode: decodeAutonomousResumeBlock,
    // `z.codec`'s `encode` callback receives the domain schema's INPUT shape
    // (nested trigger defaults not yet applied) and must return the persisted
    // schema's OUTPUT shape. Re-parsing through `domainAutonomousResumeBlockSchema`
    // applies those defaults so `encodeAutonomousResumeBlock` itself can stay
    // typed against the concrete, fully-defaulted `AutonomousResumeBlock` - the
    // shape every real caller (e.g. the host storage write funnel) has.
    encode: (domain) =>
      encodeAutonomousResumeBlock(domainAutonomousResumeBlockSchema.parse(domain)),
  },
);

export const steerBlockSchema = z.object({
  ...baseBlockFields,
  type: z.literal("steer"),
  queueItemId: z.string(),
  messageId: z.string(),
  content: jsonContentSchema,
  mode: z.enum(["safe_point", "interrupt_restart"]).default("safe_point"),
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

export const interviewAnswerSchema = z.object({
  questionId: z.string().nullable(),
  question: z.string().nullable(),
  values: z.array(z.string()),
  notes: z.string().nullable(),
});
export type InterviewAnswer = z.infer<typeof interviewAnswerSchema>;

export const interviewBlockSchema = z.object({
  ...baseBlockFields,
  type: z.literal("interview"),
  toolName: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  questions: z.array(interviewQuestionSchema),
  answers: z.array(interviewAnswerSchema),
  // Raw tool input/output are NOT persisted: the card renders only the
  // questions/answers/title/description above. Interview detection consumes the
  // raw event input pre-persist (interview-detection.ts), never the stored block.
  error: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
});
export type InterviewBlock = z.infer<typeof interviewBlockSchema>;

// The semantic operation an agent performed on an artifact during a turn,
// inferred from its filesystem actions (Write/Edit ⇒ create|update, bash
// rm/mv ⇒ delete|update). Distinct from the `file_change` block: an
// `artifact_operation` REPLACES the raw file-edit/bash noise for artifact-root
// paths with one semantic card.
export const artifactOperationActionSchema = z.enum([
  "create",
  "update",
  "delete",
]);
export type ArtifactOperationAction = z.infer<
  typeof artifactOperationActionSchema
>;

/**
 * Canonical `blockId` for an `artifact_operation` block.
 *
 * `actionId` is the originating action's id (the `file_change` block id for a
 * Write/Edit, or the bash `tool_call` id for an rm/mv). `index` disambiguates
 * multiple artifacts touched by ONE action - a single `rm -rf` can delete N
 * artifacts under one bash `tool_call` id, so each needs a distinct key.
 * Mirrors `FileEditCoordinator.makeBlockId`. A non-indexed scheme would collide
 * in both the turn-content accumulator (same `blockId` ⇒ overwrite) and the
 * GUI's React keys.
 */
export function artifactOperationBlockId(
  actionId: string,
  index: number,
): string {
  return `${actionId}:artifact-op:${index}`;
}

// Semantic artifact create/update/delete card. Carries the operation, kind,
// canonical `artifactId` (the EpicFileSync-minted UUID), and a title fallback.
// The GUI still resolves live title / ticket status / deletion tombstone from
// the open-epic projection by `artifactId` first, so later rename/status/delete
// reflects without rewriting persisted history. The fallback is for the short
// delete window before the tombstone projects. `blockId` follows
// {@link artifactOperationBlockId}.
export const artifactOperationBlockSchema = z.object({
  ...baseBlockFields,
  type: z.literal("artifact_operation"),
  operation: artifactOperationActionSchema,
  kind: artifactKindSchema,
  artifactId: z.string(),
  title: z.string().nullable().default(null),
  // Content-addressed snapshot refs for the artifact's merged change this turn
  // (first edit's pre-state → last edit's post-state), so the card can render
  // its diff the moment the edit completes - no wait for turn-end checkpoint
  // capture. Mirrors `fileChangeBlockSchema`. Null when uncaptured (e.g. a bash
  // delete with no pre-image, or a post-hoc edit). The GUI lazy-fetches the
  // before/after by hash via `snapshots.readSnapshotDiff` on expand. Defaulted
  // so blocks persisted before these fields existed parse cleanly.
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

// The on-disk/wire shape - identical to `ContentBlock` except
// `autonomous_resume`, whose persisted member carries `wakeTriggers` instead
// of inline `kind: "wakeup"` triggers. Used by the host storage layer's
// `StoredBlock` type so raw Yjs entries are typed as what is actually on disk.
//
// Deliberately NOT `z.input<typeof contentBlockSchema>`: that blanket
// derivation also reverts every OTHER member's defaulted fields to optional
// (e.g. `reasoning.startedAt`), since `z.input` reflects pre-default shape for
// ALL members, not just the codec one. Only `autonomous_resume` actually has a
// different on-disk representation - every other member's persisted shape is
// its normal (fully-defaulted) domain shape.
export type PersistedContentBlock =
  | Exclude<ContentBlock, AutonomousResumeBlock>
  | PersistedAutonomousResumeBlock;
