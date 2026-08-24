/**
 * React-aware source: open epic tabs (from
 * `useEpicCanvasStore.tabsById` / `openTabOrder`) + epics from the same
 * TanStack Query that powers `/epics` (via `useHistoryQuery`). The
 * two lists dedupe by id with the open-tab copy winning so open
 * epics render with an `"Open"` pill without a second row.
 *
 * The palette's live query is forwarded to the history search (scope prefix
 * stripped), so the rows are the SAME rows the History page would show for
 * that text: the cloud title/repo match plus the local worktree arm that
 * resolves branch names and PR numbers (`84`, `#84`, `PR #84`) to tasks and
 * fetches them by id. With an empty query the source falls back to the
 * default recents page, exactly as before.
 *
 * cmdk still runs its own filter over the pool, so every local-only match
 * key the history search can hit (PR number forms, branch names, repo
 * identifiers) is also carried on the row as a keyword - otherwise a task
 * found BY its PR number would be fetched and then hidden, since neither its
 * id nor its title contains the number.
 *
 * Rendered inside a single "Tasks" group, alphabetical by label.
 *
 * Items dispatch through the router adapter, which resolves the target
 * epic to a concrete local tab id before navigating.
 */
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import type { HistoryItem } from "@/components/home/data/home-page.data";
import {
  DEFAULT_HISTORY_SEARCH,
  patchHistorySearch,
  type HistorySearchState,
} from "@/lib/history-search";
import { displayTitle, epicDisplayTitle } from "@/lib/display-title";
import { usePaletteLiveQuery } from "@/lib/commands/palette-query-context";
import { parseScopePrefix } from "@/lib/commands/scopes";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useHistoryQuery } from "@/hooks/home/use-history-query";
import type {
  CommandContext,
  CommandItem,
  ReactCommandSource,
} from "@/lib/commands/types";

/**
 * The text to search task history for, derived from the raw palette query.
 * A leading Tasks prefix (`#`) is stripped so `#84` searches for `84`; any
 * OTHER scope prefix (`>`, `@`, `?`) hides this group entirely, so its text
 * is not worth a cloud round-trip and the default recents are kept instead.
 */
export function taskSearchQuery(paletteQuery: string): string {
  const parsed = parseScopePrefix(paletteQuery);
  if (parsed === null) return paletteQuery.trim();
  return parsed.scope === "epics" ? parsed.restQuery.trim() : "";
}

function useEpicsItems(_ctx: CommandContext): ReadonlyArray<CommandItem> {
  const openTabs = useEpicCanvasStore(
    useShallow((state) =>
      state.openTabOrder.flatMap((tabId) => {
        const tab = state.tabsById[tabId];
        return tab === undefined ? [] : [tab];
      }),
    ),
  );
  const query = taskSearchQuery(usePaletteLiveQuery());
  // `useHistoryQuery` owns the debounce; this only has to hand it the text.
  const search = useMemo<HistorySearchState>(
    () =>
      query.length === 0
        ? DEFAULT_HISTORY_SEARCH
        : patchHistorySearch(DEFAULT_HISTORY_SEARCH, { query }),
    [query],
  );
  const history = useHistoryQuery({ search, nowMs: null });

  const historyItems = history.data?.items;

  return useMemo<ReadonlyArray<CommandItem>>(() => {
    const rows = historyItems ?? [];
    const rowsByEpicId = new Map<string, HistoryItem>();
    for (const row of rows) {
      if (!rowsByEpicId.has(row.epicId)) rowsByEpicId.set(row.epicId, row);
    }
    const seen = new Set<string>();
    const items: Array<CommandItem> = [];

    for (const tab of openTabs) {
      if (seen.has(tab.epicId)) continue;
      seen.add(tab.epicId);
      items.push(
        buildOpenItem(tab.epicId, tab.name, rowsByEpicId.get(tab.epicId)),
      );
    }

    for (const row of rows) {
      if (seen.has(row.epicId)) continue;
      seen.add(row.epicId);
      items.push(buildRecentItem(row));
    }

    return items;
  }, [openTabs, historyItems]);
}

export const epicsSource: ReactCommandSource = {
  id: "epics",
  useItems: useEpicsItems,
};

/**
 * The search keys the history query can match a row on that are NOT part of
 * the label. Mirrors `LOCAL_FUSE_OPTIONS` in `use-history-query.ts` - every
 * key there except `title`, which is already the row's label.
 *
 * `worktreePaths` earns its place even though the local epic-id resolution
 * deliberately matches paths NARROWLY (basename, or the full path only for a
 * `/`-shaped query, so a common ancestor like the home directory cannot union
 * unrelated tasks into an ordinary search). That narrowness governs which
 * tasks ENTER the pool; this list only governs which pooled rows cmdk is
 * allowed to show, and can never add a task history did not already match. A
 * worktree directory name is not the branch name - a Traycer worktree carries
 * a hash suffix - so a query that matched only by path would otherwise be
 * fetched and then hidden.
 */
function historyMatchKeywords(row: HistoryItem): ReadonlyArray<string> {
  return [
    ...row.pullRequestNumbers,
    ...row.worktreeBranches,
    ...row.linkedRepos,
    ...row.worktreePaths,
  ];
}

function buildOpenItem(
  epicId: string,
  name: string,
  row: HistoryItem | undefined,
): CommandItem {
  return {
    id: `epic:${epicId}`,
    label: displayTitle(name, "epic"),
    description: "Open",
    keywords: [
      "task",
      "epic",
      "open",
      ...(row === undefined ? [] : historyMatchKeywords(row)),
    ],
    group: "epics",
    scope: "epics",
    shortcut: null,
    actionId: null,
    run: (ctx) => ctx.router.navigateToEpic(epicId),
    subpage: null,
  };
}

function buildRecentItem(row: HistoryItem): CommandItem {
  const { epicId } = row;
  return {
    id: `epic:${epicId}`,
    label: epicDisplayTitle({
      title: row.title,
      initialUserPrompt: row.initialUserPrompt,
    }),
    description: null,
    keywords: ["task", "epic", "recent", ...historyMatchKeywords(row)],
    group: "epics",
    scope: "epics",
    shortcut: null,
    actionId: null,
    run: (ctx) => ctx.router.navigateToEpic(epicId),
    subpage: null,
  };
}
