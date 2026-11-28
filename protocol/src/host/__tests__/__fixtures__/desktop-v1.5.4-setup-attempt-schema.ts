/**
 * Verbatim released declarations from
 * `git -C traycer show desktop-v1.5.4:protocol/src/host/environment-schemas.ts`
 * at b7a5f5ca2dae93bdb127482822651815e9136e87.
 */
import { lazySchema } from "../../../framework/lazy-schema";
import { z } from "zod";

export const setupAttemptSchema = lazySchema(() =>
  z.object({
    attemptId: z.string().min(1),
    scriptHash: z.string().min(1).max(128),
    itemRevision: z.number().int(),
    trigger: z.enum(["change", "retry", "resume", "restart"]),
    startedAt: z.number(),
    endedAt: z.number().nullable(),
    exitStatus: z.number().int().nullable(),
    stageReached: z.string().max(64).nullable(),
    result: z
      .enum(["succeeded", "failed", "timed_out", "cancelled", "unknown"])
      .nullable(),
  }),
);
export const environmentSetupAttemptsResponseSchema = lazySchema(() =>
  z.object({ attempts: z.array(setupAttemptSchema) }),
);
