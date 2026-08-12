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

/**
 * Integration pin, against the REAL @tanstack/react-router, for the
 * cold-launch race `bindAuthInvalidation` exists to close: an auth flip that
 * lands while the router's very first load is still in flight (slow
 * `beforeLoad`, no match ever committed) must not strand the router at
 * `status: "pending"` forever.
 *
 * The fake-router unit tests in `router-auth-invalidation.test.ts` pin the
 * exact guard predicate and the coalescing behavior against a scripted
 * interface. This file instead drives the real router-core state machine
 * end to end, so a version bump that changes what `resolvedLocation` means
 * (or when provisional matches publish) fails here even if the fake stays
 * green.
 *
 * The router is mounted for real via `<RouterProvider />` rather than driven
 * headlessly with `router.load()`. `resolvedLocation` is assigned by the
 * React `Transitioner` that `RouterProvider` renders (after render-ack, once
 * the match set commits) - a headless `router.load()` call never reaches
 * that code path, so this file's convergence assertion would hang forever
 * without a real mount.
 */

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

// Trivial stand-in for a route's pending UI. router-core's `offerPending`
// (load-client.ts) bails out WITHOUT publishing provisional matches when
// neither the route nor the router carries a pending component - regardless
// of `defaultPendingMs`. A test that omits this never exercises the
// provisional-match window at all: `router.state.matches` would stay empty
// past `defaultPendingMs`, and the "matches may now be non-empty" comment
// below would be untested.
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
 * Bridge to the narrowed `AuthInvalidationRouter` interface via an explicit
 * adapter (rather than passing `router` directly): the `state` getter below
 * re-reads `router.state` on every access, which matters because the guard
 * inspects the LATEST state at flip time, not a snapshot taken when the
 * adapter was constructed. `resolvedLocation` is optional on both the real
 * router-core type and this narrowed interface, so no bridging is required
 * there - the getter just forwards it as-is.
 *
 * `load` and `invalidate` are wrapped in spies (rather than passed through
 * directly) so the test can assert not just the router's eventual state but
 * WHICH of the two `bindAuthInvalidation` actually called, and in what order
 * - the guard's entire point is routing the auth change through `load()`
 * instead of `invalidate()` while the router is uncommitted.
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

    // Mount the router for real. `<RouterProvider>`'s `Transitioner` kicks
    // off the initial load itself on mount (straight against the router, not
    // the adapter - see `toSpiedAuthInvalidationRouter` above, so it does not
    // count toward the `load`/`invalidate` spy assertions below), and it is
    // the only thing that ever assigns `resolvedLocation`. beforeLoad is
    // blocked on the deferred, so this transaction never settles on its own,
    // which keeps the first commit blocked for the assertions that follow.
    render(<RouterProvider router={router} />);

    // Wait for router-core's pending-presentation timer (defaultPendingMs: 1)
    // to fire. With `defaultPendingComponent` wired up, provisional matches
    // are now non-empty - but the router has never committed, so
    // `resolvedLocation` must still be undefined.
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

    // zustand's `subscribe` listeners run synchronously inside `setState`,
    // and the recovery path calls `router.load()` synchronously (before
    // awaiting anything) - so by the time `setState` above returns, the
    // guard has already routed the auth change through `load()`. The
    // `beforeLoad` gate is still unresolved, so that load cannot have
    // settled yet, which means `invalidate()` must not have been called.
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
