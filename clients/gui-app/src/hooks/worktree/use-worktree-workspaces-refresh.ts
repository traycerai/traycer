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
  // True only for the single re-force `onSuccess` fires when the active host
  // changed mid-request. It is what BOUNDS that recovery: the follow-up's own
  // success cannot spawn another, so a host being swapped repeatedly costs one
  // extra force per user-driven refresh, not an unbounded chase.
  readonly isHostFollowUp: boolean;
};

type RefreshMutateAsync = (
  variables: RefreshVariables,
) => Promise<WorktreeListByWorkspacePathsResponse>;

export interface WorktreeWorkspacesRefresh {
  /**
   * Re-derives these folders from disk. Resolves once the host has answered
   * (or rejects, having already toasted). A no-op with no paths in scope.
   */
  readonly refresh: () => Promise<void>;
  readonly isRefreshing: boolean;
  /** When the HOST last derived the facts on screen - see {@link oldestResolvedAt}. */
  readonly checkedAt: number | null;
  /** False with no bound host or no folders: the affordance has nothing to do. */
  readonly canRefresh: boolean;
  /**
   * True when the last user-driven refresh settled with a non-cancelled
   * error. The footer renders "Couldn't verify — Retry" instead of the idle
   * stamp; cleared on the next refresh attempt. Coordinator cancellations
   * (host swap) never set this — but a real failure of the one-hop
   * post-swap force does.
   */
  readonly verifyFailed: boolean;
  /**
   * Monotonic counter bumped at the start of every user-driven `refresh()`
   * (and the one-hop post-swap force). The footer keys its 30s deadline to
   * this so a Retry after timeout starts a fresh deadline rather than
   * inheriting the previous attempt's expired timer.
   */
  readonly refreshGeneration: number;
}

/**
 * The folder-mapping picker's escape hatch from a stale branch label.
 *
 * `worktree.listByWorkspacePaths` is read with `forceRefresh: false`
 * everywhere, and the host's GUI-facing cold-only mode answers such a read
 * from its last-known workspace view even after the TTL expires. An external
 * `git checkout` mutates nothing the host observes, so nothing marks that view
 * dirty and no refetch - however it is triggered - can dislodge the old
 * branch. Only a forced read re-touches disk.
 *
 * The host DOES also watch for external checkouts now
 * (`workspace-freshness-watcher`), and this stays a permanent affordance rather
 * than a stopgap, because that watcher cannot cover everything:
 *  - no filesystem event crosses a network mount or a container boundary,
 *  - watches are demand-driven and LRU-bounded, so the coldest repos of a user
 *    with many folders open are unwatched by design,
 *  - arming can fail (a gitdir mid-rebase, an fd ceiling), and
 *  - pushes only reach a tab bound to the ACTIVE host - `worktree.changed` is
 *    subscribed app-wide, not per bound tab host.
 * A user-driven re-derive is the only recovery that works in all of those.
 */
