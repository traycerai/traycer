import {
  queryOptions,
  replaceEqualDeep,
  useQueries,
  type QueryClient,
  type QueryKey,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { WorktreeListAllForHostResponseV14 } from "@traycer/protocol/host/worktree-schemas";
import { type HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import { rowsByRequestedPath } from "@/lib/worktree/worktree-path-match";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";

/**
 * Paths per batched `worktree.listAllForHost` RPC. Matches the sweep's chunk
 * size, so one sweep pass is exactly one wire call.
 */
export const WORKTREE_ENRICH_BATCH_LIMIT = 8;

/**
 * Paths per RPC for the BACKGROUND surfaces (History, the Epic sweep row, owner
 * cards) - {@link sharedWorktreeEnrichmentBatcher}. Larger than the
 * Settings chunk because those surfaces read a whole task page's worktrees at
 * once and nothing there is sized to the sweep: at 8, History's ~80 owned paths
 * were ~10 RPCs per mount. The host derives only rows that need it, so a bigger
 * chunk moves the same work into fewer calls.
 */
export const WORKTREE_BACKGROUND_ENRICH_BATCH_LIMIT = 32;

/**
 * How long a background surface's enrichment row counts as fresh. A
 * `worktree.changed` frame still re-probes a named row at once, and Refresh
 * still forces; this only stops a plain remount (navigation, a list re-render)
 * from re-probing every row older than the app's one-minute default. It is
 * also how long a PR fact the host warmed in the background can take to reach
 * these surfaces on a remount.
 */
export const WORKTREE_BACKGROUND_ENRICHMENT_STALE_MS = 5 * 60_000;
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
 * The ONE observer-side definition of a per-path enrichment query, shared by
 * every surface that reads activity-enriched worktree rows: this panel's
 * viewport leg below, and the task / owner / PR-search hooks through
 * `useWorktreeEnrichmentForClient`. Sharing it is what keeps the query-level
 * options (`gcTime`, `structuralSharing`) identical on a key two surfaces
 * observe at once - TanStack holds ONE option set per query, so a second
 * definition would silently swap the resolved-row guard in and out depending
 * on which observer rendered last.
 *
 * `staleTime` is the only observer-level knob, because the surfaces genuinely
 * differ there: this panel is manual-refresh (`Infinity`), while the History
 * and hover surfaces keep the app default (`null`) so a remount after it can
 * still pick up a PR fact the host warmed in the background. `null` omits the
 * field rather than passing `undefined`, which would OVERRIDE the app default
 * with "always stale" instead of inheriting it.
 */
export function perPathEnrichmentQueryOptions(args: {
  readonly hostId: string | null;
  readonly path: string;
  readonly batcher: WorktreeEnrichmentBatcher | null;
  readonly enabled: boolean;
  readonly staleTime: number | null;
}) {
  const { hostId, path, batcher, enabled, staleTime } = args;
  // The batcher is transport, not cache identity - it stays out of the
  // query key, exactly as the client did under `useHostQueries`.
  const fetcher = (): Promise<WorktreeListAllForHostResponseV14> =>
    batcher === null
      ? Promise.reject(hostClientUnavailableError("worktree.listAllForHost"))
      : batcher.fetchPath(path);
  return queryOptions<WorktreeListAllForHostResponseV14, HostRpcError>({
    queryKey: perPathEnrichmentQueryKey(hostId, path),
    queryFn: fetcher,
    enabled,
    ...(staleTime === null ? {} : { staleTime }),
    gcTime: WORKTREE_ENRICHMENT_GC_MS,
    structuralSharing: keepResolvedEnrichmentRows,
  });
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
    queries: paths.map((path) =>
      perPathEnrichmentQueryOptions({
        hostId,
        path,
        batcher,
        enabled,
        // Probe-once for real (manual-refresh model): an enriched row never
        // refetches on remount or scroll-back. Refresh invalidation and the
        // cold-PR retry ledgers are the only re-probe paths.
        staleTime: Infinity,
      }),
    ),
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
 * wire carries up to `batchLimit` paths per call.
 *
 * Row fan-out is {@link rowsByRequestedPath}: exact `worktreePath` string
 * equality first, which is every listing-sourced path (the host answers under
 * `path.resolve` of the requested spelling, and a listing row's path already
 * is one), then the host's lexical key for a binding-sourced spelling it
 * rewrote (a trailing slash an explicit import kept). A requested path with no
 * row in the batch response resolves to an empty listing - identical to what
 * its single-path RPC would have returned for a path absent from the disk
 * walk. A failed batch rejects every waiter in the chunk with the same error;
 * retry bookkeeping stays per-path in the callers, so one poisoned path never
 * spends its neighbours' budgets.
 *
 * No dedupe on purpose: TanStack already single-flights per query key, and
 * the sweep skips paths that are fetching or viewport-owned, so a path never
 * has two concurrent waiters.
 */
export function createWorktreeEnrichmentBatcher(
  requestBatch: (
    paths: readonly string[],
  ) => Promise<WorktreeListAllForHostResponseV14>,
  batchLimit: number,
): WorktreeEnrichmentBatcher {
  let pending: PendingEnrichmentPath[] = [];
  let windowTimer: number | null = null;

  const flush = (): void => {
    if (windowTimer !== null) {
      window.clearTimeout(windowTimer);
      windowTimer = null;
    }
    while (pending.length > 0) {
      const chunk = pending.slice(0, batchLimit);
      pending = pending.slice(batchLimit);
      void requestBatch(chunk.map((entry) => entry.path)).then(
        (response) => {
          const rowsByPath = rowsByRequestedPath(
            chunk.map((entry) => entry.path),
            response.worktrees,
          );
          for (const entry of chunk) {
            entry.resolve({
              worktrees: [...(rowsByPath.get(entry.path) ?? [])],
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
        if (pending.length >= batchLimit) {
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

/**
 * The batcher over one host client's selection-mode read - the ONLY place a
 * background (`forceRefresh: false`) multi-path `worktree.listAllForHost`
 * request is written. It is a WIRE shape, never a cache key: every row it
 * returns lands under its own {@link perPathEnrichmentQueryKey}, which is what
 * lets a per-path `worktree.changed` frame re-probe exactly the rows it names
 * (`invalidate-worktree-changed-caches.ts`) instead of a whole batch.
 *
 * No abort signal is threaded through, on purpose: nothing on the host would
 * receive it. traycer-host's `listAllForHost` resolver calls
 * `WorktreeSetupOrchestrator.listAllForHost` without the request context's
 * signal, and that method takes none, so a derive the host has started runs
 * to completion and lands in its row cache whether or not the client is still
 * listening - the next read, on any mount, is served from there. Aborting a
 * chunk would only drop the answer the host already paid for.
 */
export function createWorktreeEnrichmentBatcherForClient(
  client: HostClient<HostRpcRegistry>,
  batchLimit: number,
): WorktreeEnrichmentBatcher {
  return createWorktreeEnrichmentBatcher(
    (paths) => requestEnrichmentRows(client, paths),
    batchLimit,
  );
}

function requestEnrichmentRows(
  client: HostClient<HostRpcRegistry>,
  paths: readonly string[],
): Promise<WorktreeListAllForHostResponseV14> {
  return withHostQueryErrorBoundary("worktree.listAllForHost", () =>
    client.request("worktree.listAllForHost", {
      includeActivity: true,
      activityPaths: [...paths],
      cursor: null,
      limit: null,
      forceRefresh: false,
    }),
  );
}

interface SharedEnrichmentBatcher {
  /** The requester the next chunk is sent through: the latest one seen. */
  client: HostClient<HostRpcRegistry>;
  readonly batcher: WorktreeEnrichmentBatcher;
}

const sharedBatchers = new WeakMap<
  QueryClient,
  Map<string, SharedEnrichmentBatcher>
>();

/**
 * The ONE background batcher per host, shared by every surface that reads
 * enrichment through `useWorktreeEnrichmentForClient`.
 *
 * Per-surface batchers coalesced only their own paths, so a navigation that
 * mounted History, an Epic's sweep row and an owner card at once - or a resume
 * whose catch-up frame refetched all of them - sent each surface's paths as
 * separate RPCs. One batcher per host puts every path enqueued in the same
 * window into the same chunks.
 *
 * Keyed by the query cache and host id - the namespace the rows land in
 * ({@link perPathEnrichmentQueryKey}) - never by the requester: requesters are
 * not stable per host (each `createRequester` / `createRequesterForHostId`
 * call is a new routing view, and hooks memoize theirs per instance), so a
 * requester-keyed batcher split one host's surfaces across batchers again.
 * Every requester for a host routes `worktree.listAllForHost` identically, so
 * a chunk goes out through whichever one reached this last.
 */
export function sharedWorktreeEnrichmentBatcher(
  queryClient: QueryClient,
  hostId: string,
  client: HostClient<HostRpcRegistry>,
): WorktreeEnrichmentBatcher {
  let byHost = sharedBatchers.get(queryClient);
  if (byHost === undefined) {
    byHost = new Map();
    sharedBatchers.set(queryClient, byHost);
  }
  const existing = byHost.get(hostId);
  if (existing !== undefined) {
    existing.client = client;
    return existing.batcher;
  }
  const shared: SharedEnrichmentBatcher = {
    client,
    batcher: createWorktreeEnrichmentBatcher(
      (paths) => requestEnrichmentRows(shared.client, paths),
      WORKTREE_BACKGROUND_ENRICH_BATCH_LIMIT,
    ),
  };
  byHost.set(hostId, shared);
  return shared.batcher;
}
