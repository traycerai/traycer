/**
 * Search in Tracy (decision 186), through the REAL `BotTabSurface`: opening
 * the search, the recent searches, jumping to a result, a result's row and
 * the phone. The fake hosts and the module mocks are in
 * `bot-search-surface-support.tsx`; the filters, paging, counts and the notes
 * beside the results are in `bot-search-surface-states.test.tsx`.
 * The clock is a fake one, so the debounce is crossed by advancing it.
 */
import {
  mocks,
  TAB_HOST,
  HOST_A,
  conversationOf,
  SEARCH_RESULT_A,
  answerWith,
  lastAsked,
  settle,
  typeIntoPanel,
  panel,
  pickFilter,
  thread,
  THREAD_HIT,
  hitRows,
  transcriptOf,
  installSearchSurfaceLifecycle,
} from "./bot-search-surface-support";
import { Surface } from "./bot-search-surface-view";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_NAVIGATION_HIGHLIGHT_DURATION_MS } from "@/components/chat/chat-navigation-highlight";
import { CHAT_SEARCH_DEBOUNCE_MS } from "@/lib/chat-search/chat-search-results";
import { setPhoneLayoutOnly } from "@/lib/mobile-app";
import {
  installShellForm,
  SHELL_WIDTH_MENU,
  type ShellFormHarness,
} from "../../../../__tests__/mobile-level2-form-harness";
import {
  SEARCH_BOT_A,
  SEARCH_BOT_B,
  searchHit,
  searchResponse,
} from "@/lib/bots/__tests__/bot-search-test-support";
import { openActiveTileFind } from "@/lib/commands/tile-find";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import {
  useBotSearchStore,
  type BotSearchRecent,
} from "@/stores/bots/bot-search-store";

installSearchSurfaceLifecycle();

/** ⌘F, as the keybinding and the menu route it. */
function pressFind(): boolean {
  let handled = false;
  act(() => {
    handled = openActiveTileFind();
  });
  return handled;
}

describe("opening the search", () => {
  it("opens from the column's box on the channel in view with All bots, carrying what was typed", async () => {
    render(<Surface />);

    fireEvent.change(screen.getByTestId("bot-column-search"), {
      target: { value: "release" },
    });
    await settle();

    expect(panel()).toBeTruthy();
    expect(screen.queryByTestId("bot-search-scope-chip")).toBeNull();
    const input = screen.getByTestId("bot-search-input");
    expect(input).toHaveProperty("value", "release");
    expect(document.activeElement).toBe(input);
    expect(lastAsked()).toEqual({
      hostId: TAB_HOST,
      request: {
        scope: { kind: "all" },
        query: "release",
        mode: "ranked",
        sort: "relevance",
        from: "anyone",
        since: null,
        where: "both",
        cursor: null,
        limit: 20,
      },
    });
  });

  it("opens from the header's button on this bot, as the chip says, and asks the bot's own host", async () => {
    render(<Surface />);

    fireEvent.click(
      screen.getByRole("button", { name: "Search in Release Bot" }),
    );
    await typeIntoPanel("release");

    expect(screen.getByTestId("bot-search-scope-chip").textContent).toBe(
      "in Release Bot",
    );
    expect(lastAsked().hostId).toBe(HOST_A);
    expect(lastAsked().request.scope).toEqual({
      kind: "bot",
      botId: SEARCH_BOT_A,
    });
  });

  it("opens on ⌘F while focus is in the surface or nowhere", () => {
    render(<Surface />);
    expect(document.activeElement).toBe(document.body);

    expect(pressFind()).toBe(true);
    expect(screen.getByTestId("bot-search-scope-chip").textContent).toBe(
      "in Release Bot",
    );

    fireEvent.click(screen.getByTestId("bot-search-close"));
    expect(screen.queryByTestId("bot-search-panel")).toBeNull();
    act(() => {
      screen.getByTestId("bot-column-search").focus();
    });

    expect(pressFind()).toBe(true);
    expect(panel()).toBeTruthy();
  });

  it("leaves ⌘F to a tile beside the surface while focus is in that tile", () => {
    render(
      <>
        <Surface />
        <div data-testid="tile-beside">
          <textarea aria-label="Beside tile" />
        </div>
      </>,
    );
    act(() => {
      screen.getByLabelText("Beside tile").focus();
    });

    expect(pressFind()).toBe(false);
    expect(screen.queryByTestId("bot-search-panel")).toBeNull();
  });

  it("offers neither the box, the button nor ⌘F on a host without the search", () => {
    mocks.state.searchSupported = false;
    render(<Surface />);

    expect(screen.queryByTestId("bot-column-search")).toBeNull();
    expect(screen.queryByTestId("bot-channel-search-open")).toBeNull();
    expect(pressFind()).toBe(false);
    expect(screen.queryByTestId("bot-search-panel")).toBeNull();
  });

  it("widens to all bots when the chip is removed", async () => {
    render(<Surface />);
    fireEvent.click(
      screen.getByRole("button", { name: "Search in Release Bot" }),
    );
    await typeIntoPanel("release");
    expect(lastAsked().request.scope).toEqual({
      kind: "bot",
      botId: SEARCH_BOT_A,
    });

    fireEvent.click(screen.getByTestId("bot-search-scope-remove"));
    await settle();

    expect(screen.queryByTestId("bot-search-scope-chip")).toBeNull();
    expect(lastAsked()).toMatchObject({
      hostId: TAB_HOST,
      request: { scope: { kind: "all" }, query: "release" },
    });
  });
});

