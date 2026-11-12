/**
 * A bot's question asked without waiting (Tracy Bots T91, decisions 121 and
 * 122), through the REAL `BotChannelView`: its transcript rows, the question
 * card, the thread panel, the message boxes and the `bot.conversation.send`
 * mutation run over a host client whose messenger records the request that
 * leaves. Only the virtualised list is replaced, as in the failed-answer
 * suite. What is asserted is what the person sees on the card and what the
 * host RECEIVES: an answer or a Skip goes out as the person's message with
 * the question it settles; the settlement the host writes on the row closes
 * the question for everyone, and until it lands the card holds what was sent;
 * a host too old to take an answer gets a card without actions;
 * a member whose answer is overtaken sees the question settled, and the
 * answer moves into the box of where it was asked, unsent (T186). What a
 * member has not sent outlives the views that draw it: the channel
 * unmounting, as a switch to another tab does, and the thread closing.
 */
import {
  botMentionHostClientMock,
  emptyBotMentionHostListsMock,
} from "@/components/bots/__tests__/bot-mention-host-test-support";
import { StrictMode, type ReactNode } from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BotTestRunnerHost } from "@/components/bots/__tests__/bot-test-runner-host";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  HostClient,
  type HostRequester,
} from "@traycer-clients/shared/host-client/host-client";
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  HostRpcError,
  type IHostMessenger,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { createAuthAwareMessenger } from "@traycer-clients/shared/host-transport/auth-aware-messenger";
