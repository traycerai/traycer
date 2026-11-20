/**
 * `/settings/app-notifications` is the Sounds page, which holds only the
 * soundtrack. A build with nothing to play does not offer it, and a bookmark,
 * a remembered tab path or an old link to it lands on Alerts, where its chimes
 * went.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { Route as AppNotificationsRoute } from "@/routes/settings.app-notifications";

const soundtrackOfferedMock = vi.hoisted(() => ({ value: false }));

vi.mock("@/lib/soundtrack/manifest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/soundtrack/manifest")>()),
  soundtrackOffered: () => soundtrackOfferedMock.value,
}));

afterEach(() => {
  soundtrackOfferedMock.value = false;
});

// The route's own `beforeLoad`, mounted into a throwaway route tree so the
// router honors the redirect (see the link-phone redirect suite).
const beforeLoad = AppNotificationsRoute.options.beforeLoad as (args: {
  context: object;
}) => void;

function buildRouter(initialPath: string) {
  const rootRoute = createRootRoute();
  const soundsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/app-notifications",
    beforeLoad: () => beforeLoad({ context: {} }),
    component: () => <div data-testid="sounds-panel" />,
  });
  const alertsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/alerts",
    component: () => <div data-testid="alerts-panel" />,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([soundsRoute, alertsRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

describe("/settings/app-notifications route", () => {
  it("lands on Alerts, replacing the entry, when the build has no soundtrack", async () => {
    soundtrackOfferedMock.value = false;
    const router = buildRouter("/settings/app-notifications");
    await router.load();

    expect(router.state.location.pathname).toBe("/settings/alerts");
    expect(router.history.length).toBe(1);
  });

  it("stays on Sounds when the build has a soundtrack", async () => {
    soundtrackOfferedMock.value = true;
    const router = buildRouter("/settings/app-notifications");
    await router.load();

    expect(router.state.location.pathname).toBe("/settings/app-notifications");
  });
});
