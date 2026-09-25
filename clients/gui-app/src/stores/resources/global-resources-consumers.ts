import { useSyncExternalStore } from "react";

/**
 * How many global resource consumers are mounted right now - the resource
 * monitor's panel or a live readout, each through its
 * `GlobalResourcesStreamMount`.
 *
 * Counted separately from the registry's global lease because the two answer
 * different questions. The lease says a global STREAM is open; this says
 * something on screen wants global numbers, which stays true when the host
 * cannot serve a global stream at all - the one case where somebody else (the
 * per-epic fallback) has to supply them.
 */
let consumers = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of Array.from(listeners)) listener();
}

/** Registers one consumer; returns its release. */
export function holdGlobalResourcesConsumer(): () => void {
  consumers += 1;
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    consumers -= 1;
    notify();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function hasConsumer(): boolean {
  return consumers > 0;
}

export function useGlobalResourcesConsumerPresent(): boolean {
  return useSyncExternalStore(subscribe, hasConsumer, hasConsumer);
}