import {
  createRetryingMessenger,
  type TransportRetryPolicy,
} from "@traycer-clients/shared/host-transport/retrying-messenger";
import { markMayHaveReachedHost } from "@traycer/protocol/host-transport/remote/rpc-types";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { botQuestionsText } from "@traycer/protocol/persistence/epic/messages";
import type {
  BotConversationSendDelivery,
  BotConversationSendRequest,
  BotConversationSendResponse,
  BotThreadSummary,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type {
  BotQuestionItem,
  BotQuestionSettlement,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import {
  negotiateBotSend,
  resetBotFailedRequestSupport,
  signInViewer,
  VIEWER_USER_ID,
} from "@/components/bots/__tests__/bot-failed-request-test-support";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { installLegendListTestClock } from "@/components/chat/__tests__/legend-list-test-environment";
import { TooltipProvider } from "@/components/ui/tooltip";
import type {
  BotActivity,
  BotSessionActivity,
} from "@/hooks/bots/use-bot-activity";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import type {
  ChatSessionState,
  ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { emptyTranscriptWindow } from "@/stores/chats/transcript-window";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";

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
  | "holdTranscriptOrdinal"
>;

const mocks = vi.hoisted(() => ({
  handles: new Map<string, ChatSessionStoreHandle>(),
  client: null as HostRequester<HostRpcRegistry> | null,
  threads: [] as BotThreadSummary[],
}));

vi.mock(
  "@/hooks/host/use-host-client-for-host-id",
  () => botMentionHostClientMock,
);
vi.mock(
  "@/hooks/bots/use-environment-host-lists-query",
  () => emptyBotMentionHostListsMock,
);

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useChatSessionHandleForContainer: (
    _botId: string,
    chatId: string,
  ): ChatSessionStoreHandle | null => mocks.handles.get(chatId) ?? null,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.client,
}));
vi.mock("@/hooks/host/use-host-supports-method", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-supports-method")
  >()),
  useHostMethodSupport: () => true,
}));
vi.mock("@/components/epic-tabs/pane-visibility-context", () => ({
  usePaneVisible: () => true,
  usePaneFocused: () => true,
  usePaneFocusProbe: () => () => true,
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
import { BotDraftsPersistLifecycleBridge } from "@/providers/bot-drafts-persist-lifecycle-bridge";
import { botBoxDraftsKey } from "@/lib/persist/keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  answerDraftKey,
  useBotDraftsStore,
} from "@/stores/bots/bot-drafts-store";
import type { BotOpenThread } from "@/stores/bots/bot-open-thread-store";
import type { BotMemberResolver } from "@/lib/bots/bot-member-names";
import {
  boxInput,
  boxWithin,
  textOf,
  typeInto,
} from "@/components/bots/__tests__/bot-box-test-support";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HOST_ID = "host-tab";
const CHANNEL_ID = "conversation-channel";
const QUESTION_ID = "bot-question:req-q";
const QUESTION_REQUEST = "req-q";
const DEPLOY = "Deploy to staging now or after the train?";
const HOLD = "Anything to hold back from the train?";
const TEAMMATE_USER_ID = "user-teammate";

const resolveMember: BotMemberResolver = (userId) =>
  userId === TEAMMATE_USER_ID
    ? { displayName: "Tess Teammate", avatarUrl: null }
    : null;

function deploy(settlement: BotQuestionSettlement | null): BotQuestionItem {
  return {
    text: DEPLOY,
    options: ["Now", "After the train"],
    allowFreeText: false,
    settlement,
  };
}

function hold(settlement: BotQuestionSettlement | null): BotQuestionItem {
  return { text: HOLD, options: [], allowFreeText: true, settlement };
}

const WATCH = "What should I watch for you?";

/** Options and the person's own words: the card takes several of the options. */
function watch(settlement: BotQuestionSettlement | null): BotQuestionItem {
  return {
    text: WATCH,
    options: ["Agents waiting on me", "Sandboxes and credits", "Nothing yet"],
    allowFreeText: true,
    multiSelect: true,
    settlement,
  };
}

function byPerson(
  userId: string,
  answer: string | null,
): BotQuestionSettlement {
  return {
    answer,
    skipped: answer === null,
    by: { kind: "person", userId },
    at: 3_000,
  };
}

/** The image list every row here shares, as every record without images does. */
const NO_IMAGES: Extract<Message, { role: "assistant" }>["imageResolutions"] =
  [];

/**
 * Each row's blocks, one array per row: the host writes a settlement on the
 * row's question and leaves its blocks as they were.
 */
const rowBlocks = new Map<
  string,
  Extract<Message, { role: "assistant" }>["blocks"]
>();

function blocksOf(
  messageId: string,
  text: string,
): Extract<Message, { role: "assistant" }>["blocks"] {
  const known = rowBlocks.get(messageId);
  if (known !== undefined) return known;
  const blocks: Extract<Message, { role: "assistant" }>["blocks"] = [
    {
      type: "text",
      blockId: `${messageId}:text`,
      status: "completed",
      timestamp: 2_000,
      text,
      providerNotice: null,
    },
  ];
  rowBlocks.set(messageId, blocks);
  return blocks;
}

/**
 * The bot's row in `messageId` that asks `questions`, its text the framing
 * an older client draws, its first question's options the buttons an older
 * client offers; `questions: null` is the row an older host writes. A row
 * that follows a member's post names it in `repliesTo`.
 */
function botRow(
  messageId: string,
  text: string,
  questions: ReadonlyArray<BotQuestionItem> | null,
  repliesTo: string | null,
): Message {
  const base: Extract<Message, { role: "assistant" }> = {
    role: "assistant",
    messageId,
    sender: {
      type: "agent",
      harnessId: "claude",
      agentId: "trunk-1",
      displayName: "Release Bot",
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks: blocksOf(messageId, text),
    startedAt: 2_000,
    timestamp: 2_000,
    turnId: null,
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: NO_IMAGES,
    options: ["Now", "After the train"],
    ...(repliesTo === null ? {} : { repliesTo }),
  };
  return questions === null
    ? base
    : {
        ...base,
        question: { requestId: QUESTION_REQUEST, questions: [...questions] },
      };
}

function questionRow(questions: ReadonlyArray<BotQuestionItem>): Message {
  return botRow(QUESTION_ID, DEPLOY, questions, null);
}

function textDoc(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function createStore(
  messages: ReadonlyArray<Message>,
): UseBoundStore<StoreApi<TranscriptState>> {
  return create<TranscriptState>()(() => ({
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
/** While set, the host refuses every send, as it refuses an answer to a settled question. */
let refuseSends: boolean;
/** How the host takes each send: `queued` while the bot's host is away. */
let delivery: BotConversationSendDelivery;
/** A send the host holds until the case lands or refuses it. */
interface HeldSend {
  readonly land: () => void;
  readonly refuse: () => void;
  /** The host's answer, once landed or refused. */
  readonly answered: Promise<BotConversationSendResponse>;
}
/** While set, each send waits here until the case lands or refuses it. */
let heldSends: HeldSend[] | null;
const onOpenThread = vi.fn<(open: BotOpenThread | null) => void>();

/**
 * How the host words a refusal of an answer to a settled question: as an
 * older host does, `RPC_ERROR` with the reason in its message, or with the
 * code a newer host adds.
 */
let refusalKind: "plain" | "coded";

function settledRefusal(): Error {
  if (refusalKind === "plain") {
    return new Error("QUESTION_ALREADY_SETTLED: the question is settled");
  }
  return new HostRpcError({
    code: "E_BOT_QUESTION_ALREADY_SETTLED",
    message: "This question was already answered.",
    requestId: "request-refused",
    method: "bot.conversation.send",
    fatalDetails: null,
  });
}

/** While set, the host client's messenger is the retrying and auth-aware layers over the mock, whose first send dies in a session fatal. */
let fatalFirstSend: boolean;
/** While set, the channel is mounted under the bridge that scopes the drafts to the signed-in account. */
let identityBridge: boolean;
/** The sends that reached the transport double under those layers, the fatal one included. */
let sendAttempts: number;

/**
 * What `RemoteSession` rejects a request already sent with when the session
 * goes fatal: an UNAUTHORIZED, marked because the host may have run it.
 */
function sessionFatalError(): HostRpcError {
  const error = new HostRpcError({
    code: "UNAUTHORIZED",
    message: "credential revoked",
    requestId: "session-fatal",
    method: "",
    fatalDetails: {
      code: "UNAUTHORIZED",
      reason: "credential revoked",
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  });
  markMayHaveReachedHost(error);
  return error;
}

const NO_DELAY_RETRY_POLICY: TransportRetryPolicy = {
  maxRetries: 2,
  initialDelayMs: 0,
  maxDelayMs: 0,
  sleep: () => Promise.resolve(),
  random: () => 0,
};

/**
 * The transport as the layers above it see it: its first `bot.conversation.send`
 * rejects with the session fatal, every other call goes to `inner`. It sits
 * below anything that restamps errors, which would drop the mark the auth
 * layer reads.
 */
function sessionFatalOnFirstSend(
  inner: IHostMessenger<HostRpcRegistry>,
): IHostMessenger<HostRpcRegistry> {
  return {
    request(method, params, options) {
      if (method === "bot.conversation.send") {
        sendAttempts += 1;
        if (sendAttempts === 1) return Promise.reject(sessionFatalError());
      }
      return inner.request(method, params, options);
    },
    requestWithResponseTimeout(method, params, responseTimeoutMs, options) {
      return inner.requestWithResponseTimeout(
        method,
        params,
        responseTimeoutMs,
        options,
      );
    },
  };
}

function hostClientRecordingSends(): HostRequester<HostRpcRegistry> {
  const queryClient = new QueryClient();
  let seq = 0;
  const mock = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => `request-${String(++seq)}`,
    handlers: {
      "bot.conversation.send": (params) => {
        sent = [...sent, params];
        if (refuseSends) {
          return Promise.reject(settledRefusal());
        }
        const response: BotConversationSendResponse = {
          messageId: "message-new",
          requestId: "req-new",
          delivery,
          threadId: null,
        };
        if (heldSends === null) return Promise.resolve(response);
        const { promise, resolve, reject } =
          Promise.withResolvers<BotConversationSendResponse>();
        heldSends.push({
          land: () => resolve(response),
          refuse: () => reject(settledRefusal()),
          answered: promise,
        });
        return promise;
      },
    },
  });
  const context = createRequestContextFixture({
    origin: "renderer",
    bearerToken: "tok-1",
  });
  // The recovery the auth layer waits on rotates this context's lease in
  // place, as the request context provider does, so the call is sent again.
  const messenger = fatalFirstSend
    ? createRetryingMessenger(
        createAuthAwareMessenger(
          sessionFatalOnFirstSend(mock),
          {
            revalidateExpectedBearer: () => {
              context.credentials.rotateBearerToken({
                userId: context.identity.userId,
                bearerToken: "tok-2",
              });
              return Promise.resolve("rotated");
            },
          },
          "always",
        ),
        NO_DELAY_RETRY_POLICY,
      )
    : mock;
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockRemoteHostEntry.hostId ? mockRemoteHostEntry : null,
    messenger,
  });
  spine.setRequestContext(context);
  return spine.createRequester(mockRemoteHostEntry);
}

/** The host takes the oldest send held. */
async function land(): Promise<void> {
  const next = heldSends?.shift();
  if (next === undefined) throw new Error("no send is held");
  await act(async () => {
    next.land();
    await next.answered;
  });
}

/** The host refuses the oldest send held. */
async function refuse(): Promise<void> {
  const next = heldSends?.shift();
  if (next === undefined) throw new Error("no send is held");
  await act(async () => {
    next.refuse();
    await next.answered.catch(() => undefined);
  });
}

/** A chat's transcript as its session holds it; `set` writes rows as the host does. */
function session(
  chatId: string,
  messages: ReadonlyArray<Message>,
): (next: ReadonlyArray<Message>) => void {
  const store = createStore(messages);
  mocks.handles.set(chatId, { store } as ChatSessionStoreHandle);
  return (next) => act(() => store.setState({ messages: next }));
}

function mountChannel(openThread: BotOpenThread | null): {
  readonly reopen: (next: BotOpenThread | null) => void;
  readonly unmount: () => void;
} {
  const queryClient = new QueryClient();
  const tree = (open: BotOpenThread | null): ReactNode => {
    const view = (
      <QueryClientProvider client={queryClient}>
        <BotTestRunnerHost>
          <TooltipProvider>
            <ChatExpansionTestProviders tileInstanceId="tile-1">
              <BotChannelView
                tiles={null}
                botId={BOT_ID}
                hostId={HOST_ID}
                boundHostId={HOST_ID}
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
                environmentBots={null}
                openExchange={null}
                exchangeRail={{ open: () => undefined, close: () => undefined }}
                resolveMember={resolveMember}
                tasks={[]}
                surfaceActions={null}
                openThread={open}
                onOpenThread={onOpenThread}
                setupHistory={null}
              />
            </ChatExpansionTestProviders>
          </TooltipProvider>
        </BotTestRunnerHost>
      </QueryClientProvider>
    );
    return (
      <StrictMode>
        {identityBridge ? (
          <QueryClientProvider client={queryClient}>
            <BotDraftsPersistLifecycleBridge>
              {view}
            </BotDraftsPersistLifecycleBridge>
          </QueryClientProvider>
        ) : (
          view
        )}
      </StrictMode>
    );
  };
  const result = render(tree(openThread));
  return {
    reopen: (next) => result.rerender(tree(next)),
    unmount: () => result.unmount(),
  };
}

/** The card in the channel, apart from the copy the open thread's post draws. */
function channelCard(): HTMLElement {
  return within(screen.getByTestId("bot-channel")).getByTestId("question-card");
}

function cardQuestion(card: HTMLElement, text: string): HTMLElement {
  return within(card).getByRole("region", { name: text });
}

// sonner, vaul and react-zoom-pan-pinch insert their stylesheets on import, and
// no element this file draws matches a rule in them. jsdom still runs every
// rule against an element and each of its ancestors whenever a DOM change
// drops its style cache, which every role query and click here pays: with the
// sheets in place, the file's tests take twice as long.
beforeAll(() => {
  for (const style of document.head.querySelectorAll("style")) style.remove();
});

beforeEach(() => {
  installLegendListTestClock();
  sent = [];
  refuseSends = false;
  refusalKind = "plain";
  fatalFirstSend = false;
  identityBridge = false;
  sendAttempts = 0;
  delivery = "written";
  heldSends = null;
  activityStore.setState({ activity: null });
  onOpenThread.mockClear();
  mocks.threads = [];
  mocks.handles.clear();
  rowBlocks.clear();
  useBotDraftsStore.setState({
    answers: {},
    threadBoxes: {},
    unsentBoxes: {},
    boxCarries: {},
    boxNotices: {},
  });
  mocks.client = hostClientRecordingSends();
  negotiateBotSend(HOST_ID, { major: 1, minor: 2 });
  signInViewer(VIEWER_USER_ID);
});

afterEach(async () => {
  cleanup();
  // Let Tiptap complete its deferred unmount destruction before restoring the clock.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  resetBotFailedRequestSupport();
  useAuthStore.setState({
    status: "signed-out",
    profile: null,
    contextMetadata: null,
  });
  mocks.handles.clear();
  mocks.client = null;
});

describe("<BotChannelView tiles={null} /> a question the bot asks without waiting", () => {
  it("draws the card under the bot: each question, its options, a field where words are taken, Submit and Skip, and none of the older client's buttons", () => {
    session(CHANNEL_ID, [questionRow([deploy(null), hold(null)])]);
    mountChannel(null);

    const card = channelCard();
    expect(within(card).getByText("Release Bot asks")).toBeTruthy();
    const first = cardQuestion(card, DEPLOY);
    expect(
      within(first)
        .getAllByTestId("question-card-option")
        .map((option) => option.textContent),
    ).toEqual(["Now", "After the train"]);
    expect(within(first).queryByRole("textbox")).toBeNull();
    expect(within(first).getByRole("button", { name: "Skip" })).toBeTruthy();
    const second = cardQuestion(card, HOLD);
    expect(within(second).getByRole("textbox", { name: "Your answer" }));
    expect(screen.queryByTestId("bot-reply-options")).toBeNull();
  });

  it("sends the picked answer as the person's message with the question it settles, and shows the settlement the host writes, with nothing left to do", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const write = session(CHANNEL_ID, [questionRow([deploy(null)])]);
    mountChannel(null);

    const question = cardQuestion(channelCard(), DEPLOY);
    const submit = within(question).getByRole("button", { name: "Submit" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await user.click(
      within(question).getByRole("button", { name: "After the train" }),
    );
    await user.click(submit);

    expect(sent).toEqual([
      {
        botId: BOT_ID,
        conversationId: CHANNEL_ID,
        text: "After the train",
        threadId: null,
        announcementId: null,
        redeliver: null,
        supersedes: null,
        answer: {
          questionMessageId: QUESTION_ID,
          questionIndex: 0,
          skipped: false,
        },
      },
    ]);
    write([questionRow([deploy(byPerson(VIEWER_USER_ID, "After the train"))])]);
    const settled = cardQuestion(channelCard(), DEPLOY);
    expect(
      within(settled).getByTestId("question-card-settlement").textContent,
    ).toBe("Answered by Olive Owner: After the train");
    expect(within(settled).queryAllByRole("button")).toEqual([]);
    expect(onOpenThread).not.toHaveBeenCalled();
  });

  it("sends a typed answer for the question it is typed under, by its place on the card", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    session(CHANNEL_ID, [questionRow([deploy(null), hold(null)])]);
    mountChannel(null);

    const second = cardQuestion(channelCard(), HOLD);
    await user.type(
      within(second).getByRole("textbox", { name: "Your answer" }),
      "  The migration  ",
    );
    await user.click(within(second).getByRole("button", { name: "Submit" }));

    expect(sent.map((request) => [request.text, request.answer])).toEqual([
      [
        "The migration",
        { questionMessageId: QUESTION_ID, questionIndex: 1, skipped: false },
      ],
    ]);
  });

  it("sends a Skip as skipped, and shows the question skipped once the host settles it", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const write = session(CHANNEL_ID, [questionRow([hold(null)])]);
    mountChannel(null);

    await user.click(
      within(cardQuestion(channelCard(), HOLD)).getByRole("button", {
        name: "Skip",
      }),
    );

    expect(sent.map((request) => [request.text, request.answer])).toEqual([
      [
        "Skipped",
        { questionMessageId: QUESTION_ID, questionIndex: 0, skipped: true },
      ],
    ]);
    write([questionRow([hold(byPerson(VIEWER_USER_ID, null))])]);
    expect(
      within(cardQuestion(channelCard(), HOLD)).getByTestId(
        "question-card-settlement",
      ).textContent,
    ).toBe("Skipped");
  });

  it("says what the bot settled a question nobody answered with, beside a member's answer, and offers nothing on either", () => {
    session(CHANNEL_ID, [
      questionRow([
        deploy(byPerson(TEAMMATE_USER_ID, "Now")),
        hold({
          answer: "Nothing",
          skipped: false,
          by: { kind: "bot" },
          at: 4_000,
        }),
      ]),
    ]);
    mountChannel(null);

    const card = channelCard();
    expect(
      within(card)
        .getAllByTestId("question-card-settlement")
        .map((line) => line.textContent),
    ).toEqual([
      "Answered by Tess Teammate: Now",
      "Settled by Release Bot: Nothing",
    ]);
    expect(within(card).queryAllByRole("button")).toEqual([]);
    expect(within(card).queryByRole("textbox")).toBeNull();
  });

  it("opens the question's own thread from its hover actions, not the thread of the post it follows", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    session(CHANNEL_ID, [
      botRow(
        QUESTION_ID,
        DEPLOY,
        [deploy(null)],
        "conversation-request:req-post",
      ),
    ]);
    mountChannel(null);

    await user.click(
      within(screen.getByTestId("bot-reply-row")).getByTestId(
        "bot-message-reply-in-thread",
      ),
    );

    expect(onOpenThread).toHaveBeenLastCalledWith({
      anchorMessageId: QUESTION_ID,
      announcement: true,
      anchorKind: null,
      sent: null,
    });
  });

  it("draws an older host's row as its text and its first question's options as buttons", () => {
    session(CHANNEL_ID, [botRow("reply-1", DEPLOY, null, null)]);
    mountChannel(null);

    const row = screen.getByTestId("bot-reply-row");
    expect(within(row).getByText(DEPLOY)).toBeTruthy();
    expect(
      within(row)
        .getAllByTestId("bot-reply-option")
        .map((option) => option.textContent),
    ).toEqual(["Now", "After the train"]);
    expect(within(row).queryByTestId("question-card")).toBeNull();
  });
});

describe("<BotChannelView tiles={null} /> a question on a tab whose host cannot take a card's answer", () => {
  it("draws the card with nothing to press on a host that negotiated bot.conversation.send 1.1, keeping the member's draft, and offers them again once the host reaches 1.2", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    session(CHANNEL_ID, [questionRow([deploy(null), hold(null)])]);
    mountChannel(null);
    await user.type(holdField(), "Hold the migration");

    act(() => {
      negotiateBotSend(HOST_ID, { major: 1, minor: 1 });
    });

    expect(
      within(channelCard())
        .getAllByRole("button")
        .filter((button) => !(button as HTMLButtonElement).disabled),
    ).toEqual([]);
    expect(holdField().value).toBe("Hold the migration");
    expect(holdField().disabled).toBe(true);
    expect(sent).toEqual([]);

    act(() => {
      negotiateBotSend(HOST_ID, { major: 1, minor: 2 });
    });
    await user.click(
      within(cardQuestion(channelCard(), HOLD)).getByRole("button", {
        name: "Submit",
      }),
    );
    expect(sent.map((request) => [request.text, request.answer])).toEqual([
      [
        "Hold the migration",
        { questionMessageId: QUESTION_ID, questionIndex: 1, skipped: false },
      ],
    ]);
  });
});

/** The channel's box, where an answer overtaken on a card asked at the channel's top level moves. */
function channelBox(): HTMLElement {
  return boxInput("Message Release Bot");
}

/** What the channel's box says under it once answers moved there. */
function channelMovedLine(): string | undefined {
  return screen.queryByTestId("bot-channel-composer-answers-moved")
    ?.textContent;
}

/** What a settled question's card line says, for the question named. */
function settlementLine(card: HTMLElement, text: string): string | undefined {
  return within(cardQuestion(card, text)).getByTestId(
    "question-card-settlement",
  ).textContent;
}

describe("<BotChannelView tiles={null} /> a question settled while a member was answering (decision 122, T186)", () => {
  it("gives the answer back when the host refuses it while the question is open, says it was not sent, then moves it to the channel's box when the settlement lands, the moved line replacing the failure", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const write = session(CHANNEL_ID, [questionRow([hold(null)])]);
    mountChannel(null);
    await user.type(holdField(), "Hold the migration");

    // A teammate's answer reached the host first, but the row has not shown it yet.
    refuseSends = true;
    await user.click(
      within(cardQuestion(channelCard(), HOLD)).getByRole("button", {
        name: "Submit",
      }),
    );

    expect(sent).toHaveLength(1);
    expect(
      await screen.findByTestId("bot-channel-composer-send-failed"),
    ).toBeTruthy();
    expect(holdField().value).toBe("Hold the migration");
    expect(textOf(channelBox())).toBe("");

    write([questionRow([hold(byPerson(TEAMMATE_USER_ID, "Nothing"))])]);

    expect(settlementLine(channelCard(), HOLD)).toBe(
      "Answered by Tess Teammate: Nothing",
    );
    expect(textOf(channelBox())).toBe("Hold the migration");
    expect(screen.queryByTestId("bot-channel-composer-send-failed")).toBeNull();
    expect(channelMovedLine()).toBe(
      "Tess Teammate answered first. Your answer is in the box, not sent.",
    );
    expect(within(channelCard()).queryAllByRole("button")).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it("holds the answer on the card, with no couldn't-send line, when the host refuses it with the already-settled code, and moves it to the channel's box once the teammate's settlement shows", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    refusalKind = "coded";
    const write = session(CHANNEL_ID, [questionRow([hold(null)])]);
    mountChannel(null);
    await user.type(holdField(), "Hold the migration");
    refuseSends = true;
    await user.click(
      within(cardQuestion(channelCard(), HOLD)).getByRole("button", {
        name: "Submit",
      }),
    );

    await vi.waitFor(() =>
      expect(
        useBotDraftsStore.getState().answers[BOT_ID]?.[
          answerDraftKey(QUESTION_ID, 0)
        ]?.heldForSettlement,
      ).not.toBeNull(),
    );
    expect(sent).toHaveLength(1);
    expect(
      within(cardQuestion(channelCard(), HOLD)).getByTestId(
        "question-card-sending",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("bot-channel-composer-send-failed")).toBeNull();
    expect(textOf(channelBox())).toBe("");

    write([questionRow([hold(byPerson(TEAMMATE_USER_ID, "Nothing"))])]);

    expect(textOf(channelBox())).toBe("Hold the migration");
    expect(channelMovedLine()).toBe(
      "Tess Teammate answered first. Your answer is in the box, not sent.",
    );
    expect(screen.queryByTestId("bot-channel-composer-send-failed")).toBeNull();
    expect(useBotDraftsStore.getState().answers).toEqual({});
  });

  it("holds the answer, with no couldn't-send line, when the already-settled refusal comes back wrapped by the auth layer after a session fatal and a rotated bearer, and moves it to the channel's box once the teammate's settlement shows", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    refusalKind = "coded";
    fatalFirstSend = true;
    mocks.client = hostClientRecordingSends();
    const write = session(CHANNEL_ID, [questionRow([hold(null)])]);
    mountChannel(null);
    await user.type(holdField(), "Hold the migration");
    refuseSends = true;
    await user.click(
      within(cardQuestion(channelCard(), HOLD)).getByRole("button", {
        name: "Submit",
      }),
    );

    await vi.waitFor(() =>
      expect(
        useBotDraftsStore.getState().answers[BOT_ID]?.[
          answerDraftKey(QUESTION_ID, 0)
        ]?.heldForSettlement,
      ).not.toBeNull(),
    );
    // The fatal send, then the one the auth layer made after the rotation.
    expect(sendAttempts).toBe(2);
    expect(sent).toHaveLength(1);
    expect(
      within(cardQuestion(channelCard(), HOLD)).getByTestId(
        "question-card-sending",
      ),
    ).toBeTruthy();
    expect(holdField().disabled).toBe(true);
    expect(screen.queryByTestId("bot-channel-composer-send-failed")).toBeNull();
    expect(textOf(channelBox())).toBe("");

    write([questionRow([hold(byPerson(TEAMMATE_USER_ID, "Nothing"))])]);

    expect(textOf(channelBox())).toBe("Hold the migration");
    expect(channelMovedLine()).toBe(
      "Tess Teammate answered first. Your answer is in the box, not sent.",
    );
    expect(screen.queryByTestId("bot-channel-composer-send-failed")).toBeNull();
    expect(sendAttempts).toBe(2);
  });

  it("keeps the answer held on the card when the already-settled refusal is never followed by a settlement: no failure line, nothing in the box, nothing lost", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    refusalKind = "coded";
    heldSends = [];
    session(CHANNEL_ID, [questionRow([hold(null)])]);
    mountChannel(null);
    await user.type(holdField(), "Hold the migration");
    await user.click(
      within(cardQuestion(channelCard(), HOLD)).getByRole("button", {
        name: "Submit",
      }),
    );
    await refuse();

    const key = answerDraftKey(QUESTION_ID, 0);
    await vi.waitFor(() =>
      expect(
        useBotDraftsStore.getState().answers[BOT_ID]?.[key]?.heldForSettlement,
      ).toBe(key),
    );
    expect(
      within(cardQuestion(channelCard(), HOLD)).getByTestId(
        "question-card-sending",
      ),
    ).toBeTruthy();
    expect(holdField().value).toBe("Hold the migration");
    expect(holdField().disabled).toBe(true);
    expect(screen.queryByTestId("bot-channel-composer-send-failed")).toBeNull();
    expect(textOf(channelBox())).toBe("");
    expect(sent).toHaveLength(1);
  });

  it("spends the held answer, moving nothing and saying nothing, when the settlement that follows the already-settled refusal is the member's own matching answer", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    refusalKind = "coded";
    const write = session(CHANNEL_ID, [questionRow([deploy(null)])]);
    mountChannel(null);
    await user.click(
      within(cardQuestion(channelCard(), DEPLOY)).getByRole("button", {
        name: "Now",
      }),
    );
    refuseSends = true;
    await user.click(
      within(cardQuestion(channelCard(), DEPLOY)).getByRole("button", {
        name: "Submit",
      }),
    );
    const key = answerDraftKey(QUESTION_ID, 0);
    await vi.waitFor(() =>
      expect(
        useBotDraftsStore.getState().answers[BOT_ID]?.[key]?.heldForSettlement,
      ).toBe(key),
    );

    write([questionRow([deploy(byPerson(VIEWER_USER_ID, "Now"))])]);

    expect(settlementLine(channelCard(), DEPLOY)).toBe(
      "Answered by Olive Owner: Now",
    );
    expect(useBotDraftsStore.getState().answers).toEqual({});
    expect(textOf(channelBox())).toBe("");
    expect(channelMovedLine()).toBeUndefined();
    expect(screen.queryByTestId("bot-channel-composer-send-failed")).toBeNull();
  });

  it("moves the answer once when the settlement lands while the send is held, and a refusal after it changes nothing", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    heldSends = [];
    const write = session(CHANNEL_ID, [questionRow([hold(null)])]);
    mountChannel(null);
    await user.type(holdField(), "Hold the migration");
    await user.click(
      within(cardQuestion(channelCard(), HOLD)).getByRole("button", {
        name: "Submit",
      }),
    );

    write([questionRow([hold(byPerson(TEAMMATE_USER_ID, "Nothing"))])]);
    await refuse();

    expect(textOf(channelBox())).toBe("Hold the migration");
    expect(screen.queryByTestId("bot-channel-composer-send-failed")).toBeNull();
    expect(channelMovedLine()).toBe(
      "Tess Teammate answered first. Your answer is in the box, not sent.",
    );
    expect(useBotDraftsStore.getState().answers).toEqual({});
  });

  it("moves a picked option, alone, into the channel's box when a teammate's settlement arrives, naming them, without sending anything", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const write = session(CHANNEL_ID, [questionRow([deploy(null)])]);
    mountChannel(null);
    await user.click(
      within(cardQuestion(channelCard(), DEPLOY)).getByRole("button", {
        name: "Now",
      }),
    );

    write([
      questionRow([deploy(byPerson(TEAMMATE_USER_ID, "After the train"))]),
    ]);

    const question = cardQuestion(channelCard(), DEPLOY);
    expect(
      within(question).getByTestId("question-card-settlement").textContent,
    ).toBe("Answered by Tess Teammate: After the train");
    expect(question.getAttribute("data-state")).toBe("settled");
    expect(within(question).queryAllByRole("button")).toEqual([]);
    expect(textOf(channelBox())).toBe("Now");
    expect(channelMovedLine()).toBe(
      "Tess Teammate answered first. Your answer is in the box, not sent.",
    );
    expect(sent).toEqual([]);
  });

  it("adds the answer below what the box already held, after a blank line, and replaces nothing", async () => {
    const write = session(CHANNEL_ID, [questionRow([hold(null)])]);
    mountChannel(null);
    typeInto(channelBox(), "Before I forget");
    await userEvent
      .setup({ advanceTimers: vi.advanceTimersByTime })
      .type(holdField(), "Hold the migration");

    write([questionRow([hold(byPerson(TEAMMATE_USER_ID, "Nothing"))])]);

    expect(textOf(channelBox())).toBe("Before I forget\n\nHold the migration");
  });

  it("opens the channel's box with its kept draft, a blank line and the moved answer, existing text first, when the answer moved while the box was not mounted", async () => {
    useBotDraftsStore.getState().typeThreadBox(BOT_ID, CHANNEL_ID, {
      text: "Before I forget",
      content: null,
      held: [],
    });
    const key = answerDraftKey(QUESTION_ID, 0);
    act(() => {
      const drafts = useBotDraftsStore.getState();
      drafts.setAnswer(BOT_ID, key, {
        chosen: [],
        typed: "Hold the migration",
        sent: null,
        unsureSince: null,
        heldForSettlement: null,
      });
      drafts.moveAnswers(BOT_ID, CHANNEL_ID, [key], (taken) => ({
        block: taken.map(([, draft]) => draft.typed).join("\n"),
        notice:
          "Tess Teammate answered first. Your answer is in the box, not sent.",
      }));
    });
    session(CHANNEL_ID, [questionRow([hold(null)])]);

    mountChannel(null);

    expect(textOf(channelBox())).toBe("Before I forget\n\nHold the migration");
    await vi.waitFor(() =>
      expect(
        useBotDraftsStore.getState().boxCarries[BOT_ID]?.[CHANNEL_ID] ?? [],
      ).toEqual([]),
    );
  });

  it("moves a draft the person typed under a question the asker settled, naming the bot", async () => {
    const write = session(CHANNEL_ID, [questionRow([hold(null)])]);
    mountChannel(null);
    await userEvent
      .setup({ advanceTimers: vi.advanceTimersByTime })
      .type(holdField(), "Hold the migration");

    write([
      questionRow([
        hold({
          answer: "Nothing",
          skipped: false,
          by: { kind: "bot" },
          at: 4_000,
        }),
      ]),
    ]);

    expect(settlementLine(channelCard(), HOLD)).toBe(
      "Settled by Release Bot: Nothing",
    );
    expect(channelMovedLine()).toBe(
      "Release Bot settled it first. Your answer is in the box, not sent.",
    );
  });

  it("says a teammate skipped the question first when every answer that moved was skipped over", async () => {
    const write = session(CHANNEL_ID, [questionRow([hold(null)])]);
    mountChannel(null);
    await userEvent
      .setup({ advanceTimers: vi.advanceTimersByTime })
      .type(holdField(), "Hold the migration");

    write([questionRow([hold(byPerson(TEAMMATE_USER_ID, null))])]);

    expect(channelMovedLine()).toBe(
      "Tess Teammate skipped it first. Your answer is in the box, not sent.",
    );
  });

  it("keeps the moved line while the person types in the box, and takes it back when the box sends", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const write = session(CHANNEL_ID, [questionRow([hold(null)])]);
    mountChannel(null);
    await user.type(holdField(), "Hold the migration");
    write([questionRow([hold(byPerson(TEAMMATE_USER_ID, "Nothing"))])]);

    typeInto(channelBox(), " today");
    expect(channelMovedLine()).toBeDefined();
    await user.click(screen.getByTestId("bot-channel-composer-send"));

    expect(channelMovedLine()).toBeUndefined();
    expect(sent.map((request) => request.text)).toEqual([
      "Hold the migration today",
    ]);
  });

  it("takes back the box's couldn't-send line once the person types in the box", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    session(CHANNEL_ID, [questionRow([hold(null)])]);
    mountChannel(null);
    await user.type(holdField(), "Hold the migration");
    refuseSends = true;
    await user.click(
      within(cardQuestion(channelCard(), HOLD)).getByRole("button", {
        name: "Submit",
      }),
    );
    await screen.findByTestId("bot-channel-composer-send-failed");

    typeInto(channelBox(), "Wait");

    expect(screen.queryByTestId("bot-channel-composer-send-failed")).toBeNull();
  });

  it("takes back the box's couldn't-send line when the card sends again", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    session(CHANNEL_ID, [questionRow([hold(null)])]);
    mountChannel(null);
    await user.type(holdField(), "Hold the migration");
    refuseSends = true;
    await user.click(
      within(cardQuestion(channelCard(), HOLD)).getByRole("button", {
        name: "Submit",
      }),
    );
    await screen.findByTestId("bot-channel-composer-send-failed");
    refuseSends = false;
    heldSends = [];

    await user.click(
      within(cardQuestion(channelCard(), HOLD)).getByRole("button", {
        name: "Submit",
      }),
    );

    expect(sent).toHaveLength(2);
    expect(screen.queryByTestId("bot-channel-composer-send-failed")).toBeNull();
  });
});

