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
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type {
  BotReadCursorReadResponse,
  BotRecord,
} from "@traycer/protocol/host/bot/schemas";
import type { EnvironmentMemberV12 } from "@traycer/protocol/host/environment/contracts";
import type {
  AgentSender,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { recordNegotiatedHostManifest } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { createRendererContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { BotThreadsView } from "@/components/bots/bot-threads-view";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  type HostRpcRegistry,
  type MessengerFactory,
  useHostBinding,
} from "@/lib/host";
import { setPhoneLayoutOnly } from "@/lib/mobile-app";
import { __setChatStreamClientFactoryForTests } from "@/lib/registries/chat-session-registry";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { WindowsBridgeContext } from "@/providers/windows-bridge-context";
import { useAuthStore } from "@/stores/auth/auth-store";
import { ActivityGroupOpenStoreProvider } from "@/stores/chats/activity-group-open-store";
import { A2AOpenStoreProvider } from "@/stores/chats/a2a-open-store";
import { ChatFindForceStoreProvider } from "@/stores/chats/chat-find-force-store";
import { ChatOpenStoreScopeProvider } from "@/stores/chats/open-store-scope";
import { useSettingsStore } from "@/stores/settings/settings-store";
import "@/index.css";

/**
 * THE THREADS PAGE WITH EACH FOLLOWED THREAD IN FULL (Tracy Bots T137).
 *
 * The real `BotThreadsView` in a container as the bot tab's is, `?width=<px>`
 * wide, over a host that answers the bots, their thread lists, follows, read
 * cursors and environments, and chat streams that serve each channel's posts
 * and each thread's replies. Nothing of the page is reimplemented.
 *
 * Four followed threads, newest reply first: Tracy's iPad thread (two replies,
 * one of them new, which reading the card clears), Release Bot's release
 * thread (eight replies, so it folds; the last asks a question), Tracy's
 * policy thread (three replies, new) and a Release Bot post nobody has
 * answered yet ("Just you"). `?hold=<threadId,…>` withholds the observer's
 * reports for those cards, standing in for a card beyond the fold, so its
 * summary can be seen; `?filler=<n>` adds older threads after them, read,
 * so the last card starts far below the view; `?phone=true` draws the
 * installed app's phone form; `?theme=dark` draws it dark.
 */
const params = new URLSearchParams(window.location.search);
useSettingsStore
  .getState()
  .setTheme(params.get("theme") === "dark" ? "dark" : "light");
if (params.get("phone") === "true") setPhoneLayoutOnly(true);

const held = new Set(
  (params.get("hold") ?? "").split(",").filter((id) => id.length > 0),
);
if (held.size > 0) {
  const Observer = window.IntersectionObserver;
  class HoldingObserver extends Observer {
    constructor(
      callback: IntersectionObserverCallback,
      options: IntersectionObserverInit | undefined,
    ) {
      super((entries, observer) => {
        const reported = entries.filter(
          (entry) =>
            !(entry.target instanceof HTMLElement) ||
            !held.has(entry.target.dataset.threadId ?? ""),
        );
        if (reported.length > 0) callback(reported, observer);
      }, options);
    }
  }
  Object.defineProperty(window, "IntersectionObserver", {
    configurable: true,
    writable: true,
    value: HoldingObserver,
  });
}

const HOST_ID = "bot-threads-cards-host";
// The page offers only what the host advertised in its handshake; this
// fixture's mock messenger makes none, so the bot methods are recorded here.
recordNegotiatedHostManifest(HOST_ID, {
  "bot.list": { major: 1, minor: 1 },
  "bot.thread.list": { major: 1, minor: 2 },
  "bot.threadFollow.read": { major: 1, minor: 0 },
  "bot.threadFollow.set": { major: 1, minor: 0 },
  "bot.readCursor.read": { major: 1, minor: 0 },
  "bot.readCursor.advance": { major: 1, minor: 0 },
  "bot.notificationLevel.read": { major: 1, minor: 0 },
  "bot.conversation.send": { major: 1, minor: 4 },
  "bot.turn.locate": { major: 1, minor: 0 },
  "environment.list": { major: 1, minor: 1 },
  "environment.members": { major: 1, minor: 2 },
});
const VIEWER_ID = "user-tanveer";
const SIMAR_ID = "member-simar";
const TRACY_ID = "bot_01JD5X8Q2M4N6P8R0S2T4V6W8Y";
const RELEASE_ID = "bot_01JD5X8Q2M4N6P8R0S2T4V6W9Z";
const NOW = Date.now();
const MINUTE = 60_000;

const BOT_SENDER: AgentSender = {
  type: "agent",
  harnessId: "claude",
  agentId: "claude-sonnet-4",
  displayName: "Claude Sonnet 4",
  reply: { expectsReply: false },
  inReplyTo: null,
};

function textDoc(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function memberPost(
  messageId: string,
  userId: string,
  text: string,
  at: number,
): Message {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId },
    message: { kind: "user", content: textDoc(text), browserAnnotations: [] },
    timestamp: at,
    sessionAnchor: null,
    conversationRequest: {
      requestId: `req-${messageId}`,
      resolvedAt: at + 1,
      resolvedByMessageId: null,
    },
  };
}

