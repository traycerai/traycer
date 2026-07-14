import { useMemo, type ReactNode } from "react";
import { useDroppable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import {
  getSidebarReparentRowDropId,
  type EpicCanvasDropTargetData,
} from "@/components/epic-canvas/dnd/dnd";
import { useSidebarReparentTargetActive } from "@/components/epic-canvas/dnd/dnd-store";
import type { RootCreatePanelId } from "@/stores/epics/left-panel-store";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";

/**
 * Row container shared by the chat and artifact trees: registers the
 * `sidebar-reparent-row` drop target on the row wrapper (the draggable stays on
 * the inner row button) and highlights while this row is the active reparent
 * target. Only `panelId` differs between the two trees.
 */
export function SidebarReparentRowDropWrapper(props: {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly nodeId: string;
  readonly panelId: RootCreatePanelId;
  readonly children: ReactNode;
  readonly contextMenu: ReactNode | null;
}) {
  const { epicId, viewTabId, nodeId, panelId, children, contextMenu } = props;
  const dropData = useMemo<EpicCanvasDropTargetData>(
    () => ({
      kind: "sidebar-reparent-row",
      epicId,
      viewTabId,
      nodeId,
      panelId,
    }),
    [epicId, viewTabId, nodeId, panelId],
  );
  const { setNodeRef } = useDroppable({
    id: getSidebarReparentRowDropId(nodeId),
    data: dropData,
  });
  const isReparentTarget = useSidebarReparentTargetActive(nodeId);
  const row = (
    <div
      ref={setNodeRef}
      className={cn(
        "group/tree-item relative flex items-center gap-1 rounded-md",
        isReparentTarget && "bg-accent/60 ring-2 ring-inset ring-primary/70",
      )}
    >
      {children}
    </div>
  );
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={contextMenu === null}>
        {row}
      </ContextMenuTrigger>
      {contextMenu}
    </ContextMenu>
  );
}
