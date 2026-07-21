import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  GET_TASK_CONTEXTS_MAX_IDS,
  type GetTaskContextsResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useAuthStore } from "@/stores/auth/auth-store";

const EMPTY_TASK_PINNED_STATES: ReadonlyMap<string, boolean> = new Map();

/** Reads personal History pin state for the exact set of open task tabs. */
export function useEpicTaskPinnedStates(
  epicIds: ReadonlyArray<string>,
): ReadonlyMap<string, boolean> {
  const client = useHostClient();
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const normalizedIds = useMemo(
    () =>
      [...new Set(epicIds)].sort((left, right) => left.localeCompare(right)),
    [epicIds],
  );
  const requests = useMemo(
    () =>
      chunkTaskIds(normalizedIds).map((taskIds) => ({
        method: "epic.getTaskContexts" as const,
        params: { taskIds: [...taskIds] },
      })),
    [normalizedIds],
  );

  return useHostQueries<
    HostRpcRegistry,
    "epic.getTaskContexts",
    ReadonlyMap<string, boolean>
  >({
    client,
    requests,
    cacheKeyIdentity: userId ?? undefined,
    options: {
      enabled: userId !== null && normalizedIds.length > 0,
      staleTime: Infinity,
    },
    combine: combineTaskPinnedStateResults,
  });
}

export function combineTaskPinnedStateResults(
  results: ReadonlyArray<
    Pick<UseQueryResult<GetTaskContextsResponse, HostRpcError>, "data">
  >,
): ReadonlyMap<string, boolean> {
  if (results.length === 0) return EMPTY_TASK_PINNED_STATES;
  const pinnedStates = new Map<string, boolean>();
  for (const result of results) {
    if (result.data === undefined) continue;
    for (const task of Object.values(result.data.tasks)) {
      if (task === null) continue;
      const epicId = task.epic?.light?.id;
      if (epicId === undefined) continue;
      pinnedStates.set(epicId, task.pinned ?? false);
    }
  }
  return pinnedStates;
}

export function chunkTaskIds(
  ids: ReadonlyArray<string>,
): ReadonlyArray<ReadonlyArray<string>> {
  return Array.from(
    { length: Math.ceil(ids.length / GET_TASK_CONTEXTS_MAX_IDS) },
    (_value, index) =>
      ids.slice(
        index * GET_TASK_CONTEXTS_MAX_IDS,
        (index + 1) * GET_TASK_CONTEXTS_MAX_IDS,
      ),
  );
}
