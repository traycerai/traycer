import type { RestartTargetHost } from "@traycer-clients/shared/host-lock/restart-target";
import type {
  LocalHostUnresponsive,
  LocalHostUnresponsiveOffer,
} from "../../ipc-contracts/host-types";

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
 * Asks the health monitor, now, whether this offer is still out and the host
 * it was made for is still the published one and still not answering: that
 * host when so, `null` otherwise. Registered by whoever started the monitor;
 * `null` while none runs.
 */
type StillUnresponsiveCheck = (
  offer: LocalHostUnresponsiveOffer,
) => Promise<RestartTargetHost | null>;

let stillUnresponsiveCheck: StillUnresponsiveCheck | null = null;

export function setLocalHostStillUnresponsiveCheck(
  check: StillUnresponsiveCheck | null,
): void {
  stillUnresponsiveCheck = check;
}

/**
 * The host the force restart this offer made may still stop, or `null` when
 * it may not: the verdict still is that offer, and a fresh look agrees the
 * host it was made for is still published and does not answer. `null` when no
 * monitor runs, since nothing then vouches for the verdict.
 */
export async function confirmLocalHostStillUnresponsive(
  offer: LocalHostUnresponsiveOffer,
): Promise<RestartTargetHost | null> {
  if (
    current?.pid !== offer.pid ||
    current.offerId !== offer.offerId ||
    stillUnresponsiveCheck === null
  ) {
    return null;
  }
  return stillUnresponsiveCheck(offer);
}

export function onLocalHostUnresponsiveChange(
  listener: (state: LocalHostUnresponsive | null) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
