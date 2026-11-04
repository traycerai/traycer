import { describe, expect, it, vi } from "vitest";
import type {
  BotConversationSearchResponse,
  BotConversationSearchUnreachable,
} from "@traycer/protocol/host/bot/conversation-schemas";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  botSearchFirstSource,
  botSearchHitsOf,
  botSearchSince,
  botSearchUnreachableOf,
  fetchBotSearchPage,
  type BotSearchPage,
  type BotSearchSource,
} from "@/lib/bots/bot-search-model";
import {
  SEARCH_BOT_A,
  SEARCH_BOT_B,
  SEARCH_BOT_C,
  searchHit,
  searchResponse,
} from "@/lib/bots/__tests__/bot-search-test-support";

const TAB_SOURCE: BotSearchSource = {
  hostId: null,
  scope: { kind: "all" },
  cursor: null,
};

const OTHER_OWNER_B: BotConversationSearchUnreachable = {
  botId: SEARCH_BOT_B,
  reason: "other-owner",
};

/** B's own host, which this client can dial. */
const B_HOST = "host-b";

function reachableOnlyB(botId: string): string | null {
  return botId === SEARCH_BOT_B ? B_HOST : null;
}

function nobodyReachable(): string | null {
  return null;
}

function hostFailure(
  code: "RPC_ERROR" | "E_HOST_UNSUPPORTED" | "E_INVALID_ARGUMENT",
): HostRpcError {
  return new HostRpcError({
    code,
    message: "the host did not answer",
    requestId: "request-1",
    method: "bot.conversation.search",
    fatalDetails: null,
  });
}

function emptyPage(overrides: Partial<BotSearchPage>): BotSearchPage {
  return {
    hits: [],
    next: [],
    indexState: "complete",
    total: null,
    unreachable: [],
    ...overrides,
  };
}

describe("botSearchSince", () => {
  // A local afternoon: the filter starts at a midnight, not at "24 hours ago".
  const now = new Date(2026, 10, 4, 15, 30, 12);

  it("is null for any time", () => {
    expect(botSearchSince("any", now)).toBeNull();
  });

  it.each([
    ["today", new Date(2026, 10, 4).getTime()],
    ["7d", new Date(2026, 10, 4 - 7).getTime()],
    ["30d", new Date(2026, 10, 4 - 30).getTime()],
  ] as const)("starts %s at a local midnight", (date, expected) => {
    expect(botSearchSince(date, now)).toBe(expected);
  });

  it("holds still through the day, so the cache key does", () => {
    const morning = new Date(2026, 10, 4, 0, 5);
    const night = new Date(2026, 10, 4, 23, 55);

    expect(botSearchSince("7d", morning)).toBe(botSearchSince("7d", night));
  });
});

describe("botSearchFirstSource", () => {
  it("asks a bot's own host where this client can dial it, and the tab's host for every bot", () => {
    expect(
      botSearchFirstSource(
        { kind: "bot", botId: SEARCH_BOT_B },
        reachableOnlyB,
      ),
    ).toEqual({
      hostId: B_HOST,
      scope: { kind: "bot", botId: SEARCH_BOT_B },
      cursor: null,
    });
    expect(
      botSearchFirstSource({ kind: "bot", botId: SEARCH_BOT_A }, reachableOnlyB)
        .hostId,
    ).toBeNull();
    expect(
      botSearchFirstSource({ kind: "all" }, reachableOnlyB).hostId,
    ).toBeNull();
  });
});

