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

/**
 * Frozen provider id set as shipped in protocol v7.0 (v6.0 plus huggingface).
 *
 * Pinned before the line shipped, unlike every enum above it. v8.0 now owns
 * live catalog growth without changing what a v7.0 peer can serialize.
 */
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
    // `absent` deliberately carries NO `version`. The other three arms gained
    // one on the v7.0 line (the main table labels the row "Installing v1.18.11
    // · 42%", which needs the version the slot refers to), but `absent` means
    // no managed copy exists, so a version there could only ever be null - a
    // field with one legal value forever informs nothing. "Which version WOULD
    // be installed" is a different question and it is answered properly by
    // `managedVersions.available[]`, whose rows carry `recommended` / `current`
    // per version. Do not add a fourth copy of that answer here.
    z.object({ status: z.literal("absent") }),
    z.object({
      status: z.literal("downloading"),
      // NULL IS A REAL STATE, NOT DEFENSIVE TYPING, and it is specifically NOT
      // an error: when a live SIBLING HOST sharing this machine's pack store
      // owns the transfer, this host can see a fetch is in progress but has no
      // access to the owner's byte counter. The honest report is "downloading,
      // percent unknown" and the honest render is an indeterminate bar. A
      // renderer that treats a null percent - or the sibling-owned case
      // generally - as a failure tells the user a download broke while it is
      // actively progressing on the same machine. The failure mode for a
      // sibling that STOPS progressing is a different thing entirely and has
      // its own reason (`live-owner-stalled` on the error arm).
      percent: z.number().min(0).max(100).nullable(),
      // Ships with v7.0; the v7->v6 bridge strips it. Nullable because a host
      // can be waiting behind a sibling's lease before it has resolved which
      // version that sibling is fetching.
      //
      // `.catch(null).optional()` for the same reason the base shape's
      // `managedInstallState` itself is optional, stated in its comment: the
      // key stays omittable in a TS object literal so host construction sites
      // that predate the population work do not have to be touched to satisfy
      // the type, while a PRESENT-but-unrecognized value still normalizes
      // instead of throwing. The wire-assembly ticket populates it; until then
      // these arms read `undefined`, which consumers treat as "version not
      // reported" exactly like `null`.
      version: z.string().nullable().catch(null).optional(),
    }),
    z.object({
      status: z.literal("installed"),
      // Ships with v7.0; the v7->v6 bridge strips it. Nullable so a host that
      // can see a usable managed copy but cannot cheaply name its version
      // (the poll lane runs no per-dir verification) reports the truth rather
      // than guessing. Optional for the reason given on the arm above.
      version: z.string().nullable().catch(null).optional(),
    }),
    z.object({
      status: z.literal("error"),
      reason: providerManagedInstallErrorReasonSchema,
      // The version the failed attempt was for. Ships with v7.0; the v7->v6
      // bridge strips it. Nullable: a failure early enough to precede target
      // resolution (a keyring that would not verify - `trust-unavailable`) has
      // no version to name, and inventing one would misattribute a host-wide
      // outage to a specific build. Optional for the reason given on the
      // `downloading` arm.
      version: z.string().nullable().catch(null).optional(),
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
 * Frozen `providers.list@7.0` snapshot of
 * `providerManagedInstallErrorReasonSchema` - a hand-copy, NOT derived from the
 * live enum via `.extract()`/`.exclude()`, exactly like the frozen provider id
 * enums above. See the live enum's doc block for what each member means; this
 * copy exists to pin the MEMBER SET, not to restate the semantics.
 *
 * A reason added to the live enum must not appear here. It would reach a v7.0
 * peer whose released client has no copy for it, and because the field carries
 * `.catch(null)` that client normalizes the whole `managedInstallState` to
 * `null` - a stuck install renders as a silently-unavailable row with no
 * message, which is worse than the generic copy it would have shown for a
 * reason it did know.
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
 * PRE-IMAGE snapshot of `providerManagedInstallStateSchema` - a hand-copy of
 * the four arms as they stood before the version-manager work, for the same
 * reason `providerLoginCapabilitySchemaV40` is a hand-copy of the capability:
 * pinning a wire shape's KEYS while leaving one of them wired to a live
 * sub-schema leaves that sub-schema free to grow on the line it backs.
 *
 * That growth is no longer hypothetical - it happened. The managed-versions
 * work added the version a slot refers to onto the live `downloading` /
 * `installed` arms, and the collapse put those arms on v7.0 itself; this copy
 * is what stayed behind. Because the arms are plain (non-strict) `z.object`s
 * inside a discriminated union, a decode through this pre-image simply DROPS
 * the key it does not model - the same strip mechanism every downgrade bridge
 * in this file relies on.
 *
 * Do not add arms or fields here. Extend the live schema and let the next
 * `providers.list` major publish it.
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
//
// The single-slot `managedInstallState` above answers "what is the managed
// copy doing"; everything below answers "which managed versions exist on this
// machine, and what may the user do with them". Both ride v7.0 together; the
// v7->v6 bridge strips the whole group.
//
// Keyed by PACK, not by provider: one pack serves several providers (the
// opencode pack backs opencode/traycer/openrouter/huggingface), so every
// provider row on that pack carries the same `packId` and the same
// `managedVersions`, and clients render one shared panel from whichever row
// they have. Per-provider policy on a machine-shared cell would be
// self-contradictory - see the design's D5.

/**
 * Whether the registry channel still vouches for a version, and how.
 *
 * Four of the five are channel-head facts; `uncertified` is the odd one and
 * the easiest to erase, so it is spelled out here. It means the version is
 * INSTALLED ON DISK but the head no longer carries it - a build the user
 * already runs that has simply aged out of publication. It stays usable and
 * deletable and is NOT re-downloadable, which is exactly why it cannot be
 * folded into either neighbour: calling it `eligible` promises a fresh copy
 * the registry can no longer serve, and calling it `yanked` accuses the
 * publisher of a withdrawal that never happened (a yank is typically a
 * security pull and the UI says so). "No longer published" is a third thing.
 *
 * `yanked` rows can legitimately arrive with `sizeBytes: null` - a yank
 * tombstone outlives the assets it describes, so the head knows the version
 * was withdrawn without knowing how big it was.
 *
 * `below-security-floor` and `host-ineligible` are both hard blocks rather
 * than advice: the execute-time gate positively refuses those versions, so
 * offering a download would be offered-then-failed by construction (D2).
 */
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
 * Why an on-disk version dir cannot be served, derived from the host's
 * verification verdict layer (N5).
 *
 * `corrupt` and `unverified` are NOT synonyms and must not be merged. `corrupt`
 * is a DEFINITIVE verdict - the bytes were read and are known bad. `unverified`
 * is an INDETERMINATE one - the host could not reach a verdict at all (a
 * keyring blip, an `EACCES` on the dir), so the copy may be perfectly fine.
 * The host keeps the four-way verdict split deliberately; collapsing the
 * indeterminate case into the known-bad one tells a user their download is
 * damaged when the real fault is a transient permission or trust problem, and
 * points them at re-downloading 40 MB instead of at the actual cause.
 *
 * `condemned` is the terminal one: a persisted verdict that this build is
 * defective on this machine for good. It renders as a permanent failure row
 * with NO retry affordance - `providers.installPackVersion` refuses it.
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

/**
 * Per-version install state inside the version manager. Distinct from the
 * single-slot `providerManagedInstallStateSchema`: this one adds the
 * `unusable` arm, because a version dir can be present-but-unservable, which
 * the single slot has no way to say (it reports the CURRENT target, and a
 * target that cannot be served is simply not current).
 *
 * The `downloading` arm's nullable `percent` carries the same meaning as it
 * does on the single slot, and the same warning applies: a sibling host owning
 * the transfer reports `downloading` with `percent: null`, which is a
 * transient, self-resolving state and NOT a failure.
 */
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
  // Null for a yank tombstone whose assets the registry has already pruned -
  // the head remembers the withdrawal, not the size. Renderers must not print
  // "0 MB" for it.
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
  // Null = auto (follow the newest eligible). A pin may sit below the baked
  // pin (D1 as revised 2026-08-12): the RPC refuses only versions the signed
  // head positively rules out (`below-security-floor` / `host-ineligible`).
  // No ping-pong follows - target derivation consults the user pin before the
  // baked pin, and the forward-only current-walk governs only unpinned cells.
  pinnedVersion: z.string().nullable(),
  // Only ever non-null while auto-download is paused or a pin is set: with
  // auto-download on there is nothing to announce, since a newer eligible
  // version installs itself. Computed from the LAST DURABLY-SEEN channel head
  // rather than live knowledge, so it does not flap when head knowledge
  // expires or the host boots offline (D7).
  updateAvailable: z.object({ version: z.string() }).nullable(),
  // Other provider ids served by this same pack, so the panel can name the
  // sharing ("Shared by OpenCode, Traycer, OpenRouter, Hugging Face"). Excludes
  // the provider whose row carries it.
  //
  // `.catch([])` is load-bearing, not decoration: without it a single id this
  // client's enum does not know (a newer host, mid-rollout) throws, and because
  // the throw happens inside `managedVersions` the FIELD-level `.catch(null)`
  // swallows the entire version manager - panel gone, not one label missing.
  // Degrading to "shared with nobody" costs a sentence of copy instead.
  sharedWithProviders: z.array(providerIdSchema).catch([]),
  // Total on-disk footprint of this pack across every retained version. Packs
  // run 100-500 MB, and a panel that invites the user to keep versions without
  // showing the cost invites disk surprises. Null when the host cannot cheaply
  // size the cell.
  totalSizeBytes: z.number().int().nonnegative().nullable(),
  // Union of channel-head versions (>= the baked pin) and versions installed
  // on disk - see `certification` for how the two sources are distinguished.
  available: z.array(providerPackVersionSchema),
});
export type ProviderManagedVersions = z.infer<
  typeof providerManagedVersionsSchema
