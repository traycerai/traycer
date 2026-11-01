import { useEffect, type ReactElement, type ReactNode } from "react";
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
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  BotThreadPanel,
  type BotThreadPanelThread,
} from "@/components/bots/bot-thread-panel";
import type { BotSentPost } from "@/stores/bots/bot-open-thread-store";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { UNRESOLVED_BOT_MEMBERS } from "@/lib/bots/bot-member-names";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { WindowsBridgeContext } from "@/providers/windows-bridge-context";
import { useAuthStore } from "@/stores/auth/auth-store";
import { ActivityGroupOpenStoreProvider } from "@/stores/chats/activity-group-open-store";
import { A2AOpenStoreProvider } from "@/stores/chats/a2a-open-store";
import { ChatFindForceStoreProvider } from "@/stores/chats/chat-find-force-store";
import { ChatOpenStoreScopeProvider } from "@/stores/chats/open-store-scope";
import "@/index.css";

/**
 * A BOT'S THREAD PANEL WHOSE THREAD SET UP MORE TASKS THAN THE PANE HOLDS.
 *
 * The real `BotThreadPanel` fills a window-high pane, as the channel view's
 * thread column does, on a listed thread with replies: its header, the Tasks
 * section over forty labeled automations, the replies' region with the post it
 * opens on, and the box that replies in the thread. The host serves no
 * transcript here, so the replies' region holds its connecting line; its box
 * is what the spec measures. Nothing of the panel is reimplemented; the
 * fixture supplies the provider stack and the host's answers only.
 * `?pane=<px>` makes the pane shorter than the window, as a split column is.
 *
 * The long-post spec reads the same panel with `?post=long`, a post far taller
 * than any pane, as the person sent it (no channel row in this fixture), and
 * `?thread=` for the state it is in: `listed` (default, three replies, the
 * session connecting), `zero` (listed with no reply) or `posted` (not listed
 * yet). `?tasks=none` leaves the Tasks section out.
 */
const HOST_ID = "bot-thread-tasks-bound-host";
const THREAD_ID = "thread-1";
const TASK_COUNT = 40;

const localHost = {
  hostId: HOST_ID,
  websocketUrl: "ws://127.0.0.1:9/rpc",
  version: "1.2.3",
  pid: 4545,
  systemHostName: "bot-thread-tasks-bound-fixture",
  displayName: "bot-thread-tasks-bound-fixture",
  availability: "available",
} as const;

const windowsBridgeValue = { bridge: null, hasHydrated: true } as const;
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

let requestCounter = 0;
const messengerFactory: MessengerFactory<HostRpcRegistry> = ({ registry }) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry,
    requestId: () => `bot-thread-tasks-bound-${String(++requestCounter)}`,
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
      }),
      "host.notifications.indicatorState": () => ({
        epics: {},
        chats: {},
        complete: true,
      }),
      "epic.getTaskContexts": () => ({ tasks: {} }),
    },
  });

const tasks: ReadonlyArray<BotTaskEntry> = Array.from(
  { length: TASK_COUNT },
  (_, index) => ({
    taskId: `task-${String(index + 1)}`,
    cadence: { kind: "every", seconds: 3_600 },
    lastCheckinAt: null,
    lastCheckin: null,
    nextAt: null,
    state: "tracking",
    endedReason: null,
    createdByUserId: null,
    spun: true,
    label: `Watching shard ${String(index + 1)}`,
    originRequestId: null,
    createdByChatId: THREAD_ID,
    checkins: null,
    inputNeeded: null,
    pause: null,
    stop: null,
    runRequest: null,
  }),
);

/** The thread as the channel's list has it: a member's post and its replies. */
const thread: BotThreadSummary = {
  threadId: THREAD_ID,
  conversationId: "channel-1",
  sessionChatId: "session-1",
  anchor: {
    messageId: "post-1",
    requestId: "req-1",
    senderUserId: null,
    sentAt: 1_000,
    resolvedAt: null,
    excerpt: null,
  },
  replyCount: 3,
  lastReplyAt: 2_000,
  openRequestCount: 0,
  costUsd: null,
};

function noop(): void {}

const params = new URLSearchParams(window.location.search);

/** A post taller than any pane the spec makes, ending in a marker. */
const LONG_POST = `${Array.from(
  { length: 60 },
  (_, index) =>
    `Paragraph ${String(index + 1)} of a long post: the release train leaves at noon.`,
).join("\n\n")}\n\nEND-OF-POST`;

function panelThread(): BotThreadPanelThread {
  switch (params.get("thread")) {
    case "zero":
      return {
        kind: "listed",
        thread: { ...thread, replyCount: 0 },
        retry: null,
        sendable: true,
      };
    case "posted":
      return {
        kind: "posted",
        threadId: THREAD_ID,
        retry: null,
        sendable: true,
      };
    default:
      return { kind: "listed", thread, retry: null, sendable: true };
  }
}

const sentPost: BotSentPost | null =
  params.get("post") === "long"
    ? {
        threadId: THREAD_ID,
        requestId: "req-1",
        text: LONG_POST,
        senderUserId: null,
        sentAt: 1_000,
        delivery: "written",
      }
    : null;

export function SignedInFixture(props: {
  readonly children: ReactNode;
}): ReactElement {
  const authStatus = useAuthStore((state) => state.status);
  useEffect(() => {
    if (authStatus === "signed-in") return;
    useAuthStore.getState().setSignedIn(
      {
        userId: "bot-thread-tasks-bound-user",
        userName: "Tasks Bound User",
        email: "tasks-bound@example.invalid",
      },
      { userId: "bot-thread-tasks-bound-user", username: "Tasks Bound User" },
      [],
    );
  }, [authStatus]);
  return <>{props.children}</>;
}

const paneHeight = params.get("pane");

export function Pane(): ReactElement {
  return (
    <div
      className="flex h-safe-dvh flex-col"
      style={paneHeight === null ? undefined : { height: `${paneHeight}px` }}
      data-testid="thread-pane"
    >
      <TabHostContext.Provider value={HOST_ID}>
        <ChatOpenStoreScopeProvider value="bot-thread-tasks-bound">
          <ActivityGroupOpenStoreProvider store={null}>
            <A2AOpenStoreProvider store={null}>
              <ChatFindForceStoreProvider tileInstanceId="bot-thread-tasks-bound">
                <BotThreadPanel
                  botId="bot-1"
                  hostId={HOST_ID}
                  boundHostId={HOST_ID}
                  botTitle="Release Bot"
                  conversationId="channel-1"
                  originMessageId="post-1"
                  sent={sentPost}
                  thread={panelThread()}
                  tasks={params.get("tasks") === "none" ? [] : tasks}
                  anchorSenderLabel={() => "You"}
                  resolveMember={UNRESOLVED_BOT_MEMBERS}
                  onClose={noop}
                  onOpenActivity={noop}
                  onEditPost={noop}
                  onOpenTurn={noop}
                  onOpenSession={noop}
                  landOn={null}
                  quote={null}
                />
              </ChatFindForceStoreProvider>
            </A2AOpenStoreProvider>
          </ActivityGroupOpenStoreProvider>
        </ChatOpenStoreScopeProvider>
      </TabHostContext.Provider>
    </div>
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
            fallback={<div data-testid="bot-thread-tasks-bound-fallback" />}
          >
            <WindowsBridgeContext.Provider value={windowsBridgeValue}>
              <TooltipProvider>
                <SignedInFixture>
                  <Pane />
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
if (root === null)
  throw new Error("bot thread tasks bound fixture root missing");
createRoot(root).render(<RouterProvider router={buildRouter()} />);
