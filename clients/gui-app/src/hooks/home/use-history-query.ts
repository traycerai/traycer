import type {
  HistoryItem,
  HistoryOwnershipScope,
  HistorySortOption,
  HistoryWorkspaceRef,
} from "@/components/home/data/home-page.data";
import {
  buildHistoryItemsFromTasks,
  collectHistoryRepos,
  dedupSortWorkspaces,
  filterHistoryItems,
  historyPullRequestQueryNumber,
  historyPullRequestSearchEpicIds,
  historyWorktreeSearchEpicIds,
  prioritizePinnedHistoryItems,
  sortHistoryItems,
  withHistoryItemWorktreeMetadata,
} from "@/components/home/data/home-page.data";
import { useCloudEpicTasksQuery } from "@/hooks/epics/use-cloud-epic-tasks-query";
import { useDebouncedValue } from "@/hooks/ui/use-debounced-value";
import { useEpicGetTaskContexts } from "@/hooks/epic/use-epic-get-task-contexts-query";
import {
  useTaskWorktreeMetadata,
  useWorktreeHostActivityIndex,
  useWorktreeHostIndex,
} from "@/hooks/worktree/use-task-worktree-metadata-query";
import {
  listCloudTasksRequestForHistorySearch,
  type ListCloudTasksRequest,
} from "@/lib/cloud-epic-tasks-query";
import type { ListTasksResponse } from "@traycer/protocol/host/epic/unary-schemas";
import type { WorktreeHostEntryV12 } from "@traycer/protocol/host/worktree-schemas";
import type { HistorySearchState } from "@/lib/history-search";
import { patchHistorySearch } from "@/lib/history-search";
import Fuse, { type IFuseOptions } from "fuse.js";
import { useCallback, useMemo, useState } from "react";

const SEARCH_DEBOUNCE_MS = 250;
const LOCAL_FUSE_OPTIONS: IFuseOptions<HistoryItem> = {
  includeScore: false,
  ignoreLocation: true,
  threshold: 0.4,
  minMatchCharLength: 1,
  keys: [
    { name: "title", weight: 0.8 },
    { name: "linkedRepos", weight: 0.2 },
    { name: "pullRequestNumbers", weight: 0.8 },
    { name: "worktreeBranches", weight: 0.8 },
    { name: "worktreePaths", weight: 0.3 },
  ],
};

export interface UseHistoryQueryParams {
  search: HistorySearchState;
  nowMs: number | null;
}

export interface UseHistoryQueryResult {
  data: HistoryFetchResult | undefined;
  isPending: boolean;
  isFetching: boolean;
  error: Error | null;
  hostId: string | null;
  refetch: () => Promise<unknown>;
  fetchNextPage: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
}

