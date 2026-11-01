/**
 * A post the bot failed to answer (Tracy Bots T69), through the REAL
 * `BotChannelView`: its transcript rows, hover actions, message box and the
 * `bot.conversation.send` mutation run over a host client whose messenger
 * records the request that leaves. Only the virtualised list is replaced, as
 * in the thread-panel suite, and what the bot is doing is scripted through
 * the one `useBotActivity` the view reads. What is asserted is what the
 * person sees on the row and what the host RECEIVES: the row says under its
 * text that it was not answered and why, Retry re-delivers the request as it
 * is, Edit loads the text into the channel's box and the send replaces the
 * failed post, and Sign in opens the provider on the bot's host.
 */
import { StrictMode, type ReactElement } from "react";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HostClient,
  type HostRequester,
} from "@traycer-clients/shared/host-client/host-client";
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { recordNegotiatedHostManifest } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  BotConversationSendRequest,
  BotThreadSummary,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import {
  negotiateBotSend,
  resetBotFailedRequestSupport,
  signInViewer,
  VIEWER_USER_ID,
} from "@/components/bots/__tests__/bot-failed-request-test-support";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { TooltipProvider } from "@/components/ui/tooltip";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import type {
  BotActivity,
  BotSessionActivity,
} from "@/hooks/bots/use-bot-activity";
import type {
  ChatSessionState,
  ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";
import type { OpenSettingsModalOpts } from "@/stores/tabs/system-overlay-types";
import { sandboxRefusalCopyFor } from "@/components/chat/segments/sandbox-refusal-copy";
import { emptyTranscriptWindow } from "@/stores/chats/transcript-window";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";

type ChannelTranscriptState = Pick<
  ChatSessionState,
  | "snapshotLoaded"
  | "messages"
  | "events"
  | "transcriptRowContext"
  | "transcriptDerived"
  | "pendingUserMessages"
  | "queue"
  | "turnInProgress"
  | "messageDelivery"
  | "liveAssistantMessage"
  | "activeTurn"
  | "pendingApprovals"
  | "pendingFileEditApprovals"
  | "pendingInterviews"
  | "runStatus"
  | "transcriptWindow"
  | "transcriptBaselineEpoch"
  | "transcriptHydrationSequence"
  | "coldRewrittenMessageIds"
  | "backgroundItems"
  | "reportVisibleTranscriptRange"
  | "requestFindReadOrdinal"
  | "requestTranscriptOrdinal"
  | "holdTranscriptOrdinal"
>;

const mocks = vi.hoisted(() => ({
  channelHandle: null as ChatSessionStoreHandle | null,
  threadHandle: null as ChatSessionStoreHandle | null,
  client: null as HostRequester<HostRpcRegistry> | null,
  /** The client of the host that runs the bot, which takes an Update. */
  boundClient: null as HostRequester<HostRpcRegistry> | null,
  threads: [] as BotThreadSummary[],
  openSettings: vi.fn<(opts: OpenSettingsModalOpts) => void>(),
}));

vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  // The channel reads its own session; a thread's has rows where a case
  // gives it some.
  useChatSessionHandleForContainer: (
    _botId: string,
    chatId: string,
  ): ChatSessionStoreHandle | null => {
    if (chatId === CHANNEL_ID) return mocks.channelHandle;
    return chatId === THREAD_ID ? mocks.threadHandle : null;
  },
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.client,
}));
// The app's host binding names a client per host; here only the host that
// runs the bot has one.
vi.mock("@/lib/host/binding-host-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/binding-host-client")>()),
  resolveNamedHostClient: (_binding: unknown, hostId: string) =>
    hostId === BOUND_HOST_ID ? mocks.boundClient : null,
}));
vi.mock("@/hooks/host/use-host-supports-method", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-supports-method")
  >()),
  useHostMethodSupport: () => true,
}));
vi.mock("@/components/epic-tabs/pane-visibility-context", () => ({
  usePaneVisible: () => true,
}));
vi.mock("@/hooks/bots/use-bot-conversation-list-query", () => ({
  useBotConversationListQuery: () => ({
    data: { conversations: [{ conversationId: CHANNEL_ID }] },
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/bots/use-bot-thread-list-query", () => ({
  useBotThreadListQuery: () => ({
    data: { threads: mocks.threads, threadAnchors: null },
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/notifications/use-notification-indicators-query", () => ({
  useNotificationIndicators: () => ({ epics: {}, chats: {} }),
}));
vi.mock(
  "@/hooks/notifications/use-notification-mark-entity-read-mutation",
  () => ({
    useNotificationMarkEntityRead: () => ({ mutate: vi.fn() }),
  }),
);
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessCatalogForClient: () => ({ harnesses: [] }),
}));
vi.mock("@/hooks/chats/use-chat-locate-row", () => ({
  useChatLocateRow: () => null,
  useChatLocateRowAnswer: () => ({ status: "waiting" }),
}));
// Opening Settings is the router's; the providers focus it sets is real.
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: mocks.openSettings }),
}));
vi.mock("@/hooks/bots/use-bot-activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/bots/use-bot-activity")>()),
  useBotActivity: () => activityStore((state) => state.activity),
}));
vi.mock("@/components/chat/chat-messages", async () => {
  const { ChatExpansionTestProviders: Providers } =
    await import("@/components/chat/__tests__/chat-expansion-test-providers");
  const { use } = await import("react");
  const { ChatMessage } = await import("@/components/chat/chat-message");
  const { ChatTimelineHeaderContext } =
    await import("@/components/chat/chat-timeline-header-context");
  const noBackgroundToolBlockIds: ReadonlySet<string> = new Set();
  return {
    ChatMessages: (props: {
      messages: ReadonlyArray<ChatMessageModel>;
      instanceId: string;
    }) => (
      <Providers tileInstanceId={props.instanceId}>
        <div data-testid="chat-messages-stub">
          {use(ChatTimelineHeaderContext)}
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

/** What the bot is doing, as the scripted `useBotActivity` reads it. */
const activityStore = create<{ activity: BotActivity | null }>()(() => ({
  activity: null,
}));

import { BotChannelView } from "@/components/bots/bot-channel-view";
import type { BotOpenThread } from "@/stores/bots/bot-open-thread-store";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import type { BotMemberResolver } from "@/lib/bots/bot-member-names";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
/** The host serving the tab, which takes the sends. */
const HOST_ID = "host-tab";
const CHANNEL_ID = "conversation-channel";
const THREAD_ID = "thread-1";
const POST_ID = "post-1";
const POST_REQUEST = "req-post";
const POST_TEXT = "Is CI green?";

const TEAMMATE_USER_ID = "user-teammate";
/** The host that runs the bot: another host than the one serving the tab. */
const BOUND_HOST_ID = "host-runs-bot";

const resolveMember: BotMemberResolver = (userId) =>
  userId === TEAMMATE_USER_ID
    ? { displayName: "Tess Teammate", avatarUrl: null }
    : null;

function textDoc(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

/** `senderUserId`'s post in the channel, its request open. */
function memberPost(senderUserId: string): Message {
  return {
    role: "user",
    messageId: POST_ID,
    sender: { type: "user", userId: senderUserId },
    message: {
      kind: "user",
      content: textDoc(POST_TEXT),
      browserAnnotations: [],
    },
    timestamp: 1_000,
    sessionAnchor: null,
    conversationRequest: {
      requestId: POST_REQUEST,
      resolvedAt: null,
      resolvedByMessageId: null,
    },
  };
}

const SECOND_REQUEST = "req-second";
const SECOND_TEXT = "Did the nightly run?";

/** The viewer's later post in the channel, its request open too. */
function secondPost(): Message {
  return {
    role: "user",
    messageId: "post-2",
    sender: { type: "user", userId: VIEWER_USER_ID },
    message: {
      kind: "user",
      content: textDoc(SECOND_TEXT),
      browserAnnotations: [],
    },
    timestamp: 1_500,
    sessionAnchor: null,
    conversationRequest: {
      requestId: SECOND_REQUEST,
      resolvedAt: null,
      resolvedByMessageId: null,
    },
  };
}

/** The thread `senderUserId`'s post opened. */
function postThread(senderUserId: string): BotThreadSummary {
  return {
    threadId: THREAD_ID,
    conversationId: CHANNEL_ID,
    sessionChatId: "session-1",
    anchor: {
      messageId: POST_ID,
      requestId: POST_REQUEST,
      senderUserId,
      sentAt: 1_000,
      resolvedAt: null,
      excerpt: null,
    },
    replyCount: 1,
    lastReplyAt: 2_000,
    openRequestCount: 1,
    costUsd: null,
  };
}

function sessionOn(
  state: "failed" | "parked",
  requestId: string | null,
): BotSessionActivity {
  return { state, startedAt: 1_000, step: null, requestId, reason: null };
}

function failedOn(requestId: string): BotSessionActivity {
  return sessionOn("failed", requestId);
}

/** The bot's trunk failed answering `requestId`. */
function trunkFailedOn(requestId: string): BotActivity {
  return { trunk: failedOn(requestId), threads: {} };
}

function createChannelStore(
  messages: ReadonlyArray<Message>,
): UseBoundStore<StoreApi<ChannelTranscriptState>> {
  return create<ChannelTranscriptState>()(() => ({
    snapshotLoaded: true,
    messages,
    events: [],
    transcriptRowContext: {},
    transcriptDerived: null,
    pendingUserMessages: [],
    queue: { status: "idle", items: [] },
    turnInProgress: undefined,
    messageDelivery: null,
    liveAssistantMessage: null,
    activeTurn: null,
    pendingApprovals: [],
    pendingFileEditApprovals: [],
    pendingInterviews: [],
    runStatus: "idle",
    transcriptWindow: emptyTranscriptWindow(),
    transcriptBaselineEpoch: 0,
    transcriptHydrationSequence: 0,
    coldRewrittenMessageIds: new Set<string>(),
    backgroundItems: undefined,
    reportVisibleTranscriptRange: vi.fn(),
    requestFindReadOrdinal: vi.fn(),
    requestTranscriptOrdinal: vi.fn(),
    holdTranscriptOrdinal: () => () => undefined,
  }));
}

let sent: ReadonlyArray<BotConversationSendRequest>;
/** The bound host the view is given; a case may say no host runs the bot. */
let boundHostId: string | null;
/** While set, the host holds each send until it settles, then answers `queued`. */
let heldSends: Promise<void> | null;
/** While set, the host refuses every send. */
let refuseSends: boolean;
/** The thread the host answers a send is in; `null` for reply mode `direct`. */
let answerThreadId: string | null;
const onOpenThread = vi.fn<(open: BotOpenThread | null) => void>();

/** The tab's host client, over a messenger whose `bot.conversation.send` records what it is asked. */
function hostClientRecordingSends(): HostRequester<HostRpcRegistry> {
  const queryClient = new QueryClient();
  let seq = 0;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => `request-${String(++seq)}`,
    handlers: {
      "bot.conversation.send": (params) => {
        sent = [...sent, params];
        if (refuseSends) {
          return Promise.reject(new Error("host refused the retry"));
        }
        const hold = heldSends;
        const response = {
          messageId: "message-new",
          requestId: "req-new",
          delivery: hold === null ? ("written" as const) : ("queued" as const),
          threadId: answerThreadId,
        };
        return hold === null
          ? Promise.resolve(response)
          : hold.then(() => response);
      },
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockRemoteHostEntry.hostId ? mockRemoteHostEntry : null,
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine.createRequester(mockRemoteHostEntry);
}

/** What the bot's host was asked to update, in order. */
let ensured: ReadonlyArray<string>;

/** The bot's host's client, over a messenger whose `providers.ensurePack` records the provider. */
function boundHostClientRecordingUpdates(): HostRequester<HostRpcRegistry> {
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "request-update",
    handlers: {
      "providers.ensurePack": (params) => {
        ensured = [...ensured, params.providerId];
        return Promise.resolve({ managedInstallState: null });
      },
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(new QueryClient()),
    findHostById: (hostId) =>
      hostId === mockRemoteHostEntry.hostId ? mockRemoteHostEntry : null,
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine.createRequester(mockRemoteHostEntry);
}

/** The channel with `post` in it, the viewer's own unless a case says otherwise. */
function mountChannel(openThread: BotOpenThread | null, post: Message): void {
  mountChannelWith(openThread, [post]);
}

function mountChannelWith(
  openThread: BotOpenThread | null,
  posts: ReadonlyArray<Message>,
): () => void {
  mocks.channelHandle = {
    store: createChannelStore(posts),
  } as ChatSessionStoreHandle;
  // One client for the mount, as the app has: a rerender keeps its cache.
  const queryClient = new QueryClient();
  const tree = (): ReactElement => (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ChatExpansionTestProviders tileInstanceId="tile-1">
            <BotChannelView
              tiles={null}
              botId={BOT_ID}
              hostId={HOST_ID}
              boundHostId={boundHostId}
              boundHostEpoch={1}
              botTitle="Release Bot"
              directive={null}
              appConversationChatId={CHANNEL_ID}
              trunkChatId="trunk-chat"
              onOpenTurn={vi.fn()}
              onOpenSession={vi.fn()}
              landOn={null}
              openMemory={null}
              onOpenMemory={vi.fn()}
              environmentId="env-1"
              botNameOf={() => null}
              resolveMember={resolveMember}
              tasks={[]}
              surfaceActions={null}
              openThread={openThread}
              onOpenThread={onOpenThread}
              onOpenActivity={vi.fn()}
              setupHistory={null}
            />
          </ChatExpansionTestProviders>
        </TooltipProvider>
      </QueryClientProvider>
    </StrictMode>
  );
  const view = render(tree());
  return () => view.rerender(tree());
}

function channelBox(): HTMLTextAreaElement {
  const box = screen.getByRole("textbox", { name: "Message Release Bot" });
  if (!(box instanceof HTMLTextAreaElement)) throw new Error("not a textarea");
  return box;
}

beforeEach(() => {
  sent = [];
  boundHostId = BOUND_HOST_ID;
  heldSends = null;
  refuseSends = false;
  answerThreadId = null;
  onOpenThread.mockClear();
  mocks.openSettings.mockClear();
  useProvidersFocusStore.getState().clearFocusHarnessId();
  mocks.threads = [];
  activityStore.setState({ activity: null });
  mocks.client = hostClientRecordingSends();
  ensured = [];
  mocks.boundClient = boundHostClientRecordingUpdates();
  // A host that can retry and replace, and a viewer who wrote the post.
  negotiateBotSend(HOST_ID, { major: 1, minor: 1 });
  signInViewer(VIEWER_USER_ID);
});

afterEach(() => {
  // What a box held unsent is kept under the bot, past its view.
  useBotDraftsStore.setState({ answers: {}, threadBoxes: {} });
  cleanup();
  resetBotFailedRequestSupport();
  mocks.channelHandle = null;
  mocks.threadHandle = null;
  mocks.client = null;
  mocks.boundClient = null;
});

describe("<BotChannelView tiles={null} /> Retry on a post the bot failed to answer", () => {
  it("re-delivers the post as it is, as a channel post", async () => {
    const user = userEvent.setup();
    activityStore.setState({ activity: trunkFailedOn(POST_REQUEST) });
    mountChannel(null, memberPost(VIEWER_USER_ID));

    await user.click(
      within(screen.getByTestId("bot-member-row")).getByTestId(
        "bot-message-retry",
      ),
    );

    expect(sent).toEqual([
      {
        botId: BOT_ID,
        conversationId: CHANNEL_ID,
        text: POST_TEXT,
        threadId: null,
        announcementId: null,
        redeliver: { requestId: POST_REQUEST },
        supersedes: null,
        answer: null,
      },
    ]);
  });

  it("offers it, still as a channel post, when the thread the post opened is the session that failed", async () => {
    const user = userEvent.setup();
    mocks.threads = [postThread(VIEWER_USER_ID)];
    activityStore.setState({
      activity: {
        trunk: null,
        threads: { [THREAD_ID]: failedOn(POST_REQUEST) },
      },
    });
    mountChannel(null, memberPost(VIEWER_USER_ID));

    await user.click(
      within(screen.getByTestId("bot-member-row")).getByTestId(
        "bot-message-retry",
      ),
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].threadId).toBeNull();
    expect(sent[0].redeliver).toEqual({ requestId: POST_REQUEST });
  });

  it("is not offered while the session failed on a different request", () => {
    activityStore.setState({ activity: trunkFailedOn("req-other") });
    mountChannel(null, memberPost(VIEWER_USER_ID));

    expect(screen.getByText(POST_TEXT)).toBeTruthy();
    expect(screen.queryByTestId("bot-message-retry")).toBeNull();
    expect(screen.queryByTestId("bot-message-edit")).toBeNull();
  });
});

describe("<BotChannelView tiles={null} /> a host that cannot retry or replace", () => {
  /** The trunk failed on the post with a sign-out, the fix the person can still make. */
  function signedOut(): BotActivity {
    return {
      trunk: {
        ...failedOn(POST_REQUEST),
        reason: {
          summary: "Claude is signed out.",
          code: null,
          harnessId: "claude",
          action: "sign-in",
        },
      },
      threads: {},
    };
  }

  /** The post's line says why and offers Sign in, with no Retry or Edit anywhere. */
  function expectFailureWithoutSends(): void {
    const line = within(screen.getByTestId("bot-member-row")).getByTestId(
      "bot-message-unanswered",
    );
    expect(line.textContent).toBe(
      "Not answered: Claude is signed out. · Sign in",
    );
    expect(screen.queryByTestId("bot-message-retry")).toBeNull();
    expect(screen.queryByTestId("bot-message-edit")).toBeNull();
    expect(screen.queryByTestId("bot-message-unanswered-retry")).toBeNull();
    expect(screen.queryByTestId("bot-message-unanswered-edit")).toBeNull();
  }

  it("says why the post was not answered, and offers Sign in but neither Retry nor Edit, on a host that negotiated bot.conversation.send 1.0", () => {
    negotiateBotSend(HOST_ID, { major: 1, minor: 0 });
    activityStore.setState({ activity: signedOut() });
    mountChannel(null, memberPost(VIEWER_USER_ID));

    expectFailureWithoutSends();
  });

  it("says why, and offers neither Retry nor Edit, while no handshake with the host is known", () => {
    resetBotFailedRequestSupport();
    signInViewer(VIEWER_USER_ID);
    activityStore.setState({ activity: signedOut() });
    mountChannel(null, memberPost(VIEWER_USER_ID));

    expectFailureWithoutSends();
  });

  it("offers both once the host's handshake reaches 1.1, without remounting", () => {
    negotiateBotSend(HOST_ID, { major: 1, minor: 0 });
    activityStore.setState({ activity: trunkFailedOn(POST_REQUEST) });
    mountChannel(null, memberPost(VIEWER_USER_ID));
    expect(screen.queryByTestId("bot-message-retry")).toBeNull();

    act(() => {
      negotiateBotSend(HOST_ID, { major: 1, minor: 1 });
    });

    expect(screen.getByTestId("bot-message-retry")).toBeTruthy();
    expect(screen.getByTestId("bot-message-edit")).toBeTruthy();
  });
});

describe("<BotChannelView tiles={null} /> a post the bot parked on", () => {
  it("offers Retry, re-delivered as it is, on the post the trunk's parked queue holds", async () => {
    const user = userEvent.setup();
    activityStore.setState({
      activity: { trunk: sessionOn("parked", POST_REQUEST), threads: {} },
    });
    mountChannel(null, memberPost(VIEWER_USER_ID));

    await user.click(
      within(screen.getByTestId("bot-member-row")).getByTestId(
        "bot-message-retry",
      ),
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].redeliver).toEqual({ requestId: POST_REQUEST });
    expect(sent[0].threadId).toBeNull();
  });

  it("offers Retry on the post when the thread it opened is the session that parked", () => {
    mocks.threads = [postThread(VIEWER_USER_ID)];
    activityStore.setState({
      activity: {
        trunk: null,
        threads: { [THREAD_ID]: sessionOn("parked", POST_REQUEST) },
      },
    });
    mountChannel(null, memberPost(VIEWER_USER_ID));

    expect(screen.getByTestId("bot-message-retry")).toBeTruthy();
  });

  it("offers Retry on a post parked on its first delivery, before any turn took it", () => {
    // As the host reports a delivery it could not start: no turn ever began,
    // and the parked entry names the request the queue is held on.
    const summary =
      "Queue paused because a conversation message could not be delivered: the chat has no workspace to run in.";
    activityStore.setState({
      activity: {
        trunk: {
          state: "parked",
          startedAt: null,
          step: null,
          requestId: POST_REQUEST,
          reason: { summary, code: null, harnessId: "claude", action: "none" },
        },
        threads: {},
      },
    });
    mountChannel(null, memberPost(VIEWER_USER_ID));

    expect(
      within(screen.getByTestId("bot-member-row")).getByTestId(
        "bot-message-retry",
      ),
    ).toBeTruthy();
    expect(screen.getByText(new RegExp(summary.slice(0, 40)))).toBeTruthy();
  });

  it("offers nothing when the parked session carries no request", () => {
    activityStore.setState({
      activity: { trunk: sessionOn("parked", null), threads: {} },
    });
    mountChannel(null, memberPost(VIEWER_USER_ID));

    expect(screen.getByText(POST_TEXT)).toBeTruthy();
    expect(screen.queryByTestId("bot-message-retry")).toBeNull();
    expect(screen.queryByTestId("bot-message-edit")).toBeNull();
  });
});

describe("<BotChannelView tiles={null} /> a teammate's post the bot failed to answer", () => {
  it("offers Retry, which any member may press, and no Edit, which only its writer may", async () => {
    const user = userEvent.setup();
    activityStore.setState({ activity: trunkFailedOn(POST_REQUEST) });
    mountChannel(null, memberPost(TEAMMATE_USER_ID));
    const row = screen.getByTestId("bot-member-row");

    expect(within(row).queryByTestId("bot-message-edit")).toBeNull();
    await user.click(within(row).getByTestId("bot-message-retry"));

    expect(sent).toHaveLength(1);
    expect(sent[0].redeliver).toEqual({ requestId: POST_REQUEST });
    expect(sent[0].supersedes).toBeNull();
  });

  it("says a refused Retry of the teammate's post in the channel's box, without asking for an edit there is none to make", async () => {
    const user = userEvent.setup();
    refuseSends = true;
    activityStore.setState({ activity: trunkFailedOn(POST_REQUEST) });
    mountChannel(null, memberPost(TEAMMATE_USER_ID));

    await user.click(
      within(screen.getByTestId("bot-member-row")).getByTestId(
        "bot-message-unanswered-retry",
      ),
    );

    const notice = await screen.findByTestId(
      "bot-channel-composer-send-failed",
    );
    expect(notice.textContent).toBe("Couldn't send. Try again.");
    expect(channelBox().value).toBe("");
  });

  it("offers Retry and no Edit on the thread anchor the teammate wrote", () => {
    mocks.threads = [postThread(TEAMMATE_USER_ID)];
    activityStore.setState({
      activity: {
        trunk: null,
        threads: { [THREAD_ID]: failedOn(POST_REQUEST) },
      },
    });
    mountChannel(
      {
        anchorMessageId: POST_ID,
        announcement: false,
        anchorKind: null,
        sent: null,
      },
      memberPost(TEAMMATE_USER_ID),
    );

    const anchor = screen.getByTestId("bot-thread-anchor");
    expect(
      within(anchor).getByTestId("bot-message-unanswered-retry"),
    ).toBeTruthy();
    expect(
      within(anchor).queryByTestId("bot-message-unanswered-edit"),
    ).toBeNull();
  });

  it("offers no Edit to a viewer who is not signed in", () => {
    useAuthStore.setState({ profile: null });
    activityStore.setState({ activity: trunkFailedOn(POST_REQUEST) });
    mountChannel(null, memberPost(VIEWER_USER_ID));

    expect(screen.getByTestId("bot-message-retry")).toBeTruthy();
    expect(screen.queryByTestId("bot-message-edit")).toBeNull();
  });
});

describe("<BotChannelView tiles={null} /> Edit on a post the bot failed to answer", () => {
  it("loads its text into the channel's box, and the send replaces the failed post", async () => {
    const user = userEvent.setup();
    activityStore.setState({ activity: trunkFailedOn(POST_REQUEST) });
    mountChannel(null, memberPost(VIEWER_USER_ID));
    const box = channelBox();
    expect(screen.queryByTestId("bot-channel-composer-editing")).toBeNull();

    await user.click(
      within(screen.getByTestId("bot-member-row")).getByTestId(
        "bot-message-edit",
      ),
    );

    expect(box.value).toBe(POST_TEXT);
    expect(
      screen.getByTestId("bot-channel-composer-editing").textContent,
    ).toContain("Sending replaces your message that failed.");

    await user.type(box, " Check nightly too.");
    await user.click(screen.getByTestId("bot-channel-composer-send"));

    expect(sent).toEqual([
      {
        botId: BOT_ID,
        conversationId: CHANNEL_ID,
        text: `${POST_TEXT} Check nightly too.`,
        threadId: null,
        announcementId: null,
        redeliver: null,
        supersedes: POST_REQUEST,
        answer: null,
      },
    ]);
    await waitFor(() => {
      expect(screen.queryByTestId("bot-channel-composer-editing")).toBeNull();
    });
    expect(box.value).toBe("");
  });

  it("keeps an edit of a message in the open thread, its text and the message it replaces, while the channel's session goes and comes back", async () => {
    const user = userEvent.setup();
    const THREAD_REQUEST = "req-in-thread";
    const THREAD_TEXT = "And the release branch?";
    mocks.threads = [postThread(VIEWER_USER_ID)];
    mocks.threadHandle = {
      store: createChannelStore([
        {
          role: "user",
          messageId: "thread-message-1",
          sender: { type: "user", userId: VIEWER_USER_ID },
          sessionAnchor: null,
          message: {
            kind: "user",
            content: textDoc(THREAD_TEXT),
            browserAnnotations: [],
          },
          timestamp: 3_000,
          conversationRequest: {
            requestId: THREAD_REQUEST,
            resolvedAt: null,
            resolvedByMessageId: null,
          },
        },
      ]),
    } as ChatSessionStoreHandle;
    activityStore.setState({
      activity: {
        trunk: null,
        threads: { [THREAD_ID]: failedOn(THREAD_REQUEST) },
      },
    });
    const rerender = mountChannelWith(
      {
        anchorMessageId: POST_ID,
        announcement: false,
        anchorKind: null,
        sent: null,
      },
      [memberPost(VIEWER_USER_ID)],
    );
    const panel = screen.getByTestId("bot-thread-panel");
    const messages = within(panel).getByTestId("chat-messages-stub");
    // The reply's row, not the post the list opens on.
    const anchor = within(panel).getByTestId("bot-thread-anchor");
    const [replyRow] = within(messages)
      .getAllByTestId("bot-member-row")
      .filter((row) => !anchor.contains(row));
    await user.click(within(replyRow).getByTestId("bot-message-edit"));
    const box = within(panel).getByTestId("bot-thread-composer-input");
    if (!(box instanceof HTMLTextAreaElement))
      throw new Error("not a textarea");
    await user.type(box, " Since Monday.");

    const channel = mocks.channelHandle;
    mocks.channelHandle = null;
    rerender();
    mocks.channelHandle = channel;
    rerender();

    expect(box.isConnected).toBe(true);
    expect(box.value).toBe(`${THREAD_TEXT} Since Monday.`);
    expect(screen.getByTestId("bot-thread-composer-editing")).toBeTruthy();
    await user.click(screen.getByTestId("bot-thread-composer-send"));
    expect(sent.at(-1)).toMatchObject({
      threadId: THREAD_ID,
      text: `${THREAD_TEXT} Since Monday.`,
      supersedes: THREAD_REQUEST,
    });
  });

  it("opens the replacement's thread when the bot answers it in one", async () => {
    const user = userEvent.setup();
    answerThreadId = "thread-new";
    activityStore.setState({ activity: trunkFailedOn(POST_REQUEST) });
    mountChannel(null, memberPost(VIEWER_USER_ID));
    await user.click(
      within(screen.getByTestId("bot-member-row")).getByTestId(
        "bot-message-edit",
      ),
    );

    await user.click(screen.getByTestId("bot-channel-composer-send"));

    await waitFor(() => {
      expect(onOpenThread).toHaveBeenCalledTimes(1);
    });
    const open = onOpenThread.mock.calls[0][0];
    expect(open?.anchorMessageId).toBe("message-new");
    expect(open?.announcement).toBe(false);
    expect(open?.sent).toMatchObject({
      threadId: "thread-new",
      requestId: "req-new",
      text: POST_TEXT,
      senderUserId: VIEWER_USER_ID,
      delivery: "written",
    });
    expect(sent[0]?.supersedes).toBe(POST_REQUEST);
    expect(channelBox().value).toBe("");
  });

  it("keeps the draft of an edit opened while an earlier edit's send was in flight", async () => {
    const user = userEvent.setup();
    const hold = Promise.withResolvers<void>();
    heldSends = hold.promise;
    activityStore.setState({ activity: trunkFailedOn(POST_REQUEST) });
    mountChannelWith(null, [memberPost(VIEWER_USER_ID), secondPost()]);
    await user.click(screen.getByTestId("bot-message-edit"));
    await user.click(screen.getByTestId("bot-channel-composer-send"));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });

    act(() => {
      activityStore.setState({ activity: trunkFailedOn(SECOND_REQUEST) });
    });
    await user.click(screen.getByTestId("bot-message-edit"));
    const box = channelBox();
    expect(box.value).toBe(SECOND_TEXT);
    await act(async () => {
      hold.resolve();
      await hold.promise;
    });

    // The box is held while A's send is in flight, and released once it lands.
    await waitFor(() => {
      expect(box.disabled).toBe(false);
    });
    expect(box.value).toBe(SECOND_TEXT);
    expect(screen.getByTestId("bot-channel-composer-editing")).toBeTruthy();
    // A's delivery is not said under B's unsent draft.
    expect(screen.queryByTestId("bot-channel-composer-queued")).toBeNull();
  });

  it("leaves the box empty and sends nothing when the person cancels", async () => {
    const user = userEvent.setup();
    activityStore.setState({ activity: trunkFailedOn(POST_REQUEST) });
    mountChannel(null, memberPost(VIEWER_USER_ID));
    await user.click(
      within(screen.getByTestId("bot-member-row")).getByTestId(
        "bot-message-edit",
      ),
    );

    await user.click(screen.getByTestId("bot-channel-composer-edit-cancel"));

    expect(screen.queryByTestId("bot-channel-composer-editing")).toBeNull();
    expect(channelBox().value).toBe("");
    expect(sent).toEqual([]);
  });

  it("closes the open thread and edits there, in the channel's box, when the post is a thread's anchor", async () => {
    const user = userEvent.setup();
    mocks.threads = [postThread(VIEWER_USER_ID)];
    activityStore.setState({
      activity: {
        trunk: null,
        threads: { [THREAD_ID]: failedOn(POST_REQUEST) },
      },
    });
    mountChannel(
      {
        anchorMessageId: POST_ID,
        announcement: false,
        anchorKind: null,
        sent: null,
      },
      memberPost(VIEWER_USER_ID),
    );

    await user.click(
      within(screen.getByTestId("bot-thread-anchor")).getByTestId(
        "bot-message-unanswered-edit",
      ),
    );

    expect(onOpenThread).toHaveBeenCalledWith(null);
    expect(channelBox().value).toBe(POST_TEXT);
    expect(screen.getByTestId("bot-channel-composer-editing")).toBeTruthy();
  });
});

describe("<BotChannelView tiles={null} /> a post the bot has since moved on from", () => {
  it("loses Retry and Edit when the session's activity moves on", () => {
    activityStore.setState({ activity: trunkFailedOn(POST_REQUEST) });
    mountChannel(null, memberPost(VIEWER_USER_ID));
    expect(screen.getByTestId("bot-message-retry")).toBeTruthy();
    expect(screen.getByTestId("bot-message-edit")).toBeTruthy();

    act(() => {
      activityStore.setState({
        activity: {
          trunk: {
            state: "replying",
            startedAt: 3_000,
            step: null,
            requestId: POST_REQUEST,
            reason: null,
          },
          threads: {},
        },
      });
    });

    expect(screen.queryByTestId("bot-message-retry")).toBeNull();
    expect(screen.queryByTestId("bot-message-edit")).toBeNull();
    expect(screen.queryByTestId("bot-message-unanswered")).toBeNull();
    expect(screen.getByText(POST_TEXT)).toBeTruthy();
  });
});

describe("<BotChannelView tiles={null} /> the line under a post the bot did not answer", () => {
  const GROK_OUTDATED =
    "Your Grok CLI version (1.0.5) is outdated. Update to 1.0.13 or later.";

  /** The trunk failed or parked answering the post, saying why. */
  function trunkWithReason(
    state: "failed" | "parked",
    reason: NonNullable<BotSessionActivity["reason"]>,
  ): BotActivity {
    return {
      trunk: { ...sessionOn(state, POST_REQUEST), reason },
      threads: {},
    };
  }

  function lineOf(scope: HTMLElement): HTMLElement {
    return within(scope).getByTestId("bot-message-unanswered");
  }

  it("says it under the post in the host's words, with Retry and Edit, and nothing above the box", async () => {
    const user = userEvent.setup();
    activityStore.setState({
      activity: trunkWithReason("failed", {
        summary: GROK_OUTDATED,
        code: null,
        harnessId: "grok",
        action: "none",
      }),
    });
    mountChannel(null, memberPost(VIEWER_USER_ID));

    const row = screen.getByTestId("bot-member-row");
    const line = lineOf(row);
    expect(line.textContent).toBe(
      `Not answered: ${GROK_OUTDATED} · Retry · Edit`,
    );
    expect(line.getAttribute("data-state")).toBe("failed");
    expect(line.className).toContain("text-destructive");
    expect(screen.queryByTestId("bot-channel-unanswered")).toBeNull();
    expect(screen.queryByTestId("bot-thread-unanswered")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(within(line).queryByText("Under the hood")).toBeNull();

    await user.click(within(line).getByRole("button", { name: "Retry" }));
    expect(sent).toHaveLength(1);
    expect(sent[0].redeliver).toEqual({ requestId: POST_REQUEST });
    expect(sent[0].threadId).toBeNull();

    await user.click(within(line).getByRole("button", { name: "Edit" }));
    expect(channelBox().value).toBe(POST_TEXT);
    expect(screen.getByTestId("bot-channel-composer-editing")).toBeTruthy();
  });

  it("says a sandbox's refusal in the words the transcript's error row gives it, and keeps the host's summary for any other code", () => {
    const raw = "SANDBOX_FROZEN: sandbox host 'sbx-1': the sandbox is paused";
    const copy = sandboxRefusalCopyFor("SANDBOX_FROZEN", raw);
    if (copy === null) throw new Error("SANDBOX_FROZEN has a refusal row");
    activityStore.setState({
      activity: trunkWithReason("failed", {
        summary: raw,
        code: "SANDBOX_FROZEN",
        harnessId: "claude",
        action: "none",
      }),
    });
    mountChannel(null, memberPost(VIEWER_USER_ID));

    const line = lineOf(screen.getByTestId("bot-member-row"));
    expect(line.textContent).toBe(
      `Not answered: ${copy.description} · Retry · Edit`,
    );
    expect(line.textContent).not.toContain(raw);

    act(() => {
      activityStore.setState({
        activity: trunkWithReason("failed", {
          summary: GROK_OUTDATED,
          code: "PROVIDER_UNAUTHENTICATED",
          harnessId: "claude",
          action: "none",
        }),
      });
    });
    expect(lineOf(screen.getByTestId("bot-member-row")).textContent).toBe(
      `Not answered: ${GROK_OUTDATED} · Retry · Edit`,
    );
  });

  it("adds Sign in for a sign-out, which opens Settings ▸ Providers at that provider on the host that runs the bot, not the one serving the tab", async () => {
    const user = userEvent.setup();
    activityStore.setState({
      activity: trunkWithReason("failed", {
        summary: "Claude is signed out.",
        code: null,
        harnessId: "claude",
        action: "sign-in",
      }),
    });
    mountChannel(null, memberPost(VIEWER_USER_ID));

    const line = lineOf(screen.getByTestId("bot-member-row"));
    expect(line.textContent).toBe(
      "Not answered: Claude is signed out. · Retry · Edit · Sign in",
    );
    await user.click(within(line).getByRole("button", { name: "Sign in" }));

    const focus = useProvidersFocusStore.getState();
    expect(focus.focusHarnessId).toBe("claude");
    expect(focus.focusHostId).toBe(BOUND_HOST_ID);
    expect(focus.focusTargetHostId).toBe(BOUND_HOST_ID);
    expect(mocks.openSettings).toHaveBeenCalledTimes(1);
    expect(mocks.openSettings.mock.calls[0][0].section).toBe("providers");
    expect(mocks.openSettings.mock.calls[0][0].hostId).toBe(BOUND_HOST_ID);
    expect(sent).toEqual([]);
  });

  it("adds Update for an out-of-date command-line tool, which updates the provider on the host that runs the bot", async () => {
    const user = userEvent.setup();
    recordNegotiatedHostManifest(BOUND_HOST_ID, {
      "providers.ensurePack": { major: 1, minor: 0 },
    });
    activityStore.setState({
      activity: trunkWithReason("failed", {
        summary: "Grok's command-line tool is out of date.",
        code: "provider_outdated",
        harnessId: "grok",
        action: "update-provider",
      }),
    });
    mountChannel(null, memberPost(VIEWER_USER_ID));

    const line = lineOf(screen.getByTestId("bot-member-row"));
    expect(line.textContent).toBe(
      "Not answered: Grok's command-line tool is out of date. · Retry · Edit · Update",
    );
    await user.click(within(line).getByRole("button", { name: "Update" }));

    await waitFor(() => expect(ensured).toEqual(["grok"]));
    expect(sent).toEqual([]);
  });

  it("offers no Update where the bot's host cannot update the tool, and says who does", () => {
    const owner =
      "Grok's command-line tool is out of date. The host's owner can update it.";
    activityStore.setState({
      activity: trunkWithReason("failed", {
        summary: owner,
        code: "provider_outdated_host_owner",
        harnessId: "grok",
        action: "none",
      }),
    });
    mountChannel(null, memberPost(VIEWER_USER_ID));

    expect(lineOf(screen.getByTestId("bot-member-row")).textContent).toBe(
      `Not answered: ${owner} · Retry · Edit`,
    );
  });

  it("offers no Sign in while no host runs the bot, and still says why", () => {
    boundHostId = null;
    activityStore.setState({
      activity: trunkWithReason("failed", {
        summary: "Claude is signed out.",
        code: null,
        harnessId: "claude",
        action: "sign-in",
      }),
    });
    mountChannel(null, memberPost(VIEWER_USER_ID));

    expect(lineOf(screen.getByTestId("bot-member-row")).textContent).toBe(
      "Not answered: Claude is signed out. · Retry · Edit",
    );
  });

  it("opens Settings on the bot's host with no earlier focus left armed when the harness is not one this client knows", async () => {
    const user = userEvent.setup();
    useProvidersFocusStore.getState().setProfileFocus({
      harnessId: "codex",
      hostId: "host-other",
      profileId: "profile-other",
      startSignIn: true,
    });
    activityStore.setState({
      activity: trunkWithReason("failed", {
        summary: "Signed out.",
        code: null,
        harnessId: "not-a-harness",
        action: "sign-in",
      }),
    });
    mountChannel(null, memberPost(VIEWER_USER_ID));

    await user.click(
      within(lineOf(screen.getByTestId("bot-member-row"))).getByRole("button", {
        name: "Sign in",
      }),
    );

    expect(useProvidersFocusStore.getState()).toMatchObject({
      focusHarnessId: null,
      focusHostId: null,
      focusTargetHostId: null,
      focusProfileId: null,
      startSignIn: false,
    });
    expect(mocks.openSettings).toHaveBeenCalledTimes(1);
    expect(mocks.openSettings.mock.calls[0][0].hostId).toBe(BOUND_HOST_ID);
  });

  it("says a parked post in the warning colour with the parked summary, and offers Retry alone", () => {
    const summary =
      "Queue paused because a conversation message could not be delivered.";
    activityStore.setState({
      activity: trunkWithReason("parked", {
        summary,
        code: null,
        harnessId: "claude",
        action: "sign-in",
      }),
    });
    mountChannel(null, memberPost(VIEWER_USER_ID));

    const row = screen.getByTestId("bot-member-row");
    const line = lineOf(row);
    expect(line.getAttribute("data-state")).toBe("parked");
    expect(line.className).toContain("text-warning-foreground");
    expect(line.textContent).toBe(`Not answered: ${summary} · Retry`);
    // The viewer's own post, yet no Edit on hover either: a held answer
    // offers Retry alone.
    expect(within(row).getByTestId("bot-message-retry")).toBeTruthy();
    expect(within(row).queryByTestId("bot-message-edit")).toBeNull();
  });

  it("says it under the post a thread opens on, inside the thread, and not above the thread's box", () => {
    mocks.threads = [postThread(VIEWER_USER_ID)];
    activityStore.setState({
      activity: {
        trunk: null,
        threads: {
          [THREAD_ID]: {
            ...sessionOn("failed", POST_REQUEST),
            reason: {
              summary: GROK_OUTDATED,
              code: null,
              harnessId: "grok",
              action: "none",
            },
          },
        },
      },
    });
    mountChannel(
      {
        anchorMessageId: POST_ID,
        announcement: false,
        anchorKind: null,
        sent: null,
      },
      memberPost(VIEWER_USER_ID),
    );

    const anchor = screen.getByTestId("bot-thread-anchor");
    expect(lineOf(anchor).textContent).toBe(
      `Not answered: ${GROK_OUTDATED} · Retry · Edit`,
    );
    expect(screen.queryByTestId("bot-thread-unanswered")).toBeNull();
    expect(screen.queryByTestId("bot-channel-unanswered")).toBeNull();
  });
});
