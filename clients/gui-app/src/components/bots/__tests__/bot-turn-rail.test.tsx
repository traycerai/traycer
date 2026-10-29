/**
 * A reply's receipt and the rail beside a bot's channel (Tracy Bots T86),
 * through the REAL `BotChannelView`, `BotThreadPanel`, `BotTurnPanel` and
 * transcript: the receipts come from a real `bot.turn.locate` read over a host
 * client whose messenger answers it, the turn is read from the session chat
 * that ran it, and the rail's one slot is the real open-thread store. Only the
 * virtualised message list, the chat session registry (scripted sessions by
 * chat id) and the channel's neighbouring reads are replaced.
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
import { assistantRowId } from "@traycer/protocol/persistence/chat-transcript/row-projection";
import {
  ANSWER_PROSE,
  BACKGROUND_COMMAND,
  BOT_ID,
  CHANNEL_ID,
  CHANNEL_REPLY_TURN,
  COST_USD,
  ENDED_AT,
  POST_FIRST_LINE,
  REPLY_ID,
  REPLY_PROMPT_ID,
  REPLY_TURN_ID,
  STARTED_AT,
  SENT_MESSAGE,
  SUBAGENT_NAME,
  SUMMARY,
  THREAD_ID,
  THREAD_OPEN,
  THREAD_TURN_ID,
  TOOK,
  botReply,
  buildScene,
  hostClientLocating,
  promotedSessionTurn,
  sessionPrompt,
  sessionTurn,
  turnsAskedFor,
  type Scene,
} from "@/components/bots/__tests__/bot-turn-test-support";
import { MountedChannel } from "@/components/bots/__tests__/bot-turn-channel-harness";
import { LONG_PRESS_MS } from "@/hooks/ui/use-long-press";
import type { HostRpcRegistry } from "@/lib/host";
import { pickElapsedVerb } from "@/lib/chat/turn-footer-format";
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
// The send card's delivery line reads the host directory; the suite has no
// host runtime.
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
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

/** What the host knows of the bot's turns; the locate read answers from it. */
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

