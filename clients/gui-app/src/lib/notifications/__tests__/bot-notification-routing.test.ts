import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  parseNotificationPayload,
  routeNotificationForHost,
} from "@/lib/notifications/payload";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import {
  __resetTabSyncCoordinatorForTesting,
  installTabSyncCoordinator,
} from "@/lib/tab-sync/tab-sync-coordinator";
import { lookupBotTab, useBotTabsStore } from "@/stores/bots/bot-tabs-store";
import { useBotTabLandingStore } from "@/stores/bots/bot-tab-landing-store";

/**
 * A tapped push of a bot's conversation (Tracy Bots VN4) opens the bot's
 * tab, landed on the thread beside its channel; a window with no host to
 * open it on routes the row as a chat.
 */

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CHAT = { kind: "chat", epicId: BOT_ID, chatId: "thread-1" } as const;

beforeEach(async () => {
  __resetTabNavigationControllerForTesting();
  __resetTabSyncCoordinatorForTesting();
  installTabSyncCoordinator({ readyPromise: Promise.resolve() });
  await Promise.resolve();
  await Promise.resolve();
  useBotTabsStore.setState({ tabs: {} });
  useBotTabLandingStore.setState({ byBotId: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parsing a chat payload that names a bot", () => {
  it("reads the bot, its thread and the row", () => {
    expect(
      parseNotificationPayload({
        ...CHAT,
        botId: BOT_ID,
        threadId: "thread-1",
        messageId: "row-1",
      }),
    ).toMatchObject({
      kind: "chat",
      bot: { botId: BOT_ID, threadId: "thread-1", messageId: "row-1" },
    });
  });

  it("reads a row of the channel as a bot target with no thread", () => {
    expect(parseNotificationPayload({ ...CHAT, botId: BOT_ID })).toMatchObject({
      bot: { botId: BOT_ID, threadId: null, messageId: null },
    });
  });

  it("carries no bot target without a botId", () => {
    const parsed = parseNotificationPayload({
      ...CHAT,
      threadId: "thread-1",
      messageId: "row-1",
    });
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty("bot");
  });
});

describe("routing a chat payload that names a bot", () => {
  const payload = parseNotificationPayload({
    ...CHAT,
    botId: BOT_ID,
    threadId: "thread-1",
    messageId: "row-1",
  });

  function route(navigate: Mock, effectiveHostId: string | null): boolean {
    if (payload === null) throw new Error("the payload did not parse");
    return routeNotificationForHost(navigate, payload, 1_000, {
      originHostId: "host-origin",
      effectiveHostId,
    });
  }

  it("opens the bot's tab on the window's host, requests the landing and navigates to the bot", () => {
    const navigate = vi.fn();

    expect(route(navigate, "host-effective")).toBe(true);

    expect(lookupBotTab(useBotTabsStore.getState().tabs, BOT_ID)).toMatchObject(
      { hostId: "host-effective", title: "Bot" },
    );
    expect(useBotTabLandingStore.getState().byBotId[BOT_ID]).toEqual({
      threadId: "thread-1",
      messageId: "row-1",
    });
    expect(navigate).toHaveBeenCalledTimes(1);
    const intent: unknown = navigate.mock.calls[0]?.[0];
    expect(intent).toMatchObject({ params: { botId: BOT_ID } });
  });

  it("keeps the host of a tab that is already open", () => {
    useBotTabsStore
      .getState()
      .openBotTab({ botId: BOT_ID, hostId: "host-tab", title: "Tracy" });
    const navigate = vi.fn();

    expect(route(navigate, "host-effective")).toBe(true);

    expect(lookupBotTab(useBotTabsStore.getState().tabs, BOT_ID)).toMatchObject(
      { hostId: "host-tab", title: "Tracy" },
    );
    expect(useBotTabLandingStore.getState().byBotId[BOT_ID]).toEqual({
      threadId: "thread-1",
      messageId: "row-1",
    });
  });

  it("opens no tab and requests no landing without a host, and routes the row as a chat", () => {
    const navigate = vi.fn();

    route(navigate, null);

    expect(useBotTabsStore.getState().tabs).toEqual({});
    expect(useBotTabLandingStore.getState().byBotId).toEqual({});
    // The chat route took it: it did not navigate to a bot.
    for (const call of navigate.mock.calls) {
      const intent: unknown = call[0];
      expect(intent).not.toMatchObject({ params: { botId: BOT_ID } });
    }
  });
});
