import {
  queryOptions,
  replaceEqualDeep,
  useQueries,
  type QueryKey,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  WorktreeHostEntryV14,
  WorktreeListAllForHostResponseV14,
} from "@traycer/protocol/host/worktree-schemas";
import { type HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";

/**
 * Paths per batched `worktree.listAllForHost` RPC. Matches the sweep's chunk
 * size, so one sweep pass is exactly one wire call.
 */
export const WORKTREE_ENRICH_BATCH_LIMIT = 8;
// Both enrichment legs pin the same generous gcTime, well past TanStack's
// 5-minute default: swept entries have no observers, so under the default they
// would be garbage-collected while the panel sits open - each GC visibly
// regresses its row to "Checking…" and the sweep would re-probe it, a slow,
// pointless churn loop. Refresh (method-scope invalidation) remains the way
// entries are re-probed deliberately.
export const WORKTREE_ENRICHMENT_GC_MS = 30 * 60_000;

// The per-path enrichment params, shared by the viewport observers and the
// background sweep so both produce identical query keys - the cache fold and
// TanStack's request dedupe both hinge on that identity. `forceRefresh` is
// pinned to its canonical `false`: it is a fetch directive, so every automatic
// enrichment/refetch lands in the same entry and remains a cache-only host read.
export function perPathEnrichmentParams(path: string) {
  return {
    includeActivity: true,
    activityPaths: [path],
    cursor: null,
    limit: null,
    forceRefresh: false,
  };
}

export function perPathEnrichmentQueryKey(
  hostId: string | null,
  path: string,
): QueryKey {
  return hostQueryKeys.method<HostRpcRegistry, "worktree.listAllForHost">(
    hostId,
    "worktree.listAllForHost",
    perPathEnrichmentParams(path),
  );
}

// The minimal shape this guard reasons about. Rows are passed through BY
// REFERENCE, so every other field survives untouched - narrowing here only
// keeps the guard honest about what it actually inspects.
type ResolvableRow = {
  readonly worktreePath: string;
  readonly resolvedAt: number | null;
};

function isResolvableResponse(
  value: unknown,
): value is { readonly worktrees: readonly ResolvableRow[] } {
  if (value === null || typeof value !== "object") return false;
  if (!("worktrees" in value)) return false;
  const { worktrees } = value;
  return (
    Array.isArray(worktrees) &&
    worktrees.every(
      (row: unknown) =>
        row !== null &&
        typeof row === "object" &&
        "worktreePath" in row &&
        typeof row.worktreePath === "string" &&
        "resolvedAt" in row &&
        (row.resolvedAt === null || typeof row.resolvedAt === "number"),
    )
  );
}

/**
 * Cache-write guard shared by both enrichment legs: a row the host answered
 * UNRESOLVED (`resolvedAt === null` - the cold-host `unresolvedRow` sentinel,
 * rendered as "detached HEAD" / "Waiting for host verification…") never
 * replaces a resolved row already in cache.
 *
 * Resolved data is only ever replaced by resolved data; a row disappears only
 * by leaving the base listing, which is the one thing that proves it is gone.
 * Wired through TanStack's `structuralSharing` so it covers every write to
 * these keys - the observer leg, the sweep's `fetchQuery`, and refetches -
 * without each call site remembering to merge.
 *
 * Delegates to `replaceEqualDeep` (what TanStack's DEFAULT structural sharing
 * does) rather than returning a fresh object: the enrichment fold keeps its Map
 * identity only while equal refetches preserve row references, and losing that
 * re-renders every row in the list on each probe.
 */
export function keepResolvedEnrichmentRows(
  previous: unknown,
  next: unknown,
): unknown {
  if (!isResolvableResponse(previous) || !isResolvableResponse(next)) {
    return replaceEqualDeep(previous, next);
  }
  const previousByPath = new Map(
    previous.worktrees.map((row) => [row.worktreePath, row]),
  );
  const worktrees = next.worktrees.map((row) => {
    if (row.resolvedAt !== null) return row;
    const prior = previousByPath.get(row.worktreePath);
    return prior !== undefined && prior.resolvedAt !== null ? prior : row;
  });
  // Unconditionally rebuilt, then handed to `replaceEqualDeep`: when nothing
  // was actually held back the result deep-equals `previous` and the previous
  // reference comes straight back, so row identity survives an equal refetch.
  return replaceEqualDeep(previous, { ...next, worktrees });
}

/**
 * Observer-leg fetch driver over the batched transport. Split out here (not
 * `useHostQueries`, the usual wrapper) because that wrapper hard-wires one
 * `client.request` per request spec - the whole point of this module is the
 * coalesced transport. Key shape, enabled gating, and error typing mirror the
 * wrapper exactly; consumers treat the returned results as the same opaque
 * array.
 */
export function useBatchedEnrichmentQueries(args: {
  readonly hostId: string | null;
  readonly paths: readonly string[];
  readonly batcher: WorktreeEnrichmentBatcher | null;
  readonly enabled: boolean;
}): Array<UseQueryResult<WorktreeListAllForHostResponseV14, HostRpcError>> {
  const { hostId, paths, batcher, enabled } = args;
  return useQueries({
    queries: paths.map((path) => {
      // The batcher is transport, not cache identity - it stays out of the
      // query key, exactly as the client did under `useHostQueries`.
      const fetcher = (): Promise<WorktreeListAllForHostResponseV14> =>
        batcher === null
          ? Promise.reject(
              hostClientUnavailableError("worktree.listAllForHost"),
            )
          : batcher.fetchPath(path);
      return queryOptions<WorktreeListAllForHostResponseV14, HostRpcError>({
        queryKey: perPathEnrichmentQueryKey(hostId, path),
        queryFn: fetcher,
        enabled,
        // Probe-once for real (manual-refresh model): an enriched row never
        // refetches on remount or scroll-back. Refresh invalidation and the
        // cold-PR retry ledgers are the only re-probe paths.
        staleTime: Infinity,
        gcTime: WORKTREE_ENRICHMENT_GC_MS,
        structuralSharing: keepResolvedEnrichmentRows,
      });
    }),
  });
}
// Coalescing window: how long the first enqueued path waits for company
// before its batch flushes. Sized to catch callers that enqueue across a few
// microtask/effect boundaries (a viewport settle window's observers, the
// staggered timers of one cold-retry round) while staying imperceptible
// against the RPC's own latency.
const WORKTREE_ENRICH_BATCH_WINDOW_MS = 25;

interface PendingEnrichmentPath {
  readonly path: string;
  readonly resolve: (response: WorktreeListAllForHostResponseV14) => void;
  readonly reject: (error: unknown) => void;
}

export interface WorktreeEnrichmentBatcher {
  readonly fetchPath: (
    path: string,
  ) => Promise<WorktreeListAllForHostResponseV14>;
}

/**
 * Coalesces per-path enrichment fetches into chunked `activityPaths` RPCs.
 *
 * The per-path shape is a CACHE choice, not a wire necessity: TanStack keys
 * each worktree's enrichment under its own path (probe once, scroll-back is a
 * cache hit, per-path error isolation), but issuing one WebSocket dial per
 * path made opening or refreshing an N-row fleet cost N dials. This layer
 * keeps the per-path cache entries exactly as they are - each `fetchPath`
 * resolves with a response shaped like the old single-path RPC - while the
 * wire carries up to {@link WORKTREE_ENRICH_BATCH_LIMIT} paths per call.
 *
 * Row fan-out matches by EXACT `worktreePath` string equality, the same
 * contract the host's per-path change emits rely on (raw paths, never
 * normalized). A requested path with no row in the batch response resolves to
 * an empty listing - identical to what its single-path RPC would have
 * returned for a path absent from the disk walk. A failed batch rejects every
 * waiter in the chunk with the same error; retry bookkeeping stays per-path
 * in the callers, so one poisoned path never spends its neighbours' budgets.
 *
 * No dedupe on purpose: TanStack already single-flights per query key, and
 * the sweep skips paths that are fetching or viewport-owned, so a path never
 * has two concurrent waiters.
 */
export function createWorktreeEnrichmentBatcher(
  requestBatch: (
    paths: readonly string[],
  ) => Promise<WorktreeListAllForHostResponseV14>,
): WorktreeEnrichmentBatcher {
  let pending: PendingEnrichmentPath[] = [];
  let windowTimer: number | null = null;

  const flush = (): void => {
    if (windowTimer !== null) {
      window.clearTimeout(windowTimer);
      windowTimer = null;
    }
    while (pending.length > 0) {
      const chunk = pending.slice(0, WORKTREE_ENRICH_BATCH_LIMIT);
      pending = pending.slice(WORKTREE_ENRICH_BATCH_LIMIT);
      void requestBatch(chunk.map((entry) => entry.path)).then(
        (response) => {
          const rowsByPath = new Map<string, WorktreeHostEntryV14[]>();
          for (const row of response.worktrees) {
            const rows = rowsByPath.get(row.worktreePath) ?? [];
            rows.push(row);
            rowsByPath.set(row.worktreePath, rows);
          }
          for (const entry of chunk) {
            entry.resolve({
              worktrees: rowsByPath.get(entry.path) ?? [],
              nextCursor: null,
            });
          }
        },
        (error: unknown) => {
          for (const entry of chunk) entry.reject(error);
        },
      );
    }
  };

  return {
    fetchPath: (path) =>
      new Promise((resolve, reject) => {
        pending.push({ path, resolve, reject });
        if (pending.length >= WORKTREE_ENRICH_BATCH_LIMIT) {
          flush();
          return;
        }
        if (windowTimer === null) {
          windowTimer = window.setTimeout(() => {
            windowTimer = null;
            flush();
          }, WORKTREE_ENRICH_BATCH_WINDOW_MS);
        }
      }),
  };
}
