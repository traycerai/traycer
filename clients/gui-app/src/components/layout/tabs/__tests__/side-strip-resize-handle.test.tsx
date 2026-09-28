/**
 * The vertical strip's width handle (S-20) on the shared pointer machine: the
 * width follows the pointer toward the content on either edge, the arrow keys
 * mirror with the edge, a drag from the rail that ends short stays on it,
 * double-click resets, and the stored width stays inside 192..400.
 *
 * The snap point's live layout, its commit and the width easing on a crossing
 * are `side-tab-strip.test.tsx`'s, through the real strip and its real easing.
 */
import { useRef, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { pointerEvent } from "@/components/epic-canvas/canvas/__tests__/test-pointer-events";
import { GROUND_RESIZE_HANDLE_LINE_CLASS } from "@/components/epic-canvas/canvas/use-pointer-drag-commit";
import { SideStripResizeHandle } from "@/components/layout/tabs/side-strip/side-strip-resize-handle";
import {
  SIDE_STRIP_DEFAULT_WIDTH_PX,
  SIDE_STRIP_MAX_WIDTH_PX,
  SIDE_STRIP_MIN_WIDTH_PX,
  SIDE_STRIP_RAIL_WIDTH_PX,
} from "@/components/layout/tabs/side-strip/side-strip-tokens";
import type { EdgeSide } from "@/lib/layout/layout-arrangement";
import { useSideTabStripStore } from "@/stores/layout/side-tab-strip-store";

const POINTER_ID = 3;

/** The width easing hooks: nothing here observes them. */
function noop(): void {
  // Intentionally empty.
}

function Harness(props: { readonly edge: EdgeSide }): ReactNode {
  const stripRef = useRef<HTMLElement | null>(null);
  return (
    <nav ref={stripRef} data-testid="strip">
      <SideStripResizeHandle
        edge={props.edge}
        stripRef={stripRef}
        easeWidth={noop}
        stopWidthEasing={noop}
      />
    </nav>
  );
}

/**
 * Renders the handle with the strip measuring `measuredWidth` px until a drag
 * frame writes an inline width, and that width (never under `floorPx`, the
 * strip's own min-width class) after.
 */
function renderHandle(
  edge: EdgeSide,
  measuredWidth: number,
  floorPx: number,
): { readonly handle: HTMLElement; readonly strip: HTMLElement } {
  render(<Harness edge={edge} />);
  const strip = screen.getByTestId("strip");
  vi.spyOn(strip, "getBoundingClientRect").mockImplementation(() => {
    const inline = Number.parseFloat(strip.style.width);
    const width = Number.isNaN(inline) ? measuredWidth : inline;
    return new DOMRect(0, 0, Math.max(floorPx, width), 800);
  });
  return { handle: screen.getByTestId("side-tab-strip-resize-handle"), strip };
}

function drag(handle: HTMLElement, fromX: number, toX: number): void {
  fireEvent(
    handle,
    pointerEvent("pointerdown", {
      pointerId: POINTER_ID,
      clientX: fromX,
      clientY: 10,
      button: 0,
    }),
  );
  fireEvent(
    handle,
    pointerEvent("pointermove", {
      pointerId: POINTER_ID,
      clientX: toX,
      clientY: 10,
      button: 0,
    }),
  );
}

function release(handle: HTMLElement, atX: number): void {
  fireEvent(
    handle,
    pointerEvent("pointerup", {
      pointerId: POINTER_ID,
      clientX: atX,
      clientY: 10,
      button: 0,
    }),
  );
}

describe("SideStripResizeHandle", () => {
  beforeEach(() => {
    useSideTabStripStore.setState({
      widthPx: SIDE_STRIP_DEFAULT_WIDTH_PX,
      collapsed: false,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useSideTabStripStore.setState({
      widthPx: SIDE_STRIP_DEFAULT_WIDTH_PX,
      collapsed: false,
    });
  });

  it("follows the pointer on a left strip and commits the width on release", () => {
    const { handle, strip } = renderHandle("left", 240, 0);

    drag(handle, 500, 540);
    expect(strip.style.width).toBe("280px");
    // Nothing is stored until the release.
    expect(useSideTabStripStore.getState().widthPx).toBe(240);

    release(handle, 540);
    expect(useSideTabStripStore.getState()).toMatchObject({
      widthPx: 280,
      collapsed: false,
    });
  });

  it("follows the pointer inversely on a right strip", () => {
    const { handle, strip } = renderHandle("right", 240, 0);

    drag(handle, 500, 460);
    expect(strip.style.width).toBe("280px");
    release(handle, 460);
    expect(useSideTabStripStore.getState().widthPx).toBe(280);
  });

  it("grows a left strip on ArrowRight and a right strip on ArrowLeft", () => {
    const left = renderHandle("left", 240, 0);
    fireEvent.keyDown(left.handle, { key: "ArrowRight" });
    expect(useSideTabStripStore.getState().widthPx).toBe(264);
    fireEvent.keyDown(left.handle, { key: "ArrowLeft" });
    expect(useSideTabStripStore.getState().widthPx).toBe(240);
    cleanup();

    const right = renderHandle("right", 240, 0);
    fireEvent.keyDown(right.handle, { key: "ArrowLeft" });
    expect(useSideTabStripStore.getState().widthPx).toBe(264);
    fireEvent.keyDown(right.handle, { key: "ArrowRight" });
    expect(useSideTabStripStore.getState().widthPx).toBe(240);
  });

  it("stays on the rail when a drag from it ends short of the snap point", () => {
    useSideTabStripStore.setState({ collapsed: true });
    const { handle } = renderHandle("left", SIDE_STRIP_RAIL_WIDTH_PX, 0);

    drag(handle, 100, 150);
    release(handle, 150);

    expect(useSideTabStripStore.getState().collapsed).toBe(true);
  });

  it("resets to the default width on double-click", () => {
    useSideTabStripStore.setState({ widthPx: 360, collapsed: true });
    const { handle } = renderHandle("left", SIDE_STRIP_RAIL_WIDTH_PX, 0);

    fireEvent.doubleClick(handle);

    expect(useSideTabStripStore.getState()).toMatchObject({
      widthPx: SIDE_STRIP_DEFAULT_WIDTH_PX,
      collapsed: false,
    });
  });

  it("clamps the stored width to 192..400", () => {
    const { handle, strip } = renderHandle("left", 240, 0);

    drag(handle, 500, 1500);
    expect(strip.style.width).toBe(`${SIDE_STRIP_MAX_WIDTH_PX}px`);
    release(handle, 1500);
    expect(useSideTabStripStore.getState().widthPx).toBe(
      SIDE_STRIP_MAX_WIDTH_PX,
    );
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(useSideTabStripStore.getState().widthPx).toBe(
      SIDE_STRIP_MAX_WIDTH_PX,
    );
    expect(handle.getAttribute("aria-valuenow")).toBe(
      String(SIDE_STRIP_MAX_WIDTH_PX),
    );

    // Settling now WRITES the released width (F9), so the strip measures
    // 400px here, not the original 240px: this lands at 150px, above the
    // snap point but below the minimum.
    drag(handle, 500, 250);
    release(handle, 250);
    expect(useSideTabStripStore.getState()).toMatchObject({
      widthPx: SIDE_STRIP_MIN_WIDTH_PX,
      collapsed: false,
    });
  });

  it("previews the minimum, not the pointer, between the snap point and 192px", () => {
    const { handle, strip } = renderHandle("left", 240, 0);

    // 240 - 90 = 150px: above the snap point, below the minimum.
    drag(handle, 500, 410);
    expect(strip.style.width).toBe(`${SIDE_STRIP_MIN_WIDTH_PX}px`);
    release(handle, 410);
    expect(useSideTabStripStore.getState().widthPx).toBe(
      SIDE_STRIP_MIN_WIDTH_PX,
    );
  });

  it("stores the width the strip rendered when its own floor is wider", () => {
    // The title row's floor under the traffic lights (S-43).
    const { handle } = renderHandle("left", 240, 218);

    drag(handle, 500, 460);
    release(handle, 460);

    expect(useSideTabStripStore.getState().widthPx).toBe(218);
    expect(handle.getAttribute("aria-valuenow")).toBe("218");
  });

  it("carries the shared ground hover/drag line, and paints over it (finding 9)", () => {
    const { handle } = renderHandle("left", 240, 0);

    for (const token of GROUND_RESIZE_HANDLE_LINE_CLASS.split(" ")) {
      expect(handle.classList.contains(token)).toBe(true);
    }
    // The split-pair join bridge paints at z-21 and must stay above this
    // handle, so it cannot climb past z-20.
    expect(handle.classList.contains("z-20")).toBe(true);
  });

  it("names the rail in the slider's value text", () => {
    useSideTabStripStore.setState({ collapsed: true });
    const { handle } = renderHandle("left", SIDE_STRIP_RAIL_WIDTH_PX, 0);

    expect(handle.getAttribute("aria-valuetext")).toBe("Collapsed");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle.hasAttribute("aria-valuetext")).toBe(false);
  });
});
