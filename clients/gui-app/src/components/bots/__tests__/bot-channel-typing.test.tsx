/**
 * A bot channel's typing signal (Tracy Bots T60/T64), through the REAL
 * `BotChannelView`: its transcript, thread panel and replying strips read
 * what the bot is doing through the real `useBotActivity`, which reads the
 * `activity` the bot's `bot.subscribe` snapshot carries; the case moves it
 * as the host's snapshot and `activity` frames would. The transcript's rows
 * come from real chat session stores (one per chat id, driven only through
 * the stream callbacks a host would call), with the real bot-tabs and
 * open-thread stores. The host-RPC hooks are scripted (the real protocol
 * schemas do not load in this suite's jsdom), and the virtualised message
 * list is replaced, as in the thread-panel suite.
 */
import type { ReactNode } from "react";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { ChatRunStatus } from "@traycer/protocol/host/agent/gui/subscribe";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { commandActivityLabel } from "@traycer/protocol/host/agent/gui/activity-step-label";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type {
  BotActivity,
  BotRecord,
  BotSessionActivity,
} from "@traycer/protocol/host/bot/schemas";
import type {
  AgentSender,
  Chat,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ChatLocateRowArgs } from "@/hooks/chats/use-chat-locate-row";
import {
  useBotOpenThread,
  useBotOpenThreadStore,
} from "@/stores/bots/bot-open-thread-store";
import { useBotTabsStore } from "@/stores/bots/bot-tabs-store";
import { __resetBotSubscriptionsForTesting } from "@/hooks/bots/use-bot-subscription";
import {
  StubHostStreamClient,
  StubSession,
} from "@/hooks/bots/__tests__/bot-subscribe-stub-stream";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";

interface SessionHarness {
  readonly handle: ChatSessionStoreHandle;
  callbacks(): ChatStreamCallbacks;
}

const mocks = vi.hoisted(() => ({
  sessionFor: null as
    | ((chatId: string, enabled: boolean) => ChatSessionStoreHandle | null)
    | null,
  threadListData: { threads: [] } as {
    threads: ReadonlyArray<BotThreadSummary>;
  },
  conversations: {
    conversations: [] as ReadonlyArray<{
      conversationId: string;
      botId: string;
      title: null;
      createdAt: number;
      updatedAt: number;
    }>,
  },
  bot: null as BotRecord | null,
  streamClient: null as StubHostStreamClient | null,
}));

vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useChatSessionHandleForContainer: (
    _epicId: string,
    chatId: string,
    _hostId: string,
    enabled: boolean,
  ) => {
    if (mocks.sessionFor === null) throw new Error("No session registry");
    return mocks.sessionFor(chatId, enabled);
  },
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => ({ stub: "tab-host-client" }),
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => ({ stub: "host-client" }),
}));
vi.mock("@/hooks/bots/use-bot-conversation-list-query", () => ({
  useBotConversationListQuery: () => ({
    data: mocks.conversations,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/bots/use-bot-thread-list-query", () => ({
  useBotThreadListQuery: () => ({
    data: mocks.threadListData,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/bots/use-bot-mutations", () => ({
  useBotConversationSendMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
}));
// The real shared `bot.subscribe` subscription, over a stub session the case
// drives with the host's frames and the transport's status lines.
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
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessCatalogForClient: () => ({ harnesses: [] }),
}));
vi.mock("@/hooks/chats/use-chat-locate-row", () => ({
  useChatLocateRow: (_args: ChatLocateRowArgs) => null,
}));
vi.mock("@/hooks/host/use-host-supports-method", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-supports-method")
  >()),
  useHostMethodSupport: () => true,
}));
vi.mock("@/hooks/notifications/use-notification-indicators-query", () => ({
  useNotificationIndicators: () => ({ epics: {}, chats: {} }),
}));
vi.mock(
  "@/hooks/notifications/use-notification-mark-entity-read-mutation",
  () => ({
    useNotificationMarkEntityRead: () => ({ mutate: () => undefined }),
  }),
);
vi.mock("@/components/chat/chat-messages", async () => {
  const { ChatExpansionTestProviders: Providers } =
    await import("@/components/chat/__tests__/chat-expansion-test-providers");
  const { ChatMessage } = await import("@/components/chat/chat-message");
  const noBackgroundToolBlockIds: ReadonlySet<string> = new Set();
  return {
    ChatMessages: (props: {
      messages: ReadonlyArray<ChatMessageModel>;
      instanceId: string;
    }) => (
      <Providers tileInstanceId={props.instanceId}>
        <div data-testid="chat-messages-stub">
          {props.messages.map((message) => (
            <ChatMessage
              key={message.id}
              message={message}
              actions={null}
              backgroundToolBlockIds={noBackgroundToolBlockIds}
              nextStepActions={null}
            />
          ))}
        </div>
      </Providers>
    ),
  };
});