>;

/**
 * Frozen `providers.list@7.x` version-manager state: identical to the live
 * schema except `sharedWithProviders` is pinned to `providerIdSchemaV70`.
 *
 * This is the sub-schema freeze the `frozen-catalog-lines` fixture's own
 * instructions call for, and it is the second half of the v7.0 response
 * freeze. `providerCliStateBaseShapeV70` pins v7.0's KEY SET but deliberately
 * keeps live references for its leaf schemas, so the id enum reached the
 * already-released v7.0 wire THROUGH this one array - a host→client enum
 * addition at a released version, which the compat gate scores `breaking`.
 * Adding `reasonix` is what surfaced it: the deep dump went red on
 * `managedVersions.anyOf`, exactly as that fixture's comment predicted, and
 * the answer it prescribes is this freeze rather than a regenerate-to-green.
 *
 * The blast radius was real but narrow, which is worth stating so the next
 * reader does not conclude the freeze was ceremonial: `sharedWithProviders`
 * carries `.catch([])`, so a v7.0 client handed an unknown id degrades the
 * label to "shared with nobody" rather than throwing. Reasonix also ships its
 * own binary and joins no shared pack, so it can never actually appear here.
 * Neither fact is a reason to leave a released line tracking a growing enum -
 * the next id added may well be pack-sharing, and `.catch()` tolerance is
 * parse-time hardening, not a versioning mechanism.
 *
 * Do NOT widen this schema; extend the live one and let the next major
 * publish it.
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

/**
 * Why the version manager cannot be offered for a pack that HAS one.
 *
 * A null `managedVersions` used to be the whole story, and the panel simply
 * disappeared. That is indistinguishable from "this build has no version
 * manager" and left a user staring at a settings tab with nothing to act on
 * and nothing to read - the reported bug.
 *
 * The members are the host's real outcomes, taken from `RegistryKeyringState`
 * (`loaded | unconfigured | unavailable | unattempted`) plus the one gate that
 * is not a trust state, NOT from a guessed error table. Note that only
 * `unavailable` ever produced any user-visible signal before this; the other
 * two silent states are what a dev build actually hits.
 *
 * `packId === null` is deliberately NOT a member: a provider with no baked pin
 * has no managed pack at all, so there is nothing to explain and both this and
 * `managedVersions` stay null.
 */
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
 * What the NEXT execute for this provider would resolve to - not what is
 * "currently running", which the host cannot truthfully report for a provider
 * at all: live sessions pin their binary for life, so several different
 * binaries are legitimately in use at once (`versionVisibility` carries that
 * divergence separately).
 *
 * Computed host-side as a side-effect-free simulation of the execute chain
 * under observe-intent guarantees - no install kick, no holder-pin acquire, no
 * blocking version probes. It exists so the client stops INFERRING the answer:
 * the old client-side guess ("Running from PATH · installing managed copy")
 * was wrong for closure-coupled packs, which refuse a mismatched PATH copy at
 * execute time and silently serve the bundled inline build instead.
 *
 * `path`/`version` are nullable because the resolved candidate may have
 * neither a stable path (the bundled inline build) nor a cheaply-known version
 * - the simulation is explicitly forbidden from probing to find out.
 */
