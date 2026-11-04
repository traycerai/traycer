import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { persistKey, STORE_KEYS } from "@/lib/persist";
import { botSearchHitKey } from "@/lib/bots/bot-search-model";
import {
  SEARCH_BOT_A,
  SEARCH_BOT_B,
  searchHit,
} from "@/lib/bots/__tests__/bot-search-test-support";
import {
  memoryRailOver,
  searchRailOver,
  useBotOpenThreadStore,
  type BotOpenThread,
  type BotRail,
} from "@/stores/bots/bot-open-thread-store";
import {
  BOT_SEARCH_NO_FILTERS,
  BOT_SEARCH_RECENTS_LIMIT,
  closeBotSearch,
  jumpToBotSearchHit,
  openBotSearch,
  showBotSearchResults,
  useBotSearchStore,
  type BotSearchRecent,
} from "@/stores/bots/bot-search-store";

const RECENTS_KEY = persistKey(STORE_KEYS.botSearchRecents);

const ALL = { kind: "all" } as const;
const IN_A = { kind: "bot", botId: SEARCH_BOT_A } as const;

const OPEN_THREAD: BotOpenThread = {
  anchorMessageId: "post-7",
  announcement: false,
  anchorKind: null,
  sent: null,
};

function recent(
  query: string,
  scope: BotSearchRecent["scope"],
): BotSearchRecent {
  return {
    query,
    scope,
    scopeTitle: scope.kind === "bot" ? "Release Bot" : null,
  };
}

function railOf(botId: string): BotRail | null {
  const { byBotId } = useBotOpenThreadStore.getState();
  return Object.hasOwn(byBotId, botId) ? byBotId[botId] : null;
}

beforeEach(() => {
  localStorage.clear();
  useBotSearchStore.getState().reset();
  useBotSearchStore.setState({
    recents: [],
    opens: 0,
    focusAsked: 0,
    focusAnswered: 0,
  });
  useBotOpenThreadStore.setState({ byBotId: {} });
});

describe("the recent searches", () => {
  it("keeps the newest first, one per query and scope, and no more than ten", () => {
    const { remember } = useBotSearchStore.getState();

    remember(recent("release", ALL));
    remember(recent("release", IN_A));
    remember(recent("deploy", ALL));
    // Run again: it moves to the front instead of repeating.
    remember(recent("release", ALL));

    expect(
      useBotSearchStore
        .getState()
        .recents.map((entry) => [entry.query, entry.scope.kind]),
    ).toEqual([
      ["release", "all"],
      ["deploy", "all"],
      ["release", "bot"],
    ]);

    for (let at = 0; at < BOT_SEARCH_RECENTS_LIMIT + 3; at += 1) {
      remember(recent(`query ${String(at)}`, ALL));
    }
    const kept = useBotSearchStore.getState().recents;
    expect(kept).toHaveLength(10);
    expect(kept.at(0)?.query).toBe(
      `query ${String(BOT_SEARCH_RECENTS_LIMIT + 2)}`,
    );
    expect(kept.at(-1)?.query).toBe("query 3");
  });

  it("is the one thing kept across a restart: the query, scope and filters of an open search are not", async () => {
    const store = useBotSearchStore.getState();
    store.remember(recent("release", IN_A));
    store.remember(recent("deploy", ALL));
    openBotSearch(SEARCH_BOT_A, IN_A, "half typed");
    useBotSearchStore.getState().setFilters({ from: "me", date: "7d" });

    const written = localStorage.getItem(RECENTS_KEY) ?? "";
    const stored = z
      .object({ state: z.record(z.string(), z.unknown()) })
      .parse(JSON.parse(written));
    expect(Object.keys(stored.state)).toEqual(["recents"]);

    // A restart: the list is gone from memory and read back from storage.
    useBotSearchStore.setState({ recents: [] });
    localStorage.setItem(RECENTS_KEY, written);
    await useBotSearchStore.persist.rehydrate();

    expect(
      useBotSearchStore.getState().recents.map((entry) => entry.query),
    ).toEqual(["deploy", "release"]);
  });

  it.each([
    ["a record of another shape", { recents: "release" }],
    [
      "more entries than the list holds",
      {
        recents: Array.from({ length: BOT_SEARCH_RECENTS_LIMIT + 1 }, (_, at) =>
          recent(`query ${String(at)}`, ALL),
        ),
      },
    ],
    [
      "a scope no build names",
      { recents: [{ query: "x", scope: { kind: "team" }, scopeTitle: null }] },
    ],
  ])("reads %s as no searches", async (_name, state) => {
    useBotSearchStore.getState().remember(recent("kept", ALL));
    localStorage.setItem(RECENTS_KEY, JSON.stringify({ state, version: 1 }));

    await useBotSearchStore.persist.rehydrate();

    expect(useBotSearchStore.getState().recents).toEqual([]);
  });
});

