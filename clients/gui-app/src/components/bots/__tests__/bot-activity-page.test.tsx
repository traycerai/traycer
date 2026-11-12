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
import type {
  HostNotificationsCloudFeedRow,
  HostNotificationsIndicatorStateResponse,
} from "@traycer/protocol/host/notifications/contracts";
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
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import { NotificationFeedModeContext } from "@/lib/notifications/notification-feed-mode-context";
import {
  __resetAgentActivityStoreForTests,
  __setAgentActivityPlaneAnsweringForTests,
  __setAgentActivityStateForTests,
  __setHostAgentActivityHealthForTests,
  __setHostAgentActivityStateForTests,
  TEST_LOCAL_ACTIVITY_HOST_ID,
} from "@/stores/agent-activity-store";
import {
  __resetAppLocalNotificationsStoreForTests,
  useAppLocalNotificationsStore,
} from "@/stores/notifications/app-local-notifications-store";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";
import { useAuthStore } from "@/stores/auth/auth-store";
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
    /** How the host's indicator read stands: answered, still pending, or failed. */
    indicatorRead: "ok" as "ok" | "pending" | "error" | "unanswered",
    /** The feed mode the notification session negotiated. */
    feedMode: "cloud" as "local" | "cloud" | "upgrade-required",
    /** Each host an enabled reachability read asked about. */
    reachabilityAsked: new Set<string>(),
  };
  const answers = new Map<string, unknown>();
  /** Each agent chat id an enabled indicator read asked a host about. */
  const asked: Array<{ hostId: string | null; chatId: string }> = [];
  return {
    state,
    client: { stub: "tab-host-client" },
    navigateToTabIntent: vi.fn<(...args: unknown[]) => void>(),
    openSession: vi.fn(),
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
vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: (hostId: string) => {
    mocks.state.reachabilityAsked.add(hostId);
    return {
      status: mocks.state.unreachable.has(hostId) ? "unreachable" : "reachable",
    };
  },
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
          // "unanswered": settled with no error and no data, as a host that
          // does not serve the method leaves it.
          data:
            enabled && mocks.state.indicatorRead !== "unanswered"
              ? mocks.answerIndicators(hostId, args.requests)
              : undefined,
          isPending: mocks.state.indicatorRead === "pending",
          isFetching: false,
          error:
            mocks.state.indicatorRead === "error"
              ? new Error("indicator read failed")
              : null,
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
    // Known to wait on no one; `null` would say the host cannot tell.
    inputNeeded: [],
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
    // Known to wait on no one; `null` would say the host cannot tell.
    inputNeeded: [],
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

/** A question of `agentChatId` waiting on a person: the interview surface. */
function waitingQuestion(
  agentChatId: string,
  reportedAt: number,
): BotInputNeeded {
  return {
    ...waiting(agentChatId, reportedAt, "unused"),
    surface: {
      kind: "question",
      blockId: `block-${agentChatId}`,
      questions: [
        {
          questionId: "q-1",
          text: "Which branch?",
          options: ["main", "dev"],
          allowsFreeText: true,
        },
      ],
      askedAt: reportedAt,
    },
  };
}

/** Who works where: the agents in each task, and which are mid-turn. */
function working(
  byEpic: Record<string, { working: string[]; turn: string[] }>,
): void {
  // An open, answering plane served by the cloud-merged union: the whole fleet is vouched.
  __setAgentActivityPlaneAnsweringForTests();
  __setAgentActivityStateForTests(byEpic, "cloud", "connected");
}

/** The host's activity plane covers only this window's host, not the fleet. */
function narrowActivity(): void {
  __setAgentActivityPlaneAnsweringForTests();
  __setAgentActivityStateForTests({}, "local", null);
}

/** Unread done or failure, as the host's indicator read holds it per task. */
function taskUnread(
  taskId: string,
  flags: Partial<NotificationIndicatorState>,
): void {
  mocks.state.epicFlags[taskId] = { ...flags, unreadCount: 1 };
}

/** What one agent chat holds, as the host's indicator read answers for it. */
function agentUnread(
  chatId: string,
  flags: Partial<NotificationIndicatorState>,
): void {
  mocks.state.chatFlags[chatId] = { ...flags, unreadCount: 1 };
}

type HarnessProps = {
  readonly tasks: ReadonlyArray<BotTaskEntry>;
  readonly threads: ReadonlyArray<BotThreadSummary>;
  readonly boundHere: boolean;
  readonly notificationSubscriptions: ReadonlyArray<BotNotificationSubscription> | null;
};

/** The hook reads the feed mode from its ancestors, so the provider sits above the component that calls it. */
function Harness(props: HarnessProps): ReactNode {
  return (
    <NotificationFeedModeContext.Provider value={mocks.state.feedMode}>
      <HarnessBody {...props} />
    </NotificationFeedModeContext.Provider>
  );
}

function HarnessBody(props: HarnessProps): ReactNode {
  const active = useBotActiveTasks(props.tasks, HOST_ID, true);
  return (
    <BotActivityPage
      roomFresh
      botId={BOT_ID}
      hostId={HOST_ID}
      boundHere={props.boundHere}
      active={active}
      notificationSubscriptions={props.notificationSubscriptions}
      trunkChatId="bot-trunk"
      onOpenSession={mocks.openSession}
      resolveMember={() => null}
      threads={props.threads}
    />
  );
}

/** A cloud-fed notification centre: its rows count as evidence only while connected with a snapshot. */
function mountInCloudMode(
  tasks: ReadonlyArray<BotTaskEntry>,
  cloud: { readonly connected: boolean },
): void {
  mocks.state.feedMode = "cloud";
  useCloudNotificationsStore.setState({
    hasSnapshot: cloud.connected,
    connectionState: cloud.connected ? "connected" : "unavailable",
  });
  render(
    <Harness
      threads={[]}
      tasks={tasks}
      boundHere
      notificationSubscriptions={null}
    />,
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
  mocks.state.indicatorRead = "ok";
  mocks.state.feedMode = "local";
  mocks.state.reachabilityAsked = new Set();
  mocks.actions.length = 0;
  mocks.forgetAnswers();
  __resetAgentActivityStoreForTests();
  // Every case starts with the fleet vouched, so a quiet seen row can leave.
  working({});
  // Both sources answer: the cloud feed is connected with its snapshot, so a
  // quiet seen row has been proved quiet everywhere and may leave.
  holdCloudFeed([]);
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId: "user-ada", userName: "Ada", email: "ada@example.com" },
    contextMetadata: { userId: "user-ada", username: "ada" },
  });
});

afterEach(() => {
  cleanup();
  __resetAppLocalNotificationsStoreForTests();
  useCloudNotificationsStore.getState().reset();
  coolAllEpics();
  __resetAgentActivityStoreForTests();
  useAuthStore.setState({
    status: "signed-out",
    profile: null,
    contextMetadata: null,
  });
});

