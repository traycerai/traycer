/**
 * The Activity tab's recent tasks: tasks that ended are listed below the
 * active ones with the reason they ended, over the real `bot.subscribe`
 * snapshot, subscription hook, active-task hook and page. Transitions the
 * session saw come first, newest observed first; rows the session never saw
 * end follow in reverse server creation order. Only the host transport edges
 * are stood in for.
 */
import {
  BOT_ID,
  HOST_ID,
  wireTask,
  snapshotWith,
} from "./bot-activity-stream-fixture";
import { useAuthStore } from "@/stores/auth/auth-store";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BotSubscribeServerFrame } from "@traycer/protocol/host/bot/schemas";
import { BotActivityPage } from "@/components/bots/bot-activity-page";
import {
  __resetBotSubscriptionsForTesting,
  useBotSubscriptionForClient,
} from "@/hooks/bots/use-bot-subscription";
import { BOT_SEARCH_PAGE_SIZE } from "@/lib/bots/bot-search-model";
import { useBotActiveTasks } from "@/hooks/bots/use-bot-active-tasks";
import {
  __resetAgentActivityStoreForTests,
  __setAgentActivityPlaneAnsweringForTests,
  __setAgentActivityStateForTests,
} from "@/stores/agent-activity-store";
import { NotificationFeedModeContext } from "@/lib/notifications/notification-feed-mode-context";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";
import {
  StubHostStreamClient,
  StubSession,
} from "@/hooks/bots/__tests__/bot-subscribe-stub-stream";

const mocks = vi.hoisted(() => ({
  taskTitles: {} as Record<string, string>,
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/lib/tab-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tab-navigation")>()),
  navigateToTabIntent: vi.fn(),
  activateTabIntent: vi.fn(),
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => ({ stub: "tab-host-client" }),
}));
vi.mock("@/hooks/epic/use-epic-get-task-contexts-query", () => ({
  useEpicGetTaskContexts: () => ({
    tasksById: new Map(
      Object.entries(mocks.taskTitles).map(([taskId, title]) => [
        taskId,
        { epic: { light: { title } } },
      ]),
    ),
  }),
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => false,
}));
vi.mock("@/hooks/bots/use-bot-activity", () => ({
  useBotActivity: () => null,
}));
vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({ status: "reachable" }),
}));
vi.mock("@/hooks/bots/use-bot-task-action-mutations", () => {
  const idle = () => ({
    mutate: vi.fn(),
    isPending: false,
    variables: undefined,
  });
  return {
    useBotTaskRunNowMutation: idle,
    useBotTaskSetPausedMutation: idle,
    useBotTaskStopMutation: idle,
  };
});
vi.mock("@/components/epic-canvas/sidebar/use-chat-row-open-ref", () => ({
  useChatRowOpenRef: () => () => ({ type: "chat", id: "opened" }),
}));
vi.mock("@/hooks/notifications/use-notification-host", () => ({
  useNotificationResolveHostId: () => "host-notifications",
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => ({ hostId }),
}));
// The host holds no unread result for any task: every indicator read answers
// complete and empty.
vi.mock("@/hooks/host/use-host-queries", () => ({
  useHostQueries: (args: {
    requests: ReadonlyArray<unknown>;
    combine: (results: ReadonlyArray<unknown>) => unknown;
  }) =>
    args.combine(
      args.requests.map(() => ({
        data: { epics: {}, chats: {}, complete: true },
        isPending: false,
        isFetching: false,
        error: null,
        refetch: () => Promise.resolve(),
      })),
    ),
}));

const NOW = Date.now();

function mountOver(session: StubSession): void {
  const streamClient = new StubHostStreamClient(session);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Page(): ReactNode {
    const subscription = useBotSubscriptionForClient({
      hostId: HOST_ID,
      botId: BOT_ID,
      enabled: true,
      client: streamClient,
    });
    const tasks = subscription.snapshot?.tasks ?? [];
    const active = useBotActiveTasks(
      tasks,
      HOST_ID,
      subscription.snapshotFresh,
      BOT_ID,
    );
    if (subscription.snapshot === null) return null;
    return (
      <BotActivityPage
        roomFresh={active.roomFresh}
        botId={BOT_ID}
        hostId={HOST_ID}
        boundHere
        active={active}
        notificationSubscriptions={
          subscription.snapshot.notificationSubscriptions
        }
        trunkChatId="trunk-1"
        onOpenSession={vi.fn()}
        resolveMember={() => null}
        threads={[]}
      />
    );
  }
  render(
    <NotificationFeedModeContext.Provider value="cloud">
      <QueryClientProvider client={queryClient}>
        <Page />
      </QueryClientProvider>
    </NotificationFeedModeContext.Provider>,
  );
}

