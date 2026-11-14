/**
 * The Activity list over a real `host.notifications.indicatorState` read that
 * is answered, held while the host is unreachable, and answered again with
 * something different. The real `useBotActiveTasks`, indicator hooks and
 * `useHostQueries` run on a real query client; only the host client's request
 * boundary answers, and a replacement read can be held open.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotTaskEntry } from "@traycer/protocol/host/bot/schemas";
import { BotActivityPage } from "@/components/bots/bot-activity-page";
import { useBotActiveTasks } from "@/hooks/bots/use-bot-active-tasks";
import { useNotificationIndicators } from "@/hooks/notifications/use-notification-indicators-query";
import { NotificationFeedModeContext } from "@/lib/notifications/notification-feed-mode-context";
import {
  __resetAgentActivityStoreForTests,
  __setAgentActivityPlaneAnsweringForTests,
  __setAgentActivityStateForTests,
} from "@/stores/agent-activity-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";

const mocks = vi.hoisted(() => {
  type Read = { readonly resolve: (answer: unknown) => void };
  const state = {
    /** Tasks whose agents the host holds an unread done for. */
    unread: new Set<string>(),
    /** The next indicator read stays open until `held.resolve` answers it. */
    hold: false,
    held: null as Read | null,
    unreachable: new Set<string>(),
    /** Each `host.notifications.indicatorState` request the host client received. */
    indicatorReads: 0,
  };
  const flags = {
    pendingFork: false,
    pendingApproval: false,
    pendingInterview: false,
    unreadFailure: false,
    unreadDone: false,
    unreadCount: 0,
  };
  const answer = (params: { epicIds: ReadonlyArray<string> }): unknown => ({
    epics: Object.fromEntries(
      params.epicIds
        .filter((id) => state.unread.has(id))
        .map((id) => [id, { ...flags, unreadDone: true, unreadCount: 1 }]),
    ),
    chats: {},
    complete: true,
  });
  const handle = (method: unknown, params: unknown): Promise<unknown> => {
    if (method === "epic.getTaskContexts")
      return Promise.resolve({ tasks: {} });
    if (method === "host.notifications.indicatorState") {
      state.indicatorReads += 1;
      const request = params as { epicIds: ReadonlyArray<string> };
      if (state.hold) {
        state.hold = false;
        return new Promise((resolve) => {
          state.held = { resolve };
        });
      }
      return Promise.resolve(answer(request));
    }
    return Promise.reject(new Error(`unexpected method: ${String(method)}`));
  };
  const hostClient = {
    hostId: "host-notifications",
    getActiveHostId: () => "host-notifications",
    getRequestContextUserId: () => "user-life",
    onChange: () => () => undefined,
    requestWithSignal: (method: unknown, params: unknown) =>
      handle(method, params),
    requestWithOptions: (method: unknown, params: unknown) =>
      handle(method, params),
    // A partitioned (`home: "local"`) read names the host method version it needs.
    requestWithSignalRequiringHostMethodVersion: (
      method: unknown,
      params: unknown,
    ) => handle(method, params),
    request: (method: unknown, params: unknown) => handle(method, params),
  };
  return { state, answer, hostClient };
});

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/lib/tab-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tab-navigation")>()),
  navigateToTabIntent: vi.fn(),
  activateTabIntent: vi.fn(),
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.hostClient,
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => mocks.hostClient,
  useHostRuntimeClient: () => mocks.hostClient,
}));
vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({
    hostId: "host-notifications",
    isReady: true,
    hasRpcEndpoint: true,
    canExecute: true,
    requestContextUserId: "user-life",
  }),
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => false,
}));
vi.mock("@/hooks/bots/use-bot-activity", () => ({
  useBotActivity: () => null,
}));
vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: (hostId: string) => ({
    status: mocks.state.unreachable.has(hostId) ? "unreachable" : "reachable",
  }),
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
  useHostClientForHostId: () => mocks.hostClient,
}));

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const NOW = Date.now();

function quiet(): BotTaskEntry {
  return {
    taskId: "t-life",
    cadence: { kind: "none" },
    lastCheckinAt: NOW,
    lastCheckin: null,
    nextAt: null,
    state: "ended",
    endedReason: "completed",
    createdByUserId: null,
    spun: true,
    label: null,
    originRequestId: null,
    createdByChatId: null,
    inputNeeded: [],
    pause: null,
    stop: null,
    runRequest: null,
  };
}

/** The tasks the bot lists; a case empties it to disable the indicator read and fills it to enable it again. */
const listed = { tasks: [] as ReadonlyArray<BotTaskEntry> };

function Body(): ReactNode {
  const active = useBotActiveTasks(listed.tasks, "host-bound", true);
  return (
    <BotActivityPage
      roomFresh
      botId={BOT_ID}
      hostId="host-bound"
      boundHere
      active={active}
      notificationSubscriptions={null}
      trunkChatId="trunk-1"
      onOpenSession={vi.fn()}
      resolveMember={() => null}
      threads={[]}
    />
  );
}

