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
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { TabNavigationRouteBridge } from "@/components/layout/bridges/tab-navigation-route-bridge";
import { registerHostPickerDirectory } from "@/hooks/host/use-host-picker-list";
import { filterByScope } from "@/lib/commands/grouping";
import { getOpenerItems } from "@/lib/commands/registry";
import { SCOPE_DESCRIPTORS } from "@/lib/commands/scopes";
import { botsSource } from "@/lib/commands/sources/bots.source";
import type { CommandContext, CommandItem } from "@/lib/commands/types";
import {
  EMPTY_DIRECTORY_STATE,
  ONE_TEAM_MAIN_BOT_DIRECTORY,
  PERSONAL_MAIN_BOT_ID,
  TEAM_MAIN_BOT_ID,
  TWO_MAIN_BOTS_DIRECTORY,
} from "@/lib/home-bots/__tests__/standalone-bots-fixtures";
import type { StandaloneBotsDirectory } from "@/lib/home-bots/standalone-bot-name";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";
import { routerAdapterFor } from "@/lib/keybindings/router-adapter";
import { queryClient } from "@/lib/query-client";
import { uiQueryKeys } from "@/lib/query-keys";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import { useBotTabLandingStore } from "@/stores/bots/bot-tab-landing-store";
import { useStandaloneBotsStore } from "@/stores/bots/standalone-bots-store";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { emptyTabStripLayout } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";

/** The directory the app's host binding names; its list is read from the cache. */
const HOST_DIRECTORY = vi.hoisted(() => ({
  list: (): Promise<readonly HostDirectoryEntry[]> => Promise.resolve([]),
}));

vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
  getHostBindingSnapshot: () => ({ directory: HOST_DIRECTORY }),
}));

const WINDOW_HOST = "host-window";
const SURFACE_HOST = "host-surface";

const IDLE_ROUTER: KeybindingRouter = {
  getPathname: () => "/",
  navigateHome: () => undefined,
  navigateSettings: () => undefined,
  navigateToEpic: () => undefined,
  navigateToEpicTab: () => undefined,
  navigateToEpicList: () => undefined,
  navigateSettingsSection: () => undefined,
  navigateToTabIntent: () => undefined,
  goBack: () => undefined,
  goForward: () => undefined,
  isHistoryNavAvailable: () => false,
  canGoBack: () => false,
  canGoForward: () => false,
};

function ctx(
  pathname: string,
  router: KeybindingRouter,
  targetGroupId: string | null,
): CommandContext {
  return {
    pathname,
    router,
    activeTabId: null,
    activeEpicId: null,
    focusedComposerKind: null,
    targetGroupId,
  };
}

function setDirectory(directory: StandaloneBotsDirectory): void {
  useStandaloneBotsStore.setState({ directory, settled: true });
}

function captureItems(context: CommandContext): ReadonlyArray<CommandItem> {
  let captured: ReadonlyArray<CommandItem> = [];
  function Probe() {
    captured = botsSource.useItems(context);
    return null;
  }
  render(<Probe />);
  return captured;
}

function rows(items: ReadonlyArray<CommandItem>) {
  return items.map((item) => ({
    id: item.id,
    label: item.label,
    description: item.description,
    keywords: item.keywords,
    group: item.group,
  }));
}

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
    component: () => null,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute, channelRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

async function mountRouter() {
  const router = buildRouter();
  render(<RouterProvider router={router} />);
  await waitFor(() => {
    expect(router.state.status).toBe("idle");
  });
  return router;
}

function dialableEntry(hostId: string): HostDirectoryEntry {
  return {
    hostId,
    label: hostId,
    kind: "local",
    websocketUrl: `ws://127.0.0.1/${hostId}`,
    version: "1.0.0",
    transportDialability: "dialable",
  };
}

function answerDirectory(entries: readonly HostDirectoryEntry[]): void {
  queryClient.setQueryData(
    uiQueryKeys.hostPicker(registerHostPickerDirectory(HOST_DIRECTORY)),
    entries,
  );
}

