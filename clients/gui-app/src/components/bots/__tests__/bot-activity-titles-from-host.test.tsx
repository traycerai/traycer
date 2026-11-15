/**
 * The Activity tab's task titles over a real `epic.getTaskContexts` read: the
 * real `useEpicGetTaskContexts` and `useHostQueries` run, and only the host
 * client's request boundary answers (a found title, a failed read, a task the
 * host does not resolve). The subscription is a real `bot.subscribe` snapshot
 * through the real subscription hook, as in `bot-activity-from-stream`.
 */
import {
  BOT_ID,
  HOST_ID,
  wireTask,
  snapshotWith,
} from "./bot-activity-stream-fixture";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GET_TASK_CONTEXTS_MAX_IDS,
  type GetTaskContextsResponse,
  type ListTaskLight,
} from "@traycer/protocol/host/epic/unary-schemas";
import { BotActivityPage } from "@/components/bots/bot-activity-page";
import {
  __resetBotSubscriptionsForTesting,
  useBotSubscriptionForClient,
} from "@/hooks/bots/use-bot-subscription";
import { useBotActiveTasks } from "@/hooks/bots/use-bot-active-tasks";
import {
  __resetAgentActivityStoreForTests,
  __setAgentActivityPlaneAnsweringForTests,
  __setAgentActivityStateForTests,
} from "@/stores/agent-activity-store";
import { NotificationFeedModeContext } from "@/lib/notifications/notification-feed-mode-context";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  StubHostStreamClient,
  StubSession,
} from "@/hooks/bots/__tests__/bot-subscribe-stub-stream";

