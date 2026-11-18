import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  type AnyRouter,
} from "@tanstack/react-router";
import { bindAuthInvalidation } from "@/router";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * Integration pins, against the REAL @tanstack/react-router, for the auth
 * flip that lands while the router's first load is still in flight. A second
 * load started under that one either strands the router at `status:
 * "pending"` (before anything commits) or crashes a rendered pending match
 * with a falsy throw (once one has); see `bindAuthInvalidation`.
 *
 * The router is mounted for real via `<RouterProvider />` rather than driven
 * headlessly with `router.load()`: `onResolved` and `resolvedLocation` both
 * come from the React `Transitioner` that `RouterProvider` renders, and a
 * headless load never reaches it.
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

function createTestRouter(
  beforeLoadGate: Deferred,
  guardReads: Array<string | null>,
): AnyRouter {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    beforeLoad: () => {
      guardReads.push(useAuthStore.getState().contextMetadata?.userId ?? null);
      return beforeLoadGate.promise;
    },
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

function IndexContent(): ReactNode {
  return <p>index content</p>;
}

/**
 * Stand-in for the app's root error boundary, above the router. React hands
 * `componentDidCatch` whatever was thrown, falsy values included, so a route
 * match that throws `undefined` is recorded as an `undefined` entry rather
 * than being mistaken for "nothing was caught".
 */
class CrashRecorder extends Component<
  { readonly onCrash: (thrown: unknown) => void; readonly children: ReactNode },
  { readonly crashed: boolean }
> {
  state = { crashed: false };

  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }

  componentDidCatch(thrown: unknown, _info: ErrorInfo): void {
    this.props.onCrash(thrown);
  }

  render(): ReactNode {
    return this.state.crashed ? null : this.props.children;
  }
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

  it("re-runs the guards once against the latest auth after the in-flight initial load resolves, however many flips landed in it", async () => {
    const beforeLoadGate = createDeferred();
    const guardReads: Array<string | null> = [];
    const router = createTestRouter(beforeLoadGate, guardReads);
    const unsubscribe = bindAuthInvalidation(router);
    onTestFinished(() => unsubscribe());

    // `<RouterProvider>`'s `Transitioner` starts the initial load on mount.
    // beforeLoad is blocked on the deferred, so nothing commits until the
    // gate is released.
    render(<RouterProvider router={router} />);

    // Past `defaultPendingMs: 1` the provisional matches are published, but
    // the router has never committed.
    await waitFor(() => {
      expect(router.state.status).toBe("pending");
      expect(router.state.matches.length).toBeGreaterThan(0);
      expect(router.state.resolvedLocation).toBeUndefined();
    });
    expect(guardReads).toEqual([null]);

    // Two changes inside the same load: a sign-in, then a switch of user.
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
    act(() => {
      useAuthStore.setState({
        contextMetadata: { userId: "user-b", username: "user-b" },
      });
    });
    // Neither started a load: the guard has still run only once.
    expect(guardReads).toEqual([null]);

    act(() => {
      beforeLoadGate.resolve();
    });

    // The load converges, and the one follow-up invalidate re-runs the guard
    // against the latest user.
    await waitFor(() => {
      expect(guardReads).toEqual([null, "user-b"]);
      expect(router.state.status).toBe("idle");
      expect(router.state.resolvedLocation).not.toBeUndefined();
    });
  });

  it("starts no second load for an auth flip mid initial-load, so a match that finishes first never throws undefined", async () => {
    const rootLoaderGate = createDeferred();
    const indexLoaderGate = createDeferred();
    const rootRoute = createRootRoute({ loader: () => rootLoaderGate.promise });
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      loader: () => indexLoaderGate.promise,
      component: IndexContent,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
      // Cold-load shape: the pending UI is already committed when the flip
      // lands, yet the flip and the first gate release both fall inside a
      // second load's own `defaultPendingMs` window, before it commits.
      defaultPendingMs: 50,
      defaultPendingComponent: TrivialPendingComponent,
      // The default 500ms hold on a pending UI would keep the loads running
      // past that window and hide the race.
      defaultPendingMinMs: 0,
    });
    const unsubscribe = bindAuthInvalidation(router);
    onTestFinished(() => unsubscribe());

    // `onBeforeLoad` fires once per `router.load()`, so this counts load
    // starts from the router itself, whoever calls it.
    let loadsStarted = 0;
    onTestFinished(
      router.subscribe("onBeforeLoad", () => {
        loadsStarted += 1;
      }),
    );
    const crashes: unknown[] = [];
    render(
      <CrashRecorder onCrash={(thrown) => crashes.push(thrown)}>
        <RouterProvider router={router} />
      </CrashRecorder>,
    );

    await waitFor(() => {
      expect(router.state.status).toBe("pending");
      expect(router.state.matches.length).toBeGreaterThan(0);
      expect(router.state.resolvedLocation).toBeUndefined();
    });
    const loadsStartedBeforeFlip = loadsStarted;

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
    const loadsStartedByFlip = loadsStarted - loadsStartedBeforeFlip;

    // The root match finishes while the index match is still loading. Its
    // suspended boundary retries against whatever the router left behind.
    act(() => {
      rootLoaderGate.resolve();
    });
    await waitFor(() => {
      expect(router.getMatch("__root__/")?.status).toBe("success");
    });
    act(() => {
      indexLoaderGate.resolve();
    });

    await waitFor(() => {
      expect(
        crashes.length > 0 || screen.queryByText("index content") !== null,
      ).toBe(true);
    });
    expect(crashes).toEqual([]);
    await waitFor(() => {
      expect(router.state.status).toBe("idle");
    });
    expect(screen.getByText("index content")).toBeTruthy();
    expect(loadsStartedByFlip).toBe(0);
  });
});
