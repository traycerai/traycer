import { useMemo } from "react";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import type { BotTaskEntry } from "@traycer/protocol/host/bot/schemas";
import { useNotificationIndicatorsWithFreshness } from "@/hooks/notifications/use-notification-indicators-query";
import {
  activeTasksOf,
  type BotActiveTask,
} from "@/lib/bots/bot-activity-model";
import {
  useActivityFleetCoverage,
  useAttestedEpicsWorkingCounts,
} from "@/stores/agent-activity-store";
import { useAppLocalNotificationsStore } from "@/stores/notifications/app-local-notifications-store";
import {
  EMPTY_INDICATOR_STATE_RESPONSE,
  EMPTY_NOTIFICATION_INDICATOR_STATE,
  mergeIndicatorStateResponses,
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
  servingHostId: string,
  snapshotFresh: boolean,
): BotActiveTasks {
  const taskIds = useMemo(
    () =>
      tasks
        .filter((task) => task.endedReason !== "deleted")
        .map((t) => t.taskId),
    [tasks],
  );
  const workingCounts = useAttestedEpicsWorkingCounts(taskIds);
  const fleetCoverage = useActivityFleetCoverage();
  const {
    cloudPositiveIndicators,
    hostPositiveIndicators,
    fresh,
    positiveFresh,
    hostId,
  } = useNotificationIndicatorsWithFreshness({
    hostId: null,
    epicIds: taskIds,
    chatIds: NO_CHAT_IDS,
    enabled: taskIds.length > 0,
  });
  const reachability = useHostReachability(hostId ?? UNKNOWN_HOST_PLACEHOLDER);
  const servingReachability = useHostReachability(servingHostId);
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
          mergeIndicatorStateResponses(
            cloudPositiveIndicators,
            positiveFresh && reachability.status === "reachable"
              ? hostPositiveIndicators
              : EMPTY_INDICATOR_STATE_RESPONSE,
          ),
        ),
      ]),
    );
    const notificationFresh = fresh && reachability.status === "reachable";
    const activityFresh = fleetCoverage === "fleet";
    const roomFresh =
      snapshotFresh && servingReachability.status === "reachable";
    const indicatorOf = (taskId: string): NotificationIndicatorState =>
      indicatorByTask.get(taskId) ?? EMPTY_NOTIFICATION_INDICATOR_STATE;
    return {
      rows: activeTasksOf({
        tasks: roomFresh
          ? tasks
          : tasks.map((task) => ({ ...task, inputNeeded: null })),
        evidenceFresh: activityFresh && notificationFresh && roomFresh,
        workingInTask: (taskId) => working.get(taskId) ?? 0,
        pendingInTask: (taskId) => {
          const state = indicatorOf(taskId);
          return (
            state.pendingApproval || state.pendingInterview || state.pendingFork
          );
        },
        unseenInTask: (taskId) => {
          const state = indicatorOf(taskId);
          return state.unreadDone || state.unreadFailure;
        },
      }),
      indicatorOf,
    };
  }, [
    cloudPositiveIndicators,
    hostPositiveIndicators,
    localRows,
    taskIds,
    tasks,
    workingCounts,
    fleetCoverage,
    fresh,
    positiveFresh,
    reachability.status,
    servingReachability.status,
    snapshotFresh,
  ]);
}
