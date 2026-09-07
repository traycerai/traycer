import { z } from "zod";
import { commonRecordRegistry } from "@traycer/protocol/common/registry";
import {
  DEFAULT_AGENT_MODE,
  agentModeSchema,
  type AgentMode,
} from "@traycer/protocol/common/schemas";
import { getRecordSchema } from "@traycer/protocol/framework/index";
import { permissionModeSchema } from "@traycer/protocol/persistence/epic/foundation";

export { DEFAULT_AGENT_MODE, agentModeSchema, type AgentMode };

// ─── Harness identity ─────────────────────────────────────────────────────
export const harnessIdSchema = getRecordSchema(
  commonRecordRegistry,
  "harness-id",
  "latest",
);
export type HarnessId = z.infer<typeof harnessIdSchema>;

export const guiHarnessIdSchema = harnessIdSchema.extract([
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
  "reasonix",
]);
export type GuiHarnessId = z.infer<typeof guiHarnessIdSchema>;

/**
 * Frozen harness id set as the released `chat.subscribe@1.0-1.6` lines shipped it - i.e. everything before Reasonix, which first rides `1.7`. (`1.6` looked unreleased and is not: the committed released-baseline surface.
 * They are independent, and a future harness admitted to one line but frozen off the other would silently break whichever schema borrowed the wrong copy.
 */
