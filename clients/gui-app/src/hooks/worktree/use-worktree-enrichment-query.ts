import { useEffect, useMemo } from "react";
import {
  useQueries,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  WorktreeHostEntryV14,
  WorktreeListAllForHostResponseV14,
} from "@traycer/protocol/host/worktree-schemas";
import {
  createWorktreeEnrichmentBatcherForClient,
  perPathEnrichmentQueryKey,
  perPathEnrichmentQueryOptions,
} from "@/components/settings/panels/worktrees-enrichment-batcher";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import {
  useWorktreeHostListingForClient,
  WORKTREE_HOST_LISTING_PARAMS,
  type WorktreeHostListingRow,
} from "@/hooks/worktree/use-worktree-host-listing";
import { rowsByRequestedPath } from "@/lib/worktree/worktree-path-match";
import {
  subscribeWorktreeChangedCoverageExpired,
  useWorktreeChangedStreamCovered,
} from "@/lib/worktree/worktree-changed-coverage";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";

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

interface WorktreeQuerySuccessOrder {
  orderFor(queryKey: readonly unknown[]): number;
}

const worktreeQuerySuccessOrders = new WeakMap<
  QueryClient,
  WorktreeQuerySuccessOrder
>();

/**
 * TanStack's dataUpdatedAt has millisecond resolution. A selection enabled
 * after an empty listing can succeed within that same millisecond, so compare
 * the cache's successful update edges when their timestamps tie. One tracker
 * per QueryClient serves every mounted worktree consumer.
 */
function worktreeQuerySuccessOrderFor(
  queryClient: QueryClient,
): WorktreeQuerySuccessOrder {
  const existing = worktreeQuerySuccessOrders.get(queryClient);
  if (existing !== undefined) return existing;
  const queryCache = queryClient.getQueryCache();
  const orderByQuery = new WeakMap<object, number>();
  let nextOrder = 0;
  queryCache.subscribe((event) => {
    const queryKey: unknown = event.query.queryKey;
    if (
      event.type !== "updated" ||
      event.action.type !== "success" ||
      !Array.isArray(queryKey) ||
      !hostQueryKeys.matchesMethodOnAnyHost(queryKey, "worktree.listAllForHost")
    )
      return;
    nextOrder += 1;
    orderByQuery.set(event.query, nextOrder);
  });
  const tracker: WorktreeQuerySuccessOrder = {
    orderFor: (queryKey) => {
      const query = queryCache.find({ queryKey, exact: true });
      return query === undefined ? 0 : (orderByQuery.get(query) ?? 0);
    },
  };
  worktreeQuerySuccessOrders.set(queryClient, tracker);
  return tracker;
}

/** One path's selection-mode read, as far as the merge below needs it. */
interface PerPathRead {
  readonly rows: readonly WorktreeHostEntryV14[] | null;
  readonly dataUpdatedAt: number;
  readonly isPending: boolean;
  readonly isFetching: boolean;
  readonly error: HostRpcError | null;
}

type WorktreeActivityRequirement = "none" | "ifMissing" | "always";

interface CoverageExpiryOwnerEntry {
  readonly owner: object;
  count: number;
}

const coverageExpiryOwners = new WeakMap<
  QueryClient,
  Map<string, Map<string, CoverageExpiryOwnerEntry>>
>();

function acquireCoverageExpiryOwner(
  queryClient: QueryClient,
  hostId: string,
  path: string,
): { readonly owner: object; readonly release: () => void } {
  let byHost = coverageExpiryOwners.get(queryClient);
  if (byHost === undefined) {
    byHost = new Map();
    coverageExpiryOwners.set(queryClient, byHost);
  }
  let byPath = byHost.get(hostId);
  if (byPath === undefined) {
    byPath = new Map();
    byHost.set(hostId, byPath);
  }
  let entry = byPath.get(path);
  if (entry === undefined) {
    entry = { owner: {}, count: 0 };
    byPath.set(path, entry);
  }
  entry.count += 1;
  const owner = entry.owner;
  return {
    owner,
    release: () => {
      const current = byPath.get(path);
      if (current === undefined || current.owner !== owner) return;
      current.count -= 1;
      if (current.count === 0) byPath.delete(path);
      if (byPath.size === 0) byHost.delete(hostId);
    },
  };
}

