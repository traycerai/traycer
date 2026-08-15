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
import { Search, X } from "lucide-react";
import {
  usePanelHeaderSearchQuery,
  usePanelHeaderSearchSlot,
  usePanelHeaderSearchStore,
} from "@/stores/epics/panel-header-search-store";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";

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
    <InputGroup className="h-7 w-full">
      <InputGroupAddon align="inline-start">
        <Search className="size-3.5" aria-hidden />
      </InputGroupAddon>
      <InputGroupInput
        ref={inputRef}
        type="text"
        value={searchQuery}
        onChange={(event) => onSearchQueryChange(event.target.value)}
        onKeyDown={handleInputKeyDown}
        placeholder="Search agents…"
        aria-label="Search agents"
        autoComplete="off"
        spellCheck={false}
        className="text-ui-sm"
        data-testid="epic-chat-search-input"
      />
      <InputGroupAddon align="inline-end">
        {searchQuery.length > 0 ? (
          <InputGroupButton
            type="button"
            size="icon-xs"
            aria-label="Clear agent search"
            onClick={clearSearch}
            data-testid="epic-chat-search-clear"
          >
            <X className="size-3.5" aria-hidden />
          </InputGroupButton>
        ) : null}
        <InputGroupButton
          type="button"
          size="icon-xs"
          aria-label="Close agent search"
          onClick={exitSearch}
          data-testid="epic-chat-search-close"
        >
          <span aria-hidden className="text-overline uppercase">
            esc
          </span>
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
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
