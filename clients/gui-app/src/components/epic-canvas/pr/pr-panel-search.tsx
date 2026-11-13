import { useCallback, type KeyboardEvent, type ReactNode } from "react";
import { PanelSearchField } from "@/components/epic-canvas/sidebar/epic-sidebar-search-field";
import {
  usePrPanelSearchQuery,
  usePrPanelStore,
} from "@/stores/epics/pr-panel-store";

/**
 * The Pull Requests panel's resting search field, in the header beside the
 * state filter. The query lives per Epic view tab in `pr-panel-store`;
 * Escape clears it.
 */
export function PrPanelSearch(props: { readonly tabId: string }): ReactNode {
  const { tabId } = props;
  const query = usePrPanelSearchQuery(tabId);
  const setSearchQuery = usePrPanelStore((state) => state.setSearchQuery);
  const handleChange = useCallback(
    (value: string): void => {
      setSearchQuery(tabId, value);
    },
    [setSearchQuery, tabId],
  );
  const handleClear = useCallback((): void => {
    setSearchQuery(tabId, "");
  }, [setSearchQuery, tabId]);
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>): void => {
      if (event.key !== "Escape" || query === "") return;
      event.preventDefault();
      event.stopPropagation();
      setSearchQuery(tabId, "");
    },
    [query, setSearchQuery, tabId],
  );
  return (
    <div className="min-w-0 flex-1">
      <PanelSearchField
        value={query}
        onValueChange={handleChange}
        onClear={handleClear}
        onClose={null}
        onKeyDown={handleKeyDown}
        ref={null}
        combobox={null}
        placeholder="Search pull requests..."
        label="Search pull requests"
        clearLabel="Clear search"
        closeLabel=""
        testIdPrefix="pr-panel-search"
        variant="filter"
        className="h-7"
      />
    </div>
  );
}
