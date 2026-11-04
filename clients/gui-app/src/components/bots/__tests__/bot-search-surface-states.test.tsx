/**
 * Search in Tracy (decision 186), through the REAL `BotTabSurface`: the
 * filters, paging, the count of results, a search its host no longer holds,
 * the notes beside the results and a bot under another owner. The fake hosts
 * and the module mocks are in `bot-search-surface-support.tsx`.
 * The clock is a fake one, so the debounce is crossed by advancing it.
 */
import {
  mocks,
  TAB_HOST,
  HOST_A,
  HOST_B,
  conversationOf,
  SEARCH_RESULT_A,
  answerWith,
  lastAsked,
  settle,
  typeIntoPanel,
  pickFilter,
  thread,
  THREAD_HIT,
  hitRows,
  installSearchSurfaceLifecycle,
} from "./bot-search-surface-support";
import { Surface } from "./bot-search-surface-view";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotConversationSearchHit } from "@traycer/protocol/host/bot/conversation-schemas";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  SEARCH_BOT_B,
  SEARCH_BOT_C,
  searchHit,
  searchResponse,
} from "@/lib/bots/__tests__/bot-search-test-support";

installSearchSurfaceLifecycle();

describe("the filters", () => {
  /** Filters, one at a time from the column box's All bots, each in the request. */
  it.each([
    [
      "In",
      "bot-search-filter-in",
      "Notes Bot",
      { scope: { kind: "bot", botId: SEARCH_BOT_B } },
    ],
    ["From", "bot-search-filter-from", "Me", { from: "me" }],
    ["From", "bot-search-filter-from", "The bot", { from: "bot" }],
    [
      "From",
      "bot-search-filter-from",
      "Tess Teammate",
      { from: { userId: "user-teammate" } },
    ],
    [
      "Date",
      "bot-search-filter-date",
      "Today",
      { since: new Date(2026, 10, 4).getTime() },
    ],
    [
      "Date",
      "bot-search-filter-date",
      "Last 7 days",
      { since: new Date(2026, 10, 4 - 7).getTime() },
    ],
    [
      "Date",
      "bot-search-filter-date",
      "Last 30 days",
      { since: new Date(2026, 10, 4 - 30).getTime() },
    ],
    ["Where", "bot-search-filter-where", "Posts only", { where: "posts" }],
    ["Where", "bot-search-filter-where", "Threads only", { where: "threads" }],
  ])(
    "%s set to %s changes the request (%#)",
    async (_name, trigger, option, expected) => {
      render(<Surface />);
      fireEvent.change(screen.getByTestId("bot-column-search"), {
        target: { value: "ship" },
      });
      await settle();
      const before = mocks.asked.length;

      pickFilter(trigger, option);
      await settle();

      expect(mocks.asked.length).toBe(before + 1);
      expect(lastAsked().request).toMatchObject({ query: "ship", ...expected });
    },
  );

  it("sends the other order when the sort toggle is pressed", async () => {
    render(<Surface />);
    fireEvent.change(screen.getByTestId("bot-column-search"), {
      target: { value: "ship" },
    });
    await settle();
    expect(lastAsked().request.sort).toBe("relevance");

    fireEvent.click(screen.getByTestId("bot-search-sort"));
    await settle();

    expect(screen.getByTestId("bot-search-sort").textContent).toBe("Newest");
    expect(lastAsked().request.sort).toBe("newest");
  });

  it("asks the bot's own host when the In filter narrows to a bot this client can dial, and the tab's host for all", async () => {
    render(<Surface />);
    fireEvent.change(screen.getByTestId("bot-column-search"), {
      target: { value: "ship" },
    });
    await settle();
    expect(lastAsked().hostId).toBe(TAB_HOST);

    pickFilter("bot-search-filter-in", "Notes Bot");
    await settle();
    expect(lastAsked().hostId).toBe(HOST_B);

    // Ops Bot's host is not one this client can dial.
    pickFilter("bot-search-filter-in", "Ops Bot");
    await settle();
    expect(lastAsked().hostId).toBe(TAB_HOST);
  });
});

