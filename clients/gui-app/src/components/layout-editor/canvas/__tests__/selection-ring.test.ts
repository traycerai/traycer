import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSelectionRing,
  insideWindow,
  type SelectionRingController,
} from "@/components/layout-editor/canvas/selection-ring";

let ring: SelectionRingController | null = null;
let measured = 0;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A region whose rect is a MUTABLE fact, because that is what the canvas is: a
 * dock switch or a ghost appearing beside a region moves its box without
 * touching the element.
 */
function region(rect: Rect): HTMLElement & { moveTo: (next: Rect) => void } {
  let current = rect;
  const node = document.createElement("div");
  node.getBoundingClientRect = (): DOMRect => {
    measured += 1;
    return new DOMRect(current.x, current.y, current.width, current.height);
  };
  document.body.append(node);
  return Object.assign(node, {
    moveTo: (next: Rect): void => {
      current = next;
    },
  });
}

function ringElement(): HTMLElement {
  const element = document.querySelector("[data-layout-selection-ring]");
  if (!(element instanceof HTMLElement))
    throw new Error("the ring element is not mounted");
  return element;
}

/** The ring's painted box, as numbers: jsdom rewrites "206.00px" to "206px". */
function ringBox(): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const element = ringElement();
  const translate = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(
    element.style.transform,
  );
  if (translate === null) throw new Error("the ring has no transform");
  return {
    x: Number(translate[1]),
    y: Number(translate[2]),
    width: Number.parseFloat(element.style.width),
    height: Number.parseFloat(element.style.height),
  };
}

function frames(count: number): void {
  for (let frame = 0; frame < count; frame += 1) vi.advanceTimersByTime(17);
}

beforeEach(() => {
  measured = 0;
  vi.useFakeTimers();
  ring = createSelectionRing();
});

afterEach(() => {
  ring?.destroy();
  ring = null;
  vi.useRealTimers();
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-reduce-panel-motion");
});

describe("the one shared ring", () => {
  it("mounts exactly one element and keeps it away until something is selected", () => {
    expect(
      document.querySelectorAll("[data-layout-selection-ring]"),
    ).toHaveLength(1);
    expect(ringElement().hidden).toBe(true);
  });

  it("places itself around the tracked region, padded", () => {
    ring?.track(region({ x: 100, y: 50, width: 200, height: 30 }));
    frames(2);

    expect(ringElement().hidden).toBe(false);
    expect(ringBox()).toEqual({ x: 97, y: 47, width: 206, height: 36 });
    expect(ringElement().getAttribute("data-on")).toBe("1");
  });

  it("keeps every band it paints inside the window (LV2-16)", () => {
    // A region on the window's last pixel row - the status bar's usage row is
    // one - padded by 3 and painted with a 6px halo outside that puts the
    // ring's bottom band 9px off screen, where the browser clips it and the
    // selection reads as an open box. jsdom's window is 1024 x 768, and the
    // region below sits flush on its bottom edge and 2px from its left one.
    ring?.track(region({ x: 2, y: 746, width: 318, height: 22 }));
    frames(2);

    expect(ringBox()).toEqual({ x: 6, y: 743, width: 317, height: 19 });
  });

  it("lets a region that has left the window take the ring with it", () => {
    // The clamp shrinks the ring onto the visible part of its region; with no
    // visible part there is nothing to frame, and a box collapsed against the
    // edge would draw a bar there instead of leaving with the region.
    ring?.track(region({ x: 100, y: -400, width: 200, height: 30 }));
    frames(2);

    expect(ringBox()).toEqual({ x: 97, y: -403, width: 206, height: 36 });
  });

  it("follows a region that MOVED without resizing, with nothing waking it (L-90)", () => {
    // The bug the owner reported: a dock-side switch moves the app column
    // 320px sideways without resizing anything, so the node's own
    // `ResizeObserver` stays silent, no window scroll or resize fires, and
    // neither store the parked loop listened to is written by the panel's own
    // dock preference. Nothing here wakes the ring either - it re-reads.
    const node = region({ x: 100, y: 50, width: 200, height: 30 });
    document.documentElement.setAttribute("data-reduce-panel-motion", "");
    ring?.track(node);
    frames(2);
    expect(ringBox()).toEqual({ x: 97, y: 47, width: 206, height: 36 });

    node.moveTo({ x: 420, y: 50, width: 200, height: 30 });
    frames(1);

    expect(ringBox()).toEqual({ x: 417, y: 47, width: 206, height: 36 });
  });

  it("costs one rect read and no write on a frame where nothing moved (G1-04)", () => {
    // The budget the parked loop existed to protect, kept by an idle frame
    // rather than by a wake list: the rect is read, found unchanged, and the
    // frame ends without stepping a spring or touching a style.
    const node = region({ x: 100, y: 50, width: 200, height: 30 });
    ring?.track(node);
    frames(4);
    const atRest = measured;
    const painted = ringElement().style.transform;

    frames(10);

    expect(measured - atRest).toBe(10);
    expect(ringElement().style.transform).toBe(painted);
  });

  it("does not restart the travel for a re-track of the node it is already on", () => {
    // The canvas painter runs on every editor-store notification - a hover, a
    // filter keystroke - and calls `track` on each of them.
    const node = region({ x: 100, y: 50, width: 200, height: 30 });
    ring?.track(node);
    frames(40);
    const painted = ringElement().style.transform;

    ring?.track(node);
    ring?.track(node);
    frames(4);

    expect(ringElement().style.transform).toBe(painted);
  });

  it("travels to a second region rather than jumping to it", () => {
    ring?.track(region({ x: 100, y: 50, width: 200, height: 30 }));
    frames(2);

    ring?.track(region({ x: 600, y: 400, width: 100, height: 20 }));
    frames(2);
    const travelling = ringBox();
    expect(travelling.x).toBeGreaterThan(97);
    expect(travelling.x).toBeLessThan(597);

    frames(60);
    expect(ringBox().x).toBeCloseTo(597, 1);
    expect(ringBox().y).toBeCloseTo(397, 1);
  });

  it("snaps instead of travelling under reduced motion", () => {
    ring?.track(region({ x: 100, y: 50, width: 200, height: 30 }));
    frames(2);

    document.documentElement.setAttribute("data-reduce-panel-motion", "");
    ring?.track(region({ x: 600, y: 400, width: 100, height: 20 }));
    frames(1);

    expect(ringBox()).toEqual({ x: 597, y: 397, width: 106, height: 26 });
  });

  it("stops measuring on deselect", () => {
    ring?.track(region({ x: 100, y: 50, width: 200, height: 30 }));
    frames(2);

    ring?.track(null);
    const atRest = measured;
    frames(20);

    expect(ringElement().hidden).toBe(true);
    expect(ringElement().hasAttribute("data-on")).toBe(false);
    expect(measured).toBe(atRest);
  });

  it("takes its element with it when destroyed", () => {
    ring?.destroy();
    ring = null;

    expect(
      document.querySelectorAll("[data-layout-selection-ring]"),
    ).toHaveLength(0);
  });
});

