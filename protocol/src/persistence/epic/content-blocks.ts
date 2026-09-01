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

// Frozen pre-Reasonix copy of the canonical harness enum, for the three block
// members that carry a harness id onto a released `chat.subscribe` line (see
// `contentBlockSchemaPreReasonix`). Derived with `.extract()` off the live enum
// rather than re-spelled, so adding a vendor to the canonical list without
// deciding its freeze story is a compile error here. Do NOT add new harnesses.
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

// Canonical artifact-kind vocabulary (spec / ticket / story / review), shared
// with the artifact metadata + tombstone schemas and the GUI node registries.
// Reused here (not re-spelled) so the `artifact_operation` block can never drift
// from the kinds the rest of the system recognizes.
const artifactKindSchema = getRecordSchema(
  commonRecordRegistry,
  "epic-artifact-kind",
  "latest",
);

// Durable provider-generated notice (Codex model reroute / safety
// verification / buffering, and future equivalents from other harnesses),
// carried as an ADDITIVE enrichment on `textBlockSchema` rather than a new
// `ContentBlock.type` - see `providerNotice` below for why. `harnessId` uses
// the persistence-layer's broad `harnessIdSchema`, not the host layer's
// narrower `GuiHarnessId` (persistence cannot import that layer - the
// dependency runs host -> persistence); mirrors `planSourceSchema.harnessId`.
// `harness_message` is the generic arm: a status line the harness itself
// routed to the user that is not model output and carries no structured
// facts (Claude Code's `system/informational` banners - hook feedback, blank
// prompt, and whatever else that channel grows). It is deliberately
// metadata-less; the other three name a specific provider behaviour and each
// has a `providerNoticeNormalizedMetadataSchema` variant.
export const providerNoticeKindSchema = z.enum([
  "model_rerouted",
  "model_verification",
  "safety_buffering",
  "harness_message",
]);
export type ProviderNoticeKind = z.infer<typeof providerNoticeKindSchema>;

/**
 * The notice kinds as every RELEASED line shipped them - `host-v1.2.0`, which
 * carries epic record `2.0` and `chat.subscribe@1.0`-`1.6`.
 *
 * An enum VALUE addition is the one growth a frozen `z.object` copy does not
 * absorb on its own: a released peer strips an unknown KEY, but strict-decodes
 * an unknown value and fails the whole block (`COMPATIBILITY.md`, "Same-major
 * changes"). So this is hand-frozen and bound into the pre-Reasonix copies
 * below - which reused the LIVE kind enum, since no kind had ever been added
 * when they were written - rather than left pointing at a schema that grows.
 *
 * Exported for `host/agent/gui/agent-runtime.ts`, whose frozen
 * `provider_notice.upsert` event carries the same enum on the same lines.
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

// Narrow, JSON-serializable per-notice-kind facts - normalized from the raw
// provider payload at conversion time. Never carries the raw payload or user
// code; only the specific fields each notice kind needs to render/search.
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
  // Additive enrichment: when set, this text block is a durable provider
  // notice (Codex model reroute / safety verification / buffering) and a
  // `chat.subscribe@1.3`+ reader projects it to a compact provider-notice
  // segment. `text` always carries a concise fallback rendering, so a reader
  // that strips or predates this key still renders plain assistant text -
  // this is NOT a new persisted `ContentBlock.type`. Nullable + defaulted so
  // blocks persisted before this field parse cleanly, and so pre-1.3 stream
  // subscribers can be projected down to the fallback text (see
  // `chat-frame-projection.ts`).
  providerNotice: providerNoticeMetadataSchema.nullable().default(null),
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

// One generated/edited image produced by a tool call (Codex `image_generation`
// and future equivalents), carried on the `tool_call` content block and its
// `tool_call.completed` runtime event. `attachmentHash` is the render source
// (SHA-256 content address into the epic attachment map); `filePath` is
// display-only metadata, never the render source. Array from day one - a
// single tool call can produce more than one image.
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

/**
 * The identity every shell-tool correlation carries. `description` and
 * `monitoring` ride along even though the live record carries both, because
 * they are exactly what survives the record's death: a deleted shell's card
 * still names itself "Monitor · deploy watcher" instead of degrading to an
 * anonymous row.
 */
const toolCallManagedCommandIdentityFields = {
  commandId: z.string(),
  description: z.string(),
  monitoring: z.boolean(),
};

