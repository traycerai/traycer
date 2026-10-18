import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasSiblingLayout } from "@/lib/sandbox/canvas-layout-bridge";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CanvasStructureOverlay } from "../canvas-structure-overlay";
import { useCanvasSelectionStore } from "../canvas-selection-store";
import {
  BOARD_PATH,
  disposeBridges,
  pendingSaves,
  SAVED,
  settleSave,
} from "./canvas-edit-test-support";
import {
  elementFor,
  flowAt,
  FRAME_ACTUAL,
  installPointerCapture,
  layoutOf,
  placedAt,
  selectionFor,
  selectOnly,
  selectSet,
  settleLayout,
  structureDocument,
  structureHarness,
  type FrameGeometry,
  type StructureHarness,
} from "./canvas-structure-test-support";

vi.mock("../use-artboard-edit", async () =>
  (await import("./canvas-edit-test-support")).artboardEditModule(),
);

const CHANGED = "The page changed this layout. Select the elements again.";
const DOCUMENT = structureDocument(
  `<div data-tid="row"><div data-tid="a"></div><div data-tid="b"></div><div data-tid="c"></div></div>`,
);
const POINTER = { pointerId: 1, button: 0 };

/** A row of three 100 x 50 boxes, in the flow, that a reorder can address. */
function rowLayout(): CanvasSiblingLayout {
  return layoutOf(DOCUMENT, "row", {
    a: flowAt(0, 0, 100, 50),
    b: flowAt(100, 0, 100, 50),
    c: flowAt(200, 0, 100, 50),
  });
}

/** `a` picked in the row, with the overlay mounted over the board's frame. */
async function mountOverlay(
  layout: CanvasSiblingLayout,
  geometry: FrameGeometry,
): Promise<{
  readonly harness: StructureHarness;
  readonly container: HTMLElement;
}> {
  const harness = structureHarness(layout, geometry);
  const selection = selectionFor(elementFor(DOCUMENT, "a"));
  selectOnly(selection);
  const { container } = render(
    <TooltipProvider>
      <CanvasStructureOverlay
        selection={selection}
        registry={harness.registry}
        document={DOCUMENT}
      />
    </TooltipProvider>,
  );
  await settleLayout();
  return { harness, container };
}

function handle(name: string): HTMLElement {
  return screen.getByRole("button", { name });
}

function insertionMarker(container: HTMLElement): Element | null {
  return container.querySelector("[data-canvas-insertion-marker]");
}

function pressEscape(): void {
  fireEvent.keyDown(window, { key: "Escape" });
}

/** The three steps of a drag, in screen pixels. */
function startDrag(target: HTMLElement, from: { x: number; y: number }): void {
  fireEvent.pointerDown(target, {
    ...POINTER,
    clientX: from.x,
    clientY: from.y,
  });
}
function dragTo(target: HTMLElement, to: { x: number; y: number }): void {
  fireEvent.pointerMove(target, { ...POINTER, clientX: to.x, clientY: to.y });
}
function release(target: HTMLElement, at: { x: number; y: number }): void {
  fireEvent.pointerUp(target, { ...POINTER, clientX: at.x, clientY: at.y });
}

/** The reorder the "drop before c" gesture asks for, at actual size. */
const BEFORE_C = { x: 160, y: 20 };

beforeEach(() => {
  pendingSaves.length = 0;
  installPointerCapture();
  useCanvasSelectionStore.setState({
    selection: null,
    additionalElements: [],
    selectionOwner: null,
    generation: 0,
    pendingPick: null,
  });
});

afterEach(() => {
  cleanup();
  disposeBridges();
  vi.restoreAllMocks();
});

