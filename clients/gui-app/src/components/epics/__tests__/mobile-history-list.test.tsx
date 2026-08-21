vi.mock("@/hooks/notifications/use-host-notification-indicators-query", () => ({
  useHostNotificationIndicators: () => ({
    data: { epics: {}, chats: {} },
    isPending: false,
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(),
  }),
}));

const tabNavigationMocks = vi.hoisted(() => ({
  activateTabIntent: vi.fn(),
}));

// Only `activateTabIntent` is replaced with a spy so a Phase row's tap can be
// observed going through the canonical activation boundary rather than a raw
// route push; every other export (`openPhaseMigrationIntent`,
// `__resetTabNavigationControllerForTesting`, and everything else the render
// tree reaches) stays the real implementation via `importActual`.
vi.mock("@/lib/tab-navigation", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tab-navigation")>(
    "@/lib/tab-navigation",
  );
  return {
    ...actual,
    activateTabIntent: tabNavigationMocks.activateTabIntent,
  };
});
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EpicsListPanel,
  type EpicsListPanelVariant,
} from "@/components/epics/epics-list-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { HistoryItem } from "@/components/home/data/home-page.data";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useHistorySearchStore } from "@/stores/home/history-search-store";
import { DEFAULT_HISTORY_SEARCH } from "@/lib/history-search";
import {
  __resetTabNavigationControllerForTesting,
  openPhaseMigrationIntent,
} from "@/lib/tab-navigation";
import type { WorktreeHostEntryV12 } from "@traycer/protocol/host/worktree-schemas";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

/**
 * The breakpoint `useIsMobileViewport()` reads is 768px - anything narrower
 * mounts `<MobileHistoryList>` in place of the desktop row chrome.
 */
const MOBILE_VIEWPORT_WIDTH = 375;
const DESKTOP_VIEWPORT_WIDTH = 1280;
const ORIGINAL_INNER_WIDTH = window.innerWidth;

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
}

interface DeleteEpicsMutationVariables {
  readonly ids: string[];
  readonly worktreeCleanup: {
    readonly candidates: ReadonlyArray<{
      readonly worktreePath: string;
      readonly ownerEpicIds: ReadonlyArray<string>;
    }>;
  } | null;
}

interface DeleteEpicsMutationOptions {
  readonly onSuccess: () => void;
}

interface RenameEpicTitleVariables {
  readonly epicDelta: {
    readonly id: string;
    readonly title: string;
    readonly updatedAt: number;
  };
}

interface SetEpicPinnedVariables {
  readonly epicId: string;
  readonly pinned: boolean;
}

const testState = vi.hoisted(() => ({
  items: [] as HistoryItem[],
  mutate:
    vi.fn<
      (
        variables: DeleteEpicsMutationVariables,
        options: DeleteEpicsMutationOptions,
      ) => void
    >(),
  renameMutate: vi.fn<(variables: RenameEpicTitleVariables) => void>(),
  setPinnedMutate: vi.fn<(variables: SetEpicPinnedVariables) => void>(),
  refetch: vi.fn<() => Promise<void>>(),
  fetchNextPage: vi.fn<() => void>(),
}));

vi.mock("@/hooks/home/use-history-query", () => ({
  useHistoryQuery: () => ({
    data: {
      items: testState.items,
      availableRepos: [],
      availableWorkspaces: [],
      totalCount: testState.items.length,
      facets: { repos: [], workspaces: [], ownershipScopes: [] },
      worktreesByEpicId: new Map<string, readonly WorktreeHostEntryV12[]>(),
    },
    isPending: false,
    isFetching: false,
    error: null,
    hostId: "host-test",
    refetch: testState.refetch,
    fetchNextPage: testState.fetchNextPage,
    hasNextPage: false,
    isFetchingNextPage: false,
  }),
}));

vi.mock("@/hooks/epic/use-epic-batch-delete-mutation", () => ({
  useEpicBatchDelete: () => ({
    isPending: false,
    mutate: testState.mutate,
  }),
}));

vi.mock("@/hooks/epic/use-task-delete-worktree-candidates-query", () => ({
  useTaskDeleteWorktreeCandidates: () => ({
    candidates: [],
    isError: false,
  }),
}));

// The list panel hands the sweep dialog the app-wide following client; the
// panel renders outside a HostRuntimeProvider here, and the sweep query is
// mocked below anyway (sibling epics-list-panel suites use the same stubs).
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

vi.mock("@/hooks/epic/use-epic-sweep-worktree-candidates-query", () => ({
  useEpicSweepWorktreeCandidatesForClient: () => ({
    hostId: "host-test",
    rows: [],
    isPending: false,
    isError: false,
    checkedAt: null,
    canRefresh: true,
    refresh: () => Promise.resolve(),
  }),
}));

vi.mock("@/hooks/epic/use-epic-sweep-worktrees-mutation", () => ({
  useEpicSweepWorktrees: () => ({
    isPending: false,
    mutate: () => {},
  }),
  useSweepingWorktreePaths: () => new Set<string>(),
}));