/**
 * The shell a `traycer_run_shell` call created, stamped onto the call's own
 * block so the transcript's start card can find it again.
 *
 * The id is the whole point and cannot be derived: it is minted by the host
 * inside the call and comes back only in the tool RESULT, which is never
 * persisted. Without it a start card can only guess which shell it is looking
 * at - and, worse, cannot tell a DELETED shell (look it up, find nothing) from
 * a block written before this field existed, which are the two states that must
 * read differently. The live record wins over the identity fields whenever
 * there is one - an agent can rename a shell or turn monitoring off, and the
 * card follows.
 *
 * `event` is DEFAULTED: every block stamped before restarts were correlated
 * carries only the identity, and it was always a start.
 *
 * `cwd` is the directory the successful call reported starting the shell in,
 * frozen with the block - deliberately not the live record's `cwd`, which a
 * later restart can move. The start card describes the call it is the record
 * of. Null on blocks stamped before it existed.
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
 * One successful `traycer_restart_shell`, stamped onto its own call's block as
 * an immutable event. Never a second live card and never a mutation of the
 * start card: a transcript with three restarts holds three of these, in order,
 * and together they are the shell's spec history.
 *
 * Every field is a snapshot from the successful tool RESULT, not from the
 * call's inputs. The inputs are optional and provider-shaped (a `command`
 * given or omitted, a `cwd` equal to the stored one or not, explicit nulls);
 * the result carries the EFFECTIVE spec the shell relaunched under and the
 * host's own verdict on what changed against the spec before the call.
 * `commandChanged`/`cwdChanged` therefore mean "differs from what the shell ran
 * under before" - a restart naming the command already stored changed nothing,
 * and says so.
 *
 * `outcome` is the status the result reported - `running`, or `exited` for a
 * spawn failure - and is FROZEN: a restart card is history, and a live status
 * on every one of them would mutate them all to the same present. The
 * correlated start card stays the shell's one live card.
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
 * What a shell-tool call did, stamped on its `tool_call` block. Nullable +
 * defaulted on the block: every other tool call, and every block written
 * before this existed, carries null.
 *
 * A plain union rather than `z.discriminatedUnion`: the started member's
 * discriminator is defaulted so the identity-only shape every existing block
 * carries still parses (a discriminated union refuses a missing
 * discriminator), and the restarted member goes first because its literal is
 * required - a legacy shape falls through to `started`.
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
  // The shell a `traycer_run_shell` call created - see
  // `toolCallManagedCommandSchema`. Null for every other tool call.
  managedCommand: toolCallManagedCommandSchema.nullable().default(null),
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
  // Images this call produced (`chat.subscribe@1.6`). Defaulted so blocks
  // persisted before this field existed parse cleanly. See
  // `imageGenerationResultSchema`.
  imageResults: z.array(imageGenerationResultSchema).default([]),
});
export type ToolCallBlock = z.infer<typeof toolCallBlockSchema>;

// Wire-freeze copy of `toolCallBlockSchema` from before `imageResults`
// existed (`chat.subscribe@1.0-1.5`). Bound (via the frozen content-block
// union below) to every released `chat.subscribe` minor so those lines can
// never observe image data - see `contentBlockSchemaPreReasonix`. Hand-frozen,
// NOT derived from the live shape via `.omit()`, so a future field added to
// the live block cannot silently leak onto a released wire line.
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
  // Persistent marker with the same three-state meaning as
  // `toolCallBlockSchema.backgroundTask`: true once this command has been
  // promoted to a backgrounded one (Codex yields a long-running exec to the
  // background and keeps it alive past the turn that started it). The marker
  // survives EVERY terminal path and reload, so the GUI keeps rendering it as a
  // standalone background card once it settles instead of collapsing back into
  // the generic activity group. `null` means "not yet known" - the promotion is
  // only decided at the parent turn's end, so a command that is still running
  // has no confirmed answer yet. Defaulted to `false` (not `null`) for blocks
  // persisted before this field existed, since backgrounding didn't exist as a
  // concept then.
  backgroundTask: z.boolean().nullable().default(false),
  // Set when the terminal outcome was an explicit stop - the host asked the
  // provider to terminate a backgrounded command, or a teardown killed it -
  // rather than the command failing on its own. The provider reports its own
  // kill with a synthetic exit code, and rendering that as a failure would
  // blame the command for something we did. Mirrors
  // `toolCallBlockSchema.stopped`. Defaulted so pre-existing blocks parse.
  stopped: z.boolean().default(false),
});
export type CommandBlock = z.infer<typeof commandBlockSchema>;

// One milestone in a workflow run's activity timeline: a phase transition
// (`"Find"`, `"Verify"`, ...) or a fleet-agent label sighting (`"find:host-core"`),
// parsed from the workflow task's rotating `task_progress` line. Order in
// `WorkflowMeta.activity` is chronological; consecutive duplicate labels are
// not re-appended (see the accumulator).
export const workflowActivityEntrySchema = z.object({
  kind: z.enum(["phase", "label"]),
  text: z.string(),
});
export type WorkflowActivityEntry = z.infer<typeof workflowActivityEntrySchema>;

// Rich workflow data riding a `subagent` block (see `subAgentBlockSchema.
// workflowMeta` below) - deliberately NOT a new persisted block `type`, so any
// released host/GUI can still read a chat containing a workflow run (the base
// `subagent` fields are the faithful degradation; this is the enrichment an
// old reader silently strips).
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
  // Present iff this card is a workflow run's dual-written card (see
  // `workflow.*` runtime events) - the rich data an old reader can't render.
  // `null` ⇒ an ordinary subagent block. Additive + defaulted so blocks
  // persisted before workflow support existed - and a workflow block read by
  // an old host/GUI that strips this key - both parse cleanly.
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
  // Structured identity of an auto-backgrounded MCP tool call (CLI 2.1.212+).
  // Deliberately NOT a new `kind` enum value: `kind` stays `"command"` for
  // these triggers because an unknown enum value fails the WHOLE chat's
  // `safeParse` on an older host, while an unknown defaulted key is silently
  // stripped (the same constraint that forced `wakeTriggers` out of `triggers`
  // above). Renderers prefer this identity when present and fall back to the
  // command presentation when absent/stripped.
  mcp: z
    .object({ serverName: z.string(), toolName: z.string() })
    .nullable()
    .default(null),
  // The producer was STILL RUNNING when this digest was rendered - a monitor
  // that keeps watching, or a backgrounded shell streaming mid-run output. It
  // is a separate defaulted key rather than a `status` value for the same
  // reason `mcp` and `wakeTriggers` are: `status` is a persisted enum, and an
  // unknown enum value fails the WHOLE chat's `safeParse` on an older host,
  // whereas an unknown defaulted key is silently stripped. `status` therefore
  // still carries the command's terminal outcome; renderers that understand
  // `live` must prefer it, because a running command has no terminal outcome
  // and `status` is reporting the least-wrong of three wrong answers.
  live: z.boolean().default(false),
  // Structured identity of the shell whose delivery woke this turn. Exactly the
  // `mcp` pattern above and for the same reason: `kind` is a PERSISTED enum,
  // and an unknown value in it fails the WHOLE chat's `safeParse` on an older
  // host, whereas an unknown defaulted key is silently stripped. So `kind`
  // stays `"monitor"` for every shell, and the id the divider needs to open the
  // output window on click rides here.
  //
  // `monitoring` is defaulted rather than required because this key is READ BACK
  // from chats written before it existed (and from ones written while it was
  // still `kind`, whose value strips on parse): a trigger that cannot say
  // whether its shell was watching renders as a plain shell rather than failing
  // the whole chat.
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

// The raw stored shape of an `autonomous_resume` block as read straight off a
// Yjs doc, BEFORE any schema parse: every block written before the
// `wakeTriggers` key existed (v1.1.3 and every earlier build) simply lacks it,
// and the storage hot path (`decodeStoredBlock` in
// `chat-message-collections.ts`) deliberately skips the schema parse that
// would default it. Any function consuming stored blocks must be total over
// this shape - `.default([])` only exists after a parse.
export type RawStoredAutonomousResumeBlock = Omit<
  PersistedAutonomousResumeBlock,
  "wakeTriggers"
> & { wakeTriggers: AutonomousResumeWakeTrigger[] | undefined };

// Merges `wakeTriggers` into `triggers` (wakeup entries last, matching
// construction order in `buildAutonomousResumeBlock`) and accepts legacy
// stored `kind: "wakeup"` entries already inline in `triggers` unchanged.
// Total over every shape ever persisted: a pre-`wakeTriggers` block (absent
// key) and an already-domain-shaped block are both returned unchanged - the
// function itself tolerates the missing key rather than relying on a schema
// parse the raw storage path never runs.
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
    // `z.codec`'s `encode` callback receives the domain schema's INPUT shape
    // (nested trigger defaults not yet applied) and must return the persisted
    // schema's OUTPUT shape. Re-parsing through `domainAutonomousResumeBlockSchema`
    // applies those defaults so `encodeAutonomousResumeBlock` itself can stay
    // typed against the concrete, fully-defaulted `AutonomousResumeBlock` - the
    // shape every real caller (e.g. the host storage write funnel) has.
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
  // Who authored the steered message. Duplicated from the steered USER row
  // (`messageId`) on purpose: the two records have asymmetric durability - this
  // block is execution-owned and rewritten on every persistence checkpoint,
  // while the user row is written once into `chat.messages`. When a renderer
  // sees the block but not the row, it falls back to rendering the block's own
  // content, and without this field an agent-to-agent message would render as a
  // plain user-authored bubble - an agent impersonating the user. Carrying the
  // sender here means the fallback can never lose provenance.
  // Additive + nullable: blocks persisted before this field parse to `null`,
  // which the renderer treats exactly as it did before (a "you" row).
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
 *
 * EVIDENCE, not a renderer instruction. The GUI derives exact/inferred/neutral
 * presentation from whether this resolves against the persisted question - it
 * never trusts the evidence on its own, and it never persists the derived
 * label (a fidelity label recorded at write time goes stale the moment the
 * question list is rewritten by a fork or a replay).
 *
 * `questionIndex` is the answered question's position in the block's OWN
 * `questions` array - block-local, so it survives a fork that renumbers
 * nothing. `optionIndices` are positions in that question's `options`;
 * `optionLabels` is the parallel label snapshot, kept so a question list that
 * has since changed shape can still be checked for agreement rather than
 * silently resolving to the wrong option. `customText` is the free-text
 * ("Other") value when the user typed one, and never stands in for a
 * selection.
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
  // Structured provenance for a GUI-submitted answer. `values` stays canonical
  // - it is the ONLY form that reaches harness/provider formatting - and this
  // rides alongside it so history can be exact without changing any provider
  // payload contract. Null for every provider-originated answer (an adapter
  // opts in only when it has genuine native structured identity) and for every
  // row persisted before this field existed, which is why it is defaulted.
  //
  // `.catch(null)` on top of the default, and this is the load-bearing part:
  // corrupt evidence must downgrade THIS FIELD to neutral, never reject the
  // answer around it. Without it a single malformed `selection` fails the
  // answer, which fails the interview block, which fails the assistant
  // message, which fails the whole snapshot - so one bad provenance record
  // would cost the user their entire chat history rather than one card's
  // "exact" badge. `values` is the answer that actually matters and it stays
  // readable either way.
  selection: interviewSelectionEvidenceSchema
    .nullable()
    .default(null)
    .catch(null),
});
export type InterviewAnswer = z.infer<typeof interviewAnswerSchema>;

// Wire/persistence freeze of `interviewAnswerSchema` from before selection
// evidence existed. Bound - via the frozen block/content-block/message/chat
// trees and the frozen runtime-event unions - to every `chat.subscribe` line
// through `@1.6`, so none of them can observe `selection`. Hand-frozen
// field-for-field; NOT derived from the live shape.
export const interviewAnswerSchemaPreSettlement = z.object({
  questionId: z.string().nullable(),
  question: z.string().nullable(),
  values: z.array(z.string()),
  notes: z.string().nullable(),
});

/**
 * The canonical fact about how an interview ended, independent of the legacy
 * block `status`/`error` projection.
 *
 * - `answered` - submitted answers were accepted.
 * - `skipped` - the user explicitly declined to answer; drafts may be saved.
 * - `failed` - the interview could not be completed.
 *
 * A `null` outcome (the default) means the record cannot establish one: an old
 * row, or a block whose only terminal evidence is the legacy `status`. That is
 * WEAK authority - it blocks reopening but never manufactures an outcome.
 */
