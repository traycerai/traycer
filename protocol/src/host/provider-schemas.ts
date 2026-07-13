/**
 * Schemas for the `providers.*` host RPC surface. Manages the CLI binary
 * Traycer runs for each provider (Codex / Claude Code / OpenCode).
 *
 * Each provider exposes a set of candidates - the host-bundled binary, the
 * binary auto-discovered on PATH (resolved to its real absolute path), and
 * any custom paths the user added. The user selects one via a radio in
 * Settings → Providers; the selection + custom paths + enabled flag persist
 * per-device (== per-host) in
 * `~/.traycer/host/config/provider-overrides.json`.
 */
import { z } from "zod";
import type { TuiHarnessId } from "@traycer/protocol/host/agent/shared";

export const providerIdSchema = z.enum([
  "claude-code",
  "codex",
  "opencode",
  "cursor",
  "traycer",
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
export type ProviderId = z.infer<typeof providerIdSchema>;

/**
 * Frozen provider id set as shipped in protocol v1.0. Used only by the frozen
 * v1.0 `providers.list` response so a v1.0 client never receives the ACP GUI
 * harness providers; the v2.0 line adds them with a v2→v1 downgrade bridge. Do
 * not add new providers here.
 */
export const providerIdSchemaV10 = z.enum([
  "claude-code",
  "codex",
  "opencode",
  "cursor",
  "traycer",
]);
export type ProviderIdV10 = z.infer<typeof providerIdSchemaV10>;

/**
 * Frozen provider id set as shipped in protocol v2.0 (before Amp). Used only
 * by the frozen v2.0 `providers.list` response so an already-shipped v2.0
 * client never receives the Amp provider. Do not add new providers here -
 * extend the latest `providerIdSchema` and use the existing version bridges.
 */
export const providerIdSchemaV20 = z.enum([
  "claude-code",
  "codex",
  "opencode",
  "cursor",
  "traycer",
  "grok",
  "qwen",
  "kiro",
  "droid",
  "kimi",
  "copilot",
  "kilocode",
  "openrouter",
]);
export type ProviderIdV20 = z.infer<typeof providerIdSchemaV20>;

/**
 * Frozen provider id set as shipped in protocol v3.0 (with Amp, before Devin/Pi).
 * Used only by the frozen v3.0 `providers.list` response so an already-shipped
 * v3.0 client never receives post-v3.0 providers; the v4.0 line adds them with
 * a v4→v3 (and v4→v2 / v4→v1) downgrade bridge. Do not add new providers here -
 * extend the latest `providerIdSchema` and use the existing v4 bridge instead.
 */
export const providerIdSchemaV30 = z.enum([
  "claude-code",
  "codex",
  "opencode",
  "cursor",
  "traycer",
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
export type ProviderIdV30 = z.infer<typeof providerIdSchemaV30>;

/** Human-readable provider names, shared by the host and the GUI. */
export const PROVIDER_DISPLAY_NAMES: Record<ProviderId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  traycer: "Traycer",
  grok: "Grok",
  qwen: "Qwen Code",
  kiro: "Kiro",
  droid: "Droid",
  kimi: "Kimi",
  copilot: "Copilot",
  kilocode: "Kilo Code",
  openrouter: "OpenRouter",
  amp: "Amp",
  devin: "Devin",
  pi: "Pi",
};

/**
 * Canonical TUI-harness-id → provider-overrides-id map. The harness layer uses
 * `claude`; the provider-CLI config (Settings, `provider-overrides.json`) uses
 * `claude-code`. Single source of truth shared by the host's
 * `harnessIdToProviderId` and the GUI launch picker's args pre-fill, so the
 * two can't drift.
 */
export const TUI_HARNESS_ID_TO_PROVIDER_ID: Record<TuiHarnessId, ProviderId> = {
  claude: "claude-code",
  codex: "codex",
  opencode: "opencode",
  cursor: "cursor",
};

export const providerSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bundled") }),
  z.object({ kind: z.literal("path") }),
  z.object({ kind: z.literal("custom"), path: z.string() }),
]);
export type ProviderSelection = z.infer<typeof providerSelectionSchema>;

export const providerCliCandidateSchema = z.object({
  kind: z.enum(["bundled", "path", "custom"]),
  // bundled: resolved bundled path or "" when not installed.
  // path/custom: absolute path to the binary.
  path: z.string(),
  version: z.string().nullable(),
  available: z.boolean(),
  // True while the version is still being probed in the background; the
  // client re-fetches until it flips false.
  versionPending: z.boolean(),
});
export type ProviderCliCandidate = z.infer<typeof providerCliCandidateSchema>;

export const PROVIDER_AUTH_STATUS_SCHEMA_V10 = z.enum([
  "authenticated",
  "unauthenticated",
  "unknown",
]);
export type ProviderAuthStatusV10 = z.infer<
  typeof PROVIDER_AUTH_STATUS_SCHEMA_V10
>;

export const PROVIDER_AUTH_SCHEMA_V10 = z.object({
  status: PROVIDER_AUTH_STATUS_SCHEMA_V10,
  badgeText: z.string().nullable(),
  label: z.string().nullable(),
  detail: z.string().nullable(),
});
export type ProviderAuthV10 = z.infer<typeof PROVIDER_AUTH_SCHEMA_V10>;

export const PROVIDER_AUTH_STATUS_SCHEMA_V20 = z.enum([
  "authenticated",
  "unauthenticated",
  "configured",
  "unavailable",
  "unknown",
]);
export const PROVIDER_AUTH_STATUS_SCHEMA = PROVIDER_AUTH_STATUS_SCHEMA_V20;
export type ProviderAuthStatusV20 = z.infer<
  typeof PROVIDER_AUTH_STATUS_SCHEMA_V20
>;
export type ProviderAuthStatus = ProviderAuthStatusV20;

export const PROVIDER_AUTH_SCHEMA_V20 = z.object({
  status: PROVIDER_AUTH_STATUS_SCHEMA_V20,
  badgeText: z.string().nullable(),
  label: z.string().nullable(),
  detail: z.string().nullable(),
});
export const PROVIDER_AUTH_SCHEMA = PROVIDER_AUTH_SCHEMA_V20;
export type ProviderAuthV20 = z.infer<typeof PROVIDER_AUTH_SCHEMA_V20>;
export type ProviderAuth = ProviderAuthV20;

export const UNKNOWN_PROVIDER_AUTH: ProviderAuth = {
  status: "unknown",
  badgeText: null,
  label: null,
  detail: null,
};

/**
 * Definitive signed-out verdict. Written by the host's auth poison and the
 * probe-less `providers.list` path the instant a credential failure is detected,
 * so the re-auth gate flips without waiting out the cache TTL.
 */
export const UNAUTHENTICATED_PROVIDER_AUTH: ProviderAuth = {
  status: "unauthenticated",
  badgeText: null,
  label: null,
  detail: null,
};

/**
 * Who turned a provider off, and when. Recorded on disable, cleared (null) on
 * enable. The host is single-user today, so this is currently always the
 * local user - captured now for the future cross-user host.
 */
export const providerDisabledBySchema = z.object({
  userId: z.string(),
  handle: z.string().nullable(),
  at: z.number(),
});
export type ProviderDisabledBy = z.infer<typeof providerDisabledBySchema>;

/**
 * API-key state for a provider. Only providers authenticated by an API key
 * (Cursor, whose `@cursor/sdk` runtime needs `CURSOR_API_KEY`) set
 * `supported: true`; the CLI-login providers leave it false and the GUI hides
 * the key field. The raw key is NEVER returned over RPC - only whether one is
 * resolvable and where it came from (`stored` = saved in Settings, `env` =
 * the user's login-shell `CURSOR_API_KEY`).
 */
export const providerApiKeyStateSchema = z.object({
  supported: z.boolean(),
  configured: z.boolean(),
  source: z.enum(["stored", "env"]).nullable(),
});
export type ProviderApiKeyState = z.infer<typeof providerApiKeyStateSchema>;

/**
 * A single environment-variable override applied when the host spawns this
 * provider's harness. `value: null` is an explicit *unset* (drop a variable the
 * spawned process would otherwise inherit from the user's shell); a string sets
 * it. Persisted per-provider (== per-host) in `provider-overrides.json`.
 */
export const providerEnvOverrideSchema = z.object({
  key: z.string(),
  value: z.string().nullable(),
});
export type ProviderEnvOverride = z.infer<typeof providerEnvOverrideSchema>;

/**
 * Describes how a user can re-authenticate a provider CLI from the in-chat
 * re-auth banner. The banner only appears for providers that have a web login
 * (so a sign-out is genuinely recoverable in-app); for those it offers a
 * browser-OAuth login (`oauthArgs`) AND/OR pasting a fresh credential into one
 * of `token.vars` (an API key / OAuth token, written as a per-provider env
 * override). API-key-only providers with no web login (Cursor) have no banner at
 * all - their capability is null and a bad key surfaces as a generic error row.
 *
 * Note this is distinct from how a *rejected* credential surfaces: a key/token
 * the host can't verify renders a generic error row (see the harness
 * adapters), not this reconnect affordance.
 */
export const providerLoginCapabilitySchema = z.object({
  /** Args to pass to the provider binary for browser-OAuth login, or null if unsupported. */
  oauthArgs: z.array(z.string()).nullable(),
  /**
   * Credential env vars the user can paste a key/token into (e.g.
   * `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`), written via
   * `providers.setEnvOverride`. Null when paste-to-reconnect is unsupported.
   */
  token: z.object({ vars: z.array(z.string()) }).nullable(),
});
export type ProviderLoginCapability = z.infer<
  typeof providerLoginCapabilitySchema
>;

/**
 * A single logged-in profile (subscription) for a provider. See the
 * multi-profile decision log's "Profile model". `ambient` is the read-only,
 * host-adopted `~/.claude` / `~/.codex` login Traycer never writes to;
 * `managed` is a Traycer-owned, isolated config dir under
 * `~/.traycer/harness-accounts/<provider>/<profileId>/`.
 */
export const providerProfileKindSchema = z.enum(["ambient", "managed"]);
export type ProviderProfileKind = z.infer<typeof providerProfileKindSchema>;

/**
 * Auth-mechanism discriminator. Only subscription OAuth logins ship in v1;
 * kept as a discriminator (not a bare boolean/omitted field) so a future
 * API-key profile type can be added as a new union variant without schema
 * surgery on `profiles[]` itself - see the decision log's "Auth types" row.
 */
export const providerProfileAuthTypeSchema = z.enum(["oauth"]);
export type ProviderProfileAuthType = z.infer<
  typeof providerProfileAuthTypeSchema
>;

/**
 * Live provider identity resolved for display. Deliberately distinct from the
 * profile snapshot persisted on chat session anchors
 * (`persistence/epic/senders.ts`): `providers.list` is a host-local RPC
 * response (never cross-host/cross-collaborator replicated), so it is safe to
 * carry `email` here for display - the PII restriction only applies to
 * synced Y.Doc artifacts. See the decision log's PII scope.
 */
export const providerProfileIdentitySchema = z.object({
  email: z.string().nullable(),
  tier: z.string().nullable(),
  accountUuid: z.string().nullable(),
});
export type ProviderProfileIdentity = z.infer<
  typeof providerProfileIdentitySchema
>;

/**
 * Derived from the same rate-limit gauge cache `usageUpdatedAt` reads from
 * (`rate-limit-gauge-cache.ts`'s `readProfileRateLimitStatus`) - a pure,
 * already-captured snapshot, never a fresh probe. `"unknown"` means no gauge
 * has been captured for this profile yet (never ran a turn, no active probe).
 * The GUI's rate-limit switch-prompt banner reads this to offer "Continue on
 * <profile>" among the provider's other non-limited profiles.
 */
export const providerProfileRateLimitStatusSchema = z.enum([
  "ok",
  "near_limit",
  "hard_limit",
  "unknown",
]);
export type ProviderProfileRateLimitStatus = z.infer<
  typeof providerProfileRateLimitStatusSchema
>;

export const PROVIDER_PROFILE_ACCENT_COLORS = [
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#84cc16",
  "#10b981",
  "#14b8a6",
  "#06b6d4",
  "#3b82f6",
  "#8b5cf6",
  "#a855f7",
  "#d946ef",
  "#ec4899",
] as const;

export const providerProfileAccentColorSchema = z.enum(
  PROVIDER_PROFILE_ACCENT_COLORS,
);
export type ProviderProfileAccentColor = z.infer<
  typeof providerProfileAccentColorSchema
>;

export const providerProfileSchema = z.object({
  profileId: z.string(),
  kind: providerProfileKindSchema,
  authType: providerProfileAuthTypeSchema,
  label: z.string(),
  auth: PROVIDER_AUTH_SCHEMA_V20,
  // Null until a login probe resolves it (e.g. a freshly created, not-yet-
  // authenticated profile).
  identity: providerProfileIdentitySchema.nullable(),
  // Epoch-ms the last passive (live-turn) or active (on-demand probe) usage
  // read landed for this profile; null before any read. Lets the usage
  // popover badge a gauge as stale without a background poll - see the
  // decision log's "Usage data".
  usageUpdatedAt: z.number().nullable(),
  // `.catch("unknown")` tolerates old host builds that predate this field.
  rateLimitStatus: providerProfileRateLimitStatusSchema.catch("unknown"),
  // Set when this profile's resolved identity (accountUuid, or email
  // fallback) matches another active profile of the same provider (including
  // ambient) - the id of that other profile. Duplicates are warned, never
  // blocked (see the decision log's "Identity key" row); the GUI renders
  // "same account as <label>".
  duplicateOfProfileId: z.string().nullable().catch(null),
  // Only ever non-null on the ambient profile entry. Set when the ambient
  // login's identity changed behind Traycer's back (a user ran `/login` in a
  // terminal) - carries the pre-change email and when the drift was detected
  // so the GUI can rebadge and show a one-time dismissable notice ("Terminal
  // account is now bob@, was alice@"). See the decision log's "Ambient
  // identity drift" row; dismissal handling is host/GUI-side, this field only
  // carries the notice.
  ambientDriftNotice: z
    .object({
      previousEmail: z.string().nullable(),
      changedAt: z.number(),
    })
    .nullable()
    .catch(null),
  // Deterministic per-profile accent color (hex), assigned by the host from a
  // fixed palette and optionally overridden by the user. `.catch(null)`
  // tolerates old host builds that predate this field; the GUI falls back to
  // its own deterministic palette hash of `profileId`.
  accentColor: providerProfileAccentColorSchema.nullable().catch(null),
  // Present when this active profile's accountUuid matches a removed profile.
  // The add-profile naming step uses it to explain the preselected color
  // suggestion without exposing tombstone rows in normal selection surfaces.
  reusedTombstone: z
    .object({
      label: z.string(),
      // Same forward-compat guard as the profile-level `accentColor` above:
      // a single out-of-palette color here must degrade to null, not throw -
      // otherwise the array-level `.catch([])` on `profiles` below would wipe
      // every profile for this provider on an older client.
      accentColor: providerProfileAccentColorSchema.nullable().catch(null),
    })
    .nullable()
    .optional(),
});
export type ProviderProfile = z.infer<typeof providerProfileSchema>;

/**
 * Fold-in for profile rename/remove/recolor/acknowledgeAmbientDrift, carried
 * on `providers.setEnabled`'s request (see that method's `@2.1` contract in
 * `registry.ts` for why these live here instead of standalone
 * `providers.renameProfile` / `removeProfile` / `recolorProfile` /
 * `acknowledgeAmbientDrift` methods - a new top-level method name is
 * handshake-fatal against an already-released peer, see
 * `released-surface-compat.test.ts`).
 *
 * Rename/recolor apply to managed profiles and the ambient profile sentinel;
 * remove remains managed-only. `acknowledgeAmbientDrift` durably clears the
 * ambient profile's pending
 * `ambientDriftNotice` (see that field's comment below). No `profileId`:
 * there is exactly one ambient identity per provider. It rides the same
 * `@2.1` minor as the other actions because
 * `@2.1` itself is unreleased (the released surface, host-v1.0.0, is `@2.0`)
 * - versions exist to protect released peers, so an unreleased minor widens
 * in place instead of minting `@2.2`.
 */
export const providerProfileActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("rename"),
    profileId: z.string(),
    // Capped so an arbitrarily long/hostile label (durability audit B6)
    // can't bloat the registry file or break layout downstream.
    label: z.string().min(1).max(64),
  }),
  z.object({
    type: z.literal("remove"),
    profileId: z.string(),
  }),
  z.object({
    type: z.literal("recolor"),
    profileId: z.string(),
    accentColor: providerProfileAccentColorSchema,
  }),
  z.object({
    type: z.literal("acknowledgeAmbientDrift"),
  }),
]);
export type ProviderProfileAction = z.infer<typeof providerProfileActionSchema>;