const mocks = vi.hoisted(() => {
  const request = vi.fn<(...args: unknown[]) => Promise<unknown>>();
  return {
    request,
    hostClient: {
      getActiveHostId: () => "host-titles",
      getRequestContextUserId: () => "user-titles",
      onChange: () => () => undefined,
      request,
      requestWithSignal: request,
    },
  };
});

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/lib/tab-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tab-navigation")>()),
  navigateToTabIntent: vi.fn(),
  activateTabIntent: vi.fn(),
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => ({ stub: "tab-host-client" }),
}));
// The host client: its request boundary is the one seam a title read crosses.
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => mocks.hostClient,
  useHostRuntimeClient: () => mocks.hostClient,
}));
vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({
    hostId: "host-titles",
    isReady: true,
    hasRpcEndpoint: true,
    canExecute: true,
    requestContextUserId: "user-titles",
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
// complete and empty. Title reads (`epic.getTaskContexts`) run for real.
vi.mock("@/hooks/host/use-host-queries", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/host/use-host-queries")>();
  return {
    ...actual,
    useHostQueries: (args: {
      requests: ReadonlyArray<{ method: string }>;
      combine: (results: ReadonlyArray<unknown>) => unknown;
    }) =>
      args.requests.some((r) => r.method === "epic.getTaskContexts")
        ? actual.useHostQueries(args as never)
        : args.combine(
            args.requests.map(() => ({
              data: { epics: {}, chats: {}, complete: true },
              isPending: false,
              isFetching: false,
              error: null,
              refetch: () => Promise.resolve(),
            })),
          ),
  };
});

function mountOver(session: StubSession, roomFresh: boolean): void {
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
        roomFresh={roomFresh}
        botId={BOT_ID}
        hostId={HOST_ID}
        boundHere
        active={active}
        notificationSubscriptions={
          subscription.snapshot.notificationSubscriptions
        }
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

beforeEach(() => {
  mocks.request.mockReset();
  useAuthStore.setState({
    status: "signed-in",
    profile: {
      userId: "user-titles",
      userName: "Ada",
      email: "ada@example.com",
    },
    contextMetadata: { userId: "user-titles", username: "ada" },
  });
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

function taskLight(id: string, title: string): ListTaskLight {
  return {
    epic: {
      light: {
        id,
        title,
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "draft",
        createdAt: 0,
        updatedAt: 0,
        createdBy: "user-titles",
        version: "1.0.0",
      },
      permission: null,
      repos: [],
      workspaces: [],
      roomInfo: null,
    },
    pinned: false,
  };
}

describe("the Activity tab's titles over a real epic.getTaskContexts read", () => {
  const TRACKED = (): object =>
    wireTask("t-titled", { cadence: { kind: "every", seconds: 7_200 } });

  it("shows the title the host answered, asking once for the listed task", async () => {
    mocks.request.mockImplementation((method: unknown) => {
      if (method === "epic.getTaskContexts") {
        const response: GetTaskContextsResponse = {
          tasks: {
            "t-titled": {
              status: "found",
              task: taskLight("t-titled", "Release notes for 1.9"),
            },
          },
        };
        return Promise.resolve(response);
      }
      return Promise.reject(new Error(`unexpected method: ${String(method)}`));
    });
    const session = new StubSession();
    mountOver(session, true);
    act(() => session.emit(snapshotWith([TRACKED()], [])));

    expect(await screen.findByText("Release notes for 1.9")).toBeTruthy();
    expect(mocks.request).toHaveBeenCalledWith(
      "epic.getTaskContexts",
      { taskIds: ["t-titled"] },
      expect.any(AbortSignal),
    );
  });

  it.each([
    ["the read fails", () => Promise.reject(new Error("host unreachable"))],
    [
      "the host does not resolve the task",
      () =>
        Promise.resolve({
          tasks: { "t-titled": { status: "unknown" } },
        }),
    ],
  ])("shows Task, never the id, when %s", async (_name, answer) => {
    mocks.request.mockImplementation(answer);
    const session = new StubSession();
    mountOver(session, true);
    act(() => session.emit(snapshotWith([TRACKED()], [])));

    // The read was made, and its outcome leaves the title unknown.
    await waitFor(() => expect(mocks.request).toHaveBeenCalled());
    const row = screen.getByTestId("bot-activity-task");
    expect(await within(row).findByText("Task")).toBeTruthy();
    expect(row.textContent).not.toContain("t-titled");
  });

  it("shows a loading title, not the Task fallback, while the read is unanswered", async () => {
    mocks.request.mockImplementation(() => new Promise(() => undefined));
    const session = new StubSession();
    mountOver(session, true);
    act(() => session.emit(snapshotWith([TRACKED()], [])));

    await waitFor(() => expect(mocks.request).toHaveBeenCalled());
    const row = screen.getByTestId("bot-activity-task");
    expect(within(row).getByText("Loading task title…")).toBeTruthy();
    expect(within(row).queryByText("Task")).toBeNull();
  });

  it("puts each found title on its own task whatever order the host answers in", async () => {
    mocks.request.mockImplementation(() =>
      Promise.resolve({
        tasks: {
          "t-second": {
            status: "found",
            task: taskLight("t-second", "Second"),
          },
          "t-first": { status: "found", task: taskLight("t-first", "First") },
        },
      }),
    );
    const session = new StubSession();
    mountOver(session, true);
    act(() =>
      session.emit(
        snapshotWith(
          [
            wireTask("t-first", { cadence: { kind: "every", seconds: 7_200 } }),
            wireTask("t-second", {
              cadence: { kind: "every", seconds: 7_200 },
            }),
          ],
          [],
        ),
      ),
    );

    await screen.findByText("First");
    const taskRows = screen.getAllByTestId("bot-activity-task");
    const first = taskRows.at(0);
    const second = taskRows.at(1);
    if (first === undefined || second === undefined) {
      throw new Error("expected two task rows");
    }
    expect(within(first).getByText("First")).toBeTruthy();
    expect(within(second).getByText("Second")).toBeTruthy();
  });

  it("explains an explicit denial with the sentence that the task may no longer be available to the viewer", async () => {
    mocks.request.mockImplementation(() =>
      Promise.resolve({
        tasks: { "t-titled": { status: "unknown", reason: "denied" } },
      }),
    );
    const session = new StubSession();
    mountOver(session, true);
    act(() => session.emit(snapshotWith([TRACKED()], [])));

    const row = await screen.findByTestId("bot-activity-task");
    await within(row).findByText("Task unavailable");
    expect(
      within(row).getByText("The task may no longer be available to you."),
    ).toBeTruthy();
  });

  it.each(["not-found-or-not-permitted", "transport", "server", "auth"])(
    "does not say Task unavailable when the lookup answered %s",
    async (reason) => {
      mocks.request.mockImplementation(() =>
        Promise.resolve({
          tasks: { "t-titled": { status: "unknown", reason } },
        }),
      );
      const session = new StubSession();
      mountOver(session, true);
      act(() => session.emit(snapshotWith([TRACKED()], [])));

      await waitFor(() => expect(mocks.request).toHaveBeenCalled());
      const row = screen.getByTestId("bot-activity-task");
      expect(await within(row).findByText("Task")).toBeTruthy();
      expect(row.textContent).not.toContain("Task unavailable");
      expect(row.textContent).not.toContain("no longer be available");
    },
  );
});

describe("the Activity tab's title states across lookups", () => {
  const EVERY = { cadence: { kind: "every", seconds: 7_200 } } as const;

  it("tells a confirmed-absent task from a denied one: only denied explains itself", async () => {
    mocks.request.mockImplementation(() =>
      Promise.resolve({
        tasks: {
          "t-gone": { status: "confirmed-absent" },
          "t-denied": { status: "unknown", reason: "denied" },
        },
      }),
    );
    const session = new StubSession();
    mountOver(session, true);
    act(() =>
      session.emit(
        snapshotWith(
          [wireTask("t-gone", EVERY), wireTask("t-denied", EVERY)],
          [],
        ),
      ),
    );

    await waitFor(() =>
      expect(screen.getAllByText("Task unavailable")).toHaveLength(2),
    );
    const explained = screen
      .getAllByTestId("bot-activity-task")
      .filter((row) =>
        row.textContent.includes("The task may no longer be available to you."),
      );
    expect(explained).toHaveLength(1);
  });

  it("does not show a title found for one viewer to another while the other's read is held, then shows the other's answer", async () => {
    let releaseB: (response: GetTaskContextsResponse) => void = () => undefined;
    let reads = 0;
    mocks.request.mockImplementation(() => {
      reads += 1;
      if (reads === 1) {
        return Promise.resolve({
          tasks: {
            "t-titled": {
              status: "found",
              task: taskLight("t-titled", "Viewer A's title"),
            },
          },
        });
      }
      return new Promise((resolve) => {
        releaseB = resolve;
      });
    });
    const session = new StubSession();
    mountOver(session, true);
    act(() => session.emit(snapshotWith([wireTask("t-titled", EVERY)], [])));
    expect(await screen.findByText("Viewer A's title")).toBeTruthy();

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

    await waitFor(() => expect(reads).toBe(2));
    const row = screen.getByTestId("bot-activity-task");
    expect(within(row).getByText("Loading task title…")).toBeTruthy();
    expect(screen.queryByText("Viewer A's title")).toBeNull();

    act(() =>
      releaseB({
        tasks: {
          "t-titled": {
            status: "found",
            task: taskLight("t-titled", "Viewer B's title"),
          },
        },
      }),
    );
    expect(await screen.findByText("Viewer B's title")).toBeTruthy();
    expect(screen.queryByText("Viewer A's title")).toBeNull();
  });

  it("shows a settled ambiguous task as Task while another batch is still being read", async () => {
    mocks.request.mockImplementation((_method: unknown, params: unknown) => {
      const ids = (params as { taskIds: ReadonlyArray<string> }).taskIds;
      const only = ids.at(0);
      if (only !== undefined && ids.length === 1) {
        return Promise.resolve({
          tasks: { [only]: { status: "unknown", reason: "transport" } },
        });
      }
      return new Promise(() => undefined);
    });
    const session = new StubSession();
    mountOver(session, true);
    const ids = Array.from(
      { length: GET_TASK_CONTEXTS_MAX_IDS + 1 },
      (_value, index) => `t-batch-${index}`,
    );
    act(() =>
      session.emit(
        snapshotWith(
          ids.map((id) => wireTask(id, EVERY)),
          [],
        ),
      ),
    );

    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("bot-activity-task")
          .filter((row) => within(row).queryByText("Task") !== null),
      ).toHaveLength(1),
    );
    expect(screen.getAllByText("Loading task title…")).toHaveLength(
      GET_TASK_CONTEXTS_MAX_IDS,
    );
  });
});

describe("the Activity tab with nothing to show", () => {
  it("shows the empty graphic and copy once the room is fresh and nothing is subscribed", async () => {
    const session = new StubSession();
    mountOver(session, true);
    act(() => session.emit(snapshotWith([], [])));

    const empty = await screen.findByTestId("bot-activity-empty");
    expect(within(empty).getByText("No activity yet")).toBeTruthy();
    expect(
      within(empty).getByText(
        "Keep track of work Tracy is handling. Tasks and updates that need your attention will appear here.",
      ),
    ).toBeTruthy();
    expect(within(empty).getByTestId("bot-activity-empty-art")).toBeTruthy();
    expect(screen.queryByText("Status unknown")).toBeNull();
  });

  it("shows Status unknown, not the empty graphic or copy, while the room is not fresh", async () => {
    const session = new StubSession();
    mountOver(session, false);
    act(() => session.emit(snapshotWith([], [])));

    expect(await screen.findByText("Status unknown")).toBeTruthy();
    expect(screen.queryByTestId("bot-activity-empty")).toBeNull();
    expect(screen.queryByTestId("bot-activity-empty-art")).toBeNull();
    expect(screen.queryByText("No activity yet")).toBeNull();
  });
});
