/**
 * The chat tile find's question to the host's search index: which OLDER,
 * unloaded messages of this chat contain the text (`chat-find-index.ts`).
 *
 * The History surfaces' `chat.search` read, narrowed to one chat: the same
 * host gate ({@link useChatSearchHost}), query options and page fold, with
 * `scope: chat`, `mode: substring` (the literal text, as the bar matches it,
 * not ranked words) and every tier including card text.
 *
 * ## Pages are on demand
 *
 * A chat-scoped `substring` page is three `LIKE` passes over the chat's
 * documents on the host's shared read pool, and `OFFSET` re-scans every
 * earlier match - measured at p95 143-201 ms a pass on the largest chat. So
 * one request goes out per settled query, for page 1, and a further page only
 * when the demand grows ({@link ChatFindIndexDemand.pages}), which the adapter
 * does when the reader steps back from the oldest stop it has. A query
 * that changes, or a bar that closes, drops the request's observer, and the
 * query layer aborts it.
 *
 * ## No date bound
 *
 * The request carries no `dateRange`, although one would spare the host the
 * hydrated tail's documents - the newest ones, which fill page 1 first and
 * come back only to be dropped as held. No bound the client can derive is
 * safe. The skeleton orders rows by a placement key, and a record's
 * timestamp can be LATER than that of a row sorting after it: a
 * notification-anchor row stamped mid-turn sorts after the whole turn, whose
 * rows sit at its start, and a turn adopted from a notification keeps the
 * notification's early position while its records carry the run's time. A
 * bound taken from the hydrated rows silently excluded those records. So the
 * held documents are read and dropped, and a page of nothing but held ones
 * is paged past on the reader's press like any other.
 */
import { useMemo, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  CHAT_SEARCH_MAX_PAGE_SIZE,
  CHAT_SEARCH_MAX_QUERY_CHARS,
  type ChatSearchResponse,
  type ChatSearchTier,
} from "@traycer/protocol/host/chat-search/schemas";
import {
  CHAT_FIND_INDEX_ABSENT,
  CHAT_FIND_INDEX_MAX_PAGES,
  type ChatFindIndexAnswer,
  type ChatFindIndexDemand,
  type ChatFindIndexHit,
  type ChatFindSearch,
} from "@/components/chat/chat-find-index";
import { useChatSearchHost } from "@/hooks/chats/use-chat-search-host";
import {
  CHAT_SEARCH_QUERY_OPTIONS,
  type ChatSearchBaseRequest,
} from "@/hooks/chats/use-chat-search-query";
import {
  useHostQueries,
  type HostRequestSpec,
} from "@/hooks/host/use-host-queries";
import {
  CHAT_SEARCH_BODY_MIN_QUERY_CHARS,
  mergeChatSearchExpansionPages,
} from "@/lib/chat-search/chat-search-results";
import type { HostRpcRegistry } from "@/lib/host";

/** Every tier the index holds: card text is where tool command lines live. */
const CHAT_FIND_INDEX_TIERS: ReadonlyArray<ChatSearchTier> = [
  "user",
  "assistant",
  "notice",
  "card",
];

type ChatFindIndexPages =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | {
      readonly kind: "ready";
      readonly hits: ReadonlyArray<ChatFindIndexHit>;
      readonly pagesRead: number;
      /** The last page's cursor, `null` when it is the last or in flight. */
      readonly nextCursor: string | null;
      readonly loadingMore: boolean;
    };

/**
 * Module scope, and plain data out: the query layer re-runs `combine` only
 * when a page changes and shares the result structurally, so an unchanged
 * answer keeps its identity across renders - which is what keeps the adapter
 * from rescanning the transcript on every streaming token.
 */
function combineChatFindIndexPages(
  results: Array<UseQueryResult<ChatSearchResponse, HostRpcError>>,
): ChatFindIndexPages {
  if (results.length === 0) return { kind: "idle" };
  // Refused, unsupported, or failed after its retries: every one degrades
  // find to the client scan alone. A later page failing drops the pages
  // before it too - rare, and the degrade is the honest reading.
  if (results.some((result) => result.isError)) return { kind: "failed" };
  if (results[0].data === undefined) return { kind: "loading" };
  const merged = mergeChatSearchExpansionPages(
    results.map((result) => result.data),
  );
  const pagesRead = results.filter(
    (result) => result.data !== undefined,
  ).length;
  return {
    kind: "ready",
    hits: merged.messages.map((hit) => ({
      messageId: hit.messageId,
      createdAt: hit.createdAt,
      snippet: hit.snippet.text,
    })),
    pagesRead,
    nextCursor: merged.nextCursor,
    loadingMore: pagesRead < results.length,
  };
}

