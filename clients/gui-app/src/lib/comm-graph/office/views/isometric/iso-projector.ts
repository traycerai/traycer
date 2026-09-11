/**
 * Tiles to screen for the two isometric views.
 *
 * One formula, built once per layout and never re-derived:
 *
 * ```
 * project(col, row) = { x: (col - row) * 16 + originX, y: (col + row) * 8 + originY }
 * ```
 *
 * `project` answers for the tile's CORNER `(col, row)` in the continuous tile
 * plane, which is why fractional arguments are meaningful: a walker between two
 * tiles is at a fractional corner, and a tile's centre is the corner at
 * `(col + 0.5, row + 0.5)`. One whole tile therefore projects to a 32x16
 * diamond whose TOP vertex is the projected corner - which is exactly the
 * bounding box of a `floor-iso-*` sprite drawn at `x - 16, y`.
 *
 * THE ORIGIN IS THE WHOLE POINT. `originX = rows * 16` pushes the left-most
 * column of the diamond back to zero, and `originY = H` - the tallest thing
 * STACKED on a tile, a city tower with its spire or a campus back wall - makes
 * room above the top corner for it. Nothing in the layout then projects
 * negative, which is what lets the renderer treat `bounds` as the world.
 *
 * It also means growth that adds ROWS moves every existing point right by
 * `16` per row, even though no tile moved. That is a projected delta, not a
 * `shiftFromPrevious`: the tiles are where they were, the camera compensates,
 * and the plan tests assert the delta is exactly `rows * 16`.
 */
import {
  OFFICE_CHARACTER_HEIGHT,
  OFFICE_TILE,
  type OfficePoint,
  type OfficeRect,
  type OfficeSeat,
} from "@/lib/comm-graph/office/office-types";
import type { OfficeProjector } from "@/lib/comm-graph/office/views/office-view";

/** Half the width of one projected tile diamond: a diamond is 32 x 16. */
export const ISO_HALF_WIDTH = OFFICE_TILE;
export const ISO_HALF_HEIGHT = OFFICE_TILE / 2;

/**
 * How tall one storey of a City building stands, in sprite pixels.
 *
 * A storey is one `block-left` / `block-right` slab, and those slabs are
 * authored as parallelograms that stack at this pitch. It is deliberately
 * shorter than a tile: seven storeys have to fit above a tile without the
 * skyline swallowing the streets it stands on.
 */
export const ISO_STOREY_HEIGHT = 8;

/** How far a `spire` rises above the roof it stands on. */
export const ISO_SPIRE_LIFT = 16;

/**
 * Where a drawable sits in the world stream.
 *
 * Depth is the projected y of the drawable's FOOT, because in this projection
 * "lower on screen" is "nearer the viewer" and nothing else is. Two feet can
 * land on the same line, though - a tile and the tile two columns along it do -
 * so ties break by `col + row` (the true distance from the back of the world)
 * and then by kind, which is the only ordering a floor, the thing standing on
 * it and the person standing on that can have.
 */
export type IsoDepthKind = "floor" | "prop" | "character";

const DEPTH_KIND_RANK: Readonly<Record<IsoDepthKind, number>> = {
  floor: 0,
  prop: 1,
  character: 2,
};

/**
 * Both tie-breakers folded into the FRACTION of one foot pixel.
 *
 * `depth` is one number by contract, and - this is the whole point - it is the
 * SAME number the scene gives its actors: D20's raw projected foot y. A
 * painter that scaled the foot up to make room for its tie-breakers would sort
 * every prop after every character no matter which foot was nearer, which is
 * exactly the occlusion the world stream exists to get right.
 *
 * So the tie-breakers live strictly below one pixel instead: `col + row` first
 * (the true distance from the back of the world), then kind. The cap and the
 * step are chosen so the largest possible fraction, `(1023 * 4 + 2) / 4096`,
 * is still under 1 - a tie-break can never outrank a real pixel of depth.
 *
 * A prop and a character never tie exactly, so the kind rank is not load
 * bearing between the two streams: a prop's foot is its tile's centre, at
 * `(col + row + 1) * 8`, and a character's is its tile's bottom centre, at
 * `(col + row + 1.5) * 8`. Whoever stands on a tile is always four pixels
 * nearer than what stands on it, which is the right answer anyway.
 */
const DEPTH_SCALE = 4096;
const DEPTH_COLROW_CAP = 1023;
const DEPTH_COLROW_STEP = 4;

export function isoDepth(
  footY: number,
  colRow: number,
  kind: IsoDepthKind,
): number {
  const clamped = Math.min(Math.max(Math.round(colRow), 0), DEPTH_COLROW_CAP);
  const tie = clamped * DEPTH_COLROW_STEP + DEPTH_KIND_RANK[kind];
  return footY + tie / DEPTH_SCALE;
}

export interface IsoProjectorSpec {
  readonly cols: number;
  readonly rows: number;
  /**
   * `H`: the tallest sprite STACKED on any one tile of this layout, measured
   * up from that tile's projected corner. Campus answers with its back wall,
   * City with its tallest tower plus the spire on it.
   */
  readonly stackHeight: number;
  /** City lifts an envelope's endpoint to the rooftop; Campus answers `0`. */
  readonly seatLift: (seat: OfficeSeat) => number;
}

export function createIsoProjector(spec: IsoProjectorSpec): OfficeProjector {
  const originX = spec.rows * ISO_HALF_WIDTH;
  const originY = spec.stackHeight;
  const project = (col: number, row: number): OfficePoint => ({
    x: (col - row) * ISO_HALF_WIDTH + originX,
    y: (col + row) * ISO_HALF_HEIGHT + originY,
  });
  const bounds: OfficeRect = {
    x: 0,
    y: 0,
    width: (spec.cols + spec.rows) * ISO_HALF_WIDTH,
    // The bottom corner, plus room for whoever is standing on it: a character
    // is drawn from its foot upward, but its sprite overhangs the tile it
    // stands on, and the union has to hold that too.
    height:
      (spec.cols + spec.rows) * ISO_HALF_HEIGHT +
      spec.stackHeight +
      OFFICE_CHARACTER_HEIGHT,
  };
  return { project, bounds, seatLift: spec.seatLift };
}

/** Top-left of the 32 x 16 diamond that covers the tile at this corner. */
export function isoDiamondOrigin(corner: OfficePoint): OfficePoint {
  return { x: corner.x - ISO_HALF_WIDTH, y: corner.y };
}

/**
 * Where a sprite standing ON a tile is drawn, given that sprites are top-left
 * anchored and a tile's floor is a diamond rather than a square.
 *
 * The foot lands on the diamond's CENTRE, so a bin drawn on a tile reads as
 * standing in the middle of it rather than hanging off its back corner.
 */
export function isoPropOrigin(
  corner: OfficePoint,
  spriteWidth: number,
  spriteHeight: number,
): OfficePoint {
  return {
    x: corner.x - spriteWidth / 2,
    y: corner.y + ISO_HALF_HEIGHT - spriteHeight,
  };
}
