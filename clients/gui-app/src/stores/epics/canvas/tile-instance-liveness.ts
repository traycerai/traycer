import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { isTileInstanceLive } from "@/stores/epics/canvas/canvas-state";

export function isEpicCanvasTileInstanceLive(instanceId: string): boolean {
  return isTileInstanceLive(
    useEpicCanvasStore.getState().canvasByTabId,
    instanceId,
  );
}
