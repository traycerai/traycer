import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { hostQueryKeys } from "@/lib/query-keys";
import { affectedWorktreeQueryKeys } from "@/hooks/worktree/invalidations";
import {
  enrichmentQueryPaths,
  isPerPathEnrichmentQueryKey,
  perPathEnrichmentQueryPath,
} from "@/lib/query-keys/worktree-enrichment-keys";
import {
  bindingsQueryEpicId,
  isEpicCreateSeedPending,
} from "@/lib/worktree/pending-epic-create-seeds";
import type { WorktreeChangedAccumulatedScopes } from "@/lib/worktree/worktree-changed-invalidation-scheduler";
import { worktreePathMatcher } from "@/lib/worktree/worktree-path-match";

/**
 * Drops the host's worktree listing and binding caches for one accumulated
 * burst of `worktree.changed` pushes (see the invalidation scheduler).
 * Listings read the host's own cache and bindings re-stat their folders;
 * neither forces a git resolve.
 *
 * Scope-aware on purpose, split by what a refetch COSTS the host:
 *
 * - An enrichment key (`activityPaths: [...]`, selection mode) DERIVES on the
 *   host: a read spawns git for every covered row that needs it. So a
 *   `worktreePath` event re-probes only the keys for the rows it names, and
 *   every activity-enriched surface caches one key per path precisely so this
 *   stays one row per named path - History's 27-row page used to be one key,
 *   so every frame re-derived all 27 rows, and a host that published a frame
 *   from a derive rode that edge into a feedback loop. A row no surface is
 *   observing is only MARKED (`refetchType: "active"`), so a frame for a row
 *   off screen re-probes nothing.
 * - The base listing (`activityPaths: null`) never spawns git, and the host
 *   RELIES on path events refetching it: it publishes one exactly when a row
 *   first resolves (Settings' merge gate refuses an overlay while the base row
 *   still reads unresolved) and one per REMOVED row, so a change can add or
 *   remove rows, which no per-path overlay can express. It always goes, at any
 *   scope - once per burst, active observers only.
 *
 * A frame names a path in the host's spelling (the lexical `path.resolve` of
 * the row's path), while a per-path key names whatever the client requested -
 * which for a binding-sourced path may be spelled differently. The two are
 * matched by `worktreePathMatcher`, so such a key still refreshes on its own
 * row's frame.
 *
 * Path pushes refresh keys with matching managed paths, plus imported/local
 * bindings whose path identity is uncertain. Root pushes refresh every active
 * listing: external membership changes and late cold-workspace discovery
 * publish at root scope.
 */
export function invalidateWorktreeChangedCaches(
  queryClient: QueryClient,
  hostId: string,
  scopes: WorktreeChangedAccumulatedScopes,
): void {
  // Capture membership before any refetch replaces the cached rows.
  const affected = scopes.root
    ? null
    : affectedWorktreeQueryKeys(queryClient, hostId, [...scopes.worktreePaths]);
  const isAffected = (key: QueryKey): boolean =>
    affected === null || affected.has(key);
  const listAllScope = hostQueryKeys.methodScope(
    hostId,
    "worktree.listAllForHost",
  );
  const isFramedPath = worktreePathMatcher(scopes.worktreePaths);
  void queryClient.invalidateQueries({
    queryKey: listAllScope,
    refetchType: "active",
    predicate: (query) => {
      if (scopes.root) return true;
      // The base list (and the task-delete whole-list): non-spawning, and row
      // membership may have changed, so it always refetches. That holds for
      // the task-delete walk's `includeActivity: true` too: a paged read
      // (`activityPaths: null`) never derives - the host serves every row,
      // activity facts included, from its row cache, and only selection mode
      // derives - so `includeActivity` there costs a larger page, not git.
      if (!isPerPathEnrichmentQueryKey(query.queryKey)) return true;
      const path = perPathEnrichmentQueryPath(query.queryKey);
      return path !== null && isFramedPath(path);
    },
  });
  // A MULTI-path enrichment key is never refetched by a path event: its read
  // would re-derive every row it covers for one row's change. No surface
  // builds one (every enrichment read caches per path; the census test holds
  // that), so this only guards a batch that reappears - it goes stale and
  // re-reads on its next mount instead of amplifying the burst. A root event
  // already refetched it above.
  if (!scopes.root) {
    void queryClient.invalidateQueries({
      queryKey: listAllScope,
      refetchType: "none",
      predicate: (query) => {
        const paths = enrichmentQueryPaths(query.queryKey);
        return paths !== null && paths.length > 1 && paths.some(isFramedPath);
      },
    });
  }
  void queryClient.invalidateQueries({
    queryKey: hostQueryKeys.methodScope(
      hostId,
      "worktree.listByWorkspacePaths",
    ),
    refetchType: "active",
    predicate: (query) => isAffected(query.queryKey),
  });
  // Re-read the affected owner's disk-derived missing paths; inactive owners
  // remain stale until observed.
  void queryClient.invalidateQueries({
    queryKey: hostQueryKeys.methodScope(hostId, "worktree.getBinding"),
    refetchType: "active",
    predicate: (query) => isAffected(query.queryKey),
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
    predicate: (query) => isAffected(query.queryKey),
  });
  // Binding membership can change even when no cached row names the path.
  // Pending-create seeds stay mark-only until their existing hold is released.
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
