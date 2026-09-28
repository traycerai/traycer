import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  registerTileSurfaceGeometryHost,
  registerTileSurfaceGeometrySlot,
  resetTileSurfaceGeometryCoordinatorForTesting,
  type TileSurfaceRect,
} from "@/components/epic-canvas/surface-host/tile-surface-geometry-coordinator";

/**
 * The global `MockResizeObserver` installed by `test-browser-apis.ts` is a
 * total no-op - it never invokes its callback. Installing a controllable
 * replacement at MODULE LOAD TIME (before any test body runs, so it is in
 * place before the coordinator's lazily-constructed singleton observer is
 * ever created) lets this suite prove a ResizeObserver callback never fires
 * for a sidebar-side flip - the real-world condition Staging F2 pins.
 * Mirrors `tile-canvas-remeasures-hosted-geometry.test.tsx`.
 */
class ControllableResizeObserver implements ResizeObserver {
  readonly callback: ResizeObserverCallback;
  readonly observed = new Set<Element>();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element): void {
    this.observed.add(target);
  }

  unobserve(target: Element): void {
    this.observed.delete(target);
  }

  disconnect(): void {
    this.observed.clear();
  }
}

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  writable: true,
  value: ControllableResizeObserver,
});

import { EpicSurfaceSheets } from "@/components/epic-tabs/epic-surface";

const TAB_ID = "tab-sheets-remeasure";
const SLOT_KEY = "content-slot";

function fakeRect(rect: {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}): DOMRect {
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => rect,
  };
}

function stubRect(
  element: Element,
  rect: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  },
): void {
  element.getBoundingClientRect = () => fakeRect(rect);
}

/**
 * `EpicSurfaceSheets` re-measures hosted geometry
 * (`remeasureTileSurfaceGeometry`) in a `useLayoutEffect` keyed on
 * `sidebarSide` (`epic-surface.tsx`), because flipping the task panel to the
 * other side moves the content sheet - and every hosted chat body painted
 * inside it - without resizing it. A `ResizeObserver` reports SIZE changes
 * only, so nothing about a side flip reaches the coordinator on its own
 * (Staging F2: the chat body stayed drawn over the flipped panel). This
 * suite never mounts `StableTileSurfaceHost`: it registers the geometry
 * host/slot directly (the same seam `StableTileSurfaceHost` uses in
 * production) and asserts the registered listener is re-invoked with the
 * POST-flip rect purely from `EpicSurfaceSheets`'s own layout effect, with
 * the `ControllableResizeObserver` above never triggered.
 */
describe("EpicSurfaceSheets re-measures hosted geometry on a sidebarSide flip", () => {
  let rects: TileSurfaceRect[] = [];
  let anchor: HTMLDivElement;

  beforeEach(() => {
    resetTileSurfaceGeometryCoordinatorForTesting();
    rects = [];

    const host = document.createElement("div");
    stubRect(host, { left: 0, top: 0, width: 1000, height: 600 });
    registerTileSurfaceGeometryHost(host);

    anchor = document.createElement("div");
    // The content sheet's position before the flip, with the sidebar on the left.
    stubRect(anchor, { left: 240, top: 0, width: 760, height: 600 });
    registerTileSurfaceGeometrySlot(SLOT_KEY, anchor, (rect) =>
      rects.push(rect),
    );
    // Registration delivers an initial rect synchronously - clear it so the
    // assertions below are scoped to what the flip itself produces.
    rects.length = 0;
  });

  afterEach(() => {
    cleanup();
    resetTileSurfaceGeometryCoordinatorForTesting();
  });

  it("re-applies the content slot's rect when sidebarSide flips, with no ResizeObserver callback", () => {
    const { rerender } = render(
      <EpicSurfaceSheets
        tabId={TAB_ID}
        sidebarSide="left"
        sidebar={<div data-testid="sidebar" />}
      >
        <div data-testid="body" />
      </EpicSurfaceSheets>,
    );

    // The mount layout effect also fires unconditionally (its deps are the
    // INITIAL `sidebarSide`), re-delivering the still-current (pre-flip)
    // rect. Clear that mount delivery so the negative control and the
    // post-flip assertion below are scoped to the flip alone.
    rects.length = 0;

    // The content sheet's DOM position after the flip: the sidebar moves to
    // the right, so the content sheet shifts to the origin while keeping its
    // exact width - a position-only move a ResizeObserver cannot see.
    stubRect(anchor, { left: 0, top: 0, width: 760, height: 600 });

    // Negative control: nothing has re-measured yet. The RO stub above is
    // controllable and untriggered, and re-stubbing `getBoundingClientRect`
    // is a plain data mutation - it does not itself invoke any listener.
    expect(rects).toEqual([]);

    act(() => {
      rerender(
        <EpicSurfaceSheets
          tabId={TAB_ID}
          sidebarSide="right"
          sidebar={<div data-testid="sidebar" />}
        >
          <div data-testid="body" />
        </EpicSurfaceSheets>,
      );
    });

    // The side flip alone (no RO callback ever fired) delivered exactly one
    // rect update, at the post-flip position.
    expect(rects).toEqual([{ left: 0, top: 0, width: 760, height: 600 }]);
  });

  it("orders the sidebar before the content pane on the left and after it on the right", () => {
    const { container, rerender } = render(
      <EpicSurfaceSheets
        tabId={TAB_ID}
        sidebarSide="left"
        sidebar={<div data-testid="sidebar" />}
      >
        <div data-testid="body" />
      </EpicSurfaceSheets>,
    );

    const row = container.querySelector(`[data-epic-surface="${TAB_ID}"]`);
    if (row === null) {
      throw new Error("expected the epic surface row to render");
    }

    const leftChildren = Array.from(row.children);
    const sidebarIndexLeft = leftChildren.findIndex(
      (el) => el.getAttribute("data-testid") === "sidebar",
    );
    const contentIndexLeft = leftChildren.findIndex(
      (el) => el.querySelector('[data-testid="body"]') !== null,
    );
    expect(sidebarIndexLeft).toBeGreaterThanOrEqual(0);
    expect(sidebarIndexLeft).toBeLessThan(contentIndexLeft);

    act(() => {
      rerender(
        <EpicSurfaceSheets
          tabId={TAB_ID}
          sidebarSide="right"
          sidebar={<div data-testid="sidebar" />}
        >
          <div data-testid="body" />
        </EpicSurfaceSheets>,
      );
    });

    const rightChildren = Array.from(row.children);
    const sidebarIndexRight = rightChildren.findIndex(
      (el) => el.getAttribute("data-testid") === "sidebar",
    );
    const contentIndexRight = rightChildren.findIndex(
      (el) => el.querySelector('[data-testid="body"]') !== null,
    );
    expect(contentIndexRight).toBeGreaterThanOrEqual(0);
    expect(contentIndexRight).toBeLessThan(sidebarIndexRight);
  });
});
