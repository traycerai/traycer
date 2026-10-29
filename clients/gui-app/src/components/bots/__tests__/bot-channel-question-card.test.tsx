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
 * a member whose answer is overtaken keeps it, loses Submit, and takes it to
 * the question's thread unsent. What a member has not sent outlives the views
 * that draw it: the channel unmounting, as a switch to another tab does,
 * and the thread closing.
 */
import { StrictMode, type ReactNode } from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
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
import type { JsonContent } from "@traycer/protocol/common/registry";
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

/** What the bot is doing, as the scripted `useBotActivity` reads it. */
const activityStore = create<{ activity: BotActivity | null }>()(() => ({
  activity: null,
}));

import { BotChannelView } from "@/components/bots/bot-channel-view";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import type { BotOpenThread } from "@/stores/bots/bot-open-thread-store";
import type { BotMemberResolver } from "@/lib/bots/bot-member-names";

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
/** A send the host holds until the case lands it. */
interface HeldSend {
  readonly land: () => void;
  /** The host's answer, once landed. */
  readonly answered: Promise<BotConversationSendResponse>;
}
/** While set, each send waits here until the case lands it. */
let heldSends: HeldSend[] | null;
const onOpenThread = vi.fn<(open: BotOpenThread | null) => void>();

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
          return Promise.reject(
            new Error("QUESTION_ALREADY_SETTLED: the question is settled"),
          );
        }
        const response: BotConversationSendResponse = {
          messageId: "message-new",
          requestId: "req-new",
          delivery,
          threadId: null,
        };
        if (heldSends === null) return Promise.resolve(response);
        const { promise, resolve } =
          Promise.withResolvers<BotConversationSendResponse>();
        heldSends.push({ land: () => resolve(response), answered: promise });
        return promise;
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

