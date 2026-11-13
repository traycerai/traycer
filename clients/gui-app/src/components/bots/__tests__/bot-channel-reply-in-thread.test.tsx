/**
 * "Create thread" on every row of a bot's channel (Tracy Bots,
 * decision 79), and Reply on them (T166), through the REAL
 * `BotChannelView`, transcript and `ChatBotMessage`: a member's post, the
 * bot's direct answer, a plain announcement and an announcement carrying a
 * surface each offer the thread, on hover and on a long press, while the
 * bot's binding names the rows a thread roots on; choosing it on the plain
 * announcement opens the rail on that announcement's own thread. Reply names
 * a row in the box of its own conversation, the channel's or the open
 * thread's, where the tab's host and the bot's take one. Only the
 * virtualised message list, the chat session registry (scripted sessions by
 * chat id) and the channel's neighbouring reads are replaced.
 */
import {
  botMentionHostClientMock,
  emptyBotMentionHostListsMock,
} from "@/components/bots/__tests__/bot-mention-host-test-support";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HostClient,
  type HostRequester,
} from "@traycer-clients/shared/host-client/host-client";
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  BotConversationSendRequest,
  BotThreadAnchors,
  BotThreadSummary,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type {
  BotSurfaceReference,
  Message,
} from "@traycer/protocol/persistence/epic/messages";
import {
  BOT_ID,
  CHANNEL_ID,
  HOST_ID,
  POST_ID,
  POST_REQUEST,
  THREAD_ID,
  THREAD_OPEN,
  THREAD_REPLY_ID,
  botReply,
  hostClientLocating,
  memberPost,
  postThread,
  scriptedSession,
} from "@/components/bots/__tests__/bot-turn-test-support";
import { MountedChannel } from "@/components/bots/__tests__/bot-turn-channel-harness";
import {
  negotiateBotSend,
  resetBotFailedRequestSupport,
  signInViewer,
  VIEWER_USER_ID,
} from "@/components/bots/__tests__/bot-failed-request-test-support";
import type { BotActivity } from "@/hooks/bots/use-bot-activity";
import { LONG_PRESS_MS } from "@/hooks/ui/use-long-press";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type { BotReplyTarget } from "@/lib/bots/bot-reply-target";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import {
  editableIn,
  typeInto,
} from "@/components/bots/__tests__/bot-box-test-support";

const mocks = vi.hoisted(() => ({
  client: null as HostRequester<HostRpcRegistry> | null,
  sessions: {} as Record<string, ChatSessionStoreHandle>,
  threadAnchors: null as BotThreadAnchors | null,
  threads: [] as BotThreadSummary[],
  /** How the host answers a cold read of a channel row. */
  locate: { status: "waiting" } as
    | { readonly status: "waiting" }
    | { readonly status: "missing" },
  /** What the bot is doing, as `useBotActivity` reads it. */
  activity: null as BotActivity | null,
}));

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
  ): ChatSessionStoreHandle | null =>
    Object.hasOwn(mocks.sessions, chatId) ? mocks.sessions[chatId] : null,
  useExistingChatSessionHandle: (
    _epicId: string,
    chatId: string,
  ): ChatSessionStoreHandle | null =>
    Object.hasOwn(mocks.sessions, chatId) ? mocks.sessions[chatId] : null,
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
    data: { threads: mocks.threads, threadAnchors: mocks.threadAnchors },
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
  useChatLocateRowAnswer: () => mocks.locate,
}));
// The row sheet re-asserts the app theme where it portals; the provider is
// not under test.
vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({ resolvedTheme: "light", themePreset: "neutral" }),
}));
vi.mock("@/hooks/bots/use-bot-activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/bots/use-bot-activity")>()),
  useBotActivity: () => mocks.activity,
}));
vi.mock("@/components/chat/chat-messages", async () => {
  const { ChatExpansionTestProviders: Providers } =
    await import("@/components/chat/__tests__/chat-expansion-test-providers");
  const { use } = await import("react");
  const { ChatMessage } = await import("@/components/chat/chat-message");
  const { ChatTimelineHeaderContext } =
    await import("@/components/chat/chat-timeline-header-context");
  const noBackgroundToolBlockIds: ReadonlySet<string> = new Set();
  return {
    ChatMessages: (props: {
      messages: ReadonlyArray<ChatMessageModel>;
      instanceId: string;
    }) => (
      <Providers tileInstanceId={props.instanceId}>
        <div
          data-testid="chat-messages-stub"
          data-instance-id={props.instanceId}
        >
          {use(ChatTimelineHeaderContext)}
          {props.messages.map((message) => (
            <div key={message.id} data-row-id={message.persistentMessageId}>
              <ChatMessage
                message={message}
                actions={null}
                backgroundToolBlockIds={noBackgroundToolBlockIds}
                nextStepActions={null}
              />
            </div>
          ))}
        </div>
      </Providers>
    ),
  };
});

