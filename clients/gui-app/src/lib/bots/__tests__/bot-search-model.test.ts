import { describe, expect, it, vi } from "vitest";
import type {
  BotConversationSearchHit,
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
  started: false,
  pending: [],
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
      started: false,
      pending: [],
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
  it("joins the hosts' hits by score for relevance and by time for newest, and passes the cursor back as the host named it", async () => {
    const strong = searchHit({
      messageId: "a-strong",
      createdAt: 1_000,
      score: 9,
    });
    const weak = searchHit({ messageId: "a-weak", createdAt: 3_000, score: 2 });
    const mid = searchHit({
      botId: SEARCH_BOT_B,
      messageId: "b-mid",
      createdAt: 2_000,
      score: 5,
    });
    // Each host answers best first in the order it was asked for.
    const askFor =
      (sort: "relevance" | "newest") =>
      (source: BotSearchSource): Promise<BotConversationSearchResponse> =>
        Promise.resolve(
          source.hostId === null
            ? searchResponse({
                hits: sort === "relevance" ? [strong, weak] : [weak, strong],
                nextCursor: "opaque/cursor==?x=1",
                total: 2,
              })
            : searchResponse({ hits: [mid], total: 1 }),
        );
    const directB: BotSearchSource = {
      hostId: B_HOST,
      scope: { kind: "bot", botId: SEARCH_BOT_B },
      cursor: null,
      started: false,
      pending: [],
    };

    const [relevance, newest] = await Promise.all(
      (["relevance", "newest"] as const).map((sort) =>
        fetchBotSearchPage({
          sources: [TAB_SOURCE, directB],
          sort,
          ask: askFor(sort),
          reachableHostOf: nobodyReachable,
        }),
      ),
    );

    expect(relevance.hits.map((hit) => hit.messageId)).toEqual([
      "a-strong",
      "b-mid",
      "a-weak",
    ]);
    expect(newest.hits.map((hit) => hit.messageId)).toEqual([
      "a-weak",
      "b-mid",
      "a-strong",
    ]);
    expect(relevance.next).toEqual([
      { ...TAB_SOURCE, cursor: "opaque/cursor==?x=1", started: true },
    ]);
    expect(relevance.total).toBe(3);
  });

  it("asks a team's bot directly where this client can dial its host, and joins it as a source of its own", async () => {
    const aLow = searchHit({ messageId: "a-low", score: 1 });
    const ask = vi.fn(
      (source: BotSearchSource): Promise<BotConversationSearchResponse> => {
        if (source.hostId === null) {
          return Promise.resolve(
            searchResponse({
              hits: [aLow],
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
      started: false,
      pending: [],
    });
    // B has nothing left to compare past its one hit, so the page stops there
    // and the tab's lower hit waits.
    expect(page.hits.map((hit) => hit.messageId)).toEqual(["b-high"]);
    expect(page.total).toBe(5);
    expect(page.unreachable).toEqual([]);
    expect(page.next).toEqual([
      { ...TAB_SOURCE, cursor: "tab-next", started: true, pending: [aLow] },
      {
        hostId: B_HOST,
        scope: { kind: "bot", botId: SEARCH_BOT_B },
        cursor: "b-next",
        started: true,
        pending: [],
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

  it("fails a later page whose direct host does not answer it, where the same failure on a first page only costs the bot", async () => {
    const failure = hostFailure("RPC_ERROR");
    const directB: BotSearchSource = {
      hostId: B_HOST,
      scope: { kind: "bot", botId: SEARCH_BOT_B },
      cursor: null,
      started: false,
      pending: [],
    };
    const ask = (
      source: BotSearchSource,
    ): Promise<BotConversationSearchResponse> =>
      source.hostId === B_HOST
        ? Promise.reject(failure)
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
        sources: [TAB_SOURCE, { ...directB, cursor: "b-next", started: true }],
        sort: "relevance",
        ask,
        reachableHostOf: reachableOnlyB,
      }),
    ).rejects.toBe(failure);
  });

  it.each([
    ["a first page", { cursor: null, started: false }],
    ["a later page", { cursor: "b-next", started: true }],
  ] as const)(
    "fails the page when a direct host refuses %s with E_INVALID_ARGUMENT, and names no bot unreachable",
    async (_page, where) => {
      const refused = hostFailure("E_INVALID_ARGUMENT");
      const directB: BotSearchSource = {
        hostId: B_HOST,
        scope: { kind: "bot", botId: SEARCH_BOT_B },
        pending: [],
        ...where,
      };

      await expect(
        fetchBotSearchPage({
          sources: [directB],
          sort: "relevance",
          ask: () => Promise.reject(refused),
          reachableHostOf: reachableOnlyB,
        }),
      ).rejects.toBe(refused);
    },
  );

  it("asks no follow-up on a later page, where the bot already has a source of its own", async () => {
    const directB: BotSearchSource = {
      hostId: B_HOST,
      scope: { kind: "bot", botId: SEARCH_BOT_B },
      cursor: "b-next",
      started: true,
      pending: [],
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
      sources: [{ ...TAB_SOURCE, cursor: "tab-next", started: true }, directB],
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
      started: false,
      pending: [],
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

/** A host's pages of hits, best first: the answer to the cursor it named. */
function pagedHost(
  cursorPrefix: string,
  pages: ReadonlyArray<ReadonlyArray<BotConversationSearchHit>>,
): (cursor: string | null) => BotConversationSearchResponse {
  return (cursor) => {
    const at = cursor === null ? 0 : Number(cursor.slice(cursorPrefix.length));
    return searchResponse({
      hits: [...pages[at]],
      nextCursor:
        at + 1 < pages.length ? `${cursorPrefix}${String(at + 1)}` : null,
    });
  };
}

/** Hits of `botId` with these ranks, which are also their ids. */
function rankedHits(
  botId: string,
  ranks: ReadonlyArray<number>,
  sort: "relevance" | "newest",
): BotConversationSearchHit[] {
  return ranks.map((rank) =>
    searchHit({
      botId,
      messageId: `${botId}/${String(rank)}`,
      // The field the other order reads runs the other way.
      score: sort === "relevance" ? rank : 1_000 - rank,
      createdAt: sort === "newest" ? rank : 1_000 - rank,
    }),
  );
}

/** Whole numbers from `from` down to `to`. */
function countdown(from: number, to: number): number[] {
  return Array.from({ length: from - to + 1 }, (_unused, at) => from - at);
}

const DIRECT_B: BotSearchSource = {
  hostId: B_HOST,
  scope: { kind: "bot", botId: SEARCH_BOT_B },
  cursor: null,
  started: false,
  pending: [],
};

describe("paging hosts that rank at their own pace", () => {
  it.each(["relevance", "newest"] as const)(
    "lists every hit in rank order across pages and hosts when one host's first pages run above the other's, and asks a host again only once it runs short, with its own cursor (%s)",
    async (sort) => {
      const hostA = pagedHost("a-", [
        rankedHits(SEARCH_BOT_A, countdown(200, 181), sort),
        rankedHits(SEARCH_BOT_A, countdown(180, 161), sort),
        rankedHits(SEARCH_BOT_A, countdown(160, 155), sort),
      ]);
      const hostB = pagedHost("b-", [
        rankedHits(SEARCH_BOT_B, [150, 140, 130, ...countdown(20, 4)], sort),
        rankedHits(SEARCH_BOT_B, [3, 2, 1], sort),
      ]);
      const asked: string[] = [];
      const ask = (
        source: BotSearchSource,
      ): Promise<BotConversationSearchResponse> => {
        asked.push(`${source.hostId ?? "tab"}:${source.cursor ?? "first"}`);
        return Promise.resolve(
          source.hostId === null ? hostA(source.cursor) : hostB(source.cursor),
        );
      };

      const pages: BotSearchPage[] = [];
      let sources: ReadonlyArray<BotSearchSource> = [TAB_SOURCE, DIRECT_B];
      while (sources.length > 0) {
        const page = await fetchBotSearchPage({
          sources,
          sort,
          ask,
          reachableHostOf: nobodyReachable,
        });
        pages.push(page);
        sources = page.next;
      }

      const everyRank = [
        ...countdown(200, 155),
        150,
        140,
        130,
        ...countdown(20, 1),
      ];
      expect(botSearchHitsOf(pages).map((hit) => hit.messageId)).toEqual(
        everyRank.map((rank) =>
          rank >= 155 && rank <= 200
            ? `${SEARCH_BOT_A}/${String(rank)}`
            : `${SEARCH_BOT_B}/${String(rank)}`,
        ),
      );
      expect(pages.map((page) => page.hits.length)).toEqual([20, 20, 20, 9]);
      // B's first page holds 20 hits from the start, so it is not asked again
      // until the tab's pages have used them up.
      expect(asked).toEqual([
        "tab:first",
        "host-b:first",
        "tab:a-1",
        "tab:a-2",
        "host-b:b-1",
      ]);
    },
  );

  it("stops a page where a host with more to give has none left, and asks only that host for the next", async () => {
    const hostA = pagedHost("a-", [
      rankedHits(SEARCH_BOT_A, [100, 90], "relevance"),
      rankedHits(SEARCH_BOT_A, [85], "relevance"),
    ]);
    const hostB = pagedHost("b-", [
      rankedHits(SEARCH_BOT_B, [95, 80, 70], "relevance"),
    ]);
    const asked: string[] = [];
    const ask = (
      source: BotSearchSource,
    ): Promise<BotConversationSearchResponse> => {
      asked.push(`${source.hostId ?? "tab"}:${source.cursor ?? "first"}`);
      return Promise.resolve(
        source.hostId === null ? hostA(source.cursor) : hostB(source.cursor),
      );
    };

    const first = await fetchBotSearchPage({
      sources: [TAB_SOURCE, DIRECT_B],
      sort: "relevance",
      ask,
      reachableHostOf: nobodyReachable,
    });

    // A's next hit is unknown, so nothing below 90 is placed yet.
    expect(first.hits.map((hit) => hit.messageId)).toEqual([
      `${SEARCH_BOT_A}/100`,
      `${SEARCH_BOT_B}/95`,
      `${SEARCH_BOT_A}/90`,
    ]);
    expect(first.next).toEqual([
      { ...TAB_SOURCE, cursor: "a-1", started: true },
      {
        ...DIRECT_B,
        started: true,
        pending: rankedHits(SEARCH_BOT_B, [80, 70], "relevance"),
      },
    ]);

    const second = await fetchBotSearchPage({
      sources: first.next,
      sort: "relevance",
      ask,
      reachableHostOf: nobodyReachable,
    });

    expect(asked).toEqual(["tab:first", "host-b:first", "tab:a-1"]);
    expect(second.hits.map((hit) => hit.messageId)).toEqual([
      `${SEARCH_BOT_A}/85`,
      `${SEARCH_BOT_B}/80`,
      `${SEARCH_BOT_B}/70`,
    ]);
    expect(second.next).toEqual([]);
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
