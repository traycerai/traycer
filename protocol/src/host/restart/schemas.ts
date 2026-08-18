import { z } from "zod";

/**
 * Caller-generated identity for one logical restart action. Retries must keep
 * the same value so a host can adopt the claim it already granted rather than
 * treating its own in-flight restart as competing work.
 */
export const hostRestartRequestSchema = z.object({
  transitionId: z.string().min(1),
});

/**
 * The v1.0 busy explanation: the one live count the drain projection could
 * state. The count deliberately excludes the working-agent and running-PTY
 * deny signals, so a host refusing for those reasons answered `0` — which the
 * dialog then rendered as "0 sessions are still working", a contradiction in
 * front of the user. v1.1 exists to close that gap.
 */
export const hostRestartBusyVerdictV10Schema = z.object({
  busySessionCount: z.number().int().nonnegative(),
});

/**
 * Which deny signals beyond the countable sessions refused the claim.
 *
 * These are the two `isShutdownBusy` terms the session count cannot see:
 * `workingAgents` is the activity tracker's "an agent turn or its background
 * work is in flight", and `runningTerminals` is "a PTY a shutdown would
 * destroy is alive" (which includes a plain terminal sitting at a prompt —
 * the host deliberately has no idle signal for those).
 */
export const hostRestartBusyBlockersSchema = z.object({
  workingAgents: z.boolean(),
  runningTerminals: z.boolean(),
});

/**
 * v1.1 verdict: the count plus the blocker breakdown.
 *
 * `blockers: null` means the host did not say WHY it refused — NOT that
 * nothing blocks. Two producers emit it: the v1.0→v1.1 upgrade path (an old
 * host never states blockers), and a host whose work oracles are not composed
 * (it refuses claims fail-safe without being able to name a source). A
 * fabricated `{ workingAgents: false, runningTerminals: false }` in either
 * case would put an affirmative "nothing is blocking" in the host's mouth
 * under a verdict that says the opposite.
 */
export const hostRestartBusyVerdictSchema = z.object({
  busySessionCount: z.number().int().nonnegative(),
  blockers: hostRestartBusyBlockersSchema.nullable(),
});

export const hostRestartResponseV10Schema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("accepted") }),
  z.object({
    outcome: z.literal("busy"),
    verdict: hostRestartBusyVerdictV10Schema,
  }),
]);

export const hostRestartResponseSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("accepted") }),
  z.object({
    outcome: z.literal("busy"),
    verdict: hostRestartBusyVerdictSchema,
  }),
]);

export type HostRestartRequest = z.infer<typeof hostRestartRequestSchema>;
export type HostRestartBusyBlockers = z.infer<
  typeof hostRestartBusyBlockersSchema
>;
export type HostRestartBusyVerdict = z.infer<
  typeof hostRestartBusyVerdictSchema
>;
export type HostRestartResponse = z.infer<typeof hostRestartResponseSchema>;
