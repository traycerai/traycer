import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotTaskEntry } from "@traycer/protocol/host/bot/schemas";
import type { ListTaskLight } from "@traycer/protocol/host/epic/unary-schemas";
import type { HostNotificationsIndicatorState } from "@traycer/protocol/host/notifications/host-notifications";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRendererContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { publishAgentActivity } from "@/__tests__/agent-activity-harness";
import { BotActivityPage } from "@/components/bots/bot-activity-page";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { UnreadCountBadge } from "@/components/notifications/unread-count-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useBotActiveTasks } from "@/hooks/bots/use-bot-active-tasks";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  useHostBinding,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { UNRESOLVED_BOT_MEMBERS } from "@/lib/bots/bot-member-names";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { WindowsBridgeContext } from "@/providers/windows-bridge-context";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { ChatProjection, TreeNode } from "@/stores/epics/open-epic/types";
import "@/index.css";

/**
 * A BOT'S ACTIVITY TAB (Tracy Bots T135): the real `BotActivityPage` over the
 * real `useBotActiveTasks`, under the channel header's two views with the
 * Activity count in `UnreadCountBadge`'s inline seat. The host answers the
 * notification indicators and the tasks' titles; the activity plane and one
 * task's open session (the only thing that names a task's agents) are put in
 * place before the first render. Nothing of the page is reimplemented.
 *
 * Rows: a task waiting on the person (its session open in this window, so
 * its agents fold under a chevron), a periodic task with agents working, a
 * finished task whose result is unseen, a periodic task with nothing going
 * on, and a quiet, seen task that the list leaves out. `?empty=1` lists
 * nothing; `?theme=dark` the dark theme.
 */
const HOST_ID = "bot-activity-tab-host";
const BOT_ID = "bot-activity-tab-bot";
const THREAD_ID = "thread-release";
const NOW = Date.now();
const MINUTE = 60_000;

const params = new URLSearchParams(window.location.search);
if (params.get("theme") === "dark") {
  document.documentElement.classList.add("dark");
}
const empty = params.get("empty") === "1";

const localHost = {
  hostId: HOST_ID,
  websocketUrl: "ws://127.0.0.1:9/rpc",
  version: "1.2.3",
  pid: 4545,
  systemHostName: "bot-activity-tab-fixture",
  displayName: "bot-activity-tab-fixture",
  availability: "available",
} as const;

function entry(
  taskId: string,
  fields: Partial<Omit<BotTaskEntry, "taskId">>,
): BotTaskEntry {
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
    ...fields,
  };
}

const tasks: ReadonlyArray<BotTaskEntry> = empty
  ? []
  : [
      entry("task-ipad", {
        state: "ended",
        endedReason: "completed",
        lastCheckinAt: NOW - 40 * MINUTE,
      }),
      entry("task-roster", {
        cadence: { kind: "every", seconds: 86_400 },
        nextAt: NOW + 3 * 60 * MINUTE,
        lastCheckinAt: NOW - 21 * 60 * MINUTE,
        label: "flaky shards, last 24 h",
      }),
      entry("task-release", {
        createdByChatId: THREAD_ID,
        inputNeeded: [
          {
            hostId: HOST_ID,
            hostName: "Tanveer's MacBook",
            agentChatId: "agent-writer",
            surfaceId: "surface-1",
            surface: {
              kind: "approval",
              approvalId: "approval-1",
              tool: "gh pr edit",
              summary: "the PR body",
              tier: null,
              requiresPerson: true,
              askedAt: NOW - 2 * MINUTE,
            },
            reportedAt: NOW - 2 * MINUTE,
            acceptsActions: true,
          },
        ],
      }),
      entry("task-weekly", {
        cadence: { kind: "every", seconds: 7 * 86_400 },
        nextAt: NOW + 2 * 86_400_000,
        lastCheckinAt: NOW - 5 * 86_400_000,
      }),
      entry("task-quiet", {
        state: "ended",
        endedReason: "completed",
        lastCheckinAt: NOW - 3 * 60 * MINUTE,
      }),
    ];

const TITLES: Readonly<Record<string, string>> = {
  "task-release": "Release notes draft for 1.9",
  "task-roster": "Nightly flake roster",
  "task-ipad": "iPad switcher scroller layer fix",
  "task-weekly": "Weekly dependency sweep",
  "task-quiet": "Slack uninstall copy",
};

