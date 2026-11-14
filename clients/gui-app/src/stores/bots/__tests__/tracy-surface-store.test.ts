import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { persistKey, STORE_KEYS } from "@/lib/persist";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import {
  tracySessionOf,
  tracyViewOf,
  useTracyPlaceStore,
} from "@/stores/bots/tracy-place-store";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";

function resetStores(): void {
  window.localStorage.clear();
  useTracySurfaceStore.setState({
    open: false,
    hostId: null,
    botId: null,
    visitedBotIds: [],
    goneReports: {},
  });
  useTracyPlaceStore.setState(useTracyPlaceStore.getInitialState(), true);
  useBotOpenThreadStore.setState(useBotOpenThreadStore.getInitialState(), true);
  useBotDraftsStore.setState(useBotDraftsStore.getInitialState(), true);
}

const surface = useTracySurfaceStore.getState;

const place = useTracyPlaceStore.getState;

/** `botId`'s view and session, as the surface's place holds them. */
function placeOf(botId: string) {
  return {
    view: tracyViewOf(place().viewByBotId, botId),
    session: tracySessionOf(place().sessionByBotId, botId),
  };
}

beforeEach(resetStores);
afterEach(resetStores);

describe("selecting a Tracy channel", () => {
  const SESSION = { chatId: "chat-1", threadId: null };

  it("resets the channel left to Messages with no session, and leaves Threads", () => {
    surface().selectChannel("bot-a");
    place().setView("bot-a", "activity");
    place().setSession("bot-a", SESSION);
    place().setThreadsShown(true);

    surface().selectChannel("bot-b");

    expect(surface().botId).toBe("bot-b");
    expect(placeOf("bot-a")).toEqual({ view: "messages", session: null });
    expect(place().threadsShown).toBe(false);
  });

  it("leaves the channel it selects, and every other channel, as it was", () => {
    place().setView("bot-b", "activity");
    place().setSession("bot-c", SESSION);
    surface().selectChannel("bot-a");

    surface().selectChannel("bot-b");

    expect(placeOf("bot-b").view).toBe("activity");
    expect(placeOf("bot-c").session).toEqual(SESSION);
  });

  it("keeps the rail of the channel it leaves", () => {
    surface().selectChannel("bot-a");
    useBotOpenThreadStore
      .getState()
      .setRail("bot-a", { kind: "memory", back: null });

    surface().selectChannel("bot-b");

    expect(useBotOpenThreadStore.getState().byBotId["bot-a"]).toEqual({
      kind: "memory",
      back: null,
    });
  });

  it("leaves Threads when it selects a channel from none", () => {
    place().setThreadsShown(true);

    surface().selectChannel("bot-a");

    expect(place().threadsShown).toBe(false);
  });

  it("changes nothing when the channel is already the selected one", () => {
    surface().selectChannel("bot-a");
    place().setView("bot-a", "activity");
    place().setThreadsShown(true);

    surface().selectChannel("bot-a");

    expect(placeOf("bot-a").view).toBe("activity");
    expect(place().threadsShown).toBe(true);
  });
});

describe("the bots shown gone", () => {
  it("records a bot forgotten as gone against its list, and drops it from the visited", () => {
    surface().markVisited("bot-a");
    surface().markVisited("bot-b");

    surface().forgetBot("bot-a", 10);
    const gone = surface().goneReports;

    expect(gone).toEqual({ "bot-a": 10 });
    expect(surface().visitedBotIds).toEqual(["bot-b"]);

    surface().forgetBot("bot-a", 10);
    expect(surface().goneReports).toBe(gone);
  });

  it("records a bot gone that was never visited", () => {
    surface().forgetBot("bot-never-shown", 10);

    expect(surface().goneReports).toEqual({ "bot-never-shown": 10 });
  });

  it("forgets the channel's view and session with the bot", () => {
    place().setView("bot-a", "activity");
    place().setSession("bot-a", { chatId: "chat-1", threadId: null });

    surface().forgetBot("bot-a", 10);

    expect(placeOf("bot-a")).toEqual({ view: "messages", session: null });
  });

  it("takes out of the gone only the bots a later list carries", () => {
    surface().forgetBot("bot-a", 10);
    surface().forgetBot("bot-b", 10);
    surface().forgetBot("bot-c", 10);

    surface().settleListedBots(new Set(["bot-b", "bot-listed-never-gone"]), 11);

    expect(surface().goneReports).toEqual({ "bot-a": 10, "bot-c": 10 });
  });

  it("keeps a bot gone against a list that answered at the same time as the report", () => {
    surface().forgetBot("bot-a", 10);

    surface().settleListedBots(new Set(["bot-a"]), 10);

    expect(surface().goneReports).toEqual({ "bot-a": 10 });
  });

  it("keeps a bot gone against a list that answered before the report", () => {
    surface().forgetBot("bot-a", 10);

    surface().settleListedBots(new Set(["bot-a"]), 9);

    expect(surface().goneReports).toEqual({ "bot-a": 10 });
  });

  it("leaves a bot gone when a later list does not carry it", () => {
    surface().forgetBot("bot-a", 10);
    const gone = surface().goneReports;

    surface().settleListedBots(new Set(["bot-b"]), 11);

    expect(surface().goneReports).toBe(gone);
  });

  it("forgets every bot gone when the surface closes, even with nothing else to close", () => {
    surface().forgetBot("bot-a", 10);
    expect(surface().open).toBe(false);

    surface().closeSurface();

    expect(surface().goneReports).toEqual({});
  });

  it("closes the surface's place with it", () => {
    surface().openSurface("host-1");
    surface().selectChannel("bot-a");
    place().setView("bot-a", "activity");
    place().setThreadsShown(true);

    surface().closeSurface();

    expect(placeOf("bot-a").view).toBe("messages");
    expect(place().threadsShown).toBe(false);
  });

  it("is not kept across a restart", () => {
    surface().openSurface("host-1");
    surface().selectChannel("bot-a");
    surface().forgetBot("bot-b", 10);

    const stored = window.localStorage.getItem(persistKey(STORE_KEYS.botTabs));

    expect(stored).not.toBeNull();
    expect(stored).toContain("bot-a");
    expect(stored).not.toContain("goneReports");
    expect(stored).not.toContain("bot-b");
  });
});
