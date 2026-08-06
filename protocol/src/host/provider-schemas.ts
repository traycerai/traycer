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
  nativeAuthActionSchema,
  nativeAuthCancelContextSchema,
  nativeAuthPollContextSchema,
  nativeAuthResultSchema,
  nativeListQuerySchema,
  nativeListResultSchema,
  nativeMutationResultSchema,
  nativeMutationSchema,
  providerNativeCapabilitiesSchema,
  type NativeAuthAction,
  type NativeAuthCancelContext,
  type NativeAuthPollContext,
  type NativeAuthResult,
  type NativeListQuery,
  type NativeListResult,
  type NativeMutation,
  type NativeMutationResult,
  type ProviderNativeCapabilities,
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
 * Used only by the frozen v3.0 `providers.list` response so an already-shipped
 * v3.0 client never receives post-v3.0 providers. Do not add new providers
 * here - extend the latest `providerIdSchema` and use the existing version
 * bridges instead.
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
 * Frozen provider id set as shipped in protocol v4.0 (with Devin/Pi, before
 * Hermes/omp). Used only by the frozen v4.0 `providers.list` response so an
 * already-shipped v4.0 client never receives post-v4.0 providers; the v5.0
 * line adds them with a v5→v4 (and v5→v3 / v5→v2 / v5→v1) downgrade bridge.
 * Do not add new providers here - extend the latest `providerIdSchema` and
 * use the existing bridges instead.
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

/**
 * Frozen provider id set as shipped in protocol v5.0 (with Hermes, before omp).
 *
 * This line IS released - `cli-v1.1.8` (tagged 2026-07-25) shipped v5.0, so a
 * client in the field strict-decodes exactly these ids and would reject `omp`
 * on the full-catalog `providers.list` broadcast. omp opened v6.0 instead.
 */
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
 *
 * This line IS released - `cli-v1.1.9` (tagged 2026-07-29) shipped v6.0, so it
 * is frozen for the same reason v5.0 is: a client in the field strict-decodes
 * exactly these ids. A new provider opens v7.0 rather than growing this enum.
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

/**
 * Why an `error` arm's install is stuck, as a closed vocabulary the renderer
 * can write copy against. Derived host-side from the typed verification code
 * (never sniffed from a message), so UI copy and the internal classification
 * cannot drift: `disk-full` is the ENOSPC/EDQUOT class, `verification` is a
 * `definitively-invalid` verdict, `network` is a registry/transport failure,
 * and `unknown` is the honest catch-all for a failure the host could not
 * classify any further.
 *
 * `unrepairable` is the one member that is not a failure to retry, and it is
 * the only reason that changes what the surface may OFFER rather than only
 * what it says. It means the local copy was digest-verified against a signed
 * artifact and only then found defective - a schema-invalid `pack.json`, or an
 * envelope whose manifest does not cover the tree. Re-downloading fetches the
 * byte-identical blob and fails in exactly the same place, fleet-wide, so the
 * host records the cell as terminal and refuses further installs for it. It
 * always travels with `retryAtMs: null`, and a renderer must not draw a retry
 * affordance for it: the click cannot do anything, now or later. Every other
 * reason is a genuine "try again"; this one is "this build is broken, and a
 * new one has to be published".
 *
 * `live-owner-stalled` is the opposite pole and belongs to the same story: a
 * SIBLING PROCESS on this machine holds the pack's download lease and its
 * progress token stopped advancing, so this host gave up waiting behind it
 * (bounded on the owner's lack of progress, not on elapsed time - a sibling
 * legitimately pulling a multi-gigabyte pack outlasts any fixed cap). Fully
 * retryable, with a real `retryAtMs`. It is deliberately NOT `network`, because
 * nothing about the registry failed and telling the user to check their
 * connection would send them after the wrong thing; and it is deliberately not
 * `unknown`, because `unknown` means the host could not classify the failure at
 * all, and this one is classified precisely - the host detected it on purpose
 * and has a typed error for it.
 *
 * `trust-unavailable` is the third pole, and the only reason that is not about
 * a PACK at all - it is about the host. The registry keyring could not be
 * verified this process (fetch failed, no cached copy), so there is no install
 * machinery to schedule anything with. It exists because `null` was carrying
 * three different facts at once: "this host has no managed packs by design",
 * "this build has no trust root baked yet" and "this host expected to serve
 * managed packs and currently cannot". The first two are intended states the
 * renderer must keep falling back on; the third is an outage, and reporting it
 * as `null` made a host that could not serve a provider look identical to one
 * that was never asked to - the provider silently vanished from the picker and
 * a reached turn fell through to generic "install it yourself" copy.
 *
 * It is RETRYABLE in the sense that the condition clears on its own (the host
 * re-attempts the keyring on the next kick), but a user-facing retry button is
 * the wrong affordance: the click cannot move it and `providers.ensurePack`
 * refuses on a host in this state. Its copy names reconnecting or restarting,
 * never "retry". It always travels with `retryAtMs: null`.
 *
 * `local-storage-mismatch` is the third non-retryable member, and the only one
 * that is a claim about the USER'S MACHINE. The host stored an archive that
 * passed its declared size and signed digest, read it back, and got different
 * bytes - twice for the same digest, the second time against an independently
 * re-fetched copy. It is deliberately separate from `verification`, which says
 * the registry's signed material failed its cryptography and sends the user to
 * complain about Traycer's publishing, and from `unrepairable`, which says a
 * published build is defective for everyone. Reported as either of those, the
 * one machine with failing storage looks like a fleet incident and the user is
 * pointed at something they cannot fix.
 *
 * Automatic refetch STOPS at this reason, which is what it is for: the failure
 * is deterministic on this device and the loop it replaces was an unbounded
 * multi-gigabyte download every backoff interval, forever. `retryAtMs` is null
 * because no attempt is scheduled, and a retry button would be
 * offered-then-failed.
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
 * Install lifecycle of a provider's managed (registry-backed) binary pack.
 * `absent` - never downloaded, or GC'd; `downloading` - fetch in progress,
 * `percent` a best-effort progress estimate; `installed` - present and
 * spawnable; `error` - the install failed and is not being retried until
 * `retryAtMs`. Carried at the provider level (there is exactly one managed
 * candidate per provider) rather than nested on `providerCliCandidateSchema`,
 * which is shared byte-for-byte with the frozen v1.0/v2.0/v3.0 wire shapes -
 * nesting it there would leak a new key into already-released responses (the
 * providers.list #258 class). `null` (see `managedInstallState` below) means
 * the host predates the provider pack registry, or - during the staged
 * bundled -> managed rollout - this provider hasn't been cut over yet; the
 * renderer falls back to today's `available`-flag rendering on the bundled
 * candidate in both cases, never inferring one lifecycle from the other.
 *
 * `downloading.percent` is NULLABLE, and that is a real state rather than
 * defensive typing: when a *live sibling host* sharing the same pack store
 * owns the download (per-cell lease, N13), this host can see that a transfer
 * is in progress but has no access to the owner's in-memory byte counter.
 * Reporting `absent` there would be a lie - the pack is being fetched - so the
 * observer reports `downloading` with no percent and the renderer shows an
 * indeterminate indicator. Every percent consumer must handle null.
 *
 * The `error` arm and the nullable percent are ADDITIVE ON THE UNRELEASED 6.0
 * LINE. No released tag (`host-v*`/`cli-v*`/`desktop-v*` through 1.1.8) ships
 * `providers.list@6.0`, which is what makes growing this union legal at all;
 * the released 5.0 and earlier lines are frozen and their downgrade bridges
 * strip the field wholesale. Accepted, stated plainly: a client old enough to
 * negotiate 6.0 but predating the `error` arm normalizes it to `null` through
 * `managedInstallState`'s `.catch(null)` and renders the plain `available`
 * fallback - post-T7 that is a silently-unavailable row with no message.
 */
