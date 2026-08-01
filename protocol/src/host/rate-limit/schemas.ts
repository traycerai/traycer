import { z } from "zod";
import {
  DEFAULT_ACCOUNT_CONTEXT,
  accountContextSchema,
} from "@traycer/protocol/common/schemas";
import {
  providerIdSchema,
  providerIdSchemaV40,
  providerIdSchemaV50,
  providerIdSchemaV60,
} from "@traycer/protocol/host/provider-schemas";

// `host.getRateLimitUsage` v1.0 request: no fields. Non-strict on purpose so a
// v1.1 client can Zod-strip its `accountContext` away when projecting the request
// onto this shape for a v1.0 host - a `.strict()` schema would *reject* the extra
// field instead of dropping it, breaking the minor downgrade. The shipped v1.0.0
// host parses the resulting `{}` identically (it never carried extra keys), so
// dropping `.strict()` here is invisible on the wire.
export const rateLimitUsageRequestSchemaV10 = z.object({});
export type RateLimitUsageRequestV10 = z.infer<
  typeof rateLimitUsageRequestSchemaV10
>;

// v1.1 request adds the selected account so usage reflects the active
// org/personal context. Added as a minor (NOT an in-place edit to v1.0) so a
// shipped v1.0.0 host still negotiates. Defaulted so a caller that omits it - and
// the v1.0 -> v1.1 upgrade path - resolves to the personal context.
export const rateLimitUsageRequestSchemaV11 =
  rateLimitUsageRequestSchemaV10.extend({
    accountContext: accountContextSchema.default(DEFAULT_ACCOUNT_CONTEXT),
  });
export type RateLimitUsageRequestV11 = z.infer<
  typeof rateLimitUsageRequestSchemaV11
>;

// Mirrors the aperture rate-limit shape defined in an internal shared package
// (not in this repo) - the aperture gRPC return shape the Traycer cloud
// backend maps straight onto this wire contract. Unchanged across v1.0 / v1.1.
export const rateLimitUsageResponseSchema = z.object({
  totalTokens: z.number(),
  remainingTokens: z.number(),
  retryAfter: z.number().optional(),
});
export type RateLimitUsageResponse = z.infer<
  typeof rateLimitUsageResponseSchema
>;

// v1.2 adds provider-account rate limits (Codex / Claude Code CLI), pulled
// on-demand for a specific provider rather than the Traycer-inference
// aperture the v1.0/v1.1 fields describe. Added as a minor (NOT an in-place
// edit to v1.1) so a shipped v1.1 host still negotiates: `providerId` is
// optional, so an unset field leaves today's aperture behavior unchanged.
//
// Also carries `profileId`: which of `providerId`'s logged-in profiles
// (subscriptions) to read usage for. `null` = the ambient/host login (or, on
// a host build that predates profiles, the only login there is). Added as a
// bare additive/defaulted field rather than another minor bump - it is safe
// in both directions (an old host ignores the extra key and answers with
// ambient-only usage; an old client's omitted key resolves to `null` here) -
// see the released-peer compat gate's "added optional properties are safe"
// rule.
export const rateLimitUsageRequestSchemaV12 =
  rateLimitUsageRequestSchemaV11.extend({
    providerId: providerIdSchema.optional(),
    profileId: z.string().nullable().default(null),
  });
export type RateLimitUsageRequestV12 = z.infer<
  typeof rateLimitUsageRequestSchemaV12
>;

// A normalized rolling rate-limit window, shared by every provider arm below.
// `resetsAt` is epoch-ms (each provider's native reset representation is
// normalized to this at the host boundary).
export const providerRateLimitWindowSchema = z.object({
  usedPercent: z.number(),
  resetsAt: z.number().nullable(),
  durationMinutes: z.number().nullable(),
});
export type ProviderRateLimitWindow = z.infer<
  typeof providerRateLimitWindowSchema
>;

// Single source of truth for "which providers report account rate limits": the
// available arms below tag on it, the host's reader dispatch narrows to it
// (exhaustively), and the GUI derives its `RateLimitProviderId` from it - so
// adding a provider is one edit the compiler propagates across all three.
export const rateLimitCapableProviderIdSchema = z.enum([
  "codex",
  "claude-code",
  "openrouter",
  "kilocode",
  "grok",
  "jcode",
]);
export type RateLimitCapableProviderId = z.infer<
  typeof rateLimitCapableProviderIdSchema
>;

