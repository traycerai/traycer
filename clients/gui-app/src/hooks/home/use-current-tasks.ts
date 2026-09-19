import { useMemo, useState } from "react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import type {
  ListTaskLight,
  ListTasksResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { HistoryItem } from "@/components/home/data/home-page.data";
import {
  buildHistoryItemsFromTasks,
  EMPTY_LOCAL_HOMED_TASK_IDS,
} from "@/components/home/data/home-page.data";
import { useEpicGetTaskContexts } from "@/hooks/epic/use-epic-get-task-contexts-query";
import { useCloudEpicTasksQuery } from "@/hooks/epics/use-cloud-epic-tasks-query";
import { useOpenTabEpicIds } from "@/hooks/home/use-open-tab-epic-ids";
import {
  fetchCloudEpicTasksCursorPageByHostId,
  LIST_CLOUD_TASKS_REQUEST,
} from "@/lib/cloud-epic-tasks-query";
import {
  currentTaskPinScan,
  currentTaskPinsStatus,
  groupCurrentTasks,
  pinScanDecision,
  type CurrentTaskGroups,
  PIN_TAIL_PAGE_CAP,
} from "@/lib/home/current-tasks";
import { cloudQueryKeys } from "@/lib/query-keys";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import {
  useActivityFleetCoverage,
  type ActivityFleetCoverage,
} from "@/stores/agent-activity-store";
import { useWorkingEpicIds } from "@/stores/use-working-epic-ids";

interface PinTailResult {
  readonly tasks: readonly ListTaskLight[];
  readonly pinsComplete: boolean;
}

interface CurrentTaskPins {
  readonly fetchedItems: readonly HistoryItem[];
  readonly userId: string | null;
  readonly pinsComplete: boolean;
  readonly isPending: boolean;
}

interface PinTailScope {
  readonly hostId: string;
  readonly userId: string;
  readonly firstPageCursor: string;
}

interface CurrentTaskHydrationInput {
  readonly fetchedItems: readonly HistoryItem[];
  readonly workingEpicIds: ReadonlySet<string>;
  readonly openEpicIds: readonly string[];
  readonly userId: string | null;
  readonly nowMs: number;
}

export interface CurrentTasks {
  readonly groups: CurrentTaskGroups;
  readonly pinsComplete: boolean;
  readonly activityCoverage: ActivityFleetCoverage;
  readonly isPending: boolean;
}

export function useCurrentTasks(): CurrentTasks {
  const [nowMs] = useState(() => Date.now());
  const pins = useCurrentTaskPins(nowMs);
  const workingEpicIds = useWorkingEpicIds();
  const openEpicIds = useOpenTabEpicIds();
  const hydration = useCurrentTaskHydration({
    fetchedItems: pins.fetchedItems,
    workingEpicIds,
    openEpicIds,
    userId: pins.userId,
    nowMs,
  });
  const items = useMemo(
    () => deduplicateItems([...pins.fetchedItems, ...hydration.items]),
    [hydration.items, pins.fetchedItems],
  );
  const groups = useMemo(
    () => groupCurrentTasks(items, workingEpicIds, openEpicIds),
    [items, openEpicIds, workingEpicIds],
  );
  const activityCoverage = useActivityFleetCoverage();
  return {
    groups,
    pinsComplete: pins.pinsComplete,
    activityCoverage,
    isPending: pins.isPending || hydration.isFetching,
  };
}