export function useWorktreeWorkspacesRefresh(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  /**
   * The SAME array the surface handed
   * `useWorktreeListByWorkspacePathsForClient`. The path list is part of the
   * query key, so a re-derived or re-ordered copy would write the response
   * into a key no observer reads and the screen would never move.
   */
  readonly workspacePaths: ReadonlyArray<string>;
  /** The summaries currently on screen, for the "Checked …" stamp. */
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
  // The scope as of the latest COMMIT, for comparison against the scope a
  // completing request captured - see `onSuccess`. Synced in an effect rather
  // than during render (refs are not render state); the comparison happens when
  // a request settles, long after the commit that changed the scope.
  const latestWorkspacePathsRef = useRef(workspacePaths);
  useEffect(() => {
    latestWorkspacePathsRef.current = workspacePaths;
  }, [workspacePaths]);
  // Set once the mutation exists; read only from `onSuccess`, which cannot run
  // before the first commit. Lets a completed force fire ONE follow-up force
  // against a host that changed under it (see `onSuccess`) without the
  // mutation's own options referencing the mutation being declared.
  const mutateAsyncRef = useRef<RefreshMutateAsync | null>(null);
  /**
   * Re-forces against the host that is live NOW, when the one this request
   * started under is gone. Returns whether it fired.
   *
   * A host move cannot be healed by invalidating anything: workspace views are
   * host-local, so the force that just ran taught host A nothing about host B,
   * and B's own `forceRefresh: false` read is answered from ITS cold-only
   * cache - stale, and a refetch re-serves the same stale value. Only a force
   * against B dislodges it.
   *
   * Exactly one hop, bounded by `isHostFollowUp`: the follow-up's own
   * completion cannot spawn another. Swapping hosts repeatedly therefore costs
   * one extra force per user-driven refresh rather than an unbounded chase.
   * It targets whatever host is live at the moment it fires, not the one that
   * displaced A, so the ordinary A -> B -> C case still lands on C. Only a
   * swap DURING the follow-up leaves the newest host un-forced, and that host
   * has its own mount read, the freshness watcher, and Refresh.
   */
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
      // Its own `onError` owns the failure toast; rethrowing here would make
      // the outer mutation reject and toast the SAME failure a second time.
      // A real (non-cancelled) failure of THIS hop must still set the footer
      // failure state — the outer refresh() already returned on CancelledError
      // without marking verifyFailed, so toast-only would leave the footer idle.
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
    // Both fields captured when the mutation actually fires, not read from
    // this render's closures: a host rebind, or a folder added/removed while
    // the forced read is in flight, would otherwise land the response under
    // the wrong host or the wrong path set - `onSuccess` runs whenever it
    // runs, not necessarily against the render that started the request.
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
        // Cancel any cache-only read ALREADY in flight for the key this
        // mutation is about to write. They race: the stacked rows arm forces on
        // mount, so the ordinary `forceRefresh: false` query and this forced
        // one start together, and full params make them separate coordinator
        // jobs. Without this the forced response can land first and the older
        // cache-only response can then settle and overwrite the same key back
        // to the stale view - leaving the label worse than if nothing had
        // refreshed. This is the standard TanStack guard for writing a cache
        // entry from a mutation.
        await queryClient.cancelQueries({
          queryKey: workspacesQueryKey(context.hostId, context.workspacePaths),
        });
        return context;
      },
      onError: async (error, variables, context) => {
        // This - not `onSuccess` - is where a host swap usually lands.
        // `HostClient.bind` snapshots the outgoing host's in-flight jobs and
        // settles them `authority-superseded`, which the GUI boundary
        // normalizes to a TanStack cancellation. So the request never
        // succeeds: without this branch the swap both skips the follow-up
        // force AND toasts "Couldn't refresh folder details." at a user who
        // did nothing wrong but change hosts.
        //
        // Every coordinator control-flow reason arrives this way and none is
        // a failure (superseded, waiter-cancelled, coordinator-disposed), so
        // the whole class is silent.
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
        // Lands in the SAME cache entry the rows render from. Reissuing the
        // query with `forceRefresh: true` in its params instead would fork a
        // second key that no observer reads, so the fresh branch would never
        // reach the screen.
        queryClient.setQueryData<WorktreeListByWorkspacePathsResponse>(
          workspacesQueryKey(context.hostId, context.workspacePaths),
          response,
        );
        // The scope can move while the forced read is in flight, in EITHER
        // coordinate - the paths (a folder added or removed) or the host (the
        // compact landing surface follows the active host, and a rebind can
        // land mid-request).
        //
        // Reaching `onSuccess` at all is the NARROWER host-swap window: the
        // response beat the abort, or the request began after the transition
        // snapshot. The wider one is a cancellation, handled in `onError`.
        // Either way the follow-up carries the branch invalidation for the
        // host now on screen, so returning here avoids invalidating under the
        // host that left.
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
          // Paths moved under the same host: the rows switched to a different
          // key that issued its own `forceRefresh: false` read, which cold-only
          // mode can settle STALE, and the response above landed only in the
          // captured key. The forced derive DID install fresh per-path host
          // entries, so a re-read of the current key pulls them through - no
          // second force needed. AWAITED so a Refresh that reports completion
          // means the folder labels on screen are current, not that they will
          // be shortly.
          await queryClient.invalidateQueries({
            queryKey: workspacesQueryKey(context.hostId, latestPaths),
            refetchType: "active",
          });
        }
        // The branch LIST is a separate cache with its own host-side read, so
        // the summary refresh alone leaves a branch that was deleted outside
        // Traycer sitting in the new-worktree source picker until the list
        // refetches.
        //
        // AWAITED, but `refetchType: "active"` only - and the two halves of
        // that are what D3 got half right. Its concern was real: awaiting
        // INACTIVE entries (the list usually lives in an unmounted nested
        // form) held "Checking…" open across serial relay round-trips nobody
        // was looking at. But the fix it reached for was dropping the await
        // entirely, and an active-only invalidation never fetches an inactive
        // entry in the first place - so the cost D3 avoided was already gone
        // and not awaiting bought nothing for it.
        //
        // What it cost instead was the VISIBLE list. Refresh reported done
        // while the mounted picker still showed cached branches, so the very
        // thing that sends someone to Refresh - a branch deleted outside
        // Traycer - was still on screen and still selectable at the moment the
        // spinner cleared.
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
    // The same condition `canRefresh` advertises, enforced HERE rather than
    // trusted to every call site. Today all of them gate on it, so this changes
    // no behaviour; without it, one future caller that forgets turns an unbound
    // host into a `hostClientUnavailableError` toast on a surface whose own
    // affordance was sitting disabled the whole time.
    if (client === null || workspacePaths.length === 0) return;
    setVerifyFailed(false);
    setRefreshGeneration((generation) => generation + 1);
    try {
      await mutateAsync({
        workspacePaths: [...workspacePaths],
        isHostFollowUp: false,
      });
    } catch (error) {
      // A host swap SUPERSEDES this request rather than failing it, and
      // `onError` has already handed the work to the host now on screen.
      // `mutateAsync` rejects all the same, so without this every caller sees
      // an ordinary host switch as a failed refresh - and the intent-edge
      // callers that fire this without awaiting would raise an unhandled
      // rejection. Real failures still reject, having toasted, and mark the
      // footer failure state so the idle stamp does not silently return.
      // A one-hop force that then fails sets verifyFailed inside
      // `forceAgainstLiveHost` — do not clear it here on CancelledError.
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