export const guiHarnessIdSchemaPreReasonix = harnessIdSchema.extract([
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
export type GuiHarnessIdPreReasonix = z.infer<
  typeof guiHarnessIdSchemaPreReasonix
>;

/**
 * Frozen harness id set as shipped in protocol v1.0.
 * Do NOT add new harnesses here - extend the latest `guiHarnessIdSchema` and use the existing v2 bridge instead.
 */
export const guiHarnessIdSchemaV10 = harnessIdSchema.extract([
  "claude",
  "codex",
  "opencode",
  "traycer",
  "cursor",
]);
export type GuiHarnessIdV10 = z.infer<typeof guiHarnessIdSchemaV10>;

/**
 * Frozen harness id set as shipped in protocol v2.0 (before Amp).
 * Do NOT add new harnesses here - extend the latest `guiHarnessIdSchema` and use the existing version bridges instead.
 */
export const guiHarnessIdSchemaV20 = harnessIdSchema.extract([
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
]);
export type GuiHarnessIdV20 = z.infer<typeof guiHarnessIdSchemaV20>;

/**
 * Frozen harness id set as shipped in protocol v3.0 (with Amp, before Devin/Pi).
 * Do NOT add new harnesses here - extend the latest `guiHarnessIdSchema` and use the existing version bridges instead.
 */
export const guiHarnessIdSchemaV30 = harnessIdSchema.extract([
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
]);
export type GuiHarnessIdV30 = z.infer<typeof guiHarnessIdSchemaV30>;

/**
 * Frozen harness id set as shipped in protocol v4.0 (with Devin/Pi, before Hermes/omp).
 * Do NOT add new harnesses here - extend the latest `guiHarnessIdSchema` and use the existing bridges instead.
 */
export const guiHarnessIdSchemaV40 = harnessIdSchema.extract([
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
]);
export type GuiHarnessIdV40 = z.infer<typeof guiHarnessIdSchemaV40>;

/**
 * Frozen harness id set as shipped in protocol v5.0 (with Hermes, before omp).
 * Do NOT add new harnesses here - extend the latest `guiHarnessIdSchema` and use the existing v6 bridge instead.
 */
export const guiHarnessIdSchemaV50 = harnessIdSchema.extract([
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
]);
export type GuiHarnessIdV50 = z.infer<typeof guiHarnessIdSchemaV50>;

/**
 * Frozen harness id set as shipped in protocol v6.0 (with omp, before Hugging Face).
 * Do NOT add new harnesses here - extend the latest `guiHarnessIdSchema` and use the existing v7 bridge instead.
 */
export const guiHarnessIdSchemaV60 = harnessIdSchema.extract([
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
]);
export type GuiHarnessIdV60 = z.infer<typeof guiHarnessIdSchemaV60>;

/**
 * Frozen harness id set as shipped in protocol v7.0 (with Hugging Face).
 * Do NOT add new harnesses here - extend the latest `guiHarnessIdSchema`; a v8.0 bridge drops post-v7.0 ids for older callers.
 */
export const guiHarnessIdSchemaV70 = harnessIdSchema.extract([
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
export type GuiHarnessIdV70 = z.infer<typeof guiHarnessIdSchemaV70>;

export const tuiHarnessIdSchema = harnessIdSchema.extract([
  "claude",
  "codex",
  "opencode",
  "cursor",
]);
export type TuiHarnessId = z.infer<typeof tuiHarnessIdSchema>;

export type A2ACapabilityTarget = {
  readonly surface: "gui" | "tui";
  readonly harnessId: string | null;
};

/**
 * A2A participation is TWO capabilities, not one, because the host owns two independent transports and they do not cover the same harnesses
 * INBOUND DELIVERY ({@link canReceiveA2AMessages}) - something can WAKE the agent and hand it a message it never asked for.
 */
export function canUseA2ATools(target: A2ACapabilityTarget): boolean {
  if (target.surface === "gui") return true;
  return (
    target.harnessId === "claude" ||
    target.harnessId === "codex" ||
    target.harnessId === "opencode"
  );
}

/**
 * Can this agent be the RECEIVER of an A2A message - i.e. is there a transport that will wake it and hand the message over?
 * A tool-capable agent that fails this check can still send; it just cannot be sent to, so it must never be promised a reply.
 */
export function canReceiveA2AMessages(target: A2ACapabilityTarget): boolean {
  if (target.surface === "gui") return true;
  return target.harnessId === "claude";
}

// ─── Shared A2A message-size gate ──────────────────────────────────────────
// One accepted message is either stored in full or the send is rejected before delivery/capture - truncation is never a recovery strategy.

/** Shared UTF-8 byte ceiling for a single A2A message body. */
export const A2A_MESSAGE_MAX_UTF8_BYTES = 16 * 1024 * 1024;

// Re-exported, not defined here: it moved to `utils/text/utf8` once the transcript skeleton needed the same count.
export { utf8ByteLength } from "@traycer/protocol/utils/text/utf8";

// ─── Agent-to-agent unary surface (`agent.create` / `agent.list` / `agent.sendMessage` / `agent.getTranscript`) ─────────────────────────────
// Other RPCs address the agent by id and resolve `surface` from storage; they do not carry it on the wire.

export const AGENT_FACING_HARNESS_IDS = [
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
  "reasonix",
] as const;

export const AGENT_FACING_HARNESS_ID_LIST = AGENT_FACING_HARNESS_IDS.join(", ");

export const agentFacingHarnessIdSchema = harnessIdSchema.extract([
  ...AGENT_FACING_HARNESS_IDS,
]);
export type AgentFacingHarnessId = z.infer<typeof agentFacingHarnessIdSchema>;

/** A directory to bind to a created agent. */
export const createAgentWorkspaceEntrySchema = z.object({
  path: z.string(),
  // The source workspace `path` belongs to. Null (or omitted) means `path` IS
  // the workspace - an existing folder bound as-is, no worktree.
  workspacePath: z.string().nullable().default(null),
});
export type CreateAgentWorkspaceEntry = z.infer<
  typeof createAgentWorkspaceEntrySchema
>;

export const createAgentWorkspaceSchema = z
  .object({
    entries: z.array(createAgentWorkspaceEntrySchema),
  })
  .nullable()
  .default(null);
export type CreateAgentWorkspace = z.infer<typeof createAgentWorkspaceSchema>;

/**
 * Reserved `profileId` value naming the provider's ambient CLI login (mirrors the host's persisted `AMBIENT_PROFILE_ID` sentinel).
 * Ambient is expressed exclusively through `{ kind: "ambient" }` - a managed `{ kind: "profile" }` arm must never carry this literal as its `profileId`, or the two arms could claim the same identity through disagreeing.
 */
export const AMBIENT_PROFILE_ID_SENTINEL = "ambient";

const managedProfileIdSchema = z
  .string()
  .refine((profileId) => profileId !== AMBIENT_PROFILE_ID_SENTINEL, {
    message:
      'profileId must not be the reserved "ambient" sentinel - use { kind: "ambient" } to select the ambient login.',
  });

/**
 * `agent.create@1.0` - Explicit selection of which provider profile (subscription) an agent surface should use.
 * Never offered by new discovery, rate-limit, configuration, tool, or CLI contracts - see the A2A profile-awareness ticket's guardrails.
 */
export const profileSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("last_used") }),
  z.object({ kind: z.literal("ambient") }),
  z.object({ kind: z.literal("profile"), profileId: managedProfileIdSchema }),
  z.object({ kind: z.literal("inherit_sender") }),
]);
export type ProfileSelection = z.infer<typeof profileSelectionSchema>;

