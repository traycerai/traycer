/**
 * The ground a lod-0 floor drawable actually paints, for the suites that check
 * a partial overview frame against the whole-world map.
 *
 * THE SHAPE IS THE POINT. A block map emits one region per district, amenity
 * and room, and how that region is drawn depends on the projector: an identity
 * one gets a `block`, an axis-aligned rectangle in world pixels, and the
 * isometric one gets a `quad`, the four PROJECTED corners of the same tile
 * rect. Both are parallelograms - a rectangle is the degenerate case - which is
 * what lets one pair of functions sample and test them.
 *
 * Sampling a `block`'s bounding box was fine while every block WAS its bounding
 * box; done to a sheared one it picks pixels outside the painted shape, and a
 * frame query that correctly declines to return a region for ground that region
 * does not cover then reads as a miss. So the sweeps that used to walk
 * `x + width * f` walk the shape's own two edges instead, which reproduces the
 * old points exactly on a rectangle (`P1 - P0` is `(width, 0)` and `P3 - P0` is
 * `(0, height)`) and lands inside the diamond on a sheared one.
 */
import type {
  OfficeBlockFill,
  OfficeDrawable,
  OfficePoint,
  OfficeRect,
} from "@/lib/comm-graph/office/office-types";

/** A region's four corners in perimeter order, starting at its origin corner. */
export type OverviewShape = readonly [
  OfficePoint,
  OfficePoint,
  OfficePoint,
  OfficePoint,
];

/** The shape a lod-0 floor drawable fills, or `null` where it fills none. */
export function overviewShapeOf(
  drawable: OfficeDrawable,
): OverviewShape | null {
  if (drawable.kind === "quad") return drawable.points;
  if (drawable.kind !== "block") return null;
  const right = drawable.x + drawable.width;
  const bottom = drawable.y + drawable.height;
  return [
    { x: drawable.x, y: drawable.y },
    { x: right, y: drawable.y },
    { x: right, y: bottom },
    { x: drawable.x, y: bottom },
  ];
}

/** Every drawable of a floor that fills ground, paired with the ground it fills. */
export function overviewShapesOf(
  floor: ReadonlyArray<OfficeDrawable>,
): ReadonlyArray<{
  readonly drawable: OfficeDrawable;
  readonly shape: OverviewShape;
}> {
  const shapes: Array<{
    readonly drawable: OfficeDrawable;
    readonly shape: OverviewShape;
  }> = [];
  for (const drawable of floor) {
    const shape = overviewShapeOf(drawable);
    if (shape !== null) shapes.push({ drawable, shape });
  }
  return shapes;
}

/** The tightest axis-aligned rectangle a shape fits in, for the bounds checks. */
export function overviewBoundingBoxOf(shape: OverviewShape): OfficeRect {
  const xs = shape.map((point) => point.x);
  const ys = shape.map((point) => point.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return {
    x: left,
    y: top,
    width: Math.max(...xs) - left,
    height: Math.max(...ys) - top,
  };
}

/** The point a shape is centred on: the projection of its region's own centre. */
export function overviewCentreOf(shape: OverviewShape): OfficePoint {
  const [origin, next, opposite, last] = shape;
  return {
    x: (origin.x + next.x + opposite.x + last.x) / 4,
    y: (origin.y + next.y + opposite.y + last.y) / 4,
  };
}

/** What a lod-0 region stands for, however it is drawn. */
export function overviewFillOf(
  drawable: OfficeDrawable,
): OfficeBlockFill | null {
  if (drawable.kind === "block" || drawable.kind === "quad") {
    return drawable.fill;
  }
  return null;
}

/**
 * Where a point sits in a shape's own two edge directions.
 *
 * Both edges leave the origin corner, so a point is inside exactly when both
 * coordinates are within `[0, 1]`. The determinant is the shape's signed area
 * over the unit square and is zero only for a region with no extent, which a
 * plan does not emit.
 */
function edgeCoordinatesOf(
  shape: OverviewShape,
  point: OfficePoint,
): { readonly along: number; readonly down: number } | null {
  const [origin, next, , last] = shape;
  const alongX = next.x - origin.x;
  const alongY = next.y - origin.y;
  const downX = last.x - origin.x;
  const downY = last.y - origin.y;
  const determinant = alongX * downY - downX * alongY;
  if (determinant === 0) return null;
  const offsetX = point.x - origin.x;
  const offsetY = point.y - origin.y;
  return {
    along: (offsetX * downY - downX * offsetY) / determinant,
    down: (alongX * offsetY - offsetX * alongY) / determinant,
  };
}

/** Whether a point lands on the ground a shape fills. */
export function overviewShapeContains(
  shape: OverviewShape,
  point: OfficePoint,
): boolean {
  const coordinates = edgeCoordinatesOf(shape, point);
  if (coordinates === null) return false;
  const { along, down } = coordinates;
  return along >= 0 && along <= 1 && down >= 0 && down <= 1;
}

/**
 * The three fractions every overview sweep samples at, on each of a shape's
 * two edges: just inside each end, and the middle.
 *
 * The numbers are the T5 review's own probe's, kept to the digit so a sweep
 * here and the evidence it was written against are asking the same question.
 * Nine points per region: both near corners, both edge midpoints, the centre,
 * and the four in between.
 */
export const OVERVIEW_FRACTIONS: ReadonlyArray<number> = [0.001, 0.5, 0.999];

/** Those fractions as points on one shape, along its own two edges. */
export function overviewSamplePoints(
  shape: OverviewShape,
  fractions: ReadonlyArray<number>,
): ReadonlyArray<OfficePoint> {
  const [origin, next, , last] = shape;
  const alongX = next.x - origin.x;
  const alongY = next.y - origin.y;
  const downX = last.x - origin.x;
  const downY = last.y - origin.y;
  const points: OfficePoint[] = [];
  for (const along of fractions) {
    for (const down of fractions) {
      points.push({
        x: origin.x + alongX * along + downX * down,
        y: origin.y + alongY * along + downY * down,
      });
    }
  }
  return points;
}
