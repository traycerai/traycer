/**
 * Non-component cmdk helpers shared by the modal command palette and the inline
 * in-pane opener: the fuzzy filter, the cmdk row value, and the controller hook
 * that owns the sub-page stack + item dispatch. Split out from the view
 * components (`palette-cmdk.tsx`) so each file stays fast-refresh friendly.
 */
import { useCallback, useRef, useState, type RefObject } from "react";
import { defaultFilter } from "cmdk";
import { runCommandItem } from "@/lib/commands/dispatch";
import { isPathLikeQuery, matchesPathQuery } from "@/lib/commands/path-query";
import { parseScopePrefix } from "@/lib/commands/scopes";
import type {
  CommandContext,
  CommandItem as CommandItemShape,
  CommandSubpage,
} from "@/lib/commands/types";

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
