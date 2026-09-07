/** Schemas for the `providers.*` host RPC surface. */
import { z } from "zod";
import type { TuiHarnessId } from "@traycer/protocol/host/agent/shared";
import {
  providerIdSchema,
  providerIdSchemaV10,
  providerIdSchemaV20,
  type ProviderId,
  type ProviderIdV10,
  type ProviderIdV20,
} from "./provider-ids";
import {
  DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
  DEFAULT_PROVIDER_NATIVE_CAPABILITIES_V70_PREIMAGE,
  modelProviderAuthActionSchema,
  modelProviderAuthCancelContextSchema,
  modelProviderAuthPollContextSchema,
  modelProviderAuthResultSchema,
  modelProvidersListResultSchema,
  nativeAuthActionSchema,
  nativeAuthCancelContextSchema,
  nativeAuthPollContextSchema,
  nativeAuthResultSchema,
  nativeListQuerySchema,
  nativeListResultSchema,
  nativeListResultSchemaV70Preimage,
  nativeMutationResultSchema,
  nativeMutationSchema,
  providerNativeCapabilitiesSchema,
  providerNativeCapabilitiesSchemaV70Preimage,
  type ModelProviderAuthAction,
  type ModelProviderAuthCancelContext,
  type ModelProviderAuthPollContext,
  type ModelProviderAuthResult,
  type ModelProvidersListResult,
  type NativeAuthAction,
  type NativeAuthCancelContext,
  type NativeAuthPollContext,
  type NativeAuthResult,
  type NativeListQuery,
  type NativeListResult,
  type NativeMutation,
  type NativeMutationResult,
  type ProviderNativeCapabilities,
  type ProviderNativeCapabilitiesV70Preimage,
} from "./provider-native-schemas";

export {
  providerIdSchema,
  providerIdSchemaV10,
  providerIdSchemaV20,
  type ProviderId,
  type ProviderIdV10,
  type ProviderIdV20,
};

/**
 * Frozen provider id set as shipped in protocol v3.0 (with Amp, before Devin/Pi).
 * Do not add new providers here - extend the latest `providerIdSchema` and use the existing version bridges instead.
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

/**
 * Frozen provider id set as shipped in protocol v4.0 (with Devin/Pi, before Hermes/omp).
 * Do not add new providers here - extend the latest `providerIdSchema` and use the existing bridges instead.
 */
