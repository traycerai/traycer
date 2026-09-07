import { appLogger } from "@/lib/logger";

/** Renderer wake / reconnect signal. */

const WAKE_DEBOUNCE_MS = 250;

type WakeListener = () => void;

const listeners = new Set<WakeListener>();
let installed = false;
let debounceHandle: number | null = null;

function notifyWake(): void {
  if (debounceHandle !== null) {
    // A notify is already pending; coalesce this signal into it.
    return;
  }
  debounceHandle = window.setTimeout(() => {
    debounceHandle = null;
    for (const listener of Array.from(listeners)) {
      try {
        listener();
      } catch (error) {
        appLogger.error("[wake-reconnect] listener failed", {}, error);
        // A failing subscriber must not block the others.
      }
    }
  }, WAKE_DEBOUNCE_MS);
}

function ensureInstalled(): void {
  if (installed || typeof window === "undefined") {
    return;
  }
  installed = true;
  window.addEventListener("online", notifyWake);
}

/**
 * Registers `listener` to run shortly after the network returns (the device waking from sleep is the load-bearing case).
 * Returns an unsubscribe function.
 */
export function onWakeReconnect(listener: WakeListener): () => void {
  ensureInstalled();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
