import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { hostQueryKeys } from "@/lib/query-keys";
import { perPathEnrichmentQueryPath } from "@/lib/query-keys/worktree-enrichment-keys";
import { isEpicCreateSeedPending } from "@/lib/worktree/pending-epic-create-seeds";
import type { WorktreeChangedAccumulatedScopes } from "@/lib/worktree/worktree-changed-invalidation-scheduler";

/**
 * Drops the host's worktree listing caches for one accumulated burst of
 * `worktree.changed` pushes (see `worktree-changed-invalidation-scheduler`).
 * Invalidation only - the refetch reads the host's own cache, so this never
 * forces a git resolve.
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
    predicate: (query) => !isPendingCreateSeedBindingsQuery(query.queryKey),
  });
  void queryClient.invalidateQueries({
    queryKey: bindingsScope,
    refetchType: "none",
    predicate: (query) => isPendingCreateSeedBindingsQuery(query.queryKey),
  });
}

// The binding-list key ends in its params object (`{ epicId }` - see
// `hostQueryKeys.method`); a query belongs to a mid-create epic when that
// epic's landing seed is still marked authoritative.
function isPendingCreateSeedBindingsQuery(queryKey: QueryKey): boolean {
  const params: unknown = queryKey[queryKey.length - 1];
  if (params === null || typeof params !== "object") return false;
  if (!("epicId" in params)) return false;
  const epicId: unknown = params.epicId;
  return typeof epicId === "string" && isEpicCreateSeedPending(epicId);
}
