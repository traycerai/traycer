/**
 * Home is structural, not a strip item: `TabStrip` (`tab-strip.tsx`) renders
 * it as a fixed sibling BEFORE the scrollable `header-tab-strip-scroll`
 * container, outside the `LayoutGroup` whose reorder animations belong to
 * draggable strip items, and it is never present in `items` / `stripOrder`.
 * That placement is what this file locks down against the real `TabStrip`
 * component (not a stand-in), covering:
 *
 *  - Home renders as the first child of the `role="tablist"` element and is
 *    never a descendant of the scrollable strip.
 *  - the empty-strip early return (`if (!homeTabEnabled && allTabs.length
 *    === 0 && isLandingPage) return null`) still fires with the flag off,
 *    but Home being on means there is always something to render even with
 *    zero task tabs open on the landing route - the one control that gets a
 *    user back to Home must not disappear exactly when it is the only
 *    surface left.
 *  - with the flag off, no `tab-home` node exists anywhere, regression-
 *    proofing the pre-existing (flag-independent) behavior.
 *  - Home never consumes a `data-tab-index` digit slot: two ordinary strip
 *    tabs still read `data-tab-index` 0 and 1 with Home enabled, because the
 *    Alt-digit chords index `useHeaderTabs()`, which does not include Home.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { TabStrip } from "@/components/layout/tabs/tab-strip";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useTabsStore } from "@/stores/tabs/store";
import { tabItemId } from "@/stores/tabs/layout";
import type { TabRef } from "@/stores/tabs/types";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { WindowsBridgeContext } from "@/providers/windows-bridge-context";
import { installTabSyncCoordinator } from "@/lib/tab-sync/tab-sync-coordinator";

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
}));

// Partial: `tab-strip.tsx` also imports `epicPinDispatchAdmitted` from here,
// and a full replacement would leave that binding undefined for any case that
// reaches a pin dispatch.
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

/**
 * `TabStripBody` reads `useHostClient()` unconditionally, to pass
 * `hostClient.getActiveHostId()` into `epicPinDispatchAdmitted` at its Undo
 * dispatch site. This router-only harness stands up no `<HostRuntimeProvider>`,
 * so that one call throws for every case here regardless of what it is about -
 * and this suite is about WHERE the Home control sits in the strip, not about
 * host negotiation. Partial mock for the reason the sibling `tab-strip.test.tsx`
 * gives: only `useHostClient` is replaced, so everything else in the module is
 * still the real implementation for whatever else the tree calls.
 */
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => ({ getActiveHostId: () => "host-a" }),
  };
});

// Reconciliation install is owned by `WindowsBridgeProvider` in production;
// this router-only harness skips that provider, so install once here - the
// same thing `tab-strip.test.tsx` does for the same reason.
installTabSyncCoordinator({ readyPromise: Promise.resolve() });

let queryClient: QueryClient;

function openEpicFixture(id: string, name: string): void {
  useEpicCanvasStore.getState().seedEpic(id, { tabId: id, name }, []);
}

function openDraftFixture(id: string): void {
  useLandingDraftStore.getState().createDraftWithId(id, null);
}

function resetStores(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useTabsStore.setState(useTabsStore.getInitialState(), true);
}

function buildRouter(initialPath: string) {
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <TabStrip />
        </TooltipProvider>
      </QueryClientProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <div data-testid="landing-route-body" />,
  });
  const epicTabRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/epics/$epicId/$tabId",
    validateSearch: (
      search: Record<string, unknown>,
    ): { focusedAt: number | undefined } => ({
      focusedAt:
        typeof search.focusedAt === "number" ? search.focusedAt : undefined,
    }),
    component: () => <div data-testid="epic-tab-body" />,
  });
  const routeTree = rootRoute.addChildren([indexRoute, epicTabRoute]);
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