function resetStores(): void {
  window.localStorage.clear();
  queryClient.clear();
  useStandaloneBotsStore.setState(EMPTY_DIRECTORY_STATE, true);
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

describe("bots palette source", () => {
  beforeEach(resetStores);
  afterEach(() => {
    cleanup();
    resetStores();
  });

  it("names a team's main bot with its team while the bare name could mean two main bots", () => {
    setDirectory(TWO_MAIN_BOTS_DIRECTORY);

    expect(rows(captureItems(ctx("/", IDLE_ROUTER, null)))).toEqual([
      {
        id: `bot:${PERSONAL_MAIN_BOT_ID}`,
        label: "Tracy",
        description: "Personal",
        keywords: ["Tracy", "Personal", "tracy", "bot", "channel"],
        group: "bots",
      },
      {
        id: `bot:${TEAM_MAIN_BOT_ID}`,
        label: "Tracy · traycerai",
        description: null,
        keywords: ["Tracy", "traycerai", "tracy", "bot", "channel"],
        group: "bots",
      },
    ]);
  });

  it("gives the bare name and the environment beside it when one main bot is seen", () => {
    setDirectory(ONE_TEAM_MAIN_BOT_DIRECTORY);

    expect(rows(captureItems(ctx("/", IDLE_ROUTER, null)))).toEqual([
      {
        id: `bot:${TEAM_MAIN_BOT_ID}`,
        label: "Tracy",
        description: "traycerai",
        keywords: ["Tracy", "traycerai", "tracy", "bot", "channel"],
        group: "bots",
      },
    ]);
  });

  it("lists a team's main bot still to be set up, whose channel exists", () => {
    setDirectory({
      model: {
        groups: [
          ...ONE_TEAM_MAIN_BOT_DIRECTORY.model.groups,
          {
            environmentId: "env-other",
            label: "acme",
            ownerKind: "organization",
            canCreate: true,
            bots: [],
            mainBotId: null,
          },
        ],
        botCount: 1,
      },
      setups: [
        {
          environmentId: "env-other",
          teamName: "acme",
          botId: "bot-setup",
          title: "Tracy",
        },
      ],
    });

    expect(
      captureItems(ctx("/", IDLE_ROUTER, null)).map((item) => item.label),
    ).toEqual(["Tracy · traycerai", "Tracy · acme"]);
  });

  it("leaves out the channel the palette is opened on", () => {
    setDirectory(TWO_MAIN_BOTS_DIRECTORY);

    const items = captureItems(
      ctx(`/bot/${TEAM_MAIN_BOT_ID}`, IDLE_ROUTER, null),
    );

    expect(items.map((item) => item.id)).toEqual([
      `bot:${PERSONAL_MAIN_BOT_ID}`,
    ]);
  });

  it("emits nothing while the directory is empty", () => {
    expect(captureItems(ctx("/", IDLE_ROUTER, null))).toEqual([]);
  });

  it("is found with no prefix and hidden by every scope prefix", () => {
    setDirectory(TWO_MAIN_BOTS_DIRECTORY);
    const items = captureItems(ctx("/", IDLE_ROUTER, null));

    expect(filterByScope(items, null)).toHaveLength(2);
    for (const descriptor of SCOPE_DESCRIPTORS) {
      expect(filterByScope(items, descriptor.scope)).toEqual([]);
    }
  });

  it("is absent from the opener bound to a pane", () => {
    setDirectory(TWO_MAIN_BOTS_DIRECTORY);

    const openerIds = getOpenerItems(ctx("/", IDLE_ROUTER, "group-1")).map(
      (item) => item.id,
    );

    expect(openerIds.length).toBeGreaterThan(0);
    expect(openerIds.filter((id) => id.startsWith("bot:"))).toEqual([]);
  });

  it("opens the Tracy surface on the row's channel through the router adapter", async () => {
    setDirectory(TWO_MAIN_BOTS_DIRECTORY);
    const router = await mountRouter();
    const context = ctx("/", routerAdapterFor(router), null);
    const row = captureItems(context).find(
      (item) => item.id === `bot:${TEAM_MAIN_BOT_ID}`,
    );
    if (row === undefined) throw new Error("expected the team bot's row");

    act(() => {
      void row.run(context);
    });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/bot/${TEAM_MAIN_BOT_ID}`);
      expect(useTracySurfaceStore.getState().botId).toBe(TEAM_MAIN_BOT_ID);
    });
    expect(useTracySurfaceStore.getState().hostId).toBe(WINDOW_HOST);
  });

  it("moves an open surface to the window's host when the directory says its host cannot be dialed", async () => {
    setDirectory(TWO_MAIN_BOTS_DIRECTORY);
    useTracySurfaceStore.getState().openSurface(SURFACE_HOST);
    answerDirectory([dialableEntry(WINDOW_HOST)]);
    const router = await mountRouter();
    const context = ctx("/", routerAdapterFor(router), null);
    const [row] = captureItems(context);

    act(() => {
      void row.run(context);
    });

    await waitFor(() => {
      expect(useTracySurfaceStore.getState().botId).toBe(PERSONAL_MAIN_BOT_ID);
    });
    expect(useTracySurfaceStore.getState().hostId).toBe(WINDOW_HOST);
  });

  it("keeps an open surface on its host while the directory can dial it", async () => {
    setDirectory(TWO_MAIN_BOTS_DIRECTORY);
    useTracySurfaceStore.getState().openSurface(SURFACE_HOST);
    answerDirectory([dialableEntry(WINDOW_HOST), dialableEntry(SURFACE_HOST)]);
    const router = await mountRouter();
    const context = ctx("/", routerAdapterFor(router), null);
    const [row] = captureItems(context);

    act(() => {
      void row.run(context);
    });

    await waitFor(() => {
      expect(useTracySurfaceStore.getState().botId).toBe(PERSONAL_MAIN_BOT_ID);
    });
    expect(useTracySurfaceStore.getState().hostId).toBe(SURFACE_HOST);
  });
});