import { BotChannelView } from "@/components/bots/bot-channel-view";
import type { BotMemberResolver } from "@/lib/bots/bot-member-names";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HOST_ID = "host-bound";
const CHANNEL_ID = "conversation-channel";
const TRUNK_ID = "trunk-1";
const THREAD_ID = "thread-1";
const THREAD_SESSION_ID = "session-1";
const POST_ID = "post-1";
const USER_ID = "user-teammate";

const POST_CONTENT: JsonContent = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Is CI green?" }] },
  ],
};

const BOT_SENDER: AgentSender = {
  type: "agent",
  harnessId: "claude",
  agentId: "claude-sonnet-4",
  displayName: "Claude Sonnet 4",
  reply: { expectsReply: false },
  inReplyTo: null,
};

const resolveMember: BotMemberResolver = (userId) =>
  userId === USER_ID ? { displayName: "Tess Teammate", avatarUrl: null } : null;

/** The member's post in the channel, its request open or answered. */
function post(options: {
  readonly direct: boolean;
  readonly resolvedAt: number | null;
}): Message {
  return {
    role: "user",
    messageId: POST_ID,
    sender: { type: "user", userId: USER_ID },
    message: { kind: "user", content: POST_CONTENT, browserAnnotations: [] },
    timestamp: 1_000,
    sessionAnchor: null,
    conversationRequest: {
      requestId: "request-1",
      resolvedAt: options.resolvedAt,
      resolvedByMessageId: options.resolvedAt === null ? null : "reply-1",
      ...(options.direct ? { direct: true } : {}),
    },
  };
}

function assistantRow(
  messageId: string,
  turnId: string | null,
  blocks: Extract<Message, { role: "assistant" }>["blocks"],
): Message {
  return {
    role: "assistant",
    messageId,
    sender: BOT_SENDER,
    blocks,
    startedAt: 2_000,
    timestamp: 2_000,
    turnId,
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: [],
  };
}

const BOT_REPLY = assistantRow("reply-1", null, [
  {
    type: "text",
    blockId: "reply-1:text",
    status: "completed",
    timestamp: 2_000,
    text: "CI is green.",
    providerNotice: null,
  },
]);

function threadSummary(): BotThreadSummary {
  return {
    threadId: THREAD_ID,
    conversationId: CHANNEL_ID,
    sessionChatId: THREAD_SESSION_ID,
    anchor: {
      messageId: POST_ID,
      requestId: "request-1",
      senderUserId: USER_ID,
      sentAt: 1_000,
      resolvedAt: null,
    },
    replyCount: 1,
    lastReplyAt: 2_000,
    openRequestCount: 1,
    costUsd: null,
  };
}

interface SessionState {
  readonly messages: ReadonlyArray<Message>;
}

const IDLE: { readonly runStatus: ChatRunStatus } = { runStatus: "idle" };

/** A session's turn answering `requestId` (`null`: a turn for no post). */
function replying(
  requestId: string | null,
  step: string | null,
): BotSessionActivity {
  return { state: "replying", startedAt: 3, step, requestId };
}

