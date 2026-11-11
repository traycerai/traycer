import type { BotTaskEntry } from "@traycer/protocol/host/bot/schemas";

/**
 * Why a task the bot started is on its Activity list, in the list's order: a
 * surface in it waits on a person, an agent in it is working, an agent in it
 * carries a result not yet seen, or it is a periodic check-in still tracking.
 */
export type BotActiveBand =
  | "needs-you"
  | "working"
  | "unseen"
  | "periodic"
  | "unknown";

/** One row of a bot's Activity list (Tracy Bots, decision 182). */
export type BotActiveTask = {
  readonly task: BotTaskEntry;
  readonly band: BotActiveBand;
  /** Agents working in the task, as the activity plane counts them. */
  readonly working: number;
  readonly activityFresh: boolean;
  readonly notificationFresh: boolean;
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
  unknown: 4,
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
  readonly pendingInTask: (taskId: string) => boolean;
  readonly evidenceFresh: boolean;
  readonly activityFresh: boolean;
  readonly notificationFresh: boolean;
}): ReadonlyArray<BotActiveTask> {
  const rows: BotActiveTask[] = [];
  for (const task of input.tasks) {
    if (task.endedReason === "deleted") continue;
    const working = input.workingInTask(task.taskId);
    const band = activeBandOf(
      task,
      working,
      {
        unseen: input.unseenInTask(task.taskId),
        pending: input.pendingInTask(task.taskId),
      },
      input.evidenceFresh,
    );
    if (band === null) continue;
    rows.push({
      task,
      band,
      working,
      at: latestActivityAt(task),
      activityFresh: input.activityFresh,
      notificationFresh: input.notificationFresh,
    });
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
  indicators: { readonly unseen: boolean; readonly pending: boolean },
  evidenceFresh: boolean,
): BotActiveBand | null {
  if ((task.inputNeeded ?? []).length > 0 || indicators.pending)
    return "needs-you";
  if (working > 0) return "working";
  if (indicators.unseen) return "unseen";
  if (!evidenceFresh || task.inputNeeded === null) return "unknown";
  if (isPeriodicTask(task)) return "periodic";
  if (task.state === "tracking" && task.cadence.kind === "on-completion")
    return "unknown";
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