const OTHER_BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAW";

function snapshotForBot(
  botId: string,
  tasks: ReadonlyArray<object>,
): BotSubscribeServerFrame {
  const frame = snapshotWith(tasks, []);
  if (frame.kind !== "snapshot") throw new Error("not a snapshot");
  return { ...frame, bot: { ...frame.bot, botId } };
}

/**
 * The active-task hook stays mounted the way the tab surface keeps it while
 * the Activity page is shown or not, and across a switch of bot.
 */
function SwitchableTab(props: {
  readonly streamClient: StubHostStreamClient;
  readonly botId: string;
  readonly showPage: boolean;
}): ReactNode {
  const subscription = useBotSubscriptionForClient({
    hostId: HOST_ID,
    botId: props.botId,
    enabled: true,
    client: props.streamClient,
  });
  const active = useBotActiveTasks(
    subscription.snapshot?.tasks ?? [],
    HOST_ID,
    subscription.snapshotFresh,
    props.botId,
  );
  if (subscription.snapshot === null || !props.showPage) return null;
  return (
    <BotActivityPage
      roomFresh={active.roomFresh}
      botId={props.botId}
      hostId={HOST_ID}
      boundHere
      active={active}
      notificationSubscriptions={
        subscription.snapshot.notificationSubscriptions
      }
      trunkChatId="trunk-1"
      onOpenSession={vi.fn()}
      resolveMember={() => null}
      threads={[]}
    />
  );
}

type TabProps = Parameters<typeof SwitchableTab>[0];

function tabTree(queryClient: QueryClient, props: TabProps): ReactNode {
  return (
    <NotificationFeedModeContext.Provider value="cloud">
      <QueryClientProvider client={queryClient}>
        <SwitchableTab {...props} />
      </QueryClientProvider>
    </NotificationFeedModeContext.Provider>
  );
}

beforeEach(() => {
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId: "user-a", userName: "Ada", email: "ada@example.com" },
    contextMetadata: { userId: "user-a", username: "ada" },
  });
  mocks.taskTitles = {};
  __resetAgentActivityStoreForTests();
  // The activity plane vouches the whole fleet, so a quiet seen task can leave.
  __setAgentActivityPlaneAnsweringForTests();
  __setAgentActivityStateForTests({}, "cloud", "connected");
  // The cloud feed answers too, so both sources vouch for a quiet seen task.
  useCloudNotificationsStore.setState({
    hasSnapshot: true,
    connectionState: "connected",
  });
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({
    status: "signed-out",
    profile: null,
    contextMetadata: null,
  });
  useCloudNotificationsStore.getState().reset();
  __resetBotSubscriptionsForTesting();
  __resetAgentActivityStoreForTests();
});

const WAITING_APPROVAL = {
  hostId: HOST_ID,
  hostName: "This host",
  agentChatId: "chat-1",
  surfaceId: "approval-1",
  surface: {
    kind: "approval",
    approvalId: "approval-1",
    tool: "shell",
    summary: "Run it",
    tier: null,
    requiresPerson: true,
    askedAt: NOW,
  },
  reportedAt: NOW,
  acceptsActions: true,
};

function ended(taskId: string, reason: string): object {
  return wireTask(taskId, {
    inputNeeded: [],
    cadence: { kind: "none" },
    state: "ended",
    endedReason: reason,
  });
}

function tracking(taskId: string): object {
  return wireTask(taskId, {
    inputNeeded: [],
    cadence: { kind: "every", seconds: 7_200 },
  });
}

function endedRows(): ReadonlyArray<HTMLElement> {
  return screen.queryAllByTestId("bot-activity-ended-task");
}

