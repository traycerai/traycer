/**
 * How a bot's views describe its tasks and the posts they came from (Tracy
 * Bots): the thread panel's task list and the bot's Activity page.
 */

import type { OpenMessage } from "@traycer/protocol/persistence/epic/open-harness-records";
import {
  BOT_THREAD_ANCHOR_ANSWER,
  BOT_THREAD_ANCHOR_MESSAGE,
  type BotThreadSummary,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotTaskEntry } from "@traycer/protocol/host/bot/schemas";
import {
  conversationRequestMessageId,
  type BotAnnouncementKind,
} from "@traycer/protocol/persistence/epic/messages";

const MINUTE_S = 60;
const HOUR_S = 3600;
const DAY_S = 86_400;

/**
 * An automation's interval as a short phrase ("every 6 hours"); `null` for a
 * one-off task, and for a task the bot no longer runs.
 */
export function describeTaskInterval(task: BotTaskEntry): string | null {
  if (task.state !== "tracking" || task.cadence.kind !== "every") return null;
  return `every ${describeSeconds(task.cadence.seconds)}`;
}

/** One of the bot's chats watching the person's notifications (T84), in words. */
export function describeNotificationWatch(watch: {
  readonly attentionOnly: boolean;
  readonly everySeconds: number | null;
}): string {
  const what = watch.attentionOnly ? "attention only" : "everything";
  const when =
    watch.everySeconds === null
      ? "on event"
      : `every ${describeSeconds(watch.everySeconds)}`;
  return `Watching your notifications (${what}, ${when})`;
}

function describeSeconds(seconds: number): string {
  if (seconds % DAY_S === 0) return plural(seconds / DAY_S, "day");
  if (seconds % HOUR_S === 0) return plural(seconds / HOUR_S, "hour");
  if (seconds % MINUTE_S === 0) return `${seconds / MINUTE_S} min`;
  return `${seconds} s`;
}

function plural(count: number, unit: string): string {
  return count === 1 ? unit : `${count} ${unit}s`;
}

/** Tasks the bot still runs first, each group in the list's own order. */
export function sortTasksForDisplay(
  tasks: ReadonlyArray<BotTaskEntry>,
): ReadonlyArray<BotTaskEntry> {
  return [...tasks].sort((a, b) => stateRank(a) - stateRank(b));
}

function stateRank(task: BotTaskEntry): number {
  return task.state === "tracking" ? 0 : 1;
}

/**
 * Where the message a task was set up for is (Tracy Bots T82): a member's
 * message, whose row id its request id names. On the channel when it is the
 * post a thread hangs off (`thread`, the thread it opens), or the trunk set
 * the task up; in the creating thread's record (`thread-message`) otherwise,
 * the reply that opened a thread under a question, proposal or direct post
 * included: that thread's anchor is the post it replied under, while the
 * request is the reply's. `null` for a task set up for no request, and for a
 * trunk's task while the channel is not known.
 */
export type BotTaskRequestPost =
  | {
      readonly kind: "channel";
      readonly chatId: string;
      readonly messageId: string;
      readonly thread: BotThreadSummary | null;
    }
  | {
      readonly kind: "thread-message";
      readonly threadId: string;
      readonly messageId: string;
    };

export function taskRequestPost(
  task: BotTaskEntry,
  threads: ReadonlyArray<BotThreadSummary>,
  channelId: string | null,
): BotTaskRequestPost | null {
  if (task.originRequestId === null) return null;
  const messageId = conversationRequestMessageId(task.originRequestId);
  const opened = threads.find(
    (thread) => thread.anchor?.messageId === messageId,
  );
  if (opened !== undefined) {
    return {
      kind: "channel",
      chatId: opened.conversationId,
      messageId,
      thread: opened,
    };
  }
  if (task.createdByChatId !== null) {
    return {
      kind: "thread-message",
      threadId: task.createdByChatId,
      messageId,
    };
  }
  if (channelId === null) return null;
  return { kind: "channel", chatId: channelId, messageId, thread: null };
}

/**
 * How the channel opens the thread hung off `row` (decision 114), as its
 * own row's "Reply in thread" does: a member's post opens its own thread,
 * and a direct post the box whose first reply starts one; a question or a
 * proposal opens its thread through that box too, and every other row of
 * the bot as well (T68), marked with the thread anchor its thread takes a
 * send under only while the bot's binding names it: `"answer"` for a
 * direct reply, `"message"` for the rest.
 */
export function threadOpenOf(row: OpenMessage): {
  readonly announcement: boolean;
  readonly anchorKind: string | null;
} {
  if (row.role === "user") {
    return {
      announcement: row.conversationRequest?.direct === true,
      anchorKind: null,
    };
  }
  return {
    announcement: true,
    anchorKind: botRowThreadAnchorKind({
      announcementKind: row.announcement?.kind ?? null,
      asksQuestion: row.question !== undefined,
      repliesToPost: row.repliesTo !== undefined,
    }),
  };
}

/** The host capability a bot row needs to root a thread; questions need none. */
export function botRowThreadAnchorKind(input: {
  readonly announcementKind: BotAnnouncementKind | null;
  readonly asksQuestion: boolean;
  readonly repliesToPost: boolean;
}): string | null {
  const { announcementKind, asksQuestion, repliesToPost } = input;
  if (
    announcementKind === "question" ||
    announcementKind === "proposal" ||
    asksQuestion
  ) {
    return null;
  }
  return announcementKind === null && repliesToPost
    ? BOT_THREAD_ANCHOR_ANSWER
    : BOT_THREAD_ANCHOR_MESSAGE;
}

/** A post's first line, as a task row names the request it came from. */
export function firstLineOf(text: string | null): string | null {
  const line = text?.trim().split("\n", 1)[0]?.trim() ?? "";
  return line.length === 0 ? null : line;
}
