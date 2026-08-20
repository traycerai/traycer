import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  GET_TASK_CONTEXTS_MAX_IDS,
  isFoundTaskContext,
  type GetTaskContextsResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * What the tab strip knows about one open epic's History pin.
 *
 * `pinned` alone was the whole answer, and that is gap 4: pin is a CLOUD-ONLY
 * personal preference, a local-homed epic has no cloud row to carry one, and a
 * bare `false` is indistinguishable from "in the cloud and not pinned". So the
 * tab context menu offered Pin on a local epic, fired the mutation, and the
 * toast claimed it had pinned it.
 *
 * `home` is `undefined` when the host did not say - an older host, or a
 * pre-`@1.1` negotiation. That reads as cloud-or-unknown and keeps today's
 * behaviour, which is the only safe direction for an absence.
 */
export type TaskPinnedState = {
  readonly pinned: boolean;
  readonly home: "local" | undefined;
};

const EMPTY_TASK_PINNED_STATES: ReadonlyMap<string, TaskPinnedState> =
  new Map();

/** Reads personal History pin state for the exact set of open task tabs. */
export function useEpicTaskPinnedStates(
  epicIds: ReadonlyArray<string>,
): ReadonlyMap<string, TaskPinnedState> {
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
    ReadonlyMap<string, TaskPinnedState>
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
): ReadonlyMap<string, TaskPinnedState> {
  if (results.length === 0) return EMPTY_TASK_PINNED_STATES;
  const pinnedStates = new Map<string, TaskPinnedState>();
  for (const result of results) {
    if (result.data === undefined) continue;
    // Absent (a pre-`@1.2` host, or one that predates the key) means the host
    // did not answer, so no id is marked local and the pin action keeps
    // exactly its released behaviour. An EMPTY array is a real answer: none.
    const localHomed = result.data.localHomedTaskIds;
    const localHomedSet =
      localHomed === undefined ? null : new Set<string>(localHomed);
    for (const resolution of Object.values(result.data.tasks)) {
      if (!isFoundTaskContext(resolution)) continue;
      const task = resolution.task;
      const epicId = task.epic?.light?.id;
      if (epicId === undefined) continue;
      // Carried through rather than collapsed into the boolean. Collapsing it
      // is exactly how the tab strip lost it.
      pinnedStates.set(epicId, {
        pinned: task.pinned ?? false,
        home: localHomedSet?.has(epicId) === true ? "local" : undefined,
      });
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