describe("fetchBotSearchPage", () => {
  it("orders the hits by score for relevance and by time for newest, and passes the cursor back as the host named it", async () => {
    const answer = searchResponse({
      hits: [
        searchHit({ messageId: "old-strong", createdAt: 1_000, score: 9 }),
        searchHit({ messageId: "new-weak", createdAt: 3_000, score: 2 }),
        searchHit({ messageId: "mid", createdAt: 2_000, score: 5 }),
      ],
      nextCursor: "opaque/cursor==?x=1",
      total: 3,
    });
    const ask = vi.fn(() => Promise.resolve(answer));

    const relevance = await fetchBotSearchPage({
      sources: [TAB_SOURCE],
      sort: "relevance",
      ask,
      reachableHostOf: nobodyReachable,
    });
    const newest = await fetchBotSearchPage({
      sources: [TAB_SOURCE],
      sort: "newest",
      ask,
      reachableHostOf: nobodyReachable,
    });

    expect(relevance.hits.map((hit) => hit.messageId)).toEqual([
      "old-strong",
      "mid",
      "new-weak",
    ]);
    expect(newest.hits.map((hit) => hit.messageId)).toEqual([
      "new-weak",
      "mid",
      "old-strong",
    ]);
    expect(relevance.next).toEqual([
      { ...TAB_SOURCE, cursor: "opaque/cursor==?x=1" },
    ]);
    expect(relevance.total).toBe(3);
  });

  it("asks a team's bot directly where this client can dial its host, and joins its hits to the page by score", async () => {
    const ask = vi.fn(
      (source: BotSearchSource): Promise<BotConversationSearchResponse> => {
        if (source.hostId === null) {
          return Promise.resolve(
            searchResponse({
              hits: [searchHit({ messageId: "a-low", score: 1 })],
              nextCursor: "tab-next",
              total: 1,
              unreachable: [OTHER_OWNER_B],
            }),
          );
        }
        return Promise.resolve(
          searchResponse({
            hits: [
              searchHit({ botId: SEARCH_BOT_B, messageId: "b-high", score: 7 }),
            ],
            nextCursor: "b-next",
            total: 4,
          }),
        );
      },
    );

    const page = await fetchBotSearchPage({
      sources: [TAB_SOURCE],
      sort: "relevance",
      ask,
      reachableHostOf: reachableOnlyB,
    });

    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask).toHaveBeenLastCalledWith({
      hostId: B_HOST,
      scope: { kind: "bot", botId: SEARCH_BOT_B },
      cursor: null,
    });
    expect(page.hits.map((hit) => hit.messageId)).toEqual(["b-high", "a-low"]);
    expect(page.total).toBe(5);
    expect(page.unreachable).toEqual([]);
    expect(page.next).toEqual([
      { ...TAB_SOURCE, cursor: "tab-next" },
      {
        hostId: B_HOST,
        scope: { kind: "bot", botId: SEARCH_BOT_B },
        cursor: "b-next",
      },
    ]);
  });

  it("leaves a bot nobody can dial unreachable, and a count one host could not give unknown", async () => {
    const ask = vi.fn(() =>
      Promise.resolve(
        searchResponse({
          hits: [searchHit({ messageId: "a-1" })],
          total: null,
          unreachable: [
            OTHER_OWNER_B,
            { botId: SEARCH_BOT_C, reason: "offline" },
          ],
        }),
      ),
    );

    const page = await fetchBotSearchPage({
      sources: [TAB_SOURCE],
      sort: "relevance",
      ask,
      reachableHostOf: nobodyReachable,
    });

    expect(ask).toHaveBeenCalledTimes(1);
    expect(page.unreachable).toEqual([
      OTHER_OWNER_B,
      { botId: SEARCH_BOT_C, reason: "offline" },
    ]);
    expect(page.total).toBeNull();
  });

  it.each([
    ["offline", hostFailure("RPC_ERROR")],
    ["unsupported", hostFailure("E_HOST_UNSUPPORTED")],
  ] as const)(
    "names a bot whose own host failed as %s, and keeps the rest of the page",
    async (reason, failure) => {
      const ask = vi.fn(
        (source: BotSearchSource): Promise<BotConversationSearchResponse> =>
          source.hostId === null
            ? Promise.resolve(
                searchResponse({
                  hits: [searchHit({ messageId: "a-1" })],
                  total: 1,
                  unreachable: [OTHER_OWNER_B],
                }),
              )
            : Promise.reject(failure),
      );

      const page = await fetchBotSearchPage({
        sources: [TAB_SOURCE],
        sort: "relevance",
        ask,
        reachableHostOf: reachableOnlyB,
      });

      expect(page.hits.map((hit) => hit.messageId)).toEqual(["a-1"]);
      expect(page.unreachable).toEqual([{ botId: SEARCH_BOT_B, reason }]);
      expect(page.next).toEqual([]);
    },
  );

  it("fails the page when the tab's own host fails", async () => {
    const failure = hostFailure("RPC_ERROR");

    await expect(
      fetchBotSearchPage({
        sources: [TAB_SOURCE],
        sort: "relevance",
        ask: () => Promise.reject(failure),
        reachableHostOf: reachableOnlyB,
      }),
    ).rejects.toBe(failure);
  });

  it("fails a later page whose direct host no longer holds the search, where the same answer to a first page only costs the bot", async () => {
    const refused = hostFailure("E_INVALID_ARGUMENT");
    const directB: BotSearchSource = {
      hostId: B_HOST,
      scope: { kind: "bot", botId: SEARCH_BOT_B },
      cursor: null,
    };
    const ask = (
      source: BotSearchSource,
    ): Promise<BotConversationSearchResponse> =>
      source.hostId === B_HOST
        ? Promise.reject(refused)
        : Promise.resolve(
            searchResponse({
              hits: [searchHit({ messageId: "a-1" })],
              total: 1,
            }),
          );

    const first = await fetchBotSearchPage({
      sources: [TAB_SOURCE, directB],
      sort: "relevance",
      ask,
      reachableHostOf: reachableOnlyB,
    });

    expect(first.hits.map((hit) => hit.messageId)).toEqual(["a-1"]);
    expect(first.unreachable).toEqual([
      { botId: SEARCH_BOT_B, reason: "offline" },
    ]);
    await expect(
      fetchBotSearchPage({
        sources: [TAB_SOURCE, { ...directB, cursor: "b-next" }],
        sort: "relevance",
        ask,
        reachableHostOf: reachableOnlyB,
      }),
    ).rejects.toBe(refused);
  });

  it("asks no follow-up on a later page, where the bot already has a source of its own", async () => {
    const directB: BotSearchSource = {
      hostId: B_HOST,
      scope: { kind: "bot", botId: SEARCH_BOT_B },
      cursor: "b-next",
    };
    const ask = vi.fn(
      (source: BotSearchSource): Promise<BotConversationSearchResponse> =>
        Promise.resolve(
          source.hostId === null
            ? searchResponse({
                hits: [searchHit({ messageId: "a-2", score: 3 })],
                total: 1,
                unreachable: [OTHER_OWNER_B],
              })
            : searchResponse({
                hits: [
                  searchHit({
                    botId: SEARCH_BOT_B,
                    messageId: "b-2",
                    score: 4,
                  }),
                ],
                total: 4,
              }),
        ),
    );

    const page = await fetchBotSearchPage({
      sources: [{ ...TAB_SOURCE, cursor: "tab-next" }, directB],
      sort: "relevance",
      ask,
      reachableHostOf: reachableOnlyB,
    });

    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls.map(([source]) => source.cursor)).toEqual([
      "tab-next",
      "b-next",
    ]);
    expect(page.hits.map((hit) => hit.messageId)).toEqual(["b-2", "a-2"]);
    expect(page.unreachable).toEqual([]);
  });

  it("is partial when any one host's index has not caught up, and complete otherwise", async () => {
    const directB: BotSearchSource = {
      hostId: B_HOST,
      scope: { kind: "bot", botId: SEARCH_BOT_B },
      cursor: null,
    };
    const askWith =
      (directState: "complete" | "partial") =>
      (source: BotSearchSource): Promise<BotConversationSearchResponse> =>
        Promise.resolve(
          searchResponse({
            indexState: source.hostId === null ? "complete" : directState,
          }),
        );

    const partial = await fetchBotSearchPage({
      sources: [TAB_SOURCE, directB],
      sort: "relevance",
      ask: askWith("partial"),
      reachableHostOf: nobodyReachable,
    });
    const complete = await fetchBotSearchPage({
      sources: [TAB_SOURCE, directB],
      sort: "relevance",
      ask: askWith("complete"),
      reachableHostOf: nobodyReachable,
    });

    expect(partial.indexState).toBe("partial");
    expect(complete.indexState).toBe("complete");
  });
});

