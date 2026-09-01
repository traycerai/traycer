/**
 * Extra OWNER-level delay after a plan-restricted transport reaches its own
 * reprobe deadline. The transport cache already waits before it permits a new
 * remote session; this ladder prevents a host that keeps denying the plan from
 * rebuilding the whole Epic session at every cache deadline forever.
 *
 * Requests are owned by the handle that observed the denial. One handle may
 * claim at most one ladder attempt, including the synchronous first attempt.
 * When a replacement handle is denied while a delayed attempt is pending, its
 * callback takes over that timer; a retired handle must never strand the live
 * one by keeping the only scheduled callback.
 */
export const PLAN_RESTRICTED_SESSION_REBUILD_INITIAL_BACKOFF_MS = 60_000;
export const PLAN_RESTRICTED_SESSION_REBUILD_MAX_BACKOFF_MS = 15 * 60_000;

export interface PlanRestrictedSessionRebuildBackoff {
  /**
   * Runs the first owner's rebuild immediately, then delays distinct
   * replacement owners. `owner` must remain stable for that handle's lifetime.
   */
  readonly request: (owner: object, rebuild: () => void) => void;
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
  let claimedAttempts = 0;
  let attemptedOwners = new WeakSet<object>();
  let pendingTimer: number | null = null;
  let pendingRebuild: (() => void) | null = null;

  const clear = (): void => {
    if (pendingTimer !== null) window.clearTimeout(pendingTimer);
    pendingTimer = null;
    pendingRebuild = null;
    claimedAttempts = 0;
    attemptedOwners = new WeakSet<object>();
  };

  return {
    request: (owner, rebuild) => {
      // Remember the owner even when attempt zero runs synchronously. Without
      // this, a duplicate close notification from that retired handle can arm
      // attempt one with a callback that will be inert by the time it fires.
      if (attemptedOwners.has(owner)) return;
      attemptedOwners.add(owner);

      if (pendingTimer !== null) {
        // A replacement handle reached its own denial before the current rung
        // fired. Keep the rung/deadline, but hand ownership to the live handle
        // instead of dropping its request behind a retired callback.
        pendingRebuild = rebuild;
        return;
      }

      const delayMs = delayForAttempt(claimedAttempts);
      claimedAttempts += 1;
      if (delayMs === 0) {
        rebuild();
        return;
      }
      pendingRebuild = rebuild;
      pendingTimer = window.setTimeout(() => {
        pendingTimer = null;
        const rebuildForLatestOwner = pendingRebuild;
        pendingRebuild = null;
        rebuildForLatestOwner?.();
      }, delayMs);
    },
    markHealthy: clear,
    cancel: clear,
  };
}
