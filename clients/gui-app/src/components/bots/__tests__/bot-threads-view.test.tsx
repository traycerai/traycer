/**
 * Threads in place of a bot's channel (Tracy Bots, decisions 149 and 184):
 * every thread the person follows across the bots the column lists, newest
 * reply first, each a card - the channel line, the origin post, every reply
 * and a reply box, mounted once the card is near the page's view. The real
 * view, fan-out hook, follow and send mutations, landing store, Tracy surface
 * store, the thread panel's own card body and the real transcript run over a
 * real HostClient and QueryClient whose host answers each bot's thread list,
 * follows, read cursors and levels from the case's script. Only the channels'
 * and threads' sessions (rows are read from them), the notification
 * indicators, the tab navigation and the browser's IntersectionObserver are
 * replaced. The fixtures, the mounted tree and the per-case lifecycle are in
 * `bot-threads-view-harness.tsx`.
 */
import {
  botMentionHostClientMock,
  emptyBotMentionHostListsMock,
} from "@/components/bots/__tests__/bot-mention-host-test-support";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import type { BotConversationSendRequest } from "@traycer/protocol/host/bot/conversation-schemas";
import type {
  BotQuestionItem,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import {
  botQuestionsText,
  conversationRequestMessageId,
} from "@traycer/protocol/persistence/epic/messages";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import type { MobileLevel2Form } from "@/lib/layout/mobile-layout-form";
import type { TabNavigationIntent } from "@/lib/tab-navigation/intents";
import { CHAT_NAVIGATION_HIGHLIGHT_CLASSNAME } from "@/components/chat/chat-navigation-highlight";
import { tabItemId } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import {
  answerDraftKey,
  useBotDraftsStore,
} from "@/stores/bots/bot-drafts-store";
import {
  botReply,
  memberPost,
  turnRef,
} from "@/components/bots/__tests__/bot-turn-test-support";
import {
  createWindowedSession,
  indexNamesAppendedRow,
  indexReindexed,
  messageAccepted,
  openWindowedChat,
  recoverWindowedChat,
  paragraph,
  userSkeletonEntry,
  type WindowedChatIds,
  type WindowedSession,
} from "@/components/bots/__tests__/bot-windowed-session-test-support";
import { storedRowOfSend } from "@/components/bots/__tests__/bot-send-identity-test-support";
import { currentBotLifetime } from "@/lib/bots/bot-lifetime";
import {
  startPendingSend,
  type BotPendingSendStart,
} from "@/lib/bots/bot-pending-send";
import { useBotPendingSendsStore } from "@/stores/bots/bot-pending-sends-store";
import {
  chatSessionWithPosts,
  chatSessionWithThreadRows,
  postRow,
} from "./bot-channel-rows-test-support";
import { useBotThreadFoldStore } from "@/stores/bots/bot-thread-fold-store";
import { useBotTabLandingStore } from "@/stores/bots/bot-tab-landing-store";
import { useLayoutStore } from "@/stores/layout/layout-store";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { mocks } from "./bot-threads-view-state";
import {
  FakeIntersectionObserver,
  foregroundWindow,
  intersectTarget,
  observersOf,
} from "@/components/bots/__tests__/bot-read-observer-test-support";
import {
  callThread,
  card,
  deliverReply,
  drawnReplies,
  FOLLOWING,
  hydrateRepliesAt,
  installBotThreadsViewCaseLifecycle,
  listed,
  mount,
  mountBotBoundElsewhere,
  queryClient,
  readRow,
  replyTexts,
  revealFull,
  screenReaderCount,
  script,
  setMountLevel2,
  setMountUnderHeader,
  summaryVisibleText,
  TEAM,
  thread,
  TRACY,
  windowedPlaceholders,
  windowedSession,
  withReplies,
} from "./bot-threads-view-harness";

vi.mock("@/lib/soundtrack/manifest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/soundtrack/manifest")>()),
  soundtrackOffered: () => true,
}));
vi.mock(
  "@/hooks/host/use-host-client-for-host-id",
  () => botMentionHostClientMock,
);
vi.mock(
  "@/hooks/bots/use-environment-host-lists-query",
  () => emptyBotMentionHostListsMock,
);

vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-1",
}));
vi.mock("@/hooks/host/use-host-supports-method", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-supports-method")
  >()),
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    !mocks.unsupported.has(method),
}));
vi.mock("@/hooks/host/use-host-directory-entry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-directory-entry")
  >()),
  useHostDirectoryEntry: () => null,
}));
// The bot's live snapshot (its tasks, binding and surface actions) is not
// what these cases read: no stream is opened.
vi.mock("@/hooks/bots/use-bot-subscription", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/bots/use-bot-subscription")
  >()),
  useBotSubscriptionForHost: () => ({
    snapshot: null,
    deleted: false,
    error: null,
    isPending: false,
    resubscribe: () => undefined,
  }),
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.client,
}));
vi.mock("@/hooks/bots/use-bot-list-query", () => ({
  useBotListQuery: () => ({
    data:
      mocks.botList === "listed"
        ? { bots: mocks.bots, mainBotIds: null }
        : undefined,
    isError: mocks.botList === "failed",
    refetch: mocks.refetchBots,
  }),
}));
vi.mock("@/hooks/notifications/use-notification-indicators-query", () => ({
  useNotificationIndicators: (args: { chatIds: ReadonlyArray<string> }) => ({
    epics: {},
    chats: Object.fromEntries(
      args.chatIds.map((id) => [id, { unreadCount: mocks.unread[id] ?? 0 }]),
    ),
  }),
}));
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useChatSessionHandleForContainer: (
    botId: string,
    chatId: string,
  ): ChatSessionStoreHandle | null => {
    if (Object.hasOwn(mocks.replyRows, chatId)) {
      mocks.threadSessions[chatId] ??= chatSessionWithThreadRows(
        mocks.replyRows[chatId],
      );
      return mocks.threadSessions[chatId];
    }
    if (Object.hasOwn(mocks.replies, chatId)) {
      mocks.threadSessions[chatId] ??= chatSessionWithThreadRows(
        // Each reply is written one second after the one before it, as the
        // host's read positions name them.
        mocks.replies[chatId].map((text, index) => ({
          ...postRow(`${chatId}-reply-${String(index + 1)}`, text),
          timestamp: (index + 1) * 1_000,
        })),
      );
      return mocks.threadSessions[chatId];
    }
    if (!Object.hasOwn(mocks.channels, botId)) {
      if (!Object.hasOwn(mocks.posts, botId)) return null;
      mocks.channels[botId] = chatSessionWithPosts(mocks.posts[botId]);
    }
    return mocks.channels[botId];
  },
}));
vi.mock("@/hooks/bots/use-bot-activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/bots/use-bot-activity")>()),
  useBotActivity: () => null,
}));
vi.mock("@/lib/chats/chat-serving-witness", () => ({
  useChatServingHostId: () => "host-1",
}));
vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({ resolvedTheme: "dark", themePreset: "neutral" }),
}));
vi.mock("@/components/layout/header/rate-limit-icon", () => ({
  RateLimitIconButton: () => null,
}));
vi.mock("@/components/resources/resource-monitor-popover", () => ({
  ResourceMonitorPopover: () => null,
}));
vi.mock("@/components/notifications/mobile-notifications-button", () => ({
  MobileNotificationsButton: () => null,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));
// An accepted navigation commits the channel it arrives at, as the tab's
// controller does once the path is acknowledged; the landing staged for it is
// then the channel's to spend.
vi.mock("@/lib/tab-navigation", async (importOriginal) => {
  const { useTracySurfaceStore: surfaceStore } =
    await import("@/stores/bots/tracy-surface-store");
  return {
    ...(await importOriginal<typeof import("@/lib/tab-navigation")>()),
    activateTabIntent: (_navigate: unknown, intent: TabNavigationIntent) => {
      mocks.activateTabIntent(intent);
      if (intent.kind === "tracy") {
        surfaceStore.getState().selectChannel(intent.botId);
      }
      return true;
    },
  };
});
vi.mock("@/hooks/host/use-connectable-host-ids", () => ({
  useConnectableHostIds: () => ({ hostIds: ["host-1"], resolved: true }),
}));

installBotThreadsViewCaseLifecycle();

describe("<BotThreadsView />", () => {
  beforeEach(() => {
    mocks.hosted[TRACY] = script(
      [thread(TRACY, "tracy-old", 1_000), thread(TRACY, "tracy-other", 5_000)],
      {
        "tracy-old": FOLLOWING,
        "tracy-other": { state: "unfollowed", reason: "manual" },
      },
    );
    mocks.hosted[TEAM] = script(
      [thread(TEAM, "team-new", 3_000), thread(TEAM, "team-quiet", null)],
      { "team-new": FOLLOWING, "team-quiet": FOLLOWING },
    );
  });

  it("asks for the whole thread list of each bot and for the follows, read cursors and levels by bot id alone", async () => {
    mount();
    await waitFor(() =>
      expect(listed()).toEqual(["team-new", "tracy-old", "team-quiet"]),
    );

    // The distinct params each read was sent, exactly: a refetch repeats them.
    const sentTo = (method: string): Set<string> =>
      new Set(
        mocks.reads
          .filter((read) => read.method === method)
          .map((read) => JSON.stringify(read.params)),
      );
    for (const method of [
      "bot.threadFollow.read",
      "bot.readCursor.read",
      "bot.notificationLevel.read",
    ]) {
      expect(sentTo(method)).toEqual(
        new Set([
          JSON.stringify({ botId: TRACY }),
          JSON.stringify({ botId: TEAM }),
        ]),
      );
    }
    expect(sentTo("bot.thread.list")).toEqual(
      new Set([
        JSON.stringify({ botId: TRACY, limit: null, cursor: null }),
        JSON.stringify({ botId: TEAM, limit: null, cursor: null }),
      ]),
    );
  });

  it("lists the followed threads of every bot as cards, newest reply first, each with its bot, its post's first line, its replies, its new replies and its unread count, until the card is near the view", async () => {
    mocks.posts[TEAM] = {
      [conversationRequestMessageId("req-team-new")]:
        "Nightly train: what failed?\nThe Windows leg.",
    };
    mocks.hosted[TEAM].cursors = {
      cursors: { "team-new": { messageId: "m-1", seq: 2_000 } },
      latest: { "team-new": { messageId: "m-2", seq: 3_000 } },
    };
    mocks.hosted[TRACY].cursors = {
      cursors: { "tracy-old": { messageId: "m-3", seq: 1_000 } },
      latest: { "tracy-old": { messageId: "m-3", seq: 1_000 } },
    };
    mocks.unread = { "team-new": 2 };
    mount();

    await waitFor(() =>
      expect(listed()).toEqual(["team-new", "tracy-old", "team-quiet"]),
    );
    const team = within(card("team-new"));
    expect(team.getByTestId("bot-thread-card-channel-link").textContent).toBe(
      "Team Tracy",
    );
    expect(team.getByTestId("bot-thread-card-summary").textContent).toContain(
      "Nightly train: what failed?",
    );
    expect(
      team.getByTestId("bot-thread-card-summary").textContent,
    ).not.toContain("The Windows leg.");
    expect(team.queryByTestId("bot-thread-card-summary-replies")).toBeNull();
    const count = team.getByTestId("bot-thread-reply-count-sr");
    expect(count.textContent).toBe("2 replies");
    expect(count.classList.contains("sr-only")).toBe(true);
    expect(count.tagName).not.toBe("BUTTON");
    expect(summaryVisibleText("team-new")).not.toMatch(/repl(y|ies)|·/);
    expect(team.getByTestId("bot-thread-row-new-replies")).toBeTruthy();
    expect(team.getByTestId("bot-thread-row-unread-count").textContent).toBe(
      "2 unread",
    );
    const tracy = within(card("tracy-old"));
    expect(tracy.getByTestId("bot-thread-card-channel-link").textContent).toBe(
      "Tracy",
    );
    // Its post is older than what the channel has loaded.
    expect(tracy.getByTestId("bot-thread-card-summary").textContent).toContain(
      "Thread",
    );
    expect(tracy.queryByTestId("bot-thread-row-new-replies")).toBeNull();
    expect(tracy.queryByTestId("bot-thread-row-unread-count")).toBeNull();
    expect(card("team-new").getAttribute("data-full")).toBe("false");
  });

  it("names a card by the first paragraph of a post that has several", async () => {
    mocks.channels[TEAM] = chatSessionWithThreadRows([
      memberPost({
        messageId: conversationRequestMessageId("req-team-new"),
        requestId: "req-team-new",
        lines: ["First paragraph.", "Second paragraph."],
        timestamp: 1_000,
        resolvedBy: null,
      }),
    ]);
    mount();
    await waitFor(() => expect(listed()).toContain("team-new"));

    expect(
      within(
        within(card("team-new")).getByTestId("bot-thread-card-summary"),
      ).getByText("First paragraph."),
    ).toBeTruthy();
  });

  it("keeps a thread whose post is gone as a summary with no visible reply count, only the screen-reader one", async () => {
    mocks.hosted[TEAM].threads = mocks.hosted[TEAM].threads.map((summary) =>
      summary.threadId === "team-new" ? { ...summary, anchor: null } : summary,
    );
    mount();
    await waitFor(() => expect(listed()).toContain("team-new"));
    const gone = within(card("team-new"));

    expect(gone.queryByTestId("bot-thread-card-summary-replies")).toBeNull();
    expect(gone.getByTestId("bot-thread-reply-count-sr").textContent).toBe(
      "2 replies",
    );
    expect(summaryVisibleText("team-new")).toMatch(/^Thread/);
    expect(summaryVisibleText("team-new")).not.toMatch(/repl(y|ies)|·/);
    expect(gone.queryByTestId("bot-thread-card-summary")).toBeTruthy();
  });

  it("marks a thread a call opened with a phone, and draws none on a plain thread", async () => {
    mocks.hosted[TEAM] = script(
      [callThread(TEAM, "team-call", 4_000), thread(TEAM, "team-new", 3_000)],
      { "team-call": FOLLOWING, "team-new": FOLLOWING },
    );
    mount();
    await waitFor(() => expect(listed()).toContain("team-call"));

    const phone = within(card("team-call")).getByTestId("bot-thread-row-call");
    expect(phone.getAttribute("role")).toBe("img");
    expect(phone.getAttribute("aria-label")).toBe("Call");
    expect(
      within(card("team-new")).queryByTestId("bot-thread-row-call"),
    ).toBeNull();
  });

  it("mounts a card's thread only once it is within a screen of the page's view, and keeps it, watching the card for nothing else", async () => {
    mocks.posts[TEAM] = {
      [conversationRequestMessageId("req-team-new")]: "Nightly train",
    };
    withReplies(TEAM, "team-new", replyTexts(2), 3_000);
    mount();
    await waitFor(() => expect(listed()).toContain("team-new"));

    const target = card("team-new");
    const scroller = screen.getByTestId("bot-threads-scroll");
    // Near: a screen's margin around the page's own scroller. The card in
    // view reads nothing, so nothing watches it for that.
    expect(observersOf(target, "near").map((o) => o.options)).toEqual([
      { root: scroller, rootMargin: "100% 0px" },
    ]);
    expect(observersOf(target, "view")).toEqual([]);
    expect(within(target).getByTestId("bot-thread-card-summary")).toBeTruthy();
    expect(within(target).queryByTestId("bot-thread-anchor")).toBeNull();
    expect(within(target).queryByTestId("bot-thread-composer")).toBeNull();

    await revealFull("team-new");
    expect(within(target).queryByTestId("bot-thread-card-summary")).toBeNull();
    expect(within(target).getByTestId("bot-thread-anchor")).toBeTruthy();

    // Once near, nothing watches the card, so nothing can take its thread
    // back.
    expect(
      FakeIntersectionObserver.all.filter((o) => o.targets.has(target)),
    ).toEqual([]);
    expect(card("team-new").getAttribute("data-full")).toBe("true");
  });

  it("draws a near card in full: the origin post, the replies through the real transcript and a reply box", async () => {
    mocks.posts[TEAM] = {
      [conversationRequestMessageId("req-team-new")]:
        "Nightly train: what failed?",
    };
    withReplies(TEAM, "team-new", replyTexts(2), 3_000);
    mount();
    await waitFor(() => expect(listed()).toContain("team-new"));

    const full = within(await revealFull("team-new"));

    expect(full.getByTestId("bot-thread-anchor").textContent).toContain(
      "Nightly train: what failed?",
    );
    expect(await full.findByText("reply 1")).toBeTruthy();
    expect(full.getByText("reply 2")).toBeTruthy();
    expect(full.getByTestId("bot-chat-transcript-flow")).toBeTruthy();
    expect(full.getByTestId("bot-thread-composer")).toBeTruthy();
  });

  it("opens the bot's channel landed on the origin post, with no thread panel, from the channel line", async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(listed()).toContain("team-new"));

    await user.click(
      within(card("team-new")).getByTestId("bot-thread-card-channel-link"),
    );

    expect(useBotTabLandingStore.getState().byBotId).toEqual({
      [TEAM]: {
        kind: "thread",
        threadId: null,
        messageId: conversationRequestMessageId("req-team-new"),
      },
    });
    expect(useTracySurfaceStore.getState()).toMatchObject({
      open: true,
      hostId: "host-1",
    });
    expect(mocks.activateTabIntent).toHaveBeenCalledTimes(1);
    expect(mocks.activateTabIntent).toHaveBeenCalledWith({
      kind: "tracy",
      botId: TEAM,
    });
  });

  it("opens the bot's channel landed on the origin post from the post's time, a link named for the time it shows and for what it does", async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(listed()).toContain("team-new"));
    const anchor = within(
      within(await revealFull("team-new")).getByTestId("bot-thread-anchor"),
    );

    const link = anchor.getByRole("button", { name: /, show in channel$/ });
    expect(link.getAttribute("aria-label")).toBe(
      `${String(anchor.getByTestId("chat-message-timestamp").textContent)}, show in channel`,
    );
    await user.click(link);

    expect(useBotTabLandingStore.getState().byBotId).toEqual({
      [TEAM]: {
        kind: "thread",
        threadId: null,
        messageId: conversationRequestMessageId("req-team-new"),
      },
    });
  });

  it("leaves the origin post's time out of the tab order while timestamps are hidden: no link is drawn around the missing time", async () => {
    useLayoutStore.getState().setRegionValues("timestamps", {
      shown: "hidden",
    });
    mount();
    await waitFor(() => expect(listed()).toContain("team-new"));

    const anchor = within(
      within(await revealFull("team-new")).getByTestId("bot-thread-anchor"),
    );

    expect(anchor.queryByTestId("chat-message-timestamp")).toBeNull();
    expect(anchor.queryByTestId("bot-row-time-link")).toBeNull();
  });

  it("opens the bot's channel with the thread's panel beside it from the menu's Open thread", async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(listed()).toContain("team-new"));

    await user.click(
      within(card("team-new")).getByTestId("bot-thread-row-menu"),
    );
    await user.click(await screen.findByTestId("bot-thread-row-open"));

    expect(useBotTabLandingStore.getState().byBotId).toEqual({
      [TEAM]: { kind: "thread", threadId: "team-new", messageId: null },
    });
    expect(mocks.activateTabIntent).toHaveBeenCalledWith({
      kind: "tracy",
      botId: TEAM,
    });
  });

  it("shows every message of a thread of six: the origin and its five replies, with no fold", async () => {
    withReplies(TEAM, "team-new", replyTexts(5), 3_000);
    mount();
    await waitFor(() => expect(listed()).toContain("team-new"));

    const full = within(await revealFull("team-new"));

    await full.findByText("reply 5");
    expect(drawnReplies("team-new")).toEqual(replyTexts(5));
    expect(full.queryByTestId("bot-chat-transcript-unfold")).toBeNull();
    expect(full.getByTestId("bot-thread-anchor")).toBeTruthy();
  });

  it("counts the replies of a card that draws every one for assistive technology only, with no divider or link", async () => {
    withReplies(TEAM, "team-new", replyTexts(2), 3_000);
    mount();
    await waitFor(() => expect(listed()).toContain("team-new"));

    const full = within(await revealFull("team-new"));

    await full.findByText("reply 2");
    const count = await full.findByTestId("bot-thread-reply-count-sr");
    expect(count.textContent).toBe("2 replies");
    expect(count.classList.contains("sr-only")).toBe(true);
    expect(count.tagName).not.toBe("BUTTON");
    expect(full.queryByTestId("bot-thread-reply-count")).toBeNull();
    expect(full.queryByTestId("bot-thread-reply-count-open")).toBeNull();
  });

  it("counts a single reply as 1 reply for assistive technology, with no divider", async () => {
    withReplies(TEAM, "team-new", replyTexts(1), 3_000);
    mount();
    await waitFor(() => expect(listed()).toContain("team-new"));

    const full = within(await revealFull("team-new"));

    await full.findByText("reply 1");
    expect(
      (await full.findByTestId("bot-thread-reply-count-sr")).textContent,
    ).toBe("1 reply");
    expect(full.queryByTestId("bot-thread-reply-count")).toBeNull();
  });

  it("draws neither a divider nor a count for a card with no replies", async () => {
    withReplies(TEAM, "team-new", [], 3_000);
    mount();
    await waitFor(() => expect(listed()).toContain("team-new"));

    const full = within(await revealFull("team-new"));

    await full.findByTestId("bot-thread-anchor");
    expect(full.queryByTestId("bot-thread-reply-count")).toBeNull();
    expect(full.queryByTestId("bot-thread-reply-count-sr")).toBeNull();
  });

  it("gives a folded card no divider or link, only the unfold line and the assistive count, before and after it unfolds", async () => {
    const user = userEvent.setup();
    withReplies(TEAM, "team-new", replyTexts(8), 3_000);
    mount();
    await waitFor(() => expect(listed()).toContain("team-new"));
    const full = within(await revealFull("team-new"));

    const unfold = await full.findByTestId("bot-chat-transcript-unfold");
    expect(full.queryByTestId("bot-thread-reply-count")).toBeNull();
    expect(full.queryByTestId("bot-thread-reply-count-open")).toBeNull();
    expect(screenReaderCount("team-new")?.textContent).toBe("8 replies");

    await user.click(unfold);

    await waitFor(() =>
      expect(full.queryByTestId("bot-chat-transcript-unfold")).toBeNull(),
    );
    expect(full.queryByTestId("bot-thread-reply-count")).toBeNull();
    expect(full.queryByTestId("bot-thread-reply-count-open")).toBeNull();
    expect(screenReaderCount("team-new")?.textContent).toBe("8 replies");
  });

  it("gives a windowed card whose replies are still placeholders no divider or link, only the assistive count", async () => {
    withReplies(TEAM, "team-new", replyTexts(2), 3_000);
    windowedPlaceholders("team-new", 2);
    mount();
    await waitFor(() => expect(listed()).toContain("team-new"));

    const full = within(await revealFull("team-new"));

    await full.findByTestId("bot-chat-transcript-row-loading");
    expect(full.queryByTestId("bot-thread-reply-count")).toBeNull();
    expect(full.queryByTestId("bot-thread-reply-count-open")).toBeNull();
    expect(screenReaderCount("team-new")?.textContent).toBe("2 replies");
  });

  it("draws the unfold line, still no divider, and the new assistive count when a reply pushes a card over the fold limit", async () => {
    withReplies(TEAM, "team-new", replyTexts(5), 3_000);
    mount();
    await waitFor(() => expect(listed()).toContain("team-new"));
    const full = within(await revealFull("team-new"));
    await full.findByTestId("bot-thread-reply-count-sr");

    await deliverReply("team-new", 6);

    await full.findByTestId("bot-chat-transcript-unfold");
    expect(screenReaderCount("team-new")?.textContent).toBe("6 replies");
    expect(full.queryByTestId("bot-thread-reply-count")).toBeNull();
    expect(full.queryByTestId("bot-thread-reply-count-open")).toBeNull();
  });

  it("folds a longer thread to the origin, a line counting the hidden replies and the last two replies, and the line shows the rest in place and keeps them shown", async () => {
    const user = userEvent.setup();
    withReplies(TEAM, "team-new", replyTexts(8), 3_000);
    mount();
    await waitFor(() => expect(listed()).toContain("team-new"));

    const full = within(await revealFull("team-new"));

    const unfold = await full.findByTestId("bot-chat-transcript-unfold");
    expect(unfold.textContent).toBe("Show 6 more replies");
    expect(full.getByTestId("bot-thread-anchor")).toBeTruthy();
    expect(drawnReplies("team-new")).toEqual(["reply 7", "reply 8"]);

    await user.click(unfold);

    await waitFor(() =>
      expect(drawnReplies("team-new")).toEqual(replyTexts(8)),
    );
    expect(full.queryByTestId("bot-chat-transcript-unfold")).toBeNull();
    expect(useBotThreadFoldStore.getState().unfolded).toEqual({
      "team-new": true,
    });
  });

  it("counts the followed threads with new replies in a pill and jumps to the next one below the page's top, else the first", async () => {
    const user = userEvent.setup();
    mocks.hosted[TEAM] = script(
      [thread(TEAM, "team-a", 5_000), thread(TEAM, "team-b", 4_000)],
      { "team-a": FOLLOWING, "team-b": FOLLOWING },
    );
    mocks.hosted[TRACY] = script([thread(TRACY, "tracy-c", 3_000)], {
      "tracy-c": FOLLOWING,
    });
    mocks.hosted[TEAM].cursors = {
      cursors: {},
      latest: {
        "team-a": { messageId: "m-a", seq: 5_000 },
        "team-b": { messageId: "m-b", seq: 4_000 },
      },
    };
    mocks.hosted[TRACY].cursors = {
      cursors: { "tracy-c": { messageId: "m-c", seq: 3_000 } },
      latest: { "tracy-c": { messageId: "m-c", seq: 3_000 } },
    };
    // jsdom has no scrollIntoView; afterEach puts the prototype back.
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      scrolled.push(this);
    };
    mount();
    await waitFor(() =>
      expect(listed()).toEqual(["team-a", "team-b", "tracy-c"]),
    );

    const pill = await screen.findByTestId("bot-threads-unread-pill");
    expect(pill.textContent).toBe("2 unread threads");
    // jsdom lays nothing out: place the cards against the page's top by hand.
    const place = (element: HTMLElement, top: number): void => {
      vi.spyOn(element, "getBoundingClientRect").mockReturnValue(
        new DOMRect(0, top, 100, 100),
      );
    };
    place(screen.getByTestId("bot-threads-scroll"), 0);
    place(card("team-a"), -300);
    place(card("team-b"), 200);
    place(card("tracy-c"), 600);

    await user.click(pill);
    expect(scrolled).toEqual([card("team-b")]);

    // Every unread card now starts above the page's top: back to the first.
    place(card("team-b"), -100);
    await user.click(pill);
    expect(scrolled).toEqual([card("team-b"), card("team-a")]);
  });

  it("draws no pill once every followed thread's replies are read", async () => {
    mocks.hosted[TEAM].cursors = {
      cursors: { "team-new": { messageId: "m-2", seq: 3_000 } },
      latest: { "team-new": { messageId: "m-2", seq: 3_000 } },
    };
    mocks.hosted[TRACY].cursors = {
      cursors: { "tracy-old": { messageId: "m-3", seq: 1_000 } },
      latest: { "tracy-old": { messageId: "m-3", seq: 1_000 } },
    };
    mount();
    await waitFor(() => expect(listed()).toContain("team-new"));
    await waitFor(() =>
      expect(
        mocks.reads.filter((read) => read.method === "bot.readCursor.read"),
      ).toHaveLength(2),
    );

    expect(
      within(card("team-new")).queryByTestId("bot-thread-row-new-replies"),
    ).toBeNull();
    expect(screen.queryByTestId("bot-threads-unread-pill")).toBeNull();
  });

  it("names who is in a thread on its channel line: Just you when only the viewer wrote, the names when anyone else did", async () => {
    mocks.hosted[TRACY] = script([], {});
    mocks.hosted[TEAM] = script(
      [
        {
          ...thread(TEAM, "team-solo", 4_000),
          replyParticipants: [{ kind: "person", userId: "user-1" }],
        },
        {
          ...thread(TEAM, "team-mixed", 3_000),
          replyParticipants: [{ kind: "bot" }],
        },
      ],
      { "team-solo": FOLLOWING, "team-mixed": FOLLOWING },
    );
    mount();
    await waitFor(() => expect(listed()).toEqual(["team-solo", "team-mixed"]));

    expect(
      within(card("team-solo")).getByTestId("bot-thread-card-participants")
        .textContent,
    ).toBe("Just you");
    expect(
      within(card("team-mixed")).getByTestId("bot-thread-card-participants")
        .textContent,
    ).toBe("Olive Owner, Team Tracy");
  });

  it("reads a card's replies only once its newest reply has stayed in view, never for the card's line or post in view", async () => {
    foregroundWindow();
    mocks.hosted[TRACY] = script([], {});
    mocks.hosted[TEAM] = script(
      [thread(TEAM, "team-a", 2_000), thread(TEAM, "team-b", 2_000)],
      { "team-a": FOLLOWING, "team-b": FOLLOWING },
    );
    mocks.hosted[TEAM].cursors = {
      cursors: {
        "team-a": { messageId: "team-a-reply-1", seq: 1_000 },
        "team-b": { messageId: "team-b-reply-1", seq: 1_000 },
      },
      latest: {
        "team-a": { messageId: "team-a-reply-2", seq: 2_000 },
        "team-b": { messageId: "team-b-reply-2", seq: 2_000 },
      },
    };
    withReplies(TEAM, "team-a", replyTexts(2), 2_000);
    withReplies(TEAM, "team-b", replyTexts(2), 2_000);
    mount();
    await waitFor(() => expect(listed()).toEqual(["team-a", "team-b"]));

    // Both summaries come near together and draw their threads in full.
    await within(await revealFull("team-a")).findByText("reply 2");
    await within(await revealFull("team-b")).findByText("reply 2");
    // Each reply's own row is watched, by the page's view observer.
    expect(observersOf(readRow("team-a", "reply 2"), "view")).not.toHaveLength(
      0,
    );

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    intersectTarget(readRow("team-a", "reply 2"), "view", true);
    intersectTarget(readRow("team-b", "reply 2"), "view", true);
    // The card's read hold is a second.
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(mocks.advances).toEqual([]);
    // The second card's newest reply leaves the view before the second is up.
    intersectTarget(readRow("team-b", "reply 2"), "view", false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    vi.useRealTimers();

    await waitFor(() =>
      expect(mocks.advances).toEqual([
        {
          botId: TEAM,
          conversationId: "team-a",
          messageId: "team-a-reply-2",
          seq: 2_000,
        },
      ]),
    );
  });

  it("acknowledges a newer reply only once it is drawn and has stayed in view itself, not on the strength of the reply seen before it", async () => {
    foregroundWindow();
    mocks.hosted[TEAM].cursors = {
      cursors: { "team-new": { messageId: "team-new-reply-1", seq: 1_000 } },
      latest: { "team-new": { messageId: "team-new-reply-2", seq: 2_000 } },
    };
    withReplies(TEAM, "team-new", replyTexts(2), 2_000);
    mount();
    await waitFor(() => expect(listed()).toContain("team-new"));
    await within(await revealFull("team-new")).findByText("reply 2");

    // The tail is read.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    intersectTarget(readRow("team-new", "reply 2"), "view", true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    vi.useRealTimers();
    await waitFor(() => expect(mocks.advances).toHaveLength(1));

    // The host names a newer reply the thread's session has not brought in.
    mocks.hosted[TEAM].cursors = {
      ...mocks.hosted[TEAM].cursors,
      latest: { "team-new": { messageId: "team-new-reply-3", seq: 3_000 } },
    };
    await act(() => queryClient.invalidateQueries());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    vi.useRealTimers();
    expect(mocks.advances).toHaveLength(1);

    // The reply arrives: its own mark, held anew.
    const session = mocks.threadSessions["team-new"].store;
    act(() => {
      session.setState({
        messages: [
          ...session.getState().messages,
          { ...postRow("team-new-reply-3", "reply 3"), timestamp: 3_000 },
        ],
      });
    });
    await within(card("team-new")).findByText("reply 3");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    intersectTarget(readRow("team-new", "reply 3"), "view", true);
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(mocks.advances).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    vi.useRealTimers();

    await waitFor(() =>
      expect(mocks.advances.at(-1)).toEqual({
        botId: TEAM,
        conversationId: "team-new",
        messageId: "team-new-reply-3",
        seq: 3_000,
      }),
    );
    expect(mocks.advances).toHaveLength(2);
  });

  it("clears a thread's new-replies mark once its newest row is read, though the list's lastReplyAt is ahead of that row, and marks a genuinely newer row again", async () => {
    foregroundWindow();
    mocks.hosted[TRACY] = script([], {});
    mocks.hosted[TEAM] = script([thread(TEAM, "team-new", 9_000)], {
      "team-new": FOLLOWING,
    });
    mocks.hosted[TEAM].cursors = {
      cursors: { "team-new": { messageId: "team-new-reply-1", seq: 1_000 } },
      latest: { "team-new": { messageId: "team-new-reply-2", seq: 2_000 } },
    };
    withReplies(TEAM, "team-new", replyTexts(2), 9_000);
    mount();
    await waitFor(() => expect(listed()).toEqual(["team-new"]));
    expect(
      await within(card("team-new")).findByTestId("bot-thread-row-new-replies"),
    ).toBeTruthy();
    expect(screen.getByTestId("bot-threads-unread-pill").textContent).toBe(
      "1 unread thread",
    );
    await within(await revealFull("team-new")).findByText("reply 2");

    // The whole read runs on the fake clock: the cache write's notification
    // to the list is a zero-delay timer, lost if the clock is restored first.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    intersectTarget(readRow("team-new", "reply 2"), "view", true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await vi.waitFor(() =>
      expect(mocks.advances).toEqual([
        {
          botId: TEAM,
          conversationId: "team-new",
          messageId: "team-new-reply-2",
          seq: 2_000,
        },
      ]),
    );
    // The advance landed in the cache the card reads: reading cleared it.
    await vi.waitFor(() => {
      expect(
        within(card("team-new")).queryByTestId("bot-thread-row-new-replies"),
      ).toBeNull();
    });
    expect(screen.queryByTestId("bot-threads-unread-pill")).toBeNull();
    vi.useRealTimers();

    // A row the host later names past that cursor is unread again.
    mocks.hosted[TEAM].cursors = {
      ...mocks.hosted[TEAM].cursors,
      latest: { "team-new": { messageId: "team-new-reply-3", seq: 3_000 } },
    };
    await act(() => queryClient.invalidateQueries());
    expect(
      await within(card("team-new")).findByTestId("bot-thread-row-new-replies"),
    ).toBeTruthy();
    expect(screen.getByTestId("bot-threads-unread-pill").textContent).toBe(
      "1 unread thread",
    );
  });

  describe("the unread banner's cross", () => {
    const A_OLD = { messageId: "team-a-reply-1", seq: 1_000 };
    const A_NEW = { messageId: "team-a-reply-2", seq: 2_000 };
    const B_OLD = { messageId: "team-b-reply-1", seq: 1_000 };
    const B_NEW = { messageId: "team-b-reply-2", seq: 3_000 };

    function twoUnreadThreads(): void {
      mocks.hosted[TRACY] = script([], {});
      mocks.hosted[TEAM] = script(
        [thread(TEAM, "team-a", 2_000), thread(TEAM, "team-b", 3_000)],
        { "team-a": FOLLOWING, "team-b": FOLLOWING },
      );
      mocks.hosted[TEAM].cursors = {
        cursors: { "team-a": A_OLD, "team-b": B_OLD },
        latest: { "team-a": A_NEW, "team-b": B_NEW },
      };
      mocks.failNextAdvance = false;
    }

    function banner(): HTMLElement {
      return screen.getByTestId("bot-unread-banner");
    }

    function crossBanner(): void {
      fireEvent.click(
        within(banner()).getByRole("button", { name: "Mark all read" }),
      );
    }

    /** The host names a newer newest row for `threadId`, and the view reads it. */
    async function land(
      threadId: string,
      row: { messageId: string; seq: number },
    ): Promise<void> {
      mocks.hosted[TEAM].cursors = {
        ...mocks.hosted[TEAM].cursors,
        latest: { ...mocks.hosted[TEAM].cursors.latest, [threadId]: row },
      };
      await act(() => queryClient.invalidateQueries());
    }

    it("marks every represented thread read at the newest row it had when clicked, though no card was in view, and the banner goes", async () => {
      twoUnreadThreads();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      mount();
      await vi.waitFor(() => expect(listed()).toEqual(["team-b", "team-a"]));
      expect(
        within(banner()).getByTestId("bot-threads-unread-pill").textContent,
      ).toBe("2 unread threads");

      crossBanner();

      await vi.waitFor(() => expect(mocks.advances).toHaveLength(2));
      expect(mocks.advances).toEqual(
        expect.arrayContaining([
          { botId: TEAM, conversationId: "team-a", ...A_NEW },
          { botId: TEAM, conversationId: "team-b", ...B_NEW },
        ]),
      );
      await vi.waitFor(() =>
        expect(screen.queryByTestId("bot-unread-banner")).toBeNull(),
      );
    });

    it("leaves a reply that lands after the click unread, and writes nothing more for it", async () => {
      twoUnreadThreads();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      mount();
      await vi.waitFor(() => expect(listed()).toEqual(["team-b", "team-a"]));
      crossBanner();
      await vi.waitFor(() =>
        expect(screen.queryByTestId("bot-unread-banner")).toBeNull(),
      );

      await land("team-a", { messageId: "team-a-reply-3", seq: 4_000 });

      await vi.waitFor(() =>
        expect(
          within(banner()).getByTestId("bot-threads-unread-pill").textContent,
        ).toBe("1 unread thread"),
      );
      expect(mocks.advances).toHaveLength(2);
    });

    it("keeps the banner for a thread whose write failed, and sends that same captured boundary from the next click, not a newer one", async () => {
      twoUnreadThreads();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      mount();
      await vi.waitFor(() => expect(listed()).toEqual(["team-b", "team-a"]));
      mocks.failNextAdvance = true;

      crossBanner();
      await vi.waitFor(() => expect(mocks.advances).toHaveLength(2));
      const [failed] = mocks.advances;
      await vi.waitFor(() =>
        expect(
          within(banner()).getByTestId("bot-threads-unread-pill").textContent,
        ).toBe("1 unread thread"),
      );

      const failedThread = (failed as { conversationId: string })
        .conversationId;
      await land(failedThread, { messageId: "later", seq: 9_000 });
      crossBanner();

      await vi.waitFor(() => expect(mocks.advances).toHaveLength(3));
      expect(mocks.advances.at(-1)).toEqual(failed);
    });
  });

  it("does not read across a reply the transcript has not hydrated, though the newest reply and the one before it were shown, until that reply is drawn and shown too", async () => {
    foregroundWindow();
    mocks.hosted[TRACY] = script([], {});
    mocks.hosted[TEAM] = script([thread(TEAM, "team-new", 3_000)], {
      "team-new": FOLLOWING,
    });
    mocks.hosted[TEAM].cursors = {
      cursors: { "team-new": { messageId: "team-new-reply-1", seq: 1_000 } },
      latest: { "team-new": { messageId: "team-new-reply-3", seq: 3_000 } },
    };
    withReplies(TEAM, "team-new", replyTexts(3), 3_000);
    // The window knows three rows; the middle one has no body yet.
    windowedSession("team-new");
    hydrateRepliesAt("team-new", 3, [0, 2]);
    mount();
    await waitFor(() => expect(listed()).toEqual(["team-new"]));
    await within(await revealFull("team-new")).findByText("reply 3");

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    intersectTarget(readRow("team-new", "reply 3"), "view", true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(mocks.advances).toEqual([]);

    // The middle reply arrives and is held for its own second.
    hydrateRepliesAt("team-new", 3, [0, 1, 2]);
    await vi.waitFor(() =>
      expect(drawnReplies("team-new")).toContain("reply 2"),
    );
    intersectTarget(readRow("team-new", "reply 2"), "view", true);
    intersectTarget(readRow("team-new", "reply 3"), "view", true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await vi.waitFor(() =>
      expect(mocks.advances).toEqual([
        {
          botId: TEAM,
          conversationId: "team-new",
          messageId: "team-new-reply-3",
          seq: 3_000,
        },
      ]),
    );
  });

  it("drops only the hold of the card whose transcript scrolled, and leaves another card's hold running", async () => {
    foregroundWindow();
    mocks.hosted[TRACY] = script([], {});
    mocks.hosted[TEAM] = script(
      [thread(TEAM, "team-a", 2_000), thread(TEAM, "team-b", 2_000)],
      { "team-a": FOLLOWING, "team-b": FOLLOWING },
    );
    mocks.hosted[TEAM].cursors = {
      cursors: {
        "team-a": { messageId: "team-a-reply-1", seq: 1_000 },
        "team-b": { messageId: "team-b-reply-1", seq: 1_000 },
      },
      latest: {
        "team-a": { messageId: "team-a-reply-2", seq: 2_000 },
        "team-b": { messageId: "team-b-reply-2", seq: 2_000 },
      },
    };
    withReplies(TEAM, "team-a", replyTexts(2), 2_000);
    withReplies(TEAM, "team-b", replyTexts(2), 2_000);
    mount();
    await waitFor(() =>
      expect(listed().toSorted()).toEqual(["team-a", "team-b"]),
    );
    await within(await revealFull("team-a")).findByText("reply 2");
    await within(await revealFull("team-b")).findByText("reply 2");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    intersectTarget(readRow("team-a", "reply 2"), "view", true);
    intersectTarget(readRow("team-b", "reply 2"), "view", true);

    // Half way through both holds, card A's own transcript scrolls.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    act(() => {
      card("team-a").dispatchEvent(new Event("scroll"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    await vi.waitFor(() =>
      expect(mocks.advances).toEqual([
        {
          botId: TEAM,
          conversationId: "team-b",
          messageId: "team-b-reply-2",
          seq: 2_000,
        },
      ]),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(mocks.advances).toHaveLength(1);

    // Held afresh, the scrolled card's reply is read too.
    intersectTarget(readRow("team-a", "reply 2"), "view", true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await vi.waitFor(() => expect(mocks.advances).toHaveLength(2));
    expect(mocks.advances.at(-1)).toEqual({
      botId: TEAM,
      conversationId: "team-a",
      messageId: "team-a-reply-2",
      seq: 2_000,
    });
  });

  it("unfolds the unread card the banner takes the person to, so its hidden unread replies can be read, and writes nothing for the click", async () => {
    const user = userEvent.setup();
    mocks.hosted[TRACY] = script([], {});
    mocks.hosted[TEAM] = script([thread(TEAM, "team-new", 8_000)], {
      "team-new": FOLLOWING,
    });
    mocks.hosted[TEAM].cursors = {
      cursors: { "team-new": { messageId: "team-new-reply-1", seq: 1_000 } },
      latest: { "team-new": { messageId: "team-new-reply-8", seq: 8_000 } },
    };
    withReplies(TEAM, "team-new", replyTexts(8), 8_000);
    // jsdom has no scrollIntoView; afterEach puts the prototype back.
    Element.prototype.scrollIntoView = function scrollIntoView() {};
    mount();
    await waitFor(() => expect(listed()).toEqual(["team-new"]));
    const full = within(await revealFull("team-new"));
    await full.findByTestId("bot-chat-transcript-unfold");
    expect(drawnReplies("team-new")).toEqual(["reply 7", "reply 8"]);

    await user.click(screen.getByTestId("bot-threads-unread-pill"));

    await waitFor(() =>
      expect(drawnReplies("team-new")).toEqual(replyTexts(8)),
    );
    expect(useBotThreadFoldStore.getState().unfolded).toEqual({
      "team-new": true,
    });
    expect(mocks.advances).toEqual([]);
  });

  describe("reading in prefixes as rows are hydrated and shown", () => {
    /** Four replies, the cursor on the first, the host's newest row the fourth. */
    function fourRepliesBehind(): void {
      foregroundWindow();
      mocks.hosted[TRACY] = script([], {});
      mocks.hosted[TEAM] = script([thread(TEAM, "team-new", 4_000)], {
        "team-new": FOLLOWING,
      });
      mocks.hosted[TEAM].cursors = {
        cursors: { "team-new": { messageId: "team-new-reply-1", seq: 1_000 } },
        latest: { "team-new": { messageId: "team-new-reply-4", seq: 4_000 } },
      };
      withReplies(TEAM, "team-new", replyTexts(4), 4_000);
      windowedSession("team-new");
    }

    async function showRows(...texts: string[]): Promise<void> {
      for (const text of texts) {
        intersectTarget(readRow("team-new", text), "view", true);
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
    }

    function wrote(...rows: Array<{ messageId: string; seq: number }>): void {
      expect(mocks.advances).toEqual(
        rows.map((row) => ({
          botId: TEAM,
          conversationId: "team-new",
          ...row,
        })),
      );
    }

    it("reads the shown prefix though the newest reply is not loaded, to the last reply shown and never to the newest", async () => {
      fourRepliesBehind();
      hydrateRepliesAt("team-new", 4, [0, 1]);
      mount();
      await waitFor(() => expect(listed()).toEqual(["team-new"]));
      await within(await revealFull("team-new")).findByText("reply 2");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      await showRows("reply 2");

      await vi.waitFor(() =>
        wrote({ messageId: "team-new-reply-2", seq: 2_000 }),
      );
    });

    it("writes the prefix before a gap and nothing across it, and the rest once the gap is hydrated and shown", async () => {
      fourRepliesBehind();
      hydrateRepliesAt("team-new", 4, [0, 1, 3]);
      mount();
      await waitFor(() => expect(listed()).toEqual(["team-new"]));
      await within(await revealFull("team-new")).findByText("reply 4");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      await showRows("reply 2", "reply 4");
      await vi.waitFor(() =>
        wrote({ messageId: "team-new-reply-2", seq: 2_000 }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      wrote({ messageId: "team-new-reply-2", seq: 2_000 });

      hydrateRepliesAt("team-new", 4, [0, 1, 2, 3]);
      await vi.waitFor(() =>
        expect(drawnReplies("team-new")).toContain("reply 3"),
      );
      await showRows("reply 3", "reply 4");
      await vi.waitFor(() =>
        wrote(
          { messageId: "team-new-reply-2", seq: 2_000 },
          { messageId: "team-new-reply-4", seq: 4_000 },
        ),
      );
    });

    it("goes on from a prefix it has read after that history's bodies are evicted, without hydrating it again", async () => {
      fourRepliesBehind();
      hydrateRepliesAt("team-new", 4, [0, 1]);
      mount();
      await waitFor(() => expect(listed()).toEqual(["team-new"]));
      await within(await revealFull("team-new")).findByText("reply 2");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await showRows("reply 2");
      await vi.waitFor(() =>
        wrote({ messageId: "team-new-reply-2", seq: 2_000 }),
      );

      // The window moves on: the read bodies are evicted, the newest two load.
      hydrateRepliesAt("team-new", 4, [2, 3]);
      await vi.waitFor(() =>
        expect(drawnReplies("team-new")).toEqual(["reply 3", "reply 4"]),
      );
      await showRows("reply 3", "reply 4");

      await vi.waitFor(() =>
        wrote(
          { messageId: "team-new-reply-2", seq: 2_000 },
          { messageId: "team-new-reply-4", seq: 4_000 },
        ),
      );
    });
  });

  it("opens a reply's turn from its receipt in a card, landed on the send that wrote the reply", async () => {
    const user = userEvent.setup();
    const reply = botReply({
      messageId: "team-new-bot-1",
      text: "The Windows leg failed.",
      timestamp: 3_000,
    });
    mocks.replyRows["team-new"] = [reply];
    mocks.turns = [
      turnRef({
        chatId: "session-team-new",
        turnId: "turn-1",
        userMessageId: "prompt-1",
        threadId: "team-new",
        startedAt: 2_000,
        endedAt: 3_000,
        summary: "Read 1 file",
        messageIds: [reply.messageId],
        requestIds: [],
      }),
    ];
    mount();
    await waitFor(() => expect(listed()).toContain("team-new"));
    const full = within(await revealFull("team-new"));

    await user.click(await full.findByTestId("bot-turn-receipt"));

    expect(useBotTabLandingStore.getState().byBotId).toEqual({
      [TEAM]: {
        kind: "chat",
        chatId: "session-team-new",
        messageId: "prompt-1",
        sendPostId: reply.messageId,
      },
    });
  });

  it("drops a thread from the list when Unfollow is chosen from its menu", async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() =>
      expect(listed()).toEqual(["team-new", "tracy-old", "team-quiet"]),
    );

    await user.click(
      within(card("tracy-old")).getByTestId("bot-thread-row-menu"),
    );
    await user.click(await screen.findByTestId("bot-thread-row-unfollow"));

    await waitFor(() => expect(listed()).toEqual(["team-new", "team-quiet"]));
    expect(mocks.writes).toEqual([
      { botId: TRACY, threadId: "tracy-old", state: "unfollowed" },
    ]);
  });

  describe("a reply's badge in a card", () => {
    const ANCHOR_ID = conversationRequestMessageId("req-team-new");

    /**
     * `count` rows alternating member, bot, member... as `m1`, `b2`, `m3`...
     * (a reply row is never next to another, which would merge them), with
     * the bot rows' `repliesTo` by row id.
     */
    function alternatingRows(
      count: number,
      repliesTo: Readonly<Partial<Record<string, string>>>,
    ): Message[] {
      return Array.from({ length: count }, (_, index) => {
        const n = index + 1;
        const text = `reply ${String(n)}`;
        const timestamp = 2_000 + n;
        if (n % 2 === 1) {
          return { ...postRow(`m${String(n)}`, text), timestamp };
        }
        const id = `b${String(n)}`;
        const to = repliesTo[id];
        return {
          ...botReply({ messageId: id, text, timestamp }),
          ...(to === undefined ? {} : { repliesTo: to }),
        };
      });
    }

    /** The row that draws `text` as its own message, not as a badge's line. */
    function rowOf(text: string): Element | null | undefined {
      return within(card("team-new"))
        .getAllByText(text)
        .find(
          (node) => node.closest('[data-testid="bot-reply-badge"]') === null,
        )
        ?.closest("[data-message-id]");
    }

    async function foldedCard(rows: Message[]): Promise<HTMLElement> {
      mocks.posts[TEAM] = { [ANCHOR_ID]: "Ship the release?" };
      mocks.replyRows["team-new"] = rows;
      mount();
      await waitFor(() => expect(listed()).toContain("team-new"));
      return revealFull("team-new");
    }

    it("badges the first reply drawn when the message it answers is folded away behind the fold line", async () => {
      // m7 is folded away; b8 and m9 are drawn.
      const full = within(await foldedCard(alternatingRows(9, { b8: "m7" })));

      expect(
        (await full.findByTestId("bot-chat-transcript-unfold")).textContent,
      ).toBe("Show 7 more replies");
      expect(
        full.getByRole("button", { name: /^Replying to .*: reply 7$/ }),
      ).toBeTruthy();
    });

    it("badges the first reply drawn when it answers the thread's opening post, which the fold hides from above it", async () => {
      const full = within(
        await foldedCard(alternatingRows(9, { b8: ANCHOR_ID })),
      );

      await full.findByTestId("bot-chat-transcript-unfold");
      expect(
        full.getByRole("button", {
          name: /^Replying to .*: Ship the release\?$/,
        }),
      ).toBeTruthy();
    });

    it("draws no badge on a drawn reply directly under the message it answers", async () => {
      const full = within(await foldedCard(alternatingRows(8, { b8: "m7" })));

      await full.findByTestId("bot-chat-transcript-unfold");
      expect(full.getByText("reply 8")).toBeTruthy();
      expect(full.queryByTestId("bot-reply-badge")).toBeNull();
    });

    it("unfolds a card to show the message a badge names when it is folded away, then scrolls to it and highlights it", async () => {
      const user = userEvent.setup();
      const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
      scrolled.mockImplementation(() => undefined);
      onTestFinished(() => scrolled.mockRestore());
      const full = within(await foldedCard(alternatingRows(9, { b8: "m3" })));

      await user.click(
        await full.findByRole("button", { name: /^Replying to .*: reply 3$/ }),
      );

      expect(full.queryByTestId("bot-chat-transcript-unfold")).toBeNull();
      const answered = rowOf("reply 3");
      await waitFor(() => expect(scrolled.mock.contexts).toEqual([answered]));
      expect(scrolled).toHaveBeenCalledWith({ block: "nearest" });
      for (const token of CHAT_NAVIGATION_HIGHLIGHT_CLASSNAME.split(" ")) {
        expect(answered?.classList.contains(token)).toBe(true);
      }
    });

    it("scrolls to and highlights a drawn message a badge names, in a card with no fold", async () => {
      const user = userEvent.setup();
      const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
      scrolled.mockImplementation(() => undefined);
      onTestFinished(() => scrolled.mockRestore());
      const full = within(await foldedCard(alternatingRows(5, { b4: "m1" })));
      await full.findByText("reply 5");
      expect(full.queryByTestId("bot-chat-transcript-unfold")).toBeNull();

      await user.click(
        full.getByRole("button", { name: /^Replying to .*: reply 1$/ }),
      );

      const answered = rowOf("reply 1");
      await waitFor(() => expect(scrolled.mock.contexts).toEqual([answered]));
      for (const token of CHAT_NAVIGATION_HIGHLIGHT_CLASSNAME.split(" ")) {
        expect(answered?.classList.contains(token)).toBe(true);
      }
    });
  });
});

describe("<BotThreadsView /> a card whose bot asks several questions at once", () => {
  const DEPLOY: BotQuestionItem = {
    text: "Deploy to staging now or after the train?",
    options: ["Now", "After the train"],
    allowFreeText: false,
    settlement: null,
  };
  const HOLD: BotQuestionItem = {
    text: "Anything to hold back from the train?",
    options: [],
    allowFreeText: true,
    settlement: null,
  };

  /** The bot's reply in the thread: a card of both questions, its text just the questions. */
  function askedBoth(): Message {
    const questions = [DEPLOY, HOLD];
    return {
      ...botReply({
        messageId: "team-new-question",
        text: botQuestionsText(questions),
        timestamp: 3_000,
      }),
      question: { requestId: "req-question", questions },
    };
  }

  /** The Team bot's thread holds the card; the tab's host negotiated 1.5. */
  function mountCardOfBotBoundElsewhere(kinds: readonly string[]): void {
    mountBotBoundElsewhere({ minor: 5, kinds, rows: [askedBoth()] });
  }

  it("draws one Submit and the tally under the card, none under a question, when the bot's host lists answers and this host takes them", async () => {
    mountCardOfBotBoundElsewhere(["answer", "answers"]);
    await waitFor(() => expect(listed()).toContain("team-new"));

    const full = within(await revealFull("team-new"));
    const questionCard = within(await full.findByTestId("question-card"));

    expect(
      (await questionCard.findByTestId("question-card-tally")).textContent,
    ).toBe("0 of 2 answered. Answer at least one to submit.");
    expect(questionCard.getAllByTestId("question-card-submit")).toHaveLength(1);
    for (const item of questionCard.getAllByTestId("question-card-item")) {
      expect(within(item).queryByTestId("question-card-submit")).toBeNull();
    }
  });

  it("draws a Submit under each question, and no tally, when the bot's host does not list answers", async () => {
    mountCardOfBotBoundElsewhere(["answer"]);
    await waitFor(() => expect(listed()).toContain("team-new"));

    const full = within(await revealFull("team-new"));
    const questionCard = within(await full.findByTestId("question-card"));

    expect(questionCard.queryByTestId("question-card-tally")).toBeNull();
    const items = questionCard.getAllByTestId("question-card-item");
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(within(item).getAllByTestId("question-card-submit")).toHaveLength(
        1,
      );
    }
    expect(questionCard.getAllByTestId("question-card-submit")).toHaveLength(2);
  });
});

describe("<BotThreadsView /> Reply on a row of a full thread", () => {
  /** The first `bot.conversation.send` line that carries a reply. */
  const REPLIES_MINOR = 6;
  const REPLY_ROW = botReply({
    messageId: "team-new-reply",
    text: "Staging looks fine.",
    timestamp: 3_000,
  });

  async function fullThread(): Promise<HTMLElement> {
    await waitFor(() => expect(listed()).toContain("team-new"));
    return revealFull("team-new");
  }

  it("offers Reply on a reply of the thread where the bot's host lists replies and this host takes them", async () => {
    mountBotBoundElsewhere({
      minor: REPLIES_MINOR,
      kinds: ["answer", "message", "replies"],
      rows: [REPLY_ROW],
    });

    const full = within(await fullThread());

    expect(await full.findByRole("button", { name: "Reply" })).toBeTruthy();
  });

  it.each([
    [
      "the bot's host does not list replies",
      REPLIES_MINOR,
      ["answer", "message"],
    ],
    [
      "this host negotiated bot.conversation.send below the line that carries a reply",
      REPLIES_MINOR - 1,
      ["answer", "message", "replies"],
    ],
  ])("offers no Reply on the thread where %s", async (_label, minor, kinds) => {
    mountBotBoundElsewhere({ minor, kinds, rows: [REPLY_ROW] });

    const full = within(await fullThread());

    expect(await full.findByText("Staging looks fine.")).toBeTruthy();
    expect(full.queryByRole("button", { name: "Reply" })).toBeNull();
  });
});

describe("<BotThreadsView /> a thread opened on a channel question, drawn without the channel's transcript", () => {
  const QUESTION_ID = "bot-question:req-q";
  const HOLD_TEXT = "Anything to hold back from the train?";

  function question(settled: boolean): Message {
    const questions: BotQuestionItem[] = [
      {
        text: HOLD_TEXT,
        options: [],
        allowFreeText: true,
        settlement: settled
          ? {
              answer: "Nothing",
              skipped: false,
              by: { kind: "person", userId: "user-teammate" },
              at: 3_000,
            }
          : null,
      },
    ];
    return {
      ...botReply({
        messageId: QUESTION_ID,
        text: botQuestionsText(questions),
        timestamp: 2_000,
      }),
      question: { requestId: "req-q", questions },
    };
  }

  /** When the running case started, on the real clock, which the fake one leaves alone. */
  let caseStartedAt = 0;
  /** The running case's own timeout, as the runner holds it. */
  let caseTimeout = 0;
  beforeEach(({ task }) => {
    caseStartedAt = performance.now();
    caseTimeout = task.timeout;
  });

  /**
   * The fake clock moves until `check` holds: what the view starts on a timer,
   * and what the host's replies feed, finishes in it. Some of what it waits
   * on runs on the real event loop, so the steps it takes are not countable:
   * it gives up on the real clock instead, once another step would end past
   * the case's own timeout, and throws the check's last error rather than
   * leave the runner to time out.
   */
  async function untilOnFakeClock(check: () => void): Promise<void> {
    const deadline = caseStartedAt + caseTimeout;
    let last: unknown = null;
    for (;;) {
      const stepStartedAt = performance.now();
      try {
        check();
        return;
      } catch (error) {
        last = error;
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      if (performance.now() + (performance.now() - stepStartedAt) >= deadline) {
        throw last;
      }
    }
  }

  it("moves nothing off the origin's card when a teammate settles the question: the draft stays kept, and the thread's box holds nothing and says nothing", async () => {
    const summary = thread(TEAM, "team-new", 3_000);
    const { anchor } = summary;
    if (anchor === null) throw new Error("the thread has no anchor");
    mocks.hosted[TEAM] = script(
      [
        {
          ...summary,
          anchor: {
            messageId: QUESTION_ID,
            requestId: anchor.requestId,
            senderUserId: anchor.senderUserId,
            sentAt: anchor.sentAt,
            resolvedAt: anchor.resolvedAt,
            excerpt: anchor.excerpt,
          },
        },
      ],
      { "team-new": FOLLOWING },
    );
    mocks.hosted[TRACY] = script([], {});
    mocks.posts[TEAM] = {};
    mocks.channels[TEAM] = chatSessionWithThreadRows([question(false)]);
    withReplies(TEAM, "team-new", replyTexts(2), 3_000);
    const key = answerDraftKey(QUESTION_ID, 0);
    useBotDraftsStore.getState().setAnswer(TEAM, key, {
      chosen: [],
      typed: "Hold the migration",
      sent: null,
      unsureSince: null,
      heldForSettlement: null,
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mount();
    await untilOnFakeClock(() => expect(listed()).toContain("team-new"));
    intersectTarget(card("team-new"), "near", true);
    await untilOnFakeClock(() =>
      expect(card("team-new").getAttribute("data-full")).toBe("true"),
    );
    const full = within(card("team-new"));
    await untilOnFakeClock(() => full.getByTestId("question-card"));
    const originCard = full.getByTestId("question-card");
    expect(
      within(originCard).getByRole("textbox", { name: "Your answer" }),
    ).toHaveProperty("value", "Hold the migration");

    act(() =>
      mocks.channels[TEAM].store.setState({ messages: [question(true)] }),
    );

    await untilOnFakeClock(() => full.getByTestId("question-card-item"));
    const item = full.getByTestId("question-card-item");
    expect(item.getAttribute("data-state")).toBe("settled");
    expect(useBotDraftsStore.getState().answers[TEAM]?.[key]?.typed).toBe(
      "Hold the migration",
    );
    expect(useBotDraftsStore.getState().boxCarries).toEqual({});
    expect(useBotDraftsStore.getState().boxNotices).toEqual({});
    expect(full.queryByTestId("bot-thread-composer-answers-moved")).toBeNull();
  });
});

describe("<BotThreadsView /> header", () => {
  it("goes back to the tab's channel when Back to Tracy is clicked", async () => {
    const user = userEvent.setup();
    mocks.hosted[TRACY] = script([], {});
    mocks.hosted[TEAM] = script([], {});
    mount();

    const back = screen.getByRole("button", { name: "Back to Tracy" });
    await user.click(back);

    expect(mocks.back).toHaveBeenCalledTimes(1);
  });

  it("draws no back control beside a level 2 column, whose channel row is the way back", () => {
    setMountLevel2({ column: 256 });
    mocks.hosted[TRACY] = script([], {});
    mocks.hosted[TEAM] = script([], {});
    mount();

    expect(screen.queryByTestId("bot-threads-back")).toBeNull();
  });

  it("draws the back control at every width of the menu form", () => {
    setMountLevel2("menu");
    mocks.hosted[TRACY] = script([], {});
    mocks.hosted[TEAM] = script([], {});
    mount();

    expect(screen.getByTestId("bot-threads-back").className).not.toContain(
      "@3xl",
    );
  });
});

const TRACY_REF = { kind: "tracy", id: "tracy" } as const;

function focusTracy(): void {
  useTabsStore.setState({
    items: [{ kind: "tab", id: tabItemId(TRACY_REF), ref: TRACY_REF }],
    activeItemId: tabItemId(TRACY_REF),
    stripOrder: [TRACY_REF],
  });
}

function mountUnderTracyHeader(level2: MobileLevel2Form | null): void {
  focusTracy();
  setMountUnderHeader(true);
  setMountLevel2(level2);
  mocks.hosted[TRACY] = script([], {});
  mocks.hosted[TEAM] = script([], {});
  mount();
}

describe("<BotThreadsView /> in the compact app header", () => {
  afterEach(() => {
    useTabsStore.setState(useTabsStore.getInitialState(), true);
  });

  it.each(["menu", "bar"] as const)(
    "draws a Threads picker and the Back control in the app header at the %s form, not in the view's own header",
    (form) => {
      mountUnderTracyHeader(form);

      const header = screen.getByTestId("app-header");
      expect(
        within(header).getByRole("button", { name: /^Threads$/ }),
      ).toBeTruthy();
      expect(
        within(header).getByRole("button", { name: "Back to Tracy" }),
      ).toBeTruthy();
      expect(
        within(screen.getByTestId("bot-threads-view")).queryByRole("button", {
          name: /^Threads$/,
        }),
      ).toBeNull();
    },
  );

  it("goes back to the tab's channel from the header's Back control", async () => {
    const user = userEvent.setup();
    mountUnderTracyHeader("menu");

    await user.click(
      within(screen.getByTestId("app-header")).getByRole("button", {
        name: "Back to Tracy",
      }),
    );

    expect(mocks.back).toHaveBeenCalledTimes(1);
  });

  it("opens the bots list from the Threads picker in the header", async () => {
    const user = userEvent.setup();
    mountUnderTracyHeader("menu");

    await user.click(
      within(screen.getByTestId("app-header")).getByRole("button", {
        name: /^Threads$/,
      }),
    );

    expect(await screen.findByTestId("bot-channel-picker")).toBeTruthy();
  });

  it("draws nothing in the header beside a column, where the channel row is the way back", () => {
    mountUnderTracyHeader({ column: 256 });

    const header = screen.getByTestId("app-header");
    expect(
      within(header).queryByRole("button", { name: /^Threads$/ }),
    ).toBeNull();
    expect(
      within(header).queryByRole("button", { name: "Back to Tracy" }),
    ).toBeNull();
  });

  it("takes the picker and Back out of the header when the view unmounts", () => {
    mountUnderTracyHeader("menu");
    const header = screen.getByTestId("app-header");
    expect(
      within(header).getByRole("button", { name: /^Threads$/ }),
    ).toBeTruthy();

    cleanup();

    expect(screen.queryByRole("button", { name: /^Threads$/ })).toBeNull();
  });
});

describe("<BotThreadsView /> the tab's music group", () => {
  const GROUP = { name: "Music playback" } as const;

  beforeEach(() => {
    mocks.hosted[TRACY] = script([], {});
    mocks.hosted[TEAM] = script([], {});
    useSettingsStore.setState({
      soundtrackEnabled: true,
      soundtrackPlaybackControls: true,
    });
  });
  afterEach(() => {
    useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  });

  it("draws the one group in the desktop header's title row after the heading, and no row of its own", () => {
    mount();

    const view = screen.getByTestId("bot-threads-view");
    // `getByRole` throws on a second group, as it does on none.
    const group = screen.getByRole("group", GROUP);
    const header = group.closest("header");
    expect(header?.parentElement).toBe(view);
    const heading = within(view).getByRole("heading", { name: "Threads" });
    expect(header?.contains(heading)).toBe(true);
    expect(
      heading.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it.each(["menu", "bar"] as const)(
    "gives the %s form no slot: the group is the tab's own row, outside the view",
    (form) => {
      setMountLevel2(form);
      mount();

      const view = screen.getByTestId("bot-threads-view");
      expect(within(view).queryByTestId("tracy-playback-slot")).toBeNull();
      expect(view.contains(screen.getByRole("group", GROUP))).toBe(false);
    },
  );
});

describe("<BotThreadsView /> before the bots are listed", () => {
  it("shows its loading state while the bot list is read, not the empty state", () => {
    mocks.botList = "pending";
    mount();

    expect(screen.getByTestId("bot-threads-loading")).toBeTruthy();
    expect(screen.queryByText("No threads yet.")).toBeNull();
  });

  it("says the read failed when the bot list does, and Retry reads it again", async () => {
    const user = userEvent.setup();
    mocks.botList = "failed";
    mount();

    const failure = screen.getByTestId("bot-threads-error");
    expect(failure.textContent).toContain("Couldn't load your threads.");
    expect(failure.className).toContain("text-destructive");
    expect(screen.queryByText("No threads yet.")).toBeNull();
    await user.click(within(failure).getByRole("button", { name: "Retry" }));

    expect(mocks.refetchBots).toHaveBeenCalledTimes(1);
  });
});

describe("<BotThreadsView /> with nothing to list", () => {
  it("says there are no threads yet when the person follows none", async () => {
    mocks.hosted[TRACY] = script([thread(TRACY, "tracy-a", 1_000)], {});
    mocks.hosted[TEAM] = script([], {});
    mount();

    expect(await screen.findByText("No threads yet.")).toBeTruthy();
  });

  it("says once that the host cannot list the threads, where it does not read follows", () => {
    mocks.unsupported.add("bot.threadFollow.read");
    mount();

    expect(
      screen.getAllByText("This host can't list your threads."),
    ).toHaveLength(1);
    expect(screen.queryByTestId("bot-thread-card")).toBeNull();
  });
});

/**
 * A member's own reply in a card's thread, drawn while its host has not
 * answered (Tracy Bots T249): the card's thread is the REAL chat session store
 * on the windowed line, fed a host's frames, drawn in the page's flow rows. The
 * host's index names the reply at the next ordinal before any frame has
 * carried its body.
 */
describe("a member's own reply in a card, drawn before its host answers", () => {
  const THREAD = "team-a";
  const CHANNEL = `channel-${TEAM}`;
  const REPLY_TEXT = "Is the nightly green?";
  /**
   * When the host stored the reply, later than the press stamped the pending
   * row: a read position past the pending row's own cannot be the pending
   * row's, whatever the clock says.
   */
  let hostStoredAt = 0;
  const IDS: WindowedChatIds = {
    epicId: TEAM,
    chatId: THREAD,
    hostId: "host-1",
    ownerId: "user-1",
    title: "Thread",
  };
  let session: WindowedSession;

  function earlierReply(): Extract<Message, { role: "user" }> {
    return {
      role: "user",
      messageId: "team-a-reply-1",
      sender: { type: "user", userId: "user-teammate" },
      message: {
        kind: "user",
        content: paragraph("Looking now."),
        browserAnnotations: [],
      },
      timestamp: 500,
      sessionAnchor: null,
    };
  }

  /** The card of `THREAD` over a windowed session holding one earlier reply, revealed in full. */
  async function revealedWindowedCard(): Promise<void> {
    foregroundWindow();
    mocks.hosted[TRACY] = script([], {});
    mocks.hosted[TEAM] = script([thread(TEAM, THREAD, 5_000)], {
      [THREAD]: FOLLOWING,
    });
    session = createWindowedSession(IDS);
    openWindowedChat(session, IDS, {
      messages: [earlierReply()],
      events: [],
      activeTurnId: null,
      chatId: THREAD,
    });
    mocks.threadSessions[THREAD] = session.handle;
    mocks.replies[THREAD] = [];
    mount();
    await waitFor(() => expect(listed()).toContain(THREAD));
    await revealFull(THREAD);
    await within(card(THREAD)).findByText("Looking now.");
  }

  /** The member presses Send on a reply in this thread: the real start of a send. */
  function pressReply(): {
    readonly rowId: string;
    readonly request: BotConversationSendRequest;
  } {
    const held: { started: BotPendingSendStart | null } = { started: null };
    act(() => {
      held.started = startPendingSend({
        request: {
          botId: TEAM,
          conversationId: CHANNEL,
          text: REPLY_TEXT,
          threadId: THREAD,
          announcementId: null,
          redeliver: null,
          supersedes: null,
          answer: null,
        },
        authority: { hostId: "host-1", hostEpoch: 1 },
        senderUserId: "user-1",
        sentAs: { lifetime: currentBotLifetime(), account: "user-1" },
        text: REPLY_TEXT,
        content: paragraph(REPLY_TEXT),
        images: [],
        release: () => undefined,
      });
    });
    if (held.started === null) throw new Error("Send started nothing");
    const { messageId, request } = held.started;
    hostStoredAt = Date.now() + 1_000;
    return { rowId: messageId, request };
  }

  function replyRows(): HTMLElement[] {
    return within(card(THREAD))
      .queryAllByTestId("bot-member-row")
      .filter((row) => row.textContent.includes(REPLY_TEXT));
  }

  function theReplyRow(step: string): HTMLElement {
    const rows = replyRows();
    expect(
      rows,
      `${step}: the reply was drawn as ${String(rows.length)} row(s); the card shows: ${card(THREAD).textContent.slice(0, 300)}`,
    ).toHaveLength(1);
    return rows[0];
  }

  /** The person looks at the reply's row for `ms`: whole in view, in a focused window. */
  async function viewReplyFor(ms: number): Promise<void> {
    // The card's view observer watches the row once the cursor read names a target.
    await waitFor(() =>
      expect(
        observersOf(readRow(THREAD, REPLY_TEXT), "view").length,
      ).toBeGreaterThan(0),
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    intersectTarget(readRow(THREAD, REPLY_TEXT), "view", true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
    vi.useRealTimers();
  }

  afterEach(() => {
    session.handle.dispose();
    useBotPendingSendsStore.setState(
      useBotPendingSendsStore.getInitialState(),
      true,
    );
  });

  it("stays one row, the same row, with its text, from the press through the index naming it to its body arriving", async () => {
    await revealedWindowedCard();
    const { rowId, request } = pressReply();
    const drawn = theReplyRow("at the press");

    act(() => {
      indexNamesAppendedRow(session, IDS, {
        rowCount: 2,
        indexRevision: 2,
        entry: userSkeletonEntry(rowId, Date.now()),
      });
    });

    expect(
      theReplyRow("after the index named the reply, before its body"),
      "the reply was replaced by another node",
    ).toBe(drawn);

    act(() => {
      messageAccepted(
        session,
        IDS,
        storedRowOfSend(request, "user-1", hostStoredAt),
      );
    });

    expect(theReplyRow("after the body arrived")).toBe(drawn);
  });

  it("acknowledges nothing under the pending reply: no advance with it in view until its body is drawn, then one read", async () => {
    foregroundWindow();
    await revealedWindowedCard();
    const { rowId, request } = pressReply();
    act(() => {
      indexNamesAppendedRow(session, IDS, {
        rowCount: 2,
        indexRevision: 2,
        entry: userSkeletonEntry(rowId, Date.now()),
      });
    });
    // The host has written the reply, and its read names it the newest.
    mocks.hosted[TEAM].cursors = {
      cursors: { [THREAD]: { messageId: "team-a-reply-1", seq: 500 } },
      latest: { [THREAD]: { messageId: rowId, seq: hostStoredAt } },
    };
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    // The person looks at the pending reply, well past the read hold.
    await viewReplyFor(2_000);

    expect(
      mocks.advances,
      "the card's read advanced to a reply whose body has not landed",
    ).toEqual([]);

    act(() => {
      messageAccepted(
        session,
        IDS,
        storedRowOfSend(request, "user-1", hostStoredAt),
      );
    });
    // The stored row is in view again, for the read hold.
    await viewReplyFor(2_000);

    await waitFor(() =>
      expect(mocks.advances).toEqual([
        {
          botId: TEAM,
          conversationId: THREAD,
          messageId: rowId,
          seq: hostStoredAt,
        },
      ]),
    );
  });

  it("CONTROL: earns no read credit while the window is void: no advance with the row in view, then one read once the stored body is drawn", async () => {
    foregroundWindow();
    await revealedWindowedCard();
    const { rowId, request } = pressReply();
    act(() => {
      indexNamesAppendedRow(session, IDS, {
        rowCount: 2,
        indexRevision: 2,
        entry: userSkeletonEntry(rowId, Date.now()),
      });
    });
    // The host has written the reply, and its read names it the newest.
    mocks.hosted[TEAM].cursors = {
      cursors: { [THREAD]: { messageId: "team-a-reply-1", seq: 500 } },
      latest: { [THREAD]: { messageId: rowId, seq: hostStoredAt } },
    };
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    // The host reindexes under the held reply: the window is void, and no
    // replacement has been answered.
    act(() => {
      indexReindexed(session, IDS, { epoch: 2, rowCount: 2, indexRevision: 2 });
    });
    expect(
      session.handle.store.getState().transcriptWindow.invalidated,
      "the reindex did not void the window",
    ).toBe(true);
    // The person looks at the reply's row while the window is void.
    await viewReplyFor(2_000);

    expect(
      mocks.advances,
      "the card's read advanced while the window was void",
    ).toEqual([]);

    act(() => {
      recoverWindowedChat(
        session,
        IDS,
        {
          messages: [
            earlierReply(),
            storedRowOfSend(request, "user-1", hostStoredAt),
          ],
          events: [],
          activeTurnId: null,
          chatId: THREAD,
        },
        { epoch: 2, indexRevision: 3 },
      );
    });
    // The stored row is in view again, for the read hold.
    await viewReplyFor(2_000);

    await waitFor(() =>
      expect(mocks.advances).toEqual([
        {
          botId: TEAM,
          conversationId: THREAD,
          messageId: rowId,
          seq: hostStoredAt,
        },
      ]),
    );
  });
});