const providerCliStateBaseShape = {
  enabled: z.boolean(),
  disabledBy: providerDisabledBySchema.nullable(),
  selected: providerSelectionSchema,
  candidates: z.array(providerCliCandidateSchema),
  authPending: z.boolean(),
  checkedAt: z.number().nullable(),
  apiKey: providerApiKeyStateSchema,
  // Extra CLI arguments the user wants appended when launching this provider
  // as a terminal agent (the host tokenizes and appends them to the spawned
  // argv). Only meaningful for terminal-agent-capable providers; "" when unset.
  terminalAgentArgs: z.string().catch(""),
  // Per-provider environment overrides applied when the host spawns this
  // provider's harness. Sorted by key for stable rendering; `[]` when unset.
  envOverrides: z.array(providerEnvOverrideSchema).catch([]),
  // Login/re-auth options for this provider. Null for providers that have no
  // supported login flow (cursor, traycer) or where login capability is not
  // yet modelled. `.catch(null)` tolerates old host builds that omit the field.
  loginCapability: providerLoginCapabilitySchema.nullable().catch(null),
  // True while the host's shell-env probe for this provider is still running
  // in the background (e.g. PATH binary discovery or env-sourced API key
  // lookup). The client re-fetches until it flips false. A pending row always
  // carries `available: false` semantically (don't trust candidates/auth yet).
  // `.catch(false)` tolerates old host builds that omit the field — old
  // behavior treats every verdict as final, which is correct for old hosts.
  availabilityPending: z.boolean().catch(false),
  // Per-profile rows for this provider: the ambient login plus any
  // Traycer-managed subscriptions. `[]` for providers that don't support the
  // multi-profile capability (gated per-adapter, see the decision log's
  // rollout row). The field ships with the v4.0 line: hosts on older lines
  // never send it and the v3→v4 upgrade bridge fills `profiles: []` ("old
  // host never had this feature"), with `.catch([])` kept as parse-time
  // hardening. UI affordances only appear once a provider has 2+ rows
  // (progressive disclosure).
  profiles: z.array(providerProfileSchema).catch([]),
};