const IDLE_ACTIVITY: BotSessionActivity = {
  state: "idle",
  startedAt: null,
  step: null,
  requestId: null,
};

let botStream = new StubSession();

/** The host's `bot.subscribe` snapshot, carrying `activity`. */
function emitActivity(activity: BotActivity): void {
  act(() => {
    botStream.emit({
      kind: "snapshot",
      bot: botRecord(),
      tasks: [],
      openRequestCount: null,
      conversationsRevision: null,
      boundHost: { hostId: HOST_ID, epoch: 0, isThisHost: true },
      activity,
      hasBinaryPayload: false,
    });
  });
}

/** The bot stream's transport closing, to redial (`retryable`) or for good. */
function closeBotStream(retryable: boolean): void {
  act(() => {
    botStream.status("closed", {
      kind: "fatalError",
      details: {
        code: retryable ? "HOST_RESTARTING" : "BOT_NOT_FOUND",
        reason: retryable ? "The host is restarting." : "The bot is gone.",
        incompatibleMethods: null,
        upgradeGuidance: null,
        retryable,
      },
    });
  });
}

function chatRecord(chatId: string, messages: ReadonlyArray<Message>): Chat {
  return {
    id: chatId,
    parentId: null,
    userId: USER_ID,
    hostId: HOST_ID,
    title: "Bot session",
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
  };
}

const sessions = new Map<string, SessionHarness>();

/** One real session store per chat id, kept across renders. */
function session(chatId: string): SessionHarness {
  const existing = sessions.get(chatId);
  if (existing !== undefined) return existing;
  let callbacks: ChatStreamCallbacks | null = null;
  const handle = createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: HOST_ID,
    epicId: BOT_ID,
    chatId,
    userId: USER_ID,
    onAuthError: null,
    onProviderAuthError: null,
    wakeTransport: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        sendAction: () => undefined,
        sameTurnSteeringProtocolSupported: () => true,
        draftBlobBridgeSupported: () => false,
        requestTranscriptRange: () => undefined,
        requestResnapshot: () => undefined,
        close: () => undefined,
      };
    },
  });
  const harness: SessionHarness = {
    handle,
    callbacks: () => {
      if (callbacks === null) throw new Error("Expected callbacks");
      return callbacks;
    },
  };
  sessions.set(chatId, harness);
  return harness;
}

/** Opens the chat's stream and seats an authoritative snapshot, as its host would. */
function emitSnapshot(chatId: string, state: SessionState): void {
  const callbacks = session(chatId).callbacks();
  act(() => {
    callbacks.onConnectionStatus("open", null, null);
    callbacks.onSnapshot({
      kind: "snapshot",
      hasBinaryPayload: false,
      epicId: BOT_ID,
      chatId,
      snapshot: {
        chat: chatRecord(chatId, state.messages),
        access: { role: "owner", ownerUserId: USER_ID, canAct: true },
        queue: { status: "idle", items: [] },
        runStatus: IDLE.runStatus,
        activeTurn: null,
        turnInProgress: false,
        pendingApprovals: [],
        pendingInterviews: [],
        worktreeBinding: null,
        missingWorktreePaths: [],
        pendingFileEditApprovals: [],
        accumulatedFileChanges: [],
        managedCommands: [],
        heldUpdates: [],
        portForwards: [],
        pendingFallback: undefined,
        pendingReturn: undefined,
        lastFallbackOutcome: undefined,
      },
    });
  });
}

/** Holds the open thread in its store, as the bot tab above the view does. */
function ChannelHarness(props: { readonly directive: string }): ReactNode {
  const openThread = useBotOpenThread(BOT_ID);
  return (
    <BotChannelView
      botId={BOT_ID}
      hostId={HOST_ID}
      botTitle="Tracy"
      directive={props.directive}
      appConversationChatId={CHANNEL_ID}
      resolveMember={resolveMember}
      openThread={openThread}
      onOpenThread={(open) =>
        useBotOpenThreadStore.getState().setOpenThread(BOT_ID, open)
      }
      onOpenUnderTheHood={vi.fn()}
    />
  );
}

