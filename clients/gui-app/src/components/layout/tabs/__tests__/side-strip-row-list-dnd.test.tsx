/**
 * The real side-strip DOM under the real `RootDndProvider`: the row list's
 * scroller, its m.div frames and the rows' drag handles are what the drag
 * model reads, so this pins the attributes and refs where they actually live.
 * A row reorders along y, the drag overlay is the side row, and a sideways
 * pull into the content tears the tab off (S-11). Rects are stubbed: jsdom
 * measures zeros.
 */
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { RootDndProvider } from "@/components/epic-canvas/dnd/root-dnd-provider";
import { EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE } from "@/components/epic-canvas/dnd/epic-canvas-pointer-sensor";
import { HEADER_STRIP_SCROLL_TEST_ID } from "@/components/layout/tabs/header-strip-geometry";
import { SideStripRowList } from "@/components/layout/tabs/side-strip/side-strip-row-list";
import { StripNeedsYouScope } from "@/components/layout/tabs/side-strip/strip-needs-you-scope";
import { StripSectionsScope } from "@/components/layout/tabs/side-strip/strip-sections-scope";
import {
  publishTabDetachHandler,
  resetTabDetachHandler,
} from "@/components/layout/tabs/tab-detach-channel";
import { useTabStripController } from "@/components/layout/tabs/tab-strip-controller";
import { TabStripIndicatorScope } from "@/components/layout/tabs/tab-strip-indicator-scope";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { TaskPinnedState } from "@/hooks/epic/use-epic-task-pinned-states-query";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import { installTabSyncCoordinator } from "@/lib/tab-sync/tab-sync-coordinator";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { tabItemId } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";
import {
  __resetAgentActivityStoreForTests,
  __setAgentActivityStateForTests,
} from "@/stores/agent-activity-store";
import { DEFAULT_ARRANGEMENT } from "@/lib/layout/layout-arrangement";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

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

installTabSyncCoordinator({ readyPromise: Promise.resolve() });

const STRIP_WIDTH = 240;
const STRIP_HEIGHT = 600;
const ROW_HEIGHT = 32;
/** A row and the 2px gap under it. */
const ROW_PITCH = 34;
const IN_BAND = STRIP_WIDTH / 2;
/** More than 24px past a left strip's band, into the content. */
const INTO_CONTENT = STRIP_WIDTH + 30;

const ALPHA: TabRef = { kind: "epic", id: "e-alpha" };
const REFS: ReadonlyArray<TabRef> = [
  ALPHA,
  { kind: "epic", id: "e-beta" },
  { kind: "epic", id: "e-gamma" },
];

function seedTabs(): void {
  for (const ref of REFS) {
    const name = ref.id.slice(2);
    useEpicCanvasStore.getState().seedEpic(ref.id, { tabId: ref.id, name }, []);
  }
  useTabsStore.setState({
    version: 2,
    items: REFS.map((ref) => ({ kind: "tab", id: tabItemId(ref), ref })),
    activeItemId: tabItemId(ALPHA),
    stripOrder: REFS,
    systemTabs: { history: null, settings: null },
  });
}

/**
 * The scroller at (0, 0, 240, 600); the n-th strip frame at (0, 34n, 240, 32),
 * and every element inside a frame at its frame's box.
 */
function installStripGeometry(): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement): DOMRect {
      if (this.getAttribute("data-testid") === HEADER_STRIP_SCROLL_TEST_ID) {
        return new DOMRect(0, 0, STRIP_WIDTH, STRIP_HEIGHT);
      }
      // jsdom lays nothing out: every element outside a frame is a zero box.
      const frame = this.closest("[data-strip-item-id]");
      const scroller =
        frame === null
          ? null
          : frame.closest(`[data-testid="${HEADER_STRIP_SCROLL_TEST_ID}"]`);
      if (frame === null || scroller === null) {
        return new DOMRect(0, 0, 0, 0);
      }
      const index = [
        ...scroller.querySelectorAll("[data-strip-item-id]"),
      ].indexOf(frame);
      return new DOMRect(0, ROW_PITCH * index, STRIP_WIDTH, ROW_HEIGHT);
    },
  );
}

/** The row list under the scopes `SideTabStrip` mounts it in. */
function SideStripHost(): ReactNode {
  const controller = useTabStripController();
  return (
    <>
      <StripNeedsYouScope controller={controller}>
        <TabStripIndicatorScope indicators={controller.indicators}>
          <StripSectionsScope controller={controller}>
            <SideStripRowList
              controller={controller}
              edge="left"
              variant="expanded"
            />
          </StripSectionsScope>
        </TabStripIndicatorScope>
      </StripNeedsYouScope>
      {controller.dialogs}
    </>
  );
}

async function mountSideStrip(): Promise<void> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <RootDndProvider>
            <SideStripHost />
          </RootDndProvider>
        </TooltipProvider>
      </QueryClientProvider>
    ),
  });
  const elsewhere = createRoute({
    getParentRoute: () => rootRoute,
    path: "/elsewhere",
    component: () => null,
  });
  const epicTabRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/epics/$epicId/$tabId",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([elsewhere, epicTabRoute]),
    history: createMemoryHistory({ initialEntries: ["/elsewhere"] }),
  });
  await act(async () => {
    render(<RouterProvider router={router} />);
    await router.load();
  });
  await screen.findByTestId("tab-epic-e-alpha");
}

