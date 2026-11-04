/**
 * A reply's receipt beside a bot's channel (Tracy Bots T86), and the session
 * it opens, through the REAL `BotChannelView`, `BotThreadPanel` and
 * transcript: the receipts come from a real `bot.turn.locate` read over a
 * host client whose messenger answers it, and the rail's one slot is the real
 * open-thread store. A receipt, the reply sheet's choice or a thread's
 * "Thread session" asks the tab to open the session in the channel's place;
 * what it asked is recorded by the harness. Only the virtualised message
 * list, the chat session registry (scripted sessions by chat id) and the
 * channel's neighbouring reads are replaced.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { create } from "zustand";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type {
  BotThreadSummary,
  BotTurnLocateRequest,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotActivity } from "@traycer/protocol/host/bot/schemas";
import {
  ANNOUNCEMENT_ID,
  ANNOUNCEMENT_PROMPT_ID,
  ANNOUNCEMENT_THREAD_ID,
  ANNOUNCEMENT_TURN,
  BOT_ID,
  CHANNEL_ID,
  CHANNEL_REPLY_TURN,
  HOST_ANNOUNCEMENT_ID,
  QUESTION_ID,
  QUESTION_TURN,
  REPLY_ID,
  REPLY_PROMPT_ID,
  STARTED_AT,
  SUMMARY,
  THREAD_ID,
  THREAD_OPEN,
  THREAD_PROMPT_ID,
  THREAD_REPLY_ID,
  THREAD_SESSION_ID,
  TOOK,
  TRUNK_ID,
  announcementThread,
  botAnnouncement,
  botQuestion,
  botReply,
  buildScene,
  hostClientLocating,
  openedSessions,
  scriptedSession,
  turnsAskedFor,
  type Scene,
} from "@/components/bots/__tests__/bot-turn-test-support";
import { MountedChannel } from "@/components/bots/__tests__/bot-turn-channel-harness";
import { LONG_PRESS_MS } from "@/hooks/ui/use-long-press";
import type { HostRpcRegistry } from "@/lib/host";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";

const mocks = vi.hoisted(() => ({
  client: null as HostRequester<HostRpcRegistry> | null,
  sessions: {} as Record<string, ChatSessionStoreHandle>,
  threads: [] as BotThreadSummary[],
  /** Whether the tab's host negotiated `bot.turn.locate`. */
  locateSupported: true,
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
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    method === "bot.turn.locate" ? mocks.locateSupported : true,
}));
vi.mock("@/components/epic-tabs/pane-visibility-context", () => ({
  usePaneVisible: () => true,
  usePaneFocused: () => true,
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
// The reply sheet re-asserts the app theme where it portals; the provider is
// not under test.
vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({ resolvedTheme: "light", themePreset: "neutral" }),
}));
vi.mock("@/hooks/bots/use-bot-activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/bots/use-bot-activity")>()),
  useBotActivity: () => activityStore((state) => state.activity),
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
            <ChatMessage
              key={message.id}
              message={message}
              actions={null}
              backgroundToolBlockIds={noBackgroundToolBlockIds}
              nextStepActions={null}
            />
          ))}
        </div>
      </Providers>
    ),
  };
});

/** What the bot is doing, as the scripted `useBotActivity` reads it. */
const activityStore = create<{ activity: BotActivity | null }>()(() => ({
  activity: null,
}));

import {
  useBotOpenThreadStore,
  type BotOpenThread,
} from "@/stores/bots/bot-open-thread-store";

/** Mounts the channel with `rail` open beside it, or nothing (`null`). */
function mountChannel(rail: BotOpenThread | null): void {
  if (rail !== null) {
    useBotOpenThreadStore
      .getState()
      .setRail(BOT_ID, { kind: "thread", ...rail });
  }
  render(<MountedChannel />);
}

let scene: Scene;
let asked: BotTurnLocateRequest[];

