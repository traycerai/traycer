/**
 * `/settings/browser-agent-access` opens its own page in place: a bookmark or a
 * remembered tab path keeps its address, so the section answers for the pick
 * (the page, or the card a computer without it gets) instead of landing on
 * Permissions first.
 */
import { describe, expect, it } from "vitest";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { Route as BrowserAgentAccessRoute } from "@/routes/settings.browser-agent-access";

const beforeLoad = BrowserAgentAccessRoute.options.beforeLoad as
  | ((args: { context: object }) => void)
  | undefined;

function buildRouter(initialPath: string) {
  const rootRoute = createRootRoute();
  const browserAgentAccessRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/browser-agent-access",
    beforeLoad: () => beforeLoad?.({ context: {} }),
    component: () => <div data-testid="browser-agent-access-panel" />,
  });
  const permissionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/permissions",
    component: () => <div data-testid="permissions-panel" />,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([
      browserAgentAccessRoute,
      permissionsRoute,
    ]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

describe("/settings/browser-agent-access route", () => {
  it("keeps its address instead of redirecting to Permissions", async () => {
    const router = buildRouter("/settings/browser-agent-access");
    await router.load();

    expect(router.state.location.pathname).toBe(
      "/settings/browser-agent-access",
    );
  });
});
