import { useMemo } from "react";
import { useQueries, type UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  WorktreeHostEntryV14,
  WorktreeListAllForHostResponseV14,
} from "@traycer/protocol/host/worktree-schemas";
import {
  createWorktreeEnrichmentBatcherForClient,
  perPathEnrichmentQueryOptions,
} from "@/components/settings/panels/worktrees-enrichment-batcher";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import {
  useWorktreeHostListingForClient,
  type WorktreeHostListingRow,
} from "@/hooks/worktree/use-worktree-host-listing";
import { rowsByRequestedPath } from "@/lib/worktree/worktree-path-match";
import { useWorktreeChangedStreamCovered } from "@/lib/worktree/worktree-changed-coverage";
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

/** One path's selection-mode read, as far as the merge below needs it. */
interface PerPathRead {
  readonly rows: readonly WorktreeHostEntryV14[] | null;
  readonly isPending: boolean;
  readonly isFetching: boolean;
  readonly error: HostRpcError | null;
}

// Module-level so its identity is stable: `useQueries` re-runs `combine`
// whenever the function changes, and structurally shares what it returns.
function combinePerPathReads(
  results: Array<
    UseQueryResult<WorktreeListAllForHostResponseV14, HostRpcError>
  >,
): readonly PerPathRead[] {
  return results.map((result) => ({
    rows: result.data?.worktrees ?? null,
    isPending: result.isPending && result.fetchStatus === "fetching",
    isFetching: result.isFetching,
    error: result.error,
  }));
}

function newestResolvedAt(rows: readonly { resolvedAt: number | null }[]) {
  let newest: number | null = null;
  for (const row of rows) {
    if (
      row.resolvedAt !== null &&
      (newest === null || row.resolvedAt > newest)
    ) {
      newest = row.resolvedAt;
    }
  }
  return newest;
}

/**
 * A cached selection can know activity facts that a base listing omitted,
 * while the later listing knows current owners, scripts and in-use state.
 * The host leaves `resolvedAt` unchanged when only those base fields move.
 */
function mergeEqualTimestampRows(
  listed: readonly WorktreeHostEntryV14[],
  read: readonly WorktreeHostEntryV14[],
): readonly WorktreeHostEntryV14[] {
  const readByPath = rowsByRequestedPath(
    listed.map((row) => row.worktreePath),
    read,
  );
  return listed.map((listingRow) => {
    const selectionRow = readByPath.get(listingRow.worktreePath)?.[0];
    if (
      selectionRow === undefined ||
      selectionRow.resolvedAt !== listingRow.resolvedAt
    ) {
      return listingRow;
    }
    return {
      ...listingRow,
      lastActivityAt: listingRow.lastActivityAt ?? selectionRow.lastActivityAt,
      branchStatus: listingRow.branchStatus ?? selectionRow.branchStatus,
      ...(listingRow.prState === null
        ? {
            prState: selectionRow.prState,
            prNumber: selectionRow.prNumber,
            prUrl: selectionRow.prUrl,
            mergedHeadShaMatches: selectionRow.mergedHeadShaMatches,
            submodules: selectionRow.submodules,
            atBaseCommit: selectionRow.atBaseCommit,
          }
        : {}),
    };
  });
}

/**
 * Activity-enriched rows for a set of worktree paths.
 *
 * Served from the ONE host-wide listing (`useWorktreeHostListingForClient`):
 * a row the listing has resolved normally costs no read of its own.
 * Selection-mode reads - cached per path, batched through the host's shared
 * batcher - are spent where the listing cannot answer, the caller explicitly
 * needs activity facts, or replay freshness is unavailable:
 *
 * - a row the listing reports UNRESOLVED (`resolvedAt: null`): the host
 *   derives on a selection read only (resolve-on-read), so without one it
 *   would answer the sentinel row forever;
 * - a path the listing does not name (a binding-sourced path outside the
 *   managed walk): read exactly as before this listing existed;
 * - an older or unwatched host: a selection read still touches stale PR facts
 *   because that host has no subscriber-owned recurring probe.
 * - a PR-number search: resolve every listed path's activity so a current
 *   search does not mistake the base listing's unknown PR for no match.
 *
 * Per path, a strictly newer selection derive wins. On a timestamp tie, the
 * listing owns current base fields while an earlier selection may still carry
 * activity facts the base listing omitted.
 *
 * Gated like `useHostQuery`: a null client, or a host that cannot execute
 * yet, leaves every read disabled.
 */
