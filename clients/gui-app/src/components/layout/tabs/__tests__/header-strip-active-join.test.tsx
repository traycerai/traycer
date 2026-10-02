/**
 * Integrated regression: `isActive`/`joined` thread into the drag overlay
 * from a REAL `RootDndProvider` gesture, not a hand-set prop. The dragged row
 * is a minimal fake draggable, not the real `TabItem` - only the OVERLAY
 * subtree is under test here, and that's driven by the tabs store and the
 * drag payload regardless of how the source row itself is drawn. (The real
 * `TabItem` also auto-activates a tab the instant a drag picks it up, so an
 * "inactive dragged tab" is momentary in production; this file proves the
 * overlay renders correctly for that instant regardless of how briefly it
 * lasts, which the fake row's lack of that effect doesn't undermine.)
 *
 * A joined overlay also names the pane it runs into (`surfaceJoinPane`), and
 * the top bridge it owns must name the same one: a task joins "surface",
 * History "canvas". A split pair joins "surface" when a member that holds a
 * tab paints `--background`, and "canvas" otherwise (`splitPairJoinPane`): an
 * empty slot paints neither, so History beside one keeps History's canvas.
 */
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
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
import { RootDndProvider } from "@/components/epic-canvas/dnd/root-dnd-provider";
import { SheetJoinBridge } from "@/components/layout/tabs/sheet-join";
import {
  HEADER_TAB_DND_TYPE,
  getHeaderTabDragId,
  type HeaderTabDragData,
} from "@/components/layout/tabs/header-tab-dnd";
import { HEADER_STRIP_SCROLL_TEST_ID } from "@/components/layout/tabs/header-strip-geometry";
import type { SheetJoinPane } from "@/components/layout/tabs/side-strip/side-tab-join";
import { EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE } from "@/components/epic-canvas/dnd/epic-canvas-pointer-sensor";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  DEFAULT_LANDING_PANEL_LAYOUT,
  useLandingPanelStore,
  type LandingPanelLayout,
} from "@/stores/home/landing-panel-store";
import type { SplitSide } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import type { SystemTab, TabRef } from "@/stores/tabs/types";

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

const ACTIVE: TabRef = { kind: "epic", id: "tab-active" };
const INACTIVE: TabRef = { kind: "epic", id: "tab-inactive" };
const HISTORY: TabRef = { kind: "history", id: "history" };
const PAIR_LEFT: TabRef = { kind: "epic", id: "tab-pair-left" };
const PAIR_RIGHT: TabRef = { kind: "epic", id: "tab-pair-right" };
const SPLIT_ID = "split-pair";

const PAIR_LEFT_SIDE: SplitSide = { kind: "tab", ref: PAIR_LEFT };
const PAIR_RIGHT_SIDE: SplitSide = { kind: "tab", ref: PAIR_RIGHT };
const HISTORY_SIDE: SplitSide = { kind: "tab", ref: HISTORY };
const EMPTY_SIDE: SplitSide = { kind: "empty" };

const HISTORY_SYSTEM_TAB: SystemTab = {
  id: "history",
  kind: "history",
  name: "History",
  lastPath: "/epics",
};

function itemIdOf(ref: TabRef): string {
  return `tab:${ref.kind}:${ref.id}`;
}

