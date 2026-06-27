import { z } from "zod";
import type {
  HistoryMatchMode,
  HistoryOwnershipScope,
  HistorySortOption,
  HistoryWorkspaceRef,
} from "@/components/home/data/home-page.data";
import { dedupSortWorkspaces } from "@/components/home/data/home-page.data";
import { appLogger, describeLogError } from "@/lib/logger";

const historyMatchModeSchema = z.enum(["any", "all"]);
const historyOwnershipSchema = z.enum(["mine", "shared"]);
const historySortSchema = z.enum([
  "recent",
  "oldest",
  "title-asc",
  "title-desc",
  "relevance",
]);

export const historySearchParamsSchema = z.object({
  historyQuery: z.string().optional(),
  historyRepos: z.union([z.string(), z.array(z.string())]).optional(),
  historyRepoMode: historyMatchModeSchema.optional(),
  historyWorkspaces: z.union([z.string(), z.array(z.string())]).optional(),
  historyWorkspaceMode: historyMatchModeSchema.optional(),
  historyOwnership: z
    .union([historyOwnershipSchema, z.array(historyOwnershipSchema)])
    .optional(),
  historySort: historySortSchema.optional(),
});

export interface HistorySearchState {
  readonly query: string;
  readonly repos: ReadonlyArray<string>;
  readonly repoMode: HistoryMatchMode;
  readonly workspaces: ReadonlyArray<HistoryWorkspaceRef>;
  readonly workspaceMode: HistoryMatchMode;
  readonly ownershipScopes: ReadonlyArray<HistoryOwnershipScope>;
  readonly sort: HistorySortOption;
  readonly sortExplicit: boolean;
}

export type HistorySearchPatch = Partial<
  Pick<
    HistorySearchState,
    | "query"
    | "repos"
    | "repoMode"
    | "workspaces"
    | "workspaceMode"
    | "ownershipScopes"
    | "sort"
  >
> & {
  readonly sortExplicit?: boolean;
};

export const DEFAULT_HISTORY_SEARCH: HistorySearchState = {
  query: "",
  repos: [],
  repoMode: "any",
  workspaces: [],
  workspaceMode: "any",
  ownershipScopes: [],
  sort: "recent",
  sortExplicit: false,
};

export function parseHistorySearch(
  raw: Record<string, unknown>,
): HistorySearchState {
  const parsed = historySearchParamsSchema.safeParse(raw);
  if (!parsed.success) return DEFAULT_HISTORY_SEARCH;
  const query = normalizeQuery(parsed.data.historyQuery);
  const sortExplicit = parsed.data.historySort !== undefined;
  return {
    query,
    repos: normalizeRepos(parsed.data.historyRepos),
    repoMode: parsed.data.historyRepoMode ?? DEFAULT_HISTORY_SEARCH.repoMode,
    workspaces: normalizeWorkspaces(parsed.data.historyWorkspaces),
    workspaceMode:
      parsed.data.historyWorkspaceMode ?? DEFAULT_HISTORY_SEARCH.workspaceMode,
    ownershipScopes: normalizeArray(parsed.data.historyOwnership),
    sort:
      parsed.data.historySort ??
      (query.trim().length > 0 ? "relevance" : DEFAULT_HISTORY_SEARCH.sort),
    sortExplicit,
  };
}

export function patchHistorySearch(
  current: HistorySearchState,
  patch: HistorySearchPatch,
): HistorySearchState {
  const query = patch.query ?? current.query;
  const sortExplicit = patch.sortExplicit ?? current.sortExplicit;
  const sort =
    patch.sort ?? implicitHistorySort(current.sort, query, sortExplicit);
  return {
    query,
    repos: patch.repos ?? current.repos,
    repoMode: patch.repoMode ?? current.repoMode,
    workspaces: patch.workspaces ?? current.workspaces,
    workspaceMode: patch.workspaceMode ?? current.workspaceMode,
    ownershipScopes: patch.ownershipScopes ?? current.ownershipScopes,
    sort,
    sortExplicit,
  };
}

