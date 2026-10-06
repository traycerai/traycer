import { log } from "../app/logger";
import type {
  ActivateInstalledOk,
  HostControllerStatus,
  MutationOutcome,
} from "./host-controller-types";
import type { HostBusyVerdict } from "./host-state";

// "Restart when idle" for an installed update whose restart found the host
// busy. Without it the busy dialog's only two answers are Force restart, which
// ends the work, and Defer, which schedules nothing: the next automatic
// attempt is the single idle-gated one the NEXT app launch makes
// (`host-launch-converge.ts`), so a person who never quits the app keeps
// running the old host.
//
// Modeled on `pending-login-item-revision-monitor.ts`: this module owns the
// interval, the failure budget and the armed flag, and nothing else. The
// restart itself is the controller's existing idle-gated
// `activateInstalled(false, false)`, the exact call the launch reconcile
// makes, so it re-probes busy under its own lock and never promotes a stage.
//
// Armed in memory only. An app relaunch drops the arm and makes the launch
// attempt instead, which is the same idle-gated activation.

const PENDING_ACTIVATION_POLL_INTERVAL_MS = 30_000;
// Covers attempts that THREW or settled as anything but `ok` / `busy`. A host
// that is still busy is the state this monitor exists to wait out and never
// spends it. After the budget is spent the activation debt is still on disk
// for the next launch's attempt.
const MAX_ATTEMPTS_WITHOUT_SUCCESS = 3;

const NOTHING_PENDING: MutationOutcome<ActivateInstalledOk> = {
  kind: "ok",
  value: { activated: false },
};

const STILL_BUSY: MutationOutcome<ActivateInstalledOk> = {
  kind: "busy",
  continuation: "activate",
  message:
    "The update was installed, but the host has work in progress; it will restart when that work finishes.",
};

/**
 * Narrow structural surface this monitor depends on - not the full
 * `IpcHostController` - so tests can pin exactly these two calls.
 */
export interface PendingActivationIdleMonitorHostController {
  getStatus(): Promise<HostControllerStatus>;
  activateInstalled(
    force: boolean,
    promoteReadyStage: boolean,
  ): Promise<MutationOutcome<ActivateInstalledOk>>;
}

export interface PendingActivationIdleMonitorDeps {
  readonly hostController: PendingActivationIdleMonitorHostController;
  /**
   * The cheap loopback busy read, asked BEFORE the activation: a non-forced
   * `activateInstalled` reconciles the registry first, which is a CLI
   * subprocess and a network request this monitor must not make every 30
   * seconds for as long as the host stays busy.
   */
  readonly probeHostBusy: () => Promise<HostBusyVerdict>;
  /** Test seam; production callers pass undefined. */
  readonly intervalMs: number | undefined;
}

export interface PendingActivationIdleMonitor {
  /**
   * Attempts the idle-gated activation now and resolves its outcome. A `busy`
   * outcome leaves the monitor armed: it retries on its interval until the
   * activation lands, nothing is pending any more, or the budget is spent.
   * Every other outcome leaves it disarmed.
   */
  arm(): Promise<MutationOutcome<ActivateInstalledOk>>;
  /** Stops retrying. A Force restart calls this: it supersedes the wait. */
  disarm(): void;
  dispose(): void;
}

function activationPending(status: HostControllerStatus): boolean {
  // The launch reconcile's own gate. Activating a host that carries no debt
  // would restart it for nothing.
  return (
    !status.removedByUser &&
    (status.activation === "pendingActivation" ||
      status.activation === "activationUnknown")
  );
}

export function createPendingActivationIdleMonitor(
  deps: PendingActivationIdleMonitorDeps,
): PendingActivationIdleMonitor {
  let timer: NodeJS.Timeout | null = null;
  let ticking = false;
  let disposed = false;
  let failedAttempts = 0;
  // Bumped by every arm and disarm, so an attempt that settles after either
  // cannot act on an arm it no longer belongs to.
  let generation = 0;

  const stop = (): void => {
    generation += 1;
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };

  const attempt = async (): Promise<MutationOutcome<ActivateInstalledOk>> => {
    const status = await deps.hostController.getStatus();
    if (!activationPending(status)) return NOTHING_PENDING;
    if ((await deps.probeHostBusy()) === "busy") return STILL_BUSY;
    return deps.hostController.activateInstalled(false, false);
  };

  const tick = async (): Promise<void> => {
    // A tick that outlives its interval must not stack a second one.
    if (ticking || timer === null) return;
    ticking = true;
    const armed = generation;
    try {
      const outcome = await attempt();
      if (armed !== generation) return;
      if (outcome.kind === "busy") return;
      if (outcome.kind !== "ok") {
        throw new Error(outcome.message);
      }
      stop();
      log.info(
        "[pending-activation-idle-monitor] activation settled - stopping",
        { activated: outcome.value.activated },
      );
    } catch (err) {
      if (armed !== generation) return;
      failedAttempts += 1;
      if (failedAttempts >= MAX_ATTEMPTS_WITHOUT_SUCCESS) {
        stop();
        log.warn(
          "[pending-activation-idle-monitor] attempt budget exhausted - stopping; the next launch retries the activation",
          { failedAttempts, err },
        );
      } else {
        log.warn("[pending-activation-idle-monitor] attempt failed", {
          failedAttempts,
          err,
        });
      }
    } finally {
      ticking = false;
    }
  };

  return {
    arm: async () => {
      stop();
      failedAttempts = 0;
      const armed = generation;
      const outcome = await attempt();
      if (outcome.kind !== "busy" || disposed || armed !== generation) {
        return outcome;
      }
      timer = setInterval(() => {
        void tick();
      }, deps.intervalMs ?? PENDING_ACTIVATION_POLL_INTERVAL_MS);
      // This monitor must never be what keeps the Electron main process alive.
      timer.unref();
      log.info(
        "[pending-activation-idle-monitor] host busy - will restart it when idle",
      );
      return outcome;
    },
    disarm: stop,
    dispose: () => {
      disposed = true;
      stop();
    },
  };
}
