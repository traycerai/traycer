/**
 * A bot's question asked without waiting, through the REAL `BotChannelView`.
 * What is asserted is what the person sees on the card and what the host
 * RECEIVES: an answer or a Skip goes out as the person's message with the
 * question it settles; the settlement the host writes on the row closes the
 * question for everyone, and until it lands the card holds what was sent; a
 * host too old to take an answer gets a card without actions, and a host away
 * queues the answer. A question settled while a member was answering is in
 * `bot-channel-question-card-settled.test.tsx`, and what a member has not
 * sent is in `bot-channel-question-card-moved.test.tsx`. The tree, the host
 * client and the per-case lifecycle are in
 * `bot-channel-question-card-harness.tsx`.
 */
import {
  botMentionHostClientMock,
  emptyBotMentionHostListsMock,
} from "@/components/bots/__tests__/bot-mention-host-test-support";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { botQuestionsText } from "@traycer/protocol/persistence/epic/messages";
import type { BotQuestionItem } from "@traycer/protocol/persistence/epic/schemas";
import {
  negotiateBotSend,
  VIEWER_USER_ID,
} from "@/components/bots/__tests__/bot-failed-request-test-support";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import { textOf } from "@/components/bots/__tests__/bot-box-test-support";
import { activityStore, mocks } from "./bot-channel-question-card-state";
import { chatMessagesMock } from "./bot-channel-question-card-mocks";
import {
  BOT_ID,
  botRow,
  byPerson,
  cardQuestion,
  CHANNEL_ID,
  channelBox,
  channelCard,
  channelMovedLine,
  DEPLOY,
  deploy,
  HOLD,
  hold,
  holdField,
  HOST_ID,
  installQuestionCardCaseLifecycle,
  mountChannel,
  onOpenThread,
  QUESTION_ID,
  questionRow,
  sent,
  session,
  setDelivery,
  settlementLine,
  TEAMMATE_USER_ID,
  WATCH,
  watch,
} from "./bot-channel-question-card-harness";

vi.mock(
  "@/hooks/host/use-host-client-for-host-id",
  () => botMentionHostClientMock,
);
vi.mock(
  "@/hooks/bots/use-environment-host-lists-query",
  () => emptyBotMentionHostListsMock,
);

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useChatSessionHandleForContainer: (
    _botId: string,
    chatId: string,
  ): ChatSessionStoreHandle | null => mocks.handles.get(chatId) ?? null,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.client,
}));
vi.mock("@/hooks/host/use-host-supports-method", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-supports-method")
  >()),
  useHostMethodSupport: () => true,
}));
vi.mock("@/components/epic-tabs/pane-visibility-context", () => ({
  usePaneVisible: () => true,
  usePaneFocused: () => true,
  usePaneFocusProbe: () => () => true,
}));
vi.mock("@/hooks/bots/use-bot-conversation-list-query", () => ({
  useBotConversationListQuery: () => ({
    data: { conversations: [{ conversationId: CHANNEL_ID }] },
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/bots/use-bot-thread-list-query", () => ({
  useBotThreadListQuery: () => ({
    data: { threads: mocks.threads, threadAnchors: null },
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/notifications/use-notification-indicators-query", () => ({
  useNotificationIndicators: () => ({ epics: {}, chats: {} }),
}));
vi.mock(
  "@/hooks/notifications/use-notification-mark-entity-read-mutation",
  () => ({
    useNotificationMarkEntityRead: () => ({ mutate: vi.fn() }),
  }),
);
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessCatalogForClient: () => ({ harnesses: [] }),
}));
vi.mock("@/hooks/chats/use-chat-locate-row", () => ({
  useChatLocateRow: () => null,
  useChatLocateRowAnswer: () => ({ status: "waiting" }),
}));
vi.mock("@/hooks/bots/use-bot-activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/bots/use-bot-activity")>()),
  useBotActivity: () => activityStore((state) => state.activity),
}));
vi.mock("@/components/chat/chat-messages", () => chatMessagesMock());

