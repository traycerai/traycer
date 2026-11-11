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
    const active = useBotActiveTasks(
      tasks,
      HOST_ID,
      subscription.snapshotFresh,
    );
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
    <NotificationFeedModeContext.Provider value="cloud">
      <QueryClientProvider client={queryClient}>
        <Page />
      </QueryClientProvider>
    </NotificationFeedModeContext.Provider>,
  );
}

beforeEach(() => {
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
  useCloudNotificationsStore.getState().reset();
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
              inputNeeded: [],
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
              inputNeeded: [],
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

  it("shows a waiting surface as Status unknown from the moment the stream leaves open until a fresh snapshot lands, and as waiting again after it", () => {
    const waitingTask = (): object =>
      wireTask("t-wait", {
        // On completion: with the surface no longer current, nothing else
        // earns the task a band, so it reads as unknown, not periodic.
        inputNeeded: [
          {
            hostId: "host-agents",
            hostName: "Studio Mac",
            agentChatId: "a-2",
            surfaceId: "surface-a-2",
            surface: {
              kind: "approval",
              approvalId: "approval-a-2",
              tool: "gh pr merge",
              summary: "Merge the release PR",
              tier: null,
              requiresPerson: true,
              askedAt: NOW,
            },
            reportedAt: NOW,
            acceptsActions: true,
          },
        ],
      });
    const bandOf = (): string | null =>
      screen.getByTestId("bot-activity-task").getAttribute("data-band");
    const session = new StubSession();
    mountOver(session);
    act(() => session.emit(snapshotWith([waitingTask()], [])));
    // The real stream delivered it: this is the current state.
    expect(bandOf()).toBe("needs-you");

    // The transport drops: what the last snapshot held is no longer current.
    act(() => session.status("reconnecting", null));
    expect(bandOf()).toBe("unknown");
    expect(
      screen
        .getByTestId("bot-activity-task")
        .textContent.split("Status unknown"),
    ).toHaveLength(2);

    // Open again, but no snapshot yet: still not current.
    act(() => session.status("open", null));
    expect(bandOf()).toBe("unknown");

    // The reconnect's snapshot makes it current again.
    act(() => session.emit(snapshotWith([waitingTask()], [])));
    expect(bandOf()).toBe("needs-you");
  });

  it("keeps a scheduled task with a stale waiting surface listed as Status unknown, not relabelled periodic, until a fresh snapshot lands", () => {
    const periodicWaiting = (): object =>
      wireTask("t-sched", {
        cadence: { kind: "every", seconds: 7_200 },
        nextAt: NOW + 3_600_000,
        inputNeeded: [
          {
            hostId: "host-agents",
            hostName: "Studio Mac",
            agentChatId: "a-3",
            surfaceId: "surface-a-3",
            surface: {
              kind: "approval",
              approvalId: "approval-a-3",
              tool: "gh pr merge",
              summary: "Merge the nightly PR",
              tier: null,
              requiresPerson: true,
              askedAt: NOW,
            },
            reportedAt: NOW,
            acceptsActions: true,
          },
        ],
      });
    const rowEl = (): HTMLElement => screen.getByTestId("bot-activity-task");
    const session = new StubSession();
    mountOver(session);
    act(() => session.emit(snapshotWith([periodicWaiting()], [])));
    expect(rowEl().getAttribute("data-band")).toBe("needs-you");

    act(() => session.status("reconnecting", null));
    // Listed, and says its status is unknown; never the periodic band.
    expect(screen.getAllByTestId("bot-activity-task")).toHaveLength(1);
    expect(rowEl().getAttribute("data-band")).toBe("unknown");
    expect(rowEl().textContent.split("Status unknown")).toHaveLength(2);

    act(() => session.status("open", null));
    expect(rowEl().getAttribute("data-band")).toBe("unknown");

    act(() => session.emit(snapshotWith([periodicWaiting()], [])));
    expect(rowEl().getAttribute("data-band")).toBe("needs-you");
  });
});