export const providerIdSchemaV40 = z.enum([
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
export type ProviderIdV40 = z.infer<typeof providerIdSchemaV40>;

/** Frozen provider id set as shipped in protocol v5.0 (with Hermes, before omp). */
export const providerIdSchemaV50 = z.enum([
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
  "hermes",
]);
export type ProviderIdV50 = z.infer<typeof providerIdSchemaV50>;

/**
 * Frozen provider id set as shipped in protocol v6.0 (v5.0 plus omp).
 * This line IS released - `cli-v1.1.9` (tagged 2026-07-29) shipped v6.0, so it is frozen for the same reason v5.0 is: a client in the field strict-decodes exactly these ids.
 */
export const providerIdSchemaV60 = z.enum([
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
  "hermes",
  "omp",
]);
export type ProviderIdV60 = z.infer<typeof providerIdSchemaV60>;

/** Frozen provider id set as shipped in protocol v7.0 (v6.0 plus huggingface). */
export const providerIdSchemaV70 = z.enum([
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
  "hermes",
  "omp",
  "huggingface",
]);
export type ProviderIdV70 = z.infer<typeof providerIdSchemaV70>;

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
  hermes: "Hermes Agent",
  omp: "Oh My Pi",
  huggingface: "Hugging Face",
  reasonix: "Reasonix",
};

/** Canonical TUI-harness-id → provider-overrides-id map. */
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

/**
 * Why an `error` arm's install is stuck, as a closed vocabulary the renderer can write copy against.
 * Its copy names reconnecting or restarting, never "retry".
 */
export const providerManagedInstallErrorReasonSchema = z.enum([
  "disk-full",
  "network",
  "verification",
  "unknown",
  "unrepairable",
  "live-owner-stalled",
  "trust-unavailable",
  "local-storage-mismatch",
]);
export type ProviderManagedInstallErrorReason = z.infer<
  typeof providerManagedInstallErrorReasonSchema
>;

/**
 * `providers.list@6.0` - Install lifecycle of a provider's managed (registry-backed) binary pack.
 * The `error` arm and the nullable percent are ADDITIVE ON THE UNRELEASED 6.0 LINE.
 */
export const providerManagedInstallStateSchema = z.discriminatedUnion(
  "status",
  [
    // `absent` deliberately carries NO `version`.
    // Do not add a fourth copy of that answer here.
    z.object({ status: z.literal("absent") }),
    z.object({
      status: z.literal("downloading"),
      percent: z.number().min(0).max(100).nullable(),
      // Ships with v7.0; the v7->v6 bridge strips it.
      // Nullable because a host can be waiting behind a sibling's lease before it has resolved which version that sibling is fetching.
      version: z.string().nullable().catch(null).optional(),
    }),
    z.object({
      status: z.literal("installed"),
      // Ships with v7.0; the v7->v6 bridge strips it.
      // Nullable so a host that can see a usable managed copy but cannot cheaply name its version (the poll lane runs no per-dir verification) reports the truth rather than guessing.
      version: z.string().nullable().catch(null).optional(),
    }),
    z.object({
      status: z.literal("error"),
      reason: providerManagedInstallErrorReasonSchema,
      // The version the failed attempt was for.
      // Nullable: a failure early enough to precede target resolution (a keyring that would not verify - `trust-unavailable`) has no version to name, and inventing one would misattribute a host-wide outage to a specific build.
      version: z.string().nullable().catch(null).optional(),
      // Operator-facing detail behind the reason (the underlying error text).
      // Never the primary copy - the renderer writes its own from `reason`.
      message: z.string(),
      // Epoch ms the host will accept an automatic retry again, or null when the failure carries no backoff.
      retryAtMs: z.number().int().nonnegative().nullable(),
    }),
  ],
);
export type ProviderManagedInstallState = z.infer<
  typeof providerManagedInstallStateSchema
>;

/**
 * Frozen `providers.list@7.0` snapshot of `providerManagedInstallErrorReasonSchema` - a hand-copy, NOT derived from the live enum via `.extract()`/`.exclude()`, exactly like the frozen provider id enums above.
 * A reason added to the live enum must not appear here.
 */
export const providerManagedInstallErrorReasonSchemaV70 = z.enum([
  "disk-full",
  "network",
  "verification",
  "unknown",
  "unrepairable",
  "live-owner-stalled",
  "trust-unavailable",
  "local-storage-mismatch",
]);
export type ProviderManagedInstallErrorReasonV70 = z.infer<
  typeof providerManagedInstallErrorReasonSchemaV70
>;

/**
 * PRE-IMAGE snapshot of `providerManagedInstallStateSchema` - a hand-copy of the four arms as they stood before the version-manager work, for the same reason `providerLoginCapabilitySchemaV40` is a hand-copy of the.
 */
export const providerManagedInstallStateSchemaV70Preimage =
  z.discriminatedUnion("status", [
    z.object({ status: z.literal("absent") }),
    z.object({
      status: z.literal("downloading"),
      percent: z.number().min(0).max(100).nullable(),
    }),
    z.object({ status: z.literal("installed") }),
    z.object({
      status: z.literal("error"),
      reason: providerManagedInstallErrorReasonSchemaV70,
      message: z.string(),
      retryAtMs: z.number().int().nonnegative().nullable(),
    }),
  ]);
export type ProviderManagedInstallStateV70Preimage = z.infer<
  typeof providerManagedInstallStateSchemaV70Preimage
>;

// ── v7.0: per-pack managed version manager ─────────────────────────────────

/** Whether the registry channel still vouches for a version, and how. */
export const providerPackVersionCertificationSchema = z.enum([
  "eligible",
  "yanked",
  "below-security-floor",
  "host-ineligible",
  "uncertified",
]);
export type ProviderPackVersionCertification = z.infer<
  typeof providerPackVersionCertificationSchema
>;

/**
 * Why an on-disk version dir cannot be served, derived from the host's verification verdict layer (N5).
 * `corrupt` and `unverified` are NOT synonyms and must not be merged.
 */
export const providerPackVersionUnusableReasonSchema = z.enum([
  "condemned",
  "quarantined",
  "corrupt",
  "unverified",
]);
export type ProviderPackVersionUnusableReason = z.infer<
  typeof providerPackVersionUnusableReasonSchema
>;

/** Per-version install state inside the version manager. */
export const providerPackVersionInstallStateSchema = z.discriminatedUnion(
  "status",
  [
    z.object({ status: z.literal("absent") }),
    z.object({
      status: z.literal("downloading"),
      percent: z.number().min(0).max(100).nullable(),
    }),
    z.object({ status: z.literal("installed") }),
    z.object({
      status: z.literal("unusable"),
      reason: providerPackVersionUnusableReasonSchema,
    }),
    z.object({
      status: z.literal("error"),
      reason: providerManagedInstallErrorReasonSchema,
      message: z.string(),
      retryAtMs: z.number().int().nonnegative().nullable(),
    }),
  ],
);
export type ProviderPackVersionInstallState = z.infer<
  typeof providerPackVersionInstallStateSchema
>;

/** One row in the version manager: a version the user can act on. */
export const providerPackVersionSchema = z.object({
  version: z.string(),
  // Null for a yank tombstone whose assets the registry has already pruned - the head remembers the withdrawal, not the size.
  // Renderers must not print "0 MB" for it.
  sizeBytes: z.number().int().nonnegative().nullable(),
  certification: providerPackVersionCertificationSchema,
  // True for the baked pin - the build this Traycer release is paired with.
  // Rendered "Recommended".
  recommended: z.boolean(),
  current: z.boolean(),
  installState: providerPackVersionInstallStateSchema,
});
export type ProviderPackVersion = z.infer<typeof providerPackVersionSchema>;

/**
 * The per-pack version manager's state. Null on a provider with no managed
 * pack (see `packId`).
 */
export const providerManagedVersionsSchema = z.object({
  autoDownload: z.boolean(),
  // Null = auto (follow the newest eligible).
  pinnedVersion: z.string().nullable(),
  updateAvailable: z.object({ version: z.string() }).nullable(),
  // Other provider ids served by this same pack, so the panel can name the sharing ("Shared by OpenCode, Traycer, OpenRouter, Hugging Face").
  sharedWithProviders: z.array(providerIdSchema).catch([]),
  // Total on-disk footprint of this pack across every retained version.
  // Null when the host cannot cheaply size the cell.
  totalSizeBytes: z.number().int().nonnegative().nullable(),
  // Union of channel-head versions (>= the baked pin) and versions installed
  // on disk - see `certification` for how the two sources are distinguished.
  available: z.array(providerPackVersionSchema),
});
export type ProviderManagedVersions = z.infer<
  typeof providerManagedVersionsSchema
>;

/**
 * Frozen `providers.list@7.x` version-manager state: identical to the live schema except `sharedWithProviders` is pinned to `providerIdSchemaV70`.
 * Do NOT widen this schema; extend the live one and let the next major publish it.
 */
export const providerManagedVersionsSchemaV70 = z.object({
  autoDownload: z.boolean(),
  pinnedVersion: z.string().nullable(),
  updateAvailable: z.object({ version: z.string() }).nullable(),
  sharedWithProviders: z.array(providerIdSchemaV70).catch([]),
  totalSizeBytes: z.number().int().nonnegative().nullable(),
  available: z.array(providerPackVersionSchema),
});
export type ProviderManagedVersionsV70 = z.infer<
  typeof providerManagedVersionsSchemaV70
>;

/** Why the version manager cannot be offered for a pack that HAS one. */
export const providerManagedVersionsUnavailableSchema = z.object({
  reason: z.enum([
    // Trust roots are not configured in this build, so no managed registry is
    // reachable by design. Terminal for this install - not a retry.
    "registry-unconfigured",
    // Trust roots exist and a load was attempted and failed (offline,
    // unreachable registry, verification failure). Retried with backoff.
    "registry-unreachable",
    // No load attempted yet this process. Transient by construction: the
    // keyring loader retries, and a later poll answers differently.
    "registry-not-yet-checked",
    // The keyring verified but no install manager is attached, so nothing can
    // enumerate or fetch versions. The wedge-recovery seam.
    "install-manager-unavailable",
  ]),
});
export type ProviderManagedVersionsUnavailable = z.infer<
  typeof providerManagedVersionsUnavailableSchema
>;

/**
 * What the NEXT execute for this provider would resolve to - not what is "currently running", which the host cannot truthfully report for a provider at all: live sessions pin their binary for life, so several different.
 * `path`/`version` are nullable because the resolved candidate may have neither a stable path (the bundled inline build) nor a cheaply-known version - the simulation is explicitly forbidden from probing to find out.
 */
export const providerNextRunBinarySchema = z.object({
  kind: z.enum(["managed", "bundled", "path", "custom"]),
  path: z.string().nullable(),
  version: z.string().nullable(),
});
export type ProviderNextRunBinary = z.infer<typeof providerNextRunBinarySchema>;

/**
 * Host-aggregated, direction-free signal that other active sessions for this provider are bound to a binary other than the one `nextRunBinary` names.
 * `differingSessionCount: 0` and `null` both mean "nothing to show" - the renderer never shows a toast for this, only a quiet, self-correcting row indicator.
 */
export const providerVersionVisibilitySchema = z.object({
  differingSessionCount: z.number().int().nonnegative(),
});
export type ProviderVersionVisibility = z.infer<
  typeof providerVersionVisibilitySchema
>;

/** Phase-2 (live update lane) advisory vocabulary. */
export const providerAdvisoryKindSchema = z.enum([
  "stale-channel",
  "cannot-confirm-eligibility",
  "yank-keep-running",
  "yank-rollback",
  "row-incompatibility",
]);
export type ProviderAdvisoryKind = z.infer<typeof providerAdvisoryKindSchema>;

export const providerAdvisorySchema = z.object({
  kind: providerAdvisoryKindSchema,
  detail: z.string().nullable(),
});
export type ProviderAdvisory = z.infer<typeof providerAdvisorySchema>;

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

/** Definitive signed-out verdict. */
export const UNAUTHENTICATED_PROVIDER_AUTH: ProviderAuth = {
  status: "unauthenticated",
  badgeText: null,
  label: null,
  detail: null,
};

/** Who turned a provider off, and when. */
export const providerDisabledBySchema = z.object({
  userId: z.string(),
  handle: z.string().nullable(),
  at: z.number(),
});
export type ProviderDisabledBy = z.infer<typeof providerDisabledBySchema>;

/**
 * API-key state for a provider.
 * The raw key is NEVER returned over RPC - only whether one is resolvable and where it came from (`stored` = saved in Settings, `env` = the user's login-shell `CURSOR_API_KEY`).
 */
export const providerApiKeyStateSchema = z.object({
  supported: z.boolean(),
  configured: z.boolean(),
  source: z.enum(["stored", "env"]).nullable(),
});
export type ProviderApiKeyState = z.infer<typeof providerApiKeyStateSchema>;

/** A single environment-variable override applied when the host spawns this provider's harness. */
export const providerEnvOverrideSchema = z.object({
  key: z.string(),
  value: z.string().nullable(),
});
export type ProviderEnvOverride = z.infer<typeof providerEnvOverrideSchema>;

/** Describes how a user can re-authenticate a provider CLI from the in-chat re-auth banner. */
export const providerLoginCapabilitySchema = z.object({
  /** Args to pass to the provider binary for browser-OAuth login, or null if unsupported. */
  oauthArgs: z.array(z.string()).nullable(),
  /** Credential env vars the user can paste a key/token into (e.g. */
  token: z.object({ vars: z.array(z.string()) }).nullable(),
  /**
   * Non-null when the provider's `providers.startLogin` child accepts a pasted authorization code on stdin (e.g.
   */
  codePaste: z.object({}).nullable().catch(null),
  /**
   * Non-null when this provider must be signed in from a real terminal rather than the headless `providers.startLogin` child - the host opens a host-owned PTY over `providers.startTerminalLogin` and delivers the provider's.
   * No CLI or SDK exposes that code natively, so Traycer never parses it out - the user reads it from the terminal Traycer opened.
   */
  terminalLogin: z.object({}).nullable().catch(null),
});
export type ProviderLoginCapability = z.infer<
  typeof providerLoginCapabilitySchema
>;

/**
 * Frozen pre-code-paste snapshot of `providerLoginCapabilitySchema`, as it shipped in host-v1.0.0 (`oauthArgs` + `token` only) - a hand-copy, NOT derived via `.omit()` from the live schema, same invariant as.
 */
export const providerLoginCapabilitySchemaV10 = z.object({
  oauthArgs: z.array(z.string()).nullable(),
  token: z.object({ vars: z.array(z.string()) }).nullable(),
});
export type ProviderLoginCapabilityV10 = z.infer<
  typeof providerLoginCapabilitySchemaV10
>;

/**
 * Frozen post-code-paste snapshot of `providerLoginCapabilitySchema`, as it shipped on the v4.0 line (host-v1.1.7): `oauthArgs` + `token` + `codePaste`.
 * `terminalLogin` is the concrete case this guards against: it is a v7.0 field, and a v6.0 client that negotiated before it existed must not decode it.
 */
export const providerLoginCapabilitySchemaV40 = z.object({
  oauthArgs: z.array(z.string()).nullable(),
  token: z.object({ vars: z.array(z.string()) }).nullable(),
  codePaste: z.object({}).nullable().catch(null),
});
export type ProviderLoginCapabilityV40 = z.infer<
  typeof providerLoginCapabilitySchemaV40
>;

/**
 * Frozen `providers.list@7.0` snapshot of `providerLoginCapabilitySchema`: `oauthArgs` + `token` + `codePaste` + `terminalLogin`.
 * The V40 snapshot exists because the base shape it backs kept pointing at the LIVE capability while its own keys were pinned, so `terminalLogin` reached four already-frozen shapes.
 */
export const providerLoginCapabilitySchemaV70 = z.object({
  oauthArgs: z.array(z.string()).nullable(),
  token: z.object({ vars: z.array(z.string()) }).nullable(),
  codePaste: z.object({}).nullable().catch(null),
  terminalLogin: z.object({}).nullable().catch(null),
});
export type ProviderLoginCapabilityV70 = z.infer<
  typeof providerLoginCapabilitySchemaV70
>;

/**
 * A single logged-in profile (subscription) for a provider.
 * `ambient` is the read-only, host-adopted `~/.claude` / `~/.codex` login Traycer never writes to; `managed` is a Traycer-owned, isolated config dir under `~/.traycer/harness-accounts/<provider>/<profileId>/`.
 */
export const providerProfileKindSchema = z.enum(["ambient", "managed"]);
export type ProviderProfileKind = z.infer<typeof providerProfileKindSchema>;

/** Auth-mechanism discriminator. */
export const providerProfileAuthTypeSchema = z.enum(["oauth"]);
export type ProviderProfileAuthType = z.infer<
  typeof providerProfileAuthTypeSchema
>;

/** Live provider identity resolved for display. */
export const providerProfileIdentitySchema = z.object({
  email: z.string().nullable(),
  tier: z.string().nullable(),
  accountUuid: z.string().nullable(),
});
export type ProviderProfileIdentity = z.infer<
  typeof providerProfileIdentitySchema
>;

/**
 * Derived from the same rate-limit gauge cache `usageUpdatedAt` reads from (`rate-limit-gauge-cache.ts`'s `readProfileRateLimitStatus`) - a pure, already-captured snapshot, never a fresh probe.
 * `"unknown"` means no gauge has been captured for this profile yet (never ran a turn, no active probe).
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

// One near/at-limit rate-limit window on a profile, annotated with the model family it gates.
export const providerProfileRateLimitScopeSchema = z.object({
  family: z.string().nullable(),
  severity: z.enum(["near_limit", "hard_limit"]),
});
export type ProviderProfileRateLimitScope = z.infer<
  typeof providerProfileRateLimitScopeSchema
>;

// Frozen `providers.list@7.0` profile row. Keep new profile fields off this
// shape; v8.0 is the first line that can represent eligibility.
const providerProfileShapeV70 = {
  profileId: z.string(),
  kind: providerProfileKindSchema,
  authType: providerProfileAuthTypeSchema,
  label: z.string(),
  auth: PROVIDER_AUTH_SCHEMA_V20,
  // Null until a login probe resolves it (e.g. a freshly created, not-yet-
  // authenticated profile).
  identity: providerProfileIdentitySchema.nullable(),
  // Epoch-ms the last passive (live-turn) or active (on-demand probe) usage read landed for this profile; null before any read.
  usageUpdatedAt: z.number().nullable(),
  // `.catch("unknown")` tolerates old host builds that predate this field.
  rateLimitStatus: providerProfileRateLimitStatusSchema.catch("unknown"),
  // The windows behind `rateLimitStatus`, per model family (see the scope schema above), so the composer can scope its switch prompt to the selected model instead of warning profile-wide.
  rateLimitLimitedScopes: z
    .array(providerProfileRateLimitScopeSchema)
    .nullable()
    .catch(null),
  // Set when this profile's resolved identity (accountUuid, or email fallback) matches another active profile of the same provider (including ambient) - the id of that other profile.
  // Duplicates are warned, never blocked (see the decision log's "Identity key" row); the GUI renders "same account as <label>".
  duplicateOfProfileId: z.string().nullable().catch(null),
  // Only ever non-null on the ambient profile entry.
  ambientDriftNotice: z
    .object({
      previousEmail: z.string().nullable(),
      changedAt: z.number(),
    })
    .nullable()
    .catch(null),
  // Deterministic per-profile accent color (hex), assigned by the host from a fixed palette and optionally overridden by the user.
  accentColor: providerProfileAccentColorSchema.nullable().catch(null),
  // Present when this active profile's accountUuid matches a removed profile.
  reusedTombstone: z
    .object({
      label: z.string(),
      // Same forward-compat guard as the profile-level `accentColor` above: a single out-of-palette color here must degrade to null, not throw - otherwise the array-level `.catch([])` on `profiles` below would wipe every.
      accentColor: providerProfileAccentColorSchema.nullable().catch(null),
    })
    .nullable()
    .optional(),
} as const;

export const providerProfileSchemaV70 = z.object(providerProfileShapeV70);

export const providerProfileSchema = z.object({
  ...providerProfileShapeV70,
  // Host-wide eligibility. Old supporting decoders treat an omitted legacy
  // field as enabled; older protocol lines omit disabled rows entirely.
  enabled: z.boolean().default(true).catch(true),
  // Copyable command for opening this managed account directly in its CLI.
  launchCommand: z
    .object({
      command: z.string(),
      shell: z.enum(["posix", "powershell"]),
    })
    .nullable()
    .catch(null)
    .optional(),
});
export type ProviderProfile = z.infer<typeof providerProfileSchema>;

export function isProfileEnabled(profile: {
  readonly enabled?: boolean;
}): boolean {
  return profile.enabled !== false;
}

export const providersSetProfileEnabledRequestSchema = z.object({
  providerId: providerIdSchema,
  profileId: z.string(),
  enabled: z.boolean(),
});
export type ProvidersSetProfileEnabledRequest = z.infer<
  typeof providersSetProfileEnabledRequestSchema
>;

export const providersSetProfileEnabledResponseSchema = z.object({
  profileId: z.string(),
  enabled: z.boolean(),
});
export type ProvidersSetProfileEnabledResponse = z.infer<
  typeof providersSetProfileEnabledResponseSchema
>;

/**
 * Fold-in for profile rename/remove/recolor/acknowledgeAmbientDrift, carried on `providers.setEnabled`'s request (see that method's `@2.1` contract in `registry.ts` for why these live here instead of standalone.
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

/**
 * Enablement is a plain STICKY BOOLEAN on every wire: `enabled` below is the whole story, and the only thing that changes it is the user's toggle (`providers.setEnabled`).
 * The host still probes passively, but only to SEED a boolean once and to answer "is this account signed out" (`authStatus` on the GUI harness row) - never to re-derive `enabled`.
 */

const providerCliStateBaseShape = {
  enabled: z.boolean(),
  disabledBy: providerDisabledBySchema.nullable(),
  selected: providerSelectionSchema,
  candidates: z.array(providerCliCandidateSchema),
  authPending: z.boolean(),
  checkedAt: z.number().nullable(),
  apiKey: providerApiKeyStateSchema,
  // Extra CLI arguments the user wants appended when launching this provider as a terminal agent (the host tokenizes and appends them to the spawned argv).
  terminalAgentArgs: z.string().catch(""),
  // Per-provider environment overrides applied when the host spawns this
  // provider's harness. Sorted by key for stable rendering; `[]` when unset.
  envOverrides: z.array(providerEnvOverrideSchema).catch([]),
  // Login/re-auth options for this provider.
  loginCapability: providerLoginCapabilitySchema.nullable().catch(null),
  // True while the host's shell-env probe for this provider is still running in the background (e.g.
  // A pending row always carries `available: false` semantically (don't trust candidates/auth yet).
  availabilityPending: z.boolean().catch(false),
  // Per-profile rows for this provider: the ambient login plus any Traycer-managed subscriptions.
  // `[]` for providers that don't support the multi-profile capability (gated per-adapter, see the decision log's rollout row).
  profiles: z.array(providerProfileSchema).catch([]),
  // Install lifecycle of this provider's managed (registry-backed) binary pack - see `providerManagedInstallStateSchema`.
  // Total decoder: every input either parses, defaults to null, or is simply absent - never a hard failure.
  managedInstallState: providerManagedInstallStateSchema
    .nullable()
    .catch(null)
    .optional(),
  // Aggregated, direction-free "other sessions differ" signal - see `providerVersionVisibilitySchema`.
  versionVisibility: providerVersionVisibilitySchema
    .nullable()
    .catch(null)
    .optional(),
  // Phase-2 (live update lane) advisory - see `providerAdvisorySchema`.
  advisory: providerAdvisorySchema.nullable().catch(null).optional(),
  cliBinaryResolved: z.boolean().catch(true).optional(),
  // ── v7.0 fields ──────────────────────────────────────────────────────── These three ride `providers.list@7.0` and up.
  // v7.0 and v7.1 no longer bind this shape: their hand-frozen pins sit below.
  packId: z.string().nullable().catch(null).optional(),
  // The per-pack version manager - see `providerManagedVersionsSchema`.
  managedVersions: providerManagedVersionsSchema
    .nullable()
    .catch(null)
    .optional(),
  // Why `managedVersions` is null, when the reason is worth showing.
  managedVersionsUnavailable: providerManagedVersionsUnavailableSchema
    .nullable()
    .catch(null)
    .optional(),
  // What the next execute would resolve to - see `providerNextRunBinarySchema`.
  nextRunBinary: providerNextRunBinarySchema.nullable().catch(null).optional(),
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
  loginCapability: providerLoginCapabilitySchemaV10.nullable().catch(null),
};

// Frozen protocol-v2.0 base shape (before `profiles`) - a hand-copy of `providerCliStateBaseShape` as it stood before profiles[] was added, NOT derived via `.extend()`/`.omit()` from the live shape.
// Do not add `profiles` (or any future field) here - extend the live `providerCliStateBaseShape` instead and let the v3 bridge decide whether it needs stripping too.
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
  loginCapability: providerLoginCapabilitySchemaV10.nullable().catch(null),
  availabilityPending: z.boolean().catch(false),
};