describe("resizing at canvas zoom", () => {
  // The frame is drawn at `zoom` of its CSS size; a screen pixel is 1/zoom of a
  // CSS pixel, so the same drag asks for a different size at each zoom.
  it.each([
    [1, 140, 70],
    [0.5, 180, 90],
    [2, 120, 60],
  ])(
    "at %sx a 40 x 20 screen drag writes %s x %s",
    async (zoom, width, height) => {
      const geometry: FrameGeometry = {
        ...FRAME_ACTUAL,
        width: FRAME_ACTUAL.clientWidth * zoom,
        height: FRAME_ACTUAL.clientHeight * zoom,
      };
      await mountOverlay(rowLayout(), geometry);
      const corner = handle("Resize element bottom right");
      startDrag(corner, { x: 100, y: 100 });
      dragTo(corner, { x: 140, y: 120 });
      release(corner, { x: 140, y: 120 });
      await settleLayout();

      expect(pendingSaves).toHaveLength(1);
      expect(pendingSaves[0].variables.edit).toEqual({
        kind: "set-box",
        width,
        height,
      });
    },
  );

  it("shows the dashed preview box while dragging and clears it on release", async () => {
    const { container } = await mountOverlay(rowLayout(), FRAME_ACTUAL);
    const corner = handle("Resize element bottom right");
    startDrag(corner, { x: 100, y: 100 });
    dragTo(corner, { x: 130, y: 130 });
    expect(
      container.querySelector("[data-canvas-resize-preview]"),
    ).not.toBeNull();
    release(corner, { x: 130, y: 130 });
    expect(container.querySelector("[data-canvas-resize-preview]")).toBeNull();
  });

  it("treats a movement of under three pixels as a click, not a resize", async () => {
    await mountOverlay(rowLayout(), FRAME_ACTUAL);
    const corner = handle("Resize element bottom right");
    startDrag(corner, { x: 100, y: 100 });
    release(corner, { x: 101, y: 101 });
    await settleLayout();
    expect(pendingSaves).toHaveLength(0);
  });
});

describe("reordering", () => {
  it.each([
    [1, BEFORE_C],
    [0.5, { x: BEFORE_C.x / 2, y: BEFORE_C.y / 2 }],
    [2, { x: BEFORE_C.x * 2, y: BEFORE_C.y * 2 }],
  ])(
    "at %sx a drop over c's left half moves a before c",
    async (zoom, drop) => {
      const geometry: FrameGeometry = {
        ...FRAME_ACTUAL,
        width: FRAME_ACTUAL.clientWidth * zoom,
        height: FRAME_ACTUAL.clientHeight * zoom,
      };
      await mountOverlay(rowLayout(), geometry);
      const edge = handle("Reorder element (1)");
      startDrag(edge, { x: 20 * zoom, y: 5 * zoom });
      dragTo(edge, drop);
      release(edge, drop);
      await settleLayout();

      expect(pendingSaves).toHaveLength(1);
      const edit = pendingSaves[0].variables.edit;
      expect(edit.kind).toBe("move-element");
      if (edit.kind !== "move-element") return;
      expect(edit.before).toMatchObject({ kind: "position", tagName: "div" });
    },
  );

  it("shows the insertion bar while dragging", async () => {
    const { container } = await mountOverlay(rowLayout(), FRAME_ACTUAL);
    const edge = handle("Reorder element (1)");
    startDrag(edge, { x: 20, y: 5 });
    expect(insertionMarker(container)).toBeNull();
    dragTo(edge, BEFORE_C);
    expect(insertionMarker(container)).not.toBeNull();
  });

  it("refuses to start in a container that is not a single in-flow row", async () => {
    const mixed = layoutOf(DOCUMENT, "row", {
      a: flowAt(0, 0, 100, 50),
      b: flowAt(100, 0, 100, 50),
      c: placedAt(200, 0, 100, 50),
    });
    await mountOverlay(mixed, FRAME_ACTUAL);
    for (const index of [1, 2, 3, 4])
      expect(handle(`Reorder element (${index})`).hasAttribute("disabled")).toBe(true);
  });
});

