import { z } from "zod";

/**
 * Doc-replica read for one chat: the fallback for a chat whose owning host is
 * unreachable and which was never published to the cloud. The epic Y.Doc
 * syncs to every host regardless of who owns a chat, so a serving host can
 * answer this from its own replica even though it never created the chat and
 * has no publication for it.
 *
 * This is deliberately a host-LOCAL, PURE read - no cloud round trip, no
 * session, no seed, no write. See the host resolver for why it must be
 * structurally incapable of writing (the single-writer invariant).
 */
export const chatReplicaReadRequestSchema = z.object({
  epicId: z.string().min(1),
  chatId: z.string().min(1),
});
export type ChatReplicaReadRequest = z.infer<
  typeof chatReplicaReadRequestSchema
>;

export const chatReplicaReadChatRecordSchema = z.object({
  chatId: z.string().min(1),
  title: z.string(),
  userId: z.string(),
  hostId: z.string(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type ChatReplicaReadChatRecord = z.infer<
  typeof chatReplicaReadChatRecordSchema
>;

/**
 * `messages`/`events` are raw JSON records, NOT re-validated through
 * `messageSchema`/`chatEventSchema` here. A doc row can have been written by
 * an older build than this host is running, and the wire must carry it as-is
 * so the CLIENT - which knows its own build's schemas, not the host's - can
 * re-parse per record with per-block tolerance. Same philosophy as the
 * published-copy conversion (`convertPublishedChat`).
 */
const chatReplicaReadRawRecordSchema = z.record(z.string(), z.unknown());

export const chatReplicaReadOkOutcomeSchema = z.object({
  status: z.literal("ok"),
  chat: chatReplicaReadChatRecordSchema,
  messages: z.array(chatReplicaReadRawRecordSchema),
  events: z.array(chatReplicaReadRawRecordSchema),
});
export type ChatReplicaReadOkOutcome = z.infer<
  typeof chatReplicaReadOkOutcomeSchema
>;

/** No doc-resident content for this chat on the serving host. */
export const chatReplicaReadAbsentOutcomeSchema = z.object({
  status: z.literal("absent"),
});
export type ChatReplicaReadAbsentOutcome = z.infer<
  typeof chatReplicaReadAbsentOutcomeSchema
>;

export const chatReplicaReadOutcomeSchema = z.discriminatedUnion("status", [
  chatReplicaReadOkOutcomeSchema,
  chatReplicaReadAbsentOutcomeSchema,
]);
export type ChatReplicaReadOutcome = z.infer<
  typeof chatReplicaReadOutcomeSchema
>;

export const chatReplicaReadResponseSchema = z.object({
  outcome: chatReplicaReadOutcomeSchema,
});
export type ChatReplicaReadResponse = z.infer<
  typeof chatReplicaReadResponseSchema
>;