const providerCliStateBaseShapeV10 = {
  enabled: z.boolean(),
  disabledBy: providerDisabledBySchema.nullable(),
  selected: providerSelectionSchema,
  candidates: z.array(providerCliCandidateSchema),
  authPending: z.boolean(),
  checkedAt: z.number().nullable(),
  apiKey: providerApiKeyStateSchema,
  terminalAgentArgs: z.string().catch(""),
  envOverrides: z.array(providerEnvOverrideSchema).catch([]),
  loginCapability: providerLoginCapabilitySchema.nullable().catch(null),
};

// Frozen protocol-v2.0 base shape (before `profiles`) - a hand-copy of
// `providerCliStateBaseShape` as it stood before profiles[] was added, NOT
// derived via `.extend()`/`.omit()` from the live shape. That distinction
// matters: a plain (non-strict) `z.object` built from this frozen shape
// silently DROPS an unmodeled `profiles` key during parsing, so the v3.0->v2.0
// downgrade (`downgradeProviderCliStateListToV20` below) actually strips
// profile identity (email, label) from the wire for v2.0 callers instead of
// passively inheriting whatever the live shape grows next. Do not add
// `profiles` (or any future field) here - extend the live
// `providerCliStateBaseShape` instead and let the v3 bridge decide whether it
// needs stripping too.
const providerCliStateBaseShapeV20 = {
  enabled: z.boolean(),
  disabledBy: providerDisabledBySchema.nullable(),
  selected: providerSelectionSchema,
  candidates: z.array(providerCliCandidateSchema),
  authPending: z.boolean(),
  checkedAt: z.number().nullable(),
  apiKey: providerApiKeyStateSchema,
  terminalAgentArgs: z.string().catch(""),
  envOverrides: z.array(providerEnvOverrideSchema).catch([]),
  loginCapability: providerLoginCapabilitySchema.nullable().catch(null),
  availabilityPending: z.boolean().catch(false),
};

