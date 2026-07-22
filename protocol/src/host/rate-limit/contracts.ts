import {
  defineDowngradePath,
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import {
  providersConsumeRateLimitResetCreditRequestSchema,
  providersConsumeRateLimitResetCreditResponseSchema,
  rateLimitUsageRequestSchemaV10,
  rateLimitUsageRequestSchemaV11,
  rateLimitUsageRequestSchemaV12,
  rateLimitUsageResponseSchema,
  rateLimitUsageResponseSchemaV12,
  rateLimitUsageResponseSchemaV20,
  rateLimitUsageResponseSchemaV21,
  rateLimitUsageResponseSchemaV30,
  mapGrokAvailableToUnavailable,
  type ProviderRateLimits,
} from "@traycer/protocol/host/rate-limit/schemas";

// The v2-only `usage_fetch_failed` reason maps to `rate_limits_not_available`
// so a v1.2 client's frozen 8-value reason enum keeps parsing. Every other
// reason and every `available: true` arm is already a valid v1.2 shape. Shared
// by the 2.1 -> 1.2 and 3.0 -> 1.2 downgrade bridges.
function mapUsageFetchFailedToNotAvailable(
  providerRateLimits: ProviderRateLimits | null,
): ProviderRateLimits | null {
  if (
    providerRateLimits !== null &&
    providerRateLimits.available === false &&
    providerRateLimits.reason === "usage_fetch_failed"
  ) {
    return { ...providerRateLimits, reason: "rate_limits_not_available" };
  }
  return providerRateLimits;
}

export const providersConsumeRateLimitResetCreditV10 = defineRpcContract({
  method: "providers.consumeRateLimitResetCredit",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersConsumeRateLimitResetCreditRequestSchema,
  responseSchema: providersConsumeRateLimitResetCreditResponseSchema,
});

export const hostGetRateLimitUsageV10 = defineRpcContract({
  method: "host.getRateLimitUsage",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: rateLimitUsageRequestSchemaV10,
  responseSchema: rateLimitUsageResponseSchema,
});

// v1.1 adds `accountContext` to the request. Shipped as a minor (not an in-place
// change to v1.0) so a v1.0.0 host still negotiates: a v1.1 client strips the
// field to reach a v1.0 host (default account), and a v1.0 client's request
// upgrades to canonical with the personal-context default. See the RPC
// backward-compat decision log.
export const hostGetRateLimitUsageV11 = defineRpcContract({
  method: "host.getRateLimitUsage",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: rateLimitUsageRequestSchemaV11,
  responseSchema: rateLimitUsageResponseSchema,
});

// A v1.0 request carries no account, so it upgrades to the personal context. The
// response is unchanged across the minor, so its upgrade is the identity.
export const hostGetRateLimitUsageUpgradeV10ToV11 = defineUpgradePath<
  typeof hostGetRateLimitUsageV10,
  typeof hostGetRateLimitUsageV11
>({
  from: hostGetRateLimitUsageV10.schemaVersion,
  to: hostGetRateLimitUsageV11.schemaVersion,
  upgradeRequest: () => ({ accountContext: DEFAULT_ACCOUNT_CONTEXT }),
  upgradeResponse: (response) => response,
});

// v1.2 adds an optional `providerId` to the request and a nullable
// `providerRateLimits` provider-account snapshot to the response, so the same
// method can also serve Codex / Claude Code CLI account rate limits. Shipped
// as a minor (not an in-place change to v1.1) so a v1.1 host still
// negotiates. See the RPC backward-compat decision log.
export const hostGetRateLimitUsageV12 = defineRpcContract({
  method: "host.getRateLimitUsage",
  schemaVersion: { major: 1, minor: 2 } as const,
  requestSchema: rateLimitUsageRequestSchemaV12,
  responseSchema: rateLimitUsageResponseSchemaV12,
});

// A v1.1 request carries no `providerId`, so it upgrades as-is (still
// optional in v1.2, so no default is needed). It also carries no
// `profileId` (added later as a bare additive field on this same request
// shape - see `rateLimitUsageRequestSchemaV12` in schemas.ts), so that
// upgrades to `null` (ambient). A v1.1 response carries no
// `providerRateLimits`, so it upgrades to `null` - the same "card hidden"
// state a v1.2 client gets for an aperture-only call.
export const hostGetRateLimitUsageUpgradeV11ToV12 = defineUpgradePath<
  typeof hostGetRateLimitUsageV11,
  typeof hostGetRateLimitUsageV12
>({
  from: hostGetRateLimitUsageV11.schemaVersion,
  to: hostGetRateLimitUsageV12.schemaVersion,
  upgradeRequest: (request) => ({ ...request, profileId: null }),
  upgradeResponse: (response) => ({ ...response, providerRateLimits: null }),
});

// v2.0 splits the conflated `rate_limits_not_available` reason: adds
// `usage_fetch_failed` for a CLI usage-fetch failure (transient), distinct
// from an account/auth capability problem. Shipped as a major (not a minor
// within major 1) because the new enum *value* isn't strippable by the
// within-major skew handler the way an extra object key is - see
// `rateLimitUnavailableReasonSchemaV1` / `V2` in `rate-limit/schemas.ts`. The
// request shape is unchanged from v1.2, so this reuses
// `rateLimitUsageRequestSchemaV12` directly rather than defining a new
// request schema.
export const hostGetRateLimitUsageV20 = defineRpcContract({
  method: "host.getRateLimitUsage",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: rateLimitUsageRequestSchemaV12,
  responseSchema: rateLimitUsageResponseSchemaV20,
});

// A v1.2 request and a v2.0 request are identical shapes (both use
// `rateLimitUsageRequestSchemaV12`), so the upgrade is the identity. A v1.2
// response only ever carries v1 reasons (frozen, see
// `rateLimitUnavailableReasonSchemaV1`), which are a subset of the v2 enum,
// so the response upgrade is the identity too - no re-parse needed.
export const hostGetRateLimitUsageUpgradeV12ToV20 = defineUpgradePath<
  typeof hostGetRateLimitUsageV12,
  typeof hostGetRateLimitUsageV20
>({
  from: hostGetRateLimitUsageV12.schemaVersion,
  to: hostGetRateLimitUsageV20.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

export const hostGetRateLimitUsageV21 = defineRpcContract({
  method: "host.getRateLimitUsage",
  schemaVersion: { major: 2, minor: 1 } as const,
  requestSchema: rateLimitUsageRequestSchemaV12,
  responseSchema: rateLimitUsageResponseSchemaV21,
});

export const hostGetRateLimitUsageUpgradeV20ToV21 = defineUpgradePath<
  typeof hostGetRateLimitUsageV20,
  typeof hostGetRateLimitUsageV21
>({
  from: hostGetRateLimitUsageV20.schemaVersion,
  to: hostGetRateLimitUsageV21.schemaVersion,
  upgradeRequest: (request) => request,
  // Parsing fills `resetCredits.credits` with null for a v2.0 count-only
  // response, producing the canonical additive v2.1 shape.
  upgradeResponse: (response) =>
    rateLimitUsageResponseSchemaV21.parse(response),
});

// Downgrade bridge 2.1 -> 1.2: request is identity (unchanged shape).
// `usage_fetch_failed` (v2-only) maps down to `rate_limits_not_available` so
// a v1.2 client's frozen enum keeps parsing; every other reason and every
// `available: true` arm is already a valid v1.2 shape and passes through the
// re-parse unchanged. The v1.2 parse also strips v2.1 reset-credit detail.
export const hostGetRateLimitUsageDowngradeV2ToV1 = defineDowngradePath<
  typeof hostGetRateLimitUsageV21,
  typeof hostGetRateLimitUsageV12
>({
  from: hostGetRateLimitUsageV21.schemaVersion,
  to: hostGetRateLimitUsageV12.schemaVersion,
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => ({
    ok: true,
    value: rateLimitUsageResponseSchemaV12.parse({
      ...response,
      providerRateLimits: mapUsageFetchFailedToNotAvailable(
        response.providerRateLimits,
      ),
    }),
  }),
});

// v3.0 adds the grok available arm to the provider-account snapshot. Shipped as
// a major (not a minor within major 2) because a new available union arm isn't
// strippable by the within-major skew handler the way an extra object key is -
// an old peer's frozen union has no grok arm - so it travels with the
// downgrade bridges below. The request shape is unchanged from v1.2/v2.x, so
// this reuses `rateLimitUsageRequestSchemaV12` directly.
export const hostGetRateLimitUsageV30 = defineRpcContract({
  method: "host.getRateLimitUsage",
  schemaVersion: { major: 3, minor: 0 } as const,
  requestSchema: rateLimitUsageRequestSchemaV12,
  responseSchema: rateLimitUsageResponseSchemaV30,
});

// A v2.1 request and a v3.0 request are identical shapes (both use
// `rateLimitUsageRequestSchemaV12`), so the request upgrade is the identity. A
// v2.1 response only ever carries the frozen v2.1 union arms, every one of
// which is a valid v3.0 arm (the v3.0 union is a strict superset), so the
// response upgrade is the identity too - no re-parse needed.
export const hostGetRateLimitUsageUpgradeV21ToV30 = defineUpgradePath<
  typeof hostGetRateLimitUsageV21,
  typeof hostGetRateLimitUsageV30
>({
  from: hostGetRateLimitUsageV21.schemaVersion,
  to: hostGetRateLimitUsageV30.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

// Downgrade bridge 3.0 -> 2.1: request is identity. A grok-available snapshot
// degrades to the unavailable `unsupported_provider` shape (grok has no arm in
// the frozen v2.1 union); every other arm is already valid v2.1 and passes
// through the re-parse unchanged.
export const hostGetRateLimitUsageDowngradeV3ToV2 = defineDowngradePath<
  typeof hostGetRateLimitUsageV30,
  typeof hostGetRateLimitUsageV21
>({
  from: hostGetRateLimitUsageV30.schemaVersion,
  to: hostGetRateLimitUsageV21.schemaVersion,
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => ({
    ok: true,
    value: rateLimitUsageResponseSchemaV21.parse({
      ...response,
      providerRateLimits: mapGrokAvailableToUnavailable(
        response.providerRateLimits,
      ),
    }),
  }),
});

// Downgrade bridge 3.0 -> 1.2: request is identity. Composes both frozen-line
// maps before the v1.2 re-parse - a grok-available snapshot degrades to
// `unsupported_provider`, and the v2-only `usage_fetch_failed` reason degrades
// to `rate_limits_not_available` - so a v1.2 client's frozen union and 8-value
// reason enum both keep parsing. The v1.2 parse also strips v2.1 reset-credit
// detail. Grok is applied first so a genuinely grok-available snapshot never
// lands on the usage-fetch-failed branch.
export const hostGetRateLimitUsageDowngradeV3ToV1 = defineDowngradePath<
  typeof hostGetRateLimitUsageV30,
  typeof hostGetRateLimitUsageV12
>({
  from: hostGetRateLimitUsageV30.schemaVersion,
  to: hostGetRateLimitUsageV12.schemaVersion,
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => ({
    ok: true,
    value: rateLimitUsageResponseSchemaV12.parse({
      ...response,
      providerRateLimits: mapUsageFetchFailedToNotAvailable(
        mapGrokAvailableToUnavailable(response.providerRateLimits),
      ),
    }),
  }),
});
