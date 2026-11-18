/**
 * A channel the host has not created yet: a host that makes
 * the channel chat only on its first post closes the channel's subscribe
 * with `CHAT_NOT_VISIBLE`. The REAL `BotChatTranscript` draws that as the
 * empty channel with its intro, and re-subscribes once a send to the channel
 * succeeds - read from the real mutation cache, where the composer's
 * `bot.conversation.send` lands. Only the session store and the virtualised
 * list are stand-ins.
 */
import type { ReactNode } from "react";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import {
  defaultScheduler,
  notifyManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type {
  ChatSessionState,
  ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { emptyTranscriptWindow } from "@/stores/chats/transcript-window";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { BotConversationSendRequest } from "@traycer/protocol/host/bot/conversation-schemas";
import {
  useBotCallSendMutation,
  useBotConversationSendMutation,
} from "@/hooks/bots/use-bot-mutations";
import { currentBotLifetime } from "@/lib/bots/bot-lifetime";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";

type TranscriptState = Pick<
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
  | "fatalClose"
  | "retry"
>;

const mocks = vi.hoisted(() => ({
  handle: null as ChatSessionStoreHandle | null,
  /** The app's binding, which a call's send resolves its named host through. */
  binding: null as { readonly hostClient: HostClient<HostRpcRegistry> } | null,
}));
vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
  useHostBinding: () => mocks.binding,
}));
vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: (client: { getActiveHostId(): string } | null) => {
    const hostId = client === null ? null : client.getActiveHostId();
    return {
      hostId,
      requestContextUserId: SENDER,
      isReady: hostId !== null,
      hasRpcEndpoint: hostId !== null,
      canExecute: hostId !== null,
    };
  },
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useChatSessionHandleForContainer: () => mocks.handle,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessCatalogForClient: () => ({ harnesses: [] }),
}));
// No turn receipts here: the transcript asks for none from a host this
// suite does not stand up.
vi.mock("@/hooks/bots/use-bot-turn-locate-query", () => ({
  useBotTurnLocateQuery: () => ({ data: undefined }),
}));
vi.mock("@/hooks/chats/use-chat-locate-row", () => ({
  useChatLocateRowAnswer: () => ({ status: "waiting" }),
}));
// The stub draws what the real list draws above its first row.
vi.mock("@/components/chat/chat-messages", async () => {
  const { use } = await import("react");
  const { ChatTimelineHeaderContext } =
    await import("@/components/chat/chat-timeline-header-context");
  return {
    ChatMessages: (props: { messages: ReadonlyArray<unknown> }) => (
      <div data-testid="chat-messages-stub" data-rows={props.messages.length}>
        {use(ChatTimelineHeaderContext)}
      </div>
    ),
  };
});

import {
  BotChatTranscript,
  type BotTranscriptSurface,
} from "@/components/bots/bot-chat-transcript";
import { UNRESOLVED_BOT_MEMBERS } from "@/lib/bots/bot-member-names";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CHAT_ID = "conversation-app";
/** The signed-in account the host client's request context names. */
const SENDER = "user-alice";

const NOT_ON_HOST: FatalErrorDetails = {
  code: "CHAT_NOT_VISIBLE",
  reason: "The chat is not on this host.",
  incompatibleMethods: null,
  upgradeGuidance: null,
  retryable: false,
};

const CHANNEL_SURFACE: BotTranscriptSurface = {
  kind: "channel",
  threadLine: () => null,
  openThread: null,
  openAnnouncementThread: null,
  threadAnchorKinds: [],
  chooseOption: null,
  reply: null,
  answerQuestion: null,
  answerQuestions: null,
  questionBox: null,
  failedRequest: () => null,
  openTurn: null,
  sessionChatId: null,
  intro: { botTitle: "Release Bot", directive: null },
  history: null,
};

let retry: Mock<() => void>;
let store: UseBoundStore<StoreApi<TranscriptState>>;
let queryClient: QueryClient;

/**
 * The transcript over a fresh session handle. `unmount` takes the view away
 * as switching the tab's panel does, and `remount` brings it back over the
 * same handle, which the session registry retains in between.
 */
function mountTranscript(surface: BotTranscriptSurface): {
  readonly unmount: () => void;
  readonly remount: () => void;
} {
  store = create<TranscriptState>()(() => ({
    snapshotLoaded: false,
    messages: [],
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
    fatalClose: NOT_ON_HOST,
    retry,
  }));
  mocks.handle = { store } as ChatSessionStoreHandle;
  const tree: ReactNode = (
    <QueryClientProvider client={queryClient}>
      <BotChatTranscript
        botId={BOT_ID}
        chatId={CHAT_ID}
        hostId="host-1"
        title="Tracy"
        instanceId="bot-channel:test"
        surface={surface}
        resolveMember={UNRESOLVED_BOT_MEMBERS}
        showConnecting
        header={null}
        landOn={null}
        flow={null}
        sendBinding={null}
      />
    </QueryClientProvider>
  );
  let view = render(tree);
  return {
    unmount: () => view.unmount(),
    remount: () => {
      view = render(tree);
    },
  };
}

