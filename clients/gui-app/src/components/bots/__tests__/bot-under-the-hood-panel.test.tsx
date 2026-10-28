/**
 * The bot's under-the-hood view (Tracy Bots, decision 43): what the bot and
 * its environment have cost, the threads it runs, and the transcript of its
 * trunk or of one thread's session. The real panel and the real cost query run
 * over a mocked thread listing (the bot's and its trunk's figures) and a
 * mocked `bot.thread.list` read per sibling bot bound to the tab's host (the
 * environment's); the transcript is a stub that exposes the chat it was handed.
 */
import { useState, type ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type {
  BotNotificationSubscription,
  BotTaskEntry,
} from "@traycer/protocol/host/bot/schemas";
import { conversationRequestMessageId } from "@traycer/protocol/persistence/epic/messages";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type {
  ChatSessionState,
  ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { useBotTabsStore } from "@/stores/bots/bot-tabs-store";
import type { BotOpenThread } from "@/stores/bots/bot-open-thread-store";
import { emptyTranscriptWindow } from "@/stores/chats/transcript-window";

interface ThreadListAnswer {
  readonly trunkCostUsd: number | null;
  readonly threads: ReadonlyArray<BotThreadSummary>;
}

const mocks = vi.hoisted(() => {
  const answers: Record<string, ThreadListAnswer> = {};
  const channelPosts: Record<string, string> = {};
  return {
    client: { stub: "tab-host-client" },
    refetchThreads: vi.fn<() => void>(),
    openPost: vi.fn<(open: BotOpenThread) => void>(),
    /** Every chat id the panel asked the session registry for. */
    sessionRequests: [] as string[],
    state: {
      /** Post text by message id: the channel's rows. */
      channelPosts,
      channelHandle: null as ChatSessionStoreHandle | null,
      connectable: { hostIds: [] as string[], resolved: true },
      usageSupported: true,
      answers,
      threads: [] as BotThreadSummary[],
      trunkCostUsd: null as number | null,
      threadListSupported: true,
      // `false`: the thread list has not answered (pending, or failed).
      threadListAnswered: true,
      threadListError: false,
      /** Task titles by task id, as the task-context read answers them. */
      taskTitles: {},
    },
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));
vi.mock("@/lib/tab-navigation", () => ({
  navigateToTabIntent: vi.fn(),
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.client,
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => mocks.state.threadListSupported,
}));
vi.mock("@/hooks/usage-analytics/use-usage-summary-support", () => ({
  useUsageSummarySupported: () => mocks.state.usageSupported,
}));
vi.mock("@/hooks/bots/use-bot-thread-list-query", () => ({
  useBotThreadListQuery: () => ({
    data: mocks.state.threadListAnswered
      ? {
          threads: mocks.state.threads,
          trunkCostUsd: mocks.state.trunkCostUsd,
        }
      : undefined,
    isError: mocks.state.threadListError,
    refetch: mocks.refetchThreads,
  }),
}));
vi.mock("@/hooks/epic/use-epic-get-task-contexts-query", () => ({
  useEpicGetTaskContexts: () => ({
    tasksById: new Map(
      Object.entries(mocks.state.taskTitles).map(([taskId, title]) => [
        taskId,
        { epic: { light: { title } } },
      ]),
    ),
  }),
}));
vi.mock("@/hooks/host/use-host-queries", () => ({
  useHostQueries: (args: {
    requests: ReadonlyArray<{ method: string; params: { botId: string } }>;
  }) =>
    args.requests.map((request) => {
      const botId = request.params.botId;
      return {
        data:
          request.method === "bot.thread.list" &&
          Object.hasOwn(mocks.state.answers, botId)
            ? mocks.state.answers[botId]
            : undefined,
      };
    }),
}));
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  // Only the channel has rows here (the threads' post text); the trunk's
  // session is never loaded, and every request is recorded.
  useChatSessionHandleForContainer: (
    _botId: string,
    chatId: string,
  ): ChatSessionStoreHandle | null => {
    mocks.sessionRequests.push(chatId);
    return chatId === CHANNEL_ID ? channelHandle() : null;
  },
}));
vi.mock("@/hooks/chats/use-chat-locate-row", () => ({
  useChatLocateRow: () => null,
}));
vi.mock("@/hooks/host/use-connectable-host-ids", () => ({
  useConnectableHostIds: () => mocks.state.connectable,
}));
vi.mock("@/components/bots/bot-chat-transcript", () => ({
  BotChatTranscript: (props: { chatId: string }) => (
    <div data-testid="stub-transcript" data-chat-id={props.chatId} />
  ),
}));

