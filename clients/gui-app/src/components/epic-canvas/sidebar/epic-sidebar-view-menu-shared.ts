/**
 * Label and summary text for the Agents / Artifacts view menus.
 *
 * These are pure string builders over the sort mode and filter counts, kept
 * apart from the menu components so both the sidebar's nested desktop menu and
 * the mobile switcher's flat one describe the same view with the same words. A
 * surface that reworded its own summary would be claiming a different view
 * state than the one the shared store holds.
 */
import {
  SORT_DIRECTION,
  SORT_FIELD_LABELS,
  type SortMode,
} from "@/lib/epic-sort";
import { isSortModeActive } from "@/stores/epics/left-panel-store";

/** One-line "how is this list ordered" summary: field plus a direction arrow. */
export function sortSummary(sort: SortMode): string {
  return `${SORT_FIELD_LABELS[sort.field]} ${
    sort.direction === SORT_DIRECTION.Asc ? "↑" : "↓"
  }`;
}

/**
 * Accessible name for the view-menu trigger. The count badge is `aria-hidden`
 * decoration, so everything the badge conveys - and everything it cannot, like
 * a non-default ordering - has to be said here or a screen reader hears only
 * "Filter agents" no matter how narrowed the list is.
 */
export function viewTriggerLabel(args: {
  readonly base: string;
  readonly filterCount: number;
  readonly sort: SortMode;
  readonly showChanged: boolean;
}): string {
  const details: string[] = [];
  if (args.filterCount > 0) {
    details.push(
      `${args.filterCount} ${args.filterCount === 1 ? "filter" : "filters"} active`,
    );
  }
  if (isSortModeActive(args.sort)) {
    details.push(`ordered by ${SORT_FIELD_LABELS[args.sort.field]}`);
  }
  if (args.showChanged) details.push("visibility changed");
  return details.length === 0
    ? args.base
    : `${args.base}, ${details.join(", ")}`;
}
