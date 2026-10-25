/**
 * The fixed Tracy entry (Tracy Bots T58), through the REAL
 * `TracyEntryController`, the real top and vertical strips, the real
 * keybinding dispatch and the real General settings panel, over the real
 * settings, bot-tabs, tabs and layout stores. Only host boundaries are
 * scripted: the bot list (a query over the real client cache, refetched by the
 * real `bot.listChanged` subscription), Personal's id, method support, the
 * connectable hosts, the notification indicators and the bot's activity (the
 * real protocol schemas do not load in this suite's jsdom).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  QueryClient,
  QueryClientProvider,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import type {
  BotListResponse,
  BotRecord,
} from "@traycer/protocol/host/bot/schemas";
import type { StreamFrameEnvelope } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import { MockWsStreamClient } from "@/components/epic-canvas/pr/__tests__/pr-stream-test-fixtures";
import { GeneralSettingsPanel } from "@/components/settings/panels/general-settings-panel";
import { SideTabStrip } from "@/components/layout/tabs/side-strip/side-tab-strip";
import { SheetJoinScope } from "@/components/layout/tabs/sheet-join";
import { TabStrip } from "@/components/layout/tabs/tab-strip";
import { TracyEntryController } from "@/components/layout/tabs/tracy-entry-controller";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { BotActivity } from "@/hooks/bots/use-bot-activity";
import { __resetBotListChangedSessionsForTesting } from "@/hooks/bots/use-bot-list-changed-subscription";
import type { ConnectableHosts } from "@/hooks/host/use-connectable-host-ids";
import {
  getLeaderScopesTopDown,
  LEADER_SCOPE_HEADER_TABS,
} from "@/lib/keybindings/leader-scope";
import {
  registerBaseLeaderScope,
  type KeybindingRouter,
} from "@/lib/keybindings/dispatch";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import { installTabSyncCoordinator } from "@/lib/tab-sync/tab-sync-coordinator";
import { WindowsBridgeContext } from "@/providers/windows-bridge-context";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { lookupBotTab, useBotTabsStore } from "@/stores/bots/bot-tabs-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import { useSideTabStripStore } from "@/stores/layout/side-tab-strip-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { SurfaceNotificationIndicators } from "@/stores/notifications/notification-indicator-state";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { tabItemId, tabRefKey } from "@/stores/tabs/layout";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { tabResolveIntent } from "@/stores/tabs/registry";
import { useTabsStore } from "@/stores/tabs/store";
import { getHeaderTabs } from "@/stores/tabs/use-header-tabs";
import type { TabRef } from "@/stores/tabs/types";

const PERSONAL_ENV = "env-personal";
const TEAM_ENV = "env-team";
const TRACY = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TEAM_BOT = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const TRACY_REF: TabRef = { kind: "bot", id: TRACY };
const NO_FLAGS = {
  pendingApproval: false,
  pendingInterview: false,
  pendingFork: false,
  unreadFailure: false,
  unreadDone: false,
};

/** What the scripted host boundaries answer; each test sets what it needs. */
const scripted = vi.hoisted(
  (): {
    list: BotListResponse | undefined;
    activity: BotActivity | null;
    indicators: SurfaceNotificationIndicators;
    connectable: ConnectableHosts;
    stream: MockWsStreamClient<StreamFrameEnvelope> | null;
  } => ({
    list: undefined,
    activity: null,
    indicators: { epics: {}, chats: {} },
    connectable: { hostIds: [], resolved: true },
    stream: null,
  }),
);

