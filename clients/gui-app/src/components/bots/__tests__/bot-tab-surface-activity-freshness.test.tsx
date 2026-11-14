/**
 * The Tracy surface's Activity tab through the REAL surface and the REAL
 * Activity page, over a bot stream snapshot that is current, then held, then
 * current again: what the page says about an empty task list and empty
 * notification subscriptions while the snapshot is not current, and that a
 * cached non-empty snapshot stays visible. Only the host boundaries are
 * scripted (the stream's snapshot and whether it is current, the notification
 * host's answer, the agent-activity store).
 */
import { emptyBotMentionHostListsMock } from "@/components/bots/__tests__/bot-mention-host-test-support";
import {
  botListChangedMock,
  botListQueryMock,
  botMemoryMock,
  botMutationsMock,
  botThreadListQueryMock,
  connectableHostIdsMock,
  environmentListMock,
  environmentMembersMock,
  hostDirectoryListMock,
  hostEnvironmentBindingsMock,
  cloudEpicTasksMock,
  epicTaskContextsMock,
  hostClientForHostIdMock,
  hostQueriesMock,
  hostSupportsMethodMock,
  mocks,
  notificationHostMock,
  tabHostClientMock,
  tabHostProviderMock,
  tabNavigationMock,
} from "./bot-tab-surface-mocks";
import { StrictMode, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __setAgentActivityPlaneAnsweringForTests,
  __setAgentActivityStateForTests,
} from "@/stores/agent-activity-store";
import { botSubscribeServerFrameSchema } from "@traycer/protocol/host/bot/schemas";
import type { BotSubscribeServerFrame } from "@traycer/protocol/host/bot/schemas";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import {
  StubHostStreamClient,
  StubSession,
} from "@/hooks/bots/__tests__/bot-subscribe-stub-stream";
import { __resetBotSubscriptionsForTesting } from "@/hooks/bots/use-bot-subscription";
import {
  BOT,
  BOT_ID,
  BOUND_HOST,
  endBotTabSurfaceCase,
  resetBotTabSurfaceMocks,
  snapshot,
  TAB_HOST,
  trackingTask,
} from "./bot-tab-surface-harness";

/**
 * Where the surface's stream hook result comes from. Scripted: a hook result
 * whose currentness is `current`. Real: the real hook over a stream client
 * whose one session the case drives.
 */
const stream = vi.hoisted(() => ({
  current: true,
  real: false,
  client: null as IHostStreamClient<HostStreamRpcRegistry> | null,
}));

/** Hosts the directory no longer answers for; every other host is reachable. */
const reach = vi.hoisted(() => ({ unreachable: new Set<string>() }));

