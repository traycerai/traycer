import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { CommandPalette } from "@/components/command-palette/command-palette";
import { CommandPaletteRouterContext } from "@/components/command-palette/command-palette-context";
import {
  EMPTY_DIRECTORY_STATE,
  PERSONAL_MAIN_BOT_ID,
  TEAM_MAIN_BOT_ID,
  TWO_MAIN_BOTS_DIRECTORY,
} from "@/lib/home-bots/__tests__/standalone-bots-fixtures";
import { routerAdapterFor } from "@/lib/keybindings/router-adapter";
import { useStandaloneBotsStore } from "@/stores/bots/standalone-bots-store";
import { useCommandPaletteStore } from "@/stores/command-palette/command-palette-store";

// The Tasks source reads the host's task history; this case is about the
// palette's context, so it lists none.
vi.mock("@/lib/commands/sources/epics.source", () => ({
  epicsSource: { id: "epics", useItems: () => [] },
}));

/**
 * The production palette stays mounted while closed, and its context reads the
 * path when it is built. Each opening must see the page it is opened on, not
 * the one an earlier opening (or the mount) saw. Its file runs compiled
 * (`REACT_COMPILER_REGRESSION_FILES`), as the packaged renderer runs it.
 */

function buildRouter() {
  const rootRoute = createRootRoute({ component: Outlet });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  const channelRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/bot/$botId",
    component: () => null,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute, channelRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

function shownBotRowIds(): ReadonlyArray<string> {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-slot="command-item"]'),
  ).flatMap((row) => {
    const value = row.getAttribute("data-value") ?? "";
    return value.startsWith("bot:") ? [value.split(" ")[0]] : [];
  });
}

function setPaletteOpen(open: boolean): void {
  act(() => {
    useCommandPaletteStore.getState().setOpen(open);
  });
}

function resetStores(): void {
  useCommandPaletteStore.setState({
    open: false,
    query: "",
    recentIds: [],
    pinnedIds: [],
  });
  useStandaloneBotsStore.setState(EMPTY_DIRECTORY_STATE, true);
}

describe("CommandPalette context across openings", () => {
  beforeEach(resetStores);
  afterEach(() => {
    cleanup();
    resetStores();
  });

  it("hides the channel each opening is on, after a route change while closed", async () => {
    useStandaloneBotsStore.setState({
      directory: TWO_MAIN_BOTS_DIRECTORY,
      settled: true,
    });
    const router = buildRouter();
    const adapter = routerAdapterFor(router);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CommandPaletteRouterContext.Provider value={adapter}>
          <RouterProvider router={router} />
          <CommandPalette />
        </CommandPaletteRouterContext.Provider>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(router.state.status).toBe("idle");
    });

    await act(() =>
      router.navigate({
        to: "/bot/$botId",
        params: { botId: TEAM_MAIN_BOT_ID },
      }),
    );
    setPaletteOpen(true);
    await waitFor(() => {
      expect(shownBotRowIds()).toEqual([`bot:${PERSONAL_MAIN_BOT_ID}`]);
    });
    setPaletteOpen(false);

    await act(() =>
      router.navigate({
        to: "/bot/$botId",
        params: { botId: PERSONAL_MAIN_BOT_ID },
      }),
    );
    setPaletteOpen(true);
    await waitFor(() => {
      expect(shownBotRowIds()).toEqual([`bot:${TEAM_MAIN_BOT_ID}`]);
    });
  });
});
