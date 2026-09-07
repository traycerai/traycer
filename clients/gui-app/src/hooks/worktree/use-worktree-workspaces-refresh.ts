import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CancelledError,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { WorktreeWorkspaceSummaryV15 } from "@traycer/protocol/host/worktree-schemas";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { worktreeListByWorkspacePathsParams } from "@/hooks/worktree/use-worktree-list-by-workspace-paths-query";
import type { HostRpcRegistry } from "@/lib/host";
import { toastFromHostError } from "@/lib/host-error-toast";
import { queryKeys, worktreeMutationKeys } from "@/lib/query-keys";
import { oldestResolvedAt } from "@/lib/worktree/oldest-resolved-at";

type WorktreeListByWorkspacePathsResponse = ResponseOfMethod<
  HostRpcRegistry,
  "worktree.listByWorkspacePaths"
>;

type RefreshVariables = {
  // Mutable `string[]`, matching the request schema's own field rather than
  // copying a readonly view into it on every call.
  readonly workspacePaths: string[];
  // It is what BOUNDS that recovery: the follow-up's own success cannot spawn another, so a host being swapped repeatedly costs one extra force per user-driven refresh, not an unbounded chase.
  readonly isHostFollowUp: boolean;
};

type RefreshMutateAsync = (
  variables: RefreshVariables,
) => Promise<WorktreeListByWorkspacePathsResponse>;

export interface WorktreeWorkspacesRefresh {
  /** Resolves once the host has answered (or rejects, having already toasted). A no-op with no paths in scope. */
  readonly refresh: () => Promise<void>;
  readonly isRefreshing: boolean;
  /** When the HOST last derived the facts on screen - see {@link oldestResolvedAt}. */
  readonly checkedAt: number | null;
  /** False with no bound host or no folders: the affordance has nothing to do. */
  readonly canRefresh: boolean;
  /** The footer renders "Couldn't verify - Retry" instead of the idle stamp; cleared on the next refresh attempt.
   * Coordinator cancellations (host swap) never set this - but a real failure of the one-hop post-swap force does. */
  readonly verifyFailed: boolean;
  /** The footer keys its 30s deadline to this so a Retry after timeout starts a fresh deadline rather than inheriting the previous attempt's expired timer. */
  readonly refreshGeneration: number;
}