beforeEach(() => {
  asked = [];
  activityStore.setState({ activity: null });
  useBotOpenThreadStore.setState({ byBotId: {} });
  mocks.locateSupported = true;
  openedSessions.length = 0;
  scene = buildScene();
  mocks.sessions = scene.sessions;
  mocks.threads = scene.threads;
  mocks.client = hostClientLocating(
    (request) => turnsAskedFor(scene.knownTurns, request),
    asked,
  );
});

afterEach(() => {
  cleanup();
  mocks.sessions = {};
  mocks.client = null;
});

/** The list of rows one chat draws: the channel's, a thread's. */
function listOf(instanceId: string): HTMLElement {
  const list = document.querySelector(`[data-instance-id="${instanceId}"]`);
  if (!(list instanceof HTMLElement)) {
    throw new Error(`no list for ${instanceId}`);
  }
  return list;
}

function channelList(): HTMLElement {
  return listOf(`bot-channel:${BOT_ID}`);
}

function threadList(): HTMLElement {
  return listOf(`bot-thread:${THREAD_ID}`);
}

/** The receipt under the reply in `list`, once the host has named its turn. */
function receiptIn(list: HTMLElement): Promise<HTMLElement> {
  return within(list).findByTestId("bot-turn-receipt");
}

describe("the receipt under a bot's reply", () => {
  it("reads what the turn did and how long it took, from the turn the host names for the reply", async () => {
    mountChannel(null);

    const receipt = await receiptIn(channelList());

    expect(receipt.textContent).toBe(`${SUMMARY} · ${TOOK}`);
    expect(receipt.getAttribute("data-running")).toBe("false");
    expect(asked[0]).toMatchObject({ botId: BOT_ID, messageIds: [REPLY_ID] });
  });

  it("is shown at rest for a settled turn: found with no hover or focus, and carrying no class that hides it", async () => {
    mountChannel(null);

    const receipt = await receiptIn(channelList());

    const classes = receipt.className.split(" ");
    expect(classes).not.toContain("opacity-0");
    expect(classes).not.toContain("pointer-coarse:hidden");
  });

  it("says only how long it has run while the turn runs", async () => {
    scene.knownTurns = [
      {
        ...CHANNEL_REPLY_TURN,
        startedAt: Date.now() - 65_000,
        endedAt: null,
        summary: null,
      },
    ];
    mountChannel(null);

    const receipt = await receiptIn(channelList());

    expect(receipt.getAttribute("data-running")).toBe("true");
    expect(receipt.textContent).toMatch(/^1m \d+s$/);
  });

  it("settles into its summary and duration when the bot's activity says the turn ended", async () => {
    scene.knownTurns = [
      { ...CHANNEL_REPLY_TURN, endedAt: null, summary: null },
    ];
    activityStore.setState({
      activity: {
        trunk: {
          state: "replying",
          startedAt: STARTED_AT,
          step: null,
          requestId: null,
          reason: null,
        },
        threads: {},
      },
    });
    mountChannel(null);
    const receipt = await receiptIn(channelList());
    expect(receipt.getAttribute("data-running")).toBe("true");

    scene.knownTurns = [CHANNEL_REPLY_TURN];
    act(() => {
      activityStore.setState({
        activity: {
          trunk: {
            state: "idle",
            startedAt: null,
            step: null,
            requestId: null,
            reason: null,
          },
          threads: {},
        },
      });
    });

    await waitFor(() => {
      expect(
        within(channelList()).getByTestId("bot-turn-receipt").textContent,
      ).toBe(`${SUMMARY} · ${TOOK}`);
    });
  });

  it("is not drawn, and the host is not asked, on a host without bot.turn.locate", async () => {
    mocks.locateSupported = false;
    mountChannel(null);

    await within(channelList()).findByTestId("bot-reply-row");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(within(channelList()).queryByTestId("bot-turn-receipt")).toBeNull();
    expect(asked).toEqual([]);
  });

  it("is not drawn under a reply the host does not know a turn for, while another reply's is", async () => {
    scene.channel.setState({
      messages: [
        ...scene.channel.getState().messages,
        botReply({
          messageId: "reply-unknown",
          text: "A reply nobody recorded",
          timestamp: 2_500,
        }),
      ],
    });
    mountChannel(null);

    await receiptIn(channelList());

    const rows = within(channelList()).getAllByTestId("bot-reply-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).queryByTestId("bot-turn-receipt")).not.toBeNull();
    expect(within(rows[1]).queryByTestId("bot-turn-receipt")).toBeNull();
  });
});

describe("the receipt under the other rows a turn of the bot wrote", () => {
  it("is drawn at rest under an announcement a turn wrote, asked by the announcement's id", async () => {
    scene.knownTurns = [...scene.knownTurns, ANNOUNCEMENT_TURN];
    scene.channel.setState({
      messages: [
        ...scene.channel.getState().messages,
        botAnnouncement({
          messageId: ANNOUNCEMENT_ID,
          text: "Nightly triage now runs at 02:00",
          timestamp: 2_500,
        }),
      ],
    });
    mountChannel(null);

    const receipt = await within(
      within(channelList()).getByTestId("bot-announcement"),
    ).findByTestId("bot-turn-receipt");

    expect(receipt.textContent).toBe(`${SUMMARY} · ${TOOK}`);
    expect(receipt.className.split(" ")).not.toContain("opacity-0");
    expect(asked[0].messageIds).toContain(ANNOUNCEMENT_ID);
  });

  it("is drawn under a question the bot asked, which the turn wrote", async () => {
    scene.knownTurns = [...scene.knownTurns, QUESTION_TURN];
    scene.channel.setState({
      messages: [
        ...scene.channel.getState().messages,
        botQuestion({
          messageId: QUESTION_ID,
          timestamp: 2_500,
          item: {
            text: "Deploy now or after the train?",
            options: ["Now", "After the train"],
            allowFreeText: false,
            settlement: null,
          },
        }),
      ],
    });
    mountChannel(null);

    await within(channelList()).findByTestId("question-card");
    await waitFor(() => {
      expect(
        within(channelList()).getAllByTestId("bot-turn-receipt"),
      ).toHaveLength(2);
    });

    const card = within(channelList()).getByTestId("question-card");
    const row = card.closest('[data-testid="bot-reply-row"]');
    if (!(row instanceof HTMLElement)) throw new Error("no question row");
    expect(within(row).getByTestId("bot-turn-receipt").textContent).toBe(
      `${SUMMARY} · ${TOOK}`,
    );
  });

  it("is not drawn under an announcement the host posted itself, no turn having written it", async () => {
    scene.channel.setState({
      messages: [
        ...scene.channel.getState().messages,
        botAnnouncement({
          messageId: HOST_ANNOUNCEMENT_ID,
          text: "Release Bot was created",
          timestamp: 2_500,
        }),
      ],
    });
    mountChannel(null);

    const sibling = await receiptIn(channelList());
    expect(sibling.textContent).toBe(`${SUMMARY} · ${TOOK}`);

    const row = within(channelList()).getByTestId("bot-announcement");
    expect(within(row).queryByTestId("bot-turn-receipt")).toBeNull();
    expect(asked[0].messageIds).toContain(HOST_ANNOUNCEMENT_ID);
  });
});

describe("the receipt under the bot's own post a thread opens on", () => {
  /** The bot's announcement in the channel, with the turn that wrote it known to the host. */
  function announcementPosted(): void {
    scene.knownTurns = [...scene.knownTurns, ANNOUNCEMENT_TURN];
    scene.channel.setState({
      messages: [
        ...scene.channel.getState().messages,
        botAnnouncement({
          messageId: ANNOUNCEMENT_ID,
          text: "Nightly triage now runs at 02:00",
          timestamp: 2_500,
        }),
      ],
    });
  }

  const ANNOUNCEMENT_RAIL: BotOpenThread = {
    anchorMessageId: ANNOUNCEMENT_ID,
    announcement: true,
    anchorKind: "message",
    sent: null,
  };

  it("is drawn on the origin row of a thread whose post is the bot's announcement, and opens the turn landed on the announcement", async () => {
    const user = userEvent.setup();
    announcementPosted();
    mocks.threads = [...scene.threads, announcementThread()];
    mocks.sessions = {
      ...scene.sessions,
      [ANNOUNCEMENT_THREAD_ID]: scriptedSession(ANNOUNCEMENT_THREAD_ID, [])
        .handle,
    };
    mountChannel(ANNOUNCEMENT_RAIL);

    const receipt = await within(
      await screen.findByTestId("bot-thread-anchor"),
    ).findByTestId("bot-turn-receipt");
    expect(receipt.textContent).toBe(`${SUMMARY} · ${TOOK}`);
    expect(
      asked.some((request) => request.messageIds.includes(ANNOUNCEMENT_ID)),
    ).toBe(true);

    await user.click(receipt);

    expect(openedSessions).toEqual([
      {
        chatId: TRUNK_ID,
        threadId: null,
        messageId: ANNOUNCEMENT_PROMPT_ID,
        sendPostId: ANNOUNCEMENT_ID,
      },
    ]);
  });

  it("is drawn on the origin row before anyone has replied, while the thread list has no thread for the announcement", async () => {
    announcementPosted();
    mountChannel(ANNOUNCEMENT_RAIL);

    // Unopened: the box starts the thread.
    await screen.findByRole("textbox", { name: "Reply in a new thread" });
    const receipt = await within(
      await screen.findByTestId("bot-thread-anchor"),
    ).findByTestId("bot-turn-receipt");

    expect(receipt.textContent).toBe(`${SUMMARY} · ${TOOK}`);
  });
});

describe("a receipt opens its turn's session", () => {
  it("opens the trunk's session from a channel receipt, landed on the message that started the turn", async () => {
    const user = userEvent.setup();
    mountChannel(null);

    await user.click(await receiptIn(channelList()));

    expect(openedSessions).toEqual([
      {
        chatId: TRUNK_ID,
        threadId: null,
        messageId: REPLY_PROMPT_ID,
        sendPostId: REPLY_ID,
      },
    ]);
  });

  it("opens the thread's session from a receipt inside the thread, landed on its turn, leaving the thread in the rail", async () => {
    const user = userEvent.setup();
    mountChannel(THREAD_OPEN);

    await user.click(await receiptIn(threadList()));

    expect(openedSessions).toEqual([
      {
        chatId: THREAD_SESSION_ID,
        threadId: THREAD_ID,
        messageId: THREAD_PROMPT_ID,
        sendPostId: THREAD_REPLY_ID,
      },
    ]);
    expect(useBotOpenThreadStore.getState().byBotId[BOT_ID]).toEqual({
      kind: "thread",
      ...THREAD_OPEN,
    });
  });

  it("opens the thread's whole session, landed nowhere, from the thread panel's Thread session", async () => {
    const user = userEvent.setup();
    mountChannel(THREAD_OPEN);

    await user.click(
      await screen.findByRole("button", { name: "Thread session" }),
    );

    expect(openedSessions).toEqual([
      {
        chatId: THREAD_SESSION_ID,
        threadId: THREAD_ID,
        messageId: null,
        sendPostId: null,
      },
    ]);
  });
});

describe("a long press on a bot's reply on a touch screen", () => {
  it("offers how the bot answered in a sheet whose choice opens the turn's session", async () => {
    const user = userEvent.setup();
    mountChannel(null);
    await receiptIn(channelList());
    const row = within(channelList()).getByTestId("bot-reply-row");

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

    const choice = await screen.findByTestId("bot-reply-sheet-receipt");
    expect(choice.textContent).toBe(
      `How Release Bot answered · ${SUMMARY} · ${TOOK}`,
    );
    await user.click(choice);

    expect(openedSessions).toEqual([
      {
        chatId: TRUNK_ID,
        threadId: null,
        messageId: REPLY_PROMPT_ID,
        sendPostId: REPLY_ID,
      },
    ]);
  });
});
