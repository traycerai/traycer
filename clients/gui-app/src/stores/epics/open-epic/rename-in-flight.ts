/**
 * Which nodes have an optimistic rename in flight, keyed by epic and node.
 *
 * The open-epic store's `beginRenameMutation` patches the published
 * projection with the requested title before the rename RPC settles, and
 * `retirePendingMutation("failed")` rolls that patch back. A reader that
 * PERSISTS a projected title (the canvas tab strip's name-snapshot
 * write-through) must not persist the optimistic one: a rejected rename has
 * no rollback path through a snapshot, so the refused title would resurface
 * from a cold render. The store marks a node here for the whole window - from
 * before the stamp is sent until the outcome is applied - and the
 * write-through holds while the mark is set.
 *
 * The map is read only through {@link useRenameInFlight}; the store is its
 * only writer.
 */
import { useSyncExternalStore } from "react";

const inFlightByKey = new Map<string, number>();
const listeners = new Set<() => void>();

function keyOf(epicId: string, nodeId: string): string {
  return `${epicId}\u0000${nodeId}`;
}

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Mark a rename in flight for `nodeId`. Returns the release, which is
 * idempotent: a release called twice counts once.
 */
export function markRenameInFlight(epicId: string, nodeId: string): () => void {
  const key = keyOf(epicId, nodeId);
  inFlightByKey.set(key, (inFlightByKey.get(key) ?? 0) + 1);
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = inFlightByKey.get(key) ?? 0;
    if (count <= 1) {
      inFlightByKey.delete(key);
    } else {
      inFlightByKey.set(key, count - 1);
    }
    notify();
  };
}

export function isRenameInFlight(epicId: string, nodeId: string): boolean {
  return inFlightByKey.has(keyOf(epicId, nodeId));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether `nodeId` has a rename whose outcome the store has not applied yet. */
export function useRenameInFlight(epicId: string, nodeId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isRenameInFlight(epicId, nodeId),
    () => false,
  );
}
