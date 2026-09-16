import { z } from "zod";

/**
 * Host <-> client wire shapes for `chat.search`: full-text search over the
 * chats whose transcripts live on this host.
 *
 * ## Two sections, and why the split is structural
 *
 * `chatMatches` holds chats whose TITLE matches; `messageMatches` holds chats
 * whose message text matches. The client draws the divider between them from
 * the structure rather than inferring it, and a chat never appears in both: a
 * title match carries `messageMatchCount` instead of being repeated below.
 *
 * ## Owner rows only
 *
 * Every result is a chat the requester owns. A host whose index holds no chat
 * for the requester answers the same empty page whether it holds nobody's
 * chats or only someone else's.
 *
 * ## Expanding a chat is a second request
 *
 * A message match carries its best row. The rows of one chat are fetched with
 * `scope: { kind: "chat" }`, which answers no title section and a single
 * message group whose `messages` pages by `messageCursor`. In the other scopes
 * `messages` is empty and `messageCursor` pages groups.
 *
 * Offsets are UTF-16 code-unit ranges into the string they accompany, the
 * indexing a renderer's `String.prototype.slice` uses.
 */

/** The kind of text a message document holds; each is a separate document. */
export const chatSearchTierSchema = z.enum([
  "user",
  "assistant",
  "notice",
  "card",
]);
export type ChatSearchTier = z.infer<typeof chatSearchTierSchema>;

export const chatSearchScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("current-task"), epicId: z.string().min(1) }),
  z.object({ kind: z.literal("all-accessible-tasks") }),
  /** One chat's message rows: the expansion of a message or title match. */
  z.object({
    kind: z.literal("chat"),
    epicId: z.string().min(1),
    chatId: z.string().min(1),
  }),
]);
export type ChatSearchScope = z.infer<typeof chatSearchScopeSchema>;

/**
 * Who wrote a `user`-tier document. `human` is text a person typed, `agent`
 * is a message another agent sent into the chat. Other tiers are unaffected.
 */
export const chatSearchRoleFilterSchema = z.enum(["any", "human", "agent"]);
export type ChatSearchRoleFilter = z.infer<typeof chatSearchRoleFilterSchema>;

/**
 * `ranked` matches words (the last one as a prefix) and orders by relevance
 * and recency. `substring` matches the literal query anywhere in the text and
 * orders by recency.
 *
 * `substring` scans text rather than an index, so it is served only for the
 * `current-task` and `chat` scopes. With `all-accessible-tasks` the host
 * answers `E_INVALID_ARGUMENT` - the scan over every task's text exceeds the
 * host's event-loop stall budget.
 */
export const chatSearchModeSchema = z.enum(["ranked", "substring"]);
export type ChatSearchMode = z.infer<typeof chatSearchModeSchema>;

/** Epoch-ms bounds, inclusive; `null` leaves that side open. */
export const chatSearchDateRangeSchema = z.object({
  from: z.number().int().nullable(),
  to: z.number().int().nullable(),
});
export type ChatSearchDateRange = z.infer<typeof chatSearchDateRangeSchema>;

export const CHAT_SEARCH_MAX_QUERY_CHARS = 512;
export const CHAT_SEARCH_MAX_PAGE_SIZE = 100;

const pageSizeSchema = z.number().int().min(1).max(CHAT_SEARCH_MAX_PAGE_SIZE);
/** Opaque; pass back the `nextCursor` of the previous page, `null` to start. */
const cursorSchema = z.string().max(64).nullable();

export const chatSearchRequestSchema = z.object({
  query: z.string().max(CHAT_SEARCH_MAX_QUERY_CHARS),
  scope: chatSearchScopeSchema,
  /**
   * Tiers to search. `null` is the default corpus (`user`, `assistant`,
   * `notice`); `card` text is searched only when named.
   */
  tiers: z.array(chatSearchTierSchema).min(1).nullable(),
  roleFilter: chatSearchRoleFilterSchema,
  /** Messages by `createdAt`; title matches by the chat's `updatedAt`. */
  dateRange: chatSearchDateRangeSchema.nullable(),
  /** A harness id; `null` searches chats of every harness. */
  harness: z.string().min(1).nullable(),
  mode: chatSearchModeSchema,
  chatCursor: cursorSchema,
  chatLimit: pageSizeSchema,
  messageCursor: cursorSchema,
  messageLimit: pageSizeSchema,
});
export type ChatSearchRequest = z.infer<typeof chatSearchRequestSchema>;

export const chatSearchRangeSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});
export type ChatSearchRange = z.infer<typeof chatSearchRangeSchema>;

export const chatSearchSnippetSchema = z.object({
  text: z.string(),
  highlights: z.array(chatSearchRangeSchema),
});
export type ChatSearchSnippet = z.infer<typeof chatSearchSnippetSchema>;

/** Deleted chats are never results. */
export const chatSearchLifecycleStateSchema = z.enum(["active", "archived"]);

/** The chat a group belongs to; `(epicId, ownerUserId, chatId)` is its key. */
const chatSearchChatFields = {
  epicId: z.string(),
  ownerUserId: z.string(),
  chatId: z.string(),
  title: z.string(),
  lifecycleState: chatSearchLifecycleStateSchema,
  updatedAt: z.number(),
};

export const chatSearchMessageHitSchema = z.object({
  messageId: z.string(),
  tier: chatSearchTierSchema,
  createdAt: z.number(),
  /** A `user` document sent by another agent. */
  interAgent: z.boolean(),
  /** The document was cut at the index's size cap; later text is unsearched. */
  truncated: z.boolean(),
  snippet: chatSearchSnippetSchema,
});
export type ChatSearchMessageHit = z.infer<typeof chatSearchMessageHitSchema>;

export const chatSearchChatMatchSchema = z.object({
  ...chatSearchChatFields,
  titleHighlights: z.array(chatSearchRangeSchema),
  /** Message documents in this chat that also match. */
  messageMatchCount: z.number().int().nonnegative(),
});
export type ChatSearchChatMatch = z.infer<typeof chatSearchChatMatchSchema>;

export const chatSearchMessageMatchSchema = z.object({
  ...chatSearchChatFields,
  /** At least one: `best` is one of them. */
  matchCount: z.number().int().positive(),
  best: chatSearchMessageHitSchema,
  /** A page of this chat's matching rows under `scope: chat`; else empty. */
  messages: z.array(chatSearchMessageHitSchema),
});
export type ChatSearchMessageMatch = z.infer<
  typeof chatSearchMessageMatchSchema
>;

export const chatSearchResponseSchema = z.object({
  chatMatches: z.array(chatSearchChatMatchSchema),
  /** Bounded like the request cursors: a page's cursor is the next request's. */
  chatNextCursor: cursorSchema,
  messageMatches: z.array(chatSearchMessageMatchSchema),
  messageNextCursor: cursorSchema,
  /**
   * `partial` while the host's index has not yet caught up with every chat,
   * so a missing result may still appear.
   */
  indexState: z.enum(["complete", "partial"]),
});
export type ChatSearchResponse = z.infer<typeof chatSearchResponseSchema>;
