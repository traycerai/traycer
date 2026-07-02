import { z } from "zod";
import { commonRecordRegistry } from "@traycer/protocol/common/registry";
import {
  DEFAULT_AGENT_MODE,
  agentModeSchema,
  type AgentMode,
} from "@traycer/protocol/common/schemas";
import { getRecordSchema } from "@traycer/protocol/framework/index";

export { DEFAULT_AGENT_MODE, agentModeSchema, type AgentMode };

// ─── Harness identity ─────────────────────────────────────────────────────
//
// A "harness" is a coding-agent CLI that Traycer drives - Claude Code, Codex
// CLI, OpenCode, etc. The same vendor is addressed by both surfaces:
//
//   - **GUI** agents render in a chat tab. The host drives the harness via
//     SDK / JSON-RPC and streams `RuntimeEvent` chunks back over the chat
//     subscription.
//   - **TUI** agents render in a real terminal tab. The host's job is to
//     prepare a launch (working dir, additional dirs, harness session id,
//     shell command/argv); the CLI itself runs interactively in the user's
//     PTY.
//
// `harnessIdSchema` is the canonical vendor enum used by adapter registries,
// persistence, and cross-surface RPCs (`agent.create` / `agent.list` /
// `agent.sendMessage` / `agent.getTranscript`). The narrower `guiHarnessIdSchema`
// and `tuiHarnessIdSchema` are derived via `.extract()` so adding a vendor
// to one surface without first adding it to the canonical list is a compile
// error. Subtyping flows: `GuiHarnessId extends HarnessId` and
// `TuiHarnessId extends HarnessId` are both true at the type level, so a
// surface-narrow value passes everywhere a `HarnessId` is expected.
//
// Cursor supports BOTH surfaces at the schema level: the GUI chat tab drives
// the `@cursor/sdk` agent runtime in local mode, and the TUI tab can launch the
// `cursor-agent` CLI in a PTY. It is therefore listed in `harnessIdSchema` and
// in BOTH `guiHarnessIdSchema` and `tuiHarnessIdSchema`. The TUI surface is
// hidden in the renderer for now (the adapter advertises only the GUI mode via
// `listGuiHarnesses`'s `modes` field) until the CLI reaches feature parity.
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
]);
export type GuiHarnessId = z.infer<typeof guiHarnessIdSchema>;

/**
 * Frozen harness id set as shipped in protocol v1.0. Used only by the frozen
 * v1.0 response schema of `agent.gui.listHarnesses` so a v1.0 client (which
 * predates the ACP GUI harnesses) negotiates a wire that can never carry them;
 * the v2.0 line adds them and a v2→v1 downgrade bridge filters them for v1.0
 * callers. Do NOT add new harnesses here - extend the latest
 * `guiHarnessIdSchema` and use the existing v2 bridge instead.
 */
export const guiHarnessIdSchemaV10 = harnessIdSchema.extract([
  "claude",
  "codex",
  "opencode",
  "traycer",
  "cursor",
]);
export type GuiHarnessIdV10 = z.infer<typeof guiHarnessIdSchemaV10>;

export const tuiHarnessIdSchema = harnessIdSchema.extract([
  "claude",
  "codex",
  "opencode",
  "cursor",
]);
export type TuiHarnessId = z.infer<typeof tuiHarnessIdSchema>;

/**
 * Agent-to-agent participation gate — the single source of truth for which
 * agents can take part in A2A messaging:
 *
 *   - every GUI agent (A2A is provider-native via the MCP bridge), and
 *   - Claude Code TUI agents (the only TUI with monitor-backed inbox/reply).
 *
 * Other TUI harnesses (codex, opencode, cursor) have no inbox transport. Use
 * this for create/send gates; read-only discovery/transcript paths can still
 * show them.
 *
 * Note: this is purely the A2A gate. It is intentionally NOT the gate for
 * epic activity tracking — every agent (including codex/opencode TUI) still
 * contributes activity for the YJS-warmth signal.
 */
export function canParticipateInA2A(target: {
  readonly surface: "gui" | "tui";
  readonly harnessId: string | null;
}): boolean {
  if (target.surface === "gui") return true;
  return target.harnessId === "claude";
}

// ─── Agent-to-agent unary surface (`agent.create` / `agent.list` /
// `agent.sendMessage` / `agent.getTranscript`) ─────────────────────────────
//
// Minimal unified abstraction over GUI agents (epic `chats` Y.Map) and TUI
// agents (epic `tuiAgents` Y.Map) for agent-to-agent traffic. User-facing
// chat sends keep using the streaming `chat.subscribe` surface - these RPCs
// are *only* the spawn / address / hand-off path that agents use to talk to
// each other.
//
// `surface` is required only on `agent.create` (no entity exists yet) and
// surfaces back as a per-row field in `agent.list`'s response so the
// renderer routes to the right UI. Other RPCs address the agent by id and
// resolve `surface` from storage; they do not carry it on the wire.

