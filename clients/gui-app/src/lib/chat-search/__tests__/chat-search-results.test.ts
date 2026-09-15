import { describe, expect, it } from "vitest";
import type {
  ChatSearchChatMatch,
  ChatSearchMessageHit,
  ChatSearchMessageMatch,
  ChatSearchResponse,
} from "@traycer/protocol/host/chat-search/schemas";
import {
  chatSearchDateRange,
  chatSearchGroupKey,
  chatSearchTaskTitleIndex,
  type ChatSearchTitledTask,
  highlightSegments,
  mergeChatSearchExpansionPages,
  mergeChatSearchPages,
} from "@/lib/chat-search/chat-search-results";

function chatMatch(input: {
  readonly chatId: string;
  readonly epicId?: string;
  readonly ownerUserId?: string;
  readonly title?: string;
  readonly messageMatchCount?: number;
}): ChatSearchChatMatch {
  return {
    epicId: input.epicId ?? "epic-1",
    ownerUserId: input.ownerUserId ?? "user-1",
    chatId: input.chatId,
    title: input.title ?? `title-${input.chatId}`,
    lifecycleState: "active",
    updatedAt: 1_000,
    titleHighlights: [],
    messageMatchCount: input.messageMatchCount ?? 0,
  };
}

function messageHit(input: {
  readonly messageId: string;
  readonly tier?: ChatSearchMessageHit["tier"];
}): ChatSearchMessageHit {
  return {
    messageId: input.messageId,
    tier: input.tier ?? "assistant",
    createdAt: 1_000,
    interAgent: false,
    truncated: false,
    snippet: { text: "hello", highlights: [] },
  };
}

function messageMatch(input: {
  readonly chatId: string;
  readonly epicId?: string;
  readonly ownerUserId?: string;
  readonly title?: string;
  readonly matchCount?: number;
  readonly best?: ChatSearchMessageHit;
  readonly messages?: ReadonlyArray<ChatSearchMessageHit>;
}): ChatSearchMessageMatch {
  return {
    epicId: input.epicId ?? "epic-1",
    ownerUserId: input.ownerUserId ?? "user-1",
    chatId: input.chatId,
    title: input.title ?? `title-${input.chatId}`,
    lifecycleState: "active",
    updatedAt: 1_000,
    matchCount: input.matchCount ?? 1,
    best: input.best ?? messageHit({ messageId: `${input.chatId}-m1` }),
    messages: [...(input.messages ?? [])],
  };
}

function response(input: {
  readonly chatMatches?: ReadonlyArray<ChatSearchChatMatch>;
  readonly chatNextCursor?: string | null;
  readonly messageMatches?: ReadonlyArray<ChatSearchMessageMatch>;
  readonly messageNextCursor?: string | null;
  readonly indexState?: ChatSearchResponse["indexState"];
}): ChatSearchResponse {
  return {
    chatMatches: [...(input.chatMatches ?? [])],
    chatNextCursor: input.chatNextCursor ?? null,
    messageMatches: [...(input.messageMatches ?? [])],
    messageNextCursor: input.messageNextCursor ?? null,
    indexState: input.indexState ?? "complete",
  };
}