export function historySearchToParams(
  state: HistorySearchState,
): Record<string, string | ReadonlyArray<string> | undefined> {
  return {
    historyQuery: state.query.length > 0 ? state.query : undefined,
    historyRepos: state.repos.length > 0 ? state.repos : undefined,
    historyRepoMode:
      state.repos.length > 1 &&
      state.repoMode !== DEFAULT_HISTORY_SEARCH.repoMode
        ? state.repoMode
        : undefined,
    historyWorkspaces:
      state.workspaces.length > 0
        ? state.workspaces.map(serializeWorkspaceParam)
        : undefined,
    historyWorkspaceMode:
      state.workspaces.length > 1 &&
      state.workspaceMode !== DEFAULT_HISTORY_SEARCH.workspaceMode
        ? state.workspaceMode
        : undefined,
    historyOwnership:
      state.ownershipScopes.length > 0 ? state.ownershipScopes : undefined,
    historySort:
      state.sortExplicit &&
      (state.sort !== DEFAULT_HISTORY_SEARCH.sort || state.query.length > 0)
        ? state.sort
        : undefined,
  };
}

export type HistorySearchParamKey =
  | "historyQuery"
  | "historyRepos"
  | "historyRepoMode"
  | "historyWorkspaces"
  | "historyWorkspaceMode"
  | "historyOwnership"
  | "historySort";

export type HistorySearchParamsCleared<TPrev> = Omit<
  TPrev,
  HistorySearchParamKey
>;

type HistorySearchParamRecord = Partial<Record<HistorySearchParamKey, unknown>>;

export function clearHistorySearchParams<
  TPrev extends HistorySearchParamRecord,
>(prev: TPrev): HistorySearchParamsCleared<TPrev> {
  const {
    historyQuery: _historyQuery,
    historyRepos: _historyRepos,
    historyRepoMode: _historyRepoMode,
    historyWorkspaces: _historyWorkspaces,
    historyWorkspaceMode: _historyWorkspaceMode,
    historyOwnership: _historyOwnership,
    historySort: _historySort,
    ...rest
  } = prev;
  return rest;
}

function normalizeQuery(value: string | undefined): string {
  return value ?? "";
}

function normalizeArray<T extends string>(
  value: T | T[] | undefined,
): ReadonlyArray<T> {
  if (value === undefined) return [];
  return Array.from(new Set(Array.isArray(value) ? value : [value]));
}

function normalizeRepos(
  value: string | string[] | undefined,
): ReadonlyArray<string> {
  return normalizeArray(value)
    .flatMap((repo) => {
      const trimmed = repo.trim();
      return trimmed.length > 0 ? [trimmed] : [];
    })
    .sort((left, right) => left.localeCompare(right));
}

function normalizeWorkspaces(
  value: string | string[] | undefined,
): ReadonlyArray<HistoryWorkspaceRef> {
  return dedupSortWorkspaces(
    normalizeArray(value).flatMap(parseWorkspaceParam),
  );
}

function serializeWorkspaceParam(workspace: HistoryWorkspaceRef): string {
  return `${encodeURIComponent(workspace.hostId)}:${encodeURIComponent(
    workspace.workspacePath,
  )}`;
}

function parseWorkspaceParam(value: string): HistoryWorkspaceRef[] {
  const separatorIndex = value.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) return [];
  try {
    const hostId = decodeURIComponent(value.slice(0, separatorIndex));
    const workspacePath = decodeURIComponent(value.slice(separatorIndex + 1));
    return hostId.length > 0 && workspacePath.length > 0
      ? [{ hostId, workspacePath }]
      : [];
  } catch (error) {
    appLogger.warn("[history-search] workspace parameter parse failed", {
      valueLength: value.length,
      error: describeLogError(error),
    });
    return [];
  }
}

function implicitHistorySort(
  currentSort: HistorySortOption,
  query: string,
  sortExplicit: boolean,
): HistorySortOption {
  if (sortExplicit) return currentSort;
  if (query.trim().length > 0) return "relevance";
  return DEFAULT_HISTORY_SEARCH.sort;
}
