/**
 * The question card through the REAL `BotChannelView`: its transcript rows,
 * the question card, the thread panel, the message boxes and the
 * `bot.conversation.send` mutation run over a host client whose messenger
 * records the request that leaves. Only the virtualised list is replaced, as
 * in the failed-answer suite.
 *
 * The `bot-channel-question-card*.test.tsx` files share what is here: the
 * fixtures, the host, the tree and the per-case lifecycle. Their `vi.mock`
 * calls read `bot-channel-question-card-state.ts` and
 * `bot-channel-question-card-mocks.tsx`.
 */
import { StrictMode, type ReactNode } from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BotTestRunnerHost } from "@/components/bots/__tests__/bot-test-runner-host";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { afterEach, beforeAll, beforeEach, vi } from "vitest";
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
import type {
  BotConversationSendDelivery,
  BotConversationSendRequest,
  BotConversationSendResponse,
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
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import type {
  ChatSessionState,
  ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { emptyTranscriptWindow } from "@/stores/chats/transcript-window";
import { BotChannelView } from "@/components/bots/bot-channel-view";
import { BotDraftsPersistLifecycleBridge } from "@/providers/bot-drafts-persist-lifecycle-bridge";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import type { BotOpenThread } from "@/stores/bots/bot-open-thread-store";
import type { BotMemberResolver } from "@/lib/bots/bot-member-names";
import { boxInput } from "@/components/bots/__tests__/bot-box-test-support";
import { activityStore, mocks } from "./bot-channel-question-card-state";

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

export const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const HOST_ID = "host-tab";
export const CHANNEL_ID = "conversation-channel";
export const QUESTION_ID = "bot-question:req-q";
const QUESTION_REQUEST = "req-q";
export const DEPLOY = "Deploy to staging now or after the train?";
export const HOLD = "Anything to hold back from the train?";
export const TEAMMATE_USER_ID = "user-teammate";

const resolveMember: BotMemberResolver = (userId) =>
  userId === TEAMMATE_USER_ID
    ? { displayName: "Tess Teammate", avatarUrl: null }
    : null;

export function deploy(
  settlement: BotQuestionSettlement | null,
): BotQuestionItem {
  return {
    text: DEPLOY,
    options: ["Now", "After the train"],
    allowFreeText: false,
    settlement,
  };
}

export function hold(
  settlement: BotQuestionSettlement | null,
): BotQuestionItem {
  return { text: HOLD, options: [], allowFreeText: true, settlement };
}

export const WATCH = "What should I watch for you?";

/** Options and the person's own words: the card takes several of the options. */
export function watch(
  settlement: BotQuestionSettlement | null,
): BotQuestionItem {
  return {
    text: WATCH,
    options: ["Agents waiting on me", "Sandboxes and credits", "Nothing yet"],
    allowFreeText: true,
    multiSelect: true,
    settlement,
  };
}

export function byPerson(
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
export function botRow(
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

export function questionRow(
  questions: ReadonlyArray<BotQuestionItem>,
): Message {
  return botRow(QUESTION_ID, DEPLOY, questions, null);
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

// The host fake's switches and readouts stay here even where one file uses them: the fake reads them, and the shared lifecycle resets them.
export let sent: ReadonlyArray<BotConversationSendRequest>;
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
export let heldSends: HeldSend[] | null;
export const onOpenThread = vi.fn<(open: BotOpenThread | null) => void>();

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
export let sendAttempts: number;

export function setRefuseSends(refused: boolean): void {
  refuseSends = refused;
}

export function setDelivery(next: BotConversationSendDelivery): void {
  delivery = next;
}

export function setHeldSends(held: HeldSend[] | null): void {
  heldSends = held;
}

export function setRefusalKind(kind: "plain" | "coded"): void {
  refusalKind = kind;
}

export function setFatalFirstSend(fatal: boolean): void {
  fatalFirstSend = fatal;
}

export function setIdentityBridge(bridged: boolean): void {
  identityBridge = bridged;
}

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

export function hostClientRecordingSends(): HostRequester<HostRpcRegistry> {
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
    // The send leaves as the signed-in viewer.
    identity: {
      userId: VIEWER_USER_ID,
      username: "olive",
      providerHandle: null,
    },
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
  hostSpine = spine;
  return spine.createRequester(mockRemoteHostEntry);
}

/** The host client's spine the case sends through, whose request context follows the signed-in account. */
export let hostSpine: HostClient<HostRpcRegistry> | null = null;

/** The host refuses the oldest send held. */
export async function refuse(): Promise<void> {
  const next = heldSends?.shift();
  if (next === undefined) throw new Error("no send is held");
  await act(async () => {
    next.refuse();
    await next.answered.catch(() => undefined);
  });
}

/** A chat's transcript as its session holds it; `set` writes rows as the host does. */
export function session(
  chatId: string,
  messages: ReadonlyArray<Message>,
): (next: ReadonlyArray<Message>) => void {
  const store = createStore(messages);
  mocks.handles.set(chatId, { store } as ChatSessionStoreHandle);
  return (next) => act(() => store.setState({ messages: next }));
}

export function mountChannel(openThread: BotOpenThread | null): {
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
                replyMode="direct"
                tiles={null}
                botId={BOT_ID}
                hostId={HOST_ID}
                boundHostId={HOST_ID}
                boundHostEpoch={1}
                onBindingMoved={vi.fn()}
                botTitle="Release Bot"
                directive={null}
                appConversationChatId={CHANNEL_ID}
                trunkChatId="trunk-chat"
                onOpenTurn={vi.fn()}
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
export function channelCard(): HTMLElement {
  return within(screen.getByTestId("bot-channel")).getByTestId("question-card");
}

export function cardQuestion(card: HTMLElement, text: string): HTMLElement {
  return within(card).getByRole("region", { name: text });
}

/** The channel's box, where an answer overtaken on a card asked at the channel's top level moves. */
export function channelBox(): HTMLElement {
  return boxInput("Message Release Bot");
}

/** What the channel's box says under it once answers moved there. */
export function channelMovedLine(): string | undefined {
  return screen.queryByTestId("bot-channel-composer-answers-moved")
    ?.textContent;
}

/** What a settled question's card line says, for the question named. */
export function settlementLine(
  card: HTMLElement,
  text: string,
): string | undefined {
  return within(cardQuestion(card, text)).getByTestId(
    "question-card-settlement",
  ).textContent;
}

/** The answer field of the card's question that takes words. */
export function holdField(): HTMLTextAreaElement {
  const field = within(cardQuestion(channelCard(), HOLD)).getByRole("textbox", {
    name: "Your answer",
  });
  if (!(field instanceof HTMLTextAreaElement)) throw new Error("no field");
  return field;
}

/**
 * Registers the per-case setup and teardown of the question-card cases. A test
 * file calls it once at its top level: this module is shared by every file of
 * a worker, so its own top level registers no hook.
 */
export function installQuestionCardCaseLifecycle(): void {
  // sonner, vaul and react-zoom-pan-pinch insert their stylesheets on import, and
  // no element these files draw matches a rule in them. jsdom still runs every
  // rule against an element and each of its ancestors whenever a DOM change
  // drops its style cache, which every role query and click here pays: with the
  // sheets in place, the files' tests take twice as long.
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
}