interface IndexWalk {
  /** The request the cursors were issued for; any other starts over. */
  readonly key: string | null;
  readonly cursors: ReadonlyArray<string>;
}

const NO_CURSORS: ReadonlyArray<string> = [];
const NO_WALK: IndexWalk = { key: null, cursors: NO_CURSORS };

/**
 * The query to send, or `null` when the index cannot answer it: no search, no
 * host that serves `chat.search`, or a query outside the protocol's bounds -
 * past the cap the request fails validation outright.
 *
 * The host trims too; trimming here keeps a trailing space typed mid-word
 * from being a second request for the same answer. The bar's own matcher
 * re-checks the untrimmed query against every snippet.
 */
function askableIndexQuery(
  search: ChatFindSearch | null,
  hostServes: boolean,
): string | null {
  if (search === null || !hostServes) return null;
  const query = search.query.trim();
  return query.length >= CHAT_SEARCH_BODY_MIN_QUERY_CHARS &&
    query.length <= CHAT_SEARCH_MAX_QUERY_CHARS
    ? query
    : null;
}

/** Page 1, then one request per cursor the walk has taken. */
function indexPageRequests(
  base: ChatSearchBaseRequest,
  cursors: ReadonlyArray<string>,
): ReadonlyArray<HostRequestSpec<HostRpcRegistry, "chat.search">> {
  return [null, ...cursors].map((cursor) => ({
    method: "chat.search",
    params: {
      ...base,
      // A chat scope answers no title section.
      chatCursor: null,
      chatLimit: 1,
      messageCursor: cursor,
      messageLimit: CHAT_SEARCH_MAX_PAGE_SIZE,
    },
  }));
}

/**
 * The cursor to ask for next: only once the reader has asked past what is
 * loaded (`wantedPages`), the last page named one, and nothing is in flight.
 */
function nextIndexCursor(
  pages: ChatFindIndexPages,
  cursors: ReadonlyArray<string>,
  wantedPages: number,
): string | null {
  if (pages.kind !== "ready" || pages.loadingMore) return null;
  const cursor = pages.nextCursor;
  if (cursor === null || cursors.includes(cursor)) return null;
  return cursors.length + 1 < wantedPages ? cursor : null;
}

export function useChatFindIndexHits(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly epicId: string;
  readonly chatId: string;
  /** `null` while there is nothing to ask: no query, or nothing unhydrated. */
  readonly demand: ChatFindIndexDemand | null;
}): ChatFindIndexAnswer {
  const { chatId, client, demand, epicId, hostId } = args;
  const { hostReachable, methodUnsupported } = useChatSearchHost(
    hostId,
    client,
  );
  const search = demand === null ? null : demand.search;
  const query = askableIndexQuery(search, hostReachable && !methodUnsupported);
  const base = useMemo<ChatSearchBaseRequest | null>(
    () =>
      query === null
        ? null
        : {
            query,
            scope: { kind: "chat", epicId, chatId },
            tiers: [...CHAT_FIND_INDEX_TIERS],
            roleFilter: "any",
            // Deliberately unbounded; see "No date bound" above.
            dateRange: null,
            harness: null,
            mode: "substring",
          },
    [chatId, epicId, query],
  );

  // The host is part of the walk's identity: a cursor is the answering host's.
  const walkKey = base === null ? null : JSON.stringify([hostId, base]);
  const [walk, setWalk] = useState<IndexWalk>(NO_WALK);
  const cursors = walk.key === walkKey ? walk.cursors : NO_CURSORS;
  const pages = useHostQueries<
    HostRpcRegistry,
    "chat.search",
    ChatFindIndexPages
  >({
    client,
    requests: base === null ? [] : indexPageRequests(base, cursors),
    cacheKeyIdentity: undefined,
    options: CHAT_SEARCH_QUERY_OPTIONS,
    combine: combineChatFindIndexPages,
  });
  // React's "adjust state during render" idiom: the walk settles in one
  // extra pass.
  const next = nextIndexCursor(
    pages,
    cursors,
    Math.min(demand === null ? 1 : demand.pages, CHAT_FIND_INDEX_MAX_PAGES),
  );
  if (next !== null) setWalk({ key: walkKey, cursors: [...cursors, next] });

  return useMemo<ChatFindIndexAnswer>(() => {
    if (search === null || pages.kind !== "ready") {
      return CHAT_FIND_INDEX_ABSENT;
    }
    return {
      kind: "ready",
      search,
      hits: pages.hits,
      pages: pages.pagesRead,
      more: pages.loadingMore || pages.nextCursor !== null,
      loadingMore: pages.loadingMore,
    };
  }, [pages, search]);
}
