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
// Cursor is GUI-only in the product today: the GUI chat tab drives the
// `@cursor/sdk` agent runtime in local mode. It is listed in `harnessIdSchema`
// and `guiHarnessIdSchema`, and it stays in `tuiHarnessIdSchema` as a RESERVED
// compatibility value only - a stable reserved id so existing persisted Cursor
// Terminal-interface records keep parsing - NOT because a Cursor Terminal
// launch path exists. There is none today: the host
// adapter does not implement the TUI surface, the runtime TUI catalog omits
// Cursor, and `epic.createTuiAgent` / `agent.create` reject `harnessId: "cursor"`
// on the Terminal interface.
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
 * Frozen harness id set as the released `chat.subscribe@1.0–1.6` lines shipped
 * it - i.e. everything before Reasonix, which first rides `1.7`. (`1.6` looked
 * unreleased and is not: the committed released-baseline surface advertises it
 * with exactly these nineteen ids.) Bound by the wire-freeze copies of every released server-frame schema
 * that carries a harness id (runtime session/plan events, the active turn); a
 * newer host must not project an id an installed older client's strict enum
 * cannot decode.
 *
 * Deliberately NOT aliased to `guiHarnessIdSchemaV70`, even though the two sets
 * coincide today: that one pins the `agent.*` RPC **major/minor** axis, this one
 * pins the `chat.subscribe` **minor** axis. They are independent, and a future
 * harness admitted to one line but frozen off the other would silently break
 * whichever schema borrowed the wrong copy. Do NOT add new harnesses here.
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

/**
 * Frozen harness id set as shipped in protocol v2.0 (before Amp). Used only by
 * the frozen v2.0 response schema of `agent.gui.listHarnesses` so an already-
 * shipped v2.0 client (which predates Amp) negotiates a wire that can never
 * carry it. Do NOT add new harnesses here - extend the latest
 * `guiHarnessIdSchema` and use the existing version bridges instead.
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
 * Used only by the frozen v3.0 response schema of `agent.gui.listHarnesses` so
 * already-shipped v3.0 clients never receive post-v3.0 ids. Do NOT add new
 * harnesses here - extend the latest `guiHarnessIdSchema` and use the
 * existing version bridges instead.
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
 * Frozen harness id set as shipped in protocol v4.0 (with Devin/Pi, before
 * Hermes/omp). Used only by the frozen v4.0 response schema of
 * `agent.gui.listHarnesses` so already-shipped v4.0 clients never receive
 * post-v4.0 ids. Do NOT add new harnesses here - extend the latest
 * `guiHarnessIdSchema` and use the existing bridges instead.
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
 *
 * This line IS released - `cli-v1.1.8` (tagged 2026-07-25) shipped v5.0, so a
 * client in the field strict-decodes exactly these 17 ids. omp therefore could
 * not join v5.0 and opened v6.0 instead, with v6→v5 … v6→v1 bridges that drop
 * post-v5.0 ids. Do NOT add new harnesses here - extend the latest
 * `guiHarnessIdSchema` and use the existing v6 bridge instead.
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
 * Frozen harness id set as shipped in protocol v6.0 (with omp, before
 * Hugging Face).
 *
 * This line IS released - `cli-v1.1.9` (tagged 2026-07-29) shipped v6.0, so a
 * client in the field strict-decodes exactly these 18 ids. `huggingface`
 * therefore could not join v6.0 and opened v7.0 instead, with v7→v6 … v7→v1
 * bridges that drop post-v6.0 ids. Do NOT add new harnesses here - extend the
 * latest `guiHarnessIdSchema` and use the existing v7 bridge instead.
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
 *
 * Taken when v7.1 opened for the catalog row's `authStatus`: v7.0 stops being
 * the head line there, so it can no longer track the live enum. Identical to
 * `guiHarnessIdSchema` at
 * the freeze cut - the freeze pins the SET, so a future harness cannot widen a
 * line v1.2.0-rc.1 peers already negotiate. Do NOT add new harnesses here -
 * extend the latest `guiHarnessIdSchema`; a v8.0 bridge drops post-v7.0 ids
 * for older callers.
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
 * A2A participation is TWO capabilities, not one, because the host owns two
 * independent transports and they do not cover the same harnesses:
 *
 *   1. OUTBOUND TOOLS ({@link canUseA2ATools}) — the agent is handed the
 *      host-owned `traycer_a2a` catalog at launch, so it can create, send,
 *      inspect, and hold roles. Delivered over each provider's native MCP
 *      path (GUI turns, Claude/Codex terminal launches) or the loopback HTTP
 *      tool bridge (OpenCode).
 *   2. INBOUND DELIVERY ({@link canReceiveA2AMessages}) — something can WAKE
 *      the agent and hand it a message it never asked for. GUI agents get a
 *      turn injected; a Claude Code terminal agent gets it through the
 *      bundled `traycer monitor` background command (and can be spawned
 *      headless for it). No other terminal harness has an inbox transport.
 *
 * Conflating the two is what the split exists to prevent: gating tool access
 * on inbox capability starves Codex/OpenCode terminal agents of the shared
 * catalog, while gating delivery on tool access accepts durable inbox rows
 * that nothing will ever drain.
 *
 * Cursor is absent from both arms deliberately: `CursorAdapter` declares
 * `surfaces: ["gui"]` and implements no `ITuiHarnessAdapter`, so a Cursor
 * terminal agent cannot be launched at all, let alone handed a catalog.
 *
 * Note: neither predicate gates epic activity tracking — every agent
 * (including codex/opencode TUI) still contributes activity for the
 * YJS-warmth signal.
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
 * Can this agent be the RECEIVER of an A2A message — i.e. is there a
 * transport that will wake it and hand the message over? See
 * {@link canUseA2ATools} for why this is a separate question.
 *
 * Use this for send/create-target admission, role-awareness routing, and any
 * "can I message this agent" capability the client renders. A tool-capable
 * agent that fails this check can still send; it just cannot be sent to, so
 * it must never be promised a reply.
 */
