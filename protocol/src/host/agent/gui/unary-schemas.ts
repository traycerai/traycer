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
import {
  PROVIDER_AUTH_STATUS_SCHEMA,
  providerEnablementModeSchema,
} from "@traycer/protocol/host/provider-schemas";
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
// terminal-agent launcher only for harnesses that actually support it.
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
  // re-fetches until it flips false.
  //
  // `available` carries the LAST SETTLED verdict while a probe re-runs, so a
  // harness whose host-side availability cache merely lapsed stays
  // `available: true` and the client keeps serving the catalog it already has -
  // pending is a background refresh, not a reason to retire a known-good model
  // list. A harness the host has never settled a verdict for reports
  // `available: false`, so an old app that doesn't understand this field errs on
  // the side of hiding an unproven harness and retrying via its normal
  // unavailable backoff. `.catch(false)` tolerates old host builds that omit the
  // field.
  availabilityPending: z.boolean().catch(false),
  // The provider auth verdict for this harness, carried ON THE CATALOG ROW so
  // the picker classifies a signed-out provider from the same fetch that
  // renders it, instead of joining against a separately-timed `providers.list`
  // query (which is why a re-auth-needed provider could render as a normal,
  // sendable row for up to that query's staleness window).
  //
  // Reuses `providers.list`'s auth-status enum so both surfaces classify off
  // one vocabulary. Consumers must keep the send gate's DEFINITIVE-only
  // reading - only `unauthenticated` is a signed-out verdict; `unknown` /
  // `unavailable` are read errors that fail OPEN. Widening that predicate
  // would also widen row VISIBILITY (the rail ORs degraded into visible), so a
  // sticky-enabled provider with no CLI installed would get a permanently dead
  // tab.
  //
  // `.optional()` rather than a default: an old host omits the key entirely
  // and the client falls back to its `providers.list`-derived classification,
  // so absent and "no verdict" stay distinguishable.
  //
  // `.catch(undefined)` is the separate guard for a value that is PRESENT but
  // from a newer host's wider enum: without it one unrecognized member fails
  // the entire `listHarnesses` response and the picker loses every harness,
  // rather than this one field. Falling back to `undefined` puts the client on
  // the old-host path it already supports. See the fuller note on the same pair
  // in `provider-schemas.ts`.
  authStatus: PROVIDER_AUTH_STATUS_SCHEMA.optional().catch(undefined),
  // Tri-state enablement intent behind `enabled`: sticky `"on"`/`"off"` (an
  // explicit user choice that ignores detection) or `"auto"` (enablement
  // derives from whether the host passively detected an account). `enabled`
  // stays the strict boolean EFFECTIVE value, so a client that ignores this
  // field behaves exactly as before. Absent on hosts that predate auto
  // enablement - the client then renders its binary switch. `.catch(undefined)`
  // for the same reason as `authStatus` above.
  enablementMode: providerEnablementModeSchema.optional().catch(undefined),
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

// Narrow, forward-compatible capabilities a model advertises beyond its core
// text loop. Not a wire-schema change: `guiAgentModelOptionSchema.metadata`
// stays the open `Record<string, unknown>` it always was, and this is a
// zod shape consumers use to narrow `metadata.capabilities` through a shared
// type instead of ad hoc casts. Do not reuse `supportsImages`/
// `inputModalities`/`vision`/`supportsImageAttachments` for
// `imageGeneration` - those describe image *input*, not generation.
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
//
// The row body is pinned to exactly what host-v1.0.0 shipped (verified against
// the released-baseline surface the compat gate dumps from the tag): no
// `enabled` (#178), no `availabilityPending` (#147). Both formally enter the
// major-2 line via the 2.0→2.1 minor and the 1.0→2.0 upgrade's
// `availabilityPending` fill. Do not add fields here - this line is released
// and immutable; new fields ship on a new minor of the live line.
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

// ── Frozen protocol-v2.0 catalog row + response (before Amp) ────────────────
// v2.0 shipped without Amp; the v3.0 line of `agent.gui.listHarnesses` adds
// it, and the v3→v2 downgrade bridge filters it out for already-shipped v2.0
// callers so their strict decode never sees a value it can't parse.
//
// The row body is pinned to exactly what the v1.1.0–v1.1.2 releases shipped
// on this line: `availabilityPending` (#147) but no `enabled` (#178).
// `enabled` formally enters major 2 with the 2.1 minor below, whose upgrade
// fills the pre-feature default. Do not add fields here - this line is
// released and immutable.
export const guiHarnessOptionSchemaV20 = guiHarnessOptionSchemaV10.extend({
  id: guiHarnessIdSchemaV20,
  availabilityPending: z.boolean().catch(false),
});
export const listGuiHarnessesResponseSchemaV20 = z.object({
  harnesses: z.array(guiHarnessOptionSchemaV20),
});

// ── Frozen catalog row BODY for every line from 2.1 through 7.0 ────────────
//
// Every one of those lines used to be spelled `guiHarnessOptionSchema.extend({
// id: <pinned enum> })`, i.e. a pinned id over the LIVE body. That pins only
// half a row: the id could not drift, but a field added to the live body
// widened all six SHIPPED lines at once. `authStatus` / `enablementMode` are
// the first fields to actually test that, so the body is hand-frozen here and
// the released lines below now differ from one another ONLY by their id enum -
// which is what their comments always claimed.
//
// Byte-identical to the live body at the freeze cut, so the committed
// `frozen-catalog-lines` snapshots for 2.1-6.0 are unchanged by the freeze.
// Do NOT add fields here; add them to `guiHarnessOptionSchema` above, which
// only v7.1 (the head line) binds.
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

