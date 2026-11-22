/**
 * What a member has not sent, through the REAL `BotChannelView`: the answers
 * and drafts that outlive the views that draw them (the channel unmounting,
 * as a switch to another tab does, and the thread closing), what the signed-in
 * account sees of a moved answer across an account switch, and a question a
 * thread's session asks in its thread. The tree, the host client and the
 * per-case lifecycle are in `bot-channel-question-card-harness.tsx`.
 */
import {
  botMentionHostClientMock,
  emptyBotMentionHostListsMock,
} from "@/components/bots/__tests__/bot-mention-host-test-support";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type {
  BotQuestionSettlement,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import {
  negotiateBotSend,
  VIEWER_USER_ID,
} from "@/components/bots/__tests__/bot-failed-request-test-support";
import type { BotSessionActivity } from "@/hooks/bots/use-bot-activity";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import { BotDraftsPersistLifecycleBridge } from "@/providers/bot-drafts-persist-lifecycle-bridge";
import { botBoxDraftsKey } from "@/lib/persist/keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  answerDraftKey,
  useBotDraftsStore,
} from "@/stores/bots/bot-drafts-store";
import type { BotOpenThread } from "@/stores/bots/bot-open-thread-store";
import {
  boxWithin,
  textOf,
  typeInto,
} from "@/components/bots/__tests__/bot-box-test-support";
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
  heldSends,
  HOLD,
  hold,
  holdField,
  HOST_ID,
  installQuestionCardCaseLifecycle,
  mountChannel,
  onOpenThread,
  QUESTION_ID,
  questionRow,
  refuse,
  sent,
  session,
  setDelivery,
  setHeldSends,
  setIdentityBridge,
  TEAMMATE_USER_ID,
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

