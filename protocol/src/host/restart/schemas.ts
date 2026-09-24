import { z } from "zod";
import {
  hostBusyBreakdownV1Schema,
  hostBusyBreakdownV2Schema,
} from "@traycer/protocol/host/status/contracts";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * Caller-generated identity for one logical restart action. Retries must keep
 * the same value so a host can adopt the claim it already granted rather than
 * treating its own in-flight restart as competing work.
 */
export const hostRestartRequestSchema = lazySchema(() =>
  z.object({
    transitionId: z.string().min(1),
  }),
);

/**
 * The v1.0 busy explanation: the one live count the drain projection could
 * state. The count deliberately excludes the working-agent and running-PTY
 * deny signals, so a host refusing for those reasons answered `0` — which the
 * dialog then rendered as "0 sessions are still working", a contradiction in
 * front of the user. v1.1 exists to close that gap.
 */
export const hostRestartBusyVerdictV10Schema = lazySchema(() =>
  z.object({
    busySessionCount: z.number().int().nonnegative(),
  }),
);

/**
 * Which deny signals beyond the countable sessions refused the claim.
 *
 * These are the two `isShutdownBusy` terms the session count cannot see:
 * `workingAgents` is the activity tracker's "an agent turn or its background
 * work is in flight", and `runningTerminals` is "a PTY a shutdown would
 * destroy is alive" (which includes a plain terminal sitting at a prompt —
 * the host deliberately has no idle signal for those).
 */
export const hostRestartBusyBlockersSchema = lazySchema(() =>
  z.object({
    workingAgents: z.boolean(),
    runningTerminals: z.boolean(),
  }),
);

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
export const hostRestartBusyVerdictV11Schema = lazySchema(() =>
  z.object({
    busySessionCount: z.number().int().nonnegative(),
    blockers: hostRestartBusyBlockersSchema.nullable(),
  }),
);

/**
 * v1.2 verdict: the v1.1 count + blockers, plus a typed `busyBreakdown`.
 *
 * `busyBreakdown: null` means the host did not say how the total splits —
 * NOT that every component is zero. `blockers` is unchanged: a v1.2 host
 * still names the boolean deny signals, and a v1.1 host still upgrades them
 * to `null`.
 *
 * FROZEN at the V1 breakdown: this is what `host.restart` @1.2 shipped. The
 * unversioned name stays bound to it so existing importers keep compiling
 * against the shape they read; @1.3 is {@link hostRestartBusyVerdictV13Schema}.
 */
export const hostRestartBusyVerdictSchema = lazySchema(() =>
  z.object({
    busySessionCount: z.number().int().nonnegative(),
    blockers: hostRestartBusyBlockersSchema.nullable(),
    busyBreakdown: hostBusyBreakdownV1Schema.nullable(),
  }),
);

/**
 * v1.3 verdict: v1.2's, with `busyBreakdown` at V2 (V1 plus the informational
 * `shells` and `scheduledWakes` counts, each `null` when the host did not
 * report it). `busySessionCount` and `blockers` keep their v1.2 meaning; the
 * two new counts are not part of the total.
 */
export const hostRestartBusyVerdictV13Schema = lazySchema(() =>
  hostRestartBusyVerdictSchema.extend({
    busyBreakdown: hostBusyBreakdownV2Schema.nullable(),
  }),
);

export const hostRestartResponseV10Schema = lazySchema(() =>
  z.discriminatedUnion("outcome", [
    z.object({ outcome: z.literal("accepted") }),
    z.object({
      outcome: z.literal("busy"),
      verdict: hostRestartBusyVerdictV10Schema,
    }),
  ]),
);

export const hostRestartResponseV11Schema = lazySchema(() =>
  z.discriminatedUnion("outcome", [
    z.object({ outcome: z.literal("accepted") }),
    z.object({
      outcome: z.literal("busy"),
      verdict: hostRestartBusyVerdictV11Schema,
    }),
  ]),
);

/** The v1.2 response, frozen with {@link hostRestartBusyVerdictSchema}. */
export const hostRestartResponseSchema = lazySchema(() =>
  z.discriminatedUnion("outcome", [
    z.object({ outcome: z.literal("accepted") }),
    z.object({
      outcome: z.literal("busy"),
      verdict: hostRestartBusyVerdictSchema,
    }),
  ]),
);

export const hostRestartResponseV13Schema = lazySchema(() =>
  z.discriminatedUnion("outcome", [
    z.object({ outcome: z.literal("accepted") }),
    z.object({
      outcome: z.literal("busy"),
      verdict: hostRestartBusyVerdictV13Schema,
    }),
  ]),
);

export type HostRestartRequest = z.infer<typeof hostRestartRequestSchema>;
export type HostRestartBusyBlockers = z.infer<
  typeof hostRestartBusyBlockersSchema
>;
export type HostRestartBusyVerdict = z.infer<
  typeof hostRestartBusyVerdictSchema
>;
export type HostRestartBusyVerdictV13 = z.infer<
  typeof hostRestartBusyVerdictV13Schema
>;
export type HostRestartResponse = z.infer<typeof hostRestartResponseSchema>;
export type HostRestartResponseV13 = z.infer<
  typeof hostRestartResponseV13Schema
>;
