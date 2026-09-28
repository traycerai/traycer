/**
 * Regression for the strip drag overlay's origin.
 *
 * A split pair's dragged MEMBER sits inside the strip FRAME at its own
 * offset rect (its own border/padding, and - for the second member - its own
 * position within the frame). dnd-kit's `DragOverlay` positions itself at the
 * dragged NODE's (the member's) own initial rect (`PositionedOverlay`'s
 * `top`/`left`, frozen at drag start) and layers the root modifier's
 * `transform` on top of that - so the modifier has to correct FROM the
 * member's rect TO the frame's measured origin, not merely apply a delta
 * relative to the frame's own start.
 *
 * `root-dnd-provider-vertical.test.tsx`'s split coverage never catches this:
 * its harness makes the draggable button ITSELF the `data-strip-item-id`
 * element, so frame and member rects are always identical there. This
 * harness reproduces the real `SplitTabItem`/`TabItem` shape instead: the
 * FRAME div carries `data-strip-item-id`; each member's own draggable root
 * (`TabItem`'s `chrome="member"`, `includeMotionFrame={false}`) carries none.
 * That gap is exactly what let a member's own offset leak into the rendered
 * overlay position: a real Chrome repro had a vertical split frame at
 * (8, 242, 224x72) with its second member at (10, 280, 220x32) render the
 * overlay at (10, 290) after a 10px downward drag instead of the
 * frame-anchored (8, 252). The horizontal strip's origin is
 * `drag-overlay-chip.test.tsx`'s real split-drag cases.
 */
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  type RenderResult,
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
import { useEpicDndStore } from "@/components/epic-canvas/dnd/dnd-store";
import {
  HEADER_TAB_DND_TYPE,
  getHeaderTabDragId,
  type HeaderTabDragData,
} from "@/components/layout/tabs/header-tab-dnd";
import { HEADER_STRIP_SCROLL_TEST_ID } from "@/components/layout/tabs/header-strip-geometry";
import { EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE } from "@/components/epic-canvas/dnd/epic-canvas-pointer-sensor";
import type { StripEdge } from "@/components/epic-canvas/dnd/strip-axis";
import {
  publishTabDetachHandler,
  resetTabDetachHandler,
} from "@/components/layout/tabs/tab-detach-channel";
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

const X: TabRef = { kind: "epic", id: "split-x" };
const Y: TabRef = { kind: "epic", id: "split-y" };
const SPLIT_ID = "split:x-y";

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
  readonly toJSON: () => Record<string, never>;
}

function rect(left: number, top: number, width: number, height: number): Rect {
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
 * A split FRAME wrapping two members, matching `SplitTabItem`/`TabItem`:
 * `data-strip-item-id` lives on the frame only, each member's own draggable
 * root carries none.
 */
function SplitFrameStrip(props: {
  readonly axisId: "x" | "y";
  readonly edge: StripEdge;
}): ReactNode {
  const dataFor = (ref: TabRef): HeaderTabDragData => ({
    kind: HEADER_TAB_DND_TYPE,
    stripItemId: SPLIT_ID,
    tabKind: "epic",
    tabId: ref.id,
    index: 0,
  });
  const { setNodeRef: setLeftRef, listeners: leftListeners } = useDraggable({
    id: getHeaderTabDragId("epic", X.id),
    data: dataFor(X),
  });
  const { setNodeRef: setRightRef, listeners: rightListeners } = useDraggable({
    id: getHeaderTabDragId("epic", Y.id),
    data: dataFor(Y),
  });
  return (
    <div
      data-testid={HEADER_STRIP_SCROLL_TEST_ID}
      data-strip-axis={props.axisId}
      data-strip-edge={props.edge}
    >
      <div
        data-strip-item-id={SPLIT_ID}
        data-strip-item-mergeable="false"
        data-testid="split-frame"
      >
        <button
          ref={setLeftRef}
          data-testid="split-member-left"
          {...leftListeners}
        >
          left
        </button>
        <button
          ref={setRightRef}
          data-testid="split-member-right"
          {...rightListeners}
        >
          right
        </button>
      </div>
    </div>
  );
}

function seedSplitStrip(): void {
  act(() => {
    for (const ref of [X, Y]) {
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
          left: { kind: "tab", ref: X },
          right: { kind: "tab", ref: Y },
          focusedSide: "left",
          routeBackingSide: "left",
          leftRatio: 0.5,
        },
      ],
      activeItemId: SPLIT_ID,
      stripOrder: [X, Y],
      systemTabs: { history: null, settings: null },
    });
  });
}

