import { useEpicSidebarExpansionStore } from "@/stores/epics/epic-sidebar-expansion-store";
import { useLeftPanelStore } from "@/stores/epics/left-panel-store";

export function copyEpicSidebarTabState(
  sourceTabId: string,
  targetTabId: string,
): void {
  if (sourceTabId === targetTabId) return;
  useLeftPanelStore.getState().copyTabState(sourceTabId, targetTabId);
  useEpicSidebarExpansionStore
    .getState()
    .copyTabState(sourceTabId, targetTabId);
}
