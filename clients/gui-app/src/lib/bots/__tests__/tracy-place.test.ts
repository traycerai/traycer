import { describe, expect, it } from "vitest";
import {
  normalizeTracyPlaceSearch,
  railOfTracyPlace,
  tracyPlaceOfSearch,
  tracyPlaceRailOf,
  tracyPlaceSearch,
  type TracyPlace,
  type TracyPlaceRail,
} from "@/lib/bots/tracy-place";
import type {
  BotOpenThread,
  BotRail,
  BotSentPost,
} from "@/stores/bots/bot-open-thread-store";

const SENT: BotSentPost = {
  threadId: "thread-1",
  requestId: "request-1",
  text: "hello",
  senderUserId: null,
  sentAt: 1,
  delivery: "written",
};

function openThread(
  anchorMessageId: string,
  overrides: Partial<BotOpenThread>,
): BotOpenThread {
  return {
    anchorMessageId,
    announcement: false,
    anchorKind: null,
    sent: null,
    ...overrides,
  };
}

const BARE_PLACE: TracyPlace = {
  view: "messages",
  threadsShown: false,
  session: null,
  thread: null,
  memory: false,
  exchangePeerBotId: null,
};

const FULL_PLACE: TracyPlace = {
  view: "activity",
  threadsShown: true,
  session: { chatId: "chat-1", threadId: "session-thread-1" },
  thread: { anchorMessageId: "m-1", announcement: true, anchorKind: "answer" },
  memory: true,
  exchangePeerBotId: "bot-peer",
};

const NO_SEARCH = {
  view: undefined,
  threads: undefined,
  session: undefined,
  sessionThread: undefined,
  thread: undefined,
  threadAnnouncement: undefined,
  threadAnchor: undefined,
  memory: undefined,
  exchange: undefined,
};

describe("a place and the route search that carries it", () => {
  it("round-trips a place with every field set", () => {
    expect(tracyPlaceOfSearch(tracyPlaceSearch(FULL_PLACE))).toEqual(
      FULL_PLACE,
    );
  });

  it("round-trips the bare place, which writes only its view", () => {
    expect(tracyPlaceSearch(BARE_PLACE)).toEqual({
      ...NO_SEARCH,
      view: "messages",
    });
    expect(tracyPlaceOfSearch(tracyPlaceSearch(BARE_PLACE))).toEqual(
      BARE_PLACE,
    );
  });

  it.each<readonly [string, TracyPlace]>([
    ["the Activity view", { ...BARE_PLACE, view: "activity" }],
    ["the Threads page", { ...BARE_PLACE, threadsShown: true }],
    [
      "a session of the trunk",
      { ...BARE_PLACE, session: { chatId: "chat-1", threadId: null } },
    ],
    [
      "a session of a thread",
      { ...BARE_PLACE, session: { chatId: "chat-1", threadId: "t-1" } },
    ],
    [
      "a thread of a post",
      {
        ...BARE_PLACE,
        thread: {
          anchorMessageId: "m-1",
          announcement: false,
          anchorKind: null,
        },
      },
    ],
    [
      "a thread of an announcement with an anchor kind",
      {
        ...BARE_PLACE,
        thread: {
          anchorMessageId: "m-1",
          announcement: true,
          anchorKind: "message",
        },
      },
    ],
    ["the memory", { ...BARE_PLACE, memory: true }],
    ["a pair's log", { ...BARE_PLACE, exchangePeerBotId: "bot-peer" }],
  ])("round-trips %s", (_name, place) => {
    expect(tracyPlaceOfSearch(tracyPlaceSearch(place))).toEqual(place);
  });

  it("writes a flag only when it is on", () => {
    expect(tracyPlaceSearch(BARE_PLACE)).toMatchObject({
      threads: undefined,
      threadAnnouncement: undefined,
      memory: undefined,
    });
    expect(tracyPlaceSearch(FULL_PLACE)).toMatchObject({
      threads: true,
      threadAnnouncement: true,
      memory: true,
    });
  });

  it("names no place when the view is absent, whatever else the search holds", () => {
    expect(tracyPlaceOfSearch({})).toBeNull();
    expect(
      tracyPlaceOfSearch({ thread: "m-1", threads: true, memory: true }),
    ).toBeNull();
  });

  it("names no place when the view is not one of the channel's", () => {
    expect(tracyPlaceOfSearch({ view: "threads" })).toBeNull();
    expect(tracyPlaceOfSearch({ view: 1 })).toBeNull();
  });

  it("drops keys it does not know and values of the wrong type", () => {
    expect(
      normalizeTracyPlaceSearch({
        view: "activity",
        threads: "true",
        session: 7,
        sessionThread: "",
        thread: ["m-1"],
        threadAnnouncement: false,
        threadAnchor: null,
        memory: 1,
        exchange: {},
        focusArtifactId: "a-1",
        unknown: "x",
      }),
    ).toEqual({ ...NO_SEARCH, view: "activity" });
  });

  it("keeps an empty string out of a place", () => {
    expect(
      tracyPlaceOfSearch({ view: "messages", thread: "", exchange: "" }),
    ).toEqual(BARE_PLACE);
  });
});

