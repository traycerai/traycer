import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type RouterHistory,
  type UseNavigateResult,
} from "@tanstack/react-router";
import { TabNavigationRouteBridge } from "@/components/layout/bridges/tab-navigation-route-bridge";
import { openBotChannel } from "@/lib/bots/open-bot-channel";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import { useBotTabLandingStore } from "@/stores/bots/bot-tab-landing-store";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { emptyTabStripLayout } from "@/stores/tabs/layout";
import { TRACY_TAB_REF } from "@/stores/tabs/kinds/tracy";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";

/**
 * Selecting a Tracy channel is a navigation, committed when the real
 * `TabNavigationController` sees the navigation acknowledged on a real router
 * history (through the real `TabNavigationRouteBridge`), never before.
 */

const WINDOW_HOST = "host-window";

function buildRouter(initialPath: string) {
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
  const tracyRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/bot",
    component: () => null,
  });
  const channelRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/bot/$botId",
    component: () => null,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute, tracyRoute, channelRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

interface Mounted {
  readonly navigate: UseNavigateResult<string>;
  readonly history: RouterHistory;
  readonly pathname: () => string;
}

async function mount(initialPath: string): Promise<Mounted> {
  const router = buildRouter(initialPath);
  render(<RouterProvider router={router} />);
  await waitFor(() => {
    expect(router.state.location.pathname).toBe(initialPath);
    expect(router.state.status).toBe("idle");
  });
  return {
    navigate: router.navigate,
    history: router.history,
    pathname: () => router.state.location.pathname,
  };
}

function open(navigate: UseNavigateResult<string>, botId: string): boolean {
  return openBotChannel(navigate, botId, {
    landing: null,
    isConnectable: null,
    onRejected: null,
  });
}

function selection(router: Mounted): {
  readonly pathname: string;
  readonly botId: string | null;
} {
  return {
    pathname: router.pathname(),
    botId: useTracySurfaceStore.getState().botId,
  };
}

function resetStores(): void {
  window.localStorage.clear();
  useTracySurfaceStore.setState({
    open: false,
    hostId: null,
    botId: null,
    visitedBotIds: [],
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

describe("Tracy channel selection commits on navigation acknowledgement", () => {
  beforeEach(resetStores);
  afterEach(() => {
    cleanup();
    resetStores();
  });

  it("ends on the last channel opened when channels are opened in quick succession", async () => {
    const router = await mount("/");

    act(() => {
      open(router.navigate, "bot-a");
      open(router.navigate, "bot-b");
      open(router.navigate, "bot-c");
    });

    await waitFor(() => {
      expect(selection(router)).toEqual({
        pathname: "/bot/bot-c",
        botId: "bot-c",
      });
    });
    expect(useTracySurfaceStore.getState().hostId).toBe(WINDOW_HOST);
    expect(useTabsStore.getState().activeItemId).toBe("tab:tracy:tracy");
  });

  it("keeps the previous channel selected, under its own URL, when the history refuses the switch", async () => {
    const router = await mount("/");
    act(() => {
      open(router.navigate, "bot-a");
    });
    await waitFor(() => {
      expect(selection(router)).toEqual({
        pathname: "/bot/bot-a",
        botId: "bot-a",
      });
    });

    const refused: string[] = [];
    const unblock = router.history.block({
      blockerFn: ({ nextLocation }) => {
        refused.push(nextLocation.pathname);
        return true;
      },
      enableBeforeUnload: false,
    });
    let accepted = false;
    act(() => {
      accepted = open(router.navigate, "bot-b");
    });
    await waitFor(() => {
      expect(refused).toEqual(["/bot/bot-b"]);
    });
    unblock();

    // The controller took the request; the history refused it.
    expect(accepted).toBe(true);
    expect(selection(router)).toEqual({
      pathname: "/bot/bot-a",
      botId: "bot-a",
    });
  });

  it("keeps the previous channel selected, under its own URL, when the navigation is rejected", async () => {
    const router = await mount("/");
    act(() => {
      open(router.navigate, "bot-a");
    });
    await waitFor(() => {
      expect(selection(router)).toEqual({
        pathname: "/bot/bot-a",
        botId: "bot-a",
      });
    });

    const rejection = Promise.reject<void>(new Error("navigation refused"));
    const rejecting: UseNavigateResult<string> = () => rejection;
    await act(async () => {
      open(rejecting, "bot-b");
      // The controller subscribed to the rejection first, so its handling has
      // run once this settles.
      await rejection.catch(() => undefined);
    });

    expect(selection(router)).toEqual({
      pathname: "/bot/bot-a",
      botId: "bot-a",
    });
    expect(useTabsStore.getState().activeItemId).toBe("tab:tracy:tracy");
  });

  it("pushes history on a switch, so Back returns to the previous channel and the selection follows it", async () => {
    const router = await mount("/");
    for (const botId of ["bot-a", "bot-b"]) {
      act(() => {
        open(router.navigate, botId);
      });
      await waitFor(() => {
        expect(selection(router)).toEqual({
          pathname: `/bot/${botId}`,
          botId,
        });
      });
    }

    act(() => {
      router.history.back();
    });
    await waitFor(() => {
      expect(selection(router)).toEqual({
        pathname: "/bot/bot-a",
        botId: "bot-a",
      });
    });

    act(() => {
      router.history.forward();
    });
    await waitFor(() => {
      expect(selection(router)).toEqual({
        pathname: "/bot/bot-b",
        botId: "bot-b",
      });
    });
  });

  it("opens the closed surface on the window host and selects the channel of an external /bot/{id} navigation", async () => {
    const router = await mount("/");
    expect(useTracySurfaceStore.getState().open).toBe(false);

    act(() => {
      router.history.push("/bot/bot-x");
    });

    await waitFor(() => {
      expect(useTracySurfaceStore.getState().open).toBe(true);
    });
    const surface = useTracySurfaceStore.getState();
    expect({
      hostId: surface.hostId,
      botId: surface.botId,
      pathname: router.pathname(),
      activeRef: useTabsStore
        .getState()
        .items.map((item) => (item.kind === "tab" ? item.ref : null)),
    }).toEqual({
      hostId: WINDOW_HOST,
      botId: "bot-x",
      pathname: "/bot/bot-x",
      activeRef: [TRACY_TAB_REF],
    });
  });
});
