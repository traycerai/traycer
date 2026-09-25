import { useEffect, useMemo } from "react";
import {
  useQueries,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
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
import {
  useWorktreeHostListingForClient,
  type WorktreeHostListingRow,
} from "@/hooks/worktree/use-worktree-host-listing";
import { rowsByRequestedPath } from "@/lib/worktree/worktree-path-match";
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

/**
 * How often, per host, the background surfaces touch their on-screen rows with
 * a selection-mode read. The host re-probes a PR fact only when such a read
 * touches it (paged reads serve the row cache), so this is what keeps merged
 * and closed PRs moving; the host announces a moved fact with a
 * `worktree.changed` frame, which refetches the listing.
 */
export const WORKTREE_PR_TOUCH_INTERVAL_MS = 5 * 60_000;

const lastPullRequestTouchAtByHost = new Map<string, number>();

/** Test-only: forget every host's last touch. */
export function resetWorktreePullRequestTouchesForTests(): void {
  lastPullRequestTouchAtByHost.clear();
}

/** Test-only: record a touch for `hostId` at `at`, so it is not due. */
export function markWorktreePullRequestTouchedForTests(
  hostId: string,
  at: number,
): void {
  lastPullRequestTouchAtByHost.set(hostId, at);
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
 * Activity-enriched rows for a set of worktree paths.
 *
 * Served from the ONE host-wide listing (`useWorktreeHostListingForClient`):
 * a row the listing has resolved costs no read of its own. Selection-mode
 * reads - cached per path, batched through the host's shared batcher - are
 * spent only where the listing cannot answer:
 *
 * - a row the listing reports UNRESOLVED (`resolvedAt: null`): the host
 *   derives on a selection read only (resolve-on-read), so without one it
 *   would answer the sentinel row forever;
 * - a path the listing does not name (a binding-sourced path outside the
 *   managed walk): read exactly as before this listing existed;
 * - a PR-freshness touch over the requested rows, at most once per
 *   {@link WORKTREE_PR_TOUCH_INTERVAL_MS} per host.
 *
 * Per path, whichever copy - the listing's or a selection read's - resolved
 * more recently is the one shown, so a derive a selection read triggered is
 * not hidden by an older listing, and a frame-driven listing refetch is not
 * hidden by an older selection answer.
 *
 * Gated like `useHostQuery`: a null client, or a host that cannot execute
 * yet, leaves every read disabled.
 */
export function useWorktreeEnrichmentForClient(
  client: HostClient<HostRpcRegistry> | null,
  paths: readonly string[],
  enabled: boolean,
): WorktreeEnrichment {
  const readiness = useReactiveHostReadiness(client);
  const queryClient = useQueryClient();
  const batcher = useMemo(
    () =>
      client === null ? null : sharedWorktreeEnrichmentBatcherForClient(client),
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
      // Read what the listing cannot answer: a row nobody has resolved yet
      // (only a selection read derives it), or a path the listing does not
      // name at all - a binding can name a worktree the managed walk does not
      // enumerate, and a selection read resolves requested paths directly.
      const needsRead =
        listed.length === 0 || listed.every((row) => row.resolvedAt === null);
      return perPathEnrichmentQueryOptions({
        hostId: readiness.hostId,
        path,
        batcher,
        enabled: queriesEnabled && listingSettled && needsRead,
        staleTime: WORKTREE_BACKGROUND_ENRICHMENT_STALE_MS,
      });
    }),
    combine: combinePerPathReads,
  });

  // The PR-freshness touch. An effect because it is exactly an external
  // sync: it asks the host to look again, and whatever it learns lands in the
  // same per-path cache the observers above read.
  const hostId = readiness.hostId;
  useEffect(() => {
    if (!queriesEnabled || !listingSettled || hostId === null) return;
    if (batcher === null) return;
    const listedPaths = uniquePaths.filter(
      (path) => (listingRowsByPath.get(path) ?? []).length > 0,
    );
    if (listedPaths.length === 0) return;
    const now = Date.now();
    const last = lastPullRequestTouchAtByHost.get(hostId);
    if (last !== undefined && now - last < WORKTREE_PR_TOUCH_INTERVAL_MS) {
      return;
    }
    lastPullRequestTouchAtByHost.set(hostId, now);
    for (const path of listedPaths) {
      void queryClient
        .fetchQuery({
          ...perPathEnrichmentQueryOptions({
            hostId,
            path,
            batcher,
            enabled: true,
            staleTime: null,
          }),
          staleTime: 0,
        })
        .catch(() => undefined);
    }
  }, [
    batcher,
    hostId,
    listingRowsByPath,
    listingSettled,
    queriesEnabled,
    queryClient,
    uniquePaths,
  ]);

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
        (readAt !== null && (listedAt === null || readAt >= listedAt));
      worktrees.push(...(preferRead ? read : listed));
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
