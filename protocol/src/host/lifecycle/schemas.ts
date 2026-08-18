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

/**
 * What the coordinator taking this claim is going to do with the host once it
 * is down: leave it down, or bring it straight back.
 *
 * The host cannot infer this. A supervisor-mediated `traycer host restart` and
 * a `traycer host stop` are byte-identical from inside the process - the same
 * cooperative claim, the same commit, the same exit 0 - and only the caller
 * knows a start follows. Restart intent published by the host is what keeps a
 * deliberate restart from reading as death on every attached client (D5/M1),
 * so it has to travel from whoever holds the intent.
 *
 * `transitionId` already encodes the operation by convention (`cli-restart-…`
 * vs `cli-stop-…`), which is exactly why this field exists instead: that id is
 * contractually opaque, and sniffing it would make a debugging affordance
 * load-bearing.
 */
export const shutdownClaimIntentSchema = z.enum(["shutdown", "restart"]);
export type ShutdownClaimIntent = z.infer<typeof shutdownClaimIntentSchema>;

/**
 * @1.1 adds the additive `intent`. A @1.0 peer's request is upgraded to
 * `"shutdown"` - the conservative reading, and the one that reproduces
 * today's behaviour exactly: no tombstone, the client bounces as it always
 * has. A @1.1 CLIENT against a @1.0 HOST needs no downgrade path because the
 * shapes are supersets within the major: `prepareRequestPayload` re-parses
 * against the older minor's schema, which strips `intent`.
 */
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
