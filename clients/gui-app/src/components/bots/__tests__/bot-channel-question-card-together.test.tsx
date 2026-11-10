/**
 * A bot's question card whose answers go together (Tracy Bots T167), through
 * the REAL `BotChannelView`: its transcript rows, the question card, the
 * thread panel, the message boxes, the `bot.conversation.send` mutation and
 * the thread list run over a host client whose messenger ENFORCES the version
 * floor a request names (`FloorEnforcingMessenger`), so a send that carries
 * `answers` to a host below 1.5 is refused before it leaves, as on the wire.
 * Only the virtualised list is replaced, as in the other question-card suite.
 *
 * What is asserted is what the person sees on the card and what the host
 * RECEIVES: on a card of two or more questions one Submit sends every open
 * question's answer or Skip as one message, while a card of one keeps its own
 * Submit and Skip; a refusal gives the drafts back; a send that ended without
 * saying whether it landed waits for the next transcript baseline, from its
 * session store or one that replaced it, then gives the drafts back or finds
 * the questions settled.
 */
import {
  botMentionHostClientMock,
  emptyBotMentionHostListsMock,
} from "@/components/bots/__tests__/bot-mention-host-test-support";
import { StrictMode } from "react";
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
import {
  HostRpcError,
  HostTransportFailureError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { botQuestionsText } from "@traycer/protocol/persistence/epic/messages";
import type {
  BotConversationSendRequest,
  BotConversationSendResponse,
  BotThreadAnchors,
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
import { botThreadListParams } from "@/hooks/bots/use-bot-thread-list-query";
import { FloorEnforcingMessenger } from "@/hooks/config/__tests__/floor-enforcing-messenger";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostQueryKeys } from "@/lib/query-keys";
import { formatMessageTime } from "@/lib/relative-time";
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
  useBotActivity: () => null,
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

import { BotChannelView } from "@/components/bots/bot-channel-view";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import type { BotOpenThread } from "@/stores/bots/bot-open-thread-store";
import type { BotMemberResolver } from "@/lib/bots/bot-member-names";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HOST_ID = "host-tab";
const ELSEWHERE_HOST_ID = "host-elsewhere";
const BOUND_EPOCH = 1;
const CHANNEL_ID = "conversation-channel";
const QUESTION_ID = "bot-question:req-q";
const QUESTION_REQUEST = "req-q";
const SET_REQUEST = "req-set";
const TEAMMATE_USER_ID = "user-teammate";

const V14: SchemaVersion = { major: 1, minor: 4 };
const V15: SchemaVersion = { major: 1, minor: 5 };

const DEPLOY = "Deploy to staging now or after the train?";
const HOLD = "Anything to hold back from the train?";
const WATCH = "What should I watch for you?";
const FIRST = "Which should I check first?";

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

/** Options and the person's own words, but one answer: a choice or words. */
function first(settlement: BotQuestionSettlement | null): BotQuestionItem {
  return {
    text: FIRST,
    options: ["Agents waiting on me", "Sandboxes and credits"],
    allowFreeText: true,
    multiSelect: false,
    settlement,
  };
}

function byPerson(
  userId: string,
  answer: string | null,
  setRequestId: string | null,
  at: number,
): BotQuestionSettlement {
  return {
    answer,
    skipped: answer === null,
    by: { kind: "person", userId },
    at,
    ...(setRequestId === null ? {} : { requestId: setRequestId }),
  };
}

const NO_IMAGES: Extract<Message, { role: "assistant" }>["imageResolutions"] =
  [];

/** Each row's blocks: the host writes a settlement on a question and leaves its blocks as they were. */
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

/** The bot's row `messageId` that asks `questions`, its text just the questions. */
function questionRowAt(
  messageId: string,
  questions: ReadonlyArray<BotQuestionItem>,
): Message {
  return {
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
    blocks: blocksOf(messageId, botQuestionsText(questions)),
    startedAt: 2_000,
    timestamp: 2_000,
    turnId: null,
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: NO_IMAGES,
    options: [],
    question: { requestId: QUESTION_REQUEST, questions: [...questions] },
  };
}

function questionRow(questions: ReadonlyArray<BotQuestionItem>): Message {
  return questionRowAt(QUESTION_ID, questions);
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

/** A chat's transcript as its session holds it. */
interface Transcript {
  /** The host writes rows, the baseline unchanged. */
  readonly write: (next: ReadonlyArray<Message>) => void;
  /** The subscription resynced: the rows as the host holds them, under a new baseline. */
  readonly resync: (next: ReadonlyArray<Message>) => void;
}

/** Each session gets the next number, as the real factory numbers each store it builds. */
let sessionsBuilt = 0;

function session(chatId: string, messages: ReadonlyArray<Message>): Transcript {
  const store = createStore(messages);
  sessionsBuilt += 1;
  mocks.handles.set(chatId, {
    sessionGeneration: sessionsBuilt,
    store,
  } as ChatSessionStoreHandle);
  let epoch = 0;
  return {
    write: (next) => act(() => store.setState({ messages: next })),
    resync: (next) => {
      epoch += 1;
      act(() =>
        store.setState({ messages: next, transcriptBaselineEpoch: epoch }),
      );
    },
  };
}

const SENT_RESPONSE: BotConversationSendResponse = {
  messageId: "message-new",
  requestId: "req-new",
  delivery: "written",
  threadId: null,
};

/** How the host answers a `bot.conversation.send`. */
type SendOutcome = () => Promise<BotConversationSendResponse>;

const landing: SendOutcome = () => Promise.resolve(SENT_RESPONSE);

function failing(error: HostRpcError): SendOutcome {
  return () => Promise.reject(error);
}

/** A send the host holds until the case lands it. */
interface HeldSend {
  readonly land: () => void;
  readonly answered: Promise<BotConversationSendResponse>;
}

let sent: ReadonlyArray<BotConversationSendRequest>;
let outcome: SendOutcome;
let heldSends: HeldSend[];
/** The thread list the bound host answers with. */
let threads: BotThreadSummary[];
let threadAnchors: BotThreadAnchors | null;
let threadListReads: number;
let messenger: FloorEnforcingMessenger<HostRpcRegistry>;

const holding: SendOutcome = () => {
  const { promise, resolve } =
    Promise.withResolvers<BotConversationSendResponse>();
  heldSends.push({
    land: () => resolve(SENT_RESPONSE),
    answered: promise,
  });
  return promise;
};

/** The host refuses with its own error envelope: the send never ran. */
function hostRefusal(
  code: "RPC_ERROR" | "E_BOT_ANSWER_SETS_UNSUPPORTED",
  message: string,
): HostRpcError {
  return new HostRpcError({
    code,
    message,
    requestId: "request-refused",
    method: "bot.conversation.send",
    fatalDetails: null,
  });
}

/** The connection dropped after the request was handed to it: the host may have run it. */
function droppedAfterSend(): HostTransportFailureError {
  return new HostTransportFailureError({
    code: "RPC_ERROR",
    message: "Lost the connection to this computer.",
    requestId: "request-dropped",
    method: "bot.conversation.send",
    fatalDetails: null,
  });
}

/**
 * Connects the tab to a host that negotiated `bot.conversation.send` at
 * `handshake`, which the card reads, while its connection enforces `enforced`:
 * the two differ for a host that fell below its handshake.
 */
function connectHost(handshake: SchemaVersion, enforced: SchemaVersion): void {
  negotiateBotSend(HOST_ID, handshake);
  const queryClient = new QueryClient();
  let seq = 0;
  messenger = new FloorEnforcingMessenger<HostRpcRegistry>(
    {
      registry: hostRpcRegistry,
      requestId: () => `request-${String(++seq)}`,
      handlers: {
        "bot.conversation.send": (params) => {
          sent = [...sent, params];
          return outcome();
        },
        "bot.thread.list": () => {
          threadListReads += 1;
          return {
            threads,
            threadAnchors,
            trunkCostUsd: null,
            nextCursor: null,
            total: 0,
          };
        },
      },
    },
    new Map([["bot.conversation.send", enforced]]),
  );
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
  mocks.client = spine.createRequester(mockRemoteHostEntry);
}

/** What the bound host says it takes, for the binding the channel knows. */
function boundHostSays(kinds: readonly string[]): BotThreadAnchors {
  return { hostId: ELSEWHERE_HOST_ID, epoch: BOUND_EPOCH, kinds: [...kinds] };
}

/** The host takes the oldest send held. */
async function land(): Promise<void> {
  const next = heldSends.shift();
  if (next === undefined) throw new Error("no send is held");
  await act(async () => {
    next.land();
    await next.answered;
  });
}

/** Lets what the last click set going run to its end. */
async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

function mountChannel(args: {
  /** The host that runs the bot; the tab's host is another. */
  readonly boundHostId: string | null;
  readonly openThread: BotOpenThread | null;
}): void {
  const queryClient = new QueryClient();
  // The thread list is read before the first render, as it is on a channel
  // already open, so the card's reach is not decided by a read in flight.
  queryClient.setQueryData(
    hostQueryKeys.method<HostRpcRegistry, "bot.thread.list">(
      mockRemoteHostEntry.hostId,
      "bot.thread.list",
      botThreadListParams(BOT_ID),
    ),
    { threads, threadAnchors, nextCursor: null, total: 0 },
  );
  render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BotTestRunnerHost>
          <TooltipProvider>
            <ChatExpansionTestProviders tileInstanceId="tile-1">
              <BotChannelView
                tiles={null}
                botId={BOT_ID}
                hostId={HOST_ID}
                boundHostId={args.boundHostId}
                boundHostEpoch={BOUND_EPOCH}
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
                openThread={args.openThread}
                onOpenThread={vi.fn()}
                setupHistory={null}
              />
            </ChatExpansionTestProviders>
          </TooltipProvider>
        </BotTestRunnerHost>
      </QueryClientProvider>
    </StrictMode>,
  );
}

/** The bot runs on the tab's host. */
function mountOnTabHost(): void {
  mountChannel({ boundHostId: HOST_ID, openThread: null });
}

/** The card in the channel, apart from the copy an open thread's post draws. */
function channelCard(): HTMLElement {
  return within(screen.getByTestId("bot-channel")).getByTestId("question-card");
}

function cardQuestion(card: HTMLElement, text: string): HTMLElement {
  return within(card).getByRole("region", { name: text });
}

function choice(question: HTMLElement, name: string): HTMLButtonElement {
  return buttonOf(within(question).getByRole("button", { name }));
}

function answerField(question: HTMLElement): HTMLTextAreaElement {
  const field = within(question).getByRole("textbox", { name: "Your answer" });
  if (!(field instanceof HTMLTextAreaElement)) throw new Error("no field");
  return field;
}

function buttonOf(element: HTMLElement): HTMLButtonElement {
  if (!(element instanceof HTMLButtonElement)) throw new Error("no button");
  return element;
}

/** The card's one Submit. */
function submitButton(card: HTMLElement): HTMLButtonElement {
  return buttonOf(within(card).getByTestId("question-card-submit"));
}

function tally(card: HTMLElement): string | null {
  return within(card).getByTestId("question-card-tally").textContent;
}

/** What the card offers: how many Submits, the foot's tally, and each question's skip. */
function formOf(card: HTMLElement): {
  readonly submits: number;
  readonly tally: string | null;
  readonly skips: ReadonlyArray<string | null>;
} {
  const foot = within(card).queryByTestId("question-card-tally");
  return {
    submits: within(card).getAllByTestId("question-card-submit").length,
    tally: foot === null ? null : foot.textContent,
    skips: within(card)
      .getAllByTestId("question-card-skip")
      .map((skip) => skip.textContent),
  };
}

/** The controls of an open card that a person can act on right now. */
function enabledControls(card: HTMLElement): HTMLElement[] {
  return [
    ...within(card).getAllByRole("button"),
    ...within(card).queryAllByRole("textbox"),
  ].filter((control) => !(control as HTMLButtonElement).disabled);
}

// sonner, vaul and react-zoom-pan-pinch insert their stylesheets on import, and
// no element this file draws matches a rule in them. jsdom still runs every
// rule against an element and each of its ancestors whenever a DOM change
// drops its style cache, which every role query and click here pays.
beforeAll(() => {
  for (const style of document.head.querySelectorAll("style")) style.remove();
});

beforeEach(() => {
  installLegendListTestClock();
  sent = [];
  outcome = landing;
  heldSends = [];
  threads = [];
  threadAnchors = null;
  threadListReads = 0;
  mocks.handles.clear();
  rowBlocks.clear();
  useBotDraftsStore.setState({ answers: {}, threadBoxes: {} });
  connectHost(V15, V15);
  signInViewer(VIEWER_USER_ID);
});

afterEach(async () => {
  cleanup();
  // Let Tiptap complete its deferred unmount destruction before restoring the clock.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  resetBotFailedRequestSupport();
  mocks.handles.clear();
  mocks.client = null;
});

describe("<BotChannelView tiles={null} /> where a card's answers go together, and where one by one", () => {
  it.each([
    {
      name: "each question's own Submit on a tab host at 1.4, whatever the bot's host says it takes",
      handshake: V14,
      boundHostId: ELSEWHERE_HOST_ID,
      kinds: ["answer", "answers"],
      together: false,
    },
    {
      name: "one Submit on a tab host at 1.5 that runs the bot, with nothing said by the bot's host",
      handshake: V15,
      boundHostId: HOST_ID,
      kinds: [],
      together: true,
    },
    {
      name: "each question's own Submit on a tab host at 1.5 with the bot on another host that does not list answers",
      handshake: V15,
      boundHostId: ELSEWHERE_HOST_ID,
      kinds: ["answer"],
      together: false,
    },
    {
      name: "one Submit on a tab host at 1.5 with the bot on another host that lists answers",
      handshake: V15,
      boundHostId: ELSEWHERE_HOST_ID,
      kinds: ["answer", "answers"],
      together: true,
    },
  ])("draws $name", ({ handshake, boundHostId, kinds, together }) => {
    connectHost(handshake, handshake);
    threadAnchors = boundHostSays(kinds);
    session(CHANNEL_ID, [questionRow([deploy(null), hold(null)])]);
    mountChannel({ boundHostId, openThread: null });

    expect(formOf(channelCard())).toEqual(
      together
        ? {
            submits: 1,
            tally: "0 of 2 answered. Answer or skip each one to submit.",
            skips: ["Skip this question", "Skip this question"],
          }
        : { submits: 2, tally: null, skips: ["Skip", "Skip"] },
    );
  });

  it("sends each answer on its own, never a set, from a card on a tab host at 1.4", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    connectHost(V14, V14);
    session(CHANNEL_ID, [questionRow([deploy(null), hold(null)])]);
    mountOnTabHost();

    const card = channelCard();
    await user.click(choice(cardQuestion(card, DEPLOY), "After the train"));
    await user.click(
      within(cardQuestion(card, DEPLOY)).getByTestId("question-card-submit"),
    );
    await user.type(
      answerField(cardQuestion(card, HOLD)),
      "Hold the migration",
    );
    await user.click(
      within(cardQuestion(card, HOLD)).getByTestId("question-card-submit"),
    );

    expect(sent.map((request) => [request.text, request.answer])).toEqual([
      [
        "After the train",
        { questionMessageId: QUESTION_ID, questionIndex: 0, skipped: false },
      ],
      [
        "Hold the migration",
        { questionMessageId: QUESTION_ID, questionIndex: 1, skipped: false },
      ],
    ]);
    expect(sent.map((request) => request.answers)).toEqual([
      undefined,
      undefined,
    ]);
  });
});

