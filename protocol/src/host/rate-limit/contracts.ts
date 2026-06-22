import { defineRpcContract } from "@traycer/protocol/framework/index";
import {
  rateLimitUsageRequestSchema,
  rateLimitUsageResponseSchema,
} from "@traycer/protocol/host/rate-limit/schemas";

export const hostGetRateLimitUsageV10 = defineRpcContract({
  method: "host.getRateLimitUsage",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: rateLimitUsageRequestSchema,
  responseSchema: rateLimitUsageResponseSchema,
});
