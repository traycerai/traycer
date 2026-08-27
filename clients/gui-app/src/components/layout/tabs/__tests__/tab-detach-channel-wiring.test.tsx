/**
 * S2 coverage for the router-optional fix.
 *
 * Sprint 04 made `RootDndProvider` router-REQUIRED by calling the tear-off flow
 * from inside it: that flow reaches `useRouterState`, which THROWS without a
 * router where `useNavigate` only warns. Four tests broke and the cause hid
 * across two certifications. Sprint 05 moved the flow into `TabDetachOwner`,
 * mounted in the ROUTE tree, so the router requirement is satisfied by WHERE it
 * renders rather than by a runtime check - a placement fact cannot be dormant.
 *
 * These tests cover the three things that fix needs and that a green suite did
 * not previously imply:
 *
 *   S2.1  the provider renders with NO router at all
 *   S2.6  the channel is POPULATED when the owner mounts under a router
 *   S2.8  `null` (no owner) and `{ isAvailable: false }` (owner says no) are
 *         DISTINCT, so a missing owner cannot masquerade as an unavailable one
 *
 * S2.7 is NOT covered here, and deliberately not dressed up as covered. It
 * requires a real header-tab drag released below the strip - `channel !== null`
 * proves publication, never consumption, and every test in this file would stay
 * green if the provider stopped reading the channel entirely.
 *
 * The provider-light half lives in `app-shell-lifecycle-bridges.test.tsx`,
 * which passes with no detach stub at all - if a stub is ever needed there
 * again, the dependency has moved back into the provider.
 */
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  type RenderResult,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { useDraggable } from "@dnd-kit/core";
import { appLogger } from "@/lib/logger";
import { fireEvent } from "@testing-library/react";
import { RootDndProvider } from "@/components/epic-canvas/dnd/root-dnd-provider";
import {
  HEADER_TAB_DND_TYPE,
  getHeaderTabDragId,
  type HeaderTabDragData,
} from "@/components/layout/tabs/header-tab-dnd";
import { HEADER_STRIP_SCROLL_TEST_ID } from "@/components/layout/tabs/header-strip-geometry";
import { EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE } from "@/components/epic-canvas/dnd/epic-canvas-pointer-sensor";
import {
  publishTabDetachHandler,
  readTabDetachHandler,
  resetTabDetachHandler,
} from "@/components/layout/tabs/tab-detach-channel";
import { TabDetachOwner } from "@/components/layout/tabs/tab-detach-owner";
import type { HeaderTab } from "@/stores/tabs/types";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";
import { getHeaderTabs } from "@/stores/tabs/use-header-tabs";

const NEIGHBOUR_TAB_ID = "detach-neighbour";
const EPIC_TAB_EPIC_ID = "detach-epic-id";

const EPIC_TAB: HeaderTab = {
  kind: "epic",
  id: "detach-epic",
  epicId: EPIC_TAB_EPIC_ID,
  hostId: null,
  route: "/epics/detach-epic-id/detach-epic",
  name: "Detach me",
  icon: null,
  canClose: true,
  canDuplicate: true,
  canOpenInNewWindow: true,
};

function withRouter(harness: () => ReactNode) {
  const rootRoute = createRootRoute({ component: harness });
  const child = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <div data-testid="route-body" />,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([child]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

function queryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

/**
 * A real header strip with MEASURED geometry.
 *
 * `measureHeaderStripGeometry` reads `getBoundingClientRect()` off the strip
 * and each `[data-strip-item-id]`, and jsdom returns zeros - so without stubbed
 * rects `stripBottom` is 0, every release is "below" it, and the test would
 * pass for the wrong reason. Stubbing them is what makes the tear-off threshold
 * real rather than degenerate.
 */
const STRIP_TOP = 0;
const STRIP_BOTTOM = 40;
const TAB_LEFT = 100;
const TAB_WIDTH = 190;

interface StubBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

function stubRect(el: Element, box: StubBox) {
  const { left, top, right, bottom } = box;
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    x: left,
    y: top,
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({}),
  });
}