export const providerNextRunBinarySchema = z.object({
  kind: z.enum(["managed", "bundled", "path", "custom"]),
  path: z.string().nullable(),
  version: z.string().nullable(),
});
export type ProviderNextRunBinary = z.infer<typeof providerNextRunBinarySchema>;

/**
 * Host-aggregated, direction-free signal that other active sessions for this
 * provider are bound to a binary other than the one `nextRunBinary` names.
 *
 * Measured against `nextRunBinary`, NOT against `current`: the two coincide
 * whenever the managed copy is what the next run would use, and they diverge
 * exactly when it is not - an explicit PATH selection, or the bundled build
 * serving behind a refused closure-coupled PATH copy. In those cases `current`
 * is not what a new session will get, so counting against it would report
 * divergence from a binary nothing is about to run.
 *
 * Deliberately NOT a bare `pin !== current` boolean: holders legitimately
 * differ (each pins its candidate for its whole life), and a version rollback
 * can make `current` OLDER than a surviving pin - there is no "ahead/behind"
 * to report, only a count. Rollback-specific messaging belongs solely to the
 * `advisory` field below. `differingSessionCount: 0` and `null` both mean
 * "nothing to show" - the renderer never shows a toast for this, only a
 * quiet, self-correcting row indicator.
 *
 * The count is a FLOOR, not a census: the host's holder registry is
 * per-process while the pack store is shared by every host process on the
 * machine, so sessions on a sibling host are not counted. Nothing may decide a
 * destructive action from it.
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
 * Frozen `providers.list@7.0` snapshot of `providerLoginCapabilitySchema`:
 * `oauthArgs` + `token` + `codePaste` + `terminalLogin`. Same hand-copy
 * discipline as the `V10`/`V40` snapshots above - NOT derived from the live
 * capability.
 *
 * The V40 snapshot exists because the base shape it backs kept pointing at the
 * LIVE capability while its own keys were pinned, so `terminalLogin` reached
 * four already-frozen shapes. `providerCliStateBaseShapeV70Preimage` points here for
 * exactly that reason, one line later: the fifth capability field must not
 * appear on v7.0 just because it appears on the live schema.
 *
 * Do not add fields here. Extend the live `providerLoginCapabilitySchema` and
 * let the v7->v8 upgrade bridge fill the new field for old hosts, the way the
 * v6->v7 bridge fills `terminalLogin`.
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
  // Epoch-ms the last passive (live-turn) or active (on-demand probe) usage
  // read landed for this profile; null before any read. Lets the usage
  // popover badge a gauge as stale without a background poll - see the
  // decision log's "Usage data". Describes the age of the READING the host
  // holds, so a probe that failed transiently (timeout, connection, usage
  // fetch) does NOT advance it - it is not evidence that anything was read.
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
} as const;

export const providerProfileSchemaV70 = z.object(providerProfileShapeV70);

export const providerProfileSchema = z.object({
  ...providerProfileShapeV70,
  // Host-wide eligibility. Old supporting decoders treat an omitted legacy
  // field as enabled; older protocol lines omit disabled rows entirely.
  enabled: z.boolean().default(true).catch(true),
  // Copyable command for opening this managed account directly in its CLI.
  // The host owns the absolute config path and shell quoting; ambient rows and
  // hosts that predate this field omit it. Kept inside v8.0 because that line
  // is still the unreleased live head opened by profile eligibility.
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

/**
 * Tri-state enablement intent for a provider. `"on"` / `"off"` are sticky user
 * choices that ignore detection; `"auto"` (the default, and what an unset
 * provider means) derives enablement from whether the host passively detected
 * an account for it.
 *
 * Carried on `providers.list@7.1` rows, on `agent.gui.listHarnesses@7.1` rows,
 * and as the optional `mode` on `providers.setEnabled@2.2`. It never replaces
 * `enabled`, which stays the strict boolean EFFECTIVE value on every wire.
 */
export const providerEnablementModeSchema = z.enum(["auto", "on", "off"]);
export type ProviderEnablementMode = z.infer<
  typeof providerEnablementModeSchema
>;

/**
 * Why a provider in `"auto"` mode came out enabled or disabled, so the client
 * can render the derived outcome ("Auto · enabled — account detected") instead
 * of a bare toggle state.
 *
 * Deliberately COARSER than the host's own five-value source: the host's
 * `sticky-on`/`sticky-off` both collapse to `"sticky"` (the mode field already
 * says which), and its fail-open arm reports `"auto-detected"` - a fail-open
 * provider renders as enabled, and telling a user "no account detected" about
 * a provider Traycer just enabled would be a lie about a read error.
 */
