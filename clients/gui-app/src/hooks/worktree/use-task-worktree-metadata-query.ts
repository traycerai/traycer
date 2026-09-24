import { useMemo } from "react";
import type { WorktreeHostEntryV12 } from "@traycer/protocol/host/worktree-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useWorktreeEnrichmentForClient } from "@/hooks/worktree/use-worktree-enrichment-query";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";

const EMPTY_WORKTREES: readonly WorktreeHostEntryV12[] = [];
const EMPTY_PATHS: readonly string[] = [];
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
  return useWorktreeHostIndexForClient(useHostClient(), enabled);
}

/**
 * {@link useWorktreeHostIndex} against a caller-resolved client. A surface
 * inside an Epic session passes the session's client: worktrees are per HOST,
 * so an Epic projected from host A must not be described by host B's listing.
 */
export function useWorktreeHostIndexForClient(
  client: HostClient<HostRpcRegistry> | null,
  enabled: boolean,
): WorktreeHostIndex {
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
 *
 * Cached per path (see `useWorktreeEnrichmentForClient`), so a
 * `worktree.changed` frame re-probes only the row it names, never the fleet.
 */
export function useWorktreeHostActivityIndex(
  enabled: boolean,
): WorktreeHostIndex {
  const client = useHostClient();
  const baseQuery = useWorktreeHostIndex(enabled);
  // Gated on `enabled` itself, not only passed through: the base index is a
  // key History already fetches, so a disabled observer still reads every
  // host path out of it - and would otherwise mount one idle per-path observer
  // per worktree, serving cached rows (and cached errors) while disabled.
  const activityPaths = useMemo(
    () =>
      enabled
        ? baseQuery.worktrees.map((entry) => entry.worktreePath)
        : EMPTY_PATHS,
    [baseQuery.worktrees, enabled],
  );
  const enrichment = useWorktreeEnrichmentForClient(
    client,
    activityPaths,
    enabled,
  );
  return {
    worktrees: enrichment.worktrees,
    isFetching: baseQuery.isFetching || enrichment.isFetching,
    error: baseQuery.error ?? enrichment.error,
  };
}

/**
 * Task-history worktree metadata from one cheap owner/path index plus the
 * activity enrichment of only the paths owned by the visible tasks. The
 * expensive branch/PR probes never walk unrelated rows, and each owned path is
 * cached on its own (see `useWorktreeEnrichmentForClient`): a
 * `worktree.changed` frame for one row re-probes that row, not the page.
 */
export function useTaskWorktreeMetadata(
  epicIds: readonly string[],
): TaskWorktreeMetadata {
  return useTaskWorktreeMetadataForClient(useHostClient(), epicIds);
}

/**
 * {@link useTaskWorktreeMetadata} against a caller-resolved client - the Epic
 * panel's sweep status row passes the Epic session's client (see
 * {@link useWorktreeHostIndexForClient}); the home history keeps the app-wide
 * wrapper above.
 */
export function useTaskWorktreeMetadataForClient(
  client: HostClient<HostRpcRegistry> | null,
  epicIds: readonly string[],
): TaskWorktreeMetadata {
  const baseQuery = useWorktreeHostIndexForClient(client, epicIds.length > 0);
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
  const enrichment = useWorktreeEnrichmentForClient(client, ownedPaths, true);

  const worktreesByEpicId = useMemo(() => {
    const worktrees = enrichment.worktrees;
    if (worktrees.length === 0) return EMPTY_BY_EPIC;
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
  }, [enrichment.worktrees, visibleEpicIds]);
  return {
    worktreesByEpicId,
    isFetching: baseQuery.isFetching || enrichment.isFetching,
    error: baseQuery.error ?? enrichment.error,
  };
}
