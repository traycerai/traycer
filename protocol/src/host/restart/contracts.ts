import {
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import {
  hostRestartRequestSchema,
  hostRestartResponseSchema,
  hostRestartResponseV10Schema,
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
  responseSchema: hostRestartResponseV10Schema,
});

/**
 * v1.1 adds `verdict.blockers` to the busy arm: which deny signals beyond the
 * countable sessions refused the claim. The v1.0 verdict's count is only the
 * lingering+watched session projection, while the claim is ALSO denied for
 * working agents and live PTYs — so a host busy for exactly those reasons
 * answered a truthful `busySessionCount: 0` that the dialog rendered as
 * "0 sessions are still working". The blockers field lets the client name the
 * actual blocker instead of quoting a count that measures something else.
 */
export const hostRestartV11 = defineRpcContract({
  method: "host.restart",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: hostRestartRequestSchema,
  responseSchema: hostRestartResponseSchema,
});

// A v1.0 host refuses without saying why. `blockers` upgrades to `null`, NOT
// to all-false: the client's zero-count fallback copy turns on "the host
// named nothing", and a fabricated all-false would claim the host
// affirmatively said no agents and no terminals are blocking — the same
// distinction `host.status`'s `busySessionCount: null` upgrade preserves.
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
