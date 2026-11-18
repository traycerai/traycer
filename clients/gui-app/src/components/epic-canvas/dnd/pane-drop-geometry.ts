/**
 * Pane-body drop hit testing, ported from paseo's `split-drop-zone.tsx`
 * (`resolveSplitDropPosition`): a centered box of `CENTER_DROP_RATIO` per
 * dimension resolves to "center" (move into pane); a band of
 * `EDGE_SPLIT_RATIO` along each side resolves to that edge (split); the
 * dead zone between them falls back to the nearest edge so every point
 * inside the pane resolves to one of the five positions.
 */
import {
  CENTER_DROP_RATIO,
  EDGE_SPLIT_RATIO,
} from "@/stores/epics/canvas/tile-tree-constants";
import type { DropPosition } from "@/stores/epics/canvas/types";
import type { EdgeDropPosition } from "@/components/epic-canvas/dnd/dnd";

export interface PaneRelativePoint {
  readonly width: number;
  readonly height: number;
  readonly x: number;
  readonly y: number;
}

export function resolveSplitDropPosition(
  input: PaneRelativePoint,
): DropPosition {
  const centerInsetX = input.width * ((1 - CENTER_DROP_RATIO) / 2);
  const centerInsetY = input.height * ((1 - CENTER_DROP_RATIO) / 2);
  const insideCenterX =
    input.x >= centerInsetX && input.x <= input.width - centerInsetX;
  const insideCenterY =
    input.y >= centerInsetY && input.y <= input.height - centerInsetY;

  if (insideCenterX && insideCenterY) {
    return "center";
  }

  const edgeThresholdX = input.width * EDGE_SPLIT_RATIO;
  const edgeThresholdY = input.height * EDGE_SPLIT_RATIO;
  if (input.x <= edgeThresholdX) return "left";
  if (input.x >= input.width - edgeThresholdX) return "right";
  if (input.y <= edgeThresholdY) return "top";
  if (input.y >= input.height - edgeThresholdY) return "bottom";

  const distances: Array<{
    readonly position: EdgeDropPosition;
    readonly distance: number;
  }> = [
    { position: "left", distance: input.x },
    { position: "right", distance: input.width - input.x },
    { position: "top", distance: input.y },
    { position: "bottom", distance: input.height - input.y },
  ];
  distances.sort((left, right) => left.distance - right.distance);
  return distances[0]?.position ?? "center";
}
