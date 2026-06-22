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
import { useAuthStore } from "@/stores/auth/auth-store";
import { bindAuthInvalidation } from "@/router";
import { requireSignedIn } from "@/lib/router-auth";
import type { AppRouterContext } from "@/router";

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
      getActiveHostId: () => null,
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