export const providerCliStateSchema = z.object({
  providerId: providerIdSchema,
  ...providerCliStateBaseShape,
  auth: PROVIDER_AUTH_SCHEMA_V20,
});
export type ProviderCliState = z.infer<typeof providerCliStateSchema>;

export const providersListRequestSchema = z.object({
  forceAuthRefresh: z.boolean().optional(),
});
export type ProvidersListRequest = z.infer<typeof providersListRequestSchema>;

export const providersListResponseSchema = z.object({
  providers: z.array(providerCliStateSchema),
});
export type ProvidersListResponse = z.infer<typeof providersListResponseSchema>;

// ── Frozen protocol-v2.0 provider state + list response (before Amp) ───────
// `providers.list` always returns every provider; v2.0 shipped without Amp, so
// it is frozen here as actually shipped. The v3.0 line adds Amp and a v3→v2
// (and v3→v1) downgrade bridge filters it for older callers. Do not add new
// providers here - use the existing v3 bridge.
//
// Built from the hand-frozen `providerCliStateBaseShapeV20` - NOT
// `.extend()` on the live `providerCliStateSchema` - so this type never
// silently absorbs a future field the live shape grows (see that shape's
// comment; `profiles[]` is the concrete case this guards against).
export const providerCliStateSchemaV20 = z.object({
  providerId: providerIdSchemaV20,
  ...providerCliStateBaseShapeV20,
  auth: PROVIDER_AUTH_SCHEMA_V20,
});
export type ProviderCliStateV20 = z.infer<typeof providerCliStateSchemaV20>;
export const providersListResponseSchemaV20 = z.object({
  providers: z.array(providerCliStateSchemaV20),
});
export type ProvidersListResponseV20 = z.infer<
  typeof providersListResponseSchemaV20
>;

// ── Frozen protocol-v3.0 provider state + list response (with Amp, before ──
// Devin/Pi). `providers.list` always returns every provider; v3.0 shipped with
// Amp and WITHOUT `profiles` - multi-profile landed mid-line but never reached
// a released host on this line, so `profiles` belongs to the v4.0 cut and the
// v3→v4 upgrade fills `profiles: []` for v3.0 hosts. The v4.0 line also adds
// Devin/Pi, and the v4→v3 (and v4→v2 / v4→v1) downgrade bridges filter them
// for older callers. Do not add new providers or fields here - use the
// existing v4 bridge.
//
// Built as a hand-frozen snapshot of the base shape as actually released on
// the v3.0 line, with the frozen v3.0 provider-id enum - NOT derived via
// `.extend()` from the live schema, so future live-only fields do not leak
// into the v3.0 wire for already-shipped clients. The plain (non-strict)
// `z.object` built from this shape also silently DROPS an unmodeled
// `profiles` key, so the v4.0->v3.0 downgrade strips profile identity
// (email, label) off the wire for v3.0 callers that never negotiated profile
// support - same mechanism as `providerCliStateBaseShapeV20`.
const providerCliStateBaseShapeV30 = {
  enabled: z.boolean(),
  disabledBy: providerDisabledBySchema.nullable(),
  selected: providerSelectionSchema,
  candidates: z.array(providerCliCandidateSchema),
  authPending: z.boolean(),
  checkedAt: z.number().nullable(),
  apiKey: providerApiKeyStateSchema,
  terminalAgentArgs: z.string().catch(""),
  envOverrides: z.array(providerEnvOverrideSchema).catch([]),
  loginCapability: providerLoginCapabilitySchema.nullable().catch(null),
  availabilityPending: z.boolean().catch(false),
};