/** The binding the harness mounts the channel under. */
const BOUND_HOST_ID = "host-runs-bot";
const BOUND_EPOCH = 1;

const ANSWER_ID = "answer-1";
const NOTICE_ID = "notice-1";
const SURFACE_ROW_ID = "surface-1";

const SURFACE: BotSurfaceReference = {
  kind: "question",
  epicId: "task-1",
  hostId: "host-task",
  chatId: "agent-chat-1",
  blockId: "block-1",
  resolution: null,
};

function announcement(
  messageId: string,
  text: string,
  timestamp: number,
  surface: BotSurfaceReference | null,
): Message {
  return {
    ...botReply({ messageId, text, timestamp }),
    announcement: { kind: "automation", link: null },
    ...(surface === null ? {} : { surface }),
  };
}

function anchorsNaming(kinds: readonly string[]): BotThreadAnchors {
  return { hostId: BOUND_HOST_ID, epoch: BOUND_EPOCH, kinds: [...kinds] };
}

beforeEach(() => {
  useBotOpenThreadStore.setState({ byBotId: {} });
  mocks.sessions = {
    [CHANNEL_ID]: scriptedSession(CHANNEL_ID, [
      memberPost({
        messageId: POST_ID,
        requestId: POST_REQUEST,
        lines: ["Is CI green?"],
        timestamp: 1_000,
        resolvedBy: null,
      }),
      {
        ...botReply({
          messageId: ANSWER_ID,
          text: "CI is green.",
          timestamp: 2_000,
        }),
        repliesTo: POST_ID,
      },
      announcement(NOTICE_ID, "Nightly triage now runs at 02:00", 3_000, null),
      announcement(
        SURFACE_ROW_ID,
        "The agent is waiting on you.",
        4_000,
        SURFACE,
      ),
    ]).handle,
  };
  mocks.client = hostClientLocating(() => ({ turns: [] }), []);
});

afterEach(() => {
  cleanup();
  mocks.sessions = {};
  mocks.client = null;
  mocks.threadAnchors = null;
  mocks.threads = [];
  mocks.locate = { status: "waiting" };
  mocks.activity = null;
  resetBotFailedRequestSupport();
  useBotDraftsStore.setState({ answers: {}, threadBoxes: {}, unsentBoxes: {} });
});

function rowOf(messageId: string): HTMLElement {
  const holder = document.querySelector(`[data-row-id="${messageId}"]`);
  if (!(holder instanceof HTMLElement)) throw new Error(`no row ${messageId}`);
  return holder;
}

function createThreadOn(messageId: string): HTMLElement | null {
  return within(rowOf(messageId)).queryByRole("button", {
    name: "Create thread",
  });
}

const EVERY_ROW = [POST_ID, ANSWER_ID, NOTICE_ID, SURFACE_ROW_ID];

describe("Create thread on every row of a bot's channel", () => {
  it("is offered on a member's post, the bot's answer, a plain announcement and a surface card, and opens the plain announcement's own thread", async () => {
    const user = userEvent.setup();
    mocks.threadAnchors = anchorsNaming(["answer", "message"]);
    render(<MountedChannel />);

    for (const messageId of EVERY_ROW) {
      expect(createThreadOn(messageId), messageId).not.toBeNull();
    }

    const action = createThreadOn(NOTICE_ID);
    if (action === null) throw new Error("expected the action");
    await user.click(action);

    expect(useBotOpenThreadStore.getState().byBotId[BOT_ID]).toEqual({
      kind: "thread",
      anchorMessageId: NOTICE_ID,
      announcement: true,
      anchorKind: "message",
      sent: null,
    });
    const panel = screen.getByTestId("bot-thread-panel");
    expect(
      within(panel).getByText("Nightly triage now runs at 02:00"),
    ).toBeTruthy();
  });

  it("is not offered on the bot's plain rows where its binding names only the rows an older host roots threads on", () => {
    mocks.threadAnchors = anchorsNaming(["answer"]);
    render(<MountedChannel />);

    expect(createThreadOn(POST_ID)).not.toBeNull();
    expect(createThreadOn(ANSWER_ID)).not.toBeNull();
    expect(createThreadOn(NOTICE_ID)).toBeNull();
    expect(createThreadOn(SURFACE_ROW_ID)).toBeNull();
  });

  it.each(EVERY_ROW)(
    "is offered by a long press on row %s on a touch screen",
    async (messageId) => {
      const user = userEvent.setup();
      mocks.threadAnchors = anchorsNaming(["answer", "message"]);
      render(<MountedChannel />);
      const row = rowOf(messageId).firstElementChild;
      if (!(row instanceof HTMLElement)) throw new Error("no row frame");

      vi.useFakeTimers();
      fireEvent.pointerDown(row, {
        pointerId: 1,
        pointerType: "touch",
        isPrimary: true,
        button: 0,
        clientX: 10,
        clientY: 10,
      });
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS);
      });
      vi.useRealTimers();

      const choice = await screen.findByTestId("bot-reply-sheet-thread");
      expect(choice.textContent).toBe("Create thread");
      await user.click(choice);

      expect(useBotOpenThreadStore.getState().byBotId[BOT_ID]).toMatchObject({
        kind: "thread",
        anchorMessageId: messageId,
      });
    },
  );
});

