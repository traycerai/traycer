import { log } from "../app/logger";
import type {
  ConvergeReadyOk,
  MutationOutcome,
  PendingRevisionCaller,
} from "./host-controller-types";


const PENDING_REVISION_POLL_INTERVAL_MS = 30_000;
// After the budget is spent the marker stays on disk for the next launch's single `convergeReady` attempt.
const MAX_REFRESH_ATTEMPTS_WITHOUT_SUCCESS = 3;

export interface PendingLoginItemRevisionMonitorHostController {
  applyPendingLoginItemRevisionIfIdle(
    caller: PendingRevisionCaller,
  ): Promise<MutationOutcome<ConvergeReadyOk> | null>;
  isPendingRevisionRefreshQuarantined(): boolean;
}

export interface PendingLoginItemRevisionMonitorDeps {
  readonly hostController: PendingLoginItemRevisionMonitorHostController;
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
        await deps.hostController.applyPendingLoginItemRevisionIfIdle(
          "outside-lane",
        );
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