installQuestionCardCaseLifecycle();

describe("<BotChannelView tiles={null} /> a question the bot asks without waiting", () => {
  it("draws the card under the bot: each question, its options, a field where words are taken, Submit and Skip, and none of the older client's buttons", () => {
    session(CHANNEL_ID, [questionRow([deploy(null), hold(null)])]);
    mountChannel(null);

    const card = channelCard();
    expect(within(card).getByText("Release Bot asks")).toBeTruthy();
    const first = cardQuestion(card, DEPLOY);
    expect(
      within(first)
        .getAllByTestId("question-card-option")
        .map((option) => option.textContent),
    ).toEqual(["Now", "After the train"]);
    expect(within(first).queryByRole("textbox")).toBeNull();
    expect(within(first).getByRole("button", { name: "Skip" })).toBeTruthy();
    const second = cardQuestion(card, HOLD);
    expect(within(second).getByRole("textbox", { name: "Your answer" }));
    expect(screen.queryByTestId("bot-reply-options")).toBeNull();
  });

  it("sends the picked answer as the person's message with the question it settles, and shows the settlement the host writes, with nothing left to do", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const write = session(CHANNEL_ID, [questionRow([deploy(null)])]);
    mountChannel(null);

    const question = cardQuestion(channelCard(), DEPLOY);
    const submit = within(question).getByRole("button", { name: "Submit" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await user.click(
      within(question).getByRole("button", { name: "After the train" }),
    );
    await user.click(submit);

    expect(sent).toEqual([
      {
        botId: BOT_ID,
        conversationId: CHANNEL_ID,
        text: "After the train",
        threadId: null,
        announcementId: null,
        redeliver: null,
        supersedes: null,
        answer: {
          questionMessageId: QUESTION_ID,
          questionIndex: 0,
          skipped: false,
        },
      },
    ]);
    write([questionRow([deploy(byPerson(VIEWER_USER_ID, "After the train"))])]);
    const settled = cardQuestion(channelCard(), DEPLOY);
    expect(
      within(settled).getByTestId("question-card-settlement").textContent,
    ).toBe("Answered by Olive Owner: After the train");
    expect(within(settled).queryAllByRole("button")).toEqual([]);
    expect(onOpenThread).not.toHaveBeenCalled();
  });

  it("sends a typed answer for the question it is typed under, by its place on the card", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    session(CHANNEL_ID, [questionRow([deploy(null), hold(null)])]);
    mountChannel(null);

    const second = cardQuestion(channelCard(), HOLD);
    await user.type(
      within(second).getByRole("textbox", { name: "Your answer" }),
      "  The migration  ",
    );
    await user.click(within(second).getByRole("button", { name: "Submit" }));

    expect(sent.map((request) => [request.text, request.answer])).toEqual([
      [
        "The migration",
        { questionMessageId: QUESTION_ID, questionIndex: 1, skipped: false },
      ],
    ]);
  });

  it("sends a Skip as skipped, and shows the question skipped once the host settles it", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const write = session(CHANNEL_ID, [questionRow([hold(null)])]);
    mountChannel(null);

    await user.click(
      within(cardQuestion(channelCard(), HOLD)).getByRole("button", {
        name: "Skip",
      }),
    );

    expect(sent.map((request) => [request.text, request.answer])).toEqual([
      [
        "Skipped",
        { questionMessageId: QUESTION_ID, questionIndex: 0, skipped: true },
      ],
    ]);
    write([questionRow([hold(byPerson(VIEWER_USER_ID, null))])]);
    expect(
      within(cardQuestion(channelCard(), HOLD)).getByTestId(
        "question-card-settlement",
      ).textContent,
    ).toBe("Skipped");
  });

  it("says what the bot settled a question nobody answered with, beside a member's answer, and offers nothing on either", () => {
    session(CHANNEL_ID, [
      questionRow([
        deploy(byPerson(TEAMMATE_USER_ID, "Now")),
        hold({
          answer: "Nothing",
          skipped: false,
          by: { kind: "bot" },
          at: 4_000,
        }),
      ]),
    ]);
    mountChannel(null);

    const card = channelCard();
    expect(
      within(card)
        .getAllByTestId("question-card-settlement")
        .map((line) => line.textContent),
    ).toEqual([
      "Answered by Tess Teammate: Now",
      "Settled by Release Bot: Nothing",
    ]);
    expect(within(card).queryAllByRole("button")).toEqual([]);
    expect(within(card).queryByRole("textbox")).toBeNull();
  });

  it("opens the question's own thread from its hover actions, not the thread of the post it follows", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    session(CHANNEL_ID, [
      botRow(
        QUESTION_ID,
        DEPLOY,
        [deploy(null)],
        "conversation-request:req-post",
      ),
    ]);
    mountChannel(null);

    await user.click(
      within(screen.getByTestId("bot-reply-row")).getByTestId(
        "bot-message-thread",
      ),
    );

    expect(onOpenThread).toHaveBeenLastCalledWith({
      anchorMessageId: QUESTION_ID,
      announcement: true,
      anchorKind: null,
      sent: null,
    });
  });

  it("draws an older host's row as its text and its first question's options as buttons", () => {
    session(CHANNEL_ID, [botRow("reply-1", DEPLOY, null, null)]);
    mountChannel(null);

    const row = screen.getByTestId("bot-reply-row");
    expect(within(row).getByText(DEPLOY)).toBeTruthy();
    expect(
      within(row)
        .getAllByTestId("bot-reply-option")
        .map((option) => option.textContent),
    ).toEqual(["Now", "After the train"]);
    expect(within(row).queryByTestId("question-card")).toBeNull();
  });
});

