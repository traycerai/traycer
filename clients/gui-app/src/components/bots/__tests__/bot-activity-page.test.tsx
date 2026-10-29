/**
 * A bot's Activity page (Tracy Bots T86, decision 115). The real page runs
 * over the real summary hook and the real agent-activity store, driven by its
 * test setters, so what is asserted is the membership rule end to end: which
 * of the working agents on screen are the bot's. Only the external boundaries
 * are replaced: the host client, the task-title read, the channel's session
 * (the rows a post's text is read from), the send mutation and navigation.
 */
import { type ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type {
  BotActivity,
  BotNotificationSubscription,
  BotSessionActivity,
  BotTaskCheckinRecord,
  BotTaskEntry,
  BotTaskLastCheckin,
} from "@traycer/protocol/host/bot/schemas";
import { conversationRequestMessageId } from "@traycer/protocol/persistence/epic/messages";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import {
  __resetAgentActivityStoreForTests,
  __setAgentActivityStateForTests,
} from "@/stores/agent-activity-store";
import { formatAbsoluteDateTime } from "@/lib/relative-time";
import { chatSessionWithPosts } from "./bot-channel-rows-test-support";

const mocks = vi.hoisted(() => {
  const rows: Record<string, Record<string, string>> = {};
  const taskTitles: Record<string, string> = {};
  return {
    client: { stub: "tab-host-client" },
    navigateToTabIntent: vi.fn<(...args: unknown[]) => void>(),
    openPost: vi.fn<(open: unknown) => void>(),
    sendMutate: vi.fn<(variables: unknown, options: unknown) => void>(),
    state: {
      /** Post text by chat id, then message id: the rows each chat holds. */
      rows,
      /** Task titles by task id, as the task-context read answers them. */
      taskTitles,
    },
  };
});

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/lib/tab-navigation", () => ({
  navigateToTabIntent: mocks.navigateToTabIntent,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.client,
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
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: vi.fn() }),
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSchemaVersion: () => ({ major: 1, minor: 9 }),
}));
vi.mock("@/hooks/bots/use-bot-mutations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/bots/use-bot-mutations")>()),
  useBotConversationSendMutation: () => ({
    mutate: mocks.sendMutate,
    isPending: false,
    variables: undefined,
  }),
}));
vi.mock("@/hooks/chats/use-chat-locate-row", () => ({
  useChatLocateRowAnswer: () => ({ status: "waiting" }),
}));
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useChatSessionHandleForContainer: (
    _botId: string,
    chatId: string,
  ): ChatSessionStoreHandle | null =>
    Object.hasOwn(mocks.state.rows, chatId)
      ? chatSessionWithPosts(mocks.state.rows[chatId])
      : null,
}));

import { BotActivityPage } from "@/components/bots/bot-activity-page";
import { useBotActivitySummary } from "@/hooks/bots/use-bot-activity-summary";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HOST_ID = "host-bound";
const TRUNK_ID = "trunk-1";
const CHANNEL_ID = "conversation-channel";
const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

function task(taskId: string, overrides: Partial<BotTaskEntry>): BotTaskEntry {
  return {
    taskId,
    cadence: { kind: "every", seconds: 3_600 },
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
    ...overrides,
  };
}

function received(
  receivedAt: number,
  overrides: Partial<Extract<BotTaskCheckinRecord, { kind: "received" }>>,
): BotTaskCheckinRecord {
  return {
    kind: "received",
    receivedAt,
    hostId: "host-a",
    hostName: "Studio Mac",
    outcome: "idle",
    agentsStarted: 1,
    ticketsOpened: 0,
    ticketsClosed: 2,
    backgroundEvents: 0,
    turn: null,
    ...overrides,
  };
}

function missed(
  dueAt: number,
  caughtUpAt: number | null,
): BotTaskCheckinRecord {
  return {
    kind: "missed",
    dueAt,
    missedThrough: dueAt,
    reason: "no-host-reported",
    caughtUpAt,
  };
}

/**
 * A last check-in that started one agent, closed the tickets titled `closed`
 * and opened the ones titled `opened`.
 */
