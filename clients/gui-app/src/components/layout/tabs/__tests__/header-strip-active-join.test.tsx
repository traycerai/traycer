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
import {
  HEADER_TAB_DND_TYPE,
  getHeaderTabDragId,
  type HeaderTabDragData,
} from "@/components/layout/tabs/header-tab-dnd";
import { HEADER_STRIP_SCROLL_TEST_ID } from "@/components/layout/tabs/header-strip-geometry";
import { EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE } from "@/components/epic-canvas/dnd/epic-canvas-pointer-sensor";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
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

const ACTIVE: TabRef = { kind: "epic", id: "tab-active" };
const INACTIVE: TabRef = { kind: "epic", id: "tab-inactive" };

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

function StripRow(props: {
  readonly tabRef: TabRef;
  readonly index: number;
}): ReactNode {
  const data: HeaderTabDragData = {
    kind: HEADER_TAB_DND_TYPE,
    stripItemId: itemIdOf(props.tabRef),
    tabKind: "epic",
    tabId: props.tabRef.id,
    index: props.index,
  };
  const { listeners, setNodeRef } = useDraggable({
    id: getHeaderTabDragId("epic", props.tabRef.id),
    data,
  });
  return (
    <button
      ref={setNodeRef}
      data-strip-item-id={itemIdOf(props.tabRef)}
      data-strip-item-mergeable="true"
      data-testid={`row-${props.tabRef.id}`}
      {...listeners}
    >
      {props.tabRef.id}
    </button>
  );
}

function TopStrip(): ReactNode {
  return (
    <div
      data-testid={HEADER_STRIP_SCROLL_TEST_ID}
      data-strip-axis="x"
      data-strip-edge="top"
    >
      <StripRow tabRef={ACTIVE} index={0} />
      <StripRow tabRef={INACTIVE} index={1} />
    </div>
  );
}

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

async function mountTopStrip(): Promise<void> {
  const router = withRouter(() => (
    <QueryClientProvider client={new QueryClient()}>
      <RootDndProvider>
        <TopStrip />
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
  });

  it("keeps an inactive dragged tab's inactive appearance on the overlay - no chrome box, no join", async () => {
    await mountTopStrip();
    const row = screen.getByTestId(`row-${INACTIVE.id}`);
    const drag = pressAndActivate(row, 1);

    const overlay = overlayContainer();
    expect(within(overlay).queryByTestId("tab-chrome-box")).toBeNull();
    expect(within(overlay).getByTestId("tab-hover-box")).toBeTruthy();

    releaseAt(drag);
  });

  it("draws the active dragged tab's overlay joined to the sheet", async () => {
    await mountTopStrip();
    const row = screen.getByTestId(`row-${ACTIVE.id}`);
    const drag = pressAndActivate(row, 2);

    const overlay = overlayContainer();
    expect(
      within(overlay)
        .getByTestId("tab-chrome-box")
        .getAttribute("data-sheet-joined"),
    ).toBe("top");

    releaseAt(drag);
  });
});
