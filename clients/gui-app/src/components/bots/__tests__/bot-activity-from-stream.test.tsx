/**
 * The Activity tab over a real `bot.subscribe` payload: a server snapshot,
 * parsed by the protocol schema, is delivered through the real subscription
 * hook and read by the real active-task hook and page. Only the host
 * transport edges are stood in for (task titles, indicator reads, the
 * directory's reachability); what the list shows is decided by the code under
 * test.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  botSubscribeServerFrameSchema,
  type BotSubscribeServerFrame,
} from "@traycer/protocol/host/bot/schemas";
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

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HOST_ID = mockLocalHostEntry.hostId;
const NOW = Date.now();

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
    const active = useBotActiveTasks(tasks);
    if (subscription.snapshot === null) return null;
    return (
      <BotActivityPage
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
    <QueryClientProvider client={queryClient}>
      <Page />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.taskTitles = {};
  __resetAgentActivityStoreForTests();
  // The activity plane vouches the whole fleet, so a quiet seen task can leave.
  __setAgentActivityPlaneAnsweringForTests();
  __setAgentActivityStateForTests({}, "cloud", "connected");
});

afterEach(() => {
  cleanup();
  __resetBotSubscriptionsForTesting();
  __resetAgentActivityStoreForTests();
});

describe("the Activity tab over a bot.subscribe snapshot", () => {
  it("lists tracked and started tasks once each under their titles, drops a finished seen one, and draws no history or trunk link", () => {
    mocks.taskTitles = {
      "t-started": "Release notes for 1.9",
      "t-adopted": "Nightly flake roster",
    };
    const session = new StubSession();
    mountOver(session);

    act(() =>
      session.emit(
        snapshotWith(
          [
            // Unlabelled, started by Tracy, ended with a report not yet read:
            // nothing unread is held, so it is a finished seen one-off.
            wireTask("t-finished", {
              cadence: { kind: "none" },
              state: "ended",
              endedReason: "completed",
              lastCheckinAt: NOW,
            }),
            wireTask("t-started", {
              cadence: { kind: "every", seconds: 7_200 },
              lastCheckinAt: NOW,
            }),
            wireTask("t-adopted", {
              spun: false,
              cadence: { kind: "every", seconds: 86_400 },
              label: "bot-supplied-label",
            }),
          ],
          [],
        ),
      ),
    );

    const rows = screen.getAllByTestId("bot-activity-task");
    expect(rows.map((el) => el.getAttribute("data-task-id")).sort()).toEqual([
      "t-adopted",
      "t-started",
    ]);
    expect(
      within(
        rows.find(
          (el) => el.getAttribute("data-task-id") === "t-started",
        ) as HTMLElement,
      ).getByText("Release notes for 1.9"),
    ).toBeTruthy();
    const page = screen.getByTestId("bot-activity-page");
    expect(page.textContent).toContain("Nightly flake roster");
    expect(page.textContent).not.toContain("bot-supplied-label");
    expect(page.textContent).not.toContain("t-finished");
    expect(screen.queryByText(/Tasks with check-ins/)).toBeNull();
    expect(screen.queryByText(/Open check-in/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Open trunk session" }),
    ).toBeNull();
    // A known empty subscription list draws no section.
    expect(
      screen.queryByRole("heading", { name: "Notification subscriptions" }),
    ).toBeNull();
  });

  it("shows Task for a row whose title is unknown and never its id, and re-renders when the next snapshot ends a task", () => {
    const session = new StubSession();
    mountOver(session);

    act(() =>
      session.emit(
        snapshotWith(
          [
            wireTask("t-untitled-77c1", {
              cadence: { kind: "every", seconds: 7_200 },
            }),
          ],
          null,
        ),
      ),
    );

    const row = screen.getByTestId("bot-activity-task");
    expect(within(row).getByText("Task")).toBeTruthy();
    expect(row.textContent).not.toContain("t-untitled-77c1");
    expect(screen.getByText("Subscriptions unavailable")).toBeTruthy();

    act(() =>
      session.emit(
        snapshotWith(
          [
            wireTask("t-untitled-77c1", {
              cadence: { kind: "every", seconds: 7_200 },
              state: "ended",
              endedReason: "by-bot",
              lastCheckinAt: NOW,
            }),
          ],
          null,
        ),
      ),
    );

    expect(screen.queryAllByTestId("bot-activity-task")).toHaveLength(0);
  });
});