describe("<BotChannelView tiles={null} /> a question on a tab whose host cannot take a card's answer", () => {
  it("draws the card with nothing to press on a host that negotiated bot.conversation.send 1.1, keeping the member's draft, and offers them again once the host reaches 1.2", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    session(CHANNEL_ID, [questionRow([deploy(null), hold(null)])]);
    mountChannel(null);
    await user.type(holdField(), "Hold the migration");

    act(() => {
      negotiateBotSend(HOST_ID, { major: 1, minor: 1 });
    });

    expect(
      within(channelCard())
        .getAllByRole("button")
        .filter((button) => !(button as HTMLButtonElement).disabled),
    ).toEqual([]);
    expect(holdField().value).toBe("Hold the migration");
    expect(holdField().disabled).toBe(true);
    expect(sent).toEqual([]);

    act(() => {
      negotiateBotSend(HOST_ID, { major: 1, minor: 2 });
    });
    await user.click(
      within(cardQuestion(channelCard(), HOLD)).getByRole("button", {
        name: "Submit",
      }),
    );
    expect(sent.map((request) => [request.text, request.answer])).toEqual([
      [
        "Hold the migration",
        { questionMessageId: QUESTION_ID, questionIndex: 1, skipped: false },
      ],
    ]);
  });
});

describe("<BotChannelView tiles={null} /> an answer the host queued while the bot's host is away", () => {
  it("holds the sent answer on the card, its choice pressed and nothing left to press, until the room settles it; the member's own settlement closes it", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setDelivery("queued");
    const write = session(CHANNEL_ID, [questionRow([deploy(null)])]);
    mountChannel(null);
    await user.click(
      within(cardQuestion(channelCard(), DEPLOY)).getByRole("button", {
        name: "After the train",
      }),
    );
    await user.click(
      within(cardQuestion(channelCard(), DEPLOY)).getByRole("button", {
        name: "Submit",
      }),
    );

    expect(sent).toHaveLength(1);
    const sending = cardQuestion(channelCard(), DEPLOY);
    expect(within(sending).getByTestId("question-card-sending")).toBeTruthy();
    expect(
      within(sending)
        .getByRole("button", { name: "After the train" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      within(sending)
        .getAllByRole("button")
        .filter((button) => !(button as HTMLButtonElement).disabled),
    ).toEqual([]);

    write([questionRow([deploy(byPerson(VIEWER_USER_ID, "After the train"))])]);
    const settled = cardQuestion(channelCard(), DEPLOY);
    expect(
      within(settled).getByTestId("question-card-settlement").textContent,
    ).toBe("Answered by Olive Owner: After the train");
    expect(within(settled).queryAllByRole("button")).toEqual([]);
    expect(useBotDraftsStore.getState().answers).toEqual({});
    expect(textOf(channelBox())).toBe("");
    expect(channelMovedLine()).toBeUndefined();
  });

  it("moves a queued answer into the channel's box once a teammate's settlement reaches the room first, and sends nothing more", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setDelivery("queued");
    const write = session(CHANNEL_ID, [questionRow([hold(null)])]);
    mountChannel(null);
    await user.type(holdField(), "Hold the migration");
    await user.click(
      within(cardQuestion(channelCard(), HOLD)).getByRole("button", {
        name: "Submit",
      }),
    );
    expect(
      within(cardQuestion(channelCard(), HOLD)).getByTestId(
        "question-card-sending",
      ),
    ).toBeTruthy();

    // The bot's host, back, refused it: a teammate's answer reached it first.
    write([questionRow([hold(byPerson(TEAMMATE_USER_ID, "Nothing"))])]);

    expect(settlementLine(channelCard(), HOLD)).toBe(
      "Answered by Tess Teammate: Nothing",
    );
    expect(textOf(channelBox())).toBe("Hold the migration");
    expect(sent).toHaveLength(1);
    expect(screen.queryByTestId("bot-channel-composer-send-failed")).toBeNull();
  });
});

