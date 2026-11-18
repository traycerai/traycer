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
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  __resetTabSyncCoordinatorForTesting();
}

export function seedCommittedLayout(layout: PersistedTabStripLayout): void {
  // Optional in a persisted layout, so a seed names each one: a layout that
  // omits them must not inherit what an earlier case left in the store.
  useTabsStore.setState({
    ...layout,
    activationHistory: layout.activationHistory ?? [],
    customizations: layout.customizations ?? {},
    groups: layout.groups ?? {},
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