describe("<BotChannelView tiles={null} /> a card of one question, on a host that takes answers together", () => {
  it("keeps the question's own Submit and no tally, and sends its answer on its own, never as a set", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    session(CHANNEL_ID, [questionRow([deploy(null)])]);
    mountOnTabHost();

    const card = channelCard();
    expect(formOf(card)).toEqual({ submits: 1, tally: null, skips: ["Skip"] });
    const question = cardQuestion(card, DEPLOY);
    await user.click(choice(question, "After the train"));
    await user.click(within(question).getByTestId("question-card-submit"));

    expect(sent.map((request) => [request.text, request.answer])).toEqual([
      [
        "After the train",
        { questionMessageId: QUESTION_ID, questionIndex: 0, skipped: false },
      ],
    ]);
    expect(sent.map((request) => request.answers)).toEqual([undefined]);
  });

  it("sends the question's own Skip at once, as a skipped answer, never as a set", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    session(CHANNEL_ID, [questionRow([deploy(null)])]);
    mountOnTabHost();

    await user.click(
      within(cardQuestion(channelCard(), DEPLOY)).getByTestId(
        "question-card-skip",
      ),
    );

    expect(sent.map((request) => [request.text, request.answer])).toEqual([
      [
        "Skipped",
        { questionMessageId: QUESTION_ID, questionIndex: 0, skipped: true },
      ],
    ]);
    expect(sent.map((request) => request.answers)).toEqual([undefined]);
  });
});

