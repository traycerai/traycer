/**
 * Chromium focuses a button on mousedown, so after a POINTER drag ends or is
 * cancelled, the dragged rail icon (or any dragged control) keeps focus -
 * invisibly, until the next keydown (a lone Shift or Cmd included) makes it
 * match `:focus-visible` and draws a keyboard ring on something the user only
 * dragged. `releasePointerDragFocus` (root-dnd-provider.tsx) blurs it first
 * thing in both `handleDragEnd` and `handleDragCancel`, gated on
 * `isKeyboardEvent(activatorEvent)` so a KEYBOARD drag - whose own
 * `RestoreFocus` (dnd-kit) already returns focus to the moved item - is left
 * alone.
 *
 * Drives the REAL `RootDndProvider` with a real dnd-kit pointer/keyboard
 * gesture (mirrors `root-dnd-provider-sidebar-reparent-cleanup.test.tsx`'s
 * harness) against a real `useDraggable` button. No drop target is rendered:
 * `releasePointerDragFocus` runs before any target-dependent commit logic, so
 * a drag that ends or cancels over nothing still exercises it, and the
 * fallthrough (`resolvedDrop === null`) is the same no-op path that harness
 * already proves safe.
 */
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useDraggable } from "@dnd-kit/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { RootDndProvider } from "@/components/epic-canvas/dnd/root-dnd-provider";
import { useEpicDndStore } from "@/components/epic-canvas/dnd/dnd-store";
import {
  SIDEBAR_NODE_DND_TYPE,
  getSidebarNodeDragId,
  type EpicCanvasSidebarNodeDragData,
} from "@/components/epic-canvas/dnd/dnd";

const SOURCE: EpicCanvasSidebarNodeDragData = {
  kind: SIDEBAR_NODE_DND_TYPE,
  epicId: "epic-1",
  viewTabId: "tab-1",
  hostId: "host-1",
  nodeId: "node-1",
};

function DragButton(): ReactNode {
  const { listeners, setNodeRef } = useDraggable({
    id: getSidebarNodeDragId(SOURCE.nodeId),
    data: SOURCE,
  });
  return (
    <button ref={setNodeRef} data-testid="drag-button" {...listeners}>
      drag me
    </button>
  );
}

function buildRouter(harness: () => ReactNode) {
  const rootRoute = createRootRoute({ component: harness });
  const routeTree = rootRoute.addChildren([]);
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

const queryClient = new QueryClient();

function renderHarness(): void {
  const router = buildRouter(() => (
    <QueryClientProvider client={queryClient}>
      <RootDndProvider>
        <DragButton />
      </RootDndProvider>
    </QueryClientProvider>
  ));
  render(<RouterProvider router={router} />);
}

/** A tick past the KeyboardSensor's own delayed listener attach. */
async function flushMacrotask(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

describe("pointer-drag focus release (root-dnd-provider)", () => {
  afterEach(() => {
    cleanup();
    useEpicDndStore.setState(useEpicDndStore.getInitialState(), true);
  });

  it("blurs the dragged button once a pointer drag ends, so no stray keydown draws a ring on it", async () => {
    renderHarness();
    const button = await screen.findByTestId("drag-button");
    // Mirrors Chromium's own mousedown-focus, which jsdom does not give a
    // plain pointerdown for free.
    act(() => {
      button.focus();
    });
    expect(document.activeElement).toBe(button);

    act(() => {
      fireEvent.pointerDown(button, {
        pointerId: 1,
        isPrimary: true,
        button: 0,
        clientX: 10,
        clientY: 10,
      });
    });
    act(() => {
      fireEvent.pointerMove(button, {
        pointerId: 1,
        clientX: 30,
        clientY: 10,
      });
    });
    act(() => {
      fireEvent.pointerMove(button, {
        pointerId: 1,
        clientX: 300,
        clientY: 10,
      });
    });
    act(() => {
      fireEvent.pointerUp(button, {
        pointerId: 1,
        clientX: 300,
        clientY: 10,
      });
    });

    expect(document.activeElement).not.toBe(button);
  });

  it("blurs the dragged button when a pointer drag is cancelled mid-drag (Escape)", async () => {
    renderHarness();
    const button = await screen.findByTestId("drag-button");
    act(() => {
      button.focus();
    });
    expect(document.activeElement).toBe(button);

    act(() => {
      fireEvent.pointerDown(button, {
        pointerId: 1,
        isPrimary: true,
        button: 0,
        clientX: 10,
        clientY: 10,
      });
    });
    act(() => {
      fireEvent.pointerMove(button, {
        pointerId: 1,
        clientX: 300,
        clientY: 10,
      });
    });
    act(() => {
      fireEvent.keyDown(document, { code: "Escape", key: "Escape" });
    });

    expect(document.activeElement).not.toBe(button);
  });

  it("keeps focus on the item through a keyboard drag (pick up, move, drop)", async () => {
    renderHarness();
    const button = await screen.findByTestId("drag-button");
    act(() => {
      button.focus();
    });
    expect(document.activeElement).toBe(button);

    act(() => {
      fireEvent.keyDown(button, { code: "Space", key: " " });
    });
    await flushMacrotask();
    expect(document.activeElement).toBe(button);

    act(() => {
      fireEvent.keyDown(document, { code: "ArrowRight", key: "ArrowRight" });
    });
    expect(document.activeElement).toBe(button);

    act(() => {
      fireEvent.keyDown(document, { code: "Space", key: " " });
    });

    expect(document.activeElement).toBe(button);
  });
});
