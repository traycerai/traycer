import { resetTracyPlaceStores, WINDOW_HOST } from "./tracy-place-test-fixture";
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
import { normalizeTracyPlaceSearch } from "@/lib/bots/tracy-place";
import { __resetTabNavigationHydrationForTesting } from "@/lib/tab-navigation";
import { TracyChannelPlaceRoute } from "@/routes/tracy-route-components";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import * as DesktopTabsPersistence from "@/stores/tabs/desktop-tabs-persistence";

/**
 * A desktop window reloaded onto a Tracy channel, on a real router with the
 * real `TabNavigationRouteBridge` and the real channel route. The window's
 * route replay is a load, and the surface's correction of its place onto the
 * route waits for it (`runWhenRouterSettled`).
 */

const BOT_A = "bot-a";
const CHANNEL_ROUTE = `/bot/${BOT_A}`;

vi.mock("@/providers/windows-bridge-context", () => ({
  // The per-window snapshot is in hand: the bridge replays once it mounts.
  useWindowsBridgeHydrated: () => true,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetTracyPlaceStores();
});

beforeEach(() => {
  resetTracyPlaceStores();
  // A window that has not restored its tabs yet.
  __resetTabNavigationHydrationForTesting();
});

describe("the Tracy surface's place on a reload onto its channel", () => {
  it("writes no replace while the route replay's load is in flight, and corrects the entry once it settles", async () => {
    let pending = { status: "first" as "first" | "gated" | "open" };
    let openReplay: () => void = () => undefined;
    const replayLoad = new Promise<void>((resolve) => {
      openReplay = resolve;
    });
    const rootRoute = createRootRoute({
      component: () => (
        <>
          <TabNavigationRouteBridge />
          <Outlet />
        </>
      ),
    });
    const channelRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/bot/$botId",
      validateSearch: normalizeTracyPlaceSearch,
      // The window's first load answers at once; the replay's waits.
      loader: () => {
        if (pending.status === "first") {
          pending = { status: "gated" };
          return undefined;
        }
        return pending.status === "gated" ? replayLoad : undefined;
      },
      component: TracyChannelPlaceRoute,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([channelRoute]),
      history: createMemoryHistory({ initialEntries: [CHANNEL_ROUTE] }),
    });
    let restored: string | null = CHANNEL_ROUTE;
    vi.spyOn(
      DesktopTabsPersistence,
      "consumeDesktopRestoredRoute",
    ).mockImplementation(() => {
      const value = restored;
      restored = null;
      return value;
    });
    // The surface was open on the channel when the window reloaded; its
    // entry names no place yet, so the surface corrects it.
    useTracySurfaceStore.setState({
      open: true,
      hostId: WINDOW_HOST,
      botId: BOT_A,
    });
    const replaces: Array<"pending" | "idle"> = [];
    const navigate = router.navigate;
    vi.spyOn(router, "navigate").mockImplementation((options) => {
      if (options.replace === true) replaces.push(router.state.status);
      return navigate(options);
    });

    render(<RouterProvider router={router} />);
    await waitFor(() => {
      expect(router.state.status).toBe("pending");
      expect(pending.status).toBe("gated");
    });
    expect(replaces).toEqual([]);

    act(() => {
      pending = { status: "open" };
      openReplay();
    });

    await waitFor(() => {
      expect(router.state.location.search).toHaveProperty("view");
    });
    expect(replaces.length).toBeGreaterThan(0);
    expect(new Set(replaces)).toEqual(new Set(["idle"]));
  });
});
