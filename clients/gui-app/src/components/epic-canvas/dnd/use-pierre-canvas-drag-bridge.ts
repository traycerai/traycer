/**
 * `@pierre/trees` renders its rows inside a shadow DOM, so we cannot attach a per-row dnd-kit `useDraggable` ref the way the custom chat/artifact trees do.
 * Why a module registry and not React state: the activator runs inside a DOM pointer-down, before any React render, and the React Compiler's immutability rules forbid mutating anything returned from a hook.
 */
import { useLayoutEffect } from "react";
import { useDraggable, type DraggableSyntheticListeners } from "@dnd-kit/core";
import {
  PIERRE_HOST_DATA,
  registerPierreDragHost,
  unregisterPierreDragHost,
  type PierreDragHost,
} from "@/components/epic-canvas/dnd/epic-canvas-pointer-sensor";
import { useDragSourceDisabled } from "@/components/epic-canvas/dnd/use-drag-source-disabled";
import type { EpicCanvasDragSourceData } from "@/components/epic-canvas/dnd/dnd";

export interface PierreCanvasDragBridgeInput {
  readonly id: string;
  /**
   * Resolves the dnd-kit source payload for the Pierre row under the activating pointer event, or `null` when the press is not on a draggable file or directory row (empty space and panel chrome stay non-draggable).
   * Returning `null` vetoes the canvas drag and leaves the gesture to Pierre.
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
  // The wrapper carries the sensor's listeners for EVERY row of the tree, so
  // a coarse pointer would hand the whole tree's scroll gesture to the drag.
  const dragDisabled = useDragSourceDisabled();
  const { listeners, setNodeRef } = useDraggable({
    id,
    data: PIERRE_HOST_DATA,
    disabled: dragDisabled,
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
