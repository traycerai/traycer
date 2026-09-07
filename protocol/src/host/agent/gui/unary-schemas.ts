import { z } from "zod";
import {
  guiHarnessIdSchema,
  guiHarnessIdSchemaV10,
  guiHarnessIdSchemaV20,
  guiHarnessIdSchemaV30,
  guiHarnessIdSchemaV40,
  guiHarnessIdSchemaV50,
  guiHarnessIdSchemaV60,
  guiHarnessIdSchemaV70,
} from "@traycer/protocol/host/agent/shared";
import { PROVIDER_AUTH_STATUS_SCHEMA } from "@traycer/protocol/host/provider-schemas";
import {
  ALL_PERMISSION_MODES,
  permissionModeSchema,
} from "@traycer/protocol/persistence/epic/foundation";
import {
  planSourceSchema,
  planStatusSchema,
} from "@traycer/protocol/persistence/epic/content-blocks";

// ─── Catalog rows (per-surface) ───────────────────────────────────────────
// The id is narrowed to the surface's enum so the renderer never has to widen.

// The surfaces a harness can run on.
export const harnessSurfaceSchema = z.enum(["gui", "tui"]);
export type HarnessSurface = z.infer<typeof harnessSurfaceSchema>;

export const guiHarnessOptionSchema = z.object({
  id: guiHarnessIdSchema,
  label: z.string(),
  // Controls whether the harness is included in downstream filtering and shown in the CLI.
  enabled: z.boolean().default(true),
  available: z.boolean(),
  error: z.string().nullable(),
  modes: z.array(harnessSurfaceSchema),
  // True when this (enabled) harness authenticates with an API key.
  requiresApiKey: z.boolean(),
  // Permission modes this harness honors.
  // The renderer disables (and tooltips) any PermissionsPicker option not listed here so users can't select a mode the harness silently ignores (Cursor, for example, currently runs only in "full_access").
  supportedPermissionModes: z
    .array(permissionModeSchema)
    .default([...ALL_PERMISSION_MODES]),
  // True while the host's availability probe for this harness is still running in the background (e.g. the cold interactive-shell PATH probe).
  // A harness the host has never settled a verdict for reports `available: false`, so an old app that doesn't understand this field errs on the side of hiding an unproven harness and retrying via its normal unavailable.
  availabilityPending: z.boolean().catch(false),
  // The provider auth verdict for this harness, carried ON THE CATALOG ROW so the picker classifies a signed-out provider from the same fetch that renders it, instead of joining against a separately-timed `providers.list`.
  // This field must never feed row VISIBILITY or the `enabled` flag: what the picker shows is the user's sticky choice, full stop.
  authStatus: PROVIDER_AUTH_STATUS_SCHEMA.optional().catch(undefined),
});
export type GuiHarnessOption = z.infer<typeof guiHarnessOptionSchema>;

// ─── GUI catalog: models + commands ──────────────────────────────────────
// Models and slash-commands are GUI-only concerns: a TUI agent receives model selection through its own CLI flag and discovers commands from the CLI's runtime, so the host never enumerates them.

export const agentReasoningEffortOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().nullable(),
});
export type AgentReasoningEffortOption = z.infer<
  typeof agentReasoningEffortOptionSchema
>;

// A discrete service/speed tier advertised by a harness model - e.g.
export const agentServiceTierOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().nullable(),
});
export type AgentServiceTierOption = z.infer<
  typeof agentServiceTierOptionSchema
>;

// Narrow, forward-compatible capabilities a model advertises beyond its core text loop.
// Do not reuse `supportsImages`/ `inputModalities`/`vision`/`supportsImageAttachments` for `imageGeneration` - those describe image *input*, not generation.
export const guiAgentModelCapabilitiesSchema = z.object({
  // Absent/undefined means false - only Codex (via `parseCodexModel`) derives
  // this today; every other bundled harness emits no `capabilities` at all.
  imageGeneration: z.boolean().default(false),
});
export type GuiAgentModelCapabilities = z.infer<
  typeof guiAgentModelCapabilitiesSchema
>;

export const guiAgentModelOptionSchema = z.object({
  harnessId: guiHarnessIdSchema,
  slug: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  // No `isDefault`: there's no "default model" concept.
  contextWindow: z.number().nullable(),
  maxOutputTokens: z.number().nullable(),
  defaultReasoningEffort: z.string().nullable(),
  supportedReasoningEfforts: z.array(agentReasoningEffortOptionSchema),
  defaultServiceTier: z.string().nullable().default(null),
  supportedServiceTiers: z.array(agentServiceTierOptionSchema).default([]),
  // Human-readable sunset notice for a model an adapter is keeping around only for backward compatibility with sessions/integrations still pinned to it (currently only the Traycer harness's catalog uses this - see.
  // Absent and `null` are treated identically downstream, so an older host that hasn't shipped this field - or any adapter that never will - degrades cleanly to "not deprecated" instead of failing to parse.
  deprecationNotice: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()),
});
export type GuiAgentModelOption = z.infer<typeof guiAgentModelOptionSchema>;

