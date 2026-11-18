/**
 * A question settled while a member was answering, through the REAL
 * `BotChannelView`: the host refuses the answer, a teammate's settlement
 * lands first, and the answer is given back or moves into the box of where it
 * was asked, unsent, with the line under the box that says so. What is
 * asserted is what the member sees on the card and under the box, and what
 * the host RECEIVES. The tree, the host client and the per-case lifecycle are
 * in `bot-channel-question-card-harness.tsx`.
 */
import {
  botMentionHostClientMock,
  emptyBotMentionHostListsMock,
} from "@/components/bots/__tests__/bot-mention-host-test-support";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import { VIEWER_USER_ID } from "@/components/bots/__tests__/bot-failed-request-test-support";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import {
  answerDraftKey,
  useBotDraftsStore,
} from "@/stores/bots/bot-drafts-store";
import {
  textOf,
  typeInto,
} from "@/components/bots/__tests__/bot-box-test-support";
import { activityStore, mocks } from "./bot-channel-question-card-state";
import { chatMessagesMock } from "./bot-channel-question-card-mocks";
import {
  BOT_ID,
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
  hostClientRecordingSends,
  installQuestionCardCaseLifecycle,
  mountChannel,
  QUESTION_ID,
  questionRow,
  refuse,
  sendAttempts,
  sent,
  session,
  setFatalFirstSend,
  setHeldSends,
  setRefusalKind,
  setRefuseSends,
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

describe("<BotChannelView tiles={null} /> a question settled while a member was answering (decision 122, T186)", () => {
  it("gives the answer back when the host refuses it while the question is open, says it was not sent, then moves it to the channel's box when the settlement lands, the moved line replacing the failure", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const write = session(CHANNEL_ID, [questionRow([hold(null)])]);
    mountChannel(null);
    await user.type(holdField(), "Hold the migration");

    // A teammate's answer reached the host first, but the row has not shown it yet.
    setRefuseSends(true);
    await user.click(
      within(cardQuestion(channelCard(), HOLD)).getByRole("button", {
        name: "Submit",
      }),
    );

    expect(sent).toHaveLength(1);
    expect(
      await screen.findByTestId("bot-channel-composer-send-failed"),
    ).toBeTruthy();
    expect(holdField().value).toBe("Hold the migration");
    expect(textOf(channelBox())).toBe("");

    write([questionRow([hold(byPerson(TEAMMATE_USER_ID, "Nothing"))])]);

    expect(settlementLine(channelCard(), HOLD)).toBe(
      "Answered by Tess Teammate: Nothing",
    );
    expect(textOf(channelBox())).toBe("Hold the migration");
    // The failed answer is the one that moved: nothing is left to retry.
    expect(screen.queryByTestId("bot-channel-composer-send-failed")).toBeNull();
    expect(channelMovedLine()).toBe(
      "Tess Teammate answered first. Your answer is in your message box, not sent.",
    );
    expect(within(channelCard()).queryAllByRole("button")).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it("holds the answer on the card, with no couldn't-send line, when the host refuses it with the already-settled code, and moves it to the channel's box once the teammate's settlement shows", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setRefusalKind("coded");
    const write = session(CHANNEL_ID, [questionRow([hold(null)])]);
    mountChannel(null);
    await user.type(holdField(), "Hold the migration");
    setRefuseSends(true);
    await user.click(
      within(cardQuestion(channelCard(), HOLD)).getByRole("button", {
        name: "Submit",
      }),
    );

    await vi.waitFor(() =>
      expect(
        useBotDraftsStore.getState().answers[BOT_ID]?.[
          answerDraftKey(QUESTION_ID, 0)
        ]?.heldForSettlement,
      ).not.toBeNull(),
    );
    expect(sent).toHaveLength(1);
    expect(
      within(cardQuestion(channelCard(), HOLD)).getByTestId(
        "question-card-sending",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("bot-channel-composer-send-failed")).toBeNull();
    expect(textOf(channelBox())).toBe("");

    write([questionRow([hold(byPerson(TEAMMATE_USER_ID, "Nothing"))])]);

    expect(textOf(channelBox())).toBe("Hold the migration");
    expect(channelMovedLine()).toBe(
      "Tess Teammate answered first. Your answer is in your message box, not sent.",
    );
    expect(screen.queryByTestId("bot-channel-composer-send-failed")).toBeNull();
    expect(useBotDraftsStore.getState().answers).toEqual({});
  });

  it("holds the answer, with no couldn't-send line, when the already-settled refusal comes back wrapped by the auth layer after a session fatal and a rotated bearer, and moves it to the channel's box once the teammate's settlement shows", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setRefusalKind("coded");
    setFatalFirstSend(true);
    mocks.client = hostClientRecordingSends();
    const write = session(CHANNEL_ID, [questionRow([hold(null)])]);
    mountChannel(null);
    await user.type(holdField(), "Hold the migration");
    setRefuseSends(true);
    await user.click(
      within(cardQuestion(channelCard(), HOLD)).getByRole("button", {
        name: "Submit",
      }),
    );

    await vi.waitFor(() =>
      expect(
        useBotDraftsStore.getState().answers[BOT_ID]?.[
          answerDraftKey(QUESTION_ID, 0)
        ]?.heldForSettlement,
      ).not.toBeNull(),
    );
    // The fatal send, then the one the auth layer made after the rotation.
    expect(sendAttempts).toBe(2);
    expect(sent).toHaveLength(1);
    expect(
      within(cardQuestion(channelCard(), HOLD)).getByTestId(
        "question-card-sending",
      ),
    ).toBeTruthy();
    expect(holdField().disabled).toBe(true);
    expect(screen.queryByTestId("bot-channel-composer-send-failed")).toBeNull();
    expect(textOf(channelBox())).toBe("");

    write([questionRow([hold(byPerson(TEAMMATE_USER_ID, "Nothing"))])]);

    expect(textOf(channelBox())).toBe("Hold the migration");
    expect(channelMovedLine()).toBe(
      "Tess Teammate answered first. Your answer is in your message box, not sent.",
    );
    expect(screen.queryByTestId("bot-channel-composer-send-failed")).toBeNull();
    expect(sendAttempts).toBe(2);
  });

  it("keeps the answer held on the card when the already-settled refusal is never followed by a settlement: no failure line, nothing in the box, nothing lost", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setRefusalKind("coded");
    setHeldSends([]);
    session(CHANNEL_ID, [questionRow([hold(null)])]);
    mountChannel(null);
    await user.type(holdField(), "Hold the migration");
    await user.click(
      within(cardQuestion(channelCard(), HOLD)).getByRole("button", {
        name: "Submit",
      }),
    );
    await refuse();

    const key = answerDraftKey(QUESTION_ID, 0);
    await vi.waitFor(() =>
      expect(
        useBotDraftsStore.getState().answers[BOT_ID]?.[key]?.heldForSettlement,
      ).toBe(key),
    );
    expect(
      within(cardQuestion(channelCard(), HOLD)).getByTestId(
        "question-card-sending",
      ),
    ).toBeTruthy();
    expect(holdField().value).toBe("Hold the migration");
    expect(holdField().disabled).toBe(true);
    expect(screen.queryByTestId("bot-channel-composer-send-failed")).toBeNull();
    expect(textOf(channelBox())).toBe("");
    expect(sent).toHaveLength(1);
  });

  it("spends the held answer, moving nothing and saying nothing, when the settlement that follows the already-settled refusal is the member's own matching answer", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setRefusalKind("coded");
    const write = session(CHANNEL_ID, [questionRow([deploy(null)])]);
    mountChannel(null);
    await user.click(
      within(cardQuestion(channelCard(), DEPLOY)).getByRole("button", {
        name: "Now",
      }),
    );
    setRefuseSends(true);
    await user.click(
      within(cardQuestion(channelCard(), DEPLOY)).getByRole("button", {
        name: "Submit",
      }),
    );
    const key = answerDraftKey(QUESTION_ID, 0);
    await vi.waitFor(() =>
      expect(
        useBotDraftsStore.getState().answers[BOT_ID]?.[key]?.heldForSettlement,
      ).toBe(key),
    );

    write([questionRow([deploy(byPerson(VIEWER_USER_ID, "Now"))])]);

    expect(settlementLine(channelCard(), DEPLOY)).toBe(
      "Answered by Olive Owner: Now",
    );
    expect(useBotDraftsStore.getState().answers).toEqual({});
    expect(textOf(channelBox())).toBe("");
    expect(channelMovedLine()).toBeUndefined();
    expect(screen.queryByTestId("bot-channel-composer-send-failed")).toBeNull();
  });

  it("moves the answer once when the settlement lands while the send is held, and a refusal after it changes nothing", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setHeldSends([]);
    const write = session(CHANNEL_ID, [questionRow([hold(null)])]);
    mountChannel(null);
    await user.type(holdField(), "Hold the migration");
    await user.click(
      within(cardQuestion(channelCard(), HOLD)).getByRole("button", {
        name: "Submit",
      }),
    );

    write([questionRow([hold(byPerson(TEAMMATE_USER_ID, "Nothing"))])]);
    await refuse();

    expect(textOf(channelBox())).toBe("Hold the migration");
    expect(screen.queryByTestId("bot-channel-composer-send-failed")).toBeNull();
    expect(channelMovedLine()).toBe(
      "Tess Teammate answered first. Your answer is in your message box, not sent.",
    );
    expect(useBotDraftsStore.getState().answers).toEqual({});
  });

  it("moves a picked option, alone, into the channel's box when a teammate's settlement arrives, naming them, without sending anything", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const write = session(CHANNEL_ID, [questionRow([deploy(null)])]);
    mountChannel(null);
    await user.click(
      within(cardQuestion(channelCard(), DEPLOY)).getByRole("button", {
        name: "Now",
      }),
    );

    write([
      questionRow([deploy(byPerson(TEAMMATE_USER_ID, "After the train"))]),
    ]);

    const question = cardQuestion(channelCard(), DEPLOY);
    expect(
      within(question).getByTestId("question-card-settlement").textContent,
    ).toBe("Answered by Tess Teammate: After the train");
    expect(question.getAttribute("data-state")).toBe("settled");
    expect(within(question).queryAllByRole("button")).toEqual([]);
    expect(textOf(channelBox())).toBe("Now");
    expect(channelMovedLine()).toBe(
      "Tess Teammate answered first. Your answer is in your message box, not sent.",
    );
    expect(sent).toEqual([]);
  });

  it("adds the answer below what the box already held, after a blank line, and replaces nothing", async () => {
    const write = session(CHANNEL_ID, [questionRow([hold(null)])]);
    mountChannel(null);
    typeInto(channelBox(), "Before I forget");
    await userEvent
      .setup({ advanceTimers: vi.advanceTimersByTime })
      .type(holdField(), "Hold the migration");

    write([questionRow([hold(byPerson(TEAMMATE_USER_ID, "Nothing"))])]);

    expect(textOf(channelBox())).toBe("Before I forget\n\nHold the migration");
  });

  it("opens the channel's box with its kept draft, a blank line and the moved answer, existing text first, when the answer moved while the box was not mounted", async () => {
    useBotDraftsStore.getState().typeThreadBox(BOT_ID, CHANNEL_ID, {
      text: "Before I forget",
      content: null,
      held: [],
    });
    const key = answerDraftKey(QUESTION_ID, 0);
    act(() => {
      const drafts = useBotDraftsStore.getState();
      drafts.setAnswer(BOT_ID, key, {
        chosen: [],
        typed: "Hold the migration",
        sent: null,
        unsureSince: null,
        heldForSettlement: null,
      });
      drafts.moveAnswers(BOT_ID, CHANNEL_ID, [key], (taken) => ({
        block: taken.map(([, draft]) => draft.typed).join("\n"),
        notice:
          "Tess Teammate answered first. Your answer is in your message box, not sent.",
      }));
    });
    session(CHANNEL_ID, [questionRow([hold(null)])]);

    mountChannel(null);

    expect(textOf(channelBox())).toBe("Before I forget\n\nHold the migration");
    await vi.waitFor(() =>
      expect(
        useBotDraftsStore.getState().boxCarries[BOT_ID]?.[CHANNEL_ID] ?? [],
      ).toEqual([]),
    );
  });

  it("moves a draft the person typed under a question the asker settled, naming the bot", async () => {
    const write = session(CHANNEL_ID, [questionRow([hold(null)])]);
    mountChannel(null);
    await userEvent
      .setup({ advanceTimers: vi.advanceTimersByTime })
      .type(holdField(), "Hold the migration");

    write([
      questionRow([
        hold({
          answer: "Nothing",
          skipped: false,
          by: { kind: "bot" },
          at: 4_000,
        }),
      ]),
    ]);

    expect(settlementLine(channelCard(), HOLD)).toBe(
      "Settled by Release Bot: Nothing",
    );
    expect(channelMovedLine()).toBe(
      "Release Bot settled it first. Your answer is in your message box, not sent.",
    );
  });

  it("says a teammate skipped the question first when every answer that moved was skipped over", async () => {
    const write = session(CHANNEL_ID, [questionRow([hold(null)])]);
    mountChannel(null);
    await userEvent
      .setup({ advanceTimers: vi.advanceTimersByTime })
      .type(holdField(), "Hold the migration");

    write([questionRow([hold(byPerson(TEAMMATE_USER_ID, null))])]);

    expect(channelMovedLine()).toBe(
      "Tess Teammate skipped this question first. Your answer is in your message box, not sent.",
    );
  });

  it("keeps the moved line while the person types in the box, and takes it back when the box sends", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const write = session(CHANNEL_ID, [questionRow([hold(null)])]);
    mountChannel(null);
    await user.type(holdField(), "Hold the migration");
    write([questionRow([hold(byPerson(TEAMMATE_USER_ID, "Nothing"))])]);

    typeInto(channelBox(), " today");
    expect(channelMovedLine()).toBeDefined();
    await user.click(screen.getByTestId("bot-channel-composer-send"));

    expect(channelMovedLine()).toBeUndefined();
    expect(sent.map((request) => request.text)).toEqual([
      "Hold the migration today",
    ]);
  });

  it("shows the moved line and the couldn't-send line together when a card's other question's send fails for another reason after one answer moved", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const write = session(CHANNEL_ID, [
      questionRow([deploy(null), hold(null)]),
    ]);
    mountChannel(null);
    await user.click(
      within(cardQuestion(channelCard(), DEPLOY)).getByRole("button", {
        name: "Now",
      }),
    );
    await user.type(holdField(), "Hold the migration");
    write([
      questionRow([
        deploy(byPerson(TEAMMATE_USER_ID, "After the train")),
        hold(null),
      ]),
    ]);
    await vi.waitFor(() => expect(channelMovedLine()).toBeDefined());
    setRefuseSends(true);

    await user.click(
      within(cardQuestion(channelCard(), HOLD)).getByRole("button", {
        name: "Submit",
      }),
    );

    await screen.findByTestId("bot-channel-composer-send-failed");
    expect(channelMovedLine()).toBe(
      "Tess Teammate answered first. Your answer is in your message box, not sent.",
    );
  });

  /** One card of two questions, each sent on its own: the second settled by a teammate, or open. */
  function twoQuestions(settledSecond: boolean): ReadonlyArray<Message> {
    return [
      questionRow([
        hold(null),
        watch(
          settledSecond
            ? byPerson(TEAMMATE_USER_ID, "Agents waiting on me")
            : null,
        ),
      ]),
    ];
  }

  /**
   * The first question's send refused for another reason, so its failure line
   * shows, and the second question's answer then moves into the same box. The
   * harness draws one card per row, so the second answer is another question of
   * the card.
   */
  async function failureShowingThenAnAnswerMoves(): Promise<void> {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const write = session(CHANNEL_ID, twoQuestions(false));
    mountChannel(null);
    await user.type(holdField(), "Hold the migration");
    await user.click(
      within(cardQuestion(channelCard(), WATCH)).getByRole("button", {
        name: "Nothing yet",
      }),
    );
    setRefuseSends(true);
    await user.click(
      within(cardQuestion(channelCard(), HOLD)).getByRole("button", {
        name: "Submit",
      }),
    );
    await screen.findByTestId("bot-channel-composer-send-failed");

    write(twoQuestions(true));

    await vi.waitFor(() => expect(channelMovedLine()).toBeDefined());
  }

  it("shows the moved line and keeps the couldn't-send line when another question's answer moves into the box after a question's send failed", async () => {
    await failureShowingThenAnAnswerMoves();

    expect(channelMovedLine()).toBe(
      "Tess Teammate answered first. Your answer is in your message box, not sent.",
    );
    expect(
      screen.getByTestId("bot-channel-composer-send-failed").textContent,
    ).toContain("Couldn't send. Try again.");
  });

  it("takes back the couldn't-send line, and keeps the moved line, when the person sends a question's answer again", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await failureShowingThenAnAnswerMoves();
    setRefuseSends(false);

    await user.click(
      within(cardQuestion(channelCard(), HOLD)).getByRole("button", {
        name: "Submit",
      }),
    );

    expect(screen.queryByTestId("bot-channel-composer-send-failed")).toBeNull();
    expect(channelMovedLine()).toBe(
      "Tess Teammate answered first. Your answer is in your message box, not sent.",
    );
  });

  it("takes back the box's couldn't-send line once the person types in the box", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    session(CHANNEL_ID, [questionRow([hold(null)])]);
    mountChannel(null);
    await user.type(holdField(), "Hold the migration");
    setRefuseSends(true);
    await user.click(
      within(cardQuestion(channelCard(), HOLD)).getByRole("button", {
        name: "Submit",
      }),
    );
    await screen.findByTestId("bot-channel-composer-send-failed");

    typeInto(channelBox(), "Wait");

    expect(screen.queryByTestId("bot-channel-composer-send-failed")).toBeNull();
  });

  it("takes back the box's couldn't-send line when the card sends again", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    session(CHANNEL_ID, [questionRow([hold(null)])]);
    mountChannel(null);
    await user.type(holdField(), "Hold the migration");
    setRefuseSends(true);
    await user.click(
      within(cardQuestion(channelCard(), HOLD)).getByRole("button", {
        name: "Submit",
      }),
    );
    await screen.findByTestId("bot-channel-composer-send-failed");
    setRefuseSends(false);
    setHeldSends([]);

    await user.click(
      within(cardQuestion(channelCard(), HOLD)).getByRole("button", {
        name: "Submit",
      }),
    );

    expect(sent).toHaveLength(2);
    expect(screen.queryByTestId("bot-channel-composer-send-failed")).toBeNull();
  });
});