function taskLight(id: string): ListTaskLight {
  return {
    epic: {
      light: {
        id,
        title: TITLES[id] ?? id,
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "draft",
        createdAt: 0,
        updatedAt: 0,
        createdBy: "bot-activity-tab-user",
        version: "1.0.0",
      },
      permission: null,
      repos: [],
      workspaces: [],
      roomInfo: null,
    },
    phase: null,
    pinned: false,
  };
}

function indicator(
  fields: Partial<HostNotificationsIndicatorState>,
): HostNotificationsIndicatorState {
  return {
    pendingFork: false,
    pendingApproval: false,
    pendingInterview: false,
    unreadFailure: false,
    unreadDone: false,
    unreadCount: 0,
    ...fields,
  };
}

const EPIC_INDICATORS: Readonly<
  Record<string, HostNotificationsIndicatorState>
> = {
  "task-ipad": indicator({ unreadDone: true, unreadCount: 1 }),
};
const CHAT_INDICATORS: Readonly<
  Record<string, HostNotificationsIndicatorState>
> = {
  "agent-writer": indicator({ pendingApproval: true, unreadCount: 1 }),
};

const thread: BotThreadSummary = {
  threadId: THREAD_ID,
  conversationId: "channel-1",
  sessionChatId: "session-release",
  anchor: null,
  replyCount: 4,
  lastReplyAt: NOW - 5 * MINUTE,
  openRequestCount: 0,
  costUsd: null,
};

const windowsBridgeValue = { bridge: null, hasHydrated: true } as const;
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

let requestCounter = 0;
const messengerFactory: MessengerFactory<HostRpcRegistry> = ({ registry }) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry,
    requestId: () => `bot-activity-tab-${String(++requestCounter)}`,
    handlers: {
      "host.status": () => ({
        ready: true,
        hostVersion: "1.2.3",
        protocolVersion: { major: 1, minor: 2 },
        busy: false,
        busySessionCount: 0,
        updateProgress: null,
        busyBreakdown: null,
        updateOperation: null,
        updateTransaction: null,
        storeFormats: null,
        install: null,
        processMemory: null,
        crossHostMessaging: null,
        sessions: null,
        updatesExternallyManaged: null,
        previousExit: null,
      }),
      "host.notifications.indicatorState": (request) => ({
        epics: Object.fromEntries(
          request.epicIds.flatMap((id) =>
            Object.hasOwn(EPIC_INDICATORS, id)
              ? [[id, EPIC_INDICATORS[id]]]
              : [],
          ),
        ),
        chats: Object.fromEntries(
          request.chatIds.flatMap((id) =>
            Object.hasOwn(CHAT_INDICATORS, id)
              ? [[id, CHAT_INDICATORS[id]]]
              : [],
          ),
        ),
        complete: true,
      }),
      "epic.getTaskContexts": (request) => ({
        tasks: Object.fromEntries(
          request.taskIds.map((id) => [
            id,
            { status: "found" as const, task: taskLight(id) },
          ]),
        ),
      }),
    },
  });

// The activity plane: two agents working in the roster task (one in a
// turn, one in the background) and the release task's reader in a turn.
publishAgentActivity([
  {
    hostId: HOST_ID,
    byEpic: {
      "task-roster": {
        working: ["agent-shard-a", "agent-shard-b"],
        turn: ["agent-shard-a"],
      },
      "task-release": { working: ["agent-reader"], turn: ["agent-reader"] },
    },
  },
]);

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

/** The release task's open session: a lead agent and the two it started. */
function openReleaseSession(): void {
  const agents: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly parentId: string | null;
    readonly updatedAt: number;
  }> = [
    {
      id: "agent-lead",
      title: "Release notes lead",
      parentId: null,
      updatedAt: NOW - 30 * MINUTE,
    },
    {
      id: "agent-writer",
      title: "Draft writer",
      parentId: "agent-lead",
      updatedAt: NOW - 2 * MINUTE,
    },
    {
      id: "agent-reader",
      title: "Changelog reader",
      parentId: "agent-lead",
      updatedAt: NOW - 11 * MINUTE,
    },
  ];
  const handle = __getOpenEpicRegistryForTests().acquire("task-release", () =>
    openStoreForTest({
      epicId: "task-release",
      userId: null,
      factories: {
        streamClientFactory: noopStreamClientFactory,
        laneSelection: null,
      },
      writeCommand: null,
    }),
  );
  const nodeById: Record<string, TreeNode> = {};
  const childrenByParent: Record<string, string[]> = {};
  const byId: Record<string, ChatProjection> = {};
  for (const agent of agents) {
    nodeById[agent.id] = {
      id: agent.id,
      parentId: agent.parentId,
      title: agent.title,
      type: "chat",
      status: null,
      createdAt: NOW - 60 * MINUTE,
      updatedAt: agent.updatedAt,
    };
    byId[agent.id] = {
      id: agent.id,
      title: agent.title,
      parentId: agent.parentId,
      createdAt: NOW - 60 * MINUTE,
      updatedAt: agent.updatedAt,
      userId: "bot-activity-tab-user",
      ownedByViewer: true,
      hostId: HOST_ID,
      isTitleEditedByUser: false,
      docResident: false,
      settings: null,
      archivedAt: null,
    };
    if (agent.parentId !== null) {
      childrenByParent[agent.parentId] = [
        ...(childrenByParent[agent.parentId] ?? []),
        agent.id,
      ];
    }
  }
  handle.store.setState({
    tree: { rootIds: ["agent-lead"], childrenByParent, nodeById },
    chats: { allIds: agents.map((agent) => agent.id), byId },
  });
}
if (!empty) openReleaseSession();

