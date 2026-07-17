import type { QueryClient } from "@tanstack/react-query";
import type { WorktreeChangedScope } from "@traycer/protocol/host/worktree-changed-stream";
import { hostQueryKeys } from "@/lib/query-keys";
import { perPathEnrichmentQueryPath } from "@/lib/query-keys/worktree-enrichment-keys";

/**
 * Drops the host's worktree listing caches after a `worktree.changed` push.
 * Invalidation only - the refetch reads the host's own cache, so this never
 * forces a git resolve.
 *
 * Scope-aware on purpose. A `worktreePath` event says exactly one row moved, so
 * only that row's enrichment overlay is re-probed; invalidating them all would
 * turn one commit into one refetch PER ON-SCREEN ROW. The base listing and the
 * workspace-path queries always go, at any scope: a change can add or remove
 * rows, which no per-path overlay can express, and a worktree path does not map
 * back to the workspace folders that list it.
 */
export function invalidateWorktreeChangedCaches(
  queryClient: QueryClient,
  hostId: string,
  scope: WorktreeChangedScope,
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
      if (scope.kind === "root") return true;
      return path === scope.worktreePath;
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
