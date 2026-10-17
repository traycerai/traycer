import type { LocalHostUnresponsive } from "../../ipc-contracts/host-types";

/**
 * The health monitor's latest verdict on whether the local host has stopped
 * responding, held for the IPC bridge to push and to answer pulls with.
 *
 * Process-wide, like `appliedLocalHostCapability`: the monitor that writes it
 * starts after bootstrap, while the bridge that reads it is installed before,
 * and neither owns the other.
 */
let current: LocalHostUnresponsive | null = null;
const listeners = new Set<(state: LocalHostUnresponsive | null) => void>();

export function publishLocalHostUnresponsive(
  state: LocalHostUnresponsive | null,
): void {
  if (current === null && state === null) return;
  current = state;
  for (const listener of listeners) listener(state);
}

export function readLocalHostUnresponsive(): LocalHostUnresponsive | null {
  return current;
}

/**
 * Asks the health monitor, now, whether the host with this pid is still the
 * published one and still not answering. Registered by whoever started the
 * monitor; `null` while none runs.
 */
let stillUnresponsiveCheck: ((pid: number) => Promise<boolean>) | null = null;

export function setLocalHostStillUnresponsiveCheck(
  check: ((pid: number) => Promise<boolean>) | null,
): void {
  stillUnresponsiveCheck = check;
}

/**
 * Whether a force restart offered for `pid` may still go ahead: the verdict
 * still names that host, and a fresh look agrees it does not answer. False
 * when no monitor runs, since nothing then vouches for the verdict.
 */
export async function confirmLocalHostStillUnresponsive(
  pid: number,
): Promise<boolean> {
  if (current?.pid !== pid || stillUnresponsiveCheck === null) return false;
  return stillUnresponsiveCheck(pid);
}

export function onLocalHostUnresponsiveChange(
  listener: (state: LocalHostUnresponsive | null) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
