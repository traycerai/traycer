import {
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import {
  rateLimitUsageRequestSchemaV10,
  rateLimitUsageRequestSchemaV11,
  rateLimitUsageRequestSchemaV12,
  rateLimitUsageResponseSchema,
  rateLimitUsageResponseSchemaV12,
} from "@traycer/protocol/host/rate-limit/schemas";

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
// optional in v1.2, so no default is needed). A v1.1 response carries no
// `providerRateLimits`, so it upgrades to `null` - the same "card hidden"
// state a v1.2 client gets for an aperture-only call.
export const hostGetRateLimitUsageUpgradeV11ToV12 = defineUpgradePath<
  typeof hostGetRateLimitUsageV11,
  typeof hostGetRateLimitUsageV12
>({
  from: hostGetRateLimitUsageV11.schemaVersion,
  to: hostGetRateLimitUsageV12.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({ ...response, providerRateLimits: null }),
});
