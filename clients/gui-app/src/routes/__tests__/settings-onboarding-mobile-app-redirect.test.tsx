/**
 * `/settings/onboarding` keeps its route on every build, because a URL
 * outlives the build that produced it - a bookmark, a remembered tab path, a
 * settings entry point, or a toast's "Learn more" deep link handed a stored
 * section id all navigate here. Where the section is not offered, the route
 * lands on General instead of rendering a panel the navigation beside it has
 * no row for.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { setMobileApp } from "@/lib/mobile-app";
import { Route as OnboardingRoute } from "@/routes/settings.onboarding";

afterEach(() => {
  setMobileApp(false);
});

// The route's own `beforeLoad`, mounted into a throwaway route tree rather
// than invoked directly: a redirect is only worth anything if the ROUTER
// honors it, so matching, redirect handling and history replacement all have
// to run. TanStack parameterizes the callback on the full file-route context
// and this one reads none of it, so a permissive sentinel keeps the fixture
// decoupled from that type.
const onboardingBeforeLoad = OnboardingRoute.options.beforeLoad as (args: {
  context: object;
}) => void;

function buildRouter(initialPath: string) {
  const rootRoute = createRootRoute();
  const onboardingRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/onboarding",
    beforeLoad: () => onboardingBeforeLoad({ context: {} }),
    component: () => <div data-testid="onboarding-panel" />,
  });
  const generalRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/general",
    component: () => <div data-testid="general-panel" />,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([onboardingRoute, generalRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

describe("/settings/onboarding route", () => {
  it("stays on the section for builds that offer it", async () => {
    setMobileApp(false);
    const router = buildRouter("/settings/onboarding");
    await router.load();

    expect(router.state.location.pathname).toBe("/settings/onboarding");
    // The real route renders the panel; the fixture above substitutes a stub
    // for it, so what is asserted here is that the route resolves rather than
    // redirects.
    expect(OnboardingRoute.options.component).toBeDefined();
  });

  it("lands on General in the installed mobile app", async () => {
    setMobileApp(true);
    const router = buildRouter("/settings/onboarding");
    await router.load();

    expect(router.state.location.pathname).toBe("/settings/general");
    // `replace`, so the onboarding entry is overwritten rather than pushed -
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
