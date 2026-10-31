import type { OpenMessage } from "@traycer/protocol/host/agent/gui/open-harness-wire";

/**
 * The hear loop's focused source (Tracy Bots voice, VT2): a new row of the
 * bot on the focused thread's (or channel's) chat store. The store is the
 * one source and the message id the one dedupe key; nothing is read out of
 * notification copy.
 */

/** A bot's reply as the voice is given it: the row, and its prose. */
export interface FocusedReply {
  readonly messageId: string;
  /** The row's text blocks joined; provider notices are not the bot's words. */
  readonly text: string;
}

type AssistantRow = Extract<OpenMessage, { readonly role: "assistant" }>;
type UserRow = Extract<OpenMessage, { readonly role: "user" }>;

/**
 * What the watch reads of a chat row: who wrote it, its id, a bot row's
 * blocks and a member row's request (which names the bot row that answered
 * it). Every `OpenMessage` is one; a test builds the slice alone.
 */
export type ReplyRow =
  | Pick<UserRow, "role" | "messageId" | "timestamp" | "conversationRequest">
  | Pick<AssistantRow, "role" | "messageId" | "timestamp" | "blocks">;

/**
 * What a watch remembers about one chat for the user session: the rows it
 * has seen, and the newest row of its baseline, so a row the store hydrates
 * later from before the baseline (a window scrolled back) is history, not
 * an arrival. Outlives the component that watches, so a remount across a
 * replacement speaks what landed in the gap and nothing older.
 */
export interface ReplyWatchMemory {
  readonly seen: Set<string>;
  /** The newest baseline row's timestamp; `0` before a baseline, or for an empty chat. */
  since: number;
  baselined: boolean;
}

export function createReplyWatchMemory(): ReplyWatchMemory {
  return { seen: new Set<string>(), since: 0, baselined: false };
}

/** Takes the loaded snapshot as history: every row seen, none spoken. */
export function baselineReplyWatch(
  memory: ReplyWatchMemory,
  rows: ReadonlyArray<ReplyRow>,
): void {
  for (const row of rows) {
    memory.seen.add(row.messageId);
    if (row.timestamp > memory.since) memory.since = row.timestamp;
  }
  memory.baselined = true;
}

/**
 * The request a bot row answers: the member row whose request resolved to
 * it names its id. `null` for a row that answers no request the chat shows
 * (an announcement, a row whose post is outside the loaded window).
 */
export function requestIdAnsweredBy(
  rows: ReadonlyArray<ReplyRow>,
  replyMessageId: string,
): string | null {
  for (const row of rows) {
    if (row.role !== "user") continue;
    const request = row.conversationRequest;
    if (
      request !== undefined &&
      request.resolvedByMessageId === replyMessageId
    ) {
      return request.requestId;
    }
  }
  return null;
}

/**
 * The bot's rows that arrived since the baseline, oldest first; marks them
 * seen. Rows of the baseline, and rows older than its newest (hydrated later
 * from history), are never spoken: the person asked for what comes next. A
 * row with no prose (a tool call alone, a notice) is seen and not spoken.
 */
export function takeNewBotReplies(
  messages: ReadonlyArray<ReplyRow>,
  memory: ReplyWatchMemory,
): ReadonlyArray<FocusedReply> {
  const fresh: FocusedReply[] = [];
  for (const message of messages) {
    if (memory.seen.has(message.messageId)) continue;
    memory.seen.add(message.messageId);
    if (message.role !== "assistant") continue;
    if (message.timestamp <= memory.since) continue;
    const text = replyTextOf(message);
    if (text.length === 0) continue;
    fresh.push({ messageId: message.messageId, text });
  }
  return fresh;
}

/** The prose of an assistant row: its text blocks, less the provider notices. */
function replyTextOf(message: Pick<AssistantRow, "blocks">): string {
  return message.blocks
    .flatMap((block) =>
      block.type === "text" && block.providerNotice === null
        ? [block.text]
        : [],
    )
    .join("\n\n")
    .trim();
}

/**
 * What the voice is given for a reply: the bot's words, quoted by the bot's
 * name when the focus is on another bot than the one whose voice this is
 * (V1), and bare when it is that bot's own channel.
 */
export function replySpeechText(input: {
  readonly botTitle: string;
  readonly speaksAsThisBot: boolean;
  readonly content: string;
}): string {
  const content = input.content.trim();
  return input.speaksAsThisBot
    ? content
    : `${input.botTitle} answered: ${content}`;
}
