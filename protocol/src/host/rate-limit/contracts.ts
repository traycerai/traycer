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
} from "@traycer/protocol/host/rate-limit/schemas";

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

// Downgrade bridge 2.0 -> 1.2: request is identity (unchanged shape).
// `usage_fetch_failed` (v2-only) maps down to `rate_limits_not_available` so
// a v1.2 client's frozen enum keeps parsing; every other reason and every
// `available: true` arm is already a valid v1.2 shape and passes through the
// re-parse unchanged.
export const hostGetRateLimitUsageDowngradeV2ToV1 = defineDowngradePath<
  typeof hostGetRateLimitUsageV20,
  typeof hostGetRateLimitUsageV12
>({
  from: hostGetRateLimitUsageV20.schemaVersion,
  to: hostGetRateLimitUsageV12.schemaVersion,
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => ({
    ok: true,
    value: rateLimitUsageResponseSchemaV12.parse({
      ...response,
      providerRateLimits:
        response.providerRateLimits !== null &&
        response.providerRateLimits.available === false &&
        response.providerRateLimits.reason === "usage_fetch_failed"
          ? {
              ...response.providerRateLimits,
              reason: "rate_limits_not_available",
            }
          : response.providerRateLimits,
    }),
  }),
});
