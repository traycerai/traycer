/** Route stays on every build. Where the section is not offered, land on General rather than a panel with no nav row. */
import { afterEach, describe, expect, it } from "vitest";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { setMobileApp } from "@/lib/mobile-app";
import { Route as KeybindingsRoute } from "@/routes/settings.keybindings";

afterEach(() => {
  setMobileApp(false);
});

// Mount beforeLoad in a throwaway tree so the router honors the redirect.
// Permissive sentinel: this callback reads none of the file-route context.
const keybindingsBeforeLoad = KeybindingsRoute.options.beforeLoad as (args: {
  context: object;
}) => void;

function buildRouter(initialPath: string) {
  const rootRoute = createRootRoute();
  const keybindingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/keybindings",
    beforeLoad: () => keybindingsBeforeLoad({ context: {} }),
    component: () => <div data-testid="keybindings-panel" />,
  });
  const generalRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/general",
    component: () => <div data-testid="general-panel" />,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([keybindingsRoute, generalRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

describe("/settings/keybindings route", () => {
  it("stays on the section for builds that offer it", async () => {
    setMobileApp(false);
    const router = buildRouter("/settings/keybindings");
    await router.load();

    expect(router.state.location.pathname).toBe("/settings/keybindings");
    // The real route renders the panel; the fixture above substitutes a stub
    // for it, so what is asserted here is that the route resolves rather than
    // redirects.
    expect(KeybindingsRoute.options.component).toBeDefined();
  });

  it("lands on General in the installed mobile app", async () => {
    setMobileApp(true);
    const router = buildRouter("/settings/keybindings");
    await router.load();

    expect(router.state.location.pathname).toBe("/settings/general");
    // `replace`, so the keybindings entry is overwritten rather than pushed -
    // Back leaves Settings instead of bouncing off this route into General
    // again.
    expect(router.history.length).toBe(1);
  });

  it("leaves other settings routes alone in the installed mobile app", async () => {
    setMobileApp(true);
    const router = buildRouter("/settings/general");
    await router.load();

    expect(router.state.location.pathname).toBe("/settings/general");
  });
});