function lastCheckin(
  deliveredAt: number,
  closed: ReadonlyArray<string>,
  opened: ReadonlyArray<string>,
): BotTaskLastCheckin {
  return {
    deliveredAt,
    since: deliveredAt - DAY,
    through: deliveredAt,
    sections: {
      agentsStarted: {
        available: true,
        rows: [
          {
            agentId: "agent-1",
            title: "Fix the build",
            harnessId: "claude",
            model: "claude-opus-5-5",
            reasoningEffort: null,
            startedAt: deliveredAt - 1_000,
            creatorAgentId: null,
            isTerminal: false,
          },
        ],
        omitted: 0,
        creatorsBeyondCap: false,
      },
      backgroundEvents: { rows: [], omitted: 0 },
      tickets: {
        rows: [
          ...closed.map((title) => ({ title, move: "closed" as const })),
          ...opened.map((title) => ({ title, move: "opened" as const })),
        ].map((ticket, index) => ({
          ...ticket,
          artifactId: `artifact-${String(index)}`,
          path: `epics/task/artifacts/${String(index)}/index.md`,
        })),
        omitted: 0,
        firstCheckin: false,
      },
      cost: { available: false, window: null, total: null },
      stillRunning: {
        state: "idle",
        reason: null,
        agents: [],
        agentsOmitted: 0,
        shells: [],
        shellsOmitted: 0,
      },
    },
  };
}

function session(
  state: BotSessionActivity["state"],
  requestId: string | null,
  reason: { code: string | null; summary: string } | null,
): BotSessionActivity {
  return {
    state,
    startedAt: null,
    step: null,
    requestId,
    reason:
      reason === null
        ? null
        : { ...reason, harnessId: "claude", action: "none" },
  };
}

function thread(
  threadId: string,
  requestId: string,
  text: string,
): BotThreadSummary {
  const messageId = conversationRequestMessageId(requestId);
  mocks.state.rows[CHANNEL_ID] = {
    ...mocks.state.rows[CHANNEL_ID],
    [messageId]: text,
  };
  return {
    threadId,
    conversationId: CHANNEL_ID,
    sessionChatId: `session-${threadId}`,
    anchor: {
      messageId,
      requestId,
      senderUserId: "user-1",
      sentAt: 1_000,
      resolvedAt: null,
    },
    replyCount: 2,
    lastReplyAt: 2_000,
    openRequestCount: 0,
    costUsd: null,
  };
}

type PageInputs = {
  readonly tasks: ReadonlyArray<BotTaskEntry>;
  readonly activity: BotActivity | null;
  readonly threads: ReadonlyArray<BotThreadSummary> | null;
  readonly notificationSubscriptions: ReadonlyArray<BotNotificationSubscription> | null;
};

const NONE: PageInputs = {
  tasks: [],
  activity: null,
  threads: [],
  notificationSubscriptions: null,
};

function Page(props: PageInputs): ReactNode {
  const summary = useBotActivitySummary({
    botId: BOT_ID,
    trunkChatId: TRUNK_ID,
    tasks: props.tasks,
    activity: props.activity,
    threads: props.threads,
  });
  return (
    <BotActivityPage
      botId={BOT_ID}
      hostId={HOST_ID}
      boundHost={{ hostId: HOST_ID, isThisHost: true }}
      channelId={CHANNEL_ID}
      tasks={props.tasks}
      notificationSubscriptions={props.notificationSubscriptions}
      summary={summary}
      threads={props.threads}
      onOpenPost={mocks.openPost}
    />
  );
}

function mount(inputs: Partial<PageInputs>): void {
  render(<Page {...NONE} {...inputs} />);
}

/** Who works where: the agents in each epic, and which are mid-turn. */
function working(
  byEpic: Record<string, { working: string[]; turn: string[] }>,
): void {
  __setAgentActivityStateForTests(byEpic, "local", null);
}

function section(testId: string): HTMLElement {
  return screen.getByTestId(testId);
}

function runningRows(): ReadonlyArray<HTMLElement> {
  return within(section("bot-activity-running")).queryAllByTestId(
    "bot-activity-running-row",
  );
}

function runningKinds(): ReadonlyArray<string | null> {
  return runningRows().map((row) => row.getAttribute("data-kind"));
}