export const agentFacingHarnessIdSchema = harnessIdSchema.extract([
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
export type AgentFacingHarnessId = z.infer<typeof agentFacingHarnessIdSchema>;

/**
 * A directory to bind to a created agent. Intent-level on purpose: the caller
 * supplies the runnable `path` (e.g. one returned by `worktree.createPaths`)
 * and, when that path is a worktree, the source `workspacePath` it belongs to.
 * The host derives the rest when it persists the binding:
 *  - mode (`local` vs `worktree`) from whether `path` differs from the resolved
 *    workspace path,
 *  - `repoIdentifier` from the workspace's git remote,
 *  - primacy from order (the first entry is the working directory).
 * This mirrors the CLI's `--cwd` / `--workspace-entry <src>=<run>` ergonomics.
 */
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
 * `agent.create@1.0` - agent-to-agent spawn. The sender (an agent already
 * running in the epic) asks the host to mint a new agent record.
 *
 *   - `surface` / `harnessId` non-null → use the requested surface/harness.
 *   - `surface` null, `harnessId` non-null → infer surface from the sender
 *     and requested harness.
 *   - both null → inherit the sender agent's surface and harness.
 *
 * `model`, `agentMode`, `reasoningEffort`, and `fastMode` are explicit
 * nullable overrides. `null` means "not requested"; the resolver fills
 * defaults and returns warnings for currently unsupported combinations instead
 * of rejecting the whole create.
 *
 * The new agent's `parentId` is set to `senderAgentId` so the epic projection
 * can render the spawn lineage without a separate join.
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
});
export type CreateAgentRequest = z.infer<typeof createAgentRequestSchema>;

export const createAgentResponseSchema = z.object({
  agentId: z.string(),
  warnings: z.array(z.string()),
});
export type CreateAgentResponse = z.infer<typeof createAgentResponseSchema>;

export const agentSelectionGuideRequestSchema = z.object({
  epicId: z.string(),
  senderAgentId: z.string(),
});
export type AgentSelectionGuideRequest = z.infer<
  typeof agentSelectionGuideRequestSchema
>;

// A single contributing guide file. The host resolves every non-empty guide
// and hands the formatter everything it needs to render without parsing:
//   - `workspacePath` (workspace scope only) is the workspace root the guide
//     governs, used for the section header — no path stripping at render time.
//   - `priority` orders the layered output (higher = more specific; wins on
//     conflict), so the formatter never relies on array order.
//   - `path` is the absolute guide file, kept for attribution.
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
// Distinct from `agent.selectionGuide`, which resolves the full
// workspace+global hierarchy for an agent. These are default-host scoped and
// carry no epic. Provider choices are already host state, so the host computes
// the generated default from its current provider configuration.
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

export const listHarnessModelsRequestSchema = z.object({
  epicId: z.string(),
  senderAgentId: z.string(),
  harnessId: agentFacingHarnessIdSchema,
});
export type ListHarnessModelsRequest = z.infer<
  typeof listHarnessModelsRequestSchema
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

/**
 * Per-row shape returned by `agent.list@1.0`. A flat array (not a
 * uuid-keyed map) so the wire shape lines up with `listEpicCollaborators`
 * and the rest of the `list*` family in this registry.
 *
 * `surface` lets a caller route to the right per-agent UI (e.g. fetch a
 * GUI chat transcript vs a TUI scrollback) without a second round-trip.
 * `isLocal` is the host's authoritative answer to "did I mint this
 * session?" - `hostId` equals the responding host's id. Cross-host
 * entries are returned for read-only enumeration; mutating RPCs
 * (`agent.sendMessage`) reject them with `RECEIVER_NOT_LOCAL` until the
 * relay/mailbox transport lands.
 */
export const agentSummarySchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  hostId: z.string(),
  isLocal: z.boolean(),
  surface: z.enum(["gui", "tui"]),
  harnessId: harnessIdSchema.nullable(),
  isSelf: z.boolean(),
  /**
   * Human-facing title of the chat/TUI agent. Sourced from the epic Y.Doc
   * (which replicates cross-host), so it is populated for every row regardless
   * of locality - unlike `folderPaths`/`active`, which are local-only. `null`
   * when the agent has not been titled yet.
   */
  title: z.string().nullable(),
  capabilities: z.object({
    readTranscript: z.boolean(),
    sendMessage: z.boolean(),
  }),
  /**
   * Whether the agent is actively executing right now - a GUI turn running
   * or a TUI CLI producing output. Sourced from the activity tracker's
   * `hasActivity` level (NOT effective-active: an agent merely owing an A2A
   * reply is not "working"). `false` for cross-host rows and whenever the
   * responding host has no activity tracker wired.
   */
  active: z.boolean(),
  /**
   * Absolute working directories the agent runs against, so a caller can see
   * where each agent operates. For an agent bound to git worktrees these are
   * the worktree paths; otherwise the epic's workspace folders (TUI agents
   * persist their own; GUI chats inherit the epic's). Empty for cross-host
   * GUI rows whose local paths the responding host cannot resolve.
   */
  folderPaths: z.array(z.string()),
  /**
   * Whether the agent runs in a dedicated git worktree (any bound entry is in
   * worktree mode) rather than directly in a workspace folder. `false` for
   * cross-host rows and agents with no local worktree binding.
   */
  isWorktree: z.boolean(),
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

