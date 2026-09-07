import {
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import {
  hostRestartRequestSchema,
  hostRestartResponseSchema,
  hostRestartResponseV10Schema,
  hostRestartResponseV11Schema,
} from "./schemas";

/** Claim-gated host restart. */
export const hostRestartV10 = defineRpcContract({
  method: "host.restart",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostRestartRequestSchema,
  responseSchema: hostRestartResponseV10Schema,
});

/**
 * v1.1 adds `verdict.blockers` to the busy arm: which deny signals beyond the countable sessions refused the claim.
 */
export const hostRestartV11 = defineRpcContract({
  method: "host.restart",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: hostRestartRequestSchema,
  responseSchema: hostRestartResponseV11Schema,
});

/**
 * v1.2 adds `verdict.busyBreakdown` to the busy arm: the typed split of `busySessionCount` (working agents, active terminal-agents, busy plain terminals).
 */
export const hostRestartV12 = defineRpcContract({
  method: "host.restart",
  schemaVersion: { major: 1, minor: 2 } as const,
  requestSchema: hostRestartRequestSchema,
  responseSchema: hostRestartResponseSchema,
});

// A v1.0 host refuses without saying why.
export const hostRestartUpgradeV10ToV11 = defineUpgradePath<
  typeof hostRestartV10,
  typeof hostRestartV11
>({
  from: hostRestartV10.schemaVersion,
  to: hostRestartV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) =>
    response.outcome === "busy"
      ? { ...response, verdict: { ...response.verdict, blockers: null } }
      : response,
});

// A v1.1 host refuses without a typed split.
export const hostRestartUpgradeV11ToV12 = defineUpgradePath<
  typeof hostRestartV11,
  typeof hostRestartV12
>({
  from: hostRestartV11.schemaVersion,
  to: hostRestartV12.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) =>
    response.outcome === "busy"
      ? {
          ...response,
          verdict: { ...response.verdict, busyBreakdown: null },
        }
      : response,
});
