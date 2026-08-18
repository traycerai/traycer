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
  "huggingface",
  "opencode",
  "cursor",
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

// Hugging Face arm - httpFetch-class provider (a plain GET against
// `huggingface.co/api/settings/billing/usage-v2` with the personal token, no
// subprocess). A CREDIT provider, not a windowed one: HF reports money, never a
// percentage of a rolling window, so `providerRateLimitWindows` returns [] for
// it exactly as it does for openrouter.
//
// Every field is nullable except `usedUsd` because the endpoint is
// OpenAPI-listed but schema-less, and the two allowance fields genuinely do not
// exist for every account: an account with no included allowance and no spend
// limit reports usage alone. `remainingIncludedUsd` / `remainingLimitUsd` are
// therefore only derivable when their base is present, and the host sends null
// rather than a misleading zero. Values are USD floats - the wire carries
// nano-USD integers and the host divides, so no consumer has to know the unit.
const huggingFaceRateLimitsSchema = z.object({
  provider: z.literal(rateLimitCapableProviderIdSchema.enum.huggingface),
  available: z.literal(true),
  includedUsd: z.number().nullable(),
  usedUsd: z.number(),
  remainingIncludedUsd: z.number().nullable(),
  limitUsd: z.number().nullable(),
  remainingLimitUsd: z.number().nullable(),
  numRequests: z.number().nullable(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
});

const openCodeGoWindowSchema = providerRateLimitWindowSchema.extend({
  status: z.enum(["ok", "rate-limited"]),
});

const openCodeRateLimitsSchema = z.object({
  provider: z.literal(rateLimitCapableProviderIdSchema.enum.opencode),
  available: z.literal(true),
  // Opaque renderer-cache epoch. The credential fingerprint never leaves the
  // host; this random generation only prevents retaining another key's usage.
  credentialGeneration: z.string().min(1),
  fiveHour: openCodeGoWindowSchema,
  weekly: openCodeGoWindowSchema,
  monthly: openCodeGoWindowSchema,
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

// Cursor arm - httpFetch-class provider (two plain POSTs, no subprocess).
//
// Cursor's API-key-authenticated PUBLIC API carries no account quota at all:
// it exposes `/v1/me`, `/v1/models`, `/v1/repositories`, `/v1/agents` and a
// per-AGENT token/cost read, and signals pressure only reactively via
// `retry-after` on a 429. The account-wide numbers live on the dashboard API
// the Cursor app itself uses, so the host exchanges the configured API key for
// a short-lived session token (`/auth/exchange_user_api_key`) and calls
// `aiserver.v1.DashboardService/GetCurrentPeriodUsage` with it.
//
// Deriving the session FROM the same key that runs turns is load-bearing, not
// incidental: it is what makes the account this arm reports and the account
// Traycer bills the same account by construction. Reading Cursor's own CLI
// session out of the OS keychain would report whichever account happened to
// run `cursor-agent login`, which need not be the key's owner.
//
// Hybrid shape, like grok's: synthesized windows (so severity rollups, a2a
// `rateLimitStatus`, and GUI status logic reuse the shared window primitive
// with no special-casing) plus the raw money fields.
//
// TWO windows, mirroring the buckets Cursor's own Spending page renders -
// "Cursor Models" (the payload's `autoPercentUsed`; Cursor Grok + Composer)
// and "Other Models" (`apiPercentUsed`; named third-party models). The
// payload ALSO carries a blended included-usage pool (`totalSpend`/`limit`,
// the number `displayMessage` narrates), but that percentage appears nowhere
// on Cursor's dashboard, and rendering it produced a rail (78%) that
// contradicted the Spending page beside it (38%) - a confirmed live-account
// mismatch. The blended pool therefore travels as MONEY only (`usedUsd` /
// `includedLimitUsd` / `remainingUsd`), never as a window.
//
// Every payload-derived field is nullable because the endpoint speaks proto3
// JSON, which OMITS zero-valued fields entirely - an account with no
// usage-based spend simply has no `spendLimitUsage.individualUsed` key rather
// than a `0`. Absent therefore cannot be distinguished from zero here, and
// the host sends null rather than inventing either.
//
// ALL money is USD, and EVERY wire money value is integer CENTS the host
// divides - including the on-demand (spend-limit) fields: a live account with
// a $1 on-demand limit reports `individualLimit: 100`. (An earlier revision
// read those as whole dollars and displayed $100; the cents rule has no
// exceptions.) The on-demand fields carry the dashboard's "On-Demand
// Spending" numbers and are named for it.
const cursorRateLimitsSchema = z
  .object({
    provider: z.literal(rateLimitCapableProviderIdSchema.enum.cursor),
    available: z.literal(true),
    cycleStart: z.number().nullable(),
    cycleEnd: z.number().nullable(),
    cursorModels: providerRateLimitWindowSchema.nullable(),
    otherModels: providerRateLimitWindowSchema.nullable(),
    includedLimitUsd: z.number().nullable(),
    usedUsd: z.number().nullable(),
    remainingUsd: z.number().nullable(),
    // Spend covered by Cursor's bonus grant ("free usage beyond what you've
    // purchased") - the payload's `bonusSpend`, expected to populate once
    // `usedUsd` crosses `includedLimitUsd`. Null until then (proto3 omits
    // zero-valued fields), so a consumer can distinguish "no bonus consumed"
    // from a payload that never carried the field.
    bonusUsedUsd: z.number().nullable(),
    onDemandLimitType: z.string().nullable(),
    onDemandLimitUsd: z.number().nullable(),
    onDemandUsedUsd: z.number().nullable(),
    onDemandRemainingUsd: z.number().nullable(),
    // Cursor's own rendering of the blended headline ("You've used 79% of
    // your included usage"). Carried so a consumer can show the provider's
    // wording for the pool the money fields describe.
    displayMessage: z.string().nullable(),
  })
  .superRefine((value, ctx) => {
    // Same invariant grok's arm enforces, for the same reason: the host
    // synthesizes each window's reset FROM the billing-cycle end, so the two
    // denote one instant by construction. `cycleEnd` is kept as its own field
    // so the cycle bounds survive a snapshot whose usage could not be
    // measured (both windows null, `cycleEnd` still known). Enforce it at the
    // wire boundary so a measured window can never omit or disagree with the
    // known reset.
    for (const key of ["cursorModels", "otherModels"] as const) {
      const window = value[key];
      if (
        value.cycleEnd !== null &&
        window !== null &&
        window.resetsAt !== value.cycleEnd
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `cursor ${key}.resetsAt must equal cycleEnd when the window is set`,
          path: [key, "resetsAt"],
        });
      }
    }
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
// v2 enum used by every frozen newer response and the latest response.
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

const unavailableProviderRateLimitsSchema =
  unavailableProviderRateLimitsSchemaV2.extend({
    // Present on OpenCode snapshots so renderer retention is scoped to the
    // credential observed by the host. Other providers omit it.
    credentialGeneration: z.string().min(1).optional(),
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

// Latest provider union, carried by `host.getRateLimitUsage@4.0` and
// `agent.getProviderProfileRateLimits@4.0`. Both the Hugging Face and the
// OpenCode Go available arms ride 4.0: neither had shipped when the release
// collapsed them onto one major, so there is no peer that negotiated one
// without the other. The unavailable arm's optional cache generation is
// stripped naturally by older object schemas.
//
// A pre-collapse `providerRateLimitsSchemaV70` used to sit here as the frozen
// pre-image these two lines parsed through. Nothing binds it now - 4.0 ranges
// over this live union directly - so it was removed rather than left as an
// unbound union documenting a freeze that no longer exists. Adding an arm here
// therefore GROWS THE 4.0 WIRE immediately; the bridges below are what keep the
// released 3.0/2.1/1.2 lines parsing.
export const providerRateLimitsSchema = z.union([
  codexRateLimitsSchema,
  claudeCodeRateLimitsSchema,
  openRouterRateLimitsSchema,
  kiloCodeRateLimitsSchema,
  grokRateLimitsSchema,
  huggingFaceRateLimitsSchema,
  openCodeRateLimitsSchema,
  cursorRateLimitsSchema,
  unavailableProviderRateLimitsSchema,
]);
export type ProviderRateLimits = z.infer<typeof providerRateLimitsSchema>;

// Frozen v3.0-line union - the live union as `cli-v1.1.8` first shipped it and
// every release through `cli-v1.1.10` has carried it: codex-with-per-credit-
// detail + claude-code + openrouter + kilocode + grok + unavailableV2, WITHOUT
// the Hugging Face arm. Feeds `rateLimitUsageResponseSchemaV30` only.
//
// This line pointed at the LIVE union until the Hugging Face arm was added,
// which is exactly how grok grew the released v2.1 line before it. A new
// available arm is NOT strippable by the within-major skew handler - a released
// client's frozen union has no such variant and strict-decodes the frame - so
// the arm travels on v4.0 with a bridge that degrades it. Do NOT widen this
// schema.
export const providerRateLimitsSchemaV30 = z.union([
  codexRateLimitsSchema,
  claudeCodeRateLimitsSchema,
  openRouterRateLimitsSchema,
  kiloCodeRateLimitsSchema,
  grokRateLimitsSchema,
  unavailableProviderRateLimitsSchemaV2,
]);
export type ProviderRateLimitsV30 = z.infer<typeof providerRateLimitsSchemaV30>;

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

// The Hugging Face analogue of `mapGrokAvailableToUnavailable`, for every
// bridge below the v4.0 line. A Hugging-Face-available snapshot has no
// representation in any frozen union, so it degrades to the unavailable
// `unsupported_provider` shape - the exact row a pre-Hugging-Face host returns
// for it today. `"huggingface"` IS in the unavailable arm's live `provider`
// enum, so the result reparses cleanly through the older union. Any other
// snapshot (or `null`) passes through unchanged.
export function mapHuggingFaceAvailableToUnavailable(
  providerRateLimits: ProviderRateLimits | null,
): ProviderRateLimits | null {
  if (
    providerRateLimits !== null &&
    providerRateLimits.available &&
    providerRateLimits.provider === "huggingface"
  ) {
    return {
      provider: "huggingface",
      available: false,
      reason: "unsupported_provider",
    };
  }
  return providerRateLimits;
}

/**
 * The Cursor analogue of `mapGrokAvailableToUnavailable`, for every bridge
 * below the live 4.0 line. A cursor-available snapshot has no representation in
 * any frozen union (Cursor was not a rate-limit-capable provider then), so it
 * degrades to the unavailable `unsupported_provider` shape - the exact row a
 * pre-Cursor host returns for it today. `"cursor"` is in EVERY frozen
 * `provider` enum (it long predates Hermes/omp, and is present in
 * `providerIdSchemaV40`/`V50`/`V60`), so the result reparses cleanly through
 * every older union. Any other snapshot (or `null`) passes through unchanged.
 */
export function mapCursorAvailableToUnavailable(
  providerRateLimits: ProviderRateLimits | null,
): ProviderRateLimits | null {
  if (
    providerRateLimits !== null &&
    providerRateLimits.available &&
    providerRateLimits.provider === "cursor"
  ) {
    return {
      provider: "cursor",
      available: false,
      reason: "unsupported_provider",
    };
  }
  return providerRateLimits;
}

export function mapOpenCodeAvailableToUnavailable(
  providerRateLimits: ProviderRateLimits | null,
): ProviderRateLimits | null {
  if (
    providerRateLimits !== null &&
    providerRateLimits.available &&
    providerRateLimits.provider === "opencode"
  ) {
    return {
      provider: "opencode",
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

// Frozen pre-Hugging-Face unavailable arm: same v2 reason enum, but `provider`
// is pinned to `providerIdSchemaV60` (the provider id set as shipped in
// cli-v1.1.9 / host-v1.1.9, with omp and before Hugging Face) so an
// already-shipped `agent.getProviderProfileRateLimits@3.0` caller's strict
// decode never sees `"huggingface"` in the `available: false` arm.
const unavailableProviderRateLimitsSchemaV60 = z.object({
  provider: providerIdSchemaV60,
  available: z.literal(false),
  reason: rateLimitUnavailableReasonSchemaV2,
});

/**
 * Frozen pre-Hugging-Face provider union - identical to the latest
 * `providerRateLimitsSchema` except the `available: false` arm's `provider` is
 * pinned to `providerIdSchemaV60`. Like the v5.0 union it KEEPS the grok
 * available arm (grok rate limits long predate the v1.1.9 tags).
 *
 * Feeds only `agent.getProviderProfileRateLimits@3.0`'s frozen response (see
 * `host/agent/profiles.ts`) so that released line never receives
 * `huggingface`; the v4.0 line carries it via the live
 * `providerRateLimitsSchema` above, with a v4->v3 downgrade bridge that fails
 * closed for such a rate-limit read instead of silently mis-decoding it. Do
 * NOT widen this schema - extend the latest schema and use that v4 bridge
 * instead.
 *
 * Hugging Face appears in NEITHER arm of this union: it has no available arm
 * here, and `providerIdSchemaV60` cannot name it in the unavailable one.
 * Pinning that arm's enum is what closes the second door - left live, a
 * degraded Hugging Face snapshot would still reach a v3.0 caller as an
 * `available: false` row naming a provider that line has never heard of.
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

// v3.0 response - identical to v2.1 except the provider-account snapshot ranges
// over the live `providerRateLimitsSchema`, which adds the grok available arm.
// The request shape is unchanged from v1.2/v2.x, so `hostGetRateLimitUsageV30`
// in `contracts.ts` reuses `rateLimitUsageRequestSchemaV12` directly. Shipped
// as a new major (not a v2.2 minor) because a new available union arm is not
// strippable by the within-major skew handler - an old peer's frozen union has
// no grok arm - so it needs an explicit downgrade bridge that degrades a
// grok-available snapshot to the unavailable `unsupported_provider` shape.
export const rateLimitUsageResponseSchemaV30 =
  rateLimitUsageResponseSchema.extend({
    providerRateLimits: providerRateLimitsSchemaV30.nullable(),
  });
export type RateLimitUsageResponseV30 = z.infer<
  typeof rateLimitUsageResponseSchemaV30
>;

// v4.0 response - identical to v3.0 except the provider-account snapshot ranges
// over the LIVE `providerRateLimitsSchema`, which adds the Hugging Face and
// OpenCode Go available arms. Same reasoning as the v3.0 cut for grok: a new
// available union arm is not strippable by the within-major skew handler, so it
// needs an explicit downgrade bridge that degrades it to the unavailable
// `unsupported_provider` shape. The request shape is unchanged from
// v1.2/v2.x/v3.0.
//
// This is the LIVE line: it ranges over `providerRateLimitsSchema` rather than
// a frozen snapshot, because `4` is the newest major and no released peer has
// ever negotiated it (the newest released baseline tops out at `3`). Freezing
// it costs a pre-image and buys nothing until it ships.
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
