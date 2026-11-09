/**
 * A bot's Activity page (Tracy Bots, decision 182): one list of the tasks the
 * bot started, while anything in them is still going on. The real page runs
 * over the real `useBotActiveTasks`, the real agent-activity store (driven by
 * its test seams), the real notification-indicator hooks (the host answers
 * `host.notifications.indicatorState`), and, for a warm task, a real open-epic
 * store registered in the real registry. Only the external boundaries are
 * replaced: the host's query transport, the task-title read, host
 * reachability, the member actions' writes and navigation.
 */
import { type ReactNode } from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostNotificationsIndicatorStateResponse } from "@traycer/protocol/host/notifications/contracts";
import { managedCommandSchema } from "@traycer/protocol/host/managed-command/unary-schemas";
import type { BotTurnRef } from "@traycer/protocol/host/bot/conversation-schemas";
import type {
  BotInputNeeded,
  BotNotificationSubscription,
  BotTaskEntry,
} from "@traycer/protocol/host/bot/schemas";
import {
  chatDescendantKind,
  chatDescendantStatusRollup,
} from "@/components/epic-canvas/sidebar/use-chat-archive-hidden-ids";
import {
  chatProjection,
  coolAllEpics,
  warmEpic,
} from "@/components/layout/tabs/side-strip/__tests__/warm-epic-fixture";
import type { AgentActivityTier } from "@/lib/agent-activity";
import { formatAbsoluteDateTime } from "@/lib/relative-time";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import {
  __resetAgentActivityStoreForTests,
  __setAgentActivityStateForTests,
} from "@/stores/agent-activity-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { installManagedCommandChatSession } from "@/stores/managed-commands/test-support/managed-command-chat-session";
import {
  EMPTY_NOTIFICATION_INDICATOR_STATE,
  type NotificationIndicatorState,
} from "@/stores/notifications/notification-indicator-state";

type IndicatorParams = {
  readonly epicIds: ReadonlyArray<string>;
  readonly chatIds: ReadonlyArray<string>;
};

const mocks = vi.hoisted(() => {
  const emptyFlags = {
    pendingFork: false,
    pendingApproval: false,
    pendingInterview: false,
    unreadFailure: false,
    unreadDone: false,
    unreadCount: 0,
  };
  const state = {
    /** The optional methods the tab's host advertised. */
    supported: new Set<string>(),
    /** Task titles by task id, as the task-context read answers them. */
    taskTitles: {} as Record<string, string>,
    /** What the host's indicator read holds per task and per agent chat. */
    epicFlags: {} as Record<string, Partial<typeof emptyFlags>>,
    chatFlags: {} as Record<string, Partial<typeof emptyFlags>>,
    /**
     * What a named host's indicator read holds per agent chat, for a case
     * whose hosts answer differently; a host not named here answers
     * `chatFlags`.
     */
    chatFlagsByHost: {} as Record<
      string,
      Record<string, Partial<typeof emptyFlags>>
    >,
    /** Hosts the directory reports unreachable. */
    unreachable: new Set<string>(),
  };
  const answers = new Map<string, unknown>();
  /** Each agent chat id an enabled indicator read asked a host about. */
  const asked: Array<{ hostId: string | null; chatId: string }> = [];
  return {
    state,
    client: { stub: "tab-host-client" },
    navigateToTabIntent: vi.fn<(...args: unknown[]) => void>(),
    openTurn: vi.fn(),
    openSession: vi.fn(),
    locateRequests: [] as Array<unknown>,
    locatedTurns: [] as Array<BotTurnRef>,
    /** Each member action the page sent, by method. */
    actions: [] as Array<{ method: string; variables: unknown }>,
    asked,
    /** `hostId`'s `host.notifications.indicatorState` answer for a request. */
    answerIndicators(
      hostId: string | null,
      requests: ReadonlyArray<{ params: IndicatorParams }>,
    ): HostNotificationsIndicatorStateResponse {
      const epics: HostNotificationsIndicatorStateResponse["epics"] = {};
      const chats: HostNotificationsIndicatorStateResponse["chats"] = {};
      const chatFlags =
        hostId !== null && Object.hasOwn(state.chatFlagsByHost, hostId)
          ? state.chatFlagsByHost[hostId]
          : state.chatFlags;
      for (const { params } of requests) {
        for (const id of params.epicIds) {
          if (Object.hasOwn(state.epicFlags, id)) {
            epics[id] = { ...emptyFlags, ...state.epicFlags[id] };
          }
        }
        for (const id of params.chatIds) {
          asked.push({ hostId, chatId: id });
          if (Object.hasOwn(chatFlags, id)) {
            chats[id] = { ...emptyFlags, ...chatFlags[id] };
          }
        }
      }
      return { epics, chats, complete: true };
    },
    /** One answer object per request set, as a query cache holds it. */
    cached(key: string, make: () => unknown): unknown {
      if (!answers.has(key)) answers.set(key, make());
      return answers.get(key);
    },
    forgetAnswers: () => {
      answers.clear();
      asked.length = 0;
    },
  };
});

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/lib/tab-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tab-navigation")>()),
  navigateToTabIntent: mocks.navigateToTabIntent,
  activateTabIntent: vi.fn(),
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
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    mocks.state.supported.has(method),
}));
vi.mock("@/hooks/bots/use-bot-activity", () => ({
  useBotActivity: () => null,
}));
vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (args: {
    method: string;
    params: unknown;
    options: { enabled: boolean };
  }) => {
    if (args.method === "bot.turn.locate" && args.options.enabled) {
      mocks.locateRequests.push(args.params);
      return { data: { turns: mocks.locatedTurns }, refetch: vi.fn() };
    }
    return { data: undefined, refetch: vi.fn() };
  },
}));
vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: (hostId: string) => ({
    status: mocks.state.unreachable.has(hostId) ? "unreachable" : "reachable",
  }),
}));
// The member actions' writes: each records the method and what it was sent.
vi.mock("@/hooks/bots/use-bot-task-action-mutations", () => {
  const recording = (method: string) => () => ({
    mutate: (variables: unknown) => {
      mocks.actions.push({ method, variables });
    },
    isPending: false,
    variables: undefined,
  });
  return {
    useBotTaskRunNowMutation: recording("bot.task.runNow"),
    useBotTaskSetPausedMutation: recording("bot.task.setPaused"),
    useBotTaskStopMutation: recording("bot.task.stop"),
  };
});
// Opening an agent in its task is the chat row's own seam, driven elsewhere.
vi.mock("@/components/epic-canvas/sidebar/use-chat-row-open-ref", () => ({
  useChatRowOpenRef: () => () => ({ type: "chat", id: "opened" }),
}));
// The host's query transport: `host.notifications.indicatorState` answers the
// flags a case holds for the ids it was asked about, in TanStack's result shape.
vi.mock("@/hooks/notifications/use-notification-host", () => ({
  useNotificationResolveHostId: () => "host-notifications",
}));
// A host's client names the host, so a read answers as the host it went to.
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => ({ hostId }),
}));
vi.mock("@/hooks/host/use-host-queries", () => ({
  useHostQueries: (args: {
    client: { hostId: string | null };
    requests: ReadonlyArray<{ params: IndicatorParams }>;
    options: { enabled?: boolean } | null;
    combine: (results: ReadonlyArray<unknown>) => unknown;
  }) => {
    const enabled = args.options?.enabled === true;
    const hostId = args.client.hostId;
    const key = JSON.stringify([
      enabled,
      hostId,
      args.requests.map((r) => r.params),
    ]);
    return mocks.cached(key, () =>
      args.combine(
        args.requests.map(() => ({
          data: enabled
            ? mocks.answerIndicators(hostId, args.requests)
            : undefined,
          isPending: false,
          isFetching: false,
          error: null,
          refetch: () => Promise.resolve(),
        })),
      ),
    );
  },
}));

