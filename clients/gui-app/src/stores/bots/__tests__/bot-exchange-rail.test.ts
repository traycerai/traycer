import { describe, expect, it } from "vitest";
import {
  exchangeRailOver,
  memoryRailOver,
  searchRailOver,
  type BotRail,
} from "@/stores/bots/bot-open-thread-store";

const RELEASE_BOT_ID = "bot_01JC0000000000000000000001";
const DOCS_BOT_ID = "bot_01JC0000000000000000000002";

const THREAD: BotRail = {
  kind: "thread",
  anchorMessageId: "post-1",
  announcement: false,
  anchorKind: null,
  sent: null,
};

describe("exchangeRailOver", () => {
  it("keeps the rail it displaces, to which closing the log returns", () => {
    expect(exchangeRailOver(THREAD, RELEASE_BOT_ID)).toEqual({
      kind: "exchange",
      peerBotId: RELEASE_BOT_ID,
      back: THREAD,
    });
    expect(exchangeRailOver(null, RELEASE_BOT_ID)).toEqual({
      kind: "exchange",
      peerBotId: RELEASE_BOT_ID,
      back: null,
    });
  });

  it("replaces an open log with the other pair's and still returns to the rail before the first", () => {
    const first = exchangeRailOver(THREAD, RELEASE_BOT_ID);

    expect(exchangeRailOver(first, DOCS_BOT_ID)).toEqual({
      kind: "exchange",
      peerBotId: DOCS_BOT_ID,
      back: THREAD,
    });
  });
});

describe("memoryRailOver a pair's log", () => {
  it("returns to the thread the log displaced, not to the log", () => {
    const log = exchangeRailOver(THREAD, RELEASE_BOT_ID);

    expect(memoryRailOver(log)).toEqual({
      kind: "memory",
      back: {
        anchorMessageId: "post-1",
        announcement: false,
        anchorKind: null,
        sent: null,
      },
    });
  });

  it("returns to the thread under a search the log displaced, not to the results or the log", () => {
    const log = exchangeRailOver(searchRailOver(THREAD), RELEASE_BOT_ID);

    expect(memoryRailOver(log)).toEqual({
      kind: "memory",
      back: {
        anchorMessageId: "post-1",
        announcement: false,
        anchorKind: null,
        sent: null,
      },
    });
  });
});
