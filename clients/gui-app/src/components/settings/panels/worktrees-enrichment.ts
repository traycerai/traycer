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
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { withHostRpcErrorBoundary } from "@traycer-clients/shared/host-transport/host-messenger";
import type { WorktreeHostEntryV14 } from "@traycer/protocol/host/index";
import type { WorktreeListAllForHostResponseV14 } from "@traycer/protocol/host/worktree-schemas";
import { type HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  isPerPathEnrichmentQueryKey,
  perPathEnrichmentQueryPath,
} from "@/lib/query-keys/worktree-enrichment-keys";
import { logPerfEvent } from "@/lib/perf/perf-telemetry";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import {
  createWorktreeEnrichmentBatcher,
  keepResolvedEnrichmentRows,
  perPathEnrichmentQueryKey,
  useBatchedEnrichmentQueries,
  WORKTREE_ENRICHMENT_GC_MS,
  type WorktreeEnrichmentBatcher,
} from "@/components/settings/panels/worktrees-enrichment-batcher";
import { useWorktreeEnrichSettlePerf } from "@/components/settings/panels/worktrees-settings-perf";
import {
  persistWorktreeActivitySnapshot,
  pruneWorktreeSnapshots,
  readWorktreeActivitySnapshot,
} from "@/components/settings/panels/worktrees-enrichment-persistence";

const EMPTY_PATHS: readonly string[] = [];
const EMPTY_ENRICHED: ReadonlyMap<string, WorktreeHostEntryV14> = new Map();
const EMPTY_SEEDED: ReadonlySet<string> = new Set();
const EMPTY_ERRORED: ReadonlySet<string> = new Set();
// The boundary between snapshot-seeded and live cache data: the warm-open
// restore seeds queries with their snapshot-era `updatedAt` (always a PREVIOUS
// run - the writer stamps wall-clock time and restore skips paths with live
// data), while every fetch this session stamps a fresh `dataUpdatedAt`. So
// "this entry is still the seed" is exactly "its dataUpdatedAt predates this
// module's load".
const APP_SESSION_START_MS = Date.now();
// Coalesce the per-viewport enrichment fetch across a scroll gesture: collect the
// on-screen row paths for this long before firing one batch of per-path activity
// queries for the paths not already cached. One batch per settle window, bounded
// by the viewport. (Off-screen rows are covered separately by the background
// sweep below, in equally bounded chunks - never one whole-list request.)
const WORKTREE_ENRICH_DEBOUNCE_MS = 80;
// Cold-row (`prState: null`) retry schedule, shared by the viewport ledger and
// the sweep ledger: exponential backoff from the base, capped per-wait, with a
// generous total budget (~2 minutes of patience). The host serves a cold row
// and warms its PR fact through a BACKGROUND `gh` probe whose result only a
// refetch picks up - and on a busy fleet those probes take tens of seconds to
// drain (field-observed enrichment settles of 45-80s), so a short budget
// abandons rows as permanently "Checking…" long before the host ever answers.
// `null` always means probe-pending (a settled no-PR answer is `"none"`), so
// patience is what converges; the cap + budget still bound a pathological
// host, and a refresh re-grants one budget as before.
const WORKTREE_COLD_PR_REFETCH_MAX_ATTEMPTS = 10;
const WORKTREE_COLD_PR_REFETCH_BASE_MS = 750;
const WORKTREE_COLD_PR_REFETCH_MAX_DELAY_MS = 20_000;

// Wait before retry number `attempts` (1-indexed): 750ms, 1.5s, 3s, 6s, 12s,
// then 20s flat - front-loaded for hosts that warm quickly, patient for the
// fleet-under-load tail.
function coldRetryDelayMs(attempts: number): number {
  return Math.min(
    WORKTREE_COLD_PR_REFETCH_BASE_MS * 2 ** (attempts - 1),
    WORKTREE_COLD_PR_REFETCH_MAX_DELAY_MS,
  );
}
// Background sweep: once the visible rows' batch settles, the remaining
// un-enriched rows are probed automatically in chunks of this size, one chunk
// in flight at a time, until every row has resolved - so tier pills and
// filtered counts converge without the user scrolling. Sized under a typical
// viewport batch, so the host never sees more concurrent per-path probes than
// a normal scroll would produce.
const WORKTREE_SWEEP_CHUNK_SIZE = 8;
// Debounce for the warm-open snapshot writes: the cache fold's identity
// changes on every relevant cache event (each settled probe), so writes wait
// for a quiet window instead of serializing the fleet once per chunk while
// the sweep converges.
const WORKTREE_ACTIVITY_PERSIST_DEBOUNCE_MS = 1_500;

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

