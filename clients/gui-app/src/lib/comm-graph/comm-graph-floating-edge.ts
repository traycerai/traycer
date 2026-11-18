/**
 * FLOATING-EDGE geometry: where an undirected pair edge should meet each node.
 *
 * The previous canvas anchored every edge bottom-of-source → top-of-target,
 * which is only ever right when the target sits directly below the source. A
 * target beside or above its source produced a curve that looped back over the
 * node it started from. Fixed anchors also make no sense for an edge with no
 * direction: there is no "source side" to leave from.
 *
 * So the endpoints are computed instead - each end meets the border of its own
 * box on the side facing the other box. Pure geometry, kept out of the edge
 * component so it can be tested without mounting React Flow (which jsdom cannot
 * measure).
 */
import { Position } from "@xyflow/react";

export interface CommGraphEdgeBox {
  /** Top-left in flow space. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CommGraphEdgeEndpoints {
  readonly sourceX: number;
  readonly sourceY: number;
  readonly targetX: number;
  readonly targetY: number;
  readonly sourcePosition: Position;
  readonly targetPosition: Position;
}

function centreOf(box: CommGraphEdgeBox): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Where the segment between the two centres crosses `box`'s border.
 *
 * Scales the centre-to-centre vector down to the box's own half-extents, which
 * lands on whichever edge the vector actually exits through - no per-side
 * casework, and it degenerates gracefully when the boxes overlap (the scale
 * factor just clamps to the centre).
 */
function borderPoint(
  box: CommGraphEdgeBox,
  toward: { x: number; y: number },
): { x: number; y: number } {
  const centre = centreOf(box);
  const dx = toward.x - centre.x;
  const dy = toward.y - centre.y;
  if (dx === 0 && dy === 0) return centre;
  const halfWidth = box.width / 2;
  const halfHeight = box.height / 2;
  const scale = Math.min(
    dx === 0 ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(dx),
    dy === 0 ? Number.POSITIVE_INFINITY : halfHeight / Math.abs(dy),
  );
  return { x: centre.x + dx * scale, y: centre.y + dy * scale };
}

/**
 * Which side of its own box a point sits on, so the bezier leaves perpendicular
 * to that face instead of curling around the node.
 */
function sideOf(
  box: CommGraphEdgeBox,
  point: { x: number; y: number },
): Position {
  const centre = centreOf(box);
  const dx = point.x - centre.x;
  const dy = point.y - centre.y;
  if (Math.abs(dx) * box.height > Math.abs(dy) * box.width) {
    return dx > 0 ? Position.Right : Position.Left;
  }
  return dy > 0 ? Position.Bottom : Position.Top;
}

export function commGraphEdgeEndpoints(
  source: CommGraphEdgeBox,
  target: CommGraphEdgeBox,
): CommGraphEdgeEndpoints {
  const sourcePoint = borderPoint(source, centreOf(target));
  const targetPoint = borderPoint(target, centreOf(source));
  return {
    sourceX: sourcePoint.x,
    sourceY: sourcePoint.y,
    targetX: targetPoint.x,
    targetY: targetPoint.y,
    sourcePosition: sideOf(source, sourcePoint),
    targetPosition: sideOf(target, targetPoint),
  };
}