import { postThread } from "@/components/bots/__tests__/bot-turn-test-support";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import { BotActivityPage } from "@/components/bots/bot-activity-page";
import { useBotActiveTasks } from "@/hooks/bots/use-bot-active-tasks";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HOST_ID = "host-bound";
const BOT_TITLE = "Tracy";
const NOW = Date.now();
const NONE_STATE: NotificationIndicatorState =
  EMPTY_NOTIFICATION_INDICATOR_STATE;

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
    inputNeeded: null,
    pause: null,
    stop: null,
    runRequest: null,
    ...overrides,
  };
}

/** A tracking task that checks in every two hours. */
function periodic(
  taskId: string,
  overrides: Partial<BotTaskEntry>,
): BotTaskEntry {
  return task(taskId, {
    cadence: { kind: "every", seconds: 7_200 },
    nextAt: NOW + 3_600_000,
    ...overrides,
  });
}

/** A task the bot ended because its completion check-in fired. */
function completed(
  taskId: string,
  overrides: Partial<BotTaskEntry>,
): BotTaskEntry {
  return task(taskId, {
    cadence: { kind: "none" },
    state: "ended",
    endedReason: "completed",
    ...overrides,
  });
}

/** An approval of `agentChatId` waiting on a person, reported at `reportedAt`. */
function waiting(
  agentChatId: string,
  reportedAt: number,
  summary: string,
): BotInputNeeded {
  return {
    hostId: "host-agents",
    hostName: "Studio Mac",
    agentChatId,
    surfaceId: `surface-${agentChatId}`,
    surface: {
      kind: "approval",
      approvalId: `approval-${agentChatId}`,
      tool: "gh pr merge",
      summary,
      tier: null,
      requiresPerson: true,
      askedAt: reportedAt,
    },
    reportedAt,
    acceptsActions: true,
  };
}

/** Who works where: the agents in each task, and which are mid-turn. */
function working(
  byEpic: Record<string, { working: string[]; turn: string[] }>,
): void {
  __setAgentActivityStateForTests(byEpic, "local", null);
}

/** Unread done or failure, as the host's indicator read holds it per task. */
function taskUnread(
  taskId: string,
  flags: { unreadDone?: boolean; unreadFailure?: boolean },
): void {
  mocks.state.epicFlags[taskId] = { ...flags, unreadCount: 1 };
}

/** What one agent chat holds, as the host's indicator read answers for it. */
function agentUnread(
  chatId: string,
  flags: { unreadDone?: boolean; unreadFailure?: boolean },
): void {
  mocks.state.chatFlags[chatId] = { ...flags, unreadCount: 1 };
}

function Harness(props: {
  readonly tasks: ReadonlyArray<BotTaskEntry>;
  readonly threads: ReadonlyArray<BotThreadSummary>;
  readonly boundHere: boolean;
  readonly notificationSubscriptions: ReadonlyArray<BotNotificationSubscription> | null;
}): ReactNode {
  const active = useBotActiveTasks(props.tasks);
  return (
    <BotActivityPage
      botId={BOT_ID}
      hostId={HOST_ID}
      botTitle={BOT_TITLE}
      boundHere={props.boundHere}
      active={active}
      tasks={props.tasks}
      notificationSubscriptions={props.notificationSubscriptions}
      onOpenTurn={mocks.openTurn}
      trunkChatId="bot-trunk"
      onOpenSession={mocks.openSession}
      resolveMember={() => null}
      threads={props.threads}
    />
  );
}