// The list is a real query over the test's client cache, answering what the
// test scripted, so a `bot.list` invalidation refetches it as it does in the
// app.
vi.mock("@/hooks/bots/use-bot-list-query", () => ({
  useBotListQuery: (_client: unknown, enabled: boolean) =>
    useQuery(
      queryOptions({
        queryKey: hostQueryKeys.methodScope("host-a", "bot.list"),
        queryFn: () => {
          if (scripted.list === undefined) throw new Error("No scripted list");
          return Promise.resolve(scripted.list);
        },
        initialData: scripted.list,
        enabled,
      }),
    ),
}));
// The app-wide stream the `bot.listChanged` doorbell rides.
vi.mock("@/lib/host/stream-runtime-context", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/host/stream-runtime-context")
  >()),
  useStreamHostId: () => "host-a",
  useWsStreamClient: () => scripted.stream,
}));
vi.mock("@/hooks/host/use-connectable-host-ids", () => ({
  useConnectableHostIds: () => scripted.connectable,
}));
vi.mock(
  "@/hooks/environment/use-addressed-environment",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/environment/use-addressed-environment")
    >()),
    usePersonalEnvironment: () => ({
      environmentId: "env-personal",
      resolved: true,
    }),
  }),
);
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => "host-a",
}));
vi.mock("@/hooks/host/use-host-supports-method", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-supports-method")
  >()),
  useHostMethodSupport: () => true,
}));
vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
  useHostClient: () => ({ getActiveHostId: () => "host-a" }),
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => ({ getActiveHostId: () => "host-a" }),
}));
vi.mock("@/hooks/bots/use-bot-activity", () => ({
  useBotActivity: () => scripted.activity,
}));
vi.mock(
  "@/hooks/notifications/use-notification-indicators-query",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/notifications/use-notification-indicators-query")
    >()),
    useNotificationIndicators: () => scripted.indicators,
  }),
);

// Strip collaborators that reach a host runtime this harness does not mount;
// the suite is about the entry, not the strip's own host reads.
vi.mock("@/hooks/notifications/use-host-notification-indicators-query", () => ({
  useHostNotificationIndicators: () => ({
    data: { epics: {}, chats: {} },
    isPending: false,
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(),
  }),
}));
vi.mock("@/hooks/epic/use-epic-task-pinned-states-query", () => ({
  useEpicTaskPinnedStates: () => new Map<string, boolean>(),
  useRetryUnansweredTaskPinReading: () => () => undefined,
}));
vi.mock(
  "@/hooks/epic/use-epic-set-pinned-mutation",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/epic/use-epic-set-pinned-mutation")
    >()),
    useEpicSetPinned: () => ({ mutate: vi.fn() }),
    usePendingSetPinnedEpicIds: () => new Set<string>(),
  }),
);
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
vi.mock("@/hooks/epic/use-epic-pin-local-home-support", () => ({
  useEpicPinLocalHomeSupported: () => false,
}));
vi.mock("@/lib/epic-selectors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/epic-selectors")>()),
  useRegisteredEpicPermissionRole: () => "owner",
  useRegisteredEpicLocalHome: () => true,
}));
vi.mock("@/components/layout/header/header-actions", () => ({
  HeaderUsageRegion: () => <span data-testid="foot-usage" />,
  HeaderResourceRegion: () => <span data-testid="foot-resource" />,
}));
vi.mock("@/components/layout/header/app-update-button", () => ({
  AppUpdateHeaderButton: () => <span data-testid="foot-update" />,
}));
vi.mock("@/hooks/host/use-host-directory-entry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-directory-entry")
  >()),
  useHostDirectoryEntry: () => null,
}));
vi.mock("@/hooks/notifications/use-notification-host", () => ({
  useNotificationResolveHostId: () => null,
  useNotificationResolveHost: () => ({ hostId: null, client: null }),
}));
vi.mock("@/hooks/notifications/use-notification-activation", () => ({
  useNotificationActivation: () => ({ activate: vi.fn() }),
}));
vi.mock("@/components/auth/user-menu", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/auth/user-menu")>()),
  UserMenu: () => <span data-testid="foot-account" />,
}));

installTabSyncCoordinator({ readyPromise: Promise.resolve() });