function turnRail(): HTMLElement {
  return screen.getByRole("region", { name: "How Release Bot answered" });
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

describe("How the bot answered, in the rail", () => {
  it("opens from a channel receipt with the post it answered, the turn's summary, how long it worked, the model and cost, its activity and the session it ran in", async () => {
    const user = userEvent.setup();
    mountChannel(null);

    await user.click(await receiptIn(channelList()));

    const rail = turnRail();
    expect(within(rail).getByRole("heading").textContent).toBe(
      "How Release Bot answered",
    );
    expect(within(rail).getByTestId("bot-turn-question").textContent).toBe(
      `Answering "${POST_FIRST_LINE}"`,
    );
    expect(within(rail).getByTestId("bot-turn-summary").textContent).toBe(
      SUMMARY,
    );
    const verb = pickElapsedVerb(assistantRowId(REPLY_TURN_ID));
    expect(within(rail).getByTestId("bot-turn-meta").textContent).toBe(
      `${verb} for ${TOOK}Claude Code · Claude Sonnet 4$0.0123`,
    );
    expect(within(rail).getByTestId("bot-turn-activity").textContent).toBe(
      SUMMARY,
    );
    expect(within(rail).getByTestId("bot-turn-session").textContent).toBe(
      "Trunk session",
    );
    expect(within(rail).queryByTestId("bot-turn-back")).toBeNull();
  });

  it("closes with the close button, leaving nothing in the rail", async () => {
    const user = userEvent.setup();
    mountChannel(null);
    await user.click(await receiptIn(channelList()));

    await user.click(within(turnRail()).getByRole("button", { name: "Close" }));

    expect(screen.queryByTestId("bot-turn-pane")).toBeNull();
    expect(useBotOpenThreadStore.getState().byBotId).toEqual({});
  });

  it("takes the open thread's place from a channel receipt, naming the thread by its post in the header, and the back button brings the thread back on the same list", async () => {
    const user = userEvent.setup();
    mountChannel(THREAD_OPEN);
    await receiptIn(threadList());
    expect(screen.getByTestId("bot-thread-pane")).toBeTruthy();

    await user.click(await receiptIn(channelList()));

    expect(screen.queryByTestId("bot-thread-pane")).toBeNull();
    const rail = turnRail();
    expect(within(rail).getByTestId("bot-turn-crumb").textContent).toBe(
      `Thread · ${POST_FIRST_LINE}`,
    );
    await user.click(
      within(rail).getByRole("button", { name: "Back to the thread" }),
    );

    expect(screen.queryByTestId("bot-turn-pane")).toBeNull();
    expect(screen.getByTestId("bot-thread-pane")).toBeTruthy();
    // The thread's replies remount on the instance whose scroll the list kept.
    expect(threadList().getAttribute("data-instance-id")).toBe(
      `bot-thread:${THREAD_ID}`,
    );
    expect(useBotOpenThreadStore.getState().byBotId[BOT_ID]).toEqual({
      kind: "thread",
      ...THREAD_OPEN,
    });
  });

  it("brings the thread back from its name in the header as well", async () => {
    const user = userEvent.setup();
    mountChannel(THREAD_OPEN);
    await user.click(await receiptIn(channelList()));

    await user.click(within(turnRail()).getByTestId("bot-turn-crumb"));

    expect(screen.getByTestId("bot-thread-pane")).toBeTruthy();
    expect(screen.queryByTestId("bot-turn-pane")).toBeNull();
  });

  it("keeps the thread the first turn displaced when another channel receipt is opened over it", async () => {
    const user = userEvent.setup();
    scene.channel.setState({
      messages: [
        ...scene.channel.getState().messages,
        botReply({
          messageId: "reply-2",
          text: "The nightly is queued.",
          timestamp: 2_500,
        }),
      ],
    });
    scene.knownTurns = [
      ...scene.knownTurns,
      {
        ...CHANNEL_REPLY_TURN,
        turnIds: ["turn-reply-2"],
        messageIds: ["reply-2"],
      },
    ];
    mountChannel(THREAD_OPEN);
    await waitFor(() => {
      expect(
        within(channelList()).getAllByTestId("bot-turn-receipt"),
      ).toHaveLength(2);
    });
    await user.click(
      within(channelList()).getAllByTestId("bot-turn-receipt")[0],
    );

    await user.click(
      within(channelList()).getAllByTestId("bot-turn-receipt")[1],
    );

    expect(turnRail().getAttribute("data-turn-id")).toBe("turn-reply-2");
    await user.click(
      within(turnRail()).getByRole("button", { name: "Back to the thread" }),
    );
    expect(screen.getByTestId("bot-thread-pane")).toBeTruthy();
  });

  it("opens from a receipt inside a thread with the thread's session, and goes back to that thread", async () => {
    const user = userEvent.setup();
    mountChannel(THREAD_OPEN);

    await user.click(await receiptIn(threadList()));

    const rail = turnRail();
    expect(rail.getAttribute("data-turn-id")).toBe(THREAD_TURN_ID);
    expect(within(rail).getByTestId("bot-turn-session").textContent).toBe(
      "Thread session",
    );
    expect(within(rail).getByTestId("bot-turn-question").textContent).toBe(
      `Answering "${POST_FIRST_LINE}"`,
    );
    await user.click(
      within(rail).getByRole("button", { name: "Back to the thread" }),
    );
    expect(screen.getByTestId("bot-thread-pane")).toBeTruthy();
    expect(screen.queryByTestId("bot-turn-pane")).toBeNull();
  });
});

describe("a long press on a bot's reply on a touch screen", () => {
  it("offers how the bot answered in a sheet whose choice opens the rail, with the hover receipt not shown", async () => {
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

    expect(turnRail().getAttribute("data-turn-id")).toBe(REPLY_TURN_ID);
  });
});

describe("the rail's turn, as the session ran it", () => {
  // A launch's turn is first known by a provisional id; the provider then
  // names its rows with its own. The host lists both on the turn.
  it("draws the rows a turn ran under its provider's id when the receipt's turn was found by its launch id, not a spinner", async () => {
    const user = userEvent.setup();
    scene.knownTurns = [
      { ...CHANNEL_REPLY_TURN, turnIds: ["turn-launch", "turn-provider"] },
    ];
    scene.trunk.setState({
      messages: [
        sessionPrompt(REPLY_PROMPT_ID, 90_000),
        sessionTurn({
          messageId: "turn-provider-record",
          turnId: "turn-provider",
          startedAt: STARTED_AT,
          endedAt: ENDED_AT,
          costUsd: COST_USD,
        }),
      ],
    });
    mountChannel(null);

    await user.click(await receiptIn(channelList()));

    const rail = turnRail();
    expect(rail.getAttribute("data-turn-id")).toBe("turn-launch");
    expect(within(rail).getByTestId("bot-turn-activity").textContent).toBe(
      SUMMARY,
    );
    expect(within(rail).getByTestId("bot-turn-meta").textContent).toContain(
      "Claude Code · Claude Sonnet 4$0.0123",
    );
    expect(within(rail).queryByTestId("bot-turn-loading")).toBeNull();
    expect(within(rail).queryByTestId("bot-turn-not-found")).toBeNull();
  });

  it("opened while the turn runs, keeps reading it from the host and settles into its summary and the duration it took when the bot's activity says it ended", async () => {
    const user = userEvent.setup();
    scene.knownTurns = [
      {
        ...CHANNEL_REPLY_TURN,
        startedAt: Date.now() - 65_000,
        endedAt: null,
        summary: null,
      },
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
    await user.click(await receiptIn(channelList()));
    expect(within(turnRail()).getByTestId("bot-turn-meta").textContent).toMatch(
      /^Working for 1m \d+s/,
    );
    expect(within(turnRail()).queryByTestId("bot-turn-summary")).toBeNull();

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
        within(turnRail()).getByTestId("bot-turn-summary").textContent,
      ).toBe(SUMMARY);
    });
    const meta = within(turnRail()).getByTestId("bot-turn-meta").textContent;
    expect(meta).toContain(
      `${pickElapsedVerb(assistantRowId(REPLY_TURN_ID))} for ${TOOK}`,
    );
    expect(meta).not.toContain("Working for");
  });

  it("draws the subagent, the background command and the message to another agent a turn lifted out of its activity, naming the receiver without a link, and leaves the prose of its answer to the channel", async () => {
    const user = userEvent.setup();
    scene.trunk.setState({
      messages: [
        sessionPrompt(REPLY_PROMPT_ID, 90_000),
        promotedSessionTurn({
          messageId: "turn-reply-record",
          turnId: REPLY_TURN_ID,
          startedAt: STARTED_AT,
          endedAt: ENDED_AT,
          costUsd: COST_USD,
        }),
      ],
    });
    mountChannel(null);

    await user.click(await receiptIn(channelList()));

    const activity = within(turnRail()).getByTestId("bot-turn-activity");
    expect(activity.textContent).toContain(SUBAGENT_NAME);
    expect(activity.textContent).toContain(BACKGROUND_COMMAND);
    // No open epic to resolve or open the receiver in: its id, as text.
    expect(activity.textContent).toContain("agent-re...");
    expect(activity.textContent).toContain(SENT_MESSAGE);
    expect(activity.querySelector('span[role="button"]')).toBeNull();
    expect(activity.textContent).not.toContain(ANSWER_PROSE);
  });

  it("says an ended turn's steps are no longer in its session once the session has loaded without any of its rows, instead of spinning", async () => {
    const user = userEvent.setup();
    scene.trunk.setState({
      messages: [
        sessionPrompt(REPLY_PROMPT_ID, 90_000),
        sessionTurn({
          messageId: "turn-other-record",
          turnId: "turn-other",
          startedAt: STARTED_AT,
          endedAt: ENDED_AT,
          costUsd: COST_USD,
        }),
      ],
    });
    mountChannel(null);

    await user.click(await receiptIn(channelList()));

    const rail = turnRail();
    expect(within(rail).getByTestId("bot-turn-not-found").textContent).toBe(
      "This answer's steps are no longer in its session.",
    );
    expect(within(rail).queryByTestId("bot-turn-loading")).toBeNull();
    expect(within(rail).queryByTestId("bot-turn-activity")).toBeNull();
  });
});
