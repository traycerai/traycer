import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { hostQueryKeys } from "@/lib/query-keys";
import { perPathEnrichmentQueryPath } from "@/lib/query-keys/worktree-enrichment-keys";
import { isEpicCreateSeedPending } from "@/lib/worktree/pending-epic-create-seeds";
import type { WorktreeChangedAccumulatedScopes } from "@/lib/worktree/worktree-changed-invalidation-scheduler";

/**
 * Drops the host's worktree listing caches for one accumulated burst of `worktree.changed` pushes (see `worktree-changed-invalidation-scheduler`).
 * Invalidation only - the refetch reads the host's own cache, so this never forces a git resolve.
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
  // The branch LIST is a separate host-side read, so a summary refresh alone leaves a branch deleted outside Traycer sitting in the new-worktree source picker.
  // `refetchType: "active"` (unlike the manual Refresh, which uses "all"): this path fires on every external git event, and these lists live in nested forms that are usually unmounted - refetching every cached one per event would be the amplification this.
  void queryClient.invalidateQueries({
    queryKey: hostQueryKeys.methodScope(hostId, "worktree.listBranches"),
    refetchType: "active",
  });
  // The epic-scoped binding listing feeds the git-diff / file-tree workspace pickers.
  // Without this scope, a host-push correction (a worktree finishing setup, a cold row re-deriving as a git repo) never reaches those pickers until a remount refetch.
  const bindingsScope = hostQueryKeys.methodScope(
    hostId,
    "worktree.listBindingsForEpic",
  );
  void queryClient.invalidateQueries({
    queryKey: bindingsScope,
    refetchType: "active",
    predicate: (query) => !isPendingCreateSeedBindingsQuery(query.queryKey),
  });
  void queryClient.invalidateQueries({
    queryKey: bindingsScope,
    refetchType: "none",
    predicate: (query) => isPendingCreateSeedBindingsQuery(query.queryKey),
  });
}

// The binding-list key ends in its params object (`{ epicId }` - see `hostQueryKeys.method`); a query belongs to a mid-create epic when that epic's landing seed is still marked authoritative.
function isPendingCreateSeedBindingsQuery(queryKey: QueryKey): boolean {
  const params: unknown = queryKey[queryKey.length - 1];
  if (params === null || typeof params !== "object") return false;
  if (!("epicId" in params)) return false;
  const epicId: unknown = params.epicId;
  return typeof epicId === "string" && isEpicCreateSeedPending(epicId);
}
