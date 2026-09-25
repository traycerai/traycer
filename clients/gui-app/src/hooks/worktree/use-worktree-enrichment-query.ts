import { useMemo } from "react";
import { useQueries, type UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  WorktreeHostEntryV14,
  WorktreeListAllForHostResponseV14,
} from "@traycer/protocol/host/worktree-schemas";
import {
  perPathEnrichmentQueryOptions,
  sharedWorktreeEnrichmentBatcherForClient,
  WORKTREE_BACKGROUND_ENRICHMENT_STALE_MS,
} from "@/components/settings/panels/worktrees-enrichment-batcher";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import type { HostRpcRegistry } from "@/lib/host";

export interface WorktreeEnrichment {
  /** The enriched rows, in `paths` order; a path the host no longer lists has none. */
  readonly worktrees: readonly WorktreeHostEntryV14[];
  /** Any requested path has no answer yet. */
  readonly isPending: boolean;
  readonly isFetching: boolean;
  /** The first path's failure, if any path failed. */
  readonly error: HostRpcError | null;
}

const EMPTY_ENRICHMENT: WorktreeEnrichment = {
  worktrees: [],
  isPending: false,
  isFetching: false,
  error: null,
};

// Module-level so its identity is stable: `useQueries` re-runs `combine`
// whenever the function changes, and structurally shares what it returns, so
// `worktrees` keeps its identity across refetches that land equal rows.
function combineEnrichmentResults(
  results: Array<
    UseQueryResult<WorktreeListAllForHostResponseV14, HostRpcError>
  >,
): WorktreeEnrichment {
  if (results.length === 0) return EMPTY_ENRICHMENT;
  return {
    worktrees: results.flatMap((result) => result.data?.worktrees ?? []),
    isPending: results.some((result) => result.isPending),
    isFetching: results.some((result) => result.isFetching),
    error: results.find((result) => result.error !== null)?.error ?? null,
  };
}

/**
 * Activity-enriched rows for a set of worktree paths, cached PER PATH.
 *
 * This is the Settings ▸ Worktrees overlay's cache shape, shared: each path
 * lives under its own `activityPaths: [path]` key (the same key Settings reads,
 * so a row probed by either surface is warm for the other), while the wire
 * stays batched through the enrichment batcher - up to eight paths per RPC.
 *
 * Why per path and never one multi-path key: a `worktree.changed` frame names
 * ONE row, and a selection-mode read DERIVES on the host (spawns git for any
 * row that needs it). With the whole set under one key, a frame for any row
 * refetched every row - History's 27-row batch turned each frame into 27
 * derives, and a host that published on a derive fed that straight back into
 * itself. Per-path keys make the frame's invalidation
 * (`invalidate-worktree-changed-caches.ts`) re-probe exactly the rows it named,
 * and nothing at all for a row this surface is not showing.
 *
 * Gated like `useHostQuery`: a null client, or a host that cannot execute
 * yet, leaves every query disabled.
 */
export function useWorktreeEnrichmentForClient(
  client: HostClient<HostRpcRegistry> | null,
  paths: readonly string[],
  enabled: boolean,
): WorktreeEnrichment {
  const readiness = useReactiveHostReadiness(client);
  const batcher = useMemo(
    () =>
      client === null ? null : sharedWorktreeEnrichmentBatcherForClient(client),
    [client],
  );
  // One observer per path: a repeated path would be a second observer of the
  // same key, and its rows would be listed twice.
  const uniquePaths = useMemo(() => Array.from(new Set(paths)), [paths]);
  const queriesEnabled = enabled && client !== null && readiness.canExecute;
  return useQueries({
    queries: uniquePaths.map((path) =>
      perPathEnrichmentQueryOptions({
        hostId: readiness.hostId,
        path,
        batcher,
        enabled: queriesEnabled,
        // Longer than the app default: a navigation's remount no longer
        // re-probes every row. A `worktree.changed` frame and Refresh still
        // re-probe at once; a PR fact the host warmed in the background reaches
        // these surfaces on the next remount after this.
        staleTime: WORKTREE_BACKGROUND_ENRICHMENT_STALE_MS,
      }),
    ),
    combine: combineEnrichmentResults,
  });
}
