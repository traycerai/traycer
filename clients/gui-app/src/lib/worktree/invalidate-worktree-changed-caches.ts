import type { QueryClient } from "@tanstack/react-query";
import { hostQueryKeys } from "@/lib/query-keys";

/**
 * Drops the host's worktree listing caches after a `worktree.changed` push.
 * Invalidation only - the refetch reads the host's own cache, so this never
 * forces a git resolve.
 */
export function invalidateWorktreeChangedCaches(
  queryClient: QueryClient,
  hostId: string,
): void {
  void queryClient.invalidateQueries({
    queryKey: hostQueryKeys.methodScope(hostId, "worktree.listAllForHost"),
    refetchType: "active",
  });
  void queryClient.invalidateQueries({
    queryKey: hostQueryKeys.methodScope(
      hostId,
      "worktree.listByWorkspacePaths",
    ),
    refetchType: "active",
  });
}
