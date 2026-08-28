/**
 * T9 round-4 real-wiring coverage. Round 1-3 caught divider/chooser/pair/
 * DnD bugs whose retained tests only exercised helpers and pure machines
 * (`resolveValidatedTopLevelTabDrop`) directly - hiding regressions in the
 * actual `RootDndProvider` wiring (the DnD commit's activation seam). These
 * tests mount the REAL `RootDndProvider` and drive a real dnd-kit pointer
 * gesture (pointerdown -> activation-distance move -> hover -> drop) against
 * real draggable/droppable payload shapes, so a mutation at the wiring layer -
 * not just the pure helpers - turns them red.
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
  HEADER_TAB_SLOT_DND_TYPE,
  getHeaderStripItemSlotDropId,
  type HeaderTabSlotDropData,
} from "@/components/layout/tabs/header-tab-dnd";
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
