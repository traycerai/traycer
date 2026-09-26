import { useCallback, useSyncExternalStore } from "react";

/**
 * How many global resource consumers are mounted right now, per stream host -
 * the resource monitor's panel or a live readout, each through its
 * `GlobalResourcesStreamMount`.
 *
 * Counted separately from the registry's global lease because the two answer
 * different questions. The lease says a global STREAM is open; this says
 * something on screen wants global numbers, which stays true when the host
 * cannot serve a global stream at all - the one case where somebody else (the
 * per-epic fallback) has to supply them.
 *
 * Keyed by the host the consumer's stream binding dials, so a monitor scoped
 * to one machine never asks a pane on another machine for its numbers. `null`
 * is the unbound binding's key, and only ever matches itself.
 */
const consumersByHost = new Map<string | null, number>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of Array.from(listeners)) listener();
}

/** Registers one consumer for `hostId`; returns its release. */
export function holdGlobalResourcesConsumer(hostId: string | null): () => void {
  consumersByHost.set(hostId, (consumersByHost.get(hostId) ?? 0) + 1);
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (consumersByHost.get(hostId) ?? 1) - 1;
    if (remaining > 0) consumersByHost.set(hostId, remaining);
    else consumersByHost.delete(hostId);
    notify();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useGlobalResourcesConsumerPresent(
  hostId: string | null,
): boolean {
  const hasConsumer = useCallback(
    () => (consumersByHost.get(hostId) ?? 0) > 0,
    [hostId],
  );
  return useSyncExternalStore(subscribe, hasConsumer, hasConsumer);
}
