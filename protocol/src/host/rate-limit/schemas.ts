import { z } from "zod";
import {
  DEFAULT_ACCOUNT_CONTEXT,
  accountContextSchema,
} from "@traycer/protocol/common/schemas";
import { providerIdSchema } from "@traycer/protocol/host/provider-schemas";

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
export const rateLimitUsageRequestSchemaV12 =
  rateLimitUsageRequestSchemaV11.extend({
    providerId: providerIdSchema.optional(),
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
]);
export type RateLimitCapableProviderId = z.infer<
  typeof rateLimitCapableProviderIdSchema
>;

const codexRateLimitsSchema = z.object({
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
  // Verified against a live `account/rateLimits/read` call: the real
  // `RateLimitResetCreditsSummary` is just `{ availableCount }` - no nested
  // `credits` array exists (the earlier sketch guessed one from partial
  // information).
  resetCredits: z
    .object({
      availableCount: z.number(),
    })
    .nullable(),
  rateLimitReachedType: z.string().nullable(),
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
// v2 enum (feeds the latest `providerRateLimitsSchema`, which the v2.0
// response uses).
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
  codexRateLimitsSchema,
  claudeCodeRateLimitsSchema,
  openRouterRateLimitsSchema,
  kiloCodeRateLimitsSchema,
  unavailableProviderRateLimitsSchemaV1,
]);
export type ProviderRateLimitsV1 = z.infer<typeof providerRateLimitsSchemaV1>;

// Latest provider-tagged union of account rate-limit snapshots (v2 reason
// enum). Carries each provider's full native detail (not just what today's
// UI renders) so the schema doesn't need another version bump when the UI
// grows.
export const providerRateLimitsSchema = z.union([
  codexRateLimitsSchema,
  claudeCodeRateLimitsSchema,
  openRouterRateLimitsSchema,
  kiloCodeRateLimitsSchema,
  unavailableProviderRateLimitsSchemaV2,
]);
export type ProviderRateLimits = z.infer<typeof providerRateLimitsSchema>;

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
    providerRateLimits: providerRateLimitsSchema.nullable(),
  });
export type RateLimitUsageResponseV20 = z.infer<
  typeof rateLimitUsageResponseSchemaV20
>;
