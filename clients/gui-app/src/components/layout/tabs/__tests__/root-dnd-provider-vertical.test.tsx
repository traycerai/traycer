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
import { SPLIT_HOLD_MS } from "@/components/epic-canvas/dnd/strip-drag-model";
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
import { tabRefKey } from "@/stores/tabs/layout";
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

/** A group's block, which the drag model reads as the group's extent. */
interface Block {
  readonly groupId: string;
  readonly top: number;
  readonly height: number;
}

function VerticalStrip(props: {
  readonly edge: StripEdge;
  readonly rows: ReadonlyArray<Row>;
  readonly blocks: ReadonlyArray<Block>;
}) {
  return (
    <div
      data-testid={HEADER_STRIP_SCROLL_TEST_ID}
      data-strip-axis="y"
      data-strip-edge={props.edge}
    >
      {props.blocks.map((block) => (
        <div
          key={block.groupId}
          data-testid={`block-${block.groupId}`}
          data-strip-group-extent={block.groupId}
        />
      ))}
      {props.rows.map((row, index) => (
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
  return mountStrip(edge, ROWS, []);
}

/** The strip drawing `rows` (a collapsed group's tabs are not drawn) and `blocks`. */
async function mountStrip(
  edge: "left" | "right",
  rows: ReadonlyArray<Row>,
  blocks: ReadonlyArray<Block>,
): Promise<RenderResult> {
  const router = withRouter(() => (
    <QueryClientProvider client={new QueryClient()}>
      <RootDndProvider>
        <VerticalStrip edge={edge} rows={rows} blocks={blocks} />
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
  for (const row of rows) {
    vi.spyOn(
      view.getByTestId(`row-${row.stripItemId}`),
      "getBoundingClientRect",
    ).mockReturnValue(rect(bandStart, row.top, STRIP_WIDTH, row.height));
  }
  for (const block of blocks) {
    vi.spyOn(
      view.getByTestId(`block-${block.groupId}`),
      "getBoundingClientRect",
    ).mockReturnValue(rect(bandStart, block.top, STRIP_WIDTH, block.height));
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

/**
 * Takes over the clock the hold reads (`performance.now`) and its timer, after
 * the strip has mounted on the real one.
 */
function takeOverHoldClock(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
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
    vi.useRealTimers();
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
          groupId: null,
          joinsGroup: false,
          hold: null,
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

      describe("a row's middle half", () => {
        const approaches = [
          {
            name: "from above",
            dragged: ROW_A,
            // B spans 134..166, its centre 150; 145 is in its middle half.
            centre: 145,
            targetIndex: 0,
            target: ROW_B,
            targetRef: B,
            side: "left",
          },
          {
            name: "from below",
            dragged: ROW_B,
            // A spans 100..132, its centre 116; 121 is in its middle half.
            centre: 121,
            targetIndex: 1,
            target: ROW_A,
            targetRef: A,
            side: "right",
          },
        ] as const;

        for (const approach of approaches) {
          it(`arms a split only once held there, approached ${approach.name}`, async () => {
            const view = await mountVerticalStrip(edge);
            takeOverHoldClock();
            const drag = pressAndActivate(view, approach.dragged, inBand, 2);
            moveTo(drag, inBand, approach.centre);
            const store = useEpicDndStore.getState();
            // Entered, not held: a move, with the hold under way.
            expect(store.headerStripDragState).toMatchObject({
              kind: "reorder",
              targetIndex: approach.targetIndex,
              hold: { itemId: approach.target.stripItemId },
            });
            expect(store.topLevelStripPairPreview).toBeNull();

            // The pointer rests: no move arrives, the hold's own timer does.
            act(() => {
              vi.advanceTimersByTime(SPLIT_HOLD_MS);
            });

            expect(
              useEpicDndStore.getState().headerStripDragState,
            ).toMatchObject({
              kind: "merge",
              targetIndex: approach.targetIndex,
              targetItemId: approach.target.stripItemId,
              targetSide: approach.side,
            });
            expect(useEpicDndStore.getState().topLevelStripPairPreview).toEqual(
              {
                targetRef: approach.targetRef,
                side: approach.side,
              },
            );
            releaseAt(drag, inBand, approach.centre);
          });
        }

        it("splits on a held release", async () => {
          const view = await mountVerticalStrip(edge);
          takeOverHoldClock();
          const drag = pressAndActivate(view, ROW_A, inBand, 12);
          moveTo(drag, inBand, 145);
          act(() => {
            vi.advanceTimersByTime(SPLIT_HOLD_MS);
          });

          releaseAt(drag, inBand, 145);

          expect(useTabsStore.getState().items[0]).toMatchObject({
            kind: "split",
            left: { kind: "tab", ref: A },
            right: { kind: "tab", ref: B },
          });
        });

        it("splits nothing on a release in the middle before the hold completes", async () => {
          const view = await mountVerticalStrip(edge);
          takeOverHoldClock();
          const drag = pressAndActivate(view, ROW_A, inBand, 14);
          moveTo(drag, inBand, 145);
          act(() => {
            vi.advanceTimersByTime(SPLIT_HOLD_MS - 1);
          });

          releaseAt(drag, inBand, 145);

          expect(stripItemIds()).toEqual([
            ROW_A.stripItemId,
            ROW_B.stripItemId,
            SPLIT_ID,
            ROW_C.stripItemId,
          ]);
        });
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
          groupId: null,
          joinsGroup: false,
          hold: null,
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

  describe("a keyboard drag", () => {
    it("never splits, though the dragged row rests in another row's middle", async () => {
      const view = await mountVerticalStrip("left");
      takeOverHoldClock();
      const source = view.getByTestId(`row-${ROW_C.stripItemId}`);
      source.focus();
      act(() => {
        fireEvent.keyDown(source, { code: "Space", key: " " });
      });
      // jsdom measures the drag overlay as nothing, so the keyboard's own moves
      // carry no usable position; the pointer is what tells the strip where the
      // dragged row is. A keyboard drag grabs the row at (0, 0), so its centre
      // is the pointer's y plus the row's start and half its height: put it at
      // 152, inside the middle half of B (centre 150), where a pointer drag
      // arms a split once held.
      const pointerY = 152 - ROW_C.top - ROW_C.height / 2;
      act(() => {
        fireEvent.pointerMove(source, { clientX: 120, clientY: pointerY });
      });
      act(() => {
        vi.advanceTimersByTime(2 * SPLIT_HOLD_MS);
      });

      const store = useEpicDndStore.getState();
      expect(store.headerStripDragState).toMatchObject({
        kind: "reorder",
        targetIndex: 2,
        hold: null,
      });
      expect(store.topLevelStripPairPreview).toBeNull();
      act(() => {
        fireEvent.keyDown(document, { code: "Escape", key: "Escape" });
      });
    });
  });

  describe("group membership by drop position", () => {
    const inBand = BAND.left.start + STRIP_WIDTH / 2;
    /** The strip's rows stacked 100..268; the group block reaches 4px past its rows. */
    function seedGroup(members: ReadonlyArray<TabRef>, collapsed: boolean) {
      act(() => {
        useTabsStore.setState({
          groups: { g: { name: "Work", color: "#8ab4f8", collapsed } },
          customizations: Object.fromEntries(
            members.map((ref) => [
              tabRefKey(ref),
              { color: null, icon: null, groupId: "g" },
            ]),
          ),
        });
      });
    }
    const groupOf = (ref: TabRef): string | null =>
      useTabsStore.getState().customizations?.[tabRefKey(ref)]?.groupId ?? null;
    /** The group "g" as an organization's: the drag never changes who is in it. */
    function seedOrganizationGroup(members: ReadonlyArray<TabRef>) {
      seedGroup(members, false);
      act(() => {
        const group = useTabsStore.getState().groups?.g;
        if (group === undefined) throw new Error("no group");
        useTabsStore.setState({
          groups: { g: { ...group, organizationOwnerId: "org" } },
        });
      });
    }

    it("never joins an organization's group, and goes past it whole", async () => {
      seedOrganizationGroup([B, X, Y]);
      const view = await mountStrip("left", ROWS, [
        { groupId: "g", top: 130, height: 108 },
      ]);
      const drag = pressAndActivate(view, ROW_A, inBand, 25);
      // Over the group's block, short of its centre: next to it, not in it.
      moveTo(drag, inBand, 170);
      expect(useEpicDndStore.getState().headerStripDragState).toMatchObject({
        groupId: null,
        joinsGroup: false,
      });
      // Past the group's centre: both its rows are crossed at once.
      moveTo(drag, inBand, 200);

      releaseAt(drag, inBand, 200);

      expect(groupOf(A)).toBeNull();
      expect(stripItemIds()).toEqual([
        ROW_B.stripItemId,
        SPLIT_ID,
        ROW_A.stripItemId,
        ROW_C.stripItemId,
      ]);
    });

    it("keeps a task in an organization's group, moving it to the run's nearest edge when it is dropped outside", async () => {
      seedOrganizationGroup([B, X, Y]);
      const view = await mountStrip("left", ROWS, [
        { groupId: "g", top: 130, height: 108 },
      ]);
      const drag = pressAndActivate(view, ROW_B, inBand, 26);
      // Below the block, past C: out of the group's run.
      moveTo(drag, inBand, 300);

      releaseAt(drag, inBand, 300);

      expect(groupOf(B)).toBe("g");
      expect(stripItemIds()).toEqual([
        ROW_A.stripItemId,
        SPLIT_ID,
        ROW_B.stripItemId,
        ROW_C.stripItemId,
      ]);
    });

    it("joins a task dropped between a group's tasks", async () => {
      seedGroup([B, X, Y], false);
      const view = await mountStrip("left", ROWS, [
        { groupId: "g", top: 130, height: 108 },
      ]);
      const drag = pressAndActivate(view, ROW_A, inBand, 20);
      // Past B's centre (150), short of the pair's (201): between them.
      moveTo(drag, inBand, 170);
      expect(useEpicDndStore.getState().headerStripDragState).toMatchObject({
        kind: "reorder",
        groupId: "g",
        joinsGroup: true,
      });

      releaseAt(drag, inBand, 170);

      expect(groupOf(A)).toBe("g");
      expect(stripItemIds()).toEqual([
        ROW_B.stripItemId,
        ROW_A.stripItemId,
        SPLIT_ID,
        ROW_C.stripItemId,
      ]);
    });

    it("moves a split pair into a group as one unit", async () => {
      seedGroup([A], false);
      const view = await mountStrip("left", ROWS, [
        { groupId: "g", top: 96, height: 40 },
      ]);
      const drag = pressAndActivate(view, ROW_SPLIT, inBand, 24);
      // Past A's centre (116) and short of B's (150), inside the block (to 136).
      moveTo(drag, inBand, 130);

      releaseAt(drag, inBand, 130);

      expect(groupOf(X)).toBe("g");
      expect(groupOf(Y)).toBe("g");
      expect(stripItemIds()).toEqual([
        ROW_A.stripItemId,
        SPLIT_ID,
        ROW_B.stripItemId,
        ROW_C.stripItemId,
      ]);
    });

    it("takes a task out of its group when it is dropped outside the group's block", async () => {
      seedGroup([B, X, Y], false);
      const view = await mountStrip("left", ROWS, [
        { groupId: "g", top: 130, height: 108 },
      ]);
      const drag = pressAndActivate(view, ROW_B, inBand, 21);
      // Past A's centre (116), above the block's top (130).
      moveTo(drag, inBand, 112);
      expect(useEpicDndStore.getState().headerStripDragState).toMatchObject({
        kind: "reorder",
        groupId: null,
        joinsGroup: false,
      });

      releaseAt(drag, inBand, 112);

      expect(groupOf(B)).toBeNull();
      expect(groupOf(X)).toBe("g");
      expect(stripItemIds()).toEqual([
        ROW_B.stripItemId,
        ROW_A.stripItemId,
        SPLIT_ID,
        ROW_C.stripItemId,
      ]);
    });

    it("removes a group whose last task is dropped out of it, without moving the task", async () => {
      seedGroup([B], false);
      const view = await mountStrip("left", ROWS, [
        { groupId: "g", top: 130, height: 40 },
      ]);
      const drag = pressAndActivate(view, ROW_B, inBand, 22);
      // Below the block's bottom (170), short of the pair's centre (201): the
      // row keeps its place and leaves the group.
      moveTo(drag, inBand, 190);

      releaseAt(drag, inBand, 190);

      expect(groupOf(B)).toBeNull();
      expect(useTabsStore.getState().groups?.g).toBeUndefined();
      expect(stripItemIds()).toEqual([
        ROW_A.stripItemId,
        ROW_B.stripItemId,
        SPLIT_ID,
        ROW_C.stripItemId,
      ]);
    });

    it("joins a collapsed group as its first task when dropped on its header, leaving it collapsed", async () => {
      seedGroup([B], true);
      // The collapsed group draws its header (134..162) and none of its tasks.
      const view = await mountStrip(
        "left",
        ROWS.filter((row) => row !== ROW_B),
        [{ groupId: "g", top: 134, height: 28 }],
      );
      const drag = pressAndActivate(view, ROW_C, inBand, 23);
      moveTo(drag, inBand, 148);
      expect(useEpicDndStore.getState().headerStripDragState).toMatchObject({
        kind: "reorder",
        groupId: "g",
        joinsGroup: true,
      });
      // No line: the group's tasks are not drawn to be inserted among.
      expect(useEpicDndStore.getState().headerStripDropIndex).toBeNull();

      releaseAt(drag, inBand, 148);

      expect(groupOf(C)).toBe("g");
      expect(useTabsStore.getState().groups?.g.collapsed).toBe(true);
      expect(stripItemIds()).toEqual([
        ROW_A.stripItemId,
        ROW_C.stripItemId,
        ROW_B.stripItemId,
        SPLIT_ID,
      ]);
    });
  });

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
