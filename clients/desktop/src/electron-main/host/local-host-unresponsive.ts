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
 * it was made for is still the published one and still not answering.
 * Registered by whoever started the monitor; `null` while none runs.
 */
type StillUnresponsiveCheck = (
  offer: LocalHostUnresponsiveOffer,
) => Promise<boolean>;

let stillUnresponsiveCheck: StillUnresponsiveCheck | null = null;

export function setLocalHostStillUnresponsiveCheck(
  check: StillUnresponsiveCheck | null,
): void {
  stillUnresponsiveCheck = check;
}

/**
 * Whether the force restart this offer made may still go ahead: the verdict
 * still is that offer, and a fresh look agrees the host it was made for is
 * still published and does not answer. False when no monitor runs, since
 * nothing then vouches for the verdict.
 */
export async function confirmLocalHostStillUnresponsive(
  offer: LocalHostUnresponsiveOffer,
): Promise<boolean> {
  if (
    current?.pid !== offer.pid ||
    current.offerId !== offer.offerId ||
    stillUnresponsiveCheck === null
  ) {
    return false;
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
