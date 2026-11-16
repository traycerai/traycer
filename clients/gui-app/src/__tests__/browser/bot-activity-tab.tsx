import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
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
import { recordNegotiatedHostMethods } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { publishAgentActivity } from "@/__tests__/agent-activity-harness";
import { BotActivityPage } from "@/components/bots/bot-activity-page";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { SurfacePresentationBoundary } from "@/components/layout/surface-presentation-boundary";
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
import { NotificationFeedModeContext } from "@/lib/notifications/notification-feed-mode-context";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { WindowsBridgeContext } from "@/providers/windows-bridge-context";
import { __setAgentActivityPlaneAnsweringForTests } from "@/stores/agent-activity-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { ChatProjection, TreeNode } from "@/stores/epics/open-epic/types";
import { useSettingsStore } from "@/stores/settings/settings-store";
import "@/lib/theme-applier";
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
 * on, and a quiet, seen task whose unknown waiting state keeps it listed.
 * `?empty=1` lists
 * nothing; `?theme=dark` the dark theme, set as the app sets it, through the
 * settings store the theme applier follows.
 */
const HOST_ID = "bot-activity-tab-host";
const BOT_ID = "bot-activity-tab-bot";
const THREAD_ID = "thread-release";
const NOW = Date.now();
const MINUTE = 60_000;

const params = new URLSearchParams(window.location.search);
useSettingsStore
  .getState()
  .setTheme(params.get("theme") === "dark" ? "dark" : "light");
const empty = params.get("empty") === "1";
// `?working=1` lists one more task, kept in the list only by a working agent.
const withWorking = params.get("working") === "1";
// `?pane=1` seats the tab in a pane that `unfocusPaneAnd` stops focusing.
const withPane = params.get("pane") === "1";
// `?archived=1` adds an archived agent to the release task's session: only the
// host's chat indicator for it keeps it listed under the task.
const withArchivedAgent = params.get("archived") === "1";

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
      ...(withWorking
        ? [
            entry("task-working", {
              // Tracking with no schedule and no completion to wait for: only
              // the working agent keeps it listed.
              cadence: { kind: "none" },
              inputNeeded: [],
              lastCheckinAt: NOW - 3 * MINUTE,
            }),
          ]
        : []),
    ];