function botReply(
  messageId: string,
  text: string,
  at: number,
): Extract<Message, { role: "assistant" }> {
  return {
    role: "assistant",
    messageId,
    sender: BOT_SENDER,
    blocks: [
      {
        type: "text",
        blockId: `${messageId}:text`,
        status: "completed",
        timestamp: at,
        text,
        providerNotice: null,
      },
    ],
    startedAt: at,
    timestamp: at,
    turnId: null,
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: [],
  };
}

/** A member of the team environment, as `environment.members` lists one. */
function member(
  userId: string,
  displayName: string,
  effectiveRole: EnvironmentMemberV12["effectiveRole"],
): EnvironmentMemberV12 {
  return {
    userId,
    displayName,
    avatarUrl: null,
    effectiveRole,
    linkedPlan: false,
    inviteState: "accepted",
    invitedAddress: null,
    email: null,
  };
}

function bot(botId: string, title: string, environmentId: string): BotRecord {
  return {
    botId,
    environmentId,
    createdByUserId: VIEWER_ID,
    title,
    harness: "claude",
    model: "opus",
    effort: null,
    profile: null,
    directive: null,
    replyMode: "thread",
    appConversationChatId: `channel-${botId}`,
    trunkChatId: `trunk-${botId}`,
    boundHostId: HOST_ID,
    hostEpoch: 0,
    createdAt: NOW - 30 * 24 * 60 * MINUTE,
    archivedAt: null,
  };
}

const BOTS: ReadonlyArray<BotRecord> = [
  bot(TRACY_ID, "Tracy", "env-personal"),
  bot(RELEASE_ID, "Release Bot", "env-team"),
];

const IPAD_POST = memberPost(
  "post-ipad",
  VIEWER_ID,
  "Coordination request: please serialize two pieces of iPad work so they land one after the other.",
  NOW - 32 * MINUTE,
);
const IPAD_REPLIES: ReadonlyArray<Message> = [
  botReply(
    "ipad-r1",
    "Serialized: the switcher scroller fix now rebases onto #3321's squash. One commit, review requested.",
    NOW - 29 * MINUTE,
  ),
  botReply(
    "ipad-r2",
    "#3373 merged as ed5c5a83ab. The iPad switcher fix is on main.",
    NOW - 14 * MINUTE,
  ),
];

const RELEASE_POST = memberPost(
  "post-release",
  SIMAR_ID,
  "Proposal: ship staging.215 to production tonight.",
  NOW - 3 * 60 * MINUTE,
);
const RELEASE_LINES: ReadonlyArray<readonly [string, string]> = [
  [VIEWER_ID, "What is still open on staging.215?"],
  ["bot", "Two checks: the mobile landscape pass and the docs build."],
  [SIMAR_ID, "Docs build is green as of an hour ago."],
  ["bot", "Confirmed: docs build passed on run 8841."],
  [VIEWER_ID, "And the landscape pass?"],
  ["bot", "ML7 landed; ML8 is in review."],
  [VIEWER_ID, "Hold until the mobile landscape pass is in."],
];
const RELEASE_REPLIES: ReadonlyArray<Message> = [
  ...RELEASE_LINES.map(([who, text], index): Message => {
    const at = NOW - (170 - index * 15) * MINUTE;
    const id = `release-r${String(index + 1)}`;
    return who === "bot"
      ? botReply(id, text, at)
      : memberPost(id, who, text, at);
  }),
  {
    ...botReply(
      "release-r8",
      "Approve the release once ML8 is pinned?",
      NOW - 40 * MINUTE,
    ),
    question: {
      requestId: "req-release-question",
      questions: [
        {
          text: "Approve the release once ML8 is pinned?",
          options: ["Approve", "Hold"],
          allowFreeText: true,
          settlement: null,
        },
      ],
    },
  },
];

const POLICY_POST = memberPost(
  "post-policy",
  VIEWER_ID,
  "Policy change: the iPad scroll fix is open as OSS #3373 (give each switcher list scroller its own layer).",
  NOW - 3 * 24 * 60 * MINUTE,
);
const POLICY_REPLIES: ReadonlyArray<Message> = [
  botReply("policy-r1", "Noted.", NOW - 3 * 24 * 60 * MINUTE + MINUTE),
  botReply("policy-r2", "Review requested.", NOW - 2 * 24 * 60 * MINUTE),
  botReply("policy-r3", "Merged.", NOW - 2 * 24 * 60 * MINUTE + MINUTE),
];

