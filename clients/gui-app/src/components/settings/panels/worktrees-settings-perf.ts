import { useEffect, useRef } from "react";
import { logPerfEvent } from "@/lib/perf/perf-telemetry";

/**
 * Perf instrumentation hooks for the Worktrees settings panel - heavy on open,
 * so we capture the legs that dominate that cost: the host list query and first
 * paint of a non-empty list. Both emit through `logPerfEvent` (gated +
 * non-throwing) and add no meaningful work to the hot path (a `performance.now()`
 * read inside an effect). The list render pass is timed separately by
 * `WorktreeListRenderProfiler` (React `Profiler`).
 */

export function roundPerfMs(value: number): number {
  return Math.round(value * 10) / 10;
}

type QueryFetchStatus = "fetching" | "paused" | "idle";
type QueryStatus = "pending" | "error" | "success";

/**
 * Emits `worktree.list_query` when the `worktree.listAllForHost` query settles.
 *
 * `durationMs` is measured in the renderer from the effect that observes
 * `fetchStatus` flipping to `fetching` until it settles - so it includes React
 * scheduling, not just network RTT (a clean query-start timestamp isn't exposed
 * by `useHostQuery`). `fromCache` is derived: cached data was already present
 * when the fetch began (a background refetch), which is the closest signal
 * available from the query result.
 */
export function useWorktreeListQueryPerf(input: {
  readonly includeActivity: boolean;
  readonly fetchStatus: QueryFetchStatus;
  readonly status: QueryStatus;
  readonly worktreeCount: number;
  readonly submoduleCount: number;
  readonly hasData: boolean;
}): void {
  const {
    includeActivity,
    fetchStatus,
    status,
    worktreeCount,
    submoduleCount,
    hasData,
  } = input;
  const startRef = useRef<{
    readonly startMs: number;
    readonly fromCache: boolean;
  } | null>(null);
  useEffect(() => {
    if (fetchStatus === "fetching") {
      if (startRef.current === null) {
        startRef.current = { startMs: performance.now(), fromCache: hasData };
      }
      return;
    }
    const started = startRef.current;
    if (started === null) return;
    // A `paused` fetch before the first resolve is still in flight; wait for a
    // real terminal status (success/error) before recording the leg.
    if (status === "pending") return;
    startRef.current = null;
    logPerfEvent("worktree.list_query", {
      includeActivity,
      worktreeCount,
      submoduleCount,
      durationMs: roundPerfMs(performance.now() - started.startMs),
      fromCache: started.fromCache,
    });
  }, [
    includeActivity,
    fetchStatus,
    status,
    worktreeCount,
    submoduleCount,
    hasData,
  ]);
}

/**
 * Emits `worktree.enrich_settle` once per per-viewport enrichment settle window -
 * the transition from "some per-path enrichment query fetching" to "none". Carries
 * how many paths the window probed and how many SETTLED to an error, so a
 * wholesale enrichment failure (e.g. every per-path RPC timing out on a gh network
 * stall) is visible in `traycer-perf.ndjson` instead of only showing up as
 * infinite "Checking…" spinners with no trace. `durationMs` spans from the first
 * in-flight query to the settle, measured in the renderer (includes scheduling).
 *
 * Per-query error logging is NOT done here - the app's shared `QueryCache.onError`
 * already warns each failed request; this is purely the aggregate perf signal.
 */
export function useWorktreeEnrichSettlePerf(input: {
  readonly fetching: boolean;
  readonly pathCount: number;
  readonly erroredCount: number;
}): void {
  const { fetching, pathCount, erroredCount } = input;
  const startRef = useRef<number | null>(null);
  useEffect(() => {
    if (fetching) {
      if (startRef.current === null) startRef.current = performance.now();
      return;
    }
    const started = startRef.current;
    if (started === null) return;
    startRef.current = null;
    logPerfEvent("worktree.enrich_settle", {
      pathCount,
      erroredCount,
      durationMs: roundPerfMs(performance.now() - started),
    });
  }, [fetching, pathCount, erroredCount]);
}

/**
 * Emits `worktree.first_paint` once, the first time a non-empty list has
 * painted after the panel mounted (`painted` = query succeeded with rows).
 */
export function useWorktreeFirstPaintPerf(input: {
  readonly painted: boolean;
  readonly rowCount: number;
}): void {
  const { painted, rowCount } = input;
  const mountedAtRef = useRef<number | null>(null);
  const emittedRef = useRef(false);
  // Record "mount" as early as an effect allows (the first commit) - reading the
  // clock in render would be an impure render-body call. This effect is declared
  // before the paint effect, so it always sets the baseline first.
  useEffect(() => {
    mountedAtRef.current = performance.now();
  }, []);
  useEffect(() => {
    const mountedAt = mountedAtRef.current;
    if (emittedRef.current || !painted || mountedAt === null) return;
    emittedRef.current = true;
    logPerfEvent("worktree.first_paint", {
      mountToPaintMs: roundPerfMs(performance.now() - mountedAt),
      rowCount,
    });
  }, [painted, rowCount]);
}