export const interviewOutcomeSchema = z.enum(["answered", "skipped", "failed"]);
export type InterviewOutcome = z.infer<typeof interviewOutcomeSchema>;

/**
 * Who settled the interview and under which durable settlement identity.
 *
 * Deliberately content-free: no answer, draft, question, or reason text. Its
 * whole job is to make merge and fork behavior replay-safe - `settlementId` is
 * the settlement idempotency key, so reapplying the same settlement is a
 * no-op, and `source` is what the reducer weighs when a later runtime cleanup
 * event contradicts an accepted GUI settlement.
 */
export const interviewSettlementAuthoritySchema = z.object({
  settlementId: z.string(),
  source: z.enum(["gui", "runtime"]),
});
export type InterviewSettlementAuthority = z.infer<
  typeof interviewSettlementAuthoritySchema
>;

/**
 * A content-free cleanup/conflict/delivery code recorded ALONGSIDE the
 * canonical outcome, never in place of it.
 *
 * This exists because legacy `error` was the only place a late adapter cleanup
 * could write, which made it a scratch field: an `interview.errored` arriving
 * after an accepted Skip would overwrite the user-visible skip reason with
 * adapter noise. Diagnostics are separately deduplicated by `diagnosticId`, so
 * replay cannot multiply them.
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
 * Content-free projection of the host's delivery outbox item for a DETACHED
 * settlement, joined by `settlementId`.
 *
 * The outbox is authoritative; this projection may lag and is repaired on
 * subscribe/reconciliation. Null for active waiters, provider-originated
 * settlement, legacy rows, and every pre-`1.7` peer - so "no delivery
 * projection" never reads as "delivery failed".
 */
