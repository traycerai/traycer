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
import { CommandPalette } from "@/components/command-palette/command-palette";
import { CommandPaletteRouterContext } from "@/components/command-palette/command-palette-context";
import {
  EMPTY_DIRECTORY_STATE,
  PERSONAL_MAIN_BOT_ID,
  TWO_MAIN_BOTS_DIRECTORY,
  tracyRecord,
} from "@/lib/home-bots/__tests__/standalone-bots-fixtures";
import type { StandaloneBotsDirectory } from "@/lib/home-bots/standalone-bot-name";
import { routerAdapterFor } from "@/lib/keybindings/router-adapter";
import { useStandaloneBotsStore } from "@/stores/bots/standalone-bots-store";
import { useCommandPaletteStore } from "@/stores/command-palette/command-palette-store";

// The Tasks source reads the host's task history; these cases are about the
// Tracy rows, so it lists none.
vi.mock("@/lib/commands/sources/epics.source", () => ({
  epicsSource: { id: "epics", useItems: () => [] },
}));

/**
 * What a Tracy row says, as the production palette renders it: its name, and
 * beside it the team a team's bot is in where the name does not already say
 * it. A personal bot is never qualified.
 */

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

function buildRouter() {
  const rootRoute = createRootRoute({ component: Outlet });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

/** The text each option of the Tracy group shows: its name, then any qualifier. */
function renderedBotRows(): ReadonlyArray<ReadonlyArray<string | null>> {
  const group = screen.getByRole("group", { name: "Tracy" });
  return within(group)
    .getAllByRole("option")
    .map((option) =>
      within(option)
        .getAllByText(/.+/)
        .map((node) => node.textContent),
    );
}

async function openPalette(directory: StandaloneBotsDirectory): Promise<void> {
  useStandaloneBotsStore.setState({ directory, settled: true });
  const router = buildRouter();
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

describe("CommandPalette Tracy rows", () => {
  beforeEach(resetStores);
  afterEach(() => {
    cleanup();
    resetStores();
  });

  it("shows the team beside a team's bot and nothing beside a personal one", async () => {
    await openPalette(ONE_MAIN_BOT_WITH_TEAM_BOT);

    await waitFor(() => {
      expect(renderedBotRows()).toEqual([["Tracy"], ["Triage", "traycerai"]]);
    });
  });

  it("shows nothing beside a name that already carries its team", async () => {
    await openPalette(TWO_MAIN_BOTS_DIRECTORY);

    await waitFor(() => {
      expect(renderedBotRows()).toEqual([["Tracy"], ["Tracy · traycerai"]]);
    });
  });
});
