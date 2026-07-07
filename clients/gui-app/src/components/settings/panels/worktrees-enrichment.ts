import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { WorktreeHostEntryV11 } from "@traycer/protocol/host/index";
import type { WorktreeListAllForHostResponseV11 } from "@traycer/protocol/host/worktree-schemas";
import { type HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import { useWorktreeEnrichSettlePerf } from "@/components/settings/panels/worktrees-settings-perf";

const EMPTY_PATHS: readonly string[] = [];
const EMPTY_ENRICHED: ReadonlyMap<string, WorktreeHostEntryV11> = new Map();
// Coalesce the per-viewport enrichment fetch across a scroll gesture: collect the
// on-screen row paths for this long before firing one batch of per-path activity
// queries for the paths not already cached. One batch per settle window, bounded
// by the viewport - never the whole list.
const WORKTREE_ENRICH_DEBOUNCE_MS = 80;

// A `worktree.listAllForHost` query key is `["host", hostId, method, params]`
// (see `hostQueryKeys.method`). The panel's per-path enrichment queries are the
// only ones whose `activityPaths` is an array (`[path]`); the base list and the
// task-delete whole-list query both pass `activityPaths: null`. Folding ONLY the
// per-path queries keeps the overlay to fully-enriched, on-screen-driven data -
// crucially it EXCLUDES the base list's `includeActivity: false` entries, so an
// un-probed row stays "pending" (absent from the overlay) instead of being
// classified from base-only fields.
function isPerPathEnrichmentQueryKey(key: QueryKey): boolean {
  const params = key[3];
  if (typeof params !== "object" || params === null) return false;
  if (!("activityPaths" in params)) return false;
  return Array.isArray(params.activityPaths);
}

function queryKeyHasPrefix(key: unknown, prefix: readonly unknown[]): boolean {
  if (!Array.isArray(key)) return false;
  return (
    key.length >= prefix.length && prefix.every((part, i) => key[i] === part)
  );
}

function foldEnrichedWorktrees(
  queryClient: QueryClient,
  methodScope: readonly unknown[],
): ReadonlyMap<string, WorktreeHostEntryV11> {
  const entries = queryClient.getQueriesData<WorktreeListAllForHostResponseV11>(
    {
      queryKey: methodScope,
      predicate: (query) => isPerPathEnrichmentQueryKey(query.queryKey),
    },
  );
  const map = new Map<string, WorktreeHostEntryV11>();
  for (const [, data] of entries) {
    if (data === undefined) continue;
    for (const entry of data.worktrees) map.set(entry.worktreePath, entry);
  }
  return map;
}

/**
 * The enrichment overlay, read from the TanStack Query CACHE rather than the live
 * results of the currently-requested window. This is the fix for the P0
 * oscillation: deriving the overlay from only the current window meant a row that
 * enriched to a filtered-out tier lost its overlay entry the instant it left the
 * window, reverted to "pending" (which a tier filter keeps), and re-entered - a
 * self-sustaining 66↔70 flip on the debounce cadence. Reading the cache instead
 * makes the overlay MONOTONIC: an enriched entry survives leaving the window (its
 * query stays cached under `gcTime`), so a dropped row STAYS dropped and the
 * filtered set reaches a fixed point. It also hydrates INSTANTLY on remount from a
 * warm cache, fixing the "second open regresses every row to Checking…" symptom.
 *
 * Subscribes to the QueryCache via `useSyncExternalStore` (compiler-clean external
 * store). `getSnapshot` returns a cached fold and only recomputes when a cache
 * event under this host's `worktree.listAllForHost` method scope fires (or the
 * host changes), so its reference stays stable between events - the discipline
 * `useSyncExternalStore` requires to avoid an infinite render loop.
 */
export function useCachedWorktreeEnrichment(
  queryClient: QueryClient,
  hostId: string | null,
): ReadonlyMap<string, WorktreeHostEntryV11> {
  const methodScope = useMemo(
    () => hostQueryKeys.methodScope(hostId, "worktree.listAllForHost"),
    [hostId],
  );
  // Cached fold + the scope it was folded for, so the snapshot is recomputed on a
  // relevant cache event OR a host change, and is otherwise referentially stable.
  const snapshotRef =
    useRef<ReadonlyMap<string, WorktreeHostEntryV11>>(EMPTY_ENRICHED);
  const snapshotScopeRef = useRef<readonly unknown[] | null>(null);
  const dirtyRef = useRef(true);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const cache = queryClient.getQueryCache();
      return cache.subscribe((event) => {
        // Only QUERY-level events (data added/removed/changed) may change the fold.
        // Observer-level events (`observerResultsUpdated`, `observerAdded`, …) fire
        // on EVERY render of the `useHostQueries` window; dirtying on those would
        // recompute a fresh Map each render and drive `useSyncExternalStore` into an
        // infinite loop.
        if (
          event.type !== "added" &&
          event.type !== "removed" &&
          event.type !== "updated"
        ) {
          return;
        }
        if (queryKeyHasPrefix(event.query.queryKey, methodScope)) {
          dirtyRef.current = true;
          onStoreChange();
        }
      });
    },
    [queryClient, methodScope],
  );
  const getSnapshot = useCallback((): ReadonlyMap<
    string,
    WorktreeHostEntryV11
  > => {
    if (!dirtyRef.current && snapshotScopeRef.current === methodScope) {
      return snapshotRef.current;
    }
    dirtyRef.current = false;
    snapshotScopeRef.current = methodScope;
    snapshotRef.current = foldEnrichedWorktrees(queryClient, methodScope);
    return snapshotRef.current;
  }, [queryClient, methodScope]);

  // Third arg (server snapshot) returns the stable empty map - this is a
  // browser-only SPA, but passing it keeps parity with the app's other
  // `useSyncExternalStore` readers and avoids any hydration edge.
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_ENRICHED);
}

