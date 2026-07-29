import { z } from "zod";

/**
 * A shutdown claim is only meant to span the final precondition check and a
 * graceful host stop. Keep the public bound comfortably below Node's timer
 * overflow threshold; the host coordinator applies the same bound defensively.
 */
export const SHUTDOWN_CLAIM_MAX_TTL_MS = 5 * 60 * 1_000;

export const claimShutdownRequestSchema = z.object({
  transitionId: z.string().min(1),
  ttl: z.number().int().positive().max(SHUTDOWN_CLAIM_MAX_TTL_MS),
});

export const claimShutdownResponseSchema = z.union([
  z.object({ granted: z.object({ token: z.string().min(1) }) }),
  z.object({ denied: z.literal("busy") }),
]);

export const commitShutdownRequestSchema = z.object({
  token: z.string().min(1),
});

export const commitShutdownResponseSchema = z.union([
  z.object({ committed: z.literal(true) }),
  z.object({ denied: z.literal("expired-or-unknown") }),
]);

export const releaseShutdownRequestSchema = z.object({
  token: z.string().min(1),
});

export const releaseShutdownResponseSchema = z.union([
  z.object({ released: z.literal(true) }),
  z.object({ denied: z.literal("expired-or-unknown") }),
]);

export type ClaimShutdownRequest = z.infer<typeof claimShutdownRequestSchema>;
export type ClaimShutdownResponse = z.infer<typeof claimShutdownResponseSchema>;
export type CommitShutdownRequest = z.infer<typeof commitShutdownRequestSchema>;
export type CommitShutdownResponse = z.infer<
  typeof commitShutdownResponseSchema
>;
export type ReleaseShutdownRequest = z.infer<
  typeof releaseShutdownRequestSchema
>;
export type ReleaseShutdownResponse = z.infer<
  typeof releaseShutdownResponseSchema
>;