/** A host client signed in as `SENDER` whose host answers every `bot.conversation.send`. */
function answeringHost(): HostClient<HostRpcRegistry> {
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "request-1",
    handlers: {
      "bot.conversation.send": () => ({
        messageId: "m-1",
        requestId: "r-1",
        delivery: "written",
        threadId: null,
      }),
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
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-1",
      identity: { userId: SENDER, username: "alice", providerHandle: null },
    }),
  );
  return spine;
}

/** The request a send to `conversationId` carries. */
function sendTo(conversationId: string): BotConversationSendRequest {
  return {
    botId: BOT_ID,
    conversationId,
    text: "hi",
    threadId: null,
    announcementId: null,
    redeliver: null,
    supersedes: null,
    answer: null,
  };
}

function queryWrapper(props: { readonly children: ReactNode }): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

/** The cache entry a send added, which dropping it evicts as garbage collection does once unobserved. */
function evictionOf(before: number): { readonly evict: () => void } {
  const cache = queryClient.getMutationCache();
  const mutation = cache.getAll().at(before);
  if (mutation === undefined) throw new Error("the send left no cache entry");
  return { evict: () => cache.remove(mutation) };
}

/**
 * A `bot.conversation.send` to `conversationId` that succeeds, through the
 * real mutation the composer's box sends with and its variables
 * (`{ request, sentAs }`), over a host that answers it.
 */
async function sendSucceeded(
  conversationId: string,
): Promise<{ readonly evict: () => void }> {
  const client = answeringHost().createRequester(mockRemoteHostEntry);
  const before = queryClient.getMutationCache().getAll().length;
  const { result } = renderHook(() => useBotConversationSendMutation(client), {
    wrapper: queryWrapper,
  });
  await act(async () => {
    await result.current.mutateAsync({
      request: sendTo(conversationId),
      sentAs: {
        lifetime: currentBotLifetime(),
        account: client.getRequestContextUserId(),
      },
    });
  });
  return evictionOf(before);
}

/** A call's words to `conversationId` that succeed, through the real call mutation and its variables. */
async function callSendSucceeded(conversationId: string): Promise<void> {
  mocks.binding = { hostClient: answeringHost() };
  const { result } = renderHook(() => useBotCallSendMutation(), {
    wrapper: queryWrapper,
  });
  await act(async () => {
    await result.current.mutateAsync({
      hostId: mockRemoteHostEntry.hostId,
      account: SENDER,
      authority: null,
      request: sendTo(conversationId),
    });
  });
}

beforeEach(() => {
  // The mutation cache tells its observers on a timer by default; synchronous
  // here, so a send has reached the transcript when its `act` returns.
  notifyManager.setScheduler((notify) => notify());
  retry = vi.fn<() => void>();
  queryClient = new QueryClient();
});

afterEach(() => {
  cleanup();
  mocks.binding = null;
  queryClient.clear();
  notifyManager.setScheduler(defaultScheduler);
  mocks.handle = null;
});

