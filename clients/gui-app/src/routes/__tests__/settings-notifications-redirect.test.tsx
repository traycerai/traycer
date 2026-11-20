/**
 * `/settings/notifications` was the host's Notifications page, which held
 * notification hooks. Hooks are gone, so a bookmark, a remembered tab path or
 * an old link to it lands on Alerts on every build.
 */
import { describe, expect, it } from "vitest";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { setMobileApp } from "@/lib/mobile-app";
import { Route as NotificationsRoute } from "@/routes/settings.notifications";

// The route's own `beforeLoad`, mounted into a throwaway route tree so the
// router honors the redirect (see the link-phone redirect suite).
const beforeLoad = NotificationsRoute.options.beforeLoad as (args: {
  context: object;
}) => void;

function buildRouter(initialPath: string) {
  const rootRoute = createRootRoute();
  const notificationsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/notifications",
    beforeLoad: () => beforeLoad({ context: {} }),
    component: () => <div data-testid="notifications-panel" />,
  });
  const alertsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/alerts",
    component: () => <div data-testid="alerts-panel" />,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([notificationsRoute, alertsRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

describe("/settings/notifications route", () => {
  it.each([false, true])(
    "lands on Alerts, replacing the entry (mobile app: %s)",
    async (mobile) => {
      setMobileApp(mobile);
      const router = buildRouter("/settings/notifications");
      await router.load();

      expect(router.state.location.pathname).toBe("/settings/alerts");
      expect(router.history.length).toBe(1);
      setMobileApp(false);
    },
  );
});
