import { useEffect, useEffectEvent, useMemo } from "react";
import { useDndContext } from "@dnd-kit/core";
import { SIDEBAR_NODE_DND_TYPE } from "@/components/epic-canvas/dnd/dnd";
import { useEpicDndStore } from "@/components/epic-canvas/dnd/dnd-store";
import { useChatTreeVirtual } from "@/components/epic-canvas/sidebar/chat-tree-virtual-context";
import { useVirtualRowPin } from "@/components/epic-canvas/sidebar/virtual-row-pins";

/**
 * What a drag needs from the windowed chat tree. Rendered once inside the
 * list, as a leaf of its own: `useDndContext` re-renders its reader on every
 * collision pass of a drag.
 *
 * Rows that scroll into the window during a drag become drop targets on their
 * own: dnd-kit measures every target again whenever the set of them changes.
 */
export function ChatTreeDragSupport(props: { readonly tabId: string }): null {
  const { tabId } = props;
  const { model, virtualizer, measureVersion } = useChatTreeVirtual();
  const draggedNodeId = useEpicDndStore((state) =>
    state.activeSource?.kind === SIDEBAR_NODE_DND_TYPE &&
    state.activeSource.viewTabId === tabId
      ? state.activeSource.nodeId
      : null,
  );
  const draggedKey = useMemo(
    () =>
      draggedNodeId === null
        ? null
        : (model.rows.find(
            (row) => row.kind === "local" && row.nodeId === draggedNodeId,
          )?.key ?? null),
    [model.rows, draggedNodeId],
  );
  // The dragged row stays mounted for the whole drag. dnd-kit keeps measuring
  // a source that unmounts, detached: its rect reads zeros, which throws the
  // overlay's `snapCenterToCursor` off, and it has no scroll ancestors, which
  // stops auto-scroll whenever the pointer is over no sidebar target.
  useVirtualRowPin(draggedKey, true);

  const dnd = useDndContext();
  const dragging = dnd.active !== null;
  const shown = (virtualizer.scrollRect?.height ?? 0) > 0;
  // An empty list measures every target.
  const measureTargets = useEffectEvent(() => {
    dnd.measureDroppableContainers([]);
  });
  useEffect(() => {
    // A row that stays mounted but moves - its height corrected from the
    // estimate, a folder spring-loaded open above it - changes no target, so
    // dnd-kit would keep its old rect.
    if (dragging && shown) measureTargets();
  }, [dragging, shown, measureVersion]);
  return null;
}