describe("insideWindow", () => {
  // `RING_BLEED` in selection-ring.ts: the room the ring's halo needs outside
  // the box it frames. The constant is private, so the literal is written here.
  const RING_BLEED = 6;
  const WINDOW_WIDTH = 1000;
  const WINDOW_HEIGHT = 700;
  const originalWidth = window.innerWidth;
  const originalHeight = window.innerHeight;

  function setWindowSize(width: number, height: number): void {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: width,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      writable: true,
      value: height,
    });
  }

  beforeEach(() => {
    setWindowSize(WINDOW_WIDTH, WINDOW_HEIGHT);
  });

  afterEach(() => {
    setWindowSize(originalWidth, originalHeight);
  });

  it("shrinks a box on the window's last row to end RING_BLEED px inside the bottom edge", () => {
    // Flush with the bottom edge: it ends on the window's last pixel row.
    const box = { x: 100, y: WINDOW_HEIGHT - 22, width: 300, height: 22 };

    const clamped = insideWindow(box);

    expect(clamped.y + clamped.height).toBe(WINDOW_HEIGHT - RING_BLEED);
    // Shrunk, not moved: the edge the ring frames stays on the element's own.
    expect(clamped.y).toBe(box.y);
    expect(clamped.height).toBe(22 - RING_BLEED);
  });

  it("shrinks a box on the window's last column to end RING_BLEED px inside the right edge", () => {
    const box = { x: WINDOW_WIDTH - 200, y: 100, width: 200, height: 40 };

    const clamped = insideWindow(box);

    expect(clamped.x + clamped.width).toBe(WINDOW_WIDTH - RING_BLEED);
    expect(clamped.x).toBe(box.x);
    expect(clamped.width).toBe(200 - RING_BLEED);
  });

  it("starts a box touching the top and left edges RING_BLEED px inside them", () => {
    const box = { x: 0, y: 0, width: 300, height: 100 };

    const clamped = insideWindow(box);

    expect(clamped.x).toBe(RING_BLEED);
    expect(clamped.y).toBe(RING_BLEED);
    // The far edges stay where they were: only the near side was shrunk.
    expect(clamped.x + clamped.width).toBe(300);
    expect(clamped.y + clamped.height).toBe(100);
  });

  it("returns a box that is wholly inside the window unchanged", () => {
    const box = { x: 100, y: 120, width: 300, height: 80 };

    expect(insideWindow(box)).toEqual(box);
  });

  it("keeps the true box of a region that has left the window entirely", () => {
    // One region beyond each edge. Each would collapse to a zero or negative
    // extent under the clamp, which draws a bar against the edge instead of
    // leaving with the region, so the true box comes back.
    const above = { x: 100, y: -400, width: 200, height: 30 };
    const below = { x: 100, y: WINDOW_HEIGHT + 100, width: 200, height: 30 };
    const beforeLeft = { x: -500, y: 100, width: 200, height: 30 };
    const afterRight = {
      x: WINDOW_WIDTH + 100,
      y: 100,
      width: 200,
      height: 30,
    };

    expect(insideWindow(above)).toEqual(above);
    expect(insideWindow(below)).toEqual(below);
    expect(insideWindow(beforeLeft)).toEqual(beforeLeft);
    expect(insideWindow(afterRight)).toEqual(afterRight);
  });
});