const LONELY_POST = memberPost(
  "post-lonely",
  VIEWER_ID,
  "Can the release notes list the landscape fixes?",
  NOW - 5 * MINUTE,
);

/**
 * `?filler=<n>`: as many older threads of Tracy's, each a post and one read
 * reply, so the page runs long whatever height the cards above have.
 */
const FILLER = Array.from(
  { length: Number(params.get("filler") ?? "0") },
  (_, index) => {
    const at = NOW - (4 + index) * 24 * 60 * MINUTE;
    const id = `filler-${String(index + 1)}`;
    const reply = botReply(`${id}-r1`, "Done.", at + MINUTE);
    return {
      threadId: `thread-${id}`,
      post: memberPost(
        `post-${id}`,
        VIEWER_ID,
        `Older thread ${String(index + 1)}`,
        at,
      ),
      replies: [reply],
      read: { messageId: reply.messageId, seq: reply.timestamp },
    };
  },
);

/** The chats the streams serve, by chat id. */
const CHATS: Readonly<Record<string, ReadonlyArray<Message>>> = {
  [`channel-${TRACY_ID}`]: [
    ...FILLER.map((filler) => filler.post),
    POLICY_POST,
    IPAD_POST,
  ],
  [`channel-${RELEASE_ID}`]: [RELEASE_POST, LONELY_POST],
  "thread-ipad": IPAD_REPLIES,
  "thread-release": RELEASE_REPLIES,
  "thread-policy": POLICY_REPLIES,
  ...Object.fromEntries(
    FILLER.map((filler) => [filler.threadId, filler.replies]),
  ),
};

function summary(input: {
  readonly botId: string;
  readonly threadId: string;
  readonly post: Message;
  readonly replies: ReadonlyArray<Message>;
}): BotThreadSummary {
  const { botId, threadId, post, replies } = input;
  const writers = new Map<
    string,
    { kind: "bot" } | { kind: "person"; userId: string }
  >();
  for (const reply of replies) {
    if (reply.role === "assistant") writers.set("bot", { kind: "bot" });
    else if (reply.sender.type === "user") {
      writers.set(reply.sender.userId, {
        kind: "person",
        userId: reply.sender.userId,
      });
    }
  }
  return {
    threadId,
    conversationId: `channel-${botId}`,
    sessionChatId: `session-${threadId}`,
    anchor: {
      messageId: post.messageId,
      requestId: `req-${post.messageId}`,
      senderUserId: post.sender.type === "user" ? post.sender.userId : null,
      sentAt: post.timestamp,
      resolvedAt: null,
      excerpt: null,
    },
    replyCount: replies.length,
    replyParticipants: [...writers.values()],
    lastReplyAt: replies.at(-1)?.timestamp ?? null,
    openRequestCount: 0,
    costUsd: null,
  };
}

const THREADS: Readonly<Record<string, ReadonlyArray<BotThreadSummary>>> = {
  [TRACY_ID]: [
    summary({
      botId: TRACY_ID,
      threadId: "thread-ipad",
      post: IPAD_POST,
      replies: IPAD_REPLIES,
    }),
    summary({
      botId: TRACY_ID,
      threadId: "thread-policy",
      post: POLICY_POST,
      replies: POLICY_REPLIES,
    }),
    ...FILLER.map((filler) => summary({ botId: TRACY_ID, ...filler })),
  ],
  [RELEASE_ID]: [
    summary({
      botId: RELEASE_ID,
      threadId: "thread-release",
      post: RELEASE_POST,
      replies: RELEASE_REPLIES,
    }),
    summary({
      botId: RELEASE_ID,
      threadId: "thread-lonely",
      post: LONELY_POST,
      replies: [],
    }),
  ],
};

/** Read cursors: the iPad thread's last reply and the policy thread are new. */
const fillerRead = Object.fromEntries(
  FILLER.map((filler) => [filler.threadId, filler.read]),
);
const cursors: Record<string, BotReadCursorReadResponse> = {
  [TRACY_ID]: {
    cursors: {
      "thread-ipad": { messageId: "ipad-r1", seq: NOW - 29 * MINUTE },
      "thread-policy": {
        messageId: "policy-r1",
        seq: NOW - 3 * 24 * 60 * MINUTE,
      },
      ...fillerRead,
    },
    latest: {
      "thread-ipad": { messageId: "ipad-r2", seq: NOW - 14 * MINUTE },
      "thread-policy": {
        messageId: "policy-r3",
        seq: NOW - 2 * 24 * 60 * MINUTE + MINUTE,
      },
      ...fillerRead,
    },
  },
  [RELEASE_ID]: {
    cursors: {
      "thread-release": { messageId: "release-r8", seq: NOW - 40 * MINUTE },
    },
    latest: {
      "thread-release": { messageId: "release-r8", seq: NOW - 40 * MINUTE },
    },
  },
};

