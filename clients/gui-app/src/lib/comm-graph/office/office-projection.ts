/**
 * The projection, run backwards: which TILES a rectangle of projected world
 * pixels was drawn from.
 *
 * Two callers need this and there is one answer, which is why it is here and
 * not in either of them. The scene asks it to know what floor to request from
 * a painter for the rect it is about to draw; the static layer asks it to know
 * what floor to bake into one 512-pixel chunk. Both are handed a rectangle in
 * projected pixels and both have to hand a painter a rectangle in tiles, and a
 * second implementation of that would be a second chance for the two to
 * disagree about what is on screen.
 *
 * EVERY PROJECTOR THE VIEWS SHIP IS AFFINE - the identity for the flat,
 * oblique and amphitheatre plans, a shear for the two isometric ones - so the
 * mapping is recovered from three points of `project` and inverted. Two more
 * points are checked against what was recovered, at the near corner and at the
 * far one, because a projection that bends only over distance agrees with its
 * own first step; anything that disagrees falls back to the whole world, which
 * is slower to paint and still correct to look at.
 */
import type {
  OfficePoint,
  OfficeRect,
  OfficeTileRect,
} from "@/lib/comm-graph/office/office-types";
import type { OfficeProjector } from "@/lib/comm-graph/office/views/office-view";

/**
 * How far past a rectangle's edge to look for the tiles whose ART reaches into
 * it.
 *
 * A sprite is anchored at a tile and spills off it: the largest in the set is
 * 32 pixels square, and an isometric prop is drawn half a sprite left of its
 * tile's corner and a whole sprite above it. So a rectangle that asked only
 * for the tiles inside itself would lose every sprite anchored just outside
 * one - a wall at the edge of the viewport, a plant at the seam between two
 * baked chunks. Twice the largest sprite, which covers that with room over.
 */
export const OFFICE_PROJECTION_BLEED_PX = 64;

/** Sub-pixel slack for the affinity probes; a projector is built from integers. */
const AFFINE_TOLERANCE_PX = 0.001;

export interface OfficeTileRectOfArgs {
  readonly projector: OfficeProjector;
  /** The world's size in tiles; the answer is clamped to it. */
  readonly cols: number;
  readonly rows: number;
  /** The rectangle, in projected world pixels. */
  readonly rect: OfficeRect;
  /** How far past its edge to reach; see `OFFICE_PROJECTION_BLEED_PX`. */
  readonly bleedPx: number;
}

/**
 * The tiles a painter has to be asked for to fill one rectangle of the
 * projected world, clamped to the world and grown by the bleed first.
 */
export function officeTileRectOf(args: OfficeTileRectOfArgs): OfficeTileRect {
  const { bleedPx, cols, projector, rect, rows } = args;
  const whole: OfficeTileRect = { col: 0, row: 0, cols, rows };
  const origin = projector.project(0, 0);
  const alongCol = delta(projector.project(1, 0), origin);
  const alongRow = delta(projector.project(0, 1), origin);
  const determinant = alongCol.x * alongRow.y - alongRow.x * alongCol.y;
  if (determinant === 0) return whole;
  const basis: RecoveredBasis = { origin, alongCol, alongRow, determinant };
  if (!projectsAffinely(projector, basis, 1, 1)) return whole;
  if (!projectsAffinely(projector, basis, cols, rows)) return whole;

  const left = rect.x - bleedPx;
  const top = rect.y - bleedPx;
  const right = rect.x + rect.width + bleedPx;
  const bottom = rect.y + rect.height + bleedPx;
  let minCol = Number.POSITIVE_INFINITY;
  let maxCol = Number.NEGATIVE_INFINITY;
  let minRow = Number.POSITIVE_INFINITY;
  let maxRow = Number.NEGATIVE_INFINITY;
  // All four corners, because a shear turns an axis-aligned rectangle into a
  // parallelogram: its tile bounds are not its two opposite corners.
  for (const corner of [
    { x: left, y: top },
    { x: right, y: top },
    { x: left, y: bottom },
    { x: right, y: bottom },
  ]) {
    const tile = unproject(basis, corner);
    minCol = Math.min(minCol, tile.col);
    maxCol = Math.max(maxCol, tile.col);
    minRow = Math.min(minRow, tile.row);
    maxRow = Math.max(maxRow, tile.row);
  }
  // A tile covers [c, c+1) of fractional column, so the last one the rect
  // reaches is `floor(maxCol)` and the exclusive end is one past it.
  const firstCol = Math.max(0, Math.floor(minCol));
  const firstRow = Math.max(0, Math.floor(minRow));
  const endCol = Math.min(cols, Math.floor(maxCol) + 1);
  const endRow = Math.min(rows, Math.floor(maxRow) + 1);
  return {
    col: firstCol,
    row: firstRow,
    cols: Math.max(0, endCol - firstCol),
    rows: Math.max(0, endRow - firstRow),
  };
}

/** The affine map read off three projected points. */
interface RecoveredBasis {
  readonly origin: OfficePoint;
  readonly alongCol: OfficePoint;
  readonly alongRow: OfficePoint;
  readonly determinant: number;
}

/** Where a projected point came from, in fractional tiles. */
function unproject(
  basis: RecoveredBasis,
  point: OfficePoint,
): { readonly col: number; readonly row: number } {
  const { alongCol, alongRow, determinant, origin } = basis;
  const offsetX = point.x - origin.x;
  const offsetY = point.y - origin.y;
  return {
    col: (offsetX * alongRow.y - alongRow.x * offsetY) / determinant,
    row: (alongCol.x * offsetY - offsetX * alongCol.y) / determinant,
  };
}

/** Whether one probe lands where the recovered mapping says it should. */
function projectsAffinely(
  projector: OfficeProjector,
  basis: RecoveredBasis,
  col: number,
  row: number,
): boolean {
  const { alongCol, alongRow, origin } = basis;
  const probe = delta(projector.project(col, row), origin);
  return (
    Math.abs(probe.x - (alongCol.x * col + alongRow.x * row)) <=
      AFFINE_TOLERANCE_PX &&
    Math.abs(probe.y - (alongCol.y * col + alongRow.y * row)) <=
      AFFINE_TOLERANCE_PX
  );
}

function delta(point: OfficePoint, origin: OfficePoint): OfficePoint {
  return { x: point.x - origin.x, y: point.y - origin.y };
}
