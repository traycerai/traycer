import { useMemo } from "react";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type {
  BotActivity,
  BotTaskEntry,
} from "@traycer/protocol/host/bot/schemas";
import {
  runningRowsOf,
  stoppedSessionsOf,
  trackingTasksOf,
  type BotRunningRow,
  type BotStoppedSession,
} from "@/lib/bots/bot-activity-model";
import {
  useEpicAgentActivity,
  useEpicsWorkingCounts,
} from "@/stores/agent-activity-store";

/** What a bot's Activity tab counts in its label and lists under Running now. */
export type BotActivitySummary = {
  readonly stopped: ReadonlyArray<BotStoppedSession>;
  readonly running: ReadonlyArray<BotRunningRow>;
  /** The tasks and automations the bot still runs. */
  readonly tasks: number;
};

/**
 * The bot's stopped, running and tracked work (`bot-activity-model.ts`):
 * its sessions' activity as the bot's stream carries it, the agents working
 * in its tasks and the chats living under the bot as the activity plane
 * reports them. Read by the tab's label and its Activity page alike, so the
 * two never disagree.
 */
export function useBotActivitySummary(input: {
  readonly botId: string;
  readonly trunkChatId: string;
  readonly tasks: ReadonlyArray<BotTaskEntry>;
  readonly activity: BotActivity | null;
  /** The bot's threads, as listed; `null` while the list is not read. */
  readonly threads: ReadonlyArray<BotThreadSummary> | null;
}): BotActivitySummary {
  const { botId, trunkChatId, tasks, activity, threads } = input;
  const taskIds = useMemo(() => tasks.map((task) => task.taskId), [tasks]);
  const workingCounts = useEpicsWorkingCounts(taskIds);
  const botChats = useEpicAgentActivity(botId);
  return useMemo(() => {
    const workingByTask = new Map(
      taskIds.map((taskId, index) => [taskId, workingCounts[index] ?? 0]),
    );
    const threadOfSession =
      threads === null
        ? null
        : new Map(
            threads.map((thread) => [thread.sessionChatId, thread.threadId]),
          );
    return {
      stopped: stoppedSessionsOf(activity),
      running: runningRowsOf({
        tasks,
        workingInTask: (taskId) => workingByTask.get(taskId) ?? 0,
        botChats,
        trunkChatId,
        threadOfSession,
      }),
      tasks: trackingTasksOf(tasks).length,
    };
  }, [activity, botChats, taskIds, tasks, threads, trunkChatId, workingCounts]);
}