describe("opening and closing the search in a bot's rail", () => {
  it("opens over a thread and gives it back on close, dropping the search but not the recents", () => {
    useBotOpenThreadStore
      .getState()
      .setRail(SEARCH_BOT_A, { kind: "thread", ...OPEN_THREAD });
    useBotSearchStore.getState().remember(recent("release", ALL));

    openBotSearch(SEARCH_BOT_A, IN_A, "ship");
    expect(railOf(SEARCH_BOT_A)).toEqual({
      kind: "search",
      back: OPEN_THREAD,
      showing: { kind: "results" },
    });
    expect(useBotSearchStore.getState()).toMatchObject({
      scope: IN_A,
      query: "ship",
    });

    useBotSearchStore.getState().setFilters({ where: "posts" });
    closeBotSearch(SEARCH_BOT_A);

    expect(railOf(SEARCH_BOT_A)).toEqual({ kind: "thread", ...OPEN_THREAD });
    expect(useBotSearchStore.getState()).toMatchObject({
      scope: ALL,
      query: "",
      filters: BOT_SEARCH_NO_FILTERS,
    });
    expect(useBotSearchStore.getState().recents).toHaveLength(1);
  });

  it("leaves no rail behind when it displaced nothing", () => {
    openBotSearch(SEARCH_BOT_A, ALL, null);
    expect(railOf(SEARCH_BOT_A)).toEqual({
      kind: "search",
      back: null,
      showing: { kind: "results" },
    });

    closeBotSearch(SEARCH_BOT_A);

    expect(railOf(SEARCH_BOT_A)).toBeNull();
  });

  it("opened again while open keeps its query and filters unless it is asked for another query", () => {
    openBotSearch(SEARCH_BOT_A, ALL, "ship");
    useBotSearchStore.getState().setFilters({ from: "me", sort: "newest" });

    openBotSearch(SEARCH_BOT_A, IN_A, null);
    expect(useBotSearchStore.getState()).toMatchObject({
      scope: IN_A,
      query: "ship",
    });
    expect(useBotSearchStore.getState().filters.from).toBe("me");

    openBotSearch(SEARCH_BOT_A, ALL, "deploy");
    expect(useBotSearchStore.getState().query).toBe("deploy");
    expect(useBotSearchStore.getState().filters.sort).toBe("newest");
    expect(useBotSearchStore.getState().opens).toBe(3);
  });

  it("brings the results back from a thread or the channel it showed in their place", () => {
    openBotSearch(SEARCH_BOT_A, ALL, "ship");
    const open = railOf(SEARCH_BOT_A);
    if (open?.kind !== "search") throw new Error("the search did not open");
    useBotOpenThreadStore.getState().setRail(SEARCH_BOT_A, {
      ...open,
      showing: { kind: "thread", thread: OPEN_THREAD },
    });

    showBotSearchResults(SEARCH_BOT_A);

    expect(railOf(SEARCH_BOT_A)).toEqual(open);
  });

  it("does not turn a thread or the bot's memory into results", () => {
    useBotOpenThreadStore
      .getState()
      .setRail(SEARCH_BOT_A, { kind: "thread", ...OPEN_THREAD });

    showBotSearchResults(SEARCH_BOT_A);

    expect(railOf(SEARCH_BOT_A)).toEqual({ kind: "thread", ...OPEN_THREAD });
  });

  it("keeps the displaced thread through the memory and the search taking the rail from each other", () => {
    const thread: BotRail = { kind: "thread", ...OPEN_THREAD };
    const search = searchRailOver(thread);
    const memory = memoryRailOver(search);

    expect(search).toEqual({
      kind: "search",
      back: OPEN_THREAD,
      showing: { kind: "results" },
    });
    expect(memory).toEqual({ kind: "memory", back: OPEN_THREAD });
    expect(searchRailOver(memory)).toEqual(search);
    // A search showing a result's thread: that thread is what the memory gives back.
    expect(
      memoryRailOver({
        kind: "search",
        back: null,
        showing: { kind: "thread", thread: OPEN_THREAD },
      }),
    ).toEqual({ kind: "memory", back: OPEN_THREAD });
  });
});

