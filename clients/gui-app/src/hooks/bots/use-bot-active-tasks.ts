import { useMemo, useState } from "react";
import { useAuthStore } from "@/stores/auth/auth-store";
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

type RecentObservation = {
  readonly scope: string;
  readonly source: ReadonlyArray<BotTaskEntry> | null;
  readonly previous: ReadonlyMap<string, string>;
  readonly ended: readonly string[];
};

const NO_CHAT_IDS: ReadonlyArray<string> = [];

/** A bot's Activity list, read once for the tab's count and its page alike. */
export type BotActiveTasks = {
  readonly rows: ReadonlyArray<BotActiveTask>;
  readonly roomFresh: boolean;
  readonly recentRows: ReadonlyArray<BotActiveTask>;
  /** A listed task's own indicator: what its agents hold unread, together. */
  readonly indicatorOf: (taskId: string) => NotificationIndicatorState;
};

/**
 * The bot's listed tasks that are still active (`activeTasksOf`): the
 * agents working in each as the activity plane counts them, and each task's
 * unread done or failure as the notification indicators hold it.
 */
export function useBotActiveTasks(
  tasks: ReadonlyArray<BotTaskEntry>,
  servingHostId: string,
  snapshotFresh: boolean,
  botId: string,
): BotActiveTasks {
  const viewerId = useAuthStore((state) => state.profile?.userId ?? null);
  const scope = JSON.stringify([viewerId, servingHostId, botId]);
  const [observed, setObserved] = useState<RecentObservation>(() => ({
    scope,
    source: null,
    previous: new Map(),
    ended: [],
  }));
  let currentObservation = observed;
  if (
    snapshotFresh &&
    viewerId !== null &&
    (observed.scope !== scope || observed.source !== tasks)
  ) {
    const current =
      observed.scope === scope
        ? observed
        : { scope, previous: new Map<string, string>(), ended: [] };
    const previous = new Map(tasks.map((task) => [task.taskId, task.state]));
    const newEnds = tasks
      .filter(
        (task) =>
          task.state === "ended" &&
          current.previous.get(task.taskId) === "tracking",
      )
      .map((task) => task.taskId);
    const newEndIds = new Set(newEnds);
    const stillEnded = new Set(
      tasks.filter((task) => task.state === "ended").map((task) => task.taskId),
    );
    currentObservation = {
      scope,
      source: tasks,
      previous,
      ended: [
        ...newEnds.reverse(),
        ...current.ended.filter(
          (id) => stillEnded.has(id) && !newEndIds.has(id),
        ),
      ],
    };
    setObserved(currentObservation);
  }
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
    const endedTasks = tasks.filter(
      (task) => task.state === "ended" && task.endedReason !== "deleted",
    );
    const byId = new Map(endedTasks.map((task) => [task.taskId, task]));
    const observedIds =
      currentObservation.scope === scope ? currentObservation.ended : [];
    const ranked = observedIds.flatMap((id) => {
      const task = byId.get(id);
      return task === undefined ? [] : [task];
    });
    const observedSet = new Set(observedIds);
    const recentRows: BotActiveTask[] = [
      ...ranked,
      ...endedTasks.filter((task) => !observedSet.has(task.taskId)).reverse(),
    ].map((task) => ({ task, band: "ended", working: 0, at: null }));
    return {
      roomFresh,
      recentRows,
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
    currentObservation,
    scope,
  ]);
}