// ── Frozen protocol-v1.0 agent.list response ───────────────────────────────
// `agent.list` enumerates every agent in the epic - including ACP GUI harness
// chats a newer client created - and the `traycer` CLI inlines the protocol at
// build time, so an old CLI would hit a strict enum on those rows. v1.0 is
// frozen; the v2.0 line carries them and a v2→v1 bridge drops them for v1.0
// callers. Do not add new harnesses here - use the existing v2 bridge.
export const agentSummarySchemaV10 = agentSummarySchema.extend({
  harnessId: harnessIdSchema
    .extract(["claude", "codex", "opencode", "traycer", "cursor"])
    .nullable(),
});
export const listAgentsResponseSchemaV10 = listAgentsResponseSchema.extend({
  agents: z.array(agentSummarySchemaV10),
});
export type ListAgentsResponseV10 = z.infer<typeof listAgentsResponseSchemaV10>;

/**
 * `agent.sendMessage@1.0` - fire-and-forget enqueue from one agent to
 * another. Distinct from `chat.subscribe`'s `send` action: that surface
 * streams a turn back to a UI client; this surface hands a prompt off to
 * another agent's runtime and returns immediately. Any reply travels back
 * via a separate `agent.sendMessage` call from the receiver, with
 * `responseId` set to correlate against the original prompt.
 *
 *   - `expectReply` drives broker thread tracking. When `true`, the
 *     host registers a pending request (idempotent per sender→receiver
 *     pair) and returns its `responseId`; the receiver echoes that id on
 *     its final reply (sent as a separate `agent.sendMessage` with
 *     `expectReply=false`) to close the thread. The broker's inactivity
 *     sweep surfaces a stalled-receiver notice to the sender if no
 *     progress happens within the window.
 *   - When `expectReply=false`, a non-null `responseId` closes an open
 *     thread; a null `responseId` is a one-shot delivery the sender does
 *     not want correlated.
 *   - Cross-host receivers are rejected with `RECEIVER_NOT_LOCAL`. The
 *     epic Y.Doc already replicates artifact records cross-host, but
 *     the message-delivery transport does not.
 */
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
 * `responseId` is the broker-minted thread id when the request carried
 * `expectReply=true` - the receiver passes it back on its reply. It is
 * `null` when no reply is expected (one-shot delivery or a final reply
 * that itself closes a thread).
 */
export const sendAgentMessageResponseSchema = z.object({
  responseId: z.string().nullable(),
});
export type SendAgentMessageResponse = z.infer<
  typeof sendAgentMessageResponseSchema
>;

/**
 * `agent.getTranscript@1.0` - flatten an agent's conversation into an
 * XML-tagged string so a sibling agent can read it without re-implementing
 * the discriminated `messageSchema` shape. For GUI agents the host
 * serializes the persisted `messageSchema` array (`<user>` / `<assistant>`
 * blocks); for TUI agents the host best-effort returns whatever
 * scrollback its PTY buffer holds. TUI scrollback is not persisted, so the
 * resolver errors when the target TUI session is not local and currently
 * present in this host's PTY manager.
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

/**
 * `agent.stop@1.0` - halt a running agent and, optionally, the subtree it
 * delegated to. Addresses a single agent by id like the rest of this
 * family; the fan-out is the resolver's job, not the caller's:
 *
 *   - `cascade=false` → stop just this agent. GUI: abort the current chat
 *     turn. TUI: interrupt the running CLI (SIGINT) while keeping the PTY
 *     and its tab alive so navigating back re-attaches / respawns it.
 *   - `cascade=true` → the resolver walks `parentId` descendants and stops
 *     the active ones too. This maps onto the "also stop the child agents?"
 *     confirmation: yes ⇒ cascade, no ⇒ just the one.
 *
 * `surface` is intentionally absent - the resolver reads each agent's
 * surface from storage to pick turn-abort vs SIGINT, matching the rest of
 * the family (only `agent.create` carries `surface`, because no record
 * exists yet). Stopping is not a terminal state: in-flight broker traffic
 * is purged under a transient cancel-guard so the subtree can't revive
 * itself, but a later message wakes any of these agents normally.
 */
export const stopAgentRequestSchema = z.object({
  epicId: z.string(),
  agentId: z.string(),
  cascade: z.boolean(),
});
export type StopAgentRequest = z.infer<typeof stopAgentRequestSchema>;

/**
 * The set the resolver actually stopped: the addressed agent plus, when
 * `cascade` was set, every active descendant it reached. Output only - the
 * caller never sends a list of ids.
 */
export const stopAgentResponseSchema = z.object({
  stoppedAgentIds: z.array(z.string()),
});
export type StopAgentResponse = z.infer<typeof stopAgentResponseSchema>;
