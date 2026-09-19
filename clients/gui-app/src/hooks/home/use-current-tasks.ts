import { useEffect, useMemo, useState } from "react";
import {
  queryOptions,
  replaceEqualDeep,
  skipToken,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
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
import { useLocalHomedOpenTaskRows } from "@/hooks/epic/use-epic-task-pinned-states-query";
import { useHasPendingSetPinnedForScope } from "@/hooks/epic/use-epic-set-pinned-mutation";
import { useCloudEpicTasksQuery } from "@/hooks/epics/use-cloud-epic-tasks-query";
import { useOpenTabEpicIds } from "@/hooks/home/use-open-tab-epic-ids";
import {
  fetchCloudEpicTasksCursorPageByHostId,
  LIST_CLOUD_TASKS_REQUEST,
} from "@/lib/cloud-epic-tasks-query";
import { admitCloudEpicTasksFirstPage } from "@/lib/cloud-epic-tasks-query/cache";
import {
  currentTaskPinScan,
  currentTaskPinsStatus,
  groupCurrentTasks,
  pinScanDecision,
  type CurrentTaskPinScan,
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

interface PinTailResult extends ListTasksResponse {
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
    () => deduplicateItems([...hydration.items, ...pins.fetchedItems]),
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
  const computedScan = currentTaskPinScan({
    firstPage,
    firstPagePlaceholder: cloudTasks.query.isPlaceholderData,
    cloudPagePending: cloudTasks.isCloudPagePending,
    hostId: cloudTasks.hostId,
    userId: cloudTasks.currentUserId,
  });
  const pinMutationPending = useHasPendingSetPinnedForScope(
    cloudTasks.hostId,
    cloudTasks.currentUserId,
  );
  const scan = useCurrentTaskPinBoundary(
    computedScan,
    cloudTasks.hostId,
    cloudTasks.currentUserId,
    firstPage !== undefined &&
      !cloudTasks.query.isPlaceholderData &&
      !cloudTasks.isCloudPagePending &&
      !cloudTasks.query.isRefetchError &&
      !pinMutationPending,
  );
  const cloudAuthorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const tailEnabled = scan.tailEnabled && cloudAuthorized;
  const tailQuery = useQuery(
    currentTaskPinTailQueryOptions(scan.tailScope, tailEnabled),
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
    firstPagePending:
      cloudTasks.query.isPending || cloudTasks.query.isPlaceholderData,
    firstPageUnavailable: scan.firstPageUnavailable,
    firstPageLocalRowsIncomplete: scan.firstPageLocalRowsIncomplete,
    firstPageDecision: scan.firstPageDecision,
    tailEnabled,
    tailPending: tailQuery.isPending,
    tailPinsComplete: tailQuery.data?.pinsComplete === true,
  });
  return {
    fetchedItems,
    userId: cloudTasks.currentUserId,
    ...status,
  };
}

function useCurrentTaskPinBoundary(
  observedScan: CurrentTaskPinScan,
  hostId: string | null,
  userId: string | null,
  authoritative: boolean,
): CurrentTaskPinScan {
  const queryClient = useQueryClient();
  const scope = {
    hostId: hostId ?? "",
    userId: userId ?? "",
  };
  const fallbackScan = currentTaskPinScan({
    firstPage: undefined,
    firstPagePlaceholder: false,
    cloudPagePending: true,
    hostId,
    userId,
  });
  const boundary = useQuery(currentTaskPinBoundaryQueryOptions(scope)).data;
  useEffect(() => {
    if (!authoritative || hostId === null || userId === null) return;
    if (boundary !== undefined && samePinScan(boundary, observedScan)) return;
    queryClient.setQueryData(
      cloudQueryKeys.currentTasksPinBoundary(hostId, userId),
      observedScan,
    );
  }, [authoritative, boundary, hostId, observedScan, queryClient, userId]);
  if (authoritative) return observedScan;
  return boundary ?? fallbackScan;
}

function currentTaskPinBoundaryQueryOptions(scope: {
  readonly hostId: string;
  readonly userId: string;
}) {
  return queryOptions<CurrentTaskPinScan>({
    queryKey: cloudQueryKeys.currentTasksPinBoundary(
      scope.hostId,
      scope.userId,
    ),
    queryFn: skipToken,
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

function samePinScan(
  left: CurrentTaskPinScan,
  right: CurrentTaskPinScan,
): boolean {
  return (
    left.firstPageDecision?.shouldContinue ===
      right.firstPageDecision?.shouldContinue &&
    left.firstPageDecision?.pinsComplete ===
      right.firstPageDecision?.pinsComplete &&
    left.firstPageUnavailable === right.firstPageUnavailable &&
    left.firstPageLocalRowsIncomplete === right.firstPageLocalRowsIncomplete &&
    left.tailEnabled === right.tailEnabled &&
    left.tailScope.hostId === right.tailScope.hostId &&
    left.tailScope.userId === right.tailScope.userId &&
    left.tailScope.firstPageCursor === right.tailScope.firstPageCursor
  );
}

function useCurrentTaskHydration(input: CurrentTaskHydrationInput): {
  readonly items: readonly HistoryItem[];
  readonly isFetching: boolean;
} {
  const localRows = useLocalHomedOpenTaskRows(input.openEpicIds, input.userId);
  const cloudAuthorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const hydrationIds = useMemo(() => {
    const fetchedEpicIds = new Set(
      input.fetchedItems.map((item) => item.epicId),
    );
    return [...new Set([...input.workingEpicIds, ...input.openEpicIds])]
      .filter(
        (epicId) =>
          !fetchedEpicIds.has(epicId) && !localRows.hostIds.has(epicId),
      )
      .sort();
  }, [
    input.fetchedItems,
    input.openEpicIds,
    input.workingEpicIds,
    localRows.hostIds,
  ]);
  const taskContexts = useEpicGetTaskContexts(hydrationIds, input.userId, {
    enabled: cloudAuthorized,
  });
  const items = useMemo(
    () => [
      ...buildHistoryItemsFromTasks(
        localRows.tasks.flatMap(({ task, hostId }) =>
          task.home === "local" &&
          localRows.hostIds.get(task.epic?.light?.id ?? "") === hostId
            ? [task]
            : [],
        ),
        input.nowMs,
        input.userId,
        EMPTY_LOCAL_HOMED_TASK_IDS,
      ).map((item) => ({
        ...item,
        hostId: localRows.hostIds.get(item.epicId),
      })),
      ...buildHistoryItemsFromTasks(
        [...taskContexts.tasksById.values()],
        input.nowMs,
        input.userId,
        taskContexts.localHomedTaskIds,
      ),
    ],
    [
      input.nowMs,
      input.userId,
      taskContexts.localHomedTaskIds,
      taskContexts.tasksById,
      localRows.tasks,
      localRows.hostIds,
    ],
  );
  return { items, isFetching: taskContexts.isFetching || localRows.isFetching };
}

function currentTaskPinTailQueryOptions(scope: PinTailScope, enabled: boolean) {
  return queryOptions<PinTailResult>({
    queryKey: cloudQueryKeys.currentTasksPinTail(
      scope.hostId,
      scope.userId,
      scope.firstPageCursor,
    ),
    queryFn: ({ signal }) =>
      fetchPinTail(scope.hostId, scope.userId, scope.firstPageCursor, signal),
    enabled,
    staleTime: Infinity,
    gcTime: Infinity,
    structuralSharing: (previous, incoming) =>
      replaceEqualDeep(previous, admitPinTailResult(incoming, scope)),
  });
}

function admitPinTailResult(result: unknown, scope: PinTailScope): unknown {
  if (!isPinTailResult(result)) return result;
  const admitted = admitCloudEpicTasksFirstPage(result, {
    hostId: scope.hostId,
    userId: scope.userId,
  });
  return admitted === result ? result : { ...result, tasks: admitted.tasks };
}

function isPinTailResult(value: unknown): value is PinTailResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "tasks" in value &&
    Array.isArray(value.tasks) &&
    "hasMore" in value &&
    typeof value.hasMore === "boolean" &&
    "pinsComplete" in value &&
    typeof value.pinsComplete === "boolean"
  );
}

async function fetchPinTail(
  hostId: string,
  userId: string,
  firstPageCursor: string,
  abortSignal: AbortSignal,
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
        abortSignal,
      },
    );
    abortSignal.throwIfAborted();
    tasks.push(...page.tasks);
    const decision = pinScanDecision(page, "cursor", cursorPagesFetched);
    if (!decision.shouldContinue) {
      return { tasks, hasMore: false, pinsComplete: decision.pinsComplete };
    }
    cursor = page.nextCursor ?? cursor;
  }
  return { tasks, hasMore: false, pinsComplete: false };
}

function deduplicateItems(items: readonly HistoryItem[]): HistoryItem[] {
  const byId = new Map<string, HistoryItem>();
  for (const item of items) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  return [...byId.values()];
}
