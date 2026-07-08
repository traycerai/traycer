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
 * client never receives the Amp provider; the v3.0 line adds it with a v3→v2
 * (and v3→v1) downgrade bridge. Do not add new providers here - extend the
 * latest `providerIdSchema` and use the existing v3 bridge instead.
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
export const providerCliStateSchemaV20 = providerCliStateSchema.extend({
  providerId: providerIdSchemaV20,
});
export type ProviderCliStateV20 = z.infer<typeof providerCliStateSchemaV20>;
export const providersListResponseSchemaV20 = z.object({
  providers: z.array(providerCliStateSchemaV20),
});
export type ProvidersListResponseV20 = z.infer<
  typeof providersListResponseSchemaV20
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
export type ProvidersSetEnabledResponse = z.infer<
  typeof providersSetEnabledResponseSchema
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
 * Block until an in-flight `providers.startLogin` child finishes (the browser
 * loopback completes or the CLI exits), then return the freshly re-probed state.
 * This is the honest "did the reconnect work?" signal - the host owns the
 * login child's exit, so the GUI awaits this instead of polling auth status.
 */
export const providersAwaitLoginRequestSchema = z.object({
  providerId: providerIdSchema,
});
export const providersAwaitLoginRequestSchemaV10 = z.strictObject({
  providerId: providerIdSchemaV10,
});
export type ProvidersAwaitLoginRequest = z.infer<
  typeof providersAwaitLoginRequestSchema
>;

export const providersAwaitLoginResponseSchema = z.object({
  // The provider's state after the login child closed and auth was re-probed.
  // Null when no login was in flight for this provider (nothing to await).
  state: providerCliStateSchema.nullable(),
});
export const providersAwaitLoginResponseSchemaV10 = z.object({
  state: providerCliStateSchemaV10.nullable(),
});
export type ProvidersAwaitLoginResponse = z.infer<
  typeof providersAwaitLoginResponseSchema
>;

/** Kill an in-flight `providers.startLogin` child for this provider. */
export const providersCancelLoginRequestSchema = z.object({
  providerId: providerIdSchema,
});
export type ProvidersCancelLoginRequest = z.infer<
  typeof providersCancelLoginRequestSchema
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
export function downgradeProviderCliStateToV10(
  state: ProviderCliState,
): ProviderCliStateV10 | null {
  // `providerCliStateSchemaV10` is a `z.strictObject`, so it REJECTS any key it
  // doesn't model. Drop v2.0-only fields (here `availabilityPending`) before the
  // parse — otherwise every provider fails the parse and silently vanishes from
  // the downgraded payload for v1.0 clients.
  const { availabilityPending, ...rest } = state;
  const parsed = providerCliStateSchemaV10.safeParse({
    ...rest,
    auth: downgradeProviderAuthV20ToV10(state.auth),
  });
  return parsed.success ? parsed.data : null;
}

// Downgrades a latest-shaped (v3.0) provider-state list to the frozen v2.0
// shape, dropping Amp (or any future post-v2.0 provider) so an already-shipped
// v2.0 client's strict decode never sees it. The auth-status schema is
// unchanged between v2.0 and latest, so this is a pure filter+reparse - no
// field remapping needed (unlike the v1.0 downgrade above).
export function downgradeProviderCliStateListToV20(
  states: readonly ProviderCliState[],
): ProviderCliStateV20[] {
  return states.flatMap((state) => {
    const parsed = providerCliStateSchemaV20.safeParse(state);
    return parsed.success ? [parsed.data] : [];
  });
}

export function upgradeProviderCliStateV10ToV20(
  state: ProviderCliStateV10,
): ProviderCliStateV20 {
  return providerCliStateSchemaV20.parse({
    ...state,
    availabilityPending: false,
  });
}