export const providerManagedInstallStateSchema = z.discriminatedUnion(
  "status",
  [
    z.object({ status: z.literal("absent") }),
    z.object({
      status: z.literal("downloading"),
      percent: z.number().min(0).max(100).nullable(),
    }),
    z.object({ status: z.literal("installed") }),
    z.object({
      status: z.literal("error"),
      reason: providerManagedInstallErrorReasonSchema,
      // Operator-facing detail behind the reason (the underlying error text).
      // Never the primary copy - the renderer writes its own from `reason`.
      message: z.string(),
      // Epoch ms the host will accept an automatic retry again, or null when
      // the failure carries no backoff. Null is NOT one condition: read it
      // together with `reason`. For every reason but `unrepairable` it means
      // nothing is scheduled and a user-initiated `providers.ensurePack` is
      // the way forward; for `unrepairable` it means there is no way forward
      // at all and `ensurePack` is a guaranteed no-op.
      //
      // Constrained like `percent` above rather than left a bare `z.number()`:
      // an epoch-ms instant is a non-negative integer, and a fractional or
      // negative one is a producer bug, not a countdown. Because the FIELD
      // carries `.catch(null)`, a violation degrades to "no retry scheduled"
      // instead of throwing the whole `providers.list` away.
      retryAtMs: z.number().int().nonnegative().nullable(),
    }),
  ],
);
export type ProviderManagedInstallState = z.infer<
  typeof providerManagedInstallStateSchema
>;

/**
 * Host-aggregated, direction-free signal that other active sessions for this
 * provider are pinned to a version other than `current`. Deliberately NOT a
 * bare `pin !== current` boolean: holders legitimately differ (each pins its
 * managed candidate for its whole life), and a version rollback can make
 * `current` OLDER than a surviving pin - there is no "ahead/behind" to
 * report, only a count. Rollback-specific messaging belongs solely to the
 * `advisory` field below. `differingSessionCount: 0` and `null` both mean
 * "nothing to show" - the renderer never shows a toast for this, only a
 * quiet, self-correcting row indicator.
 */
export const providerVersionVisibilitySchema = z.object({
  differingSessionCount: z.number().int().nonnegative(),
});
export type ProviderVersionVisibility = z.infer<
  typeof providerVersionVisibilitySchema
>;

/**
 * Phase-2 (live update lane) advisory vocabulary. Ships now as a DORMANT
 * field only - no Phase-1 host ever populates it, always `null` until the
 * Phase-2 live reader lands. Structurally present so that later work can
 * start populating it without another protocol bump. `stale-channel` /
 * `cannot-confirm-eligibility` describe a live-channel read that couldn't be
 * trusted; `yank-keep-running` / `yank-rollback` distinguish an informational
 * "still fine" notice from an actionable "session may need reset" one;
 * `row-incompatibility` covers an explicitly selected PATH/custom candidate
 * that fails the closure-coupled version gate.
 */
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
  /**
   * Non-null when the provider's `providers.startLogin` child accepts a
   * pasted authorization code on stdin (e.g. Claude's manual-code redirect
   * page - see the code-paste decision log). The GUI shows the paste-code
   * waiting step only for providers with this slot set; the code itself
   * goes over `providers.submitLoginCode`, kept alive via
   * `providers.touchLogin`. Shape carries no fields today - existence alone
   * is the capability signal - but stays an object rather than a boolean so
   * a future paste-flow variant can grow it without a shape change.
   * `.catch(null)` tolerates old host builds that predate this field; old
   * peers degrade to no paste UI.
   */
  codePaste: z.object({}).nullable().catch(null),
  /**
   * Non-null when this provider must be signed in from a real terminal rather
   * than the headless `providers.startLogin` child - the host opens an
   * epic-scoped PTY over `providers.startTerminalLogin` and delivers the
   * provider's login command into it, and the user reads the device code and
   * URL the CLI prints. Copilot is the case: its `copilot login` prints a
   * device code that a headless child discards while the browser opens the
   * bare `github.com/login/device` page, dead-ending the sign-in. No CLI or
   * SDK exposes that code natively, so Traycer never parses it out - the user
   * reads it from the terminal Traycer opened.
   *
   * Set here, `oauthArgs` stays the command source but the GUI must NOT offer
   * headless browser OAuth; the host refuses `providers.startLogin` for the
   * same reason, so a released client that predates this field cannot start a
   * concurrent broken flow. Shape carries no fields today - existence alone is
   * the signal - but stays an object for the same reason `codePaste` does.
   *
   * `.catch(null)` hardens a present-but-unrecognized value. A genuinely
   * ABSENT key (an old host that predates the field, decoded through the
   * client's negotiated frozen schema) reads `undefined`, not `null` - the
   * v6->v7 upgrade bridge fills it, and GUI gates must test
   * `!== null && !== undefined`.
   */
  terminalLogin: z.object({}).nullable().catch(null),
});
export type ProviderLoginCapability = z.infer<
  typeof providerLoginCapabilitySchema
