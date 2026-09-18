import { useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDndContext,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  resolveCustomizeDrop,
  suppressNextCustomizeClick,
} from "@/lib/customize/drop";
import { recordSettingGesture } from "@/lib/customize/history";
import { useCustomizeStore } from "@/stores/customize/customize-store";

export function CustomizeDnd({ children }: { children: ReactNode }) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );
  const [dragging, setDragging] = useState(false);
  return (
    <DndContext
      sensors={sensors}
      onDragStart={({ active }) => {
        setDragging(true);
        useCustomizeStore.getState().closePopover();
        useCustomizeStore.getState().setActive(String(active.id));
      }}
      onDragCancel={() => {
        setDragging(false);
        suppressNextCustomizeClick();
      }}
      onDragEnd={({ active, over }) => {
        setDragging(false);
        suppressNextCustomizeClick();
        const group: unknown = over?.data.current?.group;
        const move = resolveCustomizeDrop(
          String(active.id),
          over ? String(over.id) : null,
          typeof group === "string" ? group : null,
        );
        if (move) {
          recordSettingGesture(
            move.analytics,
            move.label,
            move.touches,
            move.run,
          );
          useCustomizeStore.getState().announce(move.announcement);
        }
      }}
    >
      <div data-customize-dragging={dragging ? "" : undefined}>
        {children}
        <DropLine />
      </div>
      <DragOverlay dropAnimation={null}>{null}</DragOverlay>
    </DndContext>
  );
}
export function DropLine() {
  const { active, over } = useDndContext();
  if (!active || !over || active.id === over.id) return null;
  const group: unknown = over.data.current?.group;
  if (
    !resolveCustomizeDrop(
      String(active.id),
      String(over.id),
      typeof group === "string" ? group : null,
    )
  )
    return null;
  const vertical = over.data.current?.axis === "vertical";
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed bg-ring"
      style={{
        left: over.rect.left,
        top: over.rect.top,
        width: vertical ? over.rect.width : 2,
        height: vertical ? 2 : over.rect.height,
      }}
    />
  );
}