/** The answer field of the card's question that takes words. */
function holdField(): HTMLTextAreaElement {
  const field = within(cardQuestion(channelCard(), HOLD)).getByRole("textbox", {
    name: "Your answer",
  });
  if (!(field instanceof HTMLTextAreaElement)) throw new Error("no field");
  return field;
}

/** The question's own thread, as Discuss opens it. */
const QUESTION_THREAD: BotOpenThread = {
  anchorMessageId: QUESTION_ID,
  announcement: true,
  anchorKind: null,
  sent: null,
};

/** The box of the question's thread, which nobody has started. */
function questionThreadBox(): HTMLElement {
  const box = boxWithin(
    screen.getByTestId("bot-thread-panel"),
    "Reply in a new thread",
  );
  return box;
}

describe("<BotChannelView tiles={null} /> an answer the host queued while the bot's host is away", () => {
  it("holds the sent answer on the card, its choice pressed and nothing left to press, until the room settles it; the member's own settlement closes it", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    delivery = "queued";
    const write = session(CHANNEL_ID, [questionRow([deploy(null)])]);
    mountChannel(null);
    await user.click(
      within(cardQuestion(channelCard(), DEPLOY)).getByRole("button", {
        name: "After the train",
      }),
    );
    await user.click(
      within(cardQuestion(channelCard(), DEPLOY)).getByRole("button", {
        name: "Submit",
      }),
    );

    expect(sent).toHaveLength(1);
    const sending = cardQuestion(channelCard(), DEPLOY);
    expect(within(sending).getByTestId("question-card-sending")).toBeTruthy();
    expect(
      within(sending)
        .getByRole("button", { name: "After the train" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      within(sending)
        .getAllByRole("button")
        .filter((button) => !(button as HTMLButtonElement).disabled),
    ).toEqual([]);

    write([questionRow([deploy(byPerson(VIEWER_USER_ID, "After the train"))])]);
    const settled = cardQuestion(channelCard(), DEPLOY);
    expect(
      within(settled).getByTestId("question-card-settlement").textContent,
    ).toBe("Answered by Olive Owner: After the train");
    expect(within(settled).queryAllByRole("button")).toEqual([]);
    expect(useBotDraftsStore.getState().answers).toEqual({});
    expect(textOf(channelBox())).toBe("");
    expect(channelMovedLine()).toBeUndefined();
  });

  it("moves a queued answer into the channel's box once a teammate's settlement reaches the room first, and sends nothing more", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    delivery = "queued";
    const write = session(CHANNEL_ID, [questionRow([hold(null)])]);
    mountChannel(null);
    await user.type(holdField(), "Hold the migration");
    await user.click(
      within(cardQuestion(channelCard(), HOLD)).getByRole("button", {
        name: "Submit",
      }),
    );
    expect(
      within(cardQuestion(channelCard(), HOLD)).getByTestId(
        "question-card-sending",
      ),
    ).toBeTruthy();

    // The bot's host, back, refused it: a teammate's answer reached it first.
    write([questionRow([hold(byPerson(TEAMMATE_USER_ID, "Nothing"))])]);

    expect(settlementLine(channelCard(), HOLD)).toBe(
      "Answered by Tess Teammate: Nothing",
    );
    expect(textOf(channelBox())).toBe("Hold the migration");
    expect(sent).toHaveLength(1);
    expect(screen.queryByTestId("bot-channel-composer-send-failed")).toBeNull();
  });
});

