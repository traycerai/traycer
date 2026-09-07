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
  providerIdSchemaV70,
} from "@traycer/protocol/host/provider-schemas";

// `host.getRateLimitUsage` v1.0 request: no fields.
// The shipped v1.0.0 host parses the resulting `{}` identically (it never carried extra keys), so dropping `.strict()` here is invisible on the wire.
export const rateLimitUsageRequestSchemaV10 = z.object({});
export type RateLimitUsageRequestV10 = z.infer<
  typeof rateLimitUsageRequestSchemaV10
>;

// v1.1 request adds the selected account so usage reflects the active org/personal context.
export const rateLimitUsageRequestSchemaV11 =
  rateLimitUsageRequestSchemaV10.extend({
    accountContext: accountContextSchema.default(DEFAULT_ACCOUNT_CONTEXT),
  });
export type RateLimitUsageRequestV11 = z.infer<
  typeof rateLimitUsageRequestSchemaV11
>;

export const rateLimitUsageResponseSchema = z.object({
  totalTokens: z.number(),
  remainingTokens: z.number(),
  retryAfter: z.number().optional(),
});
export type RateLimitUsageResponse = z.infer<
  typeof rateLimitUsageResponseSchema
>;

export const rateLimitUsageRequestSchemaV12 =
  rateLimitUsageRequestSchemaV11.extend({
    providerId: providerIdSchema.optional(),
    profileId: z.string().nullable().default(null),
  });
export type RateLimitUsageRequestV12 = z.infer<
  typeof rateLimitUsageRequestSchemaV12
>;

// v4.0 request adds `force`: whether this provider pull must initiate a fresh read, or may be served from the host's per-`(provider, profile)` gauge cache within that lane's cooldown floor.
// Travelling down to a released peer (the 4->3/2/1 bridges in `contracts.ts`) drops the key, so an old host still forces - a strictly safe degradation (an extra spawn), never a stale read.
export const rateLimitUsageRequestSchemaV40 =
  rateLimitUsageRequestSchemaV12.extend({
    force: z.boolean().optional(),
  });
export type RateLimitUsageRequestV40 = z.infer<
  typeof rateLimitUsageRequestSchemaV40
>;

// A normalized rolling rate-limit window, shared by every provider arm below.
export const providerRateLimitWindowSchema = z.object({
  usedPercent: z.number(),
  resetsAt: z.number().nullable(),
  durationMinutes: z.number().nullable(),
});
export type ProviderRateLimitWindow = z.infer<
  typeof providerRateLimitWindowSchema
>;

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
  // Newer Codex app-server builds enrich the summary with individual credits.
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

// OpenRouter arm - httpFetch-class provider (a plain GET against OpenRouter's key/credits endpoints, no subprocess).
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

// Hugging Face arm - httpFetch-class provider (a plain GET against `huggingface.co/api/settings/billing/usage-v2` with the personal token, no subprocess).
// A CREDIT provider, not a windowed one: HF reports money, never a percentage of a rolling window, so `providerRateLimitWindows` returns [] for it exactly as it does for openrouter.
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

// Kilo Code arm - httpFetch-class provider (reads its own credential file, no subprocess).
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

