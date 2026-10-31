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
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useBotTabLandingStore } from "@/stores/bots/bot-tab-landing-store";

/**
 * A tapped push of a bot's conversation (Tracy Bots VN4) opens the Tracy
 * surface on the bot's channel, landed on the thread beside it; a window with
 * no host to open it on opens nothing.
 */

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CHAT = { kind: "chat", epicId: BOT_ID, chatId: "thread-1" } as const;

beforeEach(async () => {
  __resetTabNavigationControllerForTesting();
  __resetTabSyncCoordinatorForTesting();
  installTabSyncCoordinator({ readyPromise: Promise.resolve() });
  await Promise.resolve();
  await Promise.resolve();
  useTracySurfaceStore.setState(useTracySurfaceStore.getInitialState(), true);
  useSelectionAuthorityStore.setState({ effectiveHostId: null });
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

  /** A router whose navigation is still in flight: not yet acknowledged. */
  function inFlightNavigate(): Mock {
    return vi.fn(() => new Promise<void>(() => undefined));
  }

  function route(navigate: Mock, effectiveHostId: string | null): boolean {
    if (payload === null) throw new Error("the payload did not parse");
    // The window's host, as the route reads it and as the opener binds to it.
    useSelectionAuthorityStore.setState({ effectiveHostId });
    return routeNotificationForHost(navigate, payload, 1_000, {
      originHostId: "host-origin",
      effectiveHostId,
    });
  }

  it("opens the surface on the window's host, requests the landing and navigates to the bot's channel", () => {
    const navigate = inFlightNavigate();

    expect(route(navigate, "host-effective")).toBe(true);

    expect(useTracySurfaceStore.getState()).toMatchObject({
      open: true,
      hostId: "host-effective",
    });
    expect(useBotTabLandingStore.getState().byBotId[BOT_ID]).toEqual({
      kind: "thread",
      threadId: "thread-1",
      messageId: "row-1",
    });
    expect(navigate).toHaveBeenCalledTimes(1);
    const intent: unknown = navigate.mock.calls[0]?.[0];
    expect(intent).toMatchObject({ params: { botId: BOT_ID } });
  });

  it("keeps the host of a surface that is already open", () => {
    useTracySurfaceStore.getState().openSurface("host-tab");
    const navigate = inFlightNavigate();

    expect(route(navigate, "host-effective")).toBe(true);

    expect(useTracySurfaceStore.getState().hostId).toBe("host-tab");
    expect(useBotTabLandingStore.getState().byBotId[BOT_ID]).toEqual({
      kind: "thread",
      threadId: "thread-1",
      messageId: "row-1",
    });
  });

  it("opens the open surface's channel with no window host: the surface's host serves it", () => {
    useTracySurfaceStore.getState().openSurface("host-tab");
    const navigate = inFlightNavigate();

    expect(route(navigate, null)).toBe(true);

    expect(useTracySurfaceStore.getState().hostId).toBe("host-tab");
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("opens nothing without a host: no surface, no landing, and never the bot id as an epic", () => {
    const navigate = inFlightNavigate();

    expect(route(navigate, null)).toBe(false);

    expect(useTracySurfaceStore.getState().open).toBe(false);
    expect(useBotTabLandingStore.getState().byBotId).toEqual({});
    expect(navigate).not.toHaveBeenCalled();
  });
});