/** Router matching runs a microtask/timer chain even with no loader. */
async function flushRouter(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("<TabStrip /> - Home placement", () => {
  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    useSettingsStore.setState({ homeTabEnabled: false });
    resetStores();
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
    useSettingsStore.setState({ homeTabEnabled: false });
    resetStores();
  });

  it("renders Home as the tablist's first child, outside the scrollable strip, when the flag is on", async () => {
    useSettingsStore.setState({ homeTabEnabled: true });
    openEpicFixture("e-a", "Alpha");
    const refA: TabRef = { kind: "epic", id: "e-a" };
    useTabsStore.setState({
      version: 2,
      items: [{ kind: "tab", id: tabItemId(refA), ref: refA }],
      activeItemId: tabItemId(refA),
      stripOrder: [refA],
      systemTabs: { history: null, settings: null },
    });
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    const homeTab = await screen.findByTestId("tab-home");
    const tablist = screen.getByTestId("tab-strip");
    expect(tablist.getAttribute("role")).toBe("tablist");
    expect(tablist.children[0]).toBe(homeTab);

    const scrollContainer = screen.getByTestId("header-tab-strip-scroll");
    expect(scrollContainer.contains(homeTab)).toBe(false);
    expect(within(scrollContainer).queryByTestId("tab-home")).toBeNull();
  });

  it("still renders on the landing route with zero tabs when the flag is on", async () => {
    useSettingsStore.setState({ homeTabEnabled: true });
    const router = buildRouter("/");
    render(<RouterProvider router={router} />);

    // The empty strip used to be nothing at all on the landing route; with
    // Home fixed and on, there is always something to render.
    expect(await screen.findByTestId("tab-strip")).not.toBeNull();
    expect(screen.getByTestId("tab-home")).not.toBeNull();
  });

  it("renders nothing on the landing route with zero tabs when the flag is off, and shows no Home control anywhere", async () => {
    const router = buildRouter("/");
    render(<RouterProvider router={router} />);
    await flushRouter();

    expect(screen.queryByTestId("tab-strip")).toBeNull();
    expect(screen.queryByTestId("tab-home")).toBeNull();
  });

  it("shows no Home control when the flag is off even with real tabs open", async () => {
    openEpicFixture("e-a", "Alpha");
    const refA: TabRef = { kind: "epic", id: "e-a" };
    useTabsStore.setState({
      version: 2,
      items: [{ kind: "tab", id: tabItemId(refA), ref: refA }],
      activeItemId: tabItemId(refA),
      stripOrder: [refA],
      systemTabs: { history: null, settings: null },
    });
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    expect(await screen.findByTestId("tab-epic-e-a")).not.toBeNull();
    expect(screen.queryByTestId("tab-home")).toBeNull();
  });

  it("keeps ordinary strip tabs at data-tab-index 0 and 1 - Home consumes no digit slot", async () => {
    useSettingsStore.setState({ homeTabEnabled: true });
    openEpicFixture("e-a", "Alpha");
    openDraftFixture("draft-1");
    const refEpic: TabRef = { kind: "epic", id: "e-a" };
    const refDraft: TabRef = { kind: "draft", id: "draft-1" };
    useTabsStore.setState({
      version: 2,
      items: [
        { kind: "tab", id: tabItemId(refEpic), ref: refEpic },
        { kind: "tab", id: tabItemId(refDraft), ref: refDraft },
      ],
      activeItemId: tabItemId(refEpic),
      stripOrder: [refEpic, refDraft],
      systemTabs: { history: null, settings: null },
    });
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    const epicTab = await screen.findByTestId("tab-epic-e-a");
    const draftTab = screen.getByTestId("tab-draft-draft-1");
    expect(epicTab.getAttribute("data-tab-index")).toBe("0");
    expect(draftTab.getAttribute("data-tab-index")).toBe("1");
    expect(screen.getByTestId("tab-home").hasAttribute("data-tab-index")).toBe(
      false,
    );
  });

  // Tab groups and manual tab appearance are keyed by a strip REF
  // (`stripItemGroupId` reads `customizations[tabRefKey(ref)]`), and Home has
  // no ref - it is never in `items` or `stripOrder`. So "Home cannot be
  // grouped" is a property of where it renders rather than a rule anyone
  // enforces, and these pin that it stays true as the grouping feature grows.
  it("keeps Home outside a group that spans every strip tab, and first in the tablist", async () => {
    useSettingsStore.setState({ homeTabEnabled: true });
    openEpicFixture("e-a", "Alpha");
    openDraftFixture("draft-1");
    const refEpic: TabRef = { kind: "epic", id: "e-a" };
    const refDraft: TabRef = { kind: "draft", id: "draft-1" };
    useTabsStore.setState({
      version: 2,
      items: [
        { kind: "tab", id: tabItemId(refEpic), ref: refEpic },
        { kind: "tab", id: tabItemId(refDraft), ref: refDraft },
      ],
      activeItemId: tabItemId(refEpic),
      stripOrder: [refEpic, refDraft],
      systemTabs: { history: null, settings: null },
      groups: { g1: { name: "Work", color: "#336699", collapsed: false } },
      customizations: {
        "epic:e-a": { groupId: "g1", color: null, icon: null },
        "draft:draft-1": { groupId: "g1", color: null, icon: null },
      },
    });
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    const homeTab = await screen.findByTestId("tab-home");
    const tablist = screen.getByTestId("tab-strip");
    // Still the tablist's first child, and still ahead of the group's chip.
    expect(tablist.children[0]).toBe(homeTab);
    const chip = screen.getByRole("button", {
      name: "Work: collapse group",
    });
    expect(
      homeTab.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // No customization row can name Home: it has no ref to key one by.
    expect(
      Object.keys(useTabsStore.getState().customizations ?? {}),
    ).not.toContain("home");
  });

  it("draws no appearance of its own while every other tab carries one", async () => {
    useSettingsStore.setState({ homeTabEnabled: true });
    openEpicFixture("e-a", "Alpha");
    const refEpic: TabRef = { kind: "epic", id: "e-a" };
    useTabsStore.setState({
      version: 2,
      items: [{ kind: "tab", id: tabItemId(refEpic), ref: refEpic }],
      activeItemId: tabItemId(refEpic),
      stripOrder: [refEpic],
      systemTabs: { history: null, settings: null },
      customizations: {
        "epic:e-a": { groupId: null, color: "#ff0000", icon: null },
      },
    });
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    const homeTab = await screen.findByTestId("tab-home");
    // A manual colour paints an inline `backgroundColor`; Home renders none,
    // because `TabStripHomeItem` passes `color={null}` and has no menu that
    // could set one.
    expect(homeTab.querySelector('[style*="background-color"]')).toBeNull();
  });
});

/**
 * Before the windows bridge hydrates, the strip is a skeleton. Home is a fixed
 * tab rather than a persisted ref, so nothing in `stripOrder` accounts for it -
 * and a skeleton that leaves its slot out drops the whole strip one tab's width
 * to the left, then snaps it back the instant hydration lands.
 */
describe("<TabStrip /> - pre-hydration skeleton", () => {
  function renderSkeleton(): void {
    render(
      <WindowsBridgeContext.Provider
        value={{ bridge: null, hasHydrated: false }}
      >
        <TabStrip />
      </WindowsBridgeContext.Provider>,
    );
  }

  beforeEach(() => {
    useSettingsStore.setState({ homeTabEnabled: false });
    resetStores();
  });

  afterEach(() => {
    cleanup();
    useSettingsStore.setState({ homeTabEnabled: false });
    resetStores();
  });

  it("reserves the Home slot when the flag is on", () => {
    useSettingsStore.setState({ homeTabEnabled: true });
    renderSkeleton();
    expect(screen.getByTestId("tab-strip-skeleton-home")).not.toBeNull();
  });

  it("reserves nothing when the flag is off", () => {
    renderSkeleton();
    expect(screen.queryByTestId("tab-strip-skeleton-home")).toBeNull();
  });
});
