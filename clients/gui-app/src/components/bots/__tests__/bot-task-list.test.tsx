/**
 * A bot's task list in the bot's own view (Tracy Bots T82, T86): where each
 * task came from, as the Activity page draws it. "for <post>" names the
 * channel post the task was set up for and "from <post>" the thread that set
 * it up; each opens its thread beside the channel. The real list runs over a
 * channel session that holds the rows a post is read from, and a locate-row
 * read that fetches one the channel has not loaded; only those, the task
 * titles and navigation are replaced.
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore, type StoreApi } from "zustand";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotTaskEntry } from "@traycer/protocol/host/bot/schemas";
import { conversationRequestMessageId } from "@traycer/protocol/persistence/epic/messages";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type {
  ChatSessionState,
  ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { emptyTranscriptWindow } from "@/stores/chats/transcript-window";

const mocks = vi.hoisted(() => {
  const botRows: Record<
    string,
    {
      readonly announcement?: { kind: "question"; link: null };
      readonly repliesTo?: string;
    }
  > = {};
  return {
    openPost: vi.fn<(open: unknown) => void>(),
    state: {
      /** What a bot row of the channel is, by message id. */
      botRows,
      /** Every row the list asked the host to locate, by message id. */
      located: new Set<string>(),
      ordinals: new Map<string, number>(),
      /** Each hold the channel's session took on a located row, and each release. */
      holds: [] as string[],
      releases: [] as string[],
      channelHandle: null as ChatSessionStoreHandle | null,
    },
  };
});

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/lib/tab-navigation", () => ({ navigateToTabIntent: vi.fn() }));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => ({ stub: "tab-host-client" }),
}));
vi.mock("@/hooks/epic/use-epic-get-task-contexts-query", () => ({
  useEpicGetTaskContexts: () => ({ tasksById: new Map() }),
}));
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  // Only the channel has a session here.
  useChatSessionHandleForContainer: (
    _botId: string,
    chatId: string,
  ): ChatSessionStoreHandle | null =>
    chatId === CHANNEL_ID ? channelHandle() : null,
}));
// No check-in's turn is located here: the suite stands up no host to ask.
vi.mock("@/hooks/bots/use-bot-turn-locate-query", () => ({
  useBotTurnLocateQuery: () => ({ data: undefined }),
}));
vi.mock("@/hooks/chats/use-chat-locate-row", () => ({
  useChatLocateRowAnswer: (args: {
    target: { kind: string; messageId: string } | null;
  }) => {
    if (args.target === null) return { status: "waiting" };
    const { messageId } = args.target;
    mocks.state.located.add(messageId);
    const ordinal =
      mocks.state.ordinals.get(messageId) ?? mocks.state.ordinals.size + 1;
    mocks.state.ordinals.set(messageId, ordinal);
    return { status: "found", ordinal };
  },
}));

import { BotTaskList } from "@/components/bots/bot-task-list";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HOST_ID = "host-bound";
const CHANNEL_ID = "conversation-channel";

type ChannelStore = StoreApi<
  Pick<
    ChatSessionState,
    "messages" | "transcriptWindow" | "holdTranscriptOrdinal"
  >
>;

function createChannelStore(messages: Message[]): ChannelStore {
  return createStore<
    Pick<
      ChatSessionState,
      "messages" | "transcriptWindow" | "holdTranscriptOrdinal"
    >
  >(() => ({
    transcriptWindow: emptyTranscriptWindow(),
    holdTranscriptOrdinal: (ordinal: number) => {
      const messageId =
        [...mocks.state.ordinals].find(([, held]) => held === ordinal)?.[0] ??
        String(ordinal);
      mocks.state.holds.push(messageId);
      return () => {
        mocks.state.releases.push(messageId);
      };
    },
    messages,
  }));
}

let channelStore: ChannelStore | null = null;

function channelHandle(): ChatSessionStoreHandle {
  if (mocks.state.channelHandle === null) {
    channelStore = createChannelStore([]);
    mocks.state.channelHandle = {
      store: channelStore,
    } as ChatSessionStoreHandle;
  }
  return mocks.state.channelHandle;
}

