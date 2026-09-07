import type { Query, QueryClient } from "@tanstack/react-query";
import type { IHostQueryInvalidator } from "@traycer-clients/shared/host-client/host-client";
import { appLogger } from "@/lib/logger";
import { isCloudEpicTasksQueryKey, queryKeys } from "@/lib/query-keys";
import { getConditionPollEpisodeCoordinator } from "@/lib/query/condition-poll-episode-coordinator";

/**
 * Carve harness-catalog methods out of every active host-scope refetch, including recovery sweeps.
 * Do not mark them stale either: `isInvalidated` would still burst-probe every harness on the next picker open.
 */
const ACTIVE_REFETCH_EXEMPT_METHODS: ReadonlySet<string> = new Set([
  "agent.gui.listModels",
  "agent.gui.listCommands",
]);

/**
 * The cloud epic-tasks history is the second carve-out, and it is a documented invariant rather than a tuning choice: the list is manual-refresh-only (`staleTime: Infinity`) and holds optimistically inserted local-first epics that a cloud `listTasks`.
 */
function isActiveRefetchExempt(query: Query): boolean {
  if (isCloudEpicTasksQueryKey(query.queryKey)) return true;
  const method = query.queryKey[2];
  return (
    typeof method === "string" && ACTIVE_REFETCH_EXEMPT_METHODS.has(method)
  );
}

/** Adapts the app's `QueryClient` to the `IHostQueryInvalidator` port. */
export function createHostQueryInvalidator(
  client: QueryClient,
): IHostQueryInvalidator {
  return {
    cancelHostScope: (hostId) =>
      client.cancelQueries({ queryKey: queryKeys.hostScope(hostId) }),
    invalidateHostScope: (hostId, options) => {
      getConditionPollEpisodeCoordinator(client).resetHostScope(hostId);
      const queryKey = queryKeys.hostScope(hostId);
      if (options.refetchActive) {
        // Freeze the recovery sweep at the instant the signal arrives.
        // The cancel below is async; reusing only the broad host predicate after that await would also invalidate queries mounted in the meantime, even though they were never stranded by this recovery episode.
        const affectedQueries = new Set(
          client
            .getQueryCache()
            .findAll({ queryKey })
            .filter((query) => !isActiveRefetchExempt(query)),
        );
        // The one line that counts SWEEPS.
        // The per-stream-client recovery wiring logs at debug, once per client, which over-reported the sweep count by the number of live stream clients in the window - that reading is what turned two sweeps a minute into a reported "1056 refetch storms a day" in.
        appLogger.info("[stream] host-scope sweep", {
          hostId: hostId ?? "all",
          refetching: affectedQueries.size,
        });
        const predicate = (query: Query): boolean => affectedQueries.has(query);
        // A query waiting in TanStack's retry backoff is still `fetchStatus: "fetching"`.
        // Invalidating it alone only marks it stale; it does not interrupt the sleep or start a recovery request.
        void (async (): Promise<void> => {
          await client.cancelQueries({ queryKey, predicate });
          await client.invalidateQueries({ queryKey, predicate });
        })();
        return;
      }
      void client.cancelQueries({ queryKey });
      void client.invalidateQueries({ queryKey, refetchType: "none" });
    },
  };
}