describe("<BotChannelView tiles={null} /> an answer someone else settled with first, the same member from another window included", () => {
  it("moves the card's sent answer when a teammate settled the question first with the same answer", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setDelivery("queued");
    const write = session(CHANNEL_ID, [questionRow([deploy(null)])]);
    mountChannel(null);
    await user.click(
      within(cardQuestion(channelCard(), DEPLOY)).getByRole("button", {
        name: "Now",
      }),
    );
    await user.click(
      within(cardQuestion(channelCard(), DEPLOY)).getByRole("button", {
        name: "Submit",
      }),
    );

    write([questionRow([deploy(byPerson(TEAMMATE_USER_ID, "Now"))])]);

    expect(settlementLine(channelCard(), DEPLOY)).toBe(
      "Answered by Tess Teammate: Now",
    );
    expect(textOf(channelBox())).toBe("Now");
  });

  it("moves the card's sent answer, with the another-window line, when the member's own settlement is a different answer", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setDelivery("queued");
    const write = session(CHANNEL_ID, [questionRow([deploy(null)])]);
    mountChannel(null);
    await user.click(
      within(cardQuestion(channelCard(), DEPLOY)).getByRole("button", {
        name: "After the train",
      }),
    );
    await user.click(
      within(cardQuestion(channelCard(), DEPLOY)).getByRole("button", {
        name: "Submit",
      }),
    );

    write([questionRow([deploy(byPerson(VIEWER_USER_ID, "Now"))])]);

    expect(settlementLine(channelCard(), DEPLOY)).toBe(
      "Answered by Olive Owner: Now",
    );
    expect(textOf(channelBox())).toBe("After the train");
    expect(channelMovedLine()).toBe(
      "You answered in another window first. This answer is in your message box, not sent.",
    );
    expect(sent).toHaveLength(1);
  });
});

