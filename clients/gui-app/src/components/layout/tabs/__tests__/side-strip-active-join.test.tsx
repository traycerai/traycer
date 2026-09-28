/**
 * Integrated regression for the side strip's sheet join and the header-only
 * drag overlay portal, driven against the real `SideStripRowList`/
 * `SideTabItem` chain under a real `RootDndProvider` gesture (cloned harness
 * from `side-strip-row-list-dnd.test.tsx`, plus a `ColumnEdgeContext` and the
 * `[data-strip-drag-overlay-host]` marker that file doesn't need). Proves the
 * dragged active row's join moves onto its overlay while its hidden strip
 * source relinquishes it, and that only a header-tab drag portals into the
 * strip's own host div.
 */
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useDraggable } from "@dnd-kit/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { ColumnEdgeContext } from "@/components/layout/column-edge-context";
import { RootDndProvider } from "@/components/epic-canvas/dnd/root-dnd-provider";
import { EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE } from "@/components/epic-canvas/dnd/epic-canvas-pointer-sensor";
import {
  ARTIFACT_TAB_DND_TYPE,
  getArtifactTabDragId,
  type EpicCanvasArtifactTabDragData,
} from "@/components/epic-canvas/dnd/dnd";
import { SheetJoinBridge } from "@/components/layout/tabs/sheet-join";
import { SideStripRowList } from "@/components/layout/tabs/side-strip/side-strip-row-list";
import { resetTabDetachHandler } from "@/components/layout/tabs/tab-detach-channel";
import { useTabStripController } from "@/components/layout/tabs/tab-strip-controller";
import { TabStripIndicatorScope } from "@/components/layout/tabs/tab-strip-indicator-scope";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { TaskPinnedState } from "@/hooks/epic/use-epic-task-pinned-states-query";
import { DEFAULT_ARRANGEMENT } from "@/lib/layout/layout-arrangement";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import { installTabSyncCoordinator } from "@/lib/tab-sync/tab-sync-coordinator";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import { tabItemId } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";

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

const ALPHA: TabRef = { kind: "epic", id: "e-alpha" };
const BETA: TabRef = { kind: "epic", id: "e-beta" };
const REFS: ReadonlyArray<TabRef> = [ALPHA, BETA];

const GAMMA: TabRef = { kind: "epic", id: "e-gamma" };
const DELTA: TabRef = { kind: "epic", id: "e-delta" };
const SPLIT_ID = "split-gd";

function seedEpicRef(ref: TabRef): void {
  const name = ref.id.slice(2);
  useEpicCanvasStore.getState().seedEpic(ref.id, { tabId: ref.id, name }, []);
}

function seedTabs(): void {
  for (const ref of REFS) seedEpicRef(ref);
  useTabsStore.setState({
    version: 2,
    items: REFS.map((ref) => ({ kind: "tab", id: tabItemId(ref), ref })),
    activeItemId: tabItemId(ALPHA),
    stripOrder: REFS,
    systemTabs: { history: null, settings: null },
  });
}

/** ALPHA active and alone; GAMMA/DELTA sit in an inactive split. */
function seedTabsWithInactiveSplit(): void {
  for (const ref of [ALPHA, GAMMA, DELTA]) seedEpicRef(ref);
  useTabsStore.setState({
    version: 2,
    items: [
      { kind: "tab", id: tabItemId(ALPHA), ref: ALPHA },
      {
        kind: "split",
        id: SPLIT_ID,
        left: { kind: "tab", ref: GAMMA },
        right: { kind: "tab", ref: DELTA },
        focusedSide: "left",
        routeBackingSide: "left",
        leftRatio: 0.5,
      },
    ],
    activeItemId: tabItemId(ALPHA),
    stripOrder: [ALPHA, GAMMA, DELTA],
    systemTabs: { history: null, settings: null },
  });
}

