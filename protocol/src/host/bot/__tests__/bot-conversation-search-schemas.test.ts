import { describe, expect, it } from "vitest";
import {
  SERVES_EVERY_INSTALLED_MAJOR,
  splitConnectionManifest,
  validateVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { botConversationSearchV10 } from "@traycer/protocol/host/bot/contracts";
import {
  BOT_CONVERSATION_SEARCH_MAX_PAGE_SIZE,
  BOT_CONVERSATION_SEARCH_MAX_QUERY_CHARS,
} from "@traycer/protocol/host/bot/conversation-schemas";

const METHOD = "bot.conversation.search";
const line = hostRpcRegistry[METHOD];
const request = line[1].versions[0].contract.requestSchema;
const response = line[1].versions[0].contract.responseSchema;

const baseRequest = {
  scope: { kind: "all" as const },
  query: "hello",
  mode: "ranked" as const,
  sort: "relevance" as const,
  from: "anyone" as const,
  since: null,
  where: "both" as const,
  cursor: null,
  limit: 20,
};

describe("bot.conversation.search registration", () => {
  it("answers with hits, a cursor, the index's state and the bots left out", () => {
    const answer = {
      hits: [
        {
          botId: "bot_00000000000000000000000000",
          conversationId: "channel-1",
          threadId: "thread-1",
          messageId: "message-1",
          senderUserId: null,
          rowKind: "reply",
          createdAt: 1_000,
          snippet: { text: "hello", highlights: [{ start: 0, end: 5 }] },
          replyCount: null,
          threadExcerpt: "The post",
          score: 12.5,
        },
      ],
      nextCursor: "1",
      indexState: "partial",
      total: null,
      unreachable: [
        { botId: "bot_00000000000000000000000000", reason: "other-owner" },
      ],
    };

    expect(response.parse(answer)).toEqual(answer);
  });

  it("is registered at 1.0 and degrades to unsupported", () => {
    expect(() =>
      validateVersionedRpcRegistry({ [METHOD]: hostRpcRegistry[METHOD] }),
    ).not.toThrow();
    expect(line.degrade).toEqual({ kind: "unsupported" });
    expect(line[1].latestMinor).toBe(0);
    expect(line[1].versions[0].contract).toBe(botConversationSearchV10);
    expect(botConversationSearchV10.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
  });

  it("is advertised on the optional manifest, not the floor", () => {
    const split = splitConnectionManifest(
      hostRpcRegistry,
      RELEASED_FLOOR_METHOD_NAMES,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
    expect(split.optionalManifest[METHOD]).toEqual({ major: 1, minor: 0 });
    expect(split.manifest[METHOD]).toBeUndefined();
  });
});

describe("bot.conversation.search request bounds", () => {
  it("parses a request at the longest query and the largest page", () => {
    expect(
      request.safeParse({
        ...baseRequest,
        query: "q".repeat(BOT_CONVERSATION_SEARCH_MAX_QUERY_CHARS),
        limit: BOT_CONVERSATION_SEARCH_MAX_PAGE_SIZE,
      }).success,
    ).toBe(true);
  });

  it("parses a request at the shortest query and the smallest page", () => {
    expect(
      request.safeParse({ ...baseRequest, query: "q", limit: 1 }).success,
    ).toBe(true);
  });

  it.each([
    ["an empty query", { query: "" }],
    [
      "a query one past the bound",
      { query: "q".repeat(BOT_CONVERSATION_SEARCH_MAX_QUERY_CHARS + 1) },
    ],
    ["a limit of 0", { limit: 0 }],
    [
      "a limit one past the bound",
      { limit: BOT_CONVERSATION_SEARCH_MAX_PAGE_SIZE + 1 },
    ],
  ])("refuses %s", (_name, override) => {
    expect(request.safeParse({ ...baseRequest, ...override }).success).toBe(
      false,
    );
  });
});
