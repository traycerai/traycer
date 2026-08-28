/**
 * T9 round-4 real-wiring coverage. Round 1-3 caught divider/chooser/pair/
 * DnD bugs whose retained tests only exercised helpers and pure machines
 * (`resolveValidatedTopLevelTabDrop`, `EdgeSplitDwellMachine`) directly -
 * hiding regressions in the actual `RootDndProvider` wiring (the dwell
 * revalidation subscriptions, the DnD commit's activation seam). These
 * tests mount the REAL `RootDndProvider` and drive a real dnd-kit pointer
 * gesture (pointerdown -> activation-distance move -> hover -> dwell ->
 * drop) against real draggable/droppable payload shapes, so a mutation at
 * the wiring layer - not just the pure helpers - turns them red.
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
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { RootDndProvider } from "@/components/epic-canvas/dnd/root-dnd-provider";
import { useEpicDndStore } from "@/components/epic-canvas/dnd/dnd-store";
import {
  ARTIFACT_TAB_DND_TYPE,
  getArtifactTabDragId,
  type EpicCanvasArtifactTabDragData,
} from "@/components/epic-canvas/dnd/dnd";
import {
  HEADER_TAB_DND_TYPE,
  HEADER_TAB_SLOT_DND_TYPE,
  getHeaderTabDragId,
  getHeaderStripItemSlotDropId,
  type HeaderTabDragData,
  type HeaderTabSlotDropData,
} from "@/components/layout/tabs/header-tab-dnd";
import {
  TOP_LEVEL_EDGE_SPLIT_TARGET,
  edgeSplitDropId,
  type TopLevelEdgeSplitTarget,
} from "@/components/layout/tabs/top-level-tab-dnd";
import { EDGE_SPLIT_DWELL_MS } from "@/components/layout/tabs/edge-split-dwell";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import type { TabRef } from "@/stores/tabs/types";

const SOURCE: TabRef = { kind: "draft", id: "source" };
const TARGET: TabRef = { kind: "epic", id: "target" };
const UNRELATED: TabRef = { kind: "draft", id: "unrelated-x" };
const SPLIT_ID = "split-source-target";
const TILE: EpicNodeRef = {
  id: "spec-in-task",
  instanceId: "spec-in-task-instance",
  type: "spec",
  name: "Spec in task",
  hostId: "host-a",
};

function rect(left: number, top: number, right: number, bottom: number) {
  return {
    x: left,
    y: top,
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({}),
  };
}

/** Mirrors `tab-strip-item.tsx`'s real draggable wiring - same id/data shape. */
function TestDragSource(): ReactNode {
  const dragData: HeaderTabDragData = {
    kind: HEADER_TAB_DND_TYPE,
    stripItemId: `tab:${SOURCE.kind}:${SOURCE.id}`,
    tabKind: SOURCE.kind,
    tabId: SOURCE.id,
    index: 0,
  };
  const { listeners, setNodeRef } = useDraggable({
    id: getHeaderTabDragId(SOURCE.kind, SOURCE.id),
    data: dragData,
  });
  return (
    <button ref={setNodeRef} data-testid="drag-source" {...listeners}>
      drag
    </button>
  );
}

/** Mirrors `top-level-tab-host.tsx`'s `TopLevelEdgeSplitTargets` left slot. */
function TestEdgeDropTarget(): ReactNode {
  const data: TopLevelEdgeSplitTarget = {
    kind: TOP_LEVEL_EDGE_SPLIT_TARGET,
    targetRef: TARGET,
    side: "left",
  };
  const { setNodeRef } = useDroppable({
    id: edgeSplitDropId(TARGET, "left"),
    data,
  });
  return <div ref={setNodeRef} data-testid="edge-drop-target" />;
}

function TestCanvasTabDragSource(props: {
  readonly data: EpicCanvasArtifactTabDragData;
}): ReactNode {
  const { listeners, setNodeRef } = useDraggable({
    id: getArtifactTabDragId(props.data.sourceGroupId, props.data.tabId),
    data: props.data,
  });
  return (
    <button
      ref={setNodeRef}
      data-testid="canvas-tab-drag-source"
      {...listeners}
    >
      canvas tab
    </button>
  );
}

