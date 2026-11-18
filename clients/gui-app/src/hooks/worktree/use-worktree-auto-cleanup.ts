import {
  infiniteQueryOptions,
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  WorktreeAutoCleanupRunSummary,
  WorktreeListAutoCleanupRunsResponse,
} from "@traycer/protocol/host/worktree-auto-cleanup-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import {
  hostClientUnavailableError,
  useHostMutation,
  useHostQuery,
} from "@/hooks/host/use-host-query";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import { hostQueryKeys, worktreeMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

/**
 * The four `worktree.*AutoCleanup*` reads and the one write, as ordinary host
 * queries.
 *
 * All five are OPTIONAL capabilities: a host that predates them negotiates
 * them away, so every caller gates on `useHostSupportsMethod` FIRST and passes
 * `enabled: false` here. Nothing in this module schedules, retries, or
 * simulates cleanup on the client — deletion authority is the host's, and a
 * client-side fallback would be a second scheduler nobody asked for.
 */

/** One history page. Well under the wire ceiling of 100. */
export const WORKTREE_AUTO_CLEANUP_RUNS_PAGE_LIMIT = 20;

const EMPTY_RUNS: readonly WorktreeAutoCleanupRunSummary[] = [];

/**
 * The history list's cache identity. `cursor` is pinned to its canonical
 * `null` — it is a page directive, so a later page must land in this same
 * infinite entry rather than fork a second one. Mirrors
 * `worktrees-listing-query.ts`'s `listingQueryKeyFor`, including the reason the
 * key is a named function: the CLIENT is not part of a cache identity (the host
 * it addresses already is, as `hostId`), and inlining the builder is what makes
 * a lint rule read the queryFn's `client` capture as a missing key input.
 */
function autoCleanupRunsQueryKeyFor(hostId: string | null): readonly unknown[] {
  return hostQueryKeys.method<HostRpcRegistry, "worktree.listAutoCleanupRuns">(
    hostId,
    "worktree.listAutoCleanupRuns",
    { cursor: null, limit: WORKTREE_AUTO_CLEANUP_RUNS_PAGE_LIMIT },
  );
}

function fetchAutoCleanupRunsPage(
  client: HostClient<HostRpcRegistry> | null,
  cursor: string | null,
): Promise<WorktreeListAutoCleanupRunsResponse> {
  return withHostQueryErrorBoundary("worktree.listAutoCleanupRuns", () => {
    if (client === null) {
      return Promise.reject<WorktreeListAutoCleanupRunsResponse>(
        hostClientUnavailableError("worktree.listAutoCleanupRuns"),
      );
    }
    return client.request("worktree.listAutoCleanupRuns", {
      cursor,
      limit: WORKTREE_AUTO_CLEANUP_RUNS_PAGE_LIMIT,
    });
  });
}

/**
 * A revision conflict is not a transport failure: another surface (or another
 * device) wrote this host's policy first, so the only correct response is to
 * re-read and re-present. Exported because both the hook's invalidation and
 * the panel's inline notice key off the same code.
 */
export const AUTO_CLEANUP_REVISION_CONFLICT_CODE =
  "AUTO_CLEANUP_POLICY_REVISION_CONFLICT";

export function isAutoCleanupRevisionConflict(
  error: HostRpcError | null,
): boolean {
  return error !== null && error.code === AUTO_CLEANUP_REVISION_CONFLICT_CODE;
}

export function useWorktreeAutoCleanupPolicy(
  client: HostClient<HostRpcRegistry> | null,
  enabled: boolean,
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "worktree.getAutoCleanupPolicy">,
  HostRpcError
> {
  return useHostQuery<HostRpcRegistry, "worktree.getAutoCleanupPolicy">({
    client,
    method: "worktree.getAutoCleanupPolicy",
    params: {},
    cacheKeyIdentity: undefined,
    options: { enabled },
  });
}

export interface SetAutoCleanupPolicyContext {
  readonly hostId: string | null;
}

/**
 * Persists the policy under an explicit `expectedRevision`.
 *
 * On success the fresh state is written straight into the read query's slot -
 * the response IS the same shape `getAutoCleanupPolicy` answers with, which is
 * why the contract returns it - so the control never renders a stale revision
 * between the write landing and a refetch. On a revision conflict the slot is
 * invalidated instead: the caller must re-read rather than retry blind.
 */
export function useWorktreeSetAutoCleanupPolicy(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "worktree.setAutoCleanupPolicy">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "worktree.setAutoCleanupPolicy">,
  SetAutoCleanupPolicyContext
> {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "worktree.setAutoCleanupPolicy",
    SetAutoCleanupPolicyContext
  >({
    client,
    method: "worktree.setAutoCleanupPolicy",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: worktreeMutationKeys.setAutoCleanupPolicy(),
      onMutate: () => ({
        hostId: client === null ? null : client.getActiveHostId(),
      }),
      onSuccess: (data, _variables, mutationContext) => {
        if (mutationContext.hostId === null) return;
        queryClient.setQueryData(
          hostQueryKeys.method<
            HostRpcRegistry,
            "worktree.getAutoCleanupPolicy"
          >(mutationContext.hostId, "worktree.getAutoCleanupPolicy", {}),
          data,
        );
      },
      onError: (error, _variables, mutationContext) => {
        if (isAutoCleanupRevisionConflict(error)) {
          // Re-read, do not retry: the caller renders the conflict inline and
          // the refreshed state is what the control re-presents.
          if (mutationContext?.hostId === undefined) return;
          if (mutationContext.hostId === null) return;
          void queryClient.invalidateQueries({
            queryKey: hostQueryKeys.methodScope(
              mutationContext.hostId,
              "worktree.getAutoCleanupPolicy",
            ),
          });
          return;
        }
        toastFromHostError(error, "Couldn't save automatic cleanup.");
      },
    },
  });
}

export interface WorktreeAutoCleanupRunsResult {
  readonly runs: readonly WorktreeAutoCleanupRunSummary[];
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly errorMessage: string | null;
  readonly hasMore: boolean;
  readonly isLoadingMore: boolean;
  readonly loadMore: () => void;
}

/**
 * Cursor-paginated run history, newest first.
 *
 * Manual pagination, unlike the worktree listing's auto-advance: history is
 * bounded but can hold 200 runs, and the user asked to see the newest ones.
 * A "Load more" they press is cheaper than 200 rows nobody scrolled to.
 */
export function useWorktreeAutoCleanupRuns(
  client: HostClient<HostRpcRegistry> | null,
  enabled: boolean,
): WorktreeAutoCleanupRunsResult {
  const readiness = useReactiveHostReadiness(client);
  const queryEnabled = enabled && client !== null && readiness.isReady;
  const fetchPage = ({
    pageParam,
  }: {
    readonly pageParam: string | null;
  }): Promise<WorktreeListAutoCleanupRunsResponse> =>
    fetchAutoCleanupRunsPage(client, pageParam);
  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isError,
    isFetchingNextPage,
    isPending,
  } = useInfiniteQuery(
    infiniteQueryOptions<
      WorktreeListAutoCleanupRunsResponse,
      HostRpcError,
      InfiniteData<WorktreeListAutoCleanupRunsResponse, string | null>,
      readonly unknown[],
      string | null
    >({
      queryKey: autoCleanupRunsQueryKeyFor(readiness.hostId),
      queryFn: fetchPage,
      initialPageParam: null,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      enabled: queryEnabled,
    }),
  );
  return {
    runs: data?.pages.flatMap((page) => page.runs) ?? EMPTY_RUNS,
    isPending: queryEnabled && isPending,
    isError,
    errorMessage: error?.message ?? null,
    hasMore: hasNextPage,
    isLoadingMore: isFetchingNextPage,
    loadMore: () => {
      void fetchNextPage();
    },
  };
}

/**
 * One run's target rows. Fetched only while a run is expanded, so a history
 * page costs one request rather than one per row.
 */
export function useWorktreeAutoCleanupRun(
  client: HostClient<HostRpcRegistry> | null,
  runId: string,
  enabled: boolean,
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "worktree.getAutoCleanupRun">,
  HostRpcError
> {
  return useHostQuery<HostRpcRegistry, "worktree.getAutoCleanupRun">({
    client,
    method: "worktree.getAutoCleanupRun",
    params: { runId },
    cacheKeyIdentity: undefined,
    options: { enabled },
  });
}
