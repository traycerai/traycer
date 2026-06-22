import { describe, expect, it } from "vitest";
import { findNeighbor, type TileRect } from "@/lib/keybindings/tile-geometry";

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
