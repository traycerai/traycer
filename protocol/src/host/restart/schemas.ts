import { z } from "zod";
import { hostBusyBreakdownSchema } from "@traycer/protocol/host/status/contracts";

/**
 * Caller-generated identity for one logical restart action.
 * Retries must keep the same value so a host can adopt the claim it already granted rather than treating its own in-flight restart as competing work.
 */
export const hostRestartRequestSchema = z.object({
  transitionId: z.string().min(1),
});

/** The v1.0 busy explanation: the one live count the drain projection could state. */
export const hostRestartBusyVerdictV10Schema = z.object({
  busySessionCount: z.number().int().nonnegative(),
});

/** Which deny signals beyond the countable sessions refused the claim. */
export const hostRestartBusyBlockersSchema = z.object({
  workingAgents: z.boolean(),
  runningTerminals: z.boolean(),
});

/**
 * v1.1 verdict: the count plus the blocker breakdown.
 * Two producers emit it: the v1.0→v1.1 upgrade path (an old host never states blockers), and a host whose work oracles are not composed (it refuses claims fail-safe without being able to name a source).
 */
export const hostRestartBusyVerdictV11Schema = z.object({
  busySessionCount: z.number().int().nonnegative(),
  blockers: hostRestartBusyBlockersSchema.nullable(),
});

/** v1.2 verdict: the v1.1 count + blockers, plus a typed `busyBreakdown`. */
export const hostRestartBusyVerdictSchema = z.object({
  busySessionCount: z.number().int().nonnegative(),
  blockers: hostRestartBusyBlockersSchema.nullable(),
  busyBreakdown: hostBusyBreakdownSchema.nullable(),
});

export const hostRestartResponseV10Schema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("accepted") }),
  z.object({
    outcome: z.literal("busy"),
    verdict: hostRestartBusyVerdictV10Schema,
  }),
]);

export const hostRestartResponseV11Schema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("accepted") }),
  z.object({
    outcome: z.literal("busy"),
    verdict: hostRestartBusyVerdictV11Schema,
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