// `prState === null` = "not yet probed" (distinct from `"none"` = probed, no
// PR): the host served a stale/cold row and scheduled a background `gh` probe
// whose result never re-emits; only a refetch picks the warmed fact up. A
// SUBMODULE leg counts too - a superproject can be proven `merged` while an
// owned submodule's PR fact is still warming (the detached-submodule shape),
// and one unproven submodule holds the whole row in Review.
function responseHasColdPrState(
  response: WorktreeListAllForHostResponseV14,
): boolean {
  return response.worktrees.some(
    (entry) =>
      entry.prState === null ||
      entry.submodules.some((submodule) => submodule.prState === null),
  );
}

// The sweep's imperative fetch, mirroring the observer leg exactly (same key,
// same batched transport) so the two legs dedupe onto one in-flight query.
// The client stays OUT of the query key - `hostId` already carries the cache
// identity; the batcher is transport.
function sweepEnrichmentFetchOptions(
  hostId: string,
  batcher: WorktreeEnrichmentBatcher,
  path: string,
) {
  // Rejections carry the `HostRpcError` shape the observer leg declares: the
  // batcher wraps its wire call in the host-rpc error boundary. The batcher
  // stays out of the query key (it is transport, like the client before it).
  const fetcher = () => batcher.fetchPath(path);
  return queryOptions({
    queryKey: perPathEnrichmentQueryKey(hostId, path),
    queryFn: fetcher,
    // Sweep candidates are exactly the missing / invalidated / still-cold
    // entries, so this must always hit the network - never be handed back
    // the same cold row a nonzero staleTime would consider fresh.
    staleTime: 0,
    gcTime: WORKTREE_ENRICHMENT_GC_MS,
    structuralSharing: keepResolvedEnrichmentRows,
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
    const state = queryClient.getQueryState<WorktreeListAllForHostResponseV14>(
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
function queryKeyHasPrefix(key: unknown, prefix: readonly unknown[]): boolean {
  if (!Array.isArray(key)) return false;
  return (
    key.length >= prefix.length && prefix.every((part, i) => key[i] === part)
  );
}

function foldEnrichedWorktrees(
  queryClient: QueryClient,
  methodScope: readonly unknown[],
): ReadonlyMap<string, WorktreeHostEntryV14> {
  const entries = queryClient.getQueriesData<WorktreeListAllForHostResponseV14>(
    {
      queryKey: methodScope,
      predicate: (query) => isPerPathEnrichmentQueryKey(query.queryKey),
    },
  );
  const map = new Map<string, WorktreeHostEntryV14>();
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
): ReadonlyMap<string, WorktreeHostEntryV14> {
  const methodScope = useMemo(
    () => hostQueryKeys.methodScope(hostId, "worktree.listAllForHost"),
    [hostId],
  );
  // Cached fold + the scope it was folded for, so the snapshot is recomputed on a
  // relevant cache event OR a host change, and is otherwise referentially stable.
  const snapshotRef =
    useRef<ReadonlyMap<string, WorktreeHostEntryV14>>(EMPTY_ENRICHED);
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
        // Within `updated`, only DATA-bearing actions can change the fold:
        // `success` (a fetch landing or `setQueryData`) and `setState` (raw
        // state replacement). Fetch-starts, invalidation marks, errors, and
        // pause/continue all fire `updated` too - during a convergence pass
        // that is 2+ events per probe across the whole fleet, and each one
        // used to force a fresh fold identity and a full list re-render (the
        // 100-450ms main-thread blocks the perf log calls
        // `main_thread_block`).
        if (
          event.type === "updated" &&
          event.action.type !== "success" &&
          event.action.type !== "setState"
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
    WorktreeHostEntryV14
  > => {
    if (!dirtyRef.current && snapshotScopeRef.current === methodScope) {
      return snapshotRef.current;
    }
    dirtyRef.current = false;
    snapshotScopeRef.current = methodScope;
    const next = foldEnrichedWorktrees(queryClient, methodScope);
    // Keep the PREVIOUS identity when the refold is content-identical (same
    // paths, same entry references - structural sharing preserves an entry's
    // identity across a refetch that lands equal data, the common case for
    // re-probes and refreshes on a quiet fleet). Every distinct identity here
    // fans out through the panel into a full list re-render - 100-450ms on a
    // 50-row fleet - so identity is only allowed to change when a row's data
    // actually did.
    const prev = snapshotRef.current;
    const identical =
      prev.size === next.size &&
      [...next].every(([path, entry]) => prev.get(path) === entry);
    if (!identical) snapshotRef.current = next;
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
 * on-screen path gets its OWN selection-mode `worktree.listAllForHost` query
 * (keyed on `activityPaths: [path]`), so TanStack Query caches enrichment PER
 * PATH: a path is probed once, and scrolling back to it is a cache hit, never a
 * refetch. The WIRE is batched underneath: per-path fetches coalesce through
 * {@link createWorktreeEnrichmentBatcher} into chunked `activityPaths` RPCs, so
 * cache granularity stays per-path while dial count is ~paths/8.
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
  readonly enrichedByPath: ReadonlyMap<string, WorktreeHostEntryV14>;
  // Paths whose per-path enrichment query SETTLED to an error (retries exhausted).
  // A path here is distinct from one still in flight: the row must stop reading as
  // progress and fall back to a non-animated "Unknown" pill instead of spinning
  // forever. Kept disjoint from `enrichedByPath` - a later successful refetch moves
  // the path from errored to enriched.
  readonly erroredPaths: ReadonlySet<string>;
  // Paths whose overlay entry is still the restored warm-open seed - display
  // data only. Delete surfaces treat these as not-yet-verified ("pending")
  // until a live probe replaces the seed.
  readonly seededPaths: ReadonlySet<string>;
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

  // The shared wire transport for BOTH enrichment legs: per-path fetches
  // coalesce into chunked `activityPaths` RPCs (see the batcher's doc), so an
  // N-row open or refresh costs ~N/8 dials instead of N. Keyed on the bound
  // client alone - host identity lives in the query keys.
  const readiness = useReactiveHostReadiness(client);
  const batcher = useMemo(
    () =>
      client === null
        ? null
        : createWorktreeEnrichmentBatcher((paths) =>
            withHostRpcErrorBoundary("worktree.listAllForHost", () =>
              client.request("worktree.listAllForHost", {
                includeActivity: true,
                activityPaths: [...paths],
                cursor: null,
                limit: null,
                forceRefresh: false,
              }),
            ),
          ),
    [client],
  );
  // One enrichment query per on-screen path - the cache identity is the path
  // itself, so each worktree is probed exactly once and cached independently.
  // This only DRIVES fetching; the overlay is read from the cache below.
  const results = useBatchedEnrichmentQueries({
    hostId: readiness.hostId,
    paths: requestedPaths,
    batcher,
    enabled: reachable && client !== null && readiness.isReady,
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
      }, coldRetryDelayMs(nextAttempts));
      coldPrRefetchStateRef.current.set(path, {
        attempts: nextAttempts,
        timer,
      });
    });
  }, [requestedPaths, results]);

  // Overlay from the cache (monotonic, remount-warm) - NOT from `results`.
  const enrichedByPath = useCachedWorktreeEnrichment(queryClient, hostId);

  // ---- Warm-open restore (persisted last-known tiers) ----------------------
  // The query cache is renderer-memory only, so an app relaunch used to open
  // the panel fully cold: every row at "Checking…" until its probe resolved.
  // The last run's snapshot (see worktrees-enrichment-persistence.ts) is
  // seeded back into the per-path queries on the first open per host - keyed
  // by the PASSED hostId (the same scope the cache fold reads), so last-known
  // tiers render even while the host is still dialing. Seeded queries are
  // then marked invalidated WITHOUT refetching: viewport observers refetch
  // them on mount, and the sweep treats `isInvalidated` as needs-probe - so
  // every restored row revalidates through the existing bounded machinery,
  // never a whole-list fan-out. Live truth always wins: paths with live data
  // are never overwritten, and a restored entry is replaced the moment its
  // revalidation lands. (Seeded, observer-less entries carry TanStack's
  // default 5-minute gcTime until the sweep re-fetches them under the pinned
  // 30-minute gcTime - on an unreachable host they eventually regress to
  // "Checking…", which is honest for data that can't be revalidated.)
  const restoredHostsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (hostId === null) return;
    // Once per host per app session: afterwards the live cache is the richer
    // source and re-seeding would only churn cache events.
    if (restoredHostsRef.current.has(hostId)) return;
    restoredHostsRef.current.add(hostId);
    const now = Date.now();
    pruneWorktreeSnapshots(now);
    const snapshot = readWorktreeActivitySnapshot(hostId, now);
    if (snapshot === null) return;
    const seededPaths = new Set<string>();
    for (const entry of snapshot.entries) {
      const key = perPathEnrichmentQueryKey(hostId, entry.worktreePath);
      const state =
        queryClient.getQueryState<WorktreeListAllForHostResponseV14>(key);
      if (state?.data !== undefined) continue;
      queryClient.setQueryData<WorktreeListAllForHostResponseV14>(
        key,
        { worktrees: [entry], nextCursor: null },
        // The snapshot's own age: restored entries are stale from birth, so
        // observers refetch them on mount like any stale query.
        { updatedAt: snapshot.savedAt },
      );
      seededPaths.add(entry.worktreePath);
    }
    if (seededPaths.size === 0) return;
    void queryClient.invalidateQueries({
      queryKey: hostQueryKeys.methodScope(hostId, "worktree.listAllForHost"),
      refetchType: "none",
      predicate: (query) => {
        const path = perPathEnrichmentQueryPath(query.queryKey);
        return path !== null && seededPaths.has(path);
      },
    });
    logPerfEvent("worktree.enrich_restore", {
      restoredCount: seededPaths.size,
    });
  }, [queryClient, hostId]);

  // Debounced snapshot writes off the fold: a quiet window after the last
  // cache event serializes the warm entries of the CURRENT listing (deleted
  // worktrees drop out; an empty fold never writes - guards in the writer).
  const persistDebounceRef = useRef<number | null>(null);
  useEffect(() => {
    if (hostId === null || worktreePaths.length === 0) return;
    if (persistDebounceRef.current !== null) {
      window.clearTimeout(persistDebounceRef.current);
    }
    persistDebounceRef.current = window.setTimeout(() => {
      persistDebounceRef.current = null;
      persistWorktreeActivitySnapshot({
        hostId,
        worktreePaths,
        enrichedByPath,
        now: Date.now(),
      });
    }, WORKTREE_ACTIVITY_PERSIST_DEBOUNCE_MS);
  }, [hostId, worktreePaths, enrichedByPath]);
  useEffect(
    () => () => {
      if (persistDebounceRef.current !== null) {
        window.clearTimeout(persistDebounceRef.current);
        // Reset the ref, not just the timer, for the same StrictMode
        // mount-cycle reason as the report debounce above.
        persistDebounceRef.current = null;
      }
    },
    [],
  );

  // ---- Background enrichment sweep ----------------------------------------
  // The viewport drives the rows on screen; the sweep drives everything else.
  // Each pass fetches ONE chunk of paths that still need a probe (no cached
  // data, invalidated by a refresh, or landed cold) through
  // `queryClient.fetchQuery` under the exact per-path keys the observers use
  // - and through the same batcher, so a whole chunk is one wire call. Keys
  // are built from the client's OWN readiness (`readiness.hostId`), so swept
  // entries land in precisely the scope the fold and the observers read.
  const [sweepTick, bumpSweepTick] = useReducer((tick: number) => tick + 1, 0);
  const [seedTick, bumpSeedTick] = useReducer((tick: number) => tick + 1, 0);
  const seedsOutstandingRef = useRef(false);
  // Two wake signals the identity-stable fold deliberately does NOT carry:
  //  - `invalidate` actions change no data, so the fold ignores them - but a
  //    refresh marks observer-less swept entries invalidated WITHOUT
  //    refetching, and the sweep must notice to re-probe them.
  //  - a `success` that lands data IDENTICAL to a warm-open seed keeps the
  //    fold identity (structural sharing preserves the entry), but the
  //    query's `dataUpdatedAt` is now this session's - the seeded-paths
  //    derivation below must re-run so the path flips seeded → live and the
  //    delete gate unlocks. Only ticked while seeds are outstanding, so a
  //    converged panel stays event-quiet.
  useEffect(() => {
    if (hostId === null) return;
    const scope = hostQueryKeys.methodScope(hostId, "worktree.listAllForHost");
    const cache = queryClient.getQueryCache();
    return cache.subscribe((event) => {
      if (event.type !== "updated") return;
      if (!queryKeyHasPrefix(event.query.queryKey, scope)) return;
      if (event.action.type === "invalidate") {
        bumpSweepTick();
      } else if (
        event.action.type === "success" &&
        seedsOutstandingRef.current
      ) {
        bumpSeedTick();
      }
    });
  }, [queryClient, hostId]);
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
    // `sweepTick` is a pure re-run trigger: chunk completion, backoff
    // wake-ups, and the invalidation subscription above all bump it (the
    // identity-stable fold no longer churns on invalidation marks, so a
    // refresh's wake comes from that subscription). `enrichedByPath` covers
    // the data-driven wakes - a probe landing CHANGED data or a GC removal
    // gives the fold a fresh identity.
    void sweepTick;
    void enrichedByPath;
    if (!reachable || client === null || batcher === null) return;
    if (!readiness.isReady) return;
    const sweepHostId = readiness.hostId;
    if (sweepHostId === null) return;
    // One chunk in flight at a time; its settle handler bumps `sweepTick`.
    if (sweepInFlightRef.current) return;
    // Visible rows first: while the viewport batch is fetching, hold the sweep
    // so the on-screen rows always win the host's attention.
    if (results.some((result) => result.isFetching)) return;
    const boundBatcher = batcher;
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
          sweepEnrichmentFetchOptions(sweepHostId, boundBatcher, path),
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
            queryClient.getQueryState<WorktreeListAllForHostResponseV14>(
              perPathEnrichmentQueryKey(sweepHostId, path),
            );
          ledger.set(path, {
            attempts,
            nextEligibleAt: settledAt + coldRetryDelayMs(attempts),
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
    batcher,
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
    // The stable constant in the (overwhelmingly common) empty case, so this
    // prop can't defeat downstream memoization on every `results` identity.
    return errored.size === 0 ? EMPTY_ERRORED : errored;
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

  // Paths whose overlay entry is still the warm-open SEED (see
  // `APP_SESSION_START_MS`): last-known display data this session has not yet
  // re-verified. The panel renders their restored tier but must gate
  // destructive flows (delete) on live data - a seeded "Landed" may have
  // gained commits since the snapshot was written. Keyed on the fold PLUS
  // `seedTick`: a data change or GC removal recomputes via the fold, and a
  // revalidation that landed data IDENTICAL to the seed (fold identity
  // deliberately unchanged) recomputes via the tick - either way a live
  // fetch's fresh `dataUpdatedAt` drops the path immediately.
  const seededPaths = useMemo(() => {
    void seedTick;
    if (hostId === null || enrichedByPath.size === 0) return EMPTY_SEEDED;
    const seeded = new Set<string>();
    for (const path of enrichedByPath.keys()) {
      const state =
        queryClient.getQueryState<WorktreeListAllForHostResponseV14>(
          perPathEnrichmentQueryKey(hostId, path),
        );
      if (state !== undefined && state.dataUpdatedAt < APP_SESSION_START_MS) {
        seeded.add(path);
      }
    }
    return seeded.size === 0 ? EMPTY_SEEDED : seeded;
  }, [enrichedByPath, hostId, queryClient, seedTick]);
  useEffect(() => {
    seedsOutstandingRef.current = seededPaths.size > 0;
  }, [seededPaths]);

  return {
    enrichedByPath,
    erroredPaths,
    seededPaths,
    reportVisiblePaths,
    enriching,
  };
}
