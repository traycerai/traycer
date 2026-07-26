import type { QueryKey } from "@tanstack/react-query";

/**
 * Enrichment queries are the only `worktree.listAllForHost` keys whose
 * `activityPaths` is an array; the base list and the task-delete whole-list
 * query both pass `activityPaths: null`. Telling them apart matters wherever
 * the overlay is folded or invalidated: the base list's `includeActivity:
 * false` rows must stay OUT of the overlay, so an un-probed row reads as
 * "pending" rather than being classified from base-only fields.
 *
 * Deliberately broader than {@link perPathEnrichmentQueryPath}, which requires
 * exactly one path. This predicate answers "is this an enrichment payload" -
 * true of a multi-path batch too, whose rows are the same resolved shape and
 * are as foldable into the Settings overlay as any single-path one. The path
 * accessor answers "which single row does this key stand for", which a batch
 * cannot: see its doc for the invalidation bug that conflating the two caused.
 *
 * **Freshness note - recorded, not a defect.** The batches this now admits do
 * not all share the Settings panel's caching. Settings pins its listing to
 * `staleTime: Infinity` (manual Refresh only), whereas the sidebar's row-2
 * batch takes the app-wide 60s default from `query-client.ts`, so a row folded
 * from that batch can refresh on a cadence the Settings panel never would.
 * Likewise, a multi-path key has no single target, so scope-aware invalidation
 * falls through to the "row membership may have changed" branch and refetches
 * once per accumulated burst rather than per path.
 *
 * Neither is introduced here: this predicate's body is unchanged, and other
 * consumers already emitted multi-path keys before the sidebar batch existed.
 * The sidebar simply widened an exposure that was always reachable. Written
 * down so the next reader does not re-derive it and mistake it for a
 * regression.
 */
export function isPerPathEnrichmentQueryKey(key: QueryKey): boolean {
  const params = key[3];
  if (typeof params !== "object" || params === null) return false;
  if (!("activityPaths" in params)) return false;
  return Array.isArray(params.activityPaths);
}

/**
 * The worktree path a per-path enrichment key targets, or null for any other
 * key under the method scope.
 *
 * A key qualifies only when `activityPaths` holds EXACTLY ONE path - which is
 * what "per-path" means, and what the Settings panel's keys always are. A
 * MULTI-path key is a batch covering all of its paths, so it has no single
 * target: returning its first path made scope-aware invalidation
 * (`invalidate-worktree-changed-caches.ts`) treat the whole batch as an overlay
 * on `activityPaths[0]`, and a change to any other path in it never invalidated
 * the batch at all. Three batches were affected - the sidebar row-2 batch,
 * `useTaskWorktreeMetadata`, and `useWorktreeOwnerMetadata` - all of which now
 * fall through to the "row membership may have changed" branch and refetch once
 * per accumulated burst, which is what the scheduler already bounds them to.
 */
export function perPathEnrichmentQueryPath(key: QueryKey): string | null {
  const params = key[3];
  if (typeof params !== "object" || params === null) return null;
  if (!("activityPaths" in params)) return null;
  const { activityPaths } = params;
  if (!Array.isArray(activityPaths) || activityPaths.length !== 1) return null;
  return typeof activityPaths[0] === "string" ? activityPaths[0] : null;
}
