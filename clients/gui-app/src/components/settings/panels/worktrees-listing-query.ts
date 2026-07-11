import { useEffect } from "react";
import {
  type InfiniteData,
  infiniteQueryOptions,
  useInfiniteQuery,
} from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { WorktreeHostEntryV12 } from "@traycer/protocol/host/index";
import type { WorktreeListAllForHostResponseV12 } from "@traycer/protocol/host/worktree-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { type HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import {
  useWorktreeFirstPaintPerf,
  useWorktreeListQueryPerf,
} from "@/components/settings/panels/worktrees-settings-perf";

const SETTINGS_WORKTREE_LIST_PAGE_LIMIT = 32;
const SETTINGS_WORKTREE_LIST_BASE_PARAMS = {
  includeActivity: false,
  activityPaths: null,
  cursor: null,
  limit: SETTINGS_WORKTREE_LIST_PAGE_LIMIT,
} as const;
const EMPTY_WORKTREES: readonly WorktreeHostEntryV12[] = [];

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
  readonly worktrees: readonly WorktreeHostEntryV12[];
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
  readonly refreshing: boolean;
} {
  const readiness = useReactiveHostReadiness(client);
  const enabled = reachable && client !== null && readiness.isReady;
  const fetchWorktreeListPage = async ({
    pageParam,
  }: {
    readonly pageParam: string | null;
  }): Promise<WorktreeListAllForHostResponseV12> => {
    if (client === null) {
      throw hostClientUnavailableError("worktree.listAllForHost");
    }
    return client.request("worktree.listAllForHost", {
      includeActivity: false,
      activityPaths: null,
      cursor: pageParam,
      limit: SETTINGS_WORKTREE_LIST_PAGE_LIMIT,
    });
  };
  const {
    data,
    error,
    fetchNextPage,
    fetchStatus,
    hasNextPage,
    isError,
    isFetching,
    isFetchingNextPage,
    isPending,
    isSuccess,
    refetch,
    status,
  } = useInfiniteQuery(
    infiniteQueryOptions<
      WorktreeListAllForHostResponseV12,
      HostRpcError,
      InfiniteData<WorktreeListAllForHostResponseV12, string | null>,
      readonly unknown[],
      string | null
    >({
      queryKey: hostQueryKeys.method<
        HostRpcRegistry,
        "worktree.listAllForHost"
      >(
        readiness.hostId,
        "worktree.listAllForHost",
        SETTINGS_WORKTREE_LIST_BASE_PARAMS,
      ),
      queryFn: fetchWorktreeListPage,
      initialPageParam: null,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      enabled,
    }),
  );
  useEffect(() => {
    if (!enabled) return;
    if (!hasNextPage) return;
    if (isFetchingNextPage || isError) return;
    void fetchNextPage();
  }, [enabled, fetchNextPage, hasNextPage, isError, isFetchingNextPage]);
  const worktrees =
    data?.pages.flatMap((page) => page.worktrees) ?? EMPTY_WORKTREES;
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
    refresh: () => refetch(),
    retryPartial: () => fetchNextPage(),
    refreshing: isFetching,
  };
}
