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

/**
 * The shared post-delete invalidation slice: the host-wide worktree listing
 * plus the binding-backed caches, so Settings ▸ Worktrees and the
 * folder/worktree pickers stop showing removed worktrees. Used by both the
 * Settings delete flow and the epic batch-delete cleanup.
 *
 * The listing scope stays `refetchType: "active"`: the enrichment sweep keeps
 * an observer-less per-path cache entry for EVERY worktree, so "all" would
 * refetch the whole list in one concurrent fan-out. "active" refetches the
 * mounted base list / on-screen rows in place and only MARKS the rest
 * invalidated - the sweep re-probes those in bounded chunks while the panel is
 * open, and an invalidated entry refetches on its next observer mount
 * regardless of staleTime.
 *
 * The binding-backed picker scopes keep `refetchType: "all"`: they are often
 * unmounted when a delete runs, the app's query defaults skip
 * refetch-on-focus (and the git picker pins `staleTime: Infinity`), so a
 * plain invalidate would leave them serving the pre-delete binding until they
 * next remounted. Each of these scopes is a handful of small queries, not a
 * per-path fan-out.
 */
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