describe("<BotChannelView tiles={null} /> an answer someone else settled with first, the same member from another window included", () => {
  it("moves the card's sent answer when a teammate settled the question first with the same answer", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    delivery = "queued";
    const write = session(CHANNEL_ID, [questionRow([deploy(null)])]);
    mountChannel(null);
    await user.click(
      within(cardQuestion(channelCard(), DEPLOY)).getByRole("button", {
        name: "Now",
      }),
    );
    await user.click(
      within(cardQuestion(channelCard(), DEPLOY)).getByRole("button", {
        name: "Submit",
      }),
    );

    write([questionRow([deploy(byPerson(TEAMMATE_USER_ID, "Now"))])]);

    expect(settlementLine(channelCard(), DEPLOY)).toBe(
      "Answered by Tess Teammate: Now",
    );
    expect(textOf(channelBox())).toBe("Now");
  });

  it("moves the card's sent answer, with the another-window line, when the member's own settlement is a different answer", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    delivery = "queued";
    const write = session(CHANNEL_ID, [questionRow([deploy(null)])]);
    mountChannel(null);
    await user.click(
      within(cardQuestion(channelCard(), DEPLOY)).getByRole("button", {
        name: "After the train",
      }),
    );
    await user.click(
      within(cardQuestion(channelCard(), DEPLOY)).getByRole("button", {
        name: "Submit",
      }),
    );

    write([questionRow([deploy(byPerson(VIEWER_USER_ID, "Now"))])]);

    expect(settlementLine(channelCard(), DEPLOY)).toBe(
      "Answered by Olive Owner: Now",
    );
    expect(textOf(channelBox())).toBe("After the train");
    expect(channelMovedLine()).toBe(
      "You answered in another window first. This answer is in the box, not sent.",
    );
    expect(sent).toHaveLength(1);
  });
});

