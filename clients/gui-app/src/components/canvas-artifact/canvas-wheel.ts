import type { Viewport } from "@xyflow/react";
import type { CanvasPoint } from "./canvas-model";

/** What one wheel event asks of the camera. Points are client coordinates. */
export type CanvasWheelStep =
  | { readonly kind: "pan"; readonly dx: number; readonly dy: number }
  | {
      readonly kind: "zoom";
      readonly delta: number;
      readonly point: CanvasPoint;
    };

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 4;
// Each event's pan is capped so momentum tails cannot sling the canvas,
// while the uncapped per-pixel gain stays 1.
const MAX_PAN_PER_EVENT = 80;
const MAX_ZOOM_DELTA_PER_EVENT = 240;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The viewport after one wheel event. Limits apply per event, before events
 * are added up, so a frame that carries several feels like the same events
 * applied one by one. `stageOrigin` is the stage's top-left corner on screen.
 */
export function applyWheelStep(
  viewport: Viewport,
  step: CanvasWheelStep,
  stageOrigin: CanvasPoint,
): Viewport {
  if (step.kind === "pan")
    return {
      x: viewport.x - clamp(step.dx, -MAX_PAN_PER_EVENT, MAX_PAN_PER_EVENT),
      y: viewport.y - clamp(step.dy, -MAX_PAN_PER_EVENT, MAX_PAN_PER_EVENT),
      zoom: viewport.zoom,
    };
  const delta = clamp(
    step.delta,
    -MAX_ZOOM_DELTA_PER_EVENT,
    MAX_ZOOM_DELTA_PER_EVENT,
  );
  const zoom = clamp(
    viewport.zoom * Math.exp(-delta * 0.003),
    MIN_ZOOM,
    MAX_ZOOM,
  );
  const ratio = zoom / viewport.zoom;
  // The canvas point under the pointer stays under it.
  const x = step.point.x - stageOrigin.x;
  const y = step.point.y - stageOrigin.y;
  return {
    x: x - (x - viewport.x) * ratio,
    y: y - (y - viewport.y) * ratio,
    zoom,
  };
}

/**
 * The CSS transform, about the stage's top-left corner, that makes a picture
 * drawn at `drawn` look as it would at `target`. Scaling drawn pixels this
 * way costs nothing per frame; drawing them at the new scale is the cost a
 * zoom gesture puts off until it ends.
 */
export function viewportLayerTransform(
  drawn: Viewport,
  target: Viewport,
): string {
  const ratio = target.zoom / drawn.zoom;
  return `translate(${target.x - drawn.x * ratio}px, ${target.y - drawn.y * ratio}px) scale(${ratio})`;
}
