import { useCallback, type KeyboardEvent, type RefObject } from "react";

/** Roving real DOM focus rather than `aria-activedescendant`: the rows are rich (link, checkbox, pin, delete,
 * context menu), not listbox options. */
const ROW_TARGET_SELECTOR = "[data-history-row-target]";

export interface HistoryListKeyboardNav {
  readonly onSearchKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  /** On the control rather than on the list container so the listener sits on an interactive element. */
  readonly onRowKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

function rowTargets(list: HTMLUListElement | null): ReadonlyArray<HTMLElement> {
  if (list === null) return [];
  return Array.from(list.querySelectorAll<HTMLElement>(ROW_TARGET_SELECTOR));
}

/** Arrow-key traversal from the history search box into its results. */
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
      // The row unmounted from the list this keystroke resolves against (a refetch landed mid-cycle) - drop the key
      // rather than jumping somewhere arbitrary.
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
