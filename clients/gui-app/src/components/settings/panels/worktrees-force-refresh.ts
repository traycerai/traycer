/**
 * The `forceRefresh` fetch directive for `worktree.listAllForHost`.
 *
 * `forceRefresh` tells the host to bypass its minutes-scale TTL cache and
 * recompute from disk. It is a FETCH DIRECTIVE, not cache identity: a forced
 * response describes exactly the same resource as an unforced one, so it is
 * deliberately kept OUT of every TanStack query key. The keys are built from
 * the poll-shaped params (which pin `forceRefresh: false`); only the request
 * varies. Were the directive in the key, a forced fetch would populate a
 * SEPARATE cache entry and the view - which reads the unforced key - would
 * never show the refreshed data.
 *
 * So the refresh marks its host for the duration of the invalidation it
 * awaits. Every fetch that starts inside that window - the base listing's
 * pages and each on-screen path's enrichment query, all of which the one
 * `invalidateQueries` refetches - sends `forceRefresh: true` and lands in its
 * NORMAL key. Poll- and background-driven fetches outside the window send
 * `false`, preserving cached-read behavior.
 *
 * Module state rather than context: the flag is read inside `queryFn`s that
 * are not React-rendered, and it is transient (always cleared in `finally`,
 * including when the refresh throws), so there is nothing to subscribe to.
 */
const forcedHostIds = new Set<string>();

/** Whether a user-initiated refresh is currently in flight for `hostId`. */
export function isWorktreeForceRefreshing(hostId: string | null): boolean {
  return hostId !== null && forcedHostIds.has(hostId);
}

/**
 * Marks `hostId` as force-refreshing for the duration of `refresh`, so every
 * `worktree.listAllForHost` fetch it triggers bypasses the host's TTL cache.
 * A fetch that merely overlaps the window (e.g. a poll landing mid-refresh)
 * also forces - harmless, and it is inside a window the user asked for.
 */
export async function withWorktreeForceRefresh<T>(
  hostId: string,
  refresh: () => Promise<T>,
): Promise<T> {
  forcedHostIds.add(hostId);
  try {
    return await refresh();
  } finally {
    forcedHostIds.delete(hostId);
  }
}
