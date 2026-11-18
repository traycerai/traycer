import { __resetTabSyncCoordinatorForTesting } from "@/lib/tab-sync/tab-sync-coordinator";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  flattenLayoutRefs,
  type PersistedTabStripLayout,
} from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";

export function resetStores(): void {
  useTabsStore.setState({
    version: 2,
    items: [],
    activeItemId: null,
    stripOrder: [],
    systemTabs: { history: null, settings: null },
  });
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  __resetTabSyncCoordinatorForTesting();
}

export function seedCommittedLayout(layout: PersistedTabStripLayout): void {
  useTabsStore.setState({
    ...layout,
    stripOrder: flattenLayoutRefs(layout),
  });
}

export function openEpicSource(
  epicId: string,
  name: string,
): { readonly tabId: string; readonly ref: TabRef } {
  const tabId = useEpicCanvasStore.getState().openEpicTab(epicId, name);
  return { tabId, ref: { kind: "epic", id: tabId } };
}
