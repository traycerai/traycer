import type { EpicCanvasStore } from "@/stores/epics/canvas/store";
import { parseEpicTabHref } from "@/lib/history-navigation/liveness";

export type HistoryEligibilityState = Pick<
  EpicCanvasStore,
  "tabsById" | "openTabOrder"
>;

/**
 * Eligible back/forward target per the "skip closed Tasks" rule: the entry's
 * route isn't an epic-tab route, or its tab is open, or the tab is unknown to
 * `tabsById` (left to the liveness/prune path rather than this skip scan).
 * Only a tab present in `tabsById` but absent from `openTabOrder` - a closed
 * Task - is ineligible.
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
    return true;
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