export const providerEnablementSourceSchema = z.enum([
  "sticky",
  "auto-detected",
  "auto-undetected",
]);
export type ProviderEnablementSource = z.infer<
  typeof providerEnablementSourceSchema
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
  // ── v7.0 fields ────────────────────────────────────────────────────────
  // These three ride `providers.list@7.0` and up. They arrived on an unreleased
  // v8.0 that the release collapsed into v7.0. They are ABSENT from v6.0 and
  // below because `providerCliStateSchemaV60` is a plain `z.object` whose key
  // set does not model them, so the v7->v6 reparse drops them the way every
  // older bridge drops the keys its target never modelled.
  //
  // v7.0 and v7.1 no longer bind this shape: their hand-frozen pins sit below.
  // Growing THIS shape grows the v8.0 wire. The deep
  // `z.toJSONSchema` snapshot in `__tests__/__fixtures__/frozen-catalog-lines.ts`
  // pins both lines and turns red in a plain `bun run test` either way - when
  // it does, freeze the line that stopped being head, do not regenerate over
  // it.
  //
  // Which pack (if any) serves this provider's managed binary. Null means the
  // provider has no managed pack on this host - the store is unmanaged, or the
  // staged bundled -> managed rollout has not cut this provider over. It is
  // the join key for everything per-pack: providers sharing a pack report the
  // SAME `packId` and the same `managedVersions`, and the client renders one
  // shared panel rather than N panels that would each mutate the same cell.
  packId: z.string().nullable().catch(null).optional(),
  // The per-pack version manager - see `providerManagedVersionsSchema`. Null
  // whenever `packId` is null, and also when the host has a pack but no
  // channel knowledge to describe it with.
  managedVersions: providerManagedVersionsSchema
    .nullable()
    .catch(null)
    .optional(),
  // Why `managedVersions` is null, when the reason is worth showing. Carried
  // as a SIBLING rather than folded into `managedVersions` as a union member
  // on purpose: that field's `.catch(null)` exists to collapse the whole panel
  // on a parse error, and a union would let the same catch swallow the reason
  // too - reintroducing exactly the silence this field exists to remove.
  //
  // Both null is a real and correct combination: this provider has no managed
  // pack. When both are somehow non-null the panel wins, since a renderable
  // panel is strictly more useful than an explanation of its absence.
  managedVersionsUnavailable: providerManagedVersionsUnavailableSchema
    .nullable()
    .catch(null)
    .optional(),
  // What the next execute would resolve to - see `providerNextRunBinarySchema`.
  // Null when the host could not resolve any runnable binary, which is the
  // same condition `cliBinaryResolved: false` reports.
  nextRunBinary: providerNextRunBinarySchema.nullable().catch(null).optional(),
  // ── v7.1 fields (auth-aware enablement) ────────────────────────────────
  // The tri-state intent behind `enabled`, and why an `"auto"` provider came
  // out the way it did. `enabled` above is untouched and stays the strict
  // boolean EFFECTIVE value, so a client that ignores both fields behaves
  // exactly as it does today - which is the whole reason they are additive
  // rather than a reshaped `enabled`.
  //
  // No `.default()`: absent means "this host predates auto enablement", which
  // the client must be able to tell from any concrete value (it falls back to
  // the binary switch). A default would erase that.
  //
  // `.catch(undefined)` covers the DIFFERENT case a default would not: a value
  // that is PRESENT but from a newer host's wider enum. Without it, one
  // unrecognized member fails the whole `providers.list` response - nothing on
  // the path to the array element catches, so the client empties its entire
  // provider list over one field it could simply have ignored. Every sibling
  // enum on this shape already carries a catch for that reason
  // (`loginCapability`, `advisory`, `nextRunBinary`, `rateLimitStatus`).
  //
  // Version negotiation is supposed to make this unreachable - a newer host
  // downgrades to the negotiated minor - so this is defense in depth against
  // the bridge being wrong. That is not hypothetical: this very line's own
  // v7.1 rollout shipped two such bugs (released rows pinned over a live body;
  // `downgradeProviderCliStateToV10` missing these two fields, which made whole
  // rows vanish). Degrading to `undefined` lands the client on the old-host
  // path, which is a supported, tested state.
  enablementMode: providerEnablementModeSchema.optional().catch(undefined),
  enablementSource: providerEnablementSourceSchema.optional().catch(undefined),
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
 * Canonical (live) `providers.list` request. Optional `native` list/discover
 * query folds the mcp/plugins/skills list verbs onto this carrier. Callers on
 * any earlier line predate it, so the v6.0 -> v7.0 upgrade fills `native: null`
 * ("classic caller, no native query").
 *
 * `native` rides v7.0. It was authored against the live request object
 * while v6.0 was still unreleased, which silently grew the already-shipped
 * v4.0/v5.0/v6.0 request lines too; `host-v1.1.10` then froze those three
 * lines without it, because the commit that added it was not in the release
 * cherry-pick. Every line below v7.0 is pinned to
 * `providersListRequestSchemaBeforeV70` for that reason. v7.0 itself BINDS this
 * live schema (the release collapsed the unreleased v8.0 into it), so a request
 * field added here reaches the v7.0 wire immediately - it does not wait for a
 * new line. `providersListRequestSchemaV70` is the hand-frozen copy of that same
 * wire, and it keeps its `V70` name because it still earns it: the collapse
 * moved only the response, so the frozen request and this live one are the same
 * shape. It is not a contract pin - the contract binds this schema - but it is
 * a real freeze rather than a fixture.
 *
 * Nothing enforces that equality, which is the part to watch. Add a request
 * field here and v7.0's wire grows with it while the copy below does not,
 * turning `providersListRequestSchemaV70` into a name for a shape no line
 * serializes - exactly what the response side had to be renamed out of. See the
 * equality pin in `__tests__/provider-schemas-v70-pins.test.ts`.
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
 * Frozen `providers.list@7.0` request: the pre-v7.0 shape plus `native`, which
 * is the only field this line added. A hand-copy of the live request as it
 * stands on v7.0, not `.extend()`ed from
 * `providersListRequestSchemaBeforeV70` and not aliased to
 * `providersListRequestSchema` - the alias is precisely the arrangement that
 * grew v4.0/v5.0/v6.0 with `native`, and an `.extend()` inherits whatever the
 * base grows next.
 *
 * `nativeListQuerySchema` is still the LIVE query schema, and that is a
 * deliberate stop rather than an oversight: this pin freezes v7.0's own key
 * set, and growth INSIDE the native query is caught by the deep JSON-Schema
 * snapshot in `__tests__/__fixtures__/frozen-catalog-lines.ts` rather than
 * silently. Same for the live sub-schemas the response shape below keeps.
 */
