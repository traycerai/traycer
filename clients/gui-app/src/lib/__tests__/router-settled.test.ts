import { afterEach, describe, expect, it, vi } from "vitest";
import { appLogger } from "@/lib/logger";
import {
  runWhenRouterSettled,
  type SettlingRouter,
} from "@/lib/router-settled";

/**
 * `runWhenRouterSettled` against a scripted router: the real router-core
 * behaviour behind it is pinned in `reload-restore-loads.integration.test.tsx`.
 */

interface ScriptedRouter {
  readonly router: SettlingRouter;
  /** Starts a load: what a task that navigates or invalidates does. */
  readonly startLoad: () => void;
  /** Emits `onResolved` the way the Transitioner does: status still pending. */
  readonly resolve: () => void;
  readonly listenerCount: () => number;
}

function scriptedRouter(status: "pending" | "idle"): ScriptedRouter {
  const state: { status: "pending" | "idle" } = { status };
  const listeners = new Set<() => void>();
  return {
    router: {
      state,
      subscribe: (_eventType, fn) => {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
    },
    startLoad: () => {
      state.status = "pending";
    },
    resolve: () => {
      // A `Set` visits a listener added while it iterates, as router-core's
      // `emit` does.
      for (const listener of listeners) listener();
      state.status = "idle";
    },
    listenerCount: () => listeners.size,
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    queueMicrotask(resolve);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runWhenRouterSettled", () => {
  it("runs the tasks two callers gave in the order given, each after the load the one before it started", async () => {
    const { router, startLoad, resolve } = scriptedRouter("pending");
    const ran: Array<string> = [];
    runWhenRouterSettled(router, () => {
      ran.push("replay");
      startLoad();
    });
    runWhenRouterSettled(router, () => {
      ran.push("invalidate");
    });

    resolve();
    await flushMicrotasks();
    expect(ran).toEqual(["replay"]);

    resolve();
    await flushMicrotasks();
    expect(ran).toEqual(["replay", "invalidate"]);
  });

  it("skips a cancelled task and runs the rest in order", async () => {
    const { router, resolve, listenerCount } = scriptedRouter("pending");
    const ran: Array<string> = [];
    runWhenRouterSettled(router, () => ran.push("first"));
    const cancel = runWhenRouterSettled(router, () => ran.push("cancelled"));
    runWhenRouterSettled(router, () => ran.push("last"));

    cancel();
    resolve();
    await flushMicrotasks();

    expect(ran).toEqual(["first", "last"]);
    expect(listenerCount()).toBe(0);
  });

  it("reports a task that throws and still runs every task behind it", async () => {
    const errors = vi.spyOn(appLogger, "error").mockImplementation(() => {});
    const { router, resolve } = scriptedRouter("pending");
    const fault = new Error("quota exceeded");
    const ran: Array<string> = [];
    runWhenRouterSettled(router, () => {
      throw fault;
    });
    runWhenRouterSettled(router, () => ran.push("behind"));

    resolve();
    await flushMicrotasks();

    expect(ran).toEqual(["behind"]);
    expect(errors).toHaveBeenCalledWith(
      "[router] a task waiting for the router threw",
      {},
      fault,
    );
    // Nothing is left armed: a later task runs at once on the idle router.
    runWhenRouterSettled(router, () => ran.push("later"));
    expect(ran).toEqual(["behind", "later"]);
  });

  it("runs a task given from another onResolved listener after the router is idle, not a load later", async () => {
    const { router, resolve } = scriptedRouter("pending");
    const ran: Array<string> = [];
    runWhenRouterSettled(router, () => ran.push("queued"));
    router.subscribe("onResolved", () => {
      runWhenRouterSettled(router, () => ran.push("from a listener"));
    });

    resolve();
    expect(ran).toEqual([]);
    await flushMicrotasks();

    expect(ran).toEqual(["queued", "from a listener"]);
  });
});