>;

/**
 * Frozen pre-code-paste snapshot of `providerLoginCapabilitySchema`, as it
 * shipped in host-v1.0.0 (`oauthArgs` + `token` only) - a hand-copy, NOT
 * derived via `.omit()` from the live schema, same invariant as
 * `providerCliStateBaseShapeV20`'s own comment below. Referenced by the
 * frozen `providerCliStateBaseShapeV10` / `V20` / `V30` base shapes in place
 * of the live schema, so those already-released wire shapes don't silently
 * inherit `codePaste` (or any future capability field) the moment the live
 * schema grows one - `loginCapability` predates per-field freezing
 * discipline (it was part of the original v1.0 base shape, not added and
 * frozen alongside a version bump like `profiles` was), so this snapshot
 * retrofits that guarantee.
 */
export const providerLoginCapabilitySchemaV10 = z.object({
  oauthArgs: z.array(z.string()).nullable(),
  token: z.object({ vars: z.array(z.string()) }).nullable(),
});
export type ProviderLoginCapabilityV10 = z.infer<
  typeof providerLoginCapabilitySchemaV10
>;

/**
 * Frozen post-code-paste snapshot of `providerLoginCapabilitySchema`, as it
 * shipped on the v4.0 line (host-v1.1.7): `oauthArgs` + `token` + `codePaste`.
 * Same hand-copy discipline as `providerLoginCapabilitySchemaV10` above - NOT
 * derived from the live schema.
 *
 * `providerCliStateBaseShapeV40` points here rather than at the live
 * capability, which pins four already-released wire shapes at once: the v4.0,
 * v5.0 and v6.0 `providers.list` lines and the @2.1 mutation state echo. Before
 * this pin, the base shape spread the LIVE capability, so a field added to the
 * capability leaked onto all four - the same defect the `V10` snapshot fixed
 * for the older lines and the same one that pinning the base shape itself
 * fixed for `profiles`/registry fields. `terminalLogin` is the concrete case
 * this guards against: it is a v7.0 field, and a v6.0 client that negotiated
 * before it existed must not decode it.
 *
 * Do not add fields here. Extend the live `providerLoginCapabilitySchema` and
 * let the v6->v7 upgrade bridge fill the new field for old hosts.
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

// One near/at-limit rate-limit window on a profile, annotated with the model
// family it gates. `family` is a provider-reported token - "opus", "sonnet",
// or a model-scoped bucket's display name ("Fable") - matched by the GUI
// against the selected model's slug/label; `null` means a shared window that
// gates every model.
export const providerProfileRateLimitScopeSchema = z.object({
  family: z.string().nullable(),
  severity: z.enum(["near_limit", "hard_limit"]),
});
export type ProviderProfileRateLimitScope = z.infer<
  typeof providerProfileRateLimitScopeSchema
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
  // The windows behind `rateLimitStatus`, per model family (see the scope
  // schema above), so the composer can scope its switch prompt to the selected
  // model instead of warning profile-wide. `null` = no per-scope data: an old
  // host build that predates this field (via `.catch(null)`, same guard as
  // `accentColor`) or a profile whose gauge has never been read / has gone
  // stale - consumers fall back to the profile-level `rateLimitStatus`. An
  // empty array means "read fine, nothing limited".
  rateLimitLimitedScopes: z
    .array(providerProfileRateLimitScopeSchema)
    .nullable()
    .catch(null),
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
  // Install lifecycle of this provider's managed (registry-backed) binary
  // pack - see `providerManagedInstallStateSchema`. Null/undefined for a host
  // that predates the provider pack registry, or (during the staged bundled
  // -> managed rollout) for a provider T7 has not yet cut over; the renderer
  // falls back to the existing `available` flag on the bundled candidate in
  // both cases. `.optional()` keeps the key itself omittable in a TS object
  // literal - host-side construction sites that predate this ticket (and
  // T4's population work) don't need to be touched just to satisfy the type -
  // while `.catch(null)` still normalizes a PRESENT-but-unrecognized value
  // (an older client reading a newer host's shape) to null rather than
  // throwing. Total decoder: every input either parses, defaults to null, or
  // is simply absent - never a hard failure.
  managedInstallState: providerManagedInstallStateSchema
    .nullable()
    .catch(null)
    .optional(),
  // Aggregated, direction-free "other sessions differ" signal - see
  // `providerVersionVisibilitySchema`. Null/undefined/zero all mean nothing to
  // show; see `managedInstallState` above for why the field is `.optional()`
  // on top of `.catch(null)`.
  versionVisibility: providerVersionVisibilitySchema
    .nullable()
    .catch(null)
    .optional(),
  // Phase-2 (live update lane) advisory - see `providerAdvisorySchema`. Lands
  // now as a dormant field: no Phase-1 host ever populates it, always
  // null/undefined. See `managedInstallState` above for why it's `.optional()`.
  advisory: providerAdvisorySchema.nullable().catch(null).optional(),
  // Whether the host resolved a runnable CLI binary for this provider - the
  // SAME `resolveEffectiveCliIdentity(...).path !== null` that decides whether
  // `applyBinaryAbsentGate` strips this provider's CLI-routed write verbs from
  // `nativeCapabilities`. False means those verbs were subtracted, and the UI
  // owes the user a reason: without it a binary-less amp shows an MCP tab with
  // no Add button, no Delete and no auth actions, and nothing anywhere saying
  // why.
  //
  // Deliberately NOT derived client-side from `candidates`. The resolver's
  // fallback order (selected custom -> bundled -> PATH, each only if
  // `available`) is not the same question as "is any candidate available" - an
  // available-but-unselected custom path satisfies the second and not the
  // first - and re-deriving host resolution rules in the renderer is precisely
  // the drift this field exists to stop.
  //
  // `.catch(true).optional()` for the reason `managedInstallState` is optional,
  // with `true` as the quiet default: an old host omits the key, and assuming
  // "resolved" reproduces today's exact behavior (no notice) rather than
  // accusing every provider on an old host of a missing binary.
  cliBinaryResolved: z.boolean().catch(true).optional(),
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
  loginCapability: providerLoginCapabilitySchemaV10.nullable().catch(null),
  availabilityPending: z.boolean().catch(false),
};

/**
 * Latest provider CLI state (providers.list@3.1 and state-returning
 * providers.*@2.1). Adds `nativeCapabilities` — per-capability facts the UI
 * renders MCP/plugins/skills tabs from. `.catch(DEFAULT)` tolerates old host
 * builds that omit the field when an old-host response is parsed on a new
 * client.
 */
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
 * Live `providers.list@7.0` request. Optional `native` list/discover query
 * folds the mcp/plugins/skills list verbs onto this carrier. Callers on any
 * earlier line predate it, so the v6.0 -> v7.0 upgrade fills `native: null`
 * ("classic caller, no native query").
 *
 * `native` rides v7.0 ALONE. It was authored against the live request object
 * while v6.0 was still unreleased, which silently grew the already-shipped
 * v4.0/v5.0/v6.0 request lines too; `host-v1.1.10` then froze those three
 * lines without it, because the commit that added it was not in the release
 * cherry-pick. Every line below v7.0 is pinned to
 * `providersListRequestSchemaBeforeV70` for that reason - do not point a
 * released line back at this schema.
 */
