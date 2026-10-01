import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { useAuthStore } from "@/stores/auth/auth-store";

vi.mock("@/components/layout/root-landing-page", () => ({
  RootLandingPage: () => <div data-testid="settings-auth-fallback" />,
}));

import { SettingsLayout } from "@/components/settings/settings-layout";

/**
 * The harness renders `<SettingsLayout />` under a router (a bare root route,
 * no children needed - nothing here navigates), because `SettingsLayout` reads
 * router location state; a bare `render(<SettingsLayout />)` would throw for
 * having no `<RouterProvider>` ancestor.
 *
 * `state` is set on a bare, unsubscribed history before the router exists -
 * `createMemoryHistory`'s own `initialEntries` takes plain path strings only.
 */
function renderInRouter(state: Record<string, unknown>): () => Promise<void> {
  const rootRoute = createRootRoute({ component: SettingsLayout });
  const history = createMemoryHistory({ initialEntries: ["/settings/host"] });
  history.replace("/settings/host", state);
  const router = createRouter({
    routeTree: rootRoute,
    history,
  });
  render(<RouterProvider router={router} />);
  return async () => {
    await waitFor(() => {
      expect(router.state.status).toBe("idle");
    });
  };
}

describe("<SettingsLayout />", () => {
  beforeEach(() => {
    useAuthStore.getState().setSignedOut();
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
  });

  it("renders the signed-out fallback instead of a blank settings deep link", async () => {
    renderInRouter({});

    expect(await screen.findByTestId("settings-auth-fallback")).not.toBeNull();
  });

  it("leaves signed-in settings to the top-level tab host", async () => {
    useAuthStore.getState().setSignedIn(
      {
        userId: "user-1",
        userName: "User One",
        email: "user@example.com",
      },
      { userId: "user-1", username: "user-one" },
      [],
    );

    const waitForRouterIdle = renderInRouter({});
    await waitForRouterIdle();

    expect(screen.queryByTestId("settings-auth-fallback")).toBeNull();
  });

  it("admitted with both boot-escape markers still renders nothing", async () => {
    useAuthStore.getState().setSignedIn(
      {
        userId: "user-1",
        userName: "User One",
        email: "user@example.com",
      },
      { userId: "user-1", username: "user-one" },
      [],
    );

    const waitForRouterIdle = renderInRouter({
      __traycerStartupNavigationIntent: true,
      __traycerStartupMenuSettingsIntent: true,
    });
    await waitForRouterIdle();

    expect(screen.queryByTestId("settings-auth-fallback")).toBeNull();
  });
});