describe("a bot.subscribe stream held, reconnected and continued", () => {
  const IDLE = {
    state: "idle",
    startedAt: null,
    step: null,
    requestId: null,
    reason: null,
  };
  /** A snapshot that carries the bot's activity, so an `activity` frame has something to patch. */
  function snapshotWithActivity(
    tasks: ReadonlyArray<object>,
  ): BotSubscribeServerFrame {
    return botSubscribeServerFrameSchema.parse({
      ...snapshotWith(tasks, []),
      activity: { trunk: IDLE, threads: {} },
    });
  }
  function trunkReplying(): BotSubscribeServerFrame {
    return botSubscribeServerFrameSchema.parse({
      kind: "activity",
      target: { kind: "trunk" },
      entry: { ...IDLE, state: "replying", startedAt: NOW, requestId: "r-1" },
      hasBinaryPayload: false,
    });
  }
  const WAITING = (): object => wireTask("t-held", { inputNeeded: [] });

  /** The hook's own result, read as text: what a surface would act on. */
  function mountProbe(session: StubSession): void {
    const streamClient = new StubHostStreamClient(session);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    function Probe(): ReactNode {
      const subscription = useBotSubscriptionForClient({
        hostId: HOST_ID,
        botId: BOT_ID,
        enabled: true,
        client: streamClient,
      });
      return (
        <div
          data-testid="probe"
          data-fresh={String(subscription.snapshotFresh)}
          data-tasks={(subscription.snapshot?.tasks ?? [])
            .map((t) => t.taskId)
            .join(",")}
          data-trunk={subscription.snapshot?.activity?.trunk?.state ?? "none"}
        />
      );
    }
    render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );
  }
  const probe = (): HTMLElement => screen.getByTestId("probe");

  it("keeps the last snapshot as the baseline but not as current from the moment the stream leaves open, through open again without a snapshot", () => {
    const session = new StubSession();
    mountProbe(session);
    act(() => session.emit(snapshotWithActivity([WAITING()])));
    expect(probe().dataset.fresh).toBe("true");
    expect(probe().dataset.tasks).toBe("t-held");

    act(() => session.status("reconnecting", null));
    expect(probe().dataset.fresh).toBe("false");
    expect(probe().dataset.tasks).toBe("t-held");

    act(() => session.status("open", null));
    expect(probe().dataset.fresh).toBe("false");
    expect(probe().dataset.tasks).toBe("t-held");
  });

  it("keeps an activity frame that arrives while the stream is held or stale in its baseline, without making the baseline current", () => {
    const session = new StubSession();
    mountProbe(session);
    act(() => session.emit(snapshotWithActivity([WAITING()])));
    act(() => session.status("reconnecting", null));
    // Delivered while the stream is not open: the patch is kept.
    act(() => session.emit(trunkReplying()));
    expect(probe().dataset.fresh).toBe("false");
    expect(probe().dataset.trunk).toBe("replying");
    expect(probe().dataset.tasks).toBe("t-held");

    act(() => session.status("open", null));
    expect(probe().dataset.fresh).toBe("false");
    expect(probe().dataset.trunk).toBe("replying");
    expect(probe().dataset.tasks).toBe("t-held");
  });

  it("is current again on the same baseline when a held stream continues with no new snapshot, and that baseline holds the patch it received while held", () => {
    const session = new StubSession();
    mountProbe(session);
    act(() => session.emit(snapshotWithActivity([WAITING()])));

    act(() => session.statusWithContinuity("reconnecting", null, "held"));
    expect(probe().dataset.fresh).toBe("false");
    act(() => session.emit(trunkReplying()));
    expect(probe().dataset.fresh).toBe("false");
    expect(probe().dataset.trunk).toBe("replying");

    act(() => session.statusWithContinuity("open", null, "continued"));
    // One subscription outlived the outage: its baseline, patches included, is current.
    expect(probe().dataset.fresh).toBe("true");
    expect(probe().dataset.trunk).toBe("replying");
    expect(probe().dataset.tasks).toBe("t-held");
  });

  it("is not current on a snapshot that was already in flight while the stream was held, only once the stream is open again with one delivered after", () => {
    const session = new StubSession();
    mountProbe(session);
    act(() => session.emit(snapshotWithActivity([WAITING()])));
    act(() => session.status("reconnecting", null));

    // A frame the old connection had in flight arrives before open.
    act(() => session.emit(snapshotWithActivity([WAITING()])));
    expect(probe().dataset.fresh).toBe("false");

    act(() => session.status("open", null));
    act(() => session.emit(snapshotWithActivity([WAITING()])));
    expect(probe().dataset.fresh).toBe("true");
  });

  it("stays current, and applies an activity frame to its baseline, while the stream is open and continuing", () => {
    const session = new StubSession();
    mountProbe(session);
    act(() => session.emit(snapshotWithActivity([WAITING()])));
    expect(probe().dataset.trunk).toBe("idle");

    act(() => session.emit(trunkReplying()));
    expect(probe().dataset.fresh).toBe("true");
    expect(probe().dataset.trunk).toBe("replying");
  });
});