describe("<BotChannelView tiles={null} /> what a member has not sent, across the views that draw it", () => {
  /**
   * The card's one question settled by a teammate first, the viewer's answer
   * unsent: `typed`, now moved into the channel's box.
   */
  async function movedToChannelBox(typed: string): Promise<{
    readonly reopen: (next: BotOpenThread | null) => void;
    readonly unmount: () => void;
  }> {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const write = session(CHANNEL_ID, [questionRow([hold(null)])]);
    const view = mountChannel(null);
    // Seed the draft in one paste; these cases exercise its lifecycle after settlement.
    await user.click(holdField());
    await user.paste(typed);
    write([questionRow([hold(byPerson(TEAMMATE_USER_ID, "Nothing"))])]);
    expect(textOf(channelBox())).toBe(typed);
    return view;
  }

  it("keeps a card's answers, typed, picked and sent, across the channel unmounting and mounting again, as a switch to another tab and back does", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    delivery = "queued";
    session(CHANNEL_ID, [questionRow([deploy(null), hold(null)])]);
    const first = mountChannel(null);
    await user.click(
      within(cardQuestion(channelCard(), DEPLOY)).getByRole("button", {
        name: "Now",
      }),
    );
    await user.click(
      within(cardQuestion(channelCard(), DEPLOY)).getByRole("button", {
        name: "Submit",
      }),
    );
    await user.type(holdField(), "Hold the migration");

    first.unmount();
    mountChannel(null);

    const deployQuestion = cardQuestion(channelCard(), DEPLOY);
    expect(
      within(deployQuestion).getByTestId("question-card-sending"),
    ).toBeTruthy();
    expect(
      within(deployQuestion)
        .getByRole("button", { name: "Now" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(holdField().value).toBe("Hold the migration");
    expect(sent).toHaveLength(1);
  });

  it("keeps the moved answer, and what was typed after it, in the channel's box across the channel unmounting and mounting again", async () => {
    const view = await movedToChannelBox("Hold the migration");
    typeInto(channelBox(), " today");

    view.unmount();
    mountChannel(null);

    expect(textOf(channelBox())).toBe("Hold the migration today");
    expect(sent).toEqual([]);
  });

  it("spends the moved answer with the send that carries it, even when the send lands after the channel was unmounted", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    heldSends = [];
    const view = await movedToChannelBox("Hold the migration");
    await user.click(screen.getByTestId("bot-channel-composer-send"));
    expect(
      sent.map((request) => [request.text, request.threadId, request.answer]),
    ).toEqual([["Hold the migration", null, null]]);

    view.unmount();
    await land();
    mountChannel(null);

    expect(textOf(channelBox())).toBe("");
  });

  it("offers the refused send's text back beside a newer draft, in the channel mounted again after the send was refused while it was unmounted", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    heldSends = [];
    const view = await movedToChannelBox("Hold the migration");
    await user.click(screen.getByTestId("bot-channel-composer-send"));
    typeInto(channelBox(), "Hold off today");

    view.unmount();
    await refuse();
    mountChannel(null);

    expect(textOf(channelBox())).toBe("Hold off today");
    expect(
      screen.getByTestId("bot-channel-composer-send-failed").textContent,
    ).toContain("Hold the migration");
    await user.click(
      screen.getByTestId("bot-channel-composer-send-failed-restore"),
    );
    expect(textOf(channelBox())).toBe("Hold the migration");
    expect(screen.queryByTestId("bot-channel-composer-send-failed")).toBeNull();
  });

  /**
   * The moved answer sent from the channel's box, the channel unmounted and
   * mounted again while the send is held: the answer went with the send, so
   * the box opens empty.
   */
  async function sentThenRemounted(): Promise<void> {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    heldSends = [];
    const view = await movedToChannelBox("Hold the migration");
    await user.click(screen.getByTestId("bot-channel-composer-send"));
    view.unmount();
    mountChannel(null);
    expect(textOf(channelBox())).toBe("");
  }

  it("does not offer the sent answer again in the box mounted while the send was in flight, once it lands", async () => {
    await sentThenRemounted();

    await land();

    expect(textOf(channelBox())).toBe("");
    expect(
      screen.getByTestId("bot-channel-composer-send").hasAttribute("disabled"),
    ).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("keeps what was typed in the box mounted again after the send left, when the send lands", async () => {
    await sentThenRemounted();
    typeInto(channelBox(), "Hold off today");

    await land();

    expect(textOf(channelBox())).toBe("Hold off today");
  });

  it("keeps an answer that moves into the box while an earlier send from it is in flight, once that send lands", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    heldSends = [];
    const write = session(CHANNEL_ID, [
      questionRow([deploy(null), hold(null)]),
    ]);
    mountChannel(null);
    await user.click(holdField());
    await user.paste("Hold the migration");
    await user.click(
      within(cardQuestion(channelCard(), DEPLOY)).getByRole("button", {
        name: "Now",
      }),
    );
    write([
      questionRow([deploy(null), hold(byPerson(TEAMMATE_USER_ID, "Nothing"))]),
    ]);
    await user.click(screen.getByTestId("bot-channel-composer-send"));

    write([
      questionRow([
        deploy(byPerson(TEAMMATE_USER_ID, "After the train")),
        hold(byPerson(TEAMMATE_USER_ID, "Nothing")),
      ]),
    ]);
    expect(textOf(channelBox())).toBe(`${DEPLOY} Now`);
    await land();

    expect(textOf(channelBox())).toBe(`${DEPLOY} Now`);
  });
});

const ACCOUNT_A = "user-account-a";
const ACCOUNT_B = "user-account-b";

function signInAs(userId: string): void {
  act(() => {
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId,
        userName: userId,
        email: `${userId}@example.com`,
        avatarUrl: null,
      },
      contextMetadata: { userId, username: userId },
    });
  });
}

