import type { IpcHostController } from "../ipc/runner-ipc-bridge";
import {
  HOST_NOT_SERVICE_RUN_MESSAGE,
  HOST_REMOVED_BY_USER_MESSAGE,
  isServiceTaskNotOwnedMessage,
} from "../host/host-controller-types";

export class HostRecoveryDeferredError extends Error {
  constructor() {
    super("Host recovery deferred while another Traycer process owns the lock");
  }
}

/**
 * The recovery's restart was refused because the running host is a person's
 * `traycer host start` in a terminal (`E_HOST_NOT_SERVICE_RUN`): present, and
 * not this app's. Nothing was touched, and nothing this app does will change
 * that until the terminal run ends, so the monitor stops asking.
 */
export class HostRecoveryNotServiceRunError extends Error {
  constructor() {
    super("Host recovery refused: a host started in a terminal is running");
  }
}

/**
 * The recovery was refused because the host's Scheduled Task is not this
 * account's - another Windows user's, or one whose owner could not be
 * confirmed (`E_SERVICE_TASK_NOT_OWNED`): nothing was touched, and nothing
 * this app does will make it this account's, so the monitor retires its
 * recovery for the session. A relaunch asks again.
 */
export class HostRecoveryTaskNotOwnedError extends Error {
  constructor() {
    super("Host recovery refused: the host's task is not this account's");
  }
}

// Bridges `HostController.recoverIfDown()` (the health monitor's automatic
// recovery intent) to `startHostHealthMonitor`'s `respawn: () => Promise<void>`
// contract. Kept in its own Electron-free module (like `host-wake-recovery.ts`)
// so this classification is directly unit-testable through the same function
// the monitor calls, rather than only reachable by driving the whole Electron
// boot sequence.
//
// Fixup B3 (lock-contention terminal contract, automatic-intent class):
// `recoverIfDown` resolves "deferred" for lock-contention (`E_CLI_LOCK_BUSY`)
// and for a removed-by-user host. The latter is terminal for automatic
// recovery; the former must re-arm the monitor after its snapshot was
// demoted. A distinct error lets the monitor preserve that retry ownership
// without logging expected lock contention as a generic recovery failure.
//
// It also resolves "deferred" when the host is a terminal's `traycer host
// start` (`HOST_NOT_SERVICE_RUN_MESSAGE`). That one is neither terminal nor
// retryable: the monitor leaves the run alone until it is gone, so it gets its
// own error.
//
// And when the host's Scheduled Task is not this account's - another Windows
// user's, or one whose owner could not be confirmed
// (`isServiceTaskNotOwnedMessage`): terminal - this account has no service
// host on this PC until that changes, and re-asking every tick
// would only spawn a refused CLI. Its own error, because returning would read
// as a recovery that worked and leave the monitor asking again.
export async function respawnIfDown(
  hostController: IpcHostController,
): Promise<void> {
  const outcome = await hostController.recoverIfDown();
  if (outcome.kind === "ok") {
    return;
  }
  // A caller cannot infer that an arbitrary in-flight mutation will reload
  // the lifecycle (register-service, for example, does not). Keep monitor
  // ownership until its own reload observes a reachable snapshot.
  if (outcome.kind === "suppressed") {
    throw new HostRecoveryDeferredError();
  }
  if (outcome.kind === "deferred") {
    if (outcome.message === HOST_REMOVED_BY_USER_MESSAGE) return;
    if (isServiceTaskNotOwnedMessage(outcome.message)) {
      throw new HostRecoveryTaskNotOwnedError();
    }
    if (outcome.message === HOST_NOT_SERVICE_RUN_MESSAGE) {
      throw new HostRecoveryNotServiceRunError();
    }
    throw new HostRecoveryDeferredError();
  }
  throw new Error(outcome.message);
}
