/**
 * Path-aware query matching for the file/diff openers. Traycer Host file-tree paths
 * are POSIX-relative to the workspace root (e.g. `src/components/foo.tsx`), but
 * users routinely PASTE an over-qualified path - an absolute path copied from
 * an editor/terminal, or a repo-root-relative path - which carries extra
 * leading segments. A plain substring/subsequence test (and cmdk's
 * command-score) can't match an over-qualified query against the shorter
 * relative candidate, so pasting a path used to find nothing.
 *
 * fzf-style fix: accept a candidate when it is a segment-aligned *trailing
 * sub-path* of the query, in addition to the usual substring match. Any
 * over-qualified paste collapses onto the relative candidate's tail, so the
 * file resolves regardless of how much leading path the user pasted.
 */

/** Trim, lowercase, and POSIX-normalize separators for path matching. */
export function normalizePathQuery(query: string): string {
  return query.trim().toLowerCase().replaceAll("\\", "/");
}

/**
 * A query is "path-like" once it carries a separator. Only then do we apply
 * the trailing-sub-path rescue; a bare word stays a plain substring/fuzzy
 * query so single-token searches keep matching anywhere in the path.
 */
export function isPathLikeQuery(query: string): boolean {
  return query.includes("/") || query.includes("\\");
}

/**
 * Whether a workspace-relative candidate `path` matches `query`. Matches when
 * the candidate contains the (normalized) query as a substring - covering
 * exact, basename, and trailing-fragment typing - OR when the candidate is a
 * segment-aligned trailing sub-path of an over-qualified pasted query. The
 * leading `/` guard keeps the suffix test on segment boundaries so
 * `bar/foo.ts` never matches a paste ending in `…/foobar/foo.ts`.
 */
export function matchesPathQuery(query: string, path: string): boolean {
  const q = normalizePathQuery(query);
  if (q.length === 0) return true;
  const p = path.toLowerCase();
  if (p.includes(q)) return true;
  return `/${q}`.endsWith(`/${p}`);
}