function taskRow(taskId: string): HTMLElement {
  const row = screen
    .getAllByTestId("bot-task-row")
    .find((element) => element.getAttribute("data-task-id") === taskId);
  if (row === undefined) throw new Error(`no row for ${taskId}`);
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.rows = {};
  mocks.state.taskTitles = {};
  __resetAgentActivityStoreForTests();
});

afterEach(() => {
  cleanup();
});

describe("<BotActivityPage /> running now", () => {
  it("says so when the bot has nothing running, no tasks and nothing finished", () => {
    mount({});

    expect(section("bot-activity-running").textContent).toContain(
      "Nothing running.",
    );
    expect(section("bot-activity-tasks").textContent).toContain(
      "No tasks or automations.",
    );
    expect(section("bot-activity-finished").textContent).toContain(
      "Nothing finished this week.",
    );
    expect(screen.queryByTestId("bot-activity-notifications")).toBeNull();
  });

  it("lists only what is the bot's: its tasks' agents, its trunk's and threads' background work and the agents they started", () => {
    mocks.state.taskTitles = { "task-watch": "Release watch" };
    working({
      // On the bot's task list.
      "task-watch": { working: ["agent-1", "agent-2"], turn: ["agent-1"] },
      // Working, but not a task of this bot.
      "task-unlisted": { working: ["agent-3"], turn: [] },
      // The bot's own container: the trunk answering (its typing line), a
      // thread's session with background work, and an agent it started.
      [BOT_ID]: {
        working: [TRUNK_ID, "session-thread-a", "agent-started"],
        turn: [TRUNK_ID],
      },
      // Another bot's chats.
      bot_other: { working: ["session-other"], turn: [] },
    });
    mount({
      tasks: [task("task-watch", {})],
      threads: [thread("thread-a", "req-a", "Please review the release")],
    });

    // The task, then the chats under the bot in id order; the trunk's turn is
    // the channel's typing line, so the trunk has no row.
    expect(runningKinds()).toEqual(["task", "agent", "session"]);
    const rows = runningRows();
    expect(rows[0].textContent).toContain("Release watch");
    expect(rows[0].textContent).toContain("2 agents working");
    expect(rows[2].textContent).toContain(
      "In the thread: Please review the release",
    );
    expect(rows[2].textContent).toContain("background work running");
    expect(section("bot-activity-running").textContent).not.toContain(
      "task-unlisted",
    );
  });

  it("shows the trunk once its turn is over and background work remains", () => {
    working({ [BOT_ID]: { working: [TRUNK_ID], turn: [] } });
    mount({});

    expect(runningKinds()).toEqual(["session"]);
    expect(section("bot-activity-running").textContent).toContain(
      "In the channel",
    );
  });

  it("holds back every chat but the trunk until the thread list is read", () => {
    working({
      [BOT_ID]: { working: [TRUNK_ID, "session-thread-a"], turn: [] },
    });
    mount({ threads: null });

    expect(runningKinds()).toEqual(["session"]);
    expect(section("bot-activity-running").textContent).toContain(
      "In the channel",
    );
  });

  it("lists a stopped session above the running ones, with the agent chat's words for why, and the summary where it has none", () => {
    mocks.state.taskTitles = { "task-watch": "Release watch" };
    working({ "task-watch": { working: ["agent-1"], turn: [] } });
    mount({
      tasks: [task("task-watch", {})],
      threads: [thread("thread-a", "req-a", "Please review the release")],
      activity: {
        trunk: session("failed", "req-trunk", {
          code: "rate_limit",
          summary: "429 Too Many Requests",
        }),
        threads: {
          "thread-a": session("parked", "req-thread", {
            code: "some_future_code",
            summary: "Queue paused on an undeliverable message",
          }),
        },
      },
    });

    const stopped = screen.getAllByTestId("bot-activity-stopped");
    expect(stopped).toHaveLength(2);
    expect(stopped[0].textContent).toContain("In the channel");
    expect(stopped[0].textContent).toContain("Rate limit reached");
    expect(stopped[0].textContent).not.toContain("429");
    expect(stopped[1].textContent).toContain(
      "In the thread: Please review the release",
    );
    expect(stopped[1].textContent).toContain(
      "Queue paused on an undeliverable message",
    );
    expect(
      stopped[1].compareDocumentPosition(runningRows()[0]) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("sends a stopped post again, as it was, and opens its thread in the channel", async () => {
    const user = userEvent.setup();
    const messageId = conversationRequestMessageId("req-trunk");
    mocks.state.rows[CHANNEL_ID] = { [messageId]: "Is CI green?" };
    mount({
      activity: {
        trunk: session("failed", "req-trunk", { code: null, summary: "Boom" }),
        threads: {},
      },
    });

    await user.click(screen.getByTestId("bot-activity-stopped-retry"));
    expect(mocks.sendMutate).toHaveBeenCalledTimes(1);
    expect(mocks.sendMutate.mock.calls[0][0]).toEqual({
      botId: BOT_ID,
      conversationId: CHANNEL_ID,
      text: "Is CI green?",
      threadId: null,
      announcementId: null,
      redeliver: { requestId: "req-trunk" },
      supersedes: null,
      answer: null,
    });

    await user.click(screen.getByTestId("bot-activity-stopped-open"));
    expect(mocks.openPost).toHaveBeenCalledWith({
      anchorMessageId: messageId,
      announcement: true,
      answer: false,
      sent: null,
    });
  });
});

describe("<BotActivityPage /> tasks and automations", () => {
  it("lists the tasks the bot still runs, each by its kind, next check-in and the host that last reported, and opens the brief", async () => {
    const user = userEvent.setup();
    mocks.state.taskTitles = { "task-auto": "Nightly run" };
    mount({
      tasks: [
        task("task-auto", {
          nextAt: NOW + DAY,
          checkins: [received(NOW - 1_000, { hostName: "Studio Mac" })],
        }),
        task("task-once", { cadence: { kind: "on-completion" } }),
        task("task-done", {
          state: "ended",
          endedReason: "completed",
          cadence: { kind: "on-completion" },
        }),
      ],
    });

    expect(
      within(section("bot-activity-tasks")).getAllByTestId("bot-task-row"),
    ).toHaveLength(2);
    const auto = taskRow("task-auto");
    expect(within(auto).getByTestId("bot-task-kind").textContent).toBe(
      "Automation",
    );
    expect(within(auto).getByTestId("bot-task-next").textContent).toBe(
      `next ${formatAbsoluteDateTime(NOW + DAY)}`,
    );
    expect(within(auto).getByTestId("bot-task-host").textContent).toBe(
      "on Studio Mac",
    );
    const once = taskRow("task-once");
    expect(within(once).getByTestId("bot-task-kind").textContent).toBe(
      "One-off task",
    );
    expect(within(once).queryByTestId("bot-task-next")).toBeNull();
    expect(within(once).queryByTestId("bot-task-host")).toBeNull();

    await user.click(within(auto).getByTestId("bot-task-open"));
    expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
  });

  it("nests an automation's check-ins newest first, a missed stretch in its own words, and the rest behind All N check-ins", async () => {
    const user = userEvent.setup();
    const history: BotTaskCheckinRecord[] = [
      received(NOW - 1_000, {}),
      missed(NOW - 2_000, NOW - 1_500),
      missed(NOW - 3_000, null),
      received(NOW - 4_000, { agentsStarted: null, ticketsClosed: 0 }),
      received(NOW - 5_000, { outcome: "deleted" }),
      received(NOW - 6_000, {}),
      received(NOW - 7_000, {}),
    ];
    mount({ tasks: [task("task-auto", { checkins: history })] });

    const list = within(taskRow("task-auto")).getByTestId("bot-task-checkins");
    const shown = within(list).getAllByTestId("bot-task-checkin");
    expect(shown.map((row) => row.getAttribute("data-kind"))).toEqual([
      "received",
      "missed",
      "missed",
      "received",
      "received",
    ]);
    expect(shown[0].textContent).toContain("Studio Mac");
    expect(shown[0].textContent).toContain("1 agent started, 2 tickets closed");
    expect(shown[1].textContent).toContain("Missed: no host reported");
    expect(shown[1].textContent).toContain(
      `caught up ${formatAbsoluteDateTime(NOW - 1_500)}`,
    );
    expect(shown[2].textContent).toContain("Missed: no host reported");
    expect(shown[2].textContent).not.toContain("caught up");
    expect(shown[3].textContent).toContain("Nothing new");
    expect(shown[4].textContent).toContain("The task was deleted");

    await user.click(within(list).getByTestId("bot-task-checkins-all"));
    expect(within(list).getAllByTestId("bot-task-checkin")).toHaveLength(7);
  });

  it("falls back to the last check-in where the host keeps no history, and shows no check-ins for a task with neither", () => {
    mount({
      tasks: [
        task("task-old-host", {
          checkins: null,
          lastCheckin: lastCheckin(NOW - 1_000, ["Fix flaky shard"], []),
        }),
        task("task-empty-history", {
          checkins: [],
          lastCheckin: lastCheckin(NOW - 1_000, [], []),
        }),
        task("task-none", {}),
      ],
    });

    const old = within(taskRow("task-old-host")).getAllByTestId(
      "bot-task-checkin",
    );
    expect(old).toHaveLength(1);
    expect(old[0].textContent).toContain("1 agent started, 1 ticket closed");
    expect(
      within(taskRow("task-empty-history")).getAllByTestId("bot-task-checkin"),
    ).toHaveLength(1);
    expect(
      within(taskRow("task-none")).queryByTestId("bot-task-checkins"),
    ).toBeNull();
  });
});

describe("<BotActivityPage /> notifications", () => {
  it("says since when a chat has been watching, only where the host says", () => {
    const since = NOW - 3 * DAY;
    mount({
      notificationSubscriptions: [
        {
          target: { kind: "trunk" },
          attentionOnly: true,
          everySeconds: null,
          since,
        },
        {
          target: { kind: "thread", threadId: "thread-a" },
          attentionOnly: false,
          everySeconds: 3_600,
          since: null,
        },
      ],
    });

    const [channel, other] = screen.getAllByTestId("bot-notification-watch");
    expect(channel.textContent).toContain(
      "Watching your notifications (attention only, on event)",
    );
    expect(channel.textContent).toContain(
      ` · since ${formatAbsoluteDateTime(since)}`,
    );
    expect(other.textContent).toContain("every hour");
    expect(other.textContent).not.toContain("since");
  });
});

describe("<BotActivityPage /> finished", () => {
  it("lists this week's finished tasks with why they ended and the tickets they closed, and the rest under All finished work", async () => {
    const user = userEvent.setup();
    mocks.state.taskTitles = {
      "task-week": "Release watch",
      "task-old": "Old watch",
      "task-silent": "Silent watch",
    };
    mount({
      tasks: [
        task("task-silent", { state: "ended", endedReason: "by-bot" }),
        task("task-old", {
          state: "ended",
          endedReason: "archived",
          checkins: [received(NOW - 30 * DAY, {})],
        }),
        task("task-week", {
          state: "ended",
          endedReason: "completed",
          checkins: [received(NOW - DAY, {})],
          lastCheckin: lastCheckin(
            NOW - DAY,
            ["Fix flaky shard", "Ship the docs"],
            ["Draft the plan"],
          ),
        }),
      ],
    });

    const finished = section("bot-activity-finished");
    const week = within(finished).getAllByTestId("bot-activity-finished-row");
    expect(week).toHaveLength(1);
    expect(week[0].textContent).toContain("Release watch");
    expect(week[0].textContent).toContain("Completed");
    expect(
      within(week[0]).getByTestId("bot-activity-finished-produced").textContent,
    ).toBe("closed Fix flaky shard, Ship the docs");

    await user.click(
      within(finished).getByRole("button", { name: "All finished work (3)" }),
    );
    // Newest end first, a task with no check-in last.
    const all = within(finished).getAllByTestId("bot-activity-finished-row");
    expect(all.map((row) => row.getAttribute("data-task-id"))).toEqual([
      "task-week",
      "task-old",
      "task-silent",
    ]);
    expect(all[1].textContent).toContain("Archived");
    expect(all[2].textContent).toContain("Stopped by the bot");
  });
});