function activeRows(): ReadonlyArray<HTMLElement> {
  return screen.queryAllByTestId("bot-activity-task");
}

describe("the Activity tab's recent tasks over a bot.subscribe snapshot", () => {
  it("lists ended tasks below the active ones, each with the reason it ended, and never a deleted one", () => {
    mocks.taskTitles = {
      "t-completed": "Finished build",
      "t-archived": "Old triage",
      "t-by-bot": "Stopped watch",
      "t-deleted": "Gone",
    };
    const session = new StubSession();
    mountOver(session);
    act(() =>
      session.emit(
        snapshotWith(
          [
            ended("t-completed", "completed"),
            tracking("t-live"),
            ended("t-archived", "archived"),
            ended("t-by-bot", "by-bot"),
            ended("t-deleted", "deleted"),
          ],
          [],
        ),
      ),
    );

    expect(activeRows()).toHaveLength(1);
    const rows = endedRows();
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Stopped watch"),
      expect.stringContaining("Old triage"),
      expect.stringContaining("Finished build"),
    ]);
    const live = activeRows()[0];
    expect(
      live.compareDocumentPosition(rows[0]) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      rows.map(
        (row) =>
          within(row).getByTestId("bot-activity-ended-reason").textContent,
      ),
    ).toEqual(["Tracking stopped", "Tracking ended", "Check-in completed"]);
    expect(screen.queryByText("Gone")).toBeNull();
  });

  it("shows the first page of ended rows, then the next on Show older, and never ages one out", () => {
    vi.useFakeTimers();
    const session = new StubSession();
    mountOver(session);
    const total = BOT_SEARCH_PAGE_SIZE + 5;
    act(() =>
      session.emit(
        snapshotWith(
          Array.from({ length: total }, (_value, index) =>
            ended(`t-ended-${index}`, "completed"),
          ),
          [],
        ),
      ),
    );

    expect(endedRows()).toHaveLength(BOT_SEARCH_PAGE_SIZE);
    act(() => {
      vi.advanceTimersByTime(7 * 24 * 3_600_000);
    });
    expect(endedRows()).toHaveLength(BOT_SEARCH_PAGE_SIZE);

    fireEvent.click(screen.getByRole("button", { name: "Show older" }));
    expect(endedRows()).toHaveLength(total);
    expect(screen.queryByRole("button", { name: "Show older" })).toBeNull();
  });

  it("puts tasks the session saw end first, newest observed first, then the rest in reverse server order", () => {
    mocks.taskTitles = {
      "t-first": "First to end",
      "t-second": "Second to end",
      "t-old-a": "Old A",
      "t-old-b": "Old B",
    };
    const session = new StubSession();
    mountOver(session);
    const oldA = ended("t-old-a", "completed");
    const oldB = ended("t-old-b", "completed");
    act(() =>
      session.emit(
        snapshotWith(
          [oldA, oldB, tracking("t-first"), tracking("t-second")],
          [],
        ),
      ),
    );
    act(() =>
      session.emit(
        snapshotWith(
          [oldA, oldB, ended("t-first", "by-bot"), tracking("t-second")],
          [],
        ),
      ),
    );
    act(() =>
      session.emit(
        snapshotWith(
          [
            oldA,
            oldB,
            ended("t-first", "by-bot"),
            ended("t-second", "archived"),
          ],
          [],
        ),
      ),
    );

    expect(endedRows().map((row) => row.textContent)).toEqual([
      expect.stringContaining("Second to end"),
      expect.stringContaining("First to end"),
      expect.stringContaining("Old B"),
      expect.stringContaining("Old A"),
    ]);
    expect(screen.queryAllByTestId("bot-activity-ended-at")).toHaveLength(0);
  });

  it("keeps an ended task that still waits on a person visible once, as ended with its attention, and not among the active rows or the count", () => {
    mocks.taskTitles = { "t-waiting": "Needs an answer" };
    const session = new StubSession();
    mountOver(session);
    act(() =>
      session.emit(
        snapshotWith(
          [
            wireTask("t-waiting", {
              cadence: { kind: "none" },
              state: "ended",
              endedReason: "completed",
              inputNeeded: [WAITING_APPROVAL],
            }),
          ],
          [],
        ),
      ),
    );

    expect(activeRows()).toHaveLength(0);
    expect(endedRows()).toHaveLength(1);
    expect(screen.getAllByText("Needs an answer")).toHaveLength(1);
    const row = endedRows()[0];
    expect(
      within(row).getByTestId("bot-activity-ended-reason").textContent,
    ).toBe("Check-in completed");
    expect(row.textContent).toContain("Needs you");
  });

  it("lists already-ended on-completion check-ins as recent, not active, once each, beside a still-tracking one that stays active", () => {
    mocks.taskTitles = {
      "t-checkin-a": "Check-in A",
      "t-checkin-b": "Check-in B",
      "t-checkin-live": "Check-in live",
    };
    const endedCheckin = (taskId: string): object =>
      wireTask(taskId, {
        cadence: { kind: "on-completion" },
        state: "ended",
        endedReason: "completed",
        inputNeeded: [],
        lastCheckinAt: NOW,
      });
    const session = new StubSession();
    mountOver(session);
    act(() =>
      session.emit(
        snapshotWith(
          [
            endedCheckin("t-checkin-a"),
            endedCheckin("t-checkin-b"),
            wireTask("t-checkin-live", {
              cadence: { kind: "on-completion" },
              inputNeeded: [],
            }),
          ],
          [],
        ),
      ),
    );

    expect(activeRows().map((row) => row.textContent)).toEqual([
      expect.stringContaining("Check-in live"),
    ]);
    expect(endedRows().map((row) => row.textContent)).toEqual([
      expect.stringContaining("Check-in B"),
      expect.stringContaining("Check-in A"),
    ]);
    for (const title of ["Check-in A", "Check-in B", "Check-in live"]) {
      expect(screen.getAllByText(title)).toHaveLength(1);
    }
  });

  it("does not count ended tasks toward the Activity count", () => {
    const session = new StubSession();
    const streamClient = new StubHostStreamClient(session);
    function Count(): ReactNode {
      const subscription = useBotSubscriptionForClient({
        hostId: HOST_ID,
        botId: BOT_ID,
        enabled: true,
        client: streamClient,
      });
      const active = useBotActiveTasks(
        subscription.snapshot?.tasks ?? [],
        HOST_ID,
        subscription.snapshotFresh,
        BOT_ID,
      );
      return <output data-testid="count">{active.rows.length}</output>;
    }
    render(
      <NotificationFeedModeContext.Provider value="cloud">
        <QueryClientProvider client={new QueryClient()}>
          <Count />
        </QueryClientProvider>
      </NotificationFeedModeContext.Provider>,
    );
    act(() =>
      session.emit(
        snapshotWith(
          [
            ended("t-a", "completed"),
            ended("t-b", "by-bot"),
            {
              ...ended("t-c", "completed"),
              inputNeeded: [WAITING_APPROVAL],
            },
          ],
          [],
        ),
      ),
    );

    expect(screen.getByTestId("count").textContent).toBe("0");
  });

  it("shows the ended rows a reload delivers, each with its reason and no finished time, and claims nothing about rows the server pruned", () => {
    const session = new StubSession();
    mountOver(session);
    const delivered = BOT_SEARCH_PAGE_SIZE + 3;
    act(() =>
      session.emit(
        snapshotWith(
          Array.from({ length: delivered }, (_value, index) =>
            ended(`t-ended-${index}`, "completed"),
          ),
          [],
        ),
      ),
    );

    const rows = endedRows();
    expect(rows).toHaveLength(BOT_SEARCH_PAGE_SIZE);
    for (const row of rows) {
      expect(within(row).getByTestId("bot-activity-ended-reason")).toBeTruthy();
      expect(within(row).queryByTestId("bot-activity-ended-at")).toBeNull();
    }
    fireEvent.click(screen.getByRole("button", { name: "Show older" }));
    expect(endedRows()).toHaveLength(delivered);
  });
});

