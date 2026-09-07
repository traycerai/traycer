import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
  type Mock,
} from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  type AnyRouter,
} from "@tanstack/react-router";
import { bindAuthInvalidation, type AuthInvalidationRouter } from "@/router";
import { useAuthStore } from "@/stores/auth/auth-store";

/** Real-router pin of the cold-launch race: an auth flip during the first in-flight load must not strand `status: "pending"`. Mount via `<RouterProvider />`; a headless `router.load()` never assigns `resolvedLocation`. */

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function createDeferred(): Deferred {
  let resolveDeferred: () => void = () => {
    throw new Error("resolveDeferred not assigned");
  };
  const promise = new Promise<void>((resolve) => {
    resolveDeferred = resolve;
  });
  return {
    promise,
    resolve: () => {
      resolveDeferred();
    },
  };
}

// Pending component is required: offerPending publishes no matches without one,
// regardless of defaultPendingMs.
function TrivialPendingComponent(): null {
  return null;
}

function createTestRouter(beforeLoadGate: Deferred): AnyRouter {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    beforeLoad: () => beforeLoadGate.promise,
  });
  const routeTree = rootRoute.addChildren([indexRoute]);
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
    // Fires the pending presentation almost immediately so the test does not
    // need to wait out the app's real 200ms `defaultPendingMs`.
    defaultPendingMs: 1,
    // Required for the pending presentation to actually publish - see
    // `TrivialPendingComponent` above.
    defaultPendingComponent: TrivialPendingComponent,
  });
}

interface SpiedAdapter {
  readonly adapter: AuthInvalidationRouter;
  readonly load: Mock<() => Promise<void>>;
  readonly invalidate: Mock<() => Promise<void>>;
}

/**
 * Adapter re-reads `router.state` on every access. Spy `load`/`invalidate` so the test sees which one the guard called.
 */
function toSpiedAuthInvalidationRouter(router: AnyRouter): SpiedAdapter {
  const load = vi.fn<() => Promise<void>>(() => router.load());
  const invalidate = vi.fn<() => Promise<void>>(() => router.invalidate());
  const adapter: AuthInvalidationRouter = {
    get state() {
      return {
        status: router.state.status,
        resolvedLocation: router.state.resolvedLocation,
      };
    },
    load,
    invalidate,
  };
  return { adapter, load, invalidate };
}

function resetAuthStore(): void {
  useAuthStore.setState({
    status: "signed-out",
    profile: null,
    contextMetadata: null,
    shareableTeams: [],
    subscriptionStatus: null,
  });
}

describe("bindAuthInvalidation (real @tanstack/react-router)", () => {
  beforeEach(() => {
    resetAuthStore();
  });

  afterEach(() => {
    cleanup();
    resetAuthStore();
  });

  it("does not strand the router when an auth flip lands mid initial-load, and converges once the slow beforeLoad releases", async () => {
    const beforeLoadGate = createDeferred();
    const router = createTestRouter(beforeLoadGate);
    const { adapter, load, invalidate } = toSpiedAuthInvalidationRouter(router);
    const unsubscribe = bindAuthInvalidation(adapter);
    onTestFinished(() => unsubscribe());

    // Transitioner starts the initial load on the router (not the adapter).
    // beforeLoad is blocked so the first commit stays pending.
    render(<RouterProvider router={router} />);

    // After defaultPendingMs, matches may be non-empty but resolvedLocation
    // is still undefined until commit.
    await waitFor(() => {
      expect(router.state.status).toBe("pending");
      expect(router.state.matches.length).toBeGreaterThan(0);
      expect(router.state.resolvedLocation).toBeUndefined();
    });

    expect(load).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();

    // Drive a real auth flip while the router is in that uncommitted window.
    // Without the fix this invalidate()s the in-flight load out of
    // router-core's scheduler with nothing left to reschedule it.
    act(() => {
      useAuthStore.setState({
        status: "signed-in",
        profile: {
          userId: "user-a",
          userName: "user-a",
          email: "user-a@example.com",
        },
        contextMetadata: { userId: "user-a", username: "user-a" },
      });
    });

    // subscribe runs inside setState; recovery calls load() before awaiting.
    // beforeLoad is still unresolved, so invalidate must not have been called.
    expect(load).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalled();

    // Release the slow beforeLoad now that the recovery has had a chance to
    // route the auth change through load() instead of invalidate()ing the
    // in-flight transaction directly.
    act(() => {
      beforeLoadGate.resolve();
    });

    await waitFor(() => {
      expect(router.state.status).toBe("idle");
      expect(router.state.resolvedLocation).not.toBeUndefined();
    });

    // The recovery's post-settle invalidate has now had a chance to run -
    // exactly once, per the coalescing guarantee in `bindAuthInvalidation`.
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
