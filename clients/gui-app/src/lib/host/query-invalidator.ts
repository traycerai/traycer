import type { Query, QueryClient } from "@tanstack/react-query";
import type { IHostQueryInvalidator } from "@traycer-clients/shared/host-client/host-client";
import { isCloudEpicTasksQueryKey, queryKeys } from "@/lib/query-keys";
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
 * is not evidence the catalog changed, so a recovery sweep leaves these
 * entries ENTIRELY UNTOUCHED - not refetched, and not marked stale either.
 *
 * Marking them would defer the storm rather than prevent it: TanStack
 * treats an invalidated query as stale regardless of `staleTime`, so
 * `refetchType: "none"` still sets `isInvalidated` and the next mount
 * refetches. The picker mounts `useGuiHarnessCatalog` with
 * `enabled: catalogActive` and one enabled `listModels` observer per
 * harness, so the first picker/palette open after any recovery sweep would
 * re-probe EVERY harness at once - the same CLI/SDK spawn burst, moved from
 * the sweep to the next user interaction, and worse for being attributed to
 * the click. Leaving the entries alone keeps recovery out of the refresh
 * doctrine entirely and lets the existing per-entry intent guard decide:
 * an errored or aged entry is ALWAYS due at an intent edge
 * (`harnessCatalogEntryNeedsRefresh`), so a catalog stranded by an outage
 * still recovers on the next picker open or harness selection - selectively,
 * one entry at a time, instead of all of them. The manual refresh button and
 * the app-load prefetch remain as before. Provider-config changes
 * deliberately do not invalidate these keys either
 * (`hooks/providers/invalidations.ts`) - the catalogs have no automatic
 * refresh path by design, and this carve-out closes the one that slipped
 * through.
 */
const ACTIVE_REFETCH_EXEMPT_METHODS: ReadonlySet<string> = new Set([
  "agent.gui.listModels",
  "agent.gui.listCommands",
]);

/**
 * The cloud epic-tasks history is the second carve-out, and it is a
 * documented invariant rather than a tuning choice: the list is
 * manual-refresh-only (`staleTime: Infinity`) and holds optimistically
 * inserted local-first epics that a cloud `listTasks` response does not carry
 * yet, so force-refetching it DROPS epics the user just created
 * (`cloud-query-keys.ts`). Until now the invariant was enforced at exactly
 * one call site (`use-workspace-folder-actions`), while the broadest sweep of
 * all - `HostClient.bind()`, which force-refetches the entire new host scope
 * on every host switch - ignored it. Applying it here covers both broad
 * `refetchActive` sweeps (bind and availability recovery); the list still
 * refreshes through its own lifecycle and its own manual refresh.
 */
function isActiveRefetchExempt(query: Query): boolean {
  if (isCloudEpicTasksQueryKey(query.queryKey)) return true;
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
 * the request context may already be gone; host bind and availability
 * recovery can refetch active observers - except the two carve-outs in
 * `isActiveRefetchExempt` (harness catalogs, cloud epic-tasks history), which
 * are skipped entirely.
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
        // Single pass with the exemption in the predicate: the carved-out
        // catalog entries are skipped outright, so they keep both their data
        // and their un-invalidated state (see the header - invalidating them
        // would just move the probe storm to the next picker open).
        void client.invalidateQueries({
          queryKey,
          predicate: (query) => !isActiveRefetchExempt(query),
        });
        return;
      }
      void client.cancelQueries({ queryKey });
      void client.invalidateQueries({ queryKey, refetchType: "none" });
    },
  };
}