function TestSplitGroupHeaderDropTarget(): ReactNode {
  const data: HeaderTabSlotDropData = {
    kind: HEADER_TAB_SLOT_DND_TYPE,
    index: 0,
    isTrailing: false,
  };
  const { setNodeRef } = useDroppable({
    id: getHeaderStripItemSlotDropId(SPLIT_ID),
    data,
  });
  return <div ref={setNodeRef} data-testid="split-group-header-drop-target" />;
}

/**
 * The root DnD provider reads the app's query client (an RPC-committed
 * sidebar reparent invalidates the moved row's record query), so the harness
 * supplies one the way the app shell does.
 */
const queryClient = new QueryClient();

function Harness(): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <RootDndProvider>
        <TestDragSource />
        <TestEdgeDropTarget />
      </RootDndProvider>
    </QueryClientProvider>
  );
}

function CanvasTearOffHarness(props: {
  readonly source: EpicCanvasArtifactTabDragData;
}): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <RootDndProvider>
        <TestCanvasTabDragSource data={props.source} />
        <TestSplitGroupHeaderDropTarget />
      </RootDndProvider>
    </QueryClientProvider>
  );
}

function buildRouterWithHarness(initialPath: string, harness: () => ReactNode) {
  const rootRoute = createRootRoute({ component: harness });
  const draftRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/draft/$draftId",
    component: () => <div data-testid="draft-body" />,
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
  const routeTree = rootRoute.addChildren([draftRoute, epicTabRoute]);
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

function buildRouter(initialPath: string) {
  return buildRouterWithHarness(initialPath, Harness);
}

function seedLayout(): void {
  useLandingDraftStore.getState().createDraftWithId(SOURCE.id, null);
  useEpicCanvasStore
    .getState()
    .openEpicTabWithId(TARGET.id, "target-epic", "Target");
  useTabsStore.setState({
    version: 2,
    items: [
      { kind: "tab", id: `tab:${SOURCE.kind}:${SOURCE.id}`, ref: SOURCE },
      { kind: "tab", id: `tab:${TARGET.kind}:${TARGET.id}`, ref: TARGET },
      {
        kind: "tab",
        id: "tab:draft:unrelated-x",
        ref: UNRELATED,
      },
    ],
    activeItemId: `tab:${TARGET.kind}:${TARGET.id}`,
    stripOrder: [SOURCE, TARGET, UNRELATED],
    systemTabs: { history: null, settings: null },
  });
}

function seedCanvasTearOffLayout(): EpicCanvasArtifactTabDragData {
  useLandingDraftStore.getState().createDraftWithId(SOURCE.id, null);
  useLandingDraftStore.getState().createDraftWithId(UNRELATED.id, null);
  useEpicCanvasStore
    .getState()
    .openEpicTabWithId(TARGET.id, "target-epic", "Target");
  useEpicCanvasStore.getState().openTileInTab(TARGET.id, TILE);
  const canvas = useEpicCanvasStore.getState().canvasByTabId[TARGET.id];
  const sourceGroupId = collectPanes(canvas?.root ?? null).at(0)?.id;
  if (sourceGroupId === undefined) throw new Error("Expected source pane");
  useTabsStore.setState({
    version: 2,
    items: [
      {
        kind: "split",
        id: SPLIT_ID,
        left: { kind: "tab", ref: SOURCE },
        right: { kind: "tab", ref: TARGET },
        focusedSide: "right",
        routeBackingSide: "right",
        leftRatio: 0.5,
      },
      {
        kind: "tab",
        id: `tab:${UNRELATED.kind}:${UNRELATED.id}`,
        ref: UNRELATED,
      },
    ],
    activeItemId: SPLIT_ID,
    stripOrder: [SOURCE, TARGET, UNRELATED],
    systemTabs: { history: null, settings: null },
  });
  return {
    kind: ARTIFACT_TAB_DND_TYPE,
    epicId: "target-epic",
    viewTabId: TARGET.id,
    sourceGroupId,
    tabId: TILE.instanceId,
    isPreview: false,
  };
}

/**
 * Builds the router, renders the harness, and awaits both the drag source
 * and edge drop target being mounted.
 */
async function renderHarness(initialPath: string) {
  const router = buildRouter(initialPath);
  render(<RouterProvider router={router} />);
  const source = await screen.findByTestId("drag-source");
  const target = await screen.findByTestId("edge-drop-target");
  return { router, source, target };
}

/**
 * Drives the real pointer sensor through activation + hover onto the edge
 * target, then waits out the dwell so the machine reaches "preview" and
 * publishes it to `useEpicDndStore`.
 */
function armAndPreview(source: HTMLElement, target: HTMLElement): void {
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue(
    rect(200, 0, 400, 50),
  );

  act(() => {
    fireEvent.pointerDown(source, {
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: 10,
      clientY: 10,
    });
  });
  // Cross the 5px activation distance - this pointermove only activates the
  // sensor (no `onMove` for this same event), so it does not yet resolve a
  // collision.
  act(() => {
    fireEvent.pointerMove(source, { pointerId: 1, clientX: 30, clientY: 10 });
  });
  // Now hover into the target's rect - this is the move that resolves a
  // collision and feeds `edgeDwell.observe`.
  act(() => {
    fireEvent.pointerMove(source, {
      pointerId: 1,
      clientX: 300,
      clientY: 10,
    });
  });
  expect(EDGE_SPLIT_DWELL_MS).toBe(400);
  act(() => {
    vi.advanceTimersByTime(EDGE_SPLIT_DWELL_MS);
  });
}

describe("T9 round-4: RootDndProvider real wiring", () => {
  beforeEach(() => {
    __resetTabNavigationControllerForTesting();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    useEpicDndStore.setState({ topLevelEdgeSplitPreview: null });
  });

  it("survives an unrelated concurrent coordinator transaction while the dwell is stationary (MED3)", async () => {
    seedLayout();
    const { source, target } = await renderHarness(
      `/epics/target-epic/${TARGET.id}`,
    );
    vi.useFakeTimers();

    armAndPreview(source, target);
    expect(useEpicDndStore.getState().topLevelEdgeSplitPreview).toEqual({
      kind: TOP_LEVEL_EDGE_SPLIT_TARGET,
      targetRef: TARGET,
      side: "left",
    });

    // An unrelated coordinator transaction: reorder a strip item that has
    // nothing to do with the dragged source or the hovered target. It still
    // fires the mid-transaction suppressed notify + the settled notify every
    // real transaction fires.
    act(() => {
      tabCommandCoordinator.reorderStripItem({
        itemId: "tab:draft:unrelated-x",
        targetIndex: 0,
      });
    });

    expect(useEpicDndStore.getState().topLevelEdgeSplitPreview).toEqual({
      kind: TOP_LEVEL_EDGE_SPLIT_TARGET,
      targetRef: TARGET,
      side: "left",
    });
  });

  it("commits a preview drop through the activation seam - real router navigates to the dragged source (activation-seam)", async () => {
    seedLayout();
    const { router, source, target } = await renderHarness(
      `/epics/target-epic/${TARGET.id}`,
    );
    vi.useFakeTimers();

    armAndPreview(source, target);

    act(() => {
      fireEvent.pointerUp(source, { pointerId: 1, clientX: 300, clientY: 10 });
    });

    const split = useTabsStore
      .getState()
      .items.find((item) => item.kind === "split");
    expect(split).toMatchObject({
      kind: "split",
      left: { kind: "tab", ref: SOURCE },
      right: { kind: "tab", ref: TARGET },
      focusedSide: "left",
    });
    // If the DnD commit were swapped off `activatePreparedPairTabIntent` for
    // a raw `pairTabs` + no navigation, the router would stay on the
    // pre-drag route: this assertion is the real-callsite discriminator.
    expect(router.state.location.pathname).toBe(`/draft/${SOURCE.id}`);
  });

  it("tears an in-task tile tab onto the main strip beside a split group", async () => {
    const dragData = seedCanvasTearOffLayout();
    const router = buildRouterWithHarness(
      `/epics/target-epic/${TARGET.id}`,
      () => <CanvasTearOffHarness source={dragData} />,
    );
    render(<RouterProvider router={router} />);
    const source = await screen.findByTestId("canvas-tab-drag-source");
    const target = await screen.findByTestId("split-group-header-drop-target");
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(
      rect(200, 0, 400, 50),
    );

    act(() => {
      fireEvent.pointerDown(source, {
        pointerId: 2,
        isPrimary: true,
        button: 0,
        clientX: 10,
        clientY: 10,
      });
      fireEvent.pointerMove(source, {
        pointerId: 2,
        clientX: 30,
        clientY: 10,
      });
      fireEvent.pointerMove(source, {
        pointerId: 2,
        clientX: 350,
        clientY: 10,
      });
    });
    expect(useEpicDndStore.getState().headerStripDropIndex).toBe(1);

    act(() => {
      fireEvent.pointerUp(source, {
        pointerId: 2,
        clientX: 350,
        clientY: 10,
      });
    });

    const items = useTabsStore.getState().items;
    expect(items.map((item) => item.kind)).toEqual(["split", "tab", "tab"]);
    expect(items[0]?.id).toBe(SPLIT_ID);
    expect(items[2]).toMatchObject({ kind: "tab", ref: UNRELATED });
    const duplicated = items[1];
    if (duplicated.kind !== "tab" || duplicated.ref.kind !== "epic") {
      throw new Error("Expected duplicated task beside the split group");
    }
    expect(duplicated.ref.id).not.toBe(TARGET.id);
    expect(
      useEpicCanvasStore.getState().tabsById[duplicated.ref.id]?.epicId,
    ).toBe("target-epic");
    expect(router.state.location.pathname).toBe(
      `/epics/target-epic/${duplicated.ref.id}`,
    );
  });

  // KEEP LAST: `installSourceReconciliation` subscribes the module-singleton
  // coordinator to the source stores and cannot be uninstalled, so it must
  // not run before the tests above.
  it("keeps the authoritative split when legacy stripOrder is stale during a tear-off", async () => {
    const dragData = seedCanvasTearOffLayout();
    // Production wiring: the source-store subscriber runs SYNCHRONOUSLY
    // between the drop's source mutation and its placement unless both live
    // in one suppressed coordinator transaction.
    tabCommandCoordinator.installSourceReconciliation();
    // A legacy flat caller re-seeding `stripOrder` directly is a supported
    // compatibility write. Only source-store changes trigger reconciliation,
    // so the projection stays stale until the next coordinator entry - which
    // must resolve against the authoritative grouped items, not rebuild the
    // flat order and dissolve the split.
    useTabsStore.setState((state) => ({ ...state, stripOrder: [] }));

    const router = buildRouterWithHarness(
      `/epics/target-epic/${TARGET.id}`,
      () => <CanvasTearOffHarness source={dragData} />,
    );
    render(<RouterProvider router={router} />);
    const source = await screen.findByTestId("canvas-tab-drag-source");
    const target = await screen.findByTestId("split-group-header-drop-target");
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(
      rect(200, 0, 400, 50),
    );

    act(() => {
      fireEvent.pointerDown(source, {
        pointerId: 3,
        isPrimary: true,
        button: 0,
        clientX: 10,
        clientY: 10,
      });
      fireEvent.pointerMove(source, {
        pointerId: 3,
        clientX: 30,
        clientY: 10,
      });
      fireEvent.pointerMove(source, {
        pointerId: 3,
        clientX: 350,
        clientY: 10,
      });
    });

    act(() => {
      fireEvent.pointerUp(source, {
        pointerId: 3,
        clientX: 350,
        clientY: 10,
      });
    });

    const items = useTabsStore.getState().items;
    expect(items.map((item) => item.kind)).toEqual(["split", "tab", "tab"]);
    expect(items[0]).toMatchObject({
      kind: "split",
      id: SPLIT_ID,
      left: { kind: "tab", ref: SOURCE },
      right: { kind: "tab", ref: TARGET },
    });
    const duplicated = items[1];
    if (duplicated.kind !== "tab" || duplicated.ref.kind !== "epic") {
      throw new Error("Expected duplicated task beside the split group");
    }
    expect(duplicated.ref.id).not.toBe(TARGET.id);
    expect(
      useEpicCanvasStore.getState().tabsById[duplicated.ref.id]?.epicId,
    ).toBe("target-epic");
  });
});
