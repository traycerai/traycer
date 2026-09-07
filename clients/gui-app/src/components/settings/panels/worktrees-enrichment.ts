import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
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
// The boundary between snapshot-seeded and live cache data: the warm-open restore seeds queries with their
// snapshot-era `updatedAt` (always a previous run.
const APP_SESSION_START_MS = Date.now();
// (Off-screen rows are covered separately by the background sweep below, in equally bounded chunks - never one
// whole-list request.)
const WORKTREE_ENRICH_DEBOUNCE_MS = 80;
// The host serves a cold row and warms its PR fact through a background `gh` probe whose result only a refetch
// picks up.
const WORKTREE_COLD_PR_REFETCH_MAX_ATTEMPTS = 10;
const WORKTREE_COLD_PR_REFETCH_BASE_MS = 750;
const WORKTREE_COLD_PR_REFETCH_MAX_DELAY_MS = 20_000;

// Wait before retry number `attempts` (1-indexed): 750ms, 1.5s, 3s, 6s, 12s, then 20s flat - front-loaded for
// hosts that warm quickly, patient for the fleet-under-load tail.
function coldRetryDelayMs(attempts: number): number {
  return Math.min(
    WORKTREE_COLD_PR_REFETCH_BASE_MS * 2 ** (attempts - 1),
    WORKTREE_COLD_PR_REFETCH_MAX_DELAY_MS,
  );
}
// Sized under a typical viewport batch, so the host never sees more concurrent per-path probes than a normal
// scroll would produce.
const WORKTREE_SWEEP_CHUNK_SIZE = 8;
// Debounce for the warm-open snapshot writes: the cache fold's identity changes on every relevant cache event
// (each settled probe).
const WORKTREE_ACTIVITY_PERSIST_DEBOUNCE_MS = 1_500;

interface ColdPrRefetchState {
  readonly attempts: number;
  readonly timer: number | null;
  readonly terminal: boolean;
}

interface ViewportRetryStore {
  readonly scopeToken: object;
  readonly getSnapshot: () => ReadonlyMap<string, ColdPrRefetchState>;
  readonly getGeneration: () => number;
  readonly subscribe: (listener: () => void) => () => void;
  readonly set: (path: string, state: ColdPrRefetchState) => void;
  readonly delete: (path: string) => void;
  readonly reset: () => void;
}

function createViewportRetryStore(scopeToken: object): ViewportRetryStore {
  let snapshot: ReadonlyMap<string, ColdPrRefetchState> = new Map();
  let generation = 0;
  const listeners = new Set<() => void>();
  const publish = (next: ReadonlyMap<string, ColdPrRefetchState>): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  return {
    scopeToken,
    getSnapshot: () => snapshot,
    getGeneration: () => generation,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (path, state) => {
      const prior = snapshot.get(path);
      if (
        prior?.attempts === state.attempts &&
        prior.timer === state.timer &&
        prior.terminal === state.terminal
      )
        return;
      publish(new Map(snapshot).set(path, state));
    },
    delete: (path) => {
      if (!snapshot.has(path)) return;
      const next = new Map(snapshot);
      next.delete(path);
      publish(next);
    },
    reset: () => {
      generation += 1;
      if (snapshot.size === 0) return;
      publish(new Map());
    },
  };
}

interface SweepRetryState {
  readonly attempts: number;
  readonly nextEligibleAt: number;
  // `isInvalidated` only clears on a successful refetch, so without this marker a permanently rejecting path
  // would get a fresh budget on every sweep pass - an unbounded probe spin.
  readonly sawInvalidated: boolean;
}

interface SweepExhaustionState {
  readonly hostId: string | null;
  readonly paths: ReadonlySet<string>;
}

// `prState === null` = "not yet probed" (distinct from `"none"` = probed, no PR): the host served a stale/cold
// row and scheduled a background `gh` probe whose result never re-emits.
function responseHasColdPrState(
  response: WorktreeListAllForHostResponseV14,
): boolean {
  return response.worktrees.some(
    (entry) =>
      entry.prState === null ||
      entry.submodules.some((submodule) => submodule.prState === null),
  );
}

