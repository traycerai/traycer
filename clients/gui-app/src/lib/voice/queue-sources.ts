import type { OpenMessage } from "@traycer/protocol/host/agent/gui/open-harness-wire";
import type {
  BotActivity,
  BotSessionActivity,
} from "@traycer/protocol/host/bot/schemas";
import { classifyNotificationLifecycle } from "@/lib/notifications/notification-lifecycle";
import { replyTextOf } from "@/lib/voice/focused-replies";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";
import type { QueueItemKind } from "@/stores/voice/voice-session-store";

/**
 * The voice queue's event sources (Tracy Bots voice, VT4; the tech plan's
 * "Event sources" table): one source, one hydration path and one dedupe key
 * per event class. A notification row gives ids only; what is said is read
 * from the chat records the row points at. Nothing is read out of
 * notification copy: no row's title, body or excerpt reaches this module's
 * output.
 */

/**
 * A reply the person has not seen, as an unread notification names it: a
 * bot's answer to their post (`bot.thread.verdict`), a reply in a thread they
 * follow, a direct reply, a row that mentions them. Ids only; the row it
 * names is hydrated from the records by `(botId, chatId, messageId)`.
 */
export interface ReplyRef {
  /** The dedupe key: the reply's message id, shared with the chat-store view. */
  readonly messageId: string;
  readonly botId: string;
  /** `null` for a row of the channel no thread hangs off. */
  readonly threadId: string | null;
  /** The chat whose records hold the row: the thread, else the channel. */
  readonly chatId: string;
  /** The machine the row happened on; `null` when the feed does not say. */
  readonly originHostId: string | null;
  readonly at: number;
}

/**
 * The bot replies the attention tier holds unread, newest first: rows whose
 * normalized target names a bot, a chat and a message. A row the person has
 * read is not one: the queue never reads the read state again once an item
 * exists, so this only decides what a session starts with or what arrives.
 */
export function replyRefsOf(
  rows: ReadonlyArray<MergedNotificationRow>,
): ReadonlyArray<ReplyRef> {
  const refs: ReplyRef[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const classification = classifyNotificationLifecycle(row);
    if (classification.section !== "attention") continue;
    if (classification.tier !== "answer") continue;
    const payload = row.payload;
    if (payload === null || payload.kind !== "chat") continue;
    const bot = payload.bot;
    if (bot === undefined || bot.messageId === null) continue;
    const chatId = payload.chatId;
    if (chatId === undefined || seen.has(bot.messageId)) continue;
    seen.add(bot.messageId);
    refs.push({
      messageId: bot.messageId,
      botId: bot.botId,
      threadId: bot.threadId,
      chatId,
      originHostId: row.originHostId,
      at: row.createdAt,
    });
  }
  return refs.sort((a, b) => b.at - a.at);
}

/** Prompts in the attention tier that wait on the person, by kind. */
export interface AttentionPrompts {
  readonly approvals: number;
  readonly questions: number;
}

/**
 * The unread blocking prompts, counted by the row's kind alone: an approval
 * or a question an agent waits on. Counted, never read: their copy is the
 * bell's.
 */
export function attentionPromptsOf(
  rows: ReadonlyArray<MergedNotificationRow>,
): AttentionPrompts {
  let approvals = 0;
  let questions = 0;
  for (const row of rows) {
    const classification = classifyNotificationLifecycle(row);
    if (classification.section !== "attention") continue;
    if (classification.tier !== "blocking") continue;
    if (row.hostKind === "approval.requested") approvals += 1;
    if (row.hostKind === "interview.requested") questions += 1;
  }
  return { approvals, questions };
}

type AssistantRow = Extract<OpenMessage, { readonly role: "assistant" }>;

/** What a hydrated row is, read from the row itself. */
export interface HydratedEntry {
  readonly kind: Extract<QueueItemKind, "reply" | "question" | "surface">;
  /** The bot's words: the row's text blocks, less provider notices. */
  readonly content: string;
  /** An open question's choices, read as an explicit list; empty otherwise. */
  readonly options: ReadonlyArray<string>;
  /** The approval or question block an open surface names; `null` otherwise. */
  readonly surfaceId: string | null;
}

