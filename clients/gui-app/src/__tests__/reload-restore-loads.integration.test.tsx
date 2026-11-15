import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  RouterProvider,
  type AnyRouter,
} from "@tanstack/react-router";
import { TabNavigationRouteBridge } from "@/components/layout/bridges/tab-navigation-route-bridge";
import { useShellLocalPlaneAdmission } from "@/hooks/auth/use-shell-local-plane-admission";
import { createPersistentMemoryHistory } from "@/lib/persistent-history";
import { requireSignedIn } from "@/lib/router-auth";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import { bindAuthInvalidation } from "@/router";
import { useAuthStore, type AuthState } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import * as DesktopTabsPersistence from "@/stores/tabs/desktop-tabs-persistence";
import {
  resetTabsStoreForTest,
  seedActiveEpicTabInTabsStore,
} from "@/stores/tabs/test-support/tabs-store-fixtures";

/**
 * A desktop window reloaded onto an open task, against the REAL
 * @tanstack/react-router: no load starts under another (`runWhenRouterSettled`).
 *
 * Captured on the venue, every reload made three loads on the router the
 * window kept: the sign-in restored at start-up invalidated a router that had
 * never loaded, the router's own mount load started under that one, and the
 * tab hydration's replay started under the mount load. A reload showed the
 * error card when a match was drawn pending after one of those loads cleared
 * its shared load promise.
 */

const WINDOW_ID = "window-reload";
const EPIC_ID = "epic-1";

vi.mock("@/providers/windows-bridge-context", () => ({
  // The per-window snapshot is read over IPC and is in hand before the
  // sign-in is: the bridge replays as soon as it mounts.
  useWindowsBridgeHydrated: () => true,
}));

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

function TrivialPendingComponent(): null {
  return null;
}

/** The root's shell: the bridge exists only once the shell is admitted. */
function ShellRoot(): ReactNode {
  const admission = useShellLocalPlaneAdmission();
  return (
    <>
      {admission.admitted ? <TabNavigationRouteBridge /> : null}
      <Outlet />
    </>
  );
}

function TaskContent(): ReactNode {
  return <p>task content</p>;
}

function LandingContent(): ReactNode {
  return <p>landing</p>;
}

/**
 * Stand-in for the app's root error boundary, above the router. React hands
 * `componentDidCatch` whatever was thrown, so a thrown `undefined` is recorded.
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

interface RouterContext {
  getAuthSnapshot: () => AuthState;
}

/**
 * The routes a reload passes through, behind the app's sign-in guard, each
 * guard run recording the auth status it read. The task's chunks arrive when
 * their gates open: the desktop renderer splits every route component into
 * its own chunk (`autoCodeSplitting`, `clients/desktop/vite.renderer.config.ts`),
 * so a reload's matches wait on chunk preloads.
 */
function createReloadRouter(input: {
  readonly initialRoute: string;
  /** The shell with its tab bridge, as on the reload path, or the bare outlet. */
  readonly withBridge: boolean;
  readonly persisted: boolean;
  readonly layoutChunk: Promise<void>;
  readonly taskChunk: Promise<void>;
  readonly guardReads: Array<string>;
}): AnyRouter {
  const rootRoute = createRootRouteWithContext<RouterContext>()({
    component: input.withBridge ? ShellRoot : Outlet,
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    beforeLoad: ({ context }) => {
      input.guardReads.push(`/:${context.getAuthSnapshot().status}`);
    },
    component: LandingContent,
  });
  const epicsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/epics",
    component: lazyRouteComponent(() =>
      input.layoutChunk.then(() => ({ default: Outlet })),
    ),
  });
  const taskRoute = createRoute({
    getParentRoute: () => epicsRoute,
    path: "$epicId/$tabId",
    beforeLoad: ({ context }) => {
      input.guardReads.push(`task:${context.getAuthSnapshot().status}`);
      requireSignedIn(context);
    },
    component: lazyRouteComponent(() =>
      input.taskChunk.then(() => ({ default: TaskContent })),
    ),
  });
  return createRouter({
    routeTree: rootRoute.addChildren([
      indexRoute,
      epicsRoute.addChildren([taskRoute]),
    ]),
    history: input.persisted
      ? createPersistentMemoryHistory(null, WINDOW_ID)
      : createMemoryHistory({ initialEntries: [input.initialRoute] }),
    context: { getAuthSnapshot: () => useAuthStore.getState() },
    defaultPendingMs: 50,
    defaultPendingComponent: TrivialPendingComponent,
  });
}

/**
 * The router's own record of its loads: `start` per `router.load()`,
 * `resolved` when the Transitioner settles. Two `start`s with no `resolved`
 * between them are a load started under another.
 */
