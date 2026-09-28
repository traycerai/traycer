/**
 * The real `RootDndProvider` driving a VERTICAL header strip: a scroller that
 * declares `data-strip-axis="y"` and a side edge, with stubbed rects (jsdom
 * measures zeros). Reorder and merge resolve on y, a split item drags as one
 * row pair, tear-off means pulling sideways into the content, and a canvas tab
 * dropped on a row splits that row on its y midpoint.
 */
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  type RenderResult,
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
import { EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE } from "@/components/epic-canvas/dnd/epic-canvas-pointer-sensor";
import type { StripEdge } from "@/components/epic-canvas/dnd/strip-axis";
import {
  HEADER_TAB_DND_TYPE,
  HEADER_TAB_SLOT_DND_TYPE,
  getHeaderStripItemSlotDropId,
  getHeaderTabDragId,
  type HeaderTabDragData,
  type HeaderTabSlotDropData,
} from "@/components/layout/tabs/header-tab-dnd";
import { HEADER_STRIP_SCROLL_TEST_ID } from "@/components/layout/tabs/header-strip-geometry";
import {
  publishTabDetachHandler,
  resetTabDetachHandler,
} from "@/components/layout/tabs/tab-detach-channel";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";

// Keep host notification RPCs outside the drag harness.
vi.mock("@/hooks/notifications/use-host-notification-indicators-query", () => ({
  useHostNotificationIndicators: () => ({
    data: { epics: {}, chats: {} },
    isPending: false,
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(),
  }),
}));

const A: TabRef = { kind: "epic", id: "row-a" };
const B: TabRef = { kind: "epic", id: "row-b" };
const X: TabRef = { kind: "epic", id: "row-x" };
const Y: TabRef = { kind: "epic", id: "row-y" };
const C: TabRef = { kind: "epic", id: "row-c" };
const SPLIT_ID = "split:rows-x-y";

const itemIdOf = (ref: TabRef): string => `tab:${ref.kind}:${ref.id}`;

interface Row {
  readonly stripItemId: string;
  /** The ref the drag payload names; a split names its left member. */
  readonly ref: TabRef;
  readonly top: number;
  readonly height: number;
  readonly mergeable: boolean;
}

/**
 * Four strip items stacked on y with a 2px gap: two 32px rows, a split pair as
 * one 66px item (two rows and their gap), and a last 32px row.
 */
const ROWS: ReadonlyArray<Row> = [
  { stripItemId: itemIdOf(A), ref: A, top: 100, height: 32, mergeable: true },
  { stripItemId: itemIdOf(B), ref: B, top: 134, height: 32, mergeable: true },
  { stripItemId: SPLIT_ID, ref: X, top: 168, height: 66, mergeable: false },
  { stripItemId: itemIdOf(C), ref: C, top: 236, height: 32, mergeable: true },
];

const STRIP_TOP = 100;
const STRIP_HEIGHT = 400;
const STRIP_WIDTH = 240;

/** Cross-axis band of the strip for each side. jsdom's viewport is 1024 wide. */
const BAND: Record<"left" | "right", { readonly start: number }> = {
  left: { start: 0 },
  right: { start: 700 },
};

function rect(left: number, top: number, width: number, height: number) {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  };
}

function StripRow(props: { readonly row: Row; readonly index: number }) {
  const data: HeaderTabDragData = {
    kind: HEADER_TAB_DND_TYPE,
    stripItemId: props.row.stripItemId,
    tabKind: "epic",
    tabId: props.row.ref.id,
    index: props.index,
  };
  const { listeners, setNodeRef } = useDraggable({
    id: getHeaderTabDragId("epic", props.row.ref.id),
    data,
  });
  return (
    <button
      ref={setNodeRef}
      data-strip-item-id={props.row.stripItemId}
      data-strip-item-mergeable={props.row.mergeable ? "true" : "false"}
      data-testid={`row-${props.row.stripItemId}`}
      {...listeners}
    >
      {props.row.stripItemId}
    </button>
  );
}

