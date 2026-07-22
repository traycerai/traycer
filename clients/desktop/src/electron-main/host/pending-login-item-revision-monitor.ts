import { log } from "../app/logger";
import type { ConvergeReadyOk, MutationOutcome } from "./host-controller-types";

// `HostController.convergeReadyPackagedMac`'s already-reachable branch only
// gets a chance to apply a deferred LaunchAgent revision
// (`applyPendingLoginItemRevisionIfIdle`) once per renderer-triggered
// `convergeReady` call - and the renderer's `local-host-gate.tsx` fires that
// exactly once per mount, gated by a ref that never resets. So a marker left
// behind because the host was busy at that single check sits inert for the
// rest of the session; the user would need to fully relaunch the app before
// the refreshed plist (e.g. the 8,192 descriptor limit) ever takes effect.
//
// This monitor closes that gap: it ticks on a bounded interval and hands off
// to `HostController.applyPendingLoginItemRevisionIfIdle()` directly -
// public, not run through the mutation lane, and fully self-locking via the
// desktop cli-lock, so this poll loop and a renderer-triggered ensure can
// never interleave SMAppService cycles. That method already owns every
// precondition (pending marker, reachability, idle probe, quarantine) - this
// monitor only owns the interval, the failure budget, and stopping once the
// controller reports the refresh quarantined for the session.

const PENDING_REVISION_POLL_INTERVAL_MS = 30_000;
// A small bound, not a hot-loop backstop: a refresh cycle that keeps
// throwing isn't going to resolve itself by retrying every 30s - that's a
// Doctor-level problem, not something this background monitor should keep
// hammering. After the budget is spent the marker stays on disk for the next
// launch's single `convergeReady` attempt. This budget covers THROWN
// attempts; a cycle that RESOLVES without applying the refresh (busy, no
// marker, not yet reachable) is not a failure and does not spend it -  only
// `isPendingRevisionRefreshQuarantined()` reporting true is terminal for
// those cases.
const MAX_REFRESH_ATTEMPTS_WITHOUT_SUCCESS = 3;

/**
 * Narrow structural surface this monitor depends on - not the full
 * `IpcHostController` - so tests can pin exactly these two calls without
 * standing up every other `HostController` method.
 */
export interface PendingLoginItemRevisionMonitorHostController {
  applyPendingLoginItemRevisionIfIdle(): Promise<MutationOutcome<ConvergeReadyOk> | null>;
  isPendingRevisionRefreshQuarantined(): boolean;
}

export interface PendingLoginItemRevisionMonitorDeps {
  readonly hostController: PendingLoginItemRevisionMonitorHostController;
  /** Test seam; production callers pass undefined. */
  readonly intervalMs: number | undefined;
}

export interface PendingLoginItemRevisionMonitor {
  dispose(): void;
}

export function startPendingLoginItemRevisionMonitor(
  deps: PendingLoginItemRevisionMonitorDeps,
): PendingLoginItemRevisionMonitor {
  let ticking = false;
  let disposed = false;
  let failedAttempts = 0;
  let budgetExhausted = false;

  const tick = async (): Promise<void> => {
    // A tick that outlives its interval must not stack a second concurrent
    // tick on top of it.
    if (ticking || disposed || budgetExhausted) return;
    // Once the controller has quarantined the refresh for this session
    // (requires-approval pre-flight, or a cycle that ran and did not land
    // enabled), every further attempt would just resolve `null` (nothing to
    // do) - stop ticking rather than churn a no-op call every 30s forever.
    // The marker survives on disk for the next launch's attempt.
    if (deps.hostController.isPendingRevisionRefreshQuarantined()) {
      budgetExhausted = true;
      log.info(
        "[pending-login-item-revision-monitor] refresh quarantined for this session - stopping; the marker will be retried at the next launch",
      );
      return;
    }
    ticking = true;
    try {
      const outcome =
        await deps.hostController.applyPendingLoginItemRevisionIfIdle();
      if (disposed) return;
      if (outcome === null) {
        // Nothing to do this tick (no marker, not reachable, busy, or a
        // desktop-lock contention this tick lost) - not a failure, doesn't
        // spend the budget.
        return;
      }
      if (outcome.kind !== "ok") {
        throw new Error(outcome.message);
      }
      log.info(
        "[pending-login-item-revision-monitor] pending LaunchAgent revision applied",
        { version: outcome.value.version },
      );
      failedAttempts = 0;
    } catch (err) {
      failedAttempts += 1;
      if (failedAttempts >= MAX_REFRESH_ATTEMPTS_WITHOUT_SUCCESS) {
        budgetExhausted = true;
        log.warn(
          "[pending-login-item-revision-monitor] refresh attempt budget exhausted for this session - leaving the marker for the next ensure/relaunch",
          { failedAttempts, err },
        );
      } else {
        log.warn(
          "[pending-login-item-revision-monitor] refresh attempt failed",
          { failedAttempts, err },
        );
      }
    } finally {
      ticking = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, deps.intervalMs ?? PENDING_REVISION_POLL_INTERVAL_MS);
  // This monitor must never be what keeps the Electron main process alive.
  timer.unref();

  return {
    dispose: () => {
      disposed = true;
      clearInterval(timer);
    },
  };
}