/** Latest provider CLI state (providers.list@3.1 and state-returning providers.*@2.1). */
export const providerCliStateSchema = z.object({
  providerId: providerIdSchema,
  ...providerCliStateBaseShape,
  auth: PROVIDER_AUTH_SCHEMA_V20,
  nativeCapabilities: providerNativeCapabilitiesSchema.catch(
    DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
  ),
});
export type ProviderCliState = z.infer<typeof providerCliStateSchema>;

/**
 * Canonical (live) `providers.list` request.
 * It is not a contract pin - the contract binds this schema - but it is a real freeze rather than a fixture.
 */
export const providersListRequestSchema = z.object({
  forceAuthRefresh: z.boolean().optional(),
  native: nativeListQuerySchema.nullable().default(null),
});
export type ProvidersListRequest = z.infer<typeof providersListRequestSchema>;

/**
 * Frozen request shape for every released `providers.list` line before v7.0 (v1.0 through v6.0 all shipped exactly this).
 * Hand-pinned rather than derived from the live schema via `.omit()` so a future request field cannot leak into a shipped line the way `native` did.
 */
export const providersListRequestSchemaBeforeV70 = z.object({
  forceAuthRefresh: z.boolean().optional(),
});
export type ProvidersListRequestBeforeV70 = z.infer<
  typeof providersListRequestSchemaBeforeV70