function VerticalStrip(props: { readonly edge: StripEdge }) {
  return (
    <div
      data-testid={HEADER_STRIP_SCROLL_TEST_ID}
      data-strip-axis="y"
      data-strip-edge={props.edge}
    >
      {ROWS.map((row, index) => (
        <StripRow key={row.stripItemId} row={row} index={index} />
      ))}
    </div>
  );
}

function withRouter(harness: () => ReactNode) {
  const rootRoute = createRootRoute({ component: harness });
  const home = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <div data-testid="route-body" />,
  });
  const epicTabRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/epics/$epicId/$tabId",
    component: () => <div data-testid="epic-tab-body" />,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([home, epicTabRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

function seedVerticalStrip(): void {
  act(() => {
    for (const ref of [A, B, X, Y, C]) {
      useEpicCanvasStore
        .getState()
        .openEpicTabWithId(ref.id, `${ref.id}-epic`, ref.id);
    }
    useTabsStore.setState({
      version: 2,
      items: [
        { kind: "tab", id: itemIdOf(A), ref: A },
        { kind: "tab", id: itemIdOf(B), ref: B },
        {
          kind: "split",
          id: SPLIT_ID,
          left: { kind: "tab", ref: X },
          right: { kind: "tab", ref: Y },
          focusedSide: "left",
          routeBackingSide: "left",
          leftRatio: 0.5,
        },
        { kind: "tab", id: itemIdOf(C), ref: C },
      ],
      activeItemId: itemIdOf(A),
      stripOrder: [A, B, X, Y, C],
      systemTabs: { history: null, settings: null },
    });
  });
}

async function mountVerticalStrip(
  edge: "left" | "right",
): Promise<RenderResult> {
  const router = withRouter(() => (
    <QueryClientProvider client={new QueryClient()}>
      <RootDndProvider>
        <VerticalStrip edge={edge} />
      </RootDndProvider>
    </QueryClientProvider>
  ));
  const view = await act(async () => {
    const rendered = render(<RouterProvider router={router} />);
    await router.load();
    return rendered;
  });
  const bandStart = BAND[edge].start;
  vi.spyOn(
    view.getByTestId(HEADER_STRIP_SCROLL_TEST_ID),
    "getBoundingClientRect",
  ).mockReturnValue(rect(bandStart, STRIP_TOP, STRIP_WIDTH, STRIP_HEIGHT));
  for (const row of ROWS) {
    vi.spyOn(
      view.getByTestId(`row-${row.stripItemId}`),
      "getBoundingClientRect",
    ).mockReturnValue(rect(bandStart, row.top, STRIP_WIDTH, row.height));
  }
  return view;
}

interface RowDrag {
  readonly source: HTMLElement;
  readonly pointerId: number;
}

/**
 * Press a row at its centre and cross the activation distance along y, so the
 * grab offset is half the row's height.
 */
function pressAndActivate(
  view: RenderResult,
  row: Row,
  x: number,
  pointerId: number,
): RowDrag {
  const source = view.getByTestId(`row-${row.stripItemId}`);
  const centre = row.top + row.height / 2;
  act(() => {
    fireEvent.pointerDown(source, {
      pointerId,
      isPrimary: true,
      button: 0,
      clientX: x,
      clientY: centre,
    });
  });
  act(() => {
    fireEvent.pointerMove(source, {
      pointerId,
      clientX: x,
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

/**
 * The inline transform of dnd-kit's positioned `DragOverlay` wrapper, the one
 * fixed element the overlay modifier's result is written to.
 */
function overlayTransform(): string | null {
  const overlays = [...document.querySelectorAll<HTMLElement>("*")].filter(
    (node) =>
      node.style.position === "fixed" &&
      node.style.transform.startsWith("translate3d("),
  );
  return overlays.length === 1 ? overlays[0].style.transform : null;
}

function stripItemIds(): ReadonlyArray<string> {
  return useTabsStore.getState().items.map((item) => item.id);
}

const [ROW_A, ROW_B, ROW_SPLIT, ROW_C] = ROWS;

describe("RootDndProvider on a vertical strip", () => {
  beforeEach(() => {
    __resetTabNavigationControllerForTesting();
    resetTabDetachHandler();
    seedVerticalStrip();
  });

  afterEach(() => {
    cleanup();
    resetTabDetachHandler();
    vi.restoreAllMocks();
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  for (const edge of ["left", "right"] as const) {
    const inBand = BAND[edge].start + STRIP_WIDTH / 2;

    describe(`strip at the ${edge} edge`, () => {
      it("reorders a row along y and moves the overlay on y only", async () => {
        const view = await mountVerticalStrip(edge);
        const drag = pressAndActivate(view, ROW_A, inBand, 1);
        // The dragged centre passes B's centre (150) but not the split's.
        moveTo(drag, inBand, 170);

        const store = useEpicDndStore.getState();
        expect(store.headerStripAxis).toBe("y");
        expect(store.headerStripSourceSize).toEqual({
          width: STRIP_WIDTH,
          height: 32,
        });
        expect(store.headerStripDragState).toEqual({
          kind: "reorder",
          targetIndex: 1,
        });
        expect(store.headerStripOffsets.get(ROW_B.stripItemId)).toBe(-34);
        expect(store.headerStripOffsets.get(ROW_A.stripItemId)).toBe(34);
        // Pressed at A's centre (116, grab offset 16) from its start at 100:
        // the overlay starts at 170 - 16 = 154, 54px below where it began,
        // and the cross axis is pinned.
        expect(overlayTransform()).toMatch(/^translate3d\(0px, 54px, 0\)/);

        releaseAt(drag, inBand, 170);
        expect(stripItemIds()).toEqual([
          ROW_B.stripItemId,
          ROW_A.stripItemId,
          SPLIT_ID,
          ROW_C.stripItemId,
        ]);
      });

      it("clamps the overlay to the strip's end on y", async () => {
        const view = await mountVerticalStrip(edge);
        const drag = pressAndActivate(view, ROW_A, inBand, 11);
        // Past the strip's end (500) the overlay starts at 500 - 32 = 468,
        // 368px below where it began.
        moveTo(drag, inBand, 600);
        expect(overlayTransform()).toMatch(/^translate3d\(0px, 368px, 0\)/);
        releaseAt(drag, inBand, 600);
      });

      it("merges into a row's top half when approached from above", async () => {
        const view = await mountVerticalStrip(edge);
        const drag = pressAndActivate(view, ROW_A, inBand, 2);
        // B spans 134..166; a dragged centre at 145 sits on its top half.
        moveTo(drag, inBand, 145);
        expect(useEpicDndStore.getState().headerStripDragState).toEqual({
          kind: "merge",
          targetIndex: 0,
          targetItemId: ROW_B.stripItemId,
          targetSide: "left",
        });
        expect(useEpicDndStore.getState().topLevelStripPairPreview).toEqual({
          targetRef: B,
          side: "left",
        });
        releaseAt(drag, inBand, 145);
      });

      it("merges into a row's bottom half when approached from below", async () => {
        const view = await mountVerticalStrip(edge);
        const drag = pressAndActivate(view, ROW_B, inBand, 3);
        // A spans 100..132; a dragged centre at 121 sits on its bottom half.
        moveTo(drag, inBand, 121);
        expect(useEpicDndStore.getState().headerStripDragState).toEqual({
          kind: "merge",
          targetIndex: 1,
          targetItemId: ROW_A.stripItemId,
          targetSide: "right",
        });
        expect(useEpicDndStore.getState().topLevelStripPairPreview).toEqual({
          targetRef: A,
          side: "right",
        });
        releaseAt(drag, inBand, 121);
      });

      it("drags a split pair whole, displacing a neighbour by the pair's extent", async () => {
        const view = await mountVerticalStrip(edge);
        const drag = pressAndActivate(view, ROW_SPLIT, inBand, 4);
        // C's centre is 252; the pair's centre passes it.
        moveTo(drag, inBand, 256);

        const store = useEpicDndStore.getState();
        expect(store.headerStripSourceSize).toEqual({
          width: STRIP_WIDTH,
          height: 66,
        });
        expect(store.headerStripDragState).toEqual({
          kind: "reorder",
          targetIndex: 3,
        });
        // C moves up by the pair's 66px plus the gap; the pair moves down by
        // C's advance, which as the last slot is its bare 32px extent.
        expect(store.headerStripOffsets.get(ROW_C.stripItemId)).toBe(-68);
        expect(store.headerStripOffsets.get(SPLIT_ID)).toBe(32);

        releaseAt(drag, inBand, 256);
        const items = useTabsStore.getState().items;
        expect(items.map((item) => item.id)).toEqual([
          ROW_A.stripItemId,
          ROW_B.stripItemId,
          ROW_C.stripItemId,
          SPLIT_ID,
        ]);
        expect(items[3]).toMatchObject({
          kind: "split",
          left: { kind: "tab", ref: X },
          right: { kind: "tab", ref: Y },
        });
      });
    });
  }

  describe("tear-off", () => {
    const cases: ReadonlyArray<{
      readonly edge: "left" | "right";
      /** More than 24px past the band on the content side. */
      readonly intoContent: number;
      /** Past the band on the content side, but inside the threshold. */
      readonly withinThreshold: number;
      readonly insideBand: number;
    }> = [
      { edge: "left", intoContent: 265, withinThreshold: 260, insideBand: 200 },
      {
        edge: "right",
        intoContent: 675,
        withinThreshold: 680,
        insideBand: 760,
      },
    ];

    for (const c of cases) {
      it(`tears off a release more than 24px into the content from a ${c.edge} strip`, async () => {
        const requestOpen = vi.fn();
        publishTabDetachHandler({ isAvailable: true, requestOpen });
        const view = await mountVerticalStrip(c.edge);
        const drag = pressAndActivate(view, ROW_A, c.insideBand, 5);
        moveTo(drag, c.intoContent, 116);
        expect(useEpicDndStore.getState().headerTearOffPreview).toBe(true);
        releaseAt(drag, c.intoContent, 116);
        expect(requestOpen).toHaveBeenCalledTimes(1);
        expect(requestOpen.mock.calls[0][0]).toMatchObject({ id: A.id });
      });

      it(`never tears off inside the band or the threshold of a ${c.edge} strip`, async () => {
        const requestOpen = vi.fn();
        publishTabDetachHandler({ isAvailable: true, requestOpen });
        const view = await mountVerticalStrip(c.edge);
        const drag = pressAndActivate(view, ROW_A, c.insideBand, 6);
        moveTo(drag, c.withinThreshold, 116);
        expect(useEpicDndStore.getState().headerTearOffPreview).toBe(false);
        moveTo(drag, c.insideBand, 116);
        releaseAt(drag, c.insideBand, 116);
        expect(requestOpen).not.toHaveBeenCalled();
      });
    }

    it("latches the right strip's tear-off at 24px and releases it inside 16px", async () => {
      const view = await mountVerticalStrip("right");
      const drag = pressAndActivate(view, ROW_A, 760, 10);
      moveTo(drag, 675, 116);
      expect(useEpicDndStore.getState().headerTearOffPreview).toBe(false);
      publishTabDetachHandler({ isAvailable: true, requestOpen: vi.fn() });
      moveTo(drag, 674, 116);
      expect(useEpicDndStore.getState().headerTearOffPreview).toBe(true);
      // Still latched: 680 is inside the 24px threshold but past 700 - 16.
      moveTo(drag, 680, 116);
      expect(useEpicDndStore.getState().headerTearOffPreview).toBe(true);
      // Released: 690 is inside the 16px release distance.
      moveTo(drag, 690, 116);
      expect(useEpicDndStore.getState().headerTearOffPreview).toBe(false);
      releaseAt(drag, 760, 116);
    });

    it("does not tear off on the far side of a right strip unless it leaves the viewport", async () => {
      const requestOpen = vi.fn();
      publishTabDetachHandler({ isAvailable: true, requestOpen });
      const view = await mountVerticalStrip("right");
      // The right strip's band is 700..940; 1000 is between it and the
      // window's right edge (1024).
      const farSide = pressAndActivate(view, ROW_A, 760, 7);
      moveTo(farSide, 1000, 116);
      expect(useEpicDndStore.getState().headerTearOffPreview).toBe(false);
      releaseAt(farSide, 1000, 116);
      expect(requestOpen).not.toHaveBeenCalled();

      const outside = pressAndActivate(view, ROW_A, 760, 8);
      moveTo(outside, 1100, 116);
      releaseAt(outside, 1100, 116);
      expect(requestOpen).toHaveBeenCalledTimes(1);
    });
  });
});

describe("a canvas tab dropped on a vertical strip row", () => {
  const TARGET: TabRef = { kind: "epic", id: "canvas-target" };
  const TILE: EpicNodeRef = {
    id: "spec-in-task",
    instanceId: "spec-in-task-instance",
    type: "spec",
    name: "Spec in task",
    hostId: "host-a",
  };
  /** The row the canvas tab is dropped on, 200..232 on y. */
  const ROW_RECT = rect(0, 200, STRIP_WIDTH, 32);

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

  function RowSlot(): ReactNode {
    const data: HeaderTabSlotDropData = {
      kind: HEADER_TAB_SLOT_DND_TYPE,
      index: 0,
      isTrailing: false,
    };
    const { setNodeRef } = useDroppable({
      id: getHeaderStripItemSlotDropId(itemIdOf(TARGET)),
      data,
    });
    return <div ref={setNodeRef} data-testid="row-slot" />;
  }

  function seedCanvasSource(): EpicCanvasArtifactTabDragData {
    useEpicCanvasStore
      .getState()
      .openEpicTabWithId(TARGET.id, "canvas-target-epic", "Target");
    useEpicCanvasStore.getState().openTileInTab(TARGET.id, TILE);
    const canvas = useEpicCanvasStore.getState().canvasByTabId[TARGET.id];
    const sourceGroupId = collectPanes(canvas?.root ?? null).at(0)?.id;
    if (sourceGroupId === undefined) throw new Error("Expected source pane");
    useTabsStore.setState({
      version: 2,
      items: [{ kind: "tab", id: itemIdOf(TARGET), ref: TARGET }],
      activeItemId: itemIdOf(TARGET),
      stripOrder: [TARGET],
      systemTabs: { history: null, settings: null },
    });
    return {
      kind: ARTIFACT_TAB_DND_TYPE,
      epicId: "canvas-target-epic",
      viewTabId: TARGET.id,
      sourceGroupId,
      tabId: TILE.instanceId,
      isPreview: false,
    };
  }

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("resolves the drop index after the row over its lower half and before it over its upper half", async () => {
    const source = seedCanvasSource();
    const router = withRouter(() => (
      <QueryClientProvider client={new QueryClient()}>
        <RootDndProvider>
          <CanvasTabSource data={source} />
          <div
            data-testid={HEADER_STRIP_SCROLL_TEST_ID}
            data-strip-axis="y"
            data-strip-edge="left"
          >
            <RowSlot />
          </div>
        </RootDndProvider>
      </QueryClientProvider>
    ));
    await act(async () => {
      render(<RouterProvider router={router} />);
      await router.load();
    });
    const handle = await screen.findByTestId("canvas-tab-source");
    const slot = await screen.findByTestId("row-slot");
    vi.spyOn(slot, "getBoundingClientRect").mockReturnValue(ROW_RECT);

    act(() => {
      fireEvent.pointerDown(handle, {
        pointerId: 9,
        isPrimary: true,
        button: 0,
        clientX: 600,
        clientY: 600,
      });
    });
    act(() => {
      fireEvent.pointerMove(handle, {
        pointerId: 9,
        clientX: 620,
        clientY: 600,
      });
    });
    // Left half on x, lower half on y: only a y split says "after".
    act(() => {
      fireEvent.pointerMove(handle, {
        pointerId: 9,
        clientX: 50,
        clientY: 225,
      });
    });
    expect(useEpicDndStore.getState().headerStripDropIndex).toBe(1);

    // Right half on x, upper half on y: only a y split says "before".
    act(() => {
      fireEvent.pointerMove(handle, {
        pointerId: 9,
        clientX: 200,
        clientY: 205,
      });
    });
    expect(useEpicDndStore.getState().headerStripDropIndex).toBe(0);
  });
});
