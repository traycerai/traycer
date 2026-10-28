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
    /** The bot's channel: the conversation record the post or its thread hangs off. */
    conversationId: z.string().min(1).max(255),
    text: z.string().min(1).max(100_000),
    /**
     * `null` (or absent) posts at the channel's top level, which opens a
     * thread run by a thread session of the bot (T41), or, for a bot in
     * reply mode `direct`, is answered by the bot itself at the top level
     * and opens no thread; a thread id puts the
     * message in that thread of `conversationId`, delivered to the thread's
     * session.
     */
    threadId: z.string().min(1).max(36).nullable().default(null),
    /**
     * A reply under a row of `conversationId` that roots a thread: a
     * `question` or `proposal` announcement (decision 55), a member's post
     * its bot answered at the top level (a `direct` post), or the bot's
     * direct answer to such a post (decision 114), whose thread is its own
     * and not the post's. The message opens, or joins, the thread hung off
     * that row, as its first request when it opens it. Only a bound host
     * whose `bot.thread.list` names `"answer"` in `threadAnchors.kinds` takes a
     * reply under a direct answer. `null` (or absent) otherwise; never set
     * with `threadId`.
     */
    announcementId: z.string().min(1).max(255).nullable().default(null),
    /**
     * `bot.conversation.send@1.1`: a retry. Re-delivers the post whose
     * request is `requestId`, as it was, to the session it went to; no row
     * is written and `text` is not read. The bound host refuses with
     * `REQUEST_NOT_FAILED` unless that request is open and its session is
     * failed or parked on it. `null` (or absent) for a new post.
     */
    redeliver: z
      .object({ requestId: z.string().min(1).max(255) })
      .nullable()
      .default(null),
    /**
     * `bot.conversation.send@1.1`: the request of a failed post this one
     * replaces (an edit sent again). The bound host resolves it as
     * superseded, so it owes no answer; its row stays. `null` (or absent)
     * otherwise; never set with `redeliver`.
     */
    supersedes: z.string().min(1).max(255).nullable().default(null),
  }),
);
export type BotConversationSendRequest = z.infer<
  typeof botConversationSendRequestSchema
>;

/** The 1.0 request, frozen by hand: without `redeliver` and `supersedes`. */
export const botConversationSendRequestSchemaV10 = lazySchema(() =>
  z.object({
    botId: botIdSchema,
    conversationId: z.string().min(1).max(255),
    text: z.string().min(1).max(100_000),
    threadId: z.string().min(1).max(36).nullable().default(null),
    announcementId: z.string().min(1).max(255).nullable().default(null),
  }),
);

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
    /**
     * The thread the message is in: the request's own thread when it was a
     * top-level post (derived from the message, so it is known even while
     * the message waits in the mailbox), the named one otherwise. `null` for
     * a top-level post the bot answers itself (reply mode `direct`): its
     * answer lands on the channel, and no thread opens.
     */
    threadId: z.string().min(1).nullable(),
  }),
);
export type BotConversationSendResponse = z.infer<
  typeof botConversationSendResponseSchema
>;

// ---- bot.thread.list (T41) --------------------------------------------- //

/**
 * The post a thread hangs off, as its list row shows it. It names the post
 * and carries no text: a client reads the text from the channel's row
 * `messageId` names, and a summary stays one small entry wherever it is
 * kept (the bot's environment room holds one per thread, T65).
 */
export const botThreadAnchorSchema = lazySchema(() =>
  z.object({
    messageId: z.string().min(1),
    requestId: z.string().min(1),
    /** The member who posted it. */
    senderUserId: z.string().min(1).nullable(),
    sentAt: z.number().int(),
    /** When the thread's verdict resolved the post's request; `null` while open. */
    resolvedAt: z.number().int().nullable(),
  }),
);
export type BotThreadAnchor = z.infer<typeof botThreadAnchorSchema>;

/**
 * One thread of a bot's channel: the thread record (`tenant_kind =
 * "thread"`) that holds its messages and replies, and the bot's thread
 * session that runs it.
 */
export const botThreadSummarySchema = lazySchema(() =>
  z.object({
    threadId: z.string().min(1),
    conversationId: z.string().min(1),
    sessionChatId: z.string().min(1),
    /** The post the thread answers; `null` once it is gone from the channel. */
    anchor: botThreadAnchorSchema.nullable(),
    /** Rows of the thread record: members' messages and the bot's replies. */
    replyCount: z.number().int().nonnegative(),
    lastReplyAt: z.number().int().nullable(),
    /** Open requests of the thread, the anchor's included while it is open. */
    openRequestCount: z.number().int().nonnegative(),
    /**
     * What the thread's sessions have cost in USD on the bound host, every
     * member's turns; `null` when this host cannot say.
     */
    costUsd: z.number().nonnegative().nullable(),
  }),
);
export type BotThreadSummary = z.infer<typeof botThreadSummarySchema>;

/**
 * Answered by any host: the bound one from its own store, any other from
 * the summaries the bound host keeps in the bot's environment room (T65).
 * Most recent activity first.
 */
export const botThreadListRequestSchema = lazySchema(() =>
  z.object({ botId: botIdSchema }),
);
export type BotThreadListRequest = z.infer<typeof botThreadListRequestSchema>;

/** `bot.thread.list@1.0`'s response, frozen by hand: without `threadAnchors`. */
export const botThreadListResponseSchemaV10 = lazySchema(() =>
  z.object({
    threads: z.array(botThreadSummarySchema),
    /**
     * What the bot's trunk has cost in USD on the bound host, every member's
     * turns; `null` when this host cannot say. The bot's figure is this plus
     * its threads'.
     */
    trunkCostUsd: z.number().nonnegative().nullable(),
  }),
);

/**
 * The `threadAnchors` value naming the bot's direct answer in the channel
 * (decision 114): a member's reply under one opens the answer's own thread.
 */
export const BOT_THREAD_ANCHOR_ANSWER = "answer";

/**
 * The channel rows, beyond a member's post, a question, a proposal and a
 * direct post, under which one binding of the bot opens a thread when a
 * member replies. They hold for that binding only: a client compares
 * `hostId` and `epoch` with the bot's binding as it knows it, and reads
 * none while they differ.
 */
export const botThreadAnchorsSchema = lazySchema(() =>
  z.object({
    /** The bound host that said them. */
    hostId: z.string().min(1).max(255),
    /** The bot's epoch on that host when it said them. */
    epoch: z.number().int().nonnegative(),
    /**
     * `"answer"` ({@link BOT_THREAD_ANCHOR_ANSWER}) is the bot's direct
     * answer. A value a client does not know is ignored.
     */
    kinds: z.array(z.string().min(1).max(64)).max(16),
  }),
);
export type BotThreadAnchors = z.infer<typeof botThreadAnchorsSchema>;

export const botThreadListResponseSchema = lazySchema(() =>
  botThreadListResponseSchemaV10.extend({
    /**
     * `bot.thread.list@1.1`: the rows the bot's bound host opens a thread
     * under. `null` when it has not said, as a host that predates the minor
     * and one whose room values are not written yet: a reply under such a
     * row is then refused.
     */
    threadAnchors: botThreadAnchorsSchema.nullable(),
  }),
);
export type BotThreadListResponse = z.infer<typeof botThreadListResponseSchema>;
