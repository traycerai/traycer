import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import userEvent from "@testing-library/user-event";
import { TabNavigationRouteBridge } from "@/components/layout/bridges/tab-navigation-route-bridge";
import { CommandPalette } from "@/components/command-palette/command-palette";
import { CommandPaletteRouterContext } from "@/components/command-palette/command-palette-context";
import {
  EMPTY_DIRECTORY_STATE,
  PERSONAL_MAIN_BOT_ID,
  TEAM_MAIN_BOT_ID,
  TWO_MAIN_BOTS_DIRECTORY,
  tracyRecord,
} from "@/lib/home-bots/__tests__/standalone-bots-fixtures";
import type { StandaloneBotsDirectory } from "@/lib/home-bots/standalone-bot-name";
import { routerAdapterFor } from "@/lib/keybindings/router-adapter";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import { useStandaloneBotsStore } from "@/stores/bots/standalone-bots-store";
import { useCommandPaletteStore } from "@/stores/command-palette/command-palette-store";

// The Tasks source reads the host's task history; these cases are about the
// Tracy rows, so it lists none.
vi.mock("@/lib/commands/sources/epics.source", () => ({
  epicsSource: { id: "epics", useItems: () => [] },
}));

/** A personal Tracy (the only main bot) and a team's bot with no main bot. */
const ONE_MAIN_BOT_WITH_TEAM_BOT: StandaloneBotsDirectory = {
  model: {
    groups: [
      {
        environmentId: "env-me",
        label: "Personal",
        ownerKind: "user",
        canCreate: true,
        bots: [tracyRecord(PERSONAL_MAIN_BOT_ID, "env-me")],
        mainBotId: PERSONAL_MAIN_BOT_ID,
      },
      {
        environmentId: "env-team",
        label: "traycerai",
        ownerKind: "organization",
        canCreate: true,
        bots: [{ ...tracyRecord("bot-triage", "env-team"), title: "Triage" }],
        mainBotId: null,
      },
    ],
    botCount: 2,
  },
  setups: [],
};

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
  const channelRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/bot/$botId",
    component: () => null,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute, channelRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

/** The group headings cmdk renders, top to bottom. */
function groupHeadings(): ReadonlyArray<string | null> {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[cmdk-group-heading]"),
  ).map((el) => el.textContent);
}

/** The text each option of a group shows: its name, then any qualifier. */
function renderedBotRows(
  groupName: string,
): ReadonlyArray<ReadonlyArray<string | null>> {
  const group = screen.getByRole("group", { name: groupName });
  return within(group)
    .getAllByRole("option")
    .map((option) =>
      within(option)
        .getAllByText(/.+/)
        .map((node) => node.textContent),
    );
}

async function openPalette(
  directory: StandaloneBotsDirectory,
  initialPath: string,
): Promise<{ readonly pathname: () => string }> {
  useStandaloneBotsStore.setState({ directory, settled: true });
  const router = buildRouter(initialPath);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CommandPaletteRouterContext.Provider value={routerAdapterFor(router)}>
        <RouterProvider router={router} />
        <CommandPalette />
      </CommandPaletteRouterContext.Provider>
    </QueryClientProvider>,
  );
  await waitFor(() => {
    expect(router.state.status).toBe("idle");
  });
  act(() => {
    useCommandPaletteStore.getState().setOpen(true);
  });
  return { pathname: () => router.state.location.pathname };
}

function resetStores(): void {
  useCommandPaletteStore.setState({
    open: false,
    query: "",
    recentIds: [],
    pinnedIds: [],
  });
  useStandaloneBotsStore.setState(EMPTY_DIRECTORY_STATE, true);
  useTracySurfaceStore.setState({
    open: false,
    hostId: null,
    botId: null,
    visitedBotIds: [],
  });
  useSelectionAuthorityStore.setState({
    attached: true,
    effectiveHostId: "host-window",
  });
}

/**
 * What a Tracy row says, as the production palette renders it: its name, and
 * beside it the team a team's bot is in where the name does not already say
 * it. A personal bot is never qualified.
 */