// The client stays out of the query key - `hostId` already carries the cache identity; the batcher is
// transport.
function sweepEnrichmentFetchOptions(
  hostId: string,
  batcher: WorktreeEnrichmentBatcher,
  path: string,
) {
  // The batcher stays out of the query key (it is transport, like the client before it).
  const fetcher = () => batcher.fetchPath(path);
  return queryOptions({
    queryKey: perPathEnrichmentQueryKey(hostId, path),
    queryFn: fetcher,
    // Sweep candidates are exactly the missing / invalidated / still-cold entries, so this must always hit the
    // network - never be handed back the same cold row a nonzero staleTime would consider fresh.
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

// The grant is remembered on the entry because `isInvalidated` stays true until a refetch succeeds -
// re-granting on every pass would let a permanently rejecting path bypass its budget and probe forever.
function grantInvalidationBudgetOnce(
  ledger: Map<string, SweepRetryState>,
  path: string,
): void {
  const prior = ledger.get(path);
  if (prior === undefined || prior.sawInvalidated) return;
  ledger.set(path, { attempts: 0, nextEligibleAt: 0, sawInvalidated: true });
}

// Drops ledger entries for paths that left the listing (deleted worktrees): a spent budget must not outlive
// its row.
function pruneSweepLedger(
  ledger: Map<string, SweepRetryState>,
  listedPaths: ReadonlySet<string>,
): void {
  for (const path of ledger.keys()) {
    if (!listedPaths.has(path)) ledger.delete(path);
  }
}

function exhaustedSweepPaths(
  ledger: ReadonlyMap<string, SweepRetryState>,
): ReadonlySet<string> {
  const exhausted = new Set<string>();
  for (const [path, retry] of ledger) {
    if (retry.attempts >= WORKTREE_COLD_PR_REFETCH_MAX_ATTEMPTS) {
      exhausted.add(path);
    }
  }
  return exhausted;
}

function equalPathSets(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  return left.size === right.size && [...left].every((path) => right.has(path));
}

function isTerminalEnrichmentError(args: {
  readonly state:
    | {
        readonly fetchStatus: "fetching" | "paused" | "idle";
        readonly status: "pending" | "error" | "success";
      }
    | undefined;
  readonly viewportOwned: boolean;
  readonly viewportExhausted: boolean;
  readonly sweepExhausted: boolean;
  readonly hasColdData: boolean;
}): boolean {
  const {
    state,
    viewportOwned,
    viewportExhausted,
    sweepExhausted,
    hasColdData,
  } = args;
  if (state?.fetchStatus === "fetching") return false;
  const missingOrUnresolved =
    state === undefined || state.status === "error" || hasColdData;
  if (viewportOwned) {
    if (viewportExhausted) return missingOrUnresolved;
    return state?.status === "error" && !hasColdData;
  }
  return sweepExhausted && missingOrUnresolved;
}

/** Merely time-stale entries are not re-swept - steady state stays quiet; refresh invalidation is the
 * deliberate re-probe path. */
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
  const queries = queryClient.getQueryCache().findAll({
    queryKey: methodScope,
    predicate: (query) => isPerPathEnrichmentQueryKey(query.queryKey),
  });
  const map = new Map<string, WorktreeHostEntryV14>();
  const freshness = new Map<
    string,
    { readonly resolvedAt: number | null; readonly dataUpdatedAt: number }
  >();
  for (const query of queries) {
    const data = query.state.data as
      | WorktreeListAllForHostResponseV14
      | undefined;
    if (data === undefined) continue;
    for (const entry of data.worktrees) {
      const prior = freshness.get(entry.worktreePath);
      const newerResolution =
        prior === undefined ||
        (entry.resolvedAt !== null &&
          (prior.resolvedAt === null || entry.resolvedAt > prior.resolvedAt));
      const equalResolution = entry.resolvedAt === prior?.resolvedAt;
      if (
        newerResolution ||
        (equalResolution && query.state.dataUpdatedAt > prior.dataUpdatedAt)
      ) {
        map.set(entry.worktreePath, entry);
        freshness.set(entry.worktreePath, {
          resolvedAt: entry.resolvedAt,
          dataUpdatedAt: query.state.dataUpdatedAt,
        });
      }
    }
  }
  return map;
}

/** The enrichment overlay, read from the TanStack Query cache rather than the live results of the
 * currently-requested window. */
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
        // Only query-level events (data added/removed/changed) may change the fold.
        if (
          event.type !== "added" &&
          event.type !== "removed" &&
          event.type !== "updated"
        ) {
          return;
        }
        // Within `updated`, only data-bearing actions can change the fold: `success` (a fetch landing or
        // `setQueryData`) and `setState` (raw state replacement).
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
    // Every distinct identity here fans out through the panel into a full list re-render - 100-450ms on a 50-row
    // fleet - so identity is only allowed to change when a row's data actually did.
    const prev = snapshotRef.current;
    const identical =
      prev.size === next.size &&
      [...next].every(([path, entry]) => prev.get(path) === entry);
    if (!identical) snapshotRef.current = next;
    return snapshotRef.current;
  }, [queryClient, methodScope]);

  // Third arg (server snapshot) returns the stable empty map - this is a browser-only SPA, but passing it keeps
  // parity with the app's other `useSyncExternalStore` readers and avoids any hydration edge.
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_ENRICHED);
}

