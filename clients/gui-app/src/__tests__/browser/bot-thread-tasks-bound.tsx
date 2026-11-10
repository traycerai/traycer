import { useEffect, type ReactElement, type ReactNode } from "react";
import { __setChatStreamClientFactoryForTests } from "@/lib/registries/chat-session-registry";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
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
import {
  BotIdentityContext,
  type BotIdentity,
} from "@/components/bots/bot-identity-context";
import {
  BotMentionsContext,
  type BotMentionDirectory,
} from "@/components/bots/bot-mentions-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { UNRESOLVED_BOT_MEMBERS } from "@/lib/bots/bot-member-names";
import { setPhoneLayoutOnly } from "@/lib/mobile-app";
import { setNativeKeyboardState } from "@/lib/native-keyboard";
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
 *
 * The focus-layout spec adds `?keyboard=<px>`: the installed app with the
 * keyboard up, written the way its native bridge writes it, `?top=<px>` for the
 * status bar's inset above the pane, and `?post=short` for a post of one line.
 *
 * The mention spec adds `?mentions=team` or `?mentions=person`: the bot is a
 * team's, with members to name, or the viewer's own, and the environment has
 * other bots and tasks, as the tab's directory hands them to the box and the
 * rows (decision 177); and `?post=mentions`, a post that names a bot, a task
 * and a member.
 */
const HOST_ID = "bot-thread-tasks-bound-host";
const VIEWER_ID = "bot-thread-tasks-bound-user";
const NOTES_BOT_ID = "bot_01JD5X8Q2M4N6P8R0S2T4V6W8Y";
const TRIAGE_BOT_ID = "bot_01JD5X8Q2M4N6P8R0S2T4V6W9Z";
const RELEASE_TASK_ID = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const MEMBERS = [
  { userId: VIEWER_ID, displayName: "Tasks Bound User", avatarUrl: null },
  { userId: "member-simar", displayName: "Simar Kaur", avatarUrl: null },
  { userId: "member-anders", displayName: "Anders Holm", avatarUrl: null },
] as const;
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
        previousExit: null,
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

// An opt-in host snapshot exercises the production transcript and list.
if (params.get("loaded") === "true") {
  const messages: Message[] = Array.from({ length: 30 }, (_, index) => ({
    role: "user" as const,
    messageId: `reply-${String(index)}`,
    sender: { type: "user" as const, userId: VIEWER_ID },
    sessionAnchor: null,
    message: {
      kind: "user" as const,
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: `Thread reply ${String(index)} — the release needs a careful review.`,
              },
            ],
          },
        ],
      },
      browserAnnotations: [],
    },
    timestamp: 2_000 + index,
  }));
  __setChatStreamClientFactoryForTests((_epicId, chatId, callbacks) => {
    queueMicrotask(() => {
      callbacks.onConnectionStatus("open", null, null, null);
      callbacks.onSnapshot({
        kind: "snapshot",
        hasBinaryPayload: false,
        epicId: "bot-1",
        chatId,
        snapshot: {
          chat: {
            id: chatId,
            parentId: null,
            userId: VIEWER_ID,
            hostId: HOST_ID,
            title: "Thread",
            createdAt: 1,
            updatedAt: 1,
            isTitleEditedByUser: false,
            settings: null,
            activeSessionChain: null,
            claudePendingWakes: [],
            messages,
            events: [],
            archivedAt: null,
            pinnedUserProviderHandle: null,
            lastDeliveredRolesDigest: null,
          },
          access: { role: "owner", ownerUserId: VIEWER_ID, canAct: true },
          queue: { status: "idle", items: [] },
          runStatus: "idle",
          turnInProgress: false,
          sendWouldQueue: false,
          activeTurn: null,
          pendingApprovals: [],
          pendingInterviews: [],
          worktreeBinding: null,
          missingWorktreePaths: [],
          pendingFileEditApprovals: [],
          accumulatedFileChanges: [],
          managedCommands: [],
          heldUpdates: [],
          portForwards: [],
        },
      });
    });
    return {
      sendAction: () => undefined,
      sameTurnSteeringProtocolSupported: () => true,
      draftBlobBridgeSupported: () => false,
      requestTranscriptRange: () => undefined,
      requestResnapshot: () => undefined,
      close: () => undefined,
    };
  });
}