function signOut(): void {
  act(() => {
    useAuthStore.setState({
      status: "signed-out",
      profile: null,
      contextMetadata: null,
    });
  });
}

/** Nothing of anyone's kept in memory, in any slice of the drafts store. */
function expectNoDraftsInMemory(): void {
  const { answers, threadBoxes, unsentBoxes, boxCarries, boxNotices } =
    useBotDraftsStore.getState();
  expect({ answers, threadBoxes, unsentBoxes, boxCarries, boxNotices }).toEqual(
    {
      answers: {},
      threadBoxes: {},
      unsentBoxes: {},
      boxCarries: {},
      boxNotices: {},
    },
  );
}

describe("<BotChannelView tiles={null} /> a moved answer and the signed-in account (T186)", () => {
  const MOVED = "Hold the migration";

  beforeEach(() => {
    localStorage.clear();
    identityBridge = true;
    signInAs(ACCOUNT_A);
  });

  afterEach(() => {
    localStorage.clear();
  });

  /** Signed in as A: the member types, a teammate settles, and the answer is in the channel's box. */
  async function movedIntoTheBoxAsA(): Promise<void> {
    const write = session(CHANNEL_ID, [questionRow([hold(null)])]);
    mountChannel(null);
    await userEvent
      .setup({ advanceTimers: vi.advanceTimersByTime })
      .type(holdField(), MOVED);
    write([questionRow([hold(byPerson(TEAMMATE_USER_ID, "Nothing"))])]);
    expect(textOf(channelBox())).toBe(MOVED);
  }

  /** B's box, with nothing of A's anywhere B could read it. */
  async function expectNothingOfAForB(): Promise<void> {
    await vi.waitFor(() => expect(textOf(channelBox())).toBe(""));
    expect(channelMovedLine()).toBeUndefined();
    expectNoDraftsInMemory();
    expect(
      localStorage.getItem(botBoxDraftsKey(ACCOUNT_B)) ?? "",
    ).not.toContain(MOVED);
  }

  it("shows account B nothing of account A's moved answer, in the box, the store or B's storage, and gives it back, unsent and with no line, when A signs in again after a switch", async () => {
    await movedIntoTheBoxAsA();

    signInAs(ACCOUNT_B);
    await expectNothingOfAForB();

    signInAs(ACCOUNT_A);
    await vi.waitFor(() => expect(textOf(channelBox())).toBe(MOVED));
    expect(channelMovedLine()).toBeUndefined();
    expect(sent).toEqual([]);
  });

  it("keeps an answer that moved while the box was not mounted, and was still not mounted at the switch, for A alone, folded into A's kept draft", async () => {
    identityBridge = false;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <BotDraftsPersistLifecycleBridge>
          <div />
        </BotDraftsPersistLifecycleBridge>
      </QueryClientProvider>,
    );
    session(CHANNEL_ID, [questionRow([hold(null)])]);
    const key = answerDraftKey(QUESTION_ID, 0);
    act(() => {
      const drafts = useBotDraftsStore.getState();
      drafts.setAnswer(BOT_ID, key, {
        chosen: [],
        typed: MOVED,
        sent: null,
        unsureSince: null,
        heldForSettlement: null,
      });
      drafts.moveAnswers(BOT_ID, CHANNEL_ID, [key], (taken) => ({
        block: taken.map(([, draft]) => draft.typed).join("\n"),
        notice:
          "Tess Teammate answered first. Your answer is in the box, not sent.",
      }));
    });
    expect(
      useBotDraftsStore.getState().boxCarries[BOT_ID]?.[CHANNEL_ID],
    ).toBeDefined();

    signInAs(ACCOUNT_B);
    expectNoDraftsInMemory();
    const asB = mountChannel(null);
    await expectNothingOfAForB();
    asB.unmount();

    signInAs(ACCOUNT_A);
    mountChannel(null);
    await vi.waitFor(() => expect(textOf(channelBox())).toBe(MOVED));
    expect(channelMovedLine()).toBeUndefined();
  });

  it("writes an answer that moved while the box was not mounted into A's own key at the switch, after A's read finished, and gives it back to A", async () => {
    identityBridge = false;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <BotDraftsPersistLifecycleBridge>
          <div />
        </BotDraftsPersistLifecycleBridge>
      </QueryClientProvider>,
    );
    await vi.waitFor(() =>
      expect(useBotDraftsStore.persist.hasHydrated()).toBe(true),
    );
    session(CHANNEL_ID, [questionRow([hold(null)])]);
    const key = answerDraftKey(QUESTION_ID, 0);
    act(() => {
      const drafts = useBotDraftsStore.getState();
      drafts.setAnswer(BOT_ID, key, {
        chosen: [],
        typed: MOVED,
        sent: null,
        unsureSince: null,
        heldForSettlement: null,
      });
      drafts.moveAnswers(BOT_ID, CHANNEL_ID, [key], (taken) => ({
        block: taken.map(([, draft]) => draft.typed).join("\n"),
        notice:
          "Tess Teammate answered first. Your answer is in the box, not sent.",
      }));
    });

    signInAs(ACCOUNT_B);

    await vi.waitFor(() =>
      expect(localStorage.getItem(botBoxDraftsKey(ACCOUNT_A)) ?? "").toContain(
        MOVED,
      ),
    );
    expectNoDraftsInMemory();
    const asB = mountChannel(null);
    await expectNothingOfAForB();
    asB.unmount();

    signInAs(ACCOUNT_A);
    mountChannel(null);
    await vi.waitFor(() => expect(textOf(channelBox())).toBe(MOVED));
    expect(channelMovedLine()).toBeUndefined();
  });

  it("gives A the moved answer back, unsent and with no line, when A signs out and signs in again, with nothing of it in memory while signed out", async () => {
    await movedIntoTheBoxAsA();

    signOut();
    expectNoDraftsInMemory();

    signInAs(ACCOUNT_A);
    await vi.waitFor(() => expect(textOf(channelBox())).toBe(MOVED));
    expect(channelMovedLine()).toBeUndefined();
  });

  it.each([
    { name: "refused", settle: refuse },
    { name: "landed", settle: land },
  ])(
    "leaves B's draft and B's box alone when a send A started is $name after the switch",
    async ({ settle }) => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      heldSends = [];
      session(CHANNEL_ID, [questionRow([hold(null)])]);
      mountChannel(null);
      await user.type(holdField(), MOVED);
      await user.click(
        within(cardQuestion(channelCard(), HOLD)).getByRole("button", {
          name: "Submit",
        }),
      );
      expect(heldSends).toHaveLength(1);

      signInAs(ACCOUNT_B);
      await vi.waitFor(() => expect(holdField().value).toBe(""));
      await user.type(holdField(), "B's own answer");
      const before = useBotDraftsStore.getState().answers;

      await settle();

      expect(useBotDraftsStore.getState().answers).toEqual(before);
      expect(useBotDraftsStore.getState().boxNotices).toEqual({});
      expect(holdField().value).toBe("B's own answer");
      expect(holdField().disabled).toBe(false);
      expect(
        screen.queryByTestId("bot-channel-composer-send-failed"),
      ).toBeNull();
    },
  );
});