// ── Protocol-v2.1 catalog row + response ────────────────────────────────────
// 2.1 is where `enabled` (#178) formally enters the major-2 line: the released
// 2.0 shape above is frozen without it, and the 2.0→2.1 upgrade fills the
// "old host never had this feature" default (`enabled: true` - a host that
// predates the flag only lists harnesses it considers usable).
export const guiHarnessOptionSchemaV21 = z.object({
  id: guiHarnessIdSchemaV20,
  ...guiHarnessOptionBaseShapeV70,
});
export const listGuiHarnessesResponseSchemaV21 = z.object({
  harnesses: z.array(guiHarnessOptionSchemaV21),
});

// ── Frozen protocol-v3.0 catalog row + response (with Amp, before Devin/Pi) ─
// v3.0 shipped with Amp; the v4.0 line of `agent.gui.listHarnesses` adds
// Devin/Pi, and the v4→v3 downgrade bridge filters them out for already-
// shipped v3.0 callers so their strict decode never sees a value it can't
// parse.
export const guiHarnessOptionSchemaV30 = z.object({
  id: guiHarnessIdSchemaV30,
  ...guiHarnessOptionBaseShapeV70,
});
export const listGuiHarnessesResponseSchemaV30 = z.object({
  harnesses: z.array(guiHarnessOptionSchemaV30),
});

// ── Frozen protocol-v4.0 catalog row + response (with Devin/Pi, before ──────
// Hermes). v4.0 shipped with Devin/Pi; the v5.0 line of
// `agent.gui.listHarnesses` adds Hermes, and the v5→v4 downgrade bridge
// filters it out for already-shipped v4.0 callers so their strict decode
// never sees a value it can't parse.
export const guiHarnessOptionSchemaV40 = z.object({
  id: guiHarnessIdSchemaV40,
  ...guiHarnessOptionBaseShapeV70,
});
export const listGuiHarnessesResponseSchemaV40 = z.object({
  harnesses: z.array(guiHarnessOptionSchemaV40),
});

// ── Frozen protocol-v5.0 catalog row + response (with Hermes, before omp) ───
// v5.0 shipped with Hermes in `cli-v1.1.8` / `host-v1.1.8` (both tagged
// 2026-07-25); the v6.0 line of `agent.gui.listHarnesses` adds omp, and the
// v6→v5 downgrade bridge filters it out for already-shipped v5.0 callers so
// their strict decode never sees a value it can't parse.
//
// The row body is the hand-frozen `guiHarnessOptionBaseShapeV70` shared by
// every line from 2.1 up: these lines differ only by the id enum - verified
// against the `cli-v1.1.8` tree, where this whole file is byte-identical to
// HEAD. It used to reuse the LIVE row, which pinned the id but left the body
// tracking live; see that shape's comment.
export const guiHarnessOptionSchemaV50 = z.object({
  id: guiHarnessIdSchemaV50,
  ...guiHarnessOptionBaseShapeV70,
});
export const listGuiHarnessesResponseSchemaV50 = z.object({
  harnesses: z.array(guiHarnessOptionSchemaV50),
});

// ── Frozen protocol-v6.0 catalog row + response (with omp, pre-Hugging Face) ─
// v6.0 shipped with omp in `cli-v1.1.9` / `host-v1.1.9` (both tagged
// 2026-07-29); the v7.0 line of `agent.gui.listHarnesses` adds Hugging Face,
// and the v7→v6 downgrade bridge filters it out for already-shipped v6.0
// callers so their strict decode never sees a value it can't parse.
//
// The row body is the hand-frozen `guiHarnessOptionBaseShapeV70` for the same
// reason `guiHarnessOptionSchemaV50` uses it - the two lines differ only by
// the id enum, verified against the `cli-v1.1.9` tree, where this whole file
// is byte-identical to HEAD.
export const guiHarnessOptionSchemaV60 = z.object({
  id: guiHarnessIdSchemaV60,
  ...guiHarnessOptionBaseShapeV70,
});
export const listGuiHarnessesResponseSchemaV60 = z.object({
  harnesses: z.array(guiHarnessOptionSchemaV60),
});

// ── Frozen protocol-v7.0 catalog row + response (pre auth-aware enablement) ─
// v7.0 shipped Hugging Face and, in `cli-v1.2.0-rc.1` / `host-v1.2.0-rc.1`
// (both tagged 2026-08-19), shipped to real peers. v7.1 adds `authStatus` /
// `enablementMode` to the live row, so v7.0 stops being the head line here and
// is frozen at what those rc peers negotiate: a 7.0 caller receives the row
// without the two new keys, re-parsed through this shape by the contract.
//
// This freeze is why the new fields ride a MINOR rather than widening 7.0 in
// place, which is what `registry.ts`'s "an unreleased line widens in place"
// note would otherwise license (rc tags are outside `support-floor.json`'s
// protected set). Two different shapes under one version number are
// undetectable by negotiation, and these schemas strict-parse - an rc peer at
// 7.0 handed 7.1 keys can reject the response outright. Negotiating 7.1 and
// letting the downgrade strip the keys is the honest wire.
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
