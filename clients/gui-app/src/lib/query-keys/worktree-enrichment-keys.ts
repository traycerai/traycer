import type { QueryKey } from "@tanstack/react-query";

/**
 * Per-path enrichment queries are the only `worktree.listAllForHost` keys whose
 * `activityPaths` is an array (`[path]`); the base list and the task-delete
 * whole-list query both pass `activityPaths: null`. Telling them apart matters
 * wherever the overlay is folded or invalidated: the base list's
 * `includeActivity: false` rows must stay OUT of the overlay, so an un-probed
 * row reads as "pending" rather than being classified from base-only fields.
 */
export function isPerPathEnrichmentQueryKey(key: QueryKey): boolean {
  const params = key[3];
  if (typeof params !== "object" || params === null) return false;
  if (!("activityPaths" in params)) return false;
  return Array.isArray(params.activityPaths);
}

/**
 * The worktree path a per-path enrichment key targets (`activityPaths[0]`), or
 * null for any other key under the method scope.
 */
export function perPathEnrichmentQueryPath(key: QueryKey): string | null {
  const params = key[3];
  if (typeof params !== "object" || params === null) return null;
  if (!("activityPaths" in params)) return null;
  const { activityPaths } = params;
  return Array.isArray(activityPaths) && typeof activityPaths[0] === "string"
    ? activityPaths[0]
    : null;
}