>;

/**
 * Frozen `providers.list@7.0` request: the pre-v7.0 shape plus `native`, which is the only field this line added.
 */
export const providersListRequestSchemaV70 = z.object({
  forceAuthRefresh: z.boolean().optional(),
  native: nativeListQuerySchema.nullable().default(null),
});
export type ProvidersListRequestV70 = z.infer<
  typeof providersListRequestSchemaV70
>;

/**
 * Canonical (live) `providers.list` response.
 * v1.0 through v7.0 each have a hand-frozen response. v8.0 binds this live schema, so new fields do not widen a released line.
 */
export const providersListResponseSchema = z.object({
  providers: z.array(providerCliStateSchema),
  native: nativeListResultSchema.nullable().default(null),
});
export type ProvidersListResponse = z.infer<typeof providersListResponseSchema>;

// ── Frozen protocol-v2.0 provider state + list response (before Amp) ─────── `providers.list` always returns every provider; v2.0 shipped without Amp, so it is frozen here as actually shipped.
// Do not add new providers here - use the existing v3 bridge.
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

/**
 * Tag-exact host-v1.1.5 shape for state-returning mutation @2.0 responses.
 * Distinct from list@2.0's pre-amp freeze.
 */
export const providerMutationCliStateSchemaV20 = z.object({
  providerId: providerIdSchema,
  ...providerCliStateBaseShapeV20,
  auth: PROVIDER_AUTH_SCHEMA_V20,
});
export type ProviderMutationCliStateV20 = z.infer<
  typeof providerMutationCliStateSchemaV20
>;

// ── Frozen protocol-v3.0 provider state + list response (with Amp, before ── Devin/Pi).
// Do not add new providers or fields here - use the existing version bridges.
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
  loginCapability: providerLoginCapabilitySchemaV10.nullable().catch(null),
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

// ── Frozen protocol-v4.0 provider state + list response (with Devin/Pi, ──── before Hermes/omp).
// Do not add new providers or fields here - use the existing v5 bridge.
const providerCliStateBaseShapeV40 = {
  enabled: z.boolean(),
  disabledBy: providerDisabledBySchema.nullable(),
  selected: providerSelectionSchema,
  candidates: z.array(providerCliCandidateSchema),
  authPending: z.boolean(),
  checkedAt: z.number().nullable(),
  apiKey: providerApiKeyStateSchema,
  terminalAgentArgs: z.string().catch(""),
  envOverrides: z.array(providerEnvOverrideSchema).catch([]),
  loginCapability: providerLoginCapabilitySchemaV40.nullable().catch(null),
  availabilityPending: z.boolean().catch(false),
  profiles: z.array(providerProfileSchemaV70).catch([]),
};

export const providerCliStateSchemaV40 = z.object({
  providerId: providerIdSchemaV40,
  ...providerCliStateBaseShapeV40,
  auth: PROVIDER_AUTH_SCHEMA_V20,
});
export type ProviderCliStateV40 = z.infer<typeof providerCliStateSchemaV40>;
export const providersListResponseSchemaV40 = z.object({
  providers: z.array(providerCliStateSchemaV40),
});

/**
 * Frozen `providers.list` response as shipped in protocol v5.0.
 * Pinning only the enum is not enough: this schema originally spread the LIVE base shape, whose comment ("so a future `.extend()` cannot silently leak back") described the intent but not the effect.
 */
export const providerCliStateSchemaV50 = z.object({
  providerId: providerIdSchemaV50,
  ...providerCliStateBaseShapeV40,
  auth: PROVIDER_AUTH_SCHEMA_V20,
});
export type ProviderCliStateV50 = z.infer<typeof providerCliStateSchemaV50>;

export const providersListResponseSchemaV50 = z.object({
  providers: z.array(providerCliStateSchemaV50),
});

/** Frozen `providers.list` response as shipped in protocol v6.0. */
export const providerCliStateSchemaV60 = z.object({
  providerId: providerIdSchemaV60,
  ...providerCliStateBaseShapeV40,
  auth: PROVIDER_AUTH_SCHEMA_V20,
});
export type ProviderCliStateV60 = z.infer<typeof providerCliStateSchemaV60>;

export const providersListResponseSchemaV60 = z.object({
  providers: z.array(providerCliStateSchemaV60),
});
export type ProvidersListResponseV60 = z.infer<
  typeof providersListResponseSchemaV60
>;
export type ProvidersListResponseV40 = z.infer<
  typeof providersListResponseSchemaV40
>;

// ── Historical v7.0 pre-image ───────────────────────────────────────────── This shape backs no wire contract.
const providerCliStateBaseShapeV70Preimage = {
  enabled: z.boolean(),
  disabledBy: providerDisabledBySchema.nullable(),
  selected: providerSelectionSchema,
  candidates: z.array(providerCliCandidateSchema),
  authPending: z.boolean(),
  checkedAt: z.number().nullable(),
  apiKey: providerApiKeyStateSchema,
  terminalAgentArgs: z.string().catch(""),
  envOverrides: z.array(providerEnvOverrideSchema).catch([]),
  loginCapability: providerLoginCapabilitySchemaV70.nullable().catch(null),
  availabilityPending: z.boolean().catch(false),
  profiles: z.array(providerProfileSchemaV70).catch([]),
  managedInstallState: providerManagedInstallStateSchemaV70Preimage
    .nullable()
    .catch(null)
    .optional(),
  versionVisibility: providerVersionVisibilitySchema
    .nullable()
    .catch(null)
    .optional(),
  advisory: providerAdvisorySchema.nullable().catch(null).optional(),
  cliBinaryResolved: z.boolean().catch(true).optional(),
};

export const providerCliStateSchemaV70Preimage = z.object({
  providerId: providerIdSchemaV70,
  ...providerCliStateBaseShapeV70Preimage,
  auth: PROVIDER_AUTH_SCHEMA_V20,
  // Hand-frozen since the live descriptor grew `modelProviders` (and its `supportedTabs` member) past this line - the "hand-freeze the sub-schema that grew" step the deep snapshot demands.
  // The `.catch()` keeps the pre-image default so this shape decodes byte-for-byte the way it did at the freeze cut.
  nativeCapabilities: providerNativeCapabilitiesSchemaV70Preimage.catch(
    DEFAULT_PROVIDER_NATIVE_CAPABILITIES_V70_PREIMAGE,
  ),
});
export type ProviderCliStateV70Preimage = z.infer<
  typeof providerCliStateSchemaV70Preimage
>;

export const providersListResponseSchemaV70Preimage = z.object({
  providers: z.array(providerCliStateSchemaV70Preimage),
  native: nativeListResultSchemaV70Preimage.nullable().default(null),
});
export type ProvidersListResponseV70Preimage = z.infer<
  typeof providersListResponseSchemaV70Preimage
>;

// `providers.list@7.0` freeze under `V70` names, beside (not replacing) `*V70Preimage`. Do not widen v7.0 in place; do not regenerate frozen-catalog-lines to green.
const providerCliStateBaseShapeV70 = {
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
  profiles: z.array(providerProfileSchemaV70).catch([]),
  // `.optional()` on top of `.catch(null)` is copied deliberately, not tidied
  // away - see the live shape's comments for what each half does.
  managedInstallState: providerManagedInstallStateSchema
    .nullable()
    .catch(null)
    .optional(),
  versionVisibility: providerVersionVisibilitySchema
    .nullable()
    .catch(null)
    .optional(),
  advisory: providerAdvisorySchema.nullable().catch(null).optional(),
  cliBinaryResolved: z.boolean().catch(true).optional(),
  packId: z.string().nullable().catch(null).optional(),
  // The ONE leaf this shape does not keep live - see `providerManagedVersionsSchemaV70`.
  managedVersions: providerManagedVersionsSchemaV70
    .nullable()
    .catch(null)
    .optional(),
  managedVersionsUnavailable: providerManagedVersionsUnavailableSchema
    .nullable()
    .catch(null)
    .optional(),
  nextRunBinary: providerNextRunBinarySchema.nullable().catch(null).optional(),
};

export const providerCliStateSchemaV70 = z.object({
  providerId: providerIdSchemaV70,
  ...providerCliStateBaseShapeV70,
  auth: PROVIDER_AUTH_SCHEMA_V20,
  nativeCapabilities: providerNativeCapabilitiesSchema.catch(
    DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
  ),
});
export type ProviderCliStateV70 = z.infer<typeof providerCliStateSchemaV70>;

