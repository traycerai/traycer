import type {
  BotConversationSearchHit,
  BotConversationSearchResponse,
} from "@traycer/protocol/host/bot/conversation-schemas";

/** Three bots, as the host names them. */
export const SEARCH_BOT_A = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const SEARCH_BOT_B = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAW";
export const SEARCH_BOT_C = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAX";

/** A post of `SEARCH_BOT_A`'s channel, overridden per case. */
export function searchHit(
  overrides: Partial<BotConversationSearchHit>,
): BotConversationSearchHit {
  return {
    botId: SEARCH_BOT_A,
    conversationId: "conversation-a",
    threadId: null,
    messageId: "post-1",
    senderUserId: "user-teammate",
    rowKind: "post",
    createdAt: 1_000,
    snippet: { text: "ship the release today", highlights: [] },
    replyCount: null,
    threadExcerpt: null,
    score: 1,
    ...overrides,
  };
}

/** A complete answer with no more pages, overridden per case. */
export function searchResponse(
  overrides: Partial<BotConversationSearchResponse>,
): BotConversationSearchResponse {
  return {
    hits: [],
    nextCursor: null,
    indexState: "complete",
    total: null,
    unreachable: [],
    ...overrides,
  };
}