export function useHistoryQuery(
  params: UseHistoryQueryParams,
): UseHistoryQueryResult {
  const trimmedQuery = params.search.query.trim();
  const debouncedQuery = useDebouncedValue(trimmedQuery, SEARCH_DEBOUNCE_MS);
  const [fallbackNowMs] = useState(() => Date.now());
  const nowMs = params.nowMs ?? fallbackNowMs;
  // Branch/worktree strings and PR numbers live only in local worktree
  // metadata, never in the cloud task index. The cloud query stays a plain
  // text search; local matches are resolved to epic ids here and fetched by
  // id (`epic.getTaskContexts`) as an additive union below. PR matching needs
  // the activity-enriched listing (`prNumber` is null on the cheap index), so
  // that heavier host-wide probe is gated on a PR-shaped query.
  const worktreeIndex = useWorktreeHostIndex(true);
  const pullRequestQueryNumber = historyPullRequestQueryNumber(debouncedQuery);
  const isPullRequestNumberQuery = pullRequestQueryNumber !== null;
  const activityIndex = useWorktreeHostActivityIndex(isPullRequestNumberQuery);
  const localTaskIds = useMemo(
    () =>
      Array.from(
        new Set([
          ...historyWorktreeSearchEpicIds(
            debouncedQuery,
            worktreeIndex.worktrees,
          ),
          ...(pullRequestQueryNumber === null
            ? []
            : historyPullRequestSearchEpicIds(
                pullRequestQueryNumber,
                activityIndex.worktrees,
              )),
        ]),
      ).sort((left, right) => left.localeCompare(right)),
    [
      activityIndex.worktrees,
      debouncedQuery,
      pullRequestQueryNumber,
      worktreeIndex.worktrees,
    ],
  );
  const request = useMemo<ListCloudTasksRequest>(() => {
    const search = patchHistorySearch(params.search, {
      query: debouncedQuery,
    });
    return listCloudTasksRequestForHistorySearch(search);
  }, [debouncedQuery, params.search]);
  const {
    hostId,
    currentUserId,
    tasks,
    query: tasksQuery,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useCloudEpicTasksQuery(request, { enabled: true });
  const tasksQueryRefetch = tasksQuery.refetch;
  const isQueryDebouncing = debouncedQuery !== trimmedQuery;
  const shouldProjectLocally =
    isQueryDebouncing || tasksQuery.isFetching || tasksQuery.isPlaceholderData;
  const taskContexts = useEpicGetTaskContexts(localTaskIds, currentUserId);
  const baseItems = useMemo(
    () => buildHistoryItemsFromTasks(tasks, nowMs, currentUserId),
    [currentUserId, nowMs, tasks],
  );
  const contextItems = useMemo(
    () =>
      filterHistoryItemsLocally(
        buildHistoryItemsFromTasks(
          Array.from(taskContexts.tasksById.values()),
          nowMs,
          currentUserId,
        ),
        params.search,
      ),
    [currentUserId, nowMs, params.search, taskContexts.tasksById],
  );
  // Locally matched tasks are unioned under the cloud page: the cloud rows
  // keep their server order and the id-fetched extras are appended (dedup by
  // row id). Extras respect the structured filters via the local predicate
  // above; the ordering pass happens in the `data` memo.
  const { allBaseItems, contextExtrasCount } = useMemo(() => {
    if (contextItems.length === 0) {
      return { allBaseItems: baseItems, contextExtrasCount: 0 };
    }
    const seen = new Set(baseItems.map((item) => item.id));
    const extras = contextItems.filter((item) => !seen.has(item.id));
    return {
      allBaseItems: extras.length === 0 ? baseItems : [...baseItems, ...extras],
      contextExtrasCount: extras.length,
    };
  }, [baseItems, contextItems]);
  const historyEpicIds = useMemo(
    () => allBaseItems.map((item) => item.epicId),
    [allBaseItems],
  );
  const worktreeMetadata = useTaskWorktreeMetadata(historyEpicIds);
  const worktreesByEpicId = worktreeMetadata.worktreesByEpicId;
  const allItems = useMemo(
    () => withHistoryItemWorktreeMetadata(allBaseItems, worktreesByEpicId),
    [allBaseItems, worktreesByEpicId],
  );

  const data = useMemo<HistoryFetchResult | undefined>(() => {
    if (tasksQuery.data === undefined) {
      return undefined;
    }
    // The settled server order is pinned-first, but an optimistic pin patch
    // flips a cached row's bit without moving it - the stable pinned-first
    // partition lifts it into (or drops it out of) the pinned block
    // instantly, and is an order-preserving no-op on untouched server data.
    // When id-fetched extras joined the settled list they arrive appended out
    // of order, so that path re-sorts the union client-side instead.
    const items = shouldProjectLocally
      ? projectHistoryItems(allItems, params.search)
      : settledHistoryItems(
          allItems,
          contextExtrasCount,
          params.search.sort,
          debouncedQuery,
        );
    const canUseServerFacets =
      !isQueryDebouncing && !tasksQuery.isPlaceholderData;
    const facets = canUseServerFacets
      ? mapHistoryFacets(tasksQuery.data.facets)
      : EMPTY_FACETS;
    const availableWorkspaces =
      facets.workspaces.length > 0
        ? facets.workspaces.map((workspace) => workspace.workspace)
        : collectHistoryWorkspaces(allItems);
    return {
      items,
      availableRepos:
        facets.repos.length > 0
          ? facets.repos.map((repo) => repo.label)
          : collectHistoryRepos(allItems),
      availableWorkspaces,
      totalCount: items.length,
      facets,
      worktreesByEpicId,
    };
  }, [
    allItems,
    contextExtrasCount,
    debouncedQuery,
    isQueryDebouncing,
    params.search,
    shouldProjectLocally,
    tasksQuery.data,
    tasksQuery.isPlaceholderData,
    worktreesByEpicId,
  ]);

  const refetch = useCallback(() => tasksQueryRefetch(), [tasksQueryRefetch]);

  return {
    data,
    isPending: tasksQuery.isPending,
    isFetching:
      tasksQuery.isFetching ||
      isQueryDebouncing ||
      (isPullRequestNumberQuery && activityIndex.isFetching) ||
      taskContexts.isFetching,
    error:
      (tasksQuery.error instanceof Error ? tasksQuery.error : null) ??
      (isPullRequestNumberQuery ? activityIndex.error : null) ??
      taskContexts.error,
    hostId,
    refetch,
    fetchNextPage,
    // Pagination follows the plain cloud query; id-fetched local matches are
    // complete per query (not paginated). Keep the guard so "Show more"
    // cannot fetch against a stale request during debouncing / placeholder
    // handoff.
    hasNextPage:
      hasNextPage && !isQueryDebouncing && !tasksQuery.isPlaceholderData,
    isFetchingNextPage,
  };
}

export interface HistoryFetchResult {
  items: ReadonlyArray<HistoryItem>;
  availableRepos: ReadonlyArray<string>;
  availableWorkspaces: ReadonlyArray<HistoryWorkspaceRef>;
  totalCount: number;
  facets: HistoryFacets;
  worktreesByEpicId: ReadonlyMap<string, readonly WorktreeHostEntryV12[]>;
}

export interface HistoryFacets {
  readonly repos: ReadonlyArray<HistoryRepoFacet>;
  readonly workspaces: ReadonlyArray<HistoryWorkspaceFacet>;
  readonly ownershipScopes: ReadonlyArray<HistoryOwnershipFacet>;
}

export interface HistoryRepoFacet {
  readonly label: string;
  readonly count: number;
}

export interface HistoryWorkspaceFacet {
  readonly workspace: HistoryWorkspaceRef;
  readonly count: number;
}

export interface HistoryOwnershipFacet {
  readonly value: HistoryOwnershipScope;
  readonly count: number;
}

const EMPTY_FACETS: HistoryFacets = {
  repos: [],
  workspaces: [],
  ownershipScopes: [],
};

function mapHistoryFacets(
  facets: NonNullable<ListTasksResponse["facets"]> | undefined,
): HistoryFacets {
  if (facets === undefined) return EMPTY_FACETS;
  return {
    repos: facets.repos.map((facet) => ({
      label: `${facet.repoIdentifier.owner}/${facet.repoIdentifier.repo}`,
      count: facet.count,
    })),
    workspaces: facets.workspaces.map((facet) => ({
      workspace: facet.workspaceIdentifier,
      count: facet.count,
    })),
    ownershipScopes: facets.ownershipScopes,
  };
}

function settledHistoryItems(
  items: ReadonlyArray<HistoryItem>,
  contextExtrasCount: number,
  sort: HistorySortOption,
  query: string,
): ReadonlyArray<HistoryItem> {
  if (contextExtrasCount > 0) {
    return sortProjectedHistoryItems(items, sort, query);
  }
  return prioritizePinnedHistoryItems(items);
}

function projectHistoryItems(
  items: ReadonlyArray<HistoryItem>,
  search: HistorySearchState,
): ReadonlyArray<HistoryItem> {
  const filtered = filterHistoryItemsLocally(items, search);
  const query = search.query.trim();
  const searched =
    query.length === 0
      ? filtered
      : new Fuse(filtered, LOCAL_FUSE_OPTIONS)
          .search(query)
          .map((result) => result.item);
  return sortProjectedHistoryItems(searched, search.sort, query);
}

function filterHistoryItemsLocally(
  items: ReadonlyArray<HistoryItem>,
  search: HistorySearchState,
): ReadonlyArray<HistoryItem> {
  return filterHistoryItems(items, {
    repoNames: search.repos,
    repoMatchMode: search.repoMode,
    workspaces: search.workspaces,
    workspaceMatchMode: search.workspaceMode,
    ownershipScopes: search.ownershipScopes,
  });
}

function collectHistoryWorkspaces(
  items: ReadonlyArray<HistoryItem>,
): ReadonlyArray<HistoryWorkspaceRef> {
  return dedupSortWorkspaces(...items.map((item) => item.linkedWorkspaces));
}

function sortProjectedHistoryItems(
  items: ReadonlyArray<HistoryItem>,
  sort: HistorySortOption,
  query: string,
): ReadonlyArray<HistoryItem> {
  if ((sort === "relevance" && query.length > 0) || sort === "last-viewed") {
    return prioritizePinnedHistoryItems(items);
  }
  return sortHistoryItems(items, sort);
}
