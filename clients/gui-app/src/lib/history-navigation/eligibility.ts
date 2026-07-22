import {
  resolveTabIdForEpic,
  type EpicCanvasStore,
} from "@/stores/epics/canvas/store";
import { parseNestedFocusTargetFromHref } from "@/lib/epic-nested-focus-route";
import { parseEpicTabHref } from "@/lib/history-navigation/liveness";

export type HistoryEligibilityState = Pick<
  EpicCanvasStore,
  "activeTabId" | "mostRecentTabIdByEpicId" | "tabsById" | "openTabOrder"
>;

/**
 * Eligible back/forward target per the "skip closed Tasks" rule: the entry's
 * route isn't an epic-tab route, its tab is open, or an unknown tab id would
 * resolve to an open fallback tab for the same epic. Unknown nested targets
 * cannot fall back because their pane/tile identity belongs to the missing
 * tab. Exact and fallback tabs that are currently closed are both ineligible;
 * their history entries remain retained so reopening the tab makes them
 * reachable again.
 */
export function isHistoryEntryEligible(
  href: string,
  state: HistoryEligibilityState,
): boolean {
  const epicTab = parseEpicTabHref(href);
  if (epicTab === null) {
    return true;
  }
  if (state.tabsById[epicTab.tabId] === undefined) {
    if (parseNestedFocusTargetFromHref(href) !== null) {
      return false;
    }
    const fallbackTabId = resolveTabIdForEpic(state, epicTab.epicId);
    return fallbackTabId !== null && state.openTabOrder.includes(fallbackTabId);
  }
  return state.openTabOrder.includes(epicTab.tabId);
}

/**
 * Offset (from `index`) to the nearest entry satisfying `isEligible` while
 * walking `entries` in `direction` (`-1` back, `1` forward), or `null` when
 * none exists before the stack boundary. Scanning here - rather than
 * stepping one entry at a time - lets a single `go(±offset)` skip over every
 * closed-Task entry in between in one navigation.
 */
export function findEligibleOffset(
  entries: ReadonlyArray<string>,
  index: number,
  direction: -1 | 1,
  isEligible: (href: string) => boolean,
): number | null {
  for (
    let i = index + direction;
    i >= 0 && i < entries.length;
    i += direction
  ) {
    if (isEligible(entries[i])) {
      return i - index;
    }
  }
  return null;
}
