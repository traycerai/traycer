import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import type { AuthStatus } from "@/stores/auth/auth-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { bindAuthInvalidation } from "@/router";
import { requireSignedIn } from "@/lib/router-auth";
import type { AppRouterContext } from "@/router";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { getCloudEpicTasksClient } from "@/lib/cloud-epic-tasks-query/client-registry";
import { parseHistorySearch } from "@/lib/history-search";
import type { HistorySearchState } from "@/lib/history-search";
import { Route as EpicsIndexRoute } from "@/routes/epics/index";

vi.mock("@/components/epics/epics-list", () => ({
  EpicsList: () => <div data-testid="epics-list-stub">epics</div>,
}));

import { EpicsRoute } from "@/components/epics/epics-route";

function buildRouter(initialPath: "/" | "/epics" | `/epics/${string}`) {
  const rootRoute = createRootRouteWithContext<AppRouterContext>()({
    component: () => <Outlet />,
  });
  const indexRoute = createRoute({
    path: "/",
    getParentRoute: () => rootRoute,
    component: () => <div data-testid="home-stub">home</div>,
  });
  const epicsRoute = createRoute({
    path: "/epics",
    getParentRoute: () => rootRoute,
    beforeLoad: ({ context }) => {
      requireSignedIn(context);
    },
    component: () => <EpicsRoute routeSearch={null} historyNowMs={null} />,
  });
  const epicDetailRoute = createRoute({
    path: "/epics/$epicId",
    getParentRoute: () => rootRoute,
    beforeLoad: ({ context }) => {
      requireSignedIn(context);
    },
    component: () => <div data-testid="epic-detail-stub">detail</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, epicsRoute, epicDetailRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
    context: {
      queryClient: new QueryClient(),
      getAuthSnapshot: () => useAuthStore.getState(),
      getHostClient: () => null,
    },
  });
  const unsubscribe = bindAuthInvalidation(router);
  vi.spyOn(router, "invalidate");
  return { router, unsubscribe };
}

function mount(initialPath: "/" | "/epics" | `/epics/${string}`) {
  const { router, unsubscribe } = buildRouter(initialPath);
  render(<RouterProvider router={router} />);
  return { router, unsubscribe };
}