export const providersListRequestSchemaV70 = z.object({
  forceAuthRefresh: z.boolean().optional(),
  native: nativeListQuerySchema.nullable().default(null),
});
export type ProvidersListRequestV70 = z.infer<
  typeof providersListRequestSchemaV70
>;

/**
 * Canonical (live) `providers.list` response. Always returns the classic
 * provider catalog; when the request carried a `native` query, `native` holds
 * the list/discover result (or a typed native error). Classic callers receive
 * `native: null`.
 *
 * v1.0 through v7.0 each have a hand-frozen response. v8.0 binds this live
 * schema, so new fields do not widen a released line.
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

// ── Historical v7.0 pre-image ─────────────────────────────────────────────
// This shape backs no wire contract. The v6 -> v7 upgrade uses it as a first
// normalization pass before filling the version-manager fields that shipped in
// v7.0. Its hand-copied key set and deep compatibility snapshot keep that
// historical upgrade stable while the live v8.0 shape grows.
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
  // `.optional()` on top of `.catch(null)` is copied deliberately, not
  // tidied away: it is what lets a host-side construction site omit the key
  // entirely, and dropping it here would turn "an old host omitted this" from
  // `undefined` into a parse failure. See the live shape's comments.
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
  // Hand-frozen since the live descriptor grew `modelProviders` (and its
  // `supportedTabs` member) past this line - the "hand-freeze the sub-schema
  // that grew" step the deep snapshot demands. The `.catch()` keeps the
  // pre-image default so this shape decodes byte-for-byte the way it did at
  // the freeze cut.
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

// ── Frozen protocol-v7.0 provider state + list response ────────────────────
//
// THE REAL v7.0 FREEZE, taken under the `V70` names `registry.ts` reserved for
// it, standing beside (not replacing) the `*V70Preimage` shapes above - those
// remain the v6 -> v7 bridge's first-pass target and the compat suites' v7-era
// shape. Do not collapse the two: they model different things. The pre-image
// is v7.0 BEFORE the version-manager group; this is v7.0 as it actually
// serializes, version-manager group included.
//
// Why it was taken now, and why the new enablement fields ride v7.1 rather
// than widening v7.0 in place: `registry.ts`'s head-line note licenses an
// UNRELEASED line to widen in place, and by `scripts/compat/support-floor.json`
// (`includeReleaseCandidates: false`) v7.0 is formally unreleased. That is a
// compat-FLOOR policy, not evidence that no peer speaks 7.0 -
// `cli-v1.2.0-rc.1` / `host-v1.2.0-rc.1` (2026-08-19) ship it. Widening in
// place would put two different shapes under one version number, which
// negotiation cannot detect and these strict-parsing schemas cannot tolerate:
// an rc peer that negotiated 7.0 and receives 7.1 keys can reject the whole
// response. Freezing here lets the v7.1 -> v7.0 contract parse strip the new
// keys honestly instead. Do not "simplify" this back to a widen-in-place.
//
// Like `providersListRequestSchemaV70`, this pin freezes v7.0's own KEY SET.
// Its profile leaf is also frozen because v8.0 adds profile eligibility there;
// the other live leaves remain guarded by the deep snapshot below.
// Growth inside any of those is caught by the deep `z.toJSONSchema` snapshot in
// `__tests__/__fixtures__/frozen-catalog-lines.ts`, which pins this shape - and
// when it goes red, hand-freeze the sub-schema that grew rather than
// regenerating the fixture.
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
  // The ONE leaf this shape does not keep live - see
  // `providerManagedVersionsSchemaV70`. Its `sharedWithProviders` array is a
  // host→client `providerId` enum, so leaving it live let every id added after
  // v7.0 shipped reach an already-released wire through this key.
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

// ── Frozen `providers.list@7.1` provider state + list response (pre-Reasonix)
//
// v7.1 is where the auth-aware enablement fields formally enter the major-7
// line. It is frozen here at the v7.0 PROVIDER ID SET even though no tag has
// shipped 7.1 yet, and that is the load-bearing part: a minor may not GROW A
// RESPONSE ENUM over its predecessor - `versioned-rpc.ts`'s
// projection-feasibility check refuses it outright - and v7.0 IS released, so
// no minor of major 7 can ever carry a provider id v7.0 lacks. Reasonix
// therefore opens 8.0 rather than riding 7.1.
//
// The refusal is protecting a real failure, not a formality. A 7.0 peer
// receives a 7.1 response through a within-major re-parse, which STRIPS
// unknown keys but REJECTS an unknown enum value - so a Reasonix ROW on 7.1
// would not degrade to "one provider missing", it would fail the whole
// `providers.list` response and empty that peer's provider list. Only a
// cross-major bridge can filter rows.
//
// Same key-set-only discipline as `providerCliStateBaseShapeV70` above: the
// leaf schemas stay live references and the deep `frozen-catalog-lines`
// snapshot is what catches growth inside them.
const providerCliStateBaseShapeV71 = {
  ...providerCliStateBaseShapeV70,
  enablementMode: providerEnablementModeSchema.optional().catch(undefined),
  enablementSource: providerEnablementSourceSchema.optional().catch(undefined),
};

export const providerCliStateSchemaV71 = z.object({
  providerId: providerIdSchemaV70,
  ...providerCliStateBaseShapeV71,
  auth: PROVIDER_AUTH_SCHEMA_V20,
  nativeCapabilities: providerNativeCapabilitiesSchema.catch(
    DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
  ),
});
export type ProviderCliStateV71 = z.infer<typeof providerCliStateSchemaV71>;

export const providersListResponseSchemaV71 = z.object({
  providers: z.array(providerCliStateSchemaV71),
  native: nativeListResultSchema.nullable().default(null),
});
export type ProvidersListResponseV71 = z.infer<
  typeof providersListResponseSchemaV71
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
  DEFAULT_PROVIDER_NATIVE_CAPABILITIES_V70_PREIMAGE,
  providerNativeCapabilitiesSchemaV70Preimage,
  type ProviderNativeCapabilities,
  type ProviderNativeCapabilitiesV70Preimage,
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

/**
 * `providers.setEnabled@2.2` request - adds the optional tri-state `mode` the
 * three-way Auto/On/Off settings control sends. `enabled` stays REQUIRED for
 * the reason 2.1's comment gives (demoting it would emit payloads a released
 * peer cannot parse); a 2.2 caller sends both, and the host takes `mode` as
 * authoritative when present, mapping `enabled` to on/off otherwise. So a 2.1
 * caller keeps exact binary semantics and needs no bridge fill - the 2.1 -> 2.2
 * upgrade is identity, with `mode` simply absent.
 *
 * WHY A NEW MINOR RATHER THAN `providers.nativeMutate`: the doctrine above
 * froze 2.1 and routes additions onto that method, but that doctrine is about
 * provider-NATIVE config pass-through (mcp/plugins/skills mutations that have
 * nothing to do with enablement and were only ever folded here for lack of a
 * carrier). `mode` is Traycer's own enablement semantic on the very method
 * that already owns enablement, and it is an additive optional REQUEST field,
 * which is exactly what a minor is for. Routing it through `nativeMutate`
 * would put enablement behind a native-config verb and leave `setEnabled`
 * unable to express the state it names.
 */
