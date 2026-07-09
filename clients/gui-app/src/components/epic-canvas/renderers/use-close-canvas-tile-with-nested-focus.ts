import { useCallback } from "react";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

export function useCloseCanvasTileWithNestedFocus(
  viewTabId: string,
  paneId: string,
  tileInstanceId: string,
): () => void {
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareCloseCanvasTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareCloseCanvasTabFocusTarget,
  );

  return useCallback(() => {
    const epicId =
      useEpicCanvasStore.getState().tabsById[viewTabId]?.epicId ?? null;
    const prepare = () =>
      prepareCloseCanvasTabFocusTarget(viewTabId, paneId, tileInstanceId);
    if (epicId === null) {
      prepare();
      return;
    }
    navigateNested(epicId, viewTabId, prepare);
  }, [
    navigateNested,
    paneId,
    prepareCloseCanvasTabFocusTarget,
    tileInstanceId,
    viewTabId,
  ]);
}
