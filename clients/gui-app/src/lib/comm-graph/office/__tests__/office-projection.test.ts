import { describe, expect, it } from "vitest";
import {
  officeTileRectOf,
  OFFICE_PROJECTION_BLEED_PX,
} from "@/lib/comm-graph/office/office-projection";
import type {
  OfficeRect,
  OfficeTileRect,
} from "@/lib/comm-graph/office/office-types";
import { createIsoProjector } from "@/lib/comm-graph/office/views/isometric/iso-projector";
import type { OfficeProjector } from "@/lib/comm-graph/office/views/office-view";

/** The map the flat, oblique and amphitheatre views all use. */
const IDENTITY_PROJECTOR: OfficeProjector = {
  project: (col, row) => ({ x: col * 16, y: row * 16 }),
  bounds: { x: 0, y: 0, width: 16 * 400, height: 16 * 400 },
  seatLift: () => 0,
};

const ISO_PROJECTOR: OfficeProjector = createIsoProjector({
  cols: 200,
  rows: 200,
  stackHeight: 24,
  seatLift: () => 0,
});

/** The square a chunk of the static layer asks about. */
const CHUNK: OfficeRect = { x: 1024, y: 512, width: 512, height: 512 };

function containsTile(
  tiles: OfficeTileRect,
  col: number,
  row: number,
): boolean {
  return (
    col >= tiles.col &&
    col < tiles.col + tiles.cols &&
    row >= tiles.row &&
    row < tiles.row + tiles.rows
  );
}

describe("officeTileRectOf", () => {
  it.each([
    ["the flat and oblique views' identity", IDENTITY_PROJECTOR, 400, 400],
    ["an isometric shear", ISO_PROJECTOR, 200, 200],
  ])(
    "asks for every tile whose art lands in the rect under %s",
    (_name, projector, cols, rows) => {
      const tiles = officeTileRectOf({
        projector,
        cols,
        rows,
        rect: CHUNK,
        bleedPx: OFFICE_PROJECTION_BLEED_PX,
      });

      // Every tile the rect actually covers has to be in the answer, or the
      // caller paints a hole nothing ever fills.
      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          const point = projector.project(col, row);
          if (
            point.x < CHUNK.x ||
            point.x >= CHUNK.x + CHUNK.width ||
            point.y < CHUNK.y ||
            point.y >= CHUNK.y + CHUNK.height
          ) {
            continue;
          }
          expect(containsTile(tiles, col, row)).toBe(true);
        }
      }
    },
  );

  it.each([
    ["the identity", IDENTITY_PROJECTOR, 400, 400],
    ["an isometric shear", ISO_PROJECTOR, 200, 200],
  ])(
    "reaches the bleed past the rect's own edge under %s",
    (_name, projector, cols, rows) => {
      // THE SEAM CASE. A sprite anchored just outside the rect still draws
      // into it, so a tile one bleed away has to be asked for - this is the
      // wall at the edge of the viewport and the plant on a chunk boundary.
      //
      // Taken from the MIDDLE of the projected world, where the clamp to the
      // world's own grid cannot hide the difference the bleed makes.
      const bounds = projector.bounds;
      const middle: OfficeRect = {
        x: bounds.x + bounds.width / 2 - 256,
        y: bounds.y + bounds.height / 2 - 256,
        width: 512,
        height: 512,
      };
      const tiles = officeTileRectOf({
        projector,
        cols,
        rows,
        rect: middle,
        bleedPx: OFFICE_PROJECTION_BLEED_PX,
      });
      const tight = officeTileRectOf({
        projector,
        cols,
        rows,
        rect: middle,
        bleedPx: 0,
      });

      expect(tiles.col).toBeLessThan(tight.col);
      expect(tiles.row).toBeLessThan(tight.row);
      expect(tiles.col + tiles.cols).toBeGreaterThan(tight.col + tight.cols);
      expect(tiles.row + tiles.rows).toBeGreaterThan(tight.row + tight.rows);
    },
  );

  it("asks for a fraction of a large world, which is the whole point", () => {
    const tiles = officeTileRectOf({
      projector: IDENTITY_PROJECTOR,
      cols: 400,
      rows: 400,
      rect: { x: 0, y: 0, width: 512, height: 512 },
      bleedPx: OFFICE_PROJECTION_BLEED_PX,
    });

    expect(tiles.cols * tiles.rows).toBeLessThan((400 * 400) / 10);
  });

  it("clamps to the world, never off it", () => {
    const tiles = officeTileRectOf({
      projector: IDENTITY_PROJECTOR,
      cols: 20,
      rows: 20,
      rect: { x: 0, y: 0, width: 512, height: 512 },
      bleedPx: OFFICE_PROJECTION_BLEED_PX,
    });

    expect(tiles).toEqual({ col: 0, row: 0, cols: 20, rows: 20 });
  });

  it("asks for the whole world where the projection is not affine", () => {
    // Slower and still correct, which is the right way for a projector nobody
    // has written yet to fail. The bend is over DISTANCE: this projector
    // agrees with the identity at (1,1) and diverges across a world, which is
    // why the near probe alone is not the test.
    const curved: OfficeProjector = {
      project: (col, row) => ({ x: col * col * 16, y: row * 16 }),
      bounds: { x: 0, y: 0, width: 1600, height: 1600 },
      seatLift: () => 0,
    };

    expect(
      officeTileRectOf({
        projector: curved,
        cols: 30,
        rows: 30,
        rect: CHUNK,
        bleedPx: OFFICE_PROJECTION_BLEED_PX,
      }),
    ).toEqual({ col: 0, row: 0, cols: 30, rows: 30 });
  });

  it("asks for the whole world where the projection is degenerate", () => {
    const flattened: OfficeProjector = {
      project: (col, row) => ({ x: (col + row) * 16, y: (col + row) * 16 }),
      bounds: { x: 0, y: 0, width: 1600, height: 1600 },
      seatLift: () => 0,
    };

    expect(
      officeTileRectOf({
        projector: flattened,
        cols: 30,
        rows: 30,
        rect: CHUNK,
        bleedPx: 0,
      }),
    ).toEqual({ col: 0, row: 0, cols: 30, rows: 30 });
  });

  // THAT THE SIX REGISTERED VIEWS ARE ALL AFFINE - the assumption everything
  // above rests on - is pinned in `views/__tests__/office-plan-perf.test.ts`,
  // where the plan machinery to build their real layouts already lives.
});