const RECENTS: ReadonlyArray<BotSearchRecent> = [
  {
    query: "release",
    scope: { kind: "bot", botId: SEARCH_BOT_A },
    scopeTitle: "Release Bot",
  },
  { query: "deploy", scope: { kind: "all" }, scopeTitle: null },
];

describe("before a query of two characters", () => {
  function openFromHeader(): void {
    render(<Surface />);
    fireEvent.click(
      screen.getByRole("button", { name: "Search in Release Bot" }),
    );
  }

  it("lists the recent searches with their scopes, and asks the host nothing for one character", async () => {
    act(() => {
      useBotSearchStore.setState({ recents: [...RECENTS] });
    });
    openFromHeader();

    const recents = screen.getAllByTestId("bot-search-recent");
    expect(recents.map((entry) => entry.textContent)).toEqual([
      "releaseRelease Bot",
      "deployAll bots",
    ]);
    expect(
      within(screen.getByRole("region", { name: "Narrow to" }))
        .getAllByRole("button")
        .map((chip) => chip.textContent),
    ).toEqual(["This bot", "From me", "Last 7 days"]);

    await typeIntoPanel("r");

    expect(mocks.asked).toEqual([]);
    expect(screen.getByTestId("bot-search-before-typing")).toBeTruthy();
    expect(screen.queryByTestId("bot-search-filters")).toBeNull();
  });

  it("waits out the keystrokes: a query typed on within the debounce is asked once, as typed last", async () => {
    openFromHeader();

    fireEvent.change(screen.getByTestId("bot-search-input"), {
      target: { value: "rel" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHAT_SEARCH_DEBOUNCE_MS - 1);
    });
    expect(mocks.asked).toEqual([]);
    fireEvent.change(screen.getByTestId("bot-search-input"), {
      target: { value: "release" },
    });
    await settle();

    expect(mocks.asked.map((entry) => entry.request.query)).toEqual([
      "release",
    ]);
  });

  it("runs a recent search again in the scope it ran in", async () => {
    act(() => {
      useBotSearchStore.setState({ recents: [...RECENTS] });
    });
    openFromHeader();
    expect(screen.getByTestId("bot-search-scope-chip")).toBeTruthy();

    fireEvent.click(
      within(screen.getAllByTestId("bot-search-recent")[1]).getByRole("button"),
    );
    await settle();

    expect(screen.queryByTestId("bot-search-scope-chip")).toBeNull();
    expect(screen.getByTestId("bot-search-input")).toHaveProperty(
      "value",
      "deploy",
    );
    expect(lastAsked().request).toMatchObject({
      scope: { kind: "all" },
      query: "deploy",
    });
  });

  it("sets a filter from each of the Narrow to chips", async () => {
    render(<Surface />);
    fireEvent.click(screen.getByTestId("bot-column-search"));
    const chips = {
      bot: screen.getByTestId("bot-search-narrow-bot"),
      me: screen.getByTestId("bot-search-narrow-me"),
      week: screen.getByTestId("bot-search-narrow-week"),
    };
    expect(Object.values(chips).map((chip) => chip.ariaPressed)).toEqual([
      "false",
      "false",
      "false",
    ]);

    fireEvent.click(chips.bot);
    fireEvent.click(chips.me);
    fireEvent.click(chips.week);

    expect(Object.values(chips).map((chip) => chip.ariaPressed)).toEqual([
      "true",
      "true",
      "true",
    ]);
    expect(screen.getByTestId("bot-search-scope-chip").textContent).toBe(
      "in Release Bot",
    );
    await typeIntoPanel("ship");
    expect(lastAsked().request).toMatchObject({
      scope: { kind: "bot", botId: SEARCH_BOT_A },
      from: "me",
      since: new Date(2026, 10, 4 - 7).getTime(),
    });
  });
});