export const concreteProfileSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ambient") }),
  z.object({ kind: z.literal("profile"), profileId: managedProfileIdSchema }),
]);
export type ConcreteProfileSelection = z.infer<
  typeof concreteProfileSelectionSchema
>;

/**
 * `agent.create@1.0` - agent-to-agent spawn.
 * `model`, `agentMode`, `reasoningEffort`, and `fastMode` are explicit nullable overrides.
 */
export const createAgentRequestSchema = z.object({
  senderAgentId: z.string(),
  epicId: z.string(),
  name: z.string().min(1).nullable().default(null),
  surface: z.enum(["gui", "tui"]).nullable(),
  harnessId: agentFacingHarnessIdSchema.nullable(),
  model: z.string().nullable(),
  agentMode: agentModeSchema.nullable(),
  reasoningEffort: z.string().nullable(),
  fastMode: z.boolean().nullable(),
  workspace: createAgentWorkspaceSchema,
  profileId: z.string().nullable().default(null),
});
export type CreateAgentRequest = z.infer<typeof createAgentRequestSchema>;

export const createAgentResponseSchema = z.object({
  agentId: z.string(),
  warnings: z.array(z.string()),
});
export type CreateAgentResponse = z.infer<typeof createAgentResponseSchema>;

/**
 * Frozen `agent.create@2.0` request - identical to v1.0 except the nullable `profileId` override is replaced by an explicit `profileSelection` (see `ProfileSelection` above).
 * Removing `profileId` is why this ships as a new major rather than an additive minor: v1.0 stays frozen and reachable through `agentCreateUpgradeV10ToV20` / `agentCreateDowngradeV20ToV10` in `contracts.ts`.
 */
export const createAgentRequestSchemaV20 = z.object({
  senderAgentId: z.string(),
  epicId: z.string(),
  name: z.string().min(1).nullable().default(null),
  surface: z.enum(["gui", "tui"]).nullable(),
  harnessId: agentFacingHarnessIdSchema.nullable(),
  model: z.string().nullable(),
  agentMode: agentModeSchema.nullable(),
  reasoningEffort: z.string().nullable(),
  fastMode: z.boolean().nullable(),
  workspace: createAgentWorkspaceSchema,
  profileSelection: profileSelectionSchema,
});
export type CreateAgentRequestV20 = z.infer<typeof createAgentRequestSchemaV20>;

/** `agent.create@3.0` adds the required permission-mode choice. */
export const createAgentRequestSchemaV30 = createAgentRequestSchemaV20.extend({
  permissionMode: permissionModeSchema.nullable(),
});
export type CreateAgentRequestV30 = z.infer<typeof createAgentRequestSchemaV30>;

