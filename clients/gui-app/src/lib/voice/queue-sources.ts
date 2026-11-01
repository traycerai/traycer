import type { OpenMessage } from "@traycer/protocol/host/agent/gui/open-harness-wire";
import type {
  BotActivity,
  BotSessionActivity,
} from "@traycer/protocol/host/bot/schemas";
import { composerDisplayPlainText } from "@/lib/composer/composer-clipboard";
import { classifyNotificationLifecycle } from "@/lib/notifications/notification-lifecycle";
import { openQuestionOf, replyTextOf } from "@/lib/voice/focused-replies";
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
 * A row of a bot's conversation the person has not seen, as an unread
 * notification names it: a bot's answer to their post (`bot.thread.verdict`),
 * a reply in a thread they follow (a teammate's included), a direct reply, a
 * row that mentions them, or a bot's own question to them (`bot.question`,
 * which waits on the person). Ids only; the row it names is hydrated from the
 * records by `(botId, chatId, messageId)`.
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
  /** It waits on the person (a bot's question), as the blocking tier says. */
  readonly blocking: boolean;
}

/**
 * The bot conversation rows the attention tier holds unread, newest first:
 * rows of its answer class, and blocking rows (a bot's question), whose
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
    if (classification.tier === "failure") continue;
    const target = botTargetOf(row);
    if (target === null || seen.has(target.messageId)) continue;
    seen.add(target.messageId);
    refs.push({
      messageId: target.messageId,
      botId: target.botId,
      threadId: target.threadId,
      chatId: target.chatId,
      originHostId: row.originHostId,
      at: row.createdAt,
      blocking: classification.tier === "blocking",
    });
  }
  return refs.sort((a, b) => b.at - a.at);
}

/** The bot conversation row a notification names, from its normalized target. */
function botTargetOf(row: MergedNotificationRow): {
  readonly botId: string;
  readonly threadId: string | null;
  readonly chatId: string;
  readonly messageId: string;
} | null {
  const payload = row.payload;
  if (payload === null || payload.kind !== "chat") return null;
  const bot = payload.bot;
  if (bot === undefined || bot.messageId === null) return null;
  if (payload.chatId === undefined) return null;
  return {
    botId: bot.botId,
    threadId: bot.threadId,
    chatId: payload.chatId,
    messageId: bot.messageId,
  };
}

/**
 * Prompts in the attention tier that wait on the person, by kind, each by
 * the id that names what waits: an approval's or a question block's id (the
 * same id a bot post's surface names), a bot question's message id, else the
 * row's own feed id. The ids let a briefing leave out what the queue already
 * names.
 */
export interface AttentionPrompts {
  readonly approvals: ReadonlyArray<string>;
  readonly questions: ReadonlyArray<string>;
}

/**
 * The unread blocking prompts, by the row's kind and ids alone: an approval
 * or a question an agent waits on, and a bot's own question. Counted, never
 * read: their copy is the bell's.
 */
export function attentionPromptsOf(
  rows: ReadonlyArray<MergedNotificationRow>,
): AttentionPrompts {
  const approvals: string[] = [];
  const questions: string[] = [];
  for (const row of rows) {
    const classification = classifyNotificationLifecycle(row);
    if (classification.section !== "attention") continue;
    if (classification.tier !== "blocking") continue;
    const target = botTargetOf(row);
    if (target !== null) {
      questions.push(target.messageId);
    } else if (row.hostKind === "approval.requested") {
      approvals.push(row.sourceRef ?? row.feedId);
    } else if (row.hostKind === "interview.requested") {
      questions.push(row.sourceRef ?? row.feedId);
    }
  }
  return { approvals, questions };
}

type AssistantRow = Extract<OpenMessage, { readonly role: "assistant" }>;
type UserRow = Extract<OpenMessage, { readonly role: "user" }>;

/** What a hydrated row is, read from the row itself. */
export interface HydratedEntry {
  readonly kind: Extract<
    QueueItemKind,
    "reply" | "question" | "surface" | "message"
  >;
  /** The row's words: a bot row's text blocks less provider notices, a member's message as written. */
  readonly content: string;
  /** The member who wrote a `message`; `null` for the bot's own rows. */
  readonly authorUserId: string | null;
  /** An open question's choices, read as an explicit list; empty otherwise. */
  readonly options: ReadonlyArray<string>;
  /** The approval or question block an open surface names; `null` otherwise. */
  readonly surfaceId: string | null;
}

