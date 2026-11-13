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
    goneBotIds: [],
  });
  useTracyPlaceStore.setState(useTracyPlaceStore.getInitialState(), true);
  useBotOpenThreadStore.setState(useBotOpenThreadStore.getInitialState(), true);
  useBotDraftsStore.setState(useBotDraftsStore.getInitialState(), true);
}

function surface() {
  return useTracySurfaceStore.getState();
}

function place() {
  return useTracyPlaceStore.getState();
}

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
  it("records a bot forgotten as gone, once, and drops it from the visited", () => {
    surface().markVisited("bot-a");
    surface().markVisited("bot-b");

    surface().forgetBot("bot-a");
    const gone = surface().goneBotIds;

    expect(gone).toEqual(["bot-a"]);
    expect(surface().visitedBotIds).toEqual(["bot-b"]);

    surface().forgetBot("bot-a");
    expect(surface().goneBotIds).toBe(gone);
  });

  it("records a bot gone that was never visited", () => {
    surface().forgetBot("bot-never-shown");

    expect(surface().goneBotIds).toEqual(["bot-never-shown"]);
  });

  it("forgets the channel's view and session with the bot", () => {
    place().setView("bot-a", "activity");
    place().setSession("bot-a", { chatId: "chat-1", threadId: null });

    surface().forgetBot("bot-a");

    expect(placeOf("bot-a")).toEqual({ view: "messages", session: null });
  });

  it("takes out of the gone only the bots a list carries", () => {
    surface().forgetBot("bot-a");
    surface().forgetBot("bot-b");
    surface().forgetBot("bot-c");

    surface().settleListedBots(new Set(["bot-b", "bot-listed-never-gone"]));

    expect(surface().goneBotIds).toEqual(["bot-a", "bot-c"]);
  });

  it("leaves the gone as they are when a list carries none of them", () => {
    surface().forgetBot("bot-a");
    const gone = surface().goneBotIds;

    surface().settleListedBots(new Set(["bot-b"]));

    expect(surface().goneBotIds).toBe(gone);
  });

  it("forgets every bot gone when the surface closes, even with nothing else to close", () => {
    surface().forgetBot("bot-a");
    expect(surface().open).toBe(false);

    surface().closeSurface();

    expect(surface().goneBotIds).toEqual([]);
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
    surface().forgetBot("bot-b");

    const stored = window.localStorage.getItem(persistKey(STORE_KEYS.botTabs));

    expect(stored).not.toBeNull();
    expect(stored).toContain("bot-a");
    expect(stored).not.toContain("goneBotIds");
    expect(stored).not.toContain("bot-b");
  });
});
