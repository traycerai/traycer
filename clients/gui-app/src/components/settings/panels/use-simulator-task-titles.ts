import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCloudEpicTasksQuery } from "@/hooks/epics/use-cloud-epic-tasks-query";
import {
  readEpicTitlesFromCloudTaskCaches,
  subscribeToCloudTaskListCaches,
} from "@/lib/cloud-epic-tasks-query/cache";
import {
  decodeStringMapSnapshot,
  encodeStringMapSnapshot,
} from "@/lib/string-map-snapshot";

const EMPTY_TITLES: ReadonlyMap<string, string> = new Map();

/**
 * Titles for the tasks Running now links to, from the task lists the app
 * already holds for the signed-in person (warmed with the same first page
 * History reads). A task none of those lists has stays untitled, and its link
 * shows the short id.
 */
export function useSimulatorTaskTitles(
  epicIds: readonly string[],
): ReadonlyMap<string, string> {
  const queryClient = useQueryClient();
  const cloud = useCloudEpicTasksQuery(undefined, {
    enabled: epicIds.length > 0,
  });
  const userId = cloud.currentUserId;
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      userId === null
        ? () => undefined
        : subscribeToCloudTaskListCaches(
            queryClient,
            { hostId: null, userId },
            onStoreChange,
          ),
    [queryClient, userId],
  );
  const snapshot = useSyncExternalStore(subscribe, () =>
    userId === null || epicIds.length === 0
      ? ""
      : encodeStringMapSnapshot(
          Object.entries(
            readEpicTitlesFromCloudTaskCaches(
              queryClient,
              { hostId: null, userId },
              epicIds,
            ),
          ),
        ),
  );
  return useMemo(
    () =>
      snapshot.length === 0 ? EMPTY_TITLES : decodeStringMapSnapshot(snapshot),
    [snapshot],
  );
}
