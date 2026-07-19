import { useMemo } from "react";
import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { WorktreeHostEntryV14 } from "@traycer/protocol/host/index";
import {
  GET_TASK_CONTEXTS_MAX_IDS,
  type GetTaskContextsResponse,
  type ListTaskLight,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { type HostRpcRegistry } from "@/lib/host";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import { useCloudEpicTasksQuery } from "@/hooks/epics/use-cloud-epic-tasks-query";
import { readEpicTitlesFromCloudTaskCaches } from "@/lib/cloud-epic-tasks-query/cache";

const EMPTY_TASK_TITLES: ReadonlyMap<string, string> = new Map();
const EMPTY_TITLE_RECORD: Record<string, string> = {};

/**
 * Resolves each owner `epicId` on the listing to its Task title in two tiers:
 *
 * 1. **Tier 1 (free):** scan cloud epic-tasks caches the app already maintains
 *    for the signed-in user (`readEpicTitlesFromCloudTaskCaches`). Scope is
 *    `hostId: null` so an epic cached under any host still resolves. We warm
 *    those caches with the shared first-page query History/home use.
 * 2. **Tier 2:** one (or cap-sized) `epic.getTaskContexts` batch for the
 *    still-unresolved ids, keyed by `(hostId, userId, sorted id set)` via the
 *    host-query wrapper. `null` (deleted / not permitted) stays absent → the
 *    chip renderer keeps the muted "Owner unresolved" demotion. Older hosts
 *    that lack the method fail with `E_HOST_UNSUPPORTED` and we fall back to
 *    tier 1 only (today's behavior). Generic/network errors leave rows
 *    unresolved without a new failure surface.
 */
export function useWorktreeTaskTitles(
  client: HostClient<HostRpcRegistry> | null,
  worktrees: readonly WorktreeHostEntryV14[],
): ReadonlyMap<string, string> {
  const queryClient = useQueryClient();
  const epicIds = useMemo(
    () =>
      [
        ...new Set(
          worktrees.flatMap((entry) =>
            entry.owners.map((owner) => owner.epicId),
          ),
        ),
      ].sort((left, right) => left.localeCompare(right)),
    [worktrees],
  );
  // Only warm the shared cloud-tasks cache when something actually needs a title.
  const cloud = useCloudEpicTasksQuery(undefined, {
    enabled: epicIds.length > 0,
  });
  const userId = cloud.currentUserId;
  const cloudTasks = cloud.tasks;

  const tier1Titles = useMemo(() => {
    if (userId === null || epicIds.length === 0) return EMPTY_TITLE_RECORD;
    // `cloudTasks` is a recompute trigger: the read scans the query cache
    // directly, so we re-derive whenever a fetched page changes it.
    void cloudTasks;
    return readEpicTitlesFromCloudTaskCaches(
      queryClient,
      { hostId: null, userId },
      epicIds,
    );
  }, [queryClient, userId, epicIds, cloudTasks]);

  const unresolvedIds = useMemo(
    () => epicIds.filter((id) => !Object.hasOwn(tier1Titles, id)),
    [epicIds, tier1Titles],
  );

  const batchRequests = useMemo(
    () =>
      chunkTaskIds(unresolvedIds, GET_TASK_CONTEXTS_MAX_IDS).map((taskIds) => ({
        method: "epic.getTaskContexts" as const,
        params: { taskIds: [...taskIds] },
      })),
    [unresolvedIds],
  );

  const tier2Titles = useHostQueries<
    HostRpcRegistry,
    "epic.getTaskContexts",
    ReadonlyMap<string, string>
  >({
    client,
    requests: batchRequests,
    cacheKeyIdentity: userId === null ? undefined : userId,
    options: {
      enabled: userId !== null && unresolvedIds.length > 0,
    },
    combine: combineTaskContextTitleResults,
  });

  return useMemo(() => {
    if (userId === null || epicIds.length === 0) return EMPTY_TASK_TITLES;
    if (tier2Titles.size === 0) {
      return new Map(Object.entries(tier1Titles));
    }
    const merged = new Map(Object.entries(tier1Titles));
    for (const [id, title] of tier2Titles) {
      if (!merged.has(id)) merged.set(id, title);
    }
    return merged;
  }, [userId, epicIds, tier1Titles, tier2Titles]);
}

function combineTaskContextTitleResults(
  results: Array<UseQueryResult<GetTaskContextsResponse, HostRpcError>>,
): ReadonlyMap<string, string> {
  // Older host: method unsupported → stay on tier 1 only (no throw).
  if (results.some((result) => result.error?.code === "E_HOST_UNSUPPORTED")) {
    return EMPTY_TASK_TITLES;
  }
  const titles = new Map<string, string>();
  for (const result of results) {
    if (result.data === undefined) continue;
    for (const title of titlesFromTaskContextsResponse(result.data)) {
      if (!titles.has(title.id)) titles.set(title.id, title.title);
    }
  }
  return titles;
}

function titlesFromTaskContextsResponse(
  response: GetTaskContextsResponse,
): ReadonlyArray<{ readonly id: string; readonly title: string }> {
  return Object.values(response.tasks).flatMap((task) => {
    const extracted = titleFromListTaskLight(task);
    return extracted === null ? [] : [extracted];
  });
}

function titleFromListTaskLight(
  task: ListTaskLight | null,
): { readonly id: string; readonly title: string } | null {
  if (task === null) return null;
  const light = task.epic?.light;
  if (light === null || light === undefined) return null;
  const title = light.title.trim();
  if (title.length === 0) return null;
  return { id: light.id, title };
}

function chunkTaskIds(
  ids: readonly string[],
  maxPerChunk: number,
): ReadonlyArray<ReadonlyArray<string>> {
  if (ids.length === 0) return [];
  return Array.from(
    { length: Math.ceil(ids.length / maxPerChunk) },
    (_value, index) =>
      ids.slice(index * maxPerChunk, (index + 1) * maxPerChunk),
  );
}