describe("the pages on screen", () => {
  it("shows a row an index move repeated once, in the order first seen", () => {
    const pages = [
      emptyPage({
        hits: [
          searchHit({ messageId: "post-1" }),
          searchHit({ messageId: "post-2" }),
        ],
      }),
      emptyPage({
        hits: [
          searchHit({ messageId: "post-2" }),
          searchHit({ messageId: "post-3" }),
          // The same message id in another bot is another row.
          searchHit({ botId: SEARCH_BOT_B, messageId: "post-3" }),
        ],
      }),
    ];

    expect(
      botSearchHitsOf(pages).map((hit) => [hit.botId, hit.messageId]),
    ).toEqual([
      [SEARCH_BOT_A, "post-1"],
      [SEARCH_BOT_A, "post-2"],
      [SEARCH_BOT_A, "post-3"],
      [SEARCH_BOT_B, "post-3"],
    ]);
  });

  it("names a bot once however many pages left it out", () => {
    const pages = [
      emptyPage({ unreachable: [{ botId: SEARCH_BOT_B, reason: "offline" }] }),
      emptyPage({
        unreachable: [
          { botId: SEARCH_BOT_B, reason: "offline" },
          { botId: SEARCH_BOT_C, reason: "no-host" },
        ],
      }),
    ];

    expect(botSearchUnreachableOf(pages).map((entry) => entry.botId)).toEqual([
      SEARCH_BOT_B,
      SEARCH_BOT_C,
    ]);
  });
});
