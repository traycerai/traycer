import type { ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { DndContext, useDraggable, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE,
  EpicCanvasPointerSensor,
} from "@/components/epic-canvas/dnd/epic-canvas-pointer-sensor";
import { useQueuedMessageRowSortable } from "@/components/chat/queued-message-reorder-dnd";
import { useArtifactDragSource } from "@/components/epic-canvas/dnd/use-artifact-drag-source";
import { useDragSourceDisabled } from "@/components/epic-canvas/dnd/use-drag-source-disabled";
import { useManagedCommandOutputDragSource } from "@/components/epic-canvas/dnd/use-managed-command-output-drag-source";
import { usePierreCanvasDragBridge } from "@/components/epic-canvas/dnd/use-pierre-canvas-drag-bridge";

/**
 * A drag and a scroll are one gesture on a touch pointer, so a live drag
 * source on a phone eats the list scroll the user asked for. Both arms are
 * pinned everywhere: the coarse arm never runs on a developer's machine, so a
 * suite that only asserted the fine arm would keep passing after the gate was
 * deleted, and a suite that only asserted the coarse arm would keep passing
 * after someone disabled desktop drag outright.
 *
 * What is asserted is `listeners` - the pointer handlers dnd-kit actually
 * attaches to the element. That is the difference between "no drag starts"
 * and "no handler is attached at all"; only the second lets the browser
 * scroll natively, with no sensor to out-race.
 */

/**
 * The global test shim answers every media query with `matches: false`, which
 * is the fine-pointer arm. This narrows the coarse-pointer query alone so the
 * rest of the app's queries keep the shim's answer.
 */
function stubCoarsePointer(coarse: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: coarse && query === "(pointer: coarse)",
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

function DndWrapper(props: { readonly children: ReactNode }) {
  return <DndContext>{props.children}</DndContext>;
}

function SortableWrapper(props: { readonly children: ReactNode }) {
  return (
    <DndContext>
      <SortableContext items={["queue-1"]}>{props.children}</SortableContext>
    </DndContext>
  );
}

beforeEach(() => stubCoarsePointer(false));
afterEach(cleanup);

function RootSensorRow() {
  const { listeners, setNodeRef } = useDraggable({
    id: "row",
    data: { kind: "probe" },
  });
  return (
    // A button, like the real chat and background rows this stands in for -
    // the sensor's only element-level condition is the left-button press it
    // already checks, so the tag does not change what is under test.
    <button ref={setNodeRef} {...listeners} type="button">
      row
    </button>
  );
}

function RootSensorProbe(props: { readonly onDragStart: () => void }) {
  const sensors = useSensors(
    useSensor(EpicCanvasPointerSensor, {
      activationConstraint: { distance: EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE },
    }),
  );
  return (
    <DndContext sensors={sensors} onDragStart={props.onDragStart}>
      <RootSensorRow />
    </DndContext>
  );
}

/** Press the row and drag past the sensor's activation distance. */
function pressAndDrag(pointerType: string): void {
  fireEvent.pointerDown(screen.getByRole("button", { name: "row" }), {
    pointerType,
    isPrimary: true,
    button: 0,
    clientX: 0,
    clientY: 0,
  });
  fireEvent.pointerMove(document, {
    pointerType,
    clientX: 0,
    clientY: EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE * 4,
  });
}

describe("root pointer sensor", () => {
  /**
   * The device gate cannot answer this one. A HYBRID machine - a fine-primary
   * laptop with a touchscreen - reports `(pointer: coarse)` false, so its rows
   * keep their listeners and their mouse drag, and a finger on the glass still
   * reaches the sensor. The veto is therefore per gesture, not per device.
   */
  it("activates on a mouse press", () => {
    const onDragStart = vi.fn();
    render(<RootSensorProbe onDragStart={onDragStart} />);
    pressAndDrag("mouse");
    expect(onDragStart).toHaveBeenCalled();
  });

  it("activates on a pen press", () => {
    // A pen press is as deliberate as a mouse press - it is not a scroll.
    const onDragStart = vi.fn();
    render(<RootSensorProbe onDragStart={onDragStart} />);
    pressAndDrag("pen");
    expect(onDragStart).toHaveBeenCalled();
  });

  it("vetoes a touch press even where the device gate stays open", () => {
    stubCoarsePointer(false);
    const onDragStart = vi.fn();
    render(<RootSensorProbe onDragStart={onDragStart} />);
    pressAndDrag("touch");
    expect(onDragStart).not.toHaveBeenCalled();
  });
});

describe("useDragSourceDisabled", () => {
  it("reads the pointer, not the viewport", () => {
    // A narrow DESKTOP window is a mobile viewport with a fine pointer, and it
    // must keep every drag - which is why the gate cannot key on width.
    stubCoarsePointer(false);
    expect(renderHook(() => useDragSourceDisabled()).result.current).toBe(
      false,
    );

    stubCoarsePointer(true);
    expect(renderHook(() => useDragSourceDisabled()).result.current).toBe(true);
  });
});

describe("Pierre file-tree drag bridge", () => {
  // The bridge puts ONE draggable's listeners on the wrapper around the whole
  // tree, so on a touch pointer it claims the scroll of every row at once.
  const input = { id: "tree-1", resolveSourceData: () => null };

  it("carries the wrapper's pointer listeners on a fine pointer", () => {
    stubCoarsePointer(false);
    const { result } = renderHook(() => usePierreCanvasDragBridge(input), {
      wrapper: DndWrapper,
    });
    expect(result.current.wrapperProps).toHaveProperty("onPointerDown");
  });

  it("attaches no wrapper listener on a coarse pointer", () => {
    stubCoarsePointer(true);
    const { result } = renderHook(() => usePierreCanvasDragBridge(input), {
      wrapper: DndWrapper,
    });
    expect(result.current.wrapperProps).toBeUndefined();
  });
});

describe("artifact drag source", () => {
  const args = {
    epicId: "epic-1",
    viewTabId: "tab-1",
    identity: {
      id: "artifact-1",
      type: "spec" as const,
      name: "Spec",
      hostId: "host-1",
    },
    enabled: true,
  };

  it("is draggable on a fine pointer", () => {
    stubCoarsePointer(false);
    const { result } = renderHook(() => useArtifactDragSource(args), {
      wrapper: DndWrapper,
    });
    expect(result.current.isDraggable).toBe(true);
    expect(result.current.listeners).toHaveProperty("onPointerDown");
  });

  it("reports itself non-draggable on a coarse pointer", () => {
    // `isDraggable` and not only `listeners`: callers hang their grab cursor
    // and drag chrome off it, and an affordance that cannot be reached is
    // worse than none.
    stubCoarsePointer(true);
    const { result } = renderHook(() => useArtifactDragSource(args), {
      wrapper: DndWrapper,
    });
    expect(result.current.isDraggable).toBe(false);
    expect(result.current.listeners).toBeUndefined();
  });
});

describe("managed command output drag source", () => {
  const args = {
    epicId: "epic-1",
    viewTabId: "tab-1",
    hostId: "host-1",
    commandId: "command-1",
    enabled: true,
  };

  it("is draggable on a fine pointer", () => {
    stubCoarsePointer(false);
    const { result } = renderHook(
      () => useManagedCommandOutputDragSource(args),
      { wrapper: DndWrapper },
    );
    expect(result.current.isDraggable).toBe(true);
    expect(result.current.listeners).toHaveProperty("onPointerDown");
  });

  it("reports itself non-draggable on a coarse pointer", () => {
    stubCoarsePointer(true);
    const { result } = renderHook(
      () => useManagedCommandOutputDragSource(args),
      { wrapper: DndWrapper },
    );
    expect(result.current.isDraggable).toBe(false);
    expect(result.current.listeners).toBeUndefined();
  });
});

describe("queued-message reorder handle", () => {
  const options = {
    queueItemId: "queue-1",
    index: 0,
    orderKey: "queue-1",
    disabled: false,
  };

  it("keeps its listeners on a coarse pointer", () => {
    // The exemption: these listeners sit on a dedicated grip, never the row,
    // so pressing one is explicit drag intent and cannot be a scroll. Gating
    // it would take queue reordering away on touch with nothing replacing it.
    stubCoarsePointer(true);
    const { result } = renderHook(() => useQueuedMessageRowSortable(options), {
      wrapper: SortableWrapper,
    });
    expect(result.current.listeners).toHaveProperty("onPointerDown");
  });
});