export const agentSelectionGuideRequestSchema = z.object({
  epicId: z.string(),
  senderAgentId: z.string(),
});
export type AgentSelectionGuideRequest = z.infer<
  typeof agentSelectionGuideRequestSchema
>;

// A single contributing guide file.
export const agentSelectionGuideSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("workspace"),
    workspacePath: z.string(),
    path: z.string(),
    priority: z.number(),
    content: z.string(),
  }),
  z.object({
    kind: z.literal("global"),
    path: z.string(),
    priority: z.number(),
    content: z.string(),
  }),
]);
export type AgentSelectionGuideResponseSource = z.infer<
  typeof agentSelectionGuideSourceSchema
>;

export const agentSelectionGuideResponseSchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      status: z.literal("found"),
      sources: z.array(agentSelectionGuideSourceSchema),
    }),
    z.object({
      status: z.literal("not_found"),
      message: z.string(),
    }),
  ],
);
export type AgentSelectionGuideResponse = z.infer<
  typeof agentSelectionGuideResponseSchema
>;

// Settings/onboarding surface for the global guide file (~/.traycer/...).
export const agentSelectionGuideGlobalGetRequestSchema = z.object({});
export type AgentSelectionGuideGlobalGetRequest = z.infer<
  typeof agentSelectionGuideGlobalGetRequestSchema
>;

export const agentSelectionGuideGlobalGetResponseSchema = z.object({
  content: z.string(),
  generatedDefaultContent: z.string(),
});
export type AgentSelectionGuideGlobalGetResponse = z.infer<
  typeof agentSelectionGuideGlobalGetResponseSchema
>;

export const agentSelectionGuideGlobalOnboardingDraftGetRequestSchema =
  z.object({});
export type AgentSelectionGuideGlobalOnboardingDraftGetRequest = z.infer<
  typeof agentSelectionGuideGlobalOnboardingDraftGetRequestSchema
>;

export const agentSelectionGuideGlobalOnboardingDraftGetResponseSchema =
  z.object({
    content: z.string().nullable(),
    generatedDefaultContent: z.string(),
    providersSettled: z.boolean(),
  });
export type AgentSelectionGuideGlobalOnboardingDraftGetResponse = z.infer<
  typeof agentSelectionGuideGlobalOnboardingDraftGetResponseSchema
>;

export const agentSelectionGuideGlobalSetRequestSchema = z.object({
  content: z.string(),
});
export type AgentSelectionGuideGlobalSetRequest = z.infer<
  typeof agentSelectionGuideGlobalSetRequestSchema
>;

export const agentSelectionGuideGlobalSetResponseSchema = z.object({
  content: z.string(),
  generatedDefaultContent: z.string(),
});
export type AgentSelectionGuideGlobalSetResponse = z.infer<
  typeof agentSelectionGuideGlobalSetResponseSchema
>;

export const agentSelectionGuideGlobalResetRequestSchema = z.object({});
export type AgentSelectionGuideGlobalResetRequest = z.infer<
  typeof agentSelectionGuideGlobalResetRequestSchema
>;

export const agentSelectionGuideGlobalResetResponseSchema = z.object({
  content: z.string(),
  generatedDefaultContent: z.string(),
});
export type AgentSelectionGuideGlobalResetResponse = z.infer<
  typeof agentSelectionGuideGlobalResetResponseSchema
>;

export const listHarnessModelsRequestSchemaV10 = z.object({
  epicId: z.string(),
  senderAgentId: z.string(),
  harnessId: agentFacingHarnessIdSchema,
});
export type ListHarnessModelsRequestV10 = z.infer<
  typeof listHarnessModelsRequestSchemaV10
>;

export const listHarnessModelsRequestSchemaV20 = z.object({
  epicId: z.string().nullable().default(null),
  senderAgentId: z.string().nullable().default(null),
  harnessId: agentFacingHarnessIdSchema,
});
export const listHarnessModelsRequestSchema = listHarnessModelsRequestSchemaV20;
export type ListHarnessModelsRequest = z.infer<
  typeof listHarnessModelsRequestSchemaV20