export function canReceiveA2AMessages(target: A2ACapabilityTarget): boolean {
  if (target.surface === "gui") return true;
  return target.harnessId === "claude";
}

// ─── Shared A2A message-size gate ──────────────────────────────────────────
//
// One accepted message is either stored in full or the send is rejected
// before delivery/capture - truncation is never a recovery strategy. The
// ceiling is shared (not host-domain-private) so every surface that
// composes an A2A send body - today's host domain, and any future
// pre-flight client check - agrees on the exact same byte count.

/** Shared UTF-8 byte ceiling for a single A2A message body. */
export const A2A_MESSAGE_MAX_UTF8_BYTES = 16 * 1024 * 1024;

const UTF8_ENCODER = new TextEncoder();

/**
 * UTF-8 byte length of `value`. Uses `TextEncoder` (not `Buffer`) so this
 * stays callable from browser-hosted surfaces, not just Node.
 */
export function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).length;
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
 * Reserved `profileId` value naming the provider's ambient CLI login (mirrors
 * the host's persisted `AMBIENT_PROFILE_ID` sentinel). Ambient is expressed
 * exclusively through `{ kind: "ambient" }` - a managed `{ kind: "profile" }`
 * arm must never carry this literal as its `profileId`, or the two arms could
 * claim the same identity through disagreeing shapes. Batch-2 review finding:
 * these contracts are unreleased, so the schema is hardened directly rather
 * than through a version bridge.
 */
export const AMBIENT_PROFILE_ID_SENTINEL = "ambient";

const managedProfileIdSchema = z
  .string()
  .refine((profileId) => profileId !== AMBIENT_PROFILE_ID_SENTINEL, {
    message:
      'profileId must not be the reserved "ambient" sentinel - use { kind: "ambient" } to select the ambient login.',
  });