describe("mergeChatSearchPages", () => {
  it("renders both sections from the first page alone", () => {
    const first = response({
      chatMatches: [chatMatch({ chatId: "c1" })],
      messageMatches: [messageMatch({ chatId: "c2" })],
    });

    const merged = mergeChatSearchPages({
      first,
      moreChats: [],
      moreMessages: [],
    });

    expect(merged.chatMatches).toEqual([chatMatch({ chatId: "c1" })]);
    expect(merged.messageMatches).toEqual([messageMatch({ chatId: "c2" })]);
  });

  it("removes a chat from messageMatches once a LATER chats page titles it", () => {
    const first = response({
      messageMatches: [messageMatch({ chatId: "c1" })],
    });
    const moreChats = response({
      chatMatches: [chatMatch({ chatId: "c1" })],
    });

    const merged = mergeChatSearchPages({
      first,
      moreChats: [moreChats],
      moreMessages: [],
    });

    // Title wins: the chat is listed once, under Chats, not under messages.
    expect(merged.chatMatches.map((m) => m.chatId)).toEqual(["c1"]);
    expect(merged.messageMatches).toEqual([]);
  });

  it("lists a chat group once even when it repeats across two message pages", () => {
    const first = response({
      messageMatches: [messageMatch({ chatId: "c1", matchCount: 3 })],
    });
    const moreMessages = response({
      messageMatches: [messageMatch({ chatId: "c1", matchCount: 3 })],
    });

    const merged = mergeChatSearchPages({
      first,
      moreChats: [],
      moreMessages: [moreMessages],
    });

    expect(merged.messageMatches).toHaveLength(1);
    expect(merged.messageMatches[0]?.chatId).toBe("c1");
  });

  it("names a null next cursor for a section whose latest page is still in flight", () => {
    const first = response({
      chatMatches: [chatMatch({ chatId: "c1" })],
      chatNextCursor: "cursor-1",
    });

    const merged = mergeChatSearchPages({
      first,
      moreChats: [undefined],
      moreMessages: [],
    });

    expect(merged.chatNextCursor).toBeNull();
  });

  it("otherwise takes the next cursor from the last page of that section", () => {
    const first = response({
      chatMatches: [chatMatch({ chatId: "c1" })],
      chatNextCursor: "cursor-1",
    });
    const secondChatsPage = response({
      chatMatches: [chatMatch({ chatId: "c2" })],
      chatNextCursor: "cursor-2",
    });

    const merged = mergeChatSearchPages({
      first,
      moreChats: [secondChatsPage],
      moreMessages: [],
    });

    expect(merged.chatNextCursor).toBe("cursor-2");
  });

  it("is partial when any loaded page on screen was answered partial", () => {
    const first = response({ indexState: "complete" });
    const moreChats = response({ indexState: "partial" });

    const merged = mergeChatSearchPages({
      first,
      moreChats: [moreChats],
      moreMessages: [],
    });

    expect(merged.indexState).toBe("partial");
  });

  it("stays complete when every loaded page is complete", () => {
    const first = response({ indexState: "complete" });
    const moreChats = response({ indexState: "complete" });

    const merged = mergeChatSearchPages({
      first,
      moreChats: [moreChats],
      moreMessages: [undefined],
    });

    expect(merged.indexState).toBe("complete");
  });
});

describe("mergeChatSearchExpansionPages", () => {
  it("dedupes rows by (messageId, tier), keeping distinct tiers of the same message", () => {
    const userHit = messageHit({ messageId: "m1", tier: "user" });
    const noticeHit = messageHit({ messageId: "m1", tier: "notice" });
    const page1 = response({
      messageMatches: [
        messageMatch({ chatId: "c1", messages: [userHit, noticeHit] }),
      ],
    });
    const page2 = response({
      // A later page repeating the exact same (messageId, tier) row.
      messageMatches: [messageMatch({ chatId: "c1", messages: [userHit] })],
    });

    const merged = mergeChatSearchExpansionPages([page1, page2]);

    expect(merged.messages).toEqual([userHit, noticeHit]);
  });

  it("takes nextCursor from the last page", () => {
    const page1 = response({ messageNextCursor: "cursor-a" });
    const page2 = response({ messageNextCursor: "cursor-b" });

    expect(mergeChatSearchExpansionPages([page1, page2]).nextCursor).toBe(
      "cursor-b",
    );
    expect(mergeChatSearchExpansionPages([page1, undefined]).nextCursor).toBe(
      null,
    );
  });
});

describe("chatSearchGroupKey", () => {
  it("groups by (epicId, ownerUserId, chatId)", () => {
    const a = chatSearchGroupKey({
      epicId: "e1",
      ownerUserId: "u1",
      chatId: "c1",
    });
    const b = chatSearchGroupKey({
      epicId: "e1",
      ownerUserId: "u1",
      chatId: "c1",
    });
    const different = chatSearchGroupKey({
      epicId: "e1",
      ownerUserId: "u1",
      chatId: "c2",
    });
    expect(a).toBe(b);
    expect(a).not.toBe(different);
  });
});