export const agentCommandKindSchema = z.enum(["slash-command", "skill"]);
export type AgentCommandKind = z.infer<typeof agentCommandKindSchema>;

export const guiAgentCommandOptionSchema = z.object({
  harnessId: guiHarnessIdSchema,
  name: z.string(),
  description: z.string(),
  argumentHint: z.string().nullable(),
  kind: agentCommandKindSchema,
  metadata: z.record(z.string(), z.unknown()),
});
export type GuiAgentCommandOption = z.infer<typeof guiAgentCommandOptionSchema>;

// ─── `agent.gui.listHarnesses` / `agent.gui.listModels` /
// `agent.gui.listCommands` ───────────────────────────────────────────────

export const listGuiHarnessesRequestSchema = z.object({});
export type ListGuiHarnessesRequest = z.infer<
  typeof listGuiHarnessesRequestSchema
>;

export const listGuiHarnessesResponseSchema = z.object({
  harnesses: z.array(guiHarnessOptionSchema),
});

// ── Frozen protocol-v1.0 catalog row + response ──────────────────────────── A v1.0 client predates the ACP GUI harnesses; the v2.0 line of `agent.gui.listHarnesses` adds them, and the v2→v1 downgrade bridge filters.
// Do not add fields here - this line is released and immutable; new fields ship on a new minor of the live line.
export const guiHarnessOptionSchemaV10 = z.object({
  id: guiHarnessIdSchemaV10,
  label: z.string(),
  available: z.boolean(),
  error: z.string().nullable(),
  modes: z.array(harnessSurfaceSchema),
  requiresApiKey: z.boolean(),
  supportedPermissionModes: z
    .array(permissionModeSchema)
    .default([...ALL_PERMISSION_MODES]),
});
export const listGuiHarnessesResponseSchemaV10 = z.object({
  harnesses: z.array(guiHarnessOptionSchemaV10),
});

// ── Frozen protocol-v2.0 catalog row + response (before Amp) ──────────────── v2.0 shipped without Amp; the v3.0 line of `agent.gui.listHarnesses` adds it, and the v3→v2 downgrade bridge filters it out for.
// Do not add fields here - this line is released and immutable.
export const guiHarnessOptionSchemaV20 = guiHarnessOptionSchemaV10.extend({
  id: guiHarnessIdSchemaV20,
  availabilityPending: z.boolean().catch(false),
});
export const listGuiHarnessesResponseSchemaV20 = z.object({
  harnesses: z.array(guiHarnessOptionSchemaV20),
});

// ── Frozen catalog row BODY for every line from 2.1 through 7.0 ────────────
// Do NOT add fields here; add them to `guiHarnessOptionSchema` above, which only v7.1 (the head line) binds.
const guiHarnessOptionBaseShapeV70 = {
  label: z.string(),
  enabled: z.boolean().default(true),
  available: z.boolean(),
  error: z.string().nullable(),
  modes: z.array(harnessSurfaceSchema),
  requiresApiKey: z.boolean(),
  supportedPermissionModes: z
    .array(permissionModeSchema)
    .default([...ALL_PERMISSION_MODES]),
  availabilityPending: z.boolean().catch(false),
};

// ── Protocol-v2.1 catalog row + response ──────────────────────────────────── 2.1 is where `enabled` (#178) formally enters the major-2 line: the released 2.0 shape above is frozen without it, and the 2.0→2.1 upgrade.
export const guiHarnessOptionSchemaV21 = z.object({
  id: guiHarnessIdSchemaV20,
  ...guiHarnessOptionBaseShapeV70,
});
export const listGuiHarnessesResponseSchemaV21 = z.object({
  harnesses: z.array(guiHarnessOptionSchemaV21),
});

// ── Frozen protocol-v3.0 catalog row + response (with Amp, before Devin/Pi) ─ v3.0 shipped with Amp; the v4.0 line of `agent.gui.listHarnesses` adds Devin/Pi, and the v4→v3 downgrade bridge filters them out for already-.
export const guiHarnessOptionSchemaV30 = z.object({
  id: guiHarnessIdSchemaV30,
  ...guiHarnessOptionBaseShapeV70,
});
export const listGuiHarnessesResponseSchemaV30 = z.object({
  harnesses: z.array(guiHarnessOptionSchemaV30),
});

// ── Frozen protocol-v4.0 catalog row + response (with Devin/Pi, before ────── Hermes). v4.0 shipped with Devin/Pi; the v5.0 line of `agent.gui.listHarnesses` adds Hermes, and the v5→v4 downgrade bridge filters it out.
export const guiHarnessOptionSchemaV40 = z.object({
  id: guiHarnessIdSchemaV40,
  ...guiHarnessOptionBaseShapeV70,
});
export const listGuiHarnessesResponseSchemaV40 = z.object({
  harnesses: z.array(guiHarnessOptionSchemaV40),
});