describe("the box of a listed thread under a row of the bot, opened by its anchor alone", () => {
  /** The rail as a memory's link and a thread session's "Open thread" write it. */
  const BY_ANCHOR = {
    kind: "thread",
    anchorMessageId: NOTICE_ID,
    announcement: false,
    anchorKind: null,
    sent: null,
  } as const;

  const NOTICE_THREAD = {
    threadId: "thread-notice",
    conversationId: CHANNEL_ID,
    sessionChatId: "session-notice",
    anchor: {
      messageId: NOTICE_ID,
      requestId: "req-under-notice",
      senderUserId: null,
      sentAt: 3_000,
      resolvedAt: null,
      excerpt: null,
    },
    replyCount: 1,
    lastReplyAt: 5_000,
    openRequestCount: 1,
    costUsd: null,
  } satisfies BotThreadSummary;

  function sendEnabledAfterTyping(): boolean {
    const panel = screen.getByTestId("bot-thread-panel");
    typeInto(
      editableIn(within(panel).getByTestId("bot-thread-composer-input")),
      "Since when?",
    );
    return !within(panel)
      .getByTestId("bot-thread-composer-send")
      .hasAttribute("disabled");
  }

  it.each([
    [
      "a binding that names only the rows an older host roots threads on",
      BOUND_EPOCH,
      ["answer"],
    ],
    [
      "anchors said under another epoch of the binding",
      BOUND_EPOCH - 1,
      ["answer", "message"],
    ],
  ])("takes no send under %s", (_label, epoch, kinds) => {
    mocks.threads = [NOTICE_THREAD];
    mocks.threadAnchors = { hostId: BOUND_HOST_ID, epoch, kinds: [...kinds] };
    useBotOpenThreadStore.getState().setRail(BOT_ID, BY_ANCHOR);
    render(<MountedChannel />);

    expect(sendEnabledAfterTyping()).toBe(false);
  });

  it("takes a send under a proposal of the bot on any binding, its row saying it roots a thread everywhere", () => {
    const proposal: Message = {
      ...botReply({
        messageId: "question-1",
        text: "Which release should I watch?",
        timestamp: 4_500,
      }),
      announcement: { kind: "proposal", link: null },
    };
    mocks.sessions[CHANNEL_ID].store.setState((state) => ({
      messages: [...state.messages, proposal],
    }));
    mocks.threads = [
      {
        ...NOTICE_THREAD,
        threadId: "thread-question",
        anchor: { ...NOTICE_THREAD.anchor, messageId: "question-1" },
      },
    ];
    mocks.threadAnchors = anchorsNaming([]);
    useBotOpenThreadStore
      .getState()
      .setRail(BOT_ID, { ...BY_ANCHOR, anchorMessageId: "question-1" });
    render(<MountedChannel />);

    expect(sendEnabledAfterTyping()).toBe(true);
  });

  it("takes a send while the binding names the row among the rows a thread roots on", () => {
    mocks.threads = [NOTICE_THREAD];
    mocks.threadAnchors = anchorsNaming(["answer", "message"]);
    useBotOpenThreadStore.getState().setRail(BOT_ID, BY_ANCHOR);
    render(<MountedChannel />);

    expect(sendEnabledAfterTyping()).toBe(true);
  });

  it.each([
    ["only the rows an older host roots threads on", BOUND_EPOCH, ["answer"]],
    ["another epoch of the binding", BOUND_EPOCH - 1, ["answer", "message"]],
    ["every row of the bot", BOUND_EPOCH, ["answer", "message"]],
  ])(
    "takes no send while its row cannot be read, under a binding naming %s",
    (_label, epoch, kinds) => {
      // The anchor is not in the channel the session holds, and the host's
      // read of it fails.
      mocks.locate = { status: "missing" };
      mocks.threads = [
        {
          ...NOTICE_THREAD,
          anchor: { ...NOTICE_THREAD.anchor, messageId: "notice-cold" },
        },
      ];
      mocks.threadAnchors = { hostId: BOUND_HOST_ID, epoch, kinds: [...kinds] };
      useBotOpenThreadStore
        .getState()
        .setRail(BOT_ID, { ...BY_ANCHOR, anchorMessageId: "notice-cold" });
      render(<MountedChannel />);

      expect(sendEnabledAfterTyping()).toBe(false);
    },
  );
});

