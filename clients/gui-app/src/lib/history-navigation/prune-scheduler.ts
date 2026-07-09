import type { PersistentHistoryController } from "@/lib/persistent-history";
import { isHistoryEntryDead } from "@/lib/history-navigation/liveness";

export interface PruneSchedulerOptions {
  /**
   * Reads the CURRENT router-history controller (or `null` outside Electron).
   * Re-read at execution time so the scheduler always prunes the live history,
   * never a captured singleton. A `null` result makes the prune a no-op.
   */
  readonly getController: () => PersistentHistoryController | null;
  /**
   * Subscribes to the backing stores whose mutations can render a history entry
   * dead (canvas tabs + landing drafts). Receives the scheduler's "schedule a
   * prune" callback and MUST return an unsubscribe function. The scheduler
   * calls it once at install and the returned function once at uninstall.
   */
  readonly subscribeStores: (onChange: () => void) => () => void;
  /**
   * `true` while a router load/navigation is in progress. The scheduler skips
   * pruning then (store mutations and the explicit replacement navigation often
   * land in the same user action, e.g. close-tab → navigate-next) and re-tries
   * on the next frame once the load settles (tech plan §3.3).
   */
  readonly isLoadInFlight: () => boolean;
}

/**
 * PURE installer for the load-free prune scheduler. It does NOT mount itself —
 * the prune-lifecycle ticket calls this once the canvas + draft stores have
 * hydrated and the router has mounted, wiring `getController`,
 * `subscribeStores`, and `isLoadInFlight` to the live app.
 *
 * Behavior (tech plan §3.3):
 * - **Coalesce**: a burst of store mutations schedules at most one pending
 *   prune (one animation frame, microtask fallback when rAF is unavailable).
 * - **Single-flight**: never re-enters a prune that is already running.
 * - **Skip while loading**: defers to the next frame while `isLoadInFlight()`,
 *   instead of dropping the request.
 * - **Re-read at execution**: passes `isHistoryEntryDead` straight to
 *   `controller.prune`, so href liveness is evaluated against the live stores
 *   at flush time, not at schedule time.
 *
 * Returns an uninstall function that unsubscribes from the stores and cancels
 * any pending prune.
 */
export function installPruneScheduler(
  options: PruneSchedulerOptions,
): () => void {
  const { getController, subscribeStores, isLoadInFlight } = options;

  let pending = false;
  let running = false;
  let uninstalled = false;
  let cancelScheduled: (() => void) | null = null;

  const flush = () => {
    cancelScheduled = null;
    pending = false;
    if (uninstalled) {
      return;
    }
    if (running) {
      return;
    }
    // A router load is mid-flight; re-try next frame rather than prune against a
    // half-applied navigation. Loads settle in a handful of frames, so this is
    // bounded (one callback per frame), never a tight loop.
    if (isLoadInFlight()) {
      schedule();
      return;
    }
    const controller = getController();
    if (controller === null) {
      return;
    }
    running = true;
    // `finally` (not `catch`) so a throw still re-arms the single-flight gate:
    // leaving `running` stuck `true` would silently disable pruning for the rest
    // of the session. The error itself is left to propagate to the host handler.
    try {
      controller.prune(isHistoryEntryDead);
    } finally {
      running = false;
    }
  };

  const schedule = () => {
    if (uninstalled || pending) return;
    pending = true;
    cancelScheduled = scheduleFlush(flush);
  };

  const unsubscribe = subscribeStores(schedule);

  return () => {
    uninstalled = true;
    unsubscribe();
    if (cancelScheduled !== null) {
      cancelScheduled();
      cancelScheduled = null;
    }
    pending = false;
  };
}

/**
 * Schedule `callback` on the next animation frame, falling back to a microtask
 * when `requestAnimationFrame` is unavailable (non-DOM environments). Returns a
 * canceller; the microtask fallback guards a flag instead of cancelling the
 * already-queued microtask.
 */
function scheduleFlush(callback: () => void): () => void {
  if (typeof requestAnimationFrame === "function") {
    const handle = requestAnimationFrame(() => {
      callback();
    });
    return () => {
      cancelAnimationFrame(handle);
    };
  }
  let cancelled = false;
  queueMicrotask(() => {
    if (cancelled) return;
    callback();
  });
  return () => {
    cancelled = true;
  };
}