// Grok arm - ephemeral-CLI-class provider (usage is read over the vendored grok CLI's own `_x.ai/billing` ACP extension, so Traycer never touches the grok OAuth token), but the payload is billing-period/credit-shaped.
// Every payload-derived field is nullable: xAI omits fields freely by account type, and a zero-usage subscription reports only period + tier.
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
    // `period.resetsAt` and `periodEnd` denote the same instant by construction - the host synthesizes the window's reset FROM the period end.
    // Enforce that invariant at the wire boundary so a measured period can never omit or disagree with the known reset instant.
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
// Absent therefore cannot be distinguished from zero here, and the host sends null rather than inventing either.
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
    // Spend covered by Cursor's bonus grant ("free usage beyond what you've purchased") - the payload's `bonusSpend`, expected to populate once `usedUsd` crosses `includedLimitUsd`.
    // Null until then (proto3 omits zero-valued fields), so a consumer can distinguish "no bonus consumed" from a payload that never carried the field.
    bonusUsedUsd: z.number().nullable(),
    onDemandLimitType: z.string().nullable(),
    onDemandLimitUsd: z.number().nullable(),
    onDemandUsedUsd: z.number().nullable(),
    onDemandRemainingUsd: z.number().nullable(),
    // Cursor's own rendering of the blended headline ("You've used 79% of your included usage").
    displayMessage: z.string().nullable(),
  })
  .superRefine((value, ctx) => {
    // Same invariant grok's arm enforces, for the same reason: the host synthesizes each window's reset FROM the billing-cycle end, so the two denote one instant by construction.
    // Enforce it at the wire boundary so a measured window can never omit or disagree with the known reset.
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

// `host.getRateLimitUsage@1.2` - Closed, Traycer-owned set of reasons a provider pull can fail to report rate limits - unlike a provider's own plan/reached-type tokens (owned by that provider, legitimately forward-compat.
// Enforces the host's `unavailableRateLimits` call sites and the GUI's display-label map stay exhaustive at compile time instead of silently drifting.
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

// `host.getRateLimitUsage@1.2` - v2 adds `usage_fetch_failed`: the CLI's usage HTTP fetch failed (timeout, a 401 with a failed token refresh, an unseeded 429, an empty body) - a transient fetch problem, distinct from.
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

// Any provider/auth combination that can't report rate limits.
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

// Provider-tagged union of account rate-limit snapshots, frozen at the v1 reason enum.
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

// `host.getRateLimitUsage@3.0` - Frozen v2.1 provider union - a byte-for-byte snapshot of the live union as shipped in `rateLimitUsageResponseSchemaV21` (host.getRateLimitUsage@2.1): codex-with-per-credit-detail +.
// New available arms travel behind a new major (`host.getRateLimitUsage@3.0`) with a downgrade bridge, never an in-place edit here.
export const providerRateLimitsSchemaV21 = z.union([
  codexRateLimitsSchema,
  claudeCodeRateLimitsSchema,
  openRouterRateLimitsSchema,
  kiloCodeRateLimitsSchema,
  unavailableProviderRateLimitsSchemaV2,
]);
export type ProviderRateLimitsV21 = z.infer<typeof providerRateLimitsSchemaV21>;

// Latest provider union, carried by `host.getRateLimitUsage@4.0` and `agent.getProviderProfileRateLimits@4.0`.
// A pre-collapse `providerRateLimitsSchemaV70` used to sit here as the frozen pre-image these two lines parsed through.
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

// Frozen v3.0-line union - the live union as `cli-v1.1.8` first shipped it and every release through `cli-v1.1.10` has carried it: codex-with-per-credit- detail + claude-code + openrouter + kilocode + grok +.
// A new available arm is NOT strippable by the within-major skew handler - a released client's frozen union has no such variant and strict-decodes the frame - so the arm travels on v4.0 with a bridge that degrades it.
export const providerRateLimitsSchemaV30 = z.union([
  codexRateLimitsSchema,
  claudeCodeRateLimitsSchema,
  openRouterRateLimitsSchema,
  kiloCodeRateLimitsSchema,
  grokRateLimitsSchema,
  unavailableProviderRateLimitsSchemaV2,
]);
export type ProviderRateLimitsV30 = z.infer<typeof providerRateLimitsSchemaV30>;

// Single home for the grok available -> unavailable degrade every downgrade bridge below the v3.0 line applies.
// `"grok"` is in every frozen `provider` enum (it predates Hermes/omp), so the result reparses cleanly through the older union.
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

// The Hugging Face analogue of `mapGrokAvailableToUnavailable`, for every bridge below the v4.0 line.
// A Hugging-Face-available snapshot has no representation in any frozen union, so it degrades to the unavailable `unsupported_provider` shape - the exact row a pre-Hugging-Face host returns for it today.
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
 * The Cursor analogue of `mapGrokAvailableToUnavailable`, for every bridge below the live 4.0 line.
 * `"cursor"` is in EVERY frozen `provider` enum (it long predates Hermes/omp, and is present in `providerIdSchemaV40`/`V50`/`V60`), so the result reparses cleanly through every older union.
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

// `agent.getProviderProfileRateLimits@1.0` - Frozen pre-Hermes unavailable arm: same v2 reason enum, but `provider` is pinned to `providerIdSchemaV40` (the harness/provider id set as shipped in host-v1.1.7, before.
const unavailableProviderRateLimitsSchemaV40 = z.object({
  provider: providerIdSchemaV40,
  available: z.literal(false),
  reason: rateLimitUnavailableReasonSchemaV2,
});

/**
 * `agent.getProviderProfileRateLimits@1.0` - Frozen pre-Hermes provider union - identical to the latest `providerRateLimitsSchema` except the `available: false` arm's `provider` is pinned to `providerIdSchemaV40`.
 * Do NOT widen this schema - extend the latest schema and use that v2 bridge instead.
 */
export const providerRateLimitsSchemaV40 = z.union([
  codexRateLimitsSchema,
  claudeCodeRateLimitsSchema,
  openRouterRateLimitsSchema,
  kiloCodeRateLimitsSchema,
  unavailableProviderRateLimitsSchemaV40,
]);
export type ProviderRateLimitsV40 = z.infer<typeof providerRateLimitsSchemaV40>;

// `agent.getProviderProfileRateLimits@2.0` - Frozen pre-omp unavailable arm: same v2 reason enum, but `provider` is pinned to `providerIdSchemaV50` (the provider id set as shipped in cli-v1.1.8 / host-v1.1.8, with Hermes.
const unavailableProviderRateLimitsSchemaV50 = z.object({
  provider: providerIdSchemaV50,
  available: z.literal(false),
  reason: rateLimitUnavailableReasonSchemaV2,
});

/**
 * `agent.getProviderProfileRateLimits@2.0` - Frozen pre-omp provider union - identical to the latest `providerRateLimitsSchema` except the `available: false` arm's `provider` is pinned to `providerIdSchemaV50`.
 * Do NOT widen this schema - extend the latest schema and use that v3 bridge instead.
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

// `agent.getProviderProfileRateLimits@3.0` - Frozen pre-Hugging-Face unavailable arm: same v2 reason enum, but `provider` is pinned to `providerIdSchemaV60` (the provider id set as shipped in cli-v1.1.9 / host-v1.1.9.
const unavailableProviderRateLimitsSchemaV60 = z.object({
  provider: providerIdSchemaV60,
  available: z.literal(false),
  reason: rateLimitUnavailableReasonSchemaV2,
});

/**
 * `agent.getProviderProfileRateLimits@3.0` - Frozen pre-Hugging-Face provider union - identical to the latest `providerRateLimitsSchema` except the `available: false` arm's `provider` is pinned to `providerIdSchemaV60`.
 * Do NOT widen this schema - extend the latest schema and use that v4 bridge instead.
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

// `agent.getProviderProfileRateLimits@4.0` - Frozen pre-Reasonix unavailable arm: same v2 reason enum, but `provider` is pinned to `providerIdSchemaV70` (the provider id set as shipped in cli-v1.2.0 / host-v1.2.0, with.
const unavailableProviderRateLimitsSchemaV70 = z.object({
  provider: providerIdSchemaV70,
  available: z.literal(false),
  reason: rateLimitUnavailableReasonSchemaV2,
});

/**
 * Frozen `agent.getProviderProfileRateLimits@4.0` provider union - the live union as the v1.2.0 tags (2026-08-24) shipped it, with the `available: false` arm's `provider` pinned to `providerIdSchemaV70`.
 * Do NOT widen this schema - extend the latest union and use the v5 bridge.
 */
export const providerRateLimitsSchemaV70 = z.union([
  codexRateLimitsSchema,
  claudeCodeRateLimitsSchema,
  openRouterRateLimitsSchema,
  kiloCodeRateLimitsSchema,
  grokRateLimitsSchema,
  huggingFaceRateLimitsSchema,
  openCodeRateLimitsSchema,
  cursorRateLimitsSchema,
  unavailableProviderRateLimitsSchemaV70.extend({
    credentialGeneration: z.string().min(1).optional(),
  }),
]);
export type ProviderRateLimitsV70 = z.infer<typeof providerRateLimitsSchemaV70>;

// v1.2 response = v1.0/v1.1 flat aperture fields (unchanged) + a nullable provider-account snapshot, frozen at the v1 reason enum (see `providerRateLimitsSchemaV1` above).
export const rateLimitUsageResponseSchemaV12 =
  rateLimitUsageResponseSchema.extend({
    providerRateLimits: providerRateLimitsSchemaV1.nullable(),
  });
export type RateLimitUsageResponseV12 = z.infer<
  typeof rateLimitUsageResponseSchemaV12
>;

// v2.0 response - identical to v1.2 except the provider-account snapshot's unavailable arm ranges over the v2 reason enum (adds `usage_fetch_failed`).
export const rateLimitUsageResponseSchemaV20 =
  rateLimitUsageResponseSchema.extend({
    providerRateLimits: providerRateLimitsSchemaV2.nullable(),
  });
export type RateLimitUsageResponseV20 = z.infer<
  typeof rateLimitUsageResponseSchemaV20
>;

// v2.1 adds capped per-credit Codex reset detail.
// Released v2.0 stays frozen; the RPC handler projects a canonical v2.1 response through the v2.0 schema for an older caller, stripping the additive detail.
export const rateLimitUsageResponseSchemaV21 =
  rateLimitUsageResponseSchema.extend({
    providerRateLimits: providerRateLimitsSchemaV21.nullable(),
  });
export type RateLimitUsageResponseV21 = z.infer<
  typeof rateLimitUsageResponseSchemaV21
>;

// v3.0 response - identical to v2.1 except the provider-account snapshot ranges over the live `providerRateLimitsSchema`, which adds the grok available arm.
export const rateLimitUsageResponseSchemaV30 =
  rateLimitUsageResponseSchema.extend({
    providerRateLimits: providerRateLimitsSchemaV30.nullable(),
  });
export type RateLimitUsageResponseV30 = z.infer<
  typeof rateLimitUsageResponseSchemaV30
>;

// v4.0 response - identical to v3.0 except the provider-account snapshot ranges over the LIVE `providerRateLimitsSchema`, which adds the Hugging Face and OpenCode Go available arms.
// This is the LIVE line: it ranges over `providerRateLimitsSchema` rather than a frozen snapshot, because `4` is the newest major and no released peer has ever negotiated it (the newest released baseline tops out at `3`).
export const rateLimitUsageResponseSchemaV40 =
  rateLimitUsageResponseSchema.extend({
    providerRateLimits: providerRateLimitsSchema.nullable(),
  });
export type RateLimitUsageResponseV40 = z.infer<
  typeof rateLimitUsageResponseSchemaV40
>;

/**
 * Explicit single-profile maintenance.
 * This request deliberately has no `force`/bypass flag: reaching the dedicated method is the user-maintenance intent, while ordinary reads remain execution-gated.
 */
export const providersRefreshProfileStatusRequestSchema = z.object({
  providerId: providerIdSchema,
  profileId: z.string(),
});
export type ProvidersRefreshProfileStatusRequest = z.infer<
  typeof providersRefreshProfileStatusRequestSchema
>;

export const providersRefreshProfileStatusResponseSchema = z.object({
  providerRateLimits: providerRateLimitsSchema,
});
export type ProvidersRefreshProfileStatusResponse = z.infer<
  typeof providersRefreshProfileStatusResponseSchema
>;

/** Uses one of Codex's account-level manual rate-limit reset credits for the selected profile. */
export const providersConsumeRateLimitResetCreditRequestSchema = z.object({
  providerId: z.literal("codex"),
  profileId: z.string().nullable(),
  idempotencyKey: z.string().min(1),
  // `null` preserves the count-only/older-Codex fallback where the backend chooses a credit.
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
