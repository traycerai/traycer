import { log } from "../app/logger";

const WAKE_RECOVERY_REFRESH_DELAYS_MS = [0, 250, 1_000, 3_000] as const;

export interface HostWakeRecoveryTarget {
  ensureWatcherInstalled(): void;
  // Wake recovery only awaits the refresh for its side effect (re-emit the
  // snapshot); the derived snapshot it returns is intentionally ignored here.
  reloadSnapshotFromDisk(): Promise<unknown>;
}

export interface PowerMonitorWakeHandlers {
  readonly onSuspend: () => void;
  readonly onResume: () => void;
  readonly onUnlockScreen: () => void;
}

export type PowerMonitorWakeInstaller = (
  handlers: PowerMonitorWakeHandlers,
) => void;

/**
 * Wires OS wake handling through a SINGLE `powerMonitor` registration: on
 * resume it refreshes the host pid snapshot AND fires `onWake` (the renderer
 * fan-out), and on screen-unlock it fires `onWake` again (the user-visible
 * moment when lock-on-sleep was in play). Folding the renderer notification in
 * here avoids a second `installPowerMonitorListeners` call that would
 * double-register every power event.
 */
export function installHostWakeRecovery(
  host: HostWakeRecoveryTarget,
  install: PowerMonitorWakeInstaller,
  onWake: () => void,
): void {
  install({
    onSuspend: () => log.info("[desktop] pausing on system suspend"),
    onResume: () => {
      log.info("[desktop] resuming after system wake");
      onWake();
      void refreshHostAfterWake(host);
    },
    onUnlockScreen: () => onWake(),
  });
}

export async function refreshHostAfterWake(
  host: HostWakeRecoveryTarget,
): Promise<void> {
  host.ensureWatcherInstalled();
  for (const delayMs of WAKE_RECOVERY_REFRESH_DELAYS_MS) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    try {
      await host.reloadSnapshotFromDisk();
    } catch (error) {
      log.warn("[desktop] host wake refresh failed", error);
    }
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