vi.mock(
  "@/hooks/bots/use-environment-host-lists-query",
  () => emptyBotMentionHostListsMock,
);
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));
vi.mock("@/lib/tab-navigation", async (importOriginal) =>
  tabNavigationMock(
    await importOriginal<typeof import("@/lib/tab-navigation")>(),
  ),
);
vi.mock(
  "@/hooks/epic/use-epic-get-task-contexts-query",
  () => epicTaskContextsMock,
);
vi.mock("@/hooks/epics/use-cloud-epic-tasks-query", async (importOriginal) =>
  cloudEpicTasksMock(
    await importOriginal<
      typeof import("@/hooks/epics/use-cloud-epic-tasks-query")
    >(),
  ),
);
vi.mock("@/hooks/host/use-host-supports-method", () => hostSupportsMethodMock);
vi.mock(
  "@/hooks/notifications/use-notification-host",
  () => notificationHostMock,
);
vi.mock(
  "@/hooks/host/use-host-client-for-host-id",
  () => hostClientForHostIdMock,
);
vi.mock("@/hooks/host/use-host-queries", () => hostQueriesMock);
vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: (hostId: string) => ({
    status: reach.unreachable.has(hostId) ? "unreachable" : "reachable",
  }),
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => mocks.binding,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-defaults", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/sandboxes/use-sandbox-defaults")
  >()),
  useSandboxDefaults: (environmentIds: readonly string[]) =>
    new Map(environmentIds.map((id) => [id, mocks.sandboxDefaults])),
}));
vi.mock(
  "@/hooks/bots/use-host-environment-bindings-query",
  () => hostEnvironmentBindingsMock,
);
vi.mock(
  "@/hooks/bots/use-environment-members-query",
  () => environmentMembersMock,
);
vi.mock(
  "@/components/epic-canvas/tab-host-provider",
  () => tabHostProviderMock,
);
vi.mock("@/hooks/host/use-tab-host-client", () => tabHostClientMock);
vi.mock(
  "@/components/epic-tabs/pane-visibility-context",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/epic-tabs/pane-visibility-context")
    >()),
    usePaneVisible: () => mocks.state.paneVisible,
  }),
);
vi.mock("@/hooks/bots/use-bot-memory", () => botMemoryMock);
vi.mock("@/hooks/bots/use-bot-subscription", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/bots/use-bot-subscription")>();
  return {
    ...actual,
    useBotSubscriptionForHost: (input: {
      hostId: string;
      botId: string;
      enabled: boolean;
    }) => {
      mocks.subscribed.push(input.botId);
      if (stream.real) {
        return actual.useBotSubscriptionForClient({
          hostId: input.hostId,
          botId: input.botId,
          enabled: input.enabled,
          client: stream.client,
        });
      }
      return {
        snapshot: mocks.state.snapshot,
        snapshotFresh: mocks.state.snapshot !== null && stream.current,
        deleted: mocks.state.deleted,
        error: mocks.state.error,
        isPending: mocks.state.snapshot === null,
        resubscribe: mocks.resubscribe,
      };
    },
  };
});
vi.mock("@/hooks/host/use-connectable-host-ids", () => connectableHostIdsMock);
vi.mock(
  "@/hooks/host/use-host-directory-list-query",
  () => hostDirectoryListMock,
);
vi.mock("@/hooks/bots/use-bot-list-query", () => botListQueryMock);
vi.mock(
  "@/hooks/bots/use-bot-list-changed-subscription",
  () => botListChangedMock,
);
vi.mock("@/hooks/bots/use-environment-list-query", () => environmentListMock);
vi.mock("@/hooks/bots/use-bot-mutations", () => botMutationsMock);
vi.mock("@/hooks/bots/use-bot-thread-list-query", () => botThreadListQueryMock);
vi.mock("@/components/bots/bot-channel-sidebar", () => ({
  BotChannelSidebar: () => null,
}));
vi.mock("@/components/bots/bot-channel-view", () => ({
  BotChannelView: () => null,
}));
vi.mock("@/components/bots/bot-session-view", () => ({
  BotSessionView: () => null,
}));
vi.mock("@/components/bots/bot-threads-view", () => ({
  BotThreadsView: () => null,
}));
vi.mock("@/components/bots/bot-settings-panel", () => ({
  BotChannelSettingsPanel: () => null,
}));

import { BotTabSurface } from "@/components/bots/bot-tab-surface";
import { useAuthStore } from "@/stores/auth/auth-store";
import { NotificationFeedModeContext } from "@/lib/notifications/notification-feed-mode-context";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";

let queryClient = new QueryClient();

function surface(): ReactNode {
  return (
    <StrictMode>
      <NotificationFeedModeContext.Provider value="cloud">
        <QueryClientProvider client={queryClient}>
          <BotTabSurface botId={BOT_ID} hostId={TAB_HOST} />
        </QueryClientProvider>
      </NotificationFeedModeContext.Provider>
    </StrictMode>
  );
}

const SUBSCRIPTION = {
  target: { kind: "trunk" },
  attentionOnly: false,
  everySeconds: null,
  since: null,
  digests: null,
} as const;

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  resetBotTabSurfaceMocks();
  stream.current = true;
  stream.real = false;
  stream.client = null;
  reach.unreachable.clear();
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId: "user-ada", userName: "Ada", email: "ada@example.com" },
    contextMetadata: { userId: "user-ada", username: "ada" },
  });
  // Every other source vouches: the whole fleet, and the cloud feed.
  __setAgentActivityPlaneAnsweringForTests();
  __setAgentActivityStateForTests({}, "cloud", "connected");
  useCloudNotificationsStore.setState({
    hasSnapshot: true,
    connectionState: "connected",
  });
});

afterEach(() => {
  __resetBotSubscriptionsForTesting();
  useCloudNotificationsStore.getState().reset();
  endBotTabSurfaceCase(queryClient);
});