describe("paging the results", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks for the next page when the list is scrolled near its end, with the cursor as the host named it, until the host names none", async () => {
    // Room to scroll: the list is not too short to need the next page.
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(5_000);
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(400);
    const cursors = ["page-2/opaque==?a=1&b=%2F", "page-3 /x"];
    mocks.state.answer = (_hostId, request) => {
      const at =
        request.cursor === null ? 0 : cursors.indexOf(request.cursor) + 1;
      return searchResponse({
        hits: [searchHit({ messageId: `post-${String(at)}`, score: 9 - at })],
        nextCursor: cursors.at(at) ?? null,
        total: 3,
      });
    };
    render(<Surface />);
    fireEvent.change(screen.getByTestId("bot-column-search"), {
      target: { value: "ship" },
    });
    await settle();
    expect(mocks.asked.map((entry) => entry.request.cursor)).toEqual([null]);

    const list = screen.getByTestId("bot-search-results");
    fireEvent.scroll(list, { target: { scrollTop: 4_500 } });
    await settle();
    fireEvent.scroll(list, { target: { scrollTop: 4_600 } });
    await settle();
    fireEvent.scroll(list, { target: { scrollTop: 4_700 } });
    await settle();

    expect(mocks.asked.map((entry) => entry.request.cursor)).toEqual([
      null,
      "page-2/opaque==?a=1&b=%2F",
      "page-3 /x",
    ]);
    expect(
      screen
        .getAllByTestId("bot-search-hit")
        .map((hit) => hit.dataset.messageId),
    ).toEqual(["post-0", "post-1", "post-2"]);
  });
});

describe("a search its host no longer holds", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function refusal(): HostRpcError {
    return new HostRpcError({
      code: "E_INVALID_ARGUMENT",
      message: "the search is gone",
      requestId: "request-1",
      method: "bot.conversation.search",
      fatalDetails: null,
    });
  }

  it("starts again from the first page when a later page is refused, and shows what that page found", async () => {
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(5_000);
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(400);
    let firstPages = 0;
    mocks.state.answer = (_hostId, request) => {
      if (request.cursor !== null) return refusal();
      firstPages += 1;
      return firstPages === 1
        ? searchResponse({
            hits: [searchHit({ messageId: "stale-1" })],
            nextCursor: "page-2",
            total: 2,
          })
        : searchResponse({
            hits: [searchHit({ messageId: "fresh-1" })],
            nextCursor: null,
            total: 1,
          });
    };
    render(<Surface />);
    fireEvent.change(screen.getByTestId("bot-column-search"), {
      target: { value: "ship" },
    });
    await settle();

    fireEvent.scroll(screen.getByTestId("bot-search-results"), {
      target: { scrollTop: 4_500 },
    });
    await settle();

    expect(mocks.asked.map((entry) => entry.request.cursor)).toEqual([
      null,
      "page-2",
      null,
    ]);
    expect(hitRows().map((row) => row.dataset.messageId)).toEqual(["fresh-1"]);
    expect(screen.queryByTestId("bot-search-error")).toBeNull();
    expect(screen.queryByText("Couldn't search.")).toBeNull();
  });

  it("does not start again when the first page is the one refused, and offers the retry", async () => {
    mocks.state.answer = () => refusal();
    render(<Surface />);

    fireEvent.change(screen.getByTestId("bot-column-search"), {
      target: { value: "ship" },
    });
    await settle();

    expect(mocks.asked).toHaveLength(1);
    expect(screen.getByTestId("bot-search-error")).toBeTruthy();
    expect(screen.getByText("Couldn't search.")).toBeTruthy();
  });

  /** A short list with one hit, whose page 2 the host refuses every time. */
  function refusePageTwo(): void {
    mocks.state.answer = (_hostId, request) =>
      request.cursor === null
        ? searchResponse({
            hits: [searchHit({ messageId: "post-1" })],
            nextCursor: "page-2",
            total: 2,
          })
        : refusal();
  }

  function cursorsAsked(): Array<string | null> {
    return mocks.asked.map((entry) => entry.request.cursor);
  }

  it("starts again once for a search whose host goes on refusing, then says it could not load more, with no loop", async () => {
    refusePageTwo();
    render(<Surface />);
    fireEvent.change(screen.getByTestId("bot-column-search"), {
      target: { value: "ship" },
    });
    await settle();

    // The list is too short to scroll, so every render asks for more.
    expect(cursorsAsked()).toEqual([null, "page-2", null, "page-2"]);
    const failure = screen.getByTestId("bot-search-more-error");
    expect(failure.textContent).toContain("Couldn't load more results.");
    expect(hitRows().map((row) => row.dataset.messageId)).toEqual(["post-1"]);
    expect(screen.queryByTestId("bot-search-error")).toBeNull();

    await settle();
    await settle();
    expect(cursorsAsked()).toHaveLength(4);

    fireEvent.click(within(failure).getByRole("button", { name: "Retry" }));
    await settle();

    // The person's retry starts again, and the refusal that follows it waits
    // for the next retry.
    expect(cursorsAsked()).toEqual([
      null,
      "page-2",
      null,
      "page-2",
      "page-2",
      null,
      "page-2",
    ]);
    expect(screen.getByTestId("bot-search-more-error")).toBeTruthy();
    expect(hitRows()).toHaveLength(1);
  });

  it.each([
    [
      "filter",
      (): void => {
        pickFilter("bot-search-filter-from", "Me");
      },
    ],
    [
      "query",
      (): void => {
        fireEvent.change(screen.getByTestId("bot-search-input"), {
          target: { value: "shipping" },
        });
      },
    ],
  ] as const)(
    "gives a search with another %s its own restart",
    async (_change, change) => {
      refusePageTwo();
      render(<Surface />);
      fireEvent.change(screen.getByTestId("bot-column-search"), {
        target: { value: "ship" },
      });
      await settle();
      expect(cursorsAsked()).toEqual([null, "page-2", null, "page-2"]);

      change();
      // Past the keystroke debounce, then through the restart and its refusal.
      await settle();
      await settle();

      expect(cursorsAsked()).toEqual([
        null,
        "page-2",
        null,
        "page-2",
        null,
        "page-2",
        null,
        "page-2",
      ]);
      expect(screen.getByTestId("bot-search-more-error")).toBeTruthy();
    },
  );
});