function recordLoads(router: AnyRouter): Array<"start" | "resolved"> {
  const order: Array<"start" | "resolved"> = [];
  onTestFinished(
    router.subscribe("onBeforeLoad", () => {
      order.push("start");
    }),
  );
  onTestFinished(
    router.subscribe("onResolved", () => {
      order.push("resolved");
    }),
  );
  return order;
}

/** One-shot, as the real module: the token is spent by its first reader. */
function seedRestoredRoute(route: string): void {
  let pending: string | null = route;
  vi.spyOn(
    DesktopTabsPersistence,
    "consumeDesktopRestoredRoute",
  ).mockImplementation(() => {
    const value = pending;
    pending = null;
    return value;
  });
}

/** The window's layout as the desktop restores it: the task's tab, focused. */
function seedRestoredTask(): string {
  const tabId = useEpicCanvasStore.getState().openEpicTab(EPIC_ID, "Task");
  seedActiveEpicTabInTabsStore(tabId);
  const route = `/epics/${EPIC_ID}/${tabId}`;
  window.localStorage.setItem(
    `traycer-gui-app:last-route:${WINDOW_ID}`,
    JSON.stringify({ entries: [route], index: 0 }),
  );
  seedRestoredRoute(route);
  return route;
}

function signIn(userId: string): void {
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId, userName: userId, email: `${userId}@example.com` },
    contextMetadata: { userId, username: userId },
  });
}

function signOut(): void {
  useAuthStore.setState({
    status: "signed-out",
    profile: null,
    contextMetadata: null,
  });
}

function resetAuthStore(): void {
  useAuthStore.setState({
    status: "signed-out",
    profile: null,
    contextMetadata: null,
    shareableTeams: [],
    subscriptionStatus: null,
    hostRefusedHeldBearer: false,
  });
}

const OPEN = Promise.resolve();

beforeEach(() => {
  resetAuthStore();
  resetTabsStoreForTest();
  __resetTabNavigationControllerForTesting();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetAuthStore();
  resetTabsStoreForTest();
  __resetTabNavigationControllerForTesting();
  window.localStorage.clear();
});

describe("a sign-in applied before the router's first load", () => {
  it("starts no load of its own (the precondition every captured card had)", async () => {
    const route = `/epics/${EPIC_ID}/tab-1`;
    const router = createReloadRouter({
      initialRoute: route,
      withBridge: false,
      persisted: false,
      layoutChunk: OPEN,
      taskChunk: OPEN,
      guardReads: [],
    });
    onTestFinished(bindAuthInvalidation(router));
    const loads = recordLoads(router);

    // The provisional session restored at start-up, before `RouterProvider`.
    act(() => {
      signIn("user-a");
    });
    render(<RouterProvider router={router} />);
    await waitFor(() => {
      expect(router.state.resolvedLocation).not.toBeUndefined();
      expect(router.state.status).toBe("idle");
    });

    expect(loads).toEqual(["start", "resolved"]);
  });

  it("is kept: the task's guard runs once, against the signed-in state, and the window stays on the task", async () => {
    const route = `/epics/${EPIC_ID}/tab-1`;
    const guardReads: Array<string> = [];
    const router = createReloadRouter({
      initialRoute: route,
      withBridge: false,
      persisted: false,
      layoutChunk: OPEN,
      taskChunk: OPEN,
      guardReads,
    });
    onTestFinished(bindAuthInvalidation(router));

    act(() => {
      signIn("user-a");
    });
    render(<RouterProvider router={router} />);
    await waitFor(() => {
      expect(screen.queryByText("task content")).not.toBeNull();
    });

    expect(guardReads).toEqual(["task:signed-in"]);
    expect(router.state.location.pathname).toBe(route);
  });
});