export const providersListRequestSchema = z.object({
  forceAuthRefresh: z.boolean().optional(),
  native: nativeListQuerySchema.nullable().default(null),
});
export type ProvidersListRequest = z.infer<typeof providersListRequestSchema>;

/**
 * Frozen request shape for every released `providers.list` line before v7.0
 * (v1.0 through v6.0 all shipped exactly this). Hand-pinned rather than
 * derived from the live schema via `.omit()` so a future request field cannot
 * leak into a shipped line the way `native` did.
 */
export const providersListRequestSchemaBeforeV70 = z.object({
  forceAuthRefresh: z.boolean().optional(),
});
export type ProvidersListRequestBeforeV70 = z.infer<
  typeof providersListRequestSchemaBeforeV70
>;

/**
 * `providers.list@3.1` response. Always returns the classic provider catalog;
 * when the request carried a `native` query, `native` holds the list/discover
 * result (or a typed native error). Classic callers receive `native: null`.
 */
export const providersListResponseSchema = z.object({
  providers: z.array(providerCliStateSchema),
  native: nativeListResultSchema.nullable().default(null),
});
export type ProvidersListResponse = z.infer<typeof providersListResponseSchema>;

// ── Frozen protocol-v2.0 provider state + list response (before Amp) ───────
// `providers.list` always returns every provider; v2.0 shipped without Amp, so
// it is frozen here as actually shipped. The v3.0 line adds Amp and a v3→v2
// (and v3→v1) downgrade bridge filters it for older callers. Do not add new
// providers here - use the existing v3 bridge. Frozen WITHOUT
// nativeCapabilities (that rides @3.1 / @2.1). `providerIdSchemaV20` is ONLY
// for this list@2.0 response shape — mutation @2.0 responses are amp-inclusive
// (tag-exact host-v1.1.5); see providerMutationCliStateSchemaV20 below.
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

/**
 * Tag-exact host-v1.1.5 shape for state-returning mutation @2.0 responses.
 * Amp-inclusive (the released @2.0 mutation surface accepted amp); no
 * `nativeCapabilities` (@2.1-only). Distinct from list@2.0's pre-amp freeze.
 * Oracle: `git show host-v1.1.5:protocol/src/host/provider-schemas.ts` —
 * mutation responses reused the then-latest amp-inclusive state schema.
 */
export const providerMutationCliStateSchemaV20 = z.object({
  providerId: providerIdSchema,
  ...providerCliStateBaseShapeV20,
  auth: PROVIDER_AUTH_SCHEMA_V20,
});
export type ProviderMutationCliStateV20 = z.infer<
  typeof providerMutationCliStateSchemaV20
>;

// ── Frozen protocol-v3.0 provider state + list response (with Amp, before ──
// Devin/Pi). `providers.list` always returns every provider; v3.0 shipped with
// Amp and WITHOUT `profiles` - multi-profile landed mid-line but never reached
// a released host on this line, so `profiles` belongs to the v4.0 cut and the
// v3→v4 upgrade fills `profiles: []` for v3.0 hosts. The v4.0 line also adds
// Devin/Pi, and the v4→v3 (and v4→v2 / v4→v1) downgrade bridges filter them
// for older callers. Do not add new providers or fields here - use the
// existing version bridges.
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

