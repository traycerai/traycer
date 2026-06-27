import {
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import {
  rateLimitUsageRequestSchemaV10,
  rateLimitUsageRequestSchemaV11,
  rateLimitUsageResponseSchema,
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