export const providerCliStateSchemaV30 = z.object({
  providerId: providerIdSchemaV30,
  ...providerCliStateBaseShapeV30,
  auth: PROVIDER_AUTH_SCHEMA_V20,
});
export type ProviderCliStateV30 = z.infer<typeof providerCliStateSchemaV30>;
export const providersListResponseSchemaV30 = z.object({
  providers: z.array(providerCliStateSchemaV30),
});
export type ProvidersListResponseV30 = z.infer<
  typeof providersListResponseSchemaV30
>;

// Frozen protocol-v1.0 provider state + list response. The v2.0 line of
// `providers.list` adds ACP GUI harness providers; the v2→v1 bridge filters
// them for v1.0 callers.
export const providerCliStateSchemaV10 = z.strictObject({
  providerId: providerIdSchemaV10,
  ...providerCliStateBaseShapeV10,
  auth: PROVIDER_AUTH_SCHEMA_V10,
});
export type ProviderCliStateV10 = z.infer<typeof providerCliStateSchemaV10>;
export const providersListResponseSchemaV10 = z.object({
  providers: z.array(providerCliStateSchemaV10),
});
export type ProvidersListResponseV10 = z.infer<
  typeof providersListResponseSchemaV10
>;

// ── Frozen major-2 mutation-response provider state (pre-profiles) ─────────
// The provider.* state-echo mutations (setSelection, addCustomPath,
// removeCustomPath, setEnabled, setApiKey, clearApiKey, setTerminalAgentArgs,
// setEnvOverride, deleteEnvOverride, awaitLogin) shipped their major-2 lines
// reusing the LIVE provider state, so - unlike `providers.list`, which froze
// `providerCliStateSchemaV20` - their released 2.0 wire kept evolving with the
// live shape and silently gained `profiles` (#258) that released hosts never
// send. This shape pins what a released 2.0 response actually carries: the
// pre-profiles base shape with the LIVE provider-id enum (a mutation response
// echoes the id the caller just named, so enum growth stays request-gated -
// see the `providers.set*` / `providers.add*` entries in
// compat-exceptions.json). `profiles` ships with each method's 2.1 line; the
// 2.0→2.1 upgrade fills `profiles: []` ("old host never had this feature").
// The plain (non-strict) `z.object` also strips an unmodeled `profiles` key,
// so host-side projection onto 2.0 keeps profile identity off the wire for
// released 2.0 callers.
export const providerMutationCliStateSchemaV20 = z.object({
  providerId: providerIdSchema,
  ...providerCliStateBaseShapeV20,
  auth: PROVIDER_AUTH_SCHEMA_V20,
});
export type ProviderMutationCliStateV20 = z.infer<
  typeof providerMutationCliStateSchemaV20
>;

export const providersSetSelectionRequestSchema = z.object({
  providerId: providerIdSchema,
  selection: providerSelectionSchema,
});
export const providersSetSelectionRequestSchemaV10 = z.strictObject({
  providerId: providerIdSchemaV10,
  selection: providerSelectionSchema,
});
export type ProvidersSetSelectionRequest = z.infer<
  typeof providersSetSelectionRequestSchema
>;

export const providersSetSelectionResponseSchema = z.object({
  state: providerCliStateSchema,
});
export const providersSetSelectionResponseSchemaV10 = z.object({
  state: providerCliStateSchemaV10,
});
export const providersSetSelectionResponseSchemaV20 = z.object({
  state: providerMutationCliStateSchemaV20,
});
export type ProvidersSetSelectionResponse = z.infer<
  typeof providersSetSelectionResponseSchema
>;

export const providersAddCustomPathRequestSchema = z.object({
  providerId: providerIdSchema,
  path: z.string().min(1),
});
export const providersAddCustomPathRequestSchemaV10 = z.strictObject({
  providerId: providerIdSchemaV10,
  path: z.string().min(1),
});
export type ProvidersAddCustomPathRequest = z.infer<
  typeof providersAddCustomPathRequestSchema
>;

export const providersAddCustomPathResponseSchema = z.object({
  state: providerCliStateSchema,
});
export const providersAddCustomPathResponseSchemaV10 = z.object({
  state: providerCliStateSchemaV10,
});
export const providersAddCustomPathResponseSchemaV20 = z.object({
  state: providerMutationCliStateSchemaV20,
});
export type ProvidersAddCustomPathResponse = z.infer<
  typeof providersAddCustomPathResponseSchema
>;

export const providersRemoveCustomPathRequestSchema = z.object({
  providerId: providerIdSchema,
  path: z.string().min(1),
});
export const providersRemoveCustomPathRequestSchemaV10 = z.strictObject({
  providerId: providerIdSchemaV10,
  path: z.string().min(1),
});
export type ProvidersRemoveCustomPathRequest = z.infer<
  typeof providersRemoveCustomPathRequestSchema
>;

export const providersRemoveCustomPathResponseSchema = z.object({
  state: providerCliStateSchema,
});
export const providersRemoveCustomPathResponseSchemaV10 = z.object({
  state: providerCliStateSchemaV10,
});
export const providersRemoveCustomPathResponseSchemaV20 = z.object({
  state: providerMutationCliStateSchemaV20,
});
export type ProvidersRemoveCustomPathResponse = z.infer<
  typeof providersRemoveCustomPathResponseSchema
>;

export const providersSetEnabledRequestSchema = z.object({
  providerId: providerIdSchema,
  enabled: z.boolean(),
});
export const providersSetEnabledRequestSchemaV10 = z.strictObject({
  providerId: providerIdSchemaV10,
  enabled: z.boolean(),
});
export type ProvidersSetEnabledRequest = z.infer<
  typeof providersSetEnabledRequestSchema
>;

export const providersSetEnabledResponseSchema = z.object({
  state: providerCliStateSchema,
});
export const providersSetEnabledResponseSchemaV10 = z.object({
  state: providerCliStateSchemaV10,
});
export const providersSetEnabledResponseSchemaV20 = z.object({
  state: providerMutationCliStateSchemaV20,
});
export type ProvidersSetEnabledResponse = z.infer<
  typeof providersSetEnabledResponseSchema
>;