export const providersListResponseSchemaV70 = z.object({
  providers: z.array(providerCliStateSchemaV70),
  native: nativeListResultSchema.nullable().default(null),
});
export type ProvidersListResponseV70 = z.infer<
  typeof providersListResponseSchemaV70
>;

// THERE IS NO `providers.list@7.1`.

// Frozen protocol-v1.0 provider state + list response.
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

export {
  DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
  DEFAULT_PROVIDER_NATIVE_CAPABILITIES_V70_PREIMAGE,
  providerNativeCapabilitiesSchemaV70Preimage,
  type ProviderNativeCapabilities,
  type ProviderNativeCapabilitiesV70Preimage,
};

// ── Frozen major-2.1 mutation-response provider state (pre-registry) ─────── The same freeze discipline as `providerMutationCliStateSchemaV20` above, one minor later - and applied for the same reason it was needed there.
// Both are frozen, so neither can drift into the other.
export const providerMutationCliStateSchemaV21 = z.object({
  providerId: providerIdSchema,
  ...providerCliStateBaseShapeV40,
  auth: PROVIDER_AUTH_SCHEMA_V20,
});
export type ProviderMutationCliStateV21 = z.infer<
  typeof providerMutationCliStateSchemaV21
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
  state: providerMutationCliStateSchemaV21,
});
export const providersSetSelectionResponseSchemaV20 = z.object({
  state: providerMutationCliStateSchemaV20,
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
  state: providerMutationCliStateSchemaV21,
});
export const providersAddCustomPathResponseSchemaV20 = z.object({
  state: providerMutationCliStateSchemaV20,
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
  state: providerMutationCliStateSchemaV21,
});
export const providersRemoveCustomPathResponseSchemaV20 = z.object({
  state: providerMutationCliStateSchemaV20,
});
export const providersRemoveCustomPathResponseSchemaV10 = z.object({
  state: providerCliStateSchemaV10,
});
export type ProvidersRemoveCustomPathResponse = z.infer<
  typeof providersRemoveCustomPathResponseSchema
>;

/**
 * Frozen `providers.setEnabled@2.0` request (classic enable/disable only).
 */
export const providersSetEnabledRequestSchemaV20 = z.object({
  providerId: providerIdSchema,
  enabled: z.boolean(),
});
export type ProvidersSetEnabledRequestV20 = z.infer<
  typeof providersSetEnabledRequestSchemaV20
>;

/**
 * `providers.setEnabled@2.1` request (classic enable/disable).
 * Native mutations therefore do NOT fold onto this carrier; they ride the dedicated optional `providers.nativeMutate@1.0` method instead (see `registry.ts`).
 */
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

/**
 * `providers.setEnabled@2.1` response.
 * Returns classic `state` only - 2.1 is released and its response shape is frozen.
 */
export const providersSetEnabledResponseSchema = z.object({
  state: providerMutationCliStateSchemaV21,
});
export const providersSetEnabledResponseSchemaV20 = z.object({
  state: providerMutationCliStateSchemaV20,
});
export const providersSetEnabledResponseSchemaV10 = z.object({
  state: providerCliStateSchemaV10,
});
export type ProvidersSetEnabledResponse = z.infer<
  typeof providersSetEnabledResponseSchema
>;

/**
 * `providers.setEnabled@2.1` request - folds profile rename/remove/recolor onto this existing method rather than new `providers.renameProfile` / `removeProfile` / `recolorProfile` methods (see that contract in.
 */
export const providersSetEnabledRequestSchemaV21 =
  providersSetEnabledRequestSchema.extend({
    profileAction: providerProfileActionSchema.nullable().default(null),
  });
export type ProvidersSetEnabledRequestV21 = z.infer<
  typeof providersSetEnabledRequestSchemaV21
>;