async function openActivity(): Promise<{ rerender: () => void }> {
  const view = render(surface());
  await userEvent.setup().click(screen.getByTestId("bot-tab-view-activity"));
  return { rerender: () => view.rerender(surface()) };
}

const pageText = (): string =>
  screen.getByTestId("bot-activity-page").textContent;

describe("<BotTabSurface /> Activity over a stream snapshot that is current, held and current again", () => {
  it("says there is no activity, and shows no subscriptions section, only while the empty snapshot is current", async () => {
    mocks.state.snapshot = { ...snapshot(), notificationSubscriptions: [] };
    const view = await openActivity();
    expect(pageText()).toContain("No activity yet");
    expect(pageText()).not.toContain("Status unknown");
    expect(screen.queryByText("Notification subscriptions")).toBeNull();

    // The stream leaves open: the empty snapshot is no longer current.
    stream.current = false;
    act(() => view.rerender());
    expect(pageText()).not.toContain("No activity yet");
    expect(pageText()).toContain("Status unknown");
    expect(pageText()).toContain("Subscriptions unavailable");
    expect(screen.getByText("Notification subscriptions")).toBeTruthy();

    // The reconnect's snapshot makes it current again.
    stream.current = true;
    act(() => view.rerender());
    expect(pageText()).toContain("No activity yet");
    expect(pageText()).not.toContain("Status unknown");
    expect(screen.queryByText("Notification subscriptions")).toBeNull();
  });

  it("keeps a cached non-empty snapshot visible while it is not current: its task as Status unknown and its subscription listed", async () => {
    mocks.state.snapshot = {
      ...snapshot(),
      tasks: [trackingTask("task-held")],
      notificationSubscriptions: [SUBSCRIPTION],
    };
    stream.current = false;
    await openActivity();

    expect(screen.getAllByTestId("bot-activity-task")).toHaveLength(1);
    expect(pageText()).toContain("Status unknown");
    expect(pageText()).not.toContain("No activity yet");
    expect(screen.getByText("Notification subscriptions")).toBeTruthy();
    expect(screen.getByText("Trunk")).toBeTruthy();
    expect(pageText()).not.toContain("Subscriptions unavailable");
  });

  it("keeps a cached non-empty snapshot's task as before while the stream is current (control)", async () => {
    mocks.state.snapshot = {
      ...snapshot(),
      tasks: [trackingTask("task-held")],
      notificationSubscriptions: [SUBSCRIPTION],
    };
    await openActivity();

    expect(screen.getAllByTestId("bot-activity-task")).toHaveLength(1);
    expect(screen.getByText("Trunk")).toBeTruthy();
  });
});

describe("<BotTabSurface /> Activity over the real stream hook, driven through one session", () => {
  function snapshotFrame(
    tasks: ReadonlyArray<object>,
    notificationSubscriptions: ReadonlyArray<object>,
  ): BotSubscribeServerFrame {
    return botSubscribeServerFrameSchema.parse({
      kind: "snapshot",
      bot: BOT,
      tasks,
      openRequestCount: 0,
      conversationsRevision: 1,
      notificationSubscriptions,
      surfaceActions: null,
      stoppedNotificationWatches: null,
      boundHost: { hostId: BOUND_HOST, epoch: 1, isThisHost: false },
      activity: null,
      hasBinaryPayload: false,
    });
  }

  function mountOverRealStream(): StubSession {
    const session = new StubSession();
    stream.real = true;
    stream.client = new StubHostStreamClient(session);
    render(surface());
    return session;
  }

  const openActivityTab = (): Promise<void> =>
    userEvent.setup().click(screen.getByTestId("bot-tab-view-activity"));

  it("says there is no activity only while an empty snapshot is current: empty, held, open again with no snapshot, then a fresh snapshot", async () => {
    const session = mountOverRealStream();
    act(() => session.emit(snapshotFrame([], [])));
    await openActivityTab();
    expect(pageText()).toContain("No activity yet");
    expect(screen.queryByText("Notification subscriptions")).toBeNull();

    act(() => session.status("reconnecting", null));
    expect(pageText()).not.toContain("No activity yet");
    expect(pageText()).toContain("Status unknown");
    expect(pageText()).toContain("Subscriptions unavailable");

    // Open again, but no snapshot yet: still not current.
    act(() => session.status("open", null));
    expect(pageText()).not.toContain("No activity yet");
    expect(pageText()).toContain("Status unknown");

    // The reconnect's snapshot makes it current.
    act(() => session.emit(snapshotFrame([], [])));
    expect(pageText()).toContain("No activity yet");
    expect(pageText()).not.toContain("Status unknown");
    expect(screen.queryByText("Notification subscriptions")).toBeNull();
  });

  it("keeps a non-empty snapshot's task and subscription visible through the same held stream (control)", async () => {
    const session = mountOverRealStream();
    act(() =>
      session.emit(snapshotFrame([trackingTask("task-held")], [SUBSCRIPTION])),
    );
    await openActivityTab();
    expect(screen.getAllByTestId("bot-activity-task")).toHaveLength(1);

    act(() => session.status("reconnecting", null));

    expect(screen.getAllByTestId("bot-activity-task")).toHaveLength(1);
    expect(pageText()).toContain("Status unknown");
    expect(pageText()).not.toContain("No activity yet");
    expect(screen.getByText("Trunk")).toBeTruthy();
    expect(pageText()).not.toContain("Subscriptions unavailable");
  });
});

