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
  type RenderResult,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { ChatRunStatus } from "@traycer/protocol/host/agent/gui/subscribe";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { commandActivityLabel } from "@traycer/protocol/host/agent/gui/activity-step-label";
import type {
  BotConversationSendDelivery,
  BotConversationSendRequest,
  BotConversationSendResponse,
  BotThreadSummary,
} from "@traycer/protocol/host/bot/conversation-schemas";
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
  useBotOpenThreadStore,
  useBotRail,
} from "@/stores/bots/bot-open-thread-store";
import { useBotTabsStore } from "@/stores/bots/bot-tabs-store";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import { useAuthStore } from "@/stores/auth/auth-store";
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

/** What a box hands the send mutation for its send. */
interface SendCallbacks {
  readonly onSuccess:
    | ((response: BotConversationSendResponse) => void)
    | undefined;
  readonly onError: ((error: Error) => void) | undefined;
}

interface SessionHarness {
  readonly handle: ChatSessionStoreHandle;
  callbacks(): ChatStreamCallbacks;
}

const mocks = vi.hoisted(() => ({
  /** `bot.conversation.send`, answered by the case through the callbacks it was handed. */
  send: vi.fn<
    (variables: BotConversationSendRequest, callbacks: SendCallbacks) => void
  >(),
  /** Each send's callbacks, to the send settling once the box has taken its outcome. */
  settled: new WeakMap<SendCallbacks, Promise<void>>(),
  sessionFor: null as
    | ((chatId: string, enabled: boolean) => ChatSessionStoreHandle | null)
    | null,
  threadListData: { threads: [], threadAnchors: null } as {
    threads: ReadonlyArray<BotThreadSummary>;
    threadAnchors: null;
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
    mutate: mocks.send,
    // The box settles its send through the promise; the case settles it
    // through the callbacks the promise is built on.
    mutateAsync: (variables: BotConversationSendRequest) => {
      const { promise, resolve, reject } =
        Promise.withResolvers<BotConversationSendResponse>();
      const callbacks: SendCallbacks = { onSuccess: resolve, onError: reject };
      mocks.settled.set(
        callbacks,
        promise.then(
          () => undefined,
          () => undefined,
        ),
      );
      mocks.send(variables, callbacks);
      return promise;
    },
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
  useChatLocateRowAnswer: (_args: ChatLocateRowArgs) => ({
    status: "waiting",
  }),
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
  return { state: "replying", startedAt: 3, step, requestId, reason: null };
}

const IDLE_ACTIVITY: BotSessionActivity = {
  state: "idle",
  startedAt: null,
  step: null,
  requestId: null,
  reason: null,
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
      notificationSubscriptions: null,
      stoppedNotificationWatches: null,
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
  const rail = useBotRail(BOT_ID);
  const openThread = rail?.kind === "thread" ? rail : null;
  return (
    <BotChannelView
      botId={BOT_ID}
      hostId={HOST_ID}
      boundHostId={HOST_ID}
      boundHostEpoch={1}
      botTitle="Tracy"
      directive={props.directive}
      appConversationChatId={CHANNEL_ID}
      trunkChatId="trunk-chat"
      openTurn={null}
      onOpenTurn={vi.fn()}
      openMemory={null}
      onOpenMemory={vi.fn()}
      environmentId="env-1"
      botNameOf={() => null}
      resolveMember={resolveMember}
      tasks={[]}
      openThread={openThread}
      onOpenThread={(open) =>
        useBotOpenThreadStore
          .getState()
          .setRail(BOT_ID, open === null ? null : { kind: "thread", ...open })
      }
      onOpenActivity={vi.fn()}
    />
  );
}

const DIRECTIVE = "Watches CI and answers questions about the nightly run.";

function mountChannel(threads: ReadonlyArray<BotThreadSummary>): RenderResult {
  mocks.threadListData = { threads, threadAnchors: null };
  // The transcript reads the app's send ledger off the query client.
  return render(
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
  // What a box held unsent is kept under the bot, past its view.
  useBotDraftsStore.setState({ answers: {}, threadBoxes: {} });
  cleanup();
  mocks.send.mockReset();
  for (const { handle } of sessions.values()) handle.dispose();
  sessions.clear();
  mocks.sessionFor = null;
  mocks.threadListData = { threads: [], threadAnchors: null };
  useBotTabsStore.setState({ tabs: {} });
  useBotOpenThreadStore.setState({ byBotId: {} });
  useAuthStore.setState({ profile: null });
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

  it("never names the step the trunk's turn has in flight", async () => {
    const step = commandActivityLabel("gh run view --log-failed");
    await mountAwaitingDirectReply(replying("request-1", step));

    const strip = await screen.findByTestId("bot-channel-replying");
    expect(within(strip).getByText("Tracy is replying…")).toBeTruthy();
    expect(document.body.textContent).not.toContain("gh run view");
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
    expect(screen.queryByTestId("bot-message-unanswered")).toBeNull();
  });

  it("clears when the bot's stream closes for good with the trunk still replying, and reports no failure", async () => {
    await mountAwaitingDirectReply(replying("request-1", null));
    await screen.findByTestId("bot-channel-replying");

    closeBotStream(false);

    // No frame will clear a closed stream's last reading.
    await waitFor(() => {
      expect(screen.queryByTestId("bot-channel-replying")).toBeNull();
    });
    expect(screen.queryByTestId("bot-message-unanswered")).toBeNull();
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
  it("shows on the closed thread's line, and moves to the panel once the thread is open, never naming the step", async () => {
    const user = userEvent.setup();
    emitSnapshot(CHANNEL_ID, {
      messages: [post({ direct: false, resolvedAt: null })],
    });
    mountChannel([threadSummary()]);
    emitActivity({
      trunk: null,
      threads: {
        [THREAD_ID]: replying(
          "request-1",
          commandActivityLabel("gh run view --log-failed"),
        ),
      },
    });

    const line = await screen.findByTestId("bot-thread-line");
    expect(
      within(within(line).getByTestId("bot-thread-replying")).getByText(
        "Tracy is replying…",
      ),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("gh run view");

    await user.click(line);

    // One entry for the thread, whichever session runs it: the panel says it
    // from the moment it opens, and the line no longer does.
    const panel = await screen.findByTestId("bot-thread-panel");
    const strip = await within(panel).findByTestId("bot-thread-replying-strip");
    expect(within(strip).getByText("Tracy is replying…")).toBeTruthy();
    expect(screen.queryByTestId("bot-thread-replying")).toBeNull();
    expect(document.body.textContent).not.toContain("gh run view");
  });
});

describe("<BotChannelView /> a channel nobody has written in", () => {
  it("opens with the channel's name, where it begins, and what the bot does", async () => {
    emitSnapshot(CHANNEL_ID, { messages: [], ...IDLE });
    mountChannel([]);

    const intro = await screen.findByTestId("bot-channel-intro");
    expect(within(intro).getByText("Tracy", { selector: "p" })).toBeTruthy();
    expect(
      within(intro).getByText(
        (_content, element) =>
          element?.tagName === "P" &&
          element.textContent ===
            "This is the beginning of your channel with Tracy.",
      ),
    ).toBeTruthy();
    expect(within(intro).getByText(DIRECTIVE)).toBeTruthy();
    expect(screen.queryByTestId("chat-messages-stub")).toBeNull();
  });
});

describe("<BotChannelView /> a post whose answer lands in a thread", () => {
  /** The channel's box sending what was typed into it, and the callbacks it handed the send. */
  async function postInChannel(user: UserEvent): Promise<SendCallbacks> {
    const box = screen.getByRole("textbox", { name: "Message Tracy" });
    await user.type(box, "Is CI green?");
    await user.click(screen.getByTestId("bot-channel-composer-send"));
    const call = mocks.send.mock.calls.at(-1);
    if (call === undefined) throw new Error("the channel's box sent nothing");
    expect(call[0]).toMatchObject({ text: "Is CI green?", threadId: null });
    return call[1];
  }

  async function accept(
    callbacks: SendCallbacks,
    threadId: string | null,
    delivery: BotConversationSendDelivery,
  ): Promise<void> {
    await act(async () => {
      callbacks.onSuccess?.({
        messageId: POST_ID,
        requestId: "request-1",
        delivery,
        threadId,
      });
      await mocks.settled.get(callbacks);
    });
  }

  function textbox(name: string): HTMLTextAreaElement {
    const box = screen.getByRole("textbox", { name });
    if (!(box instanceof HTMLTextAreaElement)) throw new Error("no textbox");
    return box;
  }

  function mountQuietChannel(): RenderResult {
    emitSnapshot(CHANNEL_ID, { messages: [] });
    const view = mountChannel([]);
    emitActivity({ trunk: null, threads: {} });
    return view;
  }

  it("opens the thread on the post as the send is accepted, saying the bot is replying, and keeps the reply box when the list catches up", async () => {
    const user = userEvent.setup();
    mountQuietChannel();

    await accept(await postInChannel(user), THREAD_ID, "written");

    const panel = await screen.findByTestId("bot-thread-panel");
    expect(panel.getAttribute("data-thread-id")).toBe(THREAD_ID);
    expect(
      within(within(panel).getByTestId("bot-thread-anchor")).getByText(
        "Is CI green?",
      ),
    ).toBeTruthy();
    expect(within(panel).queryByTestId("bot-thread-loading")).toBeNull();
    expect(textbox("Message Tracy").value).toBe("");
    // The channel's row lands after the host answered the send.
    emitSnapshot(CHANNEL_ID, {
      messages: [post({ direct: false, resolvedAt: null })],
    });
    expect(
      within(within(panel).getByTestId("bot-thread-anchor")).getByText(
        "Is CI green?",
      ),
    ).toBeTruthy();

    emitActivity({
      trunk: null,
      threads: { [THREAD_ID]: replying("request-1", null) },
    });
    const strip = await within(panel).findByTestId("bot-thread-replying-strip");
    expect(within(strip).getByText("Tracy is replying…")).toBeTruthy();
    expect(screen.queryByTestId("bot-thread-replying")).toBeNull();

    const reply = textbox("Reply in the thread");
    await user.type(reply, "And the nightly?");
    expect(document.activeElement).toBe(reply);

    // The list's next read returns the thread; the activity frame redraws.
    mocks.threadListData = {
      threads: [{ ...threadSummary(), replyCount: 0, lastReplyAt: null }],
      threadAnchors: null,
    };
    emitActivity({
      trunk: null,
      threads: { [THREAD_ID]: replying("request-1", null) },
    });

    expect(await within(panel).findByTestId("bot-thread-replies")).toBeTruthy();
    expect(
      within(panel).getByRole("textbox", { name: "Reply in the thread" }),
    ).toBe(reply);
    expect(reply.value).toBe("And the nightly?");
    expect(document.activeElement).toBe(reply);
    expect(within(panel).getByTestId("bot-thread-replying-strip")).toBeTruthy();
  });

  it("opens the thread of a queued post on the post as sent, says it was saved there and not under the channel's box, and retires that once the post's row lands", async () => {
    const user = userEvent.setup();
    // The post's writer is the viewer, as the channel names their own posts.
    useAuthStore.setState({
      profile: {
        userId: USER_ID,
        userName: "Tess Teammate",
        email: "tess@example.com",
        avatarUrl: null,
      },
    });
    const view = mountQuietChannel();

    await accept(await postInChannel(user), THREAD_ID, "queued");

    // No channel row yet: the bot's host has not taken the post.
    const panel = await screen.findByTestId("bot-thread-panel");
    const anchor = within(panel).getByTestId("bot-thread-anchor");
    expect(within(anchor).getByText("Is CI green?")).toBeTruthy();
    expect(within(anchor).getByText("Tess Teammate")).toBeTruthy();
    expect(within(panel).getByTestId("bot-thread-queued").textContent).toBe(
      "Saved. The bot will read it.",
    );
    // Said once, where the person now looks.
    expect(screen.queryByTestId("bot-channel-composer-queued")).toBeNull();

    // The bot's host takes the post and writes its row: what was saved has
    // been read.
    emitSnapshot(CHANNEL_ID, {
      messages: [post({ direct: false, resolvedAt: null })],
    });

    expect(within(panel).getByTestId("bot-thread-anchor")).toBe(anchor);
    expect(anchor.getAttribute("data-loaded")).toBe("true");
    expect(within(anchor).getByText("Is CI green?")).toBeTruthy();
    expect(within(anchor).getByText("Tess Teammate")).toBeTruthy();
    expect(screen.queryByTestId("bot-thread-queued")).toBeNull();

    emitActivity({
      trunk: null,
      threads: { [THREAD_ID]: replying("request-1", null) },
    });
    const strip = await within(panel).findByTestId("bot-thread-replying-strip");
    expect(within(strip).getByText("Tracy is replying…")).toBeTruthy();
    expect(screen.queryByTestId("bot-thread-queued")).toBeNull();

    // Messages → Activity → Messages: the tab unmounts the channel and
    // mounts it again on the thread it holds open.
    view.unmount();
    mountChannel([]);
    const again = await screen.findByTestId("bot-thread-panel");
    expect(
      within(within(again).getByTestId("bot-thread-anchor")).getByText(
        "Is CI green?",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("bot-thread-queued")).toBeNull();
  });

  it("says a queued post the bot answers in the channel under the channel's box", async () => {
    const user = userEvent.setup();
    mountQuietChannel();

    await accept(await postInChannel(user), null, "queued");

    expect(screen.queryByTestId("bot-thread-panel")).toBeNull();
    expect(screen.getByTestId("bot-channel-composer-queued").textContent).toBe(
      "Saved. The bot will read it.",
    );
  });

  it("opens no thread for a post the bot answers in the channel", async () => {
    const user = userEvent.setup();
    mountQuietChannel();

    await accept(await postInChannel(user), null, "written");

    expect(screen.queryByTestId("bot-thread-panel")).toBeNull();
    expect(textbox("Message Tracy").value).toBe("");
  });

  it("opens no thread and keeps the text when the send fails", async () => {
    const user = userEvent.setup();
    mountQuietChannel();

    const callbacks = await postInChannel(user);
    await act(async () => {
      callbacks.onError?.(new Error("host refused the post"));
      await mocks.settled.get(callbacks);
    });

    expect(screen.queryByTestId("bot-thread-panel")).toBeNull();
    expect(textbox("Message Tracy").value).toBe("Is CI green?");
  });
});
