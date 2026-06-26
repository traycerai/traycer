import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findNeighbor,
  readTileRects,
  type TileRect,
} from "@/lib/keybindings/tile-geometry";

function rect(id: string, box: [number, number, number, number]): TileRect {
  const [x, y, width, height] = box;
  return { id, rect: { x, y, width, height } };
}

describe("findNeighbor", () => {
  // A | B  (horizontal split)
  // A is 0..100 x 0..100, B is 100..200 x 0..100
  const a = rect("a", [0, 0, 100, 100]);
  const b = rect("b", [100, 0, 100, 100]);
  // C stacked below A
  const c = rect("c", [0, 100, 100, 100]);

  it("finds right neighbour", () => {
    expect(findNeighbor(a, [a, b, c], "right")).toBe("b");
  });

  it("finds left neighbour", () => {
    expect(findNeighbor(b, [a, b, c], "left")).toBe("a");
  });

  it("finds tile below", () => {
    expect(findNeighbor(a, [a, b, c], "down")).toBe("c");
  });

  it("returns null when nothing lies in the requested direction", () => {
    expect(findNeighbor(a, [a, b, c], "up")).toBeNull();
    expect(findNeighbor(a, [a, b, c], "left")).toBeNull();
  });

  it("prefers the closer candidate on primary axis", () => {
    const near = rect("near", [110, 0, 100, 100]);
    const far = rect("far", [300, 0, 100, 100]);
    expect(findNeighbor(a, [a, near, far], "right")).toBe("near");
  });

  // Repro for the "bottom-left → right goes to top instead of right-bottom"
  // bug: a wide top pane spans both columns, but from the bottom-left tile
  // "right" must land on the bottom-right tile, not the top.
  //
  //   ┌───────────────────────┐
  //   │          top          │   (full width, y 0..300)
  //   ├───────────┬───────────┤
  //   │ bottomL   │ bottomR   │   (y 300..600)
  //   └───────────┴───────────┘
  it("picks the aligned neighbour over a wide unaligned pane", () => {
    const top = rect("top", [0, 0, 1000, 300]);
    const bottomL = rect("bottomL", [0, 300, 500, 300]);
    const bottomR = rect("bottomR", [500, 300, 500, 300]);
    const tiles = [top, bottomL, bottomR];
    expect(findNeighbor(bottomL, tiles, "right")).toBe("bottomR");
    expect(findNeighbor(bottomR, tiles, "left")).toBe("bottomL");
    expect(findNeighbor(bottomL, tiles, "up")).toBe("top");
    expect(findNeighbor(bottomR, tiles, "up")).toBe("top");
    expect(findNeighbor(top, tiles, "down")).toBe("bottomL");
  });

  // Symmetric case: wide bottom pane below a top-split column pair.
  it("picks the aligned neighbour when the wide pane is below", () => {
    const topL = rect("topL", [0, 0, 500, 300]);
    const topR = rect("topR", [500, 0, 500, 300]);
    const bottom = rect("bottom", [0, 300, 1000, 300]);
    const tiles = [topL, topR, bottom];
    expect(findNeighbor(topL, tiles, "right")).toBe("topR");
    expect(findNeighbor(topR, tiles, "left")).toBe("topL");
    expect(findNeighbor(topL, tiles, "down")).toBe("bottom");
    expect(findNeighbor(topR, tiles, "down")).toBe("bottom");
  });
});

// Regression: a split resize handle sits on the seam between two panes, so it
// scores better than the true neighbour pane in `findNeighbor` (primaryGap 0
// vs ~handle-width). It must therefore NOT be a focus target. The handle is
// kept off `data-group-id` (it uses `data-resize-group-id`), so `readTileRects`
// excludes it and downstream navigation lands on the neighbour pane - never on
// the handle's split-group id, which no pane matches (a silent no-op).
describe("readTileRects excludes split resize handles", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  function appendBox(
    parent: HTMLElement,
    attr: "data-group-id" | "data-resize-group-id",
    id: string,
    box: [number, number, number, number],
  ): HTMLElement {
    const [x, y, width, height] = box;
    const el = document.createElement("div");
    el.setAttribute(attr, id);
    parent.append(el);
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue(
      new DOMRect(x, y, width, height),
    );
    return el;
  }

  it("collects panes only, so cross-split focus lands on the neighbour pane", () => {
    // Real horizontal-split geometry (split-container.tsx, flex-row):
    //   [ pane-A (grow) ][ handle w-px ][ pane-B (grow) ]
    // The 1px handle sits exactly on the seam at x=499.5.
    const container = document.createElement("div");
    document.body.append(container);
    appendBox(container, "data-group-id", "pane-A", [0, 0, 499.5, 600]);
    appendBox(
      container,
      "data-resize-group-id",
      "group-root",
      [499.5, 0, 1, 600],
    );
    appendBox(container, "data-group-id", "pane-B", [500.5, 0, 499.5, 600]);

    const rects = readTileRects(container);

    // The handle's split-group id must be absent entirely.
    expect([...rects.map((r) => r.id)].sort()).toEqual(["pane-A", "pane-B"]);
    expect(rects.some((r) => r.id === "group-root")).toBe(false);

    const paneA = rects.find((r) => r.id === "pane-A");
    const paneB = rects.find((r) => r.id === "pane-B");
    if (paneA === undefined || paneB === undefined) {
      throw new Error("expected both pane rects to be collected");
    }
    expect(findNeighbor(paneA, rects, "right")).toBe("pane-B");
    expect(findNeighbor(paneB, rects, "left")).toBe("pane-A");
  });
});
