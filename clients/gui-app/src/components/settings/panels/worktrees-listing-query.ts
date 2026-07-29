import { useEffect, useMemo, useRef } from "react";
import {
  type InfiniteData,
  infiniteQueryOptions,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { withHostMutationLifecycleBoundary } from "@/hooks/host/use-host-query";
import type { WorktreeHostEntryV14 } from "@traycer/protocol/host/index";
import type { WorktreeListAllForHostResponseV14 } from "@traycer/protocol/host/worktree-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { type HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys, worktreeMutationKeys } from "@/lib/query-keys";
import { isPerPathEnrichmentQueryKey } from "@/lib/query-keys/worktree-enrichment-keys";
import { logPerfEvent } from "@/lib/perf/perf-telemetry";
import { toastFromHostError } from "@/lib/host-error-toast";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import {
  useWorktreeFirstPaintPerf,
  useWorktreeListQueryPerf,
} from "@/components/settings/panels/worktrees-settings-perf";
import {
  persistWorktreeListingSnapshot,
  readWorktreeListingSnapshot,
} from "@/components/settings/panels/worktrees-enrichment-persistence";

export const SETTINGS_WORKTREE_LIST_PAGE_LIMIT = 32;
// The listing's cache IDENTITY. `forceRefresh` is pinned to its canonical
// `false` here and never varies: it is a fetch directive, so a forced refetch
// must land in this same entry rather than fork a second one.
const SETTINGS_WORKTREE_LIST_BASE_PARAMS = {
  includeActivity: false,
  activityPaths: null,
  cursor: null,
  limit: SETTINGS_WORKTREE_LIST_PAGE_LIMIT,
  forceRefresh: false,
} as const;
const EMPTY_WORKTREES: readonly WorktreeHostEntryV14[] = [];
// Debounce for the warm-open listing snapshot writes, mirroring the activity
// snapshot's cadence: pages settle in bursts, so wait for a quiet window.
const WORKTREE_LISTING_PERSIST_DEBOUNCE_MS = 1_500;
// Seed-vs-live boundary, same convention as the enrichment leg: the restore
// seeds the listing query with its snapshot-era `updatedAt` (always a previous
// run), while any fetch this session stamps a fresh `dataUpdatedAt`.
const APP_SESSION_START_MS = Date.now();

// The base listing's cache identity, shared by the query options, the
// warm-open restore, and the live-data gate on persist.
export function listingQueryKeyFor(hostId: string | null): readonly unknown[] {
  return hostQueryKeys.method<HostRpcRegistry, "worktree.listAllForHost">(
    hostId,
    "worktree.listAllForHost",
    SETTINGS_WORKTREE_LIST_BASE_PARAMS,
  );
}

// Rebuilds the snapshot's rows as page-shaped InfiniteData. Chunked at the
// live page limit with SYNTHETIC chained cursors - not one flat page - so the
// reconciling refetch behaves exactly like a normal one: TanStack refetches an
// infinite query page-by-page, re-deriving each next cursor from the PREVIOUS
// freshly-fetched page via `getNextPageParam`, so the synthetic cursors never
// reach the wire and the visible list never collapses to a single live page
// mid-reconcile. A shrunken live list simply stops early (stale tail pages are
// dropped); a grown one continues through the auto-advance effect.
function seededListingData(
  entries: readonly WorktreeHostEntryV14[],
): InfiniteData<WorktreeListAllForHostResponseV14, string | null> {
  const pages: WorktreeListAllForHostResponseV14[] = [];
  const pageParams: Array<string | null> = [];
  for (
    let start = 0;
    start < entries.length;
    start += SETTINGS_WORKTREE_LIST_PAGE_LIMIT
  ) {
    const end = start + SETTINGS_WORKTREE_LIST_PAGE_LIMIT;
    pageParams.push(start === 0 ? null : `warm-open:${String(start)}`);
    pages.push({
      worktrees: [...entries.slice(start, end)],
      nextCursor: end < entries.length ? `warm-open:${String(end)}` : null,
    });
  }
  return { pages, pageParams };
}

/**
 * Base worktree listing - the instant, viewport-independent leg. It walks the
 * host-wide listing in finite pages with `includeActivity: false`, accumulating
 * cheap rows as pages land. The heavy activity probes are fetched lazily, only
 * for the rows scrolled into view, by
 * {@link import("@/components/settings/panels/worktrees-enrichment").useWorktreeActivityEnrichment}.
 */
export function useWorktreeListing(
  client: HostClient<HostRpcRegistry> | null,
  reachable: boolean,
): {
  readonly worktrees: readonly WorktreeHostEntryV14[];
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly errorMessage: string | null;
  readonly isEmpty: boolean;
  /**
   * A later page failed after earlier pages already landed, so `worktrees` is
   * a real but INCOMPLETE prefix of the host's full list - `isError` stays
   * false (there is usable data to show), so this is the only signal that the
   * list is truncated. Callers must not present `worktrees` as the complete
   * set while this is true; surface it and let the user retry.
   */
  readonly isPartial: boolean;
  readonly refresh: () => Promise<unknown>;
  /**
   * Resumes a truncated list by re-requesting only the page that failed - via
   * the same `fetchNextPage`/`getNextPageParam` path auto-pagination already
   * uses - instead of `refresh`'s full `refetch()`, which would re-request
   * every already-landed page too.
   */
  readonly retryPartial: () => Promise<unknown>;
  /**
   * True only while the user's explicit Refresh (the forced-listing mutation)
   * is in flight - NOT during background page fetches or enrichment. The
   * toolbar keys the Refresh button's disabled/spinner state off this, so it
   * stays clickable while a cold fleet is still converging its rows.
   */
  readonly isRefreshPending: boolean;
  /**
   * When the listing data was last written: a live fetch's wall-clock stamp,
   * or the snapshot's own save time while the warm-open seed is still what's
   * showing. `null` until any data exists. Drives the toolbar's
   * "Updated Xm ago" label under the manual-refresh model.
   */
  readonly lastUpdatedAt: number | null;
} {
  const readiness = useReactiveHostReadiness(client);
  const enabled = reachable && client !== null && readiness.isReady;
  const queryClient = useQueryClient();
  // ---- Warm-open restore (persisted last-known listing) --------------------
  // The row list itself blocks first paint: nothing renders until the base
  // listing query has data, and on a cold host that RPC takes seconds. Seed
  // the last run's listing on the first open per host - keyed by the same
  // hostId the query key uses, so rows paint even while the host is still
  // dialing. The seed keeps its snapshot-era `updatedAt`, so it is stale from
  // birth: the observer refetches it the moment the query is enabled, and the
  // live response replaces the seed wholesale (deleted worktrees drop, new
  // ones appear). Live cache data is never overwritten.
  const restoredHostsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const hostId = readiness.hostId;
    if (hostId === null) return;
    // Once per host per app session: afterwards the live cache is the richer
    // source and re-seeding would only churn cache events.
    if (restoredHostsRef.current.has(hostId)) return;
    restoredHostsRef.current.add(hostId);
    const snapshot = readWorktreeListingSnapshot(hostId, Date.now());
    if (snapshot === null || snapshot.entries.length === 0) return;
    const key = listingQueryKeyFor(hostId);
    const state =
      queryClient.getQueryState<
        InfiniteData<WorktreeListAllForHostResponseV14, string | null>
      >(key);
    if (state?.data !== undefined) return;
    queryClient.setQueryData<
      InfiniteData<WorktreeListAllForHostResponseV14, string | null>
    >(key, seededListingData(snapshot.entries), {
      updatedAt: snapshot.savedAt,
    });
    // Under `staleTime: Infinity` a seed would otherwise read as fresh
    // forever. The snapshot is ANOTHER session's truth, so mark it
    // invalidated: the observer reconciles it against the host exactly once
    // (on enable), and only live data earned this session sticks.
    void queryClient.invalidateQueries({ queryKey: key });
    logPerfEvent("worktree.listing_restore", {
      restoredCount: snapshot.entries.length,
    });
  }, [queryClient, readiness.hostId]);
  const fetchWorktreeListPage = ({
    pageParam,
  }: {
    readonly pageParam: string | null;
  }): Promise<WorktreeListAllForHostResponseV14> =>
    withHostQueryErrorBoundary("worktree.listAllForHost", async () => {
      if (client === null) {
        throw hostClientUnavailableError("worktree.listAllForHost");
      }
      return client.request("worktree.listAllForHost", {
        ...SETTINGS_WORKTREE_LIST_BASE_PARAMS,
        cursor: pageParam,
        forceRefresh: false,
      });
    });
  const {
    data,
    dataUpdatedAt,
    error,
    fetchNextPage,
    fetchStatus,
    hasNextPage,
    isError,
    isFetchingNextPage,
    isPending,
    isSuccess,
    status,
  } = useInfiniteQuery(
    infiniteQueryOptions<
      WorktreeListAllForHostResponseV14,
      HostRpcError,
      InfiniteData<WorktreeListAllForHostResponseV14, string | null>,
      readonly unknown[],
      string | null
    >({
      queryKey: listingQueryKeyFor(readiness.hostId),
      queryFn: fetchWorktreeListPage,
      initialPageParam: null,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      enabled,
      // Manual-refresh model: the listing never expires on its own. The host
      // pushes `worktree.changed` only on real mutations now (no periodic
      // sweep), so freshness is owned by the Refresh button + invalidation;
      // the toolbar surfaces `lastUpdatedAt` so staleness is visible instead
      // of silently refetched.
      staleTime: Infinity,
    }),
  );
  const refreshMutation = useMutation<
    WorktreeListAllForHostResponseV14,
    HostRpcError,
    { readonly client: HostClient<HostRpcRegistry>; readonly hostId: string }
  >(
    withHostMutationLifecycleBoundary("worktree.listAllForHost", {
      mutationKey: worktreeMutationKeys.refreshListing(),
      // The Refresh button's only failure signal was the spinner stopping - the
      // rejected promise is swallowed by useRefreshSpinner.
      onError: (error) =>
        toastFromHostError(error, "Couldn't refresh worktrees."),
      mutationFn: (input) =>
        withHostQueryErrorBoundary("worktree.listAllForHost", () =>
          input.client.request("worktree.listAllForHost", {
            includeActivity: false,
            activityPaths: null,
            cursor: null,
            limit: null,
            forceRefresh: true,
          }),
        ),
      onSuccess: (response, input) => {
        queryClient.setQueryData<
          InfiniteData<WorktreeListAllForHostResponseV14, string | null>
        >(listingQueryKeyFor(input.hostId), {
          pages: [response],
          pageParams: [null],
        });
        // The forced listing re-resolves the BASE rows, so every cached overlay
        // is now older than its base row and `acceptedEnrichedByPath` rejects it
        // - the rows read "Checking..." until something re-probes them. Nothing
        // would: the overlays keep their keys, so they are neither invalidated
        // nor sweep candidates. Without this the Refresh button strands every
        // on-screen row, permanently on a host that lacks `worktree.changed`.
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(
            input.hostId,
            "worktree.listAllForHost",
          ),
          refetchType: "active",
          predicate: (query) => isPerPathEnrichmentQueryKey(query.queryKey),
        });
      },
    }),
  );
  useEffect(() => {
    if (!enabled) return;
    if (!hasNextPage) return;
    if (isFetchingNextPage || isError) return;
    void fetchNextPage();
  }, [enabled, fetchNextPage, hasNextPage, isError, isFetchingNextPage]);
  // Memoized on `data` (structurally shared by TanStack), so consumers keyed on
  // the array identity - the merge/search memos and the enrichment sweep's
  // denominator - re-derive only when a page actually changes, not per render.
  const worktrees = useMemo(
    () => data?.pages.flatMap((page) => page.worktrees) ?? EMPTY_WORKTREES,
    [data],
  );
  // ---- Debounced snapshot writes (see the restore above) -------------------
  // Only COMPLETE listings persist: `isSuccess && !hasNextPage` means every
  // page landed, so a restored row list is never a truncated prefix (a partial
  // walk has `isError` with loaded data, which drops `isSuccess`). The empty
  // case never writes (guarded in the writer too): a zero-row snapshot can't
  // improve a cold open. The timer re-checks the LIVE-data gate at fire time -
  // a restored seed still carries its snapshot-era `dataUpdatedAt`, and
  // re-writing it would extend a stale snapshot's max-age life without the
  // host having confirmed anything this session.
  const persistDebounceRef = useRef<number | null>(null);
  useEffect(() => {
    const hostId = readiness.hostId;
    if (hostId === null) return;
    if (!isSuccess || hasNextPage || worktrees.length === 0) return;
    if (persistDebounceRef.current !== null) {
      window.clearTimeout(persistDebounceRef.current);
    }
    persistDebounceRef.current = window.setTimeout(() => {
      persistDebounceRef.current = null;
      const state = queryClient.getQueryState(listingQueryKeyFor(hostId));
      if (state === undefined || state.dataUpdatedAt < APP_SESSION_START_MS) {
        return;
      }
      persistWorktreeListingSnapshot({
        hostId,
        entries: worktrees,
        now: Date.now(),
      });
    }, WORKTREE_LISTING_PERSIST_DEBOUNCE_MS);
  }, [queryClient, readiness.hostId, isSuccess, hasNextPage, worktrees]);
  useEffect(
    () => () => {
      if (persistDebounceRef.current !== null) {
        window.clearTimeout(persistDebounceRef.current);
        // Reset the ref, not just the timer, so a StrictMode mount cycle
        // (setup → cleanup → setup on the surviving instance) can re-arm.
        persistDebounceRef.current = null;
      }
    },
    [],
  );
  // Perf telemetry (gated + non-throwing). Both legs now track the BASE query -
  // the real time-to-usable-list, which is what "snappy in any environment" means.
  useWorktreeListQueryPerf({
    includeActivity: false,
    fetchStatus,
    status,
    worktreeCount: worktrees.length,
    submoduleCount: worktrees.reduce(
      (sum, entry) => sum + entry.submodules.length,
      0,
    ),
    hasData: data !== undefined,
  });
  useWorktreeFirstPaintPerf({
    painted: isSuccess && worktrees.length > 0,
    rowCount: worktrees.length,
  });
  // `data !== undefined` - not `worktrees.length > 0` - is what distinguishes
  // "a page has landed" from "no page has landed yet": a host with zero
  // worktrees legitimately has an empty first page, and a later background
  // error on that host must still read as partial/empty, never as the hard
  // error state (which would hide the fact that the empty result was real).
  const hasLoadedData = data !== undefined;
  return {
    worktrees,
    isPending,
    isError: isError && !hasLoadedData,
    errorMessage: error?.message ?? null,
    isEmpty: isSuccess && !hasNextPage && worktrees.length === 0,
    isPartial: isError && hasLoadedData,
    refresh: () => {
      if (client === null || readiness.hostId === null) {
        return Promise.reject(
          hostClientUnavailableError("worktree.listAllForHost"),
        );
      }
      return refreshMutation.mutateAsync({
        client,
        hostId: readiness.hostId,
      });
    },
    retryPartial: () => fetchNextPage(),
    isRefreshPending: refreshMutation.isPending,
    lastUpdatedAt: dataUpdatedAt === 0 ? null : dataUpdatedAt,
  };
}
