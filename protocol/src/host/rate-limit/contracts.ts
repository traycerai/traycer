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

export const hostGetRateLimitUsageV11 = defineRpcContract({
  method: "host.getRateLimitUsage",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: rateLimitUsageRequestSchemaV11,
  responseSchema: rateLimitUsageResponseSchema,
});

// Upgrade bridge: an old client's v1.0 request carries no account context, so
// the host fills the default (PERSONAL) when promoting it to canonical v1.1.
// The response is unchanged across the minor, so the response upgrade is
// identity.
//
// Spread a fresh copy rather than handing out the shared DEFAULT_ACCOUNT_CONTEXT
// reference - this object is module-global, so returning it by reference would
// let any downstream mutation of the upgraded request bleed into the constant.
export const upgradeRateLimitUsageV10ToV11 = defineUpgradePath<
  typeof hostGetRateLimitUsageV10,
  typeof hostGetRateLimitUsageV11
>({
  from: hostGetRateLimitUsageV10.schemaVersion,
  to: hostGetRateLimitUsageV11.schemaVersion,
  upgradeRequest: () => ({ accountContext: { ...DEFAULT_ACCOUNT_CONTEXT } }),
  upgradeResponse: (response) => response,
});