/** A stream client whose host serves every method, so a doorbell subscribes. */
class ServingStreamClient extends MockWsStreamClient<StreamFrameEnvelope> {
  override getMethodSupport(): StreamMethodSupport {
    return "supported";
  }

  override subscribeMethodSupport(): () => void {
    return () => undefined;
  }
}

const CHANGED: StreamFrameEnvelope = {
  kind: "changed",
  hasBinaryPayload: false,
};

let queryClient: QueryClient;

function bot(
  botId: string,
  environmentId: string,
  title: string,
  archivedAt: number | null,
): BotRecord {
  return {
    botId,
    environmentId,
    createdByUserId: "user-1",
    title,
    harness: "claude",
    model: "opus",
    effort: null,
    profile: null,
    trunkChatId: `trunk-${botId}`,
    boundHostId: "host-a",
    hostEpoch: 0,
    createdAt: 1_000,
    archivedAt,
    directive: null,
    replyMode: "direct",
    appConversationChatId: `app-${botId}`,
  };
}

function tracyIsMainBot(): void {
  scripted.list = {
    bots: [
      bot(TRACY, PERSONAL_ENV, "Tracy", null),
      bot(TEAM_BOT, TEAM_ENV, "Release Bot", null),
    ],
    mainBotIds: { [PERSONAL_ENV]: TRACY, [TEAM_ENV]: TEAM_BOT },
  };
}

function replying(step: string | null): BotActivity {
  return {
    trunk: {
      state: "replying",
      startedAt: Date.now() - 3 * 60_000,
      step,
      requestId: "req-1",
    },
    threads: {},
  };
}

function setHomeTabEnabled(enabled: boolean): void {
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
  useLayoutStore
    .getState()
    .setRegionValues("homeTab", { shown: enabled ? "shown" : "hidden" });
}

function resetStores(): void {
  __resetTabNavigationControllerForTesting();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  useBotTabsStore.setState({ tabs: {}, fixedBotId: null });
  useSettingsStore.setState({ showTracy: true });
  useSideTabStripStore.setState({
    widthPx: 240,
    collapsed: false,
    dragCollapsed: null,
  });
  // The vertical strip's foot shows a signed-in account row.
  useAuthStore.setState({
    status: "signed-in",
    profile: {
      userId: "u-1",
      userName: "Ada",
      email: "ada@example.com",
      avatarUrl: null,
    },
  });
  tabCommandCoordinator.resetReconciliationForTesting();
  __resetBotListChangedSessionsForTesting();
  scripted.list = undefined;
  scripted.activity = null;
  scripted.indicators = { epics: {}, chats: {} };
  scripted.connectable = { hostIds: ["host-a"], resolved: true };
  scripted.stream = new ServingStreamClient();
}

/** Opens epic tabs in the layout, the first one active. */
function openEpicTabs(names: ReadonlyArray<string>): ReadonlyArray<TabRef> {
  const refs = names.map((name): TabRef => {
    const id = `e-${name.toLowerCase()}`;
    useEpicCanvasStore.getState().seedEpic(id, { tabId: id, name }, []);
    return { kind: "epic", id };
  });
  const first = refs.at(0);
  useTabsStore.setState({
    version: 2,
    items: refs.map((ref) => ({ kind: "tab", id: tabItemId(ref), ref })),
    activeItemId: first === undefined ? null : tabItemId(first),
    stripOrder: refs,
    systemTabs: { history: null, settings: null },
  });
  return refs;
}

interface Mounted {
  readonly pathname: () => string;
}

function buildRouter(initialPath: string, body: ReactNode) {
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <WindowsBridgeContext.Provider
            value={{ bridge: null, hasHydrated: true }}
          >
            <SheetJoinScope>
              <TracyEntryController />
              {body}
            </SheetJoinScope>
          </WindowsBridgeContext.Provider>
        </TooltipProvider>
      </QueryClientProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  const epicTabRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/epics/$epicId/$tabId",
    component: () => null,
  });
  const botRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/bot/$botId",
    component: () => null,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute, epicTabRoute, botRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

