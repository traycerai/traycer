/**
 * Message hits from `chat.search` for a surface that already has a query box
 * and a host - the sidebar's agent filter, History's task search - rather than
 * a search UI of its own.
 *
 * Everything between the typed query and the rows is here: the trim and cap,
 * the debounce, the two-character body-search gate, the host gate, paging, and
 * the request's fixed fields. A surface passes its query, its host and its
 * scope, and renders {@link ChatSearchMessageHitList} with what comes back.
 *
 * What it deliberately does NOT do is offer filters. The dialog
 * (`chat-search-panel.tsx`) keeps its own request building because it has the
 * whose-words and date filters this hook fixes; the two share the host gate
 * ({@link useChatSearchHost}) and the row rendering, not the request.
 *
 * The chat-TITLE section of the answer is requested - `chat.search` answers
 * both sections in one round trip - and dropped. Every surface this serves
 * already lists titles above it (the sidebar tree, History's task list), so
 * showing them again would be the same result twice.
 */
import { useCallback, useMemo, useState } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  CHAT_SEARCH_MAX_QUERY_CHARS,
  type ChatSearchMessageMatch,
  type ChatSearchResponse,
} from "@traycer/protocol/host/chat-search/schemas";
import { useChatSearchHost } from "@/hooks/chats/use-chat-search-host";
import {
  useChatSearchResults,
  type ChatSearchBaseRequest,
  type ChatSearchPageError,
} from "@/hooks/chats/use-chat-search-query";
import { useDebouncedValue } from "@/hooks/ui/use-debounced-value";
import {
  CHAT_SEARCH_BODY_MIN_QUERY_CHARS,
  CHAT_SEARCH_DEBOUNCE_MS,
} from "@/lib/chat-search/chat-search-results";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * The scopes a surface can search in. `chat` is the dialog's own expansion
 * scope and is not one of these: a surface asks about a task or the account,
 * never about one chat.
 */
export type ChatSearchSurfaceScope =
  | { readonly kind: "current-task"; readonly epicId: string }
  | { readonly kind: "all-accessible-tasks" };

/**
 * How message hits read to a surface. `absent` is every way the question
 * cannot be asked - no query, too short, no scope, an unreachable host, a host
 * without the index - and it is one state on purpose: a surface renders
 * nothing for it, rather than an empty state that would claim the search ran.
 */
export type ChatSearchMessageHitsStatus =
  | { readonly kind: "absent" }
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly messages: ReadonlyArray<ChatSearchMessageMatch>;
      readonly indexState: ChatSearchResponse["indexState"];
      /**
       * The request these rows came back for, for a chat-scoped follow-up on
       * one of them - `ChatSearchExpandedRows` re-asks with `scope: chat` and
       * needs the query and filters the rows were ranked under. Exposed rather
       * than rebuilt by the surface: this hook owns the trim, the cap and the
       * debounce, so a caller reconstructing it would ask a question one
       * keystroke away from the one it is expanding.
       */
      readonly expansionBase: ChatSearchBaseRequest;
      /** Loads the next page; `null` when there is none left. */
      readonly showMore: (() => void) | null;
      readonly loadingMore: boolean;
      /** A page that failed after its retries; the rows before it stay. */
      readonly loadMoreError: ChatSearchPageError | null;
    };

const EMPTY_CURSORS: ReadonlyArray<string> = [];

interface Paging {
  /** The request the cursors were issued for; any other request starts over. */
  readonly key: string;
  readonly cursors: ReadonlyArray<string>;
}

const INITIAL_PAGING: Paging = { key: "", cursors: EMPTY_CURSORS };

export function useChatSearchMessageHits(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  /** Raw, as typed: the trim, cap and debounce are this hook's. */
  readonly query: string;
  /** `null` while the surface has no scope to search - absent, not empty. */
  readonly scope: ChatSearchSurfaceScope | null;
}): ChatSearchMessageHitsStatus {
  const { client, hostId, query, scope } = args;
  const { hostReachable, methodUnsupported } = useChatSearchHost(
    hostId,
    client,
  );
  // Capped at the protocol's limit as well: a pasted block past it would
  // otherwise make every request an invalid-argument error.
  const debouncedQuery = useDebouncedValue(
    query.trim().slice(0, CHAT_SEARCH_MAX_QUERY_CHARS),
    CHAT_SEARCH_DEBOUNCE_MS,
  );

  const base = useMemo<ChatSearchBaseRequest | null>(() => {
    if (
      scope === null ||
      debouncedQuery.length < CHAT_SEARCH_BODY_MIN_QUERY_CHARS ||
      !hostReachable ||
      methodUnsupported
    ) {
      return null;
    }
    return {
      query: debouncedQuery,
      scope,
      tiers: null,
      roleFilter: "any",
      dateRange: null,
      harness: null,
      mode: "ranked",
    };
  }, [debouncedQuery, hostReachable, methodUnsupported, scope]);
  // The host is part of the request's identity: a cursor is the answering
  // host's, so a host switch under an unchanged query must reset paging.
  const baseKey = base === null ? "" : JSON.stringify([hostId, base]);

  const [paging, setPaging] = useState<Paging>(INITIAL_PAGING);
  const cursors = paging.key === baseKey ? paging.cursors : EMPTY_CURSORS;

  // Functional, against the key the cursor was shown under: a press that lands
  // after the request moved on starts the new request's paging, never appends
  // a stale cursor to it.
  const appendCursor = useCallback(
    (cursor: string) =>
      setPaging((previous) => ({
        key: baseKey,
        cursors:
          previous.key === baseKey ? [...previous.cursors, cursor] : [cursor],
      })),
    [baseKey],
  );

  const status = useChatSearchResults({
    client,
    base,
    chatCursors: EMPTY_CURSORS,
    messageCursors: cursors,
  });
  const nextCursor =
    status.kind === "ready" ? status.results.messageNextCursor : null;
  const showMore = useCallback(() => {
    if (nextCursor !== null) appendCursor(nextCursor);
  }, [appendCursor, nextCursor]);

  return useMemo<ChatSearchMessageHitsStatus>(() => {
    switch (status.kind) {
      // No request in flight, and a host that answered `E_HOST_UNSUPPORTED` is
      // the same degrade as one the handshake already ruled out.
      case "idle":
      case "unsupported":
        return { kind: "absent" };
      case "loading":
        return { kind: "loading" };
      case "error":
        return { kind: "error", message: status.message };
      case "ready": {
        // A `ready` status is the answer to a request, so there is one to
        // report. Narrowing rather than asserting keeps the unreachable arm
        // honest: with no request there are no rows to expand either.
        if (base === null) return { kind: "absent" };
        return {
          kind: "ready",
          messages: status.results.messageMatches,
          indexState: status.results.indexState,
          expansionBase: base,
          showMore: nextCursor === null ? null : showMore,
          loadingMore: status.loadingMore,
          // Only the message section is paged here, so a load-more failure can
          // only be its own.
          loadMoreError: status.loadMoreError,
        };
      }
    }
  }, [base, nextCursor, showMore, status]);
}
