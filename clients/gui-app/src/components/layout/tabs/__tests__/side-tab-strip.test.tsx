/**
 * `SideTabStrip`, the vertical presentation of the task tabs, mounted over the
 * real controller, the real per-tab hook and the real row kit. It pins what
 * the strip owes the shell: it never disappears (the top block and the foot
 * stand with no tabs and before hydration), one presentation registers the
 * strip's keybindings exactly once, the rows carry every per-tab behaviour
 * (leader badges, reveal, rename, menu, the waiting chip), the rail swaps rows
 * for tiles, a split is one joined pair, there is no hidden-tabs menu, and the
 * macOS title row appears only when the strip owns the title bar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
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
  RouterProvider,
  type RouterHistory,
} from "@tanstack/react-router";
import { pointerEvent } from "@/components/epic-canvas/canvas/__tests__/test-pointer-events";
import { SideTabStrip } from "@/components/layout/tabs/side-strip/side-tab-strip";
import { SampleSceneContext } from "@/components/sample-workspace/sample-scene-context";
import { useStripDisclosureStore } from "@/components/layout/tabs/side-strip/strip-disclosure";
import {
  chatProjection,
  coolAllEpics,
  warmEpic,
} from "@/components/layout/tabs/side-strip/__tests__/warm-epic-fixture";
import { SheetJoinScope } from "@/components/layout/tabs/sheet-join";
import {
  SIDE_STRIP_RAIL_WIDTH_PX,
  SIDE_STRIP_SNAP_TO_RAIL_BELOW_PX,
} from "@/components/layout/tabs/side-strip/side-strip-tokens";
import {
  NotificationIndicatorIcon,
  type IndicatorRunningKind,
} from "@/components/notifications/notification-indicator-icon";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { EpicWaitingReason } from "@/hooks/epic/use-epic-activity-status";
import type { TaskPinnedState } from "@/hooks/epic/use-epic-task-pinned-states-query";
import { formatChordForDisplay } from "@/lib/keybindings/chord";
import { getDefaultBindings, type ActionId } from "@/lib/keybindings/actions";
import {
  dispatchAction,
  type KeybindingRouter,
} from "@/lib/keybindings/dispatch";
import type { EdgeSide } from "@/lib/layout/layout-arrangement";
import { createPersistentMemoryHistory } from "@/lib/persistent-history";
import type {
  NotificationIndicatorState,
  SurfaceNotificationIndicators,
} from "@/stores/notifications/notification-indicator-state";
import type { HostNotificationEntryV22 } from "@traycer/protocol/host/notifications/contracts";
import {
  __resetAgentActivityStoreForTests,
  __setAgentActivityStateForTests,
} from "@/stores/agent-activity-store";
import {
  __resetHostNotificationsStoreForTests,
  useHostNotificationsStore,
} from "@/stores/notifications/host-notifications-store";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import { installTabSyncCoordinator } from "@/lib/tab-sync/tab-sync-coordinator";
import { KeybindingProvider } from "@/providers/keybinding-provider";
import { WindowsBridgeContext } from "@/providers/windows-bridge-context";
import {
  chatTranscriptJumpKey,
  useChatTranscriptJumpStore,
} from "@/stores/chats/chat-transcript-jump-store";
import { usePaneEmphasisStore } from "@/stores/epics/canvas/pane-emphasis-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import { useLeftPanelStore } from "@/stores/epics/left-panel-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import { useSideTabStripStore } from "@/stores/layout/side-tab-strip-store";
import { tabItemId, tabRefKey } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import { useTitleBarDragStore } from "@/stores/layout/title-bar-drag-store";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import type { TabRef } from "@/stores/tabs/types";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useAppLocalNotificationsStore } from "@/stores/notifications/app-local-notifications-store";

// The foot's account row shows a signed-in user (never `SignInButton`, which
// reaches `useAuthService` and throws outside a `<HostRuntimeProvider>` this
// harness does not mount - the strip's own render is what every case here is
// about).
const AUTH_PROFILE = {
  userId: "u-1",
  userName: "Ada",
  email: "ada@example.com",
  avatarUrl: null,
};

/** Live registrations per action id, and the most ever live at once. */
const registrations = vi.hoisted(
  (): {
    readonly live: Map<string, number>;
    readonly peak: Map<string, number>;
  } => ({ live: new Map(), peak: new Map() }),
);

vi.mock("@/lib/keybindings/dispatch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/keybindings/dispatch")>();
  return {
    ...actual,
    registerDynamicActionHandler: (
      id: ActionId,
      handler: () => void,
    ): (() => void) => {
      const live = (registrations.live.get(id) ?? 0) + 1;
      registrations.live.set(id, live);
      registrations.peak.set(
        id,
        Math.max(live, registrations.peak.get(id) ?? 0),
      );
      const unregister = actual.registerDynamicActionHandler(id, handler);
      return () => {
        registrations.live.set(id, (registrations.live.get(id) ?? 1) - 1);
        unregister();
      };
    },
  };
});

vi.mock("@/hooks/notifications/use-host-notification-indicators-query", () => ({
  useHostNotificationIndicators: () => ({
    data: { epics: {}, chats: {} },
    isPending: false,
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(),
  }),
}));

// The strip's indicator batch, per epic: what a collapsed group's badge reads.
const indicatorState = vi.hoisted(
  (): { value: SurfaceNotificationIndicators } => ({
    value: { epics: {}, chats: {} },
  }),
);
vi.mock(
  "@/hooks/notifications/use-notification-indicators-query",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/notifications/use-notification-indicators-query")
      >();
    return { ...actual, useNotificationIndicators: () => indicatorState.value };
  },
);

// Motion is off in jsdom (no pane visibility); the easing case turns it on.
const motion = vi.hoisted((): { enabled: boolean } => ({ enabled: false }));
vi.mock("@/lib/animation/use-motion-enabled", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/animation/use-motion-enabled")>();
  return { ...actual, useMotionEnabled: () => motion.enabled };
});

vi.mock(
  "@/hooks/epic/use-epic-task-pinned-states-query",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/epic/use-epic-task-pinned-states-query")
      >();
    return {
      ...actual,
      useEpicTaskPinnedStates: () => new Map<string, TaskPinnedState>(),
    };
  },
);

vi.mock("@/hooks/epic/use-epic-set-pinned-mutation", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/epic/use-epic-set-pinned-mutation")
    >();
  return {
    ...actual,
    useEpicSetPinned: () => ({ mutate: vi.fn() }),
    usePendingSetPinnedEpicIds: () => new Set<string>(),
  };
});

// The tab menu's pin row asks the epic's host; no host transport is mounted.
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
vi.mock("@/hooks/epic/use-epic-pin-local-home-support", () => ({
  useEpicPinLocalHomeSupported: () => false,
}));

// The pin dispatch reads `useHostClient()`; no host runtime is mounted here.
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => ({ getActiveHostId: () => "host-a" }),
  };
});

/** A warm chat session's gate facts, per epic: what the waiting chip names. */
const waitingState = vi.hoisted(
  (): { readonly byEpicId: Map<string, EpicWaitingReason> } => ({
    byEpicId: new Map(),
  }),
);
vi.mock("@/hooks/epic/use-epic-activity-status", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/epic/use-epic-activity-status")
    >();
  return {
    ...actual,
    useEpicWaitingReason: (epicId: string | null) =>
      epicId === null ? null : (waitingState.byEpicId.get(epicId) ?? null),
  };
});

// An owner's local-homed epic, so its title is editable with no session.
vi.mock("@/lib/epic-selectors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/epic-selectors")>();
  return {
    ...actual,
    useRegisteredEpicPermissionRole: () => "owner",
    useRegisteredEpicLocalHome: () => true,
  };
});

// The foot's controls each bring a host, auth or runner dependency of their
// own; what this suite asks of the foot is that it stands, in order.
vi.mock("@/components/layout/header/header-actions", () => ({
  HeaderUsageRegion: () => <span data-testid="foot-usage" />,
  HeaderResourceRegion: () => <span data-testid="foot-resource" />,
}));
vi.mock("@/components/layout/header/app-update-button", () => ({
  AppUpdateHeaderButton: () => <span data-testid="foot-update" />,
}));

// The Notifications nav row (top block) and the foot's account row both reach a host
// directory entry through `<HostRuntimeProvider>`, which this harness does not
// mount - this suite is about the strip's own structure, not host content.
vi.mock("@/hooks/host/use-host-directory-entry", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/host/use-host-directory-entry")
    >();
  return { ...actual, useHostDirectoryEntry: () => null };
});
vi.mock("@/hooks/notifications/use-notification-host", () => ({
  useNotificationResolveHostId: () => null,
  useNotificationResolveHost: () => ({ hostId: null, client: null }),
}));

// The notification's activation pipeline is `useNotificationActivation`'s own
// suite; a cold task's needs-you row only has to hand its row to it.
const activateSpy = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/notifications/use-notification-activation", () => ({
  useNotificationActivation: () => ({ activate: activateSpy }),
}));

// The account row's real `UserMenu` reaches `useRunnerHost()`, which this
// harness does not provide - this suite only needs the account row to stand,
// not the menu's own behaviour (covered by `user-menu.test.tsx`).
vi.mock("@/components/auth/user-menu", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/auth/user-menu")>();
  return {
    ...actual,
    UserMenu: () => <span data-testid="foot-account" />,
  };
});

installTabSyncCoordinator({ readyPromise: Promise.resolve() });

// Dynamic-handler dispatch never touches the router, so every field is a no-op.
const NOOP_ROUTER: KeybindingRouter = {
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

/** Dispatches the strip's collapse action as the keyboard would. */
function collapseViaKeyboard(): boolean {
  let fired = false;
  act(() => {
    fired = dispatchAction("app.tabs.vertical.collapse", NOOP_ROUTER);
  });
  return fired;
}

const STRIP_KEYBINDING_IDS: ReadonlyArray<ActionId> = [
  "tab.split.add",
  "tab.split.swap",
  "tab.split.separate",
  "tab.split.close-left",
  "tab.split.close-right",
  "epic.close",
];

// The shipped arrangement keeps both readings in the status bar, so the
// readings row stands empty (and hidden) between the update row and the account.
const FOOT_ORDER = ["foot-update", "side-strip-readings", "foot-account"];

/** A host indicator with nothing lit. */
const NO_FLAGS = {
  pendingApproval: false,
  pendingInterview: false,
  pendingFork: false,
  unreadFailure: false,
  unreadDone: false,
};

let queryClient: QueryClient;

interface StripOptions {
  readonly edge: EdgeSide;
  readonly ownsTitleBar: boolean;
  readonly hydrated: boolean;
}

const LEFT_STRIP: StripOptions = {
  edge: "left",
  ownsTitleBar: false,
  hydrated: true,
};

function buildRouter(
  initialPath: string,
  strip: StripOptions,
  history: RouterHistory | undefined,
) {
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <WindowsBridgeContext.Provider
            value={{ bridge: null, hasHydrated: strip.hydrated }}
          >
            <SheetJoinScope>
              <SideTabStrip
                edge={strip.edge}
                ownsTitleBar={strip.ownsTitleBar}
              />
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
  const epicRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/epics/$epicId",
    component: () => null,
  });
  const elsewhereRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/elsewhere",
    component: () => null,
  });
  // New Task (F7) navigates to a fresh draft; this route is what its
  // navigation resolves to, mirroring `tab-strip.test.tsx`'s own draft route.
  const draftRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/draft/$draftId",
    component: () => null,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([
      indexRoute,
      epicTabRoute,
      epicRoute,
      elsewhereRoute,
      draftRoute,
    ]),
    history: history ?? createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

/** Settles a router navigation issued through the tab-navigation coordinator. */
async function flushNav(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function renderStrip(
  initialPath: string,
  strip: StripOptions,
): Promise<HTMLElement> {
  render(
    <RouterProvider router={buildRouter(initialPath, strip, undefined)} />,
  );
  return screen.findByTestId("side-tab-strip");
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
  useEpicCanvasStore.getState().clearAllTitleGenerationPending();
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  useSideTabStripStore.setState({
    widthPx: 240,
    collapsed: false,
    dragCollapsed: null,
  });
  useAuthStore.setState({ status: "signed-in", profile: AUTH_PROFILE });
}

/** Opens one epic tab per name, the first one active. */
function openEpicTabs(names: ReadonlyArray<string>): ReadonlyArray<TabRef> {
  const refs = names.map((name): TabRef => {
    const id = `e-${name.toLowerCase().replaceAll(" ", "-")}`;
    useEpicCanvasStore.getState().seedEpic(id, { tabId: id, name }, []);
    return { kind: "epic", id };
  });
  const firstRef = refs.at(0);
  useTabsStore.setState({
    version: 2,
    items: refs.map((ref) => ({ kind: "tab", id: tabItemId(ref), ref })),
    activeItemId: firstRef === undefined ? null : tabItemId(firstRef),
    stripOrder: refs,
    systemTabs: { history: null, settings: null },
  });
  return refs;
}

/** Opens the History system tab as the active tab, no epic tabs. */
function openHistoryTab(): void {
  const ref: TabRef = { kind: "history", id: "history" };
  useTabsStore.setState({
    version: 2,
    items: [{ kind: "tab", id: tabItemId(ref), ref }],
    activeItemId: tabItemId(ref),
    stripOrder: [ref],
    systemTabs: {
      history: {
        id: "history",
        kind: "history",
        name: "History",
        lastPath: null,
      },
      settings: null,
    },
  });
}

/** Writes the arrangement's `sidebarSide` alone, leaving every other field. */
function setSidebarSide(side: EdgeSide): void {
  useLayoutStore.setState({
    arrangement: {
      ...useLayoutStore.getState().arrangement,
      sidebarSide: side,
    },
  });
}

function openSplitPair(focusedSide: "left" | "right"): void {
  const left: TabRef = { kind: "epic", id: "e-alpha" };
  const right: TabRef = { kind: "epic", id: "e-beta" };
  useEpicCanvasStore
    .getState()
    .seedEpic(left.id, { tabId: left.id, name: "Alpha" }, []);
  useEpicCanvasStore
    .getState()
    .seedEpic(right.id, { tabId: right.id, name: "Beta" }, []);
  useTabsStore.setState({
    version: 2,
    items: [
      {
        kind: "split",
        id: "split-a",
        left: { kind: "tab", ref: left },
        right: { kind: "tab", ref: right },
        focusedSide,
        routeBackingSide: focusedSide,
        leftRatio: 0.5,
      },
    ],
    activeItemId: "split-a",
    stripOrder: [left, right],
    systemTabs: { history: null, settings: null },
  });
}

/** Sets the strip vertical (required for `useLiveAgentsInStrip`) and its
 * view, leaving every other arrangement field. */
function setSideStripView(view: "layered" | "activity"): void {
  useLayoutStore.setState({
    arrangement: {
      ...useLayoutStore.getState().arrangement,
      tabStripPlacement: "left",
      sideStripView: view,
    },
  });
}

/**
 * A group holding a tab and a full split, then an ungrouped tab:
 * One, [Two | Three], Four.
 */
function openGroupWithTabAndSplit(): void {
  const seed = (name: string): TabRef => {
    const id = `e-${name.toLowerCase()}`;
    useEpicCanvasStore.getState().seedEpic(id, { tabId: id, name }, []);
    return { kind: "epic", id };
  };
  const one = seed("One");
  const two = seed("Two");
  const three = seed("Three");
  const four = seed("Four");
  const refs = [one, two, three, four];
  const member = { color: null, icon: null, groupId: "g" };
  useTabsStore.setState({
    version: 2,
    items: [
      { kind: "tab", id: tabItemId(one), ref: one },
      {
        kind: "split",
        id: "split-g",
        left: { kind: "tab", ref: two },
        right: { kind: "tab", ref: three },
        focusedSide: "left",
        routeBackingSide: "left",
        leftRatio: 0.5,
      },
      { kind: "tab", id: tabItemId(four), ref: four },
    ],
    activeItemId: tabItemId(four),
    stripOrder: refs,
    systemTabs: { history: null, settings: null },
    groups: { g: { name: "Work", color: "#8ab4f8", collapsed: false } },
    customizations: {
      [tabRefKey(one)]: member,
      [tabRefKey(two)]: member,
      [tabRefKey(three)]: member,
    },
  });
}

function expectTopBlockAndFoot(): void {
  expect(screen.getByTestId("side-strip-top-block")).toBeDefined();
  expect(screen.getByTestId("side-strip-new-task")).toBeDefined();
  expect(screen.getByTestId("side-tab-strip-collapse")).toBeDefined();
  const foot = screen.getByTestId("side-strip-foot");
  expect(
    Array.from(foot.querySelectorAll("[data-testid]")).map((node) =>
      node.getAttribute("data-testid"),
    ),
  ).toEqual(FOOT_ORDER);
}

interface RevealShim {
  readonly scrolled: () => number;
  readonly restore: () => void;
}

/**
 * jsdom has no layout: the scroller shows 0..300 on y, the member (the
 * scroller's own child holding the selection) takes `memberBox()`, and
 * `scrollTop` keeps what is written. The reveal's decision is not shimmed.
 */
function installRevealGeometry(
  memberBox: () => { readonly top: number; readonly bottom: number },
): RevealShim {
  const realRect = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "getBoundingClientRect",
  );
  const realScrollTop = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollTop",
  );
  const isScroller = (node: Element | null): boolean =>
    node !== null && node.hasAttribute("data-layout-passive-members");
  HTMLElement.prototype.getBoundingClientRect = function boxFor(
    this: HTMLElement,
  ): DOMRect {
    if (isScroller(this)) return new DOMRect(0, 0, 200, 300);
    const holdsSelection =
      this.querySelector('[aria-selected="true"]') !== null ||
      this.getAttribute("aria-selected") === "true";
    if (!holdsSelection || !isScroller(this.parentElement)) {
      return new DOMRect(0, 0, 0, 0);
    }
    const box = memberBox();
    return new DOMRect(0, box.top, 200, box.bottom - box.top);
  };
  let scrolled = 0;
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get: () => scrolled,
    set: (value: number) => {
      scrolled = value;
    },
  });
  return {
    scrolled: () => scrolled,
    restore: () => {
      // jsdom defines the method on `Element`, so without an own descriptor
      // the override is the one own property to remove.
      if (realRect === undefined) {
        Reflect.deleteProperty(HTMLElement.prototype, "getBoundingClientRect");
      } else {
        Object.defineProperty(
          HTMLElement.prototype,
          "getBoundingClientRect",
          realRect,
        );
      }
      if (realScrollTop === undefined) {
        Reflect.deleteProperty(Element.prototype, "scrollTop");
      } else {
        Object.defineProperty(Element.prototype, "scrollTop", realScrollTop);
      }
    },
  };
}