>;

export const harnessModelSummarySchema = z.object({
  id: z.string(),
  reasoningEfforts: z.array(z.string()),
  fastModeAvailable: z.boolean(),
});
export type HarnessModelSummary = z.infer<typeof harnessModelSummarySchema>;

export const listHarnessModelsResponseSchema = z.object({
  harnessId: agentFacingHarnessIdSchema,
  models: z.array(harnessModelSummarySchema),
});
export type ListHarnessModelsResponse = z.infer<
  typeof listHarnessModelsResponseSchema
>;

/** Per-row shape returned by `agent.list@1.0`. */
const releasedAgentSummarySchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  hostId: z.string(),
  isLocal: z.boolean(),
  surface: z.enum(["gui", "tui"]),
  harnessId: harnessIdSchema.nullable(),
  isSelf: z.boolean(),
  /** Human-facing title of the chat/TUI agent. */
  title: z.string().nullable(),
  capabilities: z.object({
    readTranscript: z.boolean(),
    sendMessage: z.boolean(),
  }),
  /**
   * Whether the agent is actively executing right now - a GUI turn running or a TUI CLI producing output.
   */
  active: z.boolean(),
  /**
   * Absolute working directories the agent runs against, so a caller can see where each agent operates.
   * Empty for cross-host GUI rows whose local paths the responding host cannot resolve.
   */
  folderPaths: z.array(z.string()),
  /**
   * Whether the agent runs in a dedicated git worktree (any bound entry is in worktree mode) rather than directly in a workspace folder.
   */
  isWorktree: z.boolean(),
});

export const agentRunConfigSchema = z.object({
  model: z.union([
    z.object({ kind: z.literal("concrete"), slug: z.string() }),
    z.object({ kind: z.literal("provider-default") }),
  ]),
  reasoningEffort: z.string().nullable(),
  fastMode: z.boolean().nullable(),
});
export type AgentRunConfig = z.infer<typeof agentRunConfigSchema>;

export const agentSummarySchema = releasedAgentSummarySchema.extend({
  runConfig: agentRunConfigSchema.nullable().default(null),
});
export type AgentSummary = z.infer<typeof agentSummarySchema>;

export const listAgentsScopeSchema = z.enum(["user", "all"]);
export type ListAgentsScope = z.infer<typeof listAgentsScopeSchema>;

export const listAgentsRequestSchema = z.object({
  epicId: z.string(),
  senderAgentId: z.string(),
  scope: listAgentsScopeSchema,
});
export type ListAgentsRequest = z.infer<typeof listAgentsRequestSchema>;

export const listAgentsResponseSchema = z.object({
  caller: z.object({
    agentId: z.string(),
    canSendMessages: z.boolean(),
  }),
  scope: listAgentsScopeSchema,
  agents: z.array(agentSummarySchema),
});
export type ListAgentsResponse = z.infer<typeof listAgentsResponseSchema>;

// ── Frozen protocol-v1.0 agent.list response ─────────────────────────────── `agent.list` enumerates every agent in the epic - including ACP GUI harness chats a newer client created - and the `traycer` CLI inlines the.
// Do not add new harnesses here - use the existing v2 bridge.
export const agentSummarySchemaV10 = releasedAgentSummarySchema.extend({
  harnessId: harnessIdSchema
    .extract(["claude", "codex", "opencode", "traycer", "cursor"])
    .nullable(),
});
export const listAgentsResponseSchemaV10 = listAgentsResponseSchema.extend({
  agents: z.array(agentSummarySchemaV10),
});
export type ListAgentsResponseV10 = z.infer<typeof listAgentsResponseSchemaV10>;