describe("the Activity tab's observed order is kept by the mounted tab, not by the page", () => {
  it("keeps the order of transitions seen while the Activity page was not shown", () => {
    mocks.taskTitles = {
      "t-first": "First to end",
      "t-second": "Second to end",
      "t-old": "Old one",
    };
    const session = new StubSession();
    const streamClient = new StubHostStreamClient(session);
    const queryClient = new QueryClient();
    const view = render(
      tabTree(queryClient, { streamClient, botId: BOT_ID, showPage: false }),
    );
    const old = ended("t-old", "completed");
    act(() =>
      session.emit(
        snapshotWith([old, tracking("t-first"), tracking("t-second")], []),
      ),
    );
    act(() =>
      session.emit(
        snapshotWith(
          [old, ended("t-first", "by-bot"), tracking("t-second")],
          [],
        ),
      ),
    );
    act(() =>
      session.emit(
        snapshotWith(
          [old, ended("t-first", "by-bot"), ended("t-second", "archived")],
          [],
        ),
      ),
    );

    view.rerender(
      tabTree(queryClient, { streamClient, botId: BOT_ID, showPage: true }),
    );

    expect(endedRows().map((row) => row.textContent)).toEqual([
      expect.stringContaining("Second to end"),
      expect.stringContaining("First to end"),
      expect.stringContaining("Old one"),
    ]);
  });

  it("does not carry one bot's observed endings over to another bot's list", () => {
    mocks.taskTitles = { "t-a": "Task A", "t-b": "Task B" };
    const sessionOne = new StubSession();
    const sessionTwo = new StubSession();
    const clientOne = new StubHostStreamClient(sessionOne);
    const clientTwo = new StubHostStreamClient(sessionTwo);
    const queryClient = new QueryClient();
    const view = render(
      tabTree(queryClient, {
        streamClient: clientOne,
        botId: BOT_ID,
        showPage: true,
      }),
    );
    act(() =>
      sessionOne.emit(
        snapshotForBot(BOT_ID, [tracking("t-a"), ended("t-b", "completed")]),
      ),
    );
    act(() =>
      sessionOne.emit(
        snapshotForBot(BOT_ID, [
          ended("t-a", "by-bot"),
          ended("t-b", "completed"),
        ]),
      ),
    );
    expect(endedRows()[0].textContent).toContain("Task A");

    view.rerender(
      tabTree(queryClient, {
        streamClient: clientTwo,
        botId: OTHER_BOT_ID,
        showPage: true,
      }),
    );
    act(() =>
      sessionTwo.emit(
        snapshotForBot(OTHER_BOT_ID, [
          ended("t-a", "by-bot"),
          ended("t-b", "completed"),
        ]),
      ),
    );

    expect(endedRows().map((row) => row.textContent)).toEqual([
      expect.stringContaining("Task B"),
      expect.stringContaining("Task A"),
    ]);
  });

  it("does not carry observed endings over to another signed-in account", () => {
    mocks.taskTitles = { "t-a": "Task A", "t-b": "Task B" };
    const session = new StubSession();
    const streamClient = new StubHostStreamClient(session);
    const queryClient = new QueryClient();
    const view = render(
      tabTree(queryClient, { streamClient, botId: BOT_ID, showPage: true }),
    );
    act(() =>
      session.emit(
        snapshotWith([tracking("t-a"), ended("t-b", "completed")], []),
      ),
    );
    act(() =>
      session.emit(
        snapshotWith([ended("t-a", "by-bot"), ended("t-b", "completed")], []),
      ),
    );
    expect(endedRows()[0].textContent).toContain("Task A");

    act(() =>
      useAuthStore.setState({
        profile: {
          userId: "user-b",
          userName: "Bea",
          email: "bea@example.com",
        },
        contextMetadata: { userId: "user-b", username: "bea" },
      }),
    );
    const secondSession = new StubSession();
    view.rerender(
      tabTree(queryClient, {
        streamClient: new StubHostStreamClient(secondSession),
        botId: BOT_ID,
        showPage: true,
      }),
    );
    act(() =>
      secondSession.emit(
        snapshotWith([ended("t-a", "by-bot"), ended("t-b", "completed")], []),
      ),
    );

    expect(endedRows().map((row) => row.textContent)).toEqual([
      expect.stringContaining("Task B"),
      expect.stringContaining("Task A"),
    ]);
  });
});