// THERE IS NO `providers.setEnabled@2.2`.

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
  state: providerMutationCliStateSchemaV21,
});
export const providersSetApiKeyResponseSchemaV20 = z.object({
  state: providerMutationCliStateSchemaV20,
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
  state: providerMutationCliStateSchemaV21,
});
export const providersClearApiKeyResponseSchemaV20 = z.object({
  state: providerMutationCliStateSchemaV20,
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
  state: providerMutationCliStateSchemaV21,
});
export const providersSetTerminalAgentArgsResponseSchemaV20 = z.object({
  state: providerMutationCliStateSchemaV20,
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
  state: providerMutationCliStateSchemaV21,
});
export const providersSetEnvOverrideResponseSchemaV20 = z.object({
  state: providerMutationCliStateSchemaV20,
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
  state: providerMutationCliStateSchemaV21,
});
export const providersDeleteEnvOverrideResponseSchemaV20 = z.object({
  state: providerMutationCliStateSchemaV20,
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
 * Frozen `providers.startLogin@1.0` request/response (classic provider OAuth).
 */
export const providersStartLoginRequestSchemaV10 = z.object({
  providerId: providerIdSchema,
});
export type ProvidersStartLoginRequestV10 = z.infer<
  typeof providersStartLoginRequestSchemaV10
>;

export const providersStartLoginResponseSchemaV10 = z.object({
  url: z.string().nullable(),
  started: z.boolean(),
});
export type ProvidersStartLoginResponseV10 = z.infer<
  typeof providersStartLoginResponseSchemaV10
>;

/** `providers.startLogin@1.1` request (classic provider login only). */
export const providersStartLoginRequestSchema = z.object({
  providerId: providerIdSchema,
});
export type ProvidersStartLoginRequest = z.infer<
  typeof providersStartLoginRequestSchema
>;

/**
 * `providers.startLogin@1.1` response (classic provider login only).
 */
export const providersStartLoginResponseSchema = z.object({
  url: z.string().nullable(),
  started: z.boolean(),
});
export type ProvidersStartLoginResponse = z.infer<
  typeof providersStartLoginResponseSchema
>;

/**
 * Frozen `providers.awaitLogin@2.0` request (classic provider-child await).
 */
export const providersAwaitLoginRequestSchemaV20 = z.object({
  providerId: providerIdSchema,
});
export type ProvidersAwaitLoginRequestV20 = z.infer<
  typeof providersAwaitLoginRequestSchemaV20
>;

/**
 * `providers.startLogin@1.1` request - adds `profileId` (re-authenticate an existing managed profile's isolated config dir) and `createProfile` (mint a brand-new profile - create its dir, seed it from the ambient.
 */
export const providersStartLoginRequestSchemaV11 =
  providersStartLoginRequestSchema.extend({
    profileId: z.string().nullable().default(null),
    createProfile: z
      .object({
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
 * `providers.startLogin@1.1` response - echoes the profile this login targeted, so a `createProfile` caller learns the host-minted id without a separate round-trip.
 */
export const providersStartLoginResponseSchemaV11 =
  providersStartLoginResponseSchema.extend({
    profileId: z.string().nullable().default(null),
  });
export type ProvidersStartLoginResponseV11 = z.infer<
  typeof providersStartLoginResponseSchemaV11
>;

/** `providers.awaitLogin@2.1` request. */
// `profileId` mirrors `providers.startLogin@1.1`'s request field so the caller awaits the same profile-scoped login child it started.
// Ships with `providers.awaitLogin@2.1` (originally landed as a bare additive/defaulted field on the released 2.0 line; the 2.0 shapes are frozen without it below and the 2.0→2.1 upgrade fills `null`).
export const providersAwaitLoginRequestSchema = z.object({
  providerId: providerIdSchema,
  profileId: z.string().nullable().default(null),
});
export const providersAwaitLoginRequestSchemaV10 = z.strictObject({
  providerId: providerIdSchemaV10,
});
export type ProvidersAwaitLoginRequest = z.infer<
  typeof providersAwaitLoginRequestSchema
>;

/**
 * `providers.awaitLogin@2.1` response. Returns the re-probed `state`.
 */
export const providersAwaitLoginResponseSchema = z.object({
  // The provider's state after the login child closed and auth was re-probed.
  // Null when no login was in flight for this provider (nothing to await).
  state: providerMutationCliStateSchemaV21.nullable(),
  // `providers.awaitLogin@2.1` - Create-profile only: when the authenticated account already belongs to an active profile, the host discards the pending profile instead of activating a duplicate and identifies the existing.
  // Ships with `providers.awaitLogin@2.1`; the frozen 2.0 response below never carried it.
  existingProfileId: z.string().nullable().default(null),
  // `providers.startLogin@1.1` - Code-paste only: true when this call resolved because a previously submitted `providers.submitLoginCode` was rejected by the exchange (the login child exited nonzero without auth success on.
  // Bare additive field on the still-unreleased 2.1 line (same precedent as `providers.startLogin@1.1`'s `createProfile.shareSkillsAndPlugins`): old hosts never emit it and `.default(false)` keeps old-client parses.
  codeRejected: z.boolean().default(false),
});
export const providersAwaitLoginResponseSchemaV20 = z.object({
  state: providerMutationCliStateSchemaV20.nullable(),
});
export const providersAwaitLoginResponseSchemaV10 = z.object({
  state: providerCliStateSchemaV10.nullable(),
});
export type ProvidersAwaitLoginResponse = z.infer<
  typeof providersAwaitLoginResponseSchema
>;

/**
 * Client-side response-frame budget for `providers.awaitLogin`, which is a long-poll: the host's response is contractually silent until the OAuth login child terminates.
 * The host must keep its internal deadline strictly under this budget - clients wait exactly this long before declaring the call dead.
 */
export const PROVIDERS_AWAIT_LOGIN_RESPONSE_BUDGET_MS = 16 * 60_000;

/**
 * Frozen `providers.cancelLogin@1.0` request/response.
 */
export const providersCancelLoginRequestSchemaV10 = z.object({
  providerId: providerIdSchema,
});
export type ProvidersCancelLoginRequestV10 = z.infer<
  typeof providersCancelLoginRequestSchemaV10
>;

export const providersCancelLoginResponseSchemaV10 = z.object({
  cancelled: z.boolean(),
});
export type ProvidersCancelLoginResponseV10 = z.infer<
  typeof providersCancelLoginResponseSchemaV10
>;

/**
 * `providers.cancelLogin@1.1` request (classic provider login only). MCP
 * cancel rides the dedicated optional `providers.cancelMcpAuth@1.0` method.
 */
export const providersCancelLoginRequestSchema = z.object({
  providerId: providerIdSchema,
});
export type ProvidersCancelLoginRequest = z.infer<
  typeof providersCancelLoginRequestSchema
>;

// `providers.cancelLogin@1.1` request - adds `profileId`, mirroring `providers.startLogin@1.1`, so the caller cancels the same profile-scoped login child it started.
export const providersCancelLoginRequestSchemaV11 =
  providersCancelLoginRequestSchema.extend({
    profileId: z.string().nullable().default(null),
  });
export type ProvidersCancelLoginRequestV11 = z.infer<
  typeof providersCancelLoginRequestSchemaV11
>;

/**
 * `providers.cancelLogin@1.1` response (classic provider login only).
 */
export const providersCancelLoginResponseSchema = z.object({
  cancelled: z.boolean(),
});
export type ProvidersCancelLoginResponse = z.infer<
  typeof providersCancelLoginResponseSchema
>;

// `providers.startLogin@1.1` - ── Dedicated native methods (optional capability channel) ─────────────────
// Folding grew already-released wire shapes, which the compat gate correctly rejects: a released line is frozen.

/** `providers.mcpAuth@1.0` request - the full MCP auth action set. */
export const providersMcpAuthRequestSchema = z.object({
  providerId: providerIdSchema,
  action: nativeAuthActionSchema,
});
export type ProvidersMcpAuthRequest = z.infer<
  typeof providersMcpAuthRequestSchema
>;

/** `providers.mcpAuth@1.0` response. */
export const providersMcpAuthResponseSchema = z.object({
  result: nativeAuthResultSchema,
});
export type ProvidersMcpAuthResponse = z.infer<
  typeof providersMcpAuthResponseSchema
>;

/**
 * `providers.awaitMcpAuth@1.0` request - a **bounded status poll** (well under the 30s unary frame deadline), never a long poll.
 */
export const providersAwaitMcpAuthRequestSchema = z.object({
  providerId: providerIdSchema,
  context: nativeAuthPollContextSchema,
});
export type ProvidersAwaitMcpAuthRequest = z.infer<
  typeof providersAwaitMcpAuthRequestSchema
>;

/** `providers.awaitMcpAuth@1.0` response. */
export const providersAwaitMcpAuthResponseSchema = z.object({
  result: nativeAuthResultSchema,
});
export type ProvidersAwaitMcpAuthResponse = z.infer<
  typeof providersAwaitMcpAuthResponseSchema
>;

/** `providers.cancelMcpAuth@1.0` request. */
export const providersCancelMcpAuthRequestSchema = z.object({
  providerId: providerIdSchema,
  context: nativeAuthCancelContextSchema,
});
export type ProvidersCancelMcpAuthRequest = z.infer<
  typeof providersCancelMcpAuthRequestSchema
>;

/** `providers.cancelMcpAuth@1.0` response. */
export const providersCancelMcpAuthResponseSchema = z.object({
  cancelled: z.boolean(),
  result: nativeAuthResultSchema,
});
export type ProvidersCancelMcpAuthResponse = z.infer<
  typeof providersCancelMcpAuthResponseSchema
>;

/** `providers.nativeMutate@1.0` request - MCP/plugins/skills mutations. */
export const providersNativeMutateRequestSchema = z.object({
  providerId: providerIdSchema,
  mutation: nativeMutationSchema,
});
export type ProvidersNativeMutateRequest = z.infer<
  typeof providersNativeMutateRequestSchema
>;

/** `providers.nativeMutate@1.0` response. */
export const providersNativeMutateResponseSchema = z.object({
  result: nativeMutationResultSchema,
});
export type ProvidersNativeMutateResponse = z.infer<
  typeof providersNativeMutateResponseSchema
>;

// ── Model providers (optional capability channel) ──────────────────────────
// Both of those are released shapes, and both bake the MCP model into their payloads - `nativeListQuerySchema` carries a scope tuple every arm must answer, `nativeAuthActionSchema` a `serverName`.

/** `providers.listModelProviders@1.0` request. */
export const providersListModelProvidersRequestSchema = z.object({
  providerId: providerIdSchema,
});
export type ProvidersListModelProvidersRequest = z.infer<
  typeof providersListModelProvidersRequestSchema
>;

/** `providers.listModelProviders@1.0` response. */
export const providersListModelProvidersResponseSchema = z.object({
  result: modelProvidersListResultSchema,
});
export type ProvidersListModelProvidersResponse = z.infer<
  typeof providersListModelProvidersResponseSchema
>;

/** `providers.modelProviderAuth@1.0` request - the full auth action set. */
export const providersModelProviderAuthRequestSchema = z.object({
  providerId: providerIdSchema,
  action: modelProviderAuthActionSchema,
});
export type ProvidersModelProviderAuthRequest = z.infer<
  typeof providersModelProviderAuthRequestSchema
>;

/** `providers.modelProviderAuth@1.0` response. */
export const providersModelProviderAuthResponseSchema = z.object({
  result: modelProviderAuthResultSchema,
});
export type ProvidersModelProviderAuthResponse = z.infer<
  typeof providersModelProviderAuthResponseSchema
>;

/**
 * `providers.awaitModelProviderAuth@1.0` request - a **bounded status poll** (well under the 30s unary frame deadline), never a long poll.
 */
export const providersAwaitModelProviderAuthRequestSchema = z.object({
  providerId: providerIdSchema,
  context: modelProviderAuthPollContextSchema,
});
export type ProvidersAwaitModelProviderAuthRequest = z.infer<
  typeof providersAwaitModelProviderAuthRequestSchema
>;

/** `providers.awaitModelProviderAuth@1.0` response. */
export const providersAwaitModelProviderAuthResponseSchema = z.object({
  result: modelProviderAuthResultSchema,
});
export type ProvidersAwaitModelProviderAuthResponse = z.infer<
  typeof providersAwaitModelProviderAuthResponseSchema
>;

/** `providers.cancelModelProviderAuth@1.0` request. */
export const providersCancelModelProviderAuthRequestSchema = z.object({
  providerId: providerIdSchema,
  context: modelProviderAuthCancelContextSchema,
});
export type ProvidersCancelModelProviderAuthRequest = z.infer<
  typeof providersCancelModelProviderAuthRequestSchema
>;

/**
 * `providers.cancelModelProviderAuth@1.0` response.
 * It never claims to have revoked anything on the provider's side.
 */
export const providersCancelModelProviderAuthResponseSchema = z.object({
  cancelled: z.boolean(),
  result: modelProviderAuthResultSchema,
});
export type ProvidersCancelModelProviderAuthResponse = z.infer<
  typeof providersCancelModelProviderAuthResponseSchema
>;

export type {
  ModelProviderAuthAction,
  ModelProviderAuthCancelContext,
  ModelProviderAuthPollContext,
  ModelProviderAuthResult,
  ModelProvidersListResult,
  NativeAuthAction,
  NativeAuthCancelContext,
  NativeAuthPollContext,
  NativeAuthResult,
  NativeListQuery,
  NativeListResult,
  NativeMutation,
  NativeMutationResult,
};

/**
 * `providers.startLogin@1.1` - Relay a pasted authorization code to an in-flight `providers.startLogin` child's stdin (see the code-paste decision log's "Mechanism" row).
 */
export const providersSubmitLoginCodeRequestSchema = z.object({
  providerId: providerIdSchema,
  profileId: z.string().nullable().default(null),
  code: z.string(),
});
export type ProvidersSubmitLoginCodeRequest = z.infer<
  typeof providersSubmitLoginCodeRequestSchema
>;

export const providersSubmitLoginCodeResponseSchema = z.object({
  outcome: z.enum(["accepted", "noActiveLogin"]),
});
export type ProvidersSubmitLoginCodeResponse = z.infer<
  typeof providersSubmitLoginCodeResponseSchema
>;

export const providersTouchLoginRequestSchema = z.object({
  providerId: providerIdSchema,
  profileId: z.string().nullable(),
});
export type ProvidersTouchLoginRequest = z.infer<
  typeof providersTouchLoginRequestSchema
>;

export const providersTouchLoginResponseSchema = z.object({
  extended: z.boolean(),
});
export type ProvidersTouchLoginResponse = z.infer<
  typeof providersTouchLoginResponseSchema
>;

/**
 * `terminal.create@2.0` - Start (or restart) a host-owned terminal running this provider's login command, for providers whose capability declares `terminalLogin`.
 * Never edit this shape in place; the registry's v1.0 line binds it.
 */
export const providersStartTerminalLoginRequestSchema = z.object({
  providerId: providerIdSchema,
  epicId: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export type ProvidersStartTerminalLoginRequest = z.infer<
  typeof providersStartTerminalLoginRequestSchema
>;

/** Canonical `@2.0` request. */
export const providersStartTerminalLoginRequestSchemaV20 = z.object({
  providerId: providerIdSchema,
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("epic"), epicId: z.string().min(1) }),
    z.object({ kind: z.literal("independent") }),
  ]),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export type ProvidersStartTerminalLoginRequestV20 = z.infer<
  typeof providersStartTerminalLoginRequestSchemaV20
>;

/**
 * `sessionId` is the freshly created session - the client opens it as a tile and ATTACHES; it must never `terminal.create` that id itself.
 */
export const providersStartTerminalLoginResponseSchema = z.object({
  sessionId: z.string().min(1),
  replacedSessionId: z.string().nullable(),
});
export type ProvidersStartTerminalLoginResponse = z.infer<
  typeof providersStartTerminalLoginResponseSchema
>;

/** User-initiated "get this provider's managed pack ready". */
export const providersEnsurePackRequestSchema = z.object({
  providerId: providerIdSchema,
});
export type ProvidersEnsurePackRequest = z.infer<
  typeof providersEnsurePackRequestSchema
>;

/**
 * The pack's state as of the kick, in the same vocabulary `providers.list` carries.
 * That is how a retry affordance stays offered forever for a click that cannot work.
 */
export const providersEnsurePackResponseSchema = z.object({
  managedInstallState: providerManagedInstallStateSchema.nullable(),
});
export type ProvidersEnsurePackResponse = z.infer<
  typeof providersEnsurePackResponseSchema
>;

// `providers.ensurePack@1.0` - ── v7.0: the four per-pack version-manager methods ────────────────────────
// That split is deliberate and is not a style choice: a rename cannot be a version bump.

/**
 * User-requested download of one specific version, installed into the versioned store WITHOUT flipping `current` (the manager's download/flip split exists for this call).
 * Non-blocking, like `providers.ensurePack`: returns the version's state as of the kick and never awaits the transfer.
 */
export const providersInstallPackVersionRequestSchema = z.object({
  packId: z.string().min(1),
  version: z.string().min(1),
});
export type ProvidersInstallPackVersionRequest = z.infer<
  typeof providersInstallPackVersionRequestSchema
>;

export const providersInstallPackVersionResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    installState: providerPackVersionInstallStateSchema,
  }),
  z.object({
    ok: z.literal(false),
    // ONE MEMBER PER PRODUCER OUTCOME, deliberately.
    // Likewise `condemned` is not a spelling of any of these: it means the bytes were digest-verified and only then found defective ON THIS MACHINE, so it is terminal and must draw no retry affordance.
    code: z.enum([
      "condemned",
      "unfetchable",
      "invalid-version",
      "below-security-floor",
      "host-ineligible",
      "yanked",
    ]),
    detail: z.string().nullable(),
  }),
]);
export type ProvidersInstallPackVersionResult = z.infer<
  typeof providersInstallPackVersionResultSchema
>;

export const providersInstallPackVersionResponseSchema = z.object({
  result: providersInstallPackVersionResultSchema,
});
export type ProvidersInstallPackVersionResponse = z.infer<
  typeof providersInstallPackVersionResponseSchema
>;

/** Delete one installed version's bytes. */
export const providersRemovePackVersionRequestSchema = z.object({
  packId: z.string().min(1),
  version: z.string().min(1),
});
export type ProvidersRemovePackVersionRequest = z.infer<
  typeof providersRemovePackVersionRequestSchema
>;

export const providersRemovePackVersionResultSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    code: z.enum([
      "is-current",
      "holder-reserved",
      "quarantine-reserved",
      "deferred-locked",
    ]),
    detail: z.string().nullable(),
  }),
]);
export type ProvidersRemovePackVersionResult = z.infer<
  typeof providersRemovePackVersionResultSchema