function textDoc(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

/** The host takes the oldest send held. */
async function land(): Promise<void> {
  const next = heldSends?.shift();
  if (next === undefined) throw new Error("no send is held");
  await act(async () => {
    next.land();
    await next.answered;
  });
}

/** The question's own thread, as Discuss opens it. */
const QUESTION_THREAD: BotOpenThread = {
  anchorMessageId: QUESTION_ID,
  announcement: true,
  anchorKind: null,
  sent: null,
};

/** The box of the question's thread, which nobody has started. */
function questionThreadBox(): HTMLElement {
  const box = boxWithin(
    screen.getByTestId("bot-thread-panel"),
    "Reply in a new thread",
  );
  return box;
}

describe("<BotChannelView tiles={null} /> what a member has not sent, across the views that draw it", () => {
  /**
   * The card's one question settled by a teammate first, the viewer's answer
   * unsent: `typed`, now moved into the channel's box.
   */
  async function movedToChannelBox(typed: string): Promise<{
    readonly reopen: (next: BotOpenThread | null) => void;
    readonly unmount: () => void;
  }> {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const write = session(CHANNEL_ID, [questionRow([hold(null)])]);
    const view = mountChannel(null);
    // Seed the draft in one paste; these cases exercise its lifecycle after settlement.
    await user.click(holdField());
    await user.paste(typed);
    write([questionRow([hold(byPerson(TEAMMATE_USER_ID, "Nothing"))])]);
    expect(textOf(channelBox())).toBe(typed);
    return view;
  }

  it("keeps a card's answers, typed, picked and sent, across the channel unmounting and mounting again, as a switch to another tab and back does", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setDelivery("queued");
    session(CHANNEL_ID, [questionRow([deploy(null), hold(null)])]);
    const first = mountChannel(null);
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
    await user.type(holdField(), "Hold the migration");

    first.unmount();
    mountChannel(null);

    const deployQuestion = cardQuestion(channelCard(), DEPLOY);
    expect(
      within(deployQuestion).getByTestId("question-card-sending"),
    ).toBeTruthy();
    expect(
      within(deployQuestion)
        .getByRole("button", { name: "Now" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(holdField().value).toBe("Hold the migration");
    expect(sent).toHaveLength(1);
  });

  it("keeps the moved answer, and what was typed after it, in the channel's box across the channel unmounting and mounting again", async () => {
    const view = await movedToChannelBox("Hold the migration");
    typeInto(channelBox(), " today");

    view.unmount();
    mountChannel(null);

    expect(textOf(channelBox())).toBe("Hold the migration today");
    expect(sent).toEqual([]);
  });

  it("spends the moved answer with the send that carries it, even when the send lands after the channel was unmounted", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setHeldSends([]);
    const view = await movedToChannelBox("Hold the migration");
    await user.click(screen.getByTestId("bot-channel-composer-send"));
    expect(
      sent.map((request) => [request.text, request.threadId, request.answer]),
    ).toEqual([["Hold the migration", null, null]]);

    view.unmount();
    await land();
    mountChannel(null);

    expect(textOf(channelBox())).toBe("");
  });

  it("offers the refused send's text back beside a newer draft, in the channel mounted again after the send was refused while it was unmounted", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setHeldSends([]);
    const view = await movedToChannelBox("Hold the migration");
    await user.click(screen.getByTestId("bot-channel-composer-send"));
    typeInto(channelBox(), "Hold off today");

    view.unmount();
    await refuse();
    mountChannel(null);

    expect(textOf(channelBox())).toBe("Hold off today");
    expect(
      screen.getByTestId("bot-channel-composer-send-failed").textContent,
    ).toContain("Hold the migration");
    await user.click(
      screen.getByTestId("bot-channel-composer-send-failed-restore"),
    );
    expect(textOf(channelBox())).toBe("Hold the migration");
    expect(screen.queryByTestId("bot-channel-composer-send-failed")).toBeNull();
  });

  /**
   * The moved answer sent from the channel's box, the channel unmounted and
   * mounted again while the send is held: the answer went with the send, so
   * the box opens empty.
   */
  async function sentThenRemounted(): Promise<void> {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setHeldSends([]);
    const view = await movedToChannelBox("Hold the migration");
    await user.click(screen.getByTestId("bot-channel-composer-send"));
    view.unmount();
    mountChannel(null);
    expect(textOf(channelBox())).toBe("");
  }

  it("does not offer the sent answer again in the box mounted while the send was in flight, once it lands", async () => {
    await sentThenRemounted();

    await land();

    expect(textOf(channelBox())).toBe("");
    expect(
      screen.getByTestId("bot-channel-composer-send").hasAttribute("disabled"),
    ).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("keeps what was typed in the box mounted again after the send left, when the send lands", async () => {
    await sentThenRemounted();
    typeInto(channelBox(), "Hold off today");

    await land();

    expect(textOf(channelBox())).toBe("Hold off today");
  });

  it("keeps an answer that moves into the box while an earlier send from it is in flight, once that send lands", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setHeldSends([]);
    const write = session(CHANNEL_ID, [
      questionRow([deploy(null), hold(null)]),
    ]);
    mountChannel(null);
    await user.click(holdField());
    await user.paste("Hold the migration");
    await user.click(
      within(cardQuestion(channelCard(), DEPLOY)).getByRole("button", {
        name: "Now",
      }),
    );
    write([
      questionRow([deploy(null), hold(byPerson(TEAMMATE_USER_ID, "Nothing"))]),
    ]);
    await user.click(screen.getByTestId("bot-channel-composer-send"));

    write([
      questionRow([
        deploy(byPerson(TEAMMATE_USER_ID, "After the train")),
        hold(byPerson(TEAMMATE_USER_ID, "Nothing")),
      ]),
    ]);
    expect(textOf(channelBox())).toBe(`${DEPLOY} Now`);
    await land();

    expect(textOf(channelBox())).toBe(`${DEPLOY} Now`);
  });
});

const ACCOUNT_A = "user-account-a";
const ACCOUNT_B = "user-account-b";

function signInAs(userId: string): void {
  act(() => {
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId,
        userName: userId,
        email: `${userId}@example.com`,
        avatarUrl: null,
      },
      contextMetadata: { userId, username: userId },
    });
  });
}

