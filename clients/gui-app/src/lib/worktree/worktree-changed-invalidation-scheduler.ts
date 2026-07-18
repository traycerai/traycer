import type { WorktreeChangedScope } from "@traycer/protocol/host/worktree-changed-stream";

/**
 * Trailing-edge debounce for the burst shape the host's freshness sweep
 * produces: one push event PER re-derived row, ~20+ events/second during a
 * wave (providers-list storm RCA, live CDP audit). Collapsing a wave into one
 * flush turns N base-list + workspace-paths refetch pairs into one pair.
 */
export const WORKTREE_CHANGED_INVALIDATION_DEBOUNCE_MS = 300;

/**
 * Upper bound on how long a continuous drizzle of events (gaps under the
 * debounce) can postpone the flush - the sweep's demand-renewal contract and
 * on-screen freshness only need a refetch per wave, but they do need one.
 */
export const WORKTREE_CHANGED_INVALIDATION_MAX_WAIT_MS = 1_000;

/**
 * The union of every scope pushed since the last flush. `root: true` absorbs
 * path precision on purpose: a root event means "row membership may have
 * changed anywhere", which no path set can narrow back down.
 */
export interface WorktreeChangedAccumulatedScopes {
  readonly root: boolean;
  readonly worktreePaths: ReadonlySet<string>;
}

export interface WorktreeChangedInvalidationScheduler {
  readonly push: (scope: WorktreeChangedScope) => void;
  readonly dispose: () => void;
}

/**
 * Accumulates `worktree.changed` scopes and delivers them as ONE `onFlush`
 * per burst: trailing-edge `debounceMs` after the last event, bounded by
 * `maxWaitMs` from the first unflushed event. `dispose` flushes anything
 * pending (an invalidation must never be dropped on unmount/host switch)
 * and ignores later pushes.
 */
export function createWorktreeChangedInvalidationScheduler(args: {
  readonly onFlush: (scopes: WorktreeChangedAccumulatedScopes) => void;
  readonly debounceMs: number;
  readonly maxWaitMs: number;
}): WorktreeChangedInvalidationScheduler {
  let root = false;
  let worktreePaths = new Set<string>();
  let trailingTimer: number | null = null;
  let maxWaitTimer: number | null = null;
  let disposed = false;

  const clearTimers = (): void => {
    if (trailingTimer !== null) window.clearTimeout(trailingTimer);
    if (maxWaitTimer !== null) window.clearTimeout(maxWaitTimer);
    trailingTimer = null;
    maxWaitTimer = null;
  };

  const flush = (): void => {
    clearTimers();
    if (!root && worktreePaths.size === 0) return;
    const scopes: WorktreeChangedAccumulatedScopes = { root, worktreePaths };
    root = false;
    worktreePaths = new Set<string>();
    args.onFlush(scopes);
  };

  return {
    push: (scope: WorktreeChangedScope): void => {
      if (disposed) return;
      if (scope.kind === "root") {
        root = true;
      } else {
        worktreePaths.add(scope.worktreePath);
      }
      if (trailingTimer !== null) window.clearTimeout(trailingTimer);
      trailingTimer = window.setTimeout(flush, args.debounceMs);
      if (maxWaitTimer === null) {
        maxWaitTimer = window.setTimeout(flush, args.maxWaitMs);
      }
    },
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      flush();
    },
  };
}
