/**
 * React-aware source: open epic tabs (from
 * `useEpicCanvasStore.tabsById` / `openTabOrder`) + recent epics from the same
 * TanStack Query that powers `/epics` (via `useHistoryQuery`). The
 * two lists dedupe by id with the open-tab copy winning so open
 * epics render with an `"Open"` pill without a second row.
 *
 * Rendered inside a single "Tasks" group, alphabetical by label.
 *
 * Items dispatch through the router adapter, which resolves the target
 * epic to a concrete local tab id before navigating.
 */
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { DEFAULT_HISTORY_SEARCH } from "@/lib/history-search";
import { displayTitle, epicDisplayTitle } from "@/lib/display-title";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useHistoryQuery } from "@/hooks/home/use-history-query";
import type {
  CommandContext,
  CommandItem,
  ReactCommandSource,
} from "@/lib/commands/types";

function useEpicsItems(_ctx: CommandContext): ReadonlyArray<CommandItem> {
  const openTabs = useEpicCanvasStore(
    useShallow((state) =>
      state.openTabOrder.flatMap((tabId) => {
        const tab = state.tabsById[tabId];
        return tab === undefined ? [] : [tab];
      }),
    ),
  );
  const history = useHistoryQuery({
    search: DEFAULT_HISTORY_SEARCH,
    nowMs: null,
  });

  const historyItems = history.data?.items;

  return useMemo<ReadonlyArray<CommandItem>>(() => {
    const recentRows = historyItems ?? [];
    const seen = new Set<string>();
    const items: Array<CommandItem> = [];

    for (const tab of openTabs) {
      seen.add(tab.epicId);
      items.push(buildOpenItem(tab.epicId, tab.name));
    }

    for (const row of recentRows) {
      if (seen.has(row.epicId)) continue;
      seen.add(row.epicId);
      items.push(buildRecentItem(row.epicId, row.title, row.initialUserPrompt));
    }

    return items;
  }, [openTabs, historyItems]);
}

export const epicsSource: ReactCommandSource = {
  id: "epics",
  useItems: useEpicsItems,
};

function buildOpenItem(epicId: string, name: string): CommandItem {
  return {
    id: `epic:${epicId}`,
    label: displayTitle(name, "epic"),
    description: "Open",
    keywords: ["task", "epic", "open"],
    group: "epics",
    scope: "epics",
    shortcut: null,
    actionId: null,
    run: (ctx) => ctx.router.navigateToEpic(epicId),
    subpage: null,
  };
}

function buildRecentItem(
  epicId: string,
  title: string,
  initialUserPrompt: string,
): CommandItem {
  return {
    id: `epic:${epicId}`,
    label: epicDisplayTitle({ title, initialUserPrompt }),
    description: null,
    keywords: ["task", "epic", "recent"],
    group: "epics",
    scope: "epics",
    shortcut: null,
    actionId: null,
    run: (ctx) => ctx.router.navigateToEpic(epicId),
    subpage: null,
  };
}
