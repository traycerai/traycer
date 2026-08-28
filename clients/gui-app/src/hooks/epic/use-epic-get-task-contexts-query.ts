import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import {
  GET_TASK_CONTEXTS_MAX_IDS,
  isFoundTaskContext,
  type GetTaskContextsResponse,
  type ListTaskLight,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostQueries } from "@/hooks/host/use-host-queries";

/**
 * Presentation-only stale window for the title/context readers of
 * `epic.getTaskContexts`. These callers render a Task title next to an id;
 * nothing they show is destructive and nothing they show is time-critical, so
 * a fetch per mount buys nothing. Deliberately much longer than the existence
 * reconciler's window (`epic-tab-existence-reconciler.tsx`), which is the one
 * consumer whose freshness has consequences. A rename still lands promptly:
 * the epic's own Y.Doc drives every surface that shows a live title, and this
 * batch only backfills ids no cloud-tasks page has cached.
 */
export const TASK_CONTEXT_TITLE_STALE_TIME_MS = 5 * 60_000;

export interface EpicTaskContexts {
  readonly tasksById: ReadonlyMap<string, ListTaskLight>;
  readonly isFetching: boolean;
  readonly error: Error | null;
}

/**
 * Resolves task ids to their cloud `ListTaskLight` contexts via cap-sized
 * `epic.getTaskContexts` batches. Only `found` rows enter the map; absence and
 * unknown outcomes stay unavailable to this presentation-only caller. Cache identity is
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
    options: {
      enabled: userId !== null && taskIds.length > 0,
      staleTime: TASK_CONTEXT_TITLE_STALE_TIME_MS,
    },
    combine: combineTaskContextResults,
  });
}

function combineTaskContextResults(
  results: Array<UseQueryResult<GetTaskContextsResponse, HostRpcError>>,
): EpicTaskContexts {
  const tasksById = new Map<string, ListTaskLight>();
  for (const result of results) {
    if (result.data === undefined) continue;
    for (const [taskId, resolution] of Object.entries(result.data.tasks)) {
      if (isFoundTaskContext(resolution)) {
        tasksById.set(taskId, resolution.task);
      }
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
