import type { HeaderTab } from "@/stores/tabs/types";

interface NeighborSearch {
  readonly tabs: ReadonlyArray<HeaderTab>;
  readonly shouldRemove: (tab: HeaderTab, index: number) => boolean;
  readonly canReceiveFocus: (tab: HeaderTab) => boolean;
}

export function pickNeighborAfterRemovingTabs(
  tabs: ReadonlyArray<HeaderTab>,
  closingIndex: number,
  shouldRemove: (tab: HeaderTab, index: number) => boolean,
  canReceiveFocus: (tab: HeaderTab) => boolean,
): HeaderTab | null {
  const search: NeighborSearch = { tabs, shouldRemove, canReceiveFocus };
  if (closingIndex === -1) {
    return findEligibleNeighbor(search, tabs.length - 1, -1);
  }

  const left = findEligibleNeighbor(search, closingIndex - 1, -1);
  if (left !== null) return left;
  return findEligibleNeighbor(search, closingIndex + 1, 1);
}

function findEligibleNeighbor(
  search: NeighborSearch,
  startIndex: number,
  direction: -1 | 1,
): HeaderTab | null {
  for (
    let index = startIndex;
    index >= 0 && index < search.tabs.length;
    index += direction
  ) {
    const tab = search.tabs[index];
    if (search.shouldRemove(tab, index)) continue;
    if (!search.canReceiveFocus(tab)) continue;
    return tab;
  }
  return null;
}
