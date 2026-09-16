import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ChatSearchMessageHit,
  ChatSearchRequest,
  ChatSearchResponse,
} from "@traycer/protocol/host/chat-search/schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import {
  CHAT_SEARCH_CHAT_PAGE_SIZE,
  CHAT_SEARCH_EXPANSION_PAGE_SIZE,
  CHAT_SEARCH_MESSAGE_PAGE_SIZE,
  mergeChatSearchExpansionPages,
  mergeChatSearchPages,
  type ChatSearchMergedResults,
} from "@/lib/chat-search/chat-search-results";

/** Everything a search request carries except the per-section paging. */
export type ChatSearchBaseRequest = Omit<
  ChatSearchRequest,
  "chatCursor" | "chatLimit" | "messageCursor" | "messageLimit"
>;

/**
 * How a search outcome reads to the dialog. `unsupported` is a host without a
 * search index - an expected degrade, rendered as a disabled surface rather
 * than an error.
 */
export type ChatSearchStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly results: ChatSearchMergedResults;
      /** A show-more page is in flight. */
      readonly loadingMore: boolean;
      /**
       * A show-more page that failed after its retries. The pages before it
       * stay on screen; `retry` refetches just that page.
       */
      readonly loadMoreError: ChatSearchLoadMoreError | null;
    };

export interface ChatSearchLoadMoreError {
  readonly section: "chats" | "messages";
  readonly message: string;
  readonly retry: () => void;
}

const SEARCH_QUERY_OPTIONS = {
  // Neither refusal is transient: `E_HOST_UNSUPPORTED` is a host without the
  // index, `E_INVALID_ARGUMENT` a request the host will refuse again.
  retry: (failureCount: number, error: HostRpcError) =>
    error.code !== "E_HOST_UNSUPPORTED" &&
    error.code !== "E_INVALID_ARGUMENT" &&
    failureCount < 2,
  // No placeholderData: the status carries no request identity, so a held
  // previous answer would read as THIS request's results, and a row from the
  // old query could be opened under the new one. Between two debounced
  // keystrokes the list shows loading instead.
  staleTime: 30_000,
} as const;

function statusOf(
  results: ReadonlyArray<UseQueryResult<ChatSearchResponse, HostRpcError>>,
): Exclude<ChatSearchStatus, { readonly kind: "idle" | "ready" }> | null {
  const failed = results.find((result) => result.isError);
  if (failed !== undefined) {
    return failed.error.code === "E_HOST_UNSUPPORTED"
      ? { kind: "unsupported" }
      : { kind: "error", message: failed.error.message };
  }
  return null;
}

/**
 * The two-section search, with one extra request per "show more" press.
 *
 * `chatCursors` / `messageCursors` are the cursors the user has asked to load,
 * in order. Each becomes its own request, paging only its own section; the
 * pages fold through {@link mergeChatSearchPages}, which also keeps every chat
 * in one section only.
 */