describe("<BotActivityPage /> subscriptions", () => {
  it("says subscriptions are unavailable when unread, and draws no section at all when known empty", () => {
    const view = render(
      <Harness
        threads={[]}
        tasks={[]}
        boundHere
        notificationSubscriptions={null}
      />,
    );
    expect(screen.getByText("Subscriptions unavailable")).toBeTruthy();

    view.rerender(
      <Harness
        threads={[]}
        tasks={[]}
        boundHere
        notificationSubscriptions={[]}
      />,
    );
    expect(screen.queryByText("Subscriptions unavailable")).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Notification subscriptions" }),
    ).toBeNull();
    expect(screen.queryByText("No notification subscriptions")).toBeNull();
    // Nothing in either list: the page says so once.
    expect(screen.getByTestId("bot-activity-empty").textContent).toBe(
      "No activity yet",
    );
  });

  it("opens the session a subscription names", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        threads={[]}
        tasks={[]}
        boundHere
        notificationSubscriptions={[
          {
            target: { kind: "trunk" },
            attentionOnly: false,
            everySeconds: null,
            since: null,
            digests: null,
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open session" }));

    expect(mocks.openSession).toHaveBeenCalledWith({
      chatId: "bot-trunk",
      threadId: null,
      messageId: null,
      sendPostId: null,
    });
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

describe("<BotActivityPage /> thread subscriptions", () => {
  it("names threads by excerpt or thread ID without showing a shell section", () => {
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
    render(
      <Harness
        tasks={[]}
        threads={[named, unnamed]}
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
    const subscriptions = screen.getByRole("region", {
      name: "Notification subscriptions",
    });
    expect(
      within(subscriptions).getByText("Thread: Release discussion"),
    ).toBeTruthy();
    expect(
      within(subscriptions).getByText("Thread: thread-fallback"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("region", { name: "Shells and monitors" }),
    ).toBeNull();
  });
});

describe("<BotActivityPage /> what is listed", () => {
  it("rule 2: lists a task with a working agent, one that waits on a person, one with an unseen result and a periodic one; a quiet seen task is absent", () => {
    working({ "t-working": { working: ["a-1"], turn: ["a-1"] } });
    // Both sources answer, so the quiet seen task has been proved quiet.
    mocks.state.feedMode = "cloud";
    holdCloudFeed([
      remoteUnseenResult("t-unseen", "chat-t-unseen", "host-remote"),
    ]);
    mount(
      [
        task("t-working", {}),
        task("t-waiting", {
          inputNeeded: [waiting("a-2", NOW, "Merge the release PR")],
        }),
        task("t-unseen", {}),
        periodic("t-every", {}),
        completed("t-quiet", { lastCheckinAt: NOW }),
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

  it("lists a task the bot adopted by the same rule as one it started, once, and drops it when seen and quiet", () => {
    working({ "t-adopted-working": { working: ["a-1"], turn: ["a-1"] } });
    mocks.state.feedMode = "cloud";
    holdCloudFeed([
      remoteUnseenResult(
        "t-adopted-unseen",
        "chat-t-adopted-unseen",
        "host-remote",
      ),
    ]);
    mount(
      [
        periodic("t-adopted-every", { spun: false }),
        completed("t-adopted-working", { spun: false, lastCheckinAt: NOW }),
        completed("t-adopted-unseen", { spun: false, lastCheckinAt: NOW }),
        completed("t-adopted-seen", { spun: false, lastCheckinAt: NOW }),
      ],
      { boundHere: true },
    );

    expect([...rowIds()].sort()).toEqual([
      "t-adopted-every",
      "t-adopted-unseen",
      "t-adopted-working",
    ]);
  });

  it("names a row by the task's own title, never by the bot's label or the id", () => {
    mocks.state.taskTitles = {
      "t-titled": "Release notes for 1.9",
      "t-labelled": "Nightly flake roster",
    };
    mount(
      [
        periodic("t-titled", { label: null }),
        periodic("t-labelled", { label: "bot-supplied-label" }),
      ],
      { boundHere: true },
    );

    expect(
      within(row("t-titled")).getByText("Release notes for 1.9"),
    ).toBeTruthy();
    expect(
      within(row("t-labelled")).getByText("Nightly flake roster"),
    ).toBeTruthy();
    const text = screen.getByTestId("bot-activity-page").textContent;
    expect(text).not.toContain("bot-supplied-label");
    expect(text).not.toContain("t-titled");
    expect(text).not.toContain("t-labelled");
  });

  it("labels a row whose title is not known as Task, still opens it, and shows no id", async () => {
    const user = userEvent.setup();
    mount([periodic("t-untitled-8f3a", { label: "bot-supplied-label" })], {
      boundHere: true,
    });

    const summary = row("t-untitled-8f3a");
    expect(within(summary).getByText("Task")).toBeTruthy();
    expect(summary.textContent).not.toContain("t-untitled-8f3a");
    expect(summary.textContent).not.toContain("bot-supplied-label");

    await user.click(within(summary).getByText("Task"));
    expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
  });

  it("draws one list under the Tasks heading and none of the old sections", () => {
    working({ "t-working": { working: ["a-1"], turn: ["a-1"] } });
    mount([task("t-working", {}), periodic("t-every", {})], {
      boundHere: true,
    });

    expect(screen.getByRole("heading", { name: "Tasks" })).toBeTruthy();
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

  it("with nothing active, draws no Tasks heading, and says so only when subscriptions are known empty too", () => {
    mocks.state.feedMode = "cloud";
    const view = render(
      <Harness
        threads={[]}
        tasks={[completed("t-quiet", { lastCheckinAt: NOW })]}
        boundHere
        notificationSubscriptions={[]}
      />,
    );
    expect(rows()).toHaveLength(0);
    expect(screen.queryByRole("heading", { name: "Tasks" })).toBeNull();
    expect(screen.getByTestId("bot-activity-empty").textContent).toBe(
      "No activity yet",
    );

    // Subscriptions unread or present: no empty message, and still no heading.
    for (const subscriptions of [
      null,
      [
        {
          target: { kind: "trunk" as const },
          attentionOnly: false,
          everySeconds: null,
          since: null,
          digests: null,
        },
      ],
    ]) {
      view.rerender(
        <Harness
          threads={[]}
          tasks={[completed("t-quiet", { lastCheckinAt: NOW })]}
          boundHere
          notificationSubscriptions={subscriptions}
        />,
      );
      expect(screen.queryByTestId("bot-activity-empty")).toBeNull();
      expect(screen.queryByRole("heading", { name: "Tasks" })).toBeNull();
    }
  });
});

describe("<BotActivityPage /> when the evidence is incomplete", () => {
  /** A task that ended with its result seen and nothing running: it leaves only on proof. */
  const QUIET = (): BotTaskEntry =>
    completed("t-quiet", { lastCheckinAt: NOW });

  it("drops a quiet, seen task once every source vouches", () => {
    mocks.state.feedMode = "cloud";
    mount([QUIET()], { boundHere: true });

    expect(rowIds()).toEqual([]);
  });

  it("keeps an on-completion task still tracking as status unknown, though nothing works or is unseen yet, and drops its ended and seen counterpart", () => {
    mocks.state.feedMode = "cloud";
    // Tracking can precede the completion report: no activity and nothing
    // unread is not proof that the task has finished.
    mount(
      [
        task("t-tracking", { cadence: { kind: "on-completion" } }),
        completed("t-ended", { lastCheckinAt: NOW }),
      ],
      { boundHere: true },
    );

    expect(rowIds()).toEqual(["t-tracking"]);
    expect(row("t-tracking").textContent.split("Status unknown")).toHaveLength(
      2,
    );
  });

  it("keeps it, as status unknown, while the activity plane covers only part of the fleet", () => {
    narrowActivity();
    mount([QUIET()], { boundHere: true });

    expect(rowIds()).toEqual(["t-quiet"]);
    // Said once, not again by the cold-host label.
    expect(row("t-quiet").textContent.split("Status unknown")).toHaveLength(2);
  });

  it("keeps it while the host's indicator read is pending, and drops it when the read lands", () => {
    mocks.state.feedMode = "cloud";
    mocks.state.indicatorRead = "pending";
    const view = render(
      <Harness
        threads={[]}
        tasks={[QUIET()]}
        boundHere
        notificationSubscriptions={null}
      />,
    );
    expect(rowIds()).toEqual(["t-quiet"]);

    mocks.state.indicatorRead = "ok";
    mocks.forgetAnswers();
    view.rerender(
      <Harness
        threads={[]}
        tasks={[QUIET()]}
        boundHere
        notificationSubscriptions={null}
      />,
    );
    expect(rowIds()).toEqual([]);
  });

  it("keeps it when the host's indicator read failed", () => {
    mocks.state.indicatorRead = "error";
    mount([QUIET()], { boundHere: true });

    expect(rowIds()).toEqual(["t-quiet"]);
  });

  it("keeps it while the host that answers indicators is unreachable", () => {
    mocks.state.unreachable.add("host-notifications");
    mount([QUIET()], { boundHere: true });

    expect(rowIds()).toEqual(["t-quiet"]);
  });

  it("keeps it while a cloud-fed centre is disconnected or has no snapshot, and drops it once connected", () => {
    mountInCloudMode([QUIET()], { connected: false });
    expect(rowIds()).toEqual(["t-quiet"]);
    cleanup();

    mountInCloudMode([QUIET()], { connected: true });
    expect(rowIds()).toEqual([]);
  });

  it("never lets missing evidence hide a positive signal: waiting, unseen and scheduled rows keep their own band", () => {
    narrowActivity();
    taskUnread("t-unseen", { unreadDone: true });
    mount(
      [
        completed("t-unseen", { lastCheckinAt: NOW }),
        task("t-waiting", {
          inputNeeded: [waiting("a-2", NOW, "Merge the release PR")],
        }),
        periodic("t-every", {}),
      ],
      { boundHere: true },
    );

    // Each keeps the band its own signal earns, ahead of any unproven row.
    expect(rowIds()).toEqual(["t-waiting", "t-unseen", "t-every"]);
    // A state that is known is never also called unknown.
    for (const id of ["t-waiting", "t-unseen"]) {
      expect(row(id).textContent).not.toContain("Status unknown");
    }
  });

  it("lists an unproven row last, below every row with a known state", () => {
    narrowActivity();
    mount(
      [
        QUIET(),
        task("t-waiting", {
          inputNeeded: [waiting("a-2", NOW, "Merge the release PR")],
        }),
      ],
      { boundHere: true },
    );

    expect(rowIds()).toEqual(["t-waiting", "t-quiet"]);
  });
});

/** A result no one has read yet, held by the cloud feed for an agent of `taskId` on another host. */
function remoteUnseenResult(
  taskId: string,
  chatId: string,
  originHostId: string,
): HostNotificationsCloudFeedRow {
  return {
    entryId: `entry-${taskId}`,
    originHostId,
    coalesceKey: `agent.stopped:${chatId}`,
    entry: {
      id: `entry-${taskId}-${chatId}`,
      updatedAt: NOW,
      readAt: null,
      kind: "agent.stopped",
      sourceRef: `entry-${taskId}`,
      severity: "done",
      outcome: "completed",
      epicId: taskId,
      chatId,
      payload: {
        kind: "chat",
        epicId: taskId,
        chatId,
        outcome: "completed",
      },
    },
    presentation: { epicTitle: "Epic", chatTitle: "Chat" },
  };
}

let cloudFeedVersion = 0;

function holdCloudFeed(
  rows: ReadonlyArray<HostNotificationsCloudFeedRow>,
): void {
  useCloudNotificationsStore.setState({ accountId: "user-a" });
  useCloudNotificationsStore.getState().applySnapshot({
    rows,
    version: ++cloudFeedVersion,
    summary: {
      totalCount: rows.length,
      unreadCount: rows.filter((r) => r.entry.readAt === null).length,
      attentionCount: 0,
    },
  });
  useCloudNotificationsStore.getState().setConnectionState("connected");
}

function band(taskId: string): string | null {
  return row(taskId).getAttribute("data-band");
}

function saysStatusUnknownOnce(taskId: string): boolean {
  return row(taskId).textContent.split("Status unknown").length === 2;
}

describe("<BotActivityPage /> a source that cannot vouch never reads as proof of quiet", () => {
  /** Ended, seen, nothing working, and waiting on no one: it leaves only on proof from every source. */
  const QUIET = (overrides: Partial<BotTaskEntry>): BotTaskEntry =>
    completed("t-quiet", { lastCheckinAt: NOW, ...overrides });

  it("keeps a task whose waiting is unknown (a host that predates it, or a room it cannot read) as status unknown, while a known-empty one leaves", () => {
    mountInCloudMode([QUIET({ inputNeeded: null })], { connected: true });
    expect(rowIds()).toEqual(["t-quiet"]);
    expect(band("t-quiet")).toBe("unknown");
    expect(saysStatusUnknownOnce("t-quiet")).toBe(true);
    cleanup();

    mountInCloudMode([QUIET({ inputNeeded: [] })], { connected: true });
    expect(rowIds()).toEqual([]);
  });

  it("keeps a task whose waiting is unknown while the indicator read is still pending", () => {
    mocks.state.indicatorRead = "pending";
    mountInCloudMode([QUIET({ inputNeeded: null })], { connected: true });

    expect(rowIds()).toEqual(["t-quiet"]);
    expect(band("t-quiet")).toBe("unknown");
  });

  it("never lets an unknown waiting list hide a waiting task: a known one keeps its own band", () => {
    mountInCloudMode(
      [
        QUIET({ inputNeeded: null }),
        task("t-waiting", {
          inputNeeded: [waiting("a-2", NOW, "Merge the release PR")],
        }),
      ],
      { connected: true },
    );

    expect(rowIds()).toEqual(["t-waiting", "t-quiet"]);
    expect(band("t-waiting")).toBe("needs-you");
  });

  it("keeps a quiet task when the host's indicator read settled with no answer (a host without the method)", () => {
    mocks.state.indicatorRead = "unanswered";
    mountInCloudMode([QUIET({})], { connected: true });

    expect(rowIds()).toEqual(["t-quiet"]);
    expect(band("t-quiet")).toBe("unknown");
    expect(saysStatusUnknownOnce("t-quiet")).toBe(true);
  });

  it("keeps a quiet task when the cloud feed is unsupported and only this host answers, though another host holds an unseen result for it", () => {
    holdCloudFeed([
      remoteUnseenResult("t-quiet", "chat-t-quiet", "host-remote"),
    ]);
    mocks.state.feedMode = "local";
    mount([QUIET({})], { boundHere: true });

    expect(rowIds()).toEqual(["t-quiet"]);
    expect(band("t-quiet")).toBe("unknown");
    expect(saysStatusUnknownOnce("t-quiet")).toBe(true);
  });

  it("keeps a quiet task while the notification feed needs an upgrade, and drops it over a connected cloud feed", () => {
    mocks.state.feedMode = "upgrade-required";
    mount([QUIET({})], { boundHere: true });
    expect(rowIds()).toEqual(["t-quiet"]);
    cleanup();

    mocks.state.feedMode = "cloud";
    mount([QUIET({})], { boundHere: true });
    expect(rowIds()).toEqual([]);
  });
});

describe("<BotActivityPage /> what a lost connection leaves cached is never shown as current", () => {
  it("shows Status unknown, not working, for an agent the activity plane counted before its stream dropped", () => {
    working({ "t-run": { working: ["a-1"], turn: ["a-1"] } });
    const view = render(
      <Harness
        threads={[]}
        tasks={[task("t-run", {})]}
        boundHere
        notificationSubscriptions={null}
      />,
    );
    expect(band("t-run")).toBe("working");

    // The counts stay held; the stream that kept them current is gone.
    act(() =>
      __setHostAgentActivityHealthForTests(TEST_LOCAL_ACTIVITY_HOST_ID, {
        connectionStatus: "reconnecting",
      }),
    );
    view.rerender(
      <Harness
        threads={[]}
        tasks={[task("t-run", {})]}
        boundHere
        notificationSubscriptions={null}
      />,
    );

    expect(rowIds()).toEqual(["t-run"]);
    expect(band("t-run")).toBe("unknown");
    expect(saysStatusUnknownOnce("t-run")).toBe(true);
  });

  it("shows Status unknown, not unread, for a result the cloud feed held before it disconnected", () => {
    mocks.state.feedMode = "cloud";
    holdCloudFeed([remoteUnseenResult("t-done", "chat-t-done", "host-remote")]);
    mount([completed("t-done", { lastCheckinAt: NOW })], { boundHere: true });
    expect(band("t-done")).toBe("unseen");

    act(() =>
      useCloudNotificationsStore.getState().setConnectionState("reconnecting"),
    );

    expect(band("t-done")).toBe("unknown");
    expect(saysStatusUnknownOnce("t-done")).toBe(true);
  });

  it("shows Status unknown, not waiting, for a surface the bot's serving host reported before that host became unreachable, and ignores an unrelated host", () => {
    const tasks = [
      task("t-wait", {
        inputNeeded: [waiting("a-2", NOW, "Merge the release PR")],
      }),
    ];
    const view = render(
      <Harness
        threads={[]}
        tasks={tasks}
        boundHere
        notificationSubscriptions={null}
      />,
    );
    // The hook reads the serving host's reachability, not only the notification host's.
    expect(mocks.state.reachabilityAsked.has(HOST_ID)).toBe(true);
    expect(mocks.state.reachabilityAsked.has("host-notifications")).toBe(true);
    expect(band("t-wait")).toBe("needs-you");

    mocks.state.unreachable.add("host-unrelated");
    view.rerender(
      <Harness
        threads={[]}
        tasks={[...tasks]}
        boundHere
        notificationSubscriptions={null}
      />,
    );
    expect(band("t-wait")).toBe("needs-you");

    mocks.state.unreachable.add(HOST_ID);
    view.rerender(
      <Harness
        threads={[]}
        tasks={[...tasks]}
        boundHere
        notificationSubscriptions={null}
      />,
    );
    expect(band("t-wait")).toBe("unknown");
    expect(saysStatusUnknownOnce("t-wait")).toBe(true);
  });
});

describe("<BotActivityPage /> activity held by two hosts' streams", () => {
  const A = "host-agents-a";
  const B = "host-agents-b";
  const bands = (): ReadonlyArray<string | null> =>
    rows().map((el) => el.getAttribute("data-band"));

  /** One host's stream open with its `state` frame landed, claiming what it can see. */
  function hostAnswers(
    hostId: string,
    byEpic: Record<string, { working: string[]; turn: string[] }>,
    servedBy: "cloud" | "local",
  ): void {
    __setHostAgentActivityStateForTests(
      hostId,
      byEpic,
      servedBy,
      servedBy === "cloud" ? "connected" : null,
    );
    __setHostAgentActivityHealthForTests(hostId, {
      connectionStatus: "open",
      stateFrameSeenThisEpoch: true,
    });
  }

  it("does not show working from a host whose stream is held, though another host's fresh fleet answer holds none", () => {
    __resetAgentActivityStoreForTests();
    mocks.state.feedMode = "cloud";
    hostAnswers(A, { "t-run": { working: ["a-1"], turn: ["a-1"] } }, "local");
    hostAnswers(B, {}, "cloud");
    const view = render(
      <Harness
        threads={[]}
        tasks={[completed("t-run", { lastCheckinAt: NOW })]}
        boundHere
        notificationSubscriptions={null}
      />,
    );
    // While A answers, its agent is working.
    expect(bands()).toEqual(["working"]);

    // A's stream drops: its slice keeps the count, but no one vouches for it.
    act(() =>
      __setHostAgentActivityHealthForTests(A, {
        connectionStatus: "reconnecting",
      }),
    );
    view.rerender(
      <Harness
        threads={[]}
        tasks={[completed("t-run", { lastCheckinAt: NOW })]}
        boundHere
        notificationSubscriptions={null}
      />,
    );

    expect(bands()).not.toContain("working");
  });

  it("still shows working from a host that answers for its own agents when no host vouches for the whole fleet, and keeps a quiet task unproven", () => {
    __resetAgentActivityStoreForTests();
    mocks.state.feedMode = "cloud";
    hostAnswers(A, { "t-run": { working: ["a-1"], turn: ["a-1"] } }, "local");
    render(
      <Harness
        threads={[]}
        tasks={[
          completed("t-run", { lastCheckinAt: NOW }),
          completed("t-quiet", { lastCheckinAt: NOW }),
        ]}
        boundHere
        notificationSubscriptions={null}
      />,
    );

    // The positive stands on its own host's word; the absence has no proof.
    expect(rowIds()).toEqual(["t-run", "t-quiet"]);
    expect(row("t-run").getAttribute("data-band")).toBe("working");
    expect(row("t-quiet").getAttribute("data-band")).toBe("unknown");
  });
});

describe("<BotActivityPage /> order", () => {
  it("rule 6: needs you, then working, then unseen, then periodic, whatever order the tasks arrive in", () => {
    working({ "t-working": { working: ["a-1"], turn: ["a-1"] } });
    // A scheduled row is "periodic" only on proof from every source.
    mocks.state.feedMode = "cloud";
    holdCloudFeed([
      remoteUnseenResult("t-unseen", "chat-t-unseen", "host-remote"),
    ]);
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

function glyphLabel(taskId: string): string | null {
  return within(row(taskId))
    .getByTestId("bot-activity-task-glyph")
    .getAttribute("aria-label");
}

const PENDING_KINDS = [
  { flag: "pendingApproval", words: "1 waiting for approval" },
  { flag: "pendingInterview", words: "1 waiting for interview" },
  { flag: "pendingFork", words: "1 waiting for fork resolution" },
] as const;

describe("<BotActivityPage /> a pending ask is counted once", () => {
  const WARM_ASKER: ReadonlyArray<WarmAgent> = [
    { id: "a-ask", parentId: null, title: "Asker", archivedAt: null },
  ];

  it.each(PENDING_KINDS)(
    "counts an agent's own $flag and the task's same pending as one ask",
    ({ flag, words }) => {
      warmTask("t-warm", WARM_ASKER);
      agentUnread("a-ask", { [flag]: true });
      taskUnread("t-warm", { [flag]: true });
      mount([task("t-warm", {})], { boundHere: true });

      expect(glyphLabel("t-warm")).toBe(words);
    },
  );

  it("counts an approval the bot reports for an agent and the task's pending approval as one", () => {
    warmTask("t-warm", WARM_ASKER);
    taskUnread("t-warm", { pendingApproval: true });
    mount([task("t-warm", { inputNeeded: [waiting("a-ask", NOW, "Merge")] })], {
      boundHere: true,
    });

    expect(glyphLabel("t-warm")).toBe("1 waiting for approval");
  });

  it("counts a question the bot reports for an agent and the task's pending interview as one", () => {
    warmTask("t-warm", WARM_ASKER);
    taskUnread("t-warm", { pendingInterview: true });
    mount([task("t-warm", { inputNeeded: [waitingQuestion("a-ask", NOW)] })], {
      boundHere: true,
    });

    expect(glyphLabel("t-warm")).toBe("1 waiting for interview");
  });

  it("counts one ask for an agent that is both working and reported waiting, beside the task's pending approval", () => {
    warmTask("t-warm", WARM_ASKER);
    working({ "t-warm": { working: ["a-ask"], turn: ["a-ask"] } });
    taskUnread("t-warm", { pendingApproval: true });
    mount([task("t-warm", { inputNeeded: [waiting("a-ask", NOW, "Merge")] })], {
      boundHere: true,
    });

    expect(glyphLabel("t-warm")).toBe("1 waiting for approval");
  });

  it("counts two agents' approvals as two, whatever the task's pending says", () => {
    warmTask("t-warm", [
      ...WARM_ASKER,
      { id: "a-ask-2", parentId: null, title: "Second", archivedAt: null },
    ]);
    agentUnread("a-ask", { pendingApproval: true });
    agentUnread("a-ask-2", { pendingApproval: true });
    taskUnread("t-warm", { pendingApproval: true });
    mount([task("t-warm", {})], { boundHere: true });

    expect(glyphLabel("t-warm")).toBe("2 waiting for approval");
  });

  it("keeps a task's pending approval that no known agent carries as one ask", () => {
    working({ "t-cold": { working: ["a-1"], turn: ["a-1"] } });
    taskUnread("t-cold", { pendingApproval: true });
    mount([task("t-cold", {})], { boundHere: true });

    expect(glyphLabel("t-cold")).toBe("1 waiting for approval · 1 running");
  });

  it("does not let an agent's approval hide the task's pending interview", () => {
    warmTask("t-warm", WARM_ASKER);
    agentUnread("a-ask", { pendingApproval: true });
    taskUnread("t-warm", { pendingInterview: true });
    mount([task("t-warm", {})], { boundHere: true });

    expect(glyphLabel("t-warm")).toBe(
      "1 waiting for interview · 1 waiting for approval",
    );
  });

  it("counts an unread failure a known agent carries and the task's unread failure as one", () => {
    warmTask("t-warm", WARM_ASKER);
    agentUnread("a-ask", { unreadFailure: true });
    taskUnread("t-warm", { unreadFailure: true });
    mount([task("t-warm", {})], { boundHere: true });

    expect(glyphLabel("t-warm")).toBe("1 needs attention");
  });
});

describe("<BotActivityPage /> a task that holds an unread failure and a pending ask counts each once", () => {
  const MIXED = [
    {
      flag: "pendingApproval",
      words: "1 needs attention · 1 waiting for approval",
    },
    {
      flag: "pendingInterview",
      words: "1 needs attention · 1 waiting for interview",
    },
    {
      flag: "pendingFork",
      words: "1 needs attention · 1 waiting for fork resolution",
    },
  ] as const;

  it.each(MIXED)(
    "counts a known agent's unread failure once and the task's $flag as its own ask",
    ({ flag, words }) => {
      warmTask("t-warm", [
        { id: "a-fail", parentId: null, title: "Failed", archivedAt: null },
      ]);
      agentUnread("a-fail", { unreadFailure: true });
      taskUnread("t-warm", { unreadFailure: true, [flag]: true });
      mount([task("t-warm", {})], { boundHere: true });

      expect(glyphLabel("t-warm")).toBe(words);
    },
  );

  it.each(MIXED)(
    "counts a task's unread failure no known agent carries once, beside its $flag",
    ({ flag, words }) => {
      working({ "t-cold": { working: ["a-1"], turn: ["a-1"] } });
      taskUnread("t-cold", { unreadFailure: true, [flag]: true });
      mount([task("t-cold", {})], { boundHere: true });

      expect(glyphLabel("t-cold")).toBe(`${words} · 1 running`);
    },
  );

  it("counts the unread failure once and the approval once for a task with no agent at all", () => {
    taskUnread("t-bare", { unreadFailure: true, pendingApproval: true });
    mount([task("t-bare", {})], { boundHere: true });

    expect(glyphLabel("t-bare")).toBe(
      "1 needs attention · 1 waiting for approval",
    );
  });
});

/** A renderer-local stream failure of `chatId` in `epicId`, which `originHostId` produced. */
function localFailure(
  epicId: string,
  chatId: string,
  originHostId: string,
): void {
  // The store keeps rows only for a signed-in identity.
  useAppLocalNotificationsStore.getState().activateIdentity("user-ada");
  useAppLocalNotificationsStore.getState().upsert({
    id: `stream.transport.error:${originHostId}:${chatId}:test`,
    originHostId,
    updatedAt: NOW,
    readAt: null,
    kind: "stream.transport.error",
    sourceRef: chatId,
    payload: { kind: "chat", epicId, chatId },
    message: "Agent stream closed unexpectedly.",
    detail: null,
  });
}

/** Every way the remote answer for the task's hosts can fail to vouch. */
const UNVOUCHED = [
  {
    name: "indicator read pending",
    apply: () => {
      mocks.state.indicatorRead = "pending";
    },
  },
  {
    name: "indicator read failed",
    apply: () => {
      mocks.state.indicatorRead = "error";
    },
  },
  {
    name: "indicator read unanswered",
    apply: () => {
      mocks.state.indicatorRead = "unanswered";
    },
  },
  {
    name: "hosts unreachable",
    apply: () => {
      mocks.state.unreachable.add("host-notifications");
      mocks.state.unreachable.add("host-a");
    },
  },
] as const;

function agentKinds(
  taskId: string,
): ReadonlyArray<[string | null, string | null]> {
  return within(row(taskId))
    .getAllByTestId("bot-activity-agent")
    .map((el) => [
      el.getAttribute("data-agent-id"),
      el.getAttribute("data-kind"),
    ]);
}

describe("<BotActivityPage /> an app-local failure is a local fact, whatever the host's remote answer", () => {
  it.each(UNVOUCHED)(
    "keeps a task that holds one listed, as unseen, with its glyph, while the $name",
    ({ apply }) => {
      mocks.state.feedMode = "cloud";
      apply();
      localFailure("t-cold", "a-x", "host-a");
      mount([task("t-cold", {})], { boundHere: true });

      expect(rowIds()).toEqual(["t-cold"]);
      expect(row("t-cold").getAttribute("data-band")).toBe("unseen");
      expect(glyphLabel("t-cold")).toBe("1 needs attention");
    },
  );

  it.each(UNVOUCHED)(
    "keeps an agent's own listed with its failure kind while the $name",
    async ({ apply }) => {
      mocks.state.feedMode = "cloud";
      apply();
      warmTask("t-warm", [
        { id: "a-fail", parentId: null, title: "Failed", archivedAt: null },
        { id: "a-quiet", parentId: null, title: "Quiet", archivedAt: null },
      ]);
      localFailure("t-warm", "a-fail", "host-a");
      mount([task("t-warm", {})], { boundHere: true });
      await userEvent
        .setup()
        .click(within(row("t-warm")).getByTestId("bot-activity-task-chevron"));

      expect(agentKinds("t-warm")).toContainEqual(["a-fail", "failure"]);
      expect(glyphLabel("t-warm")).toBe("1 needs attention");
    },
  );

  it.each(UNVOUCHED)(
    "shows the local failure but none of the host's own unproven flags while the $name",
    ({ apply }) => {
      mocks.state.feedMode = "cloud";
      apply();
      warmTask("t-warm", [
        { id: "a-local", parentId: null, title: "Local", archivedAt: null },
        { id: "a-remote", parentId: null, title: "Remote", archivedAt: null },
      ]);
      localFailure("t-warm", "a-local", "host-a");
      mocks.state.chatFlags = { "a-remote": { pendingApproval: true } };
      mocks.state.epicFlags = { "t-warm": { pendingApproval: true } };
      mount([task("t-warm", {})], { boundHere: true });

      expect(glyphLabel("t-warm")).toBe("1 needs attention");
    },
  );

  it("counts the local failure and the host's vouched approval together once the host answers (control)", () => {
    mocks.state.feedMode = "cloud";
    warmTask("t-warm", [
      { id: "a-local", parentId: null, title: "Local", archivedAt: null },
      { id: "a-remote", parentId: null, title: "Remote", archivedAt: null },
    ]);
    localFailure("t-warm", "a-local", "host-a");
    mocks.state.chatFlags = { "a-remote": { pendingApproval: true } };
    mocks.state.epicFlags = { "t-warm": { pendingApproval: true } };
    mount([task("t-warm", {})], { boundHere: true });

    expect(glyphLabel("t-warm")).toBe(
      "1 needs attention · 1 waiting for approval",
    );
  });
});

describe("<BotActivityPage /> a row whose task band is unknown", () => {
  it("still names what a vouching agent host holds in its glyph, while the task's own read is unreachable", () => {
    mocks.state.feedMode = "cloud";
    mocks.state.unreachable.add("host-notifications");
    warmTask("t-warm", [
      { id: "a-ask", parentId: null, title: "Asker", archivedAt: null },
    ]);
    mocks.state.chatFlags = { "a-ask": { pendingApproval: true } };
    mount([task("t-warm", {})], { boundHere: true });

    expect(row("t-warm").getAttribute("data-band")).toBe("unknown");
    expect(glyphLabel("t-warm")).toBe("1 waiting for approval");
    expect(
      within(row("t-warm")).getByTestId("bot-activity-task-line").textContent,
    ).toContain("waiting on you");
  });

  it("says a fork waits on the person in its second line, though the band is unknown", () => {
    mocks.state.feedMode = "cloud";
    mocks.state.unreachable.add("host-notifications");
    warmTask("t-warm", [
      { id: "a-fork", parentId: null, title: "Forker", archivedAt: null },
    ]);
    mocks.state.chatFlags = { "a-fork": { pendingFork: true } };
    mount([task("t-warm", {})], { boundHere: true });

    expect(row("t-warm").getAttribute("data-band")).toBe("unknown");
    expect(
      within(row("t-warm")).getByTestId("bot-activity-task-line").textContent,
    ).toContain("waiting on you: a fork to resolve");
  });
});

describe("<BotActivityPage /> an expanded agent whose host cannot vouch", () => {
  const AGENTS: ReadonlyArray<WarmAgent> = [
    { id: "a-quiet", parentId: null, title: "Quiet", archivedAt: null },
    { id: "a-ask", parentId: null, title: "Asker", archivedAt: null },
  ];

  async function expandedKinds(): Promise<
    ReadonlyArray<[string | null, string | null]>
  > {
    await userEvent
      .setup()
      .click(within(row("t-warm")).getByTestId("bot-activity-task-chevron"));
    return agentKinds("t-warm");
  }

  it.each(UNVOUCHED)(
    "reads unknown, not idle, for an agent with nothing known while the $name",
    async ({ apply }) => {
      mocks.state.feedMode = "cloud";
      apply();
      warmTask("t-warm", AGENTS);
      mount([task("t-warm", {})], { boundHere: true });

      expect(await expandedKinds()).toEqual([
        ["a-quiet", "unknown"],
        ["a-ask", "unknown"],
      ]);
    },
  );

  it("reads idle for the quiet agent and the host's own flag for the other once the host vouches (control)", async () => {
    mocks.state.feedMode = "cloud";
    warmTask("t-warm", AGENTS);
    mocks.state.chatFlags = { "a-ask": { pendingApproval: true } };
    mount([task("t-warm", { inputNeeded: [] })], { boundHere: true });

    expect(await expandedKinds()).toEqual([
      ["a-quiet", "idle"],
      ["a-ask", "approval"],
    ]);
  });
});

async function expandRow(taskId: string): Promise<void> {
  await userEvent
    .setup()
    .click(within(row(taskId)).getByRole("button", { name: "Show agents" }));
}

const FORK_WORDS = "1 waiting for fork resolution";
const INTERVIEW_WORDS = "1 waiting for interview";
const APPROVAL_WORDS = "1 waiting for approval";

describe("<BotActivityPage /> distinct pending kinds the task holds are each counted", () => {
  const ASKER: ReadonlyArray<WarmAgent> = [
    { id: "a-ask", parentId: null, title: "Asker", archivedAt: null },
  ];

  it.each([
    {
      name: "interview and approval",
      flags: ["pendingInterview", "pendingApproval"],
      words: `${INTERVIEW_WORDS} · ${APPROVAL_WORDS}`,
    },
    {
      name: "fork and interview",
      flags: ["pendingFork", "pendingInterview"],
      words: `${FORK_WORDS} · ${INTERVIEW_WORDS}`,
    },
    {
      name: "fork and approval",
      flags: ["pendingFork", "pendingApproval"],
      words: `${FORK_WORDS} · ${APPROVAL_WORDS}`,
    },
    {
      name: "fork, interview and approval",
      flags: ["pendingFork", "pendingInterview", "pendingApproval"],
      words: `${FORK_WORDS} · ${INTERVIEW_WORDS} · ${APPROVAL_WORDS}`,
    },
  ] as const)(
    "no known agent carries $name: one of each",
    ({ flags, words }) => {
      warmTask("t-warm", ASKER);
      taskUnread(
        "t-warm",
        Object.fromEntries(flags.map((flag) => [flag, true])),
      );
      mount([task("t-warm", {})], { boundHere: true });

      expect(glyphLabel("t-warm")).toBe(words);
    },
  );

  it.each([
    {
      name: "approval",
      own: "pendingApproval",
      flags: ["pendingInterview", "pendingApproval"],
      words: `${INTERVIEW_WORDS} · ${APPROVAL_WORDS}`,
    },
    {
      name: "interview",
      own: "pendingInterview",
      flags: ["pendingInterview", "pendingApproval"],
      words: `${INTERVIEW_WORDS} · ${APPROVAL_WORDS}`,
    },
    {
      name: "approval",
      own: "pendingApproval",
      flags: ["pendingFork", "pendingInterview", "pendingApproval"],
      words: `${FORK_WORDS} · ${INTERVIEW_WORDS} · ${APPROVAL_WORDS}`,
    },
    {
      name: "interview",
      own: "pendingInterview",
      flags: ["pendingFork", "pendingInterview", "pendingApproval"],
      words: `${FORK_WORDS} · ${INTERVIEW_WORDS} · ${APPROVAL_WORDS}`,
    },
    {
      name: "fork",
      own: "pendingFork",
      flags: ["pendingFork", "pendingInterview", "pendingApproval"],
      words: `${FORK_WORDS} · ${INTERVIEW_WORDS} · ${APPROVAL_WORDS}`,
    },
  ] as const)(
    "a known agent carries its own $name beside the task's pending kinds: still one of each",
    ({ own, flags, words }) => {
      warmTask("t-warm", ASKER);
      agentUnread("a-ask", { [own]: true });
      taskUnread(
        "t-warm",
        Object.fromEntries(flags.map((flag) => [flag, true])),
      );
      mount([task("t-warm", {})], { boundHere: true });

      expect(glyphLabel("t-warm")).toBe(words);
    },
  );
});

/** `hostId`'s activity stream is open with its state frame landed, claiming only its own agents. */
function planeAnswers(
  hostId: string,
  byEpic: Record<string, { working: string[]; turn: string[] }>,
): void {
  __setHostAgentActivityStateForTests(hostId, byEpic, "local", null);
  __setHostAgentActivityHealthForTests(hostId, {
    connectionStatus: "open",
    stateFrameSeenThisEpoch: true,
  });
}

/** `hostId`'s stream answered, then dropped: its slice is held, and no one vouches for it. */
function planeHeld(
  hostId: string,
  byEpic: Record<string, { working: string[]; turn: string[] }>,
): void {
  planeAnswers(hostId, byEpic);
  __setHostAgentActivityHealthForTests(hostId, {
    connectionStatus: "reconnecting",
  });
}

describe("<BotActivityPage /> a fresh cloud unread stands without the host's partition answering", () => {
  const QUIET_UNSEEN = (): BotTaskEntry =>
    completed("t-x", { lastCheckinAt: NOW });

  it.each(UNVOUCHED)(
    "lists the task as unseen, with its completed glyph, while the $name",
    ({ apply }) => {
      mocks.state.feedMode = "cloud";
      holdCloudFeed([remoteUnseenResult("t-x", "chat-t-x", "host-remote")]);
      apply();
      mount([QUIET_UNSEEN()], { boundHere: true });

      expect(rowIds()).toEqual(["t-x"]);
      expect(band("t-x")).toBe("unseen");
      expect(glyphLabel("t-x")).toBe("1 completed");
    },
  );

  it("lists it as unseen when the partition answers too (control)", () => {
    mocks.state.feedMode = "cloud";
    holdCloudFeed([remoteUnseenResult("t-x", "chat-t-x", "host-remote")]);
    mount([QUIET_UNSEEN()], { boundHere: true });

    expect(band("t-x")).toBe("unseen");
  });

  it("keeps it unknown when the cloud feed is disconnected and the partition is pending: no source holds the unread", () => {
    mocks.state.feedMode = "cloud";
    mocks.state.indicatorRead = "pending";
    mountInCloudMode([QUIET_UNSEEN()], { connected: false });

    expect(band("t-x")).toBe("unknown");
  });

  it("keeps a task with no cloud row unknown while the partition is pending: absence is not proved", () => {
    mocks.state.feedMode = "cloud";
    holdCloudFeed([]);
    mocks.state.indicatorRead = "pending";
    mount([QUIET_UNSEEN()], { boundHere: true });

    expect(band("t-x")).toBe("unknown");
  });
});

describe("<BotActivityPage /> an agent's fresh cloud unread stands without its host's partition answering", () => {
  const AGENTS: ReadonlyArray<WarmAgent> = [
    { id: "a-done", parentId: null, title: "Finished", archivedAt: null },
    { id: "a-quiet", parentId: null, title: "Quiet", archivedAt: null },
  ];

  it.each(UNVOUCHED)("reads it done while the $name", async ({ apply }) => {
    mocks.state.feedMode = "cloud";
    // An agent's chat reports from the host that owns it.
    holdCloudFeed([remoteUnseenResult("t-warm", "a-done", "host-a")]);
    apply();
    warmTask("t-warm", AGENTS);
    mount([task("t-warm", { inputNeeded: [] })], { boundHere: true });
    await expandRow("t-warm");

    expect(agentKinds("t-warm")).toContainEqual(["a-done", "done"]);
  });

  it("reads it unknown when the cloud feed is disconnected and the partition is pending: no source holds it", async () => {
    mocks.state.feedMode = "cloud";
    mocks.state.indicatorRead = "pending";
    warmTask("t-warm", AGENTS);
    mountInCloudMode([task("t-warm", { inputNeeded: [] })], {
      connected: false,
    });
    await expandRow("t-warm");

    expect(agentKinds("t-warm")).toContainEqual(["a-done", "unknown"]);
  });
});

describe("<BotActivityPage /> a host-local approval stands while the cloud feed is disconnected", () => {
  const AGENTS: ReadonlyArray<WarmAgent> = [
    { id: "a-live", parentId: null, title: "Lead", archivedAt: null },
    { id: "a-old", parentId: null, title: "Old", archivedAt: 5 },
  ];

  it("puts the task in needs-you from its own host's pending approval (control)", () => {
    mocks.state.feedMode = "cloud";
    mocks.state.epicFlags = { "t-x": { pendingApproval: true } };
    mountInCloudMode([task("t-x", {})], { connected: false });

    expect(band("t-x")).toBe("needs-you");
  });

  it("reveals an archived agent holding a host-local approval, and counts it once, with the cloud feed disconnected", async () => {
    mocks.state.feedMode = "cloud";
    warmTask("t-warm", AGENTS);
    mocks.state.chatFlags = { "a-old": { pendingApproval: true } };
    mocks.state.epicFlags = { "t-warm": { pendingApproval: true } };
    mountInCloudMode([task("t-warm", {})], { connected: false });
    await expandRow("t-warm");

    expect(agentKinds("t-warm")).toContainEqual(["a-old", "approval"]);
    expect(glyphLabel("t-warm")).toBe("1 waiting for approval");
  });

  it("reads a quiet agent unknown, not idle, with the cloud feed disconnected, and idle once it is connected (control)", async () => {
    mocks.state.feedMode = "cloud";
    warmTask("t-warm", AGENTS);
    mountInCloudMode([task("t-warm", {})], { connected: false });
    await expandRow("t-warm");
    expect(agentKinds("t-warm")).toEqual([["a-live", "unknown"]]);
  });

  it("reads a quiet agent idle with every source vouching (control)", async () => {
    mocks.state.feedMode = "cloud";
    warmTask("t-warm", AGENTS);
    mount([task("t-warm", { inputNeeded: [] })], { boundHere: true });
    await expandRow("t-warm");

    expect(agentKinds("t-warm")).toEqual([["a-live", "idle"]]);
  });
});

describe("<BotActivityPage /> an expanded agent whose activity stream is held", () => {
  const AGENTS: ReadonlyArray<WarmAgent> = [
    { id: "a-quiet", parentId: null, title: "Quiet", archivedAt: null },
    { id: "a-ask", parentId: null, title: "Asker", archivedAt: null },
  ];

  it("reads unknown, not idle, though the host's indicators answer freshly empty", async () => {
    __resetAgentActivityStoreForTests();
    mocks.state.feedMode = "cloud";
    planeHeld("host-a", {});
    warmTask("t-warm", AGENTS);
    mount([task("t-warm", { inputNeeded: [] })], { boundHere: true });
    await expandRow("t-warm");

    expect(agentKinds("t-warm")).toEqual([
      ["a-quiet", "unknown"],
      ["a-ask", "unknown"],
    ]);
  });

  it("still shows a fresh host fact on its own while the stream is held, and the quiet one unknown", async () => {
    __resetAgentActivityStoreForTests();
    mocks.state.feedMode = "cloud";
    planeHeld("host-a", {});
    warmTask("t-warm", AGENTS);
    mocks.state.chatFlags = { "a-ask": { pendingApproval: true } };
    mount([task("t-warm", { inputNeeded: [] })], { boundHere: true });
    await expandRow("t-warm");

    expect(agentKinds("t-warm")).toEqual([
      ["a-quiet", "unknown"],
      ["a-ask", "approval"],
    ]);
  });

  it("does not read running from a held slice's count", async () => {
    __resetAgentActivityStoreForTests();
    mocks.state.feedMode = "cloud";
    planeHeld("host-a", {
      "t-warm": { working: ["a-quiet"], turn: ["a-quiet"] },
    });
    warmTask("t-warm", AGENTS);
    mount([task("t-warm", { inputNeeded: [] })], { boundHere: true });
    await expandRow("t-warm");

    expect(agentKinds("t-warm")[0]).toEqual(["a-quiet", "unknown"]);
  });

  it("reads unknown for an agent whose host the answering stream does not cover", async () => {
    __resetAgentActivityStoreForTests();
    mocks.state.feedMode = "cloud";
    planeAnswers("host-elsewhere", {});
    warmTask("t-warm", AGENTS);
    mount([task("t-warm", { inputNeeded: [] })], { boundHere: true });
    await expandRow("t-warm");

    expect(agentKinds("t-warm")[0]).toEqual(["a-quiet", "unknown"]);
  });

  it.each([
    { inputNeeded: null, kind: "unknown" },
    { inputNeeded: [], kind: "idle" },
  ] as const)(
    "reads a quiet agent $kind when the task's waiting list is $inputNeeded, every other source vouching",
    async ({ inputNeeded, kind }) => {
      mocks.state.feedMode = "cloud";
      warmTask("t-warm", [
        { id: "a-live", parentId: null, title: "Lead", archivedAt: null },
      ]);
      mount(
        [
          task("t-warm", {
            inputNeeded: inputNeeded === null ? null : [...inputNeeded],
          }),
        ],
        { boundHere: true },
      );
      await expandRow("t-warm");

      expect(agentKinds("t-warm")).toEqual([["a-live", kind]]);
    },
  );

  it("reads idle when the agent's own host's stream is open with its state landed (control)", async () => {
    __resetAgentActivityStoreForTests();
    mocks.state.feedMode = "cloud";
    planeAnswers("host-a", {});
    warmTask("t-warm", AGENTS);
    mount([task("t-warm", { inputNeeded: [] })], { boundHere: true });
    await expandRow("t-warm");

    expect(agentKinds("t-warm")[0]).toEqual(["a-quiet", "idle"]);
  });
});

describe("<BotActivityPage /> an archived quiet agent with no attested positive stays folded away, whatever source is unknown", () => {
  const AGENTS: ReadonlyArray<WarmAgent> = [
    { id: "a-live", parentId: null, title: "Lead", archivedAt: null },
    { id: "a-old", parentId: null, title: "Old", archivedAt: 5 },
  ];
  const listed = (): ReadonlyArray<string | null> =>
    agentKinds("t-warm").map(([id]) => id);

  it.each(UNVOUCHED)("stays folded away while the $name", async ({ apply }) => {
    mocks.state.feedMode = "cloud";
    apply();
    warmTask("t-warm", AGENTS);
    mount([task("t-warm", {})], { boundHere: true });
    await expandRow("t-warm");

    expect(listed()).toEqual(["a-live"]);
  });

  it("stays folded away while the cloud feed is disconnected", async () => {
    mocks.state.feedMode = "cloud";
    warmTask("t-warm", AGENTS);
    mountInCloudMode([task("t-warm", {})], { connected: false });
    await expandRow("t-warm");

    expect(listed()).toEqual(["a-live"]);
  });

  it("stays folded away while its host's activity stream is held", async () => {
    __resetAgentActivityStoreForTests();
    mocks.state.feedMode = "cloud";
    planeHeld("host-a", {});
    warmTask("t-warm", AGENTS);
    mount([task("t-warm", {})], { boundHere: true });
    await expandRow("t-warm");

    expect(listed()).toEqual(["a-live"]);
  });

  it("stays folded away once every source vouches it quiet (control)", async () => {
    mocks.state.feedMode = "cloud";
    warmTask("t-warm", AGENTS);
    mount([task("t-warm", {})], { boundHere: true });
    await expandRow("t-warm");

    expect(listed()).toEqual(["a-live"]);
  });
});

describe("<BotActivityPage /> an archived agent the bot reports waiting stays listed whatever the read says", () => {
  const AGENTS: ReadonlyArray<WarmAgent> = [
    { id: "a-live", parentId: null, title: "Lead", archivedAt: null },
    { id: "a-old", parentId: null, title: "Old", archivedAt: 5 },
  ];

  async function openAgents(): Promise<
    ReadonlyArray<[string | null, string | null]>
  > {
    const user = userEvent.setup();
    await user.click(
      within(row("t-warm")).getByTestId("bot-activity-task-chevron"),
    );
    return screen
      .getAllByTestId("bot-activity-agent")
      .map((el) => [
        el.getAttribute("data-agent-id"),
        el.getAttribute("data-kind"),
      ]);
  }

  it.each(["pending", "error", "unanswered"] as const)(
    "lists it as waiting for approval while the host's indicator read is %s",
    async (read) => {
      mocks.state.feedMode = "cloud";
      mocks.state.indicatorRead = read;
      warmTask("t-warm", AGENTS);
      mount(
        [task("t-warm", { inputNeeded: [waiting("a-old", NOW, "Merge")] })],
        { boundHere: true },
      );

      expect(await openAgents()).toContainEqual(["a-old", "approval"]);
    },
  );

  it.each(["pending", "error", "unanswered"] as const)(
    "lists it as waiting for an interview while the host's indicator read is %s",
    async (read) => {
      mocks.state.feedMode = "cloud";
      mocks.state.indicatorRead = read;
      warmTask("t-warm", AGENTS);
      mount(
        [task("t-warm", { inputNeeded: [waitingQuestion("a-old", NOW)] })],
        { boundHere: true },
      );

      expect(await openAgents()).toContainEqual(["a-old", "interview"]);
    },
  );

  it("lists it once the read has answered, too", async () => {
    mocks.state.feedMode = "cloud";
    warmTask("t-warm", AGENTS);
    mount([task("t-warm", { inputNeeded: [waiting("a-old", NOW, "Merge")] })], {
      boundHere: true,
    });

    expect(await openAgents()).toContainEqual(["a-old", "approval"]);
  });

  it.each(["pending", "error"] as const)(
    "keeps an archived agent nothing waits on folded away while the read is %s",
    async (read) => {
      mocks.state.feedMode = "cloud";
      mocks.state.indicatorRead = read;
      warmTask("t-warm", AGENTS);
      mount(
        [task("t-warm", { inputNeeded: [waiting("a-live", NOW, "Merge")] })],
        { boundHere: true },
      );

      expect((await openAgents()).map(([id]) => id)).toEqual(["a-live"]);
    },
  );

  it("agrees with the row's glyph, which already counts that agent once", () => {
    mocks.state.feedMode = "cloud";
    mocks.state.indicatorRead = "pending";
    warmTask("t-warm", AGENTS);
    mount([task("t-warm", { inputNeeded: [waiting("a-old", NOW, "Merge")] })], {
      boundHere: true,
    });

    expect(glyphLabel("t-warm")).toBe("1 waiting for approval");
  });
});

describe("<BotActivityPage /> agents on several hosts", () => {
  it.each(["local", "cloud"] as const)(
    "rule 3: an agent on another host than its task's session is read from the host that owns it (%s feed)",
    async (feedMode) => {
      mocks.state.feedMode = feedMode;
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
    },
  );
});

describe("<BotActivityPage /> an agent's host that cannot vouch", () => {
  it.each(["local", "cloud"] as const)(
    "never shows a fork an agent's own host reported before that host became unreachable, while the lead's host still answers (%s feed)",
    (feedMode) => {
      mocks.state.feedMode = feedMode;
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
      mocks.state.chatFlagsByHost = {
        "host-b": { "a-remote": { pendingFork: true } },
      };
      const view = render(
        <Harness
          threads={[]}
          tasks={[periodic("t-split", {})]}
          boundHere
          notificationSubscriptions={null}
        />,
      );
      // Current while host-b answers and is reachable.
      expect(
        within(row("t-split"))
          .getByTestId("bot-activity-task-glyph")
          .getAttribute("aria-label"),
      ).toBe("1 waiting for fork resolution");

      mocks.state.unreachable.add("host-b");
      view.rerender(
        <Harness
          threads={[]}
          tasks={[periodic("t-split", {})]}
          boundHere
          notificationSubscriptions={null}
        />,
      );

      expect(
        within(row("t-split"))
          .queryByTestId("bot-activity-task-glyph")
          ?.getAttribute("aria-label") ?? null,
      ).not.toBe("1 waiting for fork resolution");
    },
  );
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

  it("a cold scheduled task no surface waits on says its status is unknown, without naming a host", () => {
    mocks.state.unreachable.add("host-agents");
    mount([periodic("t-every", {})], { boundHere: true });

    const text = row("t-every").textContent;
    expect(text).toContain("Status unknown");
    expect(text).not.toContain("offline");
    expect(text).not.toContain("Studio Mac");
    expect(
      within(row("t-every")).queryByTestId("bot-activity-task-offline"),
    ).toBeNull();
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
  it.each(["local", "cloud"] as const)(
    "rule 4: a warm task folds its agents under a chevron, in tree order, each with its own state (%s feed)",
    async (feedMode) => {
      mocks.state.feedMode = feedMode;
      const user = userEvent.setup();
      warmTask("t-warm", [
        {
          id: "a-root",
          parentId: null,
          title: "Release lead",
          archivedAt: null,
        },
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
      mount([task("t-warm", { inputNeeded: [] })], { boundHere: true });

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
    },
  );

  it.each(["local", "cloud"] as const)(
    "rule 4: an archived agent stays folded away unless it is working or holds something unread (%s feed)",
    async (feedMode) => {
      mocks.state.feedMode = feedMode;
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
    },
  );

  it("rule 4: a cold task, whose agents this window cannot name, has no chevron", () => {
    working({ "t-cold": { working: ["a-1"], turn: ["a-1"] } });
    mount([task("t-cold", {})], { boundHere: true });

    expect(
      within(row("t-cold")).queryByTestId("bot-activity-task-chevron"),
    ).toBeNull();
  });
});