/** Only forceRefresh: true re-touches disk after an external git checkout. The watcher cannot cover network mounts, LRU-cold repos, or other-host tabs. */
export function useWorktreeWorkspacesRefresh(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  /** The path list is part of the query key, so a re-derived or re-ordered copy would write the response into a key no observer reads and the screen would never move. */
  readonly workspacePaths: ReadonlyArray<string>;
  /** The summaries currently on screen, for the snapshot-age stamp. */
  readonly summaries: ReadonlyArray<WorktreeWorkspaceSummaryV15>;
}): WorktreeWorkspacesRefresh {
  const queryClient = useQueryClient();
  const { client, workspacePaths, summaries } = args;
  // Footer failure state: set on a real (non-cancelled) settle error; cleared
  // when the user retries. Distinct from the toast path, which still fires.
  const [verifyFailed, setVerifyFailed] = useState(false);
  // Bumped per user-driven attempt so the footer can key its deadline to the
  // attempt identity rather than the bare isPending boolean.
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  // Synced in an effect rather than during render (refs are not render state); the comparison happens when a request settles, long after the commit that changed the scope.
  const latestWorkspacePathsRef = useRef(workspacePaths);
  useEffect(() => {
    latestWorkspacePathsRef.current = workspacePaths;
  }, [workspacePaths]);
  // Set once the mutation exists; read only from `onSuccess`, which cannot run before the first commit.
  // Lets a completed force fire ONE follow-up force against a host that changed under it (see `onSuccess`) without the mutation's own options referencing the mutation being declared.
  const mutateAsyncRef = useRef<RefreshMutateAsync | null>(null);
  /** One follow-up force against the live host. Invalidation cannot heal a host-local workspace cache. */
  const forceAgainstLiveHost = useCallback(
    async (
      startedUnderHostId: string | null,
      isHostFollowUp: boolean,
    ): Promise<boolean> => {
      if (isHostFollowUp) return false;
      const latestHostId = client?.getActiveHostId() ?? null;
      if (latestHostId === startedUnderHostId) return false;
      const forceAgain = mutateAsyncRef.current;
      const latestPaths = latestWorkspacePathsRef.current;
      if (
        forceAgain === null ||
        latestHostId === null ||
        latestPaths.length === 0
      ) {
        return false;
      }
      // A real (non-cancelled) failure of THIS hop must still set the footer failure state - the outer refresh() already returned on CancelledError without marking verifyFailed, so toast-only would leave the footer idle.
      setRefreshGeneration((generation) => generation + 1);
      try {
        await forceAgain({
          workspacePaths: [...latestPaths],
          isHostFollowUp: true,
        });
      } catch (error) {
        if (!(error instanceof CancelledError)) {
          setVerifyFailed(true);
        }
      }
      return true;
    },
    [client],
  );
  const refreshMutation = useHostMutation<
    HostRpcRegistry,
    "worktree.listByWorkspacePaths",
    // Both fields captured when the mutation actually fires, not read from this render's closures: a host rebind, or a folder added/removed while the forced read is in flight, would otherwise land the response under the wrong host or the wrong path set - `onSuccess` runs whenever it runs, not necessarily against the render that started the request.
    { readonly hostId: string | null; readonly workspacePaths: string[] },
    RefreshVariables
  >({
    client,
    method: "worktree.listByWorkspacePaths",
    mapVariables: (variables) => ({
      workspacePaths: variables.workspacePaths,
      scriptRefs: [],
      forceRefresh: true,
    }),
    options: {
      mutationKey: worktreeMutationKeys.refreshWorkspaceSummaries(
        args.workspacePaths,
      ),
      onMutate: async (variables) => {
        const context = {
          hostId: client?.getActiveHostId() ?? null,
          workspacePaths: variables.workspacePaths,
        };
        // Without this the forced response can land first and the older cache-only response can then settle and overwrite the same key back to the stale view - leaving the label worse than if nothing had refreshed.
        await queryClient.cancelQueries({
          queryKey: workspacesQueryKey(context.hostId, context.workspacePaths),
        });
        return context;
      },
      onError: async (error, variables, context) => {
        // Coordinator control-flow cancellations (superseded, waiter-cancelled, disposed) are silent. They are not user-facing refresh failures.
        if (error instanceof CancelledError) {
          await forceAgainstLiveHost(
            context?.hostId ?? null,
            variables.isHostFollowUp,
          );
          return;
        }
        toastFromHostError(error, "Couldn't refresh folder details.");
      },
      onSuccess: async (response, variables, context) => {
        // Reissuing the query with `forceRefresh: true` in its params instead would fork a second key that no observer reads, so the fresh branch would never reach the screen.
        queryClient.setQueryData<WorktreeListByWorkspacePathsResponse>(
          workspacesQueryKey(context.hostId, context.workspacePaths),
          response,
        );
        // Scope (paths or host) can move while the force is in flight. Follow-up invalidates the host now on screen; do not invalidate under the host that left.
        if (
          await forceAgainstLiveHost(context.hostId, variables.isHostFollowUp)
        ) {
          return;
        }
        const latestHostId = client?.getActiveHostId() ?? null;
        const latestPaths = latestWorkspacePathsRef.current;
        if (
          latestHostId === context.hostId &&
          !samePathScope(latestPaths, context.workspacePaths)
        ) {
          // Paths moved under the same host: the rows switched to a different key that issued its own `forceRefresh: false` read, which cold-only mode can settle STALE, and the response above landed only in the captured key.
          await queryClient.invalidateQueries({
            queryKey: workspacesQueryKey(context.hostId, latestPaths),
            refetchType: "active",
          });
        }
        // Await refetchType active so the mounted branch list updates before Refresh reports done.
        await queryClient.invalidateQueries({
          queryKey: queryKeys.hostMethodScope(
            context.hostId,
            "worktree.listBranches",
          ),
          refetchType: "active",
        });
      },
    },
  });
  const mutateAsync = refreshMutation.mutateAsync;
  useEffect(() => {
    mutateAsyncRef.current = mutateAsync;
  }, [mutateAsync]);
  const refresh = useCallback(async () => {
    // The same condition `canRefresh` advertises, enforced HERE rather than trusted to every call site.
    // Today all of them gate on it, so this changes no behaviour; without it, one future caller that forgets turns an unbound host into a `hostClientUnavailableError` toast on a surface whose own affordance was sitting disabled the whole time.
    if (client === null || workspacePaths.length === 0) return;
    setVerifyFailed(false);
    setRefreshGeneration((generation) => generation + 1);
    try {
      await mutateAsync({
        workspacePaths: [...workspacePaths],
        isHostFollowUp: false,
      });
    } catch (error) {
      // `mutateAsync` rejects all the same, so without this every caller sees an ordinary host switch as a failed refresh - and the intent-edge callers that fire this without awaiting would raise an unhandled rejection.
      if (error instanceof CancelledError) return;
      setVerifyFailed(true);
      throw error;
    }
  }, [client, mutateAsync, workspacePaths]);
  const checkedAt = useMemo(
    () => oldestResolvedAt(summaries.map((summary) => summary.resolvedAt)),
    [summaries],
  );
  return {
    refresh,
    isRefreshing: refreshMutation.isPending,
    checkedAt,
    canRefresh: client !== null && workspacePaths.length > 0,
    verifyFailed,
    refreshGeneration,
  };
}

/** Same paths in the same order - the query key is order-sensitive. */
function samePathScope(
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => entry === right[index]);
}

/** The `forceRefresh: false` entry the rows actually render from. */
function workspacesQueryKey(
  hostId: string | null,
  workspacePaths: readonly string[],
): QueryKey {
  return queryKeys.hostMethod<HostRpcRegistry, "worktree.listByWorkspacePaths">(
    hostId,
    "worktree.listByWorkspacePaths",
    worktreeListByWorkspacePathsParams(workspacePaths),
  );
}