export const interviewDeliveryProjectionSchema = z.object({
  deliveryId: z.string(),
  status: z.enum(["pending", "delivering", "delivered", "failed"]),
  retryable: z.boolean(),
  /**
   * Monotonic attempt/revision counter for THIS `deliveryId`, incremented by
   * the outbox each time it requeues the item.
   *
   * Status rank alone cannot order these updates. A retry legitimately moves
   * `failed → pending`, which is backwards by rank, so a merge that allowed it
   * on rank alone would also accept a STALE `pending` replayed after a later
   * failure - the two are indistinguishable without a generation. With it the
   * rule is exact: a requeue is valid only at a strictly newer generation, and
   * a stale or equal-generation `pending` cannot resurrect a settled attempt.
   *
   * Defaulted to `0` so a projection written before this field existed merges
   * as the oldest generation, which is the conservative reading for the
   * ordering rules: it can be advanced past by a newer generation.
   *
   * With ONE exception, and it is deliberate: `delivered` is absorbing across
   * generations, so a `delivered` projection at generation `0` still beats a
   * stored non-delivered one at any higher generation. Delivery is terminal -
   * the provider has the answer - and an attempt counter cannot make that
   * untrue. So "never displaces a newer one" holds for every status except
   * `delivered`; see `mergeDelivery` for the full order.
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
  // Raw tool input/output are NOT persisted: the card renders only the
  // questions/answers/title/description above. Interview detection consumes the
  // raw event input pre-persist (interview-detection.ts), never the stored block.
  error: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  // ─── Canonical settlement facts (additive; every field defaulted so an old
  // persisted row parses with no migration) ───────────────────────────────
  //
  // `status`/`answers`/`error` above remain a PROJECTION of these, regenerated
  // by the settlement reducer rather than mutated independently - see
  // `applyInterviewSettlement`.
  //
  // Every one of them also carries `.catch(...)`, for two reasons that point
  // the same way. First, the failure rule: malformed enhanced data downgrades
  // to neutral and must never invalidate the legacy projection an old renderer
  // still reads. Second, forward compatibility: these are CLOSED enums on a
  // record that is persisted AND published, so a newer writer adding an
  // `outcome`, a settlement `source` or a `delivery.status` value would
  // otherwise make every older reader reject the block outright. Degrading to
  // the "cannot establish a canonical fact" value is exactly the ambiguous
  // reading this contract already defines for a legacy row, so the fallback is
  // an honest state rather than an invented one.
  outcome: interviewOutcomeSchema.nullable().default(null).catch(null),
  // Saved-but-unsent values from an explicit Skip. These are history only:
  // they must never reach a harness/provider result, which is why they live in
  // their own field instead of being folded into `answers`.
  //
  // The catch is array-level, so one corrupt draft discards the whole draft
  // set rather than just itself - coarser than the per-answer `selection`
  // downgrade above. Accepted deliberately: drafts are history that was never
  // sent anywhere, so losing them degrades a "you had typed this" note, while
  // rejecting the block would lose the settled outcome itself.
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
   *
   * This exists to make one guarantee enforceable that otherwise cannot be:
   * `clearInterviewSettlement` - the single owner of "forget this interview
   * was ever settled", used by the `pending` fork disposition - can only clear
   * fields it knows about. A future minor that adds a terminal settlement fact
   * as a NEW TOP-LEVEL block key would be invisible to it, so a reopened fork
   * would carry a terminal fact into a fresh question. Nothing in a flat shape
   * prevents that, and no amount of documentation makes an older build clear a
   * key it has never heard of.
   *
   * So future settlement facts go in HERE. The clearer replaces the whole
   * envelope with `{}` rather than enumerating its contents, which means it
   * clears facts written by builds that postdate it. Unknown keys OUTSIDE the
   * envelope are framing/provider data and deliberately survive a clear - that
   * is the raw-overlay guarantee (`overlayInterviewSettlementPatch`) and it is
   * why this is a narrow envelope and not a catch-all.
   *
   * The current settlement fields stay top-level: they are named in the
   * contract, the reducer enumerates them, and a guard test asserts that
   * enumeration stays exhaustive against this schema. This envelope covers the
   * one case that guard cannot - a field that does not exist yet.
   */
  settlementExtensions: z.record(z.string(), z.unknown()).default({}).catch({}),
});
export type InterviewBlock = z.infer<typeof interviewBlockSchema>;