// ── Frozen protocol-v4.0 provider state + list response (with Devin/Pi, ────
// before Hermes/omp). `providers.list` always returns every provider; v4.0
// shipped (host-v1.1.7) with Devin/Pi, `profiles[]`, and the code-paste-
// capable login capability. The v5.0 line adds Hermes and omp, and the v5→v4
// (and v5→v3 / v5→v2 / v5→v1) downgrade bridges filter them for older
// callers. Do not add new providers or fields here - use the existing v5
// bridge.
//
// Built as a hand-frozen snapshot of the base shape as actually released on
// the v4.0 line, with the frozen v4.0 provider-id enum - NOT derived via
// `.extend()` from the live schema, so future live-only fields do not leak
// into the v4.0 wire for already-shipped clients.
//
// `loginCapability` points at the hand-frozen `providerLoginCapabilitySchemaV40`
// for the same reason the shape itself is hand-frozen: pinning the shape's KEYS
// while leaving one of them wired to a live sub-schema leaves that sub-schema
// free to grow on every line this shape backs (v4.0, v5.0, v6.0 list responses
// and the @2.1 mutation echo). See that schema's comment.
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
  profiles: z.array(providerProfileSchema).catch([]),
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
 *
 * Both halves are pinned - the id enum AND the base shape. Pinning only the
 * enum is not enough: this schema originally spread the LIVE base shape, whose
 * comment ("so a future `.extend()` cannot silently leak back") described the
 * intent but not the effect. A field ADDED to the live base shape leaks in the
 * same way an `.extend()` would, and the provider-pack-registry fields did
 * exactly that - `managedInstallState`, `versionVisibility` and `advisory`
 * appeared on this already-shipped line and grew it.
 *
 * `providerCliStateBaseShapeV40` is the right pin: v4.0 and v5.0 differ only by
 * the id enum, so the twelve keys below are precisely what `cli-v1.1.8` shipped
 * on v5.0. The registry fields live on the live shape and therefore reach
 * clients only through v7.0 (they briefly rode v6.0 - see
 * `providerCliStateSchemaV60` for why that line is now pinned too).
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

/**
 * Frozen `providers.list` response as shipped in protocol v6.0.
 *
 * `cli-v1.1.9` (tagged 2026-07-29) shipped v6.0, which froze it - and the
 * provider-pack-registry fields were still growing it, exactly as they grew
 * v5.0 before `cli-v1.1.8` froze that line. Same defect, one version later:
 * v6.0 pointed at the LIVE response schema, so every field added to the live
 * base shape landed on an already-released line.
 *
 * Pinned the same way v5.0 is: `providerCliStateBaseShapeV40` is the twelve
 * keys v6.0 actually shipped, since v6.0 differs from v5.0 only by the omp id.
 * The registry fields live on the live shape and now reach clients only
 * through v7.0; the v7->v6 downgrade drops them by reparsing through this
 * schema, which strips keys it does not model.
 */
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

export {
  DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
  type ProviderNativeCapabilities,
};


// ── Frozen major-2.1 mutation-response provider state (pre-registry) ───────
// The same freeze discipline as `providerMutationCliStateSchemaV20` above,
// one minor later - and applied for the same reason it was needed there.
//
// The 2.1 line shipped (host-v1.1.7) as "the frozen 2.0 mutation shape plus
// `profiles[]` plus the code-paste-capable login capability", but it was
// WIRED to the LIVE `providerCliStateSchema` instead of a pinned shape. So
// when the provider-pack-registry fields (`managedInstallState`,
// `versionVisibility`, `advisory`) landed on the live state they silently
// leaked onto ten already-released @2.1 echoes that no released peer ever
// sends - exactly the drift the 2.0 pin was introduced to stop after
// `profiles` did the same thing. Pinning the shape here restores the released
// 2.1 wire byte-for-byte.
//
// This is the honest model, not merely a compat patch: a state echo can never
// carry registry state in the first place. Enabling a provider, setting an
// API key, or completing a login cannot change what is installed, so
// `providers.list` - whose v5.0 line is properly versioned for these fields -
// is their only carrier. Do not add new fields here; add them to the live
// `providerCliStateBaseShape` and let `providers.list` publish them.
//
// The field set reuses `providerCliStateBaseShapeV40` (the list line's
// hand-frozen v4.0 shape) because that is exactly what 2.1 released. Both are
// frozen, so neither can drift into the other. `providerId` stays the LIVE
// enum for the same reason the 2.0 pin keeps it: an echo returns the id the
// caller just named, so enum growth stays request-gated (see the
// `providers.set*` / `providers.add*` entries in compat-exceptions.json).
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
 *
 * `enabled` is REQUIRED and stays required: 2.1 is a released line, and
 * demoting a required property to optional is a wire break in the dangerous
 * direction - this tree would start emitting payloads omitting `enabled` that
 * a released peer cannot parse. Native mutations therefore do NOT fold onto
 * this carrier; they ride the dedicated optional `providers.nativeMutate@1.0`
 * method instead (see `registry.ts`).
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
 * `providers.setEnabled@2.1` response. Returns classic `state` only - 2.1 is
 * released and its response shape is frozen. Native mutation results come back
 * on `providers.nativeMutate@1.0` instead.
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

/**
 * `providers.startLogin@1.1` request (classic provider login only). MCP auth
 * does NOT fold onto this released carrier - it rides the dedicated optional
 * `providers.mcpAuth@1.0` method (see `registry.ts`).
 */
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
 * `providers.awaitLogin@2.1` request. Blocks until an in-flight
 * `providers.startLogin` child finishes (the browser loopback completes or the
 * CLI exits), then returns the freshly re-probed state - the honest "did the
 * reconnect work?" signal, so the GUI awaits this instead of polling auth
 * status. MCP auth polling is NOT folded onto this released carrier; it uses
 * the dedicated optional `providers.awaitMcpAuth@1.0` method.
 */