function mount(
  tasks: ReadonlyArray<BotTaskEntry>,
  options: { readonly boundHere: boolean },
): void {
  render(
    <Harness
      threads={[]}
      tasks={tasks}
      boundHere={options.boundHere}
      notificationSubscriptions={null}
    />,
  );
}

function rows(): ReadonlyArray<HTMLElement> {
  return screen.queryAllByTestId("bot-activity-task");
}

function rowIds(): ReadonlyArray<string | null> {
  return rows().map((el) => el.getAttribute("data-task-id"));
}

function row(taskId: string): HTMLElement {
  const found = rows().find((el) => el.getAttribute("data-task-id") === taskId);
  if (found === undefined) throw new Error(`no row for ${taskId}`);
  return found;
}

function glyphKind(taskId: string): string | null {
  return within(row(taskId))
    .getByTestId("bot-activity-task-glyph")
    .getAttribute("data-kind");
}

/** What the Chats panel's own fold says for agents in these states. */
function sidebarRollupKind(
  agents: ReadonlyArray<{
    readonly state: Partial<NotificationIndicatorState>;
    readonly tier: AgentActivityTier | undefined;
  }>,
): string {
  const rollup = chatDescendantStatusRollup(
    agents.map((agent) =>
      chatDescendantKind({ ...NONE_STATE, ...agent.state }, agent.tier),
    ),
  );
  return rollup?.kind ?? "none";
}

type WarmAgent = {
  readonly id: string;
  readonly parentId: string | null;
  readonly title: string;
  readonly archivedAt: number | null;
};

/** Registers a session for `taskId` whose agents are `agents`, parents first. */
function warmTask(taskId: string, agents: ReadonlyArray<WarmAgent>): void {
  warmEpic(
    taskId,
    agents.map((agent, index) =>
      chatProjection(agent.id, {
        title: agent.title,
        parentId: agent.parentId,
        archivedAt: agent.archivedAt,
        updatedAt: 100 - index,
      }),
    ),
  );
  const handle = getOpenEpicRegistry().peek(taskId);
  if (handle === null) throw new Error(`${taskId} is not warm`);
  handle.store.setState({
    tree: {
      rootIds: agents.filter((a) => a.parentId === null).map((a) => a.id),
      childrenByParent: Object.fromEntries(
        agents.map((parent) => [
          parent.id,
          agents.filter((a) => a.parentId === parent.id).map((a) => a.id),
        ]),
      ),
      nodeById: Object.fromEntries(
        agents.map((agent, index) => [
          agent.id,
          {
            id: agent.id,
            parentId: agent.parentId,
            title: agent.title,
            type: "chat",
            status: null,
            createdAt: 0,
            updatedAt: 100 - index,
          },
        ]),
      ),
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.supported = new Set();
  mocks.state.taskTitles = {};
  mocks.state.epicFlags = {};
  mocks.state.chatFlags = {};
  mocks.state.chatFlagsByHost = {};
  mocks.state.unreachable = new Set();
  mocks.actions.length = 0;
  mocks.locateRequests.length = 0;
  mocks.locatedTurns.length = 0;
  mocks.forgetAnswers();
  __resetAgentActivityStoreForTests();
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId: "user-ada", userName: "Ada", email: "ada@example.com" },
    contextMetadata: { userId: "user-ada", username: "ada" },
  });
});

afterEach(() => {
  cleanup();
  coolAllEpics();
  __resetAgentActivityStoreForTests();
  useAuthStore.setState({
    status: "signed-out",
    profile: null,
    contextMetadata: null,
  });
});