/** The slice of a bot row the hydration reads; every `OpenMessage` bot row is one. */
export type HydrationRow = Pick<
  AssistantRow,
  "role" | "messageId" | "blocks" | "question" | "surface"
>;

/**
 * The row behind a reference, as the records hold it: a question while one
 * of its questions is open (its choices kept for the read); a task agent's
 * question or approval while the surface it points at is open; else a reply.
 * `null` for a row with no prose, which nothing can say.
 */
export function hydratedEntryOf(row: HydrationRow): HydratedEntry | null {
  const content = replyTextOf(row);
  if (content.length === 0) return null;
  const open = row.question?.questions.find(
    (question) => question.settlement === null,
  );
  if (open !== undefined) {
    return {
      kind: "question",
      content,
      options: open.options,
      surfaceId: null,
    };
  }
  const surface = row.surface;
  if (
    surface !== undefined &&
    surface.resolution === null &&
    (surface.kind === "approval" || surface.kind === "question")
  ) {
    return {
      kind: "surface",
      content,
      options: [],
      surfaceId:
        surface.kind === "approval" ? surface.approvalId : surface.blockId,
    };
  }
  return { kind: "reply", content, options: [], surfaceId: null };
}

/** The slice of a channel row the announcement watch reads. */
export type AnnouncementRow =
  | Pick<
      Extract<OpenMessage, { readonly role: "user" }>,
      "role" | "messageId" | "timestamp" | "conversationRequest"
    >
  | Pick<
      AssistantRow,
      "role" | "messageId" | "timestamp" | "blocks" | "repliesTo"
    >;

/** An announcement at a channel's top level, read from the row. */
export interface Announcement {
  readonly messageId: string;
  readonly content: string;
  readonly at: number;
}

/**
 * The bot's rows of a channel that answer nothing: no direct reply's
 * `repliesTo`, and no member's request in the channel resolved to them. Rows
 * at or before `since` are history. In the store's order, which is oldest
 * first.
 */
export function announcementsOf(
  rows: ReadonlyArray<AnnouncementRow>,
  since: number,
): ReadonlyArray<Announcement> {
  const answers = new Set<string>();
  for (const row of rows) {
    if (row.role !== "user") continue;
    const resolved = row.conversationRequest?.resolvedByMessageId;
    if (resolved !== undefined && resolved !== null) answers.add(resolved);
  }
  const found: Announcement[] = [];
  for (const row of rows) {
    if (row.role !== "assistant" || row.timestamp <= since) continue;
    if (row.repliesTo !== undefined || answers.has(row.messageId)) continue;
    const content = replyTextOf(row);
    if (content.length === 0) continue;
    found.push({ messageId: row.messageId, content, at: row.timestamp });
  }
  return found;
}

/** A session of a bot that stopped answering a request, from `bot.subscribe`. */
export interface StoppedAnswer {
  /** The dedupe key: the bot and the request it holds. */
  readonly requestId: string;
  readonly threadId: string | null;
  readonly state: "failed" | "parked";
  readonly at: number;
}

/** The failed and parked sessions of a bot's activity snapshot, the trunk first. */
export function stoppedAnswersOf(
  activity: BotActivity | null,
): ReadonlyArray<StoppedAnswer> {
  if (activity === null) return [];
  const stopped: StoppedAnswer[] = [];
  const add = (threadId: string | null, session: BotSessionActivity): void => {
    if (session.state !== "failed" && session.state !== "parked") return;
    if (session.requestId === null) return;
    stopped.push({
      requestId: session.requestId,
      threadId,
      state: session.state,
      at: session.startedAt ?? 0,
    });
  };
  if (activity.trunk !== null) add(null, activity.trunk);
  for (const [threadId, session] of Object.entries(activity.threads)) {
    add(threadId, session);
  }
  return stopped;
}
