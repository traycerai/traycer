/**
 * The router `useRouter()` answers in a suite that mocks
 * `@tanstack/react-router` with a fixed export list: the part
 * `runWhenRouterSettled` and a refusal's navigation read. It starts idle, on
 * `/`, so a navigation queued behind it runs at once; a suite that needs a load
 * in flight sets `status` to `"pending"` and calls `resolve()`, which emits
 * `onResolved` the way the Transitioner does (still pending) before it writes
 * idle.
 */
export interface ScriptedRouterForTests {
  readonly state: {
    status: "pending" | "idle";
    location: { pathname: string };
  };
  readonly router: {
    readonly state: ScriptedRouterForTests["state"];
    subscribe: (eventType: "onResolved", fn: () => void) => () => void;
  };
  readonly resolve: () => void;
  /** Back to idle on `/` with no listener, for a suite's `beforeEach`. */
  readonly reset: () => void;
}

export function createScriptedRouterForTests(): ScriptedRouterForTests {
  const listeners = new Set<() => void>();
  const state: ScriptedRouterForTests["state"] = {
    status: "idle",
    location: { pathname: "/" },
  };
  return {
    state,
    router: {
      state,
      subscribe: (_eventType, fn) => {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
    },
    resolve: () => {
      for (const listener of listeners) listener();
      state.status = "idle";
    },
    reset: () => {
      listeners.clear();
      state.status = "idle";
      state.location = { pathname: "/" };
    },
  };
}