const codexResetCreditsSchemaV20 = z.object({
  availableCount: z.number(),
});

const codexResetCreditsSchema = codexResetCreditsSchemaV20.extend({
  // Newer Codex app-server builds enrich the summary with individual
  // credits. `null` is the backward-compatible count-only response; an empty
  // array means the detail fetch completed with no rows. The backend may cap
  // this list, so it can be shorter than `availableCount`.
  credits: z
    .array(
      z.object({
        id: z.string().min(1),
        resetType: z.enum(["codexRateLimits", "unknown"]),
        status: z.enum(["available", "redeeming", "redeemed", "unknown"]),
        grantedAt: z.number(),
        expiresAt: z.number().nullable(),
        title: z.string().nullable(),
        description: z.string().nullable(),
      }),
    )
    .nullable()
    .default(null),
});

// Frozen Codex arm used by released host.getRateLimitUsage v1/v2 schemas.
// Per-credit details ship behind v3 so older clients never receive a new key.
const codexRateLimitsSchemaV20 = z.object({
  provider: z.literal(rateLimitCapableProviderIdSchema.enum.codex),
  available: z.literal(true),
  planType: z.string().nullable(),
  limitId: z.string().nullable(),
  limitName: z.string().nullable(),
  primary: providerRateLimitWindowSchema.nullable(),
  secondary: providerRateLimitWindowSchema.nullable(),
  extraWindows: z.array(
    z.object({
      limitId: z.string(),
      limitName: z.string().nullable(),
      primary: providerRateLimitWindowSchema.nullable(),
      secondary: providerRateLimitWindowSchema.nullable(),
    }),
  ),
  credits: z
    .object({
      hasCredits: z.boolean(),
      unlimited: z.boolean(),
      balance: z.string().nullable(),
    })
    .nullable(),
  individualLimit: z
    .object({
      limit: z.string(),
      used: z.string(),
      remainingPercent: z.number(),
      resetsAt: z.number(),
    })
    .nullable(),
  resetCredits: codexResetCreditsSchemaV20.nullable(),
  rateLimitReachedType: z.string().nullable(),
});

const codexRateLimitsSchema = codexRateLimitsSchemaV20.extend({
  resetCredits: codexResetCreditsSchema.nullable(),
});

// OpenRouter arm - httpFetch-class provider (a plain GET against OpenRouter's
// key/credits endpoints, no subprocess). Field names are a sketch, not yet
// verified against a live call - see the Tech Plan's "Open items".
const openRouterRateLimitsSchema = z.object({
  provider: z.literal(rateLimitCapableProviderIdSchema.enum.openrouter),
  available: z.literal(true),
  limit: z.number().nullable(),
  limitRemaining: z.number().nullable(),
  dailySpend: z.number().nullable(),
  weeklySpend: z.number().nullable(),
  monthlySpend: z.number().nullable(),
  totalCredits: z.number().nullable(),
  totalUsage: z.number().nullable(),
  balance: z.number().nullable(),
});

// Kilo Code arm - httpFetch-class provider (reads its own credential file,
// no subprocess). Field names are a sketch, not yet verified against a live
// call - see the Tech Plan's "Open items".
const kiloCodeRateLimitsSchema = z.object({
  provider: z.literal(rateLimitCapableProviderIdSchema.enum.kilocode),
  available: z.literal(true),
  creditBalance: z.number().nullable(),
  passState: z.string().nullable(),
});

const claudeCodeRateLimitsSchema = z.object({
  provider: z.literal(rateLimitCapableProviderIdSchema.enum["claude-code"]),
  available: z.literal(true),
  subscriptionType: z.string().nullable(),
  fiveHour: providerRateLimitWindowSchema.nullable(),
  sevenDay: providerRateLimitWindowSchema.nullable(),
  sevenDayOpus: providerRateLimitWindowSchema.nullable(),
  sevenDaySonnet: providerRateLimitWindowSchema.nullable(),
  modelScoped: z.array(
    z.object({ displayName: z.string() }).and(providerRateLimitWindowSchema),
  ),
  extraUsage: z
    .object({
      isEnabled: z.boolean(),
      monthlyLimit: z.number().nullable(),
      usedCredits: z.number().nullable(),
      utilization: z.number().nullable(),
    })
    .nullable(),
});

