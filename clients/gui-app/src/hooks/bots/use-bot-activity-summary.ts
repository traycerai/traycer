import { useMemo } from "react";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotTaskEntry } from "@traycer/protocol/host/bot/schemas";
import {
  runningRowsOf,
  type BotRunningRow,
} from "@/lib/bots/bot-activity-model";
import {
  useEpicAgentActivity,
  useEpicsWorkingCounts,
} from "@/stores/agent-activity-store";

/** What runs for a bot now, as Call Tracy's status reads it. */
export type BotActivitySummary = {
  readonly running: ReadonlyArray<BotRunningRow>;
};

/**
 * The bot's running work (`bot-activity-model.ts`): the agents working in
 * its tasks and the chats living under the bot, as the activity plane
 * reports them.
 */
export function useBotActivitySummary(input: {
  readonly botId: string;
  readonly trunkChatId: string;
  readonly tasks: ReadonlyArray<BotTaskEntry>;
  /** The bot's threads, as listed; `null` while the list is not read. */
  readonly threads: ReadonlyArray<BotThreadSummary> | null;
}): BotActivitySummary {
  const { botId, trunkChatId, tasks, threads } = input;
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
      running: runningRowsOf({
        tasks,
        workingInTask: (taskId) => workingByTask.get(taskId) ?? 0,
        botChats,
        trunkChatId,
        threadOfSession,
      }),
    };
  }, [botChats, taskIds, tasks, threads, trunkChatId, workingCounts]);
}
