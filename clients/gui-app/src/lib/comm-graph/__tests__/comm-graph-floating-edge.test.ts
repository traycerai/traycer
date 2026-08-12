import { describe, expect, it } from "vitest";
import { Position } from "@xyflow/react";
import {
  commGraphEdgeEndpoints,
  type CommGraphEdgeBox,
} from "@/lib/comm-graph/comm-graph-floating-edge";

function box(x: number, y: number): CommGraphEdgeBox {
  return { x, y, width: 200, height: 60 };
}

describe("commGraphEdgeEndpoints", () => {
  it("meets the facing sides when one node is to the right", () => {
    // The defect this replaces: fixed bottom→top anchors sent a horizontal edge
    // out of the bottom of its source and looped it back over the node.
    const endpoints = commGraphEdgeEndpoints(box(0, 0), box(500, 0));

    expect(endpoints.sourcePosition).toBe(Position.Right);
    expect(endpoints.targetPosition).toBe(Position.Left);
    expect(endpoints.sourceX).toBe(200);
    expect(endpoints.targetX).toBe(500);
  });

  it("meets the facing sides when the other node is ABOVE", () => {
    const endpoints = commGraphEdgeEndpoints(box(0, 500), box(0, 0));

    expect(endpoints.sourcePosition).toBe(Position.Top);
    expect(endpoints.targetPosition).toBe(Position.Bottom);
    expect(endpoints.sourceY).toBe(500);
    expect(endpoints.targetY).toBe(60);
  });

  it("is symmetric - the edge has no direction, so neither has its geometry", () => {
    const forward = commGraphEdgeEndpoints(box(0, 0), box(400, 300));
    const reverse = commGraphEdgeEndpoints(box(400, 300), box(0, 0));

    expect(reverse.targetX).toBe(forward.sourceX);
    expect(reverse.targetY).toBe(forward.sourceY);
    expect(reverse.sourceX).toBe(forward.targetX);
    expect(reverse.sourceY).toBe(forward.targetY);
  });

  it("stays on the node's border for a diagonal neighbour", () => {
    const source = box(0, 0);
    const endpoints = commGraphEdgeEndpoints(source, box(600, 400));

    // On the border, never inside the box and never floating away from it.
    const onVerticalEdge =
      endpoints.sourceX === source.x + source.width ||
      endpoints.sourceX === source.x;
    const onHorizontalEdge =
      endpoints.sourceY === source.y + source.height ||
      endpoints.sourceY === source.y;
    expect(onVerticalEdge || onHorizontalEdge).toBe(true);
    expect(endpoints.sourceX).toBeGreaterThanOrEqual(source.x);
    expect(endpoints.sourceX).toBeLessThanOrEqual(source.x + source.width);
    expect(endpoints.sourceY).toBeGreaterThanOrEqual(source.y);
    expect(endpoints.sourceY).toBeLessThanOrEqual(source.y + source.height);
  });

  it("degenerates to the centre for perfectly stacked boxes", () => {
    // Overlapping nodes should not produce NaN geometry.
    const endpoints = commGraphEdgeEndpoints(box(0, 0), box(0, 0));

    expect(Number.isFinite(endpoints.sourceX)).toBe(true);
    expect(Number.isFinite(endpoints.targetY)).toBe(true);
  });
});
