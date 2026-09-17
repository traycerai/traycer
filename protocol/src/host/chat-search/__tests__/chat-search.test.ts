import { describe, expect, it } from "vitest";
import {
  splitConnectionManifest,
  SERVES_EVERY_INSTALLED_MAJOR,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { releasedMethodNames } from "@traycer/protocol/host/__tests__/__fixtures__/released-method-names";
import { chatSearchV10 } from "@traycer/protocol/host/chat-search/contracts";
import {
  CHAT_SEARCH_MAX_PAGE_SIZE,
  CHAT_SEARCH_MAX_QUERY_CHARS,
  chatSearchRequestSchema,
  chatSearchResponseSchema,
} from "@traycer/protocol/host/chat-search/schemas";

const METHOD = "chat.search";

const baseRequest = {
  query: "hello",
  scope: { kind: "current-task" as const, epicId: "epic-1" },
  tiers: null,
  roleFilter: "any" as const,
  dateRange: null,
  harness: null,
  mode: "ranked" as const,
  chatCursor: null,
  chatLimit: 20,
  messageCursor: null,
  messageLimit: 20,
};

describe("chat.search is optional, not floor", () => {
  it("is registered at 1.0 with an unsupported degrade", () => {
    expect(chatSearchV10.method).toBe(METHOD);
    expect(chatSearchV10.schemaVersion).toEqual({ major: 1, minor: 0 });
    expect(Object.hasOwn(hostRpcRegistry, METHOD)).toBe(true);
    expect(hostRpcRegistry[METHOD].degrade).toEqual({ kind: "unsupported" });
    expect(hostRpcRegistry[METHOD][1].latestMinor).toBe(0);
    expect(hostRpcRegistry[METHOD][1].versions[0]?.contract).toBe(
      chatSearchV10,
    );
  });

  it("stays off the unary released floor and the frozen method-name fixture", () => {
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(METHOD);
    expect(releasedMethodNames).not.toContain(METHOD);
  });

  it("advertises on the optional manifest, not the floor manifest", () => {
    const split = splitConnectionManifest(
      hostRpcRegistry,
      RELEASED_FLOOR_METHOD_NAMES,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
    expect(split.optionalManifest[METHOD]).toEqual({
      major: 1,
      minor: 0,
      supportedMajors: [1],
    });
    expect(split.manifest[METHOD]).toBeUndefined();
  });
});

describe("chatSearchRequestSchema", () => {
  it("accepts a full valid request for each scope kind", () => {
    expect(chatSearchRequestSchema.safeParse(baseRequest).success).toBe(true);
    expect(
      chatSearchRequestSchema.safeParse({
        ...baseRequest,
        scope: { kind: "all-accessible-tasks" as const },
      }).success,
    ).toBe(true);
    expect(
      chatSearchRequestSchema.safeParse({
        ...baseRequest,
        scope: {
          kind: "chat" as const,
          epicId: "epic-1",
          chatId: "chat-1",
        },
      }).success,
    ).toBe(true);
  });

  it("accepts null tiers, dateRange, harness, and cursors", () => {
    expect(
      chatSearchRequestSchema.safeParse({
        ...baseRequest,
        tiers: null,
        dateRange: null,
        harness: null,
        chatCursor: null,
        messageCursor: null,
      }).success,
    ).toBe(true);
  });

  it("rejects a query longer than CHAT_SEARCH_MAX_QUERY_CHARS", () => {
    expect(
      chatSearchRequestSchema.safeParse({
        ...baseRequest,
        query: "a".repeat(CHAT_SEARCH_MAX_QUERY_CHARS + 1),
      }).success,
    ).toBe(false);
  });

  it("rejects chatLimit 0 and CHAT_SEARCH_MAX_PAGE_SIZE + 1", () => {
    expect(
      chatSearchRequestSchema.safeParse({ ...baseRequest, chatLimit: 0 })
        .success,
    ).toBe(false);
    expect(
      chatSearchRequestSchema.safeParse({
        ...baseRequest,
        chatLimit: CHAT_SEARCH_MAX_PAGE_SIZE + 1,
      }).success,
    ).toBe(false);
  });

  it("rejects an empty tiers array and an unknown tier", () => {
    expect(
      chatSearchRequestSchema.safeParse({ ...baseRequest, tiers: [] }).success,
    ).toBe(false);
    expect(
      chatSearchRequestSchema.safeParse({
        ...baseRequest,
        tiers: ["bogus"],
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown mode", () => {
    expect(
      chatSearchRequestSchema.safeParse({ ...baseRequest, mode: "bogus" })
        .success,
    ).toBe(false);
  });

  it("rejects current-task scope without epicId", () => {
    expect(
      chatSearchRequestSchema.safeParse({
        ...baseRequest,
        scope: { kind: "current-task" },
      }).success,
    ).toBe(false);
  });

  it("rejects a request missing required fields", () => {
    const { roleFilter: _roleFilter, ...withoutRoleFilter } = baseRequest;
    expect(chatSearchRequestSchema.safeParse(withoutRoleFilter).success).toBe(
      false,
    );
  });
});

describe("chatSearchResponseSchema", () => {
  const chatMatch = {
    epicId: "epic-1",
    ownerUserId: "user-1",
    chatId: "chat-1",
    title: "Chat title",
    lifecycleState: "active" as const,
    updatedAt: 1700000000000,
    titleHighlights: [{ start: 0, end: 4 }],
    messageMatchCount: 2,
  };

  const messageHit = {
    messageId: "msg-1",
    tier: "user" as const,
    createdAt: 1700000000000,
    interAgent: false,
    truncated: false,
    snippet: { text: "hello world", highlights: [{ start: 0, end: 5 }] },
  };

  const messageMatch = {
    epicId: "epic-1",
    ownerUserId: "user-1",
    chatId: "chat-2",
    title: "Chat title 2",
    lifecycleState: "active" as const,
    updatedAt: 1700000000000,
    matchCount: 1,
    best: messageHit,
    messages: [messageHit],
  };

  it("accepts an empty page", () => {
    expect(
      chatSearchResponseSchema.safeParse({
        chatMatches: [],
        chatNextCursor: null,
        messageMatches: [],
        messageNextCursor: null,
        indexState: "complete",
      }).success,
    ).toBe(true);
  });

  it("accepts a populated page with one chat match and one message match", () => {
    expect(
      chatSearchResponseSchema.safeParse({
        chatMatches: [chatMatch],
        chatNextCursor: null,
        messageMatches: [messageMatch],
        messageNextCursor: null,
        indexState: "partial",
      }).success,
    ).toBe(true);
  });

  it("rejects lifecycleState 'deleted'", () => {
    expect(
      chatSearchResponseSchema.safeParse({
        chatMatches: [{ ...chatMatch, lifecycleState: "deleted" }],
        chatNextCursor: null,
        messageMatches: [],
        messageNextCursor: null,
        indexState: "complete",
      }).success,
    ).toBe(false);
  });

  it("rejects an indexState other than complete/partial", () => {
    expect(
      chatSearchResponseSchema.safeParse({
        chatMatches: [],
        chatNextCursor: null,
        messageMatches: [],
        messageNextCursor: null,
        indexState: "stale",
      }).success,
    ).toBe(false);
  });
});
