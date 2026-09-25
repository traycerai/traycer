import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { isWorktreeChangedStreamOpen } from "@/lib/worktree/worktree-changed-coverage";
import type { HostRpcRegistry } from "@/lib/host";

export type WorktreeHostListingResponse = ResponseOfMethod<
  HostRpcRegistry,
  "worktree.listAllForHost"
>;
export type WorktreeHostListingRow =
  WorktreeHostListingResponse["worktrees"][number];

const EMPTY_ROWS: readonly WorktreeHostListingRow[] = [];

/** The app default, for a host no `worktree.changed` stream is watching. */
export const WORKTREE_HOST_LISTING_UNWATCHED_STALE_MS = 60_000;

/**
 * The ONE whole-host read every worktree surface outside Settings is served
 * from: the host's full listing in paged mode.
 *
 * Paged mode (`activityPaths: null`) never spawns git on the host: it serves
 * each row from the host's row cache - branch, uncommitted count, PR facts,
 * `resolvedAt` - whatever `includeActivity` says, which gates only the two
 * git probes (`lastActivityAt`, `branchStatus`) no background surface renders
 * (and which the protocol refuses to run unpaged). So this cheap read is
 * enough for the index consumers (owner/path index, sweep counts,
 * uncommitted counts, env files) AND for the rows the History, Epic and owner
 * surfaces render, which used to cost one selection-mode read per 8
 * on-screen paths.
 *
 * Never stale by time for a host with an open `worktree.changed` stream. That
 * host tells clients when rows change - a frame for a row or the whole root,
 * and a catch-up frame on every (re)subscribe - and every one of those
 * refetches this key (`invalidate-worktree-changed-caches.ts`), so a remount or
 * a navigation has nothing to learn by asking again. A host with no such
 * stream (an Epic bound to another machine) keeps
 * {@link WORKTREE_HOST_LISTING_UNWATCHED_STALE_MS}.
 *
 * What a paged read does NOT do is derive: a row the host has never resolved
 * answers unresolved (`resolvedAt: null`), and PR facts are re-probed only when
 * a selection-mode read touches them. `useWorktreeEnrichmentForClient` covers
 * both on top of this read.
 */
export const WORKTREE_HOST_LISTING_PARAMS = {
  includeActivity: false,
  activityPaths: null,
  cursor: null,
  limit: null,
  // A background read: serve the host's cached view. Only the Settings
  // toolbar's explicit Refresh forces a disk recompute.
  forceRefresh: false,
};

export interface WorktreeHostListing {
  readonly worktrees: readonly WorktreeHostListingRow[];
  /** Enabled and no answer yet. */
  readonly isPending: boolean;
  /** The host has answered. */
  readonly isSuccess: boolean;
  readonly isFetching: boolean;
  readonly error: Error | null;
}

/**
 * {@link WORKTREE_HOST_LISTING_PARAMS} against a caller-resolved client:
 * worktrees are per HOST, so a surface inside an Epic session passes that
 * session's client.
 */
export function useWorktreeHostListingForClient(
  client: HostClient<HostRpcRegistry> | null,
  enabled: boolean,
): WorktreeHostListing {
  const readiness = useReactiveHostReadiness(client);
  const query = useHostQuery<HostRpcRegistry, "worktree.listAllForHost">({
    cacheKeyIdentity: undefined,
    client,
    method: "worktree.listAllForHost",
    params: WORKTREE_HOST_LISTING_PARAMS,
    options: {
      enabled,
      staleTime: isWorktreeChangedStreamOpen(readiness.hostId)
        ? Infinity
        : WORKTREE_HOST_LISTING_UNWATCHED_STALE_MS,
      refetchOnWindowFocus: false,
    },
  });
  return {
    worktrees: query.data?.worktrees ?? EMPTY_ROWS,
    isPending: enabled && query.isPending,
    isSuccess: query.isSuccess,
    isFetching: query.isFetching,
    error: query.error instanceof Error ? query.error : null,
  };
}
