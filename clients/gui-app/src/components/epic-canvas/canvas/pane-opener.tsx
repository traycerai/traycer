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
  usePaletteController,
  usePaletteScrollReset,
} from "@/components/command-palette/palette-cmdk-controller";
import { getOpenerItems } from "@/lib/commands/registry";
import { PaletteQueryProvider } from "@/lib/commands/palette-query-context";
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

  // Typing re-filters the list; `handleQueryChange` keeps the auto-selected
  // first match in view by snapping the scroll container back to the top.
  const { listRef, handleQueryChange } = usePaletteScrollReset(setQuery);

  // cmdk only navigates by ArrowUp/Down/Home/End. Page Up/Down jump a viewport:
  // we find the target row in the DOM and select it with a single `pointermove`
  // (cmdk selects an item on pointer-move), then scroll it into view. A loop of
  // synthetic arrow keys does NOT work - cmdk derives "next" from the
  // not-yet-committed selection, so every key in one tick lands on the same row.
  const pageMove = (direction: "up" | "down") => {
    const list = listRef.current;
    if (list === null) return;
    const items = Array.from(
      list.querySelectorAll<HTMLElement>('[data-slot="command-item"]'),
    );
    if (items.length === 0) return;
    const rowHeight = items[0].offsetHeight || 36;
    const pageSize = Math.max(1, Math.floor(list.clientHeight / rowHeight) - 1);
    const selectedIndex = items.findIndex(
      (el) => el.getAttribute("data-selected") === "true",
    );
    // When nothing is selected yet, anchor just outside the list so the first
    // page lands on the first/last row.
    const unselectedAnchor = direction === "down" ? -1 : items.length;
    const from = selectedIndex === -1 ? unselectedAnchor : selectedIndex;
    const delta = direction === "down" ? pageSize : -pageSize;
    const targetIndex = Math.min(items.length - 1, Math.max(0, from + delta));
    const target = items[targetIndex];
    target.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
    target.scrollIntoView({ block: "nearest" });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Escape backs out of a sub-page; at the root it does nothing (the pane
    // stays empty/open, still a drop target).
    if (event.key === "Escape" && activeSubpage !== null) {
      event.preventDefault();
      event.stopPropagation();
      popSubpage();
      return;
    }
    if (event.key === "PageDown" || event.key === "PageUp") {
      event.preventDefault();
      pageMove(event.key === "PageDown" ? "down" : "up");
    }
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
            placeholder={
              activeSubpage !== null ? activeSubpage.title : "Open into pane…"
            }
            aria-label="Open into pane"
          />
          {/* `max-h-none` overrides the primitive's `max-h-72` cap so the list
              fills the full pane height instead of clipping mid-way. */}
          <CommandList ref={listRef} className="max-h-none min-h-0 flex-1">
            {activeSubpage !== null ? (
              <SubpageView
                key={activeSubpage.id}
                subpage={activeSubpage}
                ctx={ctx}
                onSelect={runItem}
              />
            ) : (
              <OpenerRootView items={openerItems} onSelect={runItem} />
            )}
          </CommandList>
        </PaletteQueryProvider>
      </Command>
    </div>
  );
}
