import type { OpenMessage } from "@traycer/protocol/persistence/epic/open-harness-records";
import type {
  ChatQueuedTaskCheckinItem,
  ChatQueuedTaskOverdueItem,
  OpenChatQueuedItem,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotTaskEntry } from "@traycer/protocol/host/bot/schemas";
import { conversationRequestMessageId } from "@traycer/protocol/persistence/epic/messages";

/**
 * What the "Under the hood" panel reads off a bot's TRUNK chat (Tracy Bots).
 *
 * A delivered check-in is not stored as a section: the trunk keeps only an
 * `autonomous_resume` block whose trigger is titled {@link
 * TASK_CHECKIN_TRIGGER_TITLE} and carries a one-line summary, and a check-in
 * the trunk has not consumed yet is a `task-checkin` item on its queue.
 */
export const TASK_CHECKIN_TRIGGER_TITLE = "Task check-in";

export interface DeliveredTaskCheckin {
  readonly key: string;
  readonly at: number;
  readonly summary: string;
  readonly status: "completed" | "failed" | "stopped";
}

export function pendingTaskCheckins(
  items: ReadonlyArray<OpenChatQueuedItem>,
): ReadonlyArray<ChatQueuedTaskCheckinItem> {
  const pending: ChatQueuedTaskCheckinItem[] = [];
  for (const item of items) {
    if (item.kind === "task-checkin") pending.push(item);
  }
  return pending;
}

/** The overdue nudge waiting on the trunk's queue, if one is (one per trunk at a time). */
export function pendingTaskOverdue(
  items: ReadonlyArray<OpenChatQueuedItem>,
): ChatQueuedTaskOverdueItem | null {
  for (const item of items) {
    if (item.kind === "task-overdue") return item;
  }
  return null;
}

/** Delivered check-in summaries in transcript order (oldest first). */
export function deliveredTaskCheckins(
  messages: ReadonlyArray<OpenMessage>,
): ReadonlyArray<DeliveredTaskCheckin> {
  const delivered: DeliveredTaskCheckin[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.blocks) {
      if (block.type !== "autonomous_resume") continue;
      block.triggers.forEach((trigger, index) => {
        if (!isTaskCheckinTrigger(trigger.title)) return;
        delivered.push({
          key: `${block.blockId}:${index}`,
          at: block.timestamp,
          summary: trigger.summary,
          status: trigger.status,
        });
      });
    }
  }
  return delivered;
}

function isTaskCheckinTrigger(title: string): boolean {
  return (
    title === TASK_CHECKIN_TRIGGER_TITLE ||
    title.startsWith(`${TASK_CHECKIN_TRIGGER_TITLE}:`)
  );
}

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
 * The tasks a thread's session set up, by the thread id its entries name
 * (Tracy Bots T82); none from a host that does not say.
 */
export function tasksOfThread(
  tasks: ReadonlyArray<BotTaskEntry>,
  threadId: string,
): ReadonlyArray<BotTaskEntry> {
  return tasks.filter((task) => task.createdByChatId === threadId);
}

/**
 * Where the post a task was set up for is (Tracy Bots T82): a member's
 * message, whose row id its request id names. On the channel when it is a
 * thread's post (`thread`, the thread it opens) or the trunk set the task up;
 * in the creating thread's record (`thread-message`) otherwise. `null` for a
 * task set up for no request, and for a trunk's task while the channel is
 * not known.
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
  const requestId = task.originRequestId;
  if (requestId === null) return null;
  for (const thread of threads) {
    if (thread.anchor?.requestId !== requestId) continue;
    return {
      kind: "channel",
      chatId: thread.conversationId,
      messageId: thread.anchor.messageId,
      thread,
    };
  }
  const messageId = conversationRequestMessageId(requestId);
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

/** A post's first line, as a task row names the request it came from. */
export function firstLineOf(text: string | null): string | null {
  const line = text?.trim().split("\n", 1)[0]?.trim() ?? "";
  return line.length === 0 ? null : line;
}