/** The ranges `RangeHighlighter` has painted, by their text. */
const painted = new Map<string, PaintedHighlight>();

class PaintedHighlight {
  readonly ranges: readonly Range[];
  constructor(...ranges: readonly Range[]) {
    this.ranges = ranges;
  }
}

function paintedWords(): string[] {
  return [...painted.values()].flatMap((highlight) =>
    highlight.ranges.map((range) => range.toString()),
  );
}

describe("jumping to a result", () => {
  beforeEach(() => {
    painted.clear();
    vi.stubGlobal("CSS", {
      highlights: {
        set: (name: string, highlight: PaintedHighlight): void => {
          painted.set(name, highlight);
        },
        delete: (name: string): void => {
          painted.delete(name);
        },
      },
    });
    vi.stubGlobal("Highlight", PaintedHighlight);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function openWithResults(query: string): Promise<void> {
    render(<Surface />);
    fireEvent.change(screen.getByTestId("bot-column-search"), {
      target: { value: query },
    });
    await settle();
  }

  it("lands the channel on a post and marks the words it matched for as long as the landing ring lasts", async () => {
    await openWithResults("release");
    expect(transcriptOf(conversationOf(SEARCH_BOT_A)).dataset.landOn).toBe(
      "none",
    );

    fireEvent.click(hitRows()[0]);
    await settle();

    expect(transcriptOf(conversationOf(SEARCH_BOT_A)).dataset.landOn).toBe(
      "post-1",
    );
    expect(paintedWords()).toEqual(["release"]);
    // The results stay beside the channel the person was taken to.
    expect(panel()).toBeTruthy();
    expect(hitRows()[0].getAttribute("aria-current")).toBe("true");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHAT_NAVIGATION_HIGHLIGHT_DURATION_MS);
    });

    expect(paintedWords()).toEqual([]);
  });

  it.each([
    ["is the word the highlight names", "İzmir", { start: 0, end: 5 }, "İzmir"],
    [
      "comes after the capital İ in the same text",
      "İzmir ankara",
      { start: 6, end: 12 },
      "ankara",
    ],
  ] as const)(
    "marks exactly the word on a row whose text %s",
    async (_where, text, highlight, marked) => {
      mocks.state.rows = new Map([
        [conversationOf(SEARCH_BOT_A), [{ messageId: "post-1", text }]],
      ]);
      mocks.state.answer = answerWith(
        searchResponse({
          hits: [
            searchHit({
              messageId: "post-1",
              snippet: { text, highlights: [highlight] },
              score: 5,
            }),
          ],
          total: 1,
        }),
      );
      await openWithResults("izmir");

      fireEvent.click(hitRows()[0]);
      await settle();

      expect(paintedWords()).toEqual([marked]);
    },
  );

  it("opens a thread's result in the rail at the reply, and the back link brings the results back with the query, filters and scroll", async () => {
    mocks.state.threads = [thread("thread-1", "post-7")];
    mocks.state.answer = answerWith(
      searchResponse({ hits: [THREAD_HIT, SEARCH_RESULT_A], total: 2 }),
    );
    // jsdom keeps no scroll position of its own.
    const scrolls = new WeakMap<Element, number>();
    vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(
      function (this: Element) {
        return scrolls.get(this) ?? 0;
      },
    );
    vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(
      function (this: Element, value: number) {
        scrolls.set(this, value);
      },
    );
    await openWithResults("release");
    pickFilter("bot-search-filter-from", "Me");
    await settle();
    fireEvent.scroll(screen.getByTestId("bot-search-results"), {
      target: { scrollTop: 120 },
    });

    fireEvent.click(hitRows()[0]);
    await settle();

    expect(screen.queryByTestId("bot-search-panel")).toBeNull();
    expect(screen.getByTestId("bot-thread-panel")).toBeTruthy();
    const replies = transcriptOf("thread-1");
    expect(replies.dataset.landOn).toBe("reply-2");
    expect(screen.getByTestId("bot-search-back").textContent).toBe(
      "2 results for “release”",
    );

    fireEvent.click(screen.getByTestId("bot-search-back"));
    await settle();

    expect(screen.queryByTestId("bot-thread-panel")).toBeNull();
    expect(screen.getByTestId("bot-search-input")).toHaveProperty(
      "value",
      "release",
    );
    expect(hitRows()).toHaveLength(2);
    expect(screen.getByTestId("bot-search-filter-from").textContent).toBe(
      "FromMe",
    );
    expect(scrolls.get(screen.getByTestId("bot-search-results"))).toBe(120);
    // Back is a read of the pages it already holds: the query and the one
    // filter change are the only two asks.
    expect(mocks.asked).toHaveLength(2);
  });

  it("keeps the results when the result's thread is in no list, and says so on its row", async () => {
    mocks.state.threads = [];
    mocks.state.answer = answerWith(
      searchResponse({ hits: [THREAD_HIT], total: 1 }),
    );
    await openWithResults("release");

    fireEvent.click(hitRows()[0]);
    await settle();

    expect(panel()).toBeTruthy();
    expect(screen.queryByTestId("bot-thread-panel")).toBeNull();
    expect(within(hitRows()[0]).getByRole("alert").textContent).toBe(
      "Couldn't open this thread.",
    );
  });

  it("steps through the results with ↑ and ↓ from the input, landing each", async () => {
    mocks.state.answer = answerWith(
      searchResponse({
        hits: [
          searchHit({ messageId: "post-1", score: 9 }),
          searchHit({ messageId: "post-2", score: 8 }),
          searchHit({ messageId: "post-3", score: 7 }),
        ],
        total: 3,
      }),
    );
    await openWithResults("release");
    const input = screen.getByTestId("bot-search-input");
    const channel = (): string | undefined =>
      transcriptOf(conversationOf(SEARCH_BOT_A)).dataset.landOn;
    const current = (): string[] =>
      hitRows()
        .filter((row) => row.getAttribute("aria-current") === "true")
        .map((row) => row.dataset.messageId ?? "");

    const steps: Array<[string, string, string]> = [
      ["ArrowDown", "post-1", "post-1"],
      ["ArrowDown", "post-2", "post-2"],
      ["ArrowDown", "post-3", "post-3"],
      ["ArrowDown", "post-3", "post-3"],
      ["ArrowUp", "post-2", "post-2"],
    ];
    for (const [key, selected, landed] of steps) {
      fireEvent.keyDown(input, { key });
      await settle();
      expect([current(), channel()]).toEqual([[selected], landed]);
    }
    expect(document.activeElement).toBe(input);
  });

  it("opens the first result on Enter, or the one stepped to, and records the search", async () => {
    mocks.state.answer = answerWith(
      searchResponse({
        hits: [
          searchHit({ messageId: "post-1", score: 9 }),
          searchHit({ messageId: "post-2", score: 8 }),
        ],
        total: 2,
      }),
    );
    await openWithResults("  release ");
    const input = screen.getByTestId("bot-search-input");
    const channel = (): string | undefined =>
      transcriptOf(conversationOf(SEARCH_BOT_A)).dataset.landOn;

    fireEvent.keyDown(input, { key: "Enter" });
    await settle();
    expect(channel()).toBe("post-1");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    await settle();

    expect(channel()).toBe("post-2");
    expect(useBotSearchStore.getState().recents).toEqual([
      { query: "release", scope: { kind: "all" }, scopeTitle: null },
    ]);
  });

  describe("recording the search on Enter", () => {
    const rememberOf = useBotSearchStore.getState().remember;

    afterEach(() => {
      useBotSearchStore.setState({ remember: rememberOf });
    });

    it.each([
      ["a result to open", [searchHit({ messageId: "post-1", score: 9 })], 1],
      ["no result", [], 0],
    ] as const)("records it once with %s", async (_case, hits, total) => {
      const remember = vi.fn(rememberOf);
      useBotSearchStore.setState({ remember });
      mocks.state.answer = answerWith(
        searchResponse({ hits: [...hits], total }),
      );
      await openWithResults("release");

      fireEvent.keyDown(screen.getByTestId("bot-search-input"), {
        key: "Enter",
      });
      await settle();

      expect(remember.mock.calls).toEqual([
        [{ query: "release", scope: { kind: "all" }, scopeTitle: null }],
      ]);
    });
  });

  it("moves the rail to the other bot's channel, opens it, and lands there with the results still beside it", async () => {
    mocks.state.rows = new Map([
      [
        conversationOf(SEARCH_BOT_B),
        [{ messageId: "note-1", text: "the release notes" }],
      ],
    ]);
    mocks.state.answer = answerWith(
      searchResponse({
        hits: [
          searchHit({
            botId: SEARCH_BOT_B,
            conversationId: conversationOf(SEARCH_BOT_B),
            messageId: "note-1",
            snippet: {
              text: "the release notes",
              highlights: [{ start: 4, end: 11 }],
            },
          }),
        ],
        total: 1,
      }),
    );
    await openWithResults("release");

    fireEvent.click(hitRows()[0]);
    await settle();

    expect(mocks.activateTabIntent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "tracy", botId: SEARCH_BOT_B }),
    );
    expect(screen.getByTestId("bot-tab-title").textContent).toContain(
      "Notes Bot",
    );
    expect(transcriptOf(conversationOf(SEARCH_BOT_B)).dataset.landOn).toBe(
      "note-1",
    );
    expect(paintedWords()).toEqual(["release"]);
    expect(screen.getByTestId("bot-search-input")).toHaveProperty(
      "value",
      "release",
    );
    const { byBotId } = useBotOpenThreadStore.getState();
    expect(byBotId[SEARCH_BOT_A]).toBeUndefined();
    expect(byBotId[SEARCH_BOT_B]?.kind).toBe("search");
  });
});