const keyboardInset = params.get("keyboard");
if (keyboardInset !== null) {
  setPhoneLayoutOnly(true);
  document.documentElement.style.setProperty(
    "--keyboard-inset",
    `${keyboardInset}px`,
  );
  setNativeKeyboardState({ open: true, transitioning: false });
}

const topInset = params.get("top");
if (topInset !== null) {
  document.documentElement.style.setProperty(
    "--safe-area-inset-top",
    `${topInset}px`,
  );
}

/** A post taller than any pane the spec makes, ending in a marker. */
const LONG_POST = `${Array.from(
  { length: 60 },
  (_, index) =>
    `Paragraph ${String(index + 1)} of a long post: the release train leaves at noon.`,
).join("\n\n")}\n\nEND-OF-POST`;

function sentText(): string | null {
  switch (params.get("post")) {
    case "long":
      return LONG_POST;
    case "short":
      return "Is the release train still leaving at noon?";
    case "mentions":
      return `<#${NOTES_BOT_ID}> can you add <~${RELEASE_TASK_ID}> to the notes? <@member-simar> owns the train.`;
    default:
      return null;
  }
}

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
      return {
        kind: "listed",
        thread:
          params.get("loaded") === "true"
            ? { ...thread, replyCount: 30 }
            : thread,
        retry: null,
        sendable: true,
      };
  }
}

const sent = sentText();
const sentPost: BotSentPost | null =
  sent === null
    ? null
    : {
        threadId: THREAD_ID,
        requestId: "req-1",
        text: sent,
        senderUserId: null,
        sentAt: 1_000,
        delivery: "written",
      };

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

const mentions = params.get("mentions");

const identity: BotIdentity | null =
  mentions === null
    ? null
    : {
        botId: "bot-1",
        title: "Release Bot",
        owner:
          mentions === "team"
            ? { kind: "team", name: "traycerai", members: MEMBERS }
            : {
                kind: "person",
                userId: VIEWER_ID,
                name: "Tasks Bound User",
                avatarUrl: null,
              },
      };

const directory: BotMentionDirectory | null =
  mentions === null
    ? null
    : {
        person: (userId) => {
          if (mentions !== "team") return null;
          const member = MEMBERS.find((entry) => entry.userId === userId);
          return member === undefined
            ? null
            : { name: member.displayName, self: userId === VIEWER_ID };
        },
        bots: [
          { id: "bot-1", name: "Release Bot" },
          { id: NOTES_BOT_ID, name: "Release notes" },
          { id: TRIAGE_BOT_ID, name: "Triage" },
        ],
        tasks: [
          { id: RELEASE_TASK_ID, name: "Release train 1.42" },
          {
            id: "7a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
            name: "Rotate the staging keys",
          },
        ],
        tasksAnswered: true,
      };

export function Pane(): ReactElement {
  return (
    <BotIdentityContext value={identity}>
      <BotMentionsContext value={directory}>
        <PaneBody />
      </BotMentionsContext>
    </BotIdentityContext>
  );
}

function PaneBody(): ReactElement {
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
                  imageReach="none"
                  botTitle="Release Bot"
                  conversationId="channel-1"
                  originMessageId="post-1"
                  sent={sentPost}
                  thread={panelThread()}
                  tasks={params.get("tasks") === "none" ? [] : tasks}
                  anchorSenderLabel={() => "You"}
                  resolveMember={UNRESOLVED_BOT_MEMBERS}
                  onClose={noop}
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