describe("<BotActivityPage /> check-ins and subscriptions", () => {
  it("shows the last received check-in when an older host has no history", () => {
    const deliveredAt = NOW - 60_000;
    mount(
      [
        completed("older-host-task", {
          label: "Legacy audit",
          checkins: null,
          lastCheckin: {
            deliveredAt,
            since: deliveredAt - 60_000,
            through: deliveredAt,
            sections: {
              agentsStarted: {
                available: true,
                rows: [],
                omitted: 0,
                creatorsBeyondCap: false,
              },
              backgroundEvents: { rows: [], omitted: 0 },
              tickets: { rows: [], omitted: 0, firstCheckin: false },
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
          },
        }),
      ],
      { boundHere: true },
    );
    const section = screen.getByRole("region", {
      name: "Tasks with check-ins",
    });
    expect(within(section).getByText("Legacy audit")).toBeTruthy();
    expect(
      within(section).getByText(
        `Check-in received · ${formatAbsoluteDateTime(deliveredAt)}`,
      ),
    ).toBeTruthy();
    expect(
      within(section).queryByText("Check-in history unavailable"),
    ).toBeNull();
  });

  it("keeps ended tasks with unavailable history visible without implying it is empty", () => {
    mount(
      [completed("dated", { label: "Dated legacy task", lastCheckinAt: NOW })],
      { boundHere: true },
    );
    const section = screen.getByRole("region", {
      name: "Tasks with check-ins",
    });
    expect(within(section).getByText("Dated legacy task")).toBeTruthy();
    expect(
      within(section).getAllByText("Check-in history unavailable").length,
    ).toBeGreaterThan(0);
    expect(within(section).queryByText("No tasks with check-ins")).toBeNull();
  });

  it("reports unknown history without claiming the task had a check-in", () => {
    mount([completed("undated", { label: "Undated legacy task" })], {
      boundHere: true,
    });
    const section = screen.getByRole("region", {
      name: "Tasks with check-ins",
    });
    expect(
      within(section).getByText("Check-in history unavailable"),
    ).toBeTruthy();
    expect(within(section).queryByText("No tasks with check-ins")).toBeNull();
  });

  it("shows received and missed history and opens the located reading turn", async () => {
    const user = userEvent.setup();
    mocks.state.supported.add("bot.turn.locate");
    const turn: BotTurnRef = {
      chatId: "bot-chat",
      turnIds: ["turn-1"],
      userMessageId: "checkin-message",
      threadId: null,
      startedAt: NOW - 1000,
      endedAt: NOW,
      summary: null,
      messageIds: [],
      requestIds: [],
    };
    mocks.locatedTurns.push(turn);
    const received = {
      kind: "received" as const,
      receivedAt: NOW,
      hostId: "host-agents",
      hostName: "Studio Mac",
      outcome: "idle" as const,
      agentsStarted: 1,
      ticketsOpened: 0,
      ticketsClosed: 1,
      backgroundEvents: 0,
      turn: { chatId: "bot-chat", turnId: "turn-1" },
      requestedByUserId: null,
    };
    const missed = {
      kind: "missed" as const,
      dueAt: NOW - 7_200_000,
      missedThrough: NOW - 3_600_000,
      reason: "no-host-reported" as const,
      caughtUpAt: null,
    };
    mount(
      [
        periodic("tracked-checkin", {
          label: "Tracked audit",
          checkins: [received],
        }),
        completed("ended-checkin", {
          label: "Finished audit",
          checkins: [missed],
        }),
      ],
      { boundHere: true },
    );

    expect(
      screen.getByRole("heading", { name: "Tasks with check-ins" }),
    ).toBeTruthy();
    expect(screen.getAllByText("Tracked audit").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Finished audit").length).toBeGreaterThan(0);
    expect(screen.getByText(/Check-in received/)).toBeTruthy();
    expect(screen.getByText(/Check-in missed/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Open check-in/ }));
    expect(mocks.locateRequests).toContainEqual({
      botId: BOT_ID,
      messageIds: [],
      requestIds: [],
      turns: [{ chatId: "bot-chat", turnId: "turn-1" }],
    });
    expect(mocks.openTurn).toHaveBeenCalledWith(turn, null);
  });

  it("distinguishes unavailable subscriptions from a known empty list", () => {
    const view = render(
      <Harness
        threads={[]}
        tasks={[]}
        boundHere
        notificationSubscriptions={null}
      />,
    );
    expect(screen.getByText("Subscriptions unavailable")).toBeTruthy();
    expect(screen.queryByText("No notification subscriptions")).toBeNull();

    view.rerender(
      <Harness
        threads={[]}
        tasks={[]}
        boundHere
        notificationSubscriptions={[]}
      />,
    );
    expect(screen.getByText("No notification subscriptions")).toBeTruthy();
    expect(screen.queryByText("Subscriptions unavailable")).toBeNull();
  });

  it("describes each subscription's target, filter, and digest cadence", () => {
    render(
      <Harness
        threads={[]}
        tasks={[]}
        boundHere
        notificationSubscriptions={[
          {
            target: { kind: "trunk" },
            attentionOnly: true,
            everySeconds: 3600,
            since: NOW,
            digests: [],
          },
          {
            target: { kind: "thread", threadId: "thread-1" },
            attentionOnly: false,
            everySeconds: null,
            since: null,
            digests: null,
          },
        ]}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Notification subscriptions" }),
    ).toBeTruthy();
    expect(screen.getByText("Trunk")).toBeTruthy();
    expect(screen.getByText("Thread: thread-1")).toBeTruthy();
    expect(screen.getByText("Attention only")).toBeTruthy();
    expect(screen.getByText("All notifications")).toBeTruthy();
    expect(screen.getByText("Every hour")).toBeTruthy();
  });
});

describe("<BotActivityPage /> shells in open sessions", () => {
  it("shows only loaded thread sessions and names thread subscriptions and shells", () => {
    const first = postThread();
    if (first.anchor === null) throw new Error("thread fixture has no anchor");
    const named = {
      ...first,
      threadId: "thread-named",
      sessionChatId: "chat-named",
      anchor: { ...first.anchor, excerpt: "Release discussion" },
    };
    const unnamed = {
      ...first,
      threadId: "thread-fallback",
      sessionChatId: "chat-fallback",
    };
    const unloaded = {
      ...first,
      threadId: "thread-unloaded",
      sessionChatId: "chat-unloaded",
    };
    const session = installManagedCommandChatSession({
      epicId: BOT_ID,
      chatId: named.sessionChatId,
      hostId: HOST_ID,
    });
    const fallback = installManagedCommandChatSession({
      epicId: BOT_ID,
      chatId: unnamed.sessionChatId,
      hostId: HOST_ID,
    });
    const command = managedCommandSchema.parse({
      id: "thread-shell",
      monitoring: true,
      description: "Thread watcher",
      command: "watch",
      cwd: "/work",
      cadence: { debounceMs: 500, maxWaitMs: 15_000, throttleMs: 5_000 },
      status: { state: "running", pid: 42, startedAtMs: NOW },
      chatId: named.sessionChatId,
      relaunchOnHostRestart: false,
      createdAtMs: NOW,
      updatedAtMs: NOW,
    });
    try {
      session.setCommands([command]);
      session.setConnectionStatus("open");
      fallback.setCommands([]);
      fallback.setConnectionStatus("open");
      render(
        <Harness
          tasks={[]}
          threads={[named, unnamed, unloaded]}
          boundHere
          notificationSubscriptions={[
            {
              target: { kind: "thread", threadId: named.threadId },
              attentionOnly: true,
              everySeconds: null,
              since: null,
              digests: null,
            },
            {
              target: { kind: "thread", threadId: unnamed.threadId },
              attentionOnly: false,
              everySeconds: null,
              since: null,
              digests: null,
            },
          ]}
        />,
      );
      const shells = screen.getByRole("region", {
        name: "Shells and monitors",
      });
      const subscriptions = screen.getByRole("region", {
        name: "Notification subscriptions",
      });
      expect(
        within(shells).getByText("Thread: Release discussion"),
      ).toBeTruthy();
      expect(within(shells).getByText("Thread: thread-fallback")).toBeTruthy();
      expect(within(shells).getByText("Thread watcher")).toBeTruthy();
      expect(within(shells).getByText("No shells")).toBeTruthy();
      expect(within(shells).queryByText("thread-unloaded")).toBeNull();
      expect(within(shells).getAllByText("Shells unavailable")).toHaveLength(1);
      expect(
        within(shells).getByText(/Other sessions may have shells/),
      ).toBeTruthy();
      expect(
        within(subscriptions).getByText("Thread: Release discussion"),
      ).toBeTruthy();
      expect(
        within(subscriptions).getByText("Thread: thread-fallback"),
      ).toBeTruthy();
      act(() => fallback.setConnectionStatus("closed"));
      expect(within(shells).getAllByText("Shells unavailable")).toHaveLength(2);
    } finally {
      cleanup();
      session.dispose();
      fallback.dispose();
    }
  });

  it("tracks the existing host-scoped session and opens the owning transcript", async () => {
    const user = userEvent.setup();
    const otherHost = installManagedCommandChatSession({
      epicId: BOT_ID,
      chatId: "bot-trunk",
      hostId: "other-host",
    });
    const session = installManagedCommandChatSession({
      epicId: BOT_ID,
      chatId: "bot-trunk",
      hostId: HOST_ID,
    });
    try {
      otherHost.setCommands([]);
      otherHost.setConnectionStatus("open");
      mount([], { boundHere: true });
      expect(screen.getByText("Shells unavailable")).toBeTruthy();
      expect(screen.queryByText("No shells")).toBeNull();

      act(() => {
        session.setCommands([]);
        session.setConnectionStatus("open");
      });
      expect(screen.getByText("No shells")).toBeTruthy();

      const command = managedCommandSchema.parse({
        id: "shell-deploy",
        monitoring: true,
        description: "deploy watcher",
        command: "tail -f deploy.log",
        cwd: "/work/repo",
        cadence: { debounceMs: 500, maxWaitMs: 15_000, throttleMs: 5_000 },
        status: { state: "running", pid: 42, startedAtMs: NOW },
        chatId: "bot-trunk",
        relaunchOnHostRestart: false,
        createdAtMs: NOW,
        updatedAtMs: NOW,
      });
      act(() => session.setCommands([command]));
      expect(screen.getByText("deploy watcher")).toBeTruthy();
      expect(screen.getByText("running")).toBeTruthy();
      expect(screen.getByText("Monitor on")).toBeTruthy();
      await user.click(screen.getByRole("button", { name: "Open session" }));
      expect(mocks.openSession).toHaveBeenCalledWith({
        chatId: "bot-trunk",
        threadId: null,
        messageId: null,
        sendPostId: null,
      });

      act(() => session.setCommands([{ ...command, monitoring: false }]));
      expect(screen.getByText("Monitor off")).toBeTruthy();
      expect(screen.queryByText("Monitor on")).toBeNull();
      act(() => session.setConnectionStatus("closed"));
      expect(screen.getByText("Shells unavailable")).toBeTruthy();
      expect(screen.queryByText("deploy watcher")).toBeNull();
    } finally {
      cleanup();
      session.dispose();
      otherHost.dispose();
    }
  });
});

describe("<BotActivityPage /> what is listed", () => {
  it("rule 2: lists a task with a working agent, one that waits on a person, one with an unseen result and a periodic one; a quiet seen task is absent", () => {
    working({ "t-working": { working: ["a-1"], turn: ["a-1"] } });
    taskUnread("t-unseen", { unreadDone: true });
    mount(
      [
        task("t-working", {}),
        task("t-waiting", {
          inputNeeded: [waiting("a-2", NOW, "Merge the release PR")],
        }),
        task("t-unseen", {}),
        periodic("t-every", {}),
        task("t-quiet", {}),
      ],
      { boundHere: true },
    );

    expect([...rowIds()].sort()).toEqual([
      "t-every",
      "t-unseen",
      "t-waiting",
      "t-working",
    ]);
  });

  it("rule 2: a task ended by its check-in with a working agent is listed once", () => {
    working({ "t-ended": { working: ["a-1"], turn: ["a-1"] } });
    mount([completed("t-ended", { lastCheckinAt: NOW })], { boundHere: true });

    expect(rowIds()).toEqual(["t-ended"]);
  });

  it("rule 1: a task the bot adopted is not listed, even working and periodic", () => {
    working({
      "t-ended": { working: ["a-1"], turn: ["a-1"] },
      "t-adopted": { working: ["a-2"], turn: ["a-2"] },
    });
    mount(
      [
        completed("t-ended", { lastCheckinAt: NOW }),
        periodic("t-adopted", { spun: false }),
      ],
      { boundHere: true },
    );

    expect(rowIds()).toEqual(["t-ended"]);
  });

  it("rule 1: draws one list under the bot's heading and none of the old sections", () => {
    working({ "t-working": { working: ["a-1"], turn: ["a-1"] } });
    mount([task("t-working", {}), periodic("t-every", {})], {
      boundHere: true,
    });

    expect(
      screen.getByRole("heading", { name: `Tasks ${BOT_TITLE} started` }),
    ).toBeTruthy();
    const text = screen.getByTestId("bot-activity-page").textContent;
    for (const gone of [
      "Running now",
      "Tasks and automations",
      "Notifications",
      "Finished",
      "All finished work",
    ]) {
      expect(text).not.toContain(gone);
    }
  });

  it("rule 1: with nothing active it says so under the same heading", () => {
    mount([task("t-quiet", {})], { boundHere: true });

    expect(rows()).toHaveLength(0);
    expect(screen.getByTestId("bot-activity-empty")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: `Tasks ${BOT_TITLE} started` }),
    ).toBeTruthy();
  });
});