describe("a result's row", () => {
  it("names its sender, where it is, its thread and its replies, and marks the match", async () => {
    mocks.state.answer = answerWith(
      searchResponse({
        hits: [
          searchHit({
            messageId: "bot-row",
            senderUserId: null,
            rowKind: "announcement",
            score: 9,
            snippet: { text: "release 4.2 is out", highlights: [] },
          }),
          searchHit({
            messageId: "member-row",
            senderUserId: "user-teammate",
            threadId: "thread-1",
            threadExcerpt: "Is the release ready?",
            rowKind: "question",
            score: 8,
            snippet: {
              text: "when does the release ship",
              highlights: [{ start: 14, end: 21 }],
            },
          }),
          searchHit({
            messageId: "own-row",
            senderUserId: "user-viewer",
            replyCount: 3,
            score: 7,
          }),
          searchHit({
            messageId: "gone-row",
            senderUserId: "user-gone",
            replyCount: 1,
            score: 6,
          }),
        ],
        total: 4,
      }),
    );
    render(<Surface />);
    fireEvent.change(screen.getByTestId("bot-column-search"), {
      target: { value: "release" },
    });
    await settle();

    const [botRow, memberRow, ownRow, goneRow] = hitRows();
    const sender = (row: HTMLElement): string | null | undefined =>
      within(row).getByTestId("bot-search-hit-sender").textContent;
    expect([botRow, memberRow, ownRow, goneRow].map(sender)).toEqual([
      "Release Bot",
      "Tess Teammate",
      "Vee Viewer",
      "user-gone",
    ]);
    // Searching every bot, a row says which bot it is in.
    expect(botRow.textContent).toContain("announcement");
    expect(within(botRow).queryByTestId("bot-search-hit-thread")).toBeNull();
    expect(
      within(memberRow).getByTestId("bot-search-hit-thread").textContent,
    ).toBe("in thread: Is the release ready?");
    expect(memberRow.textContent).toContain("question");
    expect(
      [...memberRow.querySelectorAll("mark")].map((mark) => mark.textContent),
    ).toEqual(["release"]);
    expect(ownRow.textContent).toContain("3 replies");
    expect(goneRow.textContent).toContain("1 reply");
    expect(screen.getByTestId("bot-search-count").textContent).toBe(
      "4 results",
    );
  });

  it("says which bot a member's row is in when searching every bot, and leaves it off the bot's own row, whose sender already names it", async () => {
    mocks.state.answer = answerWith(
      searchResponse({
        hits: [
          searchHit({ messageId: "bot-row", senderUserId: null, score: 9 }),
          searchHit({
            messageId: "member-row",
            senderUserId: "user-teammate",
            score: 8,
          }),
        ],
        total: 2,
      }),
    );
    render(<Surface />);
    fireEvent.change(screen.getByTestId("bot-column-search"), {
      target: { value: "release" },
    });
    await settle();

    const [botRow, memberRow] = hitRows();
    const botNames = (row: HTMLElement): Array<string | undefined> =>
      within(row)
        .queryAllByText("Release Bot")
        .map((element) => element.dataset.testid);
    expect(botNames(botRow)).toEqual(["bot-search-hit-sender"]);
    expect(botNames(memberRow)).toEqual([undefined]);
  });

  it("leaves the bot's name off a row when the search is of that bot's channel", async () => {
    render(<Surface />);
    fireEvent.click(
      screen.getByRole("button", { name: "Search in Release Bot" }),
    );
    await typeIntoPanel("release");

    const row = hitRows()[0];
    expect(row.textContent).not.toContain("Release Bot");
    expect(row.textContent).toContain("Tess Teammate");
  });
});