describe("<BotChannelView tiles={null} /> a card whose answers go together", () => {
  it("counts only the questions still open, says the bot's settlement of the others, and holds Submit until every open one is answered or skipped", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    session(CHANNEL_ID, [
      questionRow([
        deploy({
          answer: "Now",
          skipped: false,
          by: { kind: "bot" },
          at: 4_000,
        }),
        hold(null),
        watch(null),
      ]),
    ]);
    mountOnTabHost();
    const card = channelCard();

    expect(
      within(cardQuestion(card, DEPLOY)).getByTestId("question-card-settlement")
        .textContent,
    ).toBe("Settled by Release Bot: Now");
    expect(within(cardQuestion(card, DEPLOY)).queryAllByRole("button")).toEqual(
      [],
    );
    expect(tally(card)).toBe(
      "0 of 2 answered. Answer or skip each one to submit.",
    );
    expect(submitButton(card).disabled).toBe(true);

    await user.type(
      answerField(cardQuestion(card, HOLD)),
      "Hold the migration",
    );
    expect(tally(card)).toBe(
      "1 of 2 answered. Answer or skip the last one to submit.",
    );
    expect(submitButton(card).disabled).toBe(true);

    await user.click(
      within(cardQuestion(card, WATCH)).getByRole("button", {
        name: "Skip this question",
      }),
    );
    expect(tally(card)).toBe("2 of 2 answered.");
    expect(submitButton(card).disabled).toBe(false);
    // A skipped question takes no answer until it is answered after all.
    expect(answerField(cardQuestion(card, WATCH)).disabled).toBe(true);
    expect(choice(cardQuestion(card, WATCH), "Nothing yet").disabled).toBe(
      true,
    );

    await user.click(
      within(cardQuestion(card, WATCH)).getByRole("button", {
        name: "Skip this question",
        pressed: true,
      }),
    );
    expect(tally(card)).toBe(
      "1 of 2 answered. Answer or skip the last one to submit.",
    );
    expect(submitButton(card).disabled).toBe(true);
    expect(answerField(cardQuestion(card, WATCH)).disabled).toBe(false);
  });

  it("sends ONE message with every open question's answer: picks in option order, trimmed words, a skip as skipped, and no answer of its own", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    session(CHANNEL_ID, [questionRow([deploy(null), hold(null), watch(null)])]);
    mountOnTabHost();
    const card = channelCard();
    expect(tally(card)).toBe(
      "0 of 3 answered. Answer or skip each one to submit.",
    );

    await user.click(choice(cardQuestion(card, DEPLOY), "After the train"));
    expect(tally(card)).toBe(
      "1 of 3 answered. Answer or skip the other 2 to submit.",
    );
    // Words typed under a question that is then skipped are not sent.
    await user.type(
      answerField(cardQuestion(card, HOLD)),
      "Hold the migration",
    );
    await user.click(
      within(cardQuestion(card, HOLD)).getByRole("button", {
        name: "Skip this question",
      }),
    );
    await user.click(
      choice(cardQuestion(card, WATCH), "Sandboxes and credits"),
    );
    await user.click(choice(cardQuestion(card, WATCH), "Agents waiting on me"));
    await user.type(
      answerField(cardQuestion(card, WATCH)),
      "  the build farm  ",
    );
    expect(tally(card)).toBe("3 of 3 answered.");
    await user.click(submitButton(card));

    expect(sent).toEqual([
      {
        botId: BOT_ID,
        conversationId: CHANNEL_ID,
        text: `${DEPLOY}\nAfter the train\n\n${HOLD}\nSkipped\n\n${WATCH}\nAgents waiting on me, Sandboxes and credits, the build farm`,
        threadId: null,
        announcementId: null,
        redeliver: null,
        supersedes: null,
        answer: null,
        answers: {
          questionMessageId: QUESTION_ID,
          entries: [
            {
              questionIndex: 0,
              skipped: false,
              selected: ["After the train"],
              text: null,
            },
            { questionIndex: 1, skipped: true, selected: [], text: null },
            {
              questionIndex: 2,
              skipped: false,
              selected: ["Agents waiting on me", "Sandboxes and credits"],
              text: "the build farm",
            },
          ],
        },
      },
    ]);
  });

  it("holds the whole card, its inputs and Submit, with the spinner until the room settles the questions, and then shows who answered, once", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    outcome = holding;
    const transcript = session(CHANNEL_ID, [
      questionRow([deploy(null), hold(null)]),
    ]);
    mountOnTabHost();
    const card = channelCard();
    await user.click(choice(cardQuestion(card, DEPLOY), "Now"));
    await user.type(
      answerField(cardQuestion(card, HOLD)),
      "Hold the migration",
    );
    await user.click(submitButton(card));

    expect(sent).toHaveLength(1);
    expect(within(card).getAllByTestId("question-card-sending")).toHaveLength(
      1,
    );
    expect(enabledControls(card)).toEqual([]);
    expect(
      choice(cardQuestion(card, DEPLOY), "Now").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(answerField(cardQuestion(card, HOLD)).value).toBe(
      "Hold the migration",
    );

    // The host took the message; the card waits for the settlements, which are what close it.
    await land();
    expect(within(card).getAllByTestId("question-card-sending")).toHaveLength(
      1,
    );
    const at = Date.now();
    transcript.write([
      questionRow([
        deploy(byPerson(VIEWER_USER_ID, "Now", SET_REQUEST, at)),
        hold(byPerson(VIEWER_USER_ID, "Hold the migration", SET_REQUEST, at)),
      ]),
    ]);

    const settled = channelCard();
    expect(
      within(settled)
        .getAllByTestId("question-card-settlement")
        .map((line) => line.textContent),
    ).toEqual(["Now", "Hold the migration"]);
    expect(
      within(settled).getByTestId("question-card-answered-by").textContent,
    ).toBe(`Answered by Olive Owner · ${formatMessageTime(at, Date.now())}`);
    expect(within(settled).queryAllByRole("button")).toEqual([]);
    expect(useBotDraftsStore.getState().answers).toEqual({});
  });
});

