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

/**
 * What the watch reads of a chat row: who wrote it, its id, and a bot row's
 * blocks. Every `OpenMessage` is one; a test builds the slice alone.
 */
export type ReplyRow =
  | { readonly role: "user"; readonly messageId: string }
  | Pick<AssistantRow, "role" | "messageId" | "blocks">;

/**
 * The bot's rows that arrived since `seen` was taken, oldest first; marks
 * them seen. Rows present when the watch began are never spoken: the person
 * asked for what comes next, not for the history. A row with no prose (a
 * tool call alone, a notice) is seen and not spoken.
 */
export function takeNewBotReplies(
  messages: ReadonlyArray<ReplyRow>,
  seen: Set<string>,
): ReadonlyArray<FocusedReply> {
  const fresh: FocusedReply[] = [];
  for (const message of messages) {
    if (seen.has(message.messageId)) continue;
    seen.add(message.messageId);
    if (message.role !== "assistant") continue;
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

/** Every row id the watch starts from. */
export function seenMessageIds(messages: ReadonlyArray<ReplyRow>): Set<string> {
  return new Set(messages.map((message) => message.messageId));
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