// Grok arm - ephemeral-CLI-class provider (usage is read over the vendored
// grok CLI's own `_x.ai/billing` ACP extension, so Traycer never touches the
// grok OAuth token), but the payload is billing-period/credit-shaped rather
// than rolling-window-shaped. Hybrid: a synthesized `period` window (so
// severity rollups, a2a `rateLimitStatus`, and GUI status logic reuse the
// shared window primitive with zero special-casing) plus the raw credit
// fields. Every payload-derived field is nullable: xAI omits fields freely by
// account type, and a zero-usage subscription reports only period + tier.
const grokRateLimitsSchema = z
  .object({
    provider: z.literal(rateLimitCapableProviderIdSchema.enum.grok),
    available: z.literal(true),
    subscriptionTier: z.string().nullable(),
    periodType: z.string().nullable(),
    periodStart: z.number().nullable(),
    periodEnd: z.number().nullable(),
    period: providerRateLimitWindowSchema.nullable(),
    monthlyLimit: z.number().nullable(),
    onDemandCap: z.number().nullable(),
    onDemandUsed: z.number().nullable(),
    prepaidBalance: z.number().nullable(),
  })
  .superRefine((value, ctx) => {
    // `period.resetsAt` and `periodEnd` denote the same instant by
    // construction - the host synthesizes the window's reset FROM the period
    // end. The redundancy is deliberate: `periodEnd` is kept as its own field
    // so the billing-period bounds survive a period-less, unmeasured snapshot
    // (`period` is null and only `periodEnd` carries the end). Enforce that
    // invariant at the wire boundary so a measured period can never omit or
    // disagree with the known reset instant.
    if (
      value.periodEnd !== null &&
      value.period !== null &&
      value.period.resetsAt !== value.periodEnd
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "grok period.resetsAt must equal periodEnd when period is set",
        path: ["period", "resetsAt"],
      });
    }
  });

// JCode arm - meta-harness, and the only arm in this union that is a LIST.
// `jcode usage --json` fans out to a real upstream quota call PER CONNECTED
// SUB-PROVIDER (OpenRouter `GET /api/v1/key` + `/credits`, plus dedicated
// fetchers for Anthropic, OpenAI, Copilot, Antigravity, Gemini and Cursor), so
// one jcode account routinely reports several independent quotas at once.
// There is no single number that is honestly "the jcode quota", so this arm
// refuses to synthesize one: it carries the per-sub-provider rows and lets the
// shared severity rollup fold them, exactly the way claude-code's model-scoped
// windows already fold (`FamilyScopedWindow` in the host's
// `rate-limit-gauge-cache.ts` is a LIST of windows per provider - no new
// primitive is needed for this).
const jcodeSubProviderRateLimitSchema = z.object({
  // jcode's own sub-provider key ("openrouter", "anthropic", "copilot", ...).
  // Deliberately a bare string rather than a Traycer `ProviderId`: this
  // namespace is jcode's, overlaps ours only by coincidence, and grows on
  // jcode's release cadence - the same reason a provider's own plan/limit
  // tokens stay bare strings elsewhere in this file. Constraining it would
  // make every new jcode sub-provider a protocol change.
  subProviderId: z.string(),
  // jcode's own `limits[].name` ("Credits", "Weekly", ...). ONE sub-provider
  // can report SEVERAL independent quotas, each becoming its own row here, so
  // `subProviderId` is not a key and is not a sufficient label: without this
  // field two Copilot rows are indistinguishable in the UI and collide as
  // React keys. `null` when jcode omits the name - unnamed, not unlabelled by
  // choice.
  limitName: z.string().nullable(),
  // Normalized rolling window. `usedPercent` is jcode's `usage_percent`, which
  // is percent CONSUMED (verified upstream: 15990.63/16053.68 = 99.607%), so it
  // maps onto the shared window primitive with no inversion. `resetsAt` is
  // jcode's `resets_at`, which upstream populates ONLY for Antigravity and
  // Copilot - every other fetcher passes `None` - so `null` here means "not
  // reported", NOT "never resets". `null` for the whole window means this
  // sub-provider reported no measurable quota.
  window: providerRateLimitWindowSchema.nullable(),
  // jcode COMPUTES `hard_limit_reached` upstream but does not serialize it, so
  // the host derives it (`usedPercent >= 100`). Carried explicitly rather than
  // re-derived per consumer so the derivation stays at the host boundary with
  // the rest of the normalization - and so a future upstream build that DOES
  // serialize it can be honoured without changing consumers.
  hardLimitReached: z.boolean(),
  // Per-sub-provider failure text from jcode's own `error` field. Non-null
  // distinguishes "this sub-provider's quota fetch failed" from "this
  // sub-provider has no quota to report" - both yield `window: null`, and a
  // partial failure must not read as a healthy zero.
  error: z.string().nullable(),
});

