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
import type { SurfaceNotificationIndicators } from "@/stores/notifications/notification-indicator-state";
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
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
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
      if (realRect !== undefined) {
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

  it("renders a split as one joined pair, left member first, with no quick actions", async () => {
    openSplitPair("left");
    await renderStrip("/elsewhere", LEFT_STRIP);

    const pair = screen.getByTestId("split-tab-group-split-a");
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
    expect(screen.queryByTestId("split-quick-actions-split-a")).toBeNull();
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
    const NO_FLAGS = {
      pendingApproval: false,
      pendingInterview: false,
      pendingFork: false,
      unreadFailure: false,
      unreadDone: false,
    };

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

    function seedApproval(epicId: string): void {
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
        chatId: "chat-cold",
        payload: {
          kind: "approval",
          epicId,
          chatId: "chat-cold",
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

    it("gives a cold task no chevron, only its needs-you row, opened through the notification's activation", async () => {
      openEpicTabs(["Alpha"]);
      seedApproval("e-alpha");
      busy("e-alpha", ["agent-1"]);
      await renderStrip("/elsewhere", LEFT_STRIP);

      const row = screen.getByTestId("tab-epic-e-alpha");
      expect(within(row).queryByTestId("side-tab-disclosure")).toBeNull();
      expect(row.hasAttribute("aria-expanded")).toBe(false);
      const group = screen.getByTestId("strip-agent-group");
      expect(agentIds(group)).toEqual(["strip-agent-host:approval-0"]);
      const needsYou = within(group).getByTestId("strip-agent-host:approval-0");
      expect(needsYou.getAttribute("data-status")).toBe("waiting");

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

    it("nests each busy half of a split pair right under its own row, inside the pair's fill and either side of the seam", async () => {
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
      const seam = within(pair).getByTestId("side-split-row-pair-seam");
      const leftAgent = within(pair).getByTestId("strip-agent-s-left");
      const rightAgent = within(pair).getByTestId("strip-agent-s-right");
      expect(
        leftAgent.closest('[role="group"]')?.getAttribute("aria-labelledby"),
      ).toBe(leftRow.id);
      expect(
        rightAgent.closest('[role="group"]')?.getAttribute("aria-labelledby"),
      ).toBe(rightRow.id);
      const follows = (a: HTMLElement, b: HTMLElement): boolean =>
        (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      expect(follows(leftRow, leftAgent)).toBe(true);
      expect(follows(leftAgent, seam)).toBe(true);
      expect(follows(seam, rightRow)).toBe(true);
      expect(follows(rightRow, rightAgent)).toBe(true);
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

  it("counts, lines and folds a group holding a tab and a split", async () => {
    openGroupWithTabAndSplit();
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

    const header = screen.getByTestId("side-tab-group-header-g");
    expect(header.textContent).toContain("Work");
    expect(within(header).getByTestId("side-tab-group-count").textContent).toBe(
      "3",
    );
    for (const id of ["e-one", "e-two", "e-three"]) {
      expect(
        within(screen.getByTestId(`tab-epic-${id}`)).queryByTestId(
          "side-tab-group-line",
        ),
      ).not.toBeNull();
    }
    expect(
      within(screen.getByTestId("tab-epic-e-four")).queryByTestId(
        "side-tab-group-line",
      ),
    ).toBeNull();
    expect(screen.queryByTestId("side-tab-group-badge")).toBeNull();

    fireEvent.click(header);

    for (const id of ["e-one", "e-two", "e-three"]) {
      expect(screen.queryByTestId(`tab-epic-${id}`)).toBeNull();
    }
    expect(screen.getByTestId("tab-epic-e-four")).toBeDefined();
    expect(screen.getByTestId("side-tab-group-header-g")).toBeDefined();
    expect(
      screen.getByTestId("side-tab-group-badge").getAttribute("data-kind"),
    ).toBe("approval");
  });

  describe("the leading slot's glyph presentation (D12, finding 4)", () => {
    it("shows the shared approval glyph on an uncoloured row, not the message warning bubble", async () => {
      openEpicTabs(["Alpha"]);
      indicatorState.value = {
        epics: {
          "e-alpha": {
            unreadFailure: false,
            unreadDone: false,
            pendingApproval: true,
            pendingInterview: false,
            pendingFork: false,
          },
        },
        chats: {},
      };
      await renderStrip("/elsewhere", LEFT_STRIP);

      const row = screen.getByTestId("tab-epic-e-alpha");
      const leading = within(row).getByTestId("side-tab-leading");
      expect(leading.getAttribute("data-leading")).toBe("glyph");
      expect(
        leading.querySelector('[data-status-glyph="approval"]'),
      ).not.toBeNull();
    });

    it("shows the done glyph for an unread completion", async () => {
      openEpicTabs(["Alpha"]);
      indicatorState.value = {
        epics: {
          "e-alpha": {
            unreadFailure: false,
            unreadDone: true,
            pendingApproval: false,
            pendingInterview: false,
            pendingFork: false,
          },
        },
        chats: {},
      };
      await renderStrip("/elsewhere", LEFT_STRIP);

      const row = screen.getByTestId("tab-epic-e-alpha");
      const leading = within(row).getByTestId("side-tab-leading");
      expect(
        leading.querySelector('[data-status-glyph="done"]'),
      ).not.toBeNull();
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