vi.mock("@/hooks/epic/use-epic-title-mutation", () => ({
  useEpicUpdateTitle: () => ({
    isPending: false,
    mutate: testState.renameMutate,
  }),
}));

vi.mock("@/hooks/epic/use-epic-set-pinned-mutation", () => ({
  useEpicSetPinned: () => ({
    mutate: testState.setPinnedMutate,
  }),
  usePendingSetPinnedEpicIds: () => new Set<string>(),
}));

vi.mock("@/hooks/epic/use-epic-activity-status", () => ({
  useEpicActivityStatus: () => "idle",
}));

function historyItem(overrides: Partial<HistoryItem>): HistoryItem {
  return {
    id: "history-epic-1",
    epicId: "epic-from-history",
    taskType: "epic",
    title: "Open from landing",
    initialUserPrompt: "",
    updatedAtMs: 1_700_000_000_000,
    updatedLabel: "about 2 hours ago",
    updatedBucket: "today",
    linkedRepos: [],
    linkedWorkspaces: [],
    chatHostIds: null,
    pullRequestNumbers: [],
    worktreeBranches: [],
    worktreePaths: [],
    ownership: "mine",
    permissionRole: "owner",
    isPinned: false,
    ...overrides,
  };
}

function renderPanel(variant: EpicsListPanelVariant, initialEntry: string) {
  return renderPanelWithOpenItem(variant, initialEntry, null);
}

function renderPanelWithOpenItem(
  variant: EpicsListPanelVariant,
  initialEntry: string,
  onOpenItem: ((item: HistoryItem) => void) | null,
) {
  const rootRoute = createRootRoute({
    component: () => <RootOutlet />,
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <EpicsListPanel
        variant={variant}
        className={undefined}
        onSelectEpic={null}
        onOpenItem={onOpenItem}
        routeSearch={null}
        historyNowMs={null}
        autoFocusSearch={false}
      />
    ),
  });
  const tabEpicRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/epics/$epicId/$tabId",
    component: () => <div data-testid="epic-tab-route" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, tabEpicRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

function RootOutlet(): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Outlet />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

/**
 * A fixed pointer identity for every gesture dispatched in this file. Only
 * one touch pointer is ever live at a time in these scenarios, so a shared
 * constant is enough to keep `pointerdown` / `pointermove` / `pointerup`
 * addressing the same in-flight gesture.
 */
const TOUCH_POINTER_ID = 7;

function firePointerDown(el: Element, clientX: number, clientY: number): void {
  fireEvent.pointerDown(el, {
    pointerId: TOUCH_POINTER_ID,
    pointerType: "touch",
    isPrimary: true,
    clientX,
    clientY,
  });
}

function firePointerMove(el: Element, clientX: number, clientY: number): void {
  fireEvent.pointerMove(el, {
    pointerId: TOUCH_POINTER_ID,
    pointerType: "touch",
    isPrimary: true,
    clientX,
    clientY,
  });
}

function firePointerUp(el: Element, clientX: number, clientY: number): void {
  fireEvent.pointerUp(el, {
    pointerId: TOUCH_POINTER_ID,
    pointerType: "touch",
    isPrimary: true,
    clientX,
    clientY,
  });
}

/**
 * Drags a row card 80px left in one motion, well past the half-tray commit
 * distance for the default three-action tray (pin/rename/delete, 44px each -
 * 132px total, so a 66px commit threshold), and releases. A single move is
 * enough: the classifier and the commit rule both key off cumulative travel
 * from the gesture's start, not the number of intermediate samples.
 */
function openTrayByDrag(card: Element): void {
  firePointerDown(card, 300, 100);
  firePointerMove(card, 220, 100);
  firePointerUp(card, 220, 100);
}

/**
 * A touch point shaped to match what the production listeners read off a
 * real `Touch`: an `identifier` plus a coordinate pair.
 */
interface FakeTouchPoint {
  readonly identifier: number;
  readonly clientX: number;
  readonly clientY: number;
}

/**
 * jsdom implements `TouchEvent` but no usable `Touch`/`TouchList`
 * constructor, so a touch here is a plain `Event` wearing the one shape the
 * pull-to-refresh listeners read off it: a `touches` list indexable both by
 * `[]` and `.item()` (the real `TouchList` shape).
 */
function makeTouchList(
  points: ReadonlyArray<FakeTouchPoint>,
): ReadonlyArray<FakeTouchPoint> & {
  item(index: number): FakeTouchPoint | null;
} {
  return Object.assign([...points], {
    item: (index: number): FakeTouchPoint | null => points[index] ?? null,
  });
}

function fireTouchStart(
  target: Element,
  touches: ReadonlyArray<FakeTouchPoint>,
): void {
  const event = new Event("touchstart", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", {
    value: makeTouchList(touches),
    configurable: true,
  });
  target.dispatchEvent(event);
}

function fireTouchMove(
  target: Element,
  touches: ReadonlyArray<FakeTouchPoint>,
): void {
  const event = new Event("touchmove", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", {
    value: makeTouchList(touches),
    configurable: true,
  });
  target.dispatchEvent(event);
}