const jcodeRateLimitsSchema = z.object({
  provider: z.literal(rateLimitCapableProviderIdSchema.enum.jcode),
  available: z.literal(true),
  // Empty when no connected sub-provider reports quota. Still `available: true`:
  // the query itself succeeded and "nothing to show" is a different answer from
  // the `available: false` arm's "could not ask".
  subProviders: z.array(jcodeSubProviderRateLimitSchema),
});

// Closed, Traycer-owned set of reasons a provider pull can fail to report
// rate limits - unlike a provider's own plan/reached-type tokens (owned by
// that provider, legitimately forward-compat as a bare string), every one of
// these is emitted by `traycer-host` itself and ships atomically with this
// schema, so there's no cross-version drift risk in constraining it. Enforces
// the host's `unavailableRateLimits` call sites and the GUI's display-label
// map stay exhaustive at compile time instead of silently drifting.
//
// Frozen as the v1 wire enum (8 values) - the still-installed
// `host.getRateLimitUsage@1.2` response schema keeps referencing this exact
// export, unwidened (see `providerRateLimitsSchemaV1` below). `usage_fetch_failed`
// (v2, below) is a new enum *value*, and the within-major skew handler is
// key-strip only - it can't strip a value the way it strips an extra object
// key - so the new value has to travel behind an explicit major bump
// (`host.getRateLimitUsage@2.0`) with a downgrade bridge, instead of an
// in-place edit here. Widening this enum in place would make the v1.2
// contract accept and forward the new value straight through to an old GUI
// whose baked schema only knows these eight.
export const rateLimitUnavailableReasonSchemaV1 = z.enum([
  "cli_not_found",
  "unsupported_provider",
  "invalid_response",
  "timeout",
  "connection_failed",
  "rate_limits_not_available",
  "sdk_incompatible",
  "insufficient_permissions",
]);
export type RateLimitUnavailableReasonV1 = z.infer<
  typeof rateLimitUnavailableReasonSchemaV1
>;

// v2 adds `usage_fetch_failed`: the CLI's usage HTTP fetch failed (timeout,
// a 401 with a failed token refresh, an unseeded 429, an empty body) - a
// transient fetch problem, distinct from `rate_limits_not_available`, which
// is an account/auth *capability* problem (API-key auth, not logged in,
// missing scopes, creds not loaded when asked). The latest-type export
// (`RateLimitUnavailableReason` below) tracks this v2 enum, so host + GUI
// code gets the new value from the default import path; a
// `host.getRateLimitUsage@1.2` caller keeps seeing only the frozen v1 enum,
// via the downgrade bridge in `rate-limit/contracts.ts`.
export const rateLimitUnavailableReasonSchemaV2 = z.enum([
  "cli_not_found",
  "unsupported_provider",
  "invalid_response",
  "timeout",
  "connection_failed",
  "rate_limits_not_available",
  "sdk_incompatible",
  "insufficient_permissions",
  "usage_fetch_failed",
]);
export type RateLimitUnavailableReason = z.infer<
  typeof rateLimitUnavailableReasonSchemaV2
>;

// Any provider/auth combination that can't report rate limits. Its
// `provider` field ranges over the full `providerIdSchema` enum, which
// overlaps the literal `"codex"` / `"claude-code"` values the two arms above
// use as their tag - that overlap is why the unions below are plain
// `z.union`s, not `z.discriminatedUnion`s. `discriminatedUnion` requires
// every arm's discriminator value to be unique; two arms claiming `"codex"`
// (one via `z.literal`, one via this enum) makes Zod throw a raw
// (non-ZodError) "Duplicate discriminator value" error the first time the
// schema is parsed, which `safeParse` can't catch.
//
// Two versions of this arm exist for the same reason the reason enum above
// is split: `unavailableProviderRateLimitsSchemaV1` tags `reason` with the
// frozen v1 enum (feeds `providerRateLimitsSchemaV1`, which only the v1.2
// response uses); `unavailableProviderRateLimitsSchemaV2` tags it with the
// v2 enum (shared by the frozen v2 response and the latest v3 response).
const unavailableProviderRateLimitsSchemaV1 = z.object({
  provider: providerIdSchema,
  available: z.literal(false),
  reason: rateLimitUnavailableReasonSchemaV1,
});

