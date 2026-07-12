import { z } from "zod";
import {
  guiHarnessIdSchema,
  guiHarnessIdSchemaV10,
  guiHarnessIdSchemaV20,
  guiHarnessIdSchemaV30,
} from "@traycer/protocol/host/agent/shared";
import {
  ALL_PERMISSION_MODES,
  permissionModeSchema,
} from "@traycer/protocol/persistence/epic/foundation";
import {
  planSourceSchema,
  planStatusSchema,
} from "@traycer/protocol/persistence/epic/content-blocks";

// ─── Catalog rows (per-surface) ───────────────────────────────────────────
//
// Each surface has its own listHarnesses RPC that returns harnesses
// installed/available for that surface. The id is narrowed to the surface's
// enum so the renderer never has to widen.

// The surfaces a harness can run on. `"gui"` is the host-driven chat tab;
// `"tui"` is the PTY terminal-agent tab. Each adapter declares the surfaces it
// implements, and `listGuiHarnesses` reports them so the renderer can show the
// terminal-agent launcher only for harnesses that actually support it (Cursor,
// for instance, is GUI-only until its CLI reaches TUI parity).
export const harnessSurfaceSchema = z.enum(["gui", "tui"]);
export type HarnessSurface = z.infer<typeof harnessSurfaceSchema>;

export const guiHarnessOptionSchema = z.object({
  id: guiHarnessIdSchema,
  label: z.string(),
  // Controls whether the harness is included in downstream filtering and shown
  // in the CLI. This is distinct from `available` and `availabilityPending`,
  // which describe the current host-side availability probe state.
  enabled: z.boolean().default(true),
  available: z.boolean(),
  error: z.string().nullable(),
  modes: z.array(harnessSurfaceSchema),
  // True when this (enabled) harness authenticates with an API key. The
  // renderer keeps such a provider visible in the picker even while
  // `available` is false, so a missing key surfaces an "add your API key" CTA
  // instead of hiding the provider. Disabled providers report `false` and stay
  // hidden like any other.
  requiresApiKey: z.boolean(),
  // Permission modes this harness honors. The renderer disables (and tooltips)
  // any PermissionsPicker option not listed here so users can't select a mode
  // the harness silently ignores (Cursor, for example, currently runs only in
  // "full_access"). The default uses the shared `ALL_PERMISSION_MODES` const
  // for protocol skew with older hosts; the host-side runtime also
  // validates `permissionMode` against `adapter.supportedPermissionModes`
  // (`HarnessRuntime.run`), so even when an old-host response hits the
  // default and the renderer enables a mode the harness wouldn't actually
  // honor, the host refuses the call rather than silently ignoring it.
  supportedPermissionModes: z
    .array(permissionModeSchema)
    .default([...ALL_PERMISSION_MODES]),
  // True while the host's availability probe for this harness is still running
  // in the background (e.g. the cold interactive-shell PATH probe). The client
  // re-fetches until it flips false. A pending row always carries
  // `available: false` so an old app that doesn't understand this field errs on
  // the side of hiding the harness and retrying via its normal unavailable
  // backoff. `.catch(false)` tolerates old host builds that omit the field.
  availabilityPending: z.boolean().catch(false),
});
export type GuiHarnessOption = z.infer<typeof guiHarnessOptionSchema>;

// ─── GUI catalog: models + commands ──────────────────────────────────────
//
// Models and slash-commands are GUI-only concerns: a TUI agent receives
// model selection through its own CLI flag and discovers commands from the
// CLI's runtime, so the host never enumerates them.

export const agentReasoningEffortOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().nullable(),
});
export type AgentReasoningEffortOption = z.infer<
  typeof agentReasoningEffortOptionSchema
>;

// A discrete service/speed tier advertised by a harness model - e.g. Codex
// exposes `{ id: "default" | "fast" | "priority" | ... }` per model via
// `model/list`. Surfaced in the GUI as a "Speed" picker; the chosen id is
// forwarded to the harness when the chat starts.
export const agentServiceTierOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().nullable(),
});
export type AgentServiceTierOption = z.infer<
  typeof agentServiceTierOptionSchema
>;

export const guiAgentModelOptionSchema = z.object({
  harnessId: guiHarnessIdSchema,
  slug: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  // No `isDefault`: there's no "default model" concept. Adapters return their
  // recommended/preferred model first, and the renderer preselects that first
  // entry as a concrete slug.
  contextWindow: z.number().nullable(),
  maxOutputTokens: z.number().nullable(),
  defaultReasoningEffort: z.string().nullable(),
  supportedReasoningEfforts: z.array(agentReasoningEffortOptionSchema),
  // Defaults so an older host that hasn't shipped these fields yet still
  // parses cleanly on the renderer (matches `.default(null)` on persistence-
  // side ChatRunSettings.serviceTier - same protocol-skew rationale).
  defaultServiceTier: z.string().nullable().default(null),
  supportedServiceTiers: z.array(agentServiceTierOptionSchema).default([]),
  // Human-readable sunset notice for a model an adapter is keeping around only
  // for backward compatibility with sessions/integrations still pinned to it
  // (currently only the Traycer harness's catalog uses this - see
  // SONNET_4_6_SUNSET_DATE in traycer-server's inference catalog). `.optional()`
  // rather than `.default(null)` like the service-tier fields above: this is a
  // Traycer-catalog-specific concept, so making it required would force every
  // other adapter (Claude, Codex, OpenCode, Cursor, ...) to explicitly null it
  // out for a field that will never apply to them. Absent and `null` are
  // treated identically downstream, so an older host that hasn't shipped this
  // field - or any adapter that never will - degrades cleanly to "not
  // deprecated" instead of failing to parse.
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

// ── Frozen protocol-v1.0 catalog row + response ────────────────────────────
// A v1.0 client predates the ACP GUI harnesses; the v2.0 line of
// `agent.gui.listHarnesses` adds them, and the v2→v1 downgrade bridge filters
// them out for v1.0 callers so their strict decode never sees a value it can't
// parse.
export const guiHarnessOptionSchemaV10 = guiHarnessOptionSchema.extend({
  id: guiHarnessIdSchemaV10,
});
export const listGuiHarnessesResponseSchemaV10 = z.object({
  harnesses: z.array(guiHarnessOptionSchemaV10),
});

// ── Frozen protocol-v2.0 catalog row + response (before Amp) ────────────────
// v2.0 shipped without Amp; the v3.0 line of `agent.gui.listHarnesses` adds
// it, and the v3→v2 downgrade bridge filters it out for already-shipped v2.0
// callers so their strict decode never sees a value it can't parse.
export const guiHarnessOptionSchemaV20 = guiHarnessOptionSchema.extend({
  id: guiHarnessIdSchemaV20,
});
export const listGuiHarnessesResponseSchemaV20 = z.object({
  harnesses: z.array(guiHarnessOptionSchemaV20),
});

// ── Frozen protocol-v3.0 catalog row + response (with Amp, before Devin/Pi) ─
// v3.0 shipped with Amp; the v4.0 line of `agent.gui.listHarnesses` adds
// Devin/Pi, and the v4→v3 downgrade bridge filters them out for already-
// shipped v3.0 callers so their strict decode never sees a value it can't
// parse.
export const guiHarnessOptionSchemaV30 = guiHarnessOptionSchema.extend({
  id: guiHarnessIdSchemaV30,
});
export const listGuiHarnessesResponseSchemaV30 = z.object({
  harnesses: z.array(guiHarnessOptionSchemaV30),
});
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