const DIRECTIVE = "Watches CI and answers questions about the nightly run.";

function mountChannel(threads: ReadonlyArray<BotThreadSummary>): void {
  mocks.threadListData = { threads };
  // The transcript reads the app's send ledger off the query client.
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <ChatExpansionTestProviders tileInstanceId="tile-1">
          <ChannelHarness directive={DIRECTIVE} />
        </ChatExpansionTestProviders>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/** The channel with the member's post waiting on a direct reply, and the trunk's turn answering it. */
async function mountAwaitingDirectReply(
  trunk: BotSessionActivity,
): Promise<HTMLElement> {
  emitSnapshot(CHANNEL_ID, {
    messages: [post({ direct: true, resolvedAt: null })],
  });
  mountChannel([]);
  emitActivity({ trunk, threads: {} });
  return screen.findByTestId("bot-channel");
}

function botRecord(): BotRecord {
  return {
    botId: BOT_ID,
    environmentId: "env-1",
    createdByUserId: USER_ID,
    title: "Tracy",
    harness: "claude",
    model: "claude-sonnet-4",
    effort: null,
    profile: null,
    trunkChatId: TRUNK_ID,
    boundHostId: HOST_ID,
    hostEpoch: 0,
    createdAt: 1,
    archivedAt: null,
    directive: DIRECTIVE,
    replyMode: "direct",
    appConversationChatId: CHANNEL_ID,
  };
}

beforeEach(() => {
  mocks.sessionFor = (chatId, enabled) =>
    enabled ? session(chatId).handle : null;
  mocks.conversations = {
    conversations: [
      {
        conversationId: CHANNEL_ID,
        botId: BOT_ID,
        title: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  };
  botStream = new StubSession();
  mocks.streamClient = new StubHostStreamClient(botStream);
  useBotTabsStore
    .getState()
    .openBotTab({ botId: BOT_ID, hostId: HOST_ID, title: "Tracy" });
});

afterEach(() => {
  cleanup();
  for (const { handle } of sessions.values()) handle.dispose();
  sessions.clear();
  mocks.sessionFor = null;
  mocks.threadListData = { threads: [] };
  useBotTabsStore.setState({ tabs: {} });
  useBotOpenThreadStore.setState({ byBotId: {} });
  __resetBotSubscriptionsForTesting();
  mocks.streamClient = null;
});

describe("<BotChannelView /> the channel's typing line", () => {
  it("reads 'Tracy is replying…' above the composer, outside the transcript, while a direct post waits on the running trunk", async () => {
    const channel = await mountAwaitingDirectReply(replying("request-1", null));

    const strip = await screen.findByTestId("bot-channel-replying");
    expect(within(strip).getByText("Tracy is replying…")).toBeTruthy();
    expect(strip.getAttribute("role")).toBe("status");
    const composer = within(channel).getByTestId("bot-channel-composer");
    expect(strip.parentElement).toBe(composer.parentElement);
    expect(screen.getByTestId("bot-chat-transcript").contains(strip)).toBe(
      false,
    );
  });

  it("names the step the trunk's turn has in flight", async () => {
    const step = commandActivityLabel("Reading the CI log");
    await mountAwaitingDirectReply(replying("request-1", step));

    const strip = await screen.findByTestId("bot-channel-replying");
    expect(within(strip).getByText(`Tracy: ${step}`)).toBeTruthy();
  });

  it("clears when the reply lands, though the trunk is still running", async () => {
    await mountAwaitingDirectReply(replying("request-1", null));
    await screen.findByTestId("bot-channel-replying");

    emitSnapshot(CHANNEL_ID, {
      messages: [post({ direct: true, resolvedAt: 2_000 }), BOT_REPLY],
    });
    // The host's frame as the reply resolves the post: the turn runs on,
    // answering no post.
    emitActivity({ trunk: replying(null, null), threads: {} });

    await screen.findByText("CI is green.");
    await waitFor(() => {
      expect(screen.queryByTestId("bot-channel-replying")).toBeNull();
    });
  });

  it("clears when the trunk's turn ends before the post is answered", async () => {
    await mountAwaitingDirectReply(replying("request-1", null));
    await screen.findByTestId("bot-channel-replying");

    emitActivity({ trunk: IDLE_ACTIVITY, threads: {} });

    await waitFor(() => {
      expect(screen.queryByTestId("bot-channel-replying")).toBeNull();
    });
  });

  it("clears when the trunk's session closes with its turn unfinished, and reports no failure", async () => {
    await mountAwaitingDirectReply(replying("request-1", null));
    await screen.findByTestId("bot-channel-replying");

    // A session the host no longer holds has no entry.
    emitActivity({ trunk: null, threads: {} });

    await waitFor(() => {
      expect(screen.queryByTestId("bot-channel-replying")).toBeNull();
    });
    expect(screen.queryByTestId("bot-channel-unanswered")).toBeNull();
  });

  it("clears when the bot's stream closes for good with the trunk still replying, and reports no failure", async () => {
    await mountAwaitingDirectReply(replying("request-1", null));
    await screen.findByTestId("bot-channel-replying");

    closeBotStream(false);

    // No frame will clear a closed stream's last reading.
    await waitFor(() => {
      expect(screen.queryByTestId("bot-channel-replying")).toBeNull();
    });
    expect(screen.queryByTestId("bot-channel-unanswered")).toBeNull();
  });

  it("keeps replying while the bot's stream reconnects, as the turn may yet be running", async () => {
    await mountAwaitingDirectReply(replying("request-1", null));
    await screen.findByTestId("bot-channel-replying");

    closeBotStream(true);

    expect(screen.getByTestId("bot-channel-replying")).toBeTruthy();
  });

  it("stays out while the trunk runs with no direct post waiting", async () => {
    emitSnapshot(CHANNEL_ID, {
      messages: [post({ direct: false, resolvedAt: null })],
    });
    mountChannel([]);
    emitActivity({ trunk: replying(null, null), threads: {} });

    await screen.findByText("Is CI green?");
    expect(screen.queryByTestId("bot-channel-replying")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("<BotChannelView /> a thread's typing line", () => {
  it("shows on the closed thread's line, and moves to the panel once the thread is open", async () => {
    const user = userEvent.setup();
    emitSnapshot(CHANNEL_ID, {
      messages: [post({ direct: false, resolvedAt: null })],
    });
    mountChannel([threadSummary()]);
    emitActivity({
      trunk: null,
      threads: { [THREAD_ID]: replying("request-1", null) },
    });

    const line = await screen.findByTestId("bot-thread-line");
    expect(
      within(within(line).getByTestId("bot-thread-replying")).getByText(
        "Tracy is replying…",
      ),
    ).toBeTruthy();

    await user.click(line);

    // One entry for the thread, whichever session runs it: the panel says it
    // from the moment it opens, and the line no longer does.
    const panel = await screen.findByTestId("bot-thread-panel");
    const strip = await within(panel).findByTestId("bot-thread-replying-strip");
    expect(within(strip).getByText("Tracy is replying…")).toBeTruthy();
    expect(screen.queryByTestId("bot-thread-replying")).toBeNull();
  });
});

describe("<BotChannelView /> a channel nobody has written in", () => {
  it("opens with the channel's name, where it begins, and what the bot does", async () => {
    emitSnapshot(CHANNEL_ID, { messages: [], ...IDLE });
    mountChannel([]);

    const intro = await screen.findByTestId("bot-channel-intro");
    expect(within(intro).getByText("#Tracy", { selector: "p" })).toBeTruthy();
    expect(
      within(intro).getByText(
        (_content, element) =>
          element?.tagName === "P" &&
          element.textContent === "This is the beginning of #Tracy.",
      ),
    ).toBeTruthy();
    expect(within(intro).getByText(DIRECTIVE)).toBeTruthy();
    expect(screen.queryByTestId("chat-messages-stub")).toBeNull();
  });
});