describe("the reload path restores the open task with no load started under another", () => {
  it.each([{ strict: false }, { strict: true }])(
    "with the sign-in restored before the router mounts, the replay waits for the mount load (StrictMode: $strict)",
    async ({ strict }) => {
      const route = seedRestoredTask();
      const layoutChunk = createDeferred();
      const taskChunk = createDeferred();
      const router = createReloadRouter({
        initialRoute: route,
        withBridge: true,
        persisted: true,
        layoutChunk: layoutChunk.promise,
        taskChunk: taskChunk.promise,
        guardReads: [],
      });
      onTestFinished(bindAuthInvalidation(router));
      const loads = recordLoads(router);

      act(() => {
        signIn("user-a");
      });
      const crashes: unknown[] = [];
      const tree = (
        <CrashRecorder onCrash={(thrown) => crashes.push(thrown)}>
          <RouterProvider router={router} />
        </CrashRecorder>
      );
      // The desktop renderer mounts under StrictMode.
      render(strict ? <StrictMode>{tree}</StrictMode> : tree);
      // The mount load is drawn pending, so the shell and its bridge are up
      // while the load is still in flight.
      await waitFor(() => {
        expect(router.state.status).toBe("pending");
        expect(router.state.matches.length).toBeGreaterThan(0);
      });

      // The layout's chunk arrives while the task's is still loading.
      act(() => {
        layoutChunk.resolve();
      });
      act(() => {
        taskChunk.resolve();
      });

      await waitFor(() => {
        expect(loads).toEqual(["start", "resolved", "start", "resolved"]);
      });
      expect(crashes).toEqual([]);
      expect(router.state.location.pathname).toBe(route);
      expect(screen.getByText("task content")).toBeTruthy();
    },
  );

  it("with the sign-in landing during the mount load, its guard re-run and the replay each wait for the load before them", async () => {
    const route = seedRestoredTask();
    const layoutChunk = createDeferred();
    const taskChunk = createDeferred();
    const guardReads: Array<string> = [];
    const router = createReloadRouter({
      initialRoute: route,
      withBridge: true,
      persisted: true,
      layoutChunk: layoutChunk.promise,
      taskChunk: taskChunk.promise,
      guardReads,
    });
    onTestFinished(bindAuthInvalidation(router));
    const loads = recordLoads(router);

    // An `unverified` session admits the shell and the task while the
    // credential is still being checked.
    act(() => {
      useAuthStore.setState({ status: "unverified" });
    });
    const crashes: unknown[] = [];
    render(
      <CrashRecorder onCrash={(thrown) => crashes.push(thrown)}>
        <RouterProvider router={router} />
      </CrashRecorder>,
    );
    await waitFor(() => {
      expect(router.state.status).toBe("pending");
      expect(router.state.matches.length).toBeGreaterThan(0);
    });
    act(() => {
      signIn("user-a");
    });
    act(() => {
      layoutChunk.resolve();
    });
    act(() => {
      taskChunk.resolve();
    });

    await waitFor(() => {
      expect(loads).toEqual([
        "start",
        "resolved",
        "start",
        "resolved",
        "start",
        "resolved",
      ]);
    });
    expect(crashes).toEqual([]);
    expect(guardReads.at(-1)).toBe("task:signed-in");
    expect(router.state.location.pathname).toBe(route);
  });
});

describe("the fix changes nothing else about sign-in", () => {
  it("a signed-out start still lands on the sign-in surface", async () => {
    const guardReads: Array<string> = [];
    const router = createReloadRouter({
      initialRoute: `/epics/${EPIC_ID}/tab-1`,
      withBridge: false,
      persisted: false,
      layoutChunk: OPEN,
      taskChunk: OPEN,
      guardReads,
    });
    onTestFinished(bindAuthInvalidation(router));
    render(<RouterProvider router={router} />);

    await waitFor(() => {
      expect(screen.queryByText("landing")).not.toBeNull();
    });
    expect(router.state.location.pathname).toBe("/");
    expect(guardReads).toEqual(["task:signed-out", "/:signed-out"]);
  });

  it("a sign-in after the first load still invalidates, and the guards run again against it", async () => {
    const guardReads: Array<string> = [];
    const router = createReloadRouter({
      initialRoute: "/",
      withBridge: false,
      persisted: false,
      layoutChunk: OPEN,
      taskChunk: OPEN,
      guardReads,
    });
    onTestFinished(bindAuthInvalidation(router));
    const loads = recordLoads(router);
    render(<RouterProvider router={router} />);
    await waitFor(() => {
      expect(screen.queryByText("landing")).not.toBeNull();
      expect(router.state.status).toBe("idle");
    });

    act(() => {
      signIn("user-a");
    });

    await waitFor(() => {
      expect(guardReads).toEqual(["/:signed-out", "/:signed-in"]);
      expect(loads).toEqual(["start", "resolved", "start", "resolved"]);
    });
  });

  it("a sign-out after the first load still invalidates, and the guards run again and leave the task", async () => {
    const route = `/epics/${EPIC_ID}/tab-1`;
    const guardReads: Array<string> = [];
    const router = createReloadRouter({
      initialRoute: route,
      withBridge: false,
      persisted: false,
      layoutChunk: OPEN,
      taskChunk: OPEN,
      guardReads,
    });
    onTestFinished(bindAuthInvalidation(router));
    act(() => {
      signIn("user-a");
    });
    render(<RouterProvider router={router} />);
    await waitFor(() => {
      expect(screen.queryByText("task content")).not.toBeNull();
      expect(router.state.status).toBe("idle");
    });

    const readsBeforeSignOut = guardReads.length;
    act(() => {
      signOut();
    });

    await waitFor(() => {
      expect(screen.queryByText("landing")).not.toBeNull();
    });
    expect(guardReads.slice(readsBeforeSignOut)).toEqual([
      "task:signed-out",
      "/:signed-out",
    ]);
    expect(router.state.location.pathname).toBe("/");
  });
});