describe("the place a rail contributes", () => {
  const thread = openThread("m-1", {
    announcement: true,
    anchorKind: "answer",
    sent: SENT,
  });
  const placeThread = {
    anchorMessageId: "m-1",
    announcement: true,
    anchorKind: "answer",
  };

  it("is nothing for an empty rail", () => {
    expect(tracyPlaceRailOf(null)).toEqual({
      thread: null,
      memory: false,
      exchangePeerBotId: null,
    });
  });

  it("is the thread of a thread panel, without the post its send was accepted with", () => {
    expect(tracyPlaceRailOf({ kind: "thread", ...thread })).toEqual({
      thread: placeThread,
      memory: false,
      exchangePeerBotId: null,
    });
  });

  it("is the memory over the thread it displaced", () => {
    expect(tracyPlaceRailOf({ kind: "memory", back: thread })).toEqual({
      thread: placeThread,
      memory: true,
      exchangePeerBotId: null,
    });
  });

  it("is the memory alone when it displaced nothing", () => {
    expect(tracyPlaceRailOf({ kind: "memory", back: null })).toEqual({
      thread: null,
      memory: true,
      exchangePeerBotId: null,
    });
  });

  it("is the pair's log over the memory over the thread", () => {
    const rail: BotRail = {
      kind: "exchange",
      peerBotId: "bot-peer",
      back: { kind: "memory", back: thread },
    };
    expect(tracyPlaceRailOf(rail)).toEqual({
      thread: placeThread,
      memory: true,
      exchangePeerBotId: "bot-peer",
    });
  });

  it("is the pair's log alone when it displaced nothing", () => {
    expect(
      tracyPlaceRailOf({ kind: "exchange", peerBotId: "bot-peer", back: null }),
    ).toEqual({ thread: null, memory: false, exchangePeerBotId: "bot-peer" });
  });

  it("is what a search displaced while the search shows its results", () => {
    expect(
      tracyPlaceRailOf({
        kind: "search",
        back: { kind: "thread", ...thread },
        showing: { kind: "results" },
      }),
    ).toEqual({ thread: placeThread, memory: false, exchangePeerBotId: null });
  });

  it("is what a search displaced while the channel shows at a result", () => {
    expect(
      tracyPlaceRailOf({
        kind: "search",
        back: { kind: "memory", back: null },
        showing: { kind: "channel" },
      }),
    ).toEqual({ thread: null, memory: true, exchangePeerBotId: null });
  });

  it("is nothing for a search over nothing", () => {
    expect(
      tracyPlaceRailOf({
        kind: "search",
        back: null,
        showing: { kind: "results" },
      }),
    ).toEqual({ thread: null, memory: false, exchangePeerBotId: null });
  });

  it("is the thread a search result opened, not the one it displaced", () => {
    const opened = openThread("m-2", { announcement: false, anchorKind: null });
    expect(
      tracyPlaceRailOf({
        kind: "search",
        back: { kind: "thread", ...thread },
        showing: { kind: "thread", thread: opened },
      }),
    ).toEqual({
      thread: {
        anchorMessageId: "m-2",
        announcement: false,
        anchorKind: null,
      },
      memory: false,
      exchangePeerBotId: null,
    });
  });
});