describe("Escape cancels a gesture", () => {
  it("while the pointer is still down, so releasing saves nothing", async () => {
    const { container } = await mountOverlay(rowLayout(), FRAME_ACTUAL);
    const edge = handle("Reorder element (1)");
    startDrag(edge, { x: 20, y: 5 });
    dragTo(edge, BEFORE_C);
    expect(insertionMarker(container)).not.toBeNull();

    pressEscape();
    expect(insertionMarker(container)).toBeNull();
    release(edge, BEFORE_C);
    await settleLayout();
    expect(pendingSaves).toHaveLength(0);
  });

  it("only that gesture: the next drag still saves", async () => {
    await mountOverlay(rowLayout(), FRAME_ACTUAL);
    const edge = handle("Reorder element (1)");
    startDrag(edge, { x: 20, y: 5 });
    dragTo(edge, BEFORE_C);
    pressEscape();
    release(edge, BEFORE_C);
    await settleLayout();
    expect(pendingSaves).toHaveLength(0);

    startDrag(edge, { x: 20, y: 5 });
    dragTo(edge, BEFORE_C);
    release(edge, BEFORE_C);
    await settleLayout();
    expect(pendingSaves).toHaveLength(1);
  });

  it("after release, while the layout is being re-read", async () => {
    const { harness } = await mountOverlay(rowLayout(), FRAME_ACTUAL);
    const edge = handle("Reorder element (1)");
    startDrag(edge, { x: 20, y: 5 });
    dragTo(edge, BEFORE_C);
    const answer = harness.hold();
    release(edge, BEFORE_C);
    pressEscape();
    await act(async () => {
      answer();
      await Promise.resolve();
    });
    await settleLayout();
    expect(pendingSaves).toHaveLength(0);
  });

  it("is left to other handlers when no gesture is running", async () => {
    await mountOverlay(rowLayout(), FRAME_ACTUAL);
    const other = vi.fn();
    window.addEventListener("keydown", other);
    pressEscape();
    window.removeEventListener("keydown", other);
    expect(other).toHaveBeenCalledTimes(1);
  });
});

describe("something changes while the layout is being re-read", () => {
  async function dragWhileHeld(): Promise<{
    readonly harness: StructureHarness;
    readonly answer: () => void;
  }> {
    const { harness } = await mountOverlay(rowLayout(), FRAME_ACTUAL);
    const edge = handle("Reorder element (1)");
    startDrag(edge, { x: 20, y: 5 });
    dragTo(edge, BEFORE_C);
    const answer = harness.hold();
    release(edge, BEFORE_C);
    return { harness, answer };
  }

  async function answerAndSettle(answer: () => void): Promise<void> {
    await act(async () => {
      answer();
      await Promise.resolve();
    });
    await settleLayout();
  }

  it("saves when nothing changed", async () => {
    const { answer } = await dragWhileHeld();
    await answerAndSettle(answer);
    expect(pendingSaves).toHaveLength(1);
  });

  it("saves nothing when the page moved the siblings", async () => {
    const { harness, answer } = await dragWhileHeld();
    harness.report(
      layoutOf(DOCUMENT, "row", {
        a: flowAt(0, 0, 100, 50),
        b: flowAt(100, 0, 140, 50),
        c: flowAt(240, 0, 100, 50),
      }),
    );
    await answerAndSettle(answer);
    expect(pendingSaves).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toBe(CHANGED);
  });

  it("saves nothing when the page can no longer answer for the element", async () => {
    const { harness, answer } = await dragWhileHeld();
    harness.report(null);
    await answerAndSettle(answer);
    expect(pendingSaves).toHaveLength(0);
  });

  it("saves nothing when another element was selected", async () => {
    const { answer } = await dragWhileHeld();
    selectOnly(selectionFor(elementFor(DOCUMENT, "b")));
    await answerAndSettle(answer);
    expect(pendingSaves).toHaveLength(0);
  });

  it("saves nothing when the selection was cleared", async () => {
    const { answer } = await dragWhileHeld();
    act(() => {
      useCanvasSelectionStore.getState().clear();
    });
    await answerAndSettle(answer);
    expect(pendingSaves).toHaveLength(0);
  });

  it("saves nothing when the board was rewritten", async () => {
    const { harness, answer } = await dragWhileHeld();
    act(() => {
      harness.registry.update(BOARD_PATH, { sha256: "sha-rewritten" });
    });
    await answerAndSettle(answer);
    expect(pendingSaves).toHaveLength(0);
  });

  it("saves nothing when the frame was replaced", async () => {
    const { harness, answer } = await dragWhileHeld();
    act(() => {
      harness.registry.update(BOARD_PATH, {
        frame: window.document.createElement("iframe"),
      });
    });
    await answerAndSettle(answer);
    expect(pendingSaves).toHaveLength(0);
  });

  it("does not start a second gesture while the first one waits", async () => {
    const { answer } = await dragWhileHeld();
    const edge = handle("Reorder element (1)");
    startDrag(edge, { x: 20, y: 5 });
    dragTo(edge, BEFORE_C);
    release(edge, BEFORE_C);
    await answerAndSettle(answer);
    expect(pendingSaves).toHaveLength(1);
  });
});