/** The channel's row of `messageId`: a member's post for a request's row id, the bot's row otherwise. */
function channelRow(messageId: string, text: string): Message {
  const textBlock = {
    type: "doc" as const,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
  if (messageId.startsWith(conversationRequestMessageId(""))) {
    return {
      role: "user",
      messageId,
      sender: { type: "user", userId: "user-1" },
      message: { kind: "user", content: textBlock, browserAnnotations: [] },
      timestamp: 1_000,
      sessionAnchor: null,
      conversationRequest: {
        requestId: messageId,
        resolvedAt: null,
        resolvedByMessageId: null,
      },
    };
  }
  return {
    ...mocks.state.botRows[messageId],
    role: "assistant",
    messageId,
    sender: {
      type: "agent",
      harnessId: "claude",
      agentId: "claude-sonnet-4",
      displayName: "Claude Sonnet 4",
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks: [
      {
        type: "text",
        blockId: `${messageId}:text`,
        status: "completed",
        timestamp: 1_000,
        text,
        providerNotice: null,
      },
    ],
    startedAt: 1_000,
    timestamp: 1_000,
    turnId: null,
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: [],
  };
}

/** Puts the channel's loaded rows, as the session holds them. */
function loadChannel(rows: ReadonlyArray<readonly [string, string]>): void {
  channelHandle();
  act(() => {
    channelStore?.setState({
      messages: rows.map(([id, text]) => channelRow(id, text)),
    });
  });
}

function threadOn(
  threadId: string,
  anchorMessageId: string,
  anchorRequestId: string,
  senderUserId: string | null,
): BotThreadSummary {
  return {
    threadId,
    conversationId: CHANNEL_ID,
    sessionChatId: `session-${threadId}`,
    anchor: {
      messageId: anchorMessageId,
      requestId: anchorRequestId,
      senderUserId,
      sentAt: 1_000,
      resolvedAt: null,
    },
    replyCount: 2,
    lastReplyAt: 2_000,
    openRequestCount: 0,
    costUsd: null,
  };
}

function task(taskId: string, overrides: Partial<BotTaskEntry>): BotTaskEntry {
  return {
    taskId,
    cadence: { kind: "on-completion" },
    lastCheckinAt: null,
    lastCheckin: null,
    nextAt: null,
    state: "tracking",
    endedReason: null,
    createdByUserId: null,
    spun: true,
    label: null,
    originRequestId: null,
    createdByChatId: null,
    checkins: null,
    pause: null,
    stop: null,
    runRequest: null,
    ...overrides,
  };
}

function mount(
  tasks: ReadonlyArray<BotTaskEntry>,
  threads: ReadonlyArray<BotThreadSummary> | null,
): void {
  render(
    <BotTaskList
      botId={BOT_ID}
      hostId={HOST_ID}
      tasks={tasks}
      threads={threads}
      place={{
        kind: "bot",
        channelId: CHANNEL_ID,
        onOpenPost: mocks.openPost,
        onOpenTurn: vi.fn(),
        boundHere: false,
        nameOf: (userId) => userId,
      }}
    />,
  );
}

function taskRow(taskId: string): HTMLElement {
  const row = screen
    .getAllByTestId("bot-task-row")
    .find((element) => element.getAttribute("data-task-id") === taskId);
  if (row === undefined) throw new Error(`no row for ${taskId}`);
  return row;
}

const THREAD_POST = conversationRequestMessageId("req-thread-a");
const DIRECT_POST = conversationRequestMessageId("req-direct");
const THREAD_A = threadOn("thread-a", THREAD_POST, "req-thread-a", "user-1");
const ANSWER_THREAD = threadOn("thread-answer", "answer-1", "req-opener", null);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.botRows = {};
  mocks.state.located.clear();
  mocks.state.ordinals.clear();
  mocks.state.holds = [];
  mocks.state.releases = [];
  mocks.state.channelHandle = null;
  channelStore = null;
});

afterEach(() => {
  cleanup();
});

