/**
 * D7 (overlay placement): the real `SideTabStrip` provides `ColumnEdgeContext`
 * with its own edge, and the strip's real Notifications drawer (`SideStripNavRows`,
 * top block) and real `UserMenu` (foot's account row) must actually read it
 * through that boundary - a context wired at the wrong layer would still pass
 * a unit test on the hook alone. Everything else in the strip (rows, keybinding
 * registration, indicator batching) is `side-tab-strip.test.tsx`'s concern and
 * is stubbed here exactly as it is there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import type { IHostMessenger } from "@traycer-clients/shared/host-transport/host-messenger";
import { SideTabStrip } from "@/components/layout/tabs/side-strip/side-tab-strip";
import {
  HeaderIdentity,
  HeaderNotificationsBell,
} from "@/components/layout/header/header-actions";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  hostRpcRegistry,
  HostRuntimeProvider,
  type HostRpcRegistry,
} from "@/lib/host";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import { installTabSyncCoordinator } from "@/lib/tab-sync/tab-sync-coordinator";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { WindowsBridgeContext } from "@/providers/windows-bridge-context";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import { useSideTabStripStore } from "@/stores/layout/side-tab-strip-store";
import { useTitleBarDragStore } from "@/stores/layout/title-bar-drag-store";
import { __resetAppLocalNotificationsStoreForTests } from "@/stores/notifications/app-local-notifications-store";
import { __resetHostNotificationsStoreForTests } from "@/stores/notifications/host-notifications-store";
import { __resetNotificationsStoreForTests } from "@/stores/notifications/notifications-store";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";
import { tabItemId } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";

// Same host-resolution seam `notifications-bell.test.tsx` stubs: the bell
// resolves its host through these two hooks, not through the app-wide active
// host, and this suite only needs a host to exist, never its live data.
type HostDirectoryLookup = {
  readonly findById: (hostId: string) => typeof mockLocalHostEntry | null;
};

const activeHostIdRef = vi.hoisted((): { value: string | null } => ({
  value: null,
}));
const directoryRef = vi.hoisted((): { value: HostDirectoryLookup | null } => ({
  value: null,
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => activeHostIdRef.value,
}));
vi.mock("@/hooks/notifications/use-notification-host", () => ({
  useNotificationResolveHostId: () => activeHostIdRef.value,
  useNotificationResolveHost: () => ({
    hostId: activeHostIdRef.value,
    client: null,
  }),
}));
vi.mock("@/hooks/host/use-host-directory-entry", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/host/use-host-directory-entry")
    >();
  return {
    ...actual,
    useHostDirectoryEntry: (hostId: string | null) => {
      if (
        hostId === null ||
        hostId.length === 0 ||
        directoryRef.value === null
      ) {
        return null;
      }
      return directoryRef.value.findById(hostId);
    },
  };
});

// The strip's own indicator/pin/keybinding plumbing, mocked exactly as
// `side-tab-strip.test.tsx` mocks it - unrelated to overlay placement, but
// still on the strip's real render path with no tabs open.
vi.mock("@/hooks/notifications/use-host-notification-indicators-query", () => ({
  useHostNotificationIndicators: () => ({
    data: { epics: {}, chats: {} },
    isPending: false,
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(),
  }),
}));
vi.mock(
  "@/hooks/notifications/use-notification-indicators-query",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/notifications/use-notification-indicators-query")
      >();
    return {
      ...actual,
      useNotificationIndicators: () => ({ epics: {}, chats: {} }),
    };
  },
);
vi.mock(
  "@/hooks/epic/use-epic-task-pinned-states-query",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/epic/use-epic-task-pinned-states-query")
      >();
    return {
      ...actual,
      useEpicTaskPinnedStates: () => new Map(),
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
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
vi.mock("@/hooks/epic/use-epic-pin-local-home-support", () => ({
  useEpicPinLocalHomeSupported: () => false,
}));
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => ({ getActiveHostId: () => "host-a" }),
  };
});
vi.mock("@/hooks/epic/use-epic-activity-status", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/epic/use-epic-activity-status")
    >();
  return { ...actual, useEpicWaitingReason: () => null };
});
vi.mock("@/lib/epic-selectors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/epic-selectors")>();
  return {
    ...actual,
    useRegisteredEpicPermissionRole: () => "owner",
    useRegisteredEpicLocalHome: () => true,
  };
});

vi.mock("@/components/layout/header/app-update-button", () => ({
  AppUpdateHeaderButton: () => <span data-testid="foot-update" />,
}));
vi.mock("@/components/layout/header/history-button", () => ({
  HistoryButton: () => <span data-testid="foot-history" />,
}));

installTabSyncCoordinator({ readyPromise: Promise.resolve() });

function createRunnerHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://example.com",
    authnBaseUrl: "https://auth.example.com",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

function makeMessengerFactory(): (args: {
  registry: HostRpcRegistry;
}) => IHostMessenger<HostRpcRegistry> {
  return (args) =>
    new MockHostMessenger<HostRpcRegistry>({
      registry: args.registry,
      requestId: () => "req-1",
      handlers: {
        "host.status": () =>
          Promise.resolve({
            ready: true,
            hostVersion: "1.2.3",
            protocolVersion: { major: 1, minor: 0 },
            busy: false,
            busySessionCount: 0,
            updateProgress: null,
            busyBreakdown: null,
            updateOperation: null,
            updateTransaction: null,
            storeFormats: null,
            install: null,
          }),
      },
    });
}

/** The harness both scenarios below share: a runner host, host runtime, query
 * client and router, none of which this suite is about. */
