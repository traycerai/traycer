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
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
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

export interface UseEpicGetTaskContextsOptions {
  /**
   * Whether this caller may SPEND the account's cloud capability on the batch.
   *
   * Required, and deliberately not derived here from the auth store: `userId`
   * below is an ADMISSION fact (`admitsLocalPlane` resolves one for an
   * `unverified` session, off this device's credentials file), and reading it
   * as an authorization is exactly the conflation this parameter exists to
   * break. `epic.getTaskContexts` reaches the account's servers for every id it
   * cannot answer locally, so a caller that passes a widened identity has to
   * state the cloud half separately - the value is
   * `authorizesCloudCapability(status)` at every current call site.
   *
   * A caller that has already gated its whole surface on the verdict passes
   * `true`; what is not available is omitting the question.
   */
  readonly enabled: boolean;
}

/**
 * Resolves task ids to their cloud `ListTaskLight` contexts via cap-sized
 * `epic.getTaskContexts` batches. Only `found` rows enter the map; absence and
 * unknown outcomes stay unavailable to this presentation-only caller. Cache identity is
 * scoped by `userId` because permission-dependent responses must not leak
 * across account switches; the hook stays disabled until a user is known.
 * An older host without the method degrades to an empty map, not an error.
 *
 * `options.enabled` is the cloud-authorization half and is ANDed with the two
 * intrinsic gates below rather than replacing either - a known user and a
 * non-empty id list are still required of an authorized caller.
 */
export function useEpicGetTaskContexts(
  taskIds: readonly string[],
  userId: string | null,
  options: UseEpicGetTaskContextsOptions,
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
    // `options.enabled` is the verdict at render; this is the verdict at
    // dispatch, which a retry episode already running at demotion needs.
    preflight: cloudVerdictPreflight("epic.getTaskContexts"),
    options: {
      enabled: options.enabled && userId !== null && taskIds.length > 0,
      staleTime: TASK_CONTEXT_TITLE_STALE_TIME_MS,
    },
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