let queryClient: QueryClient;

function Tree(): ReactNode {
  return (
    <NotificationFeedModeContext.Provider value="cloud">
      <QueryClientProvider client={queryClient}>
        <Body />
      </QueryClientProvider>
    </NotificationFeedModeContext.Provider>
  );
}

const bandNow = (): string | null =>
  screen.queryByTestId("bot-activity-task")?.getAttribute("data-band") ?? null;

/** The host drops, and the next indicator read is held open. */
function dropAndHoldNextRead(view: {
  rerender: (ui: ReactNode) => void;
}): void {
  mocks.state.hold = true;
  mocks.state.unreachable.add("host-notifications");
  act(() => {
    void queryClient.refetchQueries({
      predicate: (query) =>
        JSON.stringify(query.queryKey).includes("indicatorState"),
    });
  });
  view.rerender(<Tree />);
}

/** The existing invalidation edge: the host's scope is invalidated, and the next indicator read is held open. */
function invalidateAndHoldNextRead(): void {
  mocks.state.hold = true;
  act(() => {
    void queryClient.invalidateQueries({
      predicate: (query) =>
        JSON.stringify(query.queryKey).includes("indicatorState"),
    });
  });
}

beforeEach(() => {
  listed.tasks = [quiet()];
  mocks.state.unread = new Set();
  mocks.state.hold = false;
  mocks.state.held = null;
  mocks.state.unreachable = new Set();
  mocks.state.indicatorReads = 0;
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  __resetAgentActivityStoreForTests();
  __setAgentActivityPlaneAnsweringForTests();
  __setAgentActivityStateForTests({}, "cloud", "connected");
  useCloudNotificationsStore.setState({
    hasSnapshot: true,
    connectionState: "connected",
  });
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId: "user-life", userName: "Ada", email: "ada@example.com" },
    contextMetadata: { userId: "user-life", username: "ada" },
  });
});

afterEach(() => {
  cleanup();
  useCloudNotificationsStore.getState().reset();
  __resetAgentActivityStoreForTests();
  useAuthStore.setState({
    status: "signed-out",
    profile: null,
    contextMetadata: null,
  });
});

describe("the Activity list over an indicator read that is answered, held and answered again", () => {
  it("never lets a cached empty answer remove a quiet task while the host is unreachable and the replacement read is held, and shows the changed answer once it lands", async () => {
    const view = render(<Tree />);
    // The first answer is empty and complete: the quiet task has left.
    await waitFor(() =>
      expect(screen.queryAllByTestId("bot-activity-task")).toHaveLength(0),
    );

    dropAndHoldNextRead(view);
    expect(bandNow()).toBe("unknown");

    // Reachable again, but the replacement read is still held: the cached
    // empty answer is not a current one.
    mocks.state.unreachable.delete("host-notifications");
    view.rerender(<Tree />);
    expect(mocks.state.held).not.toBeNull();
    expect(bandNow()).toBe("unknown");

    // The host's changed answer lands.
    mocks.state.unread.add("t-life");
    await act(async () => {
      mocks.state.held?.resolve(mocks.answer({ epicIds: ["t-life"] }));
      await Promise.resolve();
    });
    await waitFor(() => expect(bandNow()).toBe("unseen"));
  });

  it("never shows a cached positive as current while the host is unreachable and the replacement read is held, and lets the task leave once the empty answer lands", async () => {
    mocks.state.unread.add("t-life");
    const view = render(<Tree />);
    await waitFor(() => expect(bandNow()).toBe("unseen"));

    dropAndHoldNextRead(view);
    expect(bandNow()).toBe("unknown");

    mocks.state.unreachable.delete("host-notifications");
    view.rerender(<Tree />);
    expect(mocks.state.held).not.toBeNull();
    expect(bandNow()).toBe("unknown");

    mocks.state.unread.delete("t-life");
    await act(async () => {
      mocks.state.held?.resolve(mocks.answer({ epicIds: ["t-life"] }));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.queryAllByTestId("bot-activity-task")).toHaveLength(0),
    );
  });
});