interface MountSplitStripOptions {
  readonly axisId: "x" | "y";
  readonly edge: StripEdge;
  readonly stripRect: Rect;
  readonly frameRect: Rect;
  readonly grabbedMemberRect: Rect;
}

async function mountSplitStrip(
  options: MountSplitStripOptions,
): Promise<RenderResult> {
  const router = withRouter(() => (
    <QueryClientProvider client={new QueryClient()}>
      <RootDndProvider>
        <SplitFrameStrip axisId={options.axisId} edge={options.edge} />
      </RootDndProvider>
    </QueryClientProvider>
  ));
  const view = await act(async () => {
    const rendered = render(<RouterProvider router={router} />);
    await router.load();
    return rendered;
  });
  vi.spyOn(
    view.getByTestId(HEADER_STRIP_SCROLL_TEST_ID),
    "getBoundingClientRect",
  ).mockReturnValue(options.stripRect);
  vi.spyOn(
    view.getByTestId("split-frame"),
    "getBoundingClientRect",
  ).mockReturnValue(options.frameRect);
  vi.spyOn(
    view.getByTestId("split-member-right"),
    "getBoundingClientRect",
  ).mockReturnValue(options.grabbedMemberRect);
  return view;
}

interface Drag {
  readonly source: HTMLElement;
  readonly pointerId: number;
}

interface PressAndActivateOptions {
  readonly x: number;
  readonly y: number;
  readonly activateX: number;
  readonly activateY: number;
  readonly pointerId: number;
}

/** Press at `(x, y)`, then cross the activation distance toward `(activateX, activateY)`. */
function pressAndActivate(
  source: HTMLElement,
  options: PressAndActivateOptions,
): Drag {
  const { x, y, activateX, activateY, pointerId } = options;
  act(() => {
    fireEvent.pointerDown(source, {
      pointerId,
      isPrimary: true,
      button: 0,
      clientX: x,
      clientY: y,
    });
  });
  act(() => {
    fireEvent.pointerMove(source, {
      pointerId,
      clientX: activateX,
      clientY: activateY,
    });
  });
  return { source, pointerId };
}

function moveTo(drag: Drag, x: number, y: number): void {
  act(() => {
    fireEvent.pointerMove(drag.source, {
      pointerId: drag.pointerId,
      clientX: x,
      clientY: y,
    });
  });
}

function releaseAt(drag: Drag, x: number, y: number): void {
  act(() => {
    fireEvent.pointerUp(drag.source, {
      pointerId: drag.pointerId,
      clientX: x,
      clientY: y,
    });
  });
}

/** The one fixed, translate3d-transformed element dnd-kit's `DragOverlay` positions. */
function overlayElement(): HTMLElement {
  const overlays = [...document.querySelectorAll<HTMLElement>("*")].filter(
    (node) =>
      node.style.position === "fixed" &&
      node.style.transform.startsWith("translate3d("),
  );
  expect(overlays.length).toBe(1);
  return overlays[0];
}

/**
 * dnd-kit's `PositionedOverlay` freezes `top`/`left` to the dragged NODE's
 * initial rect and layers the modifier's `transform` on top - so the
 * rendered position is the sum of both, not the transform alone. Reading
 * only the transform (as `root-dnd-provider-vertical.test.tsx` does for its
 * frame-is-the-member rows) can't see a member-vs-frame origin bug: for
 * those rows the two rects are identical, so the base term is a constant
 * that cancels out of every comparison.
 */