describe("a later page that fails without being refused", () => {
  function internalFailure(): HostRpcError {
    return new HostRpcError({
      code: "RPC_ERROR",
      message: "the host failed",
      requestId: "request-1",
      method: "bot.conversation.search",
      fatalDetails: null,
    });
  }

  /** Both ways in to a search: the column's box asks the tab's host about every bot, the header's button asks the one bot's own host. */
  it.each([
    [
      "every bot, of the tab's host",
      TAB_HOST,
      async (): Promise<void> => {
        fireEvent.change(screen.getByTestId("bot-column-search"), {
          target: { value: "ship" },
        });
        await settle();
      },
    ],
    [
      "one bot, of its own host",
      HOST_A,
      async (): Promise<void> => {
        fireEvent.click(
          screen.getByRole("button", { name: "Search in Release Bot" }),
        );
        await typeIntoPanel("ship");
      },
    ],
  ] as const)(
    "keeps the pages it has when a later page of a search of %s fails, says it could not load more, asks nothing more until Retry, and goes on from the page Retry asks again",
    async (_route, askedHost, openSearch) => {
      let page2Works = false;
      mocks.state.answer = (_hostId, request) => {
        if (request.cursor === null) {
          return searchResponse({
            hits: [searchHit({ messageId: "post-1" })],
            nextCursor: "page-2",
          });
        }
        if (request.cursor === "page-2") {
          return page2Works
            ? searchResponse({
                hits: [searchHit({ messageId: "post-2" })],
                nextCursor: "page-3",
              })
            : internalFailure();
        }
        return searchResponse({ hits: [searchHit({ messageId: "post-3" })] });
      };
      render(<Surface />);
      await openSearch();
      // The page is asked again twice, after a second and after two more.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      const cursors = (): Array<string | null> =>
        mocks.asked.map((entry) => entry.request.cursor);
      expect(cursors()).toEqual([null, "page-2", "page-2", "page-2"]);
      const failure = screen.getByTestId("bot-search-more-error");
      expect(failure.textContent).toContain("Couldn't load more results.");
      expect(hitRows().map((row) => row.dataset.messageId)).toEqual(["post-1"]);
      expect(screen.queryByTestId("bot-search-error")).toBeNull();
      expect(screen.getByTestId("bot-search-count").textContent).toBe(
        "1+ results",
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(cursors()).toHaveLength(4);

      page2Works = true;
      fireEvent.click(within(failure).getByRole("button", { name: "Retry" }));
      await settle();

      expect(cursors()).toEqual([
        null,
        "page-2",
        "page-2",
        "page-2",
        "page-2",
        "page-3",
      ]);
      expect(hitRows().map((row) => row.dataset.messageId)).toEqual([
        "post-1",
        "post-2",
        "post-3",
      ]);
      expect(screen.queryByTestId("bot-search-more-error")).toBeNull();
      expect(new Set(mocks.asked.map((entry) => entry.hostId))).toEqual(
        new Set([askedHost]),
      );
    },
  );
});

describe("the count of results", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["more follow, so the rows so far are a floor", 20, "more", "20+ results"],
    ["none follow, so the rows are the count", 2, null, "2 results"],
  ] as const)(
    "where the host gave no total and %s, the list and the back link say so",
    async (_case, rows, nextCursor, label) => {
      // Room to scroll, and no scroll: the next page is not asked for.
      vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(5_000);
      vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(400);
      mocks.state.threads = [thread("thread-1", "post-7")];
      mocks.state.answer = answerWith(
        searchResponse({
          hits: [
            THREAD_HIT,
            ...Array.from({ length: rows - 1 }, (_unused, at) =>
              searchHit({ messageId: `filler-${String(at)}`, score: 1 }),
            ),
          ],
          nextCursor,
          total: null,
        }),
      );
      render(<Surface />);
      fireEvent.change(screen.getByTestId("bot-column-search"), {
        target: { value: "release" },
      });
      await settle();

      expect(hitRows()).toHaveLength(rows);
      expect(mocks.asked).toHaveLength(1);
      expect(screen.getByTestId("bot-search-count").textContent).toBe(label);

      fireEvent.click(hitRows()[0]);
      await settle();

      expect(screen.getByTestId("bot-search-back").textContent).toBe(
        `${label} for “release”`,
      );
    },
  );
});

