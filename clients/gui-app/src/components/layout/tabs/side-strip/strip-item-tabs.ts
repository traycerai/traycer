import { flattenStripItemRefs, tabRefKey } from "@/stores/tabs/layout";
import type { TabGroup } from "@/stores/tabs/tab-groups";
import type { HeaderTab } from "@/stores/tabs/types";
import type { TabStripController } from "../tab-strip-controller";
import { stripRowsOf } from "../tab-strip-rows";

/** The strip fields the Activity view's walk of the strip reads. */
export type StripItemsSource = Pick<
  TabStripController,
  "headerItemIds" | "layoutItems" | "groups" | "customizations" | "tabs"
>;

/** The tab group a strip item is in, as a section's block draws and edits it. */
export interface StripItemGroup extends TabGroup {
  readonly id: string;
}

/** One strip item's tabs (two for a split pair) in strip order. */
export interface StripItemTabs {
  readonly itemId: string;
  /** The item's index in the strip, which its drop slot is keyed by. */
  readonly stripIndex: number;
  readonly group: StripItemGroup | null;
  readonly tabs: ReadonlyArray<HeaderTab>;
}

/**
 * The strip's items in the user's order, every tab group flattened: a member
 * of a collapsed group is here, carrying its group.
 */
export function stripItemTabsOf(
  source: StripItemsSource,
): ReadonlyArray<StripItemTabs> {
  const { headerItemIds, layoutItems, groups, customizations, tabs } = source;
  const tabsByKey = new Map(tabs.map((tab) => [tabRefKey(tab), tab]));
  const items = stripRowsOf(
    headerItemIds,
    layoutItems,
    groups,
    customizations,
  ).flatMap((row) => {
    const item = layoutItems.at(row.stripIndex);
    if (item === undefined) return [];
    const itemTabs = flattenStripItemRefs(item).flatMap(
      (ref) => tabsByKey.get(tabRefKey(ref)) ?? [],
    );
    return itemTabs.length === 0 ? [] : [{ row, tabs: itemTabs }];
  });
  return items.map(({ row, tabs: itemTabs }) => ({
    itemId: row.itemId,
    stripIndex: row.stripIndex,
    group:
      row.group === null ? null : { ...row.group.group, id: row.group.groupId },
    tabs: itemTabs,
  }));
}

/** The tasks that have a row in the strip, a collapsed group's members included. */
export function stripEpicIdsOf(
  items: ReadonlyArray<StripItemTabs>,
): ReadonlySet<string> {
  return new Set(
    items.flatMap((item) =>
      item.tabs.flatMap((tab) => (tab.kind === "epic" ? [tab.epicId] : [])),
    ),
  );
}
