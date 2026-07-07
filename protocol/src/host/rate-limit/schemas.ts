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
export const rateLimitUnavailableReasonSchema = z.enum([
  "cli_not_found",
  "unsupported_provider",
  "invalid_response",
  "timeout",
  "connection_failed",
  "rate_limits_not_available",
  "sdk_incompatible",
  "insufficient_permissions",
]);
export type RateLimitUnavailableReason = z.infer<
  typeof rateLimitUnavailableReasonSchema
>;

// Any provider/auth combination that can't report rate limits (API-key auth,
// not logged in, a timed-out pull, etc). Its `provider` field ranges over the
// full `providerIdSchema` enum, which overlaps the literal `"codex"` /
// `"claude-code"` values the two arms above use as their tag - that overlap
// is why this union is a plain `z.union`, not a `z.discriminatedUnion`.
// `discriminatedUnion` requires every arm's discriminator value to be
// unique; two arms claiming `"codex"` (one via `z.literal`, one via this
// enum) makes Zod throw a raw (non-ZodError) "Duplicate discriminator value"
// error the first time the schema is parsed, which `safeParse` can't catch.
const unavailableProviderRateLimitsSchema = z.object({
  provider: providerIdSchema,
  available: z.literal(false),
  reason: rateLimitUnavailableReasonSchema,
});

// Provider-tagged union of account rate-limit snapshots. Carries each
// provider's full native detail (not just what today's UI renders) so the
// schema doesn't need another version bump when the UI grows.
export const providerRateLimitsSchema = z.union([
  codexRateLimitsSchema,
  claudeCodeRateLimitsSchema,
  openRouterRateLimitsSchema,
  kiloCodeRateLimitsSchema,
  unavailableProviderRateLimitsSchema,
]);
export type ProviderRateLimits = z.infer<typeof providerRateLimitsSchema>;

// v1.2 response = v1.0/v1.1 flat aperture fields (unchanged) + a nullable
// provider-account snapshot. Null both when the request didn't ask for a
// provider (aperture calls) and when a v1.1 host answers a v1.2 request (see
// the v1.1 -> v1.2 upgrade path).
export const rateLimitUsageResponseSchemaV12 = rateLimitUsageResponseSchema.extend({
  providerRateLimits: providerRateLimitsSchema.nullable(),
});
export type RateLimitUsageResponseV12 = z.infer<
  typeof rateLimitUsageResponseSchemaV12
>;
