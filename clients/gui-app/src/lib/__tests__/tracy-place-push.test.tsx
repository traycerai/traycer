import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { TabNavigationRouteBridge } from "@/components/layout/bridges/tab-navigation-route-bridge";
import { openBotChannel } from "@/lib/bots/open-bot-channel";
import { normalizeTracyPlaceSearch } from "@/lib/bots/tracy-place";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import { useBotTabLandingStore } from "@/stores/bots/bot-tab-landing-store";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { emptyTabStripLayout } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";

/**
 * A place the Tracy surface writes onto its own route, or a step between two
 * of its entries, is the surface committing what it already holds: the
 * controller records it and takes no tab command for it.
 */

const WINDOW_HOST = "host-window";

function buildRouter() {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <TabNavigationRouteBridge />
        <Outlet />
      </>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  const channelRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/bot/$botId",
    validateSearch: normalizeTracyPlaceSearch,
    component: () => null,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute, channelRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

function resetStores(): void {
  window.localStorage.clear();
  useTracySurfaceStore.setState({
    open: false,
    hostId: null,
    botId: null,
    visitedBotIds: [],
    goneBotIds: [],
  });
  useBotTabLandingStore.setState(useBotTabLandingStore.getInitialState(), true);
  useSelectionAuthorityStore.setState({
    attached: true,
    effectiveHostId: WINDOW_HOST,
  });
  useTabsStore.setState({ ...emptyTabStripLayout(), stripOrder: [] });
  tabCommandCoordinator.resetReconciliationForTesting();
  __resetTabNavigationControllerForTesting();
}

async function mountOnChannelA() {
  const router = buildRouter();
  render(<RouterProvider router={router} />);
  await waitFor(() => {
    expect(router.state.status).toBe("idle");
  });
  act(() => {
    openBotChannel(router.navigate, "bot-a", {
      landing: null,
      isConnectable: null,
      onRejected: null,
    });
  });
  await waitFor(() => {
    expect(router.state.location.pathname).toBe("/bot/bot-a");
    expect(useTracySurfaceStore.getState().botId).toBe("bot-a");
  });
  return router;
}

describe("a place written while the Tracy surface holds the focus", () => {
  beforeEach(resetStores);
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
    resetStores();
  });

  it("keeps the pathname, the channel and the focus, and activates nothing", async () => {
    const router = await mountOnChannelA();
    const length = router.history.length;
    const activations = vi.spyOn(tabCommandCoordinator, "activateTab");

    await act(async () => {
      await router.navigate({
        to: "/bot/$botId",
        params: { botId: "bot-a" },
        search: { view: "activity" },
      });
    });

    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ view: "activity" });
    });
    expect(router.state.location.pathname).toBe("/bot/bot-a");
    expect(useTracySurfaceStore.getState().botId).toBe("bot-a");
    expect(useTabsStore.getState().activeItemId).toBe("tab:tracy:tracy");
    expect(router.history.length).toBe(length + 1);
    expect(activations).not.toHaveBeenCalled();
  });

  it("activates nothing for a step back or forward between two of its entries either", async () => {
    const router = await mountOnChannelA();
    await act(async () => {
      await router.navigate({
        to: "/bot/$botId",
        params: { botId: "bot-a" },
        search: { view: "activity" },
      });
    });
    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ view: "activity" });
    });
    const activations = vi.spyOn(tabCommandCoordinator, "activateTab");

    act(() => {
      router.history.back();
    });
    await waitFor(() => {
      expect(router.state.location.search).not.toMatchObject({
        view: "activity",
      });
    });
    act(() => {
      router.history.forward();
    });
    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ view: "activity" });
    });

    expect(useTracySurfaceStore.getState().botId).toBe("bot-a");
    expect(activations).not.toHaveBeenCalled();
  });
});
