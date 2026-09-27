import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useDroppable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import {
  getSidebarReparentRowDropId,
  getPaneScopedDndId,
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
  const [menuMounted, setMenuMounted] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const replayRef = useRef<{
    readonly x: number;
    readonly y: number;
    readonly ctrlKey: boolean;
    readonly button: number;
  } | null>(null);
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
    id: getPaneScopedDndId(viewTabId, getSidebarReparentRowDropId(nodeId)),
    data: dropData,
  });
  const setRowRef = useCallback(
    (node: HTMLDivElement | null) => {
      rowRef.current = node;
      setNodeRef(node);
    },
    [setNodeRef],
  );
  useLayoutEffect(() => {
    if (!menuMounted || replayRef.current === null) return;
    const replay = replayRef.current;
    replayRef.current = null;
    rowRef.current?.dispatchEvent(
      new window.MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: replay.button,
        clientX: replay.x,
        clientY: replay.y,
        ctrlKey: replay.ctrlKey,
      }),
    );
  }, [menuMounted]);
  const mountForContextMenu = (
    x: number,
    y: number,
    button: number,
    ctrlKey: boolean,
  ): void => {
    replayRef.current = { x, y, button, ctrlKey };
    setMenuMounted(true);
  };
  const handleContextMenu = (event: MouseEvent<HTMLDivElement>): void => {
    if (menuMounted || contextMenu === null) return;
    event.preventDefault();
    mountForContextMenu(
      event.clientX,
      event.clientY,
      event.button,
      event.ctrlKey,
    );
  };
  const handleKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (menuMounted || contextMenu === null || event.key !== "ContextMenu") {
      return;
    }
    event.preventDefault();
    const rect = rowRef.current?.getBoundingClientRect();
    mountForContextMenu((rect?.left ?? 0) + 8, (rect?.top ?? 0) + 8, 2, false);
  };
  const isReparentTarget = useSidebarReparentTargetActive(viewTabId, nodeId);
  const row = (
    <div
      ref={setRowRef}
      data-slot="context-menu-trigger"
      {...(!menuMounted ? { "data-state": "closed" } : {})}
      {...(!menuMounted && contextMenu === null ? { "data-disabled": "" } : {})}
      onContextMenu={handleContextMenu}
      onKeyDownCapture={handleKeyDownCapture}
      className={cn(
        "group/tree-item relative flex items-center gap-1 rounded-md [-webkit-touch-callout:none]",
        isReparentTarget && "bg-accent/60 ring-2 ring-inset ring-primary/70",
      )}
    >
      {children}
    </div>
  );
  if (!menuMounted) return row;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={contextMenu === null}>
        {row}
      </ContextMenuTrigger>
      {contextMenu}
    </ContextMenu>
  );
}