describe("on a phone", () => {
  let shell: ShellFormHarness;

  beforeEach(() => {
    shell = installShellForm(SHELL_WIDTH_MENU);
  });

  afterEach(() => {
    shell.dispose();
    setPhoneLayoutOnly(false);
  });

  it("takes the whole screen for a post's result, hides the results behind the channel at it, and Back returns with the query and filters kept", async () => {
    render(<Surface />);
    fireEvent.click(
      screen.getByRole("button", { name: "Search in Release Bot" }),
    );
    await typeIntoPanel("release");
    pickFilter("bot-search-filter-from", "Me");
    await settle();

    fireEvent.click(hitRows()[0]);
    await settle();

    expect(screen.queryByTestId("bot-search-panel")).toBeNull();
    expect(transcriptOf(conversationOf(SEARCH_BOT_A)).dataset.landOn).toBe(
      "post-1",
    );
    expect(screen.getByTestId("bot-search-back").textContent).toBe(
      "1 result for “release”",
    );

    fireEvent.click(screen.getByTestId("bot-search-back"));
    await settle();

    expect(screen.queryByTestId("bot-search-back")).toBeNull();
    expect(screen.getByTestId("bot-search-input")).toHaveProperty(
      "value",
      "release",
    );
    expect(screen.getByTestId("bot-search-filter-from").textContent).toBe(
      "FromMe",
    );
    expect(screen.getByTestId("bot-search-scope-chip").textContent).toBe(
      "in Release Bot",
    );
    expect(hitRows()).toHaveLength(1);
  });
});