describe("<BotChannelView tiles={null} /> a row's text above its question card", () => {
  it("shows the row's text above the card when it says more than its questions", () => {
    session(CHANNEL_ID, [
      botRow(
        QUESTION_ID,
        "I'm your bot. Two questions to start.",
        [deploy(null)],
        null,
      ),
    ]);
    mountChannel(null);

    const channel = screen.getByTestId("bot-channel");
    expect(
      within(channel).getByText("I'm your bot. Two questions to start."),
    ).toBeTruthy();
    expect(
      within(channelCard()).getByRole("region", { name: DEPLOY }),
    ).toBeTruthy();
  });

  it("shows the card alone, with no copy of the question, when the row's text is just its questions", () => {
    session(CHANNEL_ID, [questionRow([deploy(null)])]);
    mountChannel(null);

    expect(
      within(screen.getByTestId("bot-channel")).getAllByText(DEPLOY),
    ).toHaveLength(1);
  });

  describe("with several questions, one long and multi-line", () => {
    const LONG_MARKER = "rollback window for the canary";
    const LONG_QUESTION = [
      "Before the train leaves, which of these should block it?",
      `Think about the ${LONG_MARKER}, the migration that touches billing,`,
      "and whether the on-call engineer has signed off on the release.",
      "x".repeat(200),
    ].join("\n");
    const longQuestions: BotQuestionItem[] = [
      {
        text: LONG_QUESTION,
        options: [],
        allowFreeText: true,
        settlement: null,
      },
      deploy(null),
    ];

    function expectEachQuestionOnce(): void {
      const channel = screen.getByTestId("bot-channel");
      expect(
        within(channel).getAllByText(new RegExp(LONG_MARKER)),
      ).toHaveLength(1);
      expect(within(channel).getAllByText(DEPLOY)).toHaveLength(1);
      const card = channelCard();
      within(card).getByText(new RegExp(LONG_MARKER));
      within(card).getByText(DEPLOY);
    }

    it("draws each question once, in the card, when the row's text is exactly what the host writes for them", () => {
      session(CHANNEL_ID, [
        botRow(
          QUESTION_ID,
          botQuestionsText(longQuestions),
          longQuestions,
          null,
        ),
      ]);
      mountChannel(null);

      expectEachQuestionOnce();
    });

    it("draws the prose above the card once, and each question once, when the row says more than its questions", () => {
      const prose = "Hi, I'm your release assistant. Let me ask a few things.";
      session(CHANNEL_ID, [botRow(QUESTION_ID, prose, longQuestions, null)]);
      mountChannel(null);

      expect(
        within(screen.getByTestId("bot-channel")).getAllByText(prose),
      ).toHaveLength(1);
      expectEachQuestionOnce();
    });
  });
});

