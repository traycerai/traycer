import { useMemo } from "react";
import { keepPreviousData } from "@tanstack/react-query";

import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  GithubMentionRow,
  GithubMentionSection,
  MentionGithubSearchRequest,
} from "@traycer/protocol/host/mention-schemas";
import type {
  PrSourceNotice,
  PrSourceStatus,
} from "@traycer/protocol/host/pr-schemas";

import { useHostQuery } from "@/hooks/host/use-host-query";
import type { GithubMentionFilter } from "@/lib/composer/mentions/github-mention-rows";
import {
  asIssueMentionFilter,
  asPullRequestMentionFilter,
  isDefaultGithubMentionFilter,
} from "@/lib/composer/mentions/github-mention-rows";
import type { HostRpcRegistry } from "@/lib/host";

import type { GithubMentionScope } from "./use-github-mention-catalog";

/**
 * The section's live GitHub search.
 *
 * Two things route through here, not one. The obvious one is the user's typed
 * query. The other is a FILTER the cache cannot answer - `State: Merged`, say,
 * over a catalog that only ever swept open items: the search unary takes an
 * empty query plus the filter's qualifiers, which is the wire's fetch-through
 * path. Without that, selecting a non-default filter would silently show a
 * subset of the wrong list.
 *
 * Local results are never blocked on this. The rows the cache already holds
 * render immediately and this merges in behind them, so the only thing the
 * user waits for is the extra hits - covered by the appended `Searching GitHub…`
 * row rather than by a spinner over the whole list.
 */

const SEARCH_STALE_TIME_MS = 30_000;
const EMPTY_ROWS: ReadonlyArray<GithubMentionRow> = [];

export interface UseGithubMentionSearchParams {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly scope: GithubMentionScope;
  readonly section: GithubMentionSection;
  /** Already debounced by the caller (the picker's 250ms mention class). */
  readonly debouncedQuery: string;
  readonly filter: GithubMentionFilter;
  readonly enabled: boolean;
}

export interface GithubMentionSearchResult {
  readonly rows: ReadonlyArray<GithubMentionRow>;
  readonly sourceStatus: PrSourceStatus | null;
  readonly notice: PrSourceNotice | null;
  /** True while a remote search is in flight - the appended row's condition. */
  readonly isSearching: boolean;
}

export function useGithubMentionSearch(
  params: UseGithubMentionSearchParams,
): GithubMentionSearchResult {
  const { client, scope, section, debouncedQuery, filter, enabled } = params;

  const query = debouncedQuery.trim();
  // A default filter with no query is exactly what the catalog already
  // answers, so searching for it would be a second request for the same rows.
  const wanted =
    enabled &&
    scope.workspacePaths.length > 0 &&
    (query.length > 0 || !isDefaultGithubMentionFilter(section, filter));

  const request = useMemo<MentionGithubSearchRequest>(
    () => buildSearchRequest(scope, section, query, filter),
    [filter, query, scope, section],
  );

  const searchQuery = useHostQuery<HostRpcRegistry, "mention.githubSearch">({
    client,
    method: "mention.githubSearch",
    params: request,
    cacheKeyIdentity: undefined,
    options: {
      enabled: wanted,
      staleTime: SEARCH_STALE_TIME_MS,
      placeholderData: keepPreviousData,
    },
  });

  return {
    rows: wanted ? (searchQuery.data?.rows ?? EMPTY_ROWS) : EMPTY_ROWS,
    sourceStatus: searchQuery.data?.sourceStatus ?? null,
    notice: searchQuery.data?.notice ?? null,
    isSearching: wanted && searchQuery.isFetching,
  };
}

/**
 * The request is discriminated by `section`, and the two filter shapes are not
 * interchangeable (only PRs have `review-requested`; only issues have
 * `mentions`). Building it through this narrowing is what keeps a filter from
 * one section reaching the other's arm.
 */
function buildSearchRequest(
  scope: GithubMentionScope,
  section: GithubMentionSection,
  query: string,
  filter: GithubMentionFilter,
): MentionGithubSearchRequest {
  const base = {
    epicId: scope.epicId,
    workspacePaths: [...scope.workspacePaths],
    query,
  };
  if (section === "pull-requests") {
    return {
      ...base,
      section: "pull-requests",
      filter: asPullRequestMentionFilter(filter),
    };
  }
  return {
    ...base,
    section: "issues",
    filter: asIssueMentionFilter(filter),
  };
}
