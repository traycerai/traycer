import { z } from "zod";

/** A shutdown claim is only meant to span the final precondition check and a graceful host stop. */
export const SHUTDOWN_CLAIM_MAX_TTL_MS = 5 * 60 * 1_000;

export const claimShutdownRequestSchema = z.object({
  transitionId: z.string().min(1),
  ttl: z.number().int().positive().max(SHUTDOWN_CLAIM_MAX_TTL_MS),
});

/**
 * What the coordinator taking this claim is going to do with the host once it is down: leave it down, or bring it straight back.
 */
export const shutdownClaimIntentSchema = z.enum(["shutdown", "restart"]);
export type ShutdownClaimIntent = z.infer<typeof shutdownClaimIntentSchema>;

/** @1.1 adds the additive `intent`. */
export const claimShutdownRequestSchemaV11 = z.object({
  transitionId: z.string().min(1),
  ttl: z.number().int().positive().max(SHUTDOWN_CLAIM_MAX_TTL_MS),
  intent: shutdownClaimIntentSchema,
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
export type ClaimShutdownRequestV11 = z.infer<
  typeof claimShutdownRequestSchemaV11
>;
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