const unavailableProviderRateLimitsSchemaV2 = z.object({
  provider: providerIdSchema,
  available: z.literal(false),
  reason: rateLimitUnavailableReasonSchemaV2,
});

// Provider-tagged union of account rate-limit snapshots, frozen at the v1
// reason enum. Feeds `rateLimitUsageResponseSchemaV12` only, so the
// still-installed v1.2 response schema keeps rejecting `usage_fetch_failed`.
export const providerRateLimitsSchemaV1 = z.union([
  codexRateLimitsSchemaV20,
  claudeCodeRateLimitsSchema,
  openRouterRateLimitsSchema,
  kiloCodeRateLimitsSchema,
  unavailableProviderRateLimitsSchemaV1,
]);
export type ProviderRateLimitsV1 = z.infer<typeof providerRateLimitsSchemaV1>;

// Frozen v2 provider union: v2 adds the usage-fetch reason but retains the
// count-only Codex reset-credit shape released at this wire version.
export const providerRateLimitsSchemaV2 = z.union([
  codexRateLimitsSchemaV20,
  claudeCodeRateLimitsSchema,
  openRouterRateLimitsSchema,
  kiloCodeRateLimitsSchema,
  unavailableProviderRateLimitsSchemaV2,
]);

// Frozen v2.1 provider union - a byte-for-byte snapshot of the live union as
// shipped in `rateLimitUsageResponseSchemaV21` (host.getRateLimitUsage@2.1):
// codex-with-per-credit-detail + claude-code + openrouter + kilocode +
// unavailableV2, WITHOUT the grok arm. Feeds `rateLimitUsageResponseSchemaV21`
// only, so that already-shipped v2.1 response never silently grows when the
// live union below gains grok. New available arms travel behind a new major
// (`host.getRateLimitUsage@3.0`) with a downgrade bridge, never an in-place
// edit here. Do NOT widen this schema.
export const providerRateLimitsSchemaV21 = z.union([
  codexRateLimitsSchema,
  claudeCodeRateLimitsSchema,
  openRouterRateLimitsSchema,
  kiloCodeRateLimitsSchema,
  unavailableProviderRateLimitsSchemaV2,
]);
export type ProviderRateLimitsV21 = z.infer<typeof providerRateLimitsSchemaV21>;

/**
 * Frozen v3.0 provider union - the frozen v2.1 union plus the grok available
 * arm, i.e. a byte-for-byte snapshot of the union as shipped in
 * `rateLimitUsageResponseSchemaV30` (`host.getRateLimitUsage@3.0`).
 *
 * That line IS released: `host-v1.1.9` (tagged 2026-07-29) shipped it, and it
 * pointed at the LIVE union until this pin - so the jcode available arm would
 * have landed on an already-released response. Same defect the v2.1 pin exists
 * to stop, one major later. New available arms travel behind a new major
 * (`host.getRateLimitUsage@4.0`) with a downgrade bridge, never an in-place
 * edit here. Do NOT widen this schema.
 */
export const providerRateLimitsSchemaV30 = z.union([
  codexRateLimitsSchema,
  claudeCodeRateLimitsSchema,
  openRouterRateLimitsSchema,
  kiloCodeRateLimitsSchema,
  grokRateLimitsSchema,
  unavailableProviderRateLimitsSchemaV2,
]);
export type ProviderRateLimitsV30 = z.infer<typeof providerRateLimitsSchemaV30>;

// Latest provider union: identical to the frozen v3.0 union above plus the
// jcode available arm. Feeds the v4.0 host response and the unreleased,
// still-growing a2a `agent.getProviderProfileRateLimits@4.0`.
export const providerRateLimitsSchema = z.union([
  codexRateLimitsSchema,
  claudeCodeRateLimitsSchema,
  openRouterRateLimitsSchema,
  kiloCodeRateLimitsSchema,
  grokRateLimitsSchema,
  jcodeRateLimitsSchema,
  unavailableProviderRateLimitsSchemaV2,
]);
export type ProviderRateLimits = z.infer<typeof providerRateLimitsSchema>;

