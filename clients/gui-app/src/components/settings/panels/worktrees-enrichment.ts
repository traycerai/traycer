import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  queryOptions,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { WorktreeHostEntryV12 } from "@traycer/protocol/host/index";
import type { WorktreeListAllForHostResponseV12 } from "@traycer/protocol/host/worktree-schemas";
import { type HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { logPerfEvent } from "@/lib/perf/perf-telemetry";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { useWorktreeEnrichSettlePerf } from "@/components/settings/panels/worktrees-settings-perf";

const EMPTY_PATHS: readonly string[] = [];
const EMPTY_ENRICHED: ReadonlyMap<string, WorktreeHostEntryV12> = new Map();
// Coalesce the per-viewport enrichment fetch across a scroll gesture: collect the
// on-screen row paths for this long before firing one batch of per-path activity
// queries for the paths not already cached. One batch per settle window, bounded
// by the viewport. (Off-screen rows are covered separately by the background
// sweep below, in equally bounded chunks - never one whole-list request.)
const WORKTREE_ENRICH_DEBOUNCE_MS = 80;
const WORKTREE_COLD_PR_REFETCH_MAX_ATTEMPTS = 3;
const WORKTREE_COLD_PR_REFETCH_BASE_MS = 750;
// Background sweep: once the visible rows' batch settles, the remaining
// un-enriched rows are probed automatically in chunks of this size, one chunk
// in flight at a time, until every row has resolved - so tier pills and
// filtered counts converge without the user scrolling. Sized under a typical
// viewport batch, so the host never sees more concurrent per-path probes than
// a normal scroll would produce.
const WORKTREE_SWEEP_CHUNK_SIZE = 8;
// Both enrichment legs pin the same generous gcTime, well past TanStack's
// 5-minute default: swept entries have no observers, so under the default they
// would be garbage-collected while the panel sits open - each GC visibly
// regresses its row to "Checking…" and the sweep would re-probe it, a slow,
// pointless churn loop. Refresh (method-scope invalidation) remains the way
// entries are re-probed deliberately.
const WORKTREE_ENRICHMENT_GC_MS = 30 * 60_000;

interface ColdPrRefetchState {
  readonly attempts: number;
  readonly timer: number | null;
}

interface SweepRetryState {
  readonly attempts: number;
  readonly nextEligibleAt: number;
  // True when this entry's budget was already reset for the invalidation the
  // path is CURRENTLY under. `isInvalidated` only clears on a SUCCESSFUL
  // refetch, so without this marker a permanently rejecting path would get a
  // fresh budget on every sweep pass - an unbounded probe spin.
  readonly sawInvalidated: boolean;
}

// The per-path enrichment params, shared by the viewport observers and the
// background sweep so both produce identical query keys - the cache fold and
// TanStack's request dedupe both hinge on that identity.
function perPathEnrichmentParams(path: string) {
  return {
    includeActivity: true,
    activityPaths: [path],
    cursor: null,
    limit: null,
  };
}

// `prState === null` = "not yet probed" (distinct from `"none"` = probed, no
// PR): the host served a stale/cold row and scheduled a background `gh` probe
// whose result never re-emits; only a refetch picks the warmed fact up. A
// SUBMODULE leg counts too - a superproject can be proven `merged` while an
// owned submodule's PR fact is still warming (the detached-submodule shape),
// and one unproven submodule holds the whole row in Review.
function responseHasColdPrState(
  response: WorktreeListAllForHostResponseV12,
): boolean {
  return response.worktrees.some(
    (entry) =>
      entry.prState === null ||
      entry.submodules.some((submodule) => submodule.prState === null),
  );
}

function perPathEnrichmentQueryKey(hostId: string, path: string): QueryKey {
  return hostQueryKeys.method<HostRpcRegistry, "worktree.listAllForHost">(
    hostId,
    "worktree.listAllForHost",
    perPathEnrichmentParams(path),
  );
}

// The sweep's imperative fetch, mirroring the observer leg exactly (same key,
// same request) so the two legs dedupe onto one in-flight query. As in
// `useHostQueriesWithResponseMap`, the client stays OUT of the query key -
// `hostId` already carries the cache identity; the client is transport.
function sweepEnrichmentFetchOptions(
  hostId: string,
  client: HostClient<HostRpcRegistry>,
  path: string,
) {
  const fetcher = () =>
    client.request("worktree.listAllForHost", perPathEnrichmentParams(path));
  return queryOptions({
    queryKey: perPathEnrichmentQueryKey(hostId, path),
    queryFn: fetcher,
    // Sweep candidates are exactly the missing / invalidated / still-cold
    // entries, so this must always hit the network - never be handed back the
    // same cold row the app's 60s default staleTime considers fresh.
    staleTime: 0,
    gcTime: WORKTREE_ENRICHMENT_GC_MS,
  });
}

// Retry gate for one swept path: eligible now, out of budget, or waiting for
// its backoff window.
function sweepRetryGate(
  retry: SweepRetryState | undefined,
  now: number,
):
  | { readonly kind: "eligible" }
  | { readonly kind: "exhausted" }
  | { readonly kind: "waiting"; readonly wakeAt: number } {
  if (retry === undefined) return { kind: "eligible" };
  if (retry.attempts >= WORKTREE_COLD_PR_REFETCH_MAX_ATTEMPTS) {
    return { kind: "exhausted" };
  }
  if (retry.nextEligibleAt > now) {
    return { kind: "waiting", wakeAt: retry.nextEligibleAt };
  }
  return { kind: "eligible" };
}

// A deliberate refresh grants ONE fresh retry budget for a path whose budget
// was already spent. The grant is remembered on the entry because
// `isInvalidated` stays true until a refetch SUCCEEDS - re-granting on every
// pass would let a permanently rejecting path bypass its budget and probe
// forever.
function grantInvalidationBudgetOnce(
  ledger: Map<string, SweepRetryState>,
  path: string,
): void {
  const prior = ledger.get(path);
  if (prior === undefined || prior.sawInvalidated) return;
  ledger.set(path, { attempts: 0, nextEligibleAt: 0, sawInvalidated: true });
}

// Drops ledger entries for paths that left the listing (deleted worktrees):
// a spent budget must not outlive its row - it would permanently skip a path
// that later reappears on the same host, and it inflates `unresolvedCount`.
function pruneSweepLedger(
  ledger: Map<string, SweepRetryState>,
  listedPaths: ReadonlySet<string>,
): void {
  for (const path of ledger.keys()) {
    if (!listedPaths.has(path)) ledger.delete(path);
  }
}

/**
 * Selects the next chunk of paths the background sweep should probe, walking
 * `worktreePaths` in listing order. A path needs a probe when its per-path
 * cache entry is missing, was invalidated by a refresh, or landed with a cold
 * (`prState: null`) leg. Merely time-stale entries are NOT re-swept - steady
 * state stays quiet; refresh invalidation is the deliberate re-probe path.
 * Prunes the ledger as a side effect: settled and de-listed paths drop their
 * bookkeeping, and a fresh invalidation grants a path ONE new retry budget.
 */
function selectSweepChunk(args: {
  readonly queryClient: QueryClient;
  readonly hostId: string;
  readonly worktreePaths: readonly string[];
  readonly viewportPaths: ReadonlySet<string>;
  readonly ledger: Map<string, SweepRetryState>;
  readonly now: number;
}): {
  readonly candidates: readonly string[];
  readonly nextWakeAt: number | null;
} {
  const { queryClient, hostId, worktreePaths, viewportPaths, ledger, now } =
    args;
  pruneSweepLedger(ledger, new Set(worktreePaths));
  const candidates: string[] = [];
  let nextWakeAt: number | null = null;
  for (const path of worktreePaths) {
    if (candidates.length >= WORKTREE_SWEEP_CHUNK_SIZE) break;
    // Paths in the reported window are viewport-owned: their observers fetch
    // them and their cold retries run on the viewport's own ledger.
    if (viewportPaths.has(path)) continue;
    const state = queryClient.getQueryState<WorktreeListAllForHostResponseV12>(
      perPathEnrichmentQueryKey(hostId, path),
    );
    if (state?.fetchStatus === "fetching") continue;
    const needsProbe =
      state?.data === undefined ||
      state.isInvalidated ||
      responseHasColdPrState(state.data);
    if (!needsProbe) {
      ledger.delete(path);
      continue;
    }
    if (state?.isInvalidated === true) {
      grantInvalidationBudgetOnce(ledger, path);
    }
    const gate = sweepRetryGate(ledger.get(path), now);
    if (gate.kind === "exhausted") continue;
    if (gate.kind === "waiting") {
      nextWakeAt =
        nextWakeAt === null ? gate.wakeAt : Math.min(nextWakeAt, gate.wakeAt);
      continue;
    }
    candidates.push(path);
  }
  return { candidates, nextWakeAt };
}

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
): ReadonlyMap<string, WorktreeHostEntryV12> {
  const entries = queryClient.getQueriesData<WorktreeListAllForHostResponseV12>(
    {
      queryKey: methodScope,
      predicate: (query) => isPerPathEnrichmentQueryKey(query.queryKey),
    },
  );
  const map = new Map<string, WorktreeHostEntryV12>();
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
): ReadonlyMap<string, WorktreeHostEntryV12> {
  const methodScope = useMemo(
    () => hostQueryKeys.methodScope(hostId, "worktree.listAllForHost"),
    [hostId],
  );
  // Cached fold + the scope it was folded for, so the snapshot is recomputed on a
  // relevant cache event OR a host change, and is otherwise referentially stable.
  const snapshotRef =
    useRef<ReadonlyMap<string, WorktreeHostEntryV12>>(EMPTY_ENRICHED);
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
    WorktreeHostEntryV12
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
 * on-screen path gets its OWN selection-mode `worktree.listAllForHost`
 * (`includeActivity: true`, `activityPaths: [path]`, `cursor: null`,
 * `limit: null`) query, so TanStack Query caches enrichment PER PATH: a path is
 * probed once, and scrolling back to it is a cache hit, never a refetch.
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
 * The rows the user never scrolls to are NOT left pending: a background sweep
 * walks `worktreePaths` (the full base listing) and imperatively warms the
 * same per-path queries via `queryClient.fetchQuery`, one bounded chunk at a
 * time, holding off whenever the viewport batch is fetching so on-screen rows
 * always win the host's attention. The cache fold picks swept entries up
 * exactly as if they had scrolled into view, so the whole list converges on
 * real tiers on its own.
 *
 * There is no manual "clear" - a refresh invalidates the shared
 * `worktree.listAllForHost` method scope (see `WorktreesBody`), which refetches
 * the active per-path enrichment queries in place; swept (observer-less)
 * entries are only MARKED invalidated by that, and the sweep re-probes them
 * itself in the same bounded chunks - a refresh never fans out the whole list
 * at once.
 */
export function useWorktreeActivityEnrichment(
  client: HostClient<HostRpcRegistry> | null,
  reachable: boolean,
  hostId: string | null,
  // Every worktree path in the base listing, in listing order - the sweep's
  // denominator. The viewport machinery works purely off reported paths.
  worktreePaths: readonly string[],
): {
  readonly enrichedByPath: ReadonlyMap<string, WorktreeHostEntryV12>;
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
        params: perPathEnrichmentParams(path),
      })),
    [requestedPaths],
  );
  const results = useHostQueries({
    client,
    requests,
    options: { enabled: reachable, gcTime: WORKTREE_ENRICHMENT_GC_MS },
  });
  const coldPrRefetchStateRef = useRef<Map<string, ColdPrRefetchState>>(
    new Map(),
  );
  // Cold-PR retry bookkeeping is scoped to the live host connection, so a
  // client/host swap or a reachability drop must RESET it, not just wipe it on
  // unmount: a pending `result.refetch()` would otherwise resume the PREVIOUS
  // scope, and the per-path attempt budget would leak into the next host for
  // the same path. Keying the cleanup on [client, hostId, reachable] clears the
  // timers and the map on every such change (and still on teardown), so each
  // host starts from a clean retry ledger.
  useEffect(
    () => () => {
      for (const state of coldPrRefetchStateRef.current.values()) {
        if (state.timer !== null) window.clearTimeout(state.timer);
      }
      coldPrRefetchStateRef.current.clear();
    },
    [client, hostId, reachable],
  );
  useEffect(() => {
    const activePaths = new Set(requestedPaths);
    for (const [path, state] of coldPrRefetchStateRef.current.entries()) {
      if (activePaths.has(path)) continue;
      if (state.timer !== null) window.clearTimeout(state.timer);
      coldPrRefetchStateRef.current.delete(path);
    }

    results.forEach((result, index) => {
      const path = requestedPaths[index];
      const state = coldPrRefetchStateRef.current.get(path) ?? {
        attempts: 0,
        timer: null,
      };
      // Cold rows (see `responseHasColdPrState`) retry on a bounded budget: the
      // per-path refetch re-probes every leg (superproject AND submodules), so
      // one budget per path covers both.
      const hasColdPrState =
        result.data !== undefined && responseHasColdPrState(result.data);
      if (!hasColdPrState) {
        if (state.timer !== null) window.clearTimeout(state.timer);
        coldPrRefetchStateRef.current.delete(path);
        return;
      }
      if (
        result.isFetching ||
        state.timer !== null ||
        state.attempts >= WORKTREE_COLD_PR_REFETCH_MAX_ATTEMPTS
      ) {
        coldPrRefetchStateRef.current.set(path, state);
        return;
      }

      const nextAttempts = state.attempts + 1;
      const timer = window.setTimeout(() => {
        const latest = coldPrRefetchStateRef.current.get(path);
        if (latest !== undefined) {
          coldPrRefetchStateRef.current.set(path, {
            attempts: latest.attempts,
            timer: null,
          });
        }
        void result.refetch();
      }, WORKTREE_COLD_PR_REFETCH_BASE_MS * nextAttempts);
      coldPrRefetchStateRef.current.set(path, {
        attempts: nextAttempts,
        timer,
      });
    });
  }, [requestedPaths, results]);

  // Overlay from the cache (monotonic, remount-warm) - NOT from `results`.
  const enrichedByPath = useCachedWorktreeEnrichment(queryClient, hostId);

  // ---- Background enrichment sweep ----------------------------------------
  // The viewport drives the rows on screen; the sweep drives everything else.
  // Each pass fetches ONE chunk of paths that still need a probe (no cached
  // data, invalidated by a refresh, or landed cold) through
  // `queryClient.fetchQuery` under the exact per-path keys the observers use,
  // then bumps `sweepTick` on settle to schedule the next chunk. Keys are
  // built from the client's OWN readiness (`readiness.hostId`), mirroring
  // `useHostQueries`, so swept entries land in precisely the scope the fold
  // and the observers read.
  const readiness = useReactiveHostReadiness(client);
  const [sweepTick, bumpSweepTick] = useReducer((tick: number) => tick + 1, 0);
  const sweepLedgerRef = useRef<Map<string, SweepRetryState>>(new Map());
  const sweepInFlightRef = useRef(false);
  const sweepWakeTimerRef = useRef<number | null>(null);
  const sweepStatsRef = useRef({ fetchedCount: 0, drainLogged: true });
  // Same scope-reset rule as the cold-retry ledger above: a client/host swap
  // or reachability drop starts the next scope from a clean sweep ledger. The
  // map is REPLACED (not cleared) so a chunk that settles after the reset can
  // detect it went stale and drop its bookkeeping instead of polluting the new
  // scope's retry budgets.
  useEffect(
    () => () => {
      sweepLedgerRef.current = new Map();
      sweepStatsRef.current = { fetchedCount: 0, drainLogged: true };
      if (sweepWakeTimerRef.current !== null) {
        window.clearTimeout(sweepWakeTimerRef.current);
        sweepWakeTimerRef.current = null;
      }
    },
    [client, hostId, reachable],
  );
  useEffect(() => {
    // `sweepTick` is a pure re-run trigger: chunk completion and backoff
    // wake-ups bump it. `enrichedByPath` doubles as the method-scope cache
    // EVENT feed - the fold recomputes (fresh identity) on any query event
    // under the scope, so an invalidation (refresh) or a GC removal wakes the
    // sweep even when no observer refetch churns `results`.
    void sweepTick;
    void enrichedByPath;
    if (!reachable || client === null || !readiness.isReady) return;
    const sweepHostId = readiness.hostId;
    if (sweepHostId === null) return;
    // One chunk in flight at a time; its settle handler bumps `sweepTick`.
    if (sweepInFlightRef.current) return;
    // Visible rows first: while the viewport batch is fetching, hold the sweep
    // so the on-screen rows always win the host's attention.
    if (results.some((result) => result.isFetching)) return;
    const boundClient = client;
    const ledger = sweepLedgerRef.current;
    const now = Date.now();
    const { candidates, nextWakeAt } = selectSweepChunk({
      queryClient,
      hostId: sweepHostId,
      worktreePaths,
      viewportPaths: new Set(requestedPaths),
      ledger,
      now,
    });
    if (candidates.length === 0) {
      if (nextWakeAt !== null) {
        if (sweepWakeTimerRef.current !== null) {
          window.clearTimeout(sweepWakeTimerRef.current);
        }
        sweepWakeTimerRef.current = window.setTimeout(
          () => {
            sweepWakeTimerRef.current = null;
            bumpSweepTick();
          },
          Math.max(nextWakeAt - now, 0),
        );
      } else if (!sweepStatsRef.current.drainLogged) {
        // Gated aggregate signal mirroring `worktree.enrich_settle` on the
        // viewport leg: how many probes this sweep generation fired, and how
        // many paths stayed cold/errored after their retry budget.
        logPerfEvent("worktree.enrich_sweep", {
          fetchedCount: sweepStatsRef.current.fetchedCount,
          unresolvedCount: ledger.size,
        });
        sweepStatsRef.current = { fetchedCount: 0, drainLogged: true };
      }
      return;
    }
    sweepInFlightRef.current = true;
    sweepStatsRef.current = {
      fetchedCount: sweepStatsRef.current.fetchedCount + candidates.length,
      drainLogged: false,
    };
    void Promise.allSettled(
      candidates.map((path) =>
        queryClient.fetchQuery(
          sweepEnrichmentFetchOptions(sweepHostId, boundClient, path),
        ),
      ),
    ).then((outcomes) => {
      sweepInFlightRef.current = false;
      // Record outcomes only if the scope was NOT reset (host swap /
      // reachability drop) while this chunk was in flight - stale outcomes
      // belong to the old scope's ledger, not the fresh one.
      if (sweepLedgerRef.current === ledger) {
        const settledAt = Date.now();
        outcomes.forEach((outcome, index) => {
          const path = candidates[index];
          const stillCold =
            outcome.status === "rejected" ||
            responseHasColdPrState(outcome.value);
          if (!stillCold) {
            ledger.delete(path);
            return;
          }
          const attempts = (ledger.get(path)?.attempts ?? 0) + 1;
          // `sawInvalidated` mirrors the LIVE flag: a rejected refetch leaves
          // `isInvalidated` set (→ true: this invalidation's one budget grant
          // stays consumed), while a successful-but-cold refetch clears it
          // (→ false: the NEXT refresh may grant a fresh budget again).
          const stateNow =
            queryClient.getQueryState<WorktreeListAllForHostResponseV12>(
              perPathEnrichmentQueryKey(sweepHostId, path),
            );
          ledger.set(path, {
            attempts,
            nextEligibleAt:
              settledAt + WORKTREE_COLD_PR_REFETCH_BASE_MS * attempts,
            sawInvalidated: stateNow?.isInvalidated === true,
          });
        });
      }
      // Bump UNCONDITIONALLY: while this chunk was in flight the effect
      // skipped every re-run, so this is what schedules the next pass - for
      // the fresh scope too, which would otherwise stall until an unrelated
      // cache event.
      bumpSweepTick();
    });
  }, [
    worktreePaths,
    requestedPaths,
    results,
    enrichedByPath,
    client,
    reachable,
    readiness.isReady,
    readiness.hostId,
    queryClient,
    sweepTick,
  ]);

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
