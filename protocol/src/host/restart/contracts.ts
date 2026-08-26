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
  responseSchema: hostRestartResponseV11Schema,
});

/**
 * v1.2 adds `verdict.busyBreakdown` to the busy arm: the typed split of
 * `busySessionCount` (working agents, active terminal-agents, busy plain
 * terminals). `blockers` stays; a v1.2 host derives them from the same
 * snapshot (`workingAgents = breakdown.workingAgents > 0`,
 * `runningTerminals = activeTerminalAgents + busyTerminals > 0`).
 */
export const hostRestartV12 = defineRpcContract({
  method: "host.restart",
  schemaVersion: { major: 1, minor: 2 } as const,
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

// A v1.1 host refuses without a typed split. `busyBreakdown` upgrades to
// `null`, NOT to a zero object: a fabricated idle-by-kind claim would put
// an affirmative "nothing of any kind is blocking" in a v1.1 host's mouth
// under a verdict that already said it was busy — the same distinction
// `host.status`'s 1.1→1.2 `busyBreakdown: null` upgrade preserves.
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