describe("what the list says besides the results", () => {
  it("says no result matched, and offers to clear the filters and to search all bots only where either would widen it", async () => {
    mocks.state.answer = answerWith(searchResponse({ hits: [], total: 0 }));
    render(<Surface />);
    fireEvent.change(screen.getByTestId("bot-column-search"), {
      target: { value: "zzz" },
    });
    await settle();
    const buttons = (): string[] =>
      within(screen.getByTestId("bot-search-no-results"))
        .queryAllByRole("button")
        .map((button) => button.textContent);

    expect(screen.getByTestId("bot-search-no-results").textContent).toBe(
      "No results for “zzz”",
    );
    expect(buttons()).toEqual([]);

    pickFilter("bot-search-filter-in", "Release Bot");
    pickFilter("bot-search-filter-from", "Me");
    await settle();
    expect(screen.getByTestId("bot-search-no-results").textContent).toContain(
      "No results for “zzz” in Release Bot",
    );
    expect(buttons()).toEqual(["Clear filters", "Search all bots"]);

    // Each step lands on a search already asked and held, so it asks nothing.
    fireEvent.click(screen.getByTestId("bot-search-clear-filters"));
    await settle();
    expect(screen.getByTestId("bot-search-filter-from").textContent).toBe(
      "FromAnyone",
    );
    expect(screen.getByTestId("bot-search-scope-chip")).toBeTruthy();
    expect(buttons()).toEqual(["Search all bots"]);

    fireEvent.click(screen.getByTestId("bot-search-widen"));
    await settle();
    expect(screen.queryByTestId("bot-search-scope-chip")).toBeNull();
    expect(buttons()).toEqual([]);
  });

  it("says recent messages are still being indexed, with the results found", async () => {
    mocks.state.answer = answerWith(
      searchResponse({
        hits: [SEARCH_RESULT_A],
        total: 1,
        indexState: "partial",
      }),
    );
    render(<Surface />);
    fireEvent.change(screen.getByTestId("bot-column-search"), {
      target: { value: "release" },
    });
    await settle();

    expect(screen.getByTestId("bot-search-partial").textContent).toBe(
      "Still indexing recent messages",
    );
    expect(hitRows()).toHaveLength(1);
  });

  it("names a bot whose host could not be reached", async () => {
    mocks.state.answer = answerWith(
      searchResponse({
        hits: [SEARCH_RESULT_A],
        total: 1,
        unreachable: [{ botId: SEARCH_BOT_C, reason: "offline" }],
      }),
    );
    render(<Surface />);
    fireEvent.change(screen.getByTestId("bot-column-search"), {
      target: { value: "release" },
    });
    await settle();

    expect(screen.getByTestId("bot-search-unreachable").textContent).toBe(
      "Ops Bot's host is not reachable",
    );
    expect(hitRows()).toHaveLength(1);
  });
});

