/**
 * `@pierre/trees` renders its rows inside a shadow DOM, so we cannot attach a
 * per-row dnd-kit `useDraggable` ref the way the custom chat/artifact trees
 * do. This bridge registers ONE draggable per Pierre tree and recovers the
 * row under the pointer using the same `data-item-path` scrape Pierre
 * activation already relies on.
 *
 * It splits the two roles dnd-kit normally takes from one element:
 *
 * - the WRAPPER (light-DOM element around the tree) carries the sensor's
 *   pointer listeners, so a press on ANY row starts the gesture - spread
 *   `wrapperProps` onto it;
 * - the GRABBED ROW becomes the draggable's measured node, re-anchored per
 *   press by the sensor activator, so the drag overlay and collision rect
 *   track the row exactly like the per-row chat/artifact draggables.
 *
 * The handshake runs through a module-level {@link PierreDragHost} registry
 * keyed by draggable id: the bridge keeps the host's resolver current from a
 * layout effect, and the activator inside `EpicCanvasPointerSensor` mutates
 * the host's payload per press. A non-row press resolves to a null payload
 * and the activator vetoes the drag, leaving Pierre's own click / select
 * gesture untouched. The root drag handlers detect the stable
 * `PIERRE_HOST_DATA` marker on `active.data.current` and read the resolved
 * payload back via `getPierreDragHost(active.id)`.
 *
 * Why a module registry and not React state: the activator runs inside a
 * DOM pointer-down, before any React render, and the React Compiler's
 * immutability rules forbid mutating anything returned from a hook. A plain
 * module map (the same pattern the old `PIERRE_ROW_RESOLVERS` used) is
 * mutable from effects and sensors alike without re-rendering the tree.
 */
import { useLayoutEffect } from "react";
import { useDraggable, type DraggableSyntheticListeners } from "@dnd-kit/core";
import {
  PIERRE_HOST_DATA,
  registerPierreDragHost,
  unregisterPierreDragHost,
  type PierreDragHost,
} from "@/components/epic-canvas/dnd/epic-canvas-pointer-sensor";
import type { EpicCanvasDragSourceData } from "@/components/epic-canvas/dnd/dnd";

export interface PierreCanvasDragBridgeInput {
  readonly id: string;
  /**
   * Resolves the dnd-kit source payload for the Pierre row under the
   * activating pointer event, or `null` when the press is not on a draggable
   * file row (directory rows, empty space, panel chrome). Returning `null`
   * vetoes the canvas drag and leaves the gesture to Pierre.
   */
  readonly resolveSourceData: (
    event: PointerEvent,
  ) => EpicCanvasDragSourceData | null;
}

export interface PierreCanvasDragBridge {
  /** Spread onto the light-DOM wrapper around the Pierre tree. */
  readonly wrapperProps: DraggableSyntheticListeners;
}

export function usePierreCanvasDragBridge(
  input: PierreCanvasDragBridgeInput,
): PierreCanvasDragBridge {
  const { id } = input;
  const { listeners, setNodeRef } = useDraggable({
    id,
    data: PIERRE_HOST_DATA,
  });

  const resolveSourceData = input.resolveSourceData;
  useLayoutEffect(() => {
    const host: PierreDragHost = registerPierreDragHost(id);
    host.resolve = resolveSourceData;
    host.anchorRowNode = setNodeRef;
    return () => {
      unregisterPierreDragHost(id);
    };
  }, [id, resolveSourceData, setNodeRef]);

  return { wrapperProps: listeners };
}
