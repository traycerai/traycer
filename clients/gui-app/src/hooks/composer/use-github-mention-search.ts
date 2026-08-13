import { useCallback, useMemo } from "react";
import type { QueryKey } from "@tanstack/react-query";

import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mentionGithubSearchRequestSchema } from "@traycer/protocol/host/mention-schemas";
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
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { queryKeys } from "@/lib/query-keys";
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
  /**
   * The requested search itself FAILED - retries exhausted, no response at
   * all. Not a degraded answer (`sourceStatus` reports those): a rejection
   * carries no rows, so without this a failed remote search reads exactly
   * like "settled, no extra hits", and the zero-match dismissal closes the
   * picker over rows the search never saw. The same fact the catalog read
   * reports for its lane, gated on `wanted` like every projected field - a
   * disabled observer can still HOLD an error from when it was live.
   */
  readonly errored: boolean;
  /**
   * Re-runs the live search, for the section's refresh button.
   *
   * The button is one control over a list that is two reads merged, so
   * refreshing the catalog alone leaves a typed query's rows - and this
   * observer's own `sourceStatus` and `notice` - exactly as they were. A user
   * who hits Refresh because the section says `gh` is unavailable would watch
   * that message survive the refresh that was supposed to clear it.
   *
   * No-ops when this observer is disabled, for the same reason every projected
   * field is gated on `wanted`: with the query cleared and the default filter
   * back, the catalog owns the list and a search here would be a GitHub call
   * for rows the section is not showing.
   */
  readonly refresh: () => Promise<void>;
}

export function useGithubMentionSearch(
  params: UseGithubMentionSearchParams,
): GithubMentionSearchResult {
  const { client, scope, section, debouncedQuery, filter, enabled } = params;
  const readiness = useReactiveHostReadiness(client);

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

  // The LANE this observer's answer belongs to - host, epic, roots, section -
  // and deliberately nothing else. `query` and `filter` are the axes the
  // previous answer is held ACROSS: they are what the user is changing while
  // the next one lands, and the merged list corrects for both one layer up
  // (the funnel re-filters, the ranker re-ranks against the new query).
  //
  // The scope terms are the ones nothing downstream can correct. Held across
  // a host, epic or roots change, the previous scope's rows are merged into
  // the new one and stay SELECTABLE, so the user can commit a mention naming
  // a pull request the current scope cannot resolve - the same rule the
  // catalog read already applies to its own placeholder.
  const lane = useMemo(
    () =>
      searchLane(
        queryKeys.hostMethodScope(readiness.hostId, "mention.githubSearch"),
        request,
      ),
    [readiness.hostId, request],
  );

  const searchQuery = useHostQuery<HostRpcRegistry, "mention.githubSearch">({
    client,
    method: "mention.githubSearch",
    params: request,
    cacheKeyIdentity: undefined,
    options: {
      enabled: wanted,
      staleTime: SEARCH_STALE_TIME_MS,
      // `keepPreviousData` narrowed to one lane, rather than `keepPreviousData`
      // itself, which keeps whatever the observer answered last regardless of
      // which question it was.
      placeholderData: (previous, previousQuery) =>
        previousQuery !== undefined &&
        searchLaneOfKey(previousQuery.queryKey) === lane
          ? previous
          : undefined,
    },
  });

  // Every field is gated on `wanted`, not just the rows. The observer is
  // disabled - not discarded - when the query is cleared or the default filter
  // comes back, and `keepPreviousData` keeps its last response readable. Left
  // ungated, a `gh-unavailable` status or a rate-limit notice from a search
  // that is no longer running would keep its banner on the section chrome with
  // nothing behind it.
  const answer = wanted ? searchQuery.data : undefined;
  const { refetch } = searchQuery;
  const refresh = useCallback(
    () => (wanted ? refetch().then(() => undefined) : Promise.resolve()),
    [refetch, wanted],
  );
  return {
    rows: answer?.rows ?? EMPTY_ROWS,
    sourceStatus: answer?.sourceStatus ?? null,
    notice: answer?.notice ?? null,
    isSearching: wanted && searchQuery.isFetching,
    errored: wanted && searchQuery.isError,
    refresh,
  };
}

/**
 * The scope lane a `mention.githubSearch` cache entry belongs to.
 *
 * `prefix` is whatever precedes the request in the key (`["host", hostId,
 * method]`), so the two sides of the placeholder comparison never have to
 * agree on where the host id sits - both build the lane the same way, from
 * the same two ingredients.
 */
function searchLane(
  prefix: ReadonlyArray<unknown>,
  request: MentionGithubSearchRequest,
): string {
  return JSON.stringify([
    prefix,
    request.section,
    request.epicId,
    request.workspacePaths,
  ]);
}

/**
 * The lane of an EXISTING key, read back out of it.
 *
 * Fails closed: a key whose last element is not a search request - a
 * `cacheKeyIdentity` appended later, say - yields a string the current lane
 * cannot match, so the placeholder is dropped rather than accepted across a
 * boundary this function could not read. That costs the anti-flicker hold,
 * never correctness.
 */
function searchLaneOfKey(key: QueryKey): string {
  const parsed = mentionGithubSearchRequestSchema.safeParse(key.at(-1));
  if (!parsed.success) return JSON.stringify({ unreadableKey: key });
  return searchLane(key.slice(0, -1), parsed.data);
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
    // Sorted for the same reason the catalog hook canonicalizes: the request
    // is what the query key hashes, and an order-only change in the same
    // folder set must not fork the search cache into a second slot.
    workspacePaths: [...scope.workspacePaths].toSorted(),
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