>;

export const providersRemovePackVersionResponseSchema = z.object({
  result: providersRemovePackVersionResultSchema,
});
export type ProvidersRemovePackVersionResponse = z.infer<
  typeof providersRemovePackVersionResponseSchema
>;

/**
 * Pin this pack to a version, or clear the pin.
 * `version: null` is the clear ("use latest automatically"), which is why it is nullable rather than a separate method - the two are one user-facing control.
 */
export const providersUsePackVersionRequestSchema = z.object({
  packId: z.string().min(1),
  // Null clears the pin and returns the pack to auto.
  version: z.string().min(1).nullable(),
});
export type ProvidersUsePackVersionRequest = z.infer<
  typeof providersUsePackVersionRequestSchema
>;

export const providersUsePackVersionResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    // The pin as it now stands durably - null after a clear.
    pinnedVersion: z.string().nullable(),
  }),
  z.object({
    ok: z.literal(false),
    code: z.enum([
      "verification-failed",
      "below-security-floor",
      "host-ineligible",
    ]),
    detail: z.string().nullable(),
  }),
]);
export type ProvidersUsePackVersionResult = z.infer<
  typeof providersUsePackVersionResultSchema
>;

export const providersUsePackVersionResponseSchema = z.object({
  result: providersUsePackVersionResultSchema,
});
export type ProvidersUsePackVersionResponse = z.infer<
  typeof providersUsePackVersionResponseSchema
>;

/** Set the per-pack auto-download policy. */
export const providersSetPackPolicyRequestSchema = z.object({
  packId: z.string().min(1),
  autoDownload: z.boolean(),
});
export type ProvidersSetPackPolicyRequest = z.infer<
  typeof providersSetPackPolicyRequestSchema
>;

export const providersSetPackPolicyResponseSchema = z.object({
  // The policy as it now stands durably, echoed for the same reason
  // `usePackVersion` echoes the pin.
  autoDownload: z.boolean(),
});
export type ProvidersSetPackPolicyResponse = z.infer<
  typeof providersSetPackPolicyResponseSchema
>;

// ── On-demand pack discovery refresh ───────────────────────────────────────

/**
 * Run the pack-discovery poll for one pack now.
 * Keyed by `packId`, never by provider (D5): the head this polls belongs to the PACK, and one pack serves several providers, so a per-provider request would resolve to the same pack from several ids and poll one head.
 */
export const providersRefreshPackDiscoveryRequestSchema = z.object({
  // A managed pack id. An unknown one is a caller BUG, not a typed refusal
  // below - the host throws, exactly as the per-pack mutations do.
  packId: z.string().min(1),
});
export type ProvidersRefreshPackDiscoveryRequest = z.infer<
  typeof providersRefreshPackDiscoveryRequestSchema
>;

/**
 * What the poll did to this host's knowledge of the pack.
 * `unchanged` covers a 304, an identical revision, and a pack this host has never seen that the registry has not published yet.
 */
export const providerPackRefreshOutcomeSchema = z.enum([
  "moved",
  "unchanged",
  "unreachable",
  "unusable",
]);
export type ProviderPackRefreshOutcome = z.infer<
  typeof providerPackRefreshOutcomeSchema
>;

export const providersRefreshPackDiscoveryResultSchema = z.union([
  z.object({ ok: z.literal(true), outcome: providerPackRefreshOutcomeSchema }),
  z.object({
    ok: z.literal(false),
    // Two members, both typed rather than thrown because the panel has a specific sentence to put ON THE ROW for each - a thrown error only ever reaches a generic toast.
    // `detail` stays operator-facing and is never primary copy, same rule as every other typed error in this file.
    code: z.enum(["discovery-unavailable", "pack-disabled"]),
    detail: z.string().nullable(),
  }),
]);
export type ProvidersRefreshPackDiscoveryResult = z.infer<
  typeof providersRefreshPackDiscoveryResultSchema
>;

/** Response envelope, shaped like every sibling's in this group. */
export const providersRefreshPackDiscoveryResponseSchema = z.object({
  result: providersRefreshPackDiscoveryResultSchema,
});
export type ProvidersRefreshPackDiscoveryResponse = z.infer<
  typeof providersRefreshPackDiscoveryResponseSchema
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

// Accepts any latest-shaped state and downgrades it to the frozen v1.0 shape.
// A union of the real source shapes rather than a single `Omit<ProviderCliState>`: the frozen v2.0/v3.0/mutation-v2.0 states genuinely lack `nativeCapabilities` and the provider-pack-registry fields, so those are widened.
export type DowngradableToV10ProviderState = (
  | ProviderCliState
  | ProviderCliStateV70
  | ProviderCliStateV70Preimage
  | ProviderCliStateV60
  | ProviderCliStateV50
  | ProviderCliStateV40
  | ProviderCliStateV30
  | ProviderCliStateV20
  | ProviderMutationCliStateV20
  | ProviderMutationCliStateV21
) & {
  profiles?: ProviderCliState["profiles"] | ProviderCliStateV70["profiles"];
  // Widened to the pre-image capability shape as well as the live one for the same reason `loginCapability` below is widened across its own frozen snapshots: callers reach this function holding either shape, and the strict.
  nativeCapabilities?:
    | ProviderNativeCapabilities
    | ProviderNativeCapabilitiesV70Preimage;
  // Widened to the live OR the pre-image union once the version-manager work grew the live arms with `version`.
  managedInstallState?:
    | ProviderCliState["managedInstallState"]
    | ProviderManagedInstallStateV70Preimage
    | null;
  versionVisibility?: ProviderCliState["versionVisibility"];
  advisory?: ProviderCliState["advisory"];
  cliBinaryResolved?: ProviderCliState["cliBinaryResolved"];
  // v7.0 fields, present only when the source is a live-shaped row.
  packId?: ProviderCliState["packId"];
  managedVersions?: ProviderCliState["managedVersions"];
  managedVersionsUnavailable?: ProviderCliState["managedVersionsUnavailable"];
  nextRunBinary?: ProviderCliState["nextRunBinary"];
  loginCapability: ProviderLoginCapability | ProviderLoginCapabilityV10 | null;
};

