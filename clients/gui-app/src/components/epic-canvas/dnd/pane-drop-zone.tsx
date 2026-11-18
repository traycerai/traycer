/**
 * Per-pane body drop zone for the root DndContext. Mounts its droppable
 * ONLY while a canvas-openable drag is active (paseo's split-drop-zone
 * pattern): idle panes carry zero droppable registrations and re-render
 * exactly twice per drag gesture (mount/unmount). The split/center preview
 * subscribes to this pane's slice of the drag store, so preview ticks
 * re-render only the hovered pane.
 *
 * The zone is a pointer-events-none overlay - dnd-kit hit-tests against the
 * measured rect, not DOM events, so the pane's content stays interactive
 * until a drop actually commits.
 */
import { useMemo } from "react";
import { useDroppable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import {
  getArtifactTabGroupBodyDropId,
  type EpicCanvasDropTargetData,
} from "@/components/epic-canvas/dnd/dnd";
import {
  useEpicDndCanvasDragActive,
  usePaneDropPreviewPosition,
} from "@/components/epic-canvas/dnd/dnd-store";
import type { DropPosition } from "@/stores/epics/canvas/types";

interface PaneDropZoneProps {
  readonly paneId: string;
  readonly viewTabId: string;
  readonly tabCount: number;
}

export function PaneDropZone(props: PaneDropZoneProps) {
  const dragActive = useEpicDndCanvasDragActive();
  if (!dragActive) return null;
  return (
    <PaneDropZoneActive
      paneId={props.paneId}
      viewTabId={props.viewTabId}
      tabCount={props.tabCount}
    />
  );
}

function PaneDropZoneActive(props: PaneDropZoneProps) {
  const { paneId, viewTabId, tabCount } = props;
  const dropData = useMemo<EpicCanvasDropTargetData>(
    () => ({
      kind: "artifact-tab-group-body",
      viewTabId,
      groupId: paneId,
      tabCount,
    }),
    [paneId, tabCount, viewTabId],
  );
  const { setNodeRef } = useDroppable({
    id: getArtifactTabGroupBodyDropId(paneId),
    data: dropData,
  });
  const position = usePaneDropPreviewPosition(paneId);

  return (
    <div
      ref={setNodeRef}
      aria-hidden
      data-testid="pane-drop-zone"
      className="pointer-events-none absolute inset-0 z-20"
    >
      <DropOverlay position={position} />
    </div>
  );
}

interface DropOverlayProps {
  readonly position: DropPosition | null;
}

function DropOverlay(props: DropOverlayProps) {
  const { position } = props;
  const visible = position !== null;
  const boxStyle = useMemo(() => {
    switch (position) {
      case "left":
        return { top: 0, right: "50%", bottom: 0, left: 0 } as const;
      case "right":
        return { top: 0, right: 0, bottom: 0, left: "50%" } as const;
      case "top":
        return { top: 0, right: 0, bottom: "50%", left: 0 } as const;
      case "bottom":
        return { top: "50%", right: 0, bottom: 0, left: 0 } as const;
      case "center":
      default:
        return { top: 0, right: 0, bottom: 0, left: 0 } as const;
    }
  }, [position]);

  return (
    <>
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 bg-primary/5 transition-opacity duration-150 ease-out",
          visible ? "opacity-100" : "opacity-0",
        )}
      />
      <div
        data-testid="tile-drop-overlay"
        data-position={position ?? ""}
        aria-hidden
        className={cn(
          "pointer-events-none absolute border-2 border-dashed border-primary/60 bg-primary/10 transition-[top,right,bottom,left,opacity] duration-150 ease-out",
          visible ? "opacity-100" : "opacity-0",
        )}
        style={boxStyle}
      />
    </>
  );
}