function useCurrentTaskPins(nowMs: number): CurrentTaskPins {
  const cloudTasks = useCloudEpicTasksQuery(LIST_CLOUD_TASKS_REQUEST, {
    enabled: true,
  });
  const firstPage = cloudTasks.query.data;
  const scan = currentTaskPinScan({
    firstPage,
    cloudPagePending: cloudTasks.isCloudPagePending,
    hostId: cloudTasks.hostId,
    userId: cloudTasks.currentUserId,
  });
  const tailQuery = useQuery(
    currentTaskPinTailQueryOptions(scan.tailScope, scan.tailEnabled),
  );
  const firstItems = useMemo(
    () =>
      buildHistoryItemsFromTasks(
        firstPage?.tasks ?? [],
        nowMs,
        cloudTasks.currentUserId,
        EMPTY_LOCAL_HOMED_TASK_IDS,
      ),
    [cloudTasks.currentUserId, firstPage?.tasks, nowMs],
  );
  const tailItems = useMemo(
    () =>
      buildHistoryItemsFromTasks(
        tailQuery.data?.tasks ?? [],
        nowMs,
        cloudTasks.currentUserId,
        EMPTY_LOCAL_HOMED_TASK_IDS,
      ),
    [cloudTasks.currentUserId, nowMs, tailQuery.data?.tasks],
  );
  const fetchedItems = useMemo(
    () => deduplicateItems([...firstItems, ...tailItems]),
    [firstItems, tailItems],
  );
  const status = currentTaskPinsStatus({
    initialLegRefused: cloudTasks.initialLegRefused,
    cloudPagePending: cloudTasks.isCloudPagePending,
    firstPagePending: cloudTasks.query.isPending,
    firstPageUnavailable: scan.firstPageUnavailable,
    firstPageDecision: scan.firstPageDecision,
    tailEnabled: scan.tailEnabled,
    tailPending: tailQuery.isPending,
    tailPinsComplete: tailQuery.data?.pinsComplete === true,
  });
  return {
    fetchedItems,
    userId: cloudTasks.currentUserId,
    ...status,
  };
}

function useCurrentTaskHydration(input: CurrentTaskHydrationInput): {
  readonly items: readonly HistoryItem[];
  readonly isFetching: boolean;
} {
  const cloudAuthorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const hydrationIds = useMemo(() => {
    const fetchedEpicIds = new Set(
      input.fetchedItems.map((item) => item.epicId),
    );
    return [...new Set([...input.workingEpicIds, ...input.openEpicIds])]
      .filter((epicId) => !fetchedEpicIds.has(epicId))
      .sort();
  }, [input.fetchedItems, input.openEpicIds, input.workingEpicIds]);
  const taskContexts = useEpicGetTaskContexts(hydrationIds, input.userId, {
    enabled: cloudAuthorized,
  });
  const items = useMemo(
    () =>
      buildHistoryItemsFromTasks(
        [...taskContexts.tasksById.values()],
        input.nowMs,
        input.userId,
        taskContexts.localHomedTaskIds,
      ),
    [
      input.nowMs,
      input.userId,
      taskContexts.localHomedTaskIds,
      taskContexts.tasksById,
    ],
  );
  return { items, isFetching: taskContexts.isFetching };
}

function currentTaskPinTailQueryOptions(scope: PinTailScope, enabled: boolean) {
  return queryOptions<PinTailResult>({
    queryKey: cloudQueryKeys.currentTasksPinTail(
      scope.hostId,
      scope.userId,
      scope.firstPageCursor,
    ),
    queryFn: () =>
      fetchPinTail(scope.hostId, scope.userId, scope.firstPageCursor),
    enabled,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

async function fetchPinTail(
  hostId: string,
  userId: string,
  firstPageCursor: string,
): Promise<PinTailResult> {
  const tasks: ListTaskLight[] = [];
  let cursor = firstPageCursor;
  for (
    let cursorPagesFetched = 1;
    cursorPagesFetched <= PIN_TAIL_PAGE_CAP;
    cursorPagesFetched += 1
  ) {
    const page: ListTasksResponse = await fetchCloudEpicTasksCursorPageByHostId(
      hostId,
      userId,
      {
        request: LIST_CLOUD_TASKS_REQUEST,
        cursor,
      },
    );
    tasks.push(...page.tasks);
    const decision = pinScanDecision(page, "cursor", cursorPagesFetched);
    if (!decision.shouldContinue) {
      return { tasks, pinsComplete: decision.pinsComplete };
    }
    cursor = page.nextCursor ?? cursor;
  }
  return { tasks, pinsComplete: false };
}

function deduplicateItems(items: readonly HistoryItem[]): HistoryItem[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}