describe("CommandPalette Tracy rows", () => {
  beforeEach(resetStores);
  afterEach(() => {
    cleanup();
    resetStores();
  });

  it("shows the main bot under Main bots and a team's other bot under Tracy, with the team beside it", async () => {
    await openPalette(ONE_MAIN_BOT_WITH_TEAM_BOT, "/");

    await waitFor(() => {
      expect(renderedBotRows("Main bots")).toEqual([["Tracy"]]);
    });
    expect(renderedBotRows("Tracy")).toEqual([["Triage", "traycerai"]]);
  });

  it("shows nothing beside a name that already carries its team, and no Tracy group when every bot is a main bot", async () => {
    await openPalette(TWO_MAIN_BOTS_DIRECTORY, "/");

    await waitFor(() => {
      expect(renderedBotRows("Main bots")).toEqual([
        ["Tracy"],
        ["Tracy · traycerai"],
      ]);
    });
    expect(screen.queryByRole("group", { name: "Tracy" })).toBeNull();
  });

  it("leads at rest with Main bots, ahead of Pinned and Recent", async () => {
    useCommandPaletteStore.setState({
      pinnedIds: ["nav:epics"],
      recentIds: ["nav:settings"],
    });
    await openPalette(ONE_MAIN_BOT_WITH_TEAM_BOT, "/");

    await waitFor(() => {
      expect(groupHeadings().slice(0, 3)).toEqual([
        "Main bots",
        "Pinned",
        "Recent",
      ]);
    });
  });

  it("shows a main bot that is pinned and recent once, under Main bots, while a pinned non-main bot sits under Pinned and not again under Tracy", async () => {
    useCommandPaletteStore.setState({
      pinnedIds: [`bot:${PERSONAL_MAIN_BOT_ID}`, "bot:bot-triage"],
      recentIds: [`bot:${PERSONAL_MAIN_BOT_ID}`],
    });
    await openPalette(ONE_MAIN_BOT_WITH_TEAM_BOT, "/");

    await waitFor(() => {
      expect(renderedBotRows("Main bots")).toEqual([["Tracy"]]);
    });
    expect(renderedBotRows("Pinned")).toEqual([["Triage", "traycerai"]]);
    expect(screen.queryByRole("group", { name: "Recent" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Tracy" })).toBeNull();
    expect(screen.getAllByRole("option", { name: /^Tracy/ })).toHaveLength(1);
    expect(screen.getAllByRole("option", { name: /^Triage/ })).toHaveLength(1);
  });

  it("hides Main bots for a query that matches only a non-main bot, and shows it for a query that matches the main bot", async () => {
    const user = userEvent.setup();
    await openPalette(ONE_MAIN_BOT_WITH_TEAM_BOT, "/");
    const search = await screen.findByRole("combobox");

    await user.type(search, "Triage");
    await waitFor(() => {
      expect(renderedBotRows("Tracy")).toEqual([["Triage", "traycerai"]]);
    });
    expect(screen.queryByRole("group", { name: "Main bots" })).toBeNull();

    await user.clear(search);
    await user.type(search, "Personal");
    await waitFor(() => {
      expect(renderedBotRows("Main bots")).toEqual([["Tracy"]]);
    });
    expect(screen.queryByRole("group", { name: "Tracy" })).toBeNull();
  });

  it("opens the main bot's channel when its row is chosen", async () => {
    const user = userEvent.setup();
    const palette = await openPalette(TWO_MAIN_BOTS_DIRECTORY, "/");

    await user.click(
      await screen.findByRole("option", { name: "Tracy · traycerai" }),
    );

    await waitFor(() => {
      expect(palette.pathname()).toBe(`/bot/${TEAM_MAIN_BOT_ID}`);
      expect(useTracySurfaceStore.getState().botId).toBe(TEAM_MAIN_BOT_ID);
    });
  });

  it("leaves the channel already shown out of Main bots", async () => {
    await openPalette(TWO_MAIN_BOTS_DIRECTORY, `/bot/${TEAM_MAIN_BOT_ID}`);

    await waitFor(() => {
      expect(renderedBotRows("Main bots")).toEqual([["Tracy"]]);
    });
  });
});