/**
 * `providers.setEnabled@2.1` request - folds profile rename/remove/recolor onto this
 * existing method rather than new `providers.renameProfile` /
 * `removeProfile` / `recolorProfile` methods (see that contract in `registry.ts` for the full
 * rationale). `profileAction: null` is today's plain enable/disable request,
 * byte-identical to `providersSetEnabledRequestSchema` - old clients are
 * unaffected. The 2.1 response is the live shape
 * (`providersSetEnabledResponseSchema`, whose `state.profiles[]` reflects the
 * rename/removal/recolor); the released 2.0 response is frozen pre-profiles
 * (`providersSetEnabledResponseSchemaV20`) and the 2.0→2.1 upgrade fills
 * `profiles: []`.
 */
export const providersSetEnabledRequestSchemaV21 =
  providersSetEnabledRequestSchema.extend({
    profileAction: providerProfileActionSchema.nullable().default(null),
  });
export type ProvidersSetEnabledRequestV21 = z.infer<
  typeof providersSetEnabledRequestSchemaV21
>;

export const providersSetApiKeyRequestSchema = z.object({
  providerId: providerIdSchema,
  apiKey: z.string().min(1),
});
export const providersSetApiKeyRequestSchemaV10 = z.strictObject({
  providerId: providerIdSchemaV10,
  apiKey: z.string().min(1),
});
export type ProvidersSetApiKeyRequest = z.infer<
  typeof providersSetApiKeyRequestSchema
>;

export const providersSetApiKeyResponseSchema = z.object({
  state: providerCliStateSchema,
});
export const providersSetApiKeyResponseSchemaV10 = z.object({
  state: providerCliStateSchemaV10,
});
export const providersSetApiKeyResponseSchemaV20 = z.object({
  state: providerMutationCliStateSchemaV20,
});
export type ProvidersSetApiKeyResponse = z.infer<
  typeof providersSetApiKeyResponseSchema
>;

export const providersClearApiKeyRequestSchema = z.object({
  providerId: providerIdSchema,
});
export const providersClearApiKeyRequestSchemaV10 = z.strictObject({
  providerId: providerIdSchemaV10,
});
export type ProvidersClearApiKeyRequest = z.infer<
  typeof providersClearApiKeyRequestSchema
>;

export const providersClearApiKeyResponseSchema = z.object({
  state: providerCliStateSchema,
});
export const providersClearApiKeyResponseSchemaV10 = z.object({
  state: providerCliStateSchemaV10,
});
export const providersClearApiKeyResponseSchemaV20 = z.object({
  state: providerMutationCliStateSchemaV20,
});
export type ProvidersClearApiKeyResponse = z.infer<
  typeof providersClearApiKeyResponseSchema
>;

export const providersSetTerminalAgentArgsRequestSchema = z.object({
  providerId: providerIdSchema,
  // Empty string clears the saved override.
  terminalAgentArgs: z.string(),
});
export const providersSetTerminalAgentArgsRequestSchemaV10 = z.strictObject({
  providerId: providerIdSchemaV10,
  terminalAgentArgs: z.string(),
});
export type ProvidersSetTerminalAgentArgsRequest = z.infer<
  typeof providersSetTerminalAgentArgsRequestSchema
>;

export const providersSetTerminalAgentArgsResponseSchema = z.object({
  state: providerCliStateSchema,
});
export const providersSetTerminalAgentArgsResponseSchemaV10 = z.object({
  state: providerCliStateSchemaV10,
});
export const providersSetTerminalAgentArgsResponseSchemaV20 = z.object({
  state: providerMutationCliStateSchemaV20,
});
export type ProvidersSetTerminalAgentArgsResponse = z.infer<
  typeof providersSetTerminalAgentArgsResponseSchema
>;

export const providersSetEnvOverrideRequestSchema = z.object({
  providerId: providerIdSchema,
  key: z.string().min(1),
  // null = explicit unset; a string sets the value.
  value: z.string().nullable(),
});
export const providersSetEnvOverrideRequestSchemaV10 = z.strictObject({
  providerId: providerIdSchemaV10,
  key: z.string().min(1),
  value: z.string().nullable(),
});
export type ProvidersSetEnvOverrideRequest = z.infer<
  typeof providersSetEnvOverrideRequestSchema
>;

export const providersSetEnvOverrideResponseSchema = z.object({
  state: providerCliStateSchema,
});
export const providersSetEnvOverrideResponseSchemaV10 = z.object({
  state: providerCliStateSchemaV10,
});
export const providersSetEnvOverrideResponseSchemaV20 = z.object({
  state: providerMutationCliStateSchemaV20,
});
export type ProvidersSetEnvOverrideResponse = z.infer<
  typeof providersSetEnvOverrideResponseSchema
>;

export const providersDeleteEnvOverrideRequestSchema = z.object({
  providerId: providerIdSchema,
  key: z.string().min(1),
});
export const providersDeleteEnvOverrideRequestSchemaV10 = z.strictObject({
  providerId: providerIdSchemaV10,
  key: z.string().min(1),
});
export type ProvidersDeleteEnvOverrideRequest = z.infer<
  typeof providersDeleteEnvOverrideRequestSchema
>;

export const providersDeleteEnvOverrideResponseSchema = z.object({
  state: providerCliStateSchema,
});
export const providersDeleteEnvOverrideResponseSchemaV10 = z.object({
  state: providerCliStateSchemaV10,
});
export const providersDeleteEnvOverrideResponseSchemaV20 = z.object({
  state: providerMutationCliStateSchemaV20,
});
export type ProvidersDeleteEnvOverrideResponse = z.infer<
  typeof providersDeleteEnvOverrideResponseSchema
>;

export const providersDetectVersionRequestSchema = z.object({
  candidatePath: z.string().min(1),
});
export type ProvidersDetectVersionRequest = z.infer<
  typeof providersDetectVersionRequestSchema
>;

export const providersDetectVersionResponseSchema = z.object({
  executable: z.boolean(),
  version: z.string().nullable(),
});
export type ProvidersDetectVersionResponse = z.infer<
  typeof providersDetectVersionResponseSchema
>;