describe("/epics route guard", () => {
  beforeEach(() => {
    useAuthStore.getState().setSignedOut();
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
  });

  it("redirects the user back to / when they sign out while on /epics", async () => {
    useAuthStore.getState().setSignedIn(
      {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
      { userId: "test-user", username: "Test User" },
      [],
    );

    const { router, unsubscribe } = mount("/epics");

    await screen.findByTestId("epics-list-stub");

    act(() => {
      useAuthStore.getState().setSignedOut();
    });

    await waitFor(() => {
      expect(screen.queryByTestId("epics-list-stub")).toBeNull();
      expect(screen.queryByTestId("home-stub")).not.toBeNull();
    });
    expect(router.state.location.pathname).toBe("/");
    expect(router.invalidate).toHaveBeenCalled();
    unsubscribe();
  });

  it("redirects a signed-out user who navigates directly to /epics back to /", async () => {
    const { router, unsubscribe } = mount("/epics");

    await waitFor(() => {
      expect(screen.queryByTestId("home-stub")).not.toBeNull();
    });
    expect(screen.queryByTestId("epics-list-stub")).toBeNull();
    expect(router.state.location.pathname).toBe("/");
    unsubscribe();
  });

  it("redirects a signed-out user who navigates directly to /epics/:epicId back to /", async () => {
    const { router, unsubscribe } = mount("/epics/epic-1");

    await waitFor(() => {
      expect(screen.queryByTestId("home-stub")).not.toBeNull();
    });
    expect(screen.queryByTestId("epic-detail-stub")).toBeNull();
    expect(router.state.location.pathname).toBe("/");
    unsubscribe();
  });
});

/**
 * T3: the `/epics` loader's History first-page prefetch moved from
 * `auth.status !== "signed-in"` to `!admitsLocalPlane(auth.status)`.
 * `beforeLoad` already admits `unverified` onto this route via
 * `requireSignedIn` (= `admitsLocalPlane`), so before the fix that cohort
 * reached the route with a cold History - the prefetch this loader issues is
 * the same local-first `initial` leg the panel would otherwise wait on.
 *
 * Invoked directly against `Route.options.loader`, the same way
 * `draft-entry-routes.test.ts` exercises `beforeLoad` - the route's context
 * type is wider than what this loader body actually reads, so a narrower
 * fake context is enough without standing up the full router.
 */
describe("/epics loader prefetch admission", () => {
  afterEach(() => {
    resetNegotiatedManifests();
  });

  interface FakeHostClient {
    getActiveHostId(): string | null;
    getRequestContextUserId(): string | null;
  }

  interface FakeLoaderContext {
    getHostClient: () => FakeHostClient | null;
    getAuthSnapshot: () => {
      readonly status: AuthStatus;
      readonly contextMetadata: { readonly userId: string } | null;
    };
    queryClient: { prefetchQuery: (options: unknown) => Promise<void> };
  }

  function invokeEpicsIndexLoader(args: {
    readonly authStatus: AuthStatus;
    readonly contextMetadataUserId: string | null;
    readonly hostId: string;
    readonly requestContextUserId: string | null;
  }): { readonly prefetchCalls: number } {
    const prefetchQuery = vi.fn(() => Promise.resolve());
    const loader = EpicsIndexRoute.options.loader as (loaderArgs: {
      context: FakeLoaderContext;
      deps: { historySearch: HistorySearchState };
    }) => unknown;
    loader({
      context: {
        getHostClient: () => ({
          getActiveHostId: () => args.hostId,
          getRequestContextUserId: () => args.requestContextUserId,
        }),
        getAuthSnapshot: () => ({
          status: args.authStatus,
          contextMetadata:
            args.contextMetadataUserId === null
              ? null
              : { userId: args.contextMetadataUserId },
        }),
        queryClient: { prefetchQuery },
      },
      deps: { historySearch: parseHistorySearch({}) },
    });
    return { prefetchCalls: prefetchQuery.mock.calls.length };
  }

  it("prefetches the History first page for an unverified session with a matching request-context user", () => {
    const hostId = "host-epics-unverified";
    // The host advertises the local-first line, so the prefetched leg is a
    // disk read this session is admitted to.
    recordNegotiatedHostManifest(hostId, {
      "epic.listTasks": { major: 1, minor: 6 },
    });
    const result = invokeEpicsIndexLoader({
      authStatus: "unverified",
      contextMetadataUserId: "user-1",
      hostId,
      requestContextUserId: "user-1",
    });
    expect(result.prefetchCalls).toBe(1);
    expect(getCloudEpicTasksClient(hostId)).not.toBeNull();
  });

  it("does not prefetch for an unverified session on a host below epic.listTasks@1.6", () => {
    // A pre-1.6 host strips `localFirstPhase` and runs the released
    // cloud-backed list on the retained credential; the hook's own gate
    // refuses that, and the loader's prefetch is the same leg issued earlier.
    const hostId = "host-epics-unverified-legacy";
    recordNegotiatedHostManifest(hostId, {
      "epic.listTasks": { major: 1, minor: 5 },
    });
    const result = invokeEpicsIndexLoader({
      authStatus: "unverified",
      contextMetadataUserId: "user-1",
      hostId,
      requestContextUserId: "user-1",
    });
    expect(result.prefetchCalls).toBe(0);
  });

  it("does not prefetch for an unverified session before the host's manifest has arrived", () => {
    const result = invokeEpicsIndexLoader({
      authStatus: "unverified",
      contextMetadataUserId: "user-1",
      hostId: "host-epics-unverified-no-manifest",
      requestContextUserId: "user-1",
    });
    expect(result.prefetchCalls).toBe(0);
  });

  it("still prefetches for a signed-in session on a host below epic.listTasks@1.6", () => {
    // Non-vacuity for the gate: an authorized session may spend the
    // capability whatever the peer's minor is.
    const hostId = "host-epics-signed-in-legacy";
    recordNegotiatedHostManifest(hostId, {
      "epic.listTasks": { major: 1, minor: 5 },
    });
    const result = invokeEpicsIndexLoader({
      authStatus: "signed-in",
      contextMetadataUserId: "user-1",
      hostId,
      requestContextUserId: "user-1",
    });
    expect(result.prefetchCalls).toBe(1);
  });

  it("does not prefetch for a signed-out session", () => {
    const result = invokeEpicsIndexLoader({
      authStatus: "signed-out",
      contextMetadataUserId: "user-1",
      hostId: "host-epics-signed-out",
      requestContextUserId: "user-1",
    });
    expect(result.prefetchCalls).toBe(0);
  });

  it("does not prefetch when the auth snapshot has no context user id", () => {
    const result = invokeEpicsIndexLoader({
      authStatus: "unverified",
      contextMetadataUserId: null,
      hostId: "host-epics-null-user",
      requestContextUserId: "user-1",
    });
    expect(result.prefetchCalls).toBe(0);
  });

  it("does not prefetch when the client's request-context user does not match", () => {
    const result = invokeEpicsIndexLoader({
      authStatus: "unverified",
      contextMetadataUserId: "user-1",
      hostId: "host-epics-mismatch",
      requestContextUserId: "user-2",
    });
    expect(result.prefetchCalls).toBe(0);
  });
});