describe("<BotChannelView tiles={null} /> a row's text above its question card", () => {
  it("shows the row's text above the card when it says more than its questions", () => {
    session(CHANNEL_ID, [
      botRow(
        QUESTION_ID,
        "I'm your bot. Two questions to start.",
        [deploy(null)],
        null,
      ),
    ]);
    mountChannel(null);

    const channel = screen.getByTestId("bot-channel");
    expect(
      within(channel).getByText("I'm your bot. Two questions to start."),
    ).toBeTruthy();
    expect(
      within(channelCard()).getByRole("region", { name: DEPLOY }),
    ).toBeTruthy();
  });

  it("shows the card alone, with no copy of the question, when the row's text is just its questions", () => {
    session(CHANNEL_ID, [questionRow([deploy(null)])]);
    mountChannel(null);

    expect(
      within(screen.getByTestId("bot-channel")).getAllByText(DEPLOY),
    ).toHaveLength(1);
  });

  describe("with several questions, one long and multi-line", () => {
    const LONG_MARKER = "rollback window for the canary";
    const LONG_QUESTION = [
      "Before the train leaves, which of these should block it?",
      `Think about the ${LONG_MARKER}, the migration that touches billing,`,
      "and whether the on-call engineer has signed off on the release.",
      "x".repeat(200),
    ].join("\n");
    const longQuestions: BotQuestionItem[] = [
      {
        text: LONG_QUESTION,
        options: [],
        allowFreeText: true,
        settlement: null,
      },
      deploy(null),
    ];

    function expectEachQuestionOnce(): void {
      const channel = screen.getByTestId("bot-channel");
      expect(
        within(channel).getAllByText(new RegExp(LONG_MARKER)),
      ).toHaveLength(1);
      expect(within(channel).getAllByText(DEPLOY)).toHaveLength(1);
      const card = channelCard();
      within(card).getByText(new RegExp(LONG_MARKER));
      within(card).getByText(DEPLOY);
    }

    it("draws each question once, in the card, when the row's text is exactly what the host writes for them", () => {
      session(CHANNEL_ID, [
        botRow(
          QUESTION_ID,
          botQuestionsText(longQuestions),
          longQuestions,
          null,
        ),
      ]);
      mountChannel(null);

      expectEachQuestionOnce();
    });

    it("draws the prose above the card once, and each question once, when the row says more than its questions", () => {
      const prose = "Hi, I'm your release assistant. Let me ask a few things.";
      session(CHANNEL_ID, [botRow(QUESTION_ID, prose, longQuestions, null)]);
      mountChannel(null);

      expect(
        within(screen.getByTestId("bot-channel")).getAllByText(prose),
      ).toHaveLength(1);
      expectEachQuestionOnce();
    });
  });
});

describe("<BotChannelView tiles={null} /> a question that takes options and the person's own words", () => {
  it("toggles several options, and Submit sends them joined in option order with the typed words after them", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    session(CHANNEL_ID, [questionRow([watch(null)])]);
    mountChannel(null);

    const question = cardQuestion(channelCard(), WATCH);
    await user.click(
      within(question).getByRole("button", { name: "Sandboxes and credits" }),
    );
    await user.click(
      within(question).getByRole("button", { name: "Agents waiting on me" }),
    );
    await user.type(
      within(question).getByRole("textbox", { name: "Your answer" }),
      "the build farm",
    );
    await user.click(within(question).getByRole("button", { name: "Submit" }));

    expect(sent.map((request) => request.text)).toEqual([
      "Agents waiting on me, Sandboxes and credits, the build farm",
    ]);
  });

  it("takes a pick back when it is toggled off", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    session(CHANNEL_ID, [questionRow([watch(null)])]);
    mountChannel(null);

    const question = cardQuestion(channelCard(), WATCH);
    await user.click(
      within(question).getByRole("button", { name: "Agents waiting on me" }),
    );
    await user.click(
      within(question).getByRole("button", { name: "Sandboxes and credits" }),
    );
    await user.click(
      within(question).getByRole("button", { name: "Agents waiting on me" }),
    );

    expect(
      within(question)
        .getByRole("button", { name: "Agents waiting on me" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    await user.click(within(question).getByRole("button", { name: "Submit" }));
    expect(sent.map((request) => request.text)).toEqual([
      "Sandboxes and credits",
    ]);
  });

  it("stays single-pick when multiSelect is false though free text is allowed: a second pick replaces the first", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    session(CHANNEL_ID, [
      questionRow([{ ...watch(null), multiSelect: false }]),
    ]);
    mountChannel(null);

    const question = cardQuestion(channelCard(), WATCH);
    await user.click(
      within(question).getByRole("button", { name: "Agents waiting on me" }),
    );
    await user.click(
      within(question).getByRole("button", { name: "Sandboxes and credits" }),
    );
    expect(
      within(question)
        .getByRole("button", { name: "Agents waiting on me" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    await user.click(within(question).getByRole("button", { name: "Submit" }));
    expect(sent.map((request) => request.text)).toEqual([
      "Sandboxes and credits",
    ]);
  });

  it("sends the typed words alone on a single-pick question with free text, once words are typed over a pick", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    session(CHANNEL_ID, [
      questionRow([{ ...watch(null), multiSelect: false }]),
    ]);
    mountChannel(null);

    const question = cardQuestion(channelCard(), WATCH);
    await user.click(
      within(question).getByRole("button", { name: "Agents waiting on me" }),
    );
    await user.type(
      within(question).getByRole("textbox", { name: "Your answer" }),
      "the build farm",
    );
    await user.click(within(question).getByRole("button", { name: "Submit" }));

    expect(sent.map((request) => request.text)).toEqual(["the build farm"]);
  });

  it("toggles several options with no text field when multiSelect is true and free text is not allowed, and Submit sends the picks joined in option order", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    session(CHANNEL_ID, [
      questionRow([{ ...watch(null), allowFreeText: false }]),
    ]);
    mountChannel(null);

    const question = cardQuestion(channelCard(), WATCH);
    expect(within(question).queryByRole("textbox")).toBeNull();
    await user.click(
      within(question).getByRole("button", { name: "Sandboxes and credits" }),
    );
    await user.click(
      within(question).getByRole("button", { name: "Agents waiting on me" }),
    );
    await user.click(within(question).getByRole("button", { name: "Submit" }));

    expect(sent.map((request) => request.text)).toEqual([
      "Agents waiting on me, Sandboxes and credits",
    ]);
  });

  it("draws a question row written without multiSelect, as an older host writes it, as single-pick", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    session(CHANNEL_ID, [
      questionRow([
        {
          text: WATCH,
          options: ["Agents waiting on me", "Sandboxes and credits"],
          allowFreeText: true,
          settlement: null,
        },
      ]),
    ]);
    mountChannel(null);

    const question = cardQuestion(channelCard(), WATCH);
    await user.click(
      within(question).getByRole("button", { name: "Agents waiting on me" }),
    );
    await user.click(
      within(question).getByRole("button", { name: "Sandboxes and credits" }),
    );
    await user.click(within(question).getByRole("button", { name: "Submit" }));

    expect(sent.map((request) => request.text)).toEqual([
      "Sandboxes and credits",
    ]);
  });

  it("stays single-choice on a question without free text: a second pick replaces the first", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    session(CHANNEL_ID, [questionRow([deploy(null)])]);
    mountChannel(null);

    const question = cardQuestion(channelCard(), DEPLOY);
    await user.click(within(question).getByRole("button", { name: "Now" }));
    await user.click(
      within(question).getByRole("button", { name: "After the train" }),
    );
    await user.click(within(question).getByRole("button", { name: "Submit" }));

    expect(sent.map((request) => request.text)).toEqual(["After the train"]);
  });
});

