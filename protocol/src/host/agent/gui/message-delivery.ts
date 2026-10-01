import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { getRecordSchema } from "@traycer/protocol/framework/index";
import { commonRecordRegistry } from "@traycer/protocol/common/registry";

/**
 * The prompt a withdrawn opening hands back to its composer.
 *
 * Present only for a person's own opening. It is the one copy of the text once
 * the row has left the transcript, so a device that was not connected when the
 * send failed still gets its prompt back - and it is what keeps the prompt's
 * attachment bytes reachable while a composer is still holding them, which is
 * why an acknowledgement marks it taken (`restoreClaimed`) rather than
 * clearing it. The chat's next human message releases it, in that message's own
 * transaction.
 */
export const chatMessageDeliveryRestoreSchema = lazySchema(() =>
  z.object({
    content: getRecordSchema(commonRecordRegistry, "json-content", "latest"),
  }),
);
export type ChatMessageDeliveryRestore = z.infer<
  typeof chatMessageDeliveryRestoreSchema
>;

/**
 * Execution of an already accepted conversation message, never its content.
 *
 * An opening prompt is either sent or back in the composer. `started` is the
 * commit point: once the model has it, a failure is an ordinary turn error and
 * the message stays. Anything that stops it before then - worktree setup,
 * preparation, a failed start, Stop - `withdrawn`s it: the row leaves the
 * transcript and `restore` carries the text back to the composer.
 */
export const chatMessageDeliveryStateSchema = lazySchema(() =>
  z.discriminatedUnion("phase", [
    z.object({ phase: z.literal("pending") }),
    z.object({ phase: z.literal("preparing") }),
    z.object({
      phase: z.literal("started"),
      turnId: z.string(),
      assistantMessageId: z.string(),
    }),
    z.object({
      phase: z.literal("withdrawn"),
      code: z.string(),
      reason: z.string(),
      missingHashes: z.array(z.string()),
      restore: chatMessageDeliveryRestoreSchema.nullable(),
      /**
       * A composer already has this prompt. A client that watches the
       * withdrawal happen takes it and acknowledges; one that opens the chat
       * afterwards takes it only while this is false, so reopening a chat does
       * not push an old prompt into a composer the user has moved on from.
       */
      restoreClaimed: z.boolean(),
    }),
  ]),
);
export type ChatMessageDeliveryState = z.infer<
  typeof chatMessageDeliveryStateSchema
>;

/**
 * Host-owned execution state for a row in the conversation. The revision
 * orders its changes. `messageDeliveryRestored` names the revision a client
 * restored from, and the host takes it for any revision it has reached: after
 * a withdrawal the prompt is kept whole or released, never rewritten, so an
 * acknowledgement of an earlier withdrawn revision is one of the same text.
 */
export const chatMessageDeliverySchema = lazySchema(() =>
  z.object({
    messageId: z.string(),
    revision: z.number().int().positive(),
    state: chatMessageDeliveryStateSchema,
  }),
);
export type ChatMessageDelivery = z.infer<typeof chatMessageDeliverySchema>;