describe("<BotTabSurface /> Activity while the serving host is unreachable but the snapshot stream is current", () => {
  function emptyFrame(): BotSubscribeServerFrame {
    return botSubscribeServerFrameSchema.parse({
      kind: "snapshot",
      bot: BOT,
      tasks: [],
      openRequestCount: 0,
      conversationsRevision: 1,
      notificationSubscriptions: [],
      surfaceActions: null,
      stoppedNotificationWatches: null,
      boundHost: { hostId: BOUND_HOST, epoch: 1, isThisHost: false },
      activity: null,
      hasBinaryPayload: false,
    });
  }

  it("scripted stream: an empty snapshot says Status unknown and Subscriptions unavailable, never No activity yet, and says No activity yet again once the host is reachable with the same current snapshot", async () => {
    mocks.state.snapshot = { ...snapshot(), notificationSubscriptions: [] };
    stream.current = true;
    const view = await openActivity();
    // Control: reachable.
    expect(pageText()).toContain("No activity yet");
    expect(pageText()).not.toContain("Status unknown");

    reach.unreachable.add(TAB_HOST);
    act(() => view.rerender());
    expect(stream.current).toBe(true);
    expect(pageText()).not.toContain("No activity yet");
    expect(pageText()).toContain("Status unknown");
    expect(pageText()).toContain("Subscriptions unavailable");

    // The snapshot never changed: reachability alone brings the answer back.
    reach.unreachable.delete(TAB_HOST);
    act(() => view.rerender());
    expect(pageText()).toContain("No activity yet");
    expect(pageText()).not.toContain("Status unknown");
    expect(screen.queryByText("Notification subscriptions")).toBeNull();
  });

  it("real stream hook: the session stays open with its empty snapshot while the host is unreachable, and the page still does not say No activity yet", async () => {
    const session = new StubSession();
    stream.real = true;
    stream.client = new StubHostStreamClient(session);
    const view = render(surface());
    act(() => session.emit(emptyFrame()));
    await userEvent.setup().click(screen.getByTestId("bot-tab-view-activity"));
    expect(pageText()).toContain("No activity yet");

    reach.unreachable.add(TAB_HOST);
    act(() => view.rerender(surface()));

    // Guard: nothing touched the stream; its empty snapshot is still the
    // current answer (no status change was emitted).
    expect(pageText()).not.toContain("No activity yet");
    expect(pageText()).toContain("Status unknown");
    expect(pageText()).toContain("Subscriptions unavailable");

    reach.unreachable.delete(TAB_HOST);
    act(() => view.rerender(surface()));
    expect(pageText()).toContain("No activity yet");
    expect(pageText()).not.toContain("Status unknown");
  });

  it("keeps a cached non-empty snapshot's task and subscription visible while the host is unreachable (control)", async () => {
    mocks.state.snapshot = {
      ...snapshot(),
      tasks: [trackingTask("task-held")],
      notificationSubscriptions: [SUBSCRIPTION],
    };
    reach.unreachable.add(TAB_HOST);
    await openActivity();

    expect(screen.getAllByTestId("bot-activity-task")).toHaveLength(1);
    expect(pageText()).not.toContain("No activity yet");
    expect(screen.getByText("Trunk")).toBeTruthy();
    expect(pageText()).not.toContain("Subscriptions unavailable");
  });
});
