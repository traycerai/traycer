/**
 * Extra OWNER-level delay after a plan-restricted transport reaches its own
 * reprobe deadline. The transport cache already waits before it permits a new
 * remote session; this ladder prevents a host that keeps denying the plan from
 * rebuilding the whole Epic session at every cache deadline forever.
 */
export const PLAN_RESTRICTED_SESSION_REBUILD_INITIAL_BACKOFF_MS = 60_000;
export const PLAN_RESTRICTED_SESSION_REBUILD_MAX_BACKOFF_MS = 15 * 60_000;

export interface PlanRestrictedSessionRebuildBackoff {
  /** Runs the first rebuild immediately, then delays repeated denied rebuilds. */
  readonly request: (rebuild: () => void) => void;
  /** A loaded session on an open transport proves the denial loop ended. */
  readonly markHealthy: () => void;
  /** Ends any pending delay when the owning provider/host target goes away. */
  readonly cancel: () => void;
}

function delayForAttempt(attempt: number): number {
  if (attempt === 0) return 0;
  return Math.min(
    PLAN_RESTRICTED_SESSION_REBUILD_INITIAL_BACKOFF_MS * 2 ** (attempt - 1),
    PLAN_RESTRICTED_SESSION_REBUILD_MAX_BACKOFF_MS,
  );
}

export function createPlanRestrictedSessionRebuildBackoff(): PlanRestrictedSessionRebuildBackoff {
  let completedRequests = 0;
  let pendingTimer: number | null = null;

  const clear = (): void => {
    if (pendingTimer !== null) window.clearTimeout(pendingTimer);
    pendingTimer = null;
    completedRequests = 0;
  };

  return {
    request: (rebuild) => {
      // One plan-denied handle contributes one deadline. Coalesce defensively
      // so duplicate close notifications cannot advance the ladder or create
      // two owner rebuilds.
      if (pendingTimer !== null) return;
      const delayMs = delayForAttempt(completedRequests);
      completedRequests += 1;
      if (delayMs === 0) {
        rebuild();
        return;
      }
      pendingTimer = window.setTimeout(() => {
        pendingTimer = null;
        rebuild();
      }, delayMs);
    },
    markHealthy: clear,
    cancel: clear,
  };
}