describe("<BotActivityPage /> order", () => {
  it("rule 6: needs you, then working, then unseen, then periodic, whatever order the tasks arrive in", () => {
    working({ "t-working": { working: ["a-1"], turn: ["a-1"] } });
    taskUnread("t-unseen", { unreadDone: true });
    mount(
      [
        periodic("t-every", {}),
        task("t-unseen", {}),
        task("t-working", {}),
        task("t-waiting", {
          inputNeeded: [waiting("a-2", NOW, "Merge the release PR")],
        }),
      ],
      { boundHere: true },
    );

    expect(rowIds()).toEqual(["t-waiting", "t-working", "t-unseen", "t-every"]);
    expect(rows().map((el) => el.getAttribute("data-band"))).toEqual([
      "needs-you",
      "working",
      "unseen",
      "periodic",
    ]);
  });

  it("rule 6: within a band the newest activity is first", () => {
    working({
      "w-old": { working: ["a-1"], turn: ["a-1"] },
      "w-new": { working: ["a-2"], turn: ["a-2"] },
    });
    mount(
      [
        task("n-old", {
          inputNeeded: [waiting("a-3", NOW - 5_000, "Merge it")],
        }),
        task("w-old", { lastCheckinAt: NOW - 9_000 }),
        periodic("p-old", { lastCheckinAt: NOW - 8_000 }),
        task("n-new", {
          inputNeeded: [waiting("a-4", NOW - 1_000, "Merge it")],
        }),
        task("w-new", { lastCheckinAt: NOW - 2_000 }),
        periodic("p-new", { lastCheckinAt: NOW - 3_000 }),
      ],
      { boundHere: true },
    );

    expect(rowIds()).toEqual([
      "n-new",
      "n-old",
      "w-new",
      "w-old",
      "p-new",
      "p-old",
    ]);
  });
});