describe("<BotTaskList /> in the bot's view: where a task came from", () => {
  it("names the post a task was set up for and opens its thread, names the thread a follow-up came from, and names no thread for a trunk task", async () => {
    const user = userEvent.setup();
    loadChannel([
      [THREAD_POST, "Please review the release\nIt ships Friday."],
      [DIRECT_POST, "Check the nightly run"],
    ]);
    mount(
      [
        task("task-watch", {
          originRequestId: "req-thread-a",
          createdByChatId: "thread-a",
        }),
        task("task-fix", {
          originRequestId: "req-followup",
          createdByChatId: "thread-a",
        }),
        task("task-nightly", { originRequestId: "req-direct" }),
      ],
      [THREAD_A],
    );

    // The post the task came from opens its thread, which the row then does
    // not name a second time.
    const watch = taskRow("task-watch");
    expect(within(watch).getByTestId("bot-task-request").textContent).toBe(
      "for Please review the release",
    );
    expect(within(watch).queryByTestId("bot-task-thread")).toBeNull();
    await user.click(within(watch).getByTestId("bot-task-request"));
    expect(mocks.openPost).toHaveBeenLastCalledWith({
      anchorMessageId: THREAD_POST,
      announcement: false,
      answer: false,
      sent: null,
    });

    // A task set up for a message inside a thread: the thread it came from,
    // opening that thread.
    const fix = taskRow("task-fix");
    expect(within(fix).queryByTestId("bot-task-request")).toBeNull();
    expect(within(fix).getByTestId("bot-task-thread").textContent).toBe(
      "from Please review the release",
    );
    await user.click(within(fix).getByTestId("bot-task-thread"));
    expect(mocks.openPost).toHaveBeenLastCalledWith({
      anchorMessageId: THREAD_POST,
      announcement: false,
      answer: false,
      sent: null,
    });

    // The trunk's task, set up for a post the bot answered on the channel:
    // no thread line, and the post opens the box that starts one.
    const nightly = taskRow("task-nightly");
    expect(within(nightly).queryByTestId("bot-task-thread")).toBeNull();
    expect(within(nightly).getByTestId("bot-task-request").textContent).toBe(
      "for Check the nightly run",
    );
    await user.click(within(nightly).getByTestId("bot-task-request"));
    expect(mocks.openPost).toHaveBeenLastCalledWith({
      anchorMessageId: DIRECT_POST,
      announcement: true,
      answer: false,
      sent: null,
    });
  });

  it("names and opens the thread that a reply under the bot's question opened, as the question's own row opens it", async () => {
    const user = userEvent.setup();
    mocks.state.botRows["question-1"] = {
      announcement: { kind: "question", link: null },
    };
    loadChannel([["question-1", "Which release should I watch?"]]);
    mount(
      [
        task("task-watch", {
          originRequestId: "req-opener",
          createdByChatId: "thread-q",
        }),
      ],
      [threadOn("thread-q", "question-1", "req-opener", null)],
    );

    const row = taskRow("task-watch");
    expect(within(row).queryByTestId("bot-task-request")).toBeNull();
    await user.click(within(row).getByTestId("bot-task-thread"));
    expect(mocks.openPost).toHaveBeenLastCalledWith({
      anchorMessageId: "question-1",
      announcement: true,
      answer: false,
      sent: null,
    });
  });

  it("opens a thread rooted on the bot's direct reply as an answer's thread", async () => {
    const user = userEvent.setup();
    mocks.state.botRows["answer-1"] = {
      repliesTo: conversationRequestMessageId("req-direct"),
    };
    loadChannel([["answer-1", "The nightly run passed."]]);
    mount(
      [
        task("task-watch", {
          originRequestId: "req-opener",
          createdByChatId: "thread-answer",
        }),
      ],
      [ANSWER_THREAD],
    );

    const from = within(taskRow("task-watch")).getByTestId("bot-task-thread");
    expect(from.textContent).toBe("from The nightly run passed.");
    await user.click(from);
    expect(mocks.openPost).toHaveBeenLastCalledWith({
      anchorMessageId: "answer-1",
      announcement: true,
      answer: true,
      sent: null,
    });
  });

  it("fetches a thread's post the channel has not loaded, and opens nothing until it is there to say how its thread opens", async () => {
    const user = userEvent.setup();
    mocks.state.botRows["answer-1"] = {
      repliesTo: conversationRequestMessageId("req-direct"),
    };
    mount(
      [
        task("task-watch", {
          originRequestId: "req-opener",
          createdByChatId: "thread-answer",
        }),
      ],
      [ANSWER_THREAD],
    );

    const cold = within(taskRow("task-watch")).getByTestId("bot-task-thread");
    expect(cold.textContent).toBe("from a thread");
    expect(cold.tagName).toBe("SPAN");
    expect(mocks.state.located.has("answer-1")).toBe(true);

    // The located row lands in the channel's session.
    loadChannel([["answer-1", "The nightly run passed."]]);
    await user.click(
      within(taskRow("task-watch")).getByTestId("bot-task-thread"),
    );
    expect(mocks.openPost).toHaveBeenLastCalledWith({
      anchorMessageId: "answer-1",
      announcement: true,
      answer: true,
      sent: null,
    });
  });

  it("keeps the thread's line while the post the task came from is not loaded, and fetches that post", () => {
    mount(
      [
        task("task-watch", {
          originRequestId: "req-thread-a",
          createdByChatId: "thread-a",
        }),
      ],
      [THREAD_A],
    );

    const row = taskRow("task-watch");
    expect(within(row).queryByTestId("bot-task-request")).toBeNull();
    expect(within(row).getByTestId("bot-task-thread").textContent).toBe(
      "from a thread",
    );
    expect(mocks.state.located.has(THREAD_POST)).toBe(true);
  });

  it("holds a cold post that is both the task's request and its thread's post with one reader, as its line turns from the thread to the post and back", () => {
    mount(
      [
        task("task-watch", {
          originRequestId: "req-thread-a",
          createdByChatId: "thread-a",
        }),
      ],
      [THREAD_A],
    );
    const row = (): HTMLElement => taskRow("task-watch");
    expect(within(row()).getByTestId("bot-task-thread").textContent).toBe(
      "from a thread",
    );
    const held = mocks.state.holds.filter((id) => id === THREAD_POST).length;
    expect(held).toBeGreaterThan(0);

    // The post lands: its line names it, and the thread's line goes.
    loadChannel([[THREAD_POST, "Please review the release"]]);
    expect(within(row()).getByTestId("bot-task-request").textContent).toBe(
      "for Please review the release",
    );
    expect(within(row()).queryByTestId("bot-task-thread")).toBeNull();

    // The row leaves the loaded window; the line goes back to the thread's.
    loadChannel([]);
    expect(within(row()).getByTestId("bot-task-thread").textContent).toBe(
      "from a thread",
    );

    // Neither change let the post go or took it again.
    expect(mocks.state.releases).not.toContain(THREAD_POST);
    expect(mocks.state.holds.filter((id) => id === THREAD_POST)).toHaveLength(
      held,
    );
  });

  // Accepted residual: an automation a thread of another bot set up on this
  // bot is listed here, on the bot that runs it. This bot's lists cannot name
  // or open the other bot's thread.
  it("says a task came from another bot's thread, with nothing to open, when no thread of this bot set it up", () => {
    mount(
      [
        task("task-handoff", {
          originRequestId: "req-elsewhere",
          createdByChatId: "thread-of-another-bot",
        }),
      ],
      [THREAD_A],
    );

    const row = taskRow("task-handoff");
    expect(within(row).queryByTestId("bot-task-request")).toBeNull();
    const from = within(row).getByTestId("bot-task-thread");
    expect(from.textContent).toBe("from another bot's thread");
    expect(from.tagName).toBe("SPAN");
  });

  it("says a thread set a task up, without naming which, while the thread list is not read", () => {
    mount(
      [
        task("task-watch", {
          originRequestId: "req-thread-a",
          createdByChatId: "thread-a",
        }),
      ],
      null,
    );

    const from = within(taskRow("task-watch")).getByTestId("bot-task-thread");
    expect(from.textContent).toBe("from a thread");
    expect(from.tagName).toBe("SPAN");
  });
});
