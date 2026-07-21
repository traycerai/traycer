import type { QueryClient } from "@tanstack/react-query";
import type { IHostQueryInvalidator } from "@traycer-clients/shared/host-client/host-client";
import { queryKeys } from "@/lib/query-keys";
import { getConditionPollEpisodeCoordinator } from "@/lib/query/condition-poll-episode-coordinator";

/**
 * Adapts the app's `QueryClient` to the `IHostQueryInvalidator` port.
 *
 * Host-scoped queries use the key layout `["host", hostId, method, params]`,
 * so invalidating at `["host", hostId]` covers every cached entry tied to
 * that host. Passing `null` targets the `["host"]` root which drops all
 * host-scoped entries - used when no host is currently bound.
 *
 * `HostClient` calls this on auth change, host bind/unbind, and
 * availability recovery. Auth changes mark stale without refetching because
 * the request context may already be gone; host availability recovery can
 * refetch active observers.
 */
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
        void client.invalidateQueries({ queryKey });
        return;
      }
      void client.cancelQueries({ queryKey });
      void client.invalidateQueries({ queryKey, refetchType: "none" });
    },
  };
}
