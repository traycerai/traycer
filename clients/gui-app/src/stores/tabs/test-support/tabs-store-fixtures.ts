import { tabItemId } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";

/**
 * Shared tabs-store seeds for tests.
 *
 * The versioned `setState` shape is the layout contract, so restating it per
 * test file means every future field has to be added in each copy - and a copy
 * that is missed keeps compiling while seeding a layout the store no longer
 * produces.
 */
export function resetTabsStoreForTest(): void {
  useTabsStore.setState({
    version: 2,
    items: [],
    activeItemId: null,
    stripOrder: [],
    systemTabs: { history: null, settings: null },
  });
}

/** Seeds a single active Epic strip tab for `epicTabId`. */
export function seedActiveEpicTabInTabsStore(epicTabId: string): void {
  const ref = { kind: "epic", id: epicTabId } as const;
  useTabsStore.setState({
    version: 2,
    items: [{ kind: "tab", id: tabItemId(ref), ref }],
    activeItemId: tabItemId(ref),
    stripOrder: [ref],
    systemTabs: { history: null, settings: null },
  });
}