function renderHarness(tree: ReactNode): void {
  const runnerHost = createRunnerHost();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <HostRuntimeProvider
            registry={hostRpcRegistry}
            messengerFactory={makeMessengerFactory()}
            invalidator={null}
            requestId={null}
            remoteFetcher={() =>
              Promise.resolve({ kind: "hosts", entries: [] })
            }
            fallback={<div data-testid="runtime-fallback">…</div>}
          >
            <TooltipProvider>{tree}</TooltipProvider>
          </HostRuntimeProvider>
        </RunnerHostProvider>
      </QueryClientProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
}

function resetSharedState(): void {
  __resetTabNavigationControllerForTesting();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  useSideTabStripStore.setState({ widthPx: 240, collapsed: false });
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
  useLayoutStore.getState().setRegionValues("homeTab", { shown: "hidden" });
  useTitleBarDragStore.setState({ suppressors: new Set() });
  useNotificationsPopoverStore.getState().setOpen(false);
  __resetNotificationsStoreForTests();
  __resetHostNotificationsStoreForTests();
  __resetAppLocalNotificationsStoreForTests();
  window.localStorage.clear();
  activeHostIdRef.value = mockLocalHostEntry.hostId;
  directoryRef.value = {
    findById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
  };
}

function signIn(): void {
  useAuthStore.getState().setSignedIn(
    {
      userId: "test-user",
      userName: "Ada Lovelace",
      email: "ada@example.com",
    },
    { userId: "test-user", username: "Ada Lovelace" },
    [],
  );
}

/** The Radix Content node that owns the `data-side`/`data-align` Popper wrote. */
function popoverContentFor(surfaceTestId: string): HTMLElement {
  const surface = screen.getByTestId(surfaceTestId);
  const content = surface.closest<HTMLElement>('[data-slot="popover-content"]');
  if (content === null)
    throw new Error(`expected popover content around ${surfaceTestId}`);
  return content;
}

describe("<SideTabStrip /> real overlay placement, right edge (D7)", () => {
  beforeEach(() => {
    resetSharedState();
    signIn();
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    resetSharedState();
  });

  it("opens the Inbox drawer and the user menu toward the content (side=left, align=start/end)", async () => {
    renderHarness(
      <WindowsBridgeContext.Provider
        value={{ bridge: null, hasHydrated: true }}
      >
        <SideTabStrip edge="right" ownsTitleBar={false} />
      </WindowsBridgeContext.Provider>,
    );
    await screen.findByTestId("side-tab-strip");

    // Each click re-queries the trigger: while the popover is open,
    // `TooltipWrapper` drops to a transparent `Slot.Root` (its `label` goes
    // `null`) at the same tree position as the `Tooltip` it replaces, so React
    // unmounts and remounts the button - a captured reference before the open
    // click is detached by the time this closes it.
    fireEvent.pointerDown(screen.getByTestId("side-strip-inbox"));
    fireEvent.click(screen.getByTestId("side-strip-inbox"));
    await screen.findByTestId("notifications-popover");
    // The drawer shares the same open state the bell reads elsewhere.
    expect(useNotificationsPopoverStore.getState().open).toBe(true);
    const drawer = screen.getByTestId("side-strip-inbox-drawer");
    expect(drawer.getAttribute("data-side")).toBe("left");
    expect(drawer.getAttribute("data-align")).toBe("start");

    fireEvent.click(screen.getByTestId("side-strip-inbox"));
    await waitFor(() => {
      expect(screen.queryByTestId("notifications-popover")).toBeNull();
    });
    expect(useNotificationsPopoverStore.getState().open).toBe(false);

    const userTrigger = screen.getByTestId("user-menu-trigger");
    // The account row's trigger is a custom Radix trigger: it opens on Radix's
    // own pointerdown, not a plain click (see `user-menu.test.tsx`).
    fireEvent.pointerDown(userTrigger, { button: 0, ctrlKey: false });
    const menu = await screen.findByTestId("user-menu-content");
    expect(menu.getAttribute("data-side")).toBe("left");
    expect(menu.getAttribute("data-align")).toBe("end");
  });

  it("opens the Inbox drawer toward the content on the opposite edge (side=right, align=start)", async () => {
    renderHarness(
      <WindowsBridgeContext.Provider
        value={{ bridge: null, hasHydrated: true }}
      >
        <SideTabStrip edge="left" ownsTitleBar={false} />
      </WindowsBridgeContext.Provider>,
    );
    await screen.findByTestId("side-tab-strip");

    fireEvent.pointerDown(screen.getByTestId("side-strip-inbox"));
    fireEvent.click(screen.getByTestId("side-strip-inbox"));
    await screen.findByTestId("notifications-popover");
    const drawer = screen.getByTestId("side-strip-inbox-drawer");
    expect(drawer.getAttribute("data-side")).toBe("right");
    expect(drawer.getAttribute("data-align")).toBe("start");
  });
});

