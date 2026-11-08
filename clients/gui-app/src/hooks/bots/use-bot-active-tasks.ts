import { useMemo } from "react";
import type { BotTaskEntry } from "@traycer/protocol/host/bot/schemas";
import { useNotificationIndicators } from "@/hooks/notifications/use-notification-indicators-query";
import {
  activeTasksOf,
  type BotActiveTask,
} from "@/lib/bots/bot-activity-model";
import { useEpicsWorkingCounts } from "@/stores/agent-activity-store";
import { useAppLocalNotificationsStore } from "@/stores/notifications/app-local-notifications-store";
import {
  EMPTY_NOTIFICATION_INDICATOR_STATE,
  selectNotificationIndicatorState,
  type NotificationIndicatorState,
} from "@/stores/notifications/notification-indicator-state";

const NO_CHAT_IDS: ReadonlyArray<string> = [];

/** A bot's Activity list, read once for the tab's count and its page alike. */
export type BotActiveTasks = {
  readonly rows: ReadonlyArray<BotActiveTask>;
  /** A listed task's own indicator: what its agents hold unread, together. */
  readonly indicatorOf: (taskId: string) => NotificationIndicatorState;
};

/**
 * The tasks the bot started that are still active (`activeTasksOf`): the
 * agents working in each as the activity plane counts them, and each task's
 * unread done or failure as the notification indicators hold it.
 */
export function useBotActiveTasks(
  tasks: ReadonlyArray<BotTaskEntry>,
): BotActiveTasks {
  const taskIds = useMemo(
    () => tasks.filter((task) => task.spun === true).map((t) => t.taskId),
    [tasks],
  );
  const workingCounts = useEpicsWorkingCounts(taskIds);
  const indicators = useNotificationIndicators({
    hostId: null,
    epicIds: taskIds,
    chatIds: NO_CHAT_IDS,
    enabled: taskIds.length > 0,
  });
  const localRows = useAppLocalNotificationsStore((state) => state.byId);
  return useMemo(() => {
    const working = new Map(
      taskIds.map((taskId, index) => [taskId, workingCounts[index] ?? 0]),
    );
    const indicatorByTask = new Map(
      taskIds.map((epicId) => [
        epicId,
        selectNotificationIndicatorState(
          { byId: localRows },
          { epicId },
          null,
          indicators,
        ),
      ]),
    );
    const indicatorOf = (taskId: string): NotificationIndicatorState =>
      indicatorByTask.get(taskId) ?? EMPTY_NOTIFICATION_INDICATOR_STATE;
    return {
      rows: activeTasksOf({
        tasks,
        workingInTask: (taskId) => working.get(taskId) ?? 0,
        unseenInTask: (taskId) => {
          const state = indicatorOf(taskId);
          return state.unreadDone || state.unreadFailure;
        },
      }),
      indicatorOf,
    };
  }, [indicators, localRows, taskIds, tasks, workingCounts]);
}