export function downgradeProviderCliStateToV10(
  state: DowngradableToV10ProviderState,
): ProviderCliStateV10 | null {
  // `providerCliStateSchemaV10` is a `z.strictObject`, so it REJECTS any key it doesn't model.
  // Forgetting one does not fail loudly - it empties the provider list for v1.0 clients, silently, because the row fails the parse and the caller filters it out.
  const {
    availabilityPending: _availabilityPending,
    profiles: _profiles,
    nativeCapabilities: _nativeCapabilities,
    managedInstallState: _managedInstallState,
    versionVisibility: _versionVisibility,
    advisory: _advisory,
    cliBinaryResolved: _cliBinaryResolved,
    packId: _packId,
    managedVersions: _managedVersions,
    managedVersionsUnavailable: _managedVersionsUnavailable,
    nextRunBinary: _nextRunBinary,
    ...rest
  } = state;
  const parsed = providerCliStateSchemaV10.safeParse({
    ...rest,
    auth: downgradeProviderAuthV20ToV10(state.auth),
  });
  return parsed.success ? parsed.data : null;
}

// Downgrades a latest-shaped provider-state list to the frozen v2.0 shape, dropping Amp/Devin/Pi (or any post-v2.0 provider) and stripping `nativeCapabilities` so an already-shipped v2.0 client's decode never sees them.
export function downgradeProviderCliStateListToV20(
  states: readonly unknown[],
): ProviderCliStateV20[] {
  return states.flatMap((state) => {
    const parsed = providerCliStateSchemaV20.safeParse(state);
    return parsed.success ? [parsed.data] : [];
  });
}

// Downgrades a latest-shaped provider-state list to the frozen v3.0 shape, dropping Devin/Pi (or any future post-v3.0 provider) so an already-shipped v3.0 client's strict decode never sees it.
// The reparse also strips `profiles`/`nativeCapabilities` - the frozen v3.0 object doesn't model them - keeping profile identity (email, label) off the wire for callers that never negotiated profile support.
export function downgradeProviderCliStateListToV30(
  states: readonly unknown[],
): ProviderCliStateV30[] {
  return states.flatMap((state) => {
    const parsed = providerCliStateSchemaV30.safeParse(state);
    return parsed.success ? [parsed.data] : [];
  });
}

// Downgrades latest state to frozen list@2.0 (drops Amp/Devin/Pi + nativeCapabilities).
export function downgradeProviderCliStateToV20(
  state: ProviderCliState | ProviderCliStateV30,
): ProviderCliStateV20 | null {
  const parsed = providerCliStateSchemaV20.safeParse(state);
  return parsed.success ? parsed.data : null;
}

/**
 * Downgrades latest state to tag-exact mutation@2.0 (amp-inclusive, no
 * nativeCapabilities). Used by state-returning mutation 2.1→2.0 bridges.
 */
export function downgradeProviderCliStateToMutationV20(
  state: ProviderCliState | ProviderCliStateV30 | ProviderMutationCliStateV21,
): ProviderMutationCliStateV20 {
  // No destructure-and-cast to strip `nativeCapabilities`: `providerMutationCliStateSchemaV20` is a plain (non-strict) `z.object`, so the parse itself drops every key the frozen shape does not model.
  return providerMutationCliStateSchemaV20.parse(state);
}

// Downgrades a latest-shaped provider-state list to the frozen v4.0 shape, dropping Hermes/omp (or any future post-v4.0 provider) so an already-shipped v4.0 client's strict decode never sees them.
export function downgradeProviderCliStateListToV40(
  states: readonly unknown[],
): ProviderCliStateV40[] {
  return states.flatMap((state) => {
    const parsed = providerCliStateSchemaV40.safeParse(state);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * Drop post-v5.0 providers (currently `omp`) for an already-shipped v5.0 client.
 * Same filter-by-reparse shape as the older bridges: an entry whose id is not in the frozen v5.0 enum simply does not survive the parse.
 */
export function downgradeProviderCliStateListToV50(
  states: readonly unknown[],
): ProviderCliStateV50[] {
  return states.flatMap((state) => {
    const parsed = providerCliStateSchemaV50.safeParse(state);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * Lift a frozen v6.0 state onto the v7.0 PRE-IMAGE shape (not the live one).
 * `DEFAULT_PROVIDER_NATIVE_CAPABILITIES_V70_PREIMAGE` is the same "old host never had this feature" reading its live counterpart carries - a v6.0 host advertised no native capabilities at all.
 */
export function upgradeProviderCliStateToV70Preimage(
  state:
    | ProviderCliStateV20
    | ProviderCliStateV30
    | ProviderMutationCliStateV20,
): ProviderCliStateV70Preimage {
  return providerCliStateSchemaV70Preimage.parse({
    ...state,
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES_V70_PREIMAGE,
  });
}

export function upgradeProviderCliStateListToV70Preimage(
  states: readonly (
    | ProviderCliStateV20
    | ProviderCliStateV30
    | ProviderMutationCliStateV20
  )[],
): ProviderCliStateV70Preimage[] {
  return states.map(upgradeProviderCliStateToV70Preimage);
}

/**
 * v7.0 clients cannot render disabled profiles safely.
 * Omit those rows, then reparse through the frozen v7.0 profile shape to strip `enabled` from the remaining rows without disturbing the rest of the catalog.
 */
function parseProviderStateWithEnabledProfiles(state: unknown) {
  const current = providerCliStateSchema
    .extend({ providerId: z.string() })
    .safeParse(state);
  if (!current.success) return null;
  return {
    ...current.data,
    profiles: current.data.profiles.filter(isProfileEnabled),
  };
}

export function downgradeProviderCliStateListToV70(
  states: readonly unknown[],
): ProviderCliStateV70[] {
  return states.flatMap((state) => {
    const current = parseProviderStateWithEnabledProfiles(state);
    if (current === null) return [];
    const parsed = providerCliStateSchemaV70.safeParse(current);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * Drop post-v6.0 providers (currently `huggingface`) for an already-shipped v6.0 client, and strip the provider-pack-registry fields the frozen v6.0 state does not model.
 * Same filter-by-reparse shape as the older bridges: an entry whose id is not in the frozen v6.0 enum simply does not survive the parse.
 */
export function downgradeProviderCliStateListToV60(
  states: readonly unknown[],
): ProviderCliStateV60[] {
  return states.flatMap((state) => {
    const parsed = providerCliStateSchemaV60.safeParse(state);
    return parsed.success ? [parsed.data] : [];
  });
}

// Upgrades a v1.0 state to the frozen v2.0 shape - used only by `providers.list`'s v1.0 -> v2.0 bridge, whose response is pinned to `providerCliStateSchemaV20` (narrower `providerId`, no `profiles`).
// Every other provider.* mutation's v1.0 -> v2.0 bridge upgrades to the frozen major-2 mutation shape instead - see `upgradeProviderCliStateV10ToMutationV20` below.
export function upgradeProviderCliStateV10ToV20(
  state: ProviderCliStateV10,
): ProviderCliStateV20 {
  return providerCliStateSchemaV20.parse({
    ...state,
    availabilityPending: false,
  });
}

/**
 * Upgrade a tag-exact mutation@2.0 state (amp-inclusive) to latest by attaching
 * the default descriptor.
 */
export function upgradeProviderMutationCliStateV20ToLatest(
  state: ProviderMutationCliStateV20,
): ProviderCliState {
  return providerCliStateSchema.parse({
    ...state,
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
  });
}

// The `providers.list` fills are `upgradeProviderCliStateToV70Preimage` / `...ListToV70Preimage`, named for their TARGET SHAPE rather than for "latest".
// A bridge aims at a fixed shape: the moment a v8.0 opens above v7.0, a fill named "latest" silently means a shape v7.0 cannot carry.

/** Upgrade frozen list@2.0 / v3.0 state to latest by attaching the default descriptor. */
export function upgradeProviderCliStateToLatest(
  state:
    | ProviderCliStateV20
    | ProviderCliStateV30
    | ProviderMutationCliStateV20,
): ProviderCliState {
  return providerCliStateSchema.parse({
    ...state,
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
  });
}

export function upgradeProviderCliStateListToLatest(
  states: readonly (
    | ProviderCliStateV20
    | ProviderCliStateV30
    | ProviderMutationCliStateV20
  )[],
): ProviderCliState[] {
  return states.map(upgradeProviderCliStateToLatest);
}

// Upgrades a v1.0 state to the frozen major-2 mutation-response shape - used by every provider.* state-echo mutation's v1.0 -> v2.0 bridge (setSelection, addCustomPath, setEnabled, ...).
// Like the v1.0 host itself, the frozen 2.0 shape predates `profiles`; each method's 2.0 -> 2.1 upgrade fills `profiles: []` for the caller's canonical.
export function upgradeProviderCliStateV10ToMutationV20(
  state: ProviderCliStateV10,
): ProviderMutationCliStateV20 {
  return providerMutationCliStateSchemaV20.parse({
    ...state,
    availabilityPending: false,
  });
}
