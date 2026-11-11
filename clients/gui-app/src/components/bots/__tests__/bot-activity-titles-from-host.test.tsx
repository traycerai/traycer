/**
 * The Activity tab's task titles over a real `epic.getTaskContexts` read: the
 * real `useEpicGetTaskContexts` and `useHostQueries` run, and only the host
 * client's request boundary answers (a found title, a failed read, a task the
 * host does not resolve). The subscription is a real `bot.subscribe` snapshot
 * through the real subscription hook, as in `bot-activity-from-stream`.
 */
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
  botSubscribeServerFrameSchema,
  type BotSubscribeServerFrame,
} from "@traycer/protocol/host/bot/schemas";
import type {
  GetTaskContextsResponse,
  ListTaskLight,
} from "@traycer/protocol/host/epic/unary-schemas";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
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

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HOST_ID = mockLocalHostEntry.hostId;

/** A task entry as a host sends it: every wire field, and no check-in history. */
function wireTask(taskId: string, fields: Record<string, unknown>): object {
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
    ...fields,
  };
}

function snapshotWith(
  tasks: ReadonlyArray<object>,
  notificationSubscriptions: ReadonlyArray<object> | null,
): BotSubscribeServerFrame {
  return botSubscribeServerFrameSchema.parse({
    kind: "snapshot",
    bot: {
      botId: BOT_ID,
      environmentId: "env-1",
      createdByUserId: "user-1",
      title: "Tracy",
      harness: "claude",
      model: "claude-opus-5-5",
      effort: null,
      profile: null,
      trunkChatId: "trunk-1",
      boundHostId: HOST_ID,
      hostEpoch: 0,
      createdAt: 1,
      archivedAt: null,
      directive: null,
      replyMode: "thread",
      appConversationChatId: null,
    },
    tasks,
    openRequestCount: 0,
    conversationsRevision: 1,
    notificationSubscriptions,
    surfaceActions: null,
    stoppedNotificationWatches: null,
    boundHost: { hostId: HOST_ID, epoch: 0, isThisHost: true },
    activity: null,
    hasBinaryPayload: false,
  });
}

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
    );
    if (subscription.snapshot === null) return null;
    return (
      <BotActivityPage
        roomFresh
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
    mountOver(session);
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
    mountOver(session);
    act(() => session.emit(snapshotWith([TRACKED()], [])));

    // The read was made, and its outcome leaves the title unknown.
    await waitFor(() => expect(mocks.request).toHaveBeenCalled());
    const row = screen.getByTestId("bot-activity-task");
    expect(within(row).getByText("Task")).toBeTruthy();
    expect(row.textContent).not.toContain("t-titled");
  });
});
