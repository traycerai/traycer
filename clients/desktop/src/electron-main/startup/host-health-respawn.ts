import type { IpcHostController } from "../ipc/runner-ipc-bridge";

export class HostRecoveryDeferredError extends Error {
  constructor() {
    super("Host recovery deferred while another Traycer process owns the lock");
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
export async function respawnIfDown(
  hostController: IpcHostController,
): Promise<void> {
  const outcome = await hostController.recoverIfDown();
  if (outcome.kind === "ok" || outcome.kind === "suppressed") {
    return;
  }
  if (outcome.kind === "deferred") {
    if (outcome.message.includes("removed by the user")) return;
    throw new HostRecoveryDeferredError();
  }
  throw new Error(outcome.message);
}