function fireTouchEnd(target: Element): void {
  const event = new Event("touchend", { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
}

function fireTouchCancel(target: Element): void {
  const event = new Event("touchcancel", { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
}

describe("<MobileHistoryList /> (via <EpicsListPanel /> at a mobile viewport)", () => {
  beforeEach(() => {
    setViewportWidth(MOBILE_VIEWPORT_WIDTH);
    window.localStorage.clear();
    testState.items = [historyItem({})];
    testState.mutate.mockReset();
    testState.renameMutate.mockReset();
    testState.setPinnedMutate.mockReset();
    testState.fetchNextPage.mockReset();
    testState.refetch.mockReset();
    testState.refetch.mockResolvedValue(undefined);
    tabNavigationMocks.activateTabIntent.mockReset();
    __resetTabNavigationControllerForTesting();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useHistorySearchStore.setState({ search: DEFAULT_HISTORY_SEARCH });
    queryClient.clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    setViewportWidth(ORIGINAL_INNER_WIDTH);
    document.body.innerHTML = "";
    __resetTabNavigationControllerForTesting();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useHistorySearchStore.setState({ search: DEFAULT_HISTORY_SEARCH });
  });

  describe("swipe tray", () => {
    it("opens the tray on a leftward drag well past half the tray width", async () => {
      renderPanel("embedded", "/");
      const card = await screen.findByTestId("epics-list-row-card");

      openTrayByDrag(card);

      expect(
        screen.getByTestId("epics-list-row").getAttribute("data-tray-open"),
      ).toBe("true");
    });

    it("stays closed on a leftward drag of only a few px", async () => {
      renderPanel("embedded", "/");
      const card = await screen.findByTestId("epics-list-row-card");

      firePointerDown(card, 300, 100);
      firePointerMove(card, 297, 100);
      firePointerUp(card, 297, 100);

      expect(
        screen.getByTestId("epics-list-row").getAttribute("data-tray-open"),
      ).toBeNull();
    });

    // The single-sided design: right belongs to the shell's nav-drawer edge
    // gesture, so a rightward drag must never reveal the tray, however far it
    // travels. `classifyDirectionalIntent`'s counter-direction arm fails this
    // outright at 10px, well before any commit distance is even evaluated -
    // this case is a pure distance check with no timing dependency.
    it("stays closed on a rightward drag of any distance", async () => {
      renderPanel("embedded", "/");
      const card = await screen.findByTestId("epics-list-row-card");

      firePointerDown(card, 300, 100);
      firePointerMove(card, 380, 100);
      firePointerUp(card, 380, 100);

      expect(
        screen.getByTestId("epics-list-row").getAttribute("data-tray-open"),
      ).toBeNull();
    });

    // The edge guard in `withinEdgeZone` only reads `clientX` on an OPEN tray
    // - a closed one's forward direction is leftward, so a rightward drag
    // fails `classifyDirectionalIntent`'s counter-direction arm the same way
    // it does starting anywhere else on the row. Pinned as its own case
    // because it starts inside the strip the open-tray guard below tests
    // against, so a regression that widened the guard to the closed state
    // would still be caught here.
    it("stays closed on a rightward drag starting inside the reserved edge zone", async () => {
      renderPanel("embedded", "/");
      const card = await screen.findByTestId("epics-list-row-card");

      firePointerDown(card, 10, 100);
      firePointerMove(card, 90, 100);
      firePointerUp(card, 90, 100);

      expect(
        screen.getByTestId("epics-list-row").getAttribute("data-tray-open"),
      ).toBeNull();
    });

    it("stays closed on a vertical drag", async () => {
      renderPanel("embedded", "/");
      const card = await screen.findByTestId("epics-list-row-card");

      firePointerDown(card, 300, 100);
      firePointerMove(card, 300, 160);
      firePointerUp(card, 300, 160);

      expect(
        screen.getByTestId("epics-list-row").getAttribute("data-tray-open"),
      ).toBeNull();
    });

    it("closes the first row's tray when a second row's tray opens", async () => {
      testState.items = [
        historyItem({}),
        historyItem({
          id: "history-epic-2",
          epicId: "epic-two",
          title: "Second history item",
        }),
      ];
      renderPanel("embedded", "/");
      const cards = await screen.findAllByTestId("epics-list-row-card");
      expect(cards).toHaveLength(2);

      openTrayByDrag(cards[0]);
      const rows = screen.getAllByTestId("epics-list-row");
      expect(rows[0].getAttribute("data-tray-open")).toBe("true");
      expect(rows[1].getAttribute("data-tray-open")).toBeNull();

      openTrayByDrag(cards[1]);
      const rowsAfter = screen.getAllByTestId("epics-list-row");
      expect(rowsAfter[0].getAttribute("data-tray-open")).toBeNull();
      expect(rowsAfter[1].getAttribute("data-tray-open")).toBe("true");
    });

    it("closes an open tray when the list scrolls", async () => {
      renderPanel("embedded", "/");
      const card = await screen.findByTestId("epics-list-row-card");
      openTrayByDrag(card);
      expect(
        screen.getByTestId("epics-list-row").getAttribute("data-tray-open"),
      ).toBe("true");

      fireEvent.scroll(screen.getByTestId("mobile-history-scroller"));

      expect(
        screen.getByTestId("epics-list-row").getAttribute("data-tray-open"),
      ).toBeNull();
    });

    // Once the tray is open the recognizer's forward direction flips to
    // rightward, so putting the tray away is a second, independent drag - not
    // the leftward one reversing. 80px clears half the 132px tray by distance
    // alone, the same margin `openTrayByDrag` uses for the leftward case, so
    // this needs no control over event timing. The origin, `clientX: 220`, is
    // deliberate: it sits outside the nav-drawer's edge strip (the strip is
    // `[0, 32]` at the jsdom-default zero safe-area inset), so this is the
    // contrasting case to the in-strip one below - the row is free to claim
    // this drag.
    it("closes an already-open tray on a rightward drag past half the tray width", async () => {
      renderPanel("embedded", "/");
      const card = await screen.findByTestId("epics-list-row-card");
      openTrayByDrag(card);
      expect(
        screen.getByTestId("epics-list-row").getAttribute("data-tray-open"),
      ).toBe("true");

      firePointerDown(card, 220, 100);
      firePointerMove(card, 300, 100);
      firePointerUp(card, 300, 100);

      expect(
        screen.getByTestId("epics-list-row").getAttribute("data-tray-open"),
      ).toBeNull();
    });

    // The row sits under `touch-action: pan-y`, not `pan-x`, so nothing
    // upstream stands a shell recognizer down when a close-swipe starts
    // inside the reserved strip - the row has to yield instead.
    // `withinEdgeZone` does that at `onPointerDown`: a touch starting at
    // `clientX: 10`, inside `[0, 32]` at the jsdom-default zero safe-area
    // inset, is never tracked, so the tray stays open however far past its
    // commit distance the drag travels.
    it("leaves an open tray open on a rightward close-swipe starting inside the reserved edge zone", async () => {
      renderPanel("embedded", "/");
      const card = await screen.findByTestId("epics-list-row-card");
      openTrayByDrag(card);
      expect(
        screen.getByTestId("epics-list-row").getAttribute("data-tray-open"),
      ).toBe("true");

      firePointerDown(card, 10, 100);
      firePointerMove(card, 90, 100);
      firePointerUp(card, 90, 100);

      expect(
        screen.getByTestId("epics-list-row").getAttribute("data-tray-open"),
      ).toBe("true");
    });

    // Nothing is pointer-captured until a drag ACTIVATES, so a touch that goes
    // down on the card, moves a little without declaring an axis, and then
    // ends somewhere the card never sees a `pointerup` or `pointercancel` for,
    // leaves its tracker resident in `trackingRef`. Touch pointer ids are
    // reused between contacts, so a later contact carrying the same id would
    // match that stale tracker by id alone and inherit its start coordinates
    // instead of getting a fresh one - which is how a touch landing inside the
    // nav-drawer strip could still end up driving the row. `onPointerDown`
    // clears the tracker before the edge-zone check runs, precisely so the
    // yielded contact never gets a chance to claim it.
    //
    // The drag target here (400, not the sibling case's 90) is deliberate: the
    // stale tracker's start (300, outside the strip - a tracker only survives
    // a contact the edge-zone gate let through) has to still be far enough
    // from the release point that a row using it as its anchor would clear the
    // half-tray commit distance, or the exploit this case pins would go
    // unnoticed even while it silently mis-captured the pointer.
    it("yields the drawer strip even when a prior undecided pointer left its tracker resident", async () => {
      renderPanel("embedded", "/");
      const card = await screen.findByTestId("epics-list-row-card");
      openTrayByDrag(card);
      expect(
        screen.getByTestId("epics-list-row").getAttribute("data-tray-open"),
      ).toBe("true");

      // Undecided: starts outside the strip, moves a few px - under the 15px
      // activation distance - and is never released on the card.
      firePointerDown(card, 300, 100);
      firePointerMove(card, 305, 100);

      // A fresh contact reusing the same pointer id (every gesture in this
      // file shares `TOUCH_POINTER_ID`), landing inside the strip.
      firePointerDown(card, 10, 100);
      firePointerMove(card, 400, 100);
      firePointerUp(card, 400, 100);

      expect(
        screen.getByTestId("epics-list-row").getAttribute("data-tray-open"),
      ).toBe("true");
    });

    // A rightward drag this short never clears `classifyDirectionalIntent`'s
    // 15px activation distance, so the drag never declares itself and the
    // tray's open state is left exactly where it was - a pure distance check,
    // like the closed-state "few px" case above.
    it("leaves an already-open tray open on a rightward drag of only a few px", async () => {
      renderPanel("embedded", "/");
      const card = await screen.findByTestId("epics-list-row-card");
      openTrayByDrag(card);
      expect(
        screen.getByTestId("epics-list-row").getAttribute("data-tray-open"),
      ).toBe("true");

      firePointerDown(card, 220, 100);
      firePointerMove(card, 223, 100);
      firePointerUp(card, 223, 100);

      expect(
        screen.getByTestId("epics-list-row").getAttribute("data-tray-open"),
      ).toBe("true");
    });
  });

  describe("tray actions", () => {
    it("opens the shared confirm dialog on delete, without deleting immediately", async () => {
      renderPanel("embedded", "/");

      fireEvent.click(await screen.findByTestId("epics-list-row-tray-delete"));

      expect(await screen.findByTestId("delete-tasks-dialog")).not.toBeNull();
      expect(testState.mutate).not.toHaveBeenCalled();
    });

    it("calls the set-pinned mutation with the flipped pin state", async () => {
      renderPanel("embedded", "/");

      fireEvent.click(await screen.findByTestId("epics-list-row-tray-pin"));

      expect(testState.setPinnedMutate).toHaveBeenCalledWith({
        epicId: "epic-from-history",
        pinned: true,
      });
    });

    it("reveals the inline title input on rename", async () => {
      renderPanel("embedded", "/");

      fireEvent.click(await screen.findByTestId("epics-list-row-tray-rename"));

      expect(
        await screen.findByTestId("epics-list-row-title-input"),
      ).not.toBeNull();
    });
  });

  describe("tap and long press", () => {
    it("opens the task on a plain tap", async () => {
      const onOpenItem = vi.fn();
      renderPanelWithOpenItem("embedded", "/", onOpenItem);

      fireEvent.click(
        await screen.findByRole("link", {
          name: "Open task Open from landing",
        }),
      );

      expect(onOpenItem).toHaveBeenCalledWith(testState.items[0]);
    });

    // A Phase row's overlay is a router `Link` exactly like an Epic row's, so
    // a raw click on it pushes straight to the epic route by itself. Only the
    // canonical activation boundary carries the migration intent, so a Phase
    // tap has to go through it rather than through the Link's own
    // navigation - this observes `activateTabIntent` firing with an
    // `open-phase-migration` intent, and the router never having moved off
    // its starting location on its own.
    it("routes a tap on a phase row through the phase migration activation path, not a raw router navigation", async () => {
      testState.items = [
        historyItem({
          id: "history-phase-1",
          epicId: "phase-target",
          taskType: "phase",
          title: "Legacy phase row",
        }),
      ];
      const router = renderPanel("embedded", "/");

      fireEvent.click(
        await screen.findByRole("link", { name: "Open task Legacy phase row" }),
      );

      expect(tabNavigationMocks.activateTabIntent).toHaveBeenCalledTimes(1);
      expect(tabNavigationMocks.activateTabIntent).toHaveBeenCalledWith(
        expect.any(Function),
        openPhaseMigrationIntent({
          phaseId: "phase-target",
          name: "Legacy phase row",
          focus: {
            focusedAt: undefined,
            focusArtifactId: undefined,
            focusThreadId: undefined,
            migrationSource: "phase",
          },
        }),
        undefined,
      );
      expect(router.state.location.pathname).toBe("/");
    });

    it("closes an open tray on tap instead of opening the task", async () => {
      const onOpenItem = vi.fn();
      renderPanelWithOpenItem("embedded", "/", onOpenItem);
      const card = await screen.findByTestId("epics-list-row-card");
      openTrayByDrag(card);
      expect(
        screen.getByTestId("epics-list-row").getAttribute("data-tray-open"),
      ).toBe("true");

      // A fresh, stationary press-and-release: distinct from the drag that
      // opened the tray, so neither recognizer has anything to swallow and
      // the row's own tap-while-open rule is what decides.
      firePointerDown(card, 300, 100);
      firePointerUp(card, 300, 100);
      fireEvent.click(
        screen.getByRole("link", { name: "Open task Open from landing" }),
      );

      expect(onOpenItem).not.toHaveBeenCalled();
      expect(
        screen.getByTestId("epics-list-row").getAttribute("data-tray-open"),
      ).toBeNull();
    });

    it("enters selection mode on a stationary 450ms hold, and swallows the trailing click", async () => {
      const onOpenItem = vi.fn();
      renderPanelWithOpenItem("embedded", "/", onOpenItem);
      const card = await screen.findByTestId("epics-list-row-card");

      vi.useFakeTimers();
      firePointerDown(card, 300, 100);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(460);
      });
      vi.useRealTimers();
      firePointerUp(card, 300, 100);
      // Selection mode swaps the overlay from a `Link` to a toggle button, so
      // the trailing click this case is about lands there.
      fireEvent.click(
        screen.getByRole("button", {
          name: "Toggle selection for Open from landing",
        }),
      );

      const checkbox = screen.getByTestId("epics-list-row-select");
      expect(checkbox.getAttribute("aria-checked")).toBe("true");
      expect(onOpenItem).not.toHaveBeenCalled();
    });

    it("does not enter selection mode when the press moves past the hold's slop before 450ms", async () => {
      renderPanel("embedded", "/");
      const card = await screen.findByTestId("epics-list-row-card");

      vi.useFakeTimers();
      firePointerDown(card, 300, 100);
      firePointerMove(card, 300, 112);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(460);
      });
      vi.useRealTimers();
      firePointerUp(card, 300, 112);

      expect(screen.queryByTestId("epics-list-row-select")).toBeNull();
    });
  });

  describe("selection checkbox", () => {
    it("toggles the row's selection when its select checkbox is clicked, without opening the task", async () => {
      const onOpenItem = vi.fn();
      testState.items = [
        historyItem({}),
        historyItem({
          id: "history-epic-2",
          epicId: "epic-two",
          title: "Second history item",
        }),
      ];
      renderPanelWithOpenItem("embedded", "/", onOpenItem);
      const cards = await screen.findAllByTestId("epics-list-row-card");

      // Long-press the second row to enter selection mode; the first row's
      // checkbox starts unselected, so clicking it below is the toggle under
      // test rather than a re-toggle of the row the hold already selected.
      vi.useFakeTimers();
      firePointerDown(cards[1], 300, 100);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(460);
      });
      vi.useRealTimers();
      firePointerUp(cards[1], 300, 100);

      const checkbox = screen.getByRole("checkbox", {
        name: "Select Open from landing",
      });
      expect(checkbox.getAttribute("aria-checked")).toBe("false");

      fireEvent.click(checkbox);

      expect(checkbox.getAttribute("aria-checked")).toBe("true");
      // The checkbox and the card's overlay are disjoint subtrees, so a click
      // on the checkbox has no bubbling path to the overlay's own activation
      // handler - this is the double-fire guard.
      expect(onOpenItem).not.toHaveBeenCalled();
    });

    it("disables the select checkbox for a row the user may not delete, and a click on it does not toggle selection", async () => {
      testState.items = [
        historyItem({}),
        historyItem({
          id: "history-epic-viewer",
          epicId: "epic-viewer",
          title: "Viewer only row",
          permissionRole: "viewer",
        }),
      ];
      renderPanel("embedded", "/");
      const cards = await screen.findAllByTestId("epics-list-row-card");

      // Long-press the first, deletable row to enter selection mode - a
      // viewer-only row's own long press is disabled, since a row nobody may
      // select has nothing to hold into selection mode.
      vi.useFakeTimers();
      firePointerDown(cards[0], 300, 100);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(460);
      });
      vi.useRealTimers();
      firePointerUp(cards[0], 300, 100);

      const viewerCheckbox = screen.getByRole("checkbox", {
        name: "Select Viewer only row",
      });
      expect(viewerCheckbox.getAttribute("aria-disabled")).toBe("true");

      fireEvent.click(viewerCheckbox);

      expect(viewerCheckbox.getAttribute("aria-checked")).toBe("false");
    });
  });

  describe("selection mode versus the swipe tray", () => {
    // The tray is a sibling parked behind the row card, concealed only by the
    // card's own opaque background - so anything that makes the card
    // translucent shows the tray through it, with no drag involved at all. A
    // long press enters selection mode with the pressed row already checked,
    // and a checked row's card carries its own tint, which makes this the one
    // path into the mode where that could happen. A few px of drift is
    // included because a hold rarely lands perfectly still, and it stays
    // under the hold's own 6px slop so the press still completes.
    it("enters selection mode from a long-press with slight drift, with the tray absent and the card untranslated", async () => {
      renderPanel("embedded", "/");
      const card = await screen.findByTestId("epics-list-row-card");

      vi.useFakeTimers();
      firePointerDown(card, 300, 100);
      firePointerMove(card, 303, 103);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(460);
      });
      vi.useRealTimers();
      firePointerUp(card, 303, 103);

      const row = screen.getByTestId("epics-list-row");
      expect(within(row).queryByTestId("epics-list-row-tray")).toBeNull();
      expect(
        screen
          .getByTestId("epics-list-row-select")
          .getAttribute("aria-checked"),
      ).toBe("true");
      expect(screen.getByTestId("epics-list-row-card").style.transform).toBe(
        "translate3d(-0px, 0, 0)",
      );
    });

    it("hides an already-open tray when a long-press on the same row enters selection mode", async () => {
      renderPanel("embedded", "/");
      const card = await screen.findByTestId("epics-list-row-card");
      openTrayByDrag(card);
      expect(
        screen.getByTestId("epics-list-row").getAttribute("data-tray-open"),
      ).toBe("true");

      vi.useFakeTimers();
      firePointerDown(card, 300, 100);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(460);
      });
      vi.useRealTimers();
      firePointerUp(card, 300, 100);

      const row = screen.getByTestId("epics-list-row");
      expect(within(row).queryByTestId("epics-list-row-tray")).toBeNull();
      expect(
        screen
          .getByTestId("epics-list-row-select")
          .getAttribute("aria-checked"),
      ).toBe("true");
    });

    // Selection mode is one boolean shared by the whole list, not a per-row
    // flag the pressed row alone flips, so a tray left open on a row the
    // gesture never touched still has to go.
    it("hides another row's open tray when a long-press elsewhere enters selection mode", async () => {
      testState.items = [
        historyItem({}),
        historyItem({
          id: "history-epic-2",
          epicId: "epic-two",
          title: "Second history item",
        }),
      ];
      renderPanel("embedded", "/");
      const cards = await screen.findAllByTestId("epics-list-row-card");
      openTrayByDrag(cards[0]);
      expect(
        screen
          .getAllByTestId("epics-list-row")[0]
          .getAttribute("data-tray-open"),
      ).toBe("true");

      vi.useFakeTimers();
      firePointerDown(cards[1], 300, 100);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(460);
      });
      vi.useRealTimers();
      firePointerUp(cards[1], 300, 100);

      const rows = screen.getAllByTestId("epics-list-row");
      expect(within(rows[0]).queryByTestId("epics-list-row-tray")).toBeNull();
      expect(within(rows[1]).queryByTestId("epics-list-row-tray")).toBeNull();
      expect(
        screen
          .getAllByTestId("epics-list-row-select")[1]
          .getAttribute("aria-checked"),
      ).toBe("true");
    });

    it("does not open the tray on a leftward drag past the commit distance while in selection mode, and leaves the card untranslated", async () => {
      renderPanel("embedded", "/");
      const card = await screen.findByTestId("epics-list-row-card");

      vi.useFakeTimers();
      firePointerDown(card, 300, 100);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(460);
      });
      vi.useRealTimers();
      firePointerUp(card, 300, 100);
      expect(
        screen
          .getByTestId("epics-list-row-select")
          .getAttribute("aria-checked"),
      ).toBe("true");

      openTrayByDrag(screen.getByTestId("epics-list-row-card"));

      const row = screen.getByTestId("epics-list-row");
      expect(within(row).queryByTestId("epics-list-row-tray")).toBeNull();
      expect(screen.getByTestId("epics-list-row-card").style.transform).toBe(
        "translate3d(-0px, 0, 0)",
      );
    });

    it("restores the swipe once selection mode is cancelled", async () => {
      renderPanel("embedded", "/");
      const card = await screen.findByTestId("epics-list-row-card");

      vi.useFakeTimers();
      firePointerDown(card, 300, 100);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(460);
      });
      vi.useRealTimers();
      firePointerUp(card, 300, 100);
      expect(
        screen
          .getByTestId("epics-list-row-select")
          .getAttribute("aria-checked"),
      ).toBe("true");

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByTestId("epics-list-row-select")).toBeNull();

      openTrayByDrag(screen.getByTestId("epics-list-row-card"));

      expect(
        screen.getByTestId("epics-list-row").getAttribute("data-tray-open"),
      ).toBe("true");
    });

    // A tracker is created on `pointerdown` and only ever cleared by a FRESH
    // contact landing on that same row's card - `onPointerDown` says so
    // explicitly. A long press on a different row enters selection mode
    // without ever touching the first row's card, so its tracker survives the
    // stand-down untouched, still carrying the pointerdown it was built from.
    // The recognizer must reject that tracker on identity once selection mode
    // has come and gone, not merely refuse it while disabled - otherwise the
    // same tracker matches again by `pointerId` once re-enabled, and a finger
    // that was only ever resting on the row would resume travel measured from
    // an origin the row last believed in before a mode it never took part in.
    it("rejects a contact that was already down when selection mode came and went", async () => {
      testState.items = [
        historyItem({}),
        historyItem({
          id: "history-epic-2",
          epicId: "epic-two",
          title: "Second history item",
        }),
      ];
      renderPanel("embedded", "/");
      const cards = await screen.findAllByTestId("epics-list-row-card");

      // The first row's pointer goes down and is left resting - no pointerup,
      // no pointercancel - so whatever tracker this creates is still resident
      // when the next thing happens.
      firePointerDown(cards[0], 300, 100);

      // Selection mode is entered by a long press on the OTHER row, the same
      // route the cross-row tray case above uses. This never issues a new
      // contact on the first row's card, so the first row's tracker is not
      // the one being cleared here.
      vi.useFakeTimers();
      firePointerDown(cards[1], 300, 100);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(460);
      });
      vi.useRealTimers();
      firePointerUp(cards[1], 300, 100);
      expect(
        screen
          .getAllByTestId("epics-list-row-select")[1]
          .getAttribute("aria-checked"),
      ).toBe("true");

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByTestId("epics-list-row-select")).toBeNull();

      // The same pointer id now moves on the first row's card, travelling far
      // enough - measured from the pointerdown issued before selection mode
      // ever started - to clear the tray's commit distance if that origin
      // were honored.
      const cardsAfterCancel = screen.getAllByTestId("epics-list-row-card");
      firePointerMove(cardsAfterCancel[0], 220, 100);
      firePointerUp(cardsAfterCancel[0], 220, 100);

      // The tray element stays mounted at rest once selection mode has been
      // left - only `isTrayOpen` governs whether it is revealed - so the
      // regression this pins is read off `data-tray-open`, the same attribute
      // every other swipe case in this file asserts against.
      const rows = screen.getAllByTestId("epics-list-row");
      expect(rows[0].getAttribute("data-tray-open")).toBeNull();
    });
  });

  describe("pull to refresh", () => {
    // The trigger compares raw finger travel against `PULL_TRIGGER_PX`, not
    // the damped surface distance the user sees - the two diverge fast, and
    // reading the threshold off the damped value would need roughly double
    // the raw travel to fire. Two moves: the first (30px) clears the
    // classifier's 15px activation distance without yet reaching the
    // trigger, and the second lands raw travel exactly on it.
    it("refetches on a raw downward travel of 64px, the trigger threshold", async () => {
      renderPanel("embedded", "/");
      const scroller = await screen.findByTestId("mobile-history-scroller");

      fireTouchStart(scroller, [{ identifier: 1, clientX: 100, clientY: 100 }]);
      fireTouchMove(scroller, [{ identifier: 1, clientX: 100, clientY: 130 }]);
      fireTouchMove(scroller, [{ identifier: 1, clientX: 100, clientY: 164 }]);
      fireTouchEnd(scroller);

      expect(testState.refetch).toHaveBeenCalledTimes(1);
    });

    it("does not refetch a raw downward travel of 63px, just under the trigger threshold", async () => {
      renderPanel("embedded", "/");
      const scroller = await screen.findByTestId("mobile-history-scroller");

      fireTouchStart(scroller, [{ identifier: 1, clientX: 100, clientY: 100 }]);
      fireTouchMove(scroller, [{ identifier: 1, clientX: 100, clientY: 130 }]);
      fireTouchMove(scroller, [{ identifier: 1, clientX: 100, clientY: 163 }]);
      fireTouchEnd(scroller);

      expect(testState.refetch).not.toHaveBeenCalled();
    });

    it("does not refetch on a downward drag that stops short of the trigger threshold", async () => {
      renderPanel("embedded", "/");
      const scroller = await screen.findByTestId("mobile-history-scroller");

      fireTouchStart(scroller, [{ identifier: 1, clientX: 100, clientY: 100 }]);
      // 40px of raw travel, short of the 64px trigger.
      fireTouchMove(scroller, [{ identifier: 1, clientX: 100, clientY: 140 }]);
      fireTouchEnd(scroller);

      expect(testState.refetch).not.toHaveBeenCalled();
    });

    it("does not refetch an armed pull ended by touchcancel", async () => {
      renderPanel("embedded", "/");
      const scroller = await screen.findByTestId("mobile-history-scroller");

      fireTouchStart(scroller, [{ identifier: 1, clientX: 100, clientY: 100 }]);
      fireTouchMove(scroller, [{ identifier: 1, clientX: 100, clientY: 400 }]);
      fireTouchCancel(scroller);

      expect(testState.refetch).not.toHaveBeenCalled();
    });

    // A second finger landing mid-pull hands the gesture to `cancel()`, the
    // same unwind path `touchcancel` and effect cleanup use - never
    // `startRefresh`. Asserting the transform, not just the missing refetch,
    // is what catches a surface left translated with nothing left to release
    // it.
    it("cancels an armed pull when a second finger touches down, stranding no translate", async () => {
      renderPanel("embedded", "/");
      const scroller = await screen.findByTestId("mobile-history-scroller");

      fireTouchStart(scroller, [{ identifier: 1, clientX: 100, clientY: 100 }]);
      fireTouchMove(scroller, [{ identifier: 1, clientX: 100, clientY: 400 }]);
      fireTouchStart(scroller, [
        { identifier: 1, clientX: 100, clientY: 400 },
        { identifier: 2, clientX: 200, clientY: 400 },
      ]);
      fireTouchEnd(scroller);

      expect(testState.refetch).not.toHaveBeenCalled();
      expect(scroller.style.transform).toBe("translate3d(0, 0px, 0)");
    });

    it("does not refetch a downward drag when the list is scrolled away from its top", async () => {
      renderPanel("embedded", "/");
      const scroller = await screen.findByTestId("mobile-history-scroller");
      scroller.scrollTop = 50;

      fireTouchStart(scroller, [{ identifier: 1, clientX: 100, clientY: 100 }]);
      fireTouchMove(scroller, [{ identifier: 1, clientX: 100, clientY: 400 }]);
      fireTouchEnd(scroller);

      expect(testState.refetch).not.toHaveBeenCalled();
    });

    it("does not refetch a downward drag while a text input is focused", async () => {
      renderPanel("embedded", "/");
      const scroller = await screen.findByTestId("mobile-history-scroller");
      const input = document.createElement("input");
      document.body.appendChild(input);
      input.focus();

      fireTouchStart(scroller, [{ identifier: 1, clientX: 100, clientY: 100 }]);
      fireTouchMove(scroller, [{ identifier: 1, clientX: 100, clientY: 400 }]);
      fireTouchEnd(scroller);

      expect(testState.refetch).not.toHaveBeenCalled();
    });
  });

  describe("desktop untouched", () => {
    it("keeps the desktop row chrome at a desktop viewport width", async () => {
      setViewportWidth(DESKTOP_VIEWPORT_WIDTH);
      renderPanel("embedded", "/");

      expect(await screen.findByTestId("epics-list-row-pin")).not.toBeNull();
      expect(screen.getByTestId("epics-list-row-delete")).not.toBeNull();
      expect(screen.getByTestId("epics-list-row-edit-title")).not.toBeNull();
      expect(screen.queryByTestId("epics-list-row-tray")).toBeNull();
    });
  });
});