// Single home for the grok available -> unavailable degrade every downgrade
// bridge below the v3.0 line applies. A grok-available snapshot has no
// representation in any frozen provider union (grok was not a rate-limit-capable
// provider then), so it degrades to the unavailable `unsupported_provider` shape
// - the exact row a pre-grok host returns for grok today. `"grok"` is in every
// frozen `provider` enum (it predates Hermes/omp), so the result reparses cleanly
// through the older union. Any other snapshot (or `null`) passes through
// unchanged. Shared by the `host.getRateLimitUsage` 3 -> 2 / 3 -> 1 bridges
// (`rate-limit/contracts.ts`) and the a2a `agent.getProviderProfileRateLimits`
// v2 -> v1 bridge (`agent/profiles.ts`).
export function mapGrokAvailableToUnavailable(
  providerRateLimits: ProviderRateLimits | null,
): ProviderRateLimits | null {
  if (
    providerRateLimits !== null &&
    providerRateLimits.available &&
    providerRateLimits.provider === "grok"
  ) {
    return {
      provider: "grok",
      available: false,
      reason: "unsupported_provider",
    };
  }
  return providerRateLimits;
}

/**
 * The jcode counterpart of {@link mapGrokAvailableToUnavailable}, and the
 * reason it is a SEPARATE function rather than a widened one: the two degrade
 * into different frozen unions and only one of them can survive there.
 *
 * `"grok"` is a member of every frozen `provider` enum (it predates
 * Hermes/omp/jcode), so a degraded grok row reparses cleanly through any older
 * union. `"jcode"` is in NONE of them. So this degrade is only meaningful for
 * the `host.getRateLimitUsage` line, whose frozen unavailable arms carry the
 * LIVE `providerIdSchema` and whose growing `**.provider.enum` is a recorded,
 * catalog-gated exception (`compat-exceptions.json`) - a v3.0 client only ever
 * asks about a provider it already has configured, so it never receives this
 * row at all. On `agent.getProviderProfileRateLimits` the frozen unions pin
 * `providerIdSchemaV40/V50/V60`, so a jcode read stays unrepresentable and
 * those bridges must keep failing closed instead of calling this.
 *
 * Any other snapshot (or `null`) passes through unchanged.
 */
export function mapJcodeAvailableToUnavailable(
  providerRateLimits: ProviderRateLimits | null,
): ProviderRateLimits | null {
  if (
    providerRateLimits !== null &&
    providerRateLimits.available &&
    providerRateLimits.provider === "jcode"
  ) {
    return {
      provider: "jcode",
      available: false,
      reason: "unsupported_provider",
    };
  }
  return providerRateLimits;
}

// Frozen pre-Hermes unavailable arm: same v2 reason enum, but `provider` is
// pinned to `providerIdSchemaV40` (the harness/provider id set as shipped in
// host-v1.1.7, before Hermes/omp) so an already-shipped
// `agent.getProviderProfileRateLimits@1.0` caller's strict decode never sees a
// post-v4.0 `provider` (`"hermes"`, `"omp"`) in the `available: false` arm.
const unavailableProviderRateLimitsSchemaV40 = z.object({
  provider: providerIdSchemaV40,
  available: z.literal(false),
  reason: rateLimitUnavailableReasonSchemaV2,
});

/**
 * Frozen pre-Hermes provider union - identical to the latest `providerRateLimitsSchema`
 * except the `available: false` arm's `provider` is pinned to `providerIdSchemaV40`.
 * Feeds only `agent.getProviderProfileRateLimits@1.0`'s frozen response (see
 * `host/agent/profiles.ts`) so that already-shipped v1.0 line never receives a
 * post-v4.0 provider id (Hermes, omp); the v2.0 line of that method carries
 * them via the live `providerRateLimitsSchema` above, with a v2->v1 downgrade
 * bridge that fails closed for such a rate-limit read instead of silently
 * mis-decoding it. Do NOT widen this schema - extend the latest schema and use
 * that v2 bridge instead.
 */
export const providerRateLimitsSchemaV40 = z.union([
  codexRateLimitsSchema,
  claudeCodeRateLimitsSchema,
  openRouterRateLimitsSchema,
  kiloCodeRateLimitsSchema,
  unavailableProviderRateLimitsSchemaV40,
]);
export type ProviderRateLimitsV40 = z.infer<typeof providerRateLimitsSchemaV40>;

// Frozen pre-omp unavailable arm: same v2 reason enum, but `provider` is
// pinned to `providerIdSchemaV50` (the provider id set as shipped in
// cli-v1.1.8 / host-v1.1.8, with Hermes and before omp) so an already-shipped
// `agent.getProviderProfileRateLimits@2.0` caller's strict decode never sees
// `"omp"` in the `available: false` arm.
const unavailableProviderRateLimitsSchemaV50 = z.object({
  provider: providerIdSchemaV50,
  available: z.literal(false),
  reason: rateLimitUnavailableReasonSchemaV2,
});

