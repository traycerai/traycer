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
  sortHistoryItems,
} from "@/components/home/data/home-page.data";
import { useCloudEpicTasksQuery } from "@/hooks/epics/use-cloud-epic-tasks-query";
import { useDebouncedValue } from "@/hooks/ui/use-debounced-value";
import {
  listCloudTasksRequestForHistorySearch,
  type ListCloudTasksRequest,
} from "@/lib/cloud-epic-tasks-query";
import type { ListTasksResponse } from "@traycer/protocol/host/epic/unary-schemas";
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

  const data = useMemo<HistoryFetchResult | undefined>(() => {
    if (tasksQuery.data === undefined) {
      return undefined;
    }
    const serverItems = buildHistoryItemsFromTasks(tasks, nowMs, currentUserId);
    const items = shouldProjectLocally
      ? projectHistoryItems(serverItems, params.search)
      : serverItems;
    const canUseServerFacets =
      !isQueryDebouncing && !tasksQuery.isPlaceholderData;
    const facets = canUseServerFacets
      ? mapHistoryFacets(tasksQuery.data.facets)
      : EMPTY_FACETS;
    const availableWorkspaces =
      facets.workspaces.length > 0
        ? facets.workspaces.map((workspace) => workspace.workspace)
        : collectHistoryWorkspaces(serverItems);
    return {
      items,
      availableRepos:
        facets.repos.length > 0
          ? facets.repos.map((repo) => repo.label)
          : collectHistoryRepos(serverItems),
      availableWorkspaces,
      totalCount: items.length,
      facets,
    };
  }, [
    currentUserId,
    isQueryDebouncing,
    nowMs,
    params.search,
    shouldProjectLocally,
    tasks,
    tasksQuery.data,
    tasksQuery.isPlaceholderData,
  ]);

  const refetch = useCallback(() => tasksQueryRefetch(), [tasksQueryRefetch]);

  return {
    data,
    isPending: tasksQuery.isPending,
    isFetching: tasksQuery.isFetching || isQueryDebouncing,
    error: tasksQuery.error instanceof Error ? tasksQuery.error : null,
    hostId,
    refetch,
    fetchNextPage,
    hasNextPage: hasNextPage && !shouldProjectLocally,
    isFetchingNextPage,
  };
}

export interface HistoryFetchResult {
  items: ReadonlyArray<HistoryItem>;
  availableRepos: ReadonlyArray<string>;
  availableWorkspaces: ReadonlyArray<HistoryWorkspaceRef>;
  totalCount: number;
  facets: HistoryFacets;
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
  if (sort === "relevance" && query.length > 0) return items;
  return sortHistoryItems(items, sort);
}
