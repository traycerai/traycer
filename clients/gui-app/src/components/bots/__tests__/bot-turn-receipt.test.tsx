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
  BOT_ID,
  CHANNEL_ID,
  CHANNEL_REPLY_TURN,
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
  botReply,
  buildScene,
  hostClientLocating,
  openedSessions,
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

  it("is revealed on hover or focus of a fine pointer and never on a coarse one, for a settled turn", async () => {
    mountChannel(null);

    const receipt = await receiptIn(channelList());

    const classes = receipt.className.split(" ");
    expect(classes).toContain("opacity-0");
    expect(classes).toContain("group-hover/message:opacity-100");
    expect(classes).toContain("focus-visible:opacity-100");
    expect(classes).toContain("pointer-coarse:hidden");
  });

  it("is always shown while the turn runs, saying only how long it has run", async () => {
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
    expect(receipt.className).not.toContain("opacity-0");
    expect(receipt.className).not.toContain("pointer-coarse:hidden");
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
  it("offers how the bot answered in a sheet whose choice opens the turn's session, with the hover receipt not shown", async () => {
    const user = userEvent.setup();
    mountChannel(null);
    const receipt = await receiptIn(channelList());
    expect(receipt.className.split(" ")).toContain("pointer-coarse:hidden");
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
