import { useMemo } from "react";
import type { WorktreeHostEntryV12 } from "@traycer/protocol/host/worktree-schemas";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";

const EMPTY_WORKTREES: readonly WorktreeHostEntryV12[] = [];
const EMPTY_BY_EPIC: ReadonlyMap<string, readonly WorktreeHostEntryV12[]> =
  new Map();

export interface TaskWorktreeMetadata {
  readonly worktreesByEpicId: ReadonlyMap<
    string,
    readonly WorktreeHostEntryV12[]
  >;
  readonly isFetching: boolean;
  readonly error: Error | null;
}

export interface WorktreeHostIndex {
  readonly worktrees: readonly WorktreeHostEntryV12[];
  readonly isFetching: boolean;
  readonly error: Error | null;
}

/**
 * The cheap host-wide owner/path index: `worktree.listAllForHost` without
 * activity probes, so `branch`/`worktreePath`/`owners` are populated but the
 * expensive per-worktree probes never run. Shared (same query key) with the
 * base call of `useTaskWorktreeMetadata`.
 */
export function useWorktreeHostIndex(enabled: boolean): WorktreeHostIndex {
  const client = useHostClient();
  const baseQuery = useHostQuery<HostRpcRegistry, "worktree.listAllForHost">({
    cacheKeyIdentity: undefined,
    client,
    method: "worktree.listAllForHost",
    params: {
      includeActivity: false,
      activityPaths: null,
      cursor: null,
      limit: null,
      // A background read: serve the host's TTL-cached view. Only the
      // Settings toolbar's explicit Refresh forces a disk recompute.
      forceRefresh: false,
    },
    options: { enabled },
  });
  return {
    worktrees: baseQuery.data?.worktrees ?? EMPTY_WORKTREES,
    isFetching: baseQuery.isFetching,
    error: baseQuery.error instanceof Error ? baseQuery.error : null,
  };
}

/**
 * Host-wide worktree listing WITH activity enrichment (branch/PR probes) for
 * every worktree on the host. Strictly heavier than `useWorktreeHostIndex` -
 * the host probes each path (TTL-cached server-side) - so callers must gate
 * `enabled` on an actual need, e.g. a PR-number history search that has to
 * resolve "which epic owns PR #N" across all local worktrees.
 */
export function useWorktreeHostActivityIndex(
  enabled: boolean,
): WorktreeHostIndex {
  const client = useHostClient();
  const baseQuery = useWorktreeHostIndex(enabled);
  const activityPaths = useMemo(
    () => baseQuery.worktrees.map((entry) => entry.worktreePath),
    [baseQuery.worktrees],
  );
  const enrichedQuery = useHostQuery<
    HostRpcRegistry,
    "worktree.listAllForHost"
  >({
    cacheKeyIdentity: undefined,
    client,
    method: "worktree.listAllForHost",
    params: {
      includeActivity: true,
      activityPaths,
      cursor: null,
      limit: null,
      // Background read - see `useWorktreeHostIndex`.
      forceRefresh: false,
    },
    options: { enabled: enabled && activityPaths.length > 0 },
  });
  return {
    worktrees: enrichedQuery.data?.worktrees ?? EMPTY_WORKTREES,
    isFetching: baseQuery.isFetching || enrichedQuery.isFetching,
    error:
      baseQuery.error ??
      (enrichedQuery.error instanceof Error ? enrichedQuery.error : null),
  };
}

/**
 * Batches task-history worktree metadata into two host calls: one cheap
 * owner/path index, then one bounded enrichment request for only paths owned by
 * the visible tasks. The expensive branch/PR probes never walk unrelated rows.
 */
export function useTaskWorktreeMetadata(
  epicIds: readonly string[],
): TaskWorktreeMetadata {
  const client = useHostClient();
  const baseQuery = useWorktreeHostIndex(epicIds.length > 0);
  const visibleEpicIds = useMemo(() => new Set(epicIds), [epicIds]);
  const ownedPaths = useMemo(
    () =>
      baseQuery.worktrees.flatMap((entry) =>
        entry.owners.some((owner) => visibleEpicIds.has(owner.epicId))
          ? [entry.worktreePath]
          : [],
      ),
    [baseQuery.worktrees, visibleEpicIds],
  );
  const enrichedQuery = useHostQuery<
    HostRpcRegistry,
    "worktree.listAllForHost"
  >({
    cacheKeyIdentity: undefined,
    client,
    method: "worktree.listAllForHost",
    params: {
      includeActivity: true,
      activityPaths: ownedPaths,
      cursor: null,
      limit: null,
      // Background read - see the base query above.
      forceRefresh: false,
    },
    options: { enabled: ownedPaths.length > 0 },
  });

  const worktreesByEpicId = useMemo(() => {
    const worktrees = enrichedQuery.data?.worktrees;
    if (worktrees === undefined || worktrees.length === 0) return EMPTY_BY_EPIC;
    const byEpic = new Map<string, WorktreeHostEntryV12[]>();
    for (const entry of worktrees) {
      for (const epicId of new Set(entry.owners.map((owner) => owner.epicId))) {
        if (!visibleEpicIds.has(epicId)) continue;
        const current = byEpic.get(epicId);
        if (current === undefined) byEpic.set(epicId, [entry]);
        else current.push(entry);
      }
    }
    return byEpic;
  }, [enrichedQuery.data, visibleEpicIds]);
  return {
    worktreesByEpicId,
    isFetching: baseQuery.isFetching || enrichedQuery.isFetching,
    error:
      baseQuery.error ??
      (enrichedQuery.error instanceof Error ? enrichedQuery.error : null),
  };
}