export const providersSetEnabledRequestSchemaV22 =
  providersSetEnabledRequestSchemaV21.extend({
    // Deliberately NO `.catch(undefined)`, unlike the response-side enablement
    // fields. This is a REQUEST: the host parses it, and swallowing an
    // unrecognized mode would silently rewrite what the user asked for -
    // `mode` absent falls back to the legacy `enabled` boolean, so a caller
    // that said "Auto" would be recorded as sticky on/off. Failing the call is
    // both honest and recoverable; a response degrades to a read-only display,
    // a request degrades to a WRONG WRITE. Fail loud here, fail soft there.
    mode: providerEnablementModeSchema.optional(),
  });
export type ProvidersSetEnabledRequestV22 = z.infer<
  typeof providersSetEnabledRequestSchemaV22
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

// ── Model providers (optional capability channel) ──────────────────────────
//
// Four dedicated methods for the Model Providers tab, registered with
// `degrade: { kind: "unsupported" }` exactly like the `providers.mcpAuth` trio
// above and for the same reason: they are new METHOD NAMES, so an older host
// fails them per call with upgrade guidance instead of failing the handshake.
//
// Dedicated methods rather than new arms on `providers.list`'s `native`
// carrier or on `providers.nativeMutate`. Both of those are released shapes,
// and both bake the MCP model into their payloads - `nativeListQuerySchema`
// carries a scope tuple every arm must answer, `nativeAuthActionSchema` a
// `serverName`. Upstream LLM credentials have neither: no project scope, no
// server. Widening those unions would grow a released wire shape (which the
// compat gate rejects) in order to model fields that are meaningless here.
//
// `result` is non-nullable on all four, matching the mcpAuth trio: these
// methods exist only to serve this surface, so "no payload" is not a reachable
// success state - the resolver answers with a result (including the typed
// `error` / `unsupported` arms) or throws.

/**
 * `providers.listModelProviders@1.0` request. `providerId` is the Traycer
 * provider whose settings tab is open - the `opencode` module today, and the
 * host gates the capability to it.
 */
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
 * `providers.awaitModelProviderAuth@1.0` request - a **bounded status poll**
 * (well under the 30s unary frame deadline), never a long poll. The host's
 * pending-auth registry owns concurrency and expiry.
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
 * `providers.cancelModelProviderAuth@1.0` response. `cancelled` reports
 * whether a pending attempt was actually found and torn down, distinct from
 * `result`, which describes the resulting auth state - cancelling an attempt
 * that already completed, expired or was superseded is `cancelled: false` with
 * a perfectly normal result. Same split as
 * `providersCancelMcpAuthResponseSchema`.
 *
 * Cancel is best-effort and LOCAL: upstream exposes no OAuth-cancel endpoint,
 * so this discards the pending attempt and releases its server lease. It never
 * claims to have revoked anything on the provider's side.
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

// ── v7.0: the four per-pack version-manager methods ────────────────────────
//
// Each is a BRAND-NEW METHOD NAME at `@1.0`, and `providers.ensurePack@1.0`
// above is left byte-identical. That split is deliberate and is not a style
// choice: a rename cannot be a version bump. `ensurePack` is a released method
// name, and a version bump on it would tell a peer "same method, richer shape"
// when the truth is "different method entirely" - while REMOVING the old name
// is fatal to the handshake for every peer that still lists it. New behaviour
// that is not the old method's behaviour gets a new name, and the new name
// rides the optional-capability channel (`degrade: { kind: "unsupported" }` in
// `registry.ts`) so a host predating it refuses these calls per-call with
// upgrade guidance instead of failing the whole connection.
//
// All four are keyed by `packId`, never by provider (D5): the store is
// machine-shared and one pack serves several providers, so a per-provider
// mutation would be one provider silently rewriting a cell three others read.
//
// TYPED RESULTS, not thrown errors, for the refusals a USER can act on -
// same `{ ok: true, … } | { ok: false, code, detail }` shape the native
// surface uses. The split is about who the message is for: a refusal the user
// can do something about (switch away from the current version first, pick a
// version at or above the floor) is a typed result the panel renders on the
// row it belongs to. A caller BUG or a host that has no install machinery at
// all is not - those throw, exactly as `providers.ensurePack` refuses rather
// than answering null. An unknown `packId` is in the second class.