/**
 * Spawn the provider CLI's browser-OAuth login flow (e.g. `claude auth login`).
 * The CLI opens the browser itself and self-completes via a localhost loopback,
 * so the host only spawns it and reports back. `url` is any sign-in URL
 * scraped from the CLI's stdout/stderr (a manual fallback if the auto-open
 * fails), `started` is whether the child process actually spawned. Completion
 * is observed by the client polling `providers.list` for `auth.status`.
 */
export const providersStartLoginRequestSchema = z.object({
  providerId: providerIdSchema,
});
export type ProvidersStartLoginRequest = z.infer<
  typeof providersStartLoginRequestSchema
>;

export const providersStartLoginResponseSchema = z.object({
  url: z.string().nullable(),
  started: z.boolean(),
});
export type ProvidersStartLoginResponse = z.infer<
  typeof providersStartLoginResponseSchema
>;

/**
 * `providers.startLogin@1.1` request - adds `profileId` (re-authenticate an
 * existing managed profile's isolated config dir) and `createProfile` (mint a
 * brand-new profile - create its dir, seed it from the ambient snapshot, then
 * spawn the login CLI against it - see the decision log's "Add profile flow").
 * `profileId` and `createProfile` are mutually exclusive from the caller's
 * point of view; the resolver treats a non-null `createProfile` as
 * authoritative when both are somehow set. Both default to `null`, which
 * preserves today's exact behavior (re-auth whatever binary/dir is currently
 * selected for this provider, no profile dir override) - so old clients that
 * predate profiles are unaffected.
 *
 * `createProfile.shareSkillsAndPlugins` is an in-place additive field (this
 * whole surface is still unreleased, so a bare in-place addition rather than
 * a version bump is the established precedent here - see `profileId`/
 * `createProfile` themselves, added the same way onto the v1.0 base). Claude
 * profile creation only: dir-symlinks `skills/`/`plugins/` to ambient instead
 * of copying (shadow-home plan §6). Defaults to `false` (copy, today's
 * behavior) so old clients that predate the checkbox are unaffected; every
 * other provider ignores it.
 */
export const providersStartLoginRequestSchemaV11 =
  providersStartLoginRequestSchema.extend({
    profileId: z.string().nullable().default(null),
    createProfile: z
      .object({
        // User-chosen label. Empty string defers naming to the login probe's
        // resolved identity (renderer default: email prefix) - the host
        // applies its own placeholder until then; rename later via
        // `providers.setEnabled`'s `profileAction`. Capped (not `.min(1)` -
        // empty is the deferred-naming signal above) so a hostile label
        // can't bloat the registry file or break layout downstream
        // (durability audit B6).
        label: z.string().max(64),
        shareSkillsAndPlugins: z.boolean().default(false),
      })
      .nullable()
      .default(null),
  });
export type ProvidersStartLoginRequestV11 = z.infer<
  typeof providersStartLoginRequestSchemaV11
>;

/**
 * `providers.startLogin@1.1` response - echoes the profile this login
 * targeted, so a `createProfile` caller learns the host-minted id without a
 * separate round-trip. `null` for a legacy (no-profile-override) login,
 * mirroring the request's `null` default.
 */
export const providersStartLoginResponseSchemaV11 =
  providersStartLoginResponseSchema.extend({
    profileId: z.string().nullable().default(null),
  });
export type ProvidersStartLoginResponseV11 = z.infer<
  typeof providersStartLoginResponseSchemaV11
>;

/**
 * Block until an in-flight `providers.startLogin` child finishes (the browser
 * loopback completes or the CLI exits), then return the freshly re-probed state.
 * This is the honest "did the reconnect work?" signal - the host owns the
 * login child's exit, so the GUI awaits this instead of polling auth status.
 */
// `profileId` mirrors `providers.startLogin@1.1`'s request field so the
// caller awaits the same profile-scoped login child it started. Ships with
// `providers.awaitLogin@2.1` (originally landed as a bare additive/defaulted
// field on the released 2.0 line; the 2.0 shapes are frozen without it below
// and the 2.0→2.1 upgrade fills `null`). The v2->v1 downgrade bridge in
// registry.ts explicitly drops it before the strict v1.0 parse (see
// `providersAwaitLoginDowngradeV2ToV1`).
export const providersAwaitLoginRequestSchema = z.object({
  providerId: providerIdSchema,
  profileId: z.string().nullable().default(null),
});
export const providersAwaitLoginRequestSchemaV10 = z.strictObject({
  providerId: providerIdSchemaV10,
});
// Frozen `providers.awaitLogin@2.0` request as released: no `profileId`.
export const providersAwaitLoginRequestSchemaV20 = z.object({
  providerId: providerIdSchema,
});
export type ProvidersAwaitLoginRequest = z.infer<
  typeof providersAwaitLoginRequestSchema
>;

export const providersAwaitLoginResponseSchema = z.object({
  // The provider's state after the login child closed and auth was re-probed.
  // Null when no login was in flight for this provider (nothing to await).
  state: providerCliStateSchema.nullable(),
  // Create-profile only: when the authenticated account already belongs to
  // an active profile, the host discards the pending profile instead of
  // activating a duplicate and identifies the existing profile here. Ships
  // with `providers.awaitLogin@2.1`; the frozen 2.0 response below never
  // carried it.
  existingProfileId: z.string().nullable().default(null),
});
export const providersAwaitLoginResponseSchemaV10 = z.object({
  state: providerCliStateSchemaV10.nullable(),
});
// Frozen `providers.awaitLogin@2.0` response as released: pre-profiles state,
// no `existingProfileId`.
export const providersAwaitLoginResponseSchemaV20 = z.object({
  state: providerMutationCliStateSchemaV20.nullable(),
});
export type ProvidersAwaitLoginResponse = z.infer<
  typeof providersAwaitLoginResponseSchema
>;

/**
 * Client-side response-frame budget for `providers.awaitLogin`, which is a
 * long-poll: the host's response is contractually silent until the OAuth
 * login child terminates. A transport-default frame timeout (~30 s) misreads
 * that silence as a dead host and abandons a healthy in-flight sign-in as
 * soon as the user takes longer than the timeout in the browser.
 *
 * Derivation: the host force-kills a login child after 3 minutes and its
 * await path self-resolves at most 5 s later even when the child never
 * confirms termination, followed by bounded auth re-probes before the
 * response is framed. 4 minutes covers that worst case with slack. The host
 * must keep its internal deadline strictly under this budget - clients wait
 * exactly this long before declaring the call dead.
 */
