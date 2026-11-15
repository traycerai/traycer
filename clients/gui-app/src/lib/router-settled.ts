/**
 * Starting a router load while another is in flight is unsafe on this
 * router-core version. The later load reuses the in-flight load's matches,
 * and their `_nonReactive` with them: when one load finishes a match it
 * clears that match's shared `loadPromise`, and a match still drawn pending
 * suspends on the cleared promise and throws `undefined`, which
 * `CatchBoundary` lets through to the root error boundary. The superseded
 * load is not dropped (it awaits the latest), so the router does settle; the
 * hazard is the throw.
 *
 * Every caller that would start a load on its own initiative goes through
 * {@link runWhenRouterSettled}, so on one router no such load starts under
 * another.
 *
 * A wait lasts as long as the load in flight. This app's route guards and
 * loaders are synchronous, so a load stays pending only while a route's
 * code-split chunk has not arrived; one that fails settles the load as an
 * error. A chunk that never answers would hold the router itself on its
 * pending screen, and every queued task with it: no timer cuts that short,
 * so a caller withdraws what must not stay on screen before it queues the
 * navigation, and queues only the navigation.
 *
 * A task that throws is written to the app's error log (`appLogger.error`:
 * the console, and in the desktop build `traycer-desktop.log`) and the
 * tasks behind it still run. It reaches neither the root error boundary nor
 * its crash report, where a throw from the same work inside a React effect
 * went before this queue existed.
 */
import { appLogger } from "@/lib/logger";

export interface SettlingRouter {
  readonly state: { readonly status: "pending" | "idle" };
  subscribe: (eventType: "onResolved", fn: () => void) => () => void;
}

interface SettleQueue {
  readonly tasks: Array<() => void>;
  disarm: (() => void) | null;
  /** A drain is queued for after the `onResolved` that armed it. */
  scheduled: boolean;
}

const queues = new WeakMap<SettlingRouter, SettleQueue>();

function queueFor(router: SettlingRouter): SettleQueue {
  const existing = queues.get(router);
  if (existing !== undefined) return existing;
  const created: SettleQueue = { tasks: [], disarm: null, scheduled: false };
  queues.set(router, created);
  return created;
}

function drain(router: SettlingRouter, queue: SettleQueue): void {
  while (queue.disarm === null && !queue.scheduled) {
    const next = queue.tasks.shift();
    if (next === undefined) return;
    if (router.state.status === "pending") {
      queue.tasks.unshift(next);
      queue.disarm = router.subscribe("onResolved", () => {
        queue.disarm?.();
        queue.disarm = null;
        // The Transitioner emits `onResolved` BEFORE it sets `status:
        // "idle"`, in the same layout effect. A load started inside this
        // listener would be stamped idle while it runs, so it goes after
        // that write. Until then a task given from another `onResolved`
        // listener only joins the queue.
        queue.scheduled = true;
        queueMicrotask(() => {
          queue.scheduled = false;
          drain(router, queue);
        });
      });
      return;
    }
    // A task that starts a load leaves the router pending, so the next one
    // waits for that load to resolve. A task that throws is reported and
    // strands nothing behind it.
    try {
      next();
    } catch (error) {
      appLogger.error(
        "[router] a task waiting for the router threw",
        {},
        error,
      );
    }
  }
}

/**
 * Runs `task` once `router` has no load in flight: at once when it has
 * none, otherwise after the in-flight load resolves. Tasks on one router run
 * in the order they were given, each after any load the one before it
 * started has resolved. Answers a cancel, which drops the task if it has not
 * run.
 */
export function runWhenRouterSettled(
  router: SettlingRouter,
  task: () => void,
): () => void {
  const queue = queueFor(router);
  let cancelled = false;
  const entry = (): void => {
    if (!cancelled) task();
  };
  queue.tasks.push(entry);
  drain(router, queue);
  return () => {
    cancelled = true;
    const index = queue.tasks.indexOf(entry);
    if (index !== -1) queue.tasks.splice(index, 1);
    if (queue.tasks.length === 0) {
      queue.disarm?.();
      queue.disarm = null;
    }
  };
}
