import type { OpenMessage } from "@traycer/protocol/persistence/epic/open-harness-records";
import type {
  ChatQueuedTaskCheckinItem,
  ChatQueuedTaskOverdueItem,
  OpenChatQueuedItem,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { BotTaskEntry } from "@traycer/protocol/host/bot/schemas";

/**
 * What the "Under the hood" panel reads off a bot's TRUNK chat (Tracy Bots).
 *
 * A delivered check-in is not stored as a section: the trunk keeps only an
 * `autonomous_resume` block whose trigger is titled {@link
 * TASK_CHECKIN_TRIGGER_TITLE} and carries a one-line summary, and a check-in
 * the trunk has not consumed yet is a `task-checkin` item on its queue. These
 * folds read delivered and queued check-ins from the trunk transcript.
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

/** The check-in cadence as a short phrase: "every 30 min", "when it finishes". */
export function describeCadence(cadence: BotTaskEntry["cadence"]): string {
  switch (cadence.kind) {
    case "every":
      return `every ${describeSeconds(cadence.seconds)}`;
    case "on-completion":
      return "when it finishes";
    case "none":
      return "no check-ins";
  }
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

export function sortTasksForDisplay(
  tasks: ReadonlyArray<BotTaskEntry>,
): ReadonlyArray<BotTaskEntry> {
  return [...tasks].sort((a, b) => {
    if (a.state !== b.state) return a.state === "tracking" ? -1 : 1;
    const aNext = a.nextAt ?? Number.POSITIVE_INFINITY;
    const bNext = b.nextAt ?? Number.POSITIVE_INFINITY;
    if (aNext !== bNext) return aNext - bNext;
    return a.taskId.localeCompare(b.taskId);
  });
}