// `profileId` mirrors `providers.startLogin@1.1`'s request field so the
// caller awaits the same profile-scoped login child it started. Ships with
// `providers.awaitLogin@2.1` (originally landed as a bare additive/defaulted
// field on the released 2.0 line; the 2.0 shapes are frozen without it below
// and the 2.0→2.1 upgrade fills `null`). The v2->v1 downgrade bridge in
// registry.ts explicitly drops it before the strict v1.0 parse (see
// `providersAwaitLoginDowngradeV21ToV10`).
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
  // Create-profile only: when the authenticated account already belongs to
  // an active profile, the host discards the pending profile instead of
  // activating a duplicate and identifies the existing profile here. Ships
  // with `providers.awaitLogin@2.1`; the frozen 2.0 response below never
  // carried it.
  existingProfileId: z.string().nullable().default(null),
  // Code-paste only: true when this call resolved because a previously
  // submitted `providers.submitLoginCode` was rejected by the exchange (the
  // login child exited nonzero without auth success on re-probe - see the
  // code-paste decision log's "Failure classification" row), distinct from
  // the default outcome (a successful re-probe, or nothing was in flight).
  // The GUI uses this to drive its bounded auto-restart (decision log's
  // "Bad-code recovery" row) instead of surfacing a generic failed state.
  // Bare additive field on the still-unreleased 2.1 line (same precedent as
  // `providers.startLogin@1.1`'s `createProfile.shareSkillsAndPlugins`):
  // old hosts never emit it and `.default(false)` keeps old-client parses
  // byte-identical to today.
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
 * Client-side response-frame budget for `providers.awaitLogin`, which is a
 * long-poll: the host's response is contractually silent until the OAuth
 * login child terminates. A transport-default frame timeout (~30 s) misreads
 * that silence as a dead host and abandons a healthy in-flight sign-in as
 * soon as the user takes longer than the timeout in the browser.
 *
 * Derivation: the host's login timeout is now a rolling deadline (see the
 * code-paste decision log's "Timeouts" row) - each `providers.touchLogin`
 * keepalive or `providers.submitLoginCode` submit resets the kill timer to
 * 3 minutes out, hard-capped at 15 minutes from spawn - so a child can
 * legitimately stay alive up to 15 minutes even while the long-poll caller
 * sees no traffic. 16 minutes covers that hard cap plus slack for the await
 * path's own bounded auth re-probe before the response is framed. The host
 * must keep its internal deadline strictly under this budget - clients wait
 * exactly this long before declaring the call dead.
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

/**
 * `providers.cancelLogin@1.1` response (classic provider login only).
 */
export const providersCancelLoginResponseSchema = z.object({
  cancelled: z.boolean(),
});
export type ProvidersCancelLoginResponse = z.infer<
  typeof providersCancelLoginResponseSchema
>;

// ── Dedicated native methods (optional capability channel) ─────────────────
//
// These carry the MCP/plugins/skills payloads that used to fold onto the
// released `providers.startLogin@1.1` / `awaitLogin@2.1` / `cancelLogin@1.1` /
// `setEnabled@2.1` carriers. Folding grew already-released wire shapes, which
// the compat gate correctly rejects: a released line is frozen. Because they
// are brand-new METHOD NAMES they ride the optional-capability channel with
// `degrade: { kind: "unsupported" }` (see `registry.ts`), so a host that
// predates them fails these calls per-call with upgrade guidance instead of
// failing the whole handshake.
//
// Unlike the carrier fields, `result` here is non-nullable: these methods
// exist only to serve native actions, so "no payload" is not a reachable
// success state - the resolver either answers with a result (including the
// typed `error`/`unsupported` arms) or throws.

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
 * `providers.awaitMcpAuth@1.0` request - a **bounded status poll** (well under
 * the 30s unary frame deadline), never a long poll. The host pending-auth
 * registry (R02) owns concurrency.
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

/**
 * `providers.cancelMcpAuth@1.0` response. `cancelled` reports whether a
 * pending auth was actually found and torn down, distinct from `result`, which
 * describes the server's resulting auth state - cancelling something that was
 * never in flight is `cancelled: false` with a perfectly normal result.
 */
export const providersCancelMcpAuthResponseSchema = z.object({
  cancelled: z.boolean(),
  result: nativeAuthResultSchema,
});
export type ProvidersCancelMcpAuthResponse = z.infer<
  typeof providersCancelMcpAuthResponseSchema
>;

/**
 * `providers.nativeMutate@1.0` request - MCP/plugins/skills mutations. The
 * scope tuple and its `scope`/`workspaceRoot` invariant live inside
 * `nativeMutationSchema`, so no XOR refinement is needed on this envelope.
 */
export const providersNativeMutateRequestSchema = z.object({
  providerId: providerIdSchema,
  mutation: nativeMutationSchema,
});
export type ProvidersNativeMutateRequest = z.infer<
  typeof providersNativeMutateRequestSchema
>;

/**
 * `providers.nativeMutate@1.0` response. Returns only the mutated native
 * collection: the old `setEnabled` carrier also echoed the full
 * `ProviderCliState`, but no client ever read it on the native arm, and
 * recomputing a whole provider catalog for a tool toggle is pure overhead.
 */
export const providersNativeMutateResponseSchema = z.object({
  result: nativeMutationResultSchema,
});
export type ProvidersNativeMutateResponse = z.infer<
  typeof providersNativeMutateResponseSchema
>;

export type {
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
 * Relay a pasted authorization code to an in-flight `providers.startLogin`
 * child's stdin (see the code-paste decision log's "Mechanism" row).
 * `profileId` mirrors `providers.startLogin@1.1`'s convention - the same
 * profile-scoped login child the caller started - and defaults to `null`
 * for the legacy (no-profile-override) login. The exchange outcome itself
 * (accepted vs rejected by claude.ai) is NOT carried here: submitting only
 * confirms the code reached a live child; the real outcome surfaces later
 * via the existing `providers.awaitLogin` long-poll (see that response's
 * `codeRejected` flag) or, after an auto-restart, a fresh login.
 */
export const providersSubmitLoginCodeRequestSchema = z.object({
  providerId: providerIdSchema,
  profileId: z.string().nullable().default(null),
  code: z.string(),
});
export type ProvidersSubmitLoginCodeRequest = z.infer<
  typeof providersSubmitLoginCodeRequestSchema
>;

/**
 * `accepted`: the code reached a live login child (a real exchange attempt
 * is now underway, or the child re-armed after a malformed paste - see the
 * decision log's "Malformed paste" row); await the result via
 * `providers.awaitLogin`. `noActiveLogin`: no login child is running for
 * this provider/profile (already finished, cancelled, or timed out) - the
 * caller should start a fresh login instead of waiting.
 */
export const providersSubmitLoginCodeResponseSchema = z.object({
  outcome: z.enum(["accepted", "noActiveLogin"]),
});
export type ProvidersSubmitLoginCodeResponse = z.infer<
  typeof providersSubmitLoginCodeResponseSchema
>;