/**
 * Frozen pre-omp provider union - identical to the latest
 * `providerRateLimitsSchema` except the `available: false` arm's `provider` is
 * pinned to `providerIdSchemaV50`. Unlike the v4.0 union above this one KEEPS
 * the grok available arm: grok rate limits shipped before the v1.1.8 tags, so
 * the released v2.0 line really does carry that arm and dropping it here would
 * narrow an already-shipped contract.
 *
 * Feeds only `agent.getProviderProfileRateLimits@2.0`'s frozen response (see
 * `host/agent/profiles.ts`) so that released line never receives `omp`; the
 * v3.0 line carries it via the live `providerRateLimitsSchema` above, with a
 * v3->v2 downgrade bridge that fails closed for such a rate-limit read instead
 * of silently mis-decoding it. Do NOT widen this schema - extend the latest
 * schema and use that v3 bridge instead.
 */
export const providerRateLimitsSchemaV50 = z.union([
  codexRateLimitsSchema,
  claudeCodeRateLimitsSchema,
  openRouterRateLimitsSchema,
  kiloCodeRateLimitsSchema,
  grokRateLimitsSchema,
  unavailableProviderRateLimitsSchemaV50,
]);
export type ProviderRateLimitsV50 = z.infer<typeof providerRateLimitsSchemaV50>;

// Frozen pre-jcode unavailable arm: same v2 reason enum, but `provider` is
// pinned to `providerIdSchemaV60` (the provider id set as shipped in
// cli-v1.1.9 / host-v1.1.9, with omp and before jcode) so an already-shipped
// `agent.getProviderProfileRateLimits@3.0` caller's strict decode never sees
// `"jcode"` in the `available: false` arm.
const unavailableProviderRateLimitsSchemaV60 = z.object({
  provider: providerIdSchemaV60,
  available: z.literal(false),
  reason: rateLimitUnavailableReasonSchemaV2,
});

/**
 * Frozen pre-jcode provider union - identical to the latest
 * `providerRateLimitsSchema` except the `available: false` arm's `provider` is
 * pinned to `providerIdSchemaV60`. Like the v5.0 union it KEEPS the grok
 * available arm; the v1.1.9 tags shipped that arm, so dropping it here would
 * narrow an already-shipped contract.
 *
 * Feeds only `agent.getProviderProfileRateLimits@3.0`'s frozen response (see
 * `host/agent/profiles.ts`). That line IS released (v1.1.9) but still pointed
 * at the LIVE `providerRateLimitsSchema` until this repair, so it absorbed
 * every provider id added afterwards - the same defect one version earlier let
 * `omp` ride v2.0. The v4.0 line carries jcode via the live union, with a
 * v4->v3 downgrade bridge that fails closed for such a rate-limit read instead
 * of silently mis-decoding it. Do NOT widen this schema - extend the latest
 * schema and use that v4 bridge instead.
 */
export const providerRateLimitsSchemaV60 = z.union([
  codexRateLimitsSchema,
  claudeCodeRateLimitsSchema,
  openRouterRateLimitsSchema,
  kiloCodeRateLimitsSchema,
  grokRateLimitsSchema,
  unavailableProviderRateLimitsSchemaV60,
]);
export type ProviderRateLimitsV60 = z.infer<typeof providerRateLimitsSchemaV60>;

// v1.2 response = v1.0/v1.1 flat aperture fields (unchanged) + a nullable
// provider-account snapshot, frozen at the v1 reason enum (see
// `providerRateLimitsSchemaV1` above). Null both when the request didn't ask
// for a provider (aperture calls) and when a v1.1 host answers a v1.2
// request (see the v1.1 -> v1.2 upgrade path).
export const rateLimitUsageResponseSchemaV12 =
  rateLimitUsageResponseSchema.extend({
    providerRateLimits: providerRateLimitsSchemaV1.nullable(),
  });
export type RateLimitUsageResponseV12 = z.infer<
  typeof rateLimitUsageResponseSchemaV12
>;