/**
 * Per-viewport lazy enrichment. The base list paints instantly with cheap fields;
 * the expensive activity probes (git ahead/behind/merged, gh PR state, submodule
 * merge facts) are fetched ONLY for the worktree paths currently on screen. Each
 * on-screen path gets its OWN `worktree.listAllForHost {includeActivity: true,
 * activityPaths: [path]}` query, so TanStack Query caches enrichment PER PATH: a
 * path is probed once, and scrolling back to it is a cache hit, never a refetch.
 *
 * The reported on-screen set is debounced into `requestedPaths` (trailing edge),
 * so a fast scroll spins up one batch of per-path queries per settle window, not
 * one per frame; the number of concurrent queries is bounded by the viewport,
 * never the whole list. `useHostQueries` over that window is purely the FETCH
 * DRIVER (mount observers → cold/stale paths fetch, warm paths no-op).
 *
 * The `enrichedByPath` overlay, however, is read from the CACHE via
 * {@link useCachedWorktreeEnrichment}, NOT from the live results - so it persists
 * as rows leave the window and never oscillates under a tier filter. `erroredPaths`
 * stays derived from the live window results (index-aligned with `requestedPaths`):
 * a settled-error path has no cached data, and an errored row that scrolls out and
 * back simply retries.
 *
 * There is no manual "clear" - a refresh invalidates the shared
 * `worktree.listAllForHost` method scope (see `WorktreesBody`), which refetches
 * the active per-path enrichment queries in place; the cache fold then updates.
 */
export function useWorktreeActivityEnrichment(
  client: HostClient<HostRpcRegistry> | null,
  reachable: boolean,
  hostId: string | null,
): {
  readonly enrichedByPath: ReadonlyMap<string, WorktreeHostEntryV11>;
  // Paths whose per-path enrichment query SETTLED to an error (retries exhausted).
  // A path here is distinct from one still in flight: the row must stop reading as
  // progress and fall back to a non-animated "Unknown" pill instead of spinning
  // forever. Kept disjoint from `enrichedByPath` - a later successful refetch moves
  // the path from errored to enriched.
  readonly erroredPaths: ReadonlySet<string>;
  readonly reportVisiblePaths: (paths: readonly string[]) => void;
  readonly enriching: boolean;
} {
  const queryClient = useQueryClient();
  const [requestedPaths, setRequestedPaths] =
    useState<readonly string[]>(EMPTY_PATHS);
  // The debounce coalesces every on-screen report inside one settle window into a
  // single committed `requestedPaths` update (trailing edge), so a fast scroll
  // fires one batch of per-path queries, not one per frame.
  const latestVisibleRef = useRef<readonly string[]>(EMPTY_PATHS);
  const debounceRef = useRef<number | null>(null);
  const reportVisiblePaths = useCallback((paths: readonly string[]) => {
    latestVisibleRef.current = paths;
    // Clear-and-re-arm on EVERY report (true trailing debounce), never gate on
    // "a timer is already pending". The gate variant wedged permanently when
    // React StrictMode's mount setup→cleanup→setup cycle ran the unmount
    // cleanup between two reports on the SAME (surviving) hook instance: the
    // cleanup killed the pending timer, the ref still held its id, and every
    // later report early-returned - no commit ever happened again, so a warm
    // second open never enriched anything (cold first opens escaped only
    // because the list mounts seconds after the body there). Re-arming makes
    // that state unreachable: the worst a stale id can do is clear a dead
    // timer.
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      setRequestedPaths(latestVisibleRef.current);
    }, WORKTREE_ENRICH_DEBOUNCE_MS);
  }, []);
  useEffect(
    () => () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        // Reset the ref, not just the timer: this cleanup also runs in
        // StrictMode's mount effect cycle, where the hook instance (and this
        // ref) survives - a later report must be able to re-arm cleanly.
        debounceRef.current = null;
      }
    },
    [],
  );

  // One enrichment query per on-screen path - the cache identity is the path
  // itself, so each worktree is probed exactly once and cached independently. This
  // only DRIVES fetching; the overlay is read from the cache below.
  const requests = useMemo(
    () =>
      requestedPaths.map((path) => ({
        method: "worktree.listAllForHost" as const,
        params: { includeActivity: true, activityPaths: [path] },
      })),
    [requestedPaths],
  );
  const results = useHostQueries({
    client,
    requests,
    options: { enabled: reachable },
  });

  // Overlay from the cache (monotonic, remount-warm) - NOT from `results`.
  const enrichedByPath = useCachedWorktreeEnrichment(queryClient, hostId);

  // Errored paths ARE derived from the live window results (index-aligned with
  // `requestedPaths`): a settled error has no cached data, so it can't come from
  // the cache fold; it must come from the live query state of the current window.
  const erroredPaths = useMemo(() => {
    const errored = new Set<string>();
    results.forEach((result, index) => {
      if (result.data === undefined && result.isError) {
        errored.add(requestedPaths[index]);
      }
    });
    return errored;
  }, [results, requestedPaths]);

  const enriching = results.some((result) => result.isFetching);
  // Gated perf telemetry for the enrichment leg (invisible before - only the base
  // leg was tracked, so a wholesale enrichment failure left no trace). Emits once
  // per settle window with how many paths were probed and how many errored.
  useWorktreeEnrichSettlePerf({
    fetching: enriching,
    pathCount: requestedPaths.length,
    erroredCount: erroredPaths.size,
  });

  return {
    enrichedByPath,
    erroredPaths,
    reportVisiblePaths,
    enriching,
  };
}