/**
 * Keepalive for an in-flight `providers.startLogin` child: resets the
 * host's rolling kill timer without submitting a code (see the code-paste
 * decision log's "Timeouts" row - each keepalive or submit resets the timer
 * to 3 minutes out, hard-capped at 15 minutes from spawn). The GUI fires
 * this while the user is still away in the browser so a slow copy-paste
 * doesn't race the kill timer. `profileId` mirrors the same profile-scoped
 * convention as `providers.submitLoginCode`; unlike that request this
 * method has no pre-profile legacy shape to stay compatible with, so the
 * field is required rather than defaulted.
 */
export const providersTouchLoginRequestSchema = z.object({
  providerId: providerIdSchema,
  profileId: z.string().nullable(),
});
export type ProvidersTouchLoginRequest = z.infer<
  typeof providersTouchLoginRequestSchema
>;

/**
 * `extended: false` when no live login child exists for this
 * provider/profile (already finished, cancelled, or timed out) - the
 * caller should stop touching and re-probe instead of retrying.
 */
export const providersTouchLoginResponseSchema = z.object({
  extended: z.boolean(),
});
export type ProvidersTouchLoginResponse = z.infer<
  typeof providersTouchLoginResponseSchema
>;

/**
 * Start (or restart) a host-owned, epic-scoped terminal running this
 * provider's login command, for providers whose capability declares
 * `terminalLogin`. The host - not the client - creates the PTY: only the host
 * can build the provider's spawn env (binary path, profile overrides,
 * `COPILOT_AUTO_UPDATE=false`) and pick the cwd, and a plain `terminal.create`
 * would get bare filtered `process.env` in a surface that has no cwd of its
 * own. The client's job is to render the session the host names back.
 *
 * `epicId` scopes the session so it lands in the epic's Terminals surface and
 * the initiating view can open it as a tile - the same scope `terminal.create`
 * uses. `cols`/`rows` are the size the PTY is opened at, applied while the
 * shell's output is still buffered so its first redraw is not torn; they are
 * an INITIAL size, not a promise about the user's viewport - the tile resizes
 * on mount, and today's client sends a fixed 80x24. A host must not treat them
 * as the real geometry (no sizing heuristics, no resize-suppression window).
 *
 * No `profileId`: terminal login is Copilot-only today and Copilot has no
 * managed profiles, so the field could only ever carry the ambient sentinel -
 * a value with two live spellings in the host (`"ambient"` on the wire, `null`
 * in the domain) and therefore a way for one provider to end up with two
 * "single" login shells. If terminal login ever reaches a provider WITH
 * managed profiles, add the field then and normalize it at the resolver
 * boundary.
 *
 * No `desiredSessionId` either: the host mints a fresh one per attempt. A
 * reused id is what makes a retry silently fail - a killed session lingers
 * `exited` in the host's grace window, so a readiness watch armed on that id
 * settles immediately and the login command is never delivered, and a reused
 * tile id re-focuses the previous, permanently dead tile.
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

/**
 * `sessionId` is the freshly created session - the client opens it as a tile
 * and ATTACHES; it must never `terminal.create` that id itself.
 *
 * `replacedSessionId` is the previous login session this attempt killed, or
 * `null` on a first attempt. Every click starts a fresh sign-in (a completed
 * login leaves an idle interactive shell behind that carries no state worth
 * resuming), so the client closes any open tile bound to this id before
 * focusing the new one - otherwise the retry lands on a tile that can never
 * come back to life.
 */
export const providersStartTerminalLoginResponseSchema = z.object({
  // Bounded like the request's `epicId`: an empty id decodes fine and then
  // vanishes downstream - `useFocusEpicTerminalSession` returns early on a
  // zero-length session id - leaving the host holding a live sign-in PTY with
  // no tile and no error. The host mints a uuid so this is a contract floor,
  // not a live defect.
  sessionId: z.string().min(1),
  replacedSessionId: z.string().nullable(),
});
export type ProvidersStartTerminalLoginResponse = z.infer<
  typeof providersStartTerminalLoginResponseSchema
>;

/**
 * User-initiated "get this provider's managed pack ready". A NON-BLOCKING
 * kick: the host promotes the pack to the front of its install queue, clears
 * the cell's exponential backoff (this is a human pressing retry, not an
 * automatic poll), and returns the pack's CURRENT state immediately - it never
 * awaits the download. Poll `providers.list` for progress.
 *
 * The user-initiated flag is not on the wire because it is not the client's to
 * assert: reaching the host through THIS method is what makes a call
 * user-initiated. `providers.list` and boot convergence take the automatic
 * arm, which honors backoff and may not quarantine an unverifiable version
 * dir; only this method's arm may.
 */
export const providersEnsurePackRequestSchema = z.object({
  providerId: providerIdSchema,
});
export type ProvidersEnsurePackRequest = z.infer<
  typeof providersEnsurePackRequestSchema
>;

/**
 * The pack's state as of the kick, in the same vocabulary `providers.list`
 * carries. `null` where that field is null there: the provider has no managed
 * pack on this host (store not managed, or a provider the staged rollout has
 * not cut over), so there was nothing to ensure.
 *
 * A host with no install machinery at all does NOT answer null here - it
 * refuses the call with an error. Null and "refused" would otherwise be the
 * same response, and a client cannot tell a kick it should poll for from one
 * that did nothing and never will. That is how a retry affordance stays
 * offered forever for a click that cannot work.
 */
