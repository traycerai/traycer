import type { QueryClient } from "@tanstack/react-query";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";

// Listed explicitly so binding-mutation success doesn't invalidate
// unrelated caches like `terminal.list` or `agent.list`.
export const WORKTREE_BINDING_INVALIDATIONS: ReadonlyArray<
  keyof HostRpcRegistry & string
> = [
  "worktree.listBindingsForEpic",
  "worktree.listByWorkspacePaths",
  "worktree.getBinding",
  "worktree.listBranches",
];

/** Listing: refetchType active (avoid per-path fan-out). Binding pickers: refetchType all (often unmounted, staleTime Infinity). */
export function invalidateWorktreeListingAndBindingCaches(
  queryClient: QueryClient,
  hostId: string,
): void {
  void queryClient.invalidateQueries({
    queryKey: hostQueryKeys.methodScope(hostId, "worktree.listAllForHost"),
    refetchType: "active",
  });
  for (const method of WORKTREE_BINDING_INVALIDATIONS) {
    void queryClient.invalidateQueries({
      queryKey: hostQueryKeys.methodScope(hostId, method),
      refetchType: "all",
    });
  }
}