/**
 * User-requested download of one specific version, installed into the
 * versioned store WITHOUT flipping `current` (the manager's download/flip
 * split exists for this call). Non-blocking, like `providers.ensurePack`:
 * returns the version's state as of the kick and never awaits the transfer.
 *
 * The refusal codes are one-per-producer-outcome; the reasoning for each, and
 * for why none of them may be folded into another, lives on the `code` enum in
 * `providersInstallPackVersionResultSchema` below.
 *
 * The distinction that drives the UI: `condemned` is TERMINAL - a persisted
 * verdict that this build is defective on this machine, so no retry can ever
 * succeed and the row must draw no retry affordance. `unfetchable` means the
 * registry has nothing to fetch for this version right now (head-pruned, or a
 * yank tombstone whose assets are gone); the bytes are missing, not broken, and
 * a later head refresh can legitimately change the answer. Rendering the first
 * as retryable is offered-then-failed forever; rendering the second as terminal
 * buries a version that may come back. The three certification refusals sit in
 * a third group again - not retryable, but not terminal either: they change if
 * the publisher raises the floor's ceiling or lifts a yank.
 *
 * NOT modelled here on purpose: a live SIBLING HOST already fetching these
 * bytes. That is `downloading` with a null percent on the version's
 * `installState`, never a refusal - the transfer is progressing, just not under
 * this host's control, and reporting it as an error would tell the user a
 * download broke while it is actively running on the same machine.
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
    // ONE MEMBER PER PRODUCER OUTCOME, deliberately. The host resolves a
    // user-picked version through `resolveUserPickedProviderPackTarget`, whose
    // result is a four-arm union that fans out to exactly these six refusals
    // (`refused` -> `invalid-version`; `ineligible` ->
    // `below-security-floor` / `host-ineligible` / `yanked`; plus
    // `unfetchable` and the terminal `condemned` verdict). Keeping the mapping
    // 1:1 is the point: it is total and mechanical, so no host author has to
    // pick a "closest fit" and no later reader has to reverse-engineer which
    // real outcome a collapsed code stood for. (`pin-below-floor` was the
    // seventh member until the 2026-08-12 D1 revision made below-pin versions
    // an ordinary, certification-gated offer.)
    //
    // The temptation was to fold the three `ineligible` reasons into
    // `unfetchable`. That is wrong on the facts and wrong in the copy it
    // produces. An ineligible version is DISALLOWED, not missing: its assets
    // usually exist and the host refuses to serve them, whereas `unfetchable`
    // means the registry has nothing to hand over (head-pruned, or a yank
    // tombstone that outlived its assets). Rendering "couldn't download" for
    // "below the publisher's security minimum" is precisely the
    // offered-then-failed copy D2 exists to remove - the user retries a
    // download that is refused by policy and can never succeed.
    //
    // Likewise `condemned` is not a spelling of any of these: it means the
    // bytes were digest-verified and only then found defective ON THIS
    // MACHINE, so it is terminal and must draw no retry affordance. Disallowed
    // and defective are different sentences to write.
    //
    // `below-security-floor` / `host-ineligible` / `yanked` reuse the
    // `providerPackVersionCertificationSchema` vocabulary on purpose, so a
    // renderer writes one copy string per certification and reuses it here
    // instead of parsing `detail` (which stays operator-facing, never primary
    // copy - same rule as every other typed error in this file).
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

/**
 * Delete one installed version's bytes.
 *
 * `deferred-locked` is the one member of this enum that is NOT a failure -
 * called out here the way `unrepairable` is called out on
 * `providerManagedInstallErrorReasonSchema`, and for the same reason: an enum
 * whose members are all read as "it broke" will be rendered that way. It means
 * the binary is locked right now (Windows, or a turnover-only pack), so the
 * delete was RECORDED and the boot GC pass will carry it out. The row says
 * "Removes when no longer in use". A renderer that draws it as an error tells
 * the user their delete failed when it is queued and will happen.
 *
 * The other three are genuine refusals with a user-visible next step:
 * `is-current` ("switch to another version first"), `holder-reserved` (a live
 * session pinned this dir for its whole life - it goes when that session
 * ends), `quarantine-reserved` (the host is holding the dir as evidence of a
 * failed verification).
 */
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
 * Pin this pack to a version, or clear the pin. `version: null` is the clear
 * ("use latest automatically"), which is why it is nullable rather than a
 * separate method - the two are one user-facing control.
 *
 * Setting a pin implies NOTIFY-ONLY for newer versions (D4): there is no
 * background pre-staging, so a pinned pack announces a new version and waits
 * for the user to ask, identical to the paused surface.
 *
 * A pin below the baked pin is honoured (D1 as revised 2026-08-12): target
 * derivation consults the user pin before the baked pin, so no flip-back
 * follows, and the only server-side bounds are the signed refusal facts
 * below - which must hold server-side because the UI is not the only caller
 * and a stale client can ask for anything.
 *
 * `below-security-floor` and `host-ineligible` are signed positive refusal
 * facts. Unlike a yanked or uncertified installed copy (D8), neither may
 * become this pack's durable pin or `current` binary, even for a stale client
 * that bypassed the panel's disabled affordance.
 *
 * `verification-failed` covers the D15 re-verification the flip performs
 * inside the install lock: the pin record is written FIRST (a crash between
 * pin and flip converges toward the pin on the next tick, which is safe), then
 * the target dir is re-verified before `current` moves. If that verification
 * fails the pin is rolled back, and the caller has to be told the difference
 * between "your pin was refused" and "your pin was accepted and then undone" -
 * otherwise the panel shows a pin that silently is not in force.
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
    // The pin as it now stands durably - null after a clear. Echoed rather
    // than assumed by the caller so a client that raced another host's write
    // re-renders the truth instead of its own optimistic guess.
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