export const providersEnsurePackResponseSchema = z.object({
  managedInstallState: providerManagedInstallStateSchema.nullable(),
});
export type ProvidersEnsurePackResponse = z.infer<
  typeof providersEnsurePackResponseSchema
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
// A provider outside v1.0's id set (ACP GUI harnesses, Amp) simply fails the
// `providerCliStateSchemaV10` parse below and is filtered by the caller.
// Accepts the live (latest) state or any of the frozen v2.0/v3.0 states -
// those already lack `profiles`/`nativeCapabilities` (see
// `providerCliStateBaseShapeV20`), so both are typed optional here rather
// than requiring callers to conjure one (the provider-pack-registry fields -
// `managedInstallState`, `versionVisibility`, `advisory` - are already
// optional on `ProviderCliState` itself, so no extra typing is needed for
// those). `providersListDowngradeV2ToV1` (v2.0/mutation-v2.0 sources) and the
// v3.0/latest downgrade paths (live source) share this one stripping
// function.
// `loginCapability` is typed as the live OR either frozen capability shape for
// the same reason: the v2.0/v3.0 frozen states carry the pre-`codePaste` shape
// (`providerLoginCapabilitySchemaV10`) and `ProviderMutationCliStateV21` carries
// the pre-`terminalLogin` one (`providerLoginCapabilitySchemaV40`), neither of
// them live. All three are fine here since the strict v1.0 parse below only
// keeps `oauthArgs`/`token` regardless.
// Exported so `registry.ts` names the same shape instead of restating it: the
// two definitions had already been written twice, identically, and the widened
// `loginCapability` below is exactly the kind of detail that drifts when only
// one copy gets updated.
//
// A union of the real source shapes rather than a single `Omit<ProviderCliState>`:
// the frozen v2.0/v3.0/mutation-v2.0 states genuinely lack `nativeCapabilities`
// and the provider-pack-registry fields, so those are widened to optional here.
// That keeps them destructurable in the strip below no matter which side fed
// this call.
export type DowngradableToV10ProviderState = (
  | ProviderCliState
  | ProviderCliStateV30
  | ProviderCliStateV20
  | ProviderMutationCliStateV20
  | ProviderMutationCliStateV21
) & {
  profiles?: ProviderCliState["profiles"];
  nativeCapabilities?: ProviderNativeCapabilities;
  managedInstallState?: ProviderCliState["managedInstallState"];
  versionVisibility?: ProviderCliState["versionVisibility"];
  advisory?: ProviderCliState["advisory"];
  cliBinaryResolved?: ProviderCliState["cliBinaryResolved"];
  loginCapability: ProviderLoginCapability | ProviderLoginCapabilityV10 | null;
};

export function downgradeProviderCliStateToV10(
  state: DowngradableToV10ProviderState,
): ProviderCliStateV10 | null {
  // `providerCliStateSchemaV10` is a `z.strictObject`, so it REJECTS any key it
  // doesn't model. Drop later-than-v1.0 fields before the parse — otherwise
  // every provider fails the parse and silently vanishes from the downgraded
  // payload for v1.0 clients.
  // - `availabilityPending` (v2.0+)
  // - `profiles` (unreleased) — must never reach a v1.0 caller; also keeps
  //   profile identity (email, label) off the wire for peers that never
  //   negotiated profile support.
  // - `nativeCapabilities` (v3.1 / v2.1+) — CRITICAL silent-data-loss trap
  // - `managedInstallState` / `versionVisibility` / `advisory` — the
  //   provider-pack-registry fields.
  // - `cliBinaryResolved` — the binary-absent explanation field.
  const {
    availabilityPending: _availabilityPending,
    profiles: _profiles,
    nativeCapabilities: _nativeCapabilities,
    managedInstallState: _managedInstallState,
    versionVisibility: _versionVisibility,
    advisory: _advisory,
    cliBinaryResolved: _cliBinaryResolved,
    ...rest
  } = state;
  const parsed = providerCliStateSchemaV10.safeParse({
    ...rest,
    auth: downgradeProviderAuthV20ToV10(state.auth),
  });
  return parsed.success ? parsed.data : null;
}

// Downgrades a latest-shaped provider-state list to the frozen v2.0 shape,
// dropping Amp/Devin/Pi (or any post-v2.0 provider) and stripping
// `nativeCapabilities` so an already-shipped v2.0 client's decode never sees
// them. Zod object parse strips unknown keys, so this is a pure filter+reparse
// - no field remapping needed (unlike the v1.0 downgrade above). LIST only —
// mutations use {@link downgradeProviderCliStateToMutationV20}.
export function downgradeProviderCliStateListToV20(
  states: readonly unknown[],
): ProviderCliStateV20[] {
  return states.flatMap((state) => {
    const parsed = providerCliStateSchemaV20.safeParse(state);
    return parsed.success ? [parsed.data] : [];
  });
}

// Downgrades a latest-shaped provider-state list to the frozen v3.0 shape,
// dropping Devin/Pi (or any future post-v3.0 provider) so an already-shipped
// v3.0 client's strict decode never sees it. The reparse also strips
// `profiles`/`nativeCapabilities` - the frozen v3.0 object doesn't model
// them - keeping profile identity (email, label) off the wire for callers
// that never negotiated profile support.
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
  // No destructure-and-cast to strip `nativeCapabilities`:
  // `providerMutationCliStateSchemaV20` is a plain (non-strict) `z.object`, so
  // the parse itself drops every key the frozen shape does not model. That is
  // the same mechanism the v4.0->v3.0 bridge relies on to keep `profiles` off
  // the wire - keep this schema non-strict or unmodeled fields start leaking.
  return providerMutationCliStateSchemaV20.parse(state);
}

// Downgrades a latest-shaped provider-state list to the frozen v4.0 shape,
// dropping Hermes/omp (or any future post-v4.0 provider) so an already-shipped
// v4.0 client's strict decode never sees them.
export function downgradeProviderCliStateListToV40(
  states: readonly unknown[],
): ProviderCliStateV40[] {
  return states.flatMap((state) => {
    const parsed = providerCliStateSchemaV40.safeParse(state);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * Drop post-v5.0 providers (currently `omp`) for an already-shipped v5.0
 * client. Same filter-by-reparse shape as the older bridges: an entry whose
 * id is not in the frozen v5.0 enum simply does not survive the parse.
 */
export function downgradeProviderCliStateListToV50(
  states: readonly unknown[],
): ProviderCliStateV50[] {
  return states.flatMap((state) => {
    const parsed = providerCliStateSchemaV50.safeParse(state);
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

/** Upgrade frozen list@2.0 / v3.0 state to latest by attaching the default descriptor. */
export function upgradeProviderCliStateToLatest(
  state: ProviderCliStateV20 | ProviderCliStateV30 | ProviderMutationCliStateV20,
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