interface RowDrag {
  readonly source: HTMLElement;
  readonly pointerId: number;
}

/**
 * Presses the row drawn `index`th from the top at its centre and crosses the
 * activation distance on y.
 */
function pressRow(testId: string, index: number, pointerId: number): RowDrag {
  const source = screen.getByTestId(testId);
  const centre = ROW_PITCH * index + ROW_HEIGHT / 2;
  act(() => {
    fireEvent.pointerDown(source, {
      pointerId,
      isPrimary: true,
      button: 0,
      clientX: IN_BAND,
      clientY: centre,
    });
  });
  act(() => {
    fireEvent.pointerMove(source, {
      pointerId,
      clientX: IN_BAND,
      clientY: centre + EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE + 1,
    });
  });
  return { source, pointerId };
}

function moveTo(drag: RowDrag, x: number, y: number): void {
  act(() => {
    fireEvent.pointerMove(drag.source, {
      pointerId: drag.pointerId,
      clientX: x,
      clientY: y,
    });
  });
}

function releaseAt(drag: RowDrag, x: number, y: number): void {
  act(() => {
    fireEvent.pointerUp(drag.source, {
      pointerId: drag.pointerId,
      clientX: x,
      clientY: y,
    });
  });
}

describe("SideStripRowList under RootDndProvider", () => {
  beforeEach(() => {
    __resetTabNavigationControllerForTesting();
    resetTabDetachHandler();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    seedTabs();
    installStripGeometry();
  });

  afterEach(() => {
    cleanup();
    resetTabDetachHandler();
    vi.restoreAllMocks();
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("reorders a row along y with the side row as the drag overlay", async () => {
    await mountSideStrip();

    const drag = pressRow("tab-epic-e-alpha", 0, 1);
    // The dragged centre (grab offset 16) passes Gamma's centre at 84.
    moveTo(drag, IN_BAND, 120);

    const overlay = screen.getByTestId("header-tab-drag-overlay");
    expect(overlay.querySelector("[data-side-tab]")).not.toBeNull();

    releaseAt(drag, IN_BAND, 120);
    expect(useTabsStore.getState().stripOrder.map((ref) => ref.id)).toEqual([
      "e-beta",
      "e-gamma",
      "e-alpha",
    ]);
  });

  it("tears a row off when it is pulled sideways into the content", async () => {
    const requestOpen = vi.fn();
    publishTabDetachHandler({ isAvailable: true, requestOpen });
    await mountSideStrip();

    const drag = pressRow("tab-epic-e-alpha", 0, 2);
    moveTo(drag, INTO_CONTENT, ROW_HEIGHT / 2);
    releaseAt(drag, INTO_CONTENT, ROW_HEIGHT / 2);

    expect(requestOpen).toHaveBeenCalledTimes(1);
    expect(requestOpen.mock.calls[0]?.[0]).toMatchObject({ id: "e-alpha" });
  });
});

/**
 * The Activity view lists Alpha (running) under Working and Beta and Gamma
 * under Idle, so a drag moves a row among its own section's rows and the order
 * it writes is the strip's own.
 */
describe("SideStripRowList sections under RootDndProvider", () => {
  beforeEach(() => {
    __resetTabNavigationControllerForTesting();
    resetTabDetachHandler();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    seedTabs();
    installStripGeometry();
    useLayoutStore.setState({
      ...DEFAULT_LAYOUT_SNAPSHOT,
      arrangement: {
        ...DEFAULT_ARRANGEMENT,
        tabStripPlacement: "left",
        sideStripView: "activity",
      },
    });
    __setAgentActivityStateForTests(
      { "e-alpha": { working: ["chat-1"], turn: ["chat-1"] } },
      "local",
      "connected",
    );
  });

  afterEach(() => {
    cleanup();
    resetTabDetachHandler();
    vi.restoreAllMocks();
    __resetAgentActivityStoreForTests();
    useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  const stripOrder = (): ReadonlyArray<string> =>
    useTabsStore.getState().stripOrder.map((ref) => ref.id);

  it("reorders a row among its own section's rows, writing the strip's order", async () => {
    await mountSideStrip();

    // Gamma is drawn third, under Idle; its centre passes Beta's going up.
    const drag = pressRow("tab-epic-e-gamma", 2, 1);
    moveTo(drag, IN_BAND, 40);

    const beta = screen
      .getByTestId("tab-epic-e-beta")
      .closest("[data-strip-item-id]");
    expect(
      beta?.querySelector('[data-testid="tab-drop-indicator"]'),
    ).not.toBeNull();
    const alpha = screen
      .getByTestId("tab-epic-e-alpha")
      .closest("[data-strip-item-id]");
    expect(
      alpha?.querySelector('[data-testid="tab-drop-indicator"]'),
    ).toBeNull();

    releaseAt(drag, IN_BAND, 40);
    expect(stripOrder()).toEqual(["e-alpha", "e-gamma", "e-beta"]);
  });

  it("offers no drop outside the dragged row's section, however far it is pulled", async () => {
    await mountSideStrip();

    // Beta pulled up over Alpha, which is in Working: Beta stays in Idle.
    const drag = pressRow("tab-epic-e-beta", 1, 1);
    moveTo(drag, IN_BAND, 5);

    expect(screen.queryByTestId("tab-drop-indicator")).toBeNull();

    releaseAt(drag, IN_BAND, 5);
    expect(stripOrder()).toEqual(["e-alpha", "e-beta", "e-gamma"]);
  });
});
