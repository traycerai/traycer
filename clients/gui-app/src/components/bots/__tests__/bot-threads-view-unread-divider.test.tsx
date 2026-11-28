/**
 * The unread divider in a thread card, through the real `<BotThreadsView />`:
 * the divider above the first reply another member wrote past the person's
 * read cursor, where the unread pill and a reply's badge land the page, and
 * the cases where a landing must wait or must not pull the page. The fixtures,
 * the mounted tree and the per-case lifecycle are in
 * `bot-threads-view-harness.tsx`; the other cases are in
 * `bot-threads-view.test.tsx`.
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
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
  type MockInstance,
} from "vitest";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import { conversationRequestMessageId } from "@traycer/protocol/persistence/epic/messages";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import type { TabNavigationIntent } from "@/lib/tab-navigation/intents";
import { CHAT_NAVIGATION_HIGHLIGHT_CLASSNAME } from "@/components/chat/chat-navigation-highlight";
import {
  botReply,
  memberPost,
} from "@/components/bots/__tests__/bot-turn-test-support";
import {
  chatSessionWithPosts,
  chatSessionWithThreadRows,
  postRow,
} from "./bot-channel-rows-test-support";
import {
  claimFullscreen,
  releaseFullscreen,
  type FullscreenClaim,
} from "@/lib/sandbox/overlay-owner";
import { mocks } from "./bot-threads-view-state";
import {
  foregroundWindow,
  intersectTarget,
} from "@/components/bots/__tests__/bot-read-observer-test-support";
import {
  card,
  drawnReplies,
  FOLLOWING,
  installBotThreadsViewCaseLifecycle,
  listed,
  mount,
  readRow,
  replyTexts,
  revealFull,
  script,
  setPaneVisible,
  TEAM,
  thread,
  TRACY,
  windowedSession,
  withReplies,
} from "./bot-threads-view-harness";

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

describe("<BotThreadsView /> unread divider (T467)", () => {
  const VIEWER = "user-1";
  const COLLEAGUE = "user-2";

  beforeEach(() => {
    mocks.hosted[TRACY] = script([], {});
  });

  /** The Team bot's followed threads, none with a reply yet. */
  function followedThreads(...threadIds: string[]): void {
    mocks.hosted[TEAM] = script(
      threadIds.map((threadId) => thread(TEAM, threadId, null)),
      Object.fromEntries(threadIds.map((threadId) => [threadId, FOLLOWING])),
    );
  }

  function replyId(threadId: string, n: number): string {
    return `${threadId}-reply-${String(n)}`;
  }

  /**
   * The thread holds `count` replies, reply `n` written at `n` seconds: by the
   * viewer where `ownAt` lists `n`, by another member otherwise. The host's
   * newest row is the last reply, and the person's cursor sits on `readTo`.
   */
  function unreadFrom(input: {
    readonly threadId: string;
    readonly count: number;
    readonly ownAt: ReadonlyArray<number>;
    readonly readTo: number;
  }): void {
    const { threadId, count, ownAt, readTo } = input;
    withReplies(TEAM, threadId, replyTexts(count), count * 1_000);
    mocks.replyRows[threadId] = replyTexts(count).map(
      (text, index): Message => {
        const n = index + 1;
        return {
          ...memberPost({
            messageId: replyId(threadId, n),
            requestId: replyId(threadId, n),
            lines: [text],
            timestamp: n * 1_000,
            resolvedBy: null,
          }),
          sender: {
            type: "user",
            userId: ownAt.includes(n) ? VIEWER : COLLEAGUE,
          },
        };
      },
    );
    const read = mocks.hosted[TEAM].cursors;
    mocks.hosted[TEAM].cursors = {
      cursors: {
        ...read.cursors,
        [threadId]: {
          messageId: replyId(threadId, readTo),
          seq: readTo * 1_000,
        },
      },
      latest: {
        ...read.latest,
        [threadId]: { messageId: replyId(threadId, count), seq: count * 1_000 },
      },
    };
  }

  /** The unread dividers a card draws. */
  function dividersIn(threadId: string): HTMLElement[] {
    return Array.from(
      card(threadId).querySelectorAll<HTMLElement>("[data-unread-divider]"),
    );
  }

  /**
   * The id of the message row directly under the card's one divider: the row
   * that holds it, or else the first row after it.
   */
  function rowUnderDivider(threadId: string): string | undefined {
    const dividers = dividersIn(threadId);
    expect(dividers).toHaveLength(1);
    const [divider] = dividers;
    const inOrder = Array.from(
      card(threadId).querySelectorAll<HTMLElement>(
        "[data-unread-divider], [data-message-id]",
      ),
    );
    const under =
      divider.closest("[data-message-id]") ??
      inOrder
        .slice(inOrder.indexOf(divider) + 1)
        .find((node) => node.dataset.messageId !== undefined);
    return under instanceof HTMLElement ? under.dataset.messageId : undefined;
  }

  /** The message rows of a card painted with the navigation highlight. */
  function highlightedRows(threadId: string): Element[] {
    const marks = CHAT_NAVIGATION_HIGHLIGHT_CLASSNAME.split(" ");
    return Array.from(
      card(threadId).querySelectorAll("[data-message-id]"),
    ).filter((row) => marks.some((mark) => row.classList.contains(mark)));
  }

  /** Replaces scrollIntoView with a recorder, restored after the case. */
  function recordScrolls(): MockInstance<Element["scrollIntoView"]> {
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
    scrolled.mockImplementation(() => undefined);
    onTestFinished(() => scrolled.mockRestore());
    return scrolled;
  }

  it("draws one divider directly above the first reply after the person's cursor, and none in a card whose cursor is on its newest reply", async () => {
    followedThreads("team-new", "team-read");
    unreadFrom({ threadId: "team-new", count: 4, ownAt: [], readTo: 2 });
    unreadFrom({ threadId: "team-read", count: 3, ownAt: [], readTo: 3 });
    mount();
    await waitFor(() => expect(listed()).toEqual(["team-new", "team-read"]));
    await within(await revealFull("team-new")).findByText("reply 4");
    await within(await revealFull("team-read")).findByText("reply 3");

    expect(dividersIn("team-new")).toHaveLength(1);
    expect(rowUnderDivider("team-new")).toBe(replyId("team-new", 3));
    expect(dividersIn("team-read")).toHaveLength(0);
  });

  it("skips the viewer's own replies: the divider goes above the first reply another member wrote, and none where every reply past the cursor is the viewer's", async () => {
    followedThreads("team-mixed", "team-own");
    unreadFrom({ threadId: "team-mixed", count: 5, ownAt: [3, 4], readTo: 2 });
    unreadFrom({ threadId: "team-own", count: 4, ownAt: [3, 4], readTo: 2 });
    mount();
    await waitFor(() => expect(listed()).toEqual(["team-mixed", "team-own"]));
    await within(await revealFull("team-mixed")).findByText("reply 5");
    await within(await revealFull("team-own")).findByText("reply 4");

    expect(dividersIn("team-mixed")).toHaveLength(1);
    expect(rowUnderDivider("team-mixed")).toBe(replyId("team-mixed", 5));
    expect(dividersIn("team-own")).toHaveLength(0);
  });

  it("keeps the divider where it was once the replies have been read, and draws none when the page is mounted again at the newest reply", async () => {
    foregroundWindow();
    followedThreads("team-read", "team-unread");
    unreadFrom({ threadId: "team-read", count: 4, ownAt: [], readTo: 2 });
    unreadFrom({ threadId: "team-unread", count: 3, ownAt: [], readTo: 1 });
    mount();
    await waitFor(() => expect(listed()).toEqual(["team-read", "team-unread"]));
    await within(await revealFull("team-read")).findByText("reply 4");
    await within(await revealFull("team-unread")).findByText("reply 3");
    expect(dividersIn("team-read")).toHaveLength(1);
    expect(rowUnderDivider("team-read")).toBe(replyId("team-read", 3));

    // Both unread replies stay whole in view for the read's second; the whole
    // read runs on the fake clock, as the cache write's notification is a
    // zero-delay timer.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    intersectTarget(readRow("team-read", "reply 3"), "view", true);
    intersectTarget(readRow("team-read", "reply 4"), "view", true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await vi.waitFor(() =>
      expect(mocks.advances.at(-1)).toEqual({
        botId: TEAM,
        conversationId: "team-read",
        messageId: replyId("team-read", 4),
        seq: 4_000,
      }),
    );
    await vi.waitFor(() =>
      expect(
        within(card("team-read")).queryByTestId("bot-thread-row-new-replies"),
      ).toBeNull(),
    );
    vi.useRealTimers();

    expect(rowUnderDivider("team-read")).toBe(replyId("team-read", 3));

    cleanup();
    mount();
    await waitFor(() => expect(listed()).toEqual(["team-read", "team-unread"]));
    await within(await revealFull("team-read")).findByText("reply 4");
    await within(await revealFull("team-unread")).findByText("reply 3");
    // The other card draws its divider once the cursors are read.
    await waitFor(() => expect(dividersIn("team-unread")).toHaveLength(1));
    expect(dividersIn("team-read")).toHaveLength(0);
  });

  it("keeps the divider where it was once Mark all read moves the cursor", async () => {
    followedThreads("team-new");
    unreadFrom({ threadId: "team-new", count: 4, ownAt: [], readTo: 2 });
    mount();
    await waitFor(() => expect(listed()).toEqual(["team-new"]));
    await within(await revealFull("team-new")).findByText("reply 4");
    expect(dividersIn("team-new")).toHaveLength(1);
    expect(rowUnderDivider("team-new")).toBe(replyId("team-new", 3));

    fireEvent.click(
      within(screen.getByTestId("bot-unread-banner")).getByRole("button", {
        name: "Mark all read",
      }),
    );

    await waitFor(() =>
      expect(screen.queryByTestId("bot-unread-banner")).toBeNull(),
    );
    expect(mocks.advances).toEqual([
      {
        botId: TEAM,
        conversationId: "team-new",
        messageId: replyId("team-new", 4),
        seq: 4_000,
      },
    ]);
    expect(rowUnderDivider("team-new")).toBe(replyId("team-new", 3));
  });

  it("unfolds a folded card from the unread pill and scrolls the card's divider to the top, highlighting no row", async () => {
    const user = userEvent.setup();
    const scrolled = recordScrolls();
    followedThreads("team-new");
    unreadFrom({ threadId: "team-new", count: 8, ownAt: [], readTo: 2 });
    mount();
    await waitFor(() => expect(listed()).toEqual(["team-new"]));
    const full = within(await revealFull("team-new"));
    expect(
      (await full.findByTestId("bot-chat-transcript-unfold")).textContent,
    ).toBe("Show 6 more replies");

    await user.click(await screen.findByTestId("bot-threads-unread-pill"));

    await waitFor(() =>
      expect(drawnReplies("team-new")).toEqual(replyTexts(8)),
    );
    expect(dividersIn("team-new")).toHaveLength(1);
    expect(rowUnderDivider("team-new")).toBe(replyId("team-new", 3));
    const [divider] = dividersIn("team-new");
    await waitFor(() => expect(scrolled.mock.contexts.at(-1)).toBe(divider));
    expect(scrolled.mock.calls.at(-1)?.[0]).toMatchObject({ block: "start" });
    expect(highlightedRows("team-new")).toEqual([]);
  });

  it("unfolds first when a reply's badge names the raised boundary row, and lands on that row in place", async () => {
    const scrolled = recordScrolls();
    followedThreads("team-new");
    unreadFrom({ threadId: "team-new", count: 8, ownAt: [], readTo: 2 });
    // The bot wrote reply 8 in answer to reply 3: it draws a badge.
    mocks.replyRows["team-new"] = mocks.replyRows["team-new"].map(
      (row, index) =>
        index === 7
          ? {
              ...botReply({
                messageId: replyId("team-new", 8),
                text: "reply 8",
                timestamp: 8_000,
              }),
              repliesTo: replyId("team-new", 3),
            }
          : row,
    );
    mount();
    await waitFor(() => expect(listed()).toEqual(["team-new"]));
    const full = within(await revealFull("team-new"));
    await full.findByTestId("bot-chat-transcript-unfold");
    const claim: FullscreenClaim = {
      exit: vi.fn(),
      pinnedRowKey: replyId("team-new", 3),
      surface: null,
    };
    act(() => {
      expect(claimFullscreen(claim)).toBe(true);
    });
    onTestFinished(() => releaseFullscreen(claim));
    const drawnIds = (): string =>
      Array.from(
        card("team-new").querySelectorAll<HTMLElement>("[data-message-id]"),
      )
        .map((row) => row.dataset.messageId)
        .join(",");
    // A bot reply's row is named by its timestamp, not by its message id.
    const rowIdOf = (n: number): string =>
      n === 8 ? "assistant:ts:8000" : replyId("team-new", n);
    await waitFor(() =>
      expect(drawnIds()).toBe([3, 7, 8].map(rowIdOf).join(",")),
    );

    fireEvent.click(
      full.getByRole("button", { name: /^Replying to .*: reply 3$/ }),
    );

    // The row is only drawn out of order, so the card unfolds before landing.
    await waitFor(() =>
      expect(drawnIds()).toBe([1, 2, 3, 4, 5, 6, 7, 8].map(rowIdOf).join(",")),
    );
    expect(full.queryByTestId("bot-chat-transcript-unfold")).toBeNull();
    await waitFor(() =>
      expect(scrolled.mock.contexts.at(-1)).toBe(
        card("team-new").querySelector(`[data-message-id="${rowIdOf(3)}"]`),
      ),
    );
  });

  it("lands the pill on a card's divider where it draws one, and on the card itself where its new replies are all the viewer's own, highlighting no row", async () => {
    const user = userEvent.setup();
    const scrolled = recordScrolls();
    followedThreads("team-new", "team-own");
    unreadFrom({ threadId: "team-new", count: 4, ownAt: [], readTo: 2 });
    unreadFrom({ threadId: "team-own", count: 3, ownAt: [3], readTo: 2 });
    mount();
    await waitFor(() => expect(listed()).toEqual(["team-new", "team-own"]));
    await within(await revealFull("team-new")).findByText("reply 4");
    await within(await revealFull("team-own")).findByText("reply 3");
    const pill = await screen.findByTestId("bot-threads-unread-pill");
    expect(pill.textContent).toBe("2 unread threads");
    expect(dividersIn("team-new")).toHaveLength(1);
    expect(dividersIn("team-own")).toHaveLength(0);
    // jsdom lays nothing out: place the cards against the page's top by hand.
    const place = (element: HTMLElement, top: number): void => {
      vi.spyOn(element, "getBoundingClientRect").mockReturnValue(
        new DOMRect(0, top, 100, 100),
      );
    };
    place(screen.getByTestId("bot-threads-scroll"), 0);
    place(card("team-new"), 200);
    place(card("team-own"), 600);

    scrolled.mockClear();
    await user.click(pill);

    const [divider] = dividersIn("team-new");
    await waitFor(() => expect(scrolled.mock.contexts).toHaveLength(1));
    expect(scrolled.mock.contexts[0]).toBe(divider);
    expect(scrolled.mock.calls[0][0]).toMatchObject({ block: "start" });
    expect(highlightedRows("team-new")).toEqual([]);

    // The first card now starts above the page's top: on to the next.
    place(card("team-new"), -100);
    await user.click(pill);

    await waitFor(() =>
      expect(scrolled.mock.contexts.at(-1)).toBe(card("team-own")),
    );
    expect(scrolled.mock.calls.at(-1)?.[0]).toMatchObject({ block: "start" });
    expect(dividersIn("team-own")).toHaveLength(0);
    expect(highlightedRows("team-own")).toEqual([]);
  });

  it("draws no divider where the cursor's message is not among the card's loaded rows", async () => {
    followedThreads("team-gone", "team-loaded");
    unreadFrom({ threadId: "team-gone", count: 4, ownAt: [], readTo: 2 });
    unreadFrom({ threadId: "team-loaded", count: 3, ownAt: [], readTo: 1 });
    // The session holds only the newest two replies, not the one the cursor is on.
    mocks.replyRows["team-gone"] = mocks.replyRows["team-gone"].slice(2);
    mount();
    await waitFor(() => expect(listed()).toEqual(["team-gone", "team-loaded"]));
    await within(await revealFull("team-gone")).findByText("reply 4");
    await within(await revealFull("team-loaded")).findByText("reply 3");

    expect(drawnReplies("team-gone")).toEqual(["reply 3", "reply 4"]);
    expect(dividersIn("team-loaded")).toHaveLength(1);
    expect(dividersIn("team-gone")).toHaveLength(0);
  });

  it("clears the highlight a reply's badge landed when the unread pill lands, and highlights again when the badge is used after it", async () => {
    const scrolled = recordScrolls();
    followedThreads("team-new");
    unreadFrom({ threadId: "team-new", count: 5, ownAt: [], readTo: 2 });
    // The bot wrote reply 5 in answer to reply 1, which is not the row above
    // it: it draws a badge.
    mocks.replyRows["team-new"] = mocks.replyRows["team-new"].map(
      (row, index) =>
        index === 4
          ? {
              ...botReply({
                messageId: replyId("team-new", 5),
                text: "reply 5",
                timestamp: 5_000,
              }),
              repliesTo: replyId("team-new", 1),
            }
          : row,
    );
    mount();
    await waitFor(() => expect(listed()).toEqual(["team-new"]));
    const full = within(await revealFull("team-new"));
    await full.findByText("reply 5");
    const badge = (): HTMLElement =>
      full.getByRole("button", { name: /^Replying to .*: reply 1$/ });
    const highlightedIds = (): Array<string | null> =>
      highlightedRows("team-new").map((row) =>
        row.getAttribute("data-message-id"),
      );
    expect(dividersIn("team-new")).toHaveLength(1);
    const [divider] = dividersIn("team-new");
    const pill = await screen.findByTestId("bot-threads-unread-pill");

    // The clock stands still from the badge's landing to the pill's, so the
    // highlight's three seconds cannot be up before the pill clears it.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(badge());
    expect(highlightedIds()).toEqual([replyId("team-new", 1)]);

    fireEvent.click(pill);

    expect(scrolled.mock.contexts.at(-1)).toBe(divider);
    expect(scrolled.mock.calls.at(-1)?.[0]).toMatchObject({ block: "start" });
    expect(highlightedIds()).toEqual([]);

    fireEvent.click(badge());

    expect(highlightedIds()).toEqual([replyId("team-new", 1)]);
  });

  describe("a landing on the unread divider that cannot happen yet", () => {
    const THREAD = "team-new";
    const OTHER = "team-other";
    const TO_REPLY_1 = /^Replying to .*: reply 1$/;
    const TO_OPENING_POST = /^Replying to .*: Ship the release\?$/;
    const OPENING_POST_ID = conversationRequestMessageId("req-team-new");
    /** The message reply 4 of the thread answers. */
    let answers = replyId(THREAD, 1);
    /** What reply 4 says. */
    let replyFourText = "reply 4";

    beforeEach(() => {
      answers = replyId(THREAD, 1);
      replyFourText = "reply 4";
    });

    /** Reply `n` as a colleague's row; reply 4 is the bot's, answering reply 1, so it draws a badge. */
    function replyMessage(n: number): { message: Message; rowId: string } {
      const id = replyId(THREAD, n);
      if (n === 4) {
        return {
          message: {
            ...botReply({
              messageId: id,
              text: replyFourText,
              timestamp: n * 1_000,
            }),
            repliesTo: answers,
          },
          rowId: `assistant:ts:${String(n * 1_000)}`,
        };
      }
      return {
        message: {
          ...memberPost({
            messageId: id,
            requestId: id,
            lines: [`reply ${String(n)}`],
            timestamp: n * 1_000,
            resolvedBy: null,
          }),
          sender: { type: "user", userId: COLLEAGUE },
        },
        rowId: id,
      };
    }

    /** The thread's window of five replies holds exactly `ordinals` (from 0). */
    function hydrate(ordinals: readonly number[]): void {
      const session = mocks.threadSessions[THREAD].store;
      const entries = ordinals.map((ordinal) => ({
        ordinal,
        ...replyMessage(ordinal + 1),
      }));
      act(() => {
        session.setState({
          messages: entries.map((entry) => entry.message),
          transcriptWindow: {
            ...session.getState().transcriptWindow,
            rowCount: 5,
            spans: entries.map((entry) => ({
              fromOrdinal: entry.ordinal,
              rowIds: [entry.rowId],
              rowContext: {},
              messageIds: [entry.message.messageId],
              eventIds: [],
              contextBytes: 0,
            })),
          },
        });
      });
    }

    /** Five replies, the cursor on the second; the third, the first unread, is not loaded. */
    async function mountWithMissingBoundary(input: {
      /** The message reply 4 answers, which its badge names. */
      readonly answers: string;
      /** A second card, read through, whose last reply carries a badge to its reply 1. */
      readonly withReadCard: boolean;
    }): Promise<{
      scrolled: MockInstance<Element["scrollIntoView"]>;
      pill: HTMLElement;
      badge: (threadId: string, name: RegExp) => HTMLElement;
    }> {
      const scrolled = recordScrolls();
      answers = input.answers;
      mocks.posts[TEAM] = { [OPENING_POST_ID]: "Ship the release?" };
      followedThreads(...(input.withReadCard ? [THREAD, OTHER] : [THREAD]));
      mocks.hosted[TEAM].cursors = {
        cursors: { [THREAD]: { messageId: replyId(THREAD, 2), seq: 2_000 } },
        latest: { [THREAD]: { messageId: replyId(THREAD, 5), seq: 5_000 } },
      };
      withReplies(TEAM, THREAD, replyTexts(5), 5_000);
      if (input.withReadCard) {
        unreadFrom({ threadId: OTHER, count: 3, ownAt: [], readTo: 3 });
        mocks.replyRows[OTHER] = mocks.replyRows[OTHER].map((row, index) =>
          index === 2
            ? {
                ...botReply({
                  messageId: replyId(OTHER, 3),
                  text: "reply 3",
                  timestamp: 3_000,
                }),
                repliesTo: replyId(OTHER, 1),
              }
            : row,
        );
      }
      windowedSession(THREAD);
      hydrate([0, 1, 3, 4]);
      mount();
      await waitFor(() =>
        expect(listed()).toEqual(
          input.withReadCard ? [THREAD, OTHER] : [THREAD],
        ),
      );
      await within(await revealFull(THREAD)).findByText("reply 5");
      if (input.withReadCard) {
        await within(await revealFull(OTHER)).findByText("reply 3");
      }
      return {
        scrolled,
        pill: await screen.findByTestId("bot-threads-unread-pill"),
        badge: (threadId, name) =>
          within(card(threadId)).getByRole("button", { name }),
      };
    }

    function scrolledToDivider(
      scrolled: MockInstance<Element["scrollIntoView"]>,
    ): boolean {
      return scrolled.mock.contexts.some(
        (context) =>
          context instanceof HTMLElement &&
          context.hasAttribute("data-unread-divider"),
      );
    }

    it("does not pull the page to the divider when the reply that holds it loads after a reply's badge was used, though the badge's highlight is long gone", async () => {
      const { scrolled, pill, badge } = await mountWithMissingBoundary({
        answers,
        withReadCard: false,
      });
      expect(dividersIn(THREAD)).toHaveLength(0);

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      fireEvent.click(pill);
      fireEvent.click(badge(THREAD, TO_REPLY_1));
      expect(highlightedRows(THREAD)).toHaveLength(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_500);
      });
      expect(highlightedRows(THREAD)).toEqual([]);
      vi.useRealTimers();

      hydrate([0, 1, 2, 3, 4]);
      await waitFor(() => expect(dividersIn(THREAD)).toHaveLength(1));

      expect(rowUnderDivider(THREAD)).toBe(replyId(THREAD, 3));
      expect(scrolledToDivider(scrolled)).toBe(false);
    });

    it("lands on the divider of a fresh unread press once the reply that holds it has loaded", async () => {
      const { scrolled, pill, badge } = await mountWithMissingBoundary({
        answers,
        withReadCard: false,
      });
      fireEvent.click(pill);
      fireEvent.click(badge(THREAD, TO_REPLY_1));
      hydrate([0, 1, 2, 3, 4]);
      await waitFor(() => expect(dividersIn(THREAD)).toHaveLength(1));
      expect(scrolledToDivider(scrolled)).toBe(false);

      fireEvent.click(pill);

      const [divider] = dividersIn(THREAD);
      await waitFor(() => expect(scrolled.mock.contexts.at(-1)).toBe(divider));
      expect(scrolled.mock.calls.at(-1)?.[0]).toMatchObject({ block: "start" });
    });

    /** The page's one scroller, which the person scrolls. */
    function pageScroller(): HTMLElement {
      return screen.getByTestId("bot-threads-scroll");
    }

    /** Hydrates the missing reply, which must not pull the page, then a fresh press of the pill must land. */
    async function expectNoStealThenFreshPressLands(
      scrolled: MockInstance<Element["scrollIntoView"]>,
      pill: HTMLElement,
    ): Promise<void> {
      hydrate([0, 1, 2, 3, 4]);
      await waitFor(() => expect(dividersIn(THREAD)).toHaveLength(1));
      expect(scrolledToDivider(scrolled)).toBe(false);

      fireEvent.click(pill);

      const [divider] = dividersIn(THREAD);
      await waitFor(() => expect(scrolled.mock.contexts.at(-1)).toBe(divider));
      expect(scrolled.mock.calls.at(-1)?.[0]).toMatchObject({ block: "start" });
    }

    it("does not pull the page to the divider when the reply that holds it loads after the badge naming the thread's opening post was used, and a fresh press lands", async () => {
      const { scrolled, pill, badge } = await mountWithMissingBoundary({
        answers: OPENING_POST_ID,
        withReadCard: false,
      });

      fireEvent.click(pill);
      fireEvent.click(badge(THREAD, TO_OPENING_POST));

      await expectNoStealThenFreshPressLands(scrolled, pill);
    });

    it("does not pull the page to the divider when the reply that holds it loads after a badge was used in another card, and a fresh press lands", async () => {
      const { scrolled, pill, badge } = await mountWithMissingBoundary({
        answers,
        withReadCard: true,
      });

      fireEvent.click(pill);
      fireEvent.click(badge(OTHER, TO_REPLY_1));

      await expectNoStealThenFreshPressLands(scrolled, pill);
    });

    /** What the person does to scroll the page by hand: the event type it sends to the scroller, and the action. */
    const PERSON_SCROLLS: ReadonlyArray<readonly [string, string, () => void]> =
      [
        [
          "the wheel",
          "wheel",
          () => fireEvent.wheel(pageScroller(), { deltaY: 120 }),
        ],
        [
          "a touch drag",
          "touchmove",
          () => {
            fireEvent.touchStart(pageScroller(), {
              touches: [{ clientX: 0, clientY: 200 }],
            });
            fireEvent.touchMove(pageScroller(), {
              touches: [{ clientX: 0, clientY: 100 }],
            });
          },
        ],
        [
          "a scroll key",
          "keydown",
          () => fireEvent.keyDown(pageScroller(), { key: "PageDown" }),
        ],
        [
          "a press on the scrollbar",
          "pointerdown",
          () => fireEvent.pointerDown(pageScroller()),
        ],
      ];

    /** Sends `act` and says whether an event of `type` reached the page's scroller from it. */
    function reachedScroller(type: string, act: () => void): boolean {
      const seen = vi.fn();
      pageScroller().addEventListener(type, seen);
      act();
      pageScroller().removeEventListener(type, seen);
      return seen.mock.calls.length > 0;
    }

    it.each(PERSON_SCROLLS)(
      "does not pull the page to the divider when the reply that holds it loads after the person scrolled the page with %s, and a fresh press lands",
      async (_name, type, scrollThePage) => {
        const { scrolled, pill } = await mountWithMissingBoundary({
          answers,
          withReadCard: false,
        });

        fireEvent.click(pill);
        expect(dividersIn(THREAD)).toHaveLength(0);
        expect(scrolledToDivider(scrolled)).toBe(false);
        expect(reachedScroller(type, scrollThePage)).toBe(true);

        await expectNoStealThenFreshPressLands(scrolled, pill);
      },
    );

    it("still lands on the divider when the reply that holds it loads after only the pill's own scroll to the card ran its scroll events", async () => {
      const { scrolled, pill } = await mountWithMissingBoundary({
        answers,
        withReadCard: false,
      });

      fireEvent.click(pill);
      // The pill's smooth scroll to the card's top is the page scrolling by itself.
      expect(
        reachedScroller("scroll", () => fireEvent.scroll(pageScroller())),
      ).toBe(true);
      hydrate([0, 1, 2, 3, 4]);

      await waitFor(() => expect(dividersIn(THREAD)).toHaveLength(1));
      const [divider] = dividersIn(THREAD);
      await waitFor(() => expect(scrolled.mock.contexts.at(-1)).toBe(divider));
      expect(scrolled.mock.calls.at(-1)?.[0]).toMatchObject({ block: "start" });
    });

    /** An ordinary button of a card: no menu, tab or other composite control, which would own keys of its own. */
    function ordinaryButtonIn(threadId: string): HTMLElement {
      const found = within(card(threadId))
        .getAllByRole("button")
        .find(
          (button) =>
            !button.hasAttribute("aria-haspopup") &&
            button.getAttribute("role") === null,
        );
      if (found === undefined)
        throw new Error(`no ordinary button in ${threadId}`);
      return found;
    }

    it("still lands on the divider when the reply that holds it loads after the Space an ordinary button of a card consumes, which does not scroll the page", async () => {
      const { scrolled, pill } = await mountWithMissingBoundary({
        answers,
        withReadCard: false,
      });

      fireEvent.click(pill);
      const control = ordinaryButtonIn(THREAD);
      expect(
        reachedScroller("keydown", () =>
          fireEvent.keyDown(control, { key: " " }),
        ),
      ).toBe(true);
      hydrate([0, 1, 2, 3, 4]);

      await waitFor(() => expect(dividersIn(THREAD)).toHaveLength(1));
      const [divider] = dividersIn(THREAD);
      await waitFor(() => expect(scrolled.mock.contexts.at(-1)).toBe(divider));
      expect(scrolled.mock.calls.at(-1)?.[0]).toMatchObject({ block: "start" });
    });

    it("does not pull the page to the divider when the reply that holds it loads after a press anywhere inside a card, and a fresh press lands", async () => {
      const { scrolled, pill } = await mountWithMissingBoundary({
        answers,
        withReadCard: false,
      });

      fireEvent.click(pill);
      expect(dividersIn(THREAD)).toHaveLength(0);
      expect(scrolledToDivider(scrolled)).toBe(false);
      expect(
        reachedScroller("pointerdown", () =>
          fireEvent.pointerDown(card(THREAD)),
        ),
      ).toBe(true);

      await expectNoStealThenFreshPressLands(scrolled, pill);
    });

    it("lands on the divider when the pill is pressed again, pointer first and then the click, after a press inside a card retired the first press", async () => {
      const { scrolled, pill } = await mountWithMissingBoundary({
        answers,
        withReadCard: false,
      });

      fireEvent.click(pill);
      fireEvent.pointerDown(card(THREAD));
      fireEvent.pointerDown(pill);
      fireEvent.click(pill);
      hydrate([0, 1, 2, 3, 4]);

      await waitFor(() => expect(dividersIn(THREAD)).toHaveLength(1));
      const [divider] = dividersIn(THREAD);
      await waitFor(() => expect(scrolled.mock.contexts.at(-1)).toBe(divider));
      expect(scrolled.mock.calls.at(-1)?.[0]).toMatchObject({ block: "start" });
    });

    it("keeps the intent of a pill press whose own pointer press came first, and lands on the divider once the reply that holds it loads", async () => {
      const { scrolled, pill } = await mountWithMissingBoundary({
        answers,
        withReadCard: false,
      });

      fireEvent.pointerDown(pill);
      fireEvent.click(pill);
      hydrate([0, 1, 2, 3, 4]);

      await waitFor(() => expect(dividersIn(THREAD)).toHaveLength(1));
      const [divider] = dividersIn(THREAD);
      await waitFor(() => expect(scrolled.mock.contexts.at(-1)).toBe(divider));
      expect(scrolled.mock.calls.at(-1)?.[0]).toMatchObject({ block: "start" });
    });

    it("does not pull the page to the divider when the reply that holds it loads after Space pressed on a link in a reply, which scrolls the page, and a fresh press lands", async () => {
      replyFourText = "reply 4, with [the report](https://example.com/report)";
      const { scrolled, pill } = await mountWithMissingBoundary({
        answers,
        withReadCard: false,
      });

      fireEvent.click(pill);
      const link = within(card(THREAD)).getByRole("link", {
        name: "the report",
      });
      expect(dividersIn(THREAD)).toHaveLength(0);
      expect(scrolledToDivider(scrolled)).toBe(false);
      expect(
        reachedScroller("keydown", () => fireEvent.keyDown(link, { key: " " })),
      ).toBe(true);

      await expectNoStealThenFreshPressLands(scrolled, pill);
    });

    it("does not pull the page to the divider when the reply that holds it loads while the pane is hidden, nor when the pane returns, and a fresh press lands", async () => {
      const { scrolled, pill } = await mountWithMissingBoundary({
        answers,
        withReadCard: false,
      });
      fireEvent.click(pill);

      setPaneVisible(false);
      hydrate([0, 1, 2, 3, 4]);
      expect(scrolledToDivider(scrolled)).toBe(false);
      setPaneVisible(true);

      await expectNoStealThenFreshPressLands(scrolled, pill);
    });

    it("does not pull the page to the divider when the reply that holds it loads after the pane was hidden and shown again, and a fresh press lands", async () => {
      const { scrolled, pill } = await mountWithMissingBoundary({
        answers,
        withReadCard: false,
      });
      fireEvent.click(pill);

      setPaneVisible(false);
      setPaneVisible(true);

      await expectNoStealThenFreshPressLands(scrolled, pill);
    });

    it.each(["PageDown", "ArrowDown"])(
      "does not pull the page to the divider when the reply that holds it loads after %s pressed on an ordinary button of a card, which scrolls the page, and a fresh press lands",
      async (key) => {
        const { scrolled, pill } = await mountWithMissingBoundary({
          answers,
          withReadCard: false,
        });

        fireEvent.click(pill);
        const control = ordinaryButtonIn(THREAD);
        expect(dividersIn(THREAD)).toHaveLength(0);
        expect(scrolledToDivider(scrolled)).toBe(false);
        expect(
          reachedScroller("keydown", () => fireEvent.keyDown(control, { key })),
        ).toBe(true);

        await expectNoStealThenFreshPressLands(scrolled, pill);
      },
    );

    /** Four rows loaded and read-enabled, then the session's snapshot is withdrawn, which turns reading off. */
    async function mountWithReadingOff(): Promise<{
      scrolled: MockInstance<Element["scrollIntoView"]>;
      pill: HTMLElement;
      badge: () => HTMLElement;
      enableReading: () => void;
    }> {
      const scrolled = recordScrolls();
      followedThreads(THREAD);
      unreadFrom({ threadId: THREAD, count: 5, ownAt: [], readTo: 2 });
      mocks.replyRows[THREAD] = mocks.replyRows[THREAD].map((row, index) =>
        index === 3
          ? {
              ...botReply({
                messageId: replyId(THREAD, 4),
                text: "reply 4",
                timestamp: 4_000,
              }),
              repliesTo: replyId(THREAD, 1),
            }
          : row,
      );
      mount();
      await waitFor(() => expect(listed()).toEqual([THREAD]));
      const full = within(await revealFull(THREAD));
      await full.findByText("reply 5");
      const pill = await screen.findByTestId("bot-threads-unread-pill");
      const store = mocks.threadSessions[THREAD].store;
      act(() => store.setState({ snapshotLoaded: false }));
      await waitFor(() => expect(dividersIn(THREAD)).toHaveLength(0));
      return {
        scrolled,
        pill,
        badge: () =>
          full.getByRole("button", { name: /^Replying to .*: reply 1$/ }),
        enableReading: () =>
          act(() => store.setState({ snapshotLoaded: true })),
      };
    }

    it("scrolls to the divider once, when reading is enabled again after the unread press found the card's reading off", async () => {
      const { scrolled, pill, enableReading } = await mountWithReadingOff();

      fireEvent.click(pill);
      expect(scrolledToDivider(scrolled)).toBe(false);
      enableReading();

      await waitFor(() => expect(dividersIn(THREAD)).toHaveLength(1));
      const [divider] = dividersIn(THREAD);
      await waitFor(() =>
        expect(
          scrolled.mock.contexts.filter((c) => c === divider),
        ).toHaveLength(1),
      );
      expect(scrolled.mock.calls.at(-1)?.[0]).toMatchObject({ block: "start" });
    });

    it("does not scroll to the divider when reading is enabled again after a reply's badge was used while it was off", async () => {
      const { scrolled, pill, badge, enableReading } =
        await mountWithReadingOff();

      fireEvent.click(pill);
      fireEvent.click(badge());
      enableReading();

      await waitFor(() => expect(dividersIn(THREAD)).toHaveLength(1));
      expect(scrolledToDivider(scrolled)).toBe(false);
    });
  });
});