describe("the rail a place names", () => {
  const placeThread = {
    anchorMessageId: "m-1",
    announcement: true,
    anchorKind: "answer",
  };

  it("is no rail for a place with nothing in it", () => {
    expect(
      railOfTracyPlace(
        { thread: null, memory: false, exchangePeerBotId: null },
        null,
      ),
    ).toBeNull();
  });

  it("opens a thread as the lists have it when the rail holds none", () => {
    expect(
      railOfTracyPlace(
        { thread: placeThread, memory: false, exchangePeerBotId: null },
        null,
      ),
    ).toEqual({ kind: "thread", ...placeThread, sent: null });
  });

  it("keeps the post a held thread's send was accepted with", () => {
    const held: BotRail = {
      kind: "thread",
      ...openThread("m-1", {
        announcement: true,
        anchorKind: "answer",
        sent: SENT,
      }),
    };
    expect(
      railOfTracyPlace(
        { thread: placeThread, memory: false, exchangePeerBotId: null },
        held,
      ),
    ).toEqual({ kind: "thread", ...placeThread, sent: SENT });
  });

  it("keeps the post of a thread held behind the memory or a pair's log", () => {
    const held: BotRail = {
      kind: "exchange",
      peerBotId: "bot-peer",
      back: {
        kind: "memory",
        back: openThread("m-1", { announcement: true, sent: SENT }),
      },
    };
    const rail = railOfTracyPlace(
      { thread: placeThread, memory: false, exchangePeerBotId: null },
      held,
    );
    expect(rail).toEqual({ kind: "thread", ...placeThread, sent: SENT });
  });

  it("keeps the post of the thread a search result opened", () => {
    const held: BotRail = {
      kind: "search",
      back: null,
      showing: {
        kind: "thread",
        thread: openThread("m-1", { announcement: true, sent: SENT }),
      },
    };
    expect(
      railOfTracyPlace(
        { thread: placeThread, memory: false, exchangePeerBotId: null },
        held,
      ),
    ).toEqual({ kind: "thread", ...placeThread, sent: SENT });
  });

  it("does not lend the post of another thread", () => {
    const held: BotRail = {
      kind: "thread",
      ...openThread("m-other", { sent: SENT }),
    };
    expect(
      railOfTracyPlace(
        { thread: placeThread, memory: false, exchangePeerBotId: null },
        held,
      ),
    ).toEqual({ kind: "thread", ...placeThread, sent: null });
  });

  it("builds the pair's log over the memory over the thread, keeping the thread's post", () => {
    const place: TracyPlaceRail = {
      thread: placeThread,
      memory: true,
      exchangePeerBotId: "bot-peer",
    };
    const held: BotRail = {
      kind: "thread",
      ...openThread("m-1", { announcement: true, sent: SENT }),
    };
    expect(railOfTracyPlace(place, held)).toEqual({
      kind: "exchange",
      peerBotId: "bot-peer",
      back: {
        kind: "memory",
        back: { ...placeThread, sent: SENT },
      },
    });
  });

  it("builds the memory over nothing, and the pair's log over nothing", () => {
    expect(
      railOfTracyPlace(
        { thread: null, memory: true, exchangePeerBotId: null },
        null,
      ),
    ).toEqual({ kind: "memory", back: null });
    expect(
      railOfTracyPlace(
        { thread: null, memory: false, exchangePeerBotId: "bot-peer" },
        null,
      ),
    ).toEqual({ kind: "exchange", peerBotId: "bot-peer", back: null });
  });

  it("reads back as the place it was built from", () => {
    const place: TracyPlaceRail = {
      thread: placeThread,
      memory: true,
      exchangePeerBotId: "bot-peer",
    };
    expect(tracyPlaceRailOf(railOfTracyPlace(place, null))).toEqual(place);
  });
});
