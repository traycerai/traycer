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
 * No surface builds a multi-path key any more: every activity-enriched read
 * caches per path (`useWorktreeEnrichmentForClient`, the Settings overlay) and
 * batches only on the wire. The broad predicate stays broad so a batch that
 * reappears is still folded and still invalidated - see
 * {@link enrichmentQueryPaths} for how the `worktree.changed` choke point
 * treats one.
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
 * what "per-path" means, and what every enrichment key the app builds is. A
 * MULTI-path key is a batch covering all of its paths, so it has no single
 * target: returning its first path made scope-aware invalidation
 * (`invalidate-worktree-changed-caches.ts`) treat the whole batch as an overlay
 * on `activityPaths[0]`, and a change to any other path in it never invalidated
 * the batch at all.
 */
export function perPathEnrichmentQueryPath(key: QueryKey): string | null {
  const params = key[3];
  if (typeof params !== "object" || params === null) return null;
  if (!("activityPaths" in params)) return null;
  const { activityPaths } = params;
  if (!Array.isArray(activityPaths) || activityPaths.length !== 1) return null;
  return typeof activityPaths[0] === "string" ? activityPaths[0] : null;
}

/**
 * Every worktree path an enrichment key covers, or null for a key that is not
 * one (the base list's `activityPaths: null`).
 *
 * Exists for the one question {@link perPathEnrichmentQueryPath} cannot answer
 * about a multi-path batch: does it cover a path a `worktree.changed` frame
 * named? The choke point only MARKS such a batch - refetching it would re-derive
 * every row it covers for one row's change, which is the amplification the
 * per-path cache shape exists to remove.
 */
export function enrichmentQueryPaths(key: QueryKey): readonly string[] | null {
  const params = key[3];
  if (typeof params !== "object" || params === null) return null;
  if (!("activityPaths" in params)) return null;
  const { activityPaths } = params;
  if (!Array.isArray(activityPaths)) return null;
  return activityPaths.filter(
    (path: unknown): path is string => typeof path === "string",
  );
}