describe("<BotChannelView tiles={null} /> a card's answers the host refused", () => {
  /** The card's two questions answered, and Submit pressed. */
  async function answerTwo(): Promise<void> {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const card = channelCard();
    await user.click(choice(cardQuestion(card, DEPLOY), "After the train"));
    await user.type(
      answerField(cardQuestion(card, HOLD)),
      "Hold the migration",
    );
    await user.click(submitButton(card));
    await settle();
  }

  it("gives every draft back to edit when the host answers with an error: nothing picked or typed is lost, and sending again carries the same set", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    outcome = failing(
      hostRefusal(
        "RPC_ERROR",
        "QUESTION_ALREADY_SETTLED: the question is settled",
      ),
    );
    session(CHANNEL_ID, [questionRow([deploy(null), hold(null)])]);
    mountOnTabHost();

    await answerTwo();

    const card = channelCard();
    expect(sent).toHaveLength(1);
    expect(within(card).queryByTestId("question-card-sending")).toBeNull();
    expect(
      choice(cardQuestion(card, DEPLOY), "After the train").getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
    expect(answerField(cardQuestion(card, HOLD)).value).toBe(
      "Hold the migration",
    );
    expect(answerField(cardQuestion(card, HOLD)).disabled).toBe(false);
    expect(choice(cardQuestion(card, DEPLOY), "Now").disabled).toBe(false);
    expect(submitButton(card).disabled).toBe(false);

    outcome = landing;
    await user.click(submitButton(card));
    expect(sent).toHaveLength(2);
    expect(sent[1]?.answers).toEqual(sent[0]?.answers);
  });

  it("gives the drafts back, reads the thread list again, and draws each question's own Submit once the bot's host no longer lists answers", async () => {
    threadAnchors = boundHostSays(["answer", "answers"]);
    outcome = failing(
      hostRefusal(
        "E_BOT_ANSWER_SETS_UNSUPPORTED",
        "The bot's host does not take answers together",
      ),
    );
    session(CHANNEL_ID, [questionRow([deploy(null), hold(null)])]);
    mountChannel({ boundHostId: ELSEWHERE_HOST_ID, openThread: null });
    await settle();
    expect(formOf(channelCard()).submits).toBe(1);
    const readsBefore = threadListReads;
    // What the bot's host says when the list is read again.
    threadAnchors = boundHostSays(["answer"]);

    await answerTwo();

    const card = channelCard();
    expect(sent).toHaveLength(1);
    expect(threadListReads).toBe(readsBefore + 1);
    expect(formOf(card)).toEqual({
      submits: 2,
      tally: null,
      skips: ["Skip", "Skip"],
    });
    expect(
      choice(cardQuestion(card, DEPLOY), "After the train").getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
    expect(answerField(cardQuestion(card, HOLD)).value).toBe(
      "Hold the migration",
    );
    expect(
      buttonOf(
        within(cardQuestion(card, HOLD)).getByTestId("question-card-submit"),
      ).disabled,
    ).toBe(false);
  });

  it("refuses a set before it leaves when the host has fallen below 1.5 since the handshake, and gives the drafts back", async () => {
    connectHost(V15, V14);
    session(CHANNEL_ID, [questionRow([deploy(null), hold(null)])]);
    mountOnTabHost();

    await answerTwo();

    const card = channelCard();
    expect(messenger.dispatched).not.toContain("bot.conversation.send");
    expect(sent).toEqual([]);
    expect(within(card).queryByTestId("question-card-sending")).toBeNull();
    expect(submitButton(card).disabled).toBe(false);
    expect(answerField(cardQuestion(card, HOLD)).value).toBe(
      "Hold the migration",
    );
  });
});

describe("<BotChannelView tiles={null} /> a card's answers whose send ended without saying whether the host took them", () => {
  const OPEN_TWO = (): Message => questionRow([deploy(null), hold(null)]);

  async function sendTwoThatDrop(): Promise<Transcript> {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    outcome = failing(droppedAfterSend());
    const transcript = session(CHANNEL_ID, [OPEN_TWO()]);
    mountOnTabHost();
    const card = channelCard();
    await user.click(choice(cardQuestion(card, DEPLOY), "After the train"));
    await user.type(
      answerField(cardQuestion(card, HOLD)),
      "Hold the migration",
    );
    await user.click(submitButton(card));
    await settle();
    return transcript;
  }

  it("keeps the card waiting, sending nothing again, through rows that change nothing of the baseline, and gives the drafts back, intact, once a resync shows the questions still open", async () => {
    const transcript = await sendTwoThatDrop();
    const card = channelCard();

    expect(sent).toHaveLength(1);
    expect(within(card).getAllByTestId("question-card-sending")).toHaveLength(
      1,
    );
    expect(enabledControls(card)).toEqual([]);

    transcript.write([OPEN_TWO()]);
    expect(
      within(channelCard()).getAllByTestId("question-card-sending"),
    ).toHaveLength(1);

    transcript.resync([OPEN_TWO()]);

    const reopened = channelCard();
    expect(within(reopened).queryByTestId("question-card-sending")).toBeNull();
    expect(
      choice(cardQuestion(reopened, DEPLOY), "After the train").getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
    expect(answerField(cardQuestion(reopened, HOLD)).value).toBe(
      "Hold the migration",
    );
    expect(answerField(cardQuestion(reopened, HOLD)).disabled).toBe(false);
    expect(submitButton(reopened).disabled).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it("shows the card settled, and spends the drafts, when the resync shows the viewer's set landed", async () => {
    const transcript = await sendTwoThatDrop();
    const at = Date.now();

    transcript.resync([
      questionRow([
        deploy(byPerson(VIEWER_USER_ID, "After the train", SET_REQUEST, at)),
        hold(byPerson(VIEWER_USER_ID, "Hold the migration", SET_REQUEST, at)),
      ]),
    ]);

    const card = channelCard();
    expect(
      within(card)
        .getAllByTestId("question-card-settlement")
        .map((line) => line.textContent),
    ).toEqual(["After the train", "Hold the migration"]);
    expect(
      within(card).getByTestId("question-card-answered-by").textContent,
    ).toBe(`Answered by Olive Owner · ${formatMessageTime(at, Date.now())}`);
    expect(within(card).queryAllByRole("button")).toEqual([]);
    expect(useBotDraftsStore.getState().answers).toEqual({});
    expect(sent).toHaveLength(1);
  });
});

describe("<BotChannelView tiles={null} /> a card's answers held while the channel's session store is replaced", () => {
  const OPEN_THREE = (): Message =>
    questionRow([deploy(null), hold(null), watch(null)]);

  /** A pick, words and a skip, then Submit, on a card of three open questions. */
  async function answerThreeAndSubmit(): Promise<void> {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const card = channelCard();
    await user.click(choice(cardQuestion(card, DEPLOY), "After the train"));
    await user.type(
      answerField(cardQuestion(card, HOLD)),
      "Hold the migration",
    );
    await user.click(
      within(cardQuestion(card, WATCH)).getByTestId("question-card-skip"),
    );
    await user.click(submitButton(card));
    await settle();
  }

  /**
   * The channel unmounts, as a switch away long enough for the registry to
   * evict its idle session does, and mounts again on a session built anew: a
   * new handle over a new store whose baseline is back at the same number.
   */
  async function returnToANewSession(): Promise<void> {
    const evicted = mocks.handles.get(CHANNEL_ID);
    cleanup();
    await settle();
    session(CHANNEL_ID, [OPEN_THREE()]);
    const replacement = mocks.handles.get(CHANNEL_ID);
    expect(replacement).not.toBe(evicted);
    expect(replacement?.sessionGeneration).not.toBe(evicted?.sessionGeneration);
    expect(
      [evicted, replacement].map(
        (handle) => handle?.store.getState().transcriptBaselineEpoch,
      ),
    ).toEqual([0, 0]);
    mountOnTabHost();
  }

  it("gives every draft back, intact, once the new session shows the questions still open, though its baseline is the number the old one's was, and sends nothing again", async () => {
    outcome = failing(droppedAfterSend());
    session(CHANNEL_ID, [OPEN_THREE()]);
    mountOnTabHost();
    await answerThreeAndSubmit();
    expect(sent).toHaveLength(1);
    expect(
      within(channelCard()).getAllByTestId("question-card-sending"),
    ).toHaveLength(1);
    expect(enabledControls(channelCard())).toEqual([]);

    await returnToANewSession();

    const card = channelCard();
    expect(within(card).queryByTestId("question-card-sending")).toBeNull();
    expect(
      choice(cardQuestion(card, DEPLOY), "After the train").getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
    expect(answerField(cardQuestion(card, HOLD)).value).toBe(
      "Hold the migration",
    );
    expect(answerField(cardQuestion(card, HOLD)).disabled).toBe(false);
    const skipped = buttonOf(
      within(cardQuestion(card, WATCH)).getByTestId("question-card-skip"),
    );
    expect(skipped.getAttribute("aria-pressed")).toBe("true");
    expect(skipped.disabled).toBe(false);
    expect(tally(card)).toBe("3 of 3 answered.");
    expect(submitButton(card).disabled).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it("keeps a send still in flight holding the card, and sends nothing again, when the new session's first snapshot arrives", async () => {
    outcome = holding;
    session(CHANNEL_ID, [OPEN_THREE()]);
    mountOnTabHost();
    await answerThreeAndSubmit();
    expect(sent).toHaveLength(1);

    await returnToANewSession();

    const card = channelCard();
    expect(within(card).getAllByTestId("question-card-sending")).toHaveLength(
      1,
    );
    expect(enabledControls(card)).toEqual([]);
    expect(sent).toHaveLength(1);
  });
});

describe("<BotChannelView tiles={null} /> a card settled by a member's answers", () => {
  it("shows each answer or Skipped, and who answered with when, once, when one set settled every question", () => {
    const at = Date.now();
    const settledBy = (answer: string | null): BotQuestionSettlement =>
      byPerson(TEAMMATE_USER_ID, answer, SET_REQUEST, at);
    session(CHANNEL_ID, [
      questionRow([
        deploy(settledBy("After the train")),
        hold(settledBy(null)),
        watch(settledBy("Agents waiting on me, the build farm")),
      ]),
    ]);
    mountOnTabHost();

    const card = channelCard();
    expect(
      within(card)
        .getAllByTestId("question-card-settlement")
        .map((line) => line.textContent),
    ).toEqual([
      "After the train",
      "Skipped",
      "Agents waiting on me, the build farm",
    ]);
    expect(
      within(card)
        .getAllByTestId("question-card-answered-by")
        .map((line) => line.textContent),
    ).toEqual([
      `Answered by Tess Teammate · ${formatMessageTime(at, Date.now())}`,
    ]);
    expect(within(card).queryAllByRole("button")).toEqual([]);
  });

  it("keeps each question's own line, with no footer, when the same member answered them in different messages", () => {
    const at = Date.now();
    session(CHANNEL_ID, [
      questionRow([
        deploy(byPerson(VIEWER_USER_ID, "After the train", SET_REQUEST, at)),
        hold(byPerson(VIEWER_USER_ID, "Nothing", null, at)),
      ]),
    ]);
    mountOnTabHost();

    const card = channelCard();
    expect(
      within(card)
        .getAllByTestId("question-card-settlement")
        .map((line) => line.textContent),
    ).toEqual([
      "Answered by Olive Owner: After the train",
      "Answered by Olive Owner: Nothing",
    ]);
    expect(within(card).queryByTestId("question-card-answered-by")).toBeNull();
  });

  it("draws the member's row as each question with its answer, or Skipped, in place of the row's text", () => {
    session(CHANNEL_ID, [
      {
        role: "user",
        messageId: `conversation-request:${SET_REQUEST}`,
        sender: { type: "user", userId: VIEWER_USER_ID },
        message: {
          kind: "user",
          content: textDoc("The older client's plain text of these answers"),
          browserAnnotations: [],
        },
        timestamp: 3_000,
        sessionAnchor: null,
        conversationRequest: {
          requestId: SET_REQUEST,
          resolvedAt: null,
          resolvedByMessageId: null,
        },
        questionAnswers: {
          questionMessageId: QUESTION_ID,
          answers: [
            {
              questionIndex: 0,
              question: DEPLOY,
              answer: "After the train",
              skipped: false,
            },
            { questionIndex: 1, question: HOLD, answer: null, skipped: true },
          ],
        },
      },
    ]);
    mountOnTabHost();

    const list = within(screen.getByTestId("bot-channel")).getByTestId(
      "bot-question-answers",
    );
    expect(
      Array.from(list.querySelectorAll("dt, dd")).map(
        (node) => node.textContent,
      ),
    ).toEqual([DEPLOY, "After the train", HOLD, "Skipped"]);
    expect(
      screen.queryByText("The older client's plain text of these answers"),
    ).toBeNull();
  });
});

describe("<BotChannelView tiles={null} /> a question that takes one answer, or several", () => {
  it("takes a choice or words on a single-pick question, each clearing the other, and a few spaces clear nothing", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    session(CHANNEL_ID, [questionRow([first(null), watch(null)])]);
    mountOnTabHost();
    const question = cardQuestion(channelCard(), FIRST);
    const pressed = (name: string): string | null =>
      choice(question, name).getAttribute("aria-pressed");

    await user.type(answerField(question), "the build farm");
    await user.click(choice(question, "Agents waiting on me"));
    expect(answerField(question).value).toBe("");
    expect(pressed("Agents waiting on me")).toBe("true");

    await user.type(answerField(question), "the build farm");
    expect(pressed("Agents waiting on me")).toBe("false");
    expect(answerField(question).value).toBe("the build farm");

    await user.click(choice(question, "Sandboxes and credits"));
    expect(answerField(question).value).toBe("");
    await user.type(answerField(question), "  ");
    expect(pressed("Sandboxes and credits")).toBe("true");
    expect(within(question).queryByText("Choose any.")).toBeNull();
    expect(sent).toEqual([]);
  });

  it("keeps the picks and the words together on a question that takes several, and says Choose any.", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    session(CHANNEL_ID, [questionRow([first(null), watch(null)])]);
    mountOnTabHost();
    const question = cardQuestion(channelCard(), WATCH);

    await user.click(choice(question, "Agents waiting on me"));
    await user.click(choice(question, "Nothing yet"));
    await user.type(answerField(question), "the build farm");

    expect(within(question).getByText("Choose any.")).toBeTruthy();
    expect(
      within(question)
        .getAllByTestId("question-card-option")
        .map((option) => option.getAttribute("aria-pressed")),
    ).toEqual(["true", "false", "true"]);
    expect(answerField(question).value).toBe("the build farm");
  });
});

describe("<BotChannelView tiles={null} /> a question a thread's session asks in its thread, whose answers go together", () => {
  const THREAD_ID = "thread-1";
  const POST_ID = "post-1";
  const IN_THREAD_ID = "bot-question:req-thread";
  const POST_THREAD: BotOpenThread = {
    anchorMessageId: POST_ID,
    announcement: false,
    anchorKind: null,
    sent: null,
  };

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

  it("sends the answers as one message into the thread, under its id", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    threads = [postThread()];
    session(CHANNEL_ID, [memberPost()]);
    session(THREAD_ID, [
      questionRowAt(IN_THREAD_ID, [deploy(null), hold(null)]),
    ]);
    mountChannel({ boundHostId: HOST_ID, openThread: POST_THREAD });

    const card = within(screen.getByTestId("bot-thread-replies")).getByTestId(
      "question-card",
    );
    await user.click(choice(cardQuestion(card, DEPLOY), "Now"));
    await user.click(
      within(cardQuestion(card, HOLD)).getByRole("button", {
        name: "Skip this question",
      }),
    );
    await user.click(submitButton(card));

    expect(sent).toEqual([
      {
        botId: BOT_ID,
        conversationId: CHANNEL_ID,
        text: `${DEPLOY}\nNow\n\n${HOLD}\nSkipped`,
        threadId: THREAD_ID,
        announcementId: null,
        redeliver: null,
        supersedes: null,
        answer: null,
        answers: {
          questionMessageId: IN_THREAD_ID,
          entries: [
            {
              questionIndex: 0,
              skipped: false,
              selected: ["Now"],
              text: null,
            },
            { questionIndex: 1, skipped: true, selected: [], text: null },
          ],
        },
      },
    ]);
  });
});