describe("a result on its way to the channel or thread that shows it", () => {
  it("marks a post's words, lower-cased and once each, in the channel it is in", () => {
    const hit = searchHit({
      messageId: "post-3",
      snippet: {
        text: "Ship the RELEASE, then ship it again",
        highlights: [
          { start: 0, end: 4 },
          { start: 9, end: 16 },
          { start: 23, end: 27 },
        ],
      },
    });

    expect(jumpToBotSearchHit(SEARCH_BOT_A, hit, false)).toBe(false);

    expect(useBotSearchStore.getState()).toMatchObject({
      selectedKey: botSearchHitKey(hit),
      jump: { botId: SEARCH_BOT_A, threadId: null, messageId: "post-3" },
      marks: {
        chatId: "conversation-a",
        messageId: "post-3",
        words: ["ship", "release"],
      },
    });
  });

  it("marks a thread's reply in the thread's own chat", () => {
    const hit = searchHit({
      threadId: "thread-1",
      messageId: "reply-2",
      snippet: { text: "release notes", highlights: [{ start: 0, end: 7 }] },
    });

    jumpToBotSearchHit(SEARCH_BOT_A, hit, false);

    expect(useBotSearchStore.getState().marks).toEqual({
      chatId: "thread-1",
      messageId: "reply-2",
      words: ["release"],
    });
  });

  it("asks for the input's focus back only on a step of the keyboard's", () => {
    const hit = searchHit({});

    jumpToBotSearchHit(SEARCH_BOT_A, hit, false);
    expect(useBotSearchStore.getState().focusAsked).toBe(0);

    jumpToBotSearchHit(SEARCH_BOT_A, hit, true);
    expect(useBotSearchStore.getState().focusAsked).toBe(1);
  });

  it("moves the search to the other bot's rail, and gives the bot it left its thread back", () => {
    useBotOpenThreadStore
      .getState()
      .setRail(SEARCH_BOT_A, { kind: "thread", ...OPEN_THREAD });
    openBotSearch(SEARCH_BOT_A, ALL, "ship");

    const moved = jumpToBotSearchHit(
      SEARCH_BOT_A,
      searchHit({ botId: SEARCH_BOT_B }),
      false,
    );

    expect(moved).toBe(true);
    expect(railOf(SEARCH_BOT_A)).toEqual({ kind: "thread", ...OPEN_THREAD });
    expect(railOf(SEARCH_BOT_B)).toEqual({
      kind: "search",
      back: null,
      showing: { kind: "results" },
    });
    expect(useBotSearchStore.getState().query).toBe("ship");
  });

  it("drops the selection, the scroll and a missed thread when the query, scope or a filter changes", () => {
    const store = useBotSearchStore;
    const hit = searchHit({ threadId: "thread-1" });
    const stage = (): void => {
      jumpToBotSearchHit(SEARCH_BOT_A, hit, false);
      store.getState().missThread();
      store.getState().setScrollTop(300);
    };
    const changes = [
      () => store.getState().setQuery("deploy"),
      () => store.getState().setScope(IN_A),
      () => store.getState().setFilters({ date: "30d" }),
      () => store.getState().clearFilters(),
    ];

    for (const change of changes) {
      stage();
      expect(store.getState()).toMatchObject({
        selectedKey: botSearchHitKey(hit),
        missedKey: botSearchHitKey(hit),
        jump: null,
        marks: null,
        scrollTop: 300,
      });
      change();
      expect(store.getState()).toMatchObject({
        selectedKey: null,
        missedKey: null,
        scrollTop: 0,
      });
    }
  });
});