/** The host takes the oldest send held. */
async function land(): Promise<void> {
  const next = heldSends?.shift();
  if (next === undefined) throw new Error("no send is held");
  await act(async () => {
    next.land();
    await next.answered;
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
  const tree = (open: BotOpenThread | null): ReactNode => (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ChatExpansionTestProviders tileInstanceId="tile-1">
            <BotChannelView
              botId={BOT_ID}
              hostId={HOST_ID}
              boundHostId={HOST_ID}
              boundHostEpoch={1}
              botTitle="Release Bot"
              directive={null}
              appConversationChatId={CHANNEL_ID}
              trunkChatId="trunk-chat"
              openTurn={null}
              onOpenTurn={vi.fn()}
              resolveMember={resolveMember}
              tasks={[]}
              openThread={open}
              onOpenThread={onOpenThread}
              onOpenActivity={vi.fn()}
            />
          </ChatExpansionTestProviders>
        </TooltipProvider>
      </QueryClientProvider>
    </StrictMode>
  );
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

beforeEach(() => {
  sent = [];
  refuseSends = false;
  delivery = "written";
  heldSends = null;
  activityStore.setState({ activity: null });
  onOpenThread.mockClear();
  mocks.threads = [];
  mocks.handles.clear();
  rowBlocks.clear();
  useBotDraftsStore.setState({ answers: {}, threadBoxes: {} });
  mocks.client = hostClientRecordingSends();
  negotiateBotSend(HOST_ID, { major: 1, minor: 2 });
  signInViewer(VIEWER_USER_ID);
});

afterEach(() => {
  cleanup();
  resetBotFailedRequestSupport();
  mocks.handles.clear();
  mocks.client = null;
});

describe("<BotChannelView /> a question the bot asks without waiting", () => {
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
    const user = userEvent.setup();
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
    const user = userEvent.setup();
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
    const user = userEvent.setup();
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
    const user = userEvent.setup();
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
      answer: false,
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

describe("<BotChannelView /> a question on a tab whose host cannot take a card's answer", () => {
  it("draws the card with nothing to press on a host that negotiated bot.conversation.send 1.1, keeping the member's draft, and offers them again once the host reaches 1.2", async () => {
    const user = userEvent.setup();
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

describe("<BotChannelView /> a question settled while a member was answering (decision 122)", () => {
  it("refuses the member's answer at the host, keeps their draft, and once the settlement lands says who answered, drops Submit, and offers Copy and Discuss", async () => {
    const user = userEvent.setup();
    const write = session(CHANNEL_ID, [questionRow([hold(null)])]);
    mountChannel(null);
    const field = within(cardQuestion(channelCard(), HOLD)).getByRole(
      "textbox",
      { name: "Your answer" },
    );
    await user.type(field, "Hold the migration");

    // A teammate's answer reached the host first.
    refuseSends = true;
    await user.click(
      within(cardQuestion(channelCard(), HOLD)).getByRole("button", {
        name: "Submit",
      }),
    );

    expect(sent).toHaveLength(1);
    expect(screen.getByTestId("bot-channel-composer-send-failed")).toBeTruthy();
    expect((field as HTMLTextAreaElement).value).toBe("Hold the migration");
    write([questionRow([hold(byPerson(TEAMMATE_USER_ID, "Nothing"))])]);

    const question = cardQuestion(channelCard(), HOLD);
    expect(
      within(question).getByTestId("question-card-overtaken").textContent,
    ).toBe("Answered by Tess Teammate while you were answering: Nothing");
    expect(holdField().value).toBe("Hold the migration");
    expect(
      within(question).queryByRole("button", { name: "Submit" }),
    ).toBeNull();
    expect(within(question).queryByRole("button", { name: "Skip" })).toBeNull();
    expect(within(question).getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(
      within(question).getByRole("button", { name: "Discuss" }),
    ).toBeTruthy();
  });

  it("keeps a picked option in place when another member's settlement arrives, without sending anything", async () => {
    const user = userEvent.setup();
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
      within(question).getByTestId("question-card-overtaken").textContent,
    ).toBe(
      "Answered by Tess Teammate while you were answering: After the train",
    );
    expect(
      within(question)
        .getByRole("button", { name: "Now" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      within(question).queryByRole("button", { name: "Submit" }),
    ).toBeNull();
    expect(sent).toEqual([]);
  });

  it("opens the question's thread from Discuss with the member's draft in its box, unsent", async () => {
    const user = userEvent.setup();
    const write = session(CHANNEL_ID, [questionRow([hold(null)])]);
    const { reopen } = mountChannel(null);
    await user.type(
      within(cardQuestion(channelCard(), HOLD)).getByRole("textbox", {
        name: "Your answer",
      }),
      "Hold the migration",
    );
    write([questionRow([hold(byPerson(TEAMMATE_USER_ID, "Nothing"))])]);

    await user.click(
      within(cardQuestion(channelCard(), HOLD)).getByRole("button", {
        name: "Discuss",
      }),
    );

    const opened: BotOpenThread = {
      anchorMessageId: QUESTION_ID,
      announcement: true,
      answer: false,
      sent: null,
    };
    expect(onOpenThread).toHaveBeenLastCalledWith(opened);
    reopen(opened);
    const panel = screen.getByTestId("bot-thread-panel");
    const box = within(panel).getByRole("textbox", {
      name: "Reply in a new thread",
    });
    expect((box as HTMLTextAreaElement).value).toBe("Hold the migration");
    // The thread opens on the question's card, which is answered in the channel.
    expect(
      within(within(panel).getByTestId("question-card")).getByTestId(
        "question-card-settlement",
      ).textContent,
    ).toBe("Answered by Tess Teammate: Nothing");
    expect(sent).toEqual([]);
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
  answer: false,
  sent: null,
};

/** The box of the question's thread, which nobody has started. */
function questionThreadBox(): HTMLTextAreaElement {
  const box = within(screen.getByTestId("bot-thread-panel")).getByRole(
    "textbox",
    { name: "Reply in a new thread" },
  );
  if (!(box instanceof HTMLTextAreaElement)) throw new Error("no box");
  return box;
}

describe("<BotChannelView /> an answer the host queued while the bot's host is away", () => {
  it("holds the sent answer on the card, its choice pressed and nothing left to press, until the room settles it; the member's own settlement closes it", async () => {
    const user = userEvent.setup();
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
  });

  it("shows a queued answer overtaken once a teammate's settlement reaches the room first, the draft kept with Copy and Discuss, and sends nothing more", async () => {
    const user = userEvent.setup();
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

    const question = cardQuestion(channelCard(), HOLD);
    expect(
      within(question).getByTestId("question-card-overtaken").textContent,
    ).toBe("Answered by Tess Teammate while you were answering: Nothing");
    expect(holdField().value).toBe("Hold the migration");
    expect(
      within(question).queryByRole("button", { name: "Submit" }),
    ).toBeNull();
    expect(within(question).getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(
      within(question).getByRole("button", { name: "Discuss" }),
    ).toBeTruthy();
    expect(sent).toHaveLength(1);
    expect(screen.queryByTestId("bot-channel-composer-send-failed")).toBeNull();
  });
});

describe("<BotChannelView /> an answer someone else settled with first, the same member from another window included", () => {
  it("shows the card's sent answer overtaken when a teammate settled the question first with the same answer", async () => {
    const user = userEvent.setup();
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

    expect(
      within(cardQuestion(channelCard(), DEPLOY)).getByTestId(
        "question-card-overtaken",
      ).textContent,
    ).toBe("Answered by Tess Teammate while you were answering: Now");
  });

  it("shows the card's sent answer overtaken, kept with Copy and Discuss, when the member's settlement is a different answer", async () => {
    const user = userEvent.setup();
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

    const question = cardQuestion(channelCard(), DEPLOY);
    expect(
      within(question).getByTestId("question-card-overtaken").textContent,
    ).toBe("Answered by Olive Owner while you were answering: Now");
    expect(
      within(question)
        .getByRole("button", { name: "After the train" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(within(question).getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(
      within(question).getByRole("button", { name: "Discuss" }),
    ).toBeTruthy();
    expect(sent).toHaveLength(1);
  });
});

describe("<BotChannelView /> what a member has not sent, across the views that draw it", () => {
  /**
   * The card's two questions answered by a teammate first, the viewer's
   * answers to both unsent: `typed` to the one that takes words, Now to the
   * other.
   */
  async function overtakenBoth(typed: string): Promise<{
    readonly reopen: (next: BotOpenThread | null) => void;
    readonly unmount: () => void;
  }> {
    const user = userEvent.setup();
    const write = session(CHANNEL_ID, [
      questionRow([deploy(null), hold(null)]),
    ]);
    const view = mountChannel(null);
    await user.type(holdField(), typed);
    await user.click(
      within(cardQuestion(channelCard(), DEPLOY)).getByRole("button", {
        name: "Now",
      }),
    );
    write([
      questionRow([
        deploy(byPerson(TEAMMATE_USER_ID, "After the train")),
        hold(byPerson(TEAMMATE_USER_ID, "Nothing")),
      ]),
    ]);
    return view;
  }

  async function discuss(text: string): Promise<void> {
    await userEvent.setup().click(
      within(cardQuestion(channelCard(), text)).getByRole("button", {
        name: "Discuss",
      }),
    );
  }

  it("keeps a card's answers, typed, picked and sent, across the channel unmounting and mounting again, as a switch to another tab and back does", async () => {
    const user = userEvent.setup();
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

  it("keeps the draft Discuss put in the question's thread, and what was typed after it, across the thread closing and the channel remounting", async () => {
    const user = userEvent.setup();
    const view = await overtakenBoth("Hold the migration");
    await discuss(HOLD);
    view.reopen(QUESTION_THREAD);
    await user.type(questionThreadBox(), " today");

    view.reopen(null);
    expect(screen.queryByTestId("bot-thread-panel")).toBeNull();
    view.reopen(QUESTION_THREAD);
    expect(questionThreadBox().value).toBe("Hold the migration today");

    view.unmount();
    mountChannel(QUESTION_THREAD);
    expect(questionThreadBox().value).toBe("Hold the migration today");
    expect(sent).toEqual([]);
  });

  it("spends the draft with the send that carries it, even when the send lands after the thread closed", async () => {
    const user = userEvent.setup();
    heldSends = [];
    const view = await overtakenBoth("Hold the migration");
    await discuss(HOLD);
    view.reopen(QUESTION_THREAD);
    await user.click(screen.getByTestId("bot-thread-composer-send"));
    expect(
      sent.map((request) => [
        request.text,
        request.announcementId,
        request.answer,
      ]),
    ).toEqual([["Hold the migration", QUESTION_ID, null]]);

    view.reopen(null);
    await land();
    view.reopen(QUESTION_THREAD);

    expect(questionThreadBox().value).toBe("");
  });

  /** The Discuss draft sent from the question's thread, the thread closed and opened again while the send is held. */
  async function sentThenReopened(): Promise<void> {
    const user = userEvent.setup();
    heldSends = [];
    const view = await overtakenBoth("Hold the migration");
    await discuss(HOLD);
    view.reopen(QUESTION_THREAD);
    await user.click(screen.getByTestId("bot-thread-composer-send"));
    view.reopen(null);
    view.reopen(QUESTION_THREAD);
    expect(questionThreadBox().value).toBe("Hold the migration");
  }

  it("empties the box opened again while the send was in flight once it lands, so the sent draft is not offered twice", async () => {
    await sentThenReopened();

    await land();

    expect(questionThreadBox().value).toBe("");
    expect(
      screen.getByTestId("bot-thread-composer-send").hasAttribute("disabled"),
    ).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("keeps what was typed in the box opened again after the send left, when the send lands", async () => {
    const user = userEvent.setup();
    await sentThenReopened();
    await user.type(questionThreadBox(), " today");

    await land();

    expect(questionThreadBox().value).toBe("Hold the migration today");
  });

  it("keeps a draft Discuss puts in the thread's open box while an earlier send from it is in flight", async () => {
    const user = userEvent.setup();
    heldSends = [];
    const view = await overtakenBoth("Hold the migration");
    await discuss(HOLD);
    view.reopen(QUESTION_THREAD);
    await user.click(screen.getByTestId("bot-thread-composer-send"));

    await discuss(DEPLOY);
    expect(questionThreadBox().value).toBe("Now");
    await land();

    expect(questionThreadBox().value).toBe("Now");
    view.reopen(null);
    view.reopen(QUESTION_THREAD);
    expect(questionThreadBox().value).toBe("Now");
  });

  it("keeps a draft Discuss puts in the thread while it is closed, even with the text an earlier send from its box carried, when that send lands after", async () => {
    const user = userEvent.setup();
    heldSends = [];
    const view = await overtakenBoth("Now");
    await discuss(HOLD);
    view.reopen(QUESTION_THREAD);
    await user.click(screen.getByTestId("bot-thread-composer-send"));
    expect(sent.map((request) => request.text)).toEqual(["Now"]);
    view.reopen(null);

    await discuss(DEPLOY);
    await land();
    view.reopen(QUESTION_THREAD);

    expect(questionThreadBox().value).toBe("Now");
  });
});

describe("<BotChannelView /> a question a thread's session asks in its thread", () => {
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
    answer: false,
    sent: null,
  };

  it("sends the answer into the thread, and Discuss on an overtaken answer puts it in the thread's own box, unsent", async () => {
    const user = userEvent.setup();
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
    await user.click(within(panel).getByRole("button", { name: "Discuss" }));

    expect(onOpenThread).not.toHaveBeenCalled();
    const box = within(screen.getByTestId("bot-thread-panel")).getByRole(
      "textbox",
      { name: "Reply in the thread" },
    );
    expect((box as HTMLTextAreaElement).value).toBe("Now");
    expect(sent).toHaveLength(1);
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
    const user = userEvent.setup();
    heldSends = [];
    activityStore.setState({
      activity: { trunk: null, threads: { [THREAD_ID]: FAILED_ON_REPLY } },
    });
    mocks.threads = [postThread()];
    session(CHANNEL_ID, [memberPost()]);
    session(THREAD_ID, [failedReply()]);
    const view = mountChannel(POST_THREAD);
    const box = (): HTMLTextAreaElement => {
      const element = within(screen.getByTestId("bot-thread-panel")).getByRole(
        "textbox",
        { name: "Reply in the thread" },
      );
      if (!(element instanceof HTMLTextAreaElement)) throw new Error("no box");
      return element;
    };
    await user.type(box(), "Ship it today");
    await user.click(screen.getByTestId("bot-thread-composer-send"));
    view.reopen(null);
    view.reopen(POST_THREAD);
    await user.click(
      within(screen.getByTestId("bot-thread-replies")).getByTestId(
        "bot-message-edit",
      ),
    );
    expect(box().value).toBe("Hold for now");

    await land();

    expect(box().value).toBe("Hold for now");
    expect(screen.getByTestId("bot-thread-composer-editing")).toBeTruthy();
  });

  it("starts a new message when Discuss puts a draft in the box while it edits a failed reply: what is sent replaces nothing", async () => {
    const user = userEvent.setup();
    activityStore.setState({
      activity: { trunk: null, threads: { [THREAD_ID]: FAILED_ON_REPLY } },
    });
    mocks.threads = [postThread()];
    session(CHANNEL_ID, [memberPost()]);
    const write = session(THREAD_ID, [threadQuestion(null), failedReply()]);
    mountChannel(POST_THREAD);
    const replies = screen.getByTestId("bot-thread-replies");
    await user.click(within(replies).getByRole("button", { name: "Now" }));
    write([
      threadQuestion(byPerson(TEAMMATE_USER_ID, "After the train")),
      failedReply(),
    ]);
    await user.click(within(replies).getByTestId("bot-message-edit"));
    expect(screen.getByTestId("bot-thread-composer-editing")).toBeTruthy();

    await user.click(within(replies).getByRole("button", { name: "Discuss" }));

    expect(screen.queryByTestId("bot-thread-composer-editing")).toBeNull();
    const box = within(screen.getByTestId("bot-thread-panel")).getByRole(
      "textbox",
      { name: "Reply in the thread" },
    );
    expect((box as HTMLTextAreaElement).value).toBe("Now");
    await user.click(screen.getByTestId("bot-thread-composer-send"));
    expect(
      sent.map((request) => [
        request.text,
        request.threadId,
        request.supersedes,
      ]),
    ).toEqual([["Now", THREAD_ID, null]]);
  });
});
