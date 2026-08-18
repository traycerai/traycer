import { useCallback, type KeyboardEvent, type RefObject } from "react";

/**
 * `data-history-row-target` marks a row's full-card activation control in
 * `epics-list-panel.tsx` - the `<Link>` overlay in normal mode, the toggle
 * `<button>` in selection mode. Both already sit at
 * `absolute inset-0`, so focusing one IS "this row is focused" for every visual
 * the row already keys off `group-focus-within/list-row` (pin, PR pills) plus
 * the control's own focus ring. Roving real DOM focus rather than
 * `aria-activedescendant`: the rows are rich (link, checkbox, pin, delete,
 * context menu), not listbox options, so virtual focus would have to reimplement
 * activation that Enter on the anchor already does natively.
 */
const ROW_TARGET_SELECTOR = "[data-history-row-target]";

export interface HistoryListKeyboardNav {
  /** Bind to the search box: ArrowDown drops into the first result. */
  readonly onSearchKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  /**
   * Bind to each row's activation control: ArrowUp/ArrowDown walk the rows.
   * On the control rather than on the list container so the listener sits on an
   * interactive element - a non-interactive `<ul>` carrying key handlers is
   * exactly what `jsx-a11y/no-noninteractive-element-interactions` rejects, and
   * the row overlays have no focusable children to intercept anything.
   */
  readonly onRowKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

function rowTargets(list: HTMLUListElement | null): ReadonlyArray<HTMLElement> {
  if (list === null) return [];
  return Array.from(list.querySelectorAll<HTMLElement>(ROW_TARGET_SELECTOR));
}

/**
 * Arrow-key traversal from the history search box into its results.
 *
 * The DOM order of the rendered rows is the traversal order, read fresh on each
 * keystroke - no index state to drift out of sync when the query refines the
 * list mid-cycle, and "Show more" rows join the sequence the moment they mount.
 */
export function useHistoryListKeyboardNav(
  searchInputRef: RefObject<HTMLInputElement | null>,
  listRef: RefObject<HTMLUListElement | null>,
): HistoryListKeyboardNav {
  const onSearchKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "ArrowDown") return;
      const targets = rowTargets(listRef.current);
      if (targets.length === 0) return;
      // Only claim the key once there is somewhere to go, so an empty result
      // set leaves the caret's own ArrowDown behaviour intact.
      event.preventDefault();
      targets[0].focus();
    },
    [listRef],
  );

  const onRowKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const targets = rowTargets(listRef.current);
      const index = targets.indexOf(event.currentTarget);
      // The row unmounted from the list this keystroke resolves against (a
      // refetch landed mid-cycle) - drop the key rather than jumping somewhere
      // arbitrary.
      if (index < 0) return;
      event.preventDefault();
      if (event.key === "ArrowDown") {
        targets[Math.min(index + 1, targets.length - 1)].focus();
        return;
      }
      if (index === 0) {
        // Back out to the query rather than trapping at the top: refining a
        // near-miss search is the common next move after cycling the matches.
        searchInputRef.current?.focus();
        return;
      }
      targets[index - 1].focus();
    },
    [listRef, searchInputRef],
  );

  return { onSearchKeyDown, onRowKeyDown };
}