describe("<BotActivityPage /> the row's status", () => {
  it("rule 3: the glyph is the Chats panel's rollup of the task's agents: an agent waiting on approval outranks one working", () => {
    working({ "t-mixed": { working: ["a-turn"], turn: ["a-turn"] } });
    mount(
      [
        task("t-mixed", {
          inputNeeded: [waiting("a-approve", NOW, "Merge the release PR")],
        }),
      ],
      { boundHere: true },
    );

    expect(glyphKind("t-mixed")).toBe(
      sidebarRollupKind([
        { state: { pendingApproval: true }, tier: undefined },
        { state: {}, tier: "turn" },
      ]),
    );
    expect(glyphKind("t-mixed")).toBe("approval");
  });

  it("rule 3: working agents alone roll up to running, background work alone to background", () => {
    working({
      "t-turn": { working: ["a-1"], turn: ["a-1"] },
      "t-background": { working: ["a-2"], turn: [] },
    });
    mount([task("t-turn", {}), task("t-background", {})], { boundHere: true });

    expect(glyphKind("t-turn")).toBe(
      sidebarRollupKind([{ state: {}, tier: "turn" }]),
    );
    expect(glyphKind("t-turn")).toBe("running");
    expect(glyphKind("t-background")).toBe(
      sidebarRollupKind([{ state: {}, tier: "background" }]),
    );
    expect(glyphKind("t-background")).toBe("background");
    expect(
      within(row("t-turn")).getByTestId("bot-activity-task-line").textContent,
    ).toContain("1 agent working");
  });

  it("rule 3: a periodic task with nothing going on has no glyph", () => {
    mount([periodic("t-every", {})], { boundHere: true });

    expect(glyphKind("t-every")).toBe("none");
  });

  it("rule 3: a cold task whose own indicator holds an unread done rolls up to done, and an unread failure to failure", () => {
    taskUnread("t-done", { unreadDone: true });
    taskUnread("t-failed", { unreadFailure: true });
    mount([task("t-done", {}), task("t-failed", {})], { boundHere: true });

    expect(glyphKind("t-done")).toBe(
      sidebarRollupKind([{ state: { unreadDone: true }, tier: undefined }]),
    );
    expect(glyphKind("t-done")).toBe("done");
    expect(glyphKind("t-failed")).toBe("failure");
  });

  it("rule 3: a warm task whose agents hold no unread done still shows the task's own unread done", () => {
    warmTask("t-warm", [
      { id: "a-idle", parentId: null, title: "Idle agent", archivedAt: null },
    ]);
    taskUnread("t-warm", { unreadDone: true });
    mount([task("t-warm", {})], { boundHere: true });

    expect(glyphKind("t-warm")).toBe("done");
  });

  it("rule 3: a known agent's own unread done does not hide the task's unread failure", () => {
    warmTask("t-warm", [
      {
        id: "a-done",
        parentId: null,
        title: "Finished agent",
        archivedAt: null,
      },
    ]);
    agentUnread("a-done", { unreadDone: true });
    taskUnread("t-warm", { unreadDone: true, unreadFailure: true });
    mount([task("t-warm", {})], { boundHere: true });

    expect(glyphKind("t-warm")).toBe("failure");
  });

  it("rule 3: a task's unread done that a known agent already carries is counted once", () => {
    warmTask("t-warm", [
      {
        id: "a-done",
        parentId: null,
        title: "Finished agent",
        archivedAt: null,
      },
    ]);
    agentUnread("a-done", { unreadDone: true });
    taskUnread("t-warm", { unreadDone: true });
    mount([task("t-warm", {})], { boundHere: true });

    expect(
      within(row("t-warm"))
        .getByTestId("bot-activity-task-glyph")
        .getAttribute("aria-label"),
    ).toBe("1 completed");
  });

  it("rule 3: a cold task's unread done no known agent carries is one more completed", () => {
    working({ "t-cold": { working: ["a-1"], turn: ["a-1"] } });
    taskUnread("t-cold", { unreadDone: true });
    mount([task("t-cold", {})], { boundHere: true });

    expect(
      within(row("t-cold"))
        .getByTestId("bot-activity-task-glyph")
        .getAttribute("aria-label"),
    ).toBe("1 running · 1 completed");
  });
});