/**
 * The slice of a row the hydration reads: a bot's row, or a member's (a
 * teammate's reply in a thread the person follows). Every `OpenMessage` is
 * one.
 */
export type HydrationRow =
  | Pick<AssistantRow, "role" | "messageId" | "blocks" | "question" | "surface">
  | Pick<UserRow, "role" | "messageId" | "sender" | "message">;

/**
 * What a bot row asks of the person, read from the row's own metadata: an
 * open question (its choices kept for the read), or an open approval or
 * question of a task the row's surface points at. `null` for a row that
 * asks nothing open. Hydration reads a row's kind and choices from it; the
 * announcement fallback keeps out every row that asked, open or settled,
 * with `askedThePerson`.
 */
export function promptOf(
  row: Pick<AssistantRow, "question" | "surface">,
): Pick<HydratedEntry, "kind" | "options" | "surfaceId"> | null {
  const open = openQuestionOf(row);
  if (open !== null) {
    return { kind: "question", options: open.options, surfaceId: null };
  }
  const surface = row.surface;
  if (
    surface !== undefined &&
    surface.resolution === null &&
    (surface.kind === "approval" || surface.kind === "question")
  ) {
    return {
      kind: "surface",
      options: [],
      surfaceId:
        surface.kind === "approval" ? surface.approvalId : surface.blockId,
    };
  }
  return null;
}

/**
 * The row behind a reference, as the records hold it: a question while one
 * of its questions is open (its choices kept for the read); a task agent's
 * question or approval while the surface it points at is open; else a reply.
 * `null` for a row with no prose, which nothing can say.
 */
export function hydratedEntryOf(row: HydrationRow): HydratedEntry | null {
  if (row.role === "user") {
    const content =
      row.message.kind === "user"
        ? composerDisplayPlainText(row.message.content).trim()
        : "";
    if (content.length === 0) return null;
    return {
      kind: "message",
      content,
      authorUserId: row.sender.type === "user" ? row.sender.userId : null,
      options: [],
      surfaceId: null,
    };
  }
  const content = replyTextOf(row);
  if (content.length === 0) return null;
  const prompt = promptOf(row);
  if (prompt !== null) {
    return { ...prompt, content, authorUserId: null };
  }
  return {
    kind: "reply",
    content,
    authorUserId: null,
    options: [],
    surfaceId: null,
  };
}

/** The slice of a channel row the announcement watch reads. */
export type AnnouncementRow =
  | Pick<
      Extract<OpenMessage, { readonly role: "user" }>,
      "role" | "messageId" | "timestamp" | "conversationRequest"
    >
  | Pick<
      AssistantRow,
      | "role"
      | "messageId"
      | "timestamp"
      | "blocks"
      | "repliesTo"
      | "question"
      | "surface"
    >;

/** An announcement at a channel's top level, read from the row. */
export interface Announcement {
  readonly messageId: string;
  readonly content: string;
  readonly at: number;
}

/**
 * Whether a bot row asked the person something, open or since settled: it
 * carries a question, or a surface pointing at a task's approval or
 * question. Such a row is never an announcement; once settled it is simply
 * nothing more to say.
 */
function askedThePerson(
  row: Pick<AssistantRow, "question" | "surface">,
): boolean {
  return (
    row.question !== undefined ||
    row.surface?.kind === "approval" ||
    row.surface?.kind === "question"
  );
}

/**
 * The bot's rows of a channel that answer nothing and ask nothing: no direct
 * reply's `repliesTo`, no member's request in the channel resolved to them,
 * and no question or surfaced prompt, open or settled (`askedThePerson`),
 * which is a question to the person wherever it sits. Rows at or before `since` are history. In
 * the store's order, which is oldest first.
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
    if (askedThePerson(row)) continue;
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
  /** When the session started the answer; `null` when the stream does not say. */
  readonly at: number | null;
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
      at: session.startedAt,
    });
  };
  if (activity.trunk !== null) add(null, activity.trunk);
  for (const [threadId, session] of Object.entries(activity.threads)) {
    add(threadId, session);
  }
  return stopped;
}