import { BotUnderTheHoodPanel } from "@/components/bots/bot-under-the-hood-panel";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SIBLING_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const OTHER_HOST_SIBLING_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const TRUNK_ID = "trunk-1";
const HOST_ID = "host-bound";
const OTHER_HOST_ID = "host-other";
const CHANNEL_ID = "conversation-channel";
const ENVIRONMENT_BOTS = [
  { botId: BOT_ID, boundHostId: HOST_ID },
  { botId: SIBLING_ID, boundHostId: HOST_ID },
];

function channelRow(messageId: string, text: string): Message {
  return {
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

/** The channel's session, holding the rows `thread()` registered. */
function channelHandle(): ChatSessionStoreHandle {
  if (mocks.state.channelHandle === null) {
    const store = createStore<
      Pick<
        ChatSessionState,
        "messages" | "transcriptWindow" | "holdTranscriptOrdinal"
      >
    >(() => ({
      transcriptWindow: emptyTranscriptWindow(),
      holdTranscriptOrdinal: () => () => undefined,
      messages: Object.entries(mocks.state.channelPosts).map(([id, text]) =>
        channelRow(id, text),
      ),
    }));
    mocks.state.channelHandle = { store } as ChatSessionStoreHandle;
  }
  return mocks.state.channelHandle;
}

/**
 * A thread answering a member's channel post, whose row id its request id
 * names and whose text the channel's row carries.
 */
function thread(
  threadId: string,
  text: string,
  overrides: Partial<BotThreadSummary>,
): BotThreadSummary {
  const postId = conversationRequestMessageId(`req-${threadId}`);
  mocks.state.channelPosts[postId] = text;
  return {
    threadId,
    conversationId: CHANNEL_ID,
    sessionChatId: `session-${threadId}`,
    anchor: {
      messageId: postId,
      requestId: `req-${threadId}`,
      senderUserId: "user-1",
      sentAt: 1_000,
      resolvedAt: null,
    },
    replyCount: 2,
    lastReplyAt: 2_000,
    openRequestCount: 0,
    costUsd: null,
    ...overrides,
  };
}

/** The bound host the next panel renders with. */
let boundHost: { hostId: string; isThisHost: boolean };

/** The notification watches the next panel renders with. */
let notificationSubscriptions: ReadonlyArray<BotNotificationSubscription> | null;

/** The bot's task list the next panel renders with. */
let tasks: ReadonlyArray<BotTaskEntry>;

function Panel(props: {
  readonly onSelectSession: (sessionChatId: string | null) => void;
  readonly sessionChatId: string | null;
  readonly environmentBots: ReadonlyArray<{
    readonly botId: string;
    readonly boundHostId: string | null;
  }> | null;
}): ReactNode {
  return (
    <BotUnderTheHoodPanel
      botId={BOT_ID}
      hostId={HOST_ID}
      botTitle="Release Bot"
      trunkChatId={TRUNK_ID}
      tasks={tasks}
      openRequestCount={null}
      notificationSubscriptions={notificationSubscriptions}
      boundHost={boundHost}
      environmentLabel="Acme"
      environmentBots={props.environmentBots}
      sessionChatId={props.sessionChatId}
      onSelectSession={props.onSelectSession}
      channelId={CHANNEL_ID}
      onOpenPost={mocks.openPost}
    />
  );
}

function StatefulPanel(): ReactNode {
  const [sessionChatId, setSessionChatId] = useState<string | null>(null);
  return (
    <Panel
      sessionChatId={sessionChatId}
      onSelectSession={setSessionChatId}
      environmentBots={ENVIRONMENT_BOTS}
    />
  );
}

function cost(testId: string): string {
  return within(screen.getByTestId("bot-costs")).getByTestId(testId)
    .textContent;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sessionRequests.length = 0;
  mocks.state.channelPosts = {};
  mocks.state.channelHandle = null;
  mocks.state.connectable = { hostIds: [], resolved: true };
  boundHost = { hostId: HOST_ID, isThisHost: true };
  notificationSubscriptions = null;
  tasks = [];
  mocks.state.taskTitles = {};
  useBotTabsStore.setState({ tabs: {} });
  mocks.state.usageSupported = true;
  mocks.state.answers = {};
  mocks.state.threads = [];
  mocks.state.trunkCostUsd = null;
  mocks.state.threadListSupported = true;
  mocks.state.threadListAnswered = true;
  mocks.state.threadListError = false;
});

afterEach(() => {
  cleanup();
});

describe("<BotUnderTheHoodPanel /> cost", () => {
  it("shows the bot's total as its trunk's plus its threads', the trunk's share, and the environment's as the sum of its bots' totals", () => {
    mocks.state.trunkCostUsd = 3.25;
    mocks.state.threads = [
      thread("thread-a", "Please review the release", { costUsd: 9 }),
      thread("thread-b", "Why is nightly red?", { costUsd: 0.25 }),
    ];
    mocks.state.answers = {
      [SIBLING_ID]: {
        trunkCostUsd: 5,
        threads: [thread("thread-c", "Bump the deps", { costUsd: 2.5 })],
      },
    };
    render(
      <Panel
        sessionChatId={null}
        onSelectSession={vi.fn()}
        environmentBots={ENVIRONMENT_BOTS}
      />,
    );

    expect(cost("bot-cost-bot")).toBe("$12.50");
    expect(cost("bot-cost-trunk")).toBe("$3.25");
    expect(cost("bot-cost-environment")).toBe("$20.00");
    expect(
      within(screen.getByTestId("bot-costs")).getByText("Acme"),
    ).toBeTruthy();
  });

  it("shows the bot's total as unknown while a thread's cost is, and the trunk's regardless", () => {
    mocks.state.trunkCostUsd = 3.25;
    mocks.state.threads = [
      thread("thread-a", "Please review the release", { costUsd: 9 }),
      thread("thread-b", "Why is nightly red?", { costUsd: null }),
    ];
    render(
      <Panel
        sessionChatId={null}
        onSelectSession={vi.fn()}
        environmentBots={ENVIRONMENT_BOTS}
      />,
    );

    expect(cost("bot-cost-bot")).toBe("—");
    expect(cost("bot-cost-trunk")).toBe("$3.25");
  });

  it("shows the bot's figures as unknown while the thread list has not answered", () => {
    mocks.state.threadListAnswered = false;
    mocks.state.trunkCostUsd = 3.25;
    render(
      <Panel
        sessionChatId={null}
        onSelectSession={vi.fn()}
        environmentBots={ENVIRONMENT_BOTS}
      />,
    );

    expect(cost("bot-cost-bot")).toBe("—");
    expect(cost("bot-cost-trunk")).toBe("—");
  });

  it("shows the environment's figure as unknown while one of its bots has not answered", () => {
    mocks.state.trunkCostUsd = 0;
    render(
      <Panel
        sessionChatId={null}
        onSelectSession={vi.fn()}
        environmentBots={ENVIRONMENT_BOTS}
      />,
    );

    expect(cost("bot-cost-bot")).toBe("$0.00");
    expect(cost("bot-cost-environment")).toBe("—");
  });

  it("shows the environment's figure as unknown, not the sum of the rest, while one of its bots is bound to another host", () => {
    mocks.state.trunkCostUsd = 3.25;
    mocks.state.answers = {
      [SIBLING_ID]: { trunkCostUsd: 5, threads: [] },
    };
    render(
      <Panel
        sessionChatId={null}
        onSelectSession={vi.fn()}
        environmentBots={[
          ...ENVIRONMENT_BOTS,
          { botId: OTHER_HOST_SIBLING_ID, boundHostId: "host-elsewhere" },
        ]}
      />,
    );

    expect(cost("bot-cost-bot")).toBe("$3.25");
    expect(cost("bot-cost-environment")).toBe("—");
  });

  it("shows the environment's figure as unknown while its bots are not listed yet", () => {
    mocks.state.trunkCostUsd = 3.25;
    render(
      <Panel
        sessionChatId={null}
        onSelectSession={vi.fn()}
        environmentBots={null}
      />,
    );

    expect(cost("bot-cost-bot")).toBe("$3.25");
    expect(cost("bot-cost-environment")).toBe("—");
  });

  it("shows no cost section on a host that cannot report usage", () => {
    mocks.state.usageSupported = false;
    render(
      <Panel
        sessionChatId={null}
        onSelectSession={vi.fn()}
        environmentBots={ENVIRONMENT_BOTS}
      />,
    );

    expect(screen.queryByTestId("bot-costs")).toBeNull();
    expect(screen.getByTestId("bot-threads")).toBeTruthy();
  });
});

describe("<BotUnderTheHoodPanel /> sessions", () => {
  it("shows a thread's session transcript when its row is chosen, and the trunk again from Show trunk", async () => {
    const user = userEvent.setup();
    mocks.state.threads = [
      thread("thread-a", "Please review the release", { costUsd: 1.5 }),
      thread("thread-b", "Roll back the deploy", {}),
    ];
    render(<StatefulPanel />);

    const transcript = (): string | null =>
      screen.getByTestId("stub-transcript").getAttribute("data-chat-id");
    expect(transcript()).toBe(TRUNK_ID);
    expect(screen.getByTestId("bot-session-heading").textContent).toBe("Trunk");
    expect(screen.queryByRole("button", { name: "Show trunk" })).toBeNull();

    await user.click(screen.getAllByTestId("bot-thread-row")[1]);

    expect(transcript()).toBe("session-thread-b");
    expect(screen.getByTestId("bot-session-heading").textContent).toBe(
      "Thread: Roll back the deploy",
    );

    await user.click(screen.getByRole("button", { name: "Show trunk" }));

    expect(transcript()).toBe(TRUNK_ID);
    expect(screen.getByTestId("bot-session-heading").textContent).toBe("Trunk");
  });

  it("lists each thread by the post it answers, with its replies and its cost when known", () => {
    mocks.state.threads = [
      thread("thread-a", "Please review the release", {
        replyCount: 1,
        costUsd: 1.5,
      }),
      thread("thread-b", "Roll back the deploy", { replyCount: 4 }),
    ];
    render(
      <Panel
        sessionChatId={null}
        onSelectSession={vi.fn()}
        environmentBots={ENVIRONMENT_BOTS}
      />,
    );

    const [first, second] = screen.getAllByTestId("bot-thread-row");
    expect(within(first).getByText("Please review the release")).toBeTruthy();
    expect(within(first).getByText("1 reply")).toBeTruthy();
    expect(within(first).getByTestId("bot-thread-row-cost").textContent).toBe(
      "$1.50",
    );
    expect(within(second).getByText("4 replies")).toBeTruthy();
    expect(within(second).queryByTestId("bot-thread-row-cost")).toBeNull();
  });
});

describe("<BotUnderTheHoodPanel /> thread list unavailable", () => {
  it("lists no threads on a host without the thread list", () => {
    mocks.state.threadListSupported = false;
    mocks.state.threadListAnswered = false;
    render(
      <Panel
        sessionChatId={null}
        onSelectSession={vi.fn()}
        environmentBots={ENVIRONMENT_BOTS}
      />,
    );

    expect(screen.queryByTestId("bot-threads")).toBeNull();
  });

  it("says the thread list failed, not that there are no threads, and reads it again on Retry", async () => {
    const user = userEvent.setup();
    mocks.state.threadListAnswered = false;
    mocks.state.threadListError = true;
    render(
      <Panel
        sessionChatId={null}
        onSelectSession={vi.fn()}
        environmentBots={ENVIRONMENT_BOTS}
      />,
    );

    const threads = screen.getByTestId("bot-threads");
    expect(within(threads).queryByText("No threads yet.")).toBeNull();
    const failure = within(threads).getByTestId("bot-threads-error");
    await user.click(within(failure).getByRole("button", { name: "Retry" }));
    expect(mocks.refetchThreads).toHaveBeenCalledTimes(1);
  });

  it("waits for the thread list before saying there are none", () => {
    mocks.state.threadListAnswered = false;
    render(
      <Panel
        sessionChatId={null}
        onSelectSession={vi.fn()}
        environmentBots={ENVIRONMENT_BOTS}
      />,
    );

    const threads = screen.getByTestId("bot-threads");
    expect(within(threads).getByTestId("bot-threads-loading")).toBeTruthy();
    expect(within(threads).queryByText("No threads yet.")).toBeNull();
  });
});

describe("<BotUnderTheHoodPanel /> on a host that does not run the bot", () => {
  beforeEach(() => {
    boundHost = { hostId: OTHER_HOST_ID, isThisHost: false };
    useBotTabsStore
      .getState()
      .openBotTab({ botId: BOT_ID, hostId: HOST_ID, title: "Release Bot" });
  });

  function renderPanel(): void {
    render(
      <Panel
        sessionChatId={null}
        onSelectSession={vi.fn()}
        environmentBots={ENVIRONMENT_BOTS}
      />,
    );
  }

  it("lists the threads and says the sessions are elsewhere, instead of the trunk's transcript and check-ins", () => {
    mocks.state.threads = [thread("thread-a", "Please review the release", {})];
    renderPanel();

    expect(screen.getByTestId("bot-sessions-elsewhere")).toBeTruthy();
    expect(screen.queryByTestId("stub-transcript")).toBeNull();
    expect(mocks.sessionRequests).not.toContain(TRUNK_ID);
    const [row] = screen.getAllByTestId("bot-thread-row");
    expect(within(row).getByText("Please review the release")).toBeTruthy();
  });

  it("offers Open there only when this app can connect to the bot's host, and moves the tab there", async () => {
    const user = userEvent.setup();
    renderPanel();
    expect(screen.queryByTestId("bot-sessions-open-there")).toBeNull();
    cleanup();

    mocks.state.connectable = { hostIds: [HOST_ID], resolved: true };
    renderPanel();
    expect(screen.queryByTestId("bot-sessions-open-there")).toBeNull();
    cleanup();

    mocks.state.connectable = { hostIds: [OTHER_HOST_ID], resolved: false };
    renderPanel();
    expect(screen.queryByTestId("bot-sessions-open-there")).toBeNull();
    cleanup();

    mocks.state.connectable = { hostIds: [OTHER_HOST_ID], resolved: true };
    renderPanel();
    await user.click(screen.getByTestId("bot-sessions-open-there"));

    expect(useBotTabsStore.getState().tabs[BOT_ID]?.hostId).toBe(OTHER_HOST_ID);
  });

  it("shows the transcript and the trunk's session on the bot's own host", () => {
    boundHost = { hostId: HOST_ID, isThisHost: true };
    renderPanel();

    expect(screen.queryByTestId("bot-sessions-elsewhere")).toBeNull();
    expect(
      screen.getByTestId("stub-transcript").getAttribute("data-chat-id"),
    ).toBe(TRUNK_ID);
    expect(mocks.sessionRequests).toContain(TRUNK_ID);
  });
});

describe("<BotUnderTheHoodPanel /> the post a thread answers", () => {
  it("names a thread by the channel's row, and by nothing while the channel has none", () => {
    mocks.state.threads = [thread("thread-a", "Please review the release", {})];
    mocks.state.channelPosts = {};
    render(
      <Panel
        sessionChatId={null}
        onSelectSession={vi.fn()}
        environmentBots={ENVIRONMENT_BOTS}
      />,
    );

    const [row] = screen.getAllByTestId("bot-thread-row");
    expect(within(row).queryByText("Please review the release")).toBeNull();
    expect(within(row).getByText("Thread")).toBeTruthy();
  });
});

/** A task the bot runs every six hours, set up by nobody the list names. */
function task(taskId: string, overrides: Partial<BotTaskEntry>): BotTaskEntry {
  return {
    taskId,
    cadence: { kind: "every", seconds: 21_600 },
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
    ...overrides,
  };
}

function taskRow(taskId: string): HTMLElement {
  const row = screen
    .getAllByTestId("bot-task-row")
    .find((element) => element.getAttribute("data-task-id") === taskId);
  if (row === undefined) throw new Error(`no row for ${taskId}`);
  return row;
}

describe("<BotUnderTheHoodPanel /> tasks", () => {
  function renderPanel(): void {
    render(
      <Panel
        sessionChatId={null}
        onSelectSession={vi.fn()}
        environmentBots={ENVIRONMENT_BOTS}
      />,
    );
  }

  it("lists every task the trunk and each thread set up, each with its title, name, post, thread and an automation's interval", async () => {
    const user = userEvent.setup();
    mocks.state.threads = [
      thread("thread-a", "Please review the release\nIt ships Friday.", {}),
    ];
    const directPost = conversationRequestMessageId("req-direct");
    mocks.state.channelPosts[directPost] = "Check the nightly run";
    mocks.state.taskTitles = {
      "task-watch": "Release watch",
      "task-fix": "Fix the flaky shard",
      "task-nightly": "Nightly run",
    };
    tasks = [
      task("task-watch", {
        label: "Watching the release",
        originRequestId: "req-thread-a",
        createdByChatId: "thread-a",
      }),
      task("task-fix", {
        cadence: { kind: "on-completion" },
        originRequestId: "req-followup",
        createdByChatId: "thread-a",
      }),
      task("task-nightly", {
        cadence: { kind: "on-completion" },
        originRequestId: "req-direct",
      }),
    ];
    renderPanel();

    const watch = taskRow("task-watch");
    expect(within(watch).getByTestId("bot-task-open").textContent).toBe(
      "Release watch",
    );
    expect(within(watch).getByTestId("bot-task-label").textContent).toBe(
      "Watching the release",
    );
    expect(within(watch).getByTestId("bot-task-interval").textContent).toBe(
      "every 6 hours",
    );
    // The post the task came from opens its thread, which the row then does
    // not name a second time.
    expect(within(watch).getByTestId("bot-task-request").textContent).toBe(
      "for Please review the release",
    );
    expect(within(watch).queryByTestId("bot-task-thread")).toBeNull();
    await user.click(within(watch).getByTestId("bot-task-request"));
    expect(mocks.openPost).toHaveBeenLastCalledWith({
      anchorMessageId: conversationRequestMessageId("req-thread-a"),
      announcement: false,
      sent: null,
    });

    // A one-off task set up for a message inside a thread: no interval, and
    // the thread it came from, opening that thread.
    const fix = taskRow("task-fix");
    expect(within(fix).queryByTestId("bot-task-interval")).toBeNull();
    expect(within(fix).queryByTestId("bot-task-request")).toBeNull();
    expect(within(fix).getByTestId("bot-task-thread").textContent).toBe(
      "from Please review the release",
    );
    await user.click(within(fix).getByTestId("bot-task-thread"));
    expect(mocks.openPost).toHaveBeenLastCalledWith({
      anchorMessageId: conversationRequestMessageId("req-thread-a"),
      announcement: false,
      sent: null,
    });

    // The trunk's task, set up for a post the bot answered on the channel.
    const nightly = taskRow("task-nightly");
    expect(within(nightly).queryByTestId("bot-task-thread")).toBeNull();
    expect(within(nightly).getByTestId("bot-task-request").textContent).toBe(
      "for Check the nightly run",
    );
    await user.click(within(nightly).getByTestId("bot-task-request"));
    expect(mocks.openPost).toHaveBeenLastCalledWith({
      anchorMessageId: directPost,
      announcement: true,
      sent: null,
    });

    const section = screen.getByTestId("bot-tasks");
    expect(section.textContent).not.toMatch(/check-in|next|last|ago/i);
  });

  it("names and opens the thread that a reply under the bot's question opened, for the task that reply set up", async () => {
    const user = userEvent.setup();
    // The thread hangs off the bot's question; the reply that opened it,
    // and set the task up, is the thread's own first message.
    mocks.state.channelPosts["question-1"] = "Which release should I watch?";
    mocks.state.threads = [
      {
        ...thread("thread-q", "unused", {}),
        anchor: {
          messageId: "question-1",
          requestId: "req-opener",
          senderUserId: null,
          sentAt: 1_000,
          resolvedAt: null,
        },
      },
    ];
    tasks = [
      task("task-watch", {
        originRequestId: "req-opener",
        createdByChatId: "thread-q",
      }),
    ];
    renderPanel();

    const row = taskRow("task-watch");
    expect(within(row).queryByTestId("bot-task-request")).toBeNull();
    expect(within(row).getByTestId("bot-task-thread").textContent).toBe(
      "from Which release should I watch?",
    );
    await user.click(within(row).getByTestId("bot-task-thread"));
    expect(mocks.openPost).toHaveBeenLastCalledWith({
      anchorMessageId: "question-1",
      announcement: false,
      sent: null,
    });
  });

  it("keeps the thread's link while the post the task came from is not loaded", async () => {
    const user = userEvent.setup();
    mocks.state.threads = [thread("thread-a", "Please review the release", {})];
    mocks.state.channelPosts = {};
    tasks = [
      task("task-watch", {
        originRequestId: "req-thread-a",
        createdByChatId: "thread-a",
      }),
    ];
    renderPanel();

    const row = taskRow("task-watch");
    expect(within(row).queryByTestId("bot-task-request")).toBeNull();
    const from = within(row).getByTestId("bot-task-thread");
    expect(from.textContent).toBe("from a thread");
    await user.click(from);
    expect(mocks.openPost).toHaveBeenLastCalledWith({
      anchorMessageId: conversationRequestMessageId("req-thread-a"),
      announcement: false,
      sent: null,
    });
  });

  // Accepted residual: an automation a thread of another bot set up on this
  // bot is listed here, on the bot that runs it, and not in that thread's
  // panel. This bot's lists cannot name or open the other bot's thread.
  it("says a task came from another bot's thread, with nothing to open, when no thread of this bot set it up", () => {
    mocks.state.threads = [thread("thread-a", "Please review the release", {})];
    tasks = [
      task("task-handoff", {
        originRequestId: "req-elsewhere",
        createdByChatId: "thread-of-another-bot",
      }),
    ];
    renderPanel();

    const row = taskRow("task-handoff");
    expect(within(row).queryByTestId("bot-task-request")).toBeNull();
    const from = within(row).getByTestId("bot-task-thread");
    expect(from.textContent).toBe("from another bot's thread");
    expect(from.tagName).toBe("SPAN");
  });

  it("says a thread set a task up, without naming which, while the thread list is not read", () => {
    mocks.state.threadListAnswered = false;
    tasks = [
      task("task-watch", {
        originRequestId: "req-thread-a",
        createdByChatId: "thread-a",
      }),
    ];
    renderPanel();

    const from = within(taskRow("task-watch")).getByTestId("bot-task-thread");
    expect(from.textContent).toBe("from a thread");
    expect(from.tagName).toBe("SPAN");
  });

  it("draws a task from a host that does not say where it came from with its title and interval alone", () => {
    mocks.state.threads = [thread("thread-a", "Please review the release", {})];
    tasks = [
      task("task-watch", {
        spun: null,
        label: null,
        originRequestId: null,
        createdByChatId: null,
      }),
    ];
    renderPanel();

    const row = taskRow("task-watch");
    expect(within(row).getByTestId("bot-task-open").textContent).toBe(
      "task-watch",
    );
    expect(within(row).getByTestId("bot-task-interval").textContent).toBe(
      "every 6 hours",
    );
    expect(within(row).queryByTestId("bot-task-label")).toBeNull();
    expect(within(row).queryByTestId("bot-task-request")).toBeNull();
    expect(within(row).queryByTestId("bot-task-thread")).toBeNull();
  });
});

describe("<BotUnderTheHoodPanel /> notification watches", () => {
  function renderPanel(): void {
    render(
      <Panel
        sessionChatId={null}
        onSelectSession={vi.fn()}
        environmentBots={ENVIRONMENT_BOTS}
      />,
    );
  }

  it("says the trunk and a thread are watching the person's notifications, each in words", () => {
    mocks.state.threads = [thread("thread-a", "Please review the release", {})];
    notificationSubscriptions = [
      { target: { kind: "trunk" }, attentionOnly: true, everySeconds: null },
      {
        target: { kind: "thread", threadId: "thread-a" },
        attentionOnly: false,
        everySeconds: 3600,
      },
    ];
    renderPanel();

    const watches = screen.getByTestId("bot-notification-watches");
    const [trunk, threadWatch] = within(watches).getAllByTestId(
      "bot-notification-watch",
    );
    expect(within(trunk).getByText("Trunk")).toBeTruthy();
    expect(
      within(trunk).getByText(
        "Watching your notifications (attention only, on event)",
      ),
    ).toBeTruthy();
    expect(
      within(threadWatch).getByText(
        "Watching your notifications (everything, every hour)",
      ),
    ).toBeTruthy();
  });

  it("names a watching thread the listing has not loaded as a thread", () => {
    notificationSubscriptions = [
      {
        target: { kind: "thread", threadId: "thread-unlisted" },
        attentionOnly: true,
        everySeconds: 600,
      },
    ];
    renderPanel();

    const [row] = screen.getAllByTestId("bot-notification-watch");
    expect(within(row).getByText("A thread")).toBeTruthy();
  });

  it("shows nothing when the host reports no watches, or does not know them", () => {
    notificationSubscriptions = [];
    renderPanel();
    expect(screen.queryByTestId("bot-notification-watches")).toBeNull();
    cleanup();

    notificationSubscriptions = null;
    renderPanel();
    expect(screen.queryByTestId("bot-notification-watches")).toBeNull();
  });
});