/** The rows the user never scrolls to are not left pending. */
export function useWorktreeActivityEnrichment(
  client: HostClient<HostRpcRegistry> | null,
  reachable: boolean,
  hostId: string | null,
  // Every worktree path in the base listing, in listing order - the sweep's
  // denominator. The viewport machinery works purely off reported paths.
  worktreePaths: readonly string[],
): {
  readonly enrichedByPath: ReadonlyMap<string, WorktreeHostEntryV14>;
  // A failed first probe has no cached enrichment and renders as "Unknown".
  readonly erroredPaths: ReadonlySet<string>;
  // Paths whose overlay entry is still the restored warm-open seed - display data only.
  readonly seededPaths: ReadonlySet<string>;
  readonly reportVisiblePaths: (paths: readonly string[]) => void;
  readonly prepareEnrichmentRefresh: () => () => void;
  readonly enriching: boolean;
} {
  const queryClient = useQueryClient();
  const scopeToken = useMemo(
    () => ({ client, hostId, reachable }),
    [client, hostId, reachable],
  );
  const activeScopeTokenRef = useRef(scopeToken);
  useLayoutEffect(() => {
    activeScopeTokenRef.current = scopeToken;
  }, [scopeToken]);
  const [requestedPathsState, setRequestedPathsState] = useState<{
    readonly scopeToken: typeof scopeToken | null;
    readonly paths: readonly string[];
  }>({ scopeToken: null, paths: EMPTY_PATHS });
  const requestedPaths =
    requestedPathsState.scopeToken === scopeToken
      ? requestedPathsState.paths
      : EMPTY_PATHS;
  // The debounce coalesces every on-screen report inside one settle window into a single committed
  // `requestedPaths` update (trailing edge), so a fast scroll fires one batch of per-path queries.
  const latestVisibleRef = useRef<{
    readonly scopeToken: typeof scopeToken;
    readonly paths: readonly string[];
  }>({ scopeToken, paths: EMPTY_PATHS });
  const debounceRef = useRef<number | null>(null);
  const reportVisiblePaths = useCallback(
    (paths: readonly string[]) => {
      latestVisibleRef.current = { scopeToken, paths };
      // The gate variant wedged permanently when React StrictMode's mount setup→cleanup→setup cycle ran the unmount
      // cleanup between two reports on the same (surviving) hook instance.
      if (debounceRef.current !== null)
        window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null;
        setRequestedPathsState(latestVisibleRef.current);
      }, WORKTREE_ENRICH_DEBOUNCE_MS);
    },
    [scopeToken],
  );
  useEffect(
    () => () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        // Reset the ref, not just the timer: this cleanup also runs in StrictMode's mount effect cycle, where the hook
        // instance (and this ref) survives - a later report must be able to re-arm cleanly.
        debounceRef.current = null;
      }
    },
    [scopeToken],
  );

  // The shared wire transport for both enrichment legs: per-path fetches coalesce into chunked `activityPaths`
  // RPCs (see the batcher's doc), so an N-row open or refresh costs ~N/8 dials instead of N.
  const readiness = useReactiveHostReadiness(client);
  const batcher = useMemo(
    () =>
      client === null
        ? null
        : createWorktreeEnrichmentBatcher((paths) =>
            withHostQueryErrorBoundary("worktree.listAllForHost", () =>
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
  // This only drives fetching; the overlay is read from the cache below.
  const results = useBatchedEnrichmentQueries({
    hostId: readiness.hostId,
    paths: requestedPaths,
    batcher,
    enabled: reachable && client !== null && readiness.isReady,
  });
  const viewportRetryStore = useMemo(
    () => createViewportRetryStore(scopeToken),
    [scopeToken],
  );
  const viewportRetrySnapshot = useSyncExternalStore(
    viewportRetryStore.subscribe,
    viewportRetryStore.getSnapshot,
    viewportRetryStore.getSnapshot,
  );
  // Cold-PR retry bookkeeping is scoped to the live host connection, so a client/host swap or a reachability
  // drop must reset it, not just wipe it on unmount.
  useEffect(
    () => () => {
      for (const state of viewportRetryStore.getSnapshot().values()) {
        if (state.timer !== null) window.clearTimeout(state.timer);
      }
    },
    [viewportRetryStore],
  );
  useEffect(() => {
    const activePaths = new Set(requestedPaths);
    for (const [path, state] of viewportRetryStore.getSnapshot()) {
      if (activePaths.has(path)) continue;
      if (state.timer !== null) window.clearTimeout(state.timer);
      viewportRetryStore.delete(path);
    }

    results.forEach((result, index) => {
      const path = requestedPaths[index];
      const state = viewportRetryStore.getSnapshot().get(path) ?? {
        attempts: 0,
        timer: null,
        terminal: false,
      };
      // Cold rows (see `responseHasColdPrState`) retry on a bounded budget: the per-path refetch re-probes every leg
      // (superproject and submodules), so one budget per path covers both.
      const hasColdPrState =
        result.data !== undefined && responseHasColdPrState(result.data);
      if (!hasColdPrState) {
        if (state.timer !== null) window.clearTimeout(state.timer);
        viewportRetryStore.delete(path);
        return;
      }
      if (
        result.isFetching ||
        state.timer !== null ||
        state.attempts >= WORKTREE_COLD_PR_REFETCH_MAX_ATTEMPTS
      ) {
        viewportRetryStore.set(path, state);
        return;
      }

      const nextAttempts = state.attempts + 1;
      const retryGeneration = viewportRetryStore.getGeneration();
      const timer = window.setTimeout(() => {
        const latest = viewportRetryStore.getSnapshot().get(path);
        if (latest !== undefined) {
          viewportRetryStore.set(path, {
            attempts: latest.attempts,
            timer: null,
            terminal: false,
          });
        }
        void result.refetch().then((nextResult) => {
          if (viewportRetryStore.getGeneration() !== retryGeneration) return;
          const settled = viewportRetryStore.getSnapshot().get(path);
          if (settled?.attempts !== nextAttempts) return;
          const stillUnresolved =
            nextResult.isError ||
            (nextResult.data !== undefined &&
              responseHasColdPrState(nextResult.data));
          if (!stillUnresolved) {
            viewportRetryStore.delete(path);
            return;
          }
          if (nextAttempts >= WORKTREE_COLD_PR_REFETCH_MAX_ATTEMPTS) {
            viewportRetryStore.set(path, {
              attempts: nextAttempts,
              timer: null,
              terminal: true,
            });
          }
        });
      }, coldRetryDelayMs(nextAttempts));
      viewportRetryStore.set(path, {
        attempts: nextAttempts,
        timer,
        terminal: false,
      });
    });
  }, [requestedPaths, results, viewportRetryStore]);

  // Overlay from the cache (monotonic, remount-warm) - NOT from `results`.
  const enrichedByPath = useCachedWorktreeEnrichment(queryClient, hostId);

  // (Seeded, observer-less entries carry TanStack's default 5-minute gcTime until the sweep re-fetches them
  // under the pinned 30-minute gcTime.
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
  const sweepInFlightRef = useRef<object | null>(null);

  // Debounced snapshot writes off the fold: a quiet window after the last cache event serializes the warm
  // entries of the current listing (deleted worktrees drop out; an empty fold never writes.
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

  // Background enrichment sweep ---------------------------------------- The viewport drives the rows on screen;
  // the sweep drives everything else.
  const [sweepTick, bumpSweepTick] = useReducer((tick: number) => tick + 1, 0);
  const [seedTick, bumpSeedTick] = useReducer((tick: number) => tick + 1, 0);
  const seedsOutstandingRef = useRef(false);
  const sweepLedgerRef = useRef<Map<string, SweepRetryState>>(new Map());
  const [sweepExhaustion, setSweepExhaustion] = useState<SweepExhaustionState>({
    hostId: null,
    paths: EMPTY_ERRORED,
  });
  // Two wake signals the identity-stable fold deliberately does not carry: - `invalidate` actions change no
  // data, so the fold ignores them.
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
  // Capture the ledger before awaiting the listing RPC: a host/client switch replaces that map, so a late
  // completion can prove it belongs to an obsolete scope and no-op.
  const prepareEnrichmentRefresh = useCallback((): (() => void) => {
    const refreshHostId = hostId;
    const refreshLedger = sweepLedgerRef.current;
    const refreshViewportStore = viewportRetryStore;
    const refreshScopeToken = refreshViewportStore.scopeToken;
    return () => {
      if (
        refreshScopeToken !== activeScopeTokenRef.current ||
        refreshHostId === null ||
        sweepLedgerRef.current !== refreshLedger
      ) {
        return;
      }
      for (const state of refreshViewportStore.getSnapshot().values()) {
        if (state.timer !== null) window.clearTimeout(state.timer);
      }
      sweepLedgerRef.current = new Map();
      refreshViewportStore.reset();
      sweepInFlightRef.current = null;
      setSweepExhaustion({ hostId: refreshHostId, paths: EMPTY_ERRORED });
      bumpSweepTick();
    };
  }, [hostId, viewportRetryStore]);
  const sweepWakeTimerRef = useRef<number | null>(null);
  const sweepStatsRef = useRef({ fetchedCount: 0, drainLogged: true });
  // The map is replaced (not cleared) so a chunk that settles after the reset can detect it went stale and drop
  // its bookkeeping instead of polluting the new scope's retry budgets.
  useEffect(
    () => () => {
      sweepLedgerRef.current = new Map();
      sweepInFlightRef.current = null;
      sweepStatsRef.current = { fetchedCount: 0, drainLogged: true };
      if (sweepWakeTimerRef.current !== null) {
        window.clearTimeout(sweepWakeTimerRef.current);
        sweepWakeTimerRef.current = null;
      }
    },
    [client, hostId, reachable],
  );
  useEffect(() => {
    // `sweepTick` is a pure re-run trigger: chunk completion, backoff wake-ups, and the invalidation subscription
    // above all bump it (the identity-stable fold no longer churns on invalidation marks.
    void sweepTick;
    void enrichedByPath;
    if (!reachable || client === null || batcher === null) return;
    if (!readiness.isReady) return;
    const sweepHostId = readiness.hostId;
    if (sweepHostId === null) return;
    // One chunk in flight at a time; its settle handler bumps `sweepTick`.
    if (sweepInFlightRef.current !== null) return;
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
    setSweepExhaustion((prior) => {
      const paths = exhaustedSweepPaths(ledger);
      return prior.hostId === sweepHostId && equalPathSets(prior.paths, paths)
        ? prior
        : { hostId: sweepHostId, paths };
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
        // Gated aggregate signal mirroring `worktree.enrich_settle` on the viewport leg: how many probes this sweep
        // generation fired, and how many paths stayed cold/errored after their retry budget.
        logPerfEvent("worktree.enrich_sweep", {
          fetchedCount: sweepStatsRef.current.fetchedCount,
          unresolvedCount: ledger.size,
        });
        sweepStatsRef.current = { fetchedCount: 0, drainLogged: true };
      }
      return;
    }
    const flight = {};
    sweepInFlightRef.current = flight;
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
      // A host switch or refresh generation may already have started another
      // flight. An old completion must never clear that newer scope's guard.
      if (sweepInFlightRef.current === flight) {
        sweepInFlightRef.current = null;
      }
      // Record outcomes only if the scope was not reset (host swap / reachability drop) while this chunk was in
      // flight - stale outcomes belong to the old scope's ledger, not the fresh one.
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
          // `sawInvalidated` mirrors the live flag: a rejected refetch leaves `isInvalidated` set (→ true: this
          // invalidation's one budget grant stays consumed), while a successful-but-cold refetch clears it (→ false.
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
        setSweepExhaustion((prior) => {
          const paths = exhaustedSweepPaths(ledger);
          return prior.hostId === sweepHostId &&
            equalPathSets(prior.paths, paths)
            ? prior
            : { hostId: sweepHostId, paths };
        });
      }
      // Bump unconditionally: while this chunk was in flight the effect skipped every re-run, so this is what
      // schedules the next pass.
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

  // Error state is host-wide, not viewport-owned. Strict filtering removes never-classified rows from the
  // virtual window, after which only the background sweep owns their queries.
  const erroredPaths = useMemo(() => {
    void results;
    void sweepTick;
    if (hostId === null) return EMPTY_ERRORED;
    const errored = new Set<string>();
    const viewportPaths = new Set(requestedPaths);
    const candidatePaths = new Set([...worktreePaths, ...requestedPaths]);
    for (const path of candidatePaths) {
      const state =
        queryClient.getQueryState<WorktreeListAllForHostResponseV14>(
          perPathEnrichmentQueryKey(hostId, path),
        );
      const sweepExhausted =
        sweepExhaustion.hostId === hostId && sweepExhaustion.paths.has(path);
      const viewportExhausted =
        viewportRetrySnapshot.get(path)?.terminal === true;
      const hasColdData =
        state?.data !== undefined && responseHasColdPrState(state.data);
      if (
        isTerminalEnrichmentError({
          state,
          viewportOwned: viewportPaths.has(path),
          viewportExhausted,
          sweepExhausted,
          hasColdData,
        })
      ) {
        errored.add(path);
      }
    }
    // The stable constant in the (overwhelmingly common) empty case, so this
    // prop can't defeat downstream memoization on every `results` identity.
    return errored.size === 0 ? EMPTY_ERRORED : errored;
  }, [
    hostId,
    queryClient,
    requestedPaths,
    results,
    sweepExhaustion,
    sweepTick,
    viewportRetrySnapshot,
    worktreePaths,
  ]);

  const enriching = results.some((result) => result.isFetching);
  // Settle telemetry describes this viewport's `results` window, so its error numerator must use that same
  // scope.
  const viewportErroredCount = results.filter(
    (result) => result.isError,
  ).length;
  // Gated perf telemetry for the enrichment leg (invisible before - only the base leg was tracked, so a
  // wholesale enrichment failure left no trace).
  useWorktreeEnrichSettlePerf({
    fetching: enriching,
    pathCount: requestedPaths.length,
    erroredCount: viewportErroredCount,
  });

  // The panel renders their restored tier but must gate destructive flows (delete) on live data - a seeded
  // "Landed" may have gained commits since the snapshot was written.
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
    prepareEnrichmentRefresh,
    enriching,
  };
}