// ── Frozen protocol-v2.0 agent.list response (before Amp) ────────────────── `agent.list` enumerates every agent in the epic - including Amp GUI harness chats a newer client created - so an already-shipped v2.0 client.
// Do not add new harnesses here - use the existing version bridges.
export const agentSummarySchemaV20 = releasedAgentSummarySchema.extend({
  harnessId: guiHarnessIdSchemaV20.nullable(),
});
export const listAgentsResponseSchemaV20 = listAgentsResponseSchema.extend({
  agents: z.array(agentSummarySchemaV20),
});
export type ListAgentsResponseV20 = z.infer<typeof listAgentsResponseSchemaV20>;

// ── Frozen protocol-v3.0 agent.list response (with Amp, before Devin/Pi) ─── `agent.list` enumerates every agent in the epic - including Devin/Pi GUI harness chats a newer client created - so an already-shipped v3.0.
// Do not add new harnesses here - use the existing version bridges.
export const agentSummarySchemaV30 = releasedAgentSummarySchema.extend({
  harnessId: guiHarnessIdSchemaV30.nullable(),
});
export const listAgentsResponseSchemaV30 = listAgentsResponseSchema.extend({
  agents: z.array(agentSummarySchemaV30),
});
export type ListAgentsResponseV30 = z.infer<typeof listAgentsResponseSchemaV30>;

// ── Frozen protocol-v4.0 agent.list response (with Devin/Pi, pre-Hermes/omp) ─ `agent.list` enumerates every agent in the epic - including Hermes/omp GUI harness chats a newer client created - so an already-shipped v4.0.
// Do not add new harnesses here - use the existing v5 bridge.
export const agentSummarySchemaV40 = releasedAgentSummarySchema.extend({
  harnessId: guiHarnessIdSchemaV40.nullable(),
});
export const listAgentsResponseSchemaV40 = listAgentsResponseSchema.extend({
  agents: z.array(agentSummarySchemaV40),
});
export type ListAgentsResponseV40 = z.infer<typeof listAgentsResponseSchemaV40>;

// ── Frozen protocol-v5.0 agent.list response (with Hermes, before omp) ────── `agent.list` enumerates every agent in the epic - including omp GUI harness chats a newer client created - so an already-shipped v5.0 client.
// Do not add new harnesses here - use the existing v6 bridge.
export const agentSummarySchemaV50 = releasedAgentSummarySchema.extend({
  harnessId: guiHarnessIdSchemaV50.nullable(),
});
export const listAgentsResponseSchemaV50 = listAgentsResponseSchema.extend({
  agents: z.array(agentSummarySchemaV50),
});
export type ListAgentsResponseV50 = z.infer<typeof listAgentsResponseSchemaV50>;

// ── Frozen protocol-v6.0 agent.list response (with omp, pre-Hugging Face) ─── `agent.list` enumerates every agent in the epic - including Hugging Face GUI harness chats a newer client created - so an already-shipped.
// Do not add new harnesses here - use the existing v7 bridge.
export const agentSummarySchemaV60 = releasedAgentSummarySchema.extend({
  harnessId: guiHarnessIdSchemaV60.nullable(),
});
export const listAgentsResponseSchemaV60 = listAgentsResponseSchema.extend({
  agents: z.array(agentSummarySchemaV60),
});
export type ListAgentsResponseV60 = z.infer<typeof listAgentsResponseSchemaV60>;

// ── Frozen protocol-v7.0 agent.list response (with Hugging Face, pre-Reasonix) `agent.list` enumerates every agent in the epic - including Reasonix GUI harness chats a newer client created - so an already-shipped v7.0.
// Do not add new harnesses here - use the existing v8 bridge.
export const agentSummarySchemaV70 = releasedAgentSummarySchema.extend({
  harnessId: guiHarnessIdSchemaV70.nullable(),
  runConfig: agentRunConfigSchema.nullable().default(null),
});
export const listAgentsResponseSchemaV70 = listAgentsResponseSchema.extend({
  agents: z.array(agentSummarySchemaV70),
});
export type ListAgentsResponseV70 = z.infer<typeof listAgentsResponseSchemaV70>;