export function SignedInFixture(props: {
  readonly children: ReactNode;
}): ReactElement {
  const authStatus = useAuthStore((state) => state.status);
  useEffect(() => {
    if (authStatus === "signed-in") return;
    useAuthStore.getState().setSignedIn(
      {
        userId: "bot-activity-tab-user",
        userName: "Activity Tab User",
        email: "activity-tab@example.invalid",
      },
      { userId: "bot-activity-tab-user", username: "Activity Tab User" },
      [],
    );
  }, [authStatus]);
  return <>{props.children}</>;
}

/** Holds the tab back until the host client has its request context. */
export function RequestContext(props: {
  readonly children: ReactNode;
}): ReactNode {
  const binding = useHostBinding();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (ready || binding === null) return;
    const unsubscribe = binding.hostClient.onChange(() => setReady(true));
    binding.hostClient.setRequestContext(
      createRendererContextFixture({ bearerToken: "fixture" }),
    );
    return unsubscribe;
  }, [binding, ready]);
  return ready ? props.children : null;
}

export function ActivityTab(): ReactElement {
  const active = useBotActiveTasks(tasks);
  return (
    <Tabs
      defaultValue="activity"
      className="flex h-safe-dvh min-w-0 flex-col gap-0"
      data-testid="bot-activity-tab"
    >
      <header className="flex shrink-0 flex-col gap-1 px-4 pt-3">
        <span className="text-ui-sm font-semibold">Tracy</span>
        <TabsList variant="line" aria-label="Channel view">
          <TabsTrigger value="messages">Messages</TabsTrigger>
          <TabsTrigger value="activity" data-testid="bot-tab-view-activity">
            Activity
            <UnreadCountBadge
              count={active.rows.length}
              size="xs"
              testId="bot-tab-activity-count"
              corner={null}
            />
          </TabsTrigger>
        </TabsList>
      </header>
      <TabsContent value="activity" className="flex min-h-0 flex-1 flex-col">
        <BotActivityPage
          botId={BOT_ID}
          hostId={HOST_ID}
          botTitle="Tracy"
          boundHere
          active={active}
          resolveMember={UNRESOLVED_BOT_MEMBERS}
          threads={[thread]}
        />
      </TabsContent>
    </Tabs>
  );
}

const runnerHost = new MockRunnerHost({
  signInUrl: "http://127.0.0.1:9/sign-in",
  authnBaseUrl: "http://127.0.0.1:9",
  localHost,
  hosts: [],
  workspaceFolderPickerPaths: undefined,
  hasLocalHost: undefined,
  traycerCli: new MockTraycerCli(),
});

function buildRouter() {
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <HostRuntimeProvider
            registry={hostRpcRegistry}
            messengerFactory={messengerFactory}
            invalidator={null}
            requestId={null}
            remoteFetcher={() =>
              Promise.resolve({ kind: "hosts", entries: [] })
            }
            fallback={<div data-testid="bot-activity-tab-fallback" />}
          >
            <WindowsBridgeContext.Provider value={windowsBridgeValue}>
              <TooltipProvider>
                <SignedInFixture>
                  <RequestContext>
                    <TabHostContext.Provider value={HOST_ID}>
                      <ActivityTab />
                    </TabHostContext.Provider>
                  </RequestContext>
                </SignedInFixture>
              </TooltipProvider>
            </WindowsBridgeContext.Provider>
          </HostRuntimeProvider>
        </RunnerHostProvider>
      </QueryClientProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

const root = document.querySelector("#root");
if (root === null) throw new Error("bot activity tab fixture root missing");
createRoot(root).render(<RouterProvider router={buildRouter()} />);