describe("a bot under another owner", () => {
  const OTHER_OWNER_B = { botId: SEARCH_BOT_B, reason: "other-owner" } as const;
  const NOTES_HIT = searchHit({
    botId: SEARCH_BOT_B,
    conversationId: conversationOf(SEARCH_BOT_B),
    messageId: "note-1",
    score: 7,
  });

  it("is asked of directly where this client can dial its host, and its results join the list by score", async () => {
    mocks.state.answer = (hostId) =>
      hostId === HOST_B
        ? searchResponse({ hits: [NOTES_HIT], total: 1 })
        : searchResponse({
            hits: [SEARCH_RESULT_A],
            total: 1,
            unreachable: [OTHER_OWNER_B],
          });
    render(<Surface />);
    fireEvent.change(screen.getByTestId("bot-column-search"), {
      target: { value: "release" },
    });
    await settle();

    expect(mocks.asked.map((entry) => entry.hostId)).toEqual([
      TAB_HOST,
      HOST_B,
    ]);
    expect(mocks.asked[1].request.scope).toEqual({
      kind: "bot",
      botId: SEARCH_BOT_B,
    });
    expect(hitRows().map((row) => row.dataset.messageId)).toEqual([
      "note-1",
      "post-1",
    ]);
    expect(screen.getByTestId("bot-search-count").textContent).toBe(
      "2 results",
    );
    expect(screen.queryByTestId("bot-search-unreachable")).toBeNull();
  });

  it("keeps the list in rank order across pages when the hosts' pages run to different depths", async () => {
    const aHit = (rank: number): BotConversationSearchHit =>
      searchHit({ messageId: `a-${String(rank)}`, score: rank });
    const bHit = (rank: number): BotConversationSearchHit =>
      searchHit({
        botId: SEARCH_BOT_B,
        conversationId: conversationOf(SEARCH_BOT_B),
        messageId: `b-${String(rank)}`,
        score: rank,
      });
    mocks.state.answer = (hostId, request) => {
      if (hostId === HOST_B) {
        return request.cursor === null
          ? searchResponse({ hits: [bHit(95), bHit(5)], nextCursor: "b-1" })
          : searchResponse({ hits: [bHit(4)] });
      }
      return request.cursor === null
        ? searchResponse({
            hits: [aHit(100), aHit(90), aHit(80), aHit(70)],
            nextCursor: "a-1",
            unreachable: [OTHER_OWNER_B],
          })
        : searchResponse({
            hits: [aHit(65), aHit(60)],
            unreachable: [OTHER_OWNER_B],
          });
    };
    render(<Surface />);
    fireEvent.change(screen.getByTestId("bot-column-search"), {
      target: { value: "release" },
    });
    await settle();

    // Page one stops at A's last hit, 70: B's 5 waits for the A hits above it.
    expect(
      mocks.asked.map((entry) => [entry.hostId, entry.request.cursor]),
    ).toEqual([
      [TAB_HOST, null],
      [HOST_B, null],
      [TAB_HOST, "a-1"],
      [HOST_B, "b-1"],
    ]);
    expect(hitRows().map((row) => row.dataset.messageId)).toEqual([
      "a-100",
      "b-95",
      "a-90",
      "a-80",
      "a-70",
      "a-65",
      "a-60",
      "b-5",
      "b-4",
    ]);
    expect(screen.queryByTestId("bot-search-unreachable")).toBeNull();
  });

  it("is named when its own host fails to answer", async () => {
    mocks.state.answer = (hostId) =>
      hostId === HOST_B
        ? new HostRpcError({
            code: "RPC_ERROR",
            message: "the host is down",
            requestId: "request-1",
            method: "bot.conversation.search",
            fatalDetails: null,
          })
        : searchResponse({
            hits: [SEARCH_RESULT_A],
            total: 1,
            unreachable: [OTHER_OWNER_B],
          });
    render(<Surface />);
    fireEvent.change(screen.getByTestId("bot-column-search"), {
      target: { value: "release" },
    });
    await settle();

    expect(screen.getByTestId("bot-search-unreachable").textContent).toBe(
      "Notes Bot's host is not reachable",
    );
    expect(hitRows().map((row) => row.dataset.messageId)).toEqual(["post-1"]);
  });
});