// Wire-freeze copy of `interviewBlockSchema` from before canonical settlement
// existed. Bound to every `chat.subscribe` line through `@1.6` so none of them
// observes `outcome`/`draftAnswers`/`settlement`/`diagnostics`/`delivery`, nor
// the answers' `selection`. Hand-frozen field-for-field; NOT derived from the
// live shape (a later field added above must not silently leak in here).
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

// ── Wire-freeze variants (pre-Reasonix) ─────────────────────────────────────
// These three block members carry harness ids through persisted assistant
// messages. Released `chat.subscribe@1.0–1.6` peers must never observe the
// Reasonix enum value, while keeping every other field they originally shipped.
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

// Carries a SECOND freeze the name does not record: `noticeKind` is pinned to
// the three kinds these lines shipped, so `harness_message` never reaches a
// released decoder. See `providerNoticeKindSchemaPreHarnessMessage`.
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
 * Persistence freeze for the Epic 2.0 contract: the complete live block
 * vocabulary with only harness-bearing members held to the pre-Reasonix enum.
 * Unlike the wire freezes below, this retains the live interview and image
 * shapes because those were already part of Epic 2.0 when Reasonix arrived.
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

// Wire-freeze copy of `contentBlockSchema` carrying THREE independent freezes,
// bound (via the frozen message/chat schemas) to every released
// `chat.subscribe@1.0-1.5` minor: `tool_call` swapped for its pre-image freeze
// (`toolCallBlockSchemaPreImage`, the only member that gains image data),
// `interview` swapped for its pre-settlement freeze so those lines never
// observe canonical interview settlement or answer selection evidence, and
// `text`/`plan`/`steer` swapped for their pre-Reasonix freezes so they never
// observe a harness id their enum cannot decode. The name records the FIRST
// freeze only - see the stacked comments on each swapped member. Every other
// member reuses the live sub-schema (same convention as
// `messageSchemaPreInReplyTo`).
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

// Wire-freeze copy of `contentBlockSchema` as `chat.subscribe@1.6` shipped it
// in `host-v1.2.0-rc.1`: the LIVE `tool_call` (that line does carry image
// results) with `interview` swapped for its pre-settlement freeze, so the RC
// cohort in the field keeps decoding exactly the block union it was shipped
// with. `text`/`plan`/`steer` additionally take their pre-Reasonix freezes:
// `1.6` is released with a nineteen-id harness enum, so it cannot observe a
// Reasonix id either. Bound to `@1.6` via `messageSchemaPreSettlement` /
// `chatSchemaV16`. Every other member reuses the live sub-schema.
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
