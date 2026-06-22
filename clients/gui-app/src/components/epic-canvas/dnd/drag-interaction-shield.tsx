import { useCallback, type WheelEvent } from "react";
import { useEpicDndInteractionLocked } from "@/components/epic-canvas/dnd/dnd-store";

/**
 * Blocks wheel scrolling over the canvas while a typed canvas/rail drag is
 * active. Owned by `TileCanvas` - exactly one shield per canvas; do NOT add
 * per-`TabGroupView` shields.
 */
export function EpicCanvasDragInteractionShield() {
  const interactionLocked = useEpicDndInteractionLocked();
  const preventWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  if (!interactionLocked) return null;

  return (
    <div
      aria-hidden
      data-testid="epic-canvas-drag-interaction-shield"
      className="absolute inset-0 z-10 cursor-grabbing select-none"
      onWheelCapture={preventWheel}
    />
  );
}
