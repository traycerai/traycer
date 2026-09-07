import type { IpcHostController } from "../ipc/runner-ipc-bridge";
import { HOST_REMOVED_BY_USER_MESSAGE } from "../host/host-controller-types";

export class HostRecoveryDeferredError extends Error {
  constructor() {
    super("Host recovery deferred while another Traycer process owns the lock");
  }
}

// The latter is terminal for automatic recovery; the former must re-arm the monitor after its snapshot was demoted.
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
    throw new HostRecoveryDeferredError();
  }
  throw new Error(outcome.message);
}