describe("<SideTabStrip />", () => {
  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    registrations.live.clear();
    registrations.peak.clear();
    waitingState.byEpicId.clear();
    indicatorState.value = { epics: {}, chats: {} };
    motion.enabled = false;
    setHomeTabEnabled(false);
    resetStores();
  });

  afterEach(() => {
    cleanup();
    delete (window as { runnerHost?: unknown }).runnerHost;
    queryClient.clear();
    setHomeTabEnabled(false);
    resetStores();
  });

  it("keeps the top block and the foot with no tabs, Home off, on the landing route", async () => {
    const strip = await renderStrip("/", LEFT_STRIP);

    expect(strip.getAttribute("data-edge")).toBe("left");
    expect(strip.getAttribute("data-collapsed")).toBe("false");
    expectTopBlockAndFoot();
    expect(screen.queryByTestId("tab-home")).toBeNull();
    const scroller = screen.getByTestId("header-tab-strip-scroll");
    expect(scroller.querySelectorAll("[data-strip-item-id]")).toHaveLength(0);
    // The drag spacer is the nav's own child, between the rows and the foot.
    const spacer = screen.getByTestId("side-strip-drag-spacer");
    expect(spacer.parentElement).toBe(strip);
    expect(spacer.nextElementSibling).toBe(
      screen.getByTestId("side-strip-foot"),
    );
  });

  it("draws Home in the top block when it is shown", async () => {
    setHomeTabEnabled(true);
    await renderStrip("/", LEFT_STRIP);

    const home = screen.getByTestId("tab-home");
    expect(home.getAttribute("role")).toBe("tab");
    expect(home.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("side-strip-top-block").contains(home)).toBe(
      true,
    );
  });

  it("reserves skeleton rows before hydration while the top block and the foot stay live", async () => {
    openEpicTabs(["Alpha", "Beta"]);
    await renderStrip("/elsewhere", { ...LEFT_STRIP, hydrated: false });

    expect(screen.getAllByTestId("side-strip-skeleton-row")).toHaveLength(2);
    expect(screen.queryByTestId("header-tab-strip-scroll")).toBeNull();
    expectTopBlockAndFoot();
  });

  it("registers tab.split.* and epic.close exactly once", async () => {
    openEpicTabs(["Alpha"]);
    await renderStrip("/elsewhere", LEFT_STRIP);

    for (const id of STRIP_KEYBINDING_IDS) {
      expect(registrations.live.get(id)).toBe(1);
      expect(registrations.peak.get(id)).toBe(1);
    }
    // The placement toggle is the shell's, mounted once for both placements.
    expect(registrations.peak.get("app.tabs.vertical.toggle")).toBeUndefined();
  });

  describe("app.tabs.vertical.collapse (L-165)", () => {
    it("collapses and expands via the keyboard action, never carrying the easing class", async () => {
      openEpicTabs(["Alpha"]);
      const strip = await renderStrip("/elsewhere", LEFT_STRIP);
      expect(strip.getAttribute("data-collapsed")).toBe("false");

      expect(collapseViaKeyboard()).toBe(true);
      expect(strip.getAttribute("data-collapsed")).toBe("true");
      expect(strip.className).not.toContain("transition-[width]");

      expect(collapseViaKeyboard()).toBe(true);
      expect(strip.getAttribute("data-collapsed")).toBe("false");
      expect(strip.className).not.toContain("transition-[width]");
    });

    it("registers exactly once while mounted, and unregisters on unmount", async () => {
      const router = buildRouter("/elsewhere", LEFT_STRIP, undefined);
      const { unmount } = render(<RouterProvider router={router} />);
      await screen.findByTestId("side-tab-strip");

      expect(registrations.live.get("app.tabs.vertical.collapse")).toBe(1);
      expect(registrations.peak.get("app.tabs.vertical.collapse")).toBe(1);

      unmount();

      expect(registrations.live.get("app.tabs.vertical.collapse")).toBe(0);
      expect(collapseViaKeyboard()).toBe(false);
      expect(useSideTabStripStore.getState().collapsed).toBe(false);
    });
  });

  it("shows the collapse button's chord in its tooltip, and drops it once the binding is cleared", async () => {
    await renderStrip("/", LEFT_STRIP);
    const toggle = screen.getByTestId("side-tab-strip-collapse");
    const chord =
      useKeybindingStore.getState().bindings["app.tabs.vertical.collapse"];
    if (chord === null) throw new Error("expected a default binding");

    try {
      fireEvent.pointerMove(toggle);
      const tooltip = await screen.findByRole("tooltip");
      expect(tooltip.textContent).toBe(
        `Collapse tabs (${formatChordForDisplay(chord)})`,
      );

      act(() => {
        useKeybindingStore
          .getState()
          .clearBinding("app.tabs.vertical.collapse");
      });
      await waitFor(() => {
        expect(screen.getByRole("tooltip").textContent).toBe("Collapse tabs");
      });
    } finally {
      useKeybindingStore.setState({ bindings: getDefaultBindings() });
    }
  });

  it("stamps the vertical drag contract on the scroller", async () => {
    openEpicTabs(["Alpha"]);
    await renderStrip("/elsewhere", { ...LEFT_STRIP, edge: "right" });

    const scroller = screen.getByTestId("header-tab-strip-scroll");
    expect(scroller.getAttribute("data-strip-axis")).toBe("y");
    expect(scroller.getAttribute("data-strip-edge")).toBe("right");
    const frame = screen
      .getByTestId("tab-epic-e-alpha")
      .closest("[data-strip-item-id]");
    expect(frame?.getAttribute("data-strip-item-id")).toBe(
      tabItemId({ kind: "epic", id: "e-alpha" }),
    );
    expect(frame?.getAttribute("data-strip-item-mergeable")).toBe("true");
  });

  it("shows the Alt-digit badges in leader mode", async () => {
    openEpicTabs(["Alpha", "Beta"]);
    const router = buildRouter("/elsewhere", LEFT_STRIP, undefined);
    render(
      <KeybindingProvider router={router}>
        <RouterProvider router={router} />
      </KeybindingProvider>,
    );
    await screen.findByTestId("tab-epic-e-alpha");

    vi.useFakeTimers();
    try {
      expect(screen.queryByTestId("tab-digit-1")).toBeNull();
      fireEvent.keyDown(window, {
        code: "MetaLeft",
        key: "Meta",
        metaKey: true,
      });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      const alpha = screen.getByTestId("tab-epic-e-alpha");
      expect(within(alpha).getByTestId("tab-digit-1")).toBeDefined();
      expect(
        within(screen.getByTestId("tab-epic-e-beta")).getByTestId(
          "tab-digit-2",
        ),
      ).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("scrolls a row that becomes active while clipped into view", async () => {
    const refs = openEpicTabs(["Alpha", "Beta"]);
    let selected = { top: 0, bottom: 32 };
    const geometry = installRevealGeometry(() => selected);
    try {
      await renderStrip("/elsewhere", LEFT_STRIP);
      await screen.findByTestId("tab-epic-e-beta");
      expect(geometry.scrolled()).toBe(0);

      // Beta's row sits 100px past the scroller's 300px bottom edge.
      selected = { top: 368, bottom: 400 };
      const beta = refs.at(1);
      if (beta === undefined) throw new Error("expected two tabs");
      act(() => {
        useTabsStore.setState({ activeItemId: tabItemId(beta) });
      });

      expect(geometry.scrolled()).toBe(100);
    } finally {
      geometry.restore();
    }
  });

  it("renames a row from its context menu", async () => {
    openEpicTabs(["Alpha"]);
    await renderStrip("/elsewhere", LEFT_STRIP);

    fireEvent.contextMenu(screen.getByTestId("tab-epic-e-alpha"));
    expect(await screen.findByText("Close Other Tabs")).toBeDefined();
    fireEvent.click(screen.getByText("Edit Title"));

    const input = await screen.findByTestId("tab-title-input-epic-e-alpha");
    expect((input as HTMLInputElement).value).toBe("Alpha");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("tab-title-input-epic-e-alpha")).toBeNull();
  });

  it("switches to monogram tiles on collapse and back", async () => {
    openEpicTabs(["Alpha Beta", "Gamma"]);
    const strip = await renderStrip("/elsewhere", LEFT_STRIP);
    const toggle = screen.getByTestId("side-tab-strip-collapse");
    expect(toggle.getAttribute("aria-label")).toBe("Collapse tabs");

    fireEvent.click(toggle);

    expect(strip.getAttribute("data-collapsed")).toBe("true");
    const row = screen.getByTestId("tab-epic-e-alpha-beta");
    expect(row.getAttribute("data-side-tab")).toBe("collapsed");
    expect(row.getAttribute("data-tile-kind")).toBe("monogram");
    expect(row.textContent).toBe("AB");
    expect(
      screen.getByTestId("side-tab-strip-collapse").getAttribute("aria-label"),
    ).toBe("Expand tabs");

    fireEvent.click(screen.getByTestId("side-tab-strip-collapse"));

    expect(strip.getAttribute("data-collapsed")).toBe("false");
    expect(
      screen.getByTestId("tab-epic-e-alpha-beta").getAttribute("data-side-tab"),
    ).toBe("expanded");
  });

  it("renders a split as one row named for its halves, left half first, the split icon its actions button", async () => {
    openSplitPair("left");
    await renderStrip("/elsewhere", LEFT_STRIP);

    const pair = screen.getByRole("group", {
      name: "Split view: Alpha and Beta",
    });
    expect(pair.getAttribute("data-side-split-pair")).toBe("expanded");
    const members = within(pair).getAllByRole("tab");
    expect(members.map((node) => node.getAttribute("data-testid"))).toEqual([
      "tab-epic-e-alpha",
      "tab-epic-e-beta",
    ]);
    expect(members.map((node) => node.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
    ]);
    expect(
      pair
        .closest("[data-strip-item-id]")
        ?.getAttribute("data-strip-item-mergeable"),
    ).toBe("false");
    // The top bar's own control: one icon, one behaviour, in both strips.
    expect(
      within(pair).getByRole("button", {
        name: "Split view actions, left view focused",
      }),
    ).toBe(screen.getByTestId("split-quick-actions-split-a"));
  });

  it("leaves Enter and Space on a row's close button to the button, never activating the row", async () => {
    openEpicTabs(["Alpha", "Beta"]);
    await renderStrip("/elsewhere", LEFT_STRIP);

    const beta = screen.getByTestId("tab-epic-e-beta");
    const close = within(beta).getByTestId("tab-close-epic-e-beta");
    const enter = fireEvent.keyDown(close, { key: "Enter" });
    const space = fireEvent.keyDown(close, { key: " " });
    await flushNav();

    // Not cancelled, so the button still synthesizes its own click.
    expect(enter).toBe(true);
    expect(space).toBe(true);
    expect(beta.getAttribute("aria-selected")).toBe("false");
  });

  describe("the Activity view's nested agents (D9)", () => {
    beforeEach(() => {
      setSideStripView("activity");
      activateSpy.mockClear();
    });

    afterEach(() => {
      coolAllEpics();
      __resetAgentActivityStoreForTests();
      __resetHostNotificationsStoreForTests();
      useStripDisclosureStore.setState({ expanded: {} });
      indicatorState.value = { epics: {}, chats: {} };
      useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
      useChatTranscriptJumpStore.setState({ requestsByChatId: {} });
      usePaneEmphasisStore.setState({ outlinedInstanceId: null, flash: null });
    });

    function busy(epicId: string, turn: ReadonlyArray<string>): void {
      __setAgentActivityStateForTests(
        { [epicId]: { working: [...turn], turn: [...turn] } },
        "local",
        "connected",
      );
    }

    function agentIds(group: HTMLElement): ReadonlyArray<string | null> {
      return Array.from(
        group.querySelectorAll('[data-testid^="strip-agent-"]'),
      ).map((node) => node.getAttribute("data-testid"));
    }

    function seedApproval(epicId: string, chatId: string): void {
      const entry: HostNotificationEntryV22 = {
        id: "approval-0",
        updatedAt: 10,
        readAt: null,
        kind: "approval.requested",
        sourceRef: "approval-0",
        severity: "needs_action",
        outcome: null,
        resolvedAt: null,
        epicId,
        chatId,
        payload: {
          kind: "approval",
          epicId,
          chatId,
          chatTitle: "Deploy agent",
          taskTitle: "Task",
          approvalId: "approval-0",
        },
      };
      act(() => {
        useHostNotificationsStore.getState().applySnapshot({
          attention: { entries: [entry], nextCursor: null },
          recent: { entries: [entry], nextCursor: null },
          summary: { unreadCount: 1, attentionCount: 1 },
        });
      });
    }

    /** The glyph a row draws, by the `StatusGlyph` kind it carries. */
    function glyphKindOf(row: HTMLElement): string | null {
      return (
        row
          .querySelector("[data-status-glyph]")
          ?.getAttribute("data-status-glyph") ?? null
      );
    }

    /** The glyph the Agents panel's own icon draws for a chat in this state. */
    function panelGlyphKind(
      state: NotificationIndicatorState,
      running: IndicatorRunningKind,
    ): string | null {
      const { container, unmount } = render(
        <TooltipProvider>
          <NotificationIndicatorIcon
            state={state}
            running={running}
            activityCoverage="indeterminate"
            subjectId="panel"
            testIdPrefix="panel"
            className={undefined}
            style={undefined}
            runningTitle="Running"
            defaultIcon={null}
            agentSurface="gui"
          />
        </TooltipProvider>,
      );
      const kind = glyphKindOf(container);
      unmount();
      return kind;
    }

    it("nests a warm task's agents in a group its row names, and the chevron folds it to the agents waiting on you", async () => {
      openEpicTabs(["Alpha"]);
      warmEpic("e-alpha", [
        chatProjection("c-run", { title: "Runs", updatedAt: 1 }),
        chatProjection("c-wait", { title: "Waits", updatedAt: 2 }),
        chatProjection("c-bg", { title: "Watches", updatedAt: 3 }),
      ]);
      __setAgentActivityStateForTests(
        { "e-alpha": { working: ["c-run", "c-bg"], turn: ["c-run"] } },
        "local",
        "connected",
      );
      indicatorState.value = {
        epics: {},
        chats: { "c-wait": { ...NO_FLAGS, pendingApproval: true } },
      };
      await renderStrip("/elsewhere", LEFT_STRIP);

      const row = screen.getByTestId("tab-epic-e-alpha");
      const group = screen.getByTestId("strip-agent-group");
      expect(group.getAttribute("role")).toBe("group");
      expect(group.getAttribute("aria-labelledby")).toBe(row.id);
      expect(row.getAttribute("aria-controls")).toBe(group.id);
      // The active task opens expanded.
      expect(row.getAttribute("aria-expanded")).toBe("true");
      expect(agentIds(group)).toEqual([
        "strip-agent-c-wait",
        "strip-agent-c-run",
        "strip-agent-c-bg",
      ]);
      // Agents are plain buttons in a tablist that still holds only tabs.
      expect(within(group).queryAllByRole("tab")).toHaveLength(0);
      expect(group.querySelector("[aria-selected]")).toBeNull();

      fireEvent.click(within(row).getByTestId("side-tab-disclosure"));

      expect(row.getAttribute("aria-expanded")).toBe("false");
      expect(agentIds(screen.getByTestId("strip-agent-group"))).toEqual([
        "strip-agent-c-wait",
      ]);
    });

    it("draws a running, a waiting and a failed agent with the glyph the Agents panel draws for the same state", async () => {
      openEpicTabs(["Alpha"]);
      warmEpic("e-alpha", [
        chatProjection("c-run", { title: "Runs" }),
        chatProjection("c-wait", { title: "Waits" }),
        chatProjection("c-fail", { title: "Fails" }),
      ]);
      busy("e-alpha", ["c-run"]);
      const waiting = { ...NO_FLAGS, pendingApproval: true };
      const failed = { ...NO_FLAGS, unreadFailure: true };
      indicatorState.value = {
        epics: {},
        chats: { "c-wait": waiting, "c-fail": failed },
      };
      await renderStrip("/elsewhere", LEFT_STRIP);

      const drawn = ["c-run", "c-wait", "c-fail"].map((id) =>
        glyphKindOf(screen.getByTestId(`strip-agent-${id}`)),
      );

      expect(drawn).toEqual([
        panelGlyphKind(NO_FLAGS, "turn"),
        panelGlyphKind(waiting, false),
        panelGlyphKind(failed, false),
      ]);
      // Three states, three shapes: the parity is not two nulls agreeing.
      expect(new Set(drawn).size).toBe(3);
      expect(drawn).not.toContain(null);
    });

    it("toggles another task's agents from its chevron without activating the task, on Enter as on a click, swapping the meter for the rows", async () => {
      openEpicTabs(["Alpha", "Beta"]);
      warmEpic("e-beta", [
        chatProjection("b-run", { title: "B runs" }),
        chatProjection("b-run-2", { title: "B runs too" }),
      ]);
      busy("e-beta", ["b-run", "b-run-2"]);
      await renderStrip("/elsewhere", LEFT_STRIP);

      const beta = screen.getByTestId("tab-epic-e-beta");
      const chevron = within(beta).getByTestId("side-tab-disclosure");
      expect(beta.getAttribute("aria-expanded")).toBe("false");
      // Collapsed with nobody waiting: the group it controls is hidden.
      expect(screen.getByTestId("strip-agent-group").hidden).toBe(true);
      expect(within(beta).getByTestId("side-tab-meter")).toBeTruthy();

      // The row activates on Enter; the chevron inside it must not.
      fireEvent.keyDown(chevron, { key: "Enter" });
      await flushNav();
      expect(beta.getAttribute("aria-selected")).toBe("false");

      fireEvent.click(chevron);
      await flushNav();

      expect(beta.getAttribute("aria-expanded")).toBe("true");
      expect(beta.getAttribute("aria-selected")).toBe("false");
      expect(screen.getByTestId("strip-agent-group").hidden).toBe(false);
      expect(screen.getByTestId("strip-agent-b-run")).toBeTruthy();
      expect(within(beta).queryByTestId("side-tab-meter")).toBeNull();
    });

    it("puts the chevron at the trailing edge, before a yielding glyph's cell and before the close, on a Needs you row as on a Working one", async () => {
      openEpicTabs(["Alpha", "Beta", "Gamma"]);
      warmEpic("e-beta", [chatProjection("b-wait", { title: "B waits" })]);
      warmEpic("e-gamma", [chatProjection("g-run", { title: "G runs" })]);
      busy("e-gamma", ["g-run"]);
      indicatorState.value = {
        epics: { "e-beta": { ...NO_FLAGS, pendingApproval: true } },
        chats: { "b-wait": { ...NO_FLAGS, pendingApproval: true } },
      };
      await renderStrip("/elsewhere", LEFT_STRIP);

      const inOrder = (row: HTMLElement): ReadonlyArray<string> =>
        Array.from(
          within(row)
            .getByTestId("side-tab-trailing")
            .querySelectorAll(
              '[data-testid="side-tab-disclosure"], [data-status-glyph], [data-testid^="tab-close-"]',
            ),
        ).map(
          (node) =>
            node.getAttribute("data-status-glyph") ??
            node
              .getAttribute("data-testid")
              ?.replace(/^tab-close-.*/, "close") ??
            "",
        );
      expect(inOrder(screen.getByTestId("tab-epic-e-beta"))).toEqual([
        "side-tab-disclosure",
        "close",
      ]);
      expect(inOrder(screen.getByTestId("tab-epic-e-gamma"))).toEqual([
        "side-tab-disclosure",
        "running",
        "close",
      ]);
    });

    it("gives a cold task no chevron, only its needs-you row, opened through the notification's activation", async () => {
      openEpicTabs(["Alpha"]);
      seedApproval("e-alpha", "chat-cold");
      busy("e-alpha", ["agent-1"]);
      await renderStrip("/elsewhere", LEFT_STRIP);

      const row = screen.getByTestId("tab-epic-e-alpha");
      expect(within(row).queryByTestId("side-tab-disclosure")).toBeNull();
      expect(row.hasAttribute("aria-expanded")).toBe(false);
      const group = screen.getByTestId("strip-agent-group");
      expect(agentIds(group)).toEqual(["strip-agent-host:approval-0"]);
      const needsYou = within(group).getByTestId("strip-agent-host:approval-0");
      expect(needsYou.getAttribute("data-status")).toBe("waiting");
      expect(glyphKindOf(needsYou)).toBe("approval");

      fireEvent.click(needsYou);

      expect(activateSpy).toHaveBeenCalledTimes(1);
      expect(activateSpy.mock.calls[0][0]).toMatchObject({
        feedId: "host:approval-0",
      });
    });

    it("shows five agents, then Show N more, which expands the rest in place", async () => {
      openEpicTabs(["Alpha"]);
      const ids = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"];
      warmEpic(
        "e-alpha",
        ids.map((id, index) =>
          chatProjection(id, { title: id, updatedAt: index }),
        ),
      );
      busy("e-alpha", ids);
      await renderStrip("/elsewhere", LEFT_STRIP);

      const group = screen.getByTestId("strip-agent-group");
      expect(agentIds(group)).toHaveLength(6);
      expect(within(group).getAllByRole("button")).toHaveLength(6);
      const more = within(group).getByTestId("strip-agent-show-more");
      expect(more.textContent).toBe("Show 2 more");

      fireEvent.click(more);

      const rest = screen.getByTestId("strip-agent-group");
      expect(within(rest).queryByTestId("strip-agent-show-more")).toBeNull();
      expect(within(rest).getAllByRole("button")).toHaveLength(7);
    });

    it("opens an agent's chat in its task's canvas, activating the task first when it is not in front", async () => {
      openEpicTabs(["Alpha", "Beta"]);
      warmEpic("e-alpha", [chatProjection("a-1", { title: "Alpha agent" })]);
      warmEpic("e-beta", [chatProjection("b-1", { title: "Beta agent" })]);
      __setAgentActivityStateForTests(
        {
          "e-alpha": { working: ["a-1"], turn: ["a-1"] },
          "e-beta": { working: ["b-1"], turn: ["b-1"] },
        },
        "local",
        "connected",
      );
      await renderStrip("/elsewhere", LEFT_STRIP);
      const tilesOf = (tabId: string): ReadonlyArray<string | undefined> =>
        Object.values(
          useEpicCanvasStore.getState().canvasByTabId[tabId]
            ?.tilesByInstanceId ?? {},
        ).map((tile) => tile?.id);

      fireEvent.click(screen.getByTestId("strip-agent-a-1"));
      expect(tilesOf("e-alpha")).toContain("a-1");

      // Beta is a warm task that is not in front: its group is collapsed
      // until expanded, and opening from it brings its task to the front.
      fireEvent.click(
        within(screen.getByTestId("tab-epic-e-beta")).getByTestId(
          "side-tab-disclosure",
        ),
      );
      fireEvent.click(screen.getByTestId("strip-agent-b-1"));
      await flushNav();

      expect(tilesOf("e-beta")).toContain("b-1");
      await waitFor(() => {
        expect(
          screen.getByTestId("tab-epic-e-beta").getAttribute("aria-selected"),
        ).toBe("true");
      });
    });

    describe("where the chat is, and what a click does", () => {
      const HOST_ID = "host-a";
      const IDS = ["c-focused", "c-side", "c-back", "c-closed"];

      function chatTile(id: string): EpicCanvasTileRef {
        return {
          id,
          instanceId: `tile-${id}`,
          type: "chat",
          name: id,
          hostId: HOST_ID,
        };
      }

      /** Each pane of `tabId`'s canvas by the chats in it: the one in front, then all. */
      function panesOf(tabId: string): ReadonlyArray<{
        readonly id: string;
        readonly front: string | undefined;
        readonly chats: ReadonlyArray<string | undefined>;
      }> {
        const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
        const chatOf = (instanceId: string | null): string | undefined =>
          instanceId === null
            ? undefined
            : canvas?.tilesByInstanceId[instanceId]?.id;
        return collectPanes(canvas?.root ?? null).map((pane) => ({
          id: pane.id,
          front: chatOf(pane.activeTabId),
          chats: pane.tabInstanceIds.map(chatOf),
        }));
      }

      /**
       * Two panes side by side, the left one focused: `c-focused` is in front
       * in the left pane with `c-back` behind it, `c-side` is in front in the
       * right pane, and `c-closed` is not open at all.
       */
      function seedTwoPanes(tabId: string): void {
        const canvas = useEpicCanvasStore.getState();
        act(() => {
          canvas.openTileInTab(tabId, chatTile("c-back"));
          canvas.openTileInTab(tabId, chatTile("c-focused"));
        });
        const leftPaneId = panesOf(tabId)[0].id;
        act(() => {
          canvas.splitPaneWithNode(
            tabId,
            leftPaneId,
            "right",
            chatTile("c-side"),
          );
          canvas.setActiveTilePane(tabId, leftPaneId);
        });
      }

      function focusedPaneOf(tabId: string): "left" | "right" {
        const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
        return canvas?.activePaneId === panesOf(tabId)[0].id ? "left" : "right";
      }

      function requestedJump(chatId: string) {
        return useChatTranscriptJumpStore.getState().requestsByChatId[
          chatTranscriptJumpKey(HOST_ID, chatId)
        ]?.target;
      }

      async function renderAlphaWithChats(): Promise<void> {
        openEpicTabs(["Alpha"]);
        warmEpic(
          "e-alpha",
          IDS.map((id) => chatProjection(id, { title: id })),
        );
        busy("e-alpha", IDS);
        await renderStrip("/elsewhere", LEFT_STRIP);
      }

      const rowOf = (id: string): HTMLElement =>
        screen.getByTestId(`strip-agent-${id}`);
      // The row's two states: a chat on screen (any pane) reads in full-strength
      // text and says so in its name; one that is not stays muted.
      const isOnScreen = (id: string): boolean =>
        rowOf(id).classList.contains("text-foreground");
      const namedOnScreen = (id: string): boolean =>
        (rowOf(id).getAttribute("aria-label") ?? "").endsWith(", on screen");

      it("reads a chat on screen in any pane as on screen, the focused pane's like the other, and leaves one behind a tab or not open muted", async () => {
        await renderAlphaWithChats();
        seedTwoPanes("e-alpha");

        for (const id of ["c-focused", "c-side"]) {
          expect(isOnScreen(id)).toBe(true);
          expect(namedOnScreen(id)).toBe(true);
          expect(rowOf(id).hasAttribute("aria-current")).toBe(false);
        }
        // Focus is no third state: the focused pane's row is the other's twin.
        expect(rowOf("c-focused").className).toBe(rowOf("c-side").className);
        // In a background tab of a pane, or not open: not on screen.
        for (const id of ["c-back", "c-closed"]) {
          expect(isOnScreen(id)).toBe(false);
          expect(namedOnScreen(id)).toBe(false);
        }
      });

      it("counts the split partner's canvas as on screen, and a task that is not in front as not", async () => {
        openSplitPair("left");
        warmEpic("e-alpha", []);
        warmEpic("e-beta", [
          chatProjection("s-right", { title: "Right agent" }),
        ]);
        act(() => {
          useEpicCanvasStore
            .getState()
            .openTileInTab("e-beta", chatTile("s-right"));
        });
        indicatorState.value = {
          epics: {},
          chats: { "s-right": { ...NO_FLAGS, pendingApproval: true } },
        };
        await renderStrip("/elsewhere", LEFT_STRIP);

        expect(isOnScreen("s-right")).toBe(true);

        // Un-pair: the same tile in a task that is no longer showing.
        cleanup();
        coolAllEpics();
        openEpicTabs(["Alpha", "Beta"]);
        warmEpic("e-beta", [
          chatProjection("s-right", { title: "Right agent" }),
        ]);
        act(() => {
          useEpicCanvasStore
            .getState()
            .openTileInTab("e-beta", chatTile("s-right"));
        });
        await renderStrip("/elsewhere", LEFT_STRIP);

        expect(rowOf("s-right")).toBeTruthy();
        expect(isOnScreen("s-right")).toBe(false);
      });

      const SIDE_PANE = { front: "c-side", chats: ["c-side"] };
      it.each([
        {
          state: "not open",
          chat: "c-closed",
          left: {
            front: "c-closed",
            chats: ["c-back", "c-focused", "c-closed"],
          },
          focused: "left",
          flashes: false,
        },
        {
          state: "in a background tab",
          chat: "c-back",
          left: { front: "c-back", chats: ["c-back", "c-focused"] },
          focused: "left",
          flashes: false,
        },
        {
          state: "on screen, not focused",
          chat: "c-side",
          left: { front: "c-focused", chats: ["c-back", "c-focused"] },
          focused: "right",
          flashes: true,
        },
        {
          state: "in the focused pane",
          chat: "c-focused",
          left: { front: "c-focused", chats: ["c-back", "c-focused"] },
          focused: "left",
          flashes: false,
        },
      ])(
        "takes a click on a chat $state to where it is live: focus, a flash only when it was on screen elsewhere, then its live point",
        async ({ chat, left, focused, flashes }) => {
          await renderAlphaWithChats();
          seedTwoPanes("e-alpha");

          fireEvent.click(rowOf(chat));

          const [leftPane, rightPane] = panesOf("e-alpha");
          expect({ front: leftPane.front, chats: leftPane.chats }).toEqual(
            left,
          );
          expect({ front: rightPane.front, chats: rightPane.chats }).toEqual(
            SIDE_PANE,
          );
          expect(focusedPaneOf("e-alpha")).toBe(focused);
          const flash = usePaneEmphasisStore.getState().flash;
          expect(flash?.instanceId).toBe(flashes ? "tile-c-side" : undefined);
          expect(requestedJump(chat)).toEqual({ kind: "end" });
        },
      );

      it("outlines the pane of a chat that is on screen while its row is hovered, and no pane for one that is not", async () => {
        await renderAlphaWithChats();
        seedTwoPanes("e-alpha");
        const outlined = () =>
          usePaneEmphasisStore.getState().outlinedInstanceId;

        fireEvent.pointerEnter(rowOf("c-back"));
        expect(outlined()).toBeNull();

        fireEvent.pointerEnter(rowOf("c-side"));
        expect(outlined()).toBe("tile-c-side");
        fireEvent.pointerLeave(rowOf("c-side"));
        expect(outlined()).toBeNull();
      });

      it("sends a waiting agent's click through its prompt's activation, which lands on the pending card, and still flashes a pane on screen elsewhere", async () => {
        seedApproval("e-alpha", "c-side");
        indicatorState.value = {
          epics: {},
          chats: { "c-side": { ...NO_FLAGS, pendingApproval: true } },
        };
        await renderAlphaWithChats();
        seedTwoPanes("e-alpha");

        fireEvent.click(rowOf("c-side"));

        expect(activateSpy).toHaveBeenCalledTimes(1);
        expect(activateSpy.mock.calls[0][0]).toMatchObject({
          feedId: "host:approval-0",
        });
        expect(usePaneEmphasisStore.getState().flash?.instanceId).toBe(
          "tile-c-side",
        );
        // The prompt's own landing is the live point: nothing parks an end jump.
        expect(requestedJump("c-side")).toBeUndefined();
      });
    });

    it("lists each busy half's agents under the pair, the left half's first, each under a caption naming its half", async () => {
      openSplitPair("left");
      warmEpic("e-alpha", [chatProjection("s-left", { title: "Left agent" })]);
      warmEpic("e-beta", [chatProjection("s-right", { title: "Right agent" })]);
      __setAgentActivityStateForTests(
        { "e-alpha": { working: ["s-left"], turn: ["s-left"] } },
        "local",
        "connected",
      );
      // The unfocused half is collapsed, so only its waiting agent shows.
      indicatorState.value = {
        epics: {},
        chats: { "s-right": { ...NO_FLAGS, pendingApproval: true } },
      };
      await renderStrip("/elsewhere", LEFT_STRIP);

      const pair = screen.getByTestId("split-tab-group-split-a");
      const leftRow = within(pair).getByTestId("tab-epic-e-alpha");
      const rightRow = within(pair).getByTestId("tab-epic-e-beta");
      const leftAgent = screen.getByTestId("strip-agent-s-left");
      const rightAgent = screen.getByTestId("strip-agent-s-right");
      const leftGroup = leftAgent.closest<HTMLElement>('[role="group"]');
      const rightGroup = rightAgent.closest<HTMLElement>('[role="group"]');
      if (leftGroup === null || rightGroup === null)
        throw new Error("no group");
      expect(leftGroup.getAttribute("aria-labelledby")).toBe(leftRow.id);
      expect(rightGroup.getAttribute("aria-labelledby")).toBe(rightRow.id);
      const leftCaption = within(leftGroup).getByTestId(
        "split-half-caption-left",
      );
      const rightCaption = within(rightGroup).getByTestId(
        "split-half-caption-right",
      );
      expect(leftCaption.textContent).toBe("Alpha");
      expect(rightCaption.textContent).toBe("Beta");
      // Under the pair's row, not inside it: the row stays one line of two halves.
      expect(pair.contains(leftAgent)).toBe(false);
      const follows = (a: HTMLElement, b: HTMLElement): boolean =>
        (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      expect(follows(rightRow, leftCaption)).toBe(true);
      expect(follows(leftCaption, leftAgent)).toBe(true);
      expect(follows(leftAgent, rightCaption)).toBe(true);
      expect(follows(rightCaption, rightAgent)).toBe(true);
    });
  });

  it("shows the waiting chip on a row whose agent waits for a reply", async () => {
    openEpicTabs(["Alpha", "Beta"]);
    waitingState.byEpicId.set("e-beta", "reply");
    await renderStrip("/elsewhere", LEFT_STRIP);

    const beta = screen.getByTestId("tab-epic-e-beta");
    expect(within(beta).getByTestId("side-tab-waiting-chip").textContent).toBe(
      "Reply",
    );
    expect(
      within(screen.getByTestId("tab-epic-e-alpha")).queryByTestId(
        "side-tab-waiting-chip",
      ),
    ).toBeNull();
  });

  it("has no hidden-tabs menu, however many rows there are", async () => {
    openEpicTabs(["One", "Two", "Three", "Four", "Five", "Six", "Seven"]);
    await renderStrip("/elsewhere", LEFT_STRIP);

    expect(screen.getAllByRole("tab")).toHaveLength(7);
    expect(document.querySelector("[data-hidden-tabs-control]")).toBeNull();
  });

  it("adds the traffic-light title row only when the strip owns the title bar", async () => {
    await renderStrip("/", { ...LEFT_STRIP, ownsTitleBar: true });

    const titleRow = screen.getByTestId("side-strip-title-row");
    expect(titleRow.className).toContain("h-10");
    expect(titleRow.className).toContain(
      "wco:pl-[var(--window-leading-inset)]",
    );
    // The collapse toggle lives in the title row; New Task moved out of it (F7).
    expect(
      titleRow.contains(screen.getByTestId("side-tab-strip-collapse")),
    ).toBe(true);
    expect(titleRow.contains(screen.getByTestId("side-strip-new-task"))).toBe(
      false,
    );
    cleanup();

    await renderStrip("/", LEFT_STRIP);
    expect(screen.queryByTestId("side-strip-title-row")).toBeNull();
  });

  it("keeps the rail no narrower than the traffic lights when it owns the title bar", async () => {
    useSideTabStripStore.setState({ collapsed: true });
    const strip = await renderStrip("/", {
      ...LEFT_STRIP,
      ownsTitleBar: true,
    });

    expect(strip.style.width).toBe("60px");
    expect(strip.className).toContain(
      "wco:min-w-[var(--window-leading-inset)]",
    );
  });

  it("collapses to the 60px rail with no macOS inset floor when it does not own the title bar", async () => {
    useSideTabStripStore.setState({ collapsed: true });
    const strip = await renderStrip("/", LEFT_STRIP);

    expect(strip.style.width).toBe("60px");
    expect(strip.className).not.toContain(
      "wco:min-w-[var(--window-leading-inset)]",
    );
  });

  it("keeps the expanded strip wide enough for the title row only when it owns the title bar", async () => {
    const titleRowFloor =
      "wco:min-w-[calc(var(--window-leading-inset)+8.5rem)]";
    const owning = await renderStrip("/", {
      ...LEFT_STRIP,
      ownsTitleBar: true,
    });
    expect(owning.className).toContain(titleRowFloor);
    expect(owning.className).toContain("max-w-[40vw]");
    cleanup();

    const notOwning = await renderStrip("/", LEFT_STRIP);
    expect(notOwning.className).not.toContain(titleRowFloor);
    cleanup();

    useSideTabStripStore.setState({ collapsed: true });
    const rail = await renderStrip("/", { ...LEFT_STRIP, ownsTitleBar: true });
    expect(rail.className).not.toContain(titleRowFloor);
    expect(rail.className).not.toContain("max-w-[40vw]");
  });

  it("drops the window drag region while a row's menu is open", async () => {
    // A frameless desktop window.
    (window as { runnerHost?: unknown }).runnerHost = {};
    openEpicTabs(["Alpha"]);
    const strip = await renderStrip("/elsewhere", LEFT_STRIP);
    expect(strip.className).toContain("[-webkit-app-region:drag]");

    fireEvent.contextMenu(screen.getByTestId("tab-epic-e-alpha"));
    await screen.findByText("Close Other Tabs");

    expect(strip.className).toContain("[-webkit-app-region:no-drag]");
    expect(strip.className).not.toContain("[-webkit-app-region:drag]");
    expect(useTitleBarDragStore.getState().suppressors.size).toBe(1);

    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await vi.waitFor(() => {
      expect(strip.className).toContain("[-webkit-app-region:drag]");
    });
  });

  it("eases the width only for the collapse toggle, until that transition ends", async () => {
    motion.enabled = true;
    openEpicTabs(["Alpha"]);
    const strip = await renderStrip("/elsewhere", LEFT_STRIP);
    const easingClass = "transition-[width]";
    expect(strip.className).not.toContain(easingClass);

    fireEvent.click(screen.getByTestId("side-tab-strip-collapse"));
    expect(strip.getAttribute("data-collapsed")).toBe("true");
    expect(strip.className).toContain(easingClass);
    endWidthTransition(strip);
    expect(strip.className).not.toContain(easingClass);

    // Out of the rail through the handle, then a nudge: neither eases.
    const handle = screen.getByTestId("side-tab-strip-resize-handle");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(strip.getAttribute("data-collapsed")).toBe("false");
    expect(strip.className).not.toContain(easingClass);
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(useSideTabStripStore.getState().widthPx).toBe(264);
    expect(strip.className).not.toContain(easingClass);
  });

  it("clears the easing class synchronously when the keyboard action fires right after a click", async () => {
    motion.enabled = true;
    openEpicTabs(["Alpha"]);
    const strip = await renderStrip("/elsewhere", LEFT_STRIP);
    const easingClass = "transition-[width]";

    fireEvent.click(screen.getByTestId("side-tab-strip-collapse"));
    expect(strip.getAttribute("data-collapsed")).toBe("true");
    expect(strip.className).toContain(easingClass);

    expect(collapseViaKeyboard()).toBe(true);

    expect(strip.getAttribute("data-collapsed")).toBe("false");
    expect(strip.className).not.toContain(easingClass);
  });

  it("draws a group holding a tab and a split as one block with its header and no colour bars, and folds", async () => {
    openGroupWithTabAndSplit();
    // A member's own colour is kept but not drawn while it is grouped.
    useTabsStore
      .getState()
      .setTabCustomization({ kind: "epic", id: "e-one" }, { color: "#ff0000" });
    // Two flagged members, so the folded badge has to pick the worst:
    // waiting outranks a failure (S-17).
    indicatorState.value = {
      epics: {
        "e-one": {
          unreadFailure: false,
          unreadDone: false,
          pendingApproval: true,
          pendingInterview: false,
          pendingFork: false,
        },
        "e-three": {
          unreadFailure: true,
          unreadDone: false,
          pendingApproval: false,
          pendingInterview: false,
          pendingFork: false,
        },
      },
      chats: {},
    };
    await renderStrip("/elsewhere", LEFT_STRIP);

    const block = screen.getByTestId("side-tab-group-block-g");
    const header = within(block).getByTestId("side-tab-group-header-g");
    expect(within(header).getByTestId("side-tab-group-name").textContent).toBe(
      "Work",
    );
    expect(within(header).queryByTestId("side-tab-group-count")).toBeNull();
    for (const id of ["e-one", "e-two", "e-three"]) {
      const row = within(block).getByTestId(`tab-epic-${id}`);
      expect(within(row).queryByTestId("side-tab-accent")).toBeNull();
    }
    expect(within(block).queryByTestId("tab-epic-e-four")).toBeNull();
    expect(
      within(screen.getByTestId("tab-epic-e-four")).queryByTestId(
        "side-tab-accent",
      ),
    ).not.toBeNull();
    expect(screen.queryByTestId("side-tab-group-badge")).toBeNull();

    fireEvent.click(header);

    for (const id of ["e-one", "e-two", "e-three"]) {
      expect(screen.queryByTestId(`tab-epic-${id}`)).toBeNull();
    }
    expect(screen.getByTestId("tab-epic-e-four")).toBeDefined();
    expect(
      within(screen.getByTestId("side-tab-group-block-g")).getByTestId(
        "side-tab-group-header-g",
      ),
    ).toBeDefined();
    expect(
      screen.getByTestId("side-tab-group-badge").getAttribute("data-kind"),
    ).toBe("approval");
  });

  it("draws the rail's group as one column around its header tile and its tiles, with no rings, and leaves an ungrouped tile its ring", async () => {
    openGroupWithTabAndSplit();
    const own = { kind: "epic", id: "e-one" } as const;
    useTabsStore.getState().setTabCustomization(own, { color: "#ff0000" });
    useTabsStore
      .getState()
      .setTabCustomization(
        { kind: "epic", id: "e-four" },
        { color: "#00aa00" },
      );
    useSideTabStripStore.setState({ collapsed: true });
    await renderStrip("/elsewhere", LEFT_STRIP);

    const column = screen.getByTestId("side-tab-group-column-g");
    expect(within(column).getByTestId("side-tab-group-header-g")).toBeDefined();
    for (const id of ["e-one", "e-two", "e-three"]) {
      const tile = within(column).getByTestId(`tab-epic-${id}`);
      expect(within(tile).queryByTestId("side-tab-accent")).toBeNull();
    }
    const four = screen.getByTestId("tab-epic-e-four");
    expect(column.contains(four)).toBe(false);
    expect(
      within(four)
        .getByTestId("side-tab-accent")
        .style.getPropertyValue("--side-tab-accent"),
    ).toBe("#00aa00");
  });

  it("keeps a folded group's header tile and badge inside its column", async () => {
    openGroupWithTabAndSplit();
    useTabsStore.getState().updateGroup("g", { collapsed: true });
    indicatorState.value = {
      epics: { "e-one": { ...NO_FLAGS, pendingApproval: true } },
      chats: {},
    };
    useSideTabStripStore.setState({ collapsed: true });
    await renderStrip("/elsewhere", LEFT_STRIP);

    const column = screen.getByTestId("side-tab-group-column-g");
    expect(within(column).queryAllByRole("tab")).toHaveLength(0);
    expect(
      within(column)
        .getByTestId("side-tab-group-badge")
        .getAttribute("data-kind"),
    ).toBe("approval");
  });

  describe("the Activity view's sections", () => {
    const MINUTE_MS = 60_000;

    beforeEach(() => {
      setSideStripView("activity");
      activateSpy.mockClear();
    });

    afterEach(() => {
      vi.useRealTimers();
      coolAllEpics();
      __resetAgentActivityStoreForTests();
      __resetHostNotificationsStoreForTests();
      useStripDisclosureStore.setState({ expanded: {} });
      indicatorState.value = { epics: {}, chats: {} };
      useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
    });

    /**
     * Holds the clock still, so a request made "after the list appeared" is a
     * fact of the test and not of the milliseconds it happened to run in.
     */
    function freezeClock(): void {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-06-01T12:00:00Z"));
    }

    interface Prompt {
      readonly id: string;
      readonly epicId: string;
      readonly chatId: string;
      readonly agentTitle: string;
      readonly taskTitle: string;
      readonly minutesAgo: number;
    }

    /** Approvals waiting on the person, as the host's feed files them. */
    function seedPrompts(prompts: ReadonlyArray<Prompt>): void {
      const entries = prompts.map((prompt): HostNotificationEntryV22 => ({
        id: prompt.id,
        updatedAt: Date.now() - prompt.minutesAgo * MINUTE_MS,
        readAt: null,
        kind: "approval.requested",
        sourceRef: prompt.id,
        severity: "needs_action",
        outcome: null,
        resolvedAt: null,
        epicId: prompt.epicId,
        chatId: prompt.chatId,
        payload: {
          kind: "approval",
          epicId: prompt.epicId,
          chatId: prompt.chatId,
          chatTitle: prompt.agentTitle,
          taskTitle: prompt.taskTitle,
          approvalId: prompt.id,
        },
      }));
      act(() => {
        useHostNotificationsStore.getState().applySnapshot({
          attention: { entries, nextCursor: null },
          recent: { entries, nextCursor: null },
          summary: {
            unreadCount: entries.length,
            attentionCount: entries.length,
          },
        });
      });
    }

    function isWorking(epicId: string, chatId: string): void {
      __setAgentActivityStateForTests(
        { [epicId]: { working: [chatId], turn: [chatId] } },
        "local",
        "connected",
      );
    }

    /**
     * Alpha (in front) and Zeta are idle, Beta is running, Gamma is waiting on
     * an approval, Delta finished and Epsilon failed, both unread.
     */
    function openSectionedTasks(): void {
      openEpicTabs(["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"]);
      isWorking("e-beta", "c-beta");
      indicatorState.value = {
        epics: {
          "e-gamma": { ...NO_FLAGS, pendingApproval: true },
          "e-delta": { ...NO_FLAGS, unreadDone: true },
          "e-epsilon": { ...NO_FLAGS, unreadFailure: true },
        },
        chats: {},
      };
    }

    /** The scroller's children in order: section headers and the tabs under them. */
    function listed(): ReadonlyArray<string | null> {
      return Array.from(
        screen.getByTestId("header-tab-strip-scroll").children,
      ).map(
        (child) =>
          child.getAttribute("data-testid") ??
          child.querySelector('[role="tab"]')?.getAttribute("data-testid") ??
          null,
      );
    }

    function header(section: string): HTMLElement {
      return screen.getByTestId(`side-strip-section-${section}`);
    }

    it("lists the tasks under Needs you, To review, Working and Idle, each section in the tab order", async () => {
      openSectionedTasks();
      await renderStrip("/elsewhere", LEFT_STRIP);

      expect(listed()).toEqual([
        "side-strip-section-needs-you",
        "tab-epic-e-gamma",
        "side-strip-section-to-review",
        "tab-epic-e-delta",
        "tab-epic-e-epsilon",
        "side-strip-section-working",
        "tab-epic-e-beta",
        "side-strip-section-idle",
        "tab-epic-e-alpha",
        "tab-epic-e-zeta",
      ]);
      expect(
        ["needs-you", "to-review", "working", "idle"].map(
          (section) => header(section).textContent,
        ),
      ).toEqual(["Needs you1", "To review2", "Working1", "Idle2"]);
      expect(screen.queryByTestId("side-strip-tasks-label")).toBeNull();
    });

    it("leaves out a section with nothing in it", async () => {
      openEpicTabs(["Alpha", "Beta"]);
      await renderStrip("/elsewhere", LEFT_STRIP);

      expect(listed()).toEqual([
        "side-strip-section-idle",
        "tab-epic-e-alpha",
        "tab-epic-e-beta",
      ]);
    });

    it("draws each header as a button the tablist holds beside its tabs, amber only for Needs you", async () => {
      openSectionedTasks();
      await renderStrip("/elsewhere", LEFT_STRIP);

      const tablist = screen.getByRole("tablist");
      for (const section of ["needs-you", "to-review", "working", "idle"]) {
        const button = header(section);
        expect(button.tagName).toBe("BUTTON");
        expect(button.parentElement).toBe(tablist);
        expect(button.getAttribute("aria-expanded")).toBe("true");
      }
      expect(header("needs-you").className).toContain(
        "text-warning-foreground",
      );
      for (const section of ["to-review", "working", "idle"]) {
        expect(header(section).className).not.toContain(
          "text-warning-foreground",
        );
      }
      expect(screen.getAllByRole("tab")).toHaveLength(6);
    });

    it("folds and unfolds a section from its header, leaving the others alone", async () => {
      openSectionedTasks();
      await renderStrip("/elsewhere", LEFT_STRIP);

      fireEvent.click(header("idle"));

      expect(header("idle").getAttribute("aria-expanded")).toBe("false");
      // A folded section keeps its header and its whole count, and only its rows go.
      expect(header("idle").textContent).toBe("Idle2");
      expect(screen.queryByTestId("tab-epic-e-zeta")).toBeNull();
      expect(screen.getByTestId("tab-epic-e-beta")).toBeTruthy();
      expect(screen.getByTestId("tab-epic-e-gamma")).toBeTruthy();

      fireEvent.click(header("idle"));

      expect(header("idle").getAttribute("aria-expanded")).toBe("true");
      expect(screen.getByTestId("tab-epic-e-zeta")).toBeTruthy();
    });

    it("keeps the current task's row, and its agents while it is expanded, in a folded section", async () => {
      openEpicTabs(["Alpha", "Beta"]);
      warmEpic("e-alpha", [
        chatProjection("a-run", { title: "Runs" }),
        chatProjection("a-bg", { title: "Watches" }),
      ]);
      __setAgentActivityStateForTests(
        {
          "e-alpha": { working: ["a-run", "a-bg"], turn: ["a-run"] },
          "e-beta": { working: ["b-run"], turn: ["b-run"] },
        },
        "local",
        "connected",
      );
      await renderStrip("/elsewhere", LEFT_STRIP);

      fireEvent.click(header("working"));
      try {
        // Alpha is in front and expanded; Beta goes, and the count stays whole.
        expect(header("working").textContent).toBe("Working2");
        expect(screen.getByTestId("tab-epic-e-alpha")).toBeTruthy();
        expect(screen.getByTestId("strip-agent-a-bg")).toBeTruthy();
        expect(screen.queryByTestId("tab-epic-e-beta")).toBeNull();
      } finally {
        // The fold is kept for the session, so this case hands it back open.
        fireEvent.click(header("working"));
      }
    });

    it("keeps a section folded for the session, through a change of view", async () => {
      openSectionedTasks();
      await renderStrip("/elsewhere", LEFT_STRIP);
      fireEvent.click(header("working"));

      act(() => {
        setSideStripView("layered");
      });
      expect(screen.queryByTestId("side-strip-section-working")).toBeNull();
      act(() => {
        setSideStripView("activity");
      });

      expect(header("working").getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByTestId("tab-epic-e-beta")).toBeNull();
      fireEvent.click(header("working"));
      expect(screen.getByTestId("tab-epic-e-beta")).toBeTruthy();
    });

    it("draws Needs you and To review as two lines and Working and Idle as one", async () => {
      openSectionedTasks();
      seedPrompts([
        {
          id: "approval-gamma",
          epicId: "e-gamma",
          chatId: "c-gamma",
          agentTitle: "Deploy agent",
          taskTitle: "Gamma",
          minutesAgo: 2,
        },
      ]);
      await renderStrip("/elsewhere", LEFT_STRIP);

      const secondLine = (epic: string): string | null =>
        within(screen.getByTestId(`tab-epic-${epic}`)).queryByTestId(
          "side-tab-section-detail",
        )?.textContent ?? null;
      expect(secondLine("e-gamma")).toBe("Approve · Deploy agent");
      expect(secondLine("e-delta")).toBe("Done · ready to review");
      expect(secondLine("e-epsilon")).toBe("Failed");
      expect(secondLine("e-beta")).toBeNull();
      expect(secondLine("e-alpha")).toBeNull();
      // The wait runs from the request, on the title's line, muted amber.
      expect(
        within(screen.getByTestId("tab-epic-e-gamma")).getByTestId(
          "side-tab-section-time",
        ).textContent,
      ).toBe("2m");
      // A two-line row carries no chip: its second line says it.
      expect(screen.queryByTestId("side-tab-waiting-chip")).toBeNull();
      expect(screen.queryByTestId("side-tab-failed-chip")).toBeNull();
      // Loud titles are bold and foreground; an idle one is muted.
      const title = (epic: string): string =>
        within(screen.getByTestId(`tab-epic-${epic}`)).getByTestId(
          "side-tab-title",
        ).className;
      expect(title("e-gamma")).toContain("font-semibold");
      expect(title("e-delta")).toContain("font-semibold");
      expect(title("e-beta")).not.toContain("font-semibold");
      expect(screen.getByTestId("tab-epic-e-zeta").className).toContain(
        "text-muted-foreground",
      );
      expect(screen.getByTestId("tab-epic-e-beta").className).not.toContain(
        "text-muted-foreground",
      );
    });

    it("counts the other requests as +N, and shows no agent, wait or count for a task waiting with no prompt loaded", async () => {
      openEpicTabs(["Alpha", "Beta"]);
      indicatorState.value = {
        epics: {
          "e-alpha": { ...NO_FLAGS, pendingApproval: true },
          "e-beta": { ...NO_FLAGS, pendingInterview: true },
        },
        chats: {},
      };
      seedPrompts([
        {
          id: "approval-1",
          epicId: "e-alpha",
          chatId: "c-1",
          agentTitle: "Deploy agent",
          taskTitle: "Alpha",
          minutesAgo: 5,
        },
        {
          id: "approval-2",
          epicId: "e-alpha",
          chatId: "c-2",
          agentTitle: "Test agent",
          taskTitle: "Alpha",
          minutesAgo: 1,
        },
      ]);
      await renderStrip("/elsewhere", LEFT_STRIP);

      const alpha = screen.getByTestId("tab-epic-e-alpha");
      // The oldest request, and the one other behind it.
      expect(
        within(alpha).getByTestId("side-tab-section-detail").textContent,
      ).toBe("Approve · Deploy agent+1");
      expect(
        within(alpha).getByTestId("side-tab-section-time").textContent,
      ).toBe("5m");
      const beta = screen.getByTestId("tab-epic-e-beta");
      expect(
        within(beta).getByTestId("side-tab-section-detail").textContent,
      ).toBe("Reply");
      expect(within(beta).queryByTestId("side-tab-section-time")).toBeNull();
    });

    it("gives a prompt whose task has no tab in the strip a Needs you row of its own, opened through the notification's activation", async () => {
      openSectionedTasks();
      seedPrompts([
        {
          id: "approval-gamma",
          epicId: "e-gamma",
          chatId: "c-gamma",
          agentTitle: "Deploy agent",
          taskTitle: "Gamma",
          minutesAgo: 3,
        },
        {
          id: "approval-elsewhere",
          epicId: "e-elsewhere",
          chatId: "c-elsewhere",
          agentTitle: "Release agent",
          taskTitle: "Release task",
          minutesAgo: 7,
        },
      ]);
      await renderStrip("/elsewhere", LEFT_STRIP);

      // After the strip's own tasks, inside Needs you; the block is gone.
      expect(listed().slice(0, 3)).toEqual([
        "side-strip-section-needs-you",
        "tab-epic-e-gamma",
        "strip-needs-you-prompt",
      ]);
      expect(header("needs-you").textContent).toBe("Needs you2");
      expect(screen.queryByTestId("side-strip-needs-you")).toBeNull();
      const prompt = screen.getByTestId("strip-needs-you-prompt");
      expect(prompt.textContent).toContain("Release task");
      expect(prompt.textContent).toContain("Approve · Release agent");
      expect(prompt.textContent).toContain("7m");

      fireEvent.click(prompt);

      expect(activateSpy).toHaveBeenCalledTimes(1);
      expect(activateSpy.mock.calls[0]?.[0]).toMatchObject({
        feedId: "host:approval-elsewhere",
      });
    });

    it("counts a prompt of a task in a collapsed group as that task's own, not a row of its own", async () => {
      openGroupWithTabAndSplit();
      useTabsStore.getState().updateGroup("g", { collapsed: true });
      indicatorState.value = {
        epics: { "e-one": { ...NO_FLAGS, pendingApproval: true } },
        chats: {},
      };
      seedPrompts([
        {
          id: "approval-one",
          epicId: "e-one",
          chatId: "c-one",
          agentTitle: "Deploy agent",
          taskTitle: "One",
          minutesAgo: 1,
        },
      ]);
      await renderStrip("/elsewhere", LEFT_STRIP);

      expect(screen.queryByTestId("strip-needs-you-prompt")).toBeNull();
      expect(
        within(screen.getByTestId("tab-epic-e-one")).getByTestId(
          "side-tab-section-detail",
        ).textContent,
      ).toBe("Approve · Deploy agent");
    });

    it("draws a group in its section as a block under a label-only header, with no colour bars and a split pair still one unit", async () => {
      openGroupWithTabAndSplit();
      await renderStrip("/elsewhere", LEFT_STRIP);

      const block = screen.getByTestId("side-tab-group-block-g");
      const label = within(block).getByTestId("side-tab-group-label-g");
      expect(label.textContent).toBe("Work");
      expect(within(label).queryByRole("button")).toBeNull();
      expect(screen.queryByTestId("side-tab-group-header-g")).toBeNull();
      for (const row of within(block).getAllByRole("tab")) {
        expect(within(row).queryByTestId("side-tab-accent")).toBeNull();
      }
      expect(
        within(screen.getByTestId("tab-epic-e-four")).queryByTestId(
          "side-tab-accent",
        ),
      ).not.toBeNull();
      expect(screen.getAllByTestId(/^split-tab-group-/)).toHaveLength(1);
      expect(
        within(block)
          .getByTestId("split-tab-group-split-g")
          .querySelectorAll('[role="tab"]'),
      ).toHaveLength(2);
    });

    it("gives a group whose tasks fall in two sections a block in each, named and uncounted", async () => {
      openGroupWithTabAndSplit();
      isWorking("e-one", "c-one");
      await renderStrip("/elsewhere", LEFT_STRIP);

      expect(listed()).toEqual([
        "side-strip-section-working",
        "side-tab-group-block-g",
        "side-strip-section-idle",
        "side-tab-group-block-g",
        "tab-epic-e-four",
      ]);
      const [working, idle] = screen.getAllByTestId("side-tab-group-block-g");
      expect(
        within(working).getByTestId("side-tab-group-label-g").textContent,
      ).toBe("Work");
      expect(within(working).getAllByRole("tab")).toHaveLength(1);
      expect(
        within(idle).getByTestId("side-tab-group-label-g").textContent,
      ).toBe("Work");
      expect(within(idle).getAllByRole("tab")).toHaveLength(2);
    });

    it("draws the rail's group runs as a column in each section, with no rings, and no column for an ungrouped tile", async () => {
      openGroupWithTabAndSplit();
      isWorking("e-one", "c-one");
      useTabsStore
        .getState()
        .setTabCustomization(
          { kind: "epic", id: "e-four" },
          { color: "#00aa00" },
        );
      useSideTabStripStore.setState({ collapsed: true });
      await renderStrip("/elsewhere", LEFT_STRIP);

      const [working, idle] = screen.getAllByTestId("side-tab-group-column-g");
      expect(within(working).getAllByRole("tab")).toHaveLength(1);
      expect(within(idle).getAllByRole("tab")).toHaveLength(2);
      for (const tile of [
        ...within(working).getAllByRole("tab"),
        ...within(idle).getAllByRole("tab"),
      ]) {
        expect(within(tile).queryByTestId("side-tab-accent")).toBeNull();
      }
      const four = screen.getByTestId("tab-epic-e-four");
      expect(
        four.closest('[data-testid^="side-tab-group-column-"]'),
      ).toBeNull();
      expect(within(four).getByTestId("side-tab-accent")).toBeDefined();
    });

    it("keeps a collapsed group's members in their sections", async () => {
      openGroupWithTabAndSplit();
      useTabsStore.getState().updateGroup("g", { collapsed: true });
      await renderStrip("/elsewhere", LEFT_STRIP);

      expect(screen.getAllByRole("tab")).toHaveLength(4);
      expect(screen.queryByTestId("side-tab-group-header-g")).toBeNull();
    });

    it("nests no needs-you rows under a Needs you task and, expanded, lists all its agents with the waiting one first", async () => {
      openEpicTabs(["Alpha", "Gamma"]);
      warmEpic("e-gamma", [
        chatProjection("c-run", { title: "Runs", updatedAt: 1 }),
        chatProjection("c-wait", { title: "Waits", updatedAt: 2 }),
      ]);
      isWorking("e-gamma", "c-run");
      indicatorState.value = {
        epics: { "e-gamma": { ...NO_FLAGS, pendingApproval: true } },
        chats: { "c-wait": { ...NO_FLAGS, pendingApproval: true } },
      };
      seedPrompts([
        {
          id: "approval-gamma",
          epicId: "e-gamma",
          chatId: "c-wait",
          agentTitle: "Waits",
          taskTitle: "Gamma",
          minutesAgo: 1,
        },
      ]);
      await renderStrip("/elsewhere", LEFT_STRIP);

      const row = screen.getByTestId("tab-epic-e-gamma");
      // Its second line names the request: nothing is nested under it.
      expect(screen.getByTestId("strip-agent-group").hidden).toBe(true);
      expect(screen.queryByTestId("strip-agent-c-wait")).toBeNull();
      expect(
        screen.queryByTestId("strip-agent-host:approval-gamma"),
      ).toBeNull();

      fireEvent.click(within(row).getByTestId("side-tab-disclosure"));

      expect(row.getAttribute("aria-expanded")).toBe("true");
      expect(
        Array.from(
          screen
            .getByTestId("strip-agent-group")
            .querySelectorAll('[data-testid^="strip-agent-"]'),
        ).map((node) => node.getAttribute("data-testid")),
      ).toEqual(["strip-agent-c-wait", "strip-agent-c-run"]);
    });

    it("keeps a two-line row's pending-fork glyph and time, then the chevron, then the close, at the trailing edge", async () => {
      openEpicTabs(["Alpha", "Gamma"]);
      warmEpic("e-gamma", [chatProjection("c-run", { title: "Runs" })]);
      isWorking("e-gamma", "c-run");
      indicatorState.value = {
        epics: {
          "e-gamma": { ...NO_FLAGS, pendingApproval: true, pendingFork: true },
        },
        chats: {},
      };
      seedPrompts([
        {
          id: "approval-gamma",
          epicId: "e-gamma",
          chatId: "c-gamma",
          agentTitle: "Deploy agent",
          taskTitle: "Gamma",
          minutesAgo: 2,
        },
      ]);
      await renderStrip("/elsewhere", LEFT_STRIP);

      expect(
        Array.from(
          within(screen.getByTestId("tab-epic-e-gamma"))
            .getByTestId("side-tab-trailing")
            .querySelectorAll(
              '[data-status-glyph], [data-testid="side-tab-section-time"], [data-testid="side-tab-disclosure"], [data-testid^="tab-close-"]',
            ),
        ).map(
          (node) =>
            node.getAttribute("data-status-glyph") ??
            (node.getAttribute("data-testid") ?? "").replace(
              /^tab-close-.*/,
              "close",
            ),
        ),
      ).toEqual([
        "fork",
        "side-tab-section-time",
        "side-tab-disclosure",
        "close",
      ]);
    });

    it("lets a one-line row's meter and glyph yield to the chevron and the close, where a chip stayed", async () => {
      openEpicTabs(["Alpha", "Beta", "Gamma"]);
      warmEpic("e-beta", [
        chatProjection("b-1", { title: "One" }),
        chatProjection("b-2", { title: "Two" }),
      ]);
      __setAgentActivityStateForTests(
        {
          "e-beta": { working: ["b-1", "b-2"], turn: ["b-1", "b-2"] },
          "e-gamma": { working: ["g-1"], turn: ["g-1"] },
        },
        "local",
        "connected",
      );
      await renderStrip("/elsewhere", LEFT_STRIP);

      const yields = (epic: string, status: string): boolean => {
        const trailing = within(
          screen.getByTestId(`tab-epic-${epic}`),
        ).getByTestId("side-tab-trailing");
        const node = trailing.querySelector(status);
        return (
          node
            ?.closest("span.col-start-1")
            ?.className.includes("group-hover/side-tab:opacity-0") ?? false
        );
      };
      expect(yields("e-beta", '[data-testid="side-tab-meter"]')).toBe(true);
      expect(yields("e-gamma", "[data-status-glyph]")).toBe(true);
    });

    it("keeps the current task's tint and its always-shown close in whichever section it is in", async () => {
      openSectionedTasks();
      await renderStrip("/elsewhere", LEFT_STRIP);

      // Alpha is in front and idle.
      const alpha = screen.getByTestId("tab-epic-e-alpha");
      expect(alpha.getAttribute("aria-selected")).toBe("true");
      expect(alpha.getAttribute("data-active")).toBe("true");
      expect(alpha.querySelector('[data-revealed="always"]')).not.toBeNull();
      expect(
        screen
          .getByTestId("tab-epic-e-zeta")
          .querySelector('[data-revealed="always"]'),
      ).toBeNull();
    });

    it("moves a task between sections as its state changes, in place of a reorder", async () => {
      openSectionedTasks();
      await renderStrip("/elsewhere", LEFT_STRIP);
      expect(header("working").textContent).toBe("Working1");

      act(() => {
        __setAgentActivityStateForTests(
          {
            "e-beta": { working: ["c-beta"], turn: ["c-beta"] },
            "e-zeta": { working: ["c-zeta"], turn: ["c-zeta"] },
          },
          "local",
          "connected",
        );
      });

      expect(header("working").textContent).toBe("Working2");
      expect(header("idle").textContent).toBe("Idle1");
      expect(useTabsStore.getState().stripOrder.map((ref) => ref.id)).toEqual([
        "e-alpha",
        "e-beta",
        "e-gamma",
        "e-delta",
        "e-epsilon",
        "e-zeta",
      ]);
    });

    it("announces a task arriving in Needs you once, and no other move", async () => {
      openSectionedTasks();
      freezeClock();
      const releasePrompt = (id: string, minutesAgo: number) => ({
        id,
        epicId: "e-release",
        chatId: "c-release",
        agentTitle: "Release agent",
        taskTitle: "Release task",
        minutesAgo,
      });
      const betaPrompt = {
        id: "approval-beta",
        epicId: "e-beta",
        chatId: "c-beta",
        agentTitle: "Beta agent",
        taskTitle: "Beta",
        minutesAgo: 0,
      };
      seedPrompts([
        releasePrompt("approval-first", 7),
        releasePrompt("approval-second", 3),
      ]);
      await renderStrip("/elsewhere", LEFT_STRIP);
      const region = screen.getByTestId("strip-needs-you-announcement");
      const spoken = new MutationObserver(() => undefined);
      spoken.observe(region, { childList: true, subtree: true });
      // Gamma and the tab-less Release task were waiting when the list
      // appeared: nothing to announce.
      expect(region.textContent).toBe("");
      const approval = { ...NO_FLAGS, pendingApproval: true };

      // Beta, which was running, now asks for an approval, a minute on.
      vi.setSystemTime(Date.now() + MINUTE_MS);
      seedPrompts([
        releasePrompt("approval-first", 8),
        releasePrompt("approval-second", 4),
        betaPrompt,
      ]);
      act(() => {
        indicatorState.value = {
          epics: {
            "e-gamma": approval,
            "e-beta": approval,
            "e-delta": { ...NO_FLAGS, unreadDone: true },
            "e-epsilon": { ...NO_FLAGS, unreadFailure: true },
          },
          chats: {},
        };
        // The strip reads its indicators when it renders; a new active tab does.
        useTabsStore.setState({
          activeItemId: tabItemId({ kind: "epic", id: "e-zeta" }),
        });
      });
      expect(header("needs-you").textContent).toBe("Needs you3");
      expect(region.textContent).toBe("Beta needs you");
      expect(spoken.takeRecords().length).toBeGreaterThan(0);

      // Delta and Epsilon are read, leaving To review, and Zeta starts working:
      // moves, but not into Needs you.
      act(() => {
        indicatorState.value = {
          epics: { "e-gamma": approval, "e-beta": approval },
          chats: {},
        };
        isWorking("e-zeta", "c-zeta");
        useTabsStore.setState({
          activeItemId: tabItemId({ kind: "epic", id: "e-alpha" }),
        });
      });
      expect(screen.queryByTestId("side-strip-section-to-review")).toBeNull();
      expect(region.textContent).toBe("Beta needs you");
      expect(spoken.takeRecords()).toEqual([]);

      // Release task's oldest prompt is answered and it still waits on the
      // other: the same task, not an arrival.
      seedPrompts([releasePrompt("approval-second", 4), betaPrompt]);
      expect(
        screen.getByTestId("strip-needs-you-prompt").textContent,
      ).toContain("Release task");
      expect(region.textContent).toBe("Beta needs you");
      expect(spoken.takeRecords()).toEqual([]);
      spoken.disconnect();
    });

    it("announces only a task whose request was made after the list appeared, not one the stores were late to fill in", async () => {
      openEpicTabs(["Alpha", "Gamma", "Zeta"]);
      freezeClock();
      const prompt = (epic: string, title: string, minutesAgo: number) => ({
        id: `approval-${epic}`,
        epicId: `e-${epic}`,
        chatId: `c-${epic}`,
        agentTitle: `${title} agent`,
        taskTitle: title,
        minutesAgo,
      });
      const approval = { ...NO_FLAGS, pendingApproval: true };
      const waiting = (
        epics: ReadonlyArray<string>,
        activeEpic: string,
      ): void => {
        act(() => {
          indicatorState.value = {
            epics: Object.fromEntries(epics.map((epic) => [epic, approval])),
            chats: {},
          };
          // The strip reads its indicators when it renders; a new active tab does.
          useTabsStore.setState({
            activeItemId: tabItemId({ kind: "epic", id: activeEpic }),
          });
        });
      };
      await renderStrip("/elsewhere", LEFT_STRIP);
      const region = screen.getByTestId("strip-needs-you-announcement");
      expect(region.textContent).toBe("");

      // The host's state lands after the list appeared: the session says Gamma
      // waits, then its notification arrives, made four minutes before the
      // list did. The task was waiting already; it is not news.
      waiting(["e-gamma"], "e-zeta");
      seedPrompts([prompt("gamma", "Gamma", 4)]);
      expect(header("needs-you").textContent).toBe("Needs you1");
      expect(region.textContent).toBe("");

      // A minute on, the session says Alpha waits: no request time yet, so
      // nothing is said until its notification lands, made after the list
      // appeared, and then it is.
      vi.setSystemTime(Date.now() + MINUTE_MS);
      waiting(["e-gamma", "e-alpha"], "e-alpha");
      expect(header("needs-you").textContent).toBe("Needs you2");
      expect(region.textContent).toBe("");
      seedPrompts([prompt("gamma", "Gamma", 5), prompt("alpha", "Alpha", 0)]);
      expect(region.textContent).toBe("Alpha needs you");
    });

    it("numbers the Alt-digit badges in the order the sections draw the tabs, and the digit opens that tab", async () => {
      openEpicTabs(["Alpha", "Beta"]);
      isWorking("e-beta", "c-beta");
      const router = buildRouter("/elsewhere", LEFT_STRIP, undefined);
      render(
        <KeybindingProvider router={router}>
          <RouterProvider router={router} />
        </KeybindingProvider>,
      );
      await screen.findByTestId("tab-epic-e-alpha");

      // Beta is drawn first, under Working, though Alpha is first in the strip.
      vi.useFakeTimers();
      try {
        fireEvent.keyDown(window, {
          code: "MetaLeft",
          key: "Meta",
          metaKey: true,
        });
        act(() => {
          vi.advanceTimersByTime(300);
        });
        expect(
          within(screen.getByTestId("tab-epic-e-beta")).getByTestId(
            "tab-digit-1",
          ),
        ).toBeDefined();
        expect(
          within(screen.getByTestId("tab-epic-e-alpha")).getByTestId(
            "tab-digit-2",
          ),
        ).toBeDefined();
      } finally {
        vi.useRealTimers();
      }
      fireEvent.keyUp(window, { code: "MetaLeft", key: "Meta" });

      fireEvent.keyDown(window, { code: "Digit1", key: "1", altKey: true });
      await flushNav();

      expect(router.state.location.pathname).toContain("e-beta");
    });

    it("steps to the next tab in the order the sections draw them", async () => {
      openEpicTabs(["Alpha", "Beta", "Gamma"]);
      isWorking("e-beta", "c-beta");
      useKeybindingStore.setState({
        bindings: { ...getDefaultBindings(), "epic.next": "alt+j" },
      });
      try {
        const router = buildRouter("/elsewhere", LEFT_STRIP, undefined);
        render(
          <KeybindingProvider router={router}>
            <RouterProvider router={router} />
          </KeybindingProvider>,
        );
        await screen.findByTestId("tab-epic-e-alpha");
        // Beta is drawn first, under Working, then Alpha and Gamma under Idle.
        fireEvent.keyDown(window, { code: "Digit1", key: "1", altKey: true });
        await flushNav();
        expect(router.state.location.pathname).toContain("e-beta");

        fireEvent.keyDown(window, { code: "KeyJ", key: "j", altKey: true });
        await flushNav();

        // The row drawn below Beta, where the strip's own order has Gamma.
        expect(router.state.location.pathname).toContain("e-alpha");
      } finally {
        useKeybindingStore.setState({ bindings: getDefaultBindings() });
      }
    });

    describe("the collapsed rail", () => {
      beforeEach(() => {
        useSideTabStripStore.setState({ collapsed: true });
      });

      it("runs the tiles in the sections, a hairline between them and a dot over Needs you, and in the tab order in the Layered view", async () => {
        openSectionedTasks();
        await renderStrip("/elsewhere", LEFT_STRIP);

        expect(listed()).toEqual([
          "side-strip-rail-needs-you-dot",
          "tab-epic-e-gamma",
          "side-strip-rail-section-separator",
          "tab-epic-e-delta",
          "tab-epic-e-epsilon",
          "side-strip-rail-section-separator",
          "tab-epic-e-beta",
          "side-strip-rail-section-separator",
          "tab-epic-e-alpha",
          "tab-epic-e-zeta",
        ]);

        act(() => {
          setSideStripView("layered");
        });

        expect(listed()).toEqual([
          "tab-epic-e-alpha",
          "tab-epic-e-beta",
          "tab-epic-e-gamma",
          "tab-epic-e-delta",
          "tab-epic-e-epsilon",
          "tab-epic-e-zeta",
        ]);
      });

      it("has the digit shortcut and next-tab follow the order the rail draws", async () => {
        openEpicTabs(["Alpha", "Beta", "Gamma"]);
        isWorking("e-beta", "c-beta");
        useKeybindingStore.setState({
          bindings: { ...getDefaultBindings(), "epic.next": "alt+j" },
        });
        try {
          const router = buildRouter("/elsewhere", LEFT_STRIP, undefined);
          render(
            <KeybindingProvider router={router}>
              <RouterProvider router={router} />
            </KeybindingProvider>,
          );
          await screen.findByTestId("tab-epic-e-alpha");
          // Beta is drawn first, under Working, then Alpha and Gamma under Idle.
          fireEvent.keyDown(window, { code: "Digit1", key: "1", altKey: true });
          await flushNav();
          expect(router.state.location.pathname).toContain("e-beta");

          fireEvent.keyDown(window, { code: "KeyJ", key: "j", altKey: true });
          await flushNav();

          expect(router.state.location.pathname).toContain("e-alpha");
        } finally {
          useKeybindingStore.setState({ bindings: getDefaultBindings() });
        }
      });

      it("opens a card on a Needs you or To review tile with the row's second line and the wait, and on the others the card it always had", async () => {
        openSectionedTasks();
        seedPrompts([
          {
            id: "approval-gamma",
            epicId: "e-gamma",
            chatId: "c-gamma",
            agentTitle: "Deploy agent",
            taskTitle: "Gamma",
            minutesAgo: 2,
          },
        ]);
        await renderStrip("/elsewhere", LEFT_STRIP);
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const cardOf = (epic: string): HTMLElement => {
          const tile = screen.getByTestId(`tab-epic-${epic}`);
          fireEvent.pointerEnter(tile, { pointerType: "mouse" });
          fireEvent.mouseEnter(tile);
          act(() => {
            vi.advanceTimersByTime(1000);
          });
          const card = document.querySelector<HTMLElement>(
            '[data-slot="hover-card-content"]',
          );
          if (card === null) throw new Error(`no card opened for ${epic}`);
          return card;
        };
        const secondLine = (card: HTMLElement): string | null =>
          card.querySelector('[data-testid="side-tab-section-detail"]')
            ?.textContent ?? null;
        const close = (epic: string): void => {
          const tile = screen.getByTestId(`tab-epic-${epic}`);
          fireEvent.pointerLeave(tile, { pointerType: "mouse" });
          fireEvent.mouseLeave(tile);
          act(() => {
            vi.advanceTimersByTime(1000);
          });
        };

        const gamma = cardOf("e-gamma");
        expect(gamma.textContent).toContain("Gamma");
        expect(secondLine(gamma)).toBe("Approve · Deploy agent");
        expect(
          gamma.querySelector('[data-testid="side-tab-hover-card-time"]')
            ?.textContent,
        ).toBe("2m");
        close("e-gamma");

        expect(secondLine(cardOf("e-delta"))).toBe("Done · ready to review");
        close("e-delta");
        expect(secondLine(cardOf("e-epsilon"))).toBe("Failed");
        close("e-epsilon");

        // A Working task keeps the card it had: its state and counts.
        const beta = cardOf("e-beta");
        expect(secondLine(beta)).toBeNull();
        expect(
          beta.querySelector('[data-testid="side-tab-hover-card-state"]'),
        ).not.toBeNull();
      });
    });

    it("leaves the Layered view in the user's tab order, under its group headers and its Tasks label", async () => {
      openSectionedTasks();
      setSideStripView("layered");
      await renderStrip("/elsewhere", LEFT_STRIP);

      expect(screen.queryByTestId(/^side-strip-section-/)).toBeNull();
      expect(screen.getByTestId("side-strip-tasks-label")).toBeTruthy();
      expect(
        screen
          .getAllByRole("tab")
          .map((tab) => tab.getAttribute("data-testid")),
      ).toEqual([
        "tab-epic-e-alpha",
        "tab-epic-e-beta",
        "tab-epic-e-gamma",
        "tab-epic-e-delta",
        "tab-epic-e-epsilon",
        "tab-epic-e-zeta",
      ]);
      // One line at today's 32px, with a chip where a section draws a second line.
      expect(screen.queryByTestId("side-tab-section-detail")).toBeNull();
      expect(screen.getByTestId("side-tab-waiting-chip")).toBeTruthy();
      expect(screen.getByTestId("side-tab-failed-chip")).toBeTruthy();
    });

    it("frames the layout editor's sample task as a Needs you row with its agents nested", async () => {
      const real: TabRef = { kind: "epic", id: "e-real" };
      const sample: TabRef = {
        kind: "sample-workspace",
        id: "sample-workspace",
      };
      useEpicCanvasStore
        .getState()
        .seedEpic(real.id, { tabId: real.id, name: "Real task" }, []);
      useTabsStore.setState({
        version: 2,
        items: [real, sample].map((ref) => ({
          kind: "tab",
          id: tabItemId(ref),
          ref,
        })),
        activeItemId: tabItemId(sample),
        stripOrder: [real, sample],
        systemTabs: { history: null, settings: null },
      });
      render(
        <SampleSceneContext.Provider value>
          <RouterProvider
            router={buildRouter("/elsewhere", LEFT_STRIP, undefined)}
          />
        </SampleSceneContext.Provider>,
      );
      await screen.findByTestId("side-tab-strip");

      expect(listed()).toEqual([
        "side-strip-section-needs-you",
        "tab-sample-workspace-sample-workspace",
        "side-strip-section-idle",
        "tab-epic-e-real",
      ]);
      expect(
        within(
          screen.getByTestId("tab-sample-workspace-sample-workspace"),
        ).getByTestId("side-tab-section-detail").textContent,
      ).toBe("Reply · Plan the migration");
      expect(
        within(screen.getByTestId("strip-agent-group"))
          .getAllByRole("button")
          .map((agent) => agent.getAttribute("data-status")),
      ).toEqual(["waiting", "failed", "turn"]);
    });
  });

  describe("the trailing status and the close", () => {
    interface StatusCase {
      readonly name: string;
      /** The host's flags for the task. */
      readonly flags: Partial<typeof NO_FLAGS>;
      /** An unread failure of the task's terminal, which the app records itself. */
      readonly terminalFailure: boolean;
      readonly turn: number;
      readonly background: number;
      readonly generating: boolean;
      readonly shows: string;
    }

    const NONE = {
      flags: {},
      terminalFailure: false,
      turn: 0,
      background: 0,
      generating: false,
    } as const;

    // The spec's table, top row first: what each state shows on an inactive
    // row, and the states that a row above it outranks.
    const STATUS_CASES: ReadonlyArray<StatusCase> = [
      {
        ...NONE,
        name: "1 a reply over an approval",
        flags: { pendingInterview: true, pendingApproval: true },
        shows: "Reply chip",
      },
      {
        ...NONE,
        name: "1 an approval",
        flags: { pendingApproval: true },
        shows: "Approve chip",
      },
      {
        ...NONE,
        name: "1 an approval over an unread failure",
        flags: { unreadFailure: true, pendingApproval: true },
        shows: "Approve chip",
      },
      {
        ...NONE,
        name: "1 an approval over several agents",
        flags: { pendingApproval: true },
        turn: 2,
        shows: "Approve chip",
      },
      {
        ...NONE,
        name: "1 an approval over a pending fork",
        flags: { pendingApproval: true, pendingFork: true },
        shows: "Approve chip",
      },
      {
        ...NONE,
        name: "2 an unread failure",
        flags: { unreadFailure: true },
        shows: "Failed chip",
      },
      {
        ...NONE,
        name: "2 an unread failure over several agents",
        flags: { unreadFailure: true },
        turn: 2,
        shows: "Failed chip",
      },
      {
        ...NONE,
        name: "3 a pending fork over several agents",
        flags: { pendingFork: true },
        turn: 2,
        shows: "fork glyph",
      },
      {
        ...NONE,
        name: "4 several agents",
        turn: 2,
        shows: "meter",
      },
      {
        ...NONE,
        name: "4 a turn and a background agent, over an unread done",
        flags: { unreadDone: true },
        turn: 1,
        background: 1,
        shows: "meter",
      },
      {
        ...NONE,
        name: "5 one agent running a turn",
        turn: 1,
        shows: "running glyph",
      },
      {
        ...NONE,
        name: "5 a running turn over a terminal failure",
        terminalFailure: true,
        turn: 1,
        shows: "running glyph",
      },
      {
        ...NONE,
        name: "6 background work only",
        background: 1,
        shows: "background glyph",
      },
      {
        ...NONE,
        name: "7 an unread done",
        flags: { unreadDone: true },
        shows: "done glyph",
      },
      {
        ...NONE,
        name: "7 an unread done over a terminal failure",
        flags: { unreadDone: true },
        terminalFailure: true,
        shows: "done glyph",
      },
      {
        ...NONE,
        name: "8 a terminal failure",
        terminalFailure: true,
        shows: "failure glyph",
      },
      {
        ...NONE,
        name: "10 a title still generating",
        generating: true,
        shows: "spinner",
      },
      { ...NONE, name: "11 idle, nothing unread", shows: "nothing" },
    ];

    beforeEach(() => {
      setSideStripView("layered");
      openEpicTabs(["Alpha", "Beta"]);
    });

    afterEach(() => {
      __resetAgentActivityStoreForTests();
      useAppLocalNotificationsStore.setState({ byId: {} });
      indicatorState.value = { epics: {}, chats: {} };
      useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
    });

    function setBeta(input: Omit<StatusCase, "name" | "shows">): void {
      indicatorState.value = {
        epics: { "e-beta": { ...NO_FLAGS, ...input.flags } },
        chats: {},
      };
      if (input.terminalFailure) {
        useAppLocalNotificationsStore.setState({
          byId: {
            terminal: {
              id: "terminal",
              updatedAt: 1,
              readAt: null,
              kind: "terminal.closed",
              sourceRef: "terminal",
              payload: { kind: "chat", epicId: "e-beta", chatId: "c-term" },
              message: "Terminal closed",
              detail: null,
              displayedUpdatedAt: null,
            },
          },
        });
      }
      const turn = Array.from(
        { length: input.turn },
        (_, i) => `t${String(i)}`,
      );
      const background = Array.from(
        { length: input.background },
        (_, i) => `b${String(i)}`,
      );
      __setAgentActivityStateForTests(
        { "e-beta": { working: [...turn, ...background], turn } },
        "local",
        "connected",
      );
      if (input.generating) {
        useEpicCanvasStore.getState().markEpicTitlePending("e-beta", "Beta");
      }
    }

    /** What a row's trailing edge shows, apart from its close. */
    function shownBy(row: HTMLElement): string {
      const slot = within(row).getByTestId("side-tab-trailing");
      if (slot.querySelector('[data-testid="side-tab-failed-chip"]')) {
        return "Failed chip";
      }
      const waiting = slot.querySelector(
        '[data-testid="side-tab-waiting-chip"]',
      );
      if (waiting !== null) return `${waiting.textContent} chip`;
      if (slot.querySelector('[data-testid="side-tab-meter"]')) return "meter";
      const glyph = slot.querySelector("[data-status-glyph]");
      if (glyph !== null) {
        return `${glyph.getAttribute("data-status-glyph") ?? ""} glyph`;
      }
      if (slot.querySelector('[data-testid^="header-tab-title-generating"]')) {
        return "spinner";
      }
      return "nothing";
    }

    /** The cell a close button sits in, with whatever yields to it. */
    function closeCellOf(row: HTMLElement): HTMLElement {
      const cell = within(row).getByTestId("tab-close-epic-e-beta")
        .parentElement?.parentElement;
      if (cell === null || cell === undefined) throw new Error("no close cell");
      return cell;
    }

    it.each(STATUS_CASES)("$name: shows $shows", async (row) => {
      setBeta(row);
      await renderStrip("/elsewhere", LEFT_STRIP);

      expect(shownBy(screen.getByTestId("tab-epic-e-beta"))).toBe(row.shows);
    });

    it("has a glyph yield to the close in the one cell it shares, its label still in the row", async () => {
      setBeta({ ...NONE, turn: 1 });
      await renderStrip("/elsewhere", LEFT_STRIP);

      const beta = screen.getByTestId("tab-epic-e-beta");
      const glyph = within(beta).getByRole("status", {
        name: "Task activity in progress",
      });
      expect(closeCellOf(beta).contains(glyph)).toBe(true);
      expect(within(beta).getAllByRole("status")).toContain(glyph);
    });

    it("keeps a chip, with the close joining after it", async () => {
      setBeta({ ...NONE, flags: { pendingApproval: true } });
      await renderStrip("/elsewhere", LEFT_STRIP);

      const beta = screen.getByTestId("tab-epic-e-beta");
      const chip = within(beta).getByTestId("side-tab-waiting-chip");
      const close = within(beta).getByTestId("tab-close-epic-e-beta");
      expect(closeCellOf(beta).contains(chip)).toBe(false);
      expect(chip.compareDocumentPosition(close)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    });

    it("keeps the meter, with the close joining after it", async () => {
      setBeta({ ...NONE, turn: 2 });
      await renderStrip("/elsewhere", LEFT_STRIP);

      const beta = screen.getByTestId("tab-epic-e-beta");
      const meter = within(beta).getByTestId("side-tab-meter");
      expect(closeCellOf(beta).contains(meter)).toBe(false);
      expect(
        meter.compareDocumentPosition(
          within(beta).getByTestId("tab-close-epic-e-beta"),
        ),
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    });

    it("shows the active row's status and its close, the close always revealed", async () => {
      indicatorState.value = {
        epics: { "e-alpha": { ...NO_FLAGS, unreadDone: true } },
        chats: {},
      };
      await renderStrip("/elsewhere", LEFT_STRIP);

      const alpha = screen.getByTestId("tab-epic-e-alpha");
      const done = alpha.querySelector('[data-status-glyph="done"]');
      const close = within(alpha).getByTestId("tab-close-epic-e-alpha");
      expect(done).not.toBeNull();
      expect(close.parentElement?.dataset.revealed).toBe("always");
      expect(close.parentElement?.parentElement?.contains(done)).toBe(false);
    });

    it("gives a rename input the whole row, with no status and no close", async () => {
      setBeta({ ...NONE, flags: { pendingApproval: true } });
      await renderStrip("/elsewhere", LEFT_STRIP);

      fireEvent.contextMenu(screen.getByTestId("tab-epic-e-beta"));
      fireEvent.click(await screen.findByText("Edit Title"));

      const beta = screen.getByTestId("tab-epic-e-beta");
      await within(beta).findByTestId("tab-title-input-epic-e-beta");
      expect(within(beta).queryByTestId("side-tab-trailing")).toBeNull();
      expect(within(beta).queryByTestId("side-tab-waiting-chip")).toBeNull();
      expect(within(beta).queryByTestId("tab-close-epic-e-beta")).toBeNull();
    });
  });

  describe("the joined active row (D3)", () => {
    it("joins the active epic row's own strip edge, regardless of which side the sidebar panel is on", async () => {
      setSidebarSide("right");
      openEpicTabs(["Alpha", "Beta"]);
      await renderStrip("/elsewhere", LEFT_STRIP);

      expect(
        screen
          .getByTestId("tab-epic-e-alpha")
          .getAttribute("data-sheet-joined"),
      ).toBe("left");
      expect(
        screen.getByTestId("tab-epic-e-beta").getAttribute("data-sheet-joined"),
      ).toBeNull();
      // The bridge is styled from its own published state, not from a
      // `:has()` over the joined row: it must be active and name the pane the
      // row joined.
      const bridge = document.querySelector('[data-sheet-join-bridge="left"]');
      expect(bridge?.hasAttribute("data-join-active")).toBe(true);
      expect(bridge?.getAttribute("data-join-pane")).toBe(
        screen.getByTestId("tab-epic-e-alpha").getAttribute("data-join-pane"),
      );
    });

    it("joins on the right edge when the strip is on the right, even with the sidebar on the left", async () => {
      setSidebarSide("left");
      openEpicTabs(["Alpha"]);
      await renderStrip("/elsewhere", { ...LEFT_STRIP, edge: "right" });

      expect(
        screen
          .getByTestId("tab-epic-e-alpha")
          .getAttribute("data-sheet-joined"),
      ).toBe("right");
    });

    it("joins a non-epic active surface too - the join no longer cares about surface kind", async () => {
      setSidebarSide("right");
      openHistoryTab();
      await renderStrip("/elsewhere", LEFT_STRIP);

      const history = screen.getByTestId("tab-history-history");
      expect(history.getAttribute("data-sheet-joined")).toBe("left");
    });

    it("keeps the join on the collapsed tile", async () => {
      setSidebarSide("left");
      openEpicTabs(["Alpha"]);
      useSideTabStripStore.setState({ collapsed: true });
      await renderStrip("/elsewhere", LEFT_STRIP);

      expect(
        screen
          .getByTestId("tab-epic-e-alpha")
          .getAttribute("data-sheet-joined"),
      ).toBe("left");
    });

    it("joins the split pair container, on its strip-side epic member, and never a member row", async () => {
      setSidebarSide("right");
      openSplitPair("left");
      await renderStrip("/elsewhere", LEFT_STRIP);

      const pair = screen.getByTestId("split-tab-group-split-a");
      expect(pair.getAttribute("data-sheet-joined")).toBe("left");
      expect(
        screen
          .getByTestId("tab-epic-e-alpha")
          .getAttribute("data-sheet-joined"),
      ).toBeNull();
      expect(
        screen.getByTestId("tab-epic-e-beta").getAttribute("data-sheet-joined"),
      ).toBeNull();
      // The pair publishes for the strip's one bridge, not each member.
      expect(
        document
          .querySelector('[data-sheet-join-bridge="left"]')
          ?.hasAttribute("data-join-active"),
      ).toBe(true);
    });

    it("clears the bridge when no tab is active (activeItemId null)", async () => {
      setSidebarSide("right");
      openEpicTabs(["Alpha"]);
      await renderStrip("/elsewhere", LEFT_STRIP);
      const bridge = document.querySelector('[data-sheet-join-bridge="left"]');
      expect(bridge?.hasAttribute("data-join-active")).toBe(true);

      act(() => {
        useTabsStore.setState({ activeItemId: null });
      });

      expect(bridge?.hasAttribute("data-join-active")).toBe(false);
      expect(bridge?.hasAttribute("data-join-pane")).toBe(false);
    });

    // A pair joins as one unit but takes its FILL from one member: the one on
    // the strip's own edge (`memberTab(item[edge])`), because that is the
    // member whose sheet borders the strip. The retired sheet-join browser
    // driver walked this per split variant; which pane a pair meets is
    // decided here.
    describe("the split pair's pane (D3)", () => {
      const pairPane = (): string | null =>
        screen
          .getByTestId("split-tab-group-split-a")
          .getAttribute("data-join-pane");
      const collapse = (tabId: string): void => {
        act(() => {
          useLeftPanelStore.setState({
            mainCollapsedByTabId: { [tabId]: true },
          });
        });
      };
      afterEach(() => {
        act(() => {
          useLeftPanelStore.setState({ mainCollapsedByTabId: {} });
        });
      });

      it("meets the sidebar panel when the panel is on the strip's own edge, and its rail once that panel collapses", async () => {
        setSidebarSide("left");
        openSplitPair("left");
        await renderStrip("/elsewhere", LEFT_STRIP);

        expect(pairPane()).toBe("panel");
        collapse("e-alpha");
        expect(pairPane()).toBe("rail");
      });

      it("meets the canvas when the sidebar is on the far edge", async () => {
        setSidebarSide("right");
        openSplitPair("left");
        await renderStrip("/elsewhere", LEFT_STRIP);

        expect(pairPane()).toBe("canvas");
        collapse("e-alpha");
        expect(pairPane()).toBe("canvas");
      });

      it("reads the member on the RIGHT strip's edge, not the left one, whichever half is focused", async () => {
        setSidebarSide("right");
        openSplitPair("left");
        await renderStrip("/elsewhere", { ...LEFT_STRIP, edge: "right" });

        // The left member's panel state must not move a pair on the right edge.
        collapse("e-alpha");
        expect(pairPane()).toBe("panel");
        collapse("e-beta");
        expect(pairPane()).toBe("rail");
      });
    });
  });

  describe("New Task and the collapsed rail (F1, F7)", () => {
    const precedes = (a: HTMLElement, b: HTMLElement): boolean =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

    it("orders the rail: toggle, inbox, all tasks, new task, divider, home", async () => {
      setHomeTabEnabled(true);
      useSideTabStripStore.setState({ collapsed: true });
      await renderStrip("/", LEFT_STRIP);

      const toggle = screen.getByTestId("side-tab-strip-collapse");
      const inbox = screen.getByTestId("side-strip-inbox");
      const allTasks = screen.getByTestId("side-strip-all-tasks");
      const newTask = screen.getByTestId("side-strip-new-task");
      const divider = screen.getByTestId("side-strip-rail-divider");
      const home = screen.getByTestId("tab-home");

      expect(precedes(toggle, inbox)).toBe(true);
      expect(precedes(inbox, allTasks)).toBe(true);
      expect(precedes(allTasks, newTask)).toBe(true);
      expect(precedes(newTask, divider)).toBe(true);
      expect(precedes(divider, home)).toBe(true);
    });

    it("shows the rail divider even when Home is not drawn", async () => {
      setHomeTabEnabled(false);
      useSideTabStripStore.setState({ collapsed: true });
      await renderStrip("/", LEFT_STRIP);

      expect(screen.getByTestId("side-strip-rail-divider")).toBeDefined();
      expect(screen.queryByTestId("tab-home")).toBeNull();
    });

    it('gives the collapsed New Task tile an aria-label of "New Task"', async () => {
      useSideTabStripStore.setState({ collapsed: true });
      await renderStrip("/", LEFT_STRIP);

      expect(
        screen.getByTestId("side-strip-new-task").getAttribute("aria-label"),
      ).toBe("New Task");
    });

    it("orders the expanded rows: all tasks, home, new task, tasks label - never inside the title row", async () => {
      setHomeTabEnabled(true);
      await renderStrip("/", { ...LEFT_STRIP, ownsTitleBar: true });

      const allTasks = screen.getByTestId("side-strip-all-tasks");
      const home = screen.getByTestId("tab-home");
      const newTask = screen.getByTestId("side-strip-new-task");
      const tasksLabel = screen.getByTestId("side-strip-tasks-label");
      const titleRow = screen.getByTestId("side-strip-title-row");

      expect(precedes(allTasks, home)).toBe(true);
      expect(precedes(home, newTask)).toBe(true);
      expect(precedes(newTask, tasksLabel)).toBe(true);
      expect(titleRow.contains(newTask)).toBe(false);
    });

    it("draws no history-nav arrows in the collapsed rail, even with a real history stack", async () => {
      useSideTabStripStore.setState({ collapsed: true });
      const router = buildRouter(
        "/",
        LEFT_STRIP,
        createPersistentMemoryHistory(
          "/",
          "side-tab-strip-rail-history-nav-collapsed",
        ),
      );
      render(<RouterProvider router={router} />);
      await screen.findByTestId("side-tab-strip");

      expect(screen.queryByTestId("history-nav-back")).toBeNull();
      expect(screen.queryByTestId("history-nav-forward")).toBeNull();
      cleanup();

      // Sanity: the same kind of available history DOES draw the arrows once
      // expanded, so the absence above is a real one and not an artifact of
      // history availability in this harness.
      useSideTabStripStore.setState({ collapsed: false });
      const expandedRouter = buildRouter(
        "/",
        LEFT_STRIP,
        createPersistentMemoryHistory(
          "/",
          "side-tab-strip-rail-history-nav-expanded",
        ),
      );
      render(<RouterProvider router={expandedRouter} />);
      await screen.findByTestId("side-tab-strip");
      expect(screen.getByTestId("history-nav-back")).toBeDefined();
    });

    it.each([
      { collapsed: false, label: "expanded" },
      { collapsed: true, label: "collapsed" },
    ])(
      "$label: clicking New Task opens a new draft tab",
      async ({ collapsed }) => {
        useSideTabStripStore.setState({ collapsed });
        const router = buildRouter("/", LEFT_STRIP, undefined);
        render(<RouterProvider router={router} />);
        await screen.findByTestId("side-strip-new-task");

        fireEvent.click(screen.getByTestId("side-strip-new-task"));
        await flushNav();

        expect(router.state.location.pathname).toMatch(/^\/draft\//);
      },
    );
  });

  describe("the resize handle drags the live collapsed layout (F9)", () => {
    const RESIZE_POINTER_ID = 41;
    const DRAG_ANCHOR_X = 500;
    const START_WIDTH = 240; // matches resetStores' default widthPx
    /** Comfortably on either side of the snap point, and past the minimum. */
    const UNDER_SNAP_WIDTH = SIDE_STRIP_SNAP_TO_RAIL_BELOW_PX - 26;
    const OVER_SNAP_WIDTH = SIDE_STRIP_SNAP_TO_RAIL_BELOW_PX + 174;

    /** The strip's own rect, tracking whatever width it is currently drawn at. */
    function stubStripRect(strip: HTMLElement): void {
      vi.spyOn(strip, "getBoundingClientRect").mockImplementation(() => {
        const width = Number.parseFloat(strip.style.width);
        return new DOMRect(0, 0, Number.isNaN(width) ? 0 : width, 800);
      });
    }

    function downHandle(handle: HTMLElement, atX: number): void {
      fireEvent(
        handle,
        pointerEvent("pointerdown", {
          pointerId: RESIZE_POINTER_ID,
          clientX: atX,
          clientY: 10,
          button: 0,
        }),
      );
    }
    /** Moves the pointer so the strip previews `targetWidth`, from `fromWidth`. */
    function moveTo(
      handle: HTMLElement,
      fromWidth: number,
      targetWidth: number,
    ): void {
      fireEvent(
        handle,
        pointerEvent("pointermove", {
          pointerId: RESIZE_POINTER_ID,
          clientX: DRAG_ANCHOR_X + (targetWidth - fromWidth),
          clientY: 10,
          button: 0,
        }),
      );
    }
    function releaseHandle(handle: HTMLElement): void {
      fireEvent(
        handle,
        pointerEvent("pointerup", {
          pointerId: RESIZE_POINTER_ID,
          clientX: 0,
          clientY: 10,
          button: 0,
        }),
      );
    }
    function cancelHandle(handle: HTMLElement): void {
      fireEvent(
        handle,
        pointerEvent("pointercancel", {
          pointerId: RESIZE_POINTER_ID,
          clientX: 0,
          clientY: 10,
          button: 0,
        }),
      );
    }

    /** `moveTo`, mirrored for a right-edge strip (its drag delta is negated). */
    function crossTo(
      handle: HTMLElement,
      edge: EdgeSide,
      fromWidth: number,
      targetWidth: number,
    ): void {
      if (edge === "right") moveTo(handle, targetWidth, fromWidth);
      else moveTo(handle, fromWidth, targetWidth);
    }

    describe("width easing on a crossing (L-165)", () => {
      it.each([{ edge: "left" as const }, { edge: "right" as const }])(
        "eases only the frames that cross the snap point, either direction ($edge)",
        async ({ edge }) => {
          motion.enabled = true;
          const easingClass = "transition-[width]";
          const strip = await renderStrip("/", { ...LEFT_STRIP, edge });
          stubStripRect(strip);
          const handle = screen.getByTestId("side-tab-strip-resize-handle");

          downHandle(handle, DRAG_ANCHOR_X);
          expect(strip.className).not.toContain(easingClass);

          // Stays on the expanded side: no crossing, no ease.
          crossTo(handle, edge, START_WIDTH, START_WIDTH - 20);
          expect(strip.className).not.toContain(easingClass);

          // Crosses under the snap point: this frame eases.
          crossTo(handle, edge, START_WIDTH, UNDER_SNAP_WIDTH);
          expect(strip.getAttribute("data-collapsed")).toBe("true");
          expect(strip.className).toContain(easingClass);

          // Crossing back over the snap point, in the same drag, eases too.
          crossTo(handle, edge, START_WIDTH, OVER_SNAP_WIDTH);
          expect(strip.getAttribute("data-collapsed")).toBe("false");
          expect(strip.className).toContain(easingClass);

          releaseHandle(handle);
          expect(strip.className).not.toContain(easingClass);
        },
      );

      it("leaves no easing class after a cancelled crossing, and a drag's start stops the toggle's running ease", async () => {
        motion.enabled = true;
        const easingClass = "transition-[width]";
        const strip = await renderStrip("/", LEFT_STRIP);
        stubStripRect(strip);
        const handle = screen.getByTestId("side-tab-strip-resize-handle");

        downHandle(handle, DRAG_ANCHOR_X);
        moveTo(handle, START_WIDTH, UNDER_SNAP_WIDTH);
        expect(strip.className).toContain(easingClass);

        cancelHandle(handle);
        expect(strip.className).not.toContain(easingClass);

        // The collapse toggle's ease is still running when a drag starts:
        // the pickup lands instantly rather than easing toward the pointer.
        fireEvent.click(screen.getByTestId("side-tab-strip-collapse"));
        expect(strip.className).toContain(easingClass);
        const resting = screen.getByTestId("side-tab-strip-resize-handle");
        downHandle(resting, DRAG_ANCHOR_X);
        expect(strip.className).not.toContain(easingClass);
        cancelHandle(resting);
      });
    });

    it("draws the live collapsed rail once a drag crosses under the snap point, before anything is stored", async () => {
      const strip = await renderStrip("/", LEFT_STRIP);
      stubStripRect(strip);
      const handle = screen.getByTestId("side-tab-strip-resize-handle");
      expect(screen.queryByTestId("side-strip-rail-divider")).toBeNull();

      downHandle(handle, DRAG_ANCHOR_X);
      moveTo(handle, START_WIDTH, UNDER_SNAP_WIDTH);

      expect(strip.getAttribute("data-collapsed")).toBe("true");
      expect(screen.getByTestId("side-strip-rail-divider")).toBeDefined();
      // Held below the snap point, the rail's own width is drawn flat -
      // never the tracked pointer position.
      expect(strip.style.width).toBe(`${SIDE_STRIP_RAIL_WIDTH_PX}px`);
      expect(useSideTabStripStore.getState()).toMatchObject({
        collapsed: false,
        dragCollapsed: true,
      });

      releaseHandle(handle);
    });

    it("returns to the expanded layout once the drag re-crosses back over the snap point", async () => {
      const strip = await renderStrip("/", LEFT_STRIP);
      stubStripRect(strip);
      const handle = screen.getByTestId("side-tab-strip-resize-handle");

      downHandle(handle, DRAG_ANCHOR_X);
      moveTo(handle, START_WIDTH, UNDER_SNAP_WIDTH);
      expect(strip.getAttribute("data-collapsed")).toBe("true");

      moveTo(handle, START_WIDTH, OVER_SNAP_WIDTH);

      expect(strip.getAttribute("data-collapsed")).toBe("false");
      expect(screen.queryByTestId("side-strip-rail-divider")).toBeNull();
      // Above the snap point, the width tracks the pointer again (at least
      // the minimum), not the rail's flat width.
      expect(strip.style.width).toBe(`${OVER_SNAP_WIDTH}px`);
      expect(useSideTabStripStore.getState().dragCollapsed).toBeNull();

      releaseHandle(handle);
      expect(useSideTabStripStore.getState()).toMatchObject({
        collapsed: false,
        widthPx: OVER_SNAP_WIDTH,
      });
    });

    it("commits the rail on release under the snap point, keeping the stored width", async () => {
      const strip = await renderStrip("/", LEFT_STRIP);
      stubStripRect(strip);
      const handle = screen.getByTestId("side-tab-strip-resize-handle");

      downHandle(handle, DRAG_ANCHOR_X);
      moveTo(handle, START_WIDTH, UNDER_SNAP_WIDTH);
      releaseHandle(handle);

      expect(useSideTabStripStore.getState()).toMatchObject({
        collapsed: true,
        dragCollapsed: null,
        widthPx: START_WIDTH,
      });
      // Settled explicitly to the rail width (F9): after a crossing React may
      // not rewrite an inline value it already rendered.
      expect(strip.style.width).toBe(`${SIDE_STRIP_RAIL_WIDTH_PX}px`);
    });

    it("expands from the rail once a drag out passes the snap point, and stores the width", async () => {
      useSideTabStripStore.setState({ collapsed: true });
      const strip = await renderStrip("/", LEFT_STRIP);
      stubStripRect(strip);
      const handle = screen.getByTestId("side-tab-strip-resize-handle");
      const fromWidth = SIDE_STRIP_RAIL_WIDTH_PX;

      downHandle(handle, DRAG_ANCHOR_X);
      moveTo(handle, fromWidth, OVER_SNAP_WIDTH);
      releaseHandle(handle);

      expect(useSideTabStripStore.getState()).toMatchObject({
        collapsed: false,
        dragCollapsed: null,
        widthPx: OVER_SNAP_WIDTH,
      });
    });

    it("pointercancel mid-drag after a crossing restores the starting layout and stores nothing", async () => {
      const strip = await renderStrip("/", LEFT_STRIP);
      stubStripRect(strip);
      const handle = screen.getByTestId("side-tab-strip-resize-handle");

      downHandle(handle, DRAG_ANCHOR_X);
      moveTo(handle, START_WIDTH, UNDER_SNAP_WIDTH);
      expect(strip.getAttribute("data-collapsed")).toBe("true");

      cancelHandle(handle);

      expect(strip.getAttribute("data-collapsed")).toBe("false");
      expect(strip.style.width).toBe(`${START_WIDTH}px`);
      expect(useSideTabStripStore.getState()).toMatchObject({
        collapsed: false,
        dragCollapsed: null,
        widthPx: START_WIDTH,
      });
    });

    it("blur mid-drag after a crossing restores the starting layout and stores nothing", async () => {
      const strip = await renderStrip("/", LEFT_STRIP);
      stubStripRect(strip);
      const handle = screen.getByTestId("side-tab-strip-resize-handle");

      downHandle(handle, DRAG_ANCHOR_X);
      moveTo(handle, START_WIDTH, UNDER_SNAP_WIDTH);
      expect(strip.getAttribute("data-collapsed")).toBe("true");

      fireEvent(window, new Event("blur"));

      expect(strip.getAttribute("data-collapsed")).toBe("false");
      expect(strip.style.width).toBe(`${START_WIDTH}px`);
      expect(useSideTabStripStore.getState()).toMatchObject({
        collapsed: false,
        dragCollapsed: null,
        widthPx: START_WIDTH,
      });
    });
  });
});

/** The nav's own width transition finishing, as the browser reports it. */
function endWidthTransition(strip: HTMLElement): void {
  const event = createEvent.transitionEnd(strip);
  Object.defineProperty(event, "propertyName", { value: "width" });
  fireEvent(strip, event);
}
