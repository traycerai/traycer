/**
 * Non-component command helpers shared by the modal command palette and the inline
 * in-pane opener: the fuzzy filter, the command row key, and the controller hook
 * that owns the sub-page stack + item dispatch. Split out from the view
 * components (`palette-cmdk.tsx`) so each file stays fast-refresh friendly.
 */
import { useCallback, useState } from "react";
import { commandScore } from "@/lib/command-score";
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

/**
 * Rows that outrank every other match of a query they match (C15): typing
 * "layout" means the two layout doors, not the tasks whose titles say it.
 */
const PRIMARY_ITEM_IDS: ReadonlyArray<string> = [
  "customize:layout",
  "customize:layout-settings",
];

export function paletteFilter(
  value: string,
  search: string,
  keywords: string[] | undefined,
): number {
  // Strip the leading scope prefix (`>`, `#`, `@`, `?`) before handing the
  // query to Command's fuzzy scorer so the prefix char doesn't leak into the
  // item's haystack. Empty query already returns 1 from `defaultFilter`.
  const parsed = parseScopePrefix(search);
  const query = parsed?.restQuery ?? search;
  const score = commandScore(value, query, keywords ?? []);
  if (score > 0 && PRIMARY_ITEM_IDS.some((id) => value.startsWith(`${id} `)))
    return 1 + score;
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
