import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { hostQueryKeys } from "@/lib/query-keys";
import { perPathEnrichmentQueryPath } from "@/lib/query-keys/worktree-enrichment-keys";
import {
  bindingsQueryEpicId,
  isEpicCreateSeedPending,
} from "@/lib/worktree/pending-epic-create-seeds";
import type { WorktreeChangedAccumulatedScopes } from "@/lib/worktree/worktree-changed-invalidation-scheduler";

/**
 * Drops the host's worktree listing and binding caches for one accumulated
 * burst of `worktree.changed` pushes (see the invalidation scheduler).
 * Listings read the host's own cache and bindings re-stat their folders;
 * neither forces a git resolve.
 *
 * Scope-aware on purpose. A `worktreePath` event says exactly one row moved,
 * so only that row's enrichment overlay is re-probed; invalidating them all
 * would turn one commit into one refetch PER ON-SCREEN ROW. The base listing,
 * the workspace-path queries, and the epic-scoped binding listing always go,
 * at any scope: a change can add or remove rows, which no per-path overlay
 * can express, and a worktree path does not map back to the workspace folders
 * or epics that list it. Called once per BURST rather than per event: the
 * host's sweep emits one event per re-derived row, and refetching the full
 * base list per row is pure amplification - one trailing refetch renews
 * demand and freshness the same.
 */
export function invalidateWorktreeChangedCaches(
  queryClient: QueryClient,
  hostId: string,
  scopes: WorktreeChangedAccumulatedScopes,
): void {
  const listAllScope = hostQueryKeys.methodScope(
    hostId,
    "worktree.listAllForHost",
  );
  void queryClient.invalidateQueries({
    queryKey: listAllScope,
    refetchType: "active",
    predicate: (query) => {
      const path = perPathEnrichmentQueryPath(query.queryKey);
      // Not an enrichment overlay (the base list, task-delete whole-list): row
      // membership may have changed, so it always refetches.
      if (path === null) return true;
      if (scopes.root) return true;
      return scopes.worktreePaths.has(path);
    },
  });
  void queryClient.invalidateQueries({
    queryKey: hostQueryKeys.methodScope(
      hostId,
      "worktree.listByWorkspacePaths",
    ),
    refetchType: "active",
  });
  // The chat's folder warning reads the owner's binding, not Sweep's host-wide
  // inventory. Re-read its disk-derived missing paths on the same burst so a
  // deleted or restored folder is reflected before the next send/focus. Path
  // events carry run directories, not owner ids, so refresh active bindings on
  // this host at either scope; inactive bindings only need marking stale.
  void queryClient.invalidateQueries({
    queryKey: hostQueryKeys.methodScope(hostId, "worktree.getBinding"),
    refetchType: "active",
  });
  // The branch LIST is a separate host-side read, so a summary refresh alone
  // leaves a branch deleted outside Traycer sitting in the new-worktree source
  // picker. `refetchType: "active"` (unlike the manual Refresh, which uses
  // "all"): this path fires on every external git event, and these lists live
  // in nested forms that are usually unmounted - refetching every cached one
  // per event would be the amplification this whole module exists to avoid.
  // Inactive lists are still MARKED invalidated, and the app leaves
  // `refetchOnMount` at its default, so they re-read the moment they mount.
  void queryClient.invalidateQueries({
    queryKey: hostQueryKeys.methodScope(hostId, "worktree.listBranches"),
    refetchType: "active",
  });
  // The epic-scoped binding listing feeds the git-diff / file-tree workspace
  // pickers. Without this scope, a host-push correction (a worktree finishing
  // setup, a cold row re-deriving as a git repo) never reaches those pickers
  // until a remount refetch. Invalidated at EVERY scope on purpose:
  // worktreePath events carry selector-visible changes too (a branch switch
  // re-derives the row), so gating on root scope would regress live branch
  // labels. `refetchType: "active"` refetches the open epic's mounted
  // pickers now and only MARKS other epics' cached queries invalidated -
  // they refetch on their next mount regardless of staleTime.
  //
  // Mid-create epics are the exception: their landing-flow optimistic seed
  // is still authoritative and a refetch could return pre-binding
  // `{ rows: [] }` and clobber it, so they are marked without an active
  // refetch and converge once the create settles.
  const bindingsScope = hostQueryKeys.methodScope(
    hostId,
    "worktree.listBindingsForEpic",
  );
  void queryClient.invalidateQueries({
    queryKey: bindingsScope,
    refetchType: "active",
    predicate: (query) =>
      !isPendingCreateSeedBindingsQuery(hostId, query.queryKey),
  });
  void queryClient.invalidateQueries({
    queryKey: bindingsScope,
    refetchType: "none",
    predicate: (query) =>
      isPendingCreateSeedBindingsQuery(hostId, query.queryKey),
  });
}

// The binding-list key ends in its params object (`{ epicId }` - see
// `hostQueryKeys.method`); a query belongs to a mid-create epic when that
// epic's landing seed is still marked authoritative ON THIS HOST.
//
// The host segment is not decoration. A DEFERRED create's mark outlives the
// response for the whole provisioning hold, so a host-blind read would
// downgrade another host's listing of the same epic to mark-only for up to
// `EPIC_CREATE_SEED_HOLD_TIMEOUT_MS`, where before the hold the same blindness
// lasted one round trip. `hostId` here is the burst's own host, which is also
// the host segment of every key in this scope.
function isPendingCreateSeedBindingsQuery(
  hostId: string,
  queryKey: QueryKey,
): boolean {
  const epicId = bindingsQueryEpicId(queryKey);
  return epicId !== null && isEpicCreateSeedPending(hostId, epicId);
}