/**
 * Explicit selection of which provider profile (subscription) an agent
 * surface should use. Replaces the plain nullable `profileId` `agent.create@1.0`
 * carries, which cannot distinguish omission, an intentional ambient choice,
 * and legacy sender inheritance:
 *
 *   - `last_used` - resolve the caller's per-user/per-provider last-used
 *     profile (falling back to ambient when none exists). Only new
 *     tool/CLI callers that omit an explicit profile choice send this; it has
 *     no v1.0 equivalent, so it can never downgrade to `agent.create@1.0`
 *     (see `agentCreateDowngradeV20ToV10` in `contracts.ts`).
 *   - `ambient` - explicitly use the provider's ambient CLI login, distinct
 *     from `inherit_sender` below despite both resolving to the same runtime
 *     account: frozen v1.0's `profileId: null` already means sender
 *     inheritance for a same-surface/same-harness child, so an explicit
 *     `ambient` choice has no v1.0-representable wire value and, like
 *     `last_used`, can never downgrade to `agent.create@1.0` (batch-1 review
 *     correction - see `agentCreateDowngradeV20ToV10`).
 *   - `profile` - pin to a specific managed profile by id.
 *   - `inherit_sender` - version-bridge-only arm: what a v1.0 caller's
 *     `profileId: null` upgrades to (inherit the sender agent's profile).
 *     Never offered by new discovery, rate-limit, configuration, tool, or
 *     CLI contracts - see the A2A profile-awareness ticket's guardrails.
 */
export const profileSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("last_used") }),
  z.object({ kind: z.literal("ambient") }),
  z.object({ kind: z.literal("profile"), profileId: managedProfileIdSchema }),
  z.object({ kind: z.literal("inherit_sender") }),
]);
export type ProfileSelection = z.infer<typeof profileSelectionSchema>;

/**
 * The subset of `ProfileSelection` that names a concrete, resolvable profile
 * right now - excludes `last_used` (a preference lookup, not a selection)
 * and `inherit_sender` (compatibility-only). Used by every new agent-facing
 * profile surface: discovery's effective-selection field, detailed rate-limit
 * reads, and `agent.configure` (see `agent/profiles.ts`).
 */
export const concreteProfileSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ambient") }),
  z.object({ kind: z.literal("profile"), profileId: managedProfileIdSchema }),
]);
export type ConcreteProfileSelection = z.infer<
  typeof concreteProfileSelectionSchema
>;

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
 * of rejecting the whole create. `permissionMode` arrives in v3 below; v1 and
 * v2 remain frozen to their released request shapes.
 *
 * The new agent's `parentId` is set to `senderAgentId` so the epic projection
 * can render the spawn lineage without a separate join.
 *
 * `profileId` is the explicit per-child profile override: `null` inherits
 * the sender agent's profile (the default per the multi-profile decision
 * log), a string pins the child to that specific logged-in profile
 * (subscription). Defaulted so requests built before profiles existed still
 * parse.
 *
 * Frozen at v1.0: `agent.create@2.0` (below) replaces `profileId` with the
 * explicit `profileSelection` model above; see `agentCreateUpgradeV10ToV20` /
 * `agentCreateDowngradeV20ToV10` in `contracts.ts` for the bridge.
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
 * Frozen `agent.create@2.0` request - identical to v1.0 except the nullable
 * `profileId` override is replaced by an explicit `profileSelection` (see
 * `ProfileSelection` above). Removing `profileId` is why this ships as a new
 * major rather than an additive minor: v1.0 stays frozen and reachable
 * through `agentCreateUpgradeV10ToV20` / `agentCreateDowngradeV20ToV10` in
 * `contracts.ts`. The response is unchanged (same `warnings` list), so
 * `agent.create@2.0` reuses `createAgentResponseSchema` directly.
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

/**
 * `agent.create@3.0` adds the required permission-mode choice. `null` is a
 * compatibility-only sentinel emitted by the v2->v3 upgrade path so released
 * callers retain their legacy sender-inheritance behavior; current tool/CLI
 * callers always send a concrete mode. Making the field required keeps the
 * released v2.0 wire immutable.
 */
