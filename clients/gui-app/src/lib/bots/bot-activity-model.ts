import type {
  BotActivityTarget,
  BotTaskEntry,
} from "@traycer/protocol/host/bot/schemas";
import type { EpicAgentActivity } from "@/lib/agent-activity";

/** The window the host keeps check-ins for, Call Tracy's "this week". */
const ACTIVITY_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Why a task the bot started is on its Activity list, in the list's order: a
 * surface in it waits on a person, an agent in it is working, an agent in it
 * carries a result not yet seen, or it is a periodic check-in still tracking.
 */
export type BotActiveBand = "needs-you" | "working" | "unseen" | "periodic";

/** One row of a bot's Activity list (Tracy Bots, decision 182). */
export type BotActiveTask = {
  readonly task: BotTaskEntry;
  readonly band: BotActiveBand;
  /** Agents working in the task, as the activity plane counts them. */
  readonly working: number;
  /**
   * The newest activity the list knows of: a surface reported waiting, or
   * the latest check-in; `null` for neither.
   */
  readonly at: number | null;
};

const BAND_RANK: Readonly<Record<BotActiveBand, number>> = {
  "needs-you": 0,
  working: 1,
  unseen: 2,
  periodic: 3,
};

/**
 * The tasks the bot started that are still active, in the list's order: a
 * task is listed while anything in it works, waits on a person or has a
 * result not yet seen, or while it checks in periodically. Quiet and seen,
 * it leaves; History keeps it. Within a band the newest activity is first.
 */
export function activeTasksOf(input: {
  readonly tasks: ReadonlyArray<BotTaskEntry>;
  readonly workingInTask: (taskId: string) => number;
  /** Whether an agent in the task carries an unread done or failure. */
  readonly unseenInTask: (taskId: string) => boolean;
}): ReadonlyArray<BotActiveTask> {
  const rows: BotActiveTask[] = [];
  for (const task of input.tasks) {
    if (task.spun !== true) continue;
    const working = input.workingInTask(task.taskId);
    const band = activeBandOf(task, working, input.unseenInTask(task.taskId));
    if (band === null) continue;
    rows.push({ task, band, working, at: latestActivityAt(task) });
  }
  return rows.sort(
    (a, b) =>
      BAND_RANK[a.band] - BAND_RANK[b.band] ||
      (b.at ?? -1) - (a.at ?? -1) ||
      a.task.taskId.localeCompare(b.task.taskId),
  );
}

function activeBandOf(
  task: BotTaskEntry,
  working: number,
  unseen: boolean,
): BotActiveBand | null {
  if ((task.inputNeeded ?? []).length > 0) return "needs-you";
  if (working > 0) return "working";
  if (unseen) return "unseen";
  if (isPeriodicTask(task)) return "periodic";
  return null;
}

/** A task that checks in on a schedule and still does. */
export function isPeriodicTask(task: BotTaskEntry): boolean {
  return task.state === "tracking" && task.cadence.kind === "every";
}

function latestActivityAt(task: BotTaskEntry): number | null {
  let at = task.lastCheckinAt;
  for (const waiting of task.inputNeeded ?? []) {
    if (at === null || waiting.reportedAt > at) at = waiting.reportedAt;
  }
  return at;
}

/**
 * What runs for the bot now, one row each: a task with agents working in it,
 * one of the bot's sessions with background work going (a shell, a watch, a
 * subagent) once its turn is over, and an agent the bot started that is
 * working.
 */
export type BotRunningRow =
  | {
      readonly kind: "task";
      readonly taskId: string;
      readonly agents: number;
    }
  | {
      readonly kind: "session";
      readonly chatId: string;
      readonly target: BotActivityTarget;
    }
  | { readonly kind: "agent"; readonly chatId: string };

export function runningRowsOf(input: {
  /** The bot's tasks, as its task list holds them. */
  readonly tasks: ReadonlyArray<BotTaskEntry>;
  /** Agents working in each task, by task id. */
  readonly workingInTask: (taskId: string) => number;
  /** The chats living under the bot, as the activity plane reports them. */
  readonly botChats: EpicAgentActivity;
  readonly trunkChatId: string;
  /**
   * The thread each of the bot's thread sessions belongs to, by session chat
   * id; `null` while the thread list is not read, when no chat but the trunk
   * can be told apart and the others wait.
   */
  readonly threadOfSession: ReadonlyMap<string, string> | null;
}): ReadonlyArray<BotRunningRow> {
  const { tasks, workingInTask, botChats, trunkChatId, threadOfSession } =
    input;
  const rows: BotRunningRow[] = [];
  for (const task of tasks) {
    const agents = workingInTask(task.taskId);
    if (agents > 0) rows.push({ kind: "task", taskId: task.taskId, agents });
  }
  for (const chatId of [...botChats.working].sort()) {
    if (chatId !== trunkChatId && threadOfSession === null) continue;
    const threadId = threadOfSession?.get(chatId);
    if (chatId !== trunkChatId && threadId === undefined) {
      rows.push({ kind: "agent", chatId });
      continue;
    }
    // A session answering is the channel's typing line; what is left
    // running once its turn ends is the background work.
    if (botChats.turn.has(chatId)) continue;
    rows.push({
      kind: "session",
      chatId,
      target:
        threadId === undefined
          ? { kind: "trunk" }
          : { kind: "thread", threadId },
    });
  }
  return rows;
}

/** The tasks and automations the bot still runs. */
export function trackingTasksOf(
  tasks: ReadonlyArray<BotTaskEntry>,
): ReadonlyArray<BotTaskEntry> {
  return tasks.filter((task) => task.state === "tracking");
}

/**
 * A task the bot no longer runs, with when it ended as far as the stream
 * says: when a member stopped it, else its latest check-in; `null` for one
 * with neither.
 */
export type BotFinishedTask = {
  readonly task: BotTaskEntry;
  readonly endedAt: number | null;
};

export function finishedTasksOf(
  tasks: ReadonlyArray<BotTaskEntry>,
): ReadonlyArray<BotFinishedTask> {
  return tasks
    .filter((task) => task.state === "ended")
    .map((task) => ({ task, endedAt: task.stop?.at ?? latestCheckinAt(task) }))
    .sort((a, b) => (b.endedAt ?? -1) - (a.endedAt ?? -1));
}

/** The finished tasks of the week before `now`. */
export function finishedThisWeek(
  finished: ReadonlyArray<BotFinishedTask>,
  now: number,
): ReadonlyArray<BotFinishedTask> {
  return finished.filter(
    (entry) => entry.endedAt !== null && entry.endedAt > now - ACTIVITY_WEEK_MS,
  );
}

function latestCheckinAt(task: BotTaskEntry): number | null {
  const newest = task.checkins?.[0];
  if (newest !== undefined) {
    return newest.kind === "received"
      ? newest.receivedAt
      : (newest.caughtUpAt ?? newest.missedThrough);
  }
  return task.lastCheckin?.deliveredAt ?? task.lastCheckinAt;
}