const TITLES: Readonly<Record<string, string>> = {
  "task-release": "Release notes draft for 1.9",
  "task-roster": "Nightly flake roster",
  "task-ipad": "iPad switcher scroller layer fix",
  "task-weekly": "Weekly dependency sweep",
  "task-quiet": "Slack uninstall copy",
  "task-working": "Working-only task",
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
const CHAT_INDICATORS: Record<string, HostNotificationsIndicatorState> = {
  "agent-writer": indicator({ pendingApproval: true, unreadCount: 1 }),
  "agent-archived": indicator({ pendingApproval: true, unreadCount: 1 }),
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

// When set, the host cannot read the indicators of the archived agent's chat.
let archivedIndicatorReadFails = false;

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
      "host.notifications.indicatorState": (request) => {
        if (
          archivedIndicatorReadFails &&
          request.chatIds.includes("agent-archived")
        )
          throw new Error("the host could not read the indicators");
        return {
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
        };
      },
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
function publishActivity(includeWorkingTask: boolean): void {
  publishAgentActivity([
    {
      hostId: HOST_ID,
      byEpic: {
        "task-roster": {
          working: ["agent-shard-a", "agent-shard-b"],
          turn: ["agent-shard-a"],
        },
        "task-release": { working: ["agent-reader"], turn: ["agent-reader"] },
        ...(includeWorkingTask
          ? { "task-working": { working: ["agent-w"], turn: ["agent-w"] } }
          : {}),
      },
    },
  ]);
}
publishActivity(withWorking);

// `?working=1` also puts the activity plane in its answering state and serves
// the cloud notification feed, connected with its snapshot: with the host's
// indicators answering too, every source vouches for a quiet task, so a row
// whose agents finish may leave on that store write alone.
if (withWorking) {
  __setAgentActivityPlaneAnsweringForTests();
  useCloudNotificationsStore.setState({ accountId: "fixture-account" });
  useCloudNotificationsStore.getState().applySnapshot({
    rows: [],
    version: 1,
    summary: { totalCount: 0, unreadCount: 0, attentionCount: 0 },
  });
  useCloudNotificationsStore.getState().setConnectionState("connected");
}

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

type SessionAgent = {
  readonly id: string;
  readonly title: string;
  readonly parentId: string | null;
  readonly updatedAt: number;
  readonly archivedAt: number | null;
};

const RELEASE_AGENTS: ReadonlyArray<SessionAgent> = [
  {
    id: "agent-lead",
    title: "Release notes lead",
    parentId: null,
    updatedAt: NOW - 30 * MINUTE,
    archivedAt: null,
  },
  {
    id: "agent-writer",
    title: "Draft writer",
    parentId: "agent-lead",
    updatedAt: NOW - 2 * MINUTE,
    archivedAt: null,
  },
  {
    id: "agent-reader",
    title: "Changelog reader",
    parentId: "agent-lead",
    updatedAt: NOW - 11 * MINUTE,
    archivedAt: null,
  },
];

const ARCHIVED_AGENT: SessionAgent = {
  id: "agent-archived",
  title: "Archived helper",
  parentId: "agent-lead",
  updatedAt: NOW - 40 * MINUTE,
  archivedAt: NOW - 30 * MINUTE,
};

const ROSTER_AGENTS: ReadonlyArray<SessionAgent> = [
  {
    id: "agent-shard-a",
    title: "Shard A",
    parentId: null,
    updatedAt: NOW - 4 * MINUTE,
    archivedAt: null,
  },
  {
    id: "agent-shard-b",
    title: "Shard B",
    parentId: null,
    updatedAt: NOW - 6 * MINUTE,
    archivedAt: null,
  },
];

/**
 * A task's open session: its agents in a real open-epic store, and a window
 * hook that drops one agent with the store's own update, so a spec can remove
 * an agent while the person's focus is on it. The page is not rendered again
 * by that call.
 */
function openSession(
  epicId: string,
  agents: ReadonlyArray<SessionAgent>,
  removeHook: string,
): void {
  const handle = __getOpenEpicRegistryForTests().acquire(epicId, () =>
    openStoreForTest({
      epicId,
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
      archivedAt: agent.archivedAt,
    };
    if (agent.parentId !== null) {
      childrenByParent[agent.parentId] = [
        ...(childrenByParent[agent.parentId] ?? []),
        agent.id,
      ];
    }
  }
  handle.store.setState({
    tree: {
      rootIds: agents
        .filter((agent) => agent.parentId === null)
        .map((agent) => agent.id),
      childrenByParent,
      nodeById,
    },
    chats: { allIds: agents.map((agent) => agent.id), byId },
  });
  // The task store's own update, for a spec that drops an agent while the
  // person's focus is on it: the page is not rendered again by this call.
  Object.defineProperty(window, removeHook, {
    value: (agentId: string): void => {
      const state = handle.store.getState();
      handle.store.setState({
        tree: {
          ...state.tree,
          nodeById: Object.fromEntries(
            Object.entries(state.tree.nodeById).filter(
              ([id]) => id !== agentId,
            ),
          ),
          childrenByParent: Object.fromEntries(
            Object.entries(state.tree.childrenByParent).map(
              ([parent, children]) => [
                parent,
                children.filter((id) => id !== agentId),
              ],
            ),
          ),
        },
        chats: {
          ...state.chats,
          allIds: state.chats.allIds.filter((id) => id !== agentId),
          byId: Object.fromEntries(
            Object.entries(state.chats.byId).filter(([id]) => id !== agentId),
          ),
        },
      });
    },
  });
}
if (!empty) {
  openSession(
    "task-release",
    withArchivedAgent ? [...RELEASE_AGENTS, ARCHIVED_AGENT] : RELEASE_AGENTS,
    "removeReleaseAgent",
  );
  openSession("task-roster", ROSTER_AGENTS, "removeRosterAgent");
}
// What a spec drives from the page: the host's negotiated methods, which gate
// the reporting controls, and the activity plane that keeps one task listed.
Object.defineProperty(window, "offerBotTaskMethods", {
  value: (methods: ReadonlyArray<string>): void => {
    recordNegotiatedHostMethods(HOST_ID, ["host.status", ...methods]);
  },
});
// The host answering the archived agent's chat indicator differently: the query the
// row's own chat-indicator scope reads is the only one told to read again, so
// the page's parent (which asks about the tasks, not their agents) is not
// rendered again.
Object.defineProperty(window, "clearArchivedIndicator", {
  value: (): void => {
    Reflect.deleteProperty(CHAT_INDICATORS, "agent-archived");
    void queryClient.invalidateQueries({
      predicate: (query) =>
        JSON.stringify(query.queryKey).includes("agent-archived"),
    });
  },
});
// The host failing to answer the archived agent's chat indicator again: the
// row's chat-indicator scope keeps its last answer but can no longer vouch for
// it, so what it attested stops counting.
Object.defineProperty(window, "failArchivedIndicatorRead", {
  value: (): void => {
    archivedIndicatorReadFails = true;
    void queryClient.invalidateQueries({
      predicate: (query) =>
        JSON.stringify(query.queryKey).includes("agent-archived"),
    });
  },
});
Object.defineProperty(window, "endWorkingRow", {
  value: (): void => {
    publishActivity(false);
  },
});

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
  const active = useBotActiveTasks(tasks, HOST_ID, true, BOT_ID);
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
              noun="active"
            />
          </TabsTrigger>
        </TabsList>
      </header>
      <TabsContent value="activity" className="flex min-h-0 flex-1 flex-col">
        <BotActivityPage
          roomFresh
          botId={BOT_ID}
          hostId={HOST_ID}
          boundHere
          active={active}
          notificationSubscriptions={null}
          trunkChatId="trunk-1"
          onOpenSession={() => {}}
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

/**
 * The tab in a pane the real way: `SurfacePresentationBoundary` publishes the
 * pane's activity and conceals only its own portal host, never the tab.
 * `unfocusPaneAnd(hook, args)` makes the pane no longer the focused one in the
 * same commit as one of the fixture's own store writes; a focus landing in an
 * unfocused pane is counted, as the pane's focus capture would reactivate it.
 */
function PaneHost(props: { readonly children: ReactNode }): ReactElement {
  const [focused, setFocused] = useState(true);
  const activations = useRef(0);
  useEffect(() => {
    Object.defineProperty(window, "unfocusPaneAnd", {
      configurable: true,
      value: (name: string, args: ReadonlyArray<unknown>): void => {
        const hook: unknown = Reflect.get(window, name);
        if (typeof hook !== "function")
          throw new Error(`the fixture has no ${name}`);
        flushSync(() => {
          Reflect.apply(hook, window, args);
          setFocused(false);
        });
      },
    });
    Object.defineProperty(window, "paneActivations", {
      configurable: true,
      get: (): number => activations.current,
    });
  }, []);
  return (
    <div
      onFocusCapture={() => {
        if (!focused) activations.current += 1;
      }}
    >
      <SurfacePresentationBoundary visible focused={focused}>
        {props.children}
      </SurfacePresentationBoundary>
    </div>
  );
}

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
                      <NotificationFeedModeContext.Provider
                        value={withWorking ? "cloud" : "local"}
                      >
                        {withPane ? (
                          <PaneHost>
                            <ActivityTab />
                          </PaneHost>
                        ) : (
                          <ActivityTab />
                        )}
                      </NotificationFeedModeContext.Provider>
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