/** Every row (or split pair) currently wearing the sheet join, strip-wide. */
function joinedElements(): ReadonlyArray<Element> {
  return [...document.querySelectorAll("[data-sheet-joined]")];
}

/** The strip's one bridge: active while any joined row or overlay publishes. */
function joinBridge(): Element {
  const bridge = document.querySelector('[data-sheet-join-bridge="left"]');
  if (bridge === null) throw new Error("Expected the join bridge");
  return bridge;
}

/** A minimal non-header draggable: a canvas tile tab, like a real tear-off source. */
function CanvasTabSource(props: {
  readonly data: EpicCanvasArtifactTabDragData;
}): ReactNode {
  const { listeners, setNodeRef } = useDraggable({
    id: getArtifactTabDragId(props.data.sourceGroupId, props.data.tabId),
    data: props.data,
  });
  return (
    <button ref={setNodeRef} data-testid="canvas-tab-source" {...listeners}>
      canvas tab
    </button>
  );
}

const CANVAS_TARGET: TabRef = { kind: "epic", id: "canvas-target" };
const CANVAS_TILE: EpicNodeRef = {
  id: "spec-in-task",
  instanceId: "spec-in-task-instance",
  type: "spec",
  name: "Spec in task",
  hostId: "host-a",
};

/** Seeds a second, unrelated canvas tab with one tile, for the canvas-drag case. */
function seedCanvasSource(): EpicCanvasArtifactTabDragData {
  useEpicCanvasStore
    .getState()
    .openEpicTabWithId(CANVAS_TARGET.id, "canvas-target-epic", "Target");
  useEpicCanvasStore.getState().openTileInTab(CANVAS_TARGET.id, CANVAS_TILE);
  const canvas = useEpicCanvasStore.getState().canvasByTabId[CANVAS_TARGET.id];
  const sourceGroupId = collectPanes(canvas?.root ?? null).at(0)?.id;
  if (sourceGroupId === undefined) throw new Error("Expected source pane");
  return {
    kind: ARTIFACT_TAB_DND_TYPE,
    epicId: "canvas-target-epic",
    viewTabId: CANVAS_TARGET.id,
    sourceGroupId,
    tabId: CANVAS_TILE.instanceId,
    isPreview: false,
  };
}

/**
 * The real row list plus the two things only the full `SideTabStrip` would
 * otherwise supply: the edge context `useSideTabJoin` reads, and the portal
 * host `RootDndProvider` looks for.
 */
function SideStripHost(props: {
  readonly canvasSource: EpicCanvasArtifactTabDragData | undefined;
}): ReactNode {
  const controller = useTabStripController();
  return (
    <ColumnEdgeContext.Provider value="left">
      {props.canvasSource === undefined ? null : (
        <CanvasTabSource data={props.canvasSource} />
      )}
      <TabStripIndicatorScope indicators={controller.indicators}>
        <SideStripRowList
          controller={controller}
          edge="left"
          variant="expanded"
        />
      </TabStripIndicatorScope>
      <div
        data-strip-drag-overlay-host
        data-testid="side-overlay-host"
        className="contents"
      />
      {/* In `RootDndProvider`'s join scope, like the real strip's bridge. */}
      <SheetJoinBridge edge="left" />
      {controller.dialogs}
    </ColumnEdgeContext.Provider>
  );
}

async function mountSideStrip(
  canvasSource: EpicCanvasArtifactTabDragData | undefined,
): Promise<void> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <RootDndProvider>
            <SideStripHost canvasSource={canvasSource} />
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

interface Drag {
  readonly source: HTMLElement;
  readonly pointerId: number;
}

/** Presses `source` at y=16 and crosses the activation distance on y. */
function pressAndActivate(source: HTMLElement, pointerId: number): Drag {
  act(() => {
    fireEvent.pointerDown(source, {
      pointerId,
      isPrimary: true,
      button: 0,
      clientX: 0,
      clientY: 16,
    });
  });
  act(() => {
    fireEvent.pointerMove(source, {
      pointerId,
      clientX: 0,
      clientY: 16 + EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE + 1,
    });
  });
  return { source, pointerId };
}

