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

/** Paths per batched `worktree.listAllForHost` RPC. */
export const WORKTREE_ENRICH_BATCH_LIMIT = 8;
// Both enrichment legs pin the same generous gcTime, well past TanStack's 5-minute default: swept entries have
// no observers, so under the default they would be garbage-collected while the panel sits open.
export const WORKTREE_ENRICHMENT_GC_MS = 30 * 60_000;

// `forceRefresh` is pinned to its canonical `false`: it is a fetch directive, so every automatic
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

// Rows are passed through BY reference, so every other field survives untouched - narrowing here only keeps
// the guard honest about what it actually inspects.
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

/** Cache-write guard shared by both enrichment legs: a row the host answered unresolved (`resolvedAt === null`. */
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
  // Unconditionally rebuilt, then handed to `replaceEqualDeep`: when nothing was actually held back the result
  // deep-equals `previous` and the previous reference comes straight back.
  return replaceEqualDeep(previous, { ...next, worktrees });
}

/** Split out here (not `useHostQueries`, the usual wrapper) because that wrapper hard-wires one
 * `client.request` per request spec - the whole point of this module is the coalesced transport. */
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
        // Probe-once for real (manual-refresh model): an enriched row never refetches on remount or scroll-back.
        // Refresh invalidation and the cold-PR retry ledgers are the only re-probe paths.
        staleTime: Infinity,
        gcTime: WORKTREE_ENRICHMENT_GC_MS,
        structuralSharing: keepResolvedEnrichmentRows,
      });
    }),
  });
}
// Sized to catch callers that enqueue across a few microtask/effect boundaries (a viewport settle window's
// observers.
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

/** Row fan-out matches by exact `worktreePath` string equality, the same contract the host's per-path change
 * emits rely on (raw paths, never normalized). */
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
