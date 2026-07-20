import type { IpcHostController } from "../ipc/runner-ipc-bridge";

// Bridges `HostController.recoverIfDown()` (the health monitor's automatic
// recovery intent) to `startHostHealthMonitor`'s `respawn: () => Promise<void>`
// contract. Kept in its own Electron-free module (like `host-wake-recovery.ts`)
// so this classification is directly unit-testable through the same function
// the monitor calls, rather than only reachable by driving the whole Electron
// boot sequence.
//
// Fixup B3 (lock-contention terminal contract, automatic-intent class):
// `recoverIfDown` resolves "deferred" for lock-contention (`E_CLI_LOCK_BUSY`)
// and for a removed-by-user host - both are expected, self-healing conditions
// for a background watchdog (the next tick retries, or the host stays
// intentionally absent), not a failed recovery attempt. Treating "deferred"
// as a thrown failure - the prior behavior - logged an "auto-recovery attempt
// failed" warning on every tick until the contention cleared, exactly the
// noisy manual-style surfacing the automatic-intent policy exists to avoid.
export async function respawnIfDown(
  hostController: IpcHostController,
): Promise<void> {
  const outcome = await hostController.recoverIfDown();
  if (
    outcome.kind === "ok" ||
    outcome.kind === "suppressed" ||
    outcome.kind === "deferred"
  ) {
    return;
  }
  throw new Error(outcome.message);
}
