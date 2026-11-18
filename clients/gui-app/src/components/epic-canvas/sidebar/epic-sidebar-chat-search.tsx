/**
 * Search-mode input for the Epic sidebar's agent (chat) panel.
 *
 * Same shape as artifact search - search is a MODE, the header row is traded
 * for the input rather than growing a second row, the overflow menu and
 * type-to-filter both enter it, Escape leaves it - but the body below is
 * unchanged: matches narrow the TREE through `SidebarFilterVisibilityContext`
 * instead of replacing it with a result list, so every row keeps its progress
 * icon, notification indicators, and row menus while searching. See
 * `chat-search-fuzzy.ts` for why an agent's search is local, not an RPC.
 *
 * The input's DOM is portaled into the header's slot while the component itself
 * stays mounted in the panel body, so its ref and focus handling live next to
 * the tree they drive.
 */
import { useCallback, useEffect, useRef, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import {
  usePanelHeaderSearchQuery,
  usePanelHeaderSearchSlot,
  usePanelHeaderSearchStore,
} from "@/stores/epics/panel-header-search-store";
import { PanelSearchField } from "@/components/epic-canvas/sidebar/epic-sidebar-search-field";

/** The panel whose header this search takes over while it is active. */
const CHATS_PANEL_ID = "chats";

interface ChatSearchHeaderInputProps {
  readonly tabId: string;
  /** Rows surviving the search, for the screen-reader status line. */
  readonly resultCount: number;
}

export function ChatSearchHeaderInput(props: ChatSearchHeaderInputProps) {
  const { tabId } = props;
  const searchQuery = usePanelHeaderSearchQuery(tabId, CHATS_PANEL_ID);
  const headerSlot = usePanelHeaderSearchSlot(tabId, CHATS_PANEL_ID);
  const setSearchQuery = usePanelHeaderSearchStore((s) => s.setSearchQuery);
  const closeSearch = usePanelHeaderSearchStore((s) => s.closeSearch);
  const inputRef = useRef<HTMLInputElement>(null);

  const onSearchQueryChange = useCallback(
    (value: string) => setSearchQuery(tabId, CHATS_PANEL_ID, value),
    [setSearchQuery, tabId],
  );
  const exitSearch = useCallback(
    () => closeSearch(tabId, CHATS_PANEL_ID),
    [closeSearch, tabId],
  );
  const clearSearch = useCallback(() => {
    onSearchQueryChange("");
    inputRef.current?.focus();
  }, [onSearchQueryChange]);

  // Focus the portaled input as soon as the header slot exists, so both entry
  // paths (overflow menu, type-to-filter) land the caret without a mouse click.
  useEffect(() => {
    if (headerSlot === null) return;
    inputRef.current?.focus();
  }, [headerSlot]);

  const handleInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      exitSearch();
    },
    [exitSearch],
  );

  const inputRow = (
    <PanelSearchField
      value={searchQuery}
      onValueChange={onSearchQueryChange}
      onClear={clearSearch}
      onClose={exitSearch}
      onKeyDown={handleInputKeyDown}
      ref={inputRef}
      combobox={null}
      placeholder="Search agents…"
      label="Search agents"
      clearLabel="Clear agent search"
      closeLabel="Close agent search"
      testIdPrefix="epic-chat-search"
      className="h-7"
    />
  );

  return (
    <>
      {/* The header slot is written by a ref callback during the header's
          commit, so it is null only on this component's very first render;
          the resulting store write re-renders us with the target in hand. */}
      {headerSlot === null ? null : createPortal(inputRow, headerSlot)}
      <p className="sr-only" role="status" aria-live="polite">
        {chatSearchStatusMessage(searchQuery, props.resultCount)}
      </p>
    </>
  );
}

function chatSearchStatusMessage(query: string, resultCount: number): string {
  if (query.trim().length === 0) return "";
  if (resultCount === 0) return "No agents match your search.";
  return `${resultCount} agent ${resultCount === 1 ? "result" : "results"}.`;
}
