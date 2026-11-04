import { useCallback, useMemo } from "react";
import {
  infiniteQueryOptions,
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useBotListQuery } from "@/hooks/bots/use-bot-list-query";
import { useConnectableHostIds } from "@/hooks/host/use-connectable-host-ids";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useDebouncedValue } from "@/hooks/ui/use-debounced-value";
import {
  BOT_SEARCH_PAGE_SIZE,
  botSearchBaseRequest,
  botSearchFirstSource,
  botSearchableQuery,
  fetchBotSearchPage,
  type BotSearchPage,
  type BotSearchSource,
} from "@/lib/bots/bot-search-model";
import { CHAT_SEARCH_DEBOUNCE_MS } from "@/lib/chat-search/chat-search-results";
import { useHostBinding } from "@/lib/host";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import { hostQueryKeys } from "@/lib/query-keys";
import { useBotSearchStore } from "@/stores/bots/bot-search-store";

const METHOD = "bot.conversation.search";

/** What the panel draws of the search in the store. */
export interface BotConversationSearchResults {
  /** The query the results below answer; `null` while it is too short. */
  readonly query: string | null;
  readonly pages:
    | InfiniteData<BotSearchPage, ReadonlyArray<BotSearchSource>>
    | undefined;
  readonly error: HostRpcError | null;
  readonly loading: boolean;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly loadMore: () => void;
  readonly retry: () => void;
}

/**
 * The store's search as the host answers it, paged by each host's cursor, for
 * the panel and the links back to it, which read the same pages. A new query
 * waits out the keystrokes after it, as Search chats does.
 *
 * It starts at the bot's own host where this client reaches one, and at the
 * tab's otherwise; `fetchBotSearchPage` says what happens from there.
 */
export function useBotConversationSearch(): BotConversationSearchResults {
  const client = useTabHostClient();
  const binding = useHostBinding();
  const readiness = useReactiveHostReadiness(client);
  const typed = useBotSearchStore((state) => state.query);
  const scope = useBotSearchStore((state) => state.scope);
  const filters = useBotSearchStore((state) => state.filters);
  const debounced = useDebouncedValue(typed, CHAT_SEARCH_DEBOUNCE_MS);
  const query = botSearchableQuery(debounced);
  const bots = useBotListQuery(client, true).data?.bots;
  const connectable = useConnectableHostIds();
  const reachableHostOf = useCallback(
    (botId: string): string | null => {
      const hostId =
        bots?.find((bot) => bot.botId === botId)?.boundHostId ?? null;
      return hostId !== null && connectable.hostIds.includes(hostId)
        ? hostId
        : null;
    },
    [bots, connectable.hostIds],
  );
  // Local midnights: the same base request through the day.
  const base = useMemo(
    () =>
      query === null
        ? null
        : botSearchBaseRequest(query, scope, filters, new Date()),
    [filters, query, scope],
  );
  const fetchPage = ({
    pageParam,
  }: {
    readonly pageParam: ReadonlyArray<BotSearchSource>;
  }): Promise<BotSearchPage> =>
    withHostQueryErrorBoundary(METHOD, () =>
      fetchBotSearchPage({
        sources: pageParam,
        sort: filters.sort,
        reachableHostOf,
        ask: (source) => {
          const asked =
            source.hostId === null
              ? client
              : resolveNamedHostClient(binding, source.hostId);
          if (asked === null || base === null) {
            return Promise.reject(hostClientUnavailableError(METHOD));
          }
          return asked.request(METHOD, {
            ...base,
            scope: source.scope,
            cursor: source.cursor,
            limit: BOT_SEARCH_PAGE_SIZE,
          });
        },
      }),
    );
  const queryClient = useQueryClient();
  const queryKey = [
    ...hostQueryKeys.methodScope(readiness.hostId, METHOD),
    base,
  ];
  const results = useInfiniteQuery(
    infiniteQueryOptions<
      BotSearchPage,
      HostRpcError,
      InfiniteData<BotSearchPage, ReadonlyArray<BotSearchSource>>,
      readonly unknown[],
      ReadonlyArray<BotSearchSource>
    >({
      queryKey,
      queryFn: fetchPage,
      initialPageParam: [botSearchFirstSource(scope, reachableHostOf)],
      getNextPageParam: (lastPage) =>
        lastPage.next.length === 0 ? undefined : lastPage.next,
      enabled: base !== null && client !== null && readiness.isReady,
      refetchOnWindowFocus: false,
      // A refused request is refused again, and a host without the index stays so.
      retry: (failureCount, error) =>
        error.code !== "E_HOST_UNSUPPORTED" &&
        error.code !== "E_INVALID_ARGUMENT" &&
        failureCount < 2,
      staleTime: 30_000,
    }),
  );
  const { fetchNextPage, refetch } = results;
  // A later page is refused once its host no longer holds the search, after a
  // restart or a long pause: the search starts again from its first page.
  const loadMore = async (): Promise<void> => {
    const next = await fetchNextPage();
    if (next.error?.code === "E_INVALID_ARGUMENT") {
      await queryClient.resetQueries({ queryKey, exact: true });
    }
  };
  return {
    query,
    pages: results.data,
    error: results.error,
    loading: base !== null && results.isPending,
    hasMore: results.hasNextPage,
    loadingMore: results.isFetchingNextPage,
    loadMore: () => void loadMore(),
    retry: () => void refetch(),
  };
}