function HeaderStripHarness(): ReactNode {
  const dragData: HeaderTabDragData = {
    kind: HEADER_TAB_DND_TYPE,
    stripItemId: `tab:epic:${EPIC_TAB.id}`,
    tabKind: "epic",
    tabId: EPIC_TAB.id,
    index: 0,
  };
  const { listeners, setNodeRef } = useDraggable({
    id: getHeaderTabDragId("epic", EPIC_TAB.id),
    data: dragData,
  });
  return (
    <div data-testid={HEADER_STRIP_SCROLL_TEST_ID}>
      <button
        ref={setNodeRef}
        data-strip-item-id={`tab:epic:${EPIC_TAB.id}`}
        data-testid="header-drag-source"
        {...listeners}
      >
        tab
      </button>
    </div>
  );
}

/**
 * Put the dragged tab into the real header-tab projection.
 *
 * `resolveTearOff` looks the tab up in `getHeaderTabs()`, which projects from
 * the canvas store AND `stripOrder` - a literal is not enough, and the epic tab
 * alone is not either.
 */
function seedHeaderProjection(): void {
  const ref: TabRef = { kind: "epic", id: EPIC_TAB.id };
  const neighbourRef: TabRef = { kind: "epic", id: NEIGHBOUR_TAB_ID };
  act(() => {
    useEpicCanvasStore
      .getState()
      .openEpicTabWithId(EPIC_TAB.id, EPIC_TAB_EPIC_ID, EPIC_TAB.name);
    useEpicCanvasStore
      .getState()
      .openEpicTabWithId(NEIGHBOUR_TAB_ID, "neighbour-epic-id", "Neighbour");
    // A SECOND entry is what makes `stripOrder` a real observable: with one tab
    // every possible reorder is the identity, so an equality assertion would
    // hold no matter what the drag-end did.
    useTabsStore.setState({
      version: 2,
      items: [
        { kind: "tab", id: `tab:epic:${EPIC_TAB.id}`, ref },
        { kind: "tab", id: `tab:epic:${NEIGHBOUR_TAB_ID}`, ref: neighbourRef },
      ],
      activeItemId: `tab:epic:${EPIC_TAB.id}`,
      stripOrder: [ref, neighbourRef],
      systemTabs: { history: null, settings: null },
    });
  });
}

/**
 * Drive a real tear-off: pointerdown, activation move, release BELOW the
 * measured strip bottom.
 *
 * Rects are stubbed because jsdom returns zeros - without them `stripBottom` is
 * 0, every release counts as below it, and the threshold is degenerate. Each
 * event gets its own `act()` and `isPrimary` is set: the sensor ignores a
 * non-primary pointer, and batching activation with the first move collapses
 * two frames it treats separately.
 */
function driveTearOff(view: RenderResult): void {
  const strip = view.getByTestId(HEADER_STRIP_SCROLL_TEST_ID);
  const source = view.getByTestId("header-drag-source");
  stubRect(strip, {
    left: 0,
    top: STRIP_TOP,
    right: 800,
    bottom: STRIP_BOTTOM,
  });
  stubRect(source, {
    left: TAB_LEFT,
    top: STRIP_TOP,
    right: TAB_LEFT + TAB_WIDTH,
    bottom: STRIP_BOTTOM,
  });

  const startX = TAB_LEFT + 20;
  const startY = STRIP_BOTTOM / 2;
  const releaseY = STRIP_BOTTOM + 200;

  act(() => {
    fireEvent.pointerDown(source, {
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: startX,
      clientY: startY,
    });
  });
  act(() => {
    fireEvent.pointerMove(source, {
      pointerId: 1,
      clientX: startX + EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE + 5,
      clientY: startY,
    });
  });
  act(() => {
    fireEvent.pointerMove(source, {
      pointerId: 1,
      clientX: startX,
      clientY: releaseY,
    });
  });
  act(() => {
    fireEvent.pointerUp(source, {
      pointerId: 1,
      clientX: startX,
      clientY: releaseY,
    });
  });
}

