import { appLogger } from "@/lib/logger";

/**
 * Renderer wake / reconnect signal.
 *
 * After an OS sleep/wake (laptop lid close → open), the renderer's host stream
 * can drop (the live request context the host needs to mint cloud tokens goes
 * with it), and it would otherwise wait out the full pong timeout (~60s) before
 * re-subscribing. The `window` `online` event fires when the network returns on
 * wake, so subscribers (the host stream providers) re-dial their streams then,
 * which makes the host re-run its subscribe handler and re-register the live
 * request context promptly.
 *
 * We listen to `online` ONLY - NOT `visibilitychange`. `visibilitychange` fires
 * on every ordinary app-switch (window hidden → shown) with no actual
 * disconnect, so reconnecting on it needlessly tears down a healthy stream and
 * flashes a "reconnecting" status. `online` only fires on a real network
 * transition, which is the signal we actually want. Cross-platform: works in the
 * desktop shell and the web app with no Electron IPC.
 *
 * A short debounce coalesces a burst of `online` events into one notification.
 */

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
 * Registers `listener` to run shortly after the network returns (the device
 * waking from sleep is the load-bearing case). Returns an unsubscribe function.
 * The DOM listener is installed lazily on first subscription and shared across
 * all subscribers.
 */
export function onWakeReconnect(listener: WakeListener): () => void {
  ensureInstalled();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
