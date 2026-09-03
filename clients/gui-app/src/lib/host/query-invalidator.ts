import type { Query, QueryClient } from "@tanstack/react-query";
import type { IHostQueryInvalidator } from "@traycer-clients/shared/host-client/host-client";
import { appLogger } from "@/lib/logger";
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
 * (`cloud-query-keys.ts`). The invariant was once enforced at exactly one call
 * site (`use-workspace-folder-actions`), while the broadest sweep of all -
 * `HostClient.bind()`, which force-refetched the entire new host scope on
 * every host switch - ignored it. That sweep is gone: P4.2 deleted the slot.
 * TWO broad `refetchActive` sweeps reach this port now - availability
 * recovery, and the R-1 key-rotation sweep that replaced `bind()`'s
 * rebuilt-host guarantee - and enforcing the invariant here covers both,
 * which is more than the sweep it replaced ever did.
 *
 * A host becoming EFFECTIVE still sweeps nothing through this port, and the
 * exception is worth naming so a reader does not go looking for it: the
 * re-point re-probe (`useHostStatusReprobeOnRepoint`) invalidates ONE exact
 * key straight against the query client. It never enters this port, so it
 * cannot reach the carve-outs - and has no need to, being a single entry
 * rather than a scope. The list still refreshes through its own lifecycle and
 * its own manual refresh.
 */
function isActiveRefetchExempt(query: Query): boolean {
  if (isCloudEpicTasksQueryKey(query.queryKey)) return true;
  const method = query.queryKey[2];
  return (
    typeof method === "string" && ACTIVE_REFETCH_EXEMPT_METHODS.has(method)
  );
}

/**
 * Whether an availability recovery has anything to do for this entry.
 *
 * The recovery sweep exists to un-strand queries: every automatic TanStack
 * recovery route is disabled for host RPCs, so a query that failed while the
 * host was unreachable sits in a terminal `error` state - or in a retry
 * backoff that is still `fetching` - with no other way back. Those are the
 * stranded shapes. A query that holds a successful result and is idle was not
 * stranded by anything; a recovered stream is not evidence its data changed,
 * which is the same doctrine the carve-outs above already state for the
 * catalogs, and its own `staleTime` still governs when it refreshes.
 *
 * Refetching the healthy ones was the storm: every stream client reports a
 * recovery independently, the pong heartbeat used to report one for the
 * client's own late ping, and each sweep re-issued every active host query -
 * a burst into a host that was busy enough to delay the next pong, which was
 * the next "recovery" (field: a sweep a minute for 10 h on 2026-09-03). With
 * the sweep scoped to stranded entries a false recovery costs nothing and a
 * true one costs exactly the queries that need it.
 */
function isStrandedByOutage(query: Query): boolean {
  return query.state.status === "error" || query.state.fetchStatus !== "idle";
}

/**
 * Adapts the app's `QueryClient` to the `IHostQueryInvalidator` port.
 *
 * Host-scoped queries use the key layout `["host", hostId, method, params]`,
 * so invalidating at `["host", hostId]` covers every cached entry tied to
 * that host. Passing `null` targets the `["host"]` root which drops all
 * host-scoped entries - used for an auth identity transition, which
 * invalidates work on every host this client serves rather than on a
 * privileged one.
 *
 * `HostClient` calls this on an auth identity transition, on availability
 * recovery, and on an unannounced host-scope sweep (today: the R-1
 * key-rotation sweep). Bind/unbind is not in that list any more - it went with
 * the active slot (P4.2). An identity transition marks stale WITHOUT
 * refetching, because the request context may already be gone; the two
 * host-named sweeps can refetch active observers - except the two carve-outs
 * in `isActiveRefetchExempt` (harness catalogs, cloud epic-tasks history),
 * which are skipped entirely.
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
        // Freeze the recovery sweep at the instant the signal arrives. The
        // cancel below is async; reusing only the broad host predicate after
        // that await would also invalidate queries mounted in the meantime,
        // even though they were never stranded by this recovery episode.
        const scoped = client
          .getQueryCache()
          .findAll({ queryKey })
          .filter((query) => !isActiveRefetchExempt(query));
        const affectedQueries = new Set(
          options.strandedOnly ? scoped.filter(isStrandedByOutage) : scoped,
        );
        // The one line that counts SWEEPS. The per-stream-client recovery
        // wiring used to log at info, once per client, which over-reported
        // the sweep count by the number of live stream clients in the window.
        appLogger.info("[stream] host-scope sweep", {
          hostId: hostId ?? "all",
          sweep: options.strandedOnly ? "stranded-only" : "everything",
          refetching: affectedQueries.size,
          untouched: scoped.length - affectedQueries.size,
        });
        if (affectedQueries.size === 0) return;
        const predicate = (query: Query): boolean => affectedQueries.has(query);
        // A query waiting in TanStack's retry backoff is still `fetchStatus:
        // "fetching"`. Invalidating it alone only marks it stale; it does not
        // interrupt the sleep or start a recovery request. Cancel the affected
        // active work first, then invalidate so availability recovery produces
        // an immediate refetch instead of requiring a remount or waiting for
        // the old retry timer. The carve-outs remain excluded from BOTH passes,
        // preserving their cache-only refresh doctrine.
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