function mount(initialPath: string, body: ReactNode): Mounted {
  const router = buildRouter(initialPath, body);
  render(<RouterProvider router={router} />);
  return { pathname: () => router.state.location.pathname };
}

function mountTopStrip(initialPath: string): Mounted {
  return mount(initialPath, <TabStrip />);
}

function mountSideStrip(initialPath: string): Mounted {
  return mount(initialPath, <SideTabStrip edge="left" ownsTitleBar={false} />);
}

function tracyItemId(): string {
  return tabItemId(TRACY_REF);
}

/** The layout's top-level items, a tab by its ref id. */
function layoutRefKeys(): ReadonlyArray<string> {
  return useTabsStore
    .getState()
    .items.map((item) => (item.kind === "tab" ? item.ref.id : item.id));
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  setHomeTabEnabled(true);
  resetStores();
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  setHomeTabEnabled(false);
  resetStores();
  localStorage.clear();
});

describe("the fixed Tracy entry - top strip", () => {
  beforeEach(tracyIsMainBot);

  it("opens on a fresh install after Home, outside the scrolling tabs, first in the layout, without a close control", async () => {
    openEpicTabs(["Alpha"]);
    const view = mountTopStrip("/epics/e-alpha/e-alpha");

    const entry = await screen.findByTestId("tab-tracy");
    const home = screen.getByTestId("tab-home");
    const scroller = screen.getByTestId("header-tab-strip-scroll");

    expect(entry.textContent).toContain("Tracy");
    expect(
      home.compareDocumentPosition(entry) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(scroller.contains(entry)).toBe(false);
    expect(within(scroller).queryByTestId(`tab-bot-${TRACY}`)).toBeNull();
    expect(entry.querySelector("button")).toBeNull();
    expect(screen.queryByTestId(`tab-close-bot-${TRACY}`)).toBeNull();
    // Home is unchanged, and neither fixed entry takes an Alt-digit slot.
    expect(screen.getByTestId("tab-strip").children[0].contains(home)).toBe(
      true,
    );
    expect(home.hasAttribute("data-tab-index")).toBe(false);
    expect(entry.hasAttribute("data-tab-index")).toBe(false);
    expect(
      within(scroller)
        .getByTestId("tab-epic-e-alpha")
        .getAttribute("data-tab-index"),
    ).toBe("0");

    expect(useTabsStore.getState().items[0].id).toBe(tracyItemId());
    expect(useBotTabsStore.getState().fixedBotId).toBe(TRACY);
    expect(lookupBotTab(useBotTabsStore.getState().tabs, TRACY)?.hostId).toBe(
      "host-a",
    );

    fireEvent.click(entry);
    await waitFor(() => {
      expect(view.pathname()).toBe(`/bot/${TRACY}`);
    });
    await waitFor(() => {
      expect(useTabsStore.getState().activeItemId).toBe(tracyItemId());
    });
    expect(screen.getByTestId("tab-tracy").getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("refuses to move or close the entry, and puts it back first when another tab takes index 0", async () => {
    openEpicTabs(["Alpha", "Beta"]);
    mountTopStrip("/epics/e-alpha/e-alpha");
    await screen.findByTestId("tab-tracy");
    const before = useTabsStore.getState().items;
    expect(before[0].id).toBe(tracyItemId());

    expect(
      tabCommandCoordinator.moveStripItem({
        itemId: tracyItemId(),
        targetIndex: before.length - 1,
        groupId: null,
      }),
    ).toBe(false);
    expect(tabCommandCoordinator.closeRef(TRACY_REF)).toBe(false);
    expect(useTabsStore.getState().items).toBe(before);
    expect(lookupBotTab(useBotTabsStore.getState().tabs, TRACY)).not.toBeNull();

    const beta = tabItemId({ kind: "epic", id: "e-beta" });
    act(() => {
      expect(
        tabCommandCoordinator.moveStripItem({
          itemId: beta,
          targetIndex: 0,
          groupId: null,
        }),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(layoutRefKeys()).toEqual([TRACY, "e-beta", "e-alpha"]);
    });
  });

  it("is released with Show Tracy off, closing its tab, and comes back when it is turned on", async () => {
    openEpicTabs(["Alpha"]);
    mountTopStrip("/epics/e-alpha/e-alpha");
    await screen.findByTestId("tab-tracy");

    act(() => {
      useSettingsStore.getState().setShowTracy(false);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("tab-tracy")).toBeNull();
    });
    expect(useBotTabsStore.getState().fixedBotId).toBeNull();
    expect(lookupBotTab(useBotTabsStore.getState().tabs, TRACY)).toBeNull();
    expect(layoutRefKeys()).toEqual(["e-alpha"]);

    act(() => {
      useSettingsStore.getState().setShowTracy(true);
    });
    expect(await screen.findByTestId("tab-tracy")).not.toBeNull();
    expect(useBotTabsStore.getState().fixedBotId).toBe(TRACY);
    await waitFor(() => {
      expect(layoutRefKeys()).toEqual([TRACY, "e-alpha"]);
    });
  });

  it("keeps a group's chip on its tab with the entry first in the layout", async () => {
    openEpicTabs(["Alpha", "Beta"]);
    useTabsStore.setState({
      groups: {
        g1: {
          name: "Work",
          color: "#336699",
          collapsed: false,
          organizationOwnerId: "user-1",
        },
      },
      customizations: {
        "epic:e-alpha": { groupId: "g1", color: null, icon: null },
      },
    });
    mountTopStrip("/epics/e-alpha/e-alpha");

    const alpha = await screen.findByTestId("tab-epic-e-alpha");
    await screen.findByTestId("tab-tracy");
    const chip = screen.getByRole("button", { name: "Work: collapse group" });
    expect(
      chip.compareDocumentPosition(alpha) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("draws no entry when the list names no personal main bot, and leaves a team bot's own tab ordinary", async () => {
    scripted.list = {
      bots: [
        bot(TRACY, PERSONAL_ENV, "Tracy", null),
        bot(TEAM_BOT, TEAM_ENV, "Release Bot", null),
      ],
      mainBotIds: { [TEAM_ENV]: TEAM_BOT },
    };
    useBotTabsStore
      .getState()
      .openBotTab({ botId: TEAM_BOT, hostId: "host-a", title: "Release Bot" });
    mountTopStrip("/");

    const teamTab = await screen.findByTestId(`tab-bot-${TEAM_BOT}`);
    expect(
      screen.getByTestId("header-tab-strip-scroll").contains(teamTab),
    ).toBe(true);
    expect(screen.queryByTestId("tab-tracy")).toBeNull();
    expect(useBotTabsStore.getState().fixedBotId).toBeNull();
    expect(Object.keys(useBotTabsStore.getState().tabs)).toEqual([TEAM_BOT]);
  });

  it("draws no entry for an archived main bot", async () => {
    scripted.list = {
      bots: [bot(TRACY, PERSONAL_ENV, "Tracy", 5_000)],
      mainBotIds: { [PERSONAL_ENV]: TRACY },
    };
    openEpicTabs(["Alpha"]);
    mountTopStrip("/epics/e-alpha/e-alpha");

    await screen.findByTestId("tab-epic-e-alpha");
    expect(screen.queryByTestId("tab-tracy")).toBeNull();
    expect(useBotTabsStore.getState().fixedBotId).toBeNull();
  });
});

describe("the fixed Tracy entry - a tab that was paired or grouped before it became the entry", () => {
  beforeEach(tracyIsMainBot);

  /** Tracy's tab is open and in the layout while Show Tracy is still off. */
  async function openTracyTabWithEntryOff(): Promise<void> {
    useSettingsStore.setState({ showTracy: false });
    useBotTabsStore
      .getState()
      .openBotTab({ botId: TRACY, hostId: "host-a", title: "Tracy" });
    await waitFor(() => {
      expect(layoutRefKeys()).toContain(TRACY);
    });
  }

  it("takes the bot out of a split it was paired in, leaving the partner a tab of its own", async () => {
    openEpicTabs(["Alpha", "Beta"]);
    await openTracyTabWithEntryOff();
    expect(
      tabCommandCoordinator.pairTabs({
        left: { kind: "epic", id: "e-beta" },
        right: TRACY_REF,
        splitId: "split-beta-tracy",
        leftRatio: 0.5,
        focusedRef: TRACY_REF,
      }),
    ).toBe(true);
    expect(useTabsStore.getState().items.map((item) => item.kind)).toEqual([
      "tab",
      "split",
    ]);
    mountTopStrip("/epics/e-alpha/e-alpha");

    act(() => {
      useSettingsStore.getState().setShowTracy(true);
    });

    await waitFor(() => {
      expect(layoutRefKeys()).toEqual([TRACY, "e-alpha", "e-beta"]);
    });
    expect(await screen.findByTestId("tab-tracy")).not.toBeNull();
  });

  it("takes the bot out of the group it was in, leaving the group to its other tabs", async () => {
    openEpicTabs(["Alpha", "Beta"]);
    await openTracyTabWithEntryOff();
    const tracyKey = tabRefKey(TRACY_REF);
    const alphaKey = tabRefKey({ kind: "epic", id: "e-alpha" });
    // The bot is first already, in the group with Alpha: only leaving the
    // group moves it.
    const alphaRef: TabRef = { kind: "epic", id: "e-alpha" };
    const betaRef: TabRef = { kind: "epic", id: "e-beta" };
    useTabsStore.setState({
      items: [TRACY_REF, alphaRef, betaRef].map((ref) => ({
        kind: "tab",
        id: tabItemId(ref),
        ref,
      })),
      stripOrder: [TRACY_REF, alphaRef, betaRef],
      groups: {
        g1: {
          name: "Work",
          color: "#336699",
          collapsed: false,
          organizationOwnerId: "user-1",
        },
      },
      customizations: {
        [tracyKey]: { groupId: "g1", color: null, icon: null },
        [alphaKey]: { groupId: "g1", color: null, icon: null },
      },
    });
    expect(layoutRefKeys()).toEqual([TRACY, "e-alpha", "e-beta"]);
    mountTopStrip("/epics/e-alpha/e-alpha");

    act(() => {
      useSettingsStore.getState().setShowTracy(true);
    });

    await waitFor(() => {
      expect(
        useTabsStore.getState().customizations?.[tracyKey]?.groupId,
      ).toBeNull();
    });
    expect(layoutRefKeys()).toEqual([TRACY, "e-alpha", "e-beta"]);
    expect(useTabsStore.getState().customizations?.[alphaKey]?.groupId).toBe(
      "g1",
    );
  });
});

describe("the fixed Tracy entry - opening its tab", () => {
  beforeEach(tracyIsMainBot);

  it.each([
    {
      label:
        "moves a tab whose host this client can no longer dial onto this window's host",
      bound: "host-gone",
      connectable: { hostIds: ["host-a"], resolved: true },
      expected: "host-a",
    },
    {
      label: "keeps a tab on its own host while this client can still dial it",
      bound: "host-b",
      connectable: { hostIds: ["host-a", "host-b"], resolved: true },
      expected: "host-b",
    },
    {
      label: "keeps the tab's host while the host directory has not answered",
      bound: "host-gone",
      connectable: { hostIds: [], resolved: false },
      expected: "host-gone",
    },
  ])("$label", async ({ bound, connectable, expected }) => {
    scripted.connectable = connectable;
    useBotTabsStore
      .getState()
      .openBotTab({ botId: TRACY, hostId: bound, title: "Tracy" });
    const view = mountTopStrip("/");
    const entry = await screen.findByTestId("tab-tracy");
    // A restored tab keeps the host it was bound to until it is opened.
    expect(lookupBotTab(useBotTabsStore.getState().tabs, TRACY)?.hostId).toBe(
      bound,
    );

    fireEvent.click(entry);

    await waitFor(() => {
      expect(view.pathname()).toBe(`/bot/${TRACY}`);
    });
    expect(lookupBotTab(useBotTabsStore.getState().tabs, TRACY)?.hostId).toBe(
      expected,
    );
  });
});

describe("the fixed Tracy entry - the bot list", () => {
  beforeEach(tracyIsMainBot);

  it("is refetched when the host announces a change, so an archived main bot leaves the entry with no other bots surface mounted", async () => {
    openEpicTabs(["Alpha"]);
    mountTopStrip("/epics/e-alpha/e-alpha");
    await screen.findByTestId("tab-tracy");
    expect(useBotTabsStore.getState().fixedBotId).toBe(TRACY);

    scripted.list = {
      bots: [
        bot(TRACY, PERSONAL_ENV, "Tracy", 5_000),
        bot(TEAM_BOT, TEAM_ENV, "Release Bot", null),
      ],
      mainBotIds: { [PERSONAL_ENV]: TRACY, [TEAM_ENV]: TEAM_BOT },
    };
    const doorbell = scripted.stream?.getSession("bot.listChanged", {});
    if (doorbell === undefined) throw new Error("bot.listChanged not rung");
    act(() => {
      doorbell.emitFrame(CHANGED);
    });

    await waitFor(() => {
      expect(screen.queryByTestId("tab-tracy")).toBeNull();
    });
    expect(useBotTabsStore.getState().fixedBotId).toBeNull();
    expect(lookupBotTab(useBotTabsStore.getState().tabs, TRACY)).toBeNull();
  });
});

describe("the fixed Tracy entry - signals", () => {
  beforeEach(tracyIsMainBot);

  it("shows how long Tracy has been replying, and its step on hover", async () => {
    scripted.activity = replying("Reading the plan");
    mountTopStrip("/");

    const entry = await screen.findByTestId("tab-tracy");
    expect(within(entry).getByTestId("tab-tracy-working").textContent).toBe(
      "3m",
    );

    await userEvent.hover(entry);
    const body = await screen.findByTestId("tracy-entry-hover-body");
    expect(body.textContent).toContain("Reading the plan");
  });

  it("shows no timer and an Idle hover while Tracy is not replying", async () => {
    scripted.activity = {
      trunk: { state: "idle", startedAt: null, step: null, requestId: null },
      threads: {},
    };
    mountTopStrip("/");

    const entry = await screen.findByTestId("tab-tracy");
    expect(screen.queryByTestId("tab-tracy-working")).toBeNull();

    await userEvent.hover(entry);
    const body = await screen.findByTestId("tracy-entry-hover-body");
    expect(body.textContent).toContain("Idle");
  });

  it.each([["unreadDone"], ["unreadFailure"]] as const)(
    "marks the entry and bolds its title with %s",
    async (flag) => {
      scripted.indicators = {
        epics: { [TRACY]: { ...NO_FLAGS, [flag]: true } },
        chats: {},
      };
      mountTopStrip("/");

      const entry = await screen.findByTestId("tab-tracy");
      expect(entry.hasAttribute("data-unread")).toBe(true);
      expect(within(entry).getByText("Tracy").className).toContain(
        "font-semibold",
      );
    },
  );

  it("leaves the entry unmarked with nothing unread", async () => {
    scripted.indicators = {
      epics: { [TRACY]: { ...NO_FLAGS } },
      chats: {},
    };
    mountTopStrip("/");

    const entry = await screen.findByTestId("tab-tracy");
    expect(entry.hasAttribute("data-unread")).toBe(false);
    expect(within(entry).getByText("Tracy").className).not.toContain(
      "font-semibold",
    );
  });
});

describe("the fixed Tracy entry - Alt-digit", () => {
  beforeEach(tracyIsMainBot);

  it("numbers the other tabs from 1 and never reaches Tracy", async () => {
    openEpicTabs(["Alpha"]);
    mountTopStrip("/epics/e-alpha/e-alpha");
    await screen.findByTestId("tab-tracy");
    expect(getHeaderTabs().map((tab) => tab.id)).toEqual([TRACY, "e-alpha"]);

    const intents: unknown[] = [];
    const router: KeybindingRouter = {
      getPathname: () => "/",
      navigateHome: () => undefined,
      navigateSettings: () => undefined,
      navigateToEpic: () => undefined,
      navigateToEpicTab: () => undefined,
      navigateToEpicList: () => undefined,
      navigateSettingsSection: () => undefined,
      navigateToTabIntent: (intent) => {
        intents.push(intent);
      },
      goBack: () => undefined,
      goForward: () => undefined,
      isHistoryNavAvailable: () => false,
      canGoBack: () => false,
      canGoForward: () => false,
    };
    const unregister = registerBaseLeaderScope(router);
    try {
      const digits = getLeaderScopesTopDown()
        .find((scope) => scope.id === LEADER_SCOPE_HEADER_TABS)
        ?.actions.find((action) => action.actionId === "epic.switch.byDigit");
      if (digits === undefined) throw new Error("No header-tabs digit action");

      expect(digits.dispatch(1)).toBe(true);
      expect(digits.dispatch(2)).toBe(false);
      expect(digits.sequenceState?.([2])).toBe("invalid");
      const alpha = getHeaderTabs().find((tab) => tab.id === "e-alpha");
      if (alpha === undefined) throw new Error("No Alpha header tab");
      expect(intents).toEqual([tabResolveIntent(alpha)]);
    } finally {
      unregister();
    }
  });
});

describe("the fixed Tracy entry - vertical strip", () => {
  beforeEach(tracyIsMainBot);

  it("draws the entry after Home in the top block and keeps the bot out of the tab rows", async () => {
    openEpicTabs(["Alpha"]);
    const view = mountSideStrip("/epics/e-alpha/e-alpha");

    const entry = await screen.findByTestId("tab-tracy");
    const home = screen.getByTestId("tab-home");
    const topBlock = screen.getByTestId("side-strip-top-block");

    expect(topBlock.contains(entry)).toBe(true);
    expect(
      home.compareDocumentPosition(entry) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getAllByTestId("tab-tracy")).toHaveLength(1);
    expect(screen.getByTestId("tab-epic-e-alpha")).not.toBeNull();
    expect(screen.queryByTestId(`tab-bot-${TRACY}`)).toBeNull();
    // The Tasks count is the tabs alone.
    expect(screen.getByTestId("side-strip-tasks-label").textContent).toBe(
      "Tasks1",
    );

    fireEvent.click(entry);
    await waitFor(() => {
      expect(view.pathname()).toBe(`/bot/${TRACY}`);
    });
  });
});

describe("the Show Tracy setting", () => {
  beforeEach(tracyIsMainBot);

  it("is a switch in the Bots group, on by default, and turning it off removes the entry", async () => {
    openEpicTabs(["Alpha"]);
    mount(
      "/epics/e-alpha/e-alpha",
      <>
        <TabStrip />
        <GeneralSettingsPanel />
      </>,
    );
    await screen.findByTestId("tab-tracy");

    const group = screen.getByTestId("settings-general-bots");
    const toggle = within(group).getByRole("switch", { name: "Show Tracy" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(toggle);

    expect(useSettingsStore.getState().showTracy).toBe(false);
    await waitFor(() => {
      expect(screen.queryByTestId("tab-tracy")).toBeNull();
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
});