/**
 * Set the per-pack auto-download policy. Default on, which is today's
 * behaviour (newest eligible auto-installs and, absent a pin, becomes
 * current). Off means a newer eligible version only NOTIFIES - the download
 * waits for the user.
 *
 * Turning it off does not soften the security floor: the floor is not advisory
 * (D2), so when it passes the installed current the managed lane stops serving
 * that copy whether or not auto-download is paused. The download waits for the
 * user; the consequence does not.
 *
 * No typed-error arm - there is no refusal a user can act on here. Writing the
 * policy either succeeds or the call throws (unknown pack, unwritable store),
 * which is the same division the block comment above draws.
 */
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
  // Widened the same way `profiles` is, and for the same reason: only the live
  // and v7.1 shapes carry the enablement pair, but every arm reaches
  // the strict v1.0 parse below, which strips them either way. Optional here so
  // an arm without them still satisfies the type while the destructure can
  // still name them.
  enablementMode?: ProviderCliState["enablementMode"];
  enablementSource?: ProviderCliState["enablementSource"];
  profiles?: ProviderCliState["profiles"] | ProviderCliStateV70["profiles"];
  // Widened to the pre-image capability shape as well as the live one for
  // the same reason `loginCapability` below is widened across its own frozen
  // snapshots: callers reach this function holding either shape, and the
  // strict v1.0 parse strips the field either way.
  nativeCapabilities?:
    ProviderNativeCapabilities | ProviderNativeCapabilitiesV70Preimage;
  // Widened to the live OR the pre-image union once the version-manager work
  // grew the live arms with `version`. `providersListDowngradeV7ToV1` feeds
  // this function pre-image rows, which no longer satisfy the live type - both
  // are
  // both fine here for the same reason the widened `loginCapability` below is:
  // the strict v1.0 parse discards this field either way. Without the
  // widening the v7->v1 bridge simply stops compiling, which is the good
  // outcome; the bad one would have been a shared type loose enough to hide it.
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
  // - `packId` / `managedVersions` / `managedVersionsUnavailable` /
  //   `nextRunBinary` (v7.0) — the version manager. Same trap, and it is worth
  //   restating rather than assuming the list above covers it: this parse is
  //   STRICT, so every field added to the live shape from here to the end of
  //   time must be added to this destructure too. Forgetting one does not
  //   fail loudly - it empties the provider list for v1.0 clients, silently,
  //   because the row fails the parse and the caller filters it out.
  // - `enablementMode` / `enablementSource` (v7.1) - the auth-aware enablement
  //   pair. They were in fact forgotten on the first pass and caught by a
  //   test, exactly as the paragraph above predicts: a row carrying either one
  //   did not lose the two fields, it disappeared. `enabled` still travels, and
  //   it already carries the EFFECTIVE value, so a v1.0 caller loses only the
  //   explanation of a boolean it was always going to read on its own terms.
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
    enablementMode: _enablementMode,
    enablementSource: _enablementSource,
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

/**
 * Lift a frozen v6.0 state onto the v7.0 PRE-IMAGE shape (not the live one).
 *
 * This is the v6 -> v7 hop's FIRST PASS, not the whole hop: the version-manager
 * fields land on top of what this returns, in the caller (see
 * `providersListUpgradeV6ToV7` in `registry.ts`). Pointing it at the live shape
 * instead would have the bridge emit whatever the live capability object
 * happens to be, which stays correct only while the two agree.
 * `DEFAULT_PROVIDER_NATIVE_CAPABILITIES_V70_PREIMAGE` is the same "old host
 * never had this feature" reading its live counterpart carries - a v6.0 host
 * advertised no native capabilities at all.
 */
export function upgradeProviderCliStateToV70Preimage(
  state:
    ProviderCliStateV20 | ProviderCliStateV30 | ProviderMutationCliStateV20,
): ProviderCliStateV70Preimage {
  return providerCliStateSchemaV70Preimage.parse({
    ...state,
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES_V70_PREIMAGE,
  });
}

export function upgradeProviderCliStateListToV70Preimage(
  states: readonly (
    ProviderCliStateV20 | ProviderCliStateV30 | ProviderMutationCliStateV20
  )[],
): ProviderCliStateV70Preimage[] {
  return states.map(upgradeProviderCliStateToV70Preimage);
}

/**
 * v7.0 clients cannot render disabled profiles safely. Omit those rows, then
 * reparse through the frozen v7.0 profile shape to strip `enabled` from the
 * remaining rows without disturbing the rest of the catalog.
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

export function downgradeProviderCliStateListToV71(
  states: readonly unknown[],
): ProviderCliStateV71[] {
  return states.flatMap((state) => {
    const current = parseProviderStateWithEnabledProfiles(state);
    if (current === null) return [];
    const parsed = providerCliStateSchemaV71.safeParse(current);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * Drop post-v6.0 providers (currently `huggingface`) for an already-shipped
 * v6.0 client, and strip the provider-pack-registry fields the frozen v6.0
 * state does not model. Same filter-by-reparse shape as the older bridges: an
 * entry whose id is not in the frozen v6.0 enum simply does not survive the
 * parse.
 */
export function downgradeProviderCliStateListToV60(
  states: readonly unknown[],
): ProviderCliStateV60[] {
  return states.flatMap((state) => {
    const parsed = providerCliStateSchemaV60.safeParse(state);
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

// The `providers.list` fills are `upgradeProviderCliStateToV70Preimage` /
// `...ListToV70Preimage`, named for their TARGET SHAPE rather than for
// "latest". A bridge aims at a fixed shape: the moment a v8.0 opens above v7.0,
// a fill named "latest" silently means a shape v7.0 cannot carry. What these
// two aim at is a stage INSIDE the v6 -> v7 hop rather than a line of its own,
// which is why they are named for the pre-image and not for v7.0 - the
// version-manager fill that finishes the hop runs after them. The latest-named
// fills below aim at the HEAD line and move with it.

/** Upgrade frozen list@2.0 / v3.0 state to latest by attaching the default descriptor. */
export function upgradeProviderCliStateToLatest(
  state:
    ProviderCliStateV20 | ProviderCliStateV30 | ProviderMutationCliStateV20,
): ProviderCliState {
  return providerCliStateSchema.parse({
    ...state,
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
  });
}

export function upgradeProviderCliStateListToLatest(
  states: readonly (
    ProviderCliStateV20 | ProviderCliStateV30 | ProviderMutationCliStateV20
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