export const PROVIDERS_AWAIT_LOGIN_RESPONSE_BUDGET_MS = 4 * 60_000;

/** Kill an in-flight `providers.startLogin` child for this provider. */
export const providersCancelLoginRequestSchema = z.object({
  providerId: providerIdSchema,
});
export type ProvidersCancelLoginRequest = z.infer<
  typeof providersCancelLoginRequestSchema
>;

// `providers.cancelLogin@1.1` request - adds `profileId`, mirroring
// `providers.startLogin@1.1`, so the caller cancels the same profile-scoped
// login child it started. Shipped as a minor (not an in-place edit to v1.0,
// which every released peer already negotiates): `profileId` defaults to
// `null`, byte-identical to today's request, so old clients are unaffected.
export const providersCancelLoginRequestSchemaV11 =
  providersCancelLoginRequestSchema.extend({
    profileId: z.string().nullable().default(null),
  });
export type ProvidersCancelLoginRequestV11 = z.infer<
  typeof providersCancelLoginRequestSchemaV11
>;

export const providersCancelLoginResponseSchema = z.object({
  cancelled: z.boolean(),
});
export type ProvidersCancelLoginResponse = z.infer<
  typeof providersCancelLoginResponseSchema
>;

export function downgradeProviderAuthV20ToV10(
  auth: ProviderAuthV20,
): ProviderAuthV10 {
  switch (auth.status) {
    case "configured":
    case "unavailable":
      return { ...auth, status: "unknown" };
    case "authenticated":
      return { ...auth, status: "authenticated" };
    case "unauthenticated":
      return { ...auth, status: "unauthenticated" };
    case "unknown":
      return { ...auth, status: "unknown" };
  }
}

// Accepts any latest-shaped state (v2.0 or v3.0 alike - both v2→v1 and v3→v1
// downgrade the same way) and downgrades it to the frozen v1.0 shape. A
// provider outside v1.0's id set (ACP GUI harnesses, Amp) simply fails the
// `providerCliStateSchemaV10` parse below and is filtered by the caller.
// Accepts either the live (latest) state or the frozen v2.0 state - the v2.0
// shape already lacks `profiles` (see `providerCliStateBaseShapeV20`), so
// `profiles` is typed optional here rather than requiring callers to conjure
// one. Both `providersListDowngradeV2ToV1` (v2.0 source) and the v3.0/latest
// downgrade paths (live source) share this one stripping function.
export function downgradeProviderCliStateToV10(
  state: Omit<ProviderCliState, "profiles"> & {
    profiles?: ProviderCliState["profiles"];
  },
): ProviderCliStateV10 | null {
  // `providerCliStateSchemaV10` is a `z.strictObject`, so it REJECTS any key it
  // doesn't model. Drop later-than-v1.0 fields (`availabilityPending`,
  // `profiles`) before the parse - otherwise every provider fails the parse
  // and silently vanishes from the downgraded payload for v1.0 clients.
  // `profiles` in particular must never reach a v1.0 caller - stripping it
  // here also keeps profile identity (email, label) off the wire for peers
  // that never negotiated profile support.
  const { availabilityPending, profiles, ...rest } = state;
  const parsed = providerCliStateSchemaV10.safeParse({
    ...rest,
    auth: downgradeProviderAuthV20ToV10(state.auth),
  });
  return parsed.success ? parsed.data : null;
}

// Downgrades a latest-shaped provider-state list to the frozen v2.0 shape,
// dropping Amp/Devin/Pi (or any post-v2.0 provider) so an already-shipped
// v2.0 client's strict decode never sees it. The auth-status schema is
// unchanged between v2.0 and later lines for the kept ids, so this is a pure
// filter+reparse - no field remapping needed (unlike the v1.0 downgrade).
export function downgradeProviderCliStateListToV20(
  states: readonly unknown[],
): ProviderCliStateV20[] {
  return states.flatMap((state) => {
    const parsed = providerCliStateSchemaV20.safeParse(state);
    return parsed.success ? [parsed.data] : [];
  });
}

// Downgrades a latest-shaped (v4.0) provider-state list to the frozen v3.0
// shape, dropping Devin/Pi (or any future post-v3.0 provider) so an already-
// shipped v3.0 client's strict decode never sees it. The reparse also strips
// `profiles` - the frozen v3.0 object doesn't model it - keeping profile
// identity (email, label) off the wire for callers that never negotiated
// profile support.
export function downgradeProviderCliStateListToV30(
  states: readonly unknown[],
): ProviderCliStateV30[] {
  return states.flatMap((state) => {
    const parsed = providerCliStateSchemaV30.safeParse(state);
    return parsed.success ? [parsed.data] : [];
  });
}

// Upgrades a v1.0 state to the frozen v2.0 shape - used only by
// `providers.list`'s v1.0 -> v2.0 bridge, whose response is pinned to
// `providerCliStateSchemaV20` (narrower `providerId`, no `profiles`). Every
// other provider.* mutation's v1.0 -> v2.0 bridge upgrades to the frozen
// major-2 mutation shape instead - see
// `upgradeProviderCliStateV10ToMutationV20` below.
export function upgradeProviderCliStateV10ToV20(
  state: ProviderCliStateV10,
): ProviderCliStateV20 {
  return providerCliStateSchemaV20.parse({
    ...state,
    availabilityPending: false,
  });
}

// Upgrades a v1.0 state to the frozen major-2 mutation-response shape - used
// by every provider.* state-echo mutation's v1.0 -> v2.0 bridge
// (setSelection, addCustomPath, setEnabled, ...). Like the v1.0 host itself,
// the frozen 2.0 shape predates `profiles`; each method's 2.0 -> 2.1 upgrade
// fills `profiles: []` for the caller's canonical.
export function upgradeProviderCliStateV10ToMutationV20(
  state: ProviderCliStateV10,
): ProviderMutationCliStateV20 {
  return providerMutationCliStateSchemaV20.parse({
    ...state,
    availabilityPending: false,
  });
}