function requiresPerPathActivityRead(
  activityRequirement: WorktreeActivityRequirement,
  streamCovered: boolean,
  listed: readonly WorktreeHostListingRow[],
): boolean {
  return (
    activityRequirement === "always" ||
    (activityRequirement === "ifMissing" &&
      listed.some((row) => row.prState === null)) ||
    !streamCovered ||
    listed.length === 0 ||
    listed.every((row) => row.resolvedAt === null)
  );
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
    dataUpdatedAt: result.dataUpdatedAt,
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

function selectionIsNewerThanListing(args: {
  readonly listedCount: number;
  readonly readAt: number | null;
  readonly listedAt: number | null;
  readonly listingDataUpdatedAt: number;
  readonly selectionDataUpdatedAt: number;
  readonly listingSuccessOrder: number;
  readonly selectionSuccessOrder: number;
}): boolean {
  const {
    listedCount,
    readAt,
    listedAt,
    listingDataUpdatedAt,
    selectionDataUpdatedAt,
    listingSuccessOrder,
    selectionSuccessOrder,
  } = args;
  if (listedCount > 0) {
    return readAt !== null && (listedAt === null || readAt > listedAt);
  }
  return (
    listingDataUpdatedAt === 0 ||
    selectionDataUpdatedAt > listingDataUpdatedAt ||
    (selectionDataUpdatedAt === listingDataUpdatedAt &&
      selectionSuccessOrder > listingSuccessOrder)
  );
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
 * - a path the listing does not name (a recently created binding-sourced
 *   path): accept a selection read only if it succeeded after that listing;
 *   an older cached selection cannot resurrect a removed path;
 * - an older or unwatched host: a selection read still touches stale PR facts
 *   because that host has no subscriber-owned recurring probe.
 * - task/owner metadata with a resolved row whose PR fact was never probed:
 *   one selection read fills the missing activity, including submodules;
 * - a PR-number search: touch every listed path's activity so a current
 *   search does not mistake a stale PR fact for no match.
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
  activityRequirement: WorktreeActivityRequirement,
): WorktreeEnrichment {
  const queryClient = useQueryClient();
  const successOrder = worktreeQuerySuccessOrderFor(queryClient);
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
      // selection path when no replay stream owns PR freshness. A settled
      // listing row already carries cached activity, but a resolved row with
      // a null PR fact may have been derived without an activity probe.
      const needsRead = requiresPerPathActivityRead(
        activityRequirement,
        streamCovered,
        listed,
      );
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
  useEffect(() => {
    const hostId = readiness.hostId;
    if (!queriesEnabled || !listingSettled || hostId === null) return;
    const stopListeners = uniquePaths.flatMap((path) => {
      const listed = listingRowsByPath.get(path) ?? [];
      const selectionEnabledWhileCovered = requiresPerPathActivityRead(
        activityRequirement,
        true,
        listed,
      );
      if (!selectionEnabledWhileCovered) return [];
      const key = perPathEnrichmentQueryKey(hostId, path);
      const owner = acquireCoverageExpiryOwner(queryClient, hostId, path);
      const unsubscribe = subscribeWorktreeChangedCoverageExpired(
        hostId,
        owner.owner,
        () => {
          void queryClient.invalidateQueries({
            queryKey: key,
            exact: true,
            refetchType: "active",
          });
        },
      );
      return [
        () => {
          unsubscribe();
          owner.release();
        },
      ];
    });
    return () => stopListeners.forEach((stop) => stop());
  }, [
    activityRequirement,
    listingRowsByPath,
    listingSettled,
    queriesEnabled,
    queryClient,
    readiness.hostId,
    uniquePaths,
  ]);

  return useMemo<WorktreeEnrichment>(() => {
    if (uniquePaths.length === 0) return EMPTY_ENRICHMENT;
    const worktrees: WorktreeHostEntryV14[] = [];
    const listingSuccessOrder = successOrder.orderFor(
      hostQueryKeys.method<HostRpcRegistry, "worktree.listAllForHost">(
        readiness.hostId,
        "worktree.listAllForHost",
        WORKTREE_HOST_LISTING_PARAMS,
      ),
    );
    uniquePaths.forEach((path, index) => {
      const listed = listingRowsByPath.get(path) ?? [];
      const read = perPath[index]?.rows ?? null;
      if (read === null) {
        worktrees.push(...listed);
        return;
      }
      const readAt = newestResolvedAt(read);
      const listedAt = newestResolvedAt(listed);
      const selectionSuccessOrder = successOrder.orderFor(
        perPathEnrichmentQueryKey(readiness.hostId, path),
      );
      const preferRead = selectionIsNewerThanListing({
        listedCount: listed.length,
        readAt,
        listedAt,
        listingDataUpdatedAt: listing.dataUpdatedAt,
        selectionDataUpdatedAt: perPath[index]?.dataUpdatedAt ?? 0,
        listingSuccessOrder,
        selectionSuccessOrder,
      });
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
    listing.dataUpdatedAt,
    listing.isFetching,
    listing.isPending,
    listingRowsByPath,
    perPath,
    readiness.hostId,
    successOrder,
    uniquePaths,
  ]);
}