describe("<BotChannelView tiles={null} /> a question a thread's session asks in its thread", () => {
  const THREAD_ID = "thread-1";
  const POST_ID = "post-1";
  const IN_THREAD_ID = "bot-question:req-thread";

  function postThread(): BotThreadSummary {
    return {
      threadId: THREAD_ID,
      conversationId: CHANNEL_ID,
      sessionChatId: "session-1",
      anchor: {
        messageId: POST_ID,
        requestId: "req-post",
        senderUserId: VIEWER_USER_ID,
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

  function memberPost(): Message {
    return {
      role: "user",
      messageId: POST_ID,
      sender: { type: "user", userId: VIEWER_USER_ID },
      message: {
        kind: "user",
        content: textDoc("Ship it?"),
        browserAnnotations: [],
      },
      timestamp: 1_000,
      sessionAnchor: null,
      conversationRequest: {
        requestId: "req-post",
        resolvedAt: null,
        resolvedByMessageId: null,
      },
    };
  }

  function threadQuestion(settlement: BotQuestionSettlement | null): Message {
    return botRow(IN_THREAD_ID, DEPLOY, [deploy(settlement)], null);
  }

  const POST_THREAD: BotOpenThread = {
    anchorMessageId: POST_ID,
    announcement: false,
    anchorKind: null,
    sent: null,
  };

  it("sends the answer into the thread, and moves an overtaken answer into the thread's own box, unsent, with the line under it", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocks.threads = [postThread()];
    session(CHANNEL_ID, [memberPost()]);
    const write = session(THREAD_ID, [threadQuestion(null)]);
    mountChannel(POST_THREAD);
    const panel = screen.getByTestId("bot-thread-replies");

    await user.click(within(panel).getByRole("button", { name: "Now" }));
    await user.click(within(panel).getByRole("button", { name: "Submit" }));

    expect(sent.map((request) => [request.threadId, request.answer])).toEqual([
      [
        THREAD_ID,
        { questionMessageId: IN_THREAD_ID, questionIndex: 0, skipped: false },
      ],
    ]);

    await user.click(within(panel).getByRole("button", { name: "Now" }));
    write([threadQuestion(byPerson(TEAMMATE_USER_ID, "After the train"))]);

    expect(onOpenThread).not.toHaveBeenCalled();
    const box = boxWithin(
      screen.getByTestId("bot-thread-panel"),
      "Reply in the thread",
    );
    expect(textOf(box)).toBe("Now");
    expect(
      screen.getByTestId("bot-thread-composer-answers-moved").textContent,
    ).toBe(
      "Tess Teammate answered first. Your answer is in the box, not sent.",
    );
    expect(textOf(channelBox())).toBe("");
    expect(sent).toHaveLength(1);
  });

  it("moves a channel question's answer once, into the channel's box, when the question's own thread is open and draws its card too", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const write = session(CHANNEL_ID, [questionRow([hold(null)])]);
    mountChannel(QUESTION_THREAD);
    await user.type(holdField(), "Hold the migration");

    write([questionRow([hold(byPerson(TEAMMATE_USER_ID, "Nothing"))])]);

    expect(textOf(channelBox())).toBe("Hold the migration");
    expect(textOf(questionThreadBox())).toBe("");
    expect(
      screen.queryByTestId("bot-thread-composer-answers-moved"),
    ).toBeNull();
    expect(channelMovedLine()).toBe(
      "Tess Teammate answered first. Your answer is in the box, not sent.",
    );
  });

  it("draws the thread's card with nothing to press on a host that negotiated bot.conversation.send 1.1", () => {
    negotiateBotSend(HOST_ID, { major: 1, minor: 1 });
    mocks.threads = [postThread()];
    session(CHANNEL_ID, [memberPost()]);
    session(THREAD_ID, [threadQuestion(null)]);
    mountChannel(POST_THREAD);

    const card = within(screen.getByTestId("bot-thread-replies")).getByTestId(
      "question-card",
    );
    expect(
      within(card)
        .getAllByRole("button")
        .filter((button) => !(button as HTMLButtonElement).disabled),
    ).toEqual([]);
    expect(sent).toEqual([]);
  });

  const REPLY_REQUEST = "req-reply";

  /** The viewer's reply in the thread, which the thread's session failed to answer. */
  function failedReply(): Message {
    return {
      role: "user",
      messageId: "reply-1",
      sender: { type: "user", userId: VIEWER_USER_ID },
      message: {
        kind: "user",
        content: textDoc("Hold for now"),
        browserAnnotations: [],
      },
      timestamp: 3_000,
      sessionAnchor: null,
      conversationRequest: {
        requestId: REPLY_REQUEST,
        resolvedAt: null,
        resolvedByMessageId: null,
      },
    };
  }

  const FAILED_ON_REPLY: BotSessionActivity = {
    state: "failed",
    startedAt: 3_000,
    step: null,
    requestId: REPLY_REQUEST,
    reason: null,
  };

  it("keeps an edit opened in the thread's box opened again, when a send from the box before it closed lands", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    heldSends = [];
    activityStore.setState({
      activity: { trunk: null, threads: { [THREAD_ID]: FAILED_ON_REPLY } },
    });
    mocks.threads = [postThread()];
    session(CHANNEL_ID, [memberPost()]);
    session(THREAD_ID, [failedReply()]);
    const view = mountChannel(POST_THREAD);
    const box = (): HTMLElement => {
      const element = boxWithin(
        screen.getByTestId("bot-thread-panel"),
        "Reply in the thread",
      );
      return element;
    };
    typeInto(box(), "Ship it today");
    await user.click(screen.getByTestId("bot-thread-composer-send"));
    view.reopen(null);
    view.reopen(POST_THREAD);
    await user.click(
      within(screen.getByTestId("bot-thread-replies")).getByTestId(
        "bot-message-edit",
      ),
    );
    expect(textOf(box())).toBe("Hold for now");

    await land();

    expect(textOf(box())).toBe("Hold for now");
    expect(screen.getByTestId("bot-thread-composer-editing")).toBeTruthy();
  });

  /**
   * The thread's box editing a failed reply while another person's settlement
   * moves the member's answer in under the edit.
   */
  async function movedUnderTheEditOfAFailedReply(): Promise<{
    readonly reopen: (next: BotOpenThread | null) => void;
  }> {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    activityStore.setState({
      activity: { trunk: null, threads: { [THREAD_ID]: FAILED_ON_REPLY } },
    });
    mocks.threads = [postThread()];
    session(CHANNEL_ID, [memberPost()]);
    const write = session(THREAD_ID, [threadQuestion(null), failedReply()]);
    const view = mountChannel(POST_THREAD);
    const replies = screen.getByTestId("bot-thread-replies");
    await user.click(within(replies).getByRole("button", { name: "Now" }));
    await user.click(within(replies).getByTestId("bot-message-edit"));

    write([
      threadQuestion(byPerson(TEAMMATE_USER_ID, "After the train")),
      failedReply(),
    ]);
    return view;
  }

  function threadBox(): HTMLElement {
    return boxWithin(
      screen.getByTestId("bot-thread-panel"),
      "Reply in the thread",
    );
  }

  it("keeps the thread's box editing the failed reply when an overtaken answer moves in under its text, and what is sent still replaces the failed reply", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await movedUnderTheEditOfAFailedReply();

    expect(
      screen.getByTestId("bot-thread-composer-editing").textContent,
    ).toContain("Sending replaces your message that failed.");
    expect(textOf(threadBox())).toBe("Hold for now\n\nNow");
    await user.click(screen.getByTestId("bot-thread-composer-send"));
    expect(
      sent.map((request) => [
        request.text,
        request.threadId,
        request.supersedes,
      ]),
    ).toEqual([["Hold for now\n\nNow", THREAD_ID, REPLY_REQUEST]]);
  });

  it("gives the moved answer back, once, in the thread's box opened again after the person left it while it edited the failed reply", async () => {
    const view = await movedUnderTheEditOfAFailedReply();

    view.reopen(null);
    view.reopen(POST_THREAD);

    expect(textOf(threadBox())).toBe("Now");
    expect(sent).toEqual([]);
  });

  it("shows the moved answer, once, in the thread's box when the person cancels the edit of the failed reply", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await movedUnderTheEditOfAFailedReply();

    await user.click(screen.getByTestId("bot-thread-composer-edit-cancel"));

    expect(screen.queryByTestId("bot-thread-composer-editing")).toBeNull();
    expect(textOf(threadBox())).toBe("Now");
  });
});