// v2.0 response - identical to v1.2 except the provider-account snapshot's
// unavailable arm ranges over the v2 reason enum (adds `usage_fetch_failed`).
// The request shape is unchanged from v1.2 (`accountContext` + optional
// `providerId`), so `hostGetRateLimitUsageV20` in `contracts.ts` reuses
// `rateLimitUsageRequestSchemaV12` directly instead of defining a new request
// schema here.
export const rateLimitUsageResponseSchemaV20 =
  rateLimitUsageResponseSchema.extend({
    providerRateLimits: providerRateLimitsSchemaV2.nullable(),
  });
export type RateLimitUsageResponseV20 = z.infer<
  typeof rateLimitUsageResponseSchemaV20
>;

// v2.1 adds capped per-credit Codex reset detail. The request and unavailable
// reason set remain unchanged from v2.0. Released v2.0 stays frozen; the RPC
// handler projects a canonical v2.1 response through the v2.0 schema for an
// older caller, stripping the additive detail. Pinned to the frozen
// `providerRateLimitsSchemaV21` (NOT the live union) so the grok arm added to
// the live union never reaches this shipped response - grok travels on the
// v3.0 line below.
export const rateLimitUsageResponseSchemaV21 =
  rateLimitUsageResponseSchema.extend({
    providerRateLimits: providerRateLimitsSchemaV21.nullable(),
  });
export type RateLimitUsageResponseV21 = z.infer<
  typeof rateLimitUsageResponseSchemaV21
>;

// v3.0 response - identical to v2.1 except the provider-account snapshot adds
// the grok available arm. The request shape is unchanged from v1.2/v2.x, so
// `hostGetRateLimitUsageV30` in `contracts.ts` reuses
// `rateLimitUsageRequestSchemaV12` directly. Shipped as a new major (not a v2.2
// minor) because a new available union arm is not strippable by the
// within-major skew handler - an old peer's frozen union has no grok arm - so
// it needs an explicit downgrade bridge that degrades a grok-available snapshot
// to the unavailable `unsupported_provider` shape.
//
// Pinned to the frozen `providerRateLimitsSchemaV30` (NOT the live union):
// `host-v1.1.9` shipped this line, and it pointed at the live union until that
// pin, so the jcode arm added below would have grown an already-released
// response. jcode travels on the v4.0 line.
export const rateLimitUsageResponseSchemaV30 =
  rateLimitUsageResponseSchema.extend({
    providerRateLimits: providerRateLimitsSchemaV30.nullable(),
  });
export type RateLimitUsageResponseV30 = z.infer<
  typeof rateLimitUsageResponseSchemaV30
>;

// v4.0 response - identical to v3.0 except the provider-account snapshot ranges
// over the live `providerRateLimitsSchema`, which adds the jcode available arm.
// Same reasoning as the v2.1 -> v3.0 bump: a new available union arm is not
// strippable within a major, so it needs an explicit bridge that degrades a
// jcode-available snapshot to the unavailable `unsupported_provider` shape.
export const rateLimitUsageResponseSchemaV40 =
  rateLimitUsageResponseSchema.extend({
    providerRateLimits: providerRateLimitsSchema.nullable(),
  });
export type RateLimitUsageResponseV40 = z.infer<
  typeof rateLimitUsageResponseSchemaV40
>;

/**
 * Uses one of Codex's account-level manual rate-limit reset credits for the
 * selected profile. The idempotency key is generated once by the GUI for a
 * confirmation attempt and reused by the transport if that request is retried.
 */
export const providersConsumeRateLimitResetCreditRequestSchema = z.object({
  providerId: z.literal("codex"),
  profileId: z.string().nullable(),
  idempotencyKey: z.string().min(1),
  // `null` preserves the count-only/older-Codex fallback where the backend
  // chooses a credit. A concrete id targets the earliest-expiring available
  // credit selected by the GUI.
  creditId: z.string().min(1).nullable().default(null),
});
export type ProvidersConsumeRateLimitResetCreditRequest = z.infer<
  typeof providersConsumeRateLimitResetCreditRequestSchema
>;

export const codexRateLimitResetOutcomeSchema = z.enum([
  "reset",
  "nothingToReset",
  "noCredit",
  "alreadyRedeemed",
]);
export type CodexRateLimitResetOutcome = z.infer<
  typeof codexRateLimitResetOutcomeSchema
>;

export const providersConsumeRateLimitResetCreditResponseSchema = z.object({
  outcome: codexRateLimitResetOutcomeSchema,
});
export type ProvidersConsumeRateLimitResetCreditResponse = z.infer<
  typeof providersConsumeRateLimitResetCreditResponseSchema
>;