async function mountTearOffHarness(): Promise<RenderResult> {
  const router = withRouter(() => (
    <QueryClientProvider client={queryClient()}>
      <RootDndProvider>
        <HeaderStripHarness />
      </RootDndProvider>
    </QueryClientProvider>
  ));
  return act(async () => {
    const rendered = render(<RouterProvider router={router} />);
    await router.load();
    return rendered;
  });
}

afterEach(() => {
  cleanup();
  resetTabDetachHandler();
  vi.restoreAllMocks();
});

describe("tab detach channel wiring", () => {
  beforeEach(() => {
    resetTabDetachHandler();
  });

  it("S2.8 - null and isAvailable:false are distinct states", () => {
    // The whole point of the three-state channel. Collapsed into one boolean,
    // an owner that silently stopped mounting would make every tear-off fall
    // through to ordinary drop handling: the tab reorders instead of
    // detaching, with no crash and no warning - strictly worse than the throw
    // this replaced, because the throw was loud.
    expect(readTabDetachHandler()).toBeNull();

    const requestOpen = vi.fn();
    const dispose = publishTabDetachHandler({
      isAvailable: false,
      requestOpen,
    });

    const published = readTabDetachHandler();
    expect(published).not.toBeNull();
    expect(published?.isAvailable).toBe(false);

    dispose();
    expect(readTabDetachHandler()).toBeNull();
  });

  it("S2.8 - a stale disposer cannot clear a newer handler", () => {
    const first = { isAvailable: false, requestOpen: vi.fn() };
    const second = { isAvailable: true, requestOpen: vi.fn() };
    const disposeFirst = publishTabDetachHandler(first);
    publishTabDetachHandler(second);

    disposeFirst();

    // An owner remounting publishes before the old effect cleans up; if the
    // stale disposer won, the channel would read `null` under a router.
    expect(readTabDetachHandler()).toBe(second);
  });

  it("S2.6 - mounting the owner under a router populates the channel", async () => {
    const router = withRouter(() => (
      <QueryClientProvider client={queryClient()}>
        <TabDetachOwner />
      </QueryClientProvider>
    ));

    expect(readTabDetachHandler()).toBeNull();

    await act(async () => {
      render(<RouterProvider router={router} />);
      await router.load();
    });

    // Populated - the owner reached `useRouterState` without throwing, which
    // is only true because it renders inside the route tree.
    expect(readTabDetachHandler()).not.toBeNull();
    expect(typeof readTabDetachHandler()?.requestOpen).toBe("function");
  });

  it("channel round-trip under a router - NOT S2.7", async () => {
    // HONEST SCOPE. This mounts the provider under a router and drives the
    // handler, but it invokes `requestOpen` DIRECTLY - so it exercises the
    // channel, not the provider's consumption of it. Deleting the provider's
    // `readTabDetachHandler()` call would leave this test green.
    //
    // S2.7 asks for a real header-tab drag released below the strip, asserting
    // the detach fires. That needs `activeHeaderStripGeometry` populated from a
    // measured strip, which this harness does not build. Recorded as NOT
    // COVERED rather than renamed into a pass - a test that looks like it
    // covers an assertion and does not is worse than an absent one.
    const requestOpen = vi.fn();
    publishTabDetachHandler({ isAvailable: true, requestOpen });

    const router = withRouter(() => (
      <QueryClientProvider client={queryClient()}>
        <RootDndProvider>
          <div data-testid="provider-children" />
        </RootDndProvider>
      </QueryClientProvider>
    ));

    await act(async () => {
      render(<RouterProvider router={router} />);
      await router.load();
    });

    const handler = readTabDetachHandler();
    expect(handler).not.toBeNull();

    // Drive the channel the way the provider's drag-end does, and assert the
    // published handler is what runs.
    act(() => {
      handler?.requestOpen(EPIC_TAB);
    });
    expect(requestOpen).toHaveBeenCalledWith(EPIC_TAB);
  });

  it("S2.7 - a real tear-off drag reaches the published handler", async () => {
    // The assertion the whole of S2 exists for. `channel !== null` proves
    // publication; this proves CONSUMPTION - it drives a real dnd-kit header
    // drag, releases BELOW the measured strip bottom, and asserts the handler
    // the provider read is the one that ran. Deleting `readTabDetachHandler()`
    // from `handleDragEnd`, or changing its branch, turns this red.
    // `resolveTearOff` looks the dragged tab up in the REAL header-tab
    // projection, so a literal is not enough - the tab has to exist in the
    // store or the lookup returns undefined and nothing detaches.
    seedHeaderProjection();
    expect(getHeaderTabs().some((tab) => tab.id === EPIC_TAB.id)).toBe(true);

    const requestOpen = vi.fn();
    publishTabDetachHandler({ isAvailable: true, requestOpen });

    const view = await mountTearOffHarness();
    driveTearOff(view);

    expect(requestOpen).toHaveBeenCalledTimes(1);
    expect(requestOpen.mock.calls[0][0]).toMatchObject({ id: EPIC_TAB.id });
  });

  it("S2.9 - a tear-off with no detach owner warns and falls through safely", async () => {
    // The diagnostic added for the missing-owner case. Before it, a tear-off
    // released below the strip with no owner mounted did NOTHING, silently -
    // indistinguishable from a gesture the user aborted. This drives the same
    // real drag S2.7 does, so it fails if the provider stops reaching the
    // channel or the branch stops logging.
    resetTabDetachHandler();
    const warn = vi
      .spyOn(appLogger, "warn")
      .mockImplementation(() => undefined);

    seedHeaderProjection();
    const orderBefore = [...useTabsStore.getState().stripOrder];
    // Guards the assertion below against becoming the identity: a one-entry
    // strip cannot be reordered, so equality would hold vacuously.
    expect(orderBefore).toHaveLength(2);

    const view = await mountTearOffHarness();
    driveTearOff(view);

    const detachWarnings = warn.mock.calls.filter(
      (call) =>
        typeof call[0] === "string" && call[0].startsWith("[tab-detach]"),
    );
    expect(detachWarnings).toHaveLength(1);
    // The tab id is the part that makes the line actionable - "something was
    // dropped" without naming what is a log entry nobody can act on.
    expect(detachWarnings[0][1]).toMatchObject({
      tabId: EPIC_TAB.id,
      tabKind: "epic",
    });

    // The ordinary drop path is allowed to run when detach cannot. Entering
    // the tear-off region already withdrew the reorder preview, so the safe
    // fall-through preserves the order rather than swallowing the gesture.
    expect(useTabsStore.getState().stripOrder).toEqual(orderBefore);
  });

  it("S2.9 - an owner that reports itself unavailable is not warned about", async () => {
    // The distinction S2.8 draws at the channel level, drawn here at the
    // consumer level: `{ isAvailable: false }` is an owner DECIDING not to
    // detach - an intentional, already-explained state. Logging it would make
    // the warning fire on a supported path and train readers to ignore it.
    const requestOpen = vi.fn();
    publishTabDetachHandler({ isAvailable: false, requestOpen });
    const warn = vi
      .spyOn(appLogger, "warn")
      .mockImplementation(() => undefined);

    seedHeaderProjection();
    const view = await mountTearOffHarness();
    driveTearOff(view);

    expect(
      warn.mock.calls.filter(
        (call) =>
          typeof call[0] === "string" && call[0].startsWith("[tab-detach]"),
      ),
    ).toHaveLength(0);
    expect(requestOpen).not.toHaveBeenCalled();
  });

  it("S2.1 - the provider renders without a RouterProvider", () => {
    // The regression this sprint exists to fix: `RootDndProvider` went from
    // router-optional to router-REQUIRED. Rendering it bare must not throw and
    // its children must appear.
    const { getByTestId } = render(
      <QueryClientProvider client={queryClient()}>
        <RootDndProvider>
          <div data-testid="bare-children" />
        </RootDndProvider>
      </QueryClientProvider>,
    );
    expect(getByTestId("bare-children")).toBeDefined();
    // And with no owner mounted the channel stays null rather than reporting
    // an unavailable handler.
    expect(readTabDetachHandler()).toBeNull();
  });
});
