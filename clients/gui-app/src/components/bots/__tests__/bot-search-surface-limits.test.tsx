/**
 * Search in Tracy (decision 186), through the REAL `BotTabSurface`: a page
 * with no hits that still has pages to come, a host that repeats the cursor
 * it was asked for, the longest query the host takes, and the keys of an
 * input method. The fake hosts and the module mocks are in
 * `bot-search-surface-support.tsx`; every request is checked against the
 * protocol's request schema, as the host does.
 * The clock is a fake one, so the debounce is crossed by advancing it.
 */
import {
  mocks,
  hitRows,
  lastAsked,
  transcriptOf,
  conversationOf,
  settle,
  installSearchSurfaceLifecycle,
} from "./bot-search-surface-support";
import { Surface } from "./bot-search-surface-view";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  BOT_CONVERSATION_SEARCH_MAX_QUERY_CHARS,
  type BotConversationSearchResponse,
} from "@traycer/protocol/host/bot/conversation-schemas";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  SEARCH_BOT_A,
  SEARCH_BOT_C,
  searchHit,
  searchResponse,
} from "@/lib/bots/__tests__/bot-search-test-support";

installSearchSurfaceLifecycle();

function cursorsAsked(): Array<string | null> {
  return mocks.asked.map((entry) => entry.request.cursor);
}

function typeInColumnBox(text: string): void {
  fireEvent.change(screen.getByTestId("bot-column-search"), {
    target: { value: text },
  });
}

describe("a page with no hits and a page to come", () => {
  it("is not 'no results': the list asks for the next page and shows its hits, with the note the empty page carried", async () => {
    const second = Promise.withResolvers<BotConversationSearchResponse>();
    mocks.state.answer = (_hostId, request) =>
      request.cursor === null
        ? searchResponse({
            hits: [],
            nextCursor: "page-2",
            unreachable: [{ botId: SEARCH_BOT_C, reason: "offline" }],
          })
        : second.promise;
    render(<Surface />);
    typeInColumnBox("ship");
    await settle();

    // The next page is held: this is the state a flash of "No results" would show in.
    expect(cursorsAsked()).toEqual([null, "page-2"]);
    expect(screen.queryByTestId("bot-search-no-results")).toBeNull();
    expect(screen.getByTestId("bot-search-count").textContent).toBe("");
    expect(screen.getByTestId("bot-search-unreachable").textContent).toBe(
      "Ops Bot's host is not reachable",
    );

    second.resolve(
      searchResponse({ hits: [searchHit({ messageId: "post-2" })] }),
    );
    await settle();

    expect(cursorsAsked()).toEqual([null, "page-2"]);
    expect(hitRows().map((row) => row.dataset.messageId)).toEqual(["post-2"]);
    expect(screen.getByTestId("bot-search-count").textContent).toBe("1 result");
    expect(screen.queryByTestId("bot-search-no-results")).toBeNull();
    expect(screen.getByTestId("bot-search-unreachable")).toBeTruthy();
  });

  it("says no result matched only when the pages end: three empty pages, the last with no cursor, are three asks", async () => {
    // Each page names the next, and the third names none.
    const nextOf: Readonly<Record<string, string | null>> = {
      first: "page-2",
      "page-2": "page-3",
      "page-3": null,
    };
    mocks.state.answer = (_hostId, request) =>
      searchResponse({
        hits: [],
        nextCursor: nextOf[request.cursor ?? "first"],
      });
    render(<Surface />);

    typeInColumnBox("ship");
    await settle();

    expect(cursorsAsked()).toEqual([null, "page-2", "page-3"]);
    expect(screen.getByTestId("bot-search-no-results")).toBeTruthy();
    expect(screen.queryByTestId("bot-search-count")).toBeNull();
  });

  it("stops where the host refuses a later page: it starts again once, then says it could not load more rather than no results, and Retry starts again", async () => {
    mocks.state.answer = (_hostId, request) =>
      request.cursor === null
        ? searchResponse({ hits: [], nextCursor: "page-2" })
        : new HostRpcError({
            code: "E_INVALID_ARGUMENT",
            message: "the search is gone",
            requestId: "request-1",
            method: "bot.conversation.search",
            fatalDetails: null,
          });
    render(<Surface />);
    typeInColumnBox("ship");
    await settle();
    // Past the retry delays a failed page would be asked again after.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(cursorsAsked()).toEqual([null, "page-2", null, "page-2"]);
    const failure = screen.getByTestId("bot-search-more-error");
    expect(screen.queryByTestId("bot-search-no-results")).toBeNull();

    fireEvent.click(within(failure).getByRole("button", { name: "Retry" }));
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

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
    expect(screen.queryByTestId("bot-search-no-results")).toBeNull();
  });
});

