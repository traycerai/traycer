import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicViewTab } from "@/stores/epics/canvas/types";
import { copyEpicSidebarTabState } from "@/lib/epics/copy-epic-sidebar-tab-state";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

export function duplicateEpicTab(tabId: string): EpicViewTab | null {
  const newTabId = useEpicCanvasStore.getState().duplicateTab(tabId);
  if (newTabId === null) return null;
  Analytics.getInstance().track(AnalyticsEvent.TabDuplicated, {
    target: "task",
  });
  copyEpicSidebarTabState(tabId, newTabId);
  return useEpicCanvasStore.getState().tabsById[newTabId] ?? null;
}
