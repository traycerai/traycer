import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/** Execution of an already accepted conversation message, never its content. */
export const chatMessageDeliveryStateSchema = lazySchema(() =>
  z.discriminatedUnion("phase", [
    z.object({ phase: z.literal("pending") }),
    z.object({ phase: z.literal("preparing") }),
    z.object({
      phase: z.literal("paused"),
      code: z.string(),
      reason: z.string(),
      missingHashes: z.array(z.string()),
    }),
    z.object({
      phase: z.literal("started"),
      turnId: z.string(),
      assistantMessageId: z.string(),
    }),
    z.object({ phase: z.literal("cancelled") }),
  ]),
);
export type ChatMessageDeliveryState = z.infer<
  typeof chatMessageDeliveryStateSchema
>;

/**
 * Host-owned execution state for a row in the conversation. The revision is
 * compared by mutations, so an action from a stale tab cannot change a prompt
 * another tab has edited, cancelled, or committed to a provider turn.
 */
export const chatMessageDeliverySchema = lazySchema(() =>
  z.object({
    messageId: z.string(),
    revision: z.number().int().positive(),
    state: chatMessageDeliveryStateSchema,
  }),
);
export type ChatMessageDelivery = z.infer<typeof chatMessageDeliverySchema>;