/**
 * `agentMode` is RETAINED here even though Epic Mode was removed from the
 * product. v3.0 is itself released (it shipped in the v1.1.8 tags), so a
 * current client and a v1.1.8 host both negotiate 3.0 and NO bridge runs
 * between them - dropping the key would simply be rejected by that host, which
 * still requires it. Callers state the one remaining mode; the field goes when
 * the released client/host floor passes this version, together with the
 * equally-blocked `prepareTuiLaunch` / `createTuiAgent` request shapes.
 */
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

// A single contributing guide file. Hosts emit workspace sources before the
// global source, with higher priority values for more specific workspaces.
// Clients sort by priority and layer workspace instructions over the global
// guide. The paths are kept for attribution in the rendered instructions.
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
// Distinct from `agent.selectionGuide`, which serves the guide to an agent.
// These are default-host scoped and carry no epic. Provider choices are
// already host state, so the host computes the generated default from its
// current provider configuration.
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

/**
 * Per-row shape returned by `agent.list@1.0`. A flat array (not a
 * uuid-keyed map) so the wire shape lines up with `listEpicCollaborators`
 * and the rest of the `list*` family in this registry.
 *
 * `surface` lets a caller route to the right per-agent UI (e.g. a GUI chat
 * interface vs a TUI terminal interface) without a second round-trip.
 * `isLocal` is the host's authoritative answer to "did I mint this
 * session?" - `hostId` equals the responding host's id. Cross-host
 * entries are returned for read-only enumeration; mutating RPCs
 * (`agent.sendMessage`) reject them with `RECEIVER_NOT_LOCAL` until the
 * relay/mailbox transport lands.
 */