describe("<BotChatTranscript /> on a channel the host has not created yet", () => {
  it("shows the empty channel with its intro, not the stream's failure", () => {
    mountTranscript(CHANNEL_SURFACE);

    expect(screen.getByTestId("bot-channel-intro").textContent).toContain(
      "This is the beginning of your channel with Release Bot.",
    );
    expect(screen.queryByTestId("chat-messages-stub")).toBeNull();
    expect(retry).not.toHaveBeenCalled();
  });

  it("re-subscribes once a send to the channel succeeds, and shows the channel when the subscribe lands", async () => {
    mountTranscript(CHANNEL_SURFACE);

    await sendSucceeded("another-conversation");
    expect(retry).not.toHaveBeenCalled();

    await sendSucceeded(CHAT_ID);
    expect(retry).toHaveBeenCalledTimes(1);

    act(() => {
      store.setState({ fatalClose: null, snapshotLoaded: true });
    });
    expect(screen.queryByRole("status")).toBeNull();
    // The landed snapshot has no rows yet, so the recovered transcript opens
    // with the same intro, now inside the transcript itself.
    expect(screen.queryByTestId("bot-channel-not-here-yet")).toBeNull();
    expect(
      within(screen.getByTestId("bot-chat-transcript")).getByTestId(
        "bot-channel-intro",
      ),
    ).toBeTruthy();
  });

  // A call's sends were not counted before (main's ledger read a top-level
  // `conversationId` its variables never had): a call's first words into a
  // channel the host has not created yet now re-subscribe it too.
  it("re-subscribes once a call's send to the channel succeeds", async () => {
    mountTranscript(CHANNEL_SURFACE);

    await callSendSucceeded("another-conversation");
    expect(retry).not.toHaveBeenCalled();

    await callSendSucceeded(CHAT_ID);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("re-subscribes again on a later send when the first re-subscribe still found no chat", async () => {
    mountTranscript(CHANNEL_SURFACE);
    await sendSucceeded(CHAT_ID);
    expect(retry).toHaveBeenCalledTimes(1);

    // The retry clears the close, and the host closes the new stream again.
    act(() => {
      store.setState({ fatalClose: null });
    });
    act(() => {
      store.setState({ fatalClose: NOT_ON_HOST });
    });
    expect(retry).toHaveBeenCalledTimes(1);

    await sendSucceeded(CHAT_ID);
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it("re-subscribes for a send that landed while the subscription was still connecting, once the close arrives", async () => {
    mountTranscript(CHANNEL_SURFACE);
    // Connecting: no close yet, and no snapshot.
    act(() => {
      store.setState({ fatalClose: null });
    });
    await sendSucceeded(CHAT_ID);
    expect(retry).not.toHaveBeenCalled();

    act(() => {
      store.setState({ fatalClose: NOT_ON_HOST });
    });
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("owes nothing for a send the live channel already showed", async () => {
    mountTranscript(CHANNEL_SURFACE);
    act(() => {
      store.setState({ fatalClose: null, snapshotLoaded: true });
    });
    await sendSucceeded(CHAT_ID);

    act(() => {
      store.setState({ fatalClose: NOT_ON_HOST, snapshotLoaded: false });
    });
    expect(retry).not.toHaveBeenCalled();
  });

  it("does not take a send the cache drops for a new one", async () => {
    mountTranscript(CHANNEL_SURFACE);
    const first = await sendSucceeded(CHAT_ID);
    const second = await sendSucceeded(CHAT_ID);
    expect(retry).toHaveBeenCalledTimes(2);

    act(() => second.evict());
    act(() => first.evict());
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it("re-subscribes once on coming back to the closed channel for a send that succeeded while it was away", async () => {
    const view = mountTranscript(CHANNEL_SURFACE);
    act(() => view.unmount());

    await sendSucceeded(CHAT_ID);
    expect(retry).not.toHaveBeenCalled();

    act(() => view.remount());
    expect(retry).toHaveBeenCalledTimes(1);
    act(() => view.unmount());
    act(() => view.remount());
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("still re-subscribes on return when the cache dropped the send that succeeded while the channel was away", async () => {
    const view = mountTranscript(CHANNEL_SURFACE);
    act(() => view.unmount());

    const sent = await sendSucceeded(CHAT_ID);
    act(() => sent.evict());

    act(() => view.remount());
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("leaves a thread's close to the thread's own view", () => {
    mountTranscript({
      kind: "thread",
      chooseOption: null,
      reply: null,
      answerQuestion: null,
      answerQuestions: null,
      questionBox: "post-1",
      failedRequest: () => null,
      openTurn: null,
      sessionChatId: null,
      opening: {
        messageId: "post-1",
        conversationId: "channel-1",
        show: vi.fn(),
      },
    });

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByTestId("chat-messages-stub")).toBeTruthy();
  });
});

describe("<BotChatTranscript /> on a team main bot's channel with its setup history", () => {
  const HISTORY_SURFACE: BotTranscriptSurface = {
    ...CHANNEL_SURFACE,
    history: <div data-testid="setup-history-probe" />,
  };
  const POST: Message = {
    role: "user",
    messageId: "post-1",
    sender: { type: "user", userId: "owner-1" },
    message: {
      kind: "user",
      content: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "hello" }] },
        ],
      },
      browserAnnotations: [],
    },
    timestamp: 1_000,
    sessionAnchor: null,
  };

  it("shows the history in place of the intro before the host has created the channel", () => {
    mountTranscript(HISTORY_SURFACE);

    expect(
      within(screen.getByTestId("bot-channel-not-here-yet")).getByTestId(
        "setup-history-probe",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("bot-channel-intro")).toBeNull();
  });

  it("shows the history in place of the intro on an empty channel", () => {
    mountTranscript(HISTORY_SURFACE);
    act(() => {
      store.setState({ fatalClose: null, snapshotLoaded: true });
    });

    expect(screen.getByTestId("setup-history-probe")).toBeTruthy();
    expect(screen.queryByTestId("bot-channel-intro")).toBeNull();
    expect(screen.queryByTestId("chat-messages-stub")).toBeNull();
  });

  it("hands the history to the list once the channel has posts", () => {
    mountTranscript(HISTORY_SURFACE);
    act(() => {
      store.setState({
        fatalClose: null,
        snapshotLoaded: true,
        messages: [POST],
      });
    });

    expect(
      within(screen.getByTestId("chat-messages-stub")).getByTestId(
        "setup-history-probe",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("bot-channel-intro")).toBeNull();
  });
});
