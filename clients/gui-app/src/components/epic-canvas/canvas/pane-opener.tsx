/**
 * Inline opener rendered directly inside an empty tile pane (no modal). The
 * empty pane IS the opener: it shows the search input + opener categories and
 * drills into sub-pages in place. Each pane mounts its own instance with
 * independent query + sub-page stack, so multiple empty panes are live at once.
 *
 * Builds a pane-scoped `CommandContext` (`targetGroupId = this pane's group`,
 * `activeTabId`/`activeEpicId` = this pane's tab/epic), so leaves open into
 * THIS pane via `openTileInPane` (T3). Host-dependent hooks work directly -
 * the pane renders within the app provider stack (unlike the app-root modal).
 *
 * Precedent for inline cmdk (Command outside a Dialog): worktree-picker.tsx,
 * shell-program-combobox.tsx.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { ArrowLeftIcon } from "lucide-react";
import { Command, CommandInput, CommandList } from "@/components/ui/command";
import { InputGroupButton } from "@/components/ui/input-group";
import { useCommandPaletteRouter } from "@/components/command-palette/command-palette-context";
import {
  OpenerRootView,
  SubpageView,
} from "@/components/command-palette/palette-cmdk";
import {
  paletteFilter,
  handlePalettePageNavigation,
  usePaletteController,
  usePaletteScrollReset,
} from "@/components/command-palette/palette-cmdk-controller";
import { getOpenerItems } from "@/lib/commands/registry";
import { PaletteQueryProvider } from "@/lib/commands/palette-query-context";
import { SearchRunView } from "@/components/epic-canvas/canvas/search-run-view";
import {
  isSearchRunSubpageId,
  parseSearchRunSubpageId,
} from "@/lib/commands/sources/open/search-target";
import { isFilesResultSubpageId } from "@/lib/commands/sources/open/files-result-subpage";
import type { CommandContext } from "@/lib/commands/types";

export interface PaneOpenerProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly groupId: string;
  /**
   * Whether this pane is the globally-active group. When it becomes active
   * (e.g. a keyboard split makes the new empty pane active) the search input
   * is focused so the user can type into the opener without a mouse click.
   */
  readonly active: boolean;
}

export function PaneOpener(props: PaneOpenerProps) {
  const { epicId, tabId, groupId, active } = props;
  const router = useCommandPaletteRouter();
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) return;
    const input = containerRef.current?.querySelector<HTMLInputElement>(
      'input[data-slot="command-input"]',
    );
    input?.focus();
  }, [active]);

  const ctx = useMemo<CommandContext>(
    () => ({
      pathname: router.getPathname(),
      router,
      activeTabId: tabId,
      activeEpicId: epicId,
      focusedComposerKind: null,
      targetGroupId: groupId,
    }),
    [router, tabId, epicId, groupId],
  );

  const controller = usePaletteController({
    ctx,
    resetQuery: () => setQuery(""),
    // The inline opener has no recents/pins and no dialog to close.
    recordUse: () => undefined,
    close: () => undefined,
  });

  const openerItems = useMemo(() => getOpenerItems(ctx), [ctx]);
  const { activeSubpage, runItem, popSubpage } = controller;

  // The text-search step-2 sub-page is rendered by a bespoke view (query +
  // options + results) rather than the generic fuzzy list, and cmdk's own
  // filtering is disabled for it: content search is literal/regex, so the
  // pattern must never fuzzy-filter the result rows.
  const searchRunTarget =
    activeSubpage !== null && isSearchRunSubpageId(activeSubpage.id)
      ? parseSearchRunSubpageId(activeSubpage.id)
      : null;

  // The Files step-2 result lists come pre-ranked from `workspace.searchPaths`
  // (host Fuse, typo/transposition tolerant). cmdk's own filter must NOT
  // re-score/re-order them or drop typo matches, and must not hide the typed
  // notice/truncation rows under a non-matching query. Its filtering stays ON
  // for the Files step-1 source picker and every other opener page.
  const hostRankedResultSubpage =
    activeSubpage !== null && isFilesResultSubpageId(activeSubpage.id);

  const inputPlaceholder = (): string => {
    if (searchRunTarget !== null) return "Text search…";
    return activeSubpage !== null ? activeSubpage.title : "Open into pane…";
  };

  const renderListBody = () => {
    if (searchRunTarget !== null) {
      return (
        <SearchRunView
          key={activeSubpage?.id}
          target={searchRunTarget}
          ctx={ctx}
        />
      );
    }
    if (activeSubpage !== null) {
      return (
        <SubpageView
          key={activeSubpage.id}
          subpage={activeSubpage}
          ctx={ctx}
          onSelect={runItem}
        />
      );
    }
    return <OpenerRootView items={openerItems} onSelect={runItem} />;
  };

  // Typing re-filters the list; `handleQueryChange` keeps the auto-selected
  // first match in view by snapping the scroll container back to the top.
  const { listRef, handleQueryChange } = usePaletteScrollReset(setQuery);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Escape backs out of a sub-page; at the root it does nothing (the pane
    // stays empty/open, still a drop target).
    if (event.key === "Escape" && activeSubpage !== null) {
      event.preventDefault();
      event.stopPropagation();
      popSubpage();
      return;
    }
    handlePalettePageNavigation(event, listRef);
  };

  return (
    <div
      ref={containerRef}
      data-testid="pane-opener"
      data-group-id={groupId}
      className="flex h-full min-h-0 w-full flex-col"
    >
      <Command
        filter={paletteFilter}
        shouldFilter={searchRunTarget === null && !hostRankedResultSubpage}
        onKeyDown={handleKeyDown}
        className="h-full min-h-0 bg-transparent"
      >
        <PaletteQueryProvider value={query}>
          <CommandInput
            value={query}
            onValueChange={handleQueryChange}
            leading={
              activeSubpage !== null ? (
                <InputGroupButton
                  size="icon-xs"
                  aria-label="Back"
                  onClick={popSubpage}
                >
                  <ArrowLeftIcon />
                </InputGroupButton>
              ) : undefined
            }
            placeholder={inputPlaceholder()}
            aria-label="Open into pane"
          />
          {/* `max-h-none` overrides the primitive's `max-h-72` cap so the list
              fills the full pane height instead of clipping mid-way. */}
          <CommandList ref={listRef} className="max-h-none min-h-0 flex-1">
            {renderListBody()}
          </CommandList>
        </PaletteQueryProvider>
      </Command>
    </div>
  );
}