const releasedAgentSummarySchema = z.object({
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

// ── Frozen protocol-v1.0 agent.list response ───────────────────────────────
// `agent.list` enumerates every agent in the epic - including ACP GUI harness
// chats a newer client created - and the `traycer` CLI inlines the protocol at
// build time, so an old CLI would hit a strict enum on those rows. v1.0 is
// frozen; the v2.0 line carries them and a v2→v1 bridge drops them for v1.0
// callers. Do not add new harnesses here - use the existing v2 bridge.
export const agentSummarySchemaV10 = releasedAgentSummarySchema.extend({
  harnessId: harnessIdSchema
    .extract(["claude", "codex", "opencode", "traycer", "cursor"])
    .nullable(),
});
export const listAgentsResponseSchemaV10 = listAgentsResponseSchema.extend({
  agents: z.array(agentSummarySchemaV10),
});
export type ListAgentsResponseV10 = z.infer<typeof listAgentsResponseSchemaV10>;

// ── Frozen protocol-v2.0 agent.list response (before Amp) ──────────────────
// `agent.list` enumerates every agent in the epic - including Amp GUI harness
// chats a newer client created - so an already-shipped v2.0 client (which
// predates Amp) would hit a strict enum on those rows. v2.0 is frozen here as
// actually shipped (before Amp). Do not add new harnesses here - use the
// existing version bridges.
export const agentSummarySchemaV20 = releasedAgentSummarySchema.extend({
  harnessId: guiHarnessIdSchemaV20.nullable(),
});
export const listAgentsResponseSchemaV20 = listAgentsResponseSchema.extend({
  agents: z.array(agentSummarySchemaV20),
});
export type ListAgentsResponseV20 = z.infer<typeof listAgentsResponseSchemaV20>;

// ── Frozen protocol-v3.0 agent.list response (with Amp, before Devin/Pi) ───
// `agent.list` enumerates every agent in the epic - including Devin/Pi GUI
// harness chats a newer client created - so an already-shipped v3.0 client
// would hit a strict enum on those rows. v3.0 is frozen here as actually
// shipped (with Amp). Do not add new harnesses here - use the existing
// version bridges.
export const agentSummarySchemaV30 = releasedAgentSummarySchema.extend({
  harnessId: guiHarnessIdSchemaV30.nullable(),
});
export const listAgentsResponseSchemaV30 = listAgentsResponseSchema.extend({
  agents: z.array(agentSummarySchemaV30),
});
export type ListAgentsResponseV30 = z.infer<typeof listAgentsResponseSchemaV30>;

// ── Frozen protocol-v4.0 agent.list response (with Devin/Pi, pre-Hermes/omp) ─
// `agent.list` enumerates every agent in the epic - including Hermes/omp GUI
// harness chats a newer client created - so an already-shipped v4.0 client
// would hit a strict enum on those rows. v4.0 is frozen here as actually
// shipped (with Devin/Pi); the v5.0 line carries Hermes/omp rows and v5→v4 /
// v5→v3 / v5→v2 / v5→v1 bridges drop them for older callers. Do not add new
// harnesses here - use the existing v5 bridge.
export const agentSummarySchemaV40 = releasedAgentSummarySchema.extend({
  harnessId: guiHarnessIdSchemaV40.nullable(),
});
export const listAgentsResponseSchemaV40 = listAgentsResponseSchema.extend({
  agents: z.array(agentSummarySchemaV40),
});
export type ListAgentsResponseV40 = z.infer<typeof listAgentsResponseSchemaV40>;

// ── Frozen protocol-v5.0 agent.list response (with Hermes, before omp) ──────
// `agent.list` enumerates every agent in the epic - including omp GUI harness
// chats a newer client created - so an already-shipped v5.0 client would hit a
// strict enum on those rows. This line IS released (`cli-v1.1.8` /
// `host-v1.1.8`, both tagged 2026-07-25), so it is frozen here as actually
// shipped; the v6.0 line carries omp rows and v6→v5 … v6→v1 bridges drop them
// for older callers. Do not add new harnesses here - use the existing v6
// bridge.
export const agentSummarySchemaV50 = releasedAgentSummarySchema.extend({
  harnessId: guiHarnessIdSchemaV50.nullable(),
});
export const listAgentsResponseSchemaV50 = listAgentsResponseSchema.extend({
  agents: z.array(agentSummarySchemaV50),
});
export type ListAgentsResponseV50 = z.infer<typeof listAgentsResponseSchemaV50>;

// ── Frozen protocol-v6.0 agent.list response (with omp, pre-Hugging Face) ───
// `agent.list` enumerates every agent in the epic - including Hugging Face GUI
// harness chats a newer client created - so an already-shipped v6.0 client
// would hit a strict enum on those rows. This line IS released (`cli-v1.1.9` /
// `host-v1.1.9`, both tagged 2026-07-29), so it is frozen here as actually
// shipped; the v7.0 line carries Hugging Face rows and v7→v6 … v7→v1 bridges
// drop them for older callers. Do not add new harnesses here - use the
// existing v7 bridge.
export const agentSummarySchemaV60 = releasedAgentSummarySchema.extend({
  harnessId: guiHarnessIdSchemaV60.nullable(),
});
export const listAgentsResponseSchemaV60 = listAgentsResponseSchema.extend({
  agents: z.array(agentSummarySchemaV60),
});
export type ListAgentsResponseV60 = z.infer<typeof listAgentsResponseSchemaV60>;

// ── Frozen protocol-v7.0 agent.list response (with Hugging Face, pre-Reasonix)
// `agent.list` enumerates every agent in the epic - including Reasonix GUI
// harness chats a newer client created - so an already-shipped v7.0 client
// would hit a strict enum on those rows. This line IS released (`cli-v1.2.0` /
// `host-v1.2.0`, both tagged 2026-08-24), so it is frozen here as actually
// shipped; the v8.0 line carries Reasonix rows and v8→v7 … v8→v1 bridges drop
// them for older callers. Do not add new harnesses here - use the existing v8
// bridge.
//
// The row body is hand-frozen off `releasedAgentSummarySchema` plus the
// `runConfig` field v7.0 shipped, rather than `agentSummarySchema.extend(...)`:
// pinning only the id over a LIVE body is the half-freeze
// `guiHarnessOptionBaseShapeV70` had to correct in `gui/unary-schemas.ts`. A
// field added to `agentSummarySchema` must not widen this released line.
export const agentSummarySchemaV70 = releasedAgentSummarySchema.extend({
  harnessId: guiHarnessIdSchemaV70.nullable(),
  runConfig: agentRunConfigSchema.nullable().default(null),
});
export const listAgentsResponseSchemaV70 = listAgentsResponseSchema.extend({
  agents: z.array(agentSummarySchemaV70),
});
export type ListAgentsResponseV70 = z.infer<typeof listAgentsResponseSchemaV70>;

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
 * blocks); for supported TUI agents the host reads structured conversation
 * history through the harness provider SDK. Provider history survives the PTY
 * closing; there is deliberately no raw scrollback fallback. TUI transcript
 * reads remain local to the agent's bound host because its provider session
 * store and credentials are host-local.
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

/**
 * `agent.fork`'s omit-default profile override. Deliberately NOT
 * `profileSelectionSchema` above: that union's omit-default is `last_used`
 * (a preference lookup for a freshly-minted agent) and it also carries the
 * version-bridge-only `inherit_sender` arm, neither of which fits a fork -
 * there is no "sender" being inherited (the source is an arbitrary existing
 * agent, not the caller), and a fork's natural default is byte-for-byte
 * continuation of whatever profile the SOURCE is already running under.
 * Mirrors `AgentForkProfileSelection`
 * (`traycer-host/src/domain/agent/agent-fork-service.ts`) field-for-field:
 *
 *   - `inherit` - omit-default. Keep running under the source's own profile.
 *   - `ambient` - explicitly use the provider's ambient CLI login.
 *   - `profile` - pin to a specific managed profile by id.
 *
 * Shares `managedProfileIdSchema`'s reserved-`"ambient"`-sentinel rejection:
 * a `profile` arm can never name the literal ambient sentinel as a managed
 * profile id - that intent is expressed exclusively through `{ kind:
 * "ambient" }`.
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
 * `agent.fork@1.0` - clone an existing local agent (GUI chat or Claude Code
 * terminal session) into a NEW agent seeded from the source's latest
 * available checkpoint. Wraps the same core `forkAgentFromRequest` service
 * (`traycer-host/src/domain/agent/agent-fork-service.ts`) the
 * `traycer_fork_agent` A2A tool calls, so a wire caller (the CLI, or any
 * future client) gets the transactional latest-checkpoint fork without
 * recomposing the GUI's client-side orchestration
 * (`validateForkProfile` → `prepareLaunch` → `createTuiAgent`, or
 * `createChat` + `forkSource`).
 *
 *   - `senderAgentId` - the calling agent; the fork is parented to it (same
 *     convention as `agent.create`). The service additionally asserts the
 *     caller owns this agent (`assertAuthorizedSenderAgent`) - it just
 *     names the fork's parent, so any agent the caller owns is fine here.
 *   - `agentId` - the source to fork; may equal `senderAgentId`. Accepts an
 *     unambiguous id PREFIX (`resolveAgentIdPrefix`), like the rest of the
 *     A2A id-addressed surface.
 *   - `permissionMode` - GUI forks only; a fork does NOT inherit the
 *     source's mode. Terminal forks ignore it (no Traycer permission mode
 *     exists on that surface).
 *   - `workspace` - `null` inherits the SOURCE agent's binding (the fork
 *     continues in the same directories); explicit entries bind the fork
 *     elsewhere.
 *   - `profileSelection` - see `forkAgentProfileSelectionSchema` above.
 *
 * Latest-checkpoint only, like the MCP tool: there is no boundary-selection
 * parameter (a client-chosen fork point stays a GUI `createChat` +
 * `forkSource` feature). Terminal forks stay Claude-only; other harnesses
 * are refused for lacking a native session fork.
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