describe("<BotChannelView tiles={null} /> a question that takes options and the person's own words", () => {
  it("toggles several options, and Submit sends them joined in option order with the typed words after them", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    session(CHANNEL_ID, [questionRow([watch(null)])]);
    mountChannel(null);

    const question = cardQuestion(channelCard(), WATCH);
    await user.click(
      within(question).getByRole("button", { name: "Sandboxes and credits" }),
    );
    await user.click(
      within(question).getByRole("button", { name: "Agents waiting on me" }),
    );
    await user.type(
      within(question).getByRole("textbox", { name: "Your answer" }),
      "the build farm",
    );
    await user.click(within(question).getByRole("button", { name: "Submit" }));

    expect(sent.map((request) => request.text)).toEqual([
      "Agents waiting on me, Sandboxes and credits, the build farm",
    ]);
  });

  it("takes a pick back when it is toggled off", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    session(CHANNEL_ID, [questionRow([watch(null)])]);
    mountChannel(null);

    const question = cardQuestion(channelCard(), WATCH);
    await user.click(
      within(question).getByRole("button", { name: "Agents waiting on me" }),
    );
    await user.click(
      within(question).getByRole("button", { name: "Sandboxes and credits" }),
    );
    await user.click(
      within(question).getByRole("button", { name: "Agents waiting on me" }),
    );

    expect(
      within(question)
        .getByRole("button", { name: "Agents waiting on me" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    await user.click(within(question).getByRole("button", { name: "Submit" }));
    expect(sent.map((request) => request.text)).toEqual([
      "Sandboxes and credits",
    ]);
  });

  it("stays single-pick when multiSelect is false though free text is allowed: a second pick replaces the first", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    session(CHANNEL_ID, [
      questionRow([{ ...watch(null), multiSelect: false }]),
    ]);
    mountChannel(null);

    const question = cardQuestion(channelCard(), WATCH);
    await user.click(
      within(question).getByRole("button", { name: "Agents waiting on me" }),
    );
    await user.click(
      within(question).getByRole("button", { name: "Sandboxes and credits" }),
    );
    expect(
      within(question)
        .getByRole("button", { name: "Agents waiting on me" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    await user.click(within(question).getByRole("button", { name: "Submit" }));
    expect(sent.map((request) => request.text)).toEqual([
      "Sandboxes and credits",
    ]);
  });

  it("sends the typed words alone on a single-pick question with free text, once words are typed over a pick", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    session(CHANNEL_ID, [
      questionRow([{ ...watch(null), multiSelect: false }]),
    ]);
    mountChannel(null);

    const question = cardQuestion(channelCard(), WATCH);
    await user.click(
      within(question).getByRole("button", { name: "Agents waiting on me" }),
    );
    await user.type(
      within(question).getByRole("textbox", { name: "Your answer" }),
      "the build farm",
    );
    await user.click(within(question).getByRole("button", { name: "Submit" }));

    expect(sent.map((request) => request.text)).toEqual(["the build farm"]);
  });

  it("toggles several options with no text field when multiSelect is true and free text is not allowed, and Submit sends the picks joined in option order", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    session(CHANNEL_ID, [
      questionRow([{ ...watch(null), allowFreeText: false }]),
    ]);
    mountChannel(null);

    const question = cardQuestion(channelCard(), WATCH);
    expect(within(question).queryByRole("textbox")).toBeNull();
    await user.click(
      within(question).getByRole("button", { name: "Sandboxes and credits" }),
    );
    await user.click(
      within(question).getByRole("button", { name: "Agents waiting on me" }),
    );
    await user.click(within(question).getByRole("button", { name: "Submit" }));

    expect(sent.map((request) => request.text)).toEqual([
      "Agents waiting on me, Sandboxes and credits",
    ]);
  });

  it("draws a question row written without multiSelect, as an older host writes it, as single-pick", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    session(CHANNEL_ID, [
      questionRow([
        {
          text: WATCH,
          options: ["Agents waiting on me", "Sandboxes and credits"],
          allowFreeText: true,
          settlement: null,
        },
      ]),
    ]);
    mountChannel(null);

    const question = cardQuestion(channelCard(), WATCH);
    await user.click(
      within(question).getByRole("button", { name: "Agents waiting on me" }),
    );
    await user.click(
      within(question).getByRole("button", { name: "Sandboxes and credits" }),
    );
    await user.click(within(question).getByRole("button", { name: "Submit" }));

    expect(sent.map((request) => request.text)).toEqual([
      "Sandboxes and credits",
    ]);
  });

  it("stays single-choice on a question without free text: a second pick replaces the first", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    session(CHANNEL_ID, [questionRow([deploy(null)])]);
    mountChannel(null);

    const question = cardQuestion(channelCard(), DEPLOY);
    await user.click(within(question).getByRole("button", { name: "Now" }));
    await user.click(
      within(question).getByRole("button", { name: "After the train" }),
    );
    await user.click(within(question).getByRole("button", { name: "Submit" }));

    expect(sent.map((request) => request.text)).toEqual(["After the train"]);
  });
});
