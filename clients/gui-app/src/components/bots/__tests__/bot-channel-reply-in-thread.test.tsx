/**
 * "Reply in thread" on every row of a bot's channel (Tracy Bots T68,
 * decision 79), through the REAL `BotChannelView`, transcript and
 * `ChatBotMessage`: a member's post, the bot's direct answer, a plain
 * announcement and an announcement carrying a surface each offer it, on
 * hover and on a long press, while the bot's binding names the rows a
 * thread roots on; choosing it on the plain announcement opens the rail on
 * that announcement's own thread. Only the virtualised message list, the
 * chat session registry (scripted sessions by chat id) and the channel's
 * neighbouring reads are replaced.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type {
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
  POST_ID,
  POST_REQUEST,
  botReply,
  hostClientLocating,
  memberPost,
  scriptedSession,
} from "@/components/bots/__tests__/bot-turn-test-support";
import { MountedChannel } from "@/components/bots/__tests__/bot-turn-channel-harness";
import { LONG_PRESS_MS } from "@/hooks/ui/use-long-press";
import type { HostRpcRegistry } from "@/lib/host";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";

const mocks = vi.hoisted(() => ({
  client: null as HostRequester<HostRpcRegistry> | null,
  sessions: {} as Record<string, ChatSessionStoreHandle>,
  threadAnchors: null as BotThreadAnchors | null,
  threads: [] as BotThreadSummary[],
  /** How the host answers a cold read of a channel row. */
  locate: { status: "waiting" } as
    | { readonly status: "waiting" }
    | { readonly status: "missing" },
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
  useBotActivity: () => null,
}));
vi.mock("@/components/chat/chat-messages", async () => {
  const { ChatExpansionTestProviders: Providers } =
    await import("@/components/chat/__tests__/chat-expansion-test-providers");
  const { ChatMessage } = await import("@/components/chat/chat-message");
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
});

function rowOf(messageId: string): HTMLElement {
  const holder = document.querySelector(`[data-row-id="${messageId}"]`);
  if (!(holder instanceof HTMLElement)) throw new Error(`no row ${messageId}`);
  return holder;
}

function replyInThreadOn(messageId: string): HTMLElement | null {
  return within(rowOf(messageId)).queryByRole("button", {
    name: "Reply in thread",
  });
}

const EVERY_ROW = [POST_ID, ANSWER_ID, NOTICE_ID, SURFACE_ROW_ID];

describe("Reply in thread on every row of a bot's channel", () => {
  it("is offered on a member's post, the bot's answer, a plain announcement and a surface card, and opens the plain announcement's own thread", async () => {
    const user = userEvent.setup();
    mocks.threadAnchors = anchorsNaming(["answer", "message"]);
    render(<MountedChannel />);

    for (const messageId of EVERY_ROW) {
      expect(replyInThreadOn(messageId), messageId).not.toBeNull();
    }

    const action = replyInThreadOn(NOTICE_ID);
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

    expect(replyInThreadOn(POST_ID)).not.toBeNull();
    expect(replyInThreadOn(ANSWER_ID)).not.toBeNull();
    expect(replyInThreadOn(NOTICE_ID)).toBeNull();
    expect(replyInThreadOn(SURFACE_ROW_ID)).toBeNull();
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

      const choice = await screen.findByTestId(
        "bot-reply-sheet-reply-in-thread",
      );
      expect(choice.textContent).toBe("Reply in thread");
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

  const NOTICE_THREAD: BotThreadSummary = {
    threadId: "thread-notice",
    conversationId: CHANNEL_ID,
    sessionChatId: "session-notice",
    anchor: {
      messageId: NOTICE_ID,
      requestId: "req-under-notice",
      senderUserId: null,
      sentAt: 3_000,
      resolvedAt: null,
    },
    replyCount: 1,
    lastReplyAt: 5_000,
    openRequestCount: 1,
    costUsd: null,
  };

  async function sendEnabledAfterTyping(): Promise<boolean> {
    const user = userEvent.setup();
    const panel = screen.getByTestId("bot-thread-panel");
    await user.type(
      within(panel).getByTestId("bot-thread-composer-input"),
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
  ])("takes no send under %s", async (_label, epoch, kinds) => {
    mocks.threads = [NOTICE_THREAD];
    mocks.threadAnchors = { hostId: BOUND_HOST_ID, epoch, kinds: [...kinds] };
    useBotOpenThreadStore.getState().setRail(BOT_ID, BY_ANCHOR);
    render(<MountedChannel />);

    expect(await sendEnabledAfterTyping()).toBe(false);
  });

  it("takes a send while the binding names the row among the rows a thread roots on", async () => {
    mocks.threads = [NOTICE_THREAD];
    mocks.threadAnchors = anchorsNaming(["answer", "message"]);
    useBotOpenThreadStore.getState().setRail(BOT_ID, BY_ANCHOR);
    render(<MountedChannel />);

    expect(await sendEnabledAfterTyping()).toBe(true);
  });

  it.each([
    ["only the rows an older host roots threads on", BOUND_EPOCH, ["answer"]],
    ["another epoch of the binding", BOUND_EPOCH - 1, ["answer", "message"]],
    ["every row of the bot", BOUND_EPOCH, ["answer", "message"]],
  ])(
    "takes no send while its row cannot be read, under a binding naming %s",
    async (_label, epoch, kinds) => {
      // The anchor is not in the channel the session holds, and the host's
      // read of it fails.
      mocks.locate = { status: "missing" };
      mocks.threads = [
        {
          ...NOTICE_THREAD,
          anchor:
            NOTICE_THREAD.anchor === null
              ? null
              : { ...NOTICE_THREAD.anchor, messageId: "notice-cold" },
        },
      ];
      mocks.threadAnchors = { hostId: BOUND_HOST_ID, epoch, kinds: [...kinds] };
      useBotOpenThreadStore
        .getState()
        .setRail(BOT_ID, { ...BY_ANCHOR, anchorMessageId: "notice-cold" });
      render(<MountedChannel />);

      expect(await sendEnabledAfterTyping()).toBe(false);
    },
  );
});