const localHost = {
  hostId: HOST_ID,
  websocketUrl: "ws://127.0.0.1:9/rpc",
  version: "1.2.3",
  pid: 4547,
  systemHostName: "bot-threads-cards-fixture",
  displayName: "bot-threads-cards-fixture",
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
    requestId: () => `bot-threads-cards-${String(++requestCounter)}`,
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
      "bot.list": () => ({ bots: [...BOTS], mainBotIds: null }),
      "environment.list": () => ({
        environments: [
          {
            environmentId: "env-personal",
            ownerKind: "user",
            ownerId: VIEWER_ID,
            roomId: "room-personal",
            label: "Personal",
            effectiveRole: "owner",
            kind: "personal",
            hostCount: 1,
            providerHandle: null,
          },
          {
            environmentId: "env-team",
            ownerKind: "organization",
            ownerId: "org-traycerai",
            roomId: "room-team",
            label: "traycerai",
            effectiveRole: "admin",
            kind: "team",
            hostCount: 1,
            providerHandle: null,
          },
        ],
      }),
      "environment.members": () => ({
        members: [
          member(VIEWER_ID, "Tanveer Gill", "admin"),
          member(SIMAR_ID, "Simar Kaur", "editor"),
        ],
        nextCursor: null,
        legacyRoleNoticeSeenAt: null,
        legacyMembers: [],
      }),
      "bot.thread.list": (request) => {
        const threads = THREADS[request.botId] ?? [];
        return {
          threads: [...threads],
          trunkCostUsd: null,
          threadAnchors: null,
          nextCursor: null,
          total: threads.length,
        };
      },
      "bot.threadFollow.read": (request) => ({
        follows: Object.fromEntries(
          (THREADS[request.botId] ?? []).map((thread) => [
            thread.threadId,
            { state: "following" as const, reason: "participated" as const },
          ]),
        ),
      }),
      "bot.readCursor.read": (request) =>
        cursors[request.botId] ?? { cursors: {}, latest: {} },
      "bot.readCursor.advance": (request) => {
        const cursor = { messageId: request.messageId, seq: request.seq };
        const read = cursors[request.botId] ?? { cursors: {}, latest: {} };
        cursors[request.botId] = {
          ...read,
          cursors: { ...read.cursors, [request.conversationId]: cursor },
        };
        return { cursor };
      },
      "bot.notificationLevel.read": () => ({ levels: {} }),
      "bot.turn.locate": () => ({ turns: [] }),
    },
  });

__setChatStreamClientFactoryForTests((epicId, chatId, callbacks) => {
  const messages = CHATS[chatId] ?? [];
  queueMicrotask(() => {
    callbacks.onConnectionStatus("open", null, null, null);
    callbacks.onSnapshot({
      kind: "snapshot",
      hasBinaryPayload: false,
      epicId,
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
          messages: [...messages],
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

/** Holds the page back until the host client has its request context. */
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

export function SignedIn(props: {
  readonly children: ReactNode;
}): ReactElement {
  const authStatus = useAuthStore((state) => state.status);
  useEffect(() => {
    if (authStatus === "signed-in") return;
    useAuthStore.getState().setSignedIn(
      {
        userId: VIEWER_ID,
        userName: "Tanveer Gill",
        email: "threads-cards@example.invalid",
      },
      { userId: VIEWER_ID, username: "Tanveer Gill" },
      [],
    );
  }, [authStatus]);
  return <>{props.children}</>;
}

const width = params.get("width");

function noop(): void {}

export function Page(): ReactElement {
  return (
    <div
      className="@container flex h-safe-dvh bg-background"
      style={width === null ? undefined : { width: `${width}px` }}
      data-testid="bot-tab"
    >
      <TabHostContext.Provider value={HOST_ID}>
        <ChatOpenStoreScopeProvider value="bot-threads-cards">
          <ActivityGroupOpenStoreProvider store={null}>
            <A2AOpenStoreProvider store={null}>
              <ChatFindForceStoreProvider tileInstanceId="bot-threads-cards">
                <BotThreadsView
                  level2={null}
                  hostId={HOST_ID}
                  channelTitle="Tracy"
                  onBack={noop}
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
            fallback={<div data-testid="bot-threads-cards-fallback" />}
          >
            <WindowsBridgeContext.Provider value={windowsBridgeValue}>
              <TooltipProvider>
                <SignedIn>
                  <RequestContext>
                    <Page />
                  </RequestContext>
                </SignedIn>
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
if (root === null) throw new Error("bot threads cards fixture root missing");
createRoot(root).render(<RouterProvider router={buildRouter()} />);
