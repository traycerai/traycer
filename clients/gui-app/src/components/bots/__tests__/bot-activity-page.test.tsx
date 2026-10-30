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
import type {
  BotThreadSummary,
  BotTurnRef,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type {
  BotActivity,
  BotCheckinTurn,
  BotNotificationSubscription,
  BotSessionActivity,
  BotStoppedNotificationWatch,
  BotTaskCheckinRecord,
  BotTaskEntry,
  BotTaskLastCheckin,
} from "@traycer/protocol/host/bot/schemas";
import { conversationRequestMessageId } from "@traycer/protocol/persistence/epic/messages";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import type { BotTurnOpen } from "@/stores/bots/bot-open-thread-store";
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
    openTurn: vi.fn<BotTurnOpen>(),
    /** Each set of check-in turns the page asked the host to locate. */
    locateAsked: [] as Array<ReadonlyArray<BotCheckinTurn>>,
    /** Each member action the page sent, by method. */
    actions: [] as Array<{ method: string; variables: unknown }>,
    state: {
      /** The optional methods the tab's host advertised. */
      supported: new Set<string>(),
      /** The turns the host names for the check-ins asked about. */
      locatedTurns: [] as BotTurnRef[],
      /** Post text by chat id, then message id: the rows each chat holds. */
      rows,
      /** Task titles by task id, as the task-context read answers them. */
      taskTitles,
      /** The variables of each member action still pending, by method. */
      pending: new Map<string, unknown>(),
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
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    mocks.state.supported.has(method),
}));
// The member actions' writes: each records the method and what it was sent,
// and stays pending with those variables while the case's `pending` holds it.
vi.mock("@/hooks/bots/use-bot-task-action-mutations", () => {
  const recording = (method: string) => () => ({
    mutate: (variables: unknown) => {
      mocks.actions.push({ method, variables });
      mocks.state.pending.set(method, variables);
    },
    isPending: mocks.state.pending.has(method),
    variables: mocks.state.pending.get(method),
  });
  return {
    useBotTaskRunNowMutation: recording("bot.task.runNow"),
    useBotTaskSetPausedMutation: recording("bot.task.setPaused"),
    useBotTaskStopMutation: recording("bot.task.stop"),
    useBotNotificationsStopMutation: recording("bot.notifications.stop"),
  };
});
vi.mock("@/hooks/bots/use-bot-mutations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/bots/use-bot-mutations")>()),
  useBotConversationSendMutation: () => ({
    mutate: mocks.sendMutate,
    isPending: false,
    variables: undefined,
  }),
}));
// The turns the host names for the check-ins the page asks about: none unless
// a case sets them.
vi.mock("@/hooks/bots/use-bot-turn-locate-query", () => ({
  useBotTurnLocateQuery: (args: { turns: ReadonlyArray<BotCheckinTurn> }) => {
    mocks.locateAsked.push(args.turns);
    return { data: { turns: mocks.state.locatedTurns } };
  },
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
    inputNeeded: null,
    pause: null,
    stop: null,
    runRequest: null,
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
    requestedByUserId: null,
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
  readonly stoppedNotificationWatches: ReadonlyArray<BotStoppedNotificationWatch> | null;
  /** Whether the tab's host runs the bot. */
  readonly boundHere: boolean;
};

const NONE: PageInputs = {
  tasks: [],
  activity: null,
  threads: [],
  notificationSubscriptions: null,
  stoppedNotificationWatches: null,
  boundHere: true,
};

/** The environment's member directory: one member it names. */
const MEMBER_ID = "user-ada";
const resolveMember = (userId: string) =>
  userId === MEMBER_ID ? { displayName: "Ada", avatarUrl: null } : null;

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
      boundHost={{ hostId: HOST_ID, isThisHost: props.boundHere }}
      channelId={CHANNEL_ID}
      tasks={props.tasks}
      notificationSubscriptions={props.notificationSubscriptions}
      stoppedNotificationWatches={props.stoppedNotificationWatches}
      resolveMember={resolveMember}
      summary={summary}
      threads={props.threads}
      onOpenPost={mocks.openPost}
      onOpenTurn={mocks.openTurn}
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
  mocks.state.locatedTurns = [];
  mocks.locateAsked.length = 0;
  mocks.actions.length = 0;
  mocks.state.supported = new Set();
  mocks.state.pending.clear();
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
      anchorKind: null,
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
          inputNeeded: null,
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

describe("<BotActivityPage /> a check-in's turn", () => {
  const CHECKIN_TURN: BotCheckinTurn = {
    chatId: TRUNK_ID,
    turnId: "turn-checkin",
  };

  /** The turn the host names for `CHECKIN_TURN`, settled in 1m 20s unless a case says otherwise. */
  function located(overrides: Partial<BotTurnRef>): BotTurnRef {
    return {
      chatId: CHECKIN_TURN.chatId,
      turnIds: [CHECKIN_TURN.turnId],
      userMessageId: "prompt-checkin",
      threadId: null,
      startedAt: 100_000,
      endedAt: 180_000,
      summary: "Read 2 files",
      messageIds: [],
      requestIds: [],
      ...overrides,
    };
  }

  function checkinLink(): HTMLElement {
    return within(taskRow("task-auto")).getByTestId("bot-task-checkin-turn");
  }

  it("links a received check-in to the turn the host names, by the turn's receipt, and opens that turn", async () => {
    const user = userEvent.setup();
    mocks.state.locatedTurns = [located({})];
    mount({
      tasks: [
        task("task-auto", {
          checkins: [received(NOW - 1_000, { turn: CHECKIN_TURN })],
        }),
      ],
    });

    expect(checkinLink().textContent).toBe("Read 2 files · 1m 20s");
    await user.click(checkinLink());

    expect(mocks.openTurn).toHaveBeenCalledWith(located({}), null);
  });

  it("reads Open the turn for a turn with no summary yet", () => {
    mocks.state.locatedTurns = [located({ endedAt: null, summary: null })];
    mount({
      tasks: [
        task("task-auto", {
          checkins: [received(NOW - 1_000, { turn: CHECKIN_TURN })],
        }),
      ],
    });

    expect(checkinLink().textContent).toBe("Open the turn");
  });

  it("draws no link for a check-in with no turn or a turn the host does not name, and asks only for the turns of the check-ins shown", () => {
    const hidden: BotCheckinTurn = { chatId: TRUNK_ID, turnId: "turn-beyond" };
    mocks.state.locatedTurns = [located({ turnIds: ["turn-unrelated"] })];
    const history: BotTaskCheckinRecord[] = [
      received(NOW - 1_000, {}),
      received(NOW - 2_000, { turn: CHECKIN_TURN }),
      received(NOW - 3_000, {}),
      received(NOW - 4_000, {}),
      received(NOW - 5_000, {}),
      received(NOW - 6_000, { turn: hidden }),
    ];
    mount({ tasks: [task("task-auto", { checkins: history })] });

    expect(
      within(taskRow("task-auto")).queryByTestId("bot-task-checkin-turn"),
    ).toBeNull();
    expect(mocks.locateAsked.at(-1)).toEqual([CHECKIN_TURN]);
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
          digests: null,
        },
        {
          target: { kind: "thread", threadId: "thread-a" },
          attentionOnly: false,
          everySeconds: 3_600,
          since: null,
          digests: null,
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

  it("lists each watch's digests newest first, and Stop watching sends the watch's chat where the host has the method", async () => {
    const user = userEvent.setup();
    mocks.state.supported = new Set(["bot.notifications.stop"]);
    mount({
      notificationSubscriptions: [
        {
          target: { kind: "thread", threadId: "thread-a" },
          attentionOnly: false,
          everySeconds: null,
          since: NOW - DAY,
          digests: [
            {
              deliveredAt: NOW - 1_000,
              itemCount: 3,
              attentionCount: 1,
              queueItemId: "q-2",
            },
            {
              deliveredAt: NOW - 2_000,
              itemCount: 1,
              attentionCount: 0,
              queueItemId: "q-1",
            },
          ],
        },
      ],
    });
    const [watch] = screen.getAllByTestId("bot-notification-watch");

    expect(
      within(watch)
        .getAllByTestId("bot-notification-digest")
        .map((row) => row.textContent),
    ).toEqual([
      `${formatAbsoluteDateTime(NOW - 1_000)} · 3 notifications, 1 needing you`,
      `${formatAbsoluteDateTime(NOW - 2_000)} · 1 notification`,
    ]);
    await user.click(
      within(watch).getByRole("button", { name: "Stop watching" }),
    );
    expect(mocks.actions).toEqual([
      {
        method: "bot.notifications.stop",
        variables: {
          botId: BOT_ID,
          target: { kind: "thread", threadId: "thread-a" },
        },
      },
    ]);
  });

  it("keeps the pending Stop watching on its watch when a snapshot re-reads the watches", async () => {
    const user = userEvent.setup();
    mocks.state.supported = new Set(["bot.notifications.stop"]);
    const watches = (): ReadonlyArray<BotNotificationSubscription> => [
      {
        target: { kind: "thread", threadId: "thread-a" },
        attentionOnly: false,
        everySeconds: null,
        since: NOW - DAY,
        digests: null,
      },
      {
        target: { kind: "thread", threadId: "thread-b" },
        attentionOnly: false,
        everySeconds: null,
        since: NOW - DAY,
        digests: null,
      },
    ];
    const { rerender } = render(
      <Page {...NONE} notificationSubscriptions={watches()} />,
    );
    await user.click(
      within(screen.getAllByTestId("bot-notification-watch")[0]).getByRole(
        "button",
        { name: "Stop watching" },
      ),
    );

    // The next snapshot frame parses the watches into new objects while the
    // stop is still pending.
    rerender(<Page {...NONE} notificationSubscriptions={watches()} />);
    const [stopping, other] = screen.getAllByTestId("bot-notification-watch");
    expect(
      within(stopping).queryByTestId("bot-notification-stop-pending"),
    ).not.toBeNull();
    expect(
      within(other).queryByTestId("bot-notification-stop-pending"),
    ).toBeNull();
  });

  it("offers no Stop watching from a host that does not run the bot, and lists a stopped watch with who stopped it", () => {
    mocks.state.supported = new Set(["bot.notifications.stop"]);
    const stoppedAt = NOW - 1_000;
    mount({
      boundHere: false,
      notificationSubscriptions: [
        {
          target: { kind: "trunk" },
          attentionOnly: true,
          everySeconds: null,
          since: NOW - DAY,
          digests: null,
        },
      ],
      stoppedNotificationWatches: [
        {
          target: { kind: "thread", threadId: "thread-a" },
          attentionOnly: false,
          everySeconds: null,
          since: NOW - DAY,
          stoppedAt,
          stoppedByUserId: MEMBER_ID,
          digests: [],
        },
      ],
    });

    expect(screen.queryByRole("button", { name: "Stop watching" })).toBeNull();
    expect(
      screen.getByTestId("bot-notification-watch-stopped").textContent,
    ).toContain(
      `Stopped watching your notifications · by Ada · ${formatAbsoluteDateTime(stoppedAt)}`,
    );
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
    expect(
      within(all[2]).getByTestId("bot-activity-finished-reason").textContent,
    ).toBe("Stopped");
  });

  it("lists an automation a member stopped as stopped by them, this week from when they stopped it", () => {
    mocks.state.taskTitles = { "task-auto": "Release watch" };
    mount({
      tasks: [
        task("task-auto", {
          state: "ended",
          endedReason: "by-bot",
          stop: { byUserId: MEMBER_ID, at: NOW - 1_000 },
        }),
      ],
    });

    expect(screen.queryAllByTestId("bot-task-row")).toHaveLength(0);
    const [row] = within(section("bot-activity-finished")).getAllByTestId(
      "bot-activity-finished-row",
    );
    expect(row.getAttribute("data-task-id")).toBe("task-auto");
    expect(
      within(row).getByTestId("bot-activity-finished-reason").textContent,
    ).toBe("Stopped by Ada");
  });
});

const TASK_ACTIONS = [
  "bot.task.runNow",
  "bot.task.setPaused",
  "bot.task.stop",
] as const;

describe("<BotActivityPage /> member actions on an automation", () => {
  it("offers Run now, Pause and Stop on a running automation and sends each for that task", async () => {
    const user = userEvent.setup();
    mocks.state.supported = new Set(TASK_ACTIONS);
    mount({ tasks: [task("task-auto", {})] });
    const row = taskRow("task-auto");

    await user.click(within(row).getByRole("button", { name: "Run now" }));
    await user.click(within(row).getByRole("button", { name: "Pause" }));
    await user.click(within(row).getByRole("button", { name: "Stop" }));

    expect(mocks.actions).toEqual([
      {
        method: "bot.task.runNow",
        variables: { botId: BOT_ID, taskId: "task-auto" },
      },
      {
        method: "bot.task.setPaused",
        variables: { botId: BOT_ID, taskId: "task-auto", paused: true },
      },
      {
        method: "bot.task.stop",
        variables: { botId: BOT_ID, taskId: "task-auto" },
      },
    ]);
  });

  it("offers each action only where the host has its method, and none from a host that does not run the bot or on a one-off task", () => {
    mocks.state.supported = new Set(["bot.task.setPaused"]);
    mount({
      tasks: [
        task("task-auto", {}),
        task("task-once", { cadence: { kind: "on-completion" } }),
      ],
    });

    expect(
      within(taskRow("task-auto"))
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Pause", "Open the brief"]);
    expect(
      within(taskRow("task-once")).queryByRole("button", { name: "Pause" }),
    ).toBeNull();

    cleanup();
    mocks.state.supported = new Set(TASK_ACTIONS);
    mount({ tasks: [task("task-auto", {})], boundHere: false });
    for (const name of ["Run now", "Pause", "Stop"]) {
      expect(
        within(taskRow("task-auto")).queryByRole("button", { name }),
      ).toBeNull();
    }
  });

  it("says who paused an automation and since when, offers Resume, and says a Run now runs once and leaves it paused", async () => {
    const user = userEvent.setup();
    mocks.state.supported = new Set(TASK_ACTIONS);
    const since = NOW - DAY;
    mount({
      tasks: [
        task("task-auto", {
          pause: { byUserId: MEMBER_ID, since },
          runRequest: {
            byUserId: MEMBER_ID,
            requestedAt: NOW,
            state: "running",
          },
        }),
      ],
    });
    const row = taskRow("task-auto");

    expect(within(row).getByTestId("bot-task-paused").textContent).toBe(
      `Paused by Ada since ${formatAbsoluteDateTime(since)}`,
    );
    expect(within(row).getByTestId("bot-task-run-request").textContent).toBe(
      "Runs now, then stays paused",
    );
    // One Run now at a time: the waiting one is answered first.
    expect(within(row).getByRole("button", { name: "Run now" })).toHaveProperty(
      "disabled",
      true,
    );
    await user.click(within(row).getByRole("button", { name: "Resume" }));
    expect(mocks.actions).toEqual([
      {
        method: "bot.task.setPaused",
        variables: { botId: BOT_ID, taskId: "task-auto", paused: false },
      },
    ]);
  });

  it("names a member the directory does not know as a member, never by their id", () => {
    const since = NOW - DAY;
    mount({
      tasks: [
        task("task-auto", {
          pause: { byUserId: "user-departed", since },
        }),
      ],
    });

    expect(
      within(taskRow("task-auto")).getByTestId("bot-task-paused").textContent,
    ).toBe(`Paused by a member since ${formatAbsoluteDateTime(since)}`);
  });

  it("says on Stop that it ends the automation for good", async () => {
    const user = userEvent.setup();
    mocks.state.supported = new Set(TASK_ACTIONS);
    mount({ tasks: [task("task-auto", {})] });

    await user.hover(
      within(taskRow("task-auto")).getByRole("button", { name: "Stop" }),
    );

    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Ends the automation. It can't be resumed.",
    );
  });

  it("says a Run now this host cannot run waits for the task's next report", () => {
    mount({
      tasks: [
        task("task-auto", {
          runRequest: {
            byUserId: MEMBER_ID,
            requestedAt: NOW,
            state: "requested",
          },
        }),
      ],
    });

    expect(
      within(taskRow("task-auto")).getByTestId("bot-task-run-request")
        .textContent,
    ).toBe("Requested; runs when the task next reports");
  });

  it("names the member whose Run now a check-in answered", () => {
    mount({
      tasks: [
        task("task-auto", {
          checkins: [
            received(NOW - 1_000, { requestedByUserId: MEMBER_ID }),
            received(NOW - 2_000, {}),
          ],
        }),
      ],
    });

    const [asked, scheduled] = within(taskRow("task-auto")).getAllByTestId(
      "bot-task-checkin",
    );
    expect(
      within(asked).getByTestId("bot-task-checkin-requested").textContent,
    ).toBe("· Run now by Ada");
    expect(
      within(scheduled).queryByTestId("bot-task-checkin-requested"),
    ).toBeNull();
  });
});
