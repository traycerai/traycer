import type { QueryClient } from "@tanstack/react-query";
import { hostQueryKeys } from "@/lib/query-keys";
import { perPathEnrichmentQueryPath } from "@/lib/query-keys/worktree-enrichment-keys";
import type { WorktreeChangedAccumulatedScopes } from "@/lib/worktree/worktree-changed-invalidation-scheduler";

/**
 * Drops the host's worktree listing caches for one accumulated burst of
 * `worktree.changed` pushes (see `worktree-changed-invalidation-scheduler`).
 * Invalidation only - the refetch reads the host's own cache, so this never
 * forces a git resolve.
 *
 * Scope-aware on purpose. A `worktreePath` event says exactly one row moved,
 * so only that row's enrichment overlay is re-probed; invalidating them all
 * would turn one commit into one refetch PER ON-SCREEN ROW. The base listing
 * and the workspace-path queries always go, at any scope: a change can add or
 * remove rows, which no per-path overlay can express, and a worktree path
 * does not map back to the workspace folders that list it. Called once per
 * BURST rather than per event: the host's sweep emits one event per
 * re-derived row, and refetching the full base list per row is pure
 * amplification - one trailing refetch renews demand and freshness the same.
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
}
