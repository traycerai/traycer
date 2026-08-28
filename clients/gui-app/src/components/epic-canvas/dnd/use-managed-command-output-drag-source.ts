import { useId, useMemo } from "react";
import {
  useDraggable,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
} from "@dnd-kit/core";
import {
  MANAGED_COMMAND_OUTPUT_DND_TYPE,
  getManagedCommandOutputDragId,
  getPaneScopedDndId,
  type EpicCanvasManagedCommandOutputDragData,
} from "@/components/epic-canvas/dnd/dnd";
import { useDragSourceDisabled } from "@/components/epic-canvas/dnd/use-drag-source-disabled";
import { makeManagedCommandOutputTileRef } from "@/stores/epics/canvas/tile-schema/managed-command-output-tile";

/**
 * Drag-source wiring for a shell's output window, wherever a surface offers a
 * shell as a door - the transcript's start and restart cards, the resume
 * divider - so a drag out of any of them lands the same tile the Background
 * panel's rows already drop, on the same payload. The canvas needs to know
 * nothing about where the gesture started.
 *
 * Same discipline as `useArtifactDragSource`:
 *
 *   - the caller supplies its exact owning `viewTabId`; with none (a transcript
 *     outside a canvas view) the source is simply not draggable, never resolved
 *     against some active tab;
 *   - the drag id keys on `useId()`, because the same shell can be a door many
 *     times in one thread (a start card and every restart card of it) and
 *     dnd-kit's registry collides on duplicate ids;
 *   - the payload is minted once per identity and reference-stable, so
 *     `useDraggable` never sees a fresh `data` object each render.
 *
 * `enabled` is the caller's own gate - a door for a shell the host no longer
 * has must not drag a window onto the canvas that would open onto nothing.
 */
export function useManagedCommandOutputDragSource(args: {
  readonly epicId: string | null;
  readonly viewTabId: string | null;
  readonly hostId: string | null;
  readonly commandId: string;
  readonly enabled: boolean;
}): {
  readonly isDraggable: boolean;
  readonly setNodeRef: (element: HTMLElement | null) => void;
  readonly listeners: DraggableSyntheticListeners;
  readonly attributes: DraggableAttributes;
  readonly isDragging: boolean;
} {
  const { epicId, viewTabId, hostId, commandId, enabled } = args;
  const occurrenceId = useId();
  const dragData = useMemo<
    EpicCanvasManagedCommandOutputDragData | undefined
  >(() => {
    if (!enabled) return undefined;
    if (epicId === null || viewTabId === null || hostId === null) {
      return undefined;
    }
    return {
      kind: MANAGED_COMMAND_OUTPUT_DND_TYPE,
      epicId,
      viewTabId,
      tile: makeManagedCommandOutputTileRef({ commandId, hostId }),
    };
  }, [enabled, epicId, viewTabId, hostId, commandId]);
  // Folded into `isDraggable` for the same reason as the artifact source: the
  // caller's grab chrome must disappear with the gesture, not outlive it.
  const dragDisabled = useDragSourceDisabled();
  const isDraggable = dragData !== undefined && !dragDisabled;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    // Pane-scoped like the menu and Background rows, so one root registry does
    // not collide across retained epic panes; the occurrence key keeps the
    // start card and every restart card of the same shell apart.
    id: getPaneScopedDndId(
      viewTabId ?? "",
      getManagedCommandOutputDragId(`${commandId}:${occurrenceId}`),
    ),
    data: dragData,
    disabled: !isDraggable,
  });
  return { isDraggable, setNodeRef, listeners, attributes, isDragging };
}
