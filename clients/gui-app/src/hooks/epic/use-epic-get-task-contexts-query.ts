import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import {
  GET_TASK_CONTEXTS_MAX_IDS,
  type GetTaskContextsResponse,
  type ListTaskLight,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostQueries } from "@/hooks/host/use-host-queries";

export interface EpicTaskContexts {
  readonly tasksById: ReadonlyMap<string, ListTaskLight>;
  readonly isFetching: boolean;
  readonly error: Error | null;
}

/**
 * Resolves task ids to their cloud `ListTaskLight` contexts via cap-sized
 * `epic.getTaskContexts` batches. `null` responses (deleted / not permitted -
 * indistinguishable by design) are dropped from the map. Cache identity is
 * scoped by `userId` because permission-dependent responses must not leak
 * across account switches; the hook stays disabled until a user is known.
 * An older host without the method degrades to an empty map, not an error.
 */
export function useEpicGetTaskContexts(
  taskIds: readonly string[],
  userId: string | null,
): EpicTaskContexts {
  const client = useHostClient();
  const requests = useMemo(
    () =>
      chunkTaskIds(taskIds, GET_TASK_CONTEXTS_MAX_IDS).map((chunk) => ({
        method: "epic.getTaskContexts" as const,
        params: { taskIds: [...chunk] },
      })),
    [taskIds],
  );
  return useHostQueries<
    HostRpcRegistry,
    "epic.getTaskContexts",
    EpicTaskContexts
  >({
    client,
    requests,
    cacheKeyIdentity: userId === null ? undefined : userId,
    options: { enabled: userId !== null && taskIds.length > 0 },
    combine: combineTaskContextResults,
  });
}

function combineTaskContextResults(
  results: Array<UseQueryResult<GetTaskContextsResponse, HostRpcError>>,
): EpicTaskContexts {
  const tasksById = new Map<string, ListTaskLight>();
  for (const result of results) {
    if (result.data === undefined) continue;
    for (const [taskId, task] of Object.entries(result.data.tasks)) {
      if (task !== null) tasksById.set(taskId, task);
    }
  }
  return {
    tasksById,
    isFetching: results.some((result) => result.isFetching),
    // Older host: method unsupported → degrade silently to an empty map.
    error:
      results
        .map((result) => result.error)
        .find(
          (error): error is HostRpcError =>
            error !== null && error.code !== "E_HOST_UNSUPPORTED",
        ) ?? null,
  };
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
