import { useCallback } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { getCustomizeOptions } from "@/lib/customize/customize-options";
import { useCustomizeStore } from "@/stores/customize/customize-store";

/** No layout writes or sibling animation during drag; commit only at drop. */
export function useSortableProxy(
  instanceKey: string,
  axis: "horizontal" | "vertical" | "both",
) {
  const instance = useCustomizeStore((state) =>
    state.instances.get(instanceKey),
  );
  const descriptor = instance ? getCustomizeOptions(instance)?.drag : null;
  const data = { group: descriptor?.group, axis };
  const {
    attributes,
    listeners,
    transform,
    setNodeRef: setDraggableRef,
  } = useDraggable({ id: instanceKey, disabled: !descriptor, data });
  const { setNodeRef: setDroppableRef } = useDroppable({
    id: instanceKey,
    disabled: !descriptor,
    data,
  });
  const setNodeRef = useCallback(
    (node: HTMLElement | null) => {
      setDraggableRef(node);
      setDroppableRef(node);
    },
    [setDraggableRef, setDroppableRef],
  );
  return {
    attributes: descriptor ? attributes : {},
    listeners,
    setNodeRef,
    transform: transform
      ? {
          x: axis === "vertical" ? 0 : transform.x,
          y: axis === "horizontal" ? 0 : transform.y,
        }
      : null,
  };
}
export function useDroppableSlot(id: string, group: string) {
  return useDroppable({ id, data: { group } });
}
