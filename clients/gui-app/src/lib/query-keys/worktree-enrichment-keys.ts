import type { QueryKey } from "@tanstack/react-query";

/**
 * Enrichment `worktree.listAllForHost` keys are those whose `activityPaths` is an array (base list uses `null`).
 * Broader than {@link perPathEnrichmentQueryPath}: a multi-path batch is still an enrichment payload.
 */
export function isPerPathEnrichmentQueryKey(key: QueryKey): boolean {
  const params = key[3];
  if (typeof params !== "object" || params === null) return false;
  if (!("activityPaths" in params)) return false;
  return Array.isArray(params.activityPaths);
}

/** The worktree path a per-path enrichment key targets, or null for any other key under the method scope. */
export function perPathEnrichmentQueryPath(key: QueryKey): string | null {
  const params = key[3];
  if (typeof params !== "object" || params === null) return null;
  if (!("activityPaths" in params)) return null;
  const { activityPaths } = params;
  if (!Array.isArray(activityPaths) || activityPaths.length !== 1) return null;
  return typeof activityPaths[0] === "string" ? activityPaths[0] : null;
}