describe("the frame moves during a gesture", () => {
  it("cancels the drag when the canvas is panned or zoomed under it", async () => {
    const { harness, container } = await mountOverlay(
      rowLayout(),
      FRAME_ACTUAL,
    );
    const edge = handle("Reorder element (1)");
    startDrag(edge, { x: 20, y: 5 });
    harness.frame.getBoundingClientRect = () => new DOMRect(50, 0, 800, 400);
    dragTo(edge, BEFORE_C);
    expect(insertionMarker(container)).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(CHANGED);
    release(edge, BEFORE_C);
    await settleLayout();
    expect(pendingSaves).toHaveLength(0);
  });
});

describe("a pointer that loses its capture", () => {
  it("abandons the gesture", async () => {
    const { container } = await mountOverlay(rowLayout(), FRAME_ACTUAL);
    const edge = handle("Reorder element (1)");
    startDrag(edge, { x: 20, y: 5 });
    dragTo(edge, BEFORE_C);
    expect(insertionMarker(container)).not.toBeNull();
    fireEvent.lostPointerCapture(edge, POINTER);
    expect(insertionMarker(container)).toBeNull();
  });
});

describe("source the host cannot reorder", () => {
  // The page reports ordinary geometry for table rows, so only the file's own
  // markup can say a row may not move. A resize writes a style on the row and
  // stays possible.
  const TABLE = structureDocument(
    `<table><tbody data-tid="body"><tr data-tid="r1"><td>a</td></tr><tr data-tid="r2"><td>b</td></tr></tbody></table>`,
  );

  it("disables the reorder handles of a table row but keeps its resize handles", async () => {
    const layout = layoutOf(TABLE, "body", {
      r1: flowAt(0, 0, 100, 50),
      r2: flowAt(0, 50, 100, 50),
    });
    const harness = structureHarness({ ...layout, axis: "y" }, FRAME_ACTUAL);
    const selection = selectionFor(elementFor(TABLE, "r1"));
    selectOnly(selection);
    render(
      <TooltipProvider>
        <CanvasStructureOverlay
          selection={selection}
          registry={harness.registry}
          document={TABLE}
        />
      </TooltipProvider>,
    );
    await settleLayout();

    expect(handle("Resize element bottom right").hasAttribute("disabled")).toBe(
      false,
    );
    for (const index of [1, 2, 3, 4])
      expect(
        handle(`Reorder element (${index})`).hasAttribute("disabled"),
      ).toBe(true);
  });
});

describe("a set of several elements", () => {
  it("offers no reorder or resize handles, only outlines", async () => {
    const layout = rowLayout();
    const harness = structureHarness(layout, FRAME_ACTUAL);
    const primary = selectionFor(elementFor(DOCUMENT, "a"));
    selectSet(primary, [selectionFor(elementFor(DOCUMENT, "b"))], layout);
    const { container } = render(
      <TooltipProvider>
        <CanvasStructureOverlay
          selection={primary}
          registry={harness.registry}
          document={DOCUMENT}
        />
      </TooltipProvider>,
    );
    await settleLayout();

    expect(
      screen.queryByRole("button", { name: /Reorder element/ }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Resize element/ })).toBeNull();
    expect(
      container.querySelectorAll("[data-canvas-additional-outline]"),
    ).toHaveLength(1);
  });
});

describe("a save that comes back", () => {
  it("leaves the overlay usable for the next gesture", async () => {
    await mountOverlay(rowLayout(), FRAME_ACTUAL);
    const corner = handle("Resize element bottom right");
    startDrag(corner, { x: 100, y: 100 });
    release(corner, { x: 140, y: 120 });
    await settleLayout();
    expect(pendingSaves).toHaveLength(1);
    await settleSave(0, SAVED);

    startDrag(corner, { x: 100, y: 100 });
    release(corner, { x: 130, y: 110 });
    await settleLayout();
    expect(pendingSaves).toHaveLength(2);
  });
});
