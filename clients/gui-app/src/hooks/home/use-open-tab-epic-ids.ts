import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useShallow } from "zustand/react/shallow";

/** Epic ids in tab-strip order. */
export function useOpenTabEpicIds(): readonly string[] {
  return useEpicCanvasStore(
    useShallow((state) =>
      state.openTabOrder.flatMap((tabId) => {
        const tab = state.tabsById[tabId];
        return tab === undefined ? [] : [tab.epicId];
      }),
    ),
  );
}
