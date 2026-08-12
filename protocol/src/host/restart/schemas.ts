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
 * The shutdown claim does not expose a source-level breakdown. Keep the busy
 * explanation to the one live count the host can state truthfully.
 */
export const hostRestartBusyVerdictSchema = z.object({
  busySessionCount: z.number().int().nonnegative(),
});

export const hostRestartResponseSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("accepted") }),
  z.object({
    outcome: z.literal("busy"),
    verdict: hostRestartBusyVerdictSchema,
  }),
]);

export type HostRestartRequest = z.infer<typeof hostRestartRequestSchema>;
export type HostRestartBusyVerdict = z.infer<
  typeof hostRestartBusyVerdictSchema
>;
export type HostRestartResponse = z.infer<typeof hostRestartResponseSchema>;