describe("<BotChannelView tiles={null} /> under the box: a moved answer, a failed box send and a failed card answer", () => {
  const BOX_MESSAGE = "Box message";
  const NEWER = "Newer draft";

  function failureLines(): HTMLElement[] {
    return screen.queryAllByTestId("bot-channel-composer-send-failed");
  }

  function restoreButton(): HTMLElement | null {
    return screen.queryByTestId("bot-channel-composer-send-failed-restore");
  }

  /** Whether `first` comes before `second` in the document. */
  function inOrder(first: HTMLElement, second: HTMLElement): boolean {
    return Boolean(
      first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
  }

  /** The box sends a message the host refuses, and a newer draft was typed meanwhile: the message is offered back. */
  async function boxSendFailsWithAnOffer(): Promise<void> {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setHeldSends([]);
    typeInto(channelBox(), BOX_MESSAGE);
    await user.click(screen.getByTestId("bot-channel-composer-send"));
    typeInto(channelBox(), NEWER);
    await refuse();
    await screen.findByTestId("bot-channel-composer-send-failed-restore");
  }

  /** A card of two questions whose first one's answer is typed and second one's is picked. */
  async function answeredBothQuestions(): Promise<
    (settledSecond: boolean) => void
  > {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const rows = (settledSecond: boolean): ReadonlyArray<Message> => [
      questionRow([
        hold(null),
        watch(
          settledSecond
            ? byPerson(TEAMMATE_USER_ID, "Agents waiting on me")
            : null,
        ),
      ]),
    ];
    const write = session(CHANNEL_ID, rows(false));
    mountChannel(null);
    await user.type(holdField(), "Hold the migration");
    await user.click(
      within(cardQuestion(channelCard(), WATCH)).getByRole("button", {
        name: "Nothing yet",
      }),
    );
    return (settledSecond) => write(rows(settledSecond));
  }

  /**
   * The box's send failed with an offer, the first question's send failed too,
   * and then the second question's answer moved into the box.
   */
  async function threeThingsUnderTheBox(): Promise<void> {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const settleSecond = await answeredBothQuestions();
    setHeldSends([]);
    typeInto(channelBox(), BOX_MESSAGE);
    await user.click(screen.getByTestId("bot-channel-composer-send"));
    typeInto(channelBox(), NEWER);
    await user.click(
      within(cardQuestion(channelCard(), HOLD)).getByRole("button", {
        name: "Submit",
      }),
    );
    await refuse();
    await refuse();
    settleSecond(true);
    await vi.waitFor(() => expect(channelMovedLine()).toBeDefined());
  }

  it("shows the moved line, then the box's couldn't-send line with Restore, when an answer moves into the box after its send failed, and Restore puts the message back", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const write = session(CHANNEL_ID, [questionRow([hold(null)])]);
    mountChannel(null);
    await user.type(holdField(), "Hold the migration");
    await boxSendFailsWithAnOffer();

    write([questionRow([hold(byPerson(TEAMMATE_USER_ID, "Nothing"))])]);

    await vi.waitFor(() => expect(channelMovedLine()).toBeDefined());
    expect(failureLines()).toHaveLength(1);
    expect(restoreButton()).not.toBeNull();
    expect(
      inOrder(
        screen.getByTestId("bot-channel-composer-answers-moved"),
        failureLines()[0],
      ),
    ).toBe(true);

    await user.click(
      screen.getByTestId("bot-channel-composer-send-failed-restore"),
    );

    expect(textOf(channelBox())).toContain(BOX_MESSAGE);
  });

  it("shows the moved line and exactly one couldn't-send line, the box's, with Restore, when a box send and a card answer both failed and an answer moved, and the card's line comes back without Restore after Restore", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await threeThingsUnderTheBox();

    expect(failureLines()).toHaveLength(1);
    expect(restoreButton()).not.toBeNull();
    expect(
      inOrder(
        screen.getByTestId("bot-channel-composer-answers-moved"),
        failureLines()[0],
      ),
    ).toBe(true);

    await user.click(
      screen.getByTestId("bot-channel-composer-send-failed-restore"),
    );

    expect(channelMovedLine()).toBeDefined();
    expect(failureLines()).toHaveLength(1);
    expect(restoreButton()).toBeNull();
  });

  it("shows only the moved line after Restore when the transcript spent the card's answer while the box's couldn't-send line stood", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await threeThingsUnderTheBox();
    act(() =>
      useBotDraftsStore
        .getState()
        .setAnswer(BOT_ID, answerDraftKey(QUESTION_ID, 0), null),
    );

    await user.click(
      screen.getByTestId("bot-channel-composer-send-failed-restore"),
    );

    expect(channelMovedLine()).toBeDefined();
    expect(failureLines()).toEqual([]);
  });
});