export function useWorktreeEnrichmentForClient(
  client: HostClient<HostRpcRegistry> | null,
  paths: readonly string[],
  enabled: boolean,
  requireActivity: boolean,
): WorktreeEnrichment {
  const readiness = useReactiveHostReadiness(client);
  const streamCovered = useWorktreeChangedStreamCovered(
    enabled && paths.length > 0 ? readiness.hostId : null,
  );
  const batcher = useMemo(
    () =>
      client === null ? null : createWorktreeEnrichmentBatcherForClient(client),
    [client],
  );
  // One observer per path: a repeated path would be a second observer of the
  // same key, and its rows would be listed twice.
  const uniquePaths = useMemo(() => Array.from(new Set(paths)), [paths]);
  const queriesEnabled = enabled && client !== null && readiness.canExecute;
  const listing = useWorktreeHostListingForClient(
    client,
    enabled && uniquePaths.length > 0,
  );
  // Answered either way: a failed listing names no rows, so every path falls
  // back to its own selection read rather than to nothing.
  const listingSettled = !listing.isPending;
  const listingRowsByPath = useMemo(
    () =>
      rowsByRequestedPath<WorktreeHostListingRow>(
        uniquePaths,
        listing.worktrees,
      ),
    [listing.worktrees, uniquePaths],
  );
  const perPath = useQueries({
    queries: uniquePaths.map((path) => {
      const listed = listingRowsByPath.get(path) ?? [];
      // Read what the listing cannot answer, and preserve the old-host
      // selection path when no replay stream owns PR freshness. A deliberate
      // PR-number search needs activity facts even for a resolved base row.
      const needsRead =
        requireActivity ||
        !streamCovered ||
        listed.length === 0 ||
        listed.every((row) => row.resolvedAt === null);
      return perPathEnrichmentQueryOptions({
        hostId: readiness.hostId,
        path,
        batcher,
        enabled: queriesEnabled && listingSettled && needsRead,
        staleTime: null,
      });
    }),
    combine: combinePerPathReads,
  });

  return useMemo<WorktreeEnrichment>(() => {
    if (uniquePaths.length === 0) return EMPTY_ENRICHMENT;
    const worktrees: WorktreeHostEntryV14[] = [];
    uniquePaths.forEach((path, index) => {
      const listed = listingRowsByPath.get(path) ?? [];
      const read = perPath[index]?.rows ?? null;
      if (read === null) {
        worktrees.push(...listed);
        return;
      }
      const readAt = newestResolvedAt(read);
      const listedAt = newestResolvedAt(listed);
      const preferRead =
        listed.length === 0 ||
        (readAt !== null && (listedAt === null || readAt > listedAt));
      let chosen: readonly WorktreeHostEntryV14[] = listed;
      if (preferRead) chosen = read;
      else if (readAt !== null && readAt === listedAt) {
        chosen = mergeEqualTimestampRows(listed, read);
      }
      worktrees.push(...chosen);
    });
    return {
      worktrees,
      isPending: listing.isPending || perPath.some((read) => read.isPending),
      isFetching: listing.isFetching || perPath.some((read) => read.isFetching),
      error:
        listing.error instanceof HostRpcError
          ? listing.error
          : (perPath.find((read) => read.error !== null)?.error ?? null),
    };
  }, [
    listing.error,
    listing.isFetching,
    listing.isPending,
    listingRowsByPath,
    perPath,
    uniquePaths,
  ]);
}