/** `agent.sendMessage@1.0` - fire-and-forget enqueue from one agent to another. */
export const sendAgentMessageRequestSchema = z.object({
  senderAgentId: z.string(),
  epicId: z.string(),
  receiverAgentId: z.string(),
  prompt: z.string(),
  responseId: z.string().nullable(),
  expectReply: z.boolean(),
});
export type SendAgentMessageRequest = z.infer<
  typeof sendAgentMessageRequestSchema
>;

/**
 * `responseId` is the broker-minted thread id when the request carried `expectReply=true` - the receiver passes it back on its reply.
 */
export const sendAgentMessageResponseSchema = z.object({
  responseId: z.string().nullable(),
});
export type SendAgentMessageResponse = z.infer<
  typeof sendAgentMessageResponseSchema
>;

/**
 * `agent.getTranscript@1.0` - flatten an agent's conversation into an XML-tagged string so a sibling agent can read it without re-implementing the discriminated `messageSchema` shape.
 */
export const getAgentTranscriptRequestSchema = z.object({
  epicId: z.string(),
  agentId: z.string(),
});
export type GetAgentTranscriptRequest = z.infer<
  typeof getAgentTranscriptRequestSchema
>;

export const getAgentTranscriptResponseSchema = z.object({
  transcript: z.string(),
});
export type GetAgentTranscriptResponse = z.infer<
  typeof getAgentTranscriptResponseSchema
>;

/** `agent.stop@1.0` - halt a running agent and, optionally, the subtree it delegated to. */
export const stopAgentRequestSchema = z.object({
  epicId: z.string(),
  agentId: z.string(),
  cascade: z.boolean(),
});
export type StopAgentRequest = z.infer<typeof stopAgentRequestSchema>;

/**
 * The set the resolver actually stopped: the addressed agent plus, when `cascade` was set, every active descendant it reached.
 * Output only - the caller never sends a list of ids.
 */
export const stopAgentResponseSchema = z.object({
  stoppedAgentIds: z.array(z.string()),
});
export type StopAgentResponse = z.infer<typeof stopAgentResponseSchema>;

/**
 * `agent.fork`'s omit-default profile override.
 * Shares `managedProfileIdSchema`'s reserved-`"ambient"`-sentinel rejection: a `profile` arm can never name the literal ambient sentinel as a managed profile id - that intent is expressed exclusively through `{ kind.
 */
export const forkAgentProfileSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inherit") }),
  z.object({ kind: z.literal("ambient") }),
  z.object({ kind: z.literal("profile"), profileId: managedProfileIdSchema }),
]);
export type ForkAgentProfileSelection = z.infer<
  typeof forkAgentProfileSelectionSchema
>;

/**
 * `agent.fork@1.0` - clone an existing local agent (GUI chat or Claude Code terminal session) into a NEW agent seeded from the source's latest available checkpoint.
 */
export const forkAgentRequestSchema = z.object({
  epicId: z.string(),
  senderAgentId: z.string(),
  agentId: z.string(),
  name: z.string().min(1).nullable().default(null),
  permissionMode: permissionModeSchema,
  workspace: createAgentWorkspaceSchema,
  profileSelection: forkAgentProfileSelectionSchema,
});
export type ForkAgentRequest = z.infer<typeof forkAgentRequestSchema>;

/**
 * Mirrors `AgentForkResponse` (`agent-fork-service.ts`) field-for-field.
 */
export const forkAgentResponseSchema = z.object({
  agentId: z.string(),
  sourceAgentId: z.string(),
  forkedFromMessageId: z.string().nullable(),
  warnings: z.array(z.string()),
  effectiveProfileId: z.string().nullable(),
  profileOverrideApplied: z.boolean(),
});
export type ForkAgentResponse = z.infer<typeof forkAgentResponseSchema>;
