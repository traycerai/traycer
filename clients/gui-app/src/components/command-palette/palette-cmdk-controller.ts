/**
 * Non-component cmdk helpers shared by the modal command palette and the inline
 * in-pane opener: the fuzzy filter, the cmdk row value, and the controller hook
 * that owns the sub-page stack + item dispatch. Split out from the view
 * components (`palette-cmdk.tsx`) so each file stays fast-refresh friendly.
 */
import {
  useCallback,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { defaultFilter } from "cmdk";
import { runCommandItem } from "@/lib/commands/dispatch";
import { isPathLikeQuery, matchesPathQuery } from "@/lib/commands/path-query";
import { parseScopePrefix } from "@/lib/commands/scopes";
import type {
  CommandContext,
  CommandItem as CommandItemShape,
  CommandSubpage,
} from "@/lib/commands/types";
import {
  Analytics,
  AnalyticsEvent,
  type AnalyticsCommand,
} from "@/lib/analytics";

export function buildCmdkValue(item: CommandItemShape): string {
  return `${item.id} ${item.label}`;
}

export interface PaletteScrollReset {
  readonly listRef: RefObject<HTMLDivElement | null>;
  readonly handleQueryChange: (value: string) => void;
}

/**
 * cmdk physically re-sorts its item DOM nodes on every keystroke and its
 * built-in scroll-into-view (run a render later than the query change) can leave
 * the list parked at an offbeat position. Since the top match is always the
 * auto-selected/active row, the correct behaviour while filtering is to snap the
 * scroll container back to the top.
 *
 * Pass the surface's `setQuery`; the returned `handleQueryChange` writes the
 * query and then snaps the bound list to the top. Wire it to the input's
 * `onValueChange` and spread `listRef` onto the `CommandList`. The reset is
 * deferred to the next frame so it lands AFTER cmdk's own scroll.
 */
export function usePaletteScrollReset(
  setQuery: (value: string) => void,
): PaletteScrollReset {
  const listRef = useRef<HTMLDivElement | null>(null);
  const handleQueryChange = useCallback(
    (value: string) => {
      setQuery(value);
      requestAnimationFrame(() => {
        const el = listRef.current;
        if (el !== null) el.scrollTop = 0;
      });
    },
    [setQuery],
  );
  return { listRef, handleQueryChange };
}

type PalettePageDirection = "up" | "down";

function pointerMoveEvent(): Event {
  if (typeof PointerEvent === "function") {
    return new PointerEvent("pointermove", { bubbles: true });
  }
  return new MouseEvent("pointermove", { bubbles: true });
}

export function movePaletteSelectionByPage(
  list: HTMLElement,
  direction: PalettePageDirection,
): void {
  const items = Array.from(
    list.querySelectorAll<HTMLElement>('[data-slot="command-item"]'),
  ).filter((el) => el.closest("[hidden]") === null);
  if (items.length === 0) return;

  const rowHeight = items[0]?.offsetHeight || 36;
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

  target.dispatchEvent(pointerMoveEvent());
  target.scrollIntoView({ block: "nearest" });
}

export function handlePalettePageNavigation(
  event: KeyboardEvent,
  listRef: RefObject<HTMLDivElement | null>,
): boolean {
  if (event.key !== "PageDown" && event.key !== "PageUp") return false;

  event.preventDefault();
  const list = listRef.current;
  if (list !== null) {
    movePaletteSelectionByPage(list, event.key === "PageDown" ? "down" : "up");
  }
  return true;
}

export function paletteFilter(
  value: string,
  search: string,
  keywords: string[] | undefined,
): number {
  // Strip the leading scope prefix (`>`, `#`, `@`, `?`) before handing the
  // query to cmdk's fuzzy scorer so the prefix char doesn't leak into the
  // item's haystack. Empty query already returns 1 from `defaultFilter`.
  const parsed = parseScopePrefix(search);
  const query = parsed?.restQuery ?? search;
  const score = defaultFilter(value, query, keywords);
  if (score > 0 || keywords === undefined || !isPathLikeQuery(query)) {
    return score;
  }
  // Rescue an over-qualified PASTED path. command-score can't subsequence-match
  // a query that is longer/more-qualified than the candidate (an absolute or
  // repo-relative path pasted against the workspace-relative one), so file/diff
  // rows - whose keyword is the workspace-relative path - would vanish. Treat a
  // trailing-sub-path match as a top hit so the pasted file sorts to the top.
  return keywords.some((keyword) => matchesPathQuery(query, keyword)) ? 1 : 0;
}

export interface PaletteControllerArgs {
  readonly ctx: CommandContext;
  readonly resetQuery: () => void;
  readonly recordUse: (id: string) => void;
  readonly close: () => void;
}

export interface PaletteController {
  readonly activeSubpage: CommandSubpage | null;
  readonly runItem: (item: CommandItemShape) => void;
  readonly popSubpage: () => void;
  readonly resetStack: () => void;
}

/**
 * Owns the sub-page push/pop stack and item dispatch. Each palette surface
 * gets its own instance, so multiple inline openers keep independent state.
 */
export function usePaletteController(
  args: PaletteControllerArgs,
): PaletteController {
  const { ctx, resetQuery, recordUse, close } = args;
  const [subpageStack, setSubpageStack] = useState<
    ReadonlyArray<CommandSubpage>
  >([]);
  const activeSubpage =
    subpageStack.length > 0 ? subpageStack[subpageStack.length - 1] : null;

  const runItem = useCallback(
    (item: CommandItemShape) => {
      if (item.subpage !== null) {
        const next = item.subpage;
        setSubpageStack((prev) => [...prev, next]);
        recordUse(item.id);
        resetQuery();
        return;
      }
      const analyticsCommand = analyticsCommandForItem(item);
      if (analyticsCommand !== null) {
        Analytics.getInstance().track(AnalyticsEvent.CommandExecuted, {
          command: analyticsCommand,
          source: "command_palette",
        });
      }
      void runCommandItem(item, ctx, { recordUse, close });
    },
    [ctx, recordUse, close, resetQuery],
  );

  const popSubpage = useCallback(() => {
    setSubpageStack((prev) => prev.slice(0, -1));
    resetQuery();
  }, [resetQuery]);

  const resetStack = useCallback(() => setSubpageStack([]), []);

  return { activeSubpage, runItem, popSubpage, resetStack };
}

function analyticsCommandForItem(
  item: CommandItemShape,
): AnalyticsCommand | null {
  if (item.id.startsWith("open:files:")) return "open_file";
  if (item.id.startsWith("open:diff:")) return "open_diff";
  if (item.id.startsWith("open:chats:")) return "open_chat";
  if (item.id.startsWith("open:artifacts:")) return "open_artifact";
  if (item.id.startsWith("open:terminals:")) return "open_terminal";
  if (item.id.startsWith("open:tui:")) return "open_terminal";
  if (item.id.startsWith("epic:")) return "open_task";
  if (item.id === "help:report-issue") return "report_issue";
  if (item.actionId === "epic.new") return "create_task";
  if (item.actionId === "epic.duplicate-tab") return "duplicate_tab";
  if (item.actionId === "app.settings.open") return "open_settings";
  if (item.actionId === "app.history.open") return "open_task";
  if (item.actionId === "app.terminal.new") return "open_terminal";
  return null;
}
