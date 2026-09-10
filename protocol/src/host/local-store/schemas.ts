import { z } from "zod";

/** Explicit acknowledgement rendered by the GUI's destructive confirmation. */
export const rebindLocalStoreRequestSchema = z
  .object({ confirmOldHostStopped: z.literal(true) })
  .strict();
export type RebindLocalStoreRequest = z.infer<
  typeof rebindLocalStoreRequestSchema
>;

export const rebindLocalStoreResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("rebound") }),
  z.object({
    status: z.literal("refused"),
    message: z.string(),
    remedy: z.string(),
  }),
  // Do not tear down a healthy process-held store merely because a stale GUI
  // error panel clicked late. This arm is deliberately an honest no-op.
  z.object({ status: z.literal("not-needed") }),
]);
export type RebindLocalStoreResponse = z.infer<
  typeof rebindLocalStoreResponseSchema
>;
