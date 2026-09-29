import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { createPortal } from "react-dom";
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

/** The row's own touch and pen long-press delay. */
const LONG_PRESS_MS = 700;

/**
 * Row container shared by the chat and artifact trees: registers the
 * `sidebar-reparent-row` drop target on the row wrapper (the draggable stays on
 * the inner row button) and highlights while this row is the active reparent
 * target. Only `panelId` differs between the two trees.
 *
 * The row's context menu mounts on first use, WITHOUT touching the row: the
 * row element is never wrapped, so it is never re-created, and everything that
 * holds it - focus, drag-and-drop, hover state, ids - is unaffected. A
 * context menu opens at the pointer, not at its trigger, so its trigger is a
 * hidden proxy in a portal. The row forwards every `contextmenu` it gets (a
 * right-click, the menu key, Shift+F10, a synthesized long-press) to the
 * proxy, and times a touch or pen long-press itself, since iOS fires no
 * `contextmenu` for one.
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
  const [menuOpen, setMenuOpen] = useState(false);
  // Losing the menu unmounts the root, open or not; nothing else would close
  // the row's `data-popup-open`.
  if (contextMenu === null && menuOpen) setMenuOpen(false);
  const proxyRef = useRef<HTMLSpanElement | null>(null);
  const pendingPointRef = useRef<{
    readonly x: number;
    readonly y: number;
  } | null>(null);
  const longPressRef = useRef<number | null>(null);
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
  const forwardToProxy = (x: number, y: number): void => {
    proxyRef.current?.dispatchEvent(
      new window.MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: x,
        clientY: y,
      }),
    );
  };
  useLayoutEffect(() => {
    if (!menuMounted || pendingPointRef.current === null) return;
    const point = pendingPointRef.current;
    pendingPointRef.current = null;
    forwardToProxy(point.x, point.y);
  }, [menuMounted]);
  useEffect(
    () => () => {
      if (longPressRef.current !== null) {
        window.clearTimeout(longPressRef.current);
      }
    },
    [],
  );
  const openAt = (x: number, y: number): void => {
    if (menuMounted) {
      forwardToProxy(x, y);
      return;
    }
    pendingPointRef.current = { x, y };
    setMenuMounted(true);
  };
  const clearLongPress = (): void => {
    if (longPressRef.current === null) return;
    window.clearTimeout(longPressRef.current);
    longPressRef.current = null;
  };
  // Events from the menu's portal content bubble through the row in React's
  // tree; only events from the row's own DOM are the row's. And an event a
  // control inside the row has already consumed - the more button's own
  // pointerdown - is not the row's.
  const fromRow = (event: SyntheticEvent<HTMLDivElement>): boolean =>
    !event.defaultPrevented &&
    event.target instanceof Node &&
    event.currentTarget.contains(event.target);
  const handleContextMenu = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === proxyRef.current) {
      // The forwarded event: the menu has handled it on the proxy.
      event.stopPropagation();
      return;
    }
    if (contextMenu === null || !fromRow(event)) return;
    clearLongPress();
    event.preventDefault();
    openAt(event.clientX, event.clientY);
  };
  const handlePointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (
      contextMenu === null ||
      event.pointerType === "mouse" ||
      !fromRow(event)
    ) {
      return;
    }
    clearLongPress();
    const { clientX, clientY } = event;
    longPressRef.current = window.setTimeout(() => {
      longPressRef.current = null;
      openAt(clientX, clientY);
    }, LONG_PRESS_MS);
  };
  const handlePointerEnd = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.pointerType !== "mouse") clearLongPress();
  };
  const isReparentTarget = useSidebarReparentTargetActive(viewTabId, nodeId);
  return (
    <div
      ref={setNodeRef}
      data-slot="context-menu-trigger"
      data-popup-open={menuOpen ? "" : undefined}
      {...(contextMenu === null ? { "data-disabled": "" } : {})}
      onContextMenu={handleContextMenu}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerEnd}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      className={cn(
        "group/tree-item relative flex items-center gap-1 rounded-md [-webkit-touch-callout:none]",
        isReparentTarget && "bg-accent/60 ring-2 ring-inset ring-primary/70",
      )}
    >
      {children}
      {menuMounted && contextMenu !== null
        ? createPortal(
            <ContextMenu onOpenChange={setMenuOpen}>
              <ContextMenuTrigger render={<span ref={proxyRef} hidden />} />
              {contextMenu}
            </ContextMenu>,
            document.body,
          )
        : null}
    </div>
  );
}
