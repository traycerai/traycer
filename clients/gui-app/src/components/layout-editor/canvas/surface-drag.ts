import type { DragRect } from "@/components/layout-editor/canvas/drag-model";
import {
  armLayoutGesture,
  holdLayoutDrag,
  swallowNextClick,
} from "@/components/layout-editor/canvas/drag-engine";
import type { PlacementEdge } from "@/components/layout-editor/canvas/surface-placement";

/**
 * Dragging a placement surface to an edge (D14): the tab strip to the top,
 * left or right of the app, the sidebar to either side of the content.
 *
 * The press arms through the drag engine's shared arm phase and holds its one
 * drag slot, so it waits out the same activation distance, refuses to start
 * under another drag, and goes with the session. Unlike a reorder nothing
 * moves while it is in hand: the valid edges light up as drop zones, the one
 * under the pointer lights brighter, and the release writes that edge once -
 * one recorded gesture, like every other placement write.
 */

export interface DropZone {
  readonly edge: PlacementEdge;
  readonly rect: DragRect;
}

/** How deep a drop zone reaches into its container, as a share of it. */
const ZONE_DEPTH = 0.25;

/** One band per edge, along the container's inside. */
export function dropZonesOf(
  container: DragRect,
  edges: ReadonlyArray<PlacementEdge>,
): ReadonlyArray<DropZone> {
  return edges.map((edge) => {
    const { left, top, width, height } = container;
    if (edge === "top")
      return { edge, rect: { left, top, width, height: height * ZONE_DEPTH } };
    const depth = width * ZONE_DEPTH;
    return {
      edge,
      rect: {
        left: edge === "left" ? left : left + width - depth,
        top,
        width: depth,
        height,
      },
    };
  });
}

/**
 * The zone a point is dropping into, or `null` between them.
 *
 * The point is pulled inside the container first, so a pointer that has left
 * it over the inspector or off the window still means the edge it left by.
 * Where two bands overlap (a corner) the one the point is shallower in wins,
 * each depth measured as a share of its own band.
 */
export function dropEdgeAt(
  container: DragRect,
  zones: ReadonlyArray<DropZone>,
  point: { readonly x: number; readonly y: number },
): PlacementEdge | null {
  const x = clamp(point.x, container.left, container.left + container.width);
  const y = clamp(point.y, container.top, container.top + container.height);
  let best: PlacementEdge | null = null;
  let bestShare = 1;
  for (const zone of zones) {
    const share = depthShare(zone, x, y);
    if (share < bestShare) {
      best = zone.edge;
      bestShare = share;
    }
  }
  return best;
}

/** How far into its band a point is, from 0 at the edge to 1 at the far side. */
function depthShare(zone: DropZone, x: number, y: number): number {
  const { rect } = zone;
  if (zone.edge === "top") return (y - rect.top) / rect.height;
  if (zone.edge === "left") return (x - rect.left) / rect.width;
  return (rect.left + rect.width - x) / rect.width;
}

export interface SurfaceDragInput {
  readonly event: PointerEvent;
  /** The surface's own element, marked while it is in hand. */
  readonly node: HTMLElement;
  /** The box the edges belong to, measured when the drag starts. */
  readonly container: HTMLElement;
  readonly edges: ReadonlyArray<PlacementEdge>;
  readonly current: PlacementEdge;
  readonly onDrop: (edge: PlacementEdge) => void;
}

export function armSurfaceDrag(input: SurfaceDragInput): void {
  armLayoutGesture({
    event: input.event,
    onStart: (move) => {
      startSurfaceDrag(input, move);
    },
  });
}

function startSurfaceDrag(input: SurfaceDragInput, move: PointerEvent): void {
  const { node, edges, current, onDrop } = input;
  const container = input.container.getBoundingClientRect();
  const zones = dropZonesOf(container, edges);
  const elements = zones.map((zone) => {
    const element = document.createElement("div");
    element.setAttribute("data-layout-drop-zone", zone.edge);
    element.setAttribute("aria-hidden", "true");
    if (zone.edge === current) element.setAttribute("data-current", "1");
    element.style.transform = `translate(${String(zone.rect.left)}px, ${String(zone.rect.top)}px)`;
    element.style.width = `${String(zone.rect.width)}px`;
    element.style.height = `${String(zone.rect.height)}px`;
    document.body.append(element);
    return element;
  });
  const pointerId = move.pointerId;
  let over: PlacementEdge | null = null;

  const onPointerMove = (next: PointerEvent): void => {
    if (next.pointerId !== pointerId) return;
    over = dropEdgeAt(container, zones, { x: next.clientX, y: next.clientY });
    for (const [index, element] of elements.entries()) {
      if (zones[index].edge === over) element.setAttribute("data-over", "1");
      else element.removeAttribute("data-over");
    }
  };

  const onPointerUp = (up: PointerEvent): void => {
    if (up.pointerId !== pointerId) return;
    swallowNextClick();
    const landed = over;
    teardown();
    if (landed !== null && landed !== current) onDrop(landed);
  };

  const onPointerCancel = (cancel: PointerEvent): void => {
    if (cancel.pointerId === pointerId) teardown();
  };

  const release = holdLayoutDrag(teardown);

  function teardown(): void {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    for (const element of elements) element.remove();
    node.removeAttribute("data-layout-surface-dragging");
    if (node.hasPointerCapture(pointerId))
      node.releasePointerCapture(pointerId);
    release();
  }

  node.setAttribute("data-layout-surface-dragging", "1");
  node.setPointerCapture(pointerId);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerCancel);
  onPointerMove(move);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