describe("<BotActivityPage /> agents on several hosts", () => {
  it("rule 3: an agent on another host than its task's session is read from the host that owns it", async () => {
    const user = userEvent.setup();
    warmTask("t-split", [
      { id: "a-lead", parentId: null, title: "Lead", archivedAt: null },
      {
        id: "a-remote",
        parentId: "a-lead",
        title: "Remote reviewer",
        archivedAt: null,
      },
    ]);
    const handle = getOpenEpicRegistry().peek("t-split");
    if (handle === null) throw new Error("t-split is not warm");
    act(() => {
      handle.store.setState((state) => ({
        chats: {
          ...state.chats,
          byId: {
            ...state.chats.byId,
            "a-remote": { ...state.chats.byId["a-remote"], hostId: "host-b" },
          },
        },
      }));
    });
    // The lead's host knows nothing of the reviewer; only the reviewer's own
    // host holds its fork.
    mocks.state.chatFlagsByHost = {
      "host-b": { "a-remote": { pendingFork: true } },
    };
    mount([periodic("t-split", {})], { boundHere: true });

    expect(
      within(row("t-split"))
        .getByTestId("bot-activity-task-glyph")
        .getAttribute("aria-label"),
    ).toBe("1 waiting for fork resolution");
    await user.click(
      within(row("t-split")).getByTestId("bot-activity-task-chevron"),
    );
    const remote = within(row("t-split"))
      .getAllByTestId("bot-activity-agent")
      .find((agent) => agent.getAttribute("data-agent-id") === "a-remote");
    expect(remote?.getAttribute("data-kind")).toBe("fork");
    expect([
      ...new Set(
        mocks.asked
          .filter((read) => read.chatId === "a-remote")
          .map((read) => read.hostId),
      ),
    ]).toEqual(["host-b"]);
  });
});

describe("<BotActivityPage /> badges and words", () => {
  it("rule 5: a periodic task wears its cadence in words and its next check-in on the second line", () => {
    mount([periodic("t-every", {})], { boundHere: true });

    const badge = within(row("t-every")).getByTestId("bot-activity-every");
    expect(badge.textContent).toBe("every 2 hours");
    expect(
      within(row("t-every")).getByTestId("bot-activity-task-line").textContent,
    ).toContain("next check-in");
  });

  it("rule 5: a task a surface waits on wears Needs you and says what it asks", () => {
    mount(
      [
        task("t-waiting", {
          inputNeeded: [waiting("a-1", NOW, "Merge the release PR")],
        }),
      ],
      { boundHere: true },
    );

    expect(
      within(row("t-waiting")).getByTestId("bot-activity-needs-you")
        .textContent,
    ).toBe("Needs you");
    expect(
      within(row("t-waiting")).getByTestId("bot-activity-task-line")
        .textContent,
    ).toContain("waiting on you: approve Merge the release PR");
  });

  it("rule 5: an on-completion task wears no cadence badge and the page says neither Automation nor One-off task", () => {
    working({ "t-once": { working: ["a-1"], turn: ["a-1"] } });
    mount([task("t-once", {})], { boundHere: true });

    expect(
      within(row("t-once")).queryByTestId("bot-activity-every"),
    ).toBeNull();
    expect(
      within(row("t-once")).queryByTestId("bot-activity-needs-you"),
    ).toBeNull();
    const text = screen.getByTestId("bot-activity-page").textContent;
    expect(text).not.toMatch(/every/i);
    expect(text).not.toContain("Automation");
    expect(text).not.toContain("One-off task");
  });

  it("rule 4: a cold task whose reporting host is unreachable says its agents are offline there", () => {
    mocks.state.unreachable.add("host-agents");
    mount(
      [
        task("t-waiting", {
          inputNeeded: [waiting("a-1", NOW, "Merge the release PR")],
        }),
      ],
      { boundHere: true },
    );

    expect(
      within(row("t-waiting")).getByTestId("bot-activity-task-offline")
        .textContent,
    ).toBe("agents on Studio Mac, offline");
  });
});

