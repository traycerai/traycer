import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { botIdSchema } from "./schemas";

/**
 * `bot.conversation.*` schemas (Tracy Bots T7), kept apart from `schemas.ts`
 * so the bot record and task schemas can move without touching these. Every
 * schema is a `lazySchema` thunk, as in `schemas.ts`.
 */

// ---- bot.conversation.list / bot.conversation.send (T7) ---------------- //

/**
 * One conversation record under a bot: the chat row the cloud files as
 * `tenant_kind = "conversation"` under `task_id = botId`. A human reaches the
 * bot only through one of these - it carries user rows and bot-reply rows and
 * nothing else, and every user row opens a request the bot's trunk resolves
 * (`conversationRequestSchema` on the user row).
 */
export const botConversationRecordSchema = lazySchema(() =>
  z.object({
    conversationId: z.string().min(1),
    botId: botIdSchema,
    /** `null` until something titles it; the app conversation ships untitled. */
    title: z.string().nullable(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  }),
);
export type BotConversationRecord = z.infer<typeof botConversationRecordSchema>;

/**
 * Served from the cloud's chat list under the caller's bearer, so it answers
 * from any host, like `bot.list`.
 */
export const botConversationListRequestSchema = lazySchema(() =>
  z.object({ botId: botIdSchema }),
);
export type BotConversationListRequest = z.infer<
  typeof botConversationListRequestSchema
>;

export const botConversationListResponseSchema = lazySchema(() =>
  z.object({
    conversations: z.array(botConversationRecordSchema),
  }),
);
export type BotConversationListResponse = z.infer<
  typeof botConversationListResponseSchema
>;

/**
 * One human message into a conversation. The host mints the message id and
 * the request id and writes the user row with `conversationRequest` open.
 *
 * Accepted whether or not the bot's bound host is reachable: a send on the
 * bound host writes the row and queues the trunk's `conversation-message` item
 * in-line (`delivery: "written"`); a send anywhere else hands the message to
 * the bound host through the cross-host mailbox (`delivery: "queued"`), and
 * the row materializes there when it drains. The request id is minted at
 * send either way, so the caller can show it and a redelivery after a crash
 * between write and acknowledgement writes no second row.
 */
export const botConversationSendRequestSchema = lazySchema(() =>
  z.object({
    botId: botIdSchema,
    conversationId: z.string().min(1).max(255),
    text: z.string().min(1).max(100_000),
  }),
);
export type BotConversationSendRequest = z.infer<
  typeof botConversationSendRequestSchema
>;

export const botConversationSendDeliverySchema = lazySchema(() =>
  z.enum(["written", "queued"]),
);
export type BotConversationSendDelivery = z.infer<
  typeof botConversationSendDeliverySchema
>;

export const botConversationSendResponseSchema = lazySchema(() =>
  z.object({
    messageId: z.string().min(1),
    requestId: z.string().min(1),
    delivery: botConversationSendDeliverySchema,
  }),
);
export type BotConversationSendResponse = z.infer<
  typeof botConversationSendResponseSchema
>;
