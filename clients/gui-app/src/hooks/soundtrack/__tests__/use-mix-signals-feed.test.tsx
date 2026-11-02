/**
 * The hook that publishes `MixSignals`, through the REAL notification stores,
 * the real agent-activity plane, the real `useBotActivity` over a stub
 * `bot.subscribe` session, and a real router over a memory history. Only the
 * host lookups the notification feed needs are scripted, as in the merged
 * notification projection suite.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostNotificationEntry,
  HostNotificationSeverity,
  HostNotificationsSummary,
} from "@traycer/protocol/host/notifications/contracts";
import type {
  BotActivity,
  BotRecord,
  BotSessionActivity,
} from "@traycer/protocol/host/bot/schemas";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import {
  StubHostStreamClient,
  StubSession,
} from "@/hooks/bots/__tests__/bot-subscribe-stub-stream";
import { __resetBotSubscriptionsForTesting } from "@/hooks/bots/use-bot-subscription";
import type { MixSignals } from "@/lib/soundtrack/signals";
import { systemTabOverlaySearchSchema } from "@/lib/system-tab-overlay-search";
import {
  __resetAgentActivityStoreForTests,
  __setHostAgentActivityStateForTests,
} from "@/stores/agent-activity-store";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import { __resetAppLocalNotificationsStoreForTests } from "@/stores/notifications/app-local-notifications-store";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";
import {
  __resetHostNotificationsStoreForTests,
  useHostNotificationsStore,
} from "@/stores/notifications/host-notifications-store";
import { __resetNotificationsStoreForTests } from "@/stores/notifications/notifications-store";
import { useMixSignalsFeed } from "../use-mix-signals-feed";

const mocks = vi.hoisted(() => ({
  streamClient: null as StubHostStreamClient | null,
}));

vi.mock("@/lib/notifications/notification-feed-mode", async (importActual) => ({
  ...(await importActual<
    typeof import("@/lib/notifications/notification-feed-mode")
  >()),
  useNotificationFeedMode: () => "local",
  useNotificationFeedModeSettling: () => false,
}));
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-local",
}));
vi.mock("@/hooks/notifications/use-notification-host", () => ({
  useNotificationResolveHostId: () => "host-local",
  useNotificationResolveHost: () => ({ hostId: "host-local", client: null }),
}));
vi.mock("@/hooks/host/use-host-directory-entry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-directory-entry")
  >()),
  useHostDirectoryEntry: () => mockLocalHostEntry,
}));
// The real shared `bot.subscribe` subscription, over a stub session.
vi.mock("@/hooks/bots/use-bot-subscription", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/bots/use-bot-subscription")>();
  return {
    ...actual,
    useBotSubscriptionForHost: (args: {
      readonly hostId: string;
      readonly botId: string;
      readonly enabled: boolean;
    }) =>
      actual.useBotSubscriptionForClient({
        ...args,
        client: mocks.streamClient,
      }),
  };
});

const NOW = 1_700_000_000_000;
const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BOT_HOST_ID = "host-bound";

function hostEntry(
  id: string,
  severity: Exclude<HostNotificationSeverity, "info">,
  updatedAt: number,
  readAt: number | null,
): HostNotificationEntry {
  const common = {
    id,
    updatedAt,
    readAt,
    sourceRef: id,
    epicId: "epic-1",
    chatId: "chat-1",
  };
  if (severity === "needs_action") {
    return {
      ...common,
      kind: "interview.requested",
      severity,
      outcome: null,
      resolvedAt: null,
      payload: {
        kind: "interview",
        epicId: "epic-1",
        chatId: "chat-1",
        chatTitle: "A private chat title",
        taskTitle: "A private task title",
        interviewBlockId: "block-1",
      },
    };
  }
  const outcome = severity === "failure" ? "errored" : "completed";
  return {
    ...common,
    kind: "agent.stopped",
    severity,
    outcome,
    payload: {
      kind: "chat",
      epicId: "epic-1",
      chatId: "chat-1",
      agentName: "A private agent name",
      taskTitle: "A private task title",
      outcome,
    },
  };
}

function seedFeed(entries: readonly HostNotificationEntry[]): void {
  const summary: HostNotificationsSummary = {
    unreadCount: entries.filter((entry) => entry.readAt === null).length,
    attentionCount: 0,
  };
  act(() => {
    useHostNotificationsStore.getState().applySnapshot({
      attention: { entries: [], nextCursor: null },
      recent: { entries, nextCursor: null },
      summary,
    });
  });
}

function setTurns(
  hostId: string,
  turnsByEpic: Readonly<Record<string, readonly string[]>>,
): void {
  const byEpic: Record<string, { working: string[]; turn: string[] }> = {};
  for (const [epicId, turn] of Object.entries(turnsByEpic)) {
    byEpic[epicId] = { working: [], turn: [...turn] };
  }
  act(() => {
    __setHostAgentActivityStateForTests(hostId, byEpic, "local", null);
  });
}

const publish = vi.fn<(signals: MixSignals) => void>();

function lastPublished(): MixSignals {
  const last = publish.mock.calls.at(-1);
  if (last === undefined) throw new Error("nothing was published");
  return last[0];
}

function Probe() {
  useMixSignalsFeed(publish);
  return null;
}

function buildRouter(initialPath: string) {
  const root = createRootRoute({
    validateSearch: (raw) => systemTabOverlaySearchSchema.parse(raw),
    component: Probe,
  });
  const paths = ["/", "/epics/$epicId/$tabId"];
  return createRouter({
    routeTree: root.addChildren(
      paths.map((path) =>
        createRoute({
          getParentRoute: () => root,
          path,
          component: () => null,
        }),
      ),
    ),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

async function mountAt(initialPath: string) {
  const router = buildRouter(initialPath);
  await act(async () => {
    await router.load();
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const REPLYING: BotSessionActivity = {
  state: "replying",
  startedAt: 3,
  step: null,
  requestId: null,
  reason: null,
};
const IDLE: BotSessionActivity = {
  ...REPLYING,
  state: "idle",
  startedAt: null,
};

let botStream = new StubSession();

function emitBotActivity(activity: BotActivity): void {
  const bot: BotRecord = {
    botId: BOT_ID,
    environmentId: "env-1",
    createdByUserId: "user-1",
    title: "Tracy",
    harness: "claude",
    model: "claude-sonnet-4",
    effort: null,
    profile: null,
    trunkChatId: "trunk-1",
    boundHostId: BOT_HOST_ID,
    hostEpoch: 0,
    createdAt: 1,
    archivedAt: null,
    directive: "Watches CI.",
    replyMode: "direct",
    appConversationChatId: "conversation-1",
  };
  act(() => {
    botStream.emit({
      kind: "snapshot",
      bot,
      tasks: [],
      openRequestCount: null,
      conversationsRevision: null,
      notificationSubscriptions: null,
      surfaceActions: null,
      stoppedNotificationWatches: null,
      boundHost: { hostId: BOT_HOST_ID, epoch: 0, isThisHost: true },
      activity,
      hasBinaryPayload: false,
    });
  });
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "Date"],
    now: NOW,
  });
  publish.mockReset();
  __resetHostNotificationsStoreForTests();
  __resetAppLocalNotificationsStoreForTests();
  __resetNotificationsStoreForTests();
  __resetAgentActivityStoreForTests();
  useCloudNotificationsStore.getState().reset();
  botStream = new StubSession();
  mocks.streamClient = new StubHostStreamClient(botStream);
});

afterEach(() => {
  cleanup();
  useTracySurfaceStore.setState({
    open: false,
    hostId: null,
    botId: null,
    visitedBotIds: [],
  });
  __resetBotSubscriptionsForTesting();
  mocks.streamClient = null;
  vi.useRealTimers();
});

describe("useMixSignalsFeed", () => {
  it("publishes the feed's unread blocking and failure rows and its recent done rows", async () => {
    seedFeed([
      hostEntry("prompt-unread", "needs_action", NOW - 5000, null),
      hostEntry("prompt-read", "needs_action", NOW - 5000, NOW - 1000),
      hostEntry("failure-unread", "failure", NOW - 5000, null),
      hostEntry("failure-read", "failure", NOW - 5000, NOW - 1000),
      hostEntry("done-recent", "done", NOW - 30_000, null),
      hostEntry("done-old", "done", NOW - 120_000, null),
    ]);
    await mountAt("/");

    expect(lastPublished()).toEqual({
      view: "home",
      working: 0,
      blocking: 1,
      failure: 1,
      done: 1,
    });
  });

  it("publishes again when a done row's window ends, with nothing written anywhere", async () => {
    seedFeed([hostEntry("done-recent", "done", NOW - 30_000, null)]);
    await mountAt("/");
    expect(lastPublished().done).toBe(1);

    act(() => {
      vi.advanceTimersByTime(59_000);
    });
    expect(lastPublished().done).toBe(1);

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(lastPublished()).toEqual({
      view: "home",
      working: 0,
      blocking: 0,
      failure: 0,
      done: 0,
    });
  });

  it("counts the agents with a turn in flight across hosts, up to three", async () => {
    await mountAt("/");
    setTurns("host-a", { "epic-1": ["agent-1", "agent-2"] });
    expect(lastPublished().working).toBe(2);

    setTurns("host-b", { "epic-2": ["agent-2", "agent-3", "agent-4"] });
    expect(lastPublished().working).toBe(3);
  });

  it("reads the settings overlay off the location's search", async () => {
    await mountAt("/epics/epic-1/tab-1?settingsOverlay=true");
    expect(lastPublished().view).toBe("settings");
  });

  it("follows the router when the person goes to another view", async () => {
    const router = await mountAt("/");
    expect(lastPublished().view).toBe("home");
    await act(async () => {
      router.history.push("/epics/epic-1/tab-1");
      await router.load();
    });
    expect(lastPublished().view).toBe("task");
  });

  it("adds the Tracy bot's replying sessions to the working count", async () => {
    useTracySurfaceStore.getState().openSurface(BOT_HOST_ID);
    useTracySurfaceStore.getState().selectChannel(BOT_ID);
    await mountAt("/");
    setTurns("host-a", { "epic-1": ["agent-1"] });
    expect(lastPublished().working).toBe(1);

    emitBotActivity({
      trunk: REPLYING,
      threads: { "thread-1": REPLYING, "thread-2": IDLE },
    });
    expect(lastPublished().working).toBe(3);

    emitBotActivity({ trunk: IDLE, threads: {} });
    expect(lastPublished().working).toBe(1);
  });
});