describe("the longest query the host takes", () => {
  it("is asked as typed, trimmed and then cut to the limit, so a longer one is a search and not an error", async () => {
    const long = "q".repeat(BOT_CONVERSATION_SEARCH_MAX_QUERY_CHARS + 1);
    render(<Surface />);

    // `fireEvent.change` sets what the input's own limit would have stopped.
    typeInColumnBox(`  ${long}  `);
    await settle();

    expect(lastAsked().request.query).toBe(
      "q".repeat(BOT_CONVERSATION_SEARCH_MAX_QUERY_CHARS),
    );
    expect(screen.queryByTestId("bot-search-error")).toBeNull();
    expect(hitRows()).toHaveLength(1);
  });

  it("is the limit the column's box and the panel's input hold a person to", () => {
    render(<Surface />);
    fireEvent.click(
      screen.getByRole("button", { name: "Search in Release Bot" }),
    );

    expect(screen.getByTestId("bot-column-search")).toHaveProperty(
      "maxLength",
      BOT_CONVERSATION_SEARCH_MAX_QUERY_CHARS,
    );
    expect(screen.getByTestId("bot-search-input")).toHaveProperty(
      "maxLength",
      BOT_CONVERSATION_SEARCH_MAX_QUERY_CHARS,
    );
  });
});

describe("a host that answers a page with the cursor it was asked for", () => {
  it.each([
    ["after a page of hits", [searchHit({ messageId: "post-1" })]],
    ["after an empty page", []],
  ] as const)(
    "stops the list at 'could not load more' %s, with no restart and no 'no results', and Retry asks that page again",
    async (_after, firstHits) => {
      mocks.state.answer = (_hostId, request) =>
        request.cursor === null
          ? searchResponse({ hits: [...firstHits], nextCursor: "page-2" })
          : searchResponse({ hits: [], nextCursor: request.cursor });
      render(<Surface />);
      typeInColumnBox("ship");
      await settle();
      // Past the retry delays the failed page is asked again after.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(cursorsAsked()).toEqual([null, "page-2", "page-2", "page-2"]);
      const failure = screen.getByTestId("bot-search-more-error");
      expect(screen.queryByTestId("bot-search-no-results")).toBeNull();
      expect(screen.queryAllByTestId("bot-search-hit")).toHaveLength(
        firstHits.length,
      );

      fireEvent.click(within(failure).getByRole("button", { name: "Retry" }));
      await settle();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(cursorsAsked()).toEqual([
        null,
        "page-2",
        "page-2",
        "page-2",
        "page-2",
        "page-2",
        "page-2",
      ]);
      expect(screen.getByTestId("bot-search-more-error")).toBeTruthy();
      expect(screen.queryAllByTestId("bot-search-hit")).toHaveLength(
        firstHits.length,
      );
    },
  );
});

describe("the keys of an input method", () => {
  it.each(["Enter", "ArrowDown", "ArrowUp"] as const)(
    "%s while composing is left to the input method: no jump, no selection, not prevented; the same key after it lands the result",
    async (key) => {
      render(<Surface />);
      typeInColumnBox("ship");
      await settle();
      const input = screen.getByTestId("bot-search-input");
      const landedOn = (): string | undefined =>
        transcriptOf(conversationOf(SEARCH_BOT_A)).dataset.landOn;

      const notPrevented = fireEvent.keyDown(input, { key, isComposing: true });
      await settle();

      expect(notPrevented).toBe(true);
      expect(landedOn()).toBe("none");
      expect(hitRows()[0].getAttribute("aria-current")).toBeNull();

      const prevented = !fireEvent.keyDown(input, { key });
      await settle();

      expect(prevented).toBe(true);
      expect(landedOn()).toBe("post-1");
      expect(hitRows()[0].getAttribute("aria-current")).toBe("true");
    },
  );
});