describe("highlightSegments", () => {
  it("returns the whole text as one plain segment when there are no ranges", () => {
    const segments = highlightSegments("hello world", []);
    expect(segments).toEqual([
      { start: 0, text: "hello world", highlighted: false },
    ]);
  });

  it("sorts unsorted ranges before splitting", () => {
    const segments = highlightSegments("abcdef", [
      { start: 4, end: 6 },
      { start: 0, end: 2 },
    ]);
    expect(segments).toEqual([
      { start: 0, text: "ab", highlighted: true },
      { start: 2, text: "cd", highlighted: false },
      { start: 4, text: "ef", highlighted: true },
    ]);
  });

  it("does not duplicate text for overlapping ranges", () => {
    const segments = highlightSegments("abcdef", [
      { start: 0, end: 4 },
      { start: 2, end: 6 },
    ]);
    // The second range's covered head (2-4) is already consumed by the
    // first, so only its uncovered tail (4-6) contributes a segment.
    expect(segments).toEqual([
      { start: 0, text: "abcd", highlighted: true },
      { start: 4, text: "ef", highlighted: true },
    ]);
  });

  it("clamps a range that extends beyond the text length", () => {
    const segments = highlightSegments("abc", [{ start: 1, end: 99 }]);
    expect(segments).toEqual([
      { start: 0, text: "a", highlighted: false },
      { start: 1, text: "bc", highlighted: true },
    ]);
  });

  it("always reconstitutes the input when segment texts are concatenated", () => {
    const cases: ReadonlyArray<{
      readonly text: string;
      readonly ranges: ReadonlyArray<{ start: number; end: number }>;
    }> = [
      { text: "hello world", ranges: [] },
      { text: "hello world", ranges: [{ start: 0, end: 5 }] },
      {
        text: "hello world",
        ranges: [
          { start: 6, end: 11 },
          { start: 0, end: 5 },
        ],
      },
      { text: "hello world", ranges: [{ start: 3, end: 999 }] },
      { text: "", ranges: [] },
    ];
    for (const { text, ranges } of cases) {
      const segments = highlightSegments(text, ranges);
      expect(segments.map((segment) => segment.text).join("")).toBe(text);
    }
  });

  it("reports correct start offsets for every segment", () => {
    const segments = highlightSegments("abcdefgh", [{ start: 3, end: 5 }]);
    expect(segments).toEqual([
      { start: 0, text: "abc", highlighted: false },
      { start: 3, text: "de", highlighted: true },
      { start: 5, text: "fgh", highlighted: false },
    ]);
    for (const segment of segments) {
      expect(
        "abcdefgh".slice(segment.start, segment.start + segment.text.length),
      ).toBe(segment.text);
    }
  });
});

describe("chatSearchDateRange", () => {
  const anchorMs = 1_700_000_000_000;

  it("returns null for the `any` preset", () => {
    expect(chatSearchDateRange("any", anchorMs)).toBeNull();
  });

  it("returns a week-back range with an open upper bound for `week`", () => {
    const range = chatSearchDateRange("week", anchorMs);
    expect(range).toEqual({
      from: anchorMs - 7 * 24 * 60 * 60 * 1000,
      to: null,
    });
  });
});

describe("chatSearchTaskTitleIndex", () => {
  function task(epic: {
    readonly id: string;
    readonly title: string;
    readonly initialUserPrompt: string;
  }): ChatSearchTitledTask {
    return { epic: { light: { ...epic } } };
  }

  it("indexes each listed epic's display title by id and skips epic-less rows", () => {
    const index = chatSearchTaskTitleIndex([
      task({ id: "e1", title: "First task", initialUserPrompt: "" }),
      { epic: null },
      task({ id: "e2", title: "", initialUserPrompt: "" }),
    ]);

    expect(index.get("e1")).toBe("First task");
    expect(index.get("e2")).toBe("Untitled task");
    expect(index.size).toBe(2);
  });
});