describe("Reply on a row of a bot's channel", () => {
  const WITH_REPLIES = ["answer", "message", "replies"];
  /** The first `bot.conversation.send` line that carries a reply. */
  const REPLIES_MINOR = 6;
  let sent: ReadonlyArray<BotConversationSendRequest>;

  /** The tab's host client: it records each send, and locates no turn. */
  function hostClientRecordingSends(): HostRequester<HostRpcRegistry> {
    let seq = 0;
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `request-${String(++seq)}`,
      handlers: {
        "bot.turn.locate": () => Promise.resolve({ turns: [] }),
        "bot.conversation.send": (params) => {
          sent = [...sent, params];
          return Promise.resolve({
            messageId: "message-new",
            requestId: "req-new",
            delivery: "written" as const,
            threadId: null,
          });
        },
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(new QueryClient()),
      findHostById: (hostId) =>
        hostId === mockRemoteHostEntry.hostId ? mockRemoteHostEntry : null,
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
    );
    return spine.createRequester(mockRemoteHostEntry);
  }

  beforeEach(() => {
    sent = [];
    mocks.client = hostClientRecordingSends();
    mocks.threadAnchors = anchorsNaming(WITH_REPLIES);
    negotiateBotSend(HOST_ID, { major: 1, minor: REPLIES_MINOR });
    signInViewer(VIEWER_USER_ID);
  });

  function replyOn(messageId: string): HTMLElement | null {
    return within(rowOf(messageId)).queryByRole("button", { name: "Reply" });
  }

  function chooseReplyOn(messageId: string): Promise<void> {
    const reply = replyOn(messageId);
    if (reply === null) throw new Error(`no Reply on ${messageId}`);
    return userEvent.setup().click(reply);
  }

  it("puts the strip in the channel's box when Reply is chosen on a row, and the send names that row", async () => {
    const user = userEvent.setup();
    render(<MountedChannel />);

    await chooseReplyOn(POST_ID);

    const strip = screen.getByTestId("bot-channel-composer-reply");
    expect(
      within(strip).getByTestId("bot-channel-composer-reply-author")
        .textContent,
    ).toBe("Olive Owner");
    expect(
      within(strip).getByTestId("bot-channel-composer-reply-line").textContent,
    ).toBe("Is CI green?");
    expect(screen.queryByTestId("bot-thread-composer-reply")).toBeNull();
    typeInto(
      editableIn(screen.getByTestId("bot-channel-composer-input")),
      "Yes",
    );
    await user.click(screen.getByTestId("bot-channel-composer-send"));

    expect(sent).toEqual([
      {
        botId: BOT_ID,
        conversationId: CHANNEL_ID,
        text: "Yes",
        threadId: null,
        announcementId: null,
        redeliver: null,
        supersedes: null,
        answer: null,
        replyTo: POST_ID,
      },
    ]);
    expect(screen.queryByTestId("bot-channel-composer-reply")).toBeNull();
  });

  it.each([
    [
      "another host than the tab's, whose thread list does not say it takes replies",
      REPLIES_MINOR,
      ["answer", "message"],
    ],
    [
      "a tab host that negotiated bot.conversation.send below the line that carries a reply",
      REPLIES_MINOR - 1,
      WITH_REPLIES,
    ],
  ])("is offered on no row of a bot bound to %s", (_label, minor, kinds) => {
    mocks.threadAnchors = anchorsNaming(kinds);
    negotiateBotSend(HOST_ID, { major: 1, minor });
    render(<MountedChannel />);

    for (const messageId of EVERY_ROW) {
      expect(replyOn(messageId), messageId).toBeNull();
    }
    expect(createThreadOn(POST_ID)).not.toBeNull();
  });

  it("puts the strip in the open thread's box, not the channel's, when Reply is chosen on a row of the thread", async () => {
    mocks.sessions[THREAD_ID] = scriptedSession(THREAD_ID, [
      botReply({
        messageId: THREAD_REPLY_ID,
        text: "Yes, the thread agrees.",
        timestamp: 3_000,
      }),
    ]).handle;
    mocks.threads = [postThread()];
    useBotOpenThreadStore
      .getState()
      .setRail(BOT_ID, { kind: "thread", ...THREAD_OPEN });
    render(<MountedChannel />);
    const panel = screen.getByTestId("bot-thread-panel");

    await userEvent
      .setup()
      .click(within(panel).getByRole("button", { name: "Reply" }));

    const strip = within(panel).getByTestId("bot-thread-composer-reply");
    expect(
      within(strip).getByTestId("bot-thread-composer-reply-line").textContent,
    ).toBe("Yes, the thread agrees.");
    expect(screen.queryByTestId("bot-channel-composer-reply")).toBeNull();
  });

  it("is offered on no row while the channel's box edits a failed message", async () => {
    mocks.activity = {
      trunk: {
        state: "failed",
        startedAt: 1_000,
        step: null,
        requestId: POST_REQUEST,
        reason: null,
      },
      threads: {},
    };
    render(<MountedChannel />);
    expect(replyOn(ANSWER_ID)).not.toBeNull();

    await userEvent
      .setup()
      .click(within(rowOf(POST_ID)).getByTestId("bot-message-edit"));

    expect(screen.getByTestId("bot-channel-composer-editing")).toBeTruthy();
    for (const messageId of EVERY_ROW) {
      expect(replyOn(messageId), messageId).toBeNull();
    }
  });

  /** A row of the bot with `text` as its one text block, below the rows of the channel. */
  function addBotRow(messageId: string, text: string): void {
    mocks.sessions[CHANNEL_ID].store.setState((state) => ({
      messages: [
        ...state.messages,
        botReply({ messageId, text, timestamp: 5_000 }),
      ],
    }));
  }

  function channelReplyTarget(): BotReplyTarget | null {
    return (
      useBotDraftsStore.getState().threadBoxes[BOT_ID]?.[CHANNEL_ID]?.replyTo ??
      null
    );
  }

  it("names a bot's row by its first line as the bot wrote it, not by the preview that folds its lines together", async () => {
    addBotRow("bot-two-lines", "First line\nSecond line");
    render(<MountedChannel />);

    await userEvent
      .setup()
      .click(within(rowOf("bot-two-lines")).getByTestId("bot-message-reply"));

    expect(
      screen.getByTestId("bot-channel-composer-reply-line").textContent,
    ).toBe("First line");
    expect(channelReplyTarget()).toEqual({
      messageId: "bot-two-lines",
      author: "Release Bot",
      line: "First line",
    });
  });

  it("keeps a bot's line of two hundred characters whole when the preview's cut falls inside a character", async () => {
    // One character of eleven UTF-16 units, so the preview's cut at two
    // hundred units lands inside it.
    const family = ["\u{1F468}", "\u{1F469}", "\u{1F467}", "\u{1F466}"].join(
      String.fromCodePoint(0x200d),
    );
    const line = `${"a".repeat(195)}${family} end`;
    addBotRow("bot-long-line", line);
    render(<MountedChannel />);

    await userEvent
      .setup()
      .click(within(rowOf("bot-long-line")).getByTestId("bot-message-reply"));

    expect(
      screen.getByTestId("bot-channel-composer-reply-line").textContent,
    ).toBe(line);
    expect(channelReplyTarget()).toEqual({
      messageId: "bot-long-line",
      author: "Release Bot",
      line,
    });
  });

  it("keeps naming the message by the line it was chosen with when the row's text changes", async () => {
    render(<MountedChannel />);
    await chooseReplyOn(POST_ID);

    act(() => {
      mocks.sessions[CHANNEL_ID].store.setState((state) => ({
        messages: state.messages.map((message) =>
          message.messageId === POST_ID
            ? memberPost({
                messageId: POST_ID,
                requestId: POST_REQUEST,
                lines: ["Is the nightly green?"],
                timestamp: 1_000,
                resolvedBy: null,
              })
            : message,
        ),
      }));
    });

    expect(
      within(rowOf(POST_ID)).getByText("Is the nightly green?"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("bot-channel-composer-reply-line").textContent,
    ).toBe("Is CI green?");
  });
});
