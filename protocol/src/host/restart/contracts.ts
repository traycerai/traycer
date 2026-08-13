import { defineRpcContract } from "@traycer/protocol/framework/index";
import {
  hostRestartRequestSchema,
  hostRestartResponseSchema,
} from "./schemas";

/**
 * Claim-gated host restart. An accepted response is sent before host teardown
 * begins; clients retry the same `transitionId` only when that response is
 * lost before it reaches them.
 */
export const hostRestartV10 = defineRpcContract({
  method: "host.restart",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostRestartRequestSchema,
  responseSchema: hostRestartResponseSchema,
});