// ── Frozen protocol-v5.0 catalog row + response (with Hermes, before omp) ─── v5.0 shipped with Hermes in `cli-v1.1.8` / `host-v1.1.8` (both tagged 2026-07-25); the v6.0 line of `agent.gui.listHarnesses` adds omp, and.
// The row body is the hand-frozen `guiHarnessOptionBaseShapeV70` shared by every line from 2.1 up: these lines differ only by the id enum - verified against the `cli-v1.1.8` tree, where this whole file is byte-identical.
export const guiHarnessOptionSchemaV50 = z.object({
  id: guiHarnessIdSchemaV50,
  ...guiHarnessOptionBaseShapeV70,
});
export const listGuiHarnessesResponseSchemaV50 = z.object({
  harnesses: z.array(guiHarnessOptionSchemaV50),
});

// ── Frozen protocol-v6.0 catalog row + response (with omp, pre-Hugging Face) ─ v6.0 shipped with omp in `cli-v1.1.9` / `host-v1.1.9` (both tagged 2026-07-29); the v7.0 line of `agent.gui.listHarnesses` adds Hugging.
export const guiHarnessOptionSchemaV60 = z.object({
  id: guiHarnessIdSchemaV60,
  ...guiHarnessOptionBaseShapeV70,
});
export const listGuiHarnessesResponseSchemaV60 = z.object({
  harnesses: z.array(guiHarnessOptionSchemaV60),
});

// Frozen `listGuiHarnesses@7.0` row (pre-`authStatus`). Do not widen v7.0 in place; a 7.1 key on a 7.0 peer fails strict parse.
export const guiHarnessOptionSchemaV70 = z.object({
  id: guiHarnessIdSchemaV70,
  ...guiHarnessOptionBaseShapeV70,
});
export const listGuiHarnessesResponseSchemaV70 = z.object({
  harnesses: z.array(guiHarnessOptionSchemaV70),
});
export type ListGuiHarnessesResponseV70 = z.infer<
  typeof listGuiHarnessesResponseSchemaV70
>;

// ── Frozen protocol-v7.1 catalog row + response (pre-Reasonix) ───────────── 7.1 is where `authStatus` formally enters the major-7 line.
// Do NOT add fields or ids here; add fields to `guiHarnessOptionSchema` above, which only v8.0 (the head line) binds.
const guiHarnessOptionBaseShapeV71 = {
  ...guiHarnessOptionBaseShapeV70,
  authStatus: PROVIDER_AUTH_STATUS_SCHEMA.optional().catch(undefined),
};

export const guiHarnessOptionSchemaV71 = z.object({
  id: guiHarnessIdSchemaV70,
  ...guiHarnessOptionBaseShapeV71,
});
export const listGuiHarnessesResponseSchemaV71 = z.object({
  harnesses: z.array(guiHarnessOptionSchemaV71),
});
export type ListGuiHarnessesResponseV71 = z.infer<
  typeof listGuiHarnessesResponseSchemaV71
>;

export type ListGuiHarnessesResponse = z.infer<
  typeof listGuiHarnessesResponseSchema
>;

export const listGuiAgentModelsRequestSchema = z.object({
  harnessId: guiHarnessIdSchema,
  workingDirectory: z.string().nullable(),
});
export type ListGuiAgentModelsRequest = z.infer<
  typeof listGuiAgentModelsRequestSchema
>;

export const listGuiAgentModelsResponseSchema = z.object({
  harnessId: guiHarnessIdSchema,
  models: z.array(guiAgentModelOptionSchema),
});
export type ListGuiAgentModelsResponse = z.infer<
  typeof listGuiAgentModelsResponseSchema
>;

export const listGuiAgentCommandsRequestSchema = z.object({
  harnessId: guiHarnessIdSchema,
  workingDirectory: z.string().nullable(),
  workingDirectories: z.array(z.string()).default([]),
});
export type ListGuiAgentCommandsRequest = z.infer<
  typeof listGuiAgentCommandsRequestSchema
>;

export const listGuiAgentCommandsResponseSchema = z.object({
  harnessId: guiHarnessIdSchema,
  commands: z.array(guiAgentCommandOptionSchema),
});
export type ListGuiAgentCommandsResponse = z.infer<
  typeof listGuiAgentCommandsResponseSchema
>;

export const getGuiAgentPlanRequestSchema = z.object({
  epicId: z.string(),
  chatId: z.string(),
  planId: z.string(),
});
export type GetGuiAgentPlanRequest = z.infer<
  typeof getGuiAgentPlanRequestSchema
>;

export const getGuiAgentPlanUnavailableReasonSchema = z.enum(["blob_missing"]);
export type GetGuiAgentPlanUnavailableReason = z.infer<
  typeof getGuiAgentPlanUnavailableReasonSchema
>;

export const getGuiAgentPlanResponseSchema = z.object({
  planId: z.string(),
  markdown: z.string(),
  source: planSourceSchema,
  planStatus: planStatusSchema,
  contentHash: z.string().nullable(),
  unavailableReason: getGuiAgentPlanUnavailableReasonSchema.nullable(),
});
export type GetGuiAgentPlanResponse = z.infer<
  typeof getGuiAgentPlanResponseSchema
>;
