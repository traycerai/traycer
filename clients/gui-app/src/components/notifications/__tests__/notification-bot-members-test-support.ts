import { screen, within } from "@testing-library/react";
import type { HostNotificationFeedEntry } from "@/stores/notifications/host-notifications-store";

type FinishedOperationEntry = Extract<
  HostNotificationFeedEntry,
  { kind: "host.operation.finished" }
>;

/**
 * Bot conversation rows as the producer writes them (event and operation
 * pairs, severity and outcome), for the suites that fold a bot's replies by
 * thread or channel.
 */

export const BOT = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const OTHER_BOT = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAW";
export const CHANNEL = "conversation-main";

/** The operation the producer pairs with each event. */
const OPERATION_OF_EVENT: Readonly<Record<string, string>> = {
  reply: "bot.reply",
  verdict: "bot.thread.verdict",
  directAnswer: "bot.thread.verdict",
  announcement: "bot.announcement",
  post: "bot.post",
  question: "bot.question",
  failure: "bot.failure",
  questionSettled: "bot.questionSettled",
};

export interface BotMember {
  readonly id: string;
  /** The host's order for the row, which is its created time. */
  readonly at: number;
  readonly readAt: number | null;
  readonly text: string;
  readonly event: string;
  readonly operation: string | null;
  readonly botId: string;
  readonly conversationId: string;
  readonly threadId: string | null;
  readonly messageId: string | null;
  readonly severity: FinishedOperationEntry["severity"];
  readonly outcome: FinishedOperationEntry["outcome"];
}

/** A reply or post the way the producer writes it, with `over` changing only what a case is about. */
export function botMember(
  id: string,
  at: number,
  text: string,
  over: Partial<BotMember>,
): HostNotificationFeedEntry {
  const base: BotMember = {
    id,
    at,
    readAt: null,
    text,
    event: "reply",
    operation: null,
    botId: BOT,
    conversationId: CHANNEL,
    threadId: null,
    messageId: null,
    severity: "done",
    outcome: "completed",
  };
  const member: BotMember = { ...base, ...over };
  return {
    id: member.id,
    updatedAt: member.at,
    readAt: member.readAt,
    kind: "host.operation.finished",
    sourceRef: member.id,
    severity: member.severity,
    outcome: member.outcome,
    epicId: member.botId,
    chatId: member.threadId ?? member.conversationId,
    payload: {
      kind: "bot_conversation",
      event: member.event,
      operation: member.operation ?? OPERATION_OF_EVENT[member.event],
      title: "Tracy",
      message: member.text,
      botId: member.botId,
      conversationId: member.conversationId,
      threadId: member.threadId,
      messageId: member.messageId ?? member.id,
      authorUserId: "user-other",
      mention: false,
    },
  };
}

/** An ordinary informational post to a channel, the unthreaded kind. */
export function channelPost(
  id: string,
  at: number,
  text: string,
  over: Partial<BotMember>,
): HostNotificationFeedEntry {
  return botMember(id, at, text, {
    event: "post",
    severity: "info",
    ...over,
  });
}

/** The thread verdict older hosts write, with a thread id and no conversation. */
export function legacyVerdict(
  id: string,
  at: number,
  text: string,
): HostNotificationFeedEntry {
  return {
    id,
    updatedAt: at,
    readAt: null,
    kind: "host.operation.finished",
    sourceRef: id,
    severity: "done",
    outcome: "completed",
    epicId: BOT,
    chatId: "thread-a",
    payload: {
      kind: "bot_thread_verdict",
      operation: "bot.thread.verdict",
      title: "Tracy answered",
      message: text,
      botId: BOT,
      threadId: "thread-a",
      replyMessageId: id,
    },
  };
}

/** What a row shows apart from its time, which carries digits of its own. */
export function bodyOf(row: HTMLElement): string {
  const clone = row.cloneNode(true);
  if (!(clone instanceof HTMLElement)) throw new Error("not an element");
  for (const time of clone.querySelectorAll(
    '[data-testid="notification-timestamp"]',
  )) {
    time.remove();
  }
  return clone.textContent;
}

export function entries(): HTMLElement[] {
  return screen.getAllByTestId("notification-entry");
}

/** The one row that shows `text`; the case fails when none or several do. */
export function rowShowing(text: string): HTMLElement {
  const found = entries().filter((row) => bodyOf(row).includes(text));
  if (found.length !== 1) {
    throw new Error(
      `expected one row showing "${text}", found ${String(found.length)}`,
    );
  }
  return found[0];
}

export const hasUnreadRail = (row: HTMLElement): boolean =>
  within(row).queryByTestId("notification-unread-rail") !== null;

/**
 * Whether a row shows `count` as a number of its own. The row's parts sit
 * side by side with no space between their texts, so a word boundary cannot
 * tell the count from the preview's last letter; only another digit does.
 */
export function showsCount(row: HTMLElement, count: number): boolean {
  return new RegExp(`(?<![0-9])${String(count)}(?![0-9])`).test(bodyOf(row));
}
