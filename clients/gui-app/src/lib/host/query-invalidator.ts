import type { Query, QueryClient } from "@tanstack/react-query";
import type { IHostQueryInvalidator } from "@traycer-clients/shared/host-client/host-client";
import { queryKeys } from "@/lib/query-keys";
import { getConditionPollEpisodeCoordinator } from "@/lib/query/condition-poll-episode-coordinator";

/**
 * Harness-catalog methods are carved out of every ACTIVE host-scope refetch.
 * Model catalogs are deliberately cache-only (`staleTime: Infinity`) and
 * command catalogs nearly so (finite 15-min staleTime) - see the header of
 * `hooks/harnesses/use-gui-harness-catalog.ts` for the refresh-point
 * doctrine - but `invalidateQueries` with an active refetch beats any
 * staleTime, so a host-scope invalidation was an undocumented refresh point
 * that bypassed the doctrine. On availability recovery that meant every
 * always-mounted catalog observer re-probed at once - each a provider
 * CLI/SDK spawn on the host - feeding the stall -> stream-flap ->
 * recovery-sweep loop a slow machine cannot exit (traycer#912). A recovered
 * stream - or a same-host transport rebind, which a storm also produces -
 * is not evidence the catalog changed: mark these stale
 * (`refetchType: "none"`) and let the intent edges recover them. An errored
 * entry is ALWAYS due at an intent edge (`harnessCatalogEntryNeedsRefresh`),
 * so a catalog stranded by an outage refetches on the next picker open or
 * harness selection; the manual refresh button and the app-load prefetch
 * remain as before. Provider-config changes deliberately do not invalidate
 * these keys either (`hooks/providers/invalidations.ts`) - the catalogs
 * have no automatic refresh path by design, and this carve-out closes the
 * one that slipped through.
 */
const ACTIVE_REFETCH_EXEMPT_METHODS: ReadonlySet<string> = new Set([
  "agent.gui.listModels",
  "agent.gui.listCommands",
]);

function isActiveRefetchExempt(query: Query): boolean {
  const method = query.queryKey[2];
  return (
    typeof method === "string" && ACTIVE_REFETCH_EXEMPT_METHODS.has(method)
  );
}

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
 * refetch active observers - except the harness-catalog methods above, which
 * are marked stale without a refetch.
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
        void client.invalidateQueries({
          queryKey,
          predicate: (query) => !isActiveRefetchExempt(query),
        });
        void client.invalidateQueries({
          queryKey,
          refetchType: "none",
          predicate: isActiveRefetchExempt,
        });
        return;
      }
      void client.cancelQueries({ queryKey });
      void client.invalidateQueries({ queryKey, refetchType: "none" });
    },
  };
}