function signOut(): void {
  act(() => {
    useAuthStore.setState({
      status: "signed-out",
      profile: null,
      contextMetadata: null,
    });
  });
}

/** Nothing of anyone's kept in memory, in any slice of the drafts store. */
function expectNoDraftsInMemory(): void {
  const { answers, threadBoxes, unsentBoxes, boxCarries, boxNotices } =
    useBotDraftsStore.getState();
  expect({ answers, threadBoxes, unsentBoxes, boxCarries, boxNotices }).toEqual(
    {
      answers: {},
      threadBoxes: {},
      unsentBoxes: {},
      boxCarries: {},
      boxNotices: {},
    },
  );
}

describe("<BotChannelView tiles={null} /> a moved answer and the signed-in account (T186)", () => {
  const MOVED = "Hold the migration";

  beforeEach(() => {
    localStorage.clear();
    setIdentityBridge(true);
    signInAs(ACCOUNT_A);
  });

  afterEach(() => {
    localStorage.clear();
  });

  /** Signed in as A: the member types, a teammate settles, and the answer is in the channel's box. */
  async function movedIntoTheBoxAsA(): Promise<void> {
    const write = session(CHANNEL_ID, [questionRow([hold(null)])]);
    mountChannel(null);
    await userEvent
      .setup({ advanceTimers: vi.advanceTimersByTime })
      .type(holdField(), MOVED);
    write([questionRow([hold(byPerson(TEAMMATE_USER_ID, "Nothing"))])]);
    expect(textOf(channelBox())).toBe(MOVED);
  }

  /** B's box, with nothing of A's anywhere B could read it. */
  async function expectNothingOfAForB(): Promise<void> {
    await vi.waitFor(() => expect(textOf(channelBox())).toBe(""));
    expect(channelMovedLine()).toBeUndefined();
    expectNoDraftsInMemory();
    expect(
      localStorage.getItem(botBoxDraftsKey(ACCOUNT_B)) ?? "",
    ).not.toContain(MOVED);
  }

  it("shows account B nothing of account A's moved answer, in the box, the store or B's storage, and gives it back, unsent and with no line, when A signs in again after a switch", async () => {
    await movedIntoTheBoxAsA();

    signInAs(ACCOUNT_B);
    await expectNothingOfAForB();

    signInAs(ACCOUNT_A);
    await vi.waitFor(() => expect(textOf(channelBox())).toBe(MOVED));
    expect(channelMovedLine()).toBeUndefined();
    expect(sent).toEqual([]);
  });

  it("keeps an answer that moved while the box was not mounted, and was still not mounted at the switch, for A alone, folded into A's kept draft", async () => {
    setIdentityBridge(false);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <BotDraftsPersistLifecycleBridge>
          <div />
        </BotDraftsPersistLifecycleBridge>
      </QueryClientProvider>,
    );
    session(CHANNEL_ID, [questionRow([hold(null)])]);
    const key = answerDraftKey(QUESTION_ID, 0);
    act(() => {
      const drafts = useBotDraftsStore.getState();
      drafts.setAnswer(BOT_ID, key, {
        chosen: [],
        typed: MOVED,
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
    expect(
      useBotDraftsStore.getState().boxCarries[BOT_ID]?.[CHANNEL_ID],
    ).toBeDefined();

    signInAs(ACCOUNT_B);
    expectNoDraftsInMemory();
    const asB = mountChannel(null);
    await expectNothingOfAForB();
    asB.unmount();

    signInAs(ACCOUNT_A);
    mountChannel(null);
    await vi.waitFor(() => expect(textOf(channelBox())).toBe(MOVED));
    expect(channelMovedLine()).toBeUndefined();
  });

  it("writes an answer that moved while the box was not mounted into A's own key at the switch, after A's read finished, and gives it back to A", async () => {
    setIdentityBridge(false);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <BotDraftsPersistLifecycleBridge>
          <div />
        </BotDraftsPersistLifecycleBridge>
      </QueryClientProvider>,
    );
    await vi.waitFor(() =>
      expect(useBotDraftsStore.persist.hasHydrated()).toBe(true),
    );
    session(CHANNEL_ID, [questionRow([hold(null)])]);
    const key = answerDraftKey(QUESTION_ID, 0);
    act(() => {
      const drafts = useBotDraftsStore.getState();
      drafts.setAnswer(BOT_ID, key, {
        chosen: [],
        typed: MOVED,
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

    signInAs(ACCOUNT_B);

    await vi.waitFor(() =>
      expect(localStorage.getItem(botBoxDraftsKey(ACCOUNT_A)) ?? "").toContain(
        MOVED,
      ),
    );
    expectNoDraftsInMemory();
    const asB = mountChannel(null);
    await expectNothingOfAForB();
    asB.unmount();

    signInAs(ACCOUNT_A);
    mountChannel(null);
    await vi.waitFor(() => expect(textOf(channelBox())).toBe(MOVED));
    expect(channelMovedLine()).toBeUndefined();
  });

  it("gives A the moved answer back, unsent and with no line, when A signs out and signs in again, with nothing of it in memory while signed out", async () => {
    await movedIntoTheBoxAsA();

    signOut();
    expectNoDraftsInMemory();

    signInAs(ACCOUNT_A);
    await vi.waitFor(() => expect(textOf(channelBox())).toBe(MOVED));
    expect(channelMovedLine()).toBeUndefined();
  });

  it.each([
    { name: "refused", settle: refuse },
    { name: "landed", settle: land },
  ])(
    "leaves B's draft and B's box alone when a send A started is $name after the switch",
    async ({ settle }) => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setHeldSends([]);
      session(CHANNEL_ID, [questionRow([hold(null)])]);
      mountChannel(null);
      await user.type(holdField(), MOVED);
      await user.click(
        within(cardQuestion(channelCard(), HOLD)).getByRole("button", {
          name: "Submit",
        }),
      );
      expect(heldSends).toHaveLength(1);

      signInAs(ACCOUNT_B);
      await vi.waitFor(() => expect(holdField().value).toBe(""));
      await user.type(holdField(), "B's own answer");
      const before = useBotDraftsStore.getState().answers;

      await settle();

      expect(useBotDraftsStore.getState().answers).toEqual(before);
      expect(useBotDraftsStore.getState().boxNotices).toEqual({});
      expect(holdField().value).toBe("B's own answer");
      expect(holdField().disabled).toBe(false);
      expect(
        screen.queryByTestId("bot-channel-composer-send-failed"),
      ).toBeNull();
    },
  );
});

describe("<BotChannelView tiles={null} /> a question a thread's session asks in its thread", () => {
  const THREAD_ID = "thread-1";
  const POST_ID = "post-1";
  const IN_THREAD_ID = "bot-question:req-thread";

  function postThread(): BotThreadSummary {
    return {
      threadId: THREAD_ID,
      conversationId: CHANNEL_ID,
      sessionChatId: "session-1",
      anchor: {
        messageId: POST_ID,
        requestId: "req-post",
        senderUserId: VIEWER_USER_ID,
        sentAt: 1_000,
        resolvedAt: null,
        excerpt: null,
      },
      replyCount: 1,
      lastReplyAt: 2_000,
      openRequestCount: 1,
      costUsd: null,
    };
  }

  function memberPost(): Message {
    return {
      role: "user",
      messageId: POST_ID,
      sender: { type: "user", userId: VIEWER_USER_ID },
      message: {
        kind: "user",
        content: textDoc("Ship it?"),
        browserAnnotations: [],
      },
      timestamp: 1_000,
      sessionAnchor: null,
      conversationRequest: {
        requestId: "req-post",
        resolvedAt: null,
        resolvedByMessageId: null,
      },
    };
  }

  function threadQuestion(settlement: BotQuestionSettlement | null): Message {
    return botRow(IN_THREAD_ID, DEPLOY, [deploy(settlement)], null);
  }

  const POST_THREAD: BotOpenThread = {
    anchorMessageId: POST_ID,
    announcement: false,
    anchorKind: null,
    sent: null,
  };

  it("sends the answer into the thread, and moves an overtaken answer into the thread's own box, unsent, with the line under it", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocks.threads = [postThread()];
    session(CHANNEL_ID, [memberPost()]);
    const write = session(THREAD_ID, [threadQuestion(null)]);
    mountChannel(POST_THREAD);
    const panel = screen.getByTestId("bot-thread-replies");

    await user.click(within(panel).getByRole("button", { name: "Now" }));
    await user.click(within(panel).getByRole("button", { name: "Submit" }));

    expect(sent.map((request) => [request.threadId, request.answer])).toEqual([
      [
        THREAD_ID,
        { questionMessageId: IN_THREAD_ID, questionIndex: 0, skipped: false },
      ],
    ]);

    await user.click(within(panel).getByRole("button", { name: "Now" }));
    write([threadQuestion(byPerson(TEAMMATE_USER_ID, "After the train"))]);

    expect(onOpenThread).not.toHaveBeenCalled();
    const box = boxWithin(
      screen.getByTestId("bot-thread-panel"),
      "Reply in the thread",
    );
    expect(textOf(box)).toBe("Now");
    expect(
      screen.getByTestId("bot-thread-composer-answers-moved").textContent,
    ).toBe(
      "Tess Teammate answered first. Your answer is in your message box, not sent.",
    );
    expect(textOf(channelBox())).toBe("");
    expect(sent).toHaveLength(1);
  });

  it("moves a channel question's answer once, into the channel's box, when the question's own thread is open and draws its card too", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const write = session(CHANNEL_ID, [questionRow([hold(null)])]);
    mountChannel(QUESTION_THREAD);
    await user.type(holdField(), "Hold the migration");

    write([questionRow([hold(byPerson(TEAMMATE_USER_ID, "Nothing"))])]);

    expect(textOf(channelBox())).toBe("Hold the migration");
    expect(textOf(questionThreadBox())).toBe("");
    expect(
      screen.queryByTestId("bot-thread-composer-answers-moved"),
    ).toBeNull();
    expect(channelMovedLine()).toBe(
      "Tess Teammate answered first. Your answer is in your message box, not sent.",
    );
  });

  it("draws the thread's card with nothing to press on a host that negotiated bot.conversation.send 1.1", () => {
    negotiateBotSend(HOST_ID, { major: 1, minor: 1 });
    mocks.threads = [postThread()];
    session(CHANNEL_ID, [memberPost()]);
    session(THREAD_ID, [threadQuestion(null)]);
    mountChannel(POST_THREAD);

    const card = within(screen.getByTestId("bot-thread-replies")).getByTestId(
      "question-card",
    );
    expect(
      within(card)
        .getAllByRole("button")
        .filter((button) => !(button as HTMLButtonElement).disabled),
    ).toEqual([]);
    expect(sent).toEqual([]);
  });

  const REPLY_REQUEST = "req-reply";

  /** The viewer's reply in the thread, which the thread's session failed to answer. */
  function failedReply(): Message {
    return {
      role: "user",
      messageId: "reply-1",
      sender: { type: "user", userId: VIEWER_USER_ID },
      message: {
        kind: "user",
        content: textDoc("Hold for now"),
        browserAnnotations: [],
      },
      timestamp: 3_000,
      sessionAnchor: null,
      conversationRequest: {
        requestId: REPLY_REQUEST,
        resolvedAt: null,
        resolvedByMessageId: null,
      },
    };
  }

  const FAILED_ON_REPLY: BotSessionActivity = {
    state: "failed",
    startedAt: 3_000,
    step: null,
    requestId: REPLY_REQUEST,
    reason: null,
  };

  it("keeps an edit opened in the thread's box opened again, when a send from the box before it closed lands", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setHeldSends([]);
    activityStore.setState({
      activity: { trunk: null, threads: { [THREAD_ID]: FAILED_ON_REPLY } },
    });
    mocks.threads = [postThread()];
    session(CHANNEL_ID, [memberPost()]);
    session(THREAD_ID, [failedReply()]);
    const view = mountChannel(POST_THREAD);
    const box = (): HTMLElement => {
      const element = boxWithin(
        screen.getByTestId("bot-thread-panel"),
        "Reply in the thread",
      );
      return element;
    };
    typeInto(box(), "Ship it today");
    await user.click(screen.getByTestId("bot-thread-composer-send"));
    view.reopen(null);
    view.reopen(POST_THREAD);
    await user.click(
      within(screen.getByTestId("bot-thread-replies")).getByTestId(
        "bot-message-edit",
      ),
    );
    expect(textOf(box())).toBe("Hold for now");

    await land();

    expect(textOf(box())).toBe("Hold for now");
    expect(screen.getByTestId("bot-thread-composer-editing")).toBeTruthy();
  });

  /**
   * The thread's box editing a failed reply while another person's settlement
   * moves the member's answer in under the edit.
   */
  async function movedUnderTheEditOfAFailedReply(): Promise<{
    readonly reopen: (next: BotOpenThread | null) => void;
  }> {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    activityStore.setState({
      activity: { trunk: null, threads: { [THREAD_ID]: FAILED_ON_REPLY } },
    });
    mocks.threads = [postThread()];
    session(CHANNEL_ID, [memberPost()]);
    const write = session(THREAD_ID, [threadQuestion(null), failedReply()]);
    const view = mountChannel(POST_THREAD);
    const replies = screen.getByTestId("bot-thread-replies");
    await user.click(within(replies).getByRole("button", { name: "Now" }));
    await user.click(within(replies).getByTestId("bot-message-edit"));

    write([
      threadQuestion(byPerson(TEAMMATE_USER_ID, "After the train")),
      failedReply(),
    ]);
    return view;
  }

  function threadBox(): HTMLElement {
    return boxWithin(
      screen.getByTestId("bot-thread-panel"),
      "Reply in the thread",
    );
  }

  it("keeps the thread's box editing the failed reply when an overtaken answer moves in under its text, and what is sent still replaces the failed reply", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await movedUnderTheEditOfAFailedReply();

    expect(
      screen.getByTestId("bot-thread-composer-editing").textContent,
    ).toContain("Sending replaces your message that failed.");
    expect(textOf(threadBox())).toBe("Hold for now\n\nNow");
    await user.click(screen.getByTestId("bot-thread-composer-send"));
    expect(
      sent.map((request) => [
        request.text,
        request.threadId,
        request.supersedes,
      ]),
    ).toEqual([["Hold for now\n\nNow", THREAD_ID, REPLY_REQUEST]]);
  });

  it("gives the moved answer back, once, in the thread's box opened again after the person left it while it edited the failed reply", async () => {
    const view = await movedUnderTheEditOfAFailedReply();

    view.reopen(null);
    view.reopen(POST_THREAD);

    expect(textOf(threadBox())).toBe("Now");
    expect(sent).toEqual([]);
  });

  it("shows the moved answer, once, in the thread's box when the person cancels the edit of the failed reply", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await movedUnderTheEditOfAFailedReply();

    await user.click(screen.getByTestId("bot-thread-composer-edit-cancel"));

    expect(screen.queryByTestId("bot-thread-composer-editing")).toBeNull();
    expect(textOf(threadBox())).toBe("Now");
  });
});