describe("<BotActivityPage /> actions", () => {
  it("rule 7: a periodic task keeps Run now, Pause and Stop, bound here; no other row has them", async () => {
    const user = userEvent.setup();
    mocks.state.supported = new Set([
      "bot.task.runNow",
      "bot.task.setPaused",
      "bot.task.stop",
    ]);
    working({ "t-once": { working: ["a-1"], turn: ["a-1"] } });
    mount([periodic("t-every", {}), task("t-once", {})], { boundHere: true });

    const every = within(row("t-every"));
    expect(every.getByTestId("bot-task-run-now").textContent).toContain(
      "Run now",
    );
    expect(every.getByTestId("bot-task-pause").textContent).toContain("Pause");
    expect(every.getByTestId("bot-task-stop").textContent).toContain("Stop");
    expect(within(row("t-once")).queryByTestId("bot-task-run-now")).toBeNull();
    expect(within(row("t-once")).queryByTestId("bot-task-pause")).toBeNull();
    expect(within(row("t-once")).queryByTestId("bot-task-stop")).toBeNull();

    await user.click(every.getByTestId("bot-task-run-now"));
    expect(mocks.actions).toEqual([
      {
        method: "bot.task.runNow",
        variables: { botId: BOT_ID, taskId: "t-every" },
      },
    ]);
  });

  it("rule 7: a tab bound to another host offers a periodic task no actions", () => {
    mocks.state.supported = new Set([
      "bot.task.runNow",
      "bot.task.setPaused",
      "bot.task.stop",
    ]);
    mount([periodic("t-every", {})], { boundHere: false });

    expect(screen.queryByTestId("bot-task-run-now")).toBeNull();
    expect(screen.queryByTestId("bot-task-pause")).toBeNull();
    expect(screen.queryByTestId("bot-task-stop")).toBeNull();
  });

  it("rule 7: a click on a row's summary opens that task, and no row has a menu", async () => {
    const user = userEvent.setup();
    working({ "t-once": { working: ["a-1"], turn: ["a-1"] } });
    mount([periodic("t-every", {}), task("t-once", {})], { boundHere: true });

    expect(screen.queryByRole("button", { name: "Task actions" })).toBeNull();
    expect(screen.queryByText("Open the brief")).toBeNull();
    for (const taskId of ["t-every", "t-once"]) {
      mocks.navigateToTabIntent.mockClear();
      await user.click(
        within(row(taskId)).getByTestId("bot-activity-task-open"),
      );
      expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
      expect(mocks.navigateToTabIntent.mock.calls[0][1]).toMatchObject({
        kind: "open-epic",
        epicId: taskId,
        // A list of the bot's tasks is a manual open: no way back to Tracy.
        tracyOrigin: null,
      });
    }
  });

  it("rule 7: Enter and Space on the focused summary open the task", async () => {
    const user = userEvent.setup();
    working({ "t-once": { working: ["a-1"], turn: ["a-1"] } });
    mount([task("t-once", {})], { boundHere: true });

    const open = within(row("t-once")).getByTestId("bot-activity-task-open");
    open.focus();
    await user.keyboard("{Enter}");
    expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
    await user.keyboard(" ");
    expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(2);
    for (const call of mocks.navigateToTabIntent.mock.calls) {
      expect(call[1]).toMatchObject({ kind: "open-epic", epicId: "t-once" });
    }
  });

  it("rule 7: the chevron and Run now, Pause and Stop do not open the task", async () => {
    const user = userEvent.setup();
    mocks.state.supported = new Set([
      "bot.task.runNow",
      "bot.task.setPaused",
      "bot.task.stop",
    ]);
    warmTask("t-every", [
      { id: "a-root", parentId: null, title: "Lead", archivedAt: null },
    ]);
    mount([periodic("t-every", {})], { boundHere: true });

    const every = within(row("t-every"));
    for (const testId of [
      "bot-activity-task-chevron",
      "bot-task-run-now",
      "bot-task-pause",
      "bot-task-stop",
    ]) {
      await user.click(every.getByTestId(testId));
    }
    expect(mocks.navigateToTabIntent).not.toHaveBeenCalled();
  });
});

describe("<BotActivityPage /> the task's agents", () => {
  it("rule 4: a warm task folds its agents under a chevron, in tree order, each with its own state", async () => {
    const user = userEvent.setup();
    warmTask("t-warm", [
      { id: "a-root", parentId: null, title: "Release lead", archivedAt: null },
      {
        id: "a-child",
        parentId: "a-root",
        title: "Changelog",
        archivedAt: null,
      },
      { id: "a-idle", parentId: null, title: "Spare", archivedAt: null },
    ]);
    working({ "t-warm": { working: ["a-root"], turn: ["a-root"] } });
    agentUnread("a-child", { unreadDone: true });
    mount([task("t-warm", {})], { boundHere: true });

    expect(screen.queryByTestId("bot-activity-task-agents")).toBeNull();
    await user.click(
      within(row("t-warm")).getByTestId("bot-activity-task-chevron"),
    );

    const agents = within(
      within(row("t-warm")).getByTestId("bot-activity-task-agents"),
    ).getAllByTestId("bot-activity-agent");
    expect(
      agents.map((el) => [
        el.getAttribute("data-agent-id"),
        el.getAttribute("data-kind"),
      ]),
    ).toEqual([
      ["a-root", sidebarRollupKind([{ state: {}, tier: "turn" }])],
      [
        "a-child",
        sidebarRollupKind([{ state: { unreadDone: true }, tier: undefined }]),
      ],
      ["a-idle", "idle"],
    ]);
    expect(agents.map((el) => el.getAttribute("data-kind"))).toEqual([
      "running",
      "done",
      "idle",
    ]);
  });

  it("rule 4: an archived agent stays folded away unless it is working or holds something unread", async () => {
    const user = userEvent.setup();
    warmTask("t-warm", [
      { id: "a-live", parentId: null, title: "Lead", archivedAt: null },
      { id: "a-old", parentId: null, title: "Old", archivedAt: 5 },
      { id: "a-unseen", parentId: null, title: "Unseen", archivedAt: 5 },
    ]);
    working({ "t-warm": { working: ["a-live"], turn: ["a-live"] } });
    agentUnread("a-unseen", { unreadDone: true });
    mount([task("t-warm", {})], { boundHere: true });

    await user.click(
      within(row("t-warm")).getByTestId("bot-activity-task-chevron"),
    );

    expect(
      screen
        .getAllByTestId("bot-activity-agent")
        .map((el) => el.getAttribute("data-agent-id")),
    ).toEqual(["a-live", "a-unseen"]);
  });

  it("rule 4: a cold task, whose agents this window cannot name, has no chevron", () => {
    working({ "t-cold": { working: ["a-1"], turn: ["a-1"] } });
    mount([task("t-cold", {})], { boundHere: true });

    expect(
      within(row("t-cold")).queryByTestId("bot-activity-task-chevron"),
    ).toBeNull();
  });
});