describe("the Activity list over an indicator read invalidated while the replacement is held", () => {
  it("shows unknown, not the cached empty answer, from the invalidation until the replacement lands, then the changed answer", async () => {
    const view = render(<Tree />);
    await waitFor(() =>
      expect(screen.queryAllByTestId("bot-activity-task")).toHaveLength(0),
    );

    // The host stays reachable: only the invalidation makes the cache old.
    invalidateAndHoldNextRead();
    view.rerender(<Tree />);
    expect(mocks.state.held).not.toBeNull();
    expect(bandNow()).toBe("unknown");

    mocks.state.unread.add("t-life");
    await act(async () => {
      mocks.state.held?.resolve(mocks.answer({ epicIds: ["t-life"] }));
      await Promise.resolve();
    });
    await waitFor(() => expect(bandNow()).toBe("unseen"));
  });

  it("shows unknown, not the cached positive, from the invalidation until the replacement lands, then lets the task leave", async () => {
    mocks.state.unread.add("t-life");
    const view = render(<Tree />);
    await waitFor(() => expect(bandNow()).toBe("unseen"));

    invalidateAndHoldNextRead();
    view.rerender(<Tree />);
    expect(mocks.state.held).not.toBeNull();
    expect(bandNow()).toBe("unknown");

    mocks.state.unread.delete("t-life");
    await act(async () => {
      mocks.state.held?.resolve(mocks.answer({ epicIds: ["t-life"] }));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.queryAllByTestId("bot-activity-task")).toHaveLength(0),
    );
  });

  it("reads the cache as old when it was invalidated while the read was disabled: unknown on re-enable until the held read lands", async () => {
    const view = render(<Tree />);
    await waitFor(() =>
      expect(screen.queryAllByTestId("bot-activity-task")).toHaveLength(0),
    );

    // The list empties, so the indicator read is disabled; the cache is invalidated meanwhile.
    listed.tasks = [];
    view.rerender(<Tree />);
    act(() => {
      void queryClient.invalidateQueries({
        predicate: (query) =>
          JSON.stringify(query.queryKey).includes("indicatorState"),
      });
    });

    // The task is listed again: the read is enabled, and its replacement is held.
    mocks.state.hold = true;
    listed.tasks = [quiet()];
    view.rerender(<Tree />);
    await waitFor(() => expect(mocks.state.held).not.toBeNull());
    expect(bandNow()).toBe("unknown");

    mocks.state.unread.add("t-life");
    await act(async () => {
      mocks.state.held?.resolve(mocks.answer({ epicIds: ["t-life"] }));
      await Promise.resolve();
    });
    await waitFor(() => expect(bandNow()).toBe("unseen"));
  });
});

describe("the Activity list over an indicator cache invalidated and not yet refetched", () => {
  it.each([
    ["an empty cached answer", false, null],
    ["a positive cached answer", true, "unseen"],
  ] as const)(
    "does not treat %s as current once it is marked invalid and no read has started: unknown until the refetch lands",
    async (_name, unread, firstBand) => {
      if (unread) mocks.state.unread.add("t-life");
      const view = render(<Tree />);
      await waitFor(() => expect(bandNow()).toBe(firstBand));

      // Marked invalid, with no refetch begun: nothing is in flight and the cache is old.
      act(() => {
        void queryClient.invalidateQueries({
          predicate: (query) =>
            JSON.stringify(query.queryKey).includes("indicatorState"),
          refetchType: "none",
        });
      });
      view.rerender(<Tree />);
      expect(mocks.state.held).toBeNull();
      expect(bandNow()).toBe("unknown");

      // The refetch runs and lands: current again.
      await act(async () => {
        await queryClient.refetchQueries({
          predicate: (query) =>
            JSON.stringify(query.queryKey).includes("indicatorState"),
        });
      });
      await waitFor(() => expect(bandNow()).toBe(firstBand));
    },
  );
});

describe("ordinary notification indicators over the same read", () => {
  function Ordinary(): ReactNode {
    const indicators = useNotificationIndicators({
      hostId: null,
      epicIds: ["t-life"],
      chatIds: [],
      enabled: true,
    });
    return (
      <div
        data-testid="ordinary"
        data-unread={String(
          Object.hasOwn(indicators.epics, "t-life") &&
            indicators.epics["t-life"].unreadDone,
        )}
      />
    );
  }

  it("shows the host’s changed answer after the existing invalidation", async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <Ordinary />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("ordinary").dataset.unread).toBe("false"),
    );

    mocks.state.unread.add("t-life");
    // The host-scope invalidation the app already issues on a host event.
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: ["host", "host-notifications"],
      });
    });
    await waitFor(() =>
      expect(screen.getByTestId("ordinary").dataset.unread).toBe("true"),
    );
  });

  it("reads again on remount, so an indicator that returns to view shows the host's changed answer", async () => {
    const first = render(
      <QueryClientProvider client={queryClient}>
        <Ordinary />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("ordinary").dataset.unread).toBe("false"),
    );
    expect(mocks.state.indicatorReads).toBe(1);

    first.unmount();
    // The host's answer changes while nothing observes the read.
    mocks.state.unread.add("t-life");
    render(
      <QueryClientProvider client={queryClient}>
        <Ordinary />
      </QueryClientProvider>,
    );

    // The remount asks the host again, and the new answer reaches the indicator.
    await waitFor(() => expect(mocks.state.indicatorReads).toBe(2));
    await waitFor(() =>
      expect(screen.getByTestId("ordinary").dataset.unread).toBe("true"),
    );
  });
});
