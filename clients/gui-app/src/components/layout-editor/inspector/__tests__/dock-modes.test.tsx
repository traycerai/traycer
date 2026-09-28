import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clampFloatPosition,
  defaultFloatPosition,
  DOCK_EDGE_SNAP_PX,
  edgeSnapDockMode,
  floatDockHeight,
  FLOAT_DOCK_WIDTH,
  restingFloatPosition,
  useFloatingDock,
} from "@/components/layout-editor/inspector/dock-modes";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";

const VIEWPORT = { width: 1400, height: 900 };

/**
 * jsdom has no pointer capture, which is a browser input facility rather than
 * anything this module decides - stubbed so the drag itself can be driven.
 */
function stubPointerCapture(node: HTMLElement): void {
  node.setPointerCapture = () => undefined;
  node.releasePointerCapture = () => undefined;
  node.hasPointerCapture = () => true;
}

function mountPanel(): HTMLDivElement {
  const panel = document.createElement("div");
  const header = document.createElement("div");
  header.setAttribute("data-layout-inspector-header", "");
  panel.append(header);
  document.body.append(panel);
  stubPointerCapture(panel);
  return panel;
}

function header(panel: HTMLElement): HTMLElement {
  const node = panel.querySelector<HTMLElement>(
    "[data-layout-inspector-header]",
  );
  if (node === null) throw new Error("expected a header");
  return node;
}

function pointer(type: string, x: number, y: number): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    pointerId: 1,
  });
}

function setViewport(): void {
  for (const [key, value] of Object.entries({
    innerWidth: VIEWPORT.width,
    innerHeight: VIEWPORT.height,
  })) {
    Object.defineProperty(window, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
}

beforeEach(() => {
  setViewport();
  useLayoutEditorStore.setState({ dockMode: "float", floatPosition: null });
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  useLayoutEditorStore.setState({ dockMode: "right", floatPosition: null });
});

describe("float geometry (5.4, section 6)", () => {
  it("keeps the panel inside the window, and off the chrome above the app", () => {
    // `y` floors at the top inset rather than at 0: the app's own header is up
    // there, and a panel over it takes the title bar's drag region with it.
    expect(clampFloatPosition({ x: -400, y: -80 }, VIEWPORT)).toEqual({
      x: 0,
      y: 28,
    });
    expect(clampFloatPosition({ x: 10, y: 0 }, VIEWPORT).y).toBe(28);
    expect(clampFloatPosition({ x: 9000, y: 9000 }, VIEWPORT)).toEqual({
      x: VIEWPORT.width - FLOAT_DOCK_WIDTH,
      y: VIEWPORT.height - floatDockHeight(VIEWPORT.height),
    });
  });

  it("is 560px tall until the window is short, then leaves a margin", () => {
    expect(floatDockHeight(900)).toBe(560);
    expect(floatDockHeight(500)).toBe(500 - 92);
  });

  it("opens near the top right and never off-screen on a small window", () => {
    expect(defaultFloatPosition(VIEWPORT).x).toBeLessThan(
      VIEWPORT.width - FLOAT_DOCK_WIDTH,
    );
    // Narrower than the panel: the default is flush left rather than negative.
    expect(defaultFloatPosition({ width: 240, height: 300 }).x).toBe(0);
  });

  it("opens a remembered float where it is floating, never on a dock's band (LV2-17)", () => {
    // A position remembered on a wider window: the clamp puts it flush against
    // the right edge, which is exactly where the right dock sits - so choosing
    // Float looked like a no-op until the user dragged the panel off it. The
    // clamp cannot refuse that band, because a drag reaches the snap zone
    // through it; the RESTING position is where the distinction belongs.
    const remembered = { x: 9000, y: 290 };
    expect(clampFloatPosition(remembered, VIEWPORT).x).toBe(
      VIEWPORT.width - FLOAT_DOCK_WIDTH,
    );
    expect(
      edgeSnapDockMode(clampFloatPosition(remembered, VIEWPORT), VIEWPORT),
    ).toBe("right");

    expect(restingFloatPosition(remembered, VIEWPORT)).toEqual(
      defaultFloatPosition(VIEWPORT),
    );
    // A position that is genuinely floating is still the user's own.
    expect(restingFloatPosition({ x: 500, y: 200 }, VIEWPORT)).toEqual({
      x: 500,
      y: 200,
    });
    expect(restingFloatPosition(null, VIEWPORT)).toEqual(
      defaultFloatPosition(VIEWPORT),
    );
  });

  it("docks to the side a release lands near, and nowhere else", () => {
    expect(edgeSnapDockMode({ x: DOCK_EDGE_SNAP_PX, y: 10 }, VIEWPORT)).toBe(
      "left",
    );
    expect(
      edgeSnapDockMode(
        { x: VIEWPORT.width - FLOAT_DOCK_WIDTH - DOCK_EDGE_SNAP_PX, y: 10 },
        VIEWPORT,
      ),
    ).toBe("right");
    expect(edgeSnapDockMode({ x: 500, y: 10 }, VIEWPORT)).toBeNull();
  });
});

describe("dragging the panel by its header (L-38)", () => {
  it("remembers where the user dropped it", () => {
    const panel = mountPanel();
    renderHook(() => useFloatingDock(panel));

    act(() => {
      header(panel).dispatchEvent(pointer("pointerdown", 700, 200));
      panel.dispatchEvent(pointer("pointermove", 760, 260));
      panel.dispatchEvent(pointer("pointerup", 760, 260));
    });

    // The node starts at 0,0 in jsdom, so the drop lands on the delta.
    expect(useLayoutEditorStore.getState().floatPosition).toEqual({
      x: 60,
      y: 60,
    });
    expect(useLayoutEditorStore.getState().dockMode).toBe("float");
  });

  it("docks to the side when the release lands near an edge, and forgets where it was", () => {
    const panel = mountPanel();
    // A position the user really left behind, so the assertion below is about
    // the snap CLEARING it rather than about it never having been set (I-15).
    act(() => {
      useLayoutEditorStore.getState().setFloatPosition({ x: 500, y: 200 });
    });
    renderHook(() => useFloatingDock(panel));

    act(() => {
      header(panel).dispatchEvent(pointer("pointerdown", 700, 200));
      panel.dispatchEvent(pointer("pointermove", 2000, 200));
      panel.dispatchEvent(pointer("pointerup", 2000, 200));
    });

    expect(useLayoutEditorStore.getState().dockMode).toBe("right");
    // The side IS the memory now; no stale float position competes with it.
    expect(useLayoutEditorStore.getState().floatPosition).toBeNull();
  });

  it("ignores a press on a control in the header", () => {
    const panel = mountPanel();
    const button = document.createElement("button");
    header(panel).append(button);
    renderHook(() => useFloatingDock(panel));

    act(() => {
      button.dispatchEvent(pointer("pointerdown", 700, 200));
      panel.dispatchEvent(pointer("pointermove", 760, 260));
      panel.dispatchEvent(pointer("pointerup", 760, 260));
    });

    expect(useLayoutEditorStore.getState().floatPosition).toBeNull();
  });

  it("does not pick a drag up from the body", () => {
    const panel = mountPanel();
    const body = document.createElement("div");
    panel.append(body);
    renderHook(() => useFloatingDock(panel));

    act(() => {
      body.dispatchEvent(pointer("pointerdown", 700, 200));
      panel.dispatchEvent(pointer("pointermove", 760, 260));
      panel.dispatchEvent(pointer("pointerup", 760, 260));
    });

    expect(useLayoutEditorStore.getState().floatPosition).toBeNull();
  });
});
