import { useSyncExternalStore } from "react";

/**
 * The one-shot "connect this" that travels from an explicit open (a sidebar
 * row, the open menu, the switcher, the inventory's other rows) to the tile
 * it placed. A row click already says "boot this", so the tile must not ask
 * again with "Boot and connect"; but the request is NOT part of the tile ref,
 * because a ref is persisted and a tile restored after a reload must not
 * start a boot by merely reappearing.
 *
 * Keyed by tile id (host + simulator), so a click on a row whose tile is
 * already open reaches that tile. Consumed once by whoever handles it: the
 * inventory gate connects, a tile already live drops it.
 */

const requests = new Map<string, number>();
const listeners = new Set<() => void>();
let nextNonce = 1;

function notify(): void {
  for (const listener of listeners) listener();
}

export function requestSimulatorConnect(tileId: string): void {
  requests.set(tileId, nextNonce++);
  notify();
}

/** The pending request's nonce for `tileId`, or null. */
export function pendingSimulatorConnectRequest(tileId: string): number | null {
  return requests.get(tileId) ?? null;
}

/** Consumes the request `nonce` for `tileId`; false when it was already taken or superseded. */
export function takeSimulatorConnectRequest(
  tileId: string,
  nonce: number,
): boolean {
  if (requests.get(tileId) !== nonce) return false;
  requests.delete(tileId);
  notify();
  return true;
}

export function subscribeSimulatorConnectRequests(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePendingSimulatorConnectRequest(
  tileId: string,
): number | null {
  return useSyncExternalStore(
    subscribeSimulatorConnectRequests,
    () => pendingSimulatorConnectRequest(tileId),
    () => null,
  );
}

/** Test seam. */
export function resetSimulatorConnectRequestsForTests(): void {
  requests.clear();
  notify();
}