function withRouter(harness: () => ReactNode) {
  const rootRoute = createRootRoute({ component: harness });
  const home = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <div data-testid="route-body" />,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([home]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

/**
 * A bare draggable standing in for a strip item's row. `stripItemId` is the
 * item it stands for: the tab's own, or its split pair's (a pair is one drag
 * source, carried by one of its members).
 */
function StripRow(props: {
  readonly tabRef: TabRef;
  readonly stripItemId: string;
  readonly index: number;
}): ReactNode {
  const data: HeaderTabDragData = {
    kind: HEADER_TAB_DND_TYPE,
    stripItemId: props.stripItemId,
    tabKind: props.tabRef.kind,
    tabId: props.tabRef.id,
    index: props.index,
  };
  const { listeners, setNodeRef } = useDraggable({
    id: getHeaderTabDragId(
      props.tabRef.kind,
      props.stripItemId === itemIdOf(props.tabRef)
        ? props.tabRef.id
        : `${props.stripItemId}:${props.tabRef.id}`,
    ),
    data,
  });
  return (
    <button
      ref={setNodeRef}
      data-strip-item-id={props.stripItemId}
      data-strip-item-mergeable="true"
      data-testid={`row-${props.tabRef.id}`}
      {...listeners}
    >
      {props.tabRef.id}
    </button>
  );
}

function TopStrip(props: { readonly rows: ReactNode }): ReactNode {
  return (
    <div
      data-testid={HEADER_STRIP_SCROLL_TEST_ID}
      data-strip-axis="x"
      data-strip-edge="top"
    >
      {props.rows}
    </div>
  );
}

const EPIC_ROWS: ReactNode = (
  <>
    <StripRow tabRef={ACTIVE} stripItemId={itemIdOf(ACTIVE)} index={0} />
    <StripRow tabRef={INACTIVE} stripItemId={itemIdOf(INACTIVE)} index={1} />
  </>
);

function seedTwoTabs(): void {
  act(() => {
    for (const ref of [ACTIVE, INACTIVE]) {
      useEpicCanvasStore
        .getState()
        .openEpicTabWithId(ref.id, `${ref.id}-epic`, ref.id);
    }
    useTabsStore.setState({
      version: 2,
      items: [ACTIVE, INACTIVE].map((ref) => ({
        kind: "tab",
        id: itemIdOf(ref),
        ref,
      })),
      activeItemId: itemIdOf(ACTIVE),
      stripOrder: [ACTIVE, INACTIVE],
      systemTabs: { history: null, settings: null },
    });
  });
}

/** The History system tab, opened and made the active item. */
function seedActiveHistory(): void {
  act(() => {
    useTabsStore.getState().openSystemTab({
      kind: "history",
      name: "History",
      lastPath: "/epics",
    });
    useTabsStore.setState({ activeItemId: itemIdOf(HISTORY) });
  });
}

/** One split pair, active, and nothing else in the strip. */
function seedActiveSplit(left: SplitSide, right: SplitSide): void {
  const members = [left, right].flatMap((side) =>
    side.kind === "tab" ? [side.ref] : [],
  );
  act(() => {
    for (const ref of members) {
      if (ref.kind !== "epic") continue;
      useEpicCanvasStore
        .getState()
        .openEpicTabWithId(ref.id, `${ref.id}-epic`, ref.id);
    }
    useTabsStore.setState({
      version: 2,
      items: [
        {
          kind: "split",
          id: SPLIT_ID,
          left,
          right,
          focusedSide: "left",
          routeBackingSide: "left",
          leftRatio: 0.5,
        },
      ],
      activeItemId: SPLIT_ID,
      stripOrder: members,
      systemTabs: {
        history: members.some((ref) => ref.kind === "history")
          ? HISTORY_SYSTEM_TAB
          : null,
        settings: null,
      },
    });
  });
}

async function mountTopStrip(rows: ReactNode): Promise<void> {
  const router = withRouter(() => (
    <QueryClientProvider client={new QueryClient()}>
      <RootDndProvider>
        <TopStrip rows={rows} />
        <SheetJoinBridge edge="top" />
      </RootDndProvider>
    </QueryClientProvider>
  ));
  await act(async () => {
    render(<RouterProvider router={router} />);
    await router.load();
  });
}

interface Drag {
  readonly source: HTMLElement;
  readonly pointerId: number;
}

/** Press, then cross the activation distance along x (the strip's own axis). */
function pressAndActivate(row: HTMLElement, pointerId: number): Drag {
  act(() => {
    fireEvent.pointerDown(row, {
      pointerId,
      isPrimary: true,
      button: 0,
      clientX: 0,
      clientY: 0,
    });
  });
  act(() => {
    fireEvent.pointerMove(row, {
      pointerId,
      clientX: EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE + 1,
      clientY: 0,
    });
  });
  return { source: row, pointerId };
}

function releaseAt(drag: Drag): void {
  act(() => {
    fireEvent.pointerUp(drag.source, {
      pointerId: drag.pointerId,
      clientX: 0,
      clientY: 0,
    });
  });
}

function topBridge(): Element {
  const bridge = document.querySelector('[data-sheet-join-bridge="top"]');
  if (bridge === null) throw new Error("Expected the top join bridge");
  return bridge;
}

function overlayContainer(): HTMLElement {
  return screen.getByTestId("header-tab-drag-overlay");
}

describe("top strip drag overlay: active/inactive chrome and sheet join", () => {
  beforeEach(() => {
    __resetTabNavigationControllerForTesting();
    seedTwoTabs();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    useLandingPanelStore.getState().resetForTests();
  });

  it("keeps an inactive dragged tab's inactive appearance on the overlay - no chrome box, no join", async () => {
    await mountTopStrip(EPIC_ROWS);
    const row = screen.getByTestId(`row-${INACTIVE.id}`);
    const drag = pressAndActivate(row, 1);

    const overlay = overlayContainer();
    expect(within(overlay).queryByTestId("tab-chrome-box")).toBeNull();
    expect(within(overlay).getByTestId("tab-hover-box")).toBeTruthy();
    // The rows here are bare buttons, so only an ACTIVE overlay can publish:
    // the inactive one leaves the bridge unowned.
    expect(topBridge().hasAttribute("data-join-active")).toBe(false);

    releaseAt(drag);
  });

  it("draws the active dragged tab's overlay joined to the sheet", async () => {
    await mountTopStrip(EPIC_ROWS);
    const row = screen.getByTestId(`row-${ACTIVE.id}`);
    const drag = pressAndActivate(row, 2);

    const overlay = overlayContainer();
    expect(
      within(overlay)
        .getByTestId("tab-chrome-box")
        .getAttribute("data-sheet-joined"),
    ).toBe("top");
    // The joined overlay is the one publisher, so it owns the bridge.
    expect(topBridge().hasAttribute("data-join-active")).toBe(true);

    releaseAt(drag);
  });

  // The pane is the fill the join takes (`index.css`), and the bridge paints
  // the same fill onto the sheet, so the two must name one pane. A task paints
  // `--background` along its top edge, so its tab joins "surface" - not the
  // canvas, which would leave the tab and the row under it two colours.
  it("joins the active dragged task's overlay to the surface pane, and the bridge with it", async () => {
    await mountTopStrip(EPIC_ROWS);
    const row = screen.getByTestId(`row-${ACTIVE.id}`);
    const drag = pressAndActivate(row, 3);

    expect(
      within(overlayContainer())
        .getByTestId("tab-chrome-box")
        .getAttribute("data-join-pane"),
    ).toBe("surface");
    expect(topBridge().getAttribute("data-join-pane")).toBe("surface");

    releaseAt(drag);
  });

  it("joins the active dragged History tab's overlay to the canvas pane, and the bridge with it", async () => {
    seedActiveHistory();
    await mountTopStrip(
      <StripRow tabRef={HISTORY} stripItemId={itemIdOf(HISTORY)} index={0} />,
    );
    const drag = pressAndActivate(screen.getByTestId(`row-${HISTORY.id}`), 4);

    const box = within(overlayContainer()).getByTestId("tab-chrome-box");
    expect(box.getAttribute("data-sheet-joined")).toBe("top");
    expect(box.getAttribute("data-join-pane")).toBe("canvas");
    expect(topBridge().getAttribute("data-join-pane")).toBe("canvas");

    releaseAt(drag);
  });

  // A pair runs into the sheet under it as one box, in the pane its members
  // paint (`splitPairJoinPane`): `--background` when any member that holds a
  // tab paints it, the canvas otherwise. An empty slot paints neither, so
  // History beside one is the one pair that keeps History's canvas.
  const SPLIT_PAIR_CASES: ReadonlyArray<{
    readonly pair: string;
    readonly left: SplitSide;
    readonly right: SplitSide;
    readonly dragged: TabRef;
    readonly pane: SheetJoinPane;
    readonly pointerId: number;
  }> = [
    {
      pair: "two tasks",
      left: PAIR_LEFT_SIDE,
      right: PAIR_RIGHT_SIDE,
      dragged: PAIR_LEFT,
      pane: "surface",
      pointerId: 5,
    },
    {
      pair: "a task and an empty slot",
      left: PAIR_LEFT_SIDE,
      right: EMPTY_SIDE,
      dragged: PAIR_LEFT,
      pane: "surface",
      pointerId: 6,
    },
    {
      pair: "History and a task",
      left: HISTORY_SIDE,
      right: PAIR_RIGHT_SIDE,
      dragged: HISTORY,
      pane: "surface",
      pointerId: 7,
    },
    {
      pair: "History and an empty slot",
      left: HISTORY_SIDE,
      right: EMPTY_SIDE,
      dragged: HISTORY,
      pane: "canvas",
      pointerId: 8,
    },
  ];

  it.each(SPLIT_PAIR_CASES)(
    "joins the active dragged pair of $pair as one box in the $pane pane, and the bridge with it",
    async ({ left, right, dragged, pane, pointerId }) => {
      seedActiveSplit(left, right);
      await mountTopStrip(
        <StripRow tabRef={dragged} stripItemId={SPLIT_ID} index={0} />,
      );
      const drag = pressAndActivate(
        screen.getByTestId(`row-${dragged.id}`),
        pointerId,
      );

      const box = within(overlayContainer()).getByTestId(
        `split-tab-joined-${SPLIT_ID}`,
      );
      expect(box.getAttribute("data-sheet-joined")).toBe("top");
      expect(box.getAttribute("data-join-pane")).toBe(pane);
      expect(topBridge().getAttribute("data-join-pane")).toBe(pane);

      releaseAt(drag);
    },
  );

  // A draft paints `--background` under its terminal panel, which is canvas:
  // maximized, it covers the draft's whole page, so the pair meets canvas only
  // when its other member is History (or an empty slot). The overlay reads the
  // panel's recorded layout for that draft.
  const DRAFT_PANEL_CASES: ReadonlyArray<{
    readonly panel: string;
    readonly layout: LandingPanelLayout;
    readonly pane: SheetJoinPane;
    readonly pointerId: number;
  }> = [
    {
      panel: "closed",
      layout: DEFAULT_LANDING_PANEL_LAYOUT,
      pane: "surface",
      pointerId: 9,
    },
    {
      panel: "open and docked",
      layout: { ...DEFAULT_LANDING_PANEL_LAYOUT, panelOpen: true },
      pane: "surface",
      pointerId: 10,
    },
    {
      panel: "open and maximized",
      layout: {
        ...DEFAULT_LANDING_PANEL_LAYOUT,
        panelOpen: true,
        maximized: true,
      },
      pane: "canvas",
      pointerId: 11,
    },
  ];

  it.each(DRAFT_PANEL_CASES)(
    "joins the active dragged pair of a draft and History in the $pane pane while the draft's terminal panel is $panel",
    async ({ layout, pane, pointerId }) => {
      const draftId = useLandingDraftStore.getState().createDraft(null);
      const draft: TabRef = { kind: "draft", id: draftId };
      act(() => {
        useLandingPanelStore.setState({
          layoutsByLandingPageId: { [draftId]: layout },
        });
      });
      seedActiveSplit({ kind: "tab", ref: draft }, HISTORY_SIDE);
      await mountTopStrip(
        <StripRow tabRef={draft} stripItemId={SPLIT_ID} index={0} />,
      );
      const drag = pressAndActivate(
        screen.getByTestId(`row-${draftId}`),
        pointerId,
      );

      const box = within(overlayContainer()).getByTestId(
        `split-tab-joined-${SPLIT_ID}`,
      );
      expect(box.getAttribute("data-sheet-joined")).toBe("top");
      expect(box.getAttribute("data-join-pane")).toBe(pane);
      expect(topBridge().getAttribute("data-join-pane")).toBe(pane);

      releaseAt(drag);
    },
  );
});