function releaseAt(drag: Drag, y: number): void {
  act(() => {
    fireEvent.pointerUp(drag.source, {
      pointerId: drag.pointerId,
      clientX: 0,
      clientY: y,
    });
  });
}

describe("side strip: sheet join and the header-overlay portal under a real drag", () => {
  beforeEach(() => {
    __resetTabNavigationControllerForTesting();
    resetTabDetachHandler();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    // The drag overlay resolves its OWN edge from the stored arrangement
    // (`useTabStripPlacement`), not from this harness's `ColumnEdgeContext` -
    // that context only reaches the strip's own rows. Match the strip's
    // "left" edge here too, or the overlay's `useSideTabJoin` sees a null
    // edge and never joins regardless of active state.
    useLayoutStore.setState({
      ...DEFAULT_LAYOUT_SNAPSHOT,
      arrangement: { ...DEFAULT_ARRANGEMENT, tabStripPlacement: "left" },
    });
    seedTabs();
  });

  afterEach(() => {
    cleanup();
    resetTabDetachHandler();
    vi.restoreAllMocks();
    useLayoutStore.setState({
      ...DEFAULT_LAYOUT_SNAPSHOT,
    });
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("moves the join onto the overlay for a dragged active row, off the hidden source", async () => {
    await mountSideStrip(undefined);
    const alpha = screen.getByTestId("tab-epic-e-alpha");
    const drag = pressAndActivate(alpha, 2);

    const overlayRow = screen
      .getByTestId("header-tab-drag-overlay")
      .querySelector("[data-side-tab]");
    expect(overlayRow).not.toBeNull();
    expect(overlayRow?.hasAttribute("data-sheet-joined")).toBe(true);
    // The source row itself is still in the DOM (opacity-0), and it is the
    // one actually being dragged - it relinquishes the join.
    expect(alpha.hasAttribute("data-sheet-joined")).toBe(false);
    // Once the source has un-joined and the overlay joined, the bridge is
    // active and carries the overlay's pane.
    expect(joinBridge().hasAttribute("data-join-active")).toBe(true);
    expect(joinBridge().getAttribute("data-join-pane")).toBe(
      overlayRow?.getAttribute("data-join-pane"),
    );

    releaseAt(drag, 16 + EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE + 1);

    // The overlay's cleanup hands the bridge back to the source row: once the
    // drop settles the row is joined again and the bridge names its pane.
    await waitFor(() => {
      expect(alpha.hasAttribute("data-sheet-joined")).toBe(true);
    });
    expect(joinBridge().hasAttribute("data-join-active")).toBe(true);
    expect(joinBridge().getAttribute("data-join-pane")).toBe(
      alpha.getAttribute("data-join-pane"),
    );
  });

  it("auto-activates an inactive dragged lone row and keeps exactly one joined row at every step", async () => {
    await mountSideStrip(undefined);
    const alpha = screen.getByTestId("tab-epic-e-alpha");
    const beta = screen.getByTestId("tab-epic-e-beta");

    // Before drag: ALPHA is the sole active tab and the sole join.
    expect(joinedElements()).toEqual([alpha]);
    expect(joinBridge().hasAttribute("data-join-active")).toBe(true);

    const drag = pressAndActivate(beta, 6);

    // The real `useStripTabItem` pickup effect activates BETA the instant the
    // drag crosses the activation distance (chrome selects on pickup, not
    // release). That flips `activeItemId` synchronously, which the overlay's
    // and every row's `isActive` selectors read live - so the join must have
    // already moved: onto BETA's overlay row, off BETA's own now-dragging
    // source, and off ALPHA now that it is no longer active. Exactly one
    // joined element throughout, never zero and never two.
    const overlayRow = screen
      .getByTestId("header-tab-drag-overlay")
      .querySelector("[data-side-tab]");
    expect(overlayRow).not.toBeNull();
    expect(joinedElements()).toEqual([overlayRow]);
    expect(beta.hasAttribute("data-sheet-joined")).toBe(false);
    expect(alpha.hasAttribute("data-sheet-joined")).toBe(false);
    // After ALPHA, BETA's source and BETA's overlay have settled, the bridge
    // is active for the overlay's join.
    expect(joinBridge().hasAttribute("data-join-active")).toBe(true);

    releaseAt(drag, 16 + EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE + 1);
  });

  it("auto-activates an inactive dragged split member and keeps exactly one joined pair/row at every step", async () => {
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    seedTabsWithInactiveSplit();
    await mountSideStrip(undefined);
    const alpha = screen.getByTestId("tab-epic-e-alpha");
    const gamma = screen.getByTestId("tab-epic-e-gamma");
    const splitPair = screen.getByTestId(`split-tab-group-${SPLIT_ID}`);

    // Before drag: ALPHA is active and alone; the (inactive) split has no join.
    expect(joinedElements()).toEqual([alpha]);
    expect(splitPair.hasAttribute("data-sheet-joined")).toBe(false);

    const drag = pressAndActivate(gamma, 7);

    // Picking up GAMMA (a split member) activates the whole split via the
    // same production pickup effect. The join moves to the split's overlay
    // pair, off the source pair (now dragging) and off ALPHA. A split's join
    // lives on the PAIR frame, not the member row - GAMMA's own row never
    // carries the attribute, joined or not.
    const overlayPair = screen.getByTestId(
      `split-tab-group-overlay-${SPLIT_ID}`,
    );
    expect(joinedElements()).toEqual([overlayPair]);
    expect(splitPair.hasAttribute("data-sheet-joined")).toBe(false);
    expect(gamma.hasAttribute("data-sheet-joined")).toBe(false);
    expect(alpha.hasAttribute("data-sheet-joined")).toBe(false);

    releaseAt(drag, 16 + EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE + 1);
  });

  it("portals a header row's drag overlay into the strip's own host", async () => {
    await mountSideStrip(undefined);
    const alpha = screen.getByTestId("tab-epic-e-alpha");
    const drag = pressAndActivate(alpha, 3);

    const host = screen.getByTestId("side-overlay-host");
    const marker = screen.getByTestId("drag-overlay-marker");
    expect(host.contains(marker)).toBe(true);

    releaseAt(drag, 16 + EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE + 1);
  });

  it("never portals a canvas tab's drag overlay, even with the host mounted", async () => {
    const source = seedCanvasSource();
    await mountSideStrip(source);
    const canvasSource = screen.getByTestId("canvas-tab-source");
    const host = screen.getByTestId("side-overlay-host");

    // Forces the host resolution to engage with a real header-tab pickup
    // before the canvas-only check below.
    const alpha = screen.getByTestId("tab-epic-e-alpha");
    const headerDrag = pressAndActivate(alpha, 5);
    expect(host.contains(screen.getByTestId("drag-overlay-marker"))).toBe(true);
    releaseAt(headerDrag, 16 + EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE + 1);

    act(() => {
      fireEvent.pointerDown(canvasSource, {
        pointerId: 4,
        isPrimary: true,
        button: 0,
        clientX: 0,
        clientY: 0,
      });
    });
    act(() => {
      fireEvent.pointerMove(canvasSource, {
        pointerId: 4,
        clientX: EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE + 1,
        clientY: 0,
      });
    });

    // Must have returned to root after the header drag above, not retained
    // it - a canvas drag never portals into the strip's own host.
    expect(
      host.querySelector('[data-testid="drag-overlay-marker"]'),
    ).toBeNull();
    expect(screen.getAllByTestId("drag-overlay-marker")).toHaveLength(1);

    act(() => {
      fireEvent.pointerUp(canvasSource, {
        pointerId: 4,
        clientX: EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE + 1,
        clientY: 0,
      });
    });
  });
});