function renderedOverlayPosition(): {
  readonly top: number;
  readonly left: number;
} {
  const el = overlayElement();
  const match = /^translate3d\(([-\d.]+)px, ([-\d.]+)px, 0\)/.exec(
    el.style.transform,
  );
  if (match === null) {
    throw new Error(`unexpected overlay transform: ${el.style.transform}`);
  }
  return {
    top: parseFloat(el.style.top) + Number(match[2]),
    left: parseFloat(el.style.left) + Number(match[1]),
  };
}

describe("strip drag overlay origin: split frame vs grabbed member", () => {
  beforeEach(() => {
    __resetTabNavigationControllerForTesting();
    resetTabDetachHandler();
    seedSplitStrip();
  });

  afterEach(() => {
    cleanup();
    resetTabDetachHandler();
    vi.restoreAllMocks();
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("anchors a vertical split's overlay to the frame's origin, not the grabbed member's", async () => {
    // Real Chrome repro: frame (8, 242, 224x72), second member (10, 280, 220x32).
    const view = await mountSplitStrip({
      axisId: "y",
      edge: "left",
      stripRect: rect(0, 0, 240, 1000),
      frameRect: rect(8, 242, 224, 72),
      grabbedMemberRect: rect(10, 280, 220, 32),
    });
    const member = view.getByTestId("split-member-right");
    // Press at the member's centre (120, 296) so the grab offset is measured
    // from a real point on it.
    const drag = pressAndActivate(member, {
      x: 120,
      y: 296,
      activateX: 120,
      activateY: 296 + EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE + 1,
      pointerId: 21,
    });
    moveTo(drag, 120, 306); // +10px down
    expect(renderedOverlayPosition()).toEqual({ top: 252, left: 8 });
    // Same target again: proves the fix latches the member's initial rect
    // ONCE rather than re-measuring it every frame - dnd-kit's own
    // `active.rect.current.initial` updates on every layout effect, which
    // is exactly what made a naive "subtract the live rect" fix unstable.
    moveTo(drag, 120, 306);
    expect(renderedOverlayPosition()).toEqual({ top: 252, left: 8 });
    releaseAt(drag, 120, 306);
  });

  it("reverts to the grabbed member's own origin once tear-off previews, not the frame's", async () => {
    const requestOpen = vi.fn();
    publishTabDetachHandler({ isAvailable: true, requestOpen });
    const view = await mountSplitStrip({
      axisId: "y",
      edge: "left",
      stripRect: rect(0, 0, 240, 1000),
      frameRect: rect(8, 242, 224, 72),
      grabbedMemberRect: rect(10, 280, 220, 32),
    });
    const member = view.getByTestId("split-member-right");
    const drag = pressAndActivate(member, {
      x: 120,
      y: 296,
      activateX: 120,
      activateY: 296 + EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE + 1,
      pointerId: 23,
    });
    // More than 24px past the left strip's band (0..240) tears off. The
    // store flag flips via the app's own `onDragMove` effect, which commits
    // AFTER this event's modifier already ran - so the overlay only reflects
    // the new tear-off state on the NEXT dnd-kit-driven position update, not
    // this one. A second move at the same point exercises exactly that.
    moveTo(drag, 265, 306);
    expect(useEpicDndStore.getState().headerTearOffPreview).toBe(true);
    moveTo(drag, 265, 306);
    // Frame-anchored would read (252, 8); tear-off intentionally keeps the
    // member's own origin plus the raw pointer delta instead, so the tab
    // visibly peels away from under the pointer rather than snapping back
    // to the frame mid-gesture: (290, 10).
    expect(renderedOverlayPosition()).toEqual({ top: 290, left: 10 });
    releaseAt(drag, 265, 306);
    expect(requestOpen).toHaveBeenCalledTimes(1);
  });
});