const ALPHA: TabRef = { kind: "epic", id: "e-alpha" };

/** One open task, so the strip has a real row to hover. */
function openAlphaTab(): void {
  useEpicCanvasStore
    .getState()
    .seedEpic(ALPHA.id, { tabId: ALPHA.id, name: "Alpha" }, []);
  useTabsStore.setState({
    version: 2,
    items: [{ kind: "tab", id: tabItemId(ALPHA), ref: ALPHA }],
    activeItemId: tabItemId(ALPHA),
    stripOrder: [ALPHA],
    systemTabs: { history: null, settings: null },
  });
}

/** A real mouse hover: Floating UI's open delay rides on the native
 * `mouseenter` and gates on the pointer type the React `onPointerEnter`
 * records just before it, so both fire, in this order. */
function hoverIn(trigger: HTMLElement): void {
  fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
  fireEvent.mouseEnter(trigger);
}

describe("<SideTabStrip /> the sides its overlays open on, per edge (D7)", () => {
  beforeEach(() => {
    resetSharedState();
    signIn();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useAuthStore.getState().setSignedOut();
    resetSharedState();
  });

  it.each([
    { edge: "left", side: "right" },
    { edge: "right", side: "left" },
  ] as const)(
    "opens a task row's hover card toward the content: side=$side on the $edge strip",
    async ({ edge, side }) => {
      openAlphaTab();
      renderHarness(
        <WindowsBridgeContext.Provider
          value={{ bridge: null, hasHydrated: true }}
        >
          <SideTabStrip edge={edge} ownsTitleBar={false} />
        </WindowsBridgeContext.Provider>,
      );
      const row = await screen.findByTestId("tab-epic-e-alpha");
      // After the strip has mounted on real timers: the card's open delay is
      // the only clock this test needs to drive.
      vi.useFakeTimers({ shouldAdvanceTime: true });
      expect(screen.queryByTestId("side-tab-hover-card")).toBeNull();

      hoverIn(row);
      act(() => {
        vi.advanceTimersByTime(1000);
      });

      // The row's own card, read off the real strip: the edge it took its side
      // from is the one `SideTabStrip` provided, not one this test wrote.
      const card = screen.getByTestId("side-tab-hover-card");
      expect(card.getAttribute("data-side")).toBe(side);
      expect(card.getAttribute("data-align")).toBe("start");
    },
  );

  it("opens the user menu toward the content on the left strip (side=right, align=end)", async () => {
    renderHarness(
      <WindowsBridgeContext.Provider
        value={{ bridge: null, hasHydrated: true }}
      >
        <SideTabStrip edge="left" ownsTitleBar={false} />
      </WindowsBridgeContext.Provider>,
    );
    await screen.findByTestId("side-tab-strip");

    fireEvent.pointerDown(screen.getByTestId("user-menu-trigger"), {
      button: 0,
      ctrlKey: false,
    });
    const menu = await screen.findByTestId("user-menu-content");
    expect(menu.getAttribute("data-side")).toBe("right");
    expect(menu.getAttribute("data-align")).toBe("end");
  });
});

describe("header overlays outside a column keep today's placement (D7)", () => {
  beforeEach(() => {
    resetSharedState();
    signIn();
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    resetSharedState();
  });

  it("leaves the bell and the user menu on their pre-D7 placement with no ColumnEdgeContext above them", async () => {
    renderHarness(
      <>
        <HeaderNotificationsBell />
        <HeaderIdentity showAppSettings={false} />
      </>,
    );

    await screen.findByTestId("notifications-bell");
    // Re-query per click, not a captured reference: opening swaps
    // `TooltipWrapper` to a transparent `Slot.Root` at the same position
    // (`label` goes `null` while open), which unmounts and remounts the
    // button underneath it.
    fireEvent.pointerDown(screen.getByTestId("notifications-bell"));
    fireEvent.click(screen.getByTestId("notifications-bell"));
    await screen.findByTestId("notifications-popover");
    const bellContent = popoverContentFor("notifications-popover");
    // No explicit `side` was ever passed here (align="end" always was) - the
    // hook resolving to null must reproduce exactly that, not a new default.
    expect(bellContent.getAttribute("data-side")).toBe("bottom");
    expect(bellContent.getAttribute("data-align")).toBe("end");

    // Close it before opening the user menu: two open surfaces at once is not
    // the scenario either component is meant to handle, and is not what this
    // test is about.
    fireEvent.click(screen.getByTestId("notifications-bell"));
    await waitFor(() => {
      expect(screen.queryByTestId("notifications-popover")).toBeNull();
    });

    const userTrigger = screen.getByTestId("user-menu-trigger");
    fireEvent.click(userTrigger);
    const menu = await screen.findByTestId("user-menu-content");
    expect(menu.getAttribute("data-side")).toBe("bottom");
    expect(menu.getAttribute("data-align")).toBe("end");
  });
});