export function useChatSearchResults(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  /** `null` sends nothing - an empty query or a host known to lack search. */
  readonly base: ChatSearchBaseRequest | null;
  readonly chatCursors: ReadonlyArray<string>;
  readonly messageCursors: ReadonlyArray<string>;
}): ChatSearchStatus {
  const { base, chatCursors, client, messageCursors } = args;
  const requests =
    base === null
      ? []
      : [
          {
            method: "chat.search" as const,
            params: {
              ...base,
              chatCursor: null,
              chatLimit: CHAT_SEARCH_CHAT_PAGE_SIZE,
              messageCursor: null,
              messageLimit: CHAT_SEARCH_MESSAGE_PAGE_SIZE,
            },
          },
          ...chatCursors.map((cursor) => ({
            method: "chat.search" as const,
            params: {
              ...base,
              chatCursor: cursor,
              chatLimit: CHAT_SEARCH_CHAT_PAGE_SIZE,
              // The message half of this answer is discarded; ask for as
              // little of it as the schema allows.
              messageCursor: null,
              messageLimit: 1,
            },
          })),
          ...messageCursors.map((cursor) => ({
            method: "chat.search" as const,
            params: {
              ...base,
              chatCursor: null,
              chatLimit: 1,
              messageCursor: cursor,
              messageLimit: CHAT_SEARCH_MESSAGE_PAGE_SIZE,
            },
          })),
        ];
  return useHostQueries<HostRpcRegistry, "chat.search", ChatSearchStatus>({
    client,
    requests,
    cacheKeyIdentity: undefined,
    options: SEARCH_QUERY_OPTIONS,
    combine: (results) => {
      if (base === null) return { kind: "idle" };
      const [first, ...rest] = results;
      // Only the first page decides the whole surface: a later page that
      // failed keeps what is already loaded and reports beside its section.
      const failure = statusOf([first]);
      if (failure !== null) return failure;
      if (first.data === undefined) return { kind: "loading" };
      const moreChats = rest.slice(0, chatCursors.length);
      const moreMessages = rest.slice(chatCursors.length);
      const failedIndex = rest.findIndex((result) => result.isError);
      const failed = failedIndex === -1 ? undefined : rest[failedIndex];
      return {
        kind: "ready",
        results: mergeChatSearchPages({
          first: first.data,
          moreChats: moreChats.map((result) => result.data),
          moreMessages: moreMessages.map((result) => result.data),
        }),
        loadingMore: rest.some(
          (result) => result.data === undefined && !result.isError,
        ),
        loadMoreError:
          failed === undefined || !failed.isError
            ? null
            : {
                section:
                  failedIndex < chatCursors.length ? "chats" : "messages",
                message: failed.error.message,
                retry: () => {
                  void failed.refetch();
                },
              },
      };
    },
  });
}

export type ChatSearchExpansionStatus =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly messages: ReadonlyArray<ChatSearchMessageHit>;
      readonly nextCursor: string | null;
      readonly loadingMore: boolean;
      /** A later page that failed; the rows before it stay. */
      readonly loadMoreError: ChatSearchPageError | null;
    };

export interface ChatSearchPageError {
  readonly message: string;
  /** Refetches only the failed page. */
  readonly retry: () => void;
}

/**
 * One chat's matching message rows, the expansion of a result group: the same
 * query under `scope: chat`, paged by `messageCursor`.
 */
export function useChatSearchMessageRows(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly base: ChatSearchBaseRequest;
  readonly epicId: string;
  readonly chatId: string;
  readonly cursors: ReadonlyArray<string>;
}): ChatSearchExpansionStatus {
  const { base, chatId, client, cursors, epicId } = args;
  const pageCursors: ReadonlyArray<string | null> = [null, ...cursors];
  return useHostQueries<
    HostRpcRegistry,
    "chat.search",
    ChatSearchExpansionStatus
  >({
    client,
    requests: pageCursors.map((cursor) => ({
      method: "chat.search" as const,
      params: {
        ...base,
        scope: { kind: "chat", epicId, chatId },
        // A chat scope answers no title section.
        chatCursor: null,
        chatLimit: 1,
        messageCursor: cursor,
        messageLimit: CHAT_SEARCH_EXPANSION_PAGE_SIZE,
      },
    })),
    cacheKeyIdentity: undefined,
    options: SEARCH_QUERY_OPTIONS,
    combine: (results) => {
      // `pageCursors` always holds the first page, so there is a result 0;
      // only it decides the whole expansion. A later page that failed keeps
      // the rows already loaded and reports beside them.
      const [first, ...rest] = results;
      const failure = statusOf([first]);
      if (failure !== null) {
        return failure.kind === "error"
          ? failure
          : { kind: "error", message: "Search is unavailable on this host." };
      }
      if (first.data === undefined) return { kind: "loading" };
      const merged = mergeChatSearchExpansionPages(
        results.map((result) => result.data),
      );
      const failedIndex = rest.findIndex((result) => result.isError);
      const failed = failedIndex === -1 ? undefined : rest[failedIndex];
      return {
        kind: "ready",
        messages: merged.messages,
        nextCursor: merged.nextCursor,
        loadingMore: rest.some(
          (result) => result.data === undefined && !result.isError,
        ),
        loadMoreError:
          failed === undefined || !failed.isError
            ? null
            : {
                message: failed.error.message,
                retry: () => {
                  void failed.refetch();
                },
              },
      };
    },
  });
}
