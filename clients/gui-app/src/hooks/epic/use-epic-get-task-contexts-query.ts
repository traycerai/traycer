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

export interface EpicTaskContexts {
  readonly tasksById: ReadonlyMap<string, ListTaskLight>;
  /**
   * The subset of `tasksById` the host marked local-homed - `@1.1`'s
   * `localHomedTaskIds` sibling.
   *
   * Carried rather than dropped because `tasks` is a `z.record`, so the home
   * marker could NOT be added to the row itself (the additivity gate treats a
   * record's value schema as opaque). A consumer that projects only
   * `response.tasks` therefore loses the one fact the minor was added to
   * carry, and a context-only search hit - a local epic matched by branch,
   * path, or PR - reads as cloud-backed.
   *
   * Empty means the host said nothing (an older host, or an `@1.0`
   * negotiation), which reads as cloud-or-unknown and never as local.
   */
  readonly localHomedTaskIds: ReadonlySet<string>;
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
    options: { enabled: userId !== null && taskIds.length > 0 },
    combine: combineTaskContextResults,
  });
}

function combineTaskContextResults(
  results: Array<UseQueryResult<GetTaskContextsResponse, HostRpcError>>,
): EpicTaskContexts {
  const tasksById = new Map<string, ListTaskLight>();
  const localHomedTaskIds = new Set<string>();
  for (const result of results) {
    if (result.data === undefined) continue;
    for (const [taskId, resolution] of Object.entries(result.data.tasks)) {
      if (isFoundTaskContext(resolution)) {
        tasksById.set(taskId, resolution.task);
      }
    }
    for (const taskId of result.data.localHomedTaskIds ?? []) {
      localHomedTaskIds.add(taskId);
    }
  }
  return {
    tasksById,
    localHomedTaskIds,
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
