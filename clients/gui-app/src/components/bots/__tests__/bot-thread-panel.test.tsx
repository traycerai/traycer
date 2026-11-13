/**
 * A bot's thread panel (Tracy Bots, decisions 55, 56). The REAL panel, its
 * transcript (`useRenderedMessages` over a session store's records, each row
 * drawn by the real `<ChatMessage>`), its message box and the `bot.conversation
 * .send` mutation run over a host client whose messenger records the request
 * that leaves. Only the virtualised list is replaced by a stub, as in the
 * channel-rows suite. What is asserted is what the host RECEIVES: a first reply
 * under a question opens its thread, an option clicked in a thread is the
 * person's next message in it, and a thread hung off the bot's own row is
 * drawn as the bot's, with no request to show. Every state opens on the
 * channel row the thread answers, drawn by the channel's own row component.
 */
import {
  botMentionHostClientMock,
  emptyBotMentionHostListsMock,
} from "@/components/bots/__tests__/bot-mention-host-test-support";
import { StrictMode, useSyncExternalStore, type ReactNode } from "react";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
  type RenderResult,
} from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BotTestRunnerHost } from "@/components/bots/__tests__/bot-test-runner-host";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import {
  HostClient,
  type HostRequester,
} from "@traycer-clients/shared/host-client/host-client";
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  BotConversationSendRequest,
  BotConversationSendResponse,
  BotThreadSummary,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { BotTaskEntry } from "@traycer/protocol/host/bot/schemas";
import type { BotTurnLocateRequest } from "@traycer/protocol/host/bot/conversation-schemas";
import { conversationRequestMessageId } from "@traycer/protocol/persistence/epic/messages";
import type {
  AgentSender,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import {
  negotiateBotSend,
  resetBotFailedRequestSupport,
  signInViewer,
  VIEWER_USER_ID,
} from "@/components/bots/__tests__/bot-failed-request-test-support";
import { BotIdentityContext } from "@/components/bots/bot-identity-context";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { CHAT_NAVIGATION_HIGHLIGHT_CLASSNAME } from "@/components/chat/chat-navigation-highlight";
import { TooltipProvider } from "@/components/ui/tooltip";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import type { ChatLocateRowArgs } from "@/hooks/chats/use-chat-locate-row";
import type {
  ChatSessionState,
  ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { emptyTranscriptWindow } from "@/stores/chats/transcript-window";
import type {
  BotActivity,
  BotSessionActivity,
} from "@/hooks/bots/use-bot-activity";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  hostClientLocating,
  turnRef,
  turnsAskedFor,
} from "@/components/bots/__tests__/bot-turn-test-support";
import {
  sessionTargetOfTurn,
  type BotTurnOpen,
} from "@/stores/bots/bot-open-thread-store";
import type { BotComposerEdit } from "@/components/bots/bot-message-composer";
import type { BotReplyReach } from "@/hooks/bots/use-bot-send-version";
import type { BotSentPost } from "@/stores/bots/bot-open-thread-store";
import type { BotTranscriptLanding } from "@/components/bots/bot-chat-transcript";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import {
  BOT_BOX_DRAFTS_PERSIST_KEY,
  storedBoxDraftsOf,
  type StoredBoxDraft,
} from "@/lib/bots/bot-box-draft-storage";
import { isRecord } from "@/lib/editor/prosemirror-json";
import { setPhoneLayoutOnly } from "@/lib/mobile-app";
import {
  useVoiceSessionStore,
  type VoiceSessionDriver,
} from "@/stores/voice/voice-session-store";
import {
  holdScreenLandscape,
  IPHONE_17,
  lowerNativeKeyboard,
  raiseNativeKeyboard,
  restoreKeyboardEnvironment,
} from "../../../../__tests__/short-keyboard-viewport-harness";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";

type ThreadTranscriptState = Pick<
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
  handle: null as ChatSessionStoreHandle | null,
  channelHandle: null as ChatSessionStoreHandle | null,
  client: null as HostRequester<HostRpcRegistry> | null,
  toastFromHostError: vi.fn<(error: Error, fallback: string) => void>(),
  /** What the host's locate answers for the anchor: its ordinal, or `null`. */
  locatedOrdinal: null as number | null,
  /** Every locate the component asked for while it had a target. */
  locateTargets: [] as ChatLocateRowArgs["target"][],
  /**
   * The thread's session handle as the registry hands it out: ready at once,
   * or (`held`) not yet acquired, as the real registry's first render is,
   * until the case acquires it.
   */
  threadHandle: {
    held: false,
    listeners: new Set<() => void>(),
  },
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
vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: mocks.toastFromHostError,
}));

vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  // The thread reads its own session; the post it answers comes from the
  // channel's.
  useChatSessionHandleForContainer: (
    _botId: string,
    chatId: string,
  ): ChatSessionStoreHandle | null => {
    const thread = useSyncExternalStore(
      (listener) => {
        mocks.threadHandle.listeners.add(listener);
        return () => mocks.threadHandle.listeners.delete(listener);
      },
      () => (mocks.threadHandle.held ? null : mocks.handle),
    );
    return chatId === CONVERSATION_ID ? mocks.channelHandle : thread;
  },
}));
// The thread's typing line is `bot-channel-typing.test.tsx`'s; the bot is
// idle unless a case says its thread's session failed.
vi.mock("@/hooks/bots/use-bot-activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/bots/use-bot-activity")>()),
  useBotActivity: () => activityStore((state) => state.activity),
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.client,
}));
vi.mock("@/hooks/epic/use-epic-get-task-contexts-query", () => ({
  useEpicGetTaskContexts: () => ({
    tasksById: new Map([
      ["task-watch", { epic: { light: { title: "Release watch" } } }],
    ]),
  }),
}));
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessCatalogForClient: () => ({ harnesses: [] }),
}));
vi.mock("@/hooks/chats/use-chat-locate-row", () => ({
  useChatLocateRow: (args: ChatLocateRowArgs) => {
    if (args.target === null) return null;
    mocks.locateTargets.push(args.target);
    return mocks.locatedOrdinal;
  },
  useChatLocateRowAnswer: (args: ChatLocateRowArgs) => {
    if (args.target === null) return { status: "waiting" };
    mocks.locateTargets.push(args.target);
    return mocks.locatedOrdinal === null
      ? { status: "waiting" }
      : { status: "found", ordinal: mocks.locatedOrdinal };
  },
}));
vi.mock("@/components/chat/chat-messages", async () => {
  const { ChatExpansionTestProviders: Providers } =
    await import("@/components/chat/__tests__/chat-expansion-test-providers");
  const { use } = await import("react");
  const { ChatMessage } = await import("@/components/chat/chat-message");
  const { ChatTimelineHeaderContext } =
    await import("@/components/chat/chat-timeline-header-context");
  const { ChatEmptyState } = await import("@/components/chat/chat-empty-state");
  const noBackgroundToolBlockIds: ReadonlySet<string> = new Set();
  return {
    // As the real timeline does: the header above the rows, and with no row
    // the header in place of the empty state.
    ChatMessages: (props: {
      messages: ReadonlyArray<ChatMessageModel>;
      instanceId: string;
    }) => {
      const header = use(ChatTimelineHeaderContext);
      return (
        <Providers tileInstanceId={props.instanceId}>
          <div data-testid="chat-messages-stub">
            {header}
            {props.messages.length === 0 && header === null ? (
              <ChatEmptyState />
            ) : null}
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
      );
    },
  };
});

/** The scroll region that holds the post where no reply is listed. */
function postScroll(): HTMLElement {
  return screen.getByTestId("bot-thread-post-scroll");
}

/** The post sits in its own scroll region. */
function expectPostScrolls(): void {
  expect(postScroll().contains(screen.getByTestId("bot-thread-anchor"))).toBe(
    true,
  );
}

/** As above, with the reply box outside it. */
function expectPostScrollsApartFromBox(): void {
  expectPostScrolls();
  expect(postScroll().contains(screen.getByTestId("bot-thread-composer"))).toBe(
    false,
  );
}

/** What the bot is doing, as the scripted `useBotActivity` reads it. */
const activityStore = create<{ activity: BotActivity | null }>()(() => ({
  activity: null,
}));

import { BotThreadPanel } from "@/components/bots/bot-thread-panel";
import type { BotThreadPanelThread } from "@/components/bots/bot-thread-panel";
import type { BotMemberResolver } from "@/lib/bots/bot-member-names";
import {
  boxInput,
  editableIn,
  textOf,
  typeInto,
} from "@/components/bots/__tests__/bot-box-test-support";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HOST_ID = "host-bound";
const CONVERSATION_ID = "conversation-channel";
const THREAD_ID = "thread-1";

const BOT_SENDER: AgentSender = {
  type: "agent",
  harnessId: "claude",
  agentId: "claude-sonnet-4",
  displayName: "Claude Sonnet 4",
  reply: { expectsReply: false },
  inReplyTo: null,
};

const resolveMember: BotMemberResolver = (userId) =>
  userId === "user-teammate"
    ? { displayName: "Tess Teammate", avatarUrl: null }
    : null;

function threadSummary(anchorSenderUserId: string | null): BotThreadSummary & {
  readonly anchor: NonNullable<BotThreadSummary["anchor"]>;
} {
  return {
    threadId: THREAD_ID,
    conversationId: CONVERSATION_ID,
    sessionChatId: "session-1",
    anchor: {
      messageId: "anchor-1",
      requestId: "req-1",
      senderUserId: anchorSenderUserId,
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

function botReply(
  options: ReadonlyArray<string> | null,
): Extract<Message, { role: "assistant" }> {
  const base: Extract<Message, { role: "assistant" }> = {
    role: "assistant",
    messageId: "reply-1",
    sender: BOT_SENDER,
    blocks: [
      {
        type: "text",
        blockId: "reply-1:text",
        status: "completed",
        timestamp: 2_000,
        text: "Which way should I go?",
        providerNotice: null,
      },
    ],
    startedAt: 2_000,
    timestamp: 2_000,
    turnId: null,
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: [],
  };
  return options === null ? base : { ...base, options: [...options] };
}

function createThreadStore(
  messages: ReadonlyArray<Message>,
  holdTranscriptOrdinal: ThreadTranscriptState["holdTranscriptOrdinal"],
): UseBoundStore<StoreApi<ThreadTranscriptState>> {
  return create<ThreadTranscriptState>()(() => ({
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
    holdTranscriptOrdinal,
  }));
}

const SEND_RESPONSE: BotConversationSendResponse = {
  messageId: "message-1",
  requestId: "request-1",
  delivery: "written",
  threadId: THREAD_ID,
};

/** The channel's own rows, where the anchor's text is read from. */
let channelMessages: ReadonlyArray<Message>;

function announcement(
  messageId: string,
  text: string,
): Extract<Message, { role: "assistant" }> {
  const base = botReply(null);
  return {
    ...base,
    messageId,
    blocks: [
      {
        type: "text",
        blockId: `${messageId}:text`,
        status: "completed",
        timestamp: 1_000,
        text,
        providerNotice: null,
      },
    ],
  };
}

/** The channel store's hold action: records each hold and its release. */
const channelHold = vi.fn<(ordinal: number) => () => void>(
  () => channelRelease,
);
const channelRelease = vi.fn<() => void>();

let sent: ReadonlyArray<BotConversationSendRequest>;
/** The post as its send opened the thread; `null` for a thread opened from a row. */
let panelSent: BotSentPost | null;
/** The message of the thread the panel's replies land on; `null` for none. */
let panelLanding: BotTranscriptLanding | null;
/** The bot's task list the panel is handed. */
let panelTasks: ReadonlyArray<BotTaskEntry>;
/** Where a Reply on a row of the thread reaches the bot. */
let panelReplyReach: BotReplyReach;
const onEditPost = vi.fn<(edit: BotComposerEdit) => void>();
/** The turn a tap on the replying strip asks the tab to open. */
const onOpenTurn = vi.fn<BotTurnOpen>();
/** What the host answers the next `bot.conversation.send` with. */
let sendAnswer: () => Promise<BotConversationSendResponse>;

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
        return sendAnswer();
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

/** The row a case opens its thread on instead of `originOf`'s; `null` for that. */
let panelOrigin: string | null;

/** The post a thread opens on: the question nobody has replied under, or the listed thread's anchor. */
function originOf(thread: BotThreadPanelThread): string {
  if (panelOrigin !== null) return panelOrigin;
  return thread.kind === "unopened" ? "question-1" : "anchor-1";
}

function mountPanel(
  thread: BotThreadPanelThread,
  messages: ReadonlyArray<Message>,
): RenderResult {
  stageSessions(messages);
  return render(panelTree(thread));
}

/** The thread's session over `messages`, and the channel's over `channelMessages`. */
function stageSessions(messages: ReadonlyArray<Message>): void {
  mocks.handle = {
    store: createThreadStore(messages, () => () => undefined),
  } as ChatSessionStoreHandle;
  mocks.channelHandle = {
    store: createThreadStore(channelMessages, channelHold),
  } as ChatSessionStoreHandle;
}

/** The case's query cache: one per case, so a re-render keeps its queries. */
let panelQueryClient: QueryClient;

/** The panel on `thread`, over the sessions the last mount made. */
function panelTree(thread: BotThreadPanelThread): ReactNode {
  return (
    <StrictMode>
      <QueryClientProvider client={panelQueryClient}>
        <BotTestRunnerHost>
          <TooltipProvider>
            <ChatExpansionTestProviders tileInstanceId="tile-1">
              <BotThreadPanel
                botId={BOT_ID}
                hostId={HOST_ID}
                boundHostId={HOST_ID}
                imageReach="none"
                answerReach="each"
                replyReach={panelReplyReach}
                botTitle="Release Bot"
                conversationId={CONVERSATION_ID}
                originMessageId={originOf(thread)}
                sent={panelSent}
                thread={thread}
                tasks={panelTasks}
                anchorSenderLabel={(senderUserId) =>
                  senderUserId === null ? "You" : "Tess Teammate"
                }
                resolveMember={resolveMember}
                onClose={vi.fn()}
                onEditPost={onEditPost}
                onOpenTurn={onOpenTurn}
                onOpenSession={vi.fn()}
                landOn={panelLanding}
                quote={null}
              />
            </ChatExpansionTestProviders>
          </TooltipProvider>
        </BotTestRunnerHost>
      </QueryClientProvider>
    </StrictMode>
  );
}

function listed(
  anchorSenderUserId: string | null,
): Extract<BotThreadPanelThread, { kind: "listed" }> {
  return {
    kind: "listed",
    retry: null,
    thread: threadSummary(anchorSenderUserId),
    sendable: true,
  };
}

beforeEach(() => {
  panelQueryClient = new QueryClient();
  sent = [];
  panelSent = null;
  panelLanding = null;
  panelTasks = [];
  panelReplyReach = "none";
  panelOrigin = null;
  mocks.threadHandle.held = false;
  onEditPost.mockClear();
  onOpenTurn.mockReset();
  activityStore.setState({ activity: null });
  channelMessages = [];
  mocks.locatedOrdinal = null;
  mocks.locateTargets = [];
  channelHold.mockClear();
  channelRelease.mockClear();
  sendAnswer = () => Promise.resolve(SEND_RESPONSE);
  mocks.toastFromHostError.mockClear();
  mocks.client = hostClientRecordingSends();
  // A host that can retry and replace, and a viewer who wrote the failed message.
  negotiateBotSend(HOST_ID, { major: 1, minor: 1 });
  signInViewer(VIEWER_USER_ID);
});

afterEach(() => {
  // What a box held unsent is kept under the bot, past its view.
  useBotDraftsStore.setState({ answers: {}, threadBoxes: {} });
  cleanup();
  resetBotFailedRequestSupport();
  mocks.handle = null;
  mocks.channelHandle = null;
  mocks.client = null;
});

describe("<BotThreadPanel /> a question or proposal nobody has replied under", () => {
  it("opens on the question, followed directly by the box, and sends the first reply with the announcement's id and no thread", async () => {
    const user = userEvent.setup();
    channelMessages = [announcement("question-1", "Ship the release today?")];
    mountPanel({ kind: "unopened", retry: null, sendable: true }, []);

    const origin = screen.getByTestId("bot-thread-anchor");
    expect(within(origin).getByText("Release Bot")).toBeTruthy();
    expect(within(origin).getByText("Ship the release today?")).toBeTruthy();
    expect(within(origin).queryByTestId("bot-message-actions")).toBeNull();
    expectPostScrollsApartFromBox();
    expect(postScroll().nextElementSibling?.getAttribute("data-testid")).toBe(
      "bot-thread-composer",
    );
    expect(
      screen.queryByText("Reply to start a thread. The bot answers there."),
    ).toBeNull();
    expect(screen.queryByTestId("chat-messages-stub")).toBeNull();
    expect(screen.queryByTestId("bot-thread-reply-count")).toBeNull();

    typeInto(boxInput("Reply in a new thread"), "Ship it");
    await user.click(screen.getByTestId("bot-thread-composer-send"));

    expect(sent).toEqual([
      {
        botId: BOT_ID,
        conversationId: CONVERSATION_ID,
        text: "Ship it",
        threadId: null,
        announcementId: "question-1",
        redeliver: null,
        supersedes: null,
        answer: null,
      },
    ]);
  });
});

describe("<BotThreadPanel /> a direct reply nobody has replied under", () => {
  /** The member's post, then the bot's direct reply to it, on the channel. */
  function answeredPost(): void {
    const answer = announcement("answer-1", "It failed on the retry job.");
    channelMessages = [
      {
        role: "user",
        messageId: "post-1",
        sender: { type: "user", userId: "user-teammate" },
        message: {
          kind: "user",
          content: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Why did the build fail?" }],
              },
            ],
          },
          browserAnnotations: [],
        },
        timestamp: 900,
        sessionAnchor: null,
        conversationRequest: {
          requestId: "req-post",
          resolvedAt: 1_000,
          resolvedByMessageId: "answer-1",
          direct: true,
        },
      },
      { ...answer, repliesTo: "post-1" },
    ];
    panelOrigin = "answer-1";
  }

  it("opens on the reply, not the post it answered, and sends the first reply with the reply's id", async () => {
    const user = userEvent.setup();
    answeredPost();
    mountPanel({ kind: "unopened", retry: null, sendable: true }, []);

    const origin = screen.getByTestId("bot-thread-anchor");
    expect(within(origin).getByText("Release Bot")).toBeTruthy();
    expect(
      within(origin).getByText("It failed on the retry job."),
    ).toBeTruthy();
    expect(within(origin).queryByText("Why did the build fail?")).toBeNull();
    expect(within(origin).queryByTestId("bot-message-actions")).toBeNull();

    typeInto(boxInput("Reply in a new thread"), "Which job?");
    await user.click(screen.getByTestId("bot-thread-composer-send"));

    expect(sent).toEqual([
      {
        botId: BOT_ID,
        conversationId: CONVERSATION_ID,
        text: "Which job?",
        threadId: null,
        announcementId: "answer-1",
        redeliver: null,
        supersedes: null,
        answer: null,
      },
    ]);
  });

  it("says the reply could not be sent, and keeps the reply on screen, when the host refuses a thread under it", async () => {
    const user = userEvent.setup();
    answeredPost();
    sendAnswer = () =>
      Promise.reject(
        new Error(
          "Message 'answer-1' is not a question, proposal or direct post of conversation 'conversation-channel': only those take a reply in a thread.",
        ),
      );
    mountPanel({ kind: "unopened", retry: null, sendable: true }, []);

    typeInto(boxInput("Reply in a new thread"), "Which job?");
    await user.click(screen.getByTestId("bot-thread-composer-send"));

    expect(
      (await screen.findByTestId("bot-thread-composer-send-failed"))
        .textContent,
    ).toBe("Couldn't send. Try again.");
    expect(sent.map((request) => request.announcementId)).toEqual(["answer-1"]);
    expect(
      within(screen.getByTestId("bot-thread-anchor")).getByText(
        "It failed on the retry job.",
      ),
    ).toBeTruthy();
    expect(mocks.toastFromHostError).not.toHaveBeenCalled();
  });

  it("keeps the box, its draft and its focus while the list drops the reply's thread after a claim and lists it again, and sends the draft into the thread", async () => {
    const user = userEvent.setup();
    answeredPost();
    const taking = listed("user-teammate");
    const panel = mountPanel(taking, []);
    const box = editableIn(screen.getByTestId("bot-thread-composer-input"));
    typeInto(box, "Which job?");

    // Claimed: the room drops the earlier host's threads, and the new host
    // has not written its own yet.
    panel.rerender(
      panelTree({ kind: "unopened", retry: null, sendable: false }),
    );
    expect(editableIn(screen.getByTestId("bot-thread-composer-input"))).toBe(
      box,
    );
    expect(textOf(box)).toBe("Which job?");
    expect(document.activeElement).toBe(box);

    // The new host writes the thread, and opens threads under a reply.
    panel.rerender(panelTree(taking));
    expect(editableIn(screen.getByTestId("bot-thread-composer-input"))).toBe(
      box,
    );
    expect(textOf(box)).toBe("Which job?");
    expect(document.activeElement).toBe(box);
    await user.click(screen.getByTestId("bot-thread-composer-send"));

    expect(
      sent.map((request) => [
        request.text,
        request.threadId,
        request.announcementId,
      ]),
    ).toEqual([["Which job?", THREAD_ID, null]]);
  });

  it("keeps what the person typed and sends nothing while the bot's binding no longer opens a thread under the reply, and sends it once it does again", async () => {
    const user = userEvent.setup();
    answeredPost();
    const panel = mountPanel(
      { kind: "unopened", retry: null, sendable: true },
      [],
    );
    const box = (): HTMLElement => boxInput("Reply in a new thread");
    const sendButton = (): HTMLButtonElement =>
      screen.getByTestId("bot-thread-composer-send");
    typeInto(box(), "Which job?");
    expect(sendButton().disabled).toBe(false);

    panel.rerender(
      panelTree({ kind: "unopened", retry: null, sendable: false }),
    );

    expect(textOf(box())).toBe("Which job?");
    expect(sendButton().disabled).toBe(true);
    typeInto(box(), "{Enter}");
    expect(sent).toEqual([]);

    panel.rerender(
      panelTree({ kind: "unopened", retry: null, sendable: true }),
    );
    await user.click(sendButton());

    expect(
      sent.map((request) => [request.text, request.announcementId]),
    ).toEqual([["Which job?", "answer-1"]]);
  });
});

describe("<BotThreadPanel /> what its box holds unsent", () => {
  /** The draft this device holds for the bot's box under `key`. */
  function storedBox(key: string): StoredBoxDraft | undefined {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(BOT_BOX_DRAFTS_PERSIST_KEY) ?? "null",
    );
    const stored =
      isRecord(parsed) && isRecord(parsed.state)
        ? parsed.state.threadBoxes
        : null;
    return storedBoxDraftsOf(stored)[BOT_ID]?.[key];
  }

  it("keeps the thread's draft under the thread, apart from the channel's, on the device and in its box when the thread opens again", () => {
    useBotDraftsStore
      .getState()
      .typeThreadBox(BOT_ID, CONVERSATION_ID, "For the channel", null);
    const thread = listed("user-teammate");
    const box = (): HTMLElement =>
      editableIn(screen.getByTestId("bot-thread-composer-input"));
    const panel = mountPanel(thread, []);
    expect(textOf(box())).toBe("");

    typeInto(box(), "For the thread");
    panel.unmount();
    window.dispatchEvent(new Event("pagehide"));

    expect(storedBox(originOf(thread))?.text).toBe("For the thread");
    expect(storedBox(CONVERSATION_ID)?.text).toBe("For the channel");
    mountPanel(thread, []);
    expect(textOf(box())).toBe("For the thread");
  });
});

describe("<BotThreadPanel /> Call", () => {
  beforeEach(() => {
    useVoiceSessionStore.setState({
      availability: "live",
      driver: {
        start: vi.fn<VoiceSessionDriver["start"]>(),
        end: vi.fn<VoiceSessionDriver["end"]>(),
        setMuted: vi.fn<VoiceSessionDriver["setMuted"]>(),
      },
    });
  });

  afterEach(() => {
    useVoiceSessionStore.setState(useVoiceSessionStore.getInitialState(), true);
  });

  it("is in the box of a listed thread, calling that thread, and not in the header", async () => {
    const user = userEvent.setup();
    mountPanel(listed("user-teammate"), [botReply(null)]);

    const header = screen.getByTestId("bot-thread-close").closest("header");
    if (header === null) throw new Error("expected the thread header");
    expect(within(header).queryByRole("button", { name: /^Call/ })).toBeNull();
    const call = within(screen.getByTestId("bot-thread-composer")).getByRole(
      "button",
      { name: "Call Release Bot" },
    );

    await user.click(call);

    expect(useVoiceSessionStore.getState().driver?.start).toHaveBeenCalledWith({
      botId: BOT_ID,
      threadId: THREAD_ID,
    });
  });

  it("is not in the box replying under a question nobody has replied under", () => {
    channelMessages = [announcement("question-1", "Ship the release today?")];
    mountPanel({ kind: "unopened", retry: null, sendable: true }, []);

    expect(screen.queryByTestId("bot-thread-composer-call")).toBeNull();
  });
});

describe("<BotThreadPanel /> a direct reply's box through a failed read", () => {
  it("keeps the box and its draft beside Retry while the list's read fails, and sends the draft once the read recovers", async () => {
    const user = userEvent.setup();
    channelMessages = [announcement("answer-1", "It failed on the retry job.")];
    panelOrigin = "answer-1";
    const retry = vi.fn<() => void>();
    const panel = mountPanel(
      { kind: "unopened", retry: null, sendable: true },
      [],
    );
    const box = boxInput("Reply in a new thread");
    typeInto(box, "Which job?");

    // The read after the bot's binding moved fails; the new binding has not
    // said it opens a thread under the reply.
    panel.rerender(panelTree({ kind: "unopened", retry, sendable: false }));

    expect(boxInput("Reply in a new thread")).toBe(box);
    expect(textOf(box)).toBe("Which job?");
    expect(
      screen.getByTestId("bot-thread-composer-send").hasAttribute("disabled"),
    ).toBe(true);
    await user.click(
      within(screen.getByTestId("bot-thread-error")).getByRole("button", {
        name: "Retry",
      }),
    );
    expect(retry).toHaveBeenCalledTimes(1);

    // Retry reads the list, and the binding opens the reply's thread.
    panel.rerender(
      panelTree({ kind: "unopened", retry: null, sendable: true }),
    );
    expect(screen.queryByTestId("bot-thread-error")).toBeNull();
    expect(boxInput("Reply in a new thread")).toBe(box);
    await user.click(screen.getByTestId("bot-thread-composer-send"));

    expect(
      sent.map((request) => [request.text, request.announcementId]),
    ).toEqual([["Which job?", "answer-1"]]);
  });
});

describe("<BotThreadPanel /> a listed thread", () => {
  it("puts the box right under the post of a listed thread with no reply yet, with no count or rule, and keeps its replies subscribed", () => {
    const zero = listed("user-teammate");
    mountPanel(
      {
        kind: "listed",
        retry: null,
        thread: { ...zero.thread, replyCount: 0 },
        sendable: true,
      },
      [],
    );

    expect(screen.queryByTestId("bot-thread-reply-count")).toBeNull();
    const replies = screen.getByTestId("bot-thread-replies");
    expect(replies.getAttribute("data-has-replies")).toBe("false");
    expect(replies.className).not.toContain("grow");
    expect(within(replies).getByTestId("bot-chat-transcript")).toBeTruthy();
    // The empty thread's transcript draws nothing between the post and the box.
    expect(replies.textContent).toBe("");
    expect(screen.queryByText("No replies yet.")).toBeNull();
    expect(postScroll().contains(screen.getByTestId("bot-thread-anchor"))).toBe(
      true,
    );
    expect(postScroll().nextElementSibling).toBe(replies);

    // The subscription held while empty brings the first reply in.
    act(() => {
      mocks.handle?.store.setState({ messages: [botReply(null)] });
    });
    expect(within(replies).getByText("Which way should I go?")).toBeTruthy();
    cleanup();

    mountPanel(listed("user-teammate"), [botReply(null)]);
    const listedReplies = screen.getByTestId("bot-thread-replies");
    expect(listedReplies.getAttribute("data-has-replies")).toBe("true");
    expect(listedReplies.className).toContain("grow");
    expect(screen.getByTestId("bot-thread-reply-count").textContent).toBe(
      "1 reply",
    );
  });

  it("posts the option a person clicks as their next message in that thread", async () => {
    const user = userEvent.setup();
    mountPanel(listed("user-teammate"), [botReply(["Ship it", "Hold"])]);

    const group = screen.getByRole("group", { name: "Choices" });
    expect(
      within(group)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Ship it", "Hold"]);
    expect(sent).toEqual([]);

    await user.click(within(group).getByRole("button", { name: "Hold" }));

    expect(sent).toEqual([
      {
        botId: BOT_ID,
        conversationId: CONVERSATION_ID,
        text: "Hold",
        threadId: THREAD_ID,
        announcementId: null,
        redeliver: null,
        supersedes: null,
        answer: null,
      },
    ]);
  });

  it("offers no second pick while the first is still being sent, and offers the choices again once it lands", async () => {
    const user = userEvent.setup();
    let land: (response: BotConversationSendResponse) => void = () => {};
    sendAnswer = () =>
      new Promise<BotConversationSendResponse>((resolve) => {
        land = resolve;
      });
    mountPanel(listed("user-teammate"), [botReply(["Ship it", "Hold"])]);
    const group = screen.getByRole("group", { name: "Choices" });

    await user.click(within(group).getByRole("button", { name: "Hold" }));

    await waitFor(() => {
      expect(
        within(group)
          .getAllByRole("button")
          .every((button) => button.hasAttribute("disabled")),
      ).toBe(true);
    });
    await user.click(within(group).getByRole("button", { name: "Ship it" }));
    expect(sent).toHaveLength(1);

    land(SEND_RESPONSE);

    await waitFor(() => {
      expect(
        within(group)
          .getAllByRole("button")
          .some((button) => button.hasAttribute("disabled")),
      ).toBe(false);
    });
  });

  it("says in the thread's box when their pick could not be sent, and raises no toast", async () => {
    const user = userEvent.setup();
    sendAnswer = () => Promise.reject(new Error("host refused the pick"));
    mountPanel(listed("user-teammate"), [botReply(["Ship it", "Hold"])]);

    await user.click(screen.getByRole("button", { name: "Hold" }));

    expect(
      (await screen.findByTestId("bot-thread-composer-send-failed"))
        .textContent,
    ).toBe("Couldn't send. Try again.");
    // The host was asked and refused: a pick that never left would show the same notice.
    expect(sent.map((request) => request.text)).toEqual(["Hold"]);
    expect(mocks.toastFromHostError).not.toHaveBeenCalled();
  });

  it("sends no reply and no picked option while it does not take a send, keeping the draft, and sends both once it does again", async () => {
    const user = userEvent.setup();
    const taking = listed("user-teammate");
    const view = mountPanel(taking, [botReply(["Ship it", "Hold"])]);
    const box = boxInput("Reply in the thread");
    typeInto(box, "Which job?");

    // The bot moved to a host that does not open a thread under its reply.
    view.rerender(panelTree({ ...taking, sendable: false }));

    expect(textOf(box)).toBe("Which job?");
    const sendButton = screen.getByTestId("bot-thread-composer-send");
    expect(sendButton.hasAttribute("disabled")).toBe(true);
    typeInto(box, "{Enter}");
    const group = screen.getByRole("group", { name: "Choices" });
    expect(
      within(group)
        .getAllByRole("button")
        .every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
    await user.click(within(group).getByRole("button", { name: "Hold" }));
    expect(sent).toEqual([]);

    view.rerender(panelTree(taking));
    await user.click(screen.getByTestId("bot-thread-composer-send"));
    await user.click(within(group).getByRole("button", { name: "Hold" }));

    expect(sent.map((request) => [request.text, request.threadId])).toEqual([
      ["Which job?", THREAD_ID],
      ["Hold", THREAD_ID],
    ]);
  });

  it("says a failed read of the list above the replies it last listed, with Retry, and sends again once the read recovers", async () => {
    const user = userEvent.setup();
    const retry = vi.fn<() => void>();
    const taking = listed("user-teammate");
    const panel = mountPanel({ ...taking, retry, sendable: false }, [
      botReply(null),
    ]);

    const failure = screen.getByTestId("bot-thread-error");
    expect(
      within(screen.getByTestId("bot-thread-replies")).getByText(
        "Which way should I go?",
      ),
    ).toBeTruthy();
    expect(
      screen.getByTestId("bot-thread-composer-send").hasAttribute("disabled"),
    ).toBe(true);
    await user.click(within(failure).getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);

    panel.rerender(panelTree(taking));
    expect(screen.queryByTestId("bot-thread-error")).toBeNull();
    typeInto(
      editableIn(screen.getByTestId("bot-thread-composer-input")),
      "Thanks",
    );
    await user.click(screen.getByTestId("bot-thread-composer-send"));
    expect(sent.map((request) => request.text)).toEqual(["Thanks"]);
  });

  it("draws no choices under a reply that offers none", () => {
    mountPanel(listed("user-teammate"), [botReply(null)]);

    expect(screen.getByText("Which way should I go?")).toBeTruthy();
    expect(screen.queryByTestId("bot-reply-options")).toBeNull();
  });

  it("replies into the thread with its id and no announcement", async () => {
    const user = userEvent.setup();
    mountPanel(listed("user-teammate"), []);

    typeInto(boxInput("Reply in the thread"), "Hold for now");
    await user.click(screen.getByTestId("bot-thread-composer-send"));

    expect(sent).toEqual([
      {
        botId: BOT_ID,
        conversationId: CONVERSATION_ID,
        text: "Hold for now",
        threadId: THREAD_ID,
        announcementId: null,
        redeliver: null,
        supersedes: null,
        answer: null,
      },
    ]);
  });
});

describe("<BotThreadPanel /> a thread its post opened as it was sent", () => {
  const POSTED: BotThreadPanelThread = {
    kind: "posted",
    threadId: THREAD_ID,
    retry: null,
    sendable: true,
  };

  /** The thread's session acquired by the registry, as its effect does after the first render. */
  function acquireThreadHandle(): void {
    act(() => {
      mocks.threadHandle.held = false;
      for (const listener of mocks.threadHandle.listeners) listener();
    });
  }

  function replyBox(): HTMLElement {
    const box = boxInput("Reply in the thread");
    return box;
  }

  it("opens on the post with no wait, says the bot is replying, and replies in the thread", async () => {
    const user = userEvent.setup();
    channelMessages = [announcement("anchor-1", "Ship the release today?")];
    mountPanel(POSTED, []);

    const panel = screen.getByTestId("bot-thread-panel");
    expect(panel.getAttribute("data-thread-id")).toBe(THREAD_ID);
    const anchor = screen.getByTestId("bot-thread-anchor");
    expect(within(anchor).getByText("Ship the release today?")).toBeTruthy();
    expectPostScrollsApartFromBox();
    expect(screen.queryByTestId("bot-thread-loading")).toBeNull();
    // No replies to read until the list has the thread.
    expect(screen.queryByTestId("bot-thread-replies")).toBeNull();
    expect(screen.queryByTestId("bot-thread-replying-strip")).toBeNull();

    act(() => {
      activityStore.setState({
        activity: {
          trunk: null,
          threads: {
            [THREAD_ID]: {
              state: "replying",
              startedAt: 1_000,
              step: null,
              requestId: "req-1",
              reason: null,
            },
          },
        },
      });
    });
    const strip = screen.getByTestId("bot-thread-replying-strip");
    expect(within(strip).getByText("Release Bot is replying…")).toBeTruthy();

    typeInto(replyBox(), "And the nightly?");
    await user.click(screen.getByTestId("bot-thread-composer-send"));
    await waitFor(() => {
      expect(sent).toEqual([
        {
          botId: BOT_ID,
          conversationId: CONVERSATION_ID,
          text: "And the nightly?",
          threadId: THREAD_ID,
          announcementId: null,
          redeliver: null,
          supersedes: null,
          answer: null,
        },
      ]);
    });
  });

  it("keeps the reply box, its draft and its focus when the list returns the thread", () => {
    channelMessages = [announcement("anchor-1", "Ship the release today?")];
    const view = mountPanel(POSTED, []);
    const box = replyBox();
    typeInto(box, "And the nightly?");
    expect(document.activeElement).toBe(box);

    view.rerender(panelTree(listed("user-teammate")));

    expect(screen.getByTestId("bot-thread-replies")).toBeTruthy();
    expect(replyBox()).toBe(box);
    expect(textOf(box)).toBe("And the nightly?");
    expect(document.activeElement).toBe(box);
  });

  it("draws nothing between the post and the box while a listed thread's session connects", () => {
    channelMessages = [announcement("anchor-1", "Ship the release today?")];
    const view = mountPanel(POSTED, []);
    const box = replyBox();
    typeInto(box, "And the nightly?");
    const zero = listed("user-teammate");

    mocks.threadHandle.held = true;
    view.rerender(
      panelTree({
        kind: "listed",
        retry: null,
        thread: { ...zero.thread, replyCount: 0 },
        sendable: true,
      }),
    );

    expect(screen.queryByTestId("bot-chat-transcript-connecting")).toBeNull();
    const replies = screen.getByTestId("bot-thread-replies");
    expect(replies.childElementCount).toBe(0);
    expect(postScroll().contains(screen.getByTestId("bot-thread-anchor"))).toBe(
      true,
    );
    expect(postScroll().nextElementSibling).toBe(replies);

    acquireThreadHandle();
    expect(screen.queryByTestId("bot-chat-transcript-connecting")).toBeNull();
    expect(within(replies).getByTestId("bot-chat-transcript")).toBeTruthy();
    expect(replies.textContent).toBe("");
    expect(replyBox()).toBe(box);
    expect(textOf(box)).toBe("And the nightly?");
  });

  it("holds the place of a thread with replies with a spinner while its session connects", () => {
    mocks.threadHandle.held = true;
    mountPanel(listed("user-teammate"), [botReply(null)]);

    const region = screen.getByTestId("bot-thread-replies");
    const spinner = within(region).getByTestId(
      "bot-chat-transcript-connecting",
    );
    // The post is held above the spinner, in the same scroller, so a long one
    // cannot push the box out of the pane.
    const anchor = within(region).getByTestId("bot-thread-anchor");
    expect(
      anchor.compareDocumentPosition(spinner) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(region)
        .getByTestId("bot-thread-reply-count")
        .compareDocumentPosition(spinner) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(region.contains(screen.getByTestId("bot-thread-composer"))).toBe(
      false,
    );
    expect(screen.queryByTestId("bot-thread-post-scroll")).toBeNull();
  });

  it("says a failed read of the list under the post, keeps the box and its draft, and shows the thread once Retry reads it", async () => {
    const user = userEvent.setup();
    const retry = vi.fn<() => void>();
    channelMessages = [announcement("anchor-1", "Ship the release today?")];
    const view = mountPanel({ ...POSTED, retry }, []);
    const box = replyBox();
    typeInto(box, "And the nightly?");

    const failure = screen.getByTestId("bot-thread-error");
    expect(postScroll().contains(screen.getByTestId("bot-thread-anchor"))).toBe(
      true,
    );
    expect(postScroll().nextElementSibling?.contains(failure)).toBe(true);
    await user.click(within(failure).getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);

    // The read Retry asked for returns the thread, with the bot's answer.
    act(() => {
      mocks.handle?.store.setState({ messages: [botReply(null)] });
    });
    view.rerender(panelTree(listed("user-teammate")));

    expect(screen.queryByTestId("bot-thread-error")).toBeNull();
    expect(
      within(screen.getByTestId("bot-thread-replies")).getByText(
        "Which way should I go?",
      ),
    ).toBeTruthy();
    expect(replyBox()).toBe(box);
    expect(textOf(box)).toBe("And the nightly?");
  });
});

describe("<BotThreadPanel /> the anchor", () => {
  it("shows an image on the post before and after the channel row arrives", () => {
    const image =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const content: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Ship the release today?" },
            {
              type: "imageAttachment",
              attrs: {
                id: "release-image",
                fileName: "release-train.png",
                mimeType: "image/png",
                b64content: image,
              },
            },
          ],
        },
      ],
    };
    panelSent = {
      threadId: THREAD_ID,
      requestId: "req-1",
      text: "Ship the release today?",
      content,
      senderUserId: null,
      sentAt: 1_000,
      delivery: "written",
    };
    mountPanel(listed("user-teammate"), []);
    const pending = within(screen.getByTestId("bot-thread-anchor"));
    expect(
      pending.getByRole("img", { name: "release-train.png" }),
    ).toHaveProperty("src", `data:image/png;base64,${image}`);
    cleanup();

    channelMessages = [
      {
        role: "user",
        messageId: "anchor-1",
        sender: { type: "user", userId: "user-teammate" },
        message: { kind: "user", content, browserAnnotations: [] },
        timestamp: 1_000,
        sessionAnchor: null,
      },
    ];
    mountPanel(listed("user-teammate"), []);
    const loaded = within(screen.getByTestId("bot-thread-anchor"));
    expect(
      loaded.getByRole("img", { name: "release-train.png" }),
    ).toHaveProperty("src", `data:image/png;base64,${image}`);
  });

  it("draws a member's post under their name, with no request badge whether it is open or resolved", () => {
    mountPanel(listed("user-teammate"), []);

    const anchor = screen.getByTestId("bot-thread-anchor");
    expect(within(anchor).getByText("Tess Teammate")).toBeTruthy();
    expect(within(anchor).queryByTestId("conversation-request")).toBeNull();
    expect(within(anchor).queryByText("Open")).toBeNull();
    expect(within(anchor).queryByTestId("bot-message-actions")).toBeNull();
    cleanup();

    const resolved = listed("user-teammate");
    if (resolved.thread.anchor === null) {
      throw new Error("expected a listed thread with an anchor");
    }
    mountPanel(
      {
        kind: "listed",
        retry: null,
        thread: {
          ...resolved.thread,
          anchor: { ...resolved.thread.anchor, resolvedAt: 3_000 },
        },
        sendable: true,
      },
      [],
    );
    const settled = screen.getByTestId("bot-thread-anchor");
    expect(within(settled).queryByTestId("conversation-request")).toBeNull();
    expect(within(settled).queryByText("Resolved")).toBeNull();
  });

  it("opens a listed thread on its post - writer, time and text - then the rule and reply count, then the replies", () => {
    channelMessages = [
      announcement("other-post", "Something else"),
      {
        role: "user",
        messageId: "anchor-1",
        sender: { type: "user", userId: "user-teammate" },
        message: {
          kind: "user",
          content: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Ship the release today?" }],
              },
            ],
          },
          browserAnnotations: [],
        },
        timestamp: 1_000,
        sessionAnchor: null,
        conversationRequest: {
          requestId: "req-1",
          resolvedAt: null,
          resolvedByMessageId: null,
        },
      },
    ];
    mountPanel(listed("user-teammate"), [botReply(null)]);

    const anchor = screen.getByTestId("bot-thread-anchor");
    expect(within(anchor).getByText("Tess Teammate")).toBeTruthy();
    expect(
      within(anchor)
        .getByTestId("chat-message-timestamp")
        .getAttribute("datetime"),
    ).toBe(new Date(1_000).toISOString());
    expect(within(anchor).getByText("Ship the release today?")).toBeTruthy();
    expect(within(anchor).queryByText("Something else")).toBeNull();
    expect(within(anchor).queryByTestId("bot-message-actions")).toBeNull();
    const count = screen.getByTestId("bot-thread-reply-count");
    const replies = screen.getByTestId("chat-messages-stub");
    // The post and the count are the first things in the replies' list, which
    // scrolls them with the rows; the box is outside it.
    const region = screen.getByTestId("bot-thread-replies");
    expect(region.contains(replies)).toBe(true);
    expect(replies.contains(anchor)).toBe(true);
    expect(replies.contains(count)).toBe(true);
    expect(region.contains(screen.getByTestId("bot-thread-composer"))).toBe(
      false,
    );
    expect(screen.queryByTestId("bot-thread-post-scroll")).toBeNull();
    const reply = within(replies).getByText("Which way should I go?");
    expect(
      anchor.compareDocumentPosition(count) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      count.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(anchor).queryByText("Which way should I go?")).toBeNull();
  });

  it("opens a thread the list does not show yet on its post, above the wait", () => {
    channelMessages = [announcement("anchor-1", "Ship the release today?")];
    mountPanel({ kind: "pending" }, []);

    const anchor = screen.getByTestId("bot-thread-anchor");
    expect(within(anchor).getByText("Ship the release today?")).toBeTruthy();
    expectPostScrolls();
    expect(screen.queryByTestId("bot-thread-composer")).toBeNull();
    expect(
      anchor.compareDocumentPosition(screen.getByTestId("bot-thread-loading")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("opens a thread whose list read failed on its post in its own scroll region", () => {
    channelMessages = [announcement("anchor-1", "Ship the release today?")];
    mountPanel({ kind: "failed", retry: () => undefined }, []);

    expectPostScrolls();
    expect(screen.queryByTestId("bot-thread-composer")).toBeNull();
    expect(screen.queryByTestId("bot-thread-replies")).toBeNull();
  });

  it("heads the thread with its name, the bot's picture and the bot's title, without a hash", () => {
    mountPanel(listed("user-teammate"), []);

    const channel = screen.getByTestId("bot-thread-channel");
    expect(within(channel).getByText("Release Bot")).toBeTruthy();
    expect(channel.textContent).not.toContain("#");
    expect(within(channel).getByTestId("bot-avatar")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Thread" })).toBeTruthy();
  });

  it("rule 8: has no Activity button on a listed thread", () => {
    mountPanel(listed("user-teammate"), [botReply(null)]);

    expect(screen.queryByTestId("bot-thread-activity")).toBeNull();
    expect(screen.queryByRole("button", { name: "Activity" })).toBeNull();
  });

  it("shows the anchor without text while the channel has no row for it, and its text once the channel's row is there", () => {
    mountPanel(listed("user-teammate"), []);
    const bare = screen.getByTestId("bot-thread-anchor");
    expect(within(bare).queryByText("Ship the release today?")).toBeNull();
    cleanup();

    channelMessages = [
      announcement("other-post", "Something else"),
      announcement("anchor-1", "Ship the release today?"),
    ];
    mountPanel(listed("user-teammate"), []);
    const anchor = screen.getByTestId("bot-thread-anchor");
    expect(within(anchor).getByText("Ship the release today?")).toBeTruthy();
    expect(within(anchor).queryByText("Something else")).toBeNull();
  });

  it("locates an anchor the channel has not loaded, holds that ordinal hydrated, shows its text once the row lands, and releases the hold on unmount", () => {
    mocks.locatedOrdinal = 7;
    const view = mountPanel(listed("user-teammate"), []);

    expect(mocks.locateTargets[0]).toEqual({
      kind: "message",
      messageId: "anchor-1",
    });
    expect(channelHold).toHaveBeenCalledWith(7);
    // StrictMode re-runs the effect, so what matters is that one hold is live.
    const liveHolds = (): number =>
      channelHold.mock.calls.length - channelRelease.mock.calls.length;
    expect(liveHolds()).toBe(1);
    const bare = screen.getByTestId("bot-thread-anchor");
    expect(within(bare).queryByText("Ship the release today?")).toBeNull();

    // Hydration brings the held row into the channel's loaded messages.
    act(() => {
      mocks.channelHandle?.store.setState({
        messages: [announcement("anchor-1", "Ship the release today?")],
      });
    });
    const anchor = screen.getByTestId("bot-thread-anchor");
    expect(within(anchor).getByText("Ship the release today?")).toBeTruthy();
    expect(liveHolds()).toBe(1);

    view.unmount();
    expect(liveHolds()).toBe(0);
  });

  it("opens on a message of the thread it has not loaded, asking the host where it is and holding that ordinal hydrated", () => {
    channelMessages = [announcement("anchor-1", "Ship the release today?")];
    panelLanding = { messageId: "reply-cold", sendPostId: null, visit: 1 };
    mocks.locatedOrdinal = 12;
    mountPanel(listed("user-teammate"), [botReply(null)]);

    expect(mocks.locateTargets).toContainEqual({
      kind: "message",
      messageId: "reply-cold",
    });
    expect(
      mocks.handle?.store.getState().requestTranscriptOrdinal,
    ).toHaveBeenCalledWith(12);
  });

  it("does not locate or hold anything when the channel already has the anchor's row", () => {
    channelMessages = [announcement("anchor-1", "Ship the release today?")];
    mocks.locatedOrdinal = 7;
    mountPanel(listed("user-teammate"), []);

    expect(mocks.locateTargets).toEqual([]);
    expect(channelHold).not.toHaveBeenCalled();
  });

  it("draws a bot's own announcement in the bot's frame, with no request badge", () => {
    channelMessages = [announcement("anchor-1", "Ship the release today?")];
    mountPanel(listed(null), []);

    const anchor = screen.getByTestId("bot-thread-anchor");
    expect(within(anchor).getByText("Release Bot")).toBeTruthy();
    expect(within(anchor).getByTestId("bot-avatar")).toBeTruthy();
    expect(within(anchor).getByText("Ship the release today?")).toBeTruthy();
    expect(within(anchor).queryByTestId("conversation-request")).toBeNull();
    expect(within(anchor).queryByText("Open")).toBeNull();
  });

  it("names no owner on a bot's question it opens on, inside the bot's surface", () => {
    channelMessages = [announcement("anchor-1", "Ship the release today?")];
    stageSessions([]);
    render(
      <BotIdentityContext
        value={{
          botId: BOT_ID,
          title: "Release Bot",
          owner: {
            kind: "person",
            userId: "owner-1",
            name: "Olive Owner",
            avatarUrl: null,
          },
        }}
      >
        {panelTree(listed(null))}
      </BotIdentityContext>,
    );

    const anchor = screen.getByTestId("bot-thread-anchor");
    expect(within(anchor).getByTestId("bot-row-name").textContent).toBe(
      "Release Bot",
    );
    expect(within(anchor).queryByTestId("bot-owner-line")).toBeNull();
    expect(anchor.textContent).not.toMatch(/managed by/i);
    expect(anchor.textContent).not.toContain("Olive Owner");
  });
});

describe("<BotThreadPanel /> Reply on a row of the thread", () => {
  it("names the row in the thread's box when Reply is chosen, and sends its id as the message it replies to", async () => {
    const user = userEvent.setup();
    panelReplyReach = "delivered";
    mountPanel(listed("user-teammate"), [botReply(null)]);
    const row = within(screen.getByTestId("chat-messages-stub")).getByTestId(
      "bot-reply-row",
    );

    await user.click(within(row).getByTestId("bot-message-reply"));

    expect(
      screen.getByTestId("bot-thread-composer-reply-author").textContent,
    ).toBe("Release Bot");
    expect(
      screen.getByTestId("bot-thread-composer-reply-line").textContent,
    ).toBe("Which way should I go?");
    typeInto(boxInput("Reply in the thread"), "Hold");
    await user.click(screen.getByTestId("bot-thread-composer-send"));

    expect(sent).toEqual([
      {
        botId: BOT_ID,
        conversationId: CONVERSATION_ID,
        text: "Hold",
        threadId: THREAD_ID,
        announcementId: null,
        redeliver: null,
        supersedes: null,
        answer: null,
        replyTo: "reply-1",
      },
    ]);
    expect(screen.queryByTestId("bot-thread-composer-reply")).toBeNull();
  });

  it.each<BotReplyReach>(["held-back", "none"])(
    "offers no Reply on a row of the thread where the reach is %s",
    (reach) => {
      panelReplyReach = reach;
      mountPanel(listed("user-teammate"), [botReply(null)]);

      expect(screen.queryByTestId("bot-message-reply")).toBeNull();
    },
  );
});

describe("<BotThreadPanel /> a message the bot failed to answer", () => {
  const REPLY_REQUEST = "req-reply";
  const POST_REQUEST = "req-1";

  function textDoc(text: string): JsonContent {
    return {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    };
  }

  /** `senderUserId`'s message in the thread (or the channel), its request open. */
  function memberMessage(
    messageId: string,
    requestId: string,
    text: string,
    senderUserId: string,
  ): Message {
    return {
      role: "user",
      messageId,
      sender: { type: "user", userId: senderUserId },
      message: { kind: "user", content: textDoc(text), browserAnnotations: [] },
      timestamp: 3_000,
      sessionAnchor: null,
      conversationRequest: {
        requestId,
        resolvedAt: null,
        resolvedByMessageId: null,
      },
    };
  }

  /** The thread's own session failed or parked answering `requestId`. */
  function threadSession(
    state: "failed" | "parked",
    requestId: string | null,
  ): BotActivity {
    return {
      trunk: null,
      threads: {
        [THREAD_ID]: {
          state,
          startedAt: 1_000,
          step: null,
          requestId,
          reason: null,
        },
      },
    };
  }

  function threadFailedOn(requestId: string): BotActivity {
    return threadSession("failed", requestId);
  }

  /** The member's message in the thread's transcript, not the post it opens on. */
  function replyRow(): HTMLElement {
    const anchor = screen.getByTestId("bot-thread-anchor");
    const rows = within(screen.getByTestId("chat-messages-stub"))
      .getAllByTestId("bot-member-row")
      .filter((row) => !anchor.contains(row));
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  /** The viewer's own reply in the thread, which the thread's session failed on. */
  function mountFailedReply(): void {
    activityStore.setState({ activity: threadFailedOn(REPLY_REQUEST) });
    mountPanel(listed(VIEWER_USER_ID), [
      memberMessage(
        "member-reply-1",
        REPLY_REQUEST,
        "Hold for now",
        VIEWER_USER_ID,
      ),
    ]);
  }

  it("offers neither Retry nor Edit on a failed reply while the thread takes no send, and both once it does again", async () => {
    const user = userEvent.setup();
    activityStore.setState({ activity: threadFailedOn(REPLY_REQUEST) });
    const taking = listed(VIEWER_USER_ID);
    const view = mountPanel({ ...taking, sendable: false }, [
      memberMessage(
        "member-reply-1",
        REPLY_REQUEST,
        "Hold for now",
        VIEWER_USER_ID,
      ),
    ]);

    expect(
      within(replyRow()).getByTestId("bot-message-unanswered").textContent,
    ).toBe("Not answered");
    expect(screen.queryByTestId("bot-message-retry")).toBeNull();
    expect(screen.queryByTestId("bot-message-edit")).toBeNull();

    view.rerender(panelTree(taking));
    await user.click(within(replyRow()).getByTestId("bot-message-retry"));

    expect(sent.map((request) => request.redeliver)).toEqual([
      { requestId: REPLY_REQUEST },
    ]);
  });

  it("retries a failed reply as it is in its own thread, with Retry unavailable while it is being sent", async () => {
    const user = userEvent.setup();
    let land: (response: BotConversationSendResponse) => void = () => {};
    sendAnswer = () =>
      new Promise<BotConversationSendResponse>((resolve) => {
        land = resolve;
      });
    mountFailedReply();
    const row = replyRow();
    expect(
      within(screen.getByTestId("bot-thread-anchor")).queryByTestId(
        "bot-message-unanswered",
      ),
    ).toBeNull();
    // The reply says it under its text, in the thread.
    expect(within(row).getByTestId("bot-message-unanswered").textContent).toBe(
      "Not answered · Retry · Edit",
    );

    await user.click(within(row).getByTestId("bot-message-retry"));

    expect(sent).toEqual([
      {
        botId: BOT_ID,
        conversationId: CONVERSATION_ID,
        text: "Hold for now",
        threadId: THREAD_ID,
        announcementId: null,
        redeliver: { requestId: REPLY_REQUEST },
        supersedes: null,
        answer: null,
      },
    ]);
    await waitFor(() => {
      expect(
        within(row).getByTestId("bot-message-retry").hasAttribute("disabled"),
      ).toBe(true);
    });
    expect(
      within(row).getByTestId("bot-message-edit").hasAttribute("disabled"),
    ).toBe(false);

    land(SEND_RESPONSE);

    await waitFor(() => {
      expect(
        within(row).getByTestId("bot-message-retry").hasAttribute("disabled"),
      ).toBe(false);
    });
  });

  it("offers no Reply on a row of the thread while the thread's box edits a failed reply", async () => {
    const user = userEvent.setup();
    panelReplyReach = "delivered";
    mountFailedReply();
    expect(within(replyRow()).getByTestId("bot-message-reply")).toBeTruthy();

    await user.click(within(replyRow()).getByTestId("bot-message-edit"));

    expect(screen.queryByTestId("bot-message-reply")).toBeNull();
  });

  it("puts a failed reply back in the thread's box, and what is sent replaces it", async () => {
    const user = userEvent.setup();
    mountFailedReply();
    const box = boxInput("Reply in the thread");
    expect(screen.queryByTestId("bot-thread-composer-editing")).toBeNull();

    await user.click(within(replyRow()).getByTestId("bot-message-edit"));

    expect(textOf(box)).toBe("Hold for now");
    expect(
      screen.getByTestId("bot-thread-composer-editing").textContent,
    ).toContain("Sending replaces your message that failed.");

    typeInto(box, " please");
    await user.click(screen.getByTestId("bot-thread-composer-send"));

    expect(sent).toEqual([
      {
        botId: BOT_ID,
        conversationId: CONVERSATION_ID,
        text: "Hold for now please",
        threadId: THREAD_ID,
        announcementId: null,
        redeliver: null,
        supersedes: REPLY_REQUEST,
        answer: null,
      },
    ]);
    await waitFor(() => {
      expect(screen.queryByTestId("bot-thread-composer-editing")).toBeNull();
    });
    expect(textOf(box)).toBe("");
  });

  /** The viewer's failed reply in the thread under the bot's direct reply, put back in the box by its Edit and typed on. */
  async function editedAnswerReply(user: UserEvent): Promise<{
    readonly panel: RenderResult;
    readonly taking: BotThreadPanelThread;
    readonly box: HTMLElement;
  }> {
    activityStore.setState({ activity: threadFailedOn(REPLY_REQUEST) });
    panelOrigin = "answer-1";
    const taking = listed(VIEWER_USER_ID);
    const panel = mountPanel(taking, [
      memberMessage(
        "member-reply-1",
        REPLY_REQUEST,
        "Hold for now",
        VIEWER_USER_ID,
      ),
    ]);
    const box = editableIn(screen.getByTestId("bot-thread-composer-input"));
    await user.click(within(replyRow()).getByTestId("bot-message-edit"));
    typeInto(box, " please");
    return { panel, taking, box };
  }

  it("keeps an edit and its text while a claim's list drops the thread and lists it again, and what is sent then replaces the failed reply", async () => {
    const user = userEvent.setup();
    const { panel, taking, box } = await editedAnswerReply(user);

    panel.rerender(
      panelTree({ kind: "unopened", retry: null, sendable: false }),
    );
    expect(textOf(box)).toBe("Hold for now please");
    expect(screen.getByTestId("bot-thread-composer-editing")).toBeTruthy();
    // What it sends still replaces a message of the thread.
    expect(boxInput("Reply in the thread")).toBe(box);
    panel.rerender(panelTree(taking));
    expect(editableIn(screen.getByTestId("bot-thread-composer-input"))).toBe(
      box,
    );
    expect(textOf(box)).toBe("Hold for now please");
    await user.click(screen.getByTestId("bot-thread-composer-send"));

    expect(sent).toEqual([
      {
        botId: BOT_ID,
        conversationId: CONVERSATION_ID,
        text: "Hold for now please",
        threadId: THREAD_ID,
        announcementId: null,
        redeliver: null,
        supersedes: REPLY_REQUEST,
        answer: null,
      },
    ]);
  });

  it("sends an edit from the box under the reply, while the list does not have its thread, as the failed reply's replacement", async () => {
    const user = userEvent.setup();
    const { panel } = await editedAnswerReply(user);

    panel.rerender(
      panelTree({ kind: "unopened", retry: null, sendable: true }),
    );
    await user.click(screen.getByTestId("bot-thread-composer-send"));

    expect(sent).toEqual([
      {
        botId: BOT_ID,
        conversationId: CONVERSATION_ID,
        text: "Hold for now please",
        threadId: null,
        announcementId: "answer-1",
        redeliver: null,
        supersedes: REPLY_REQUEST,
        answer: null,
      },
    ]);
  });

  it("clears the box and ends the edit when an edit sent before the list dropped the thread lands", async () => {
    const user = userEvent.setup();
    let land: (response: BotConversationSendResponse) => void = () => {};
    sendAnswer = () =>
      new Promise<BotConversationSendResponse>((resolve) => {
        land = resolve;
      });
    const { panel, taking, box } = await editedAnswerReply(user);
    await user.click(screen.getByTestId("bot-thread-composer-send"));
    expect(sent.map((request) => request.supersedes)).toEqual([REPLY_REQUEST]);

    panel.rerender(
      panelTree({ kind: "unopened", retry: null, sendable: false }),
    );
    act(() => land(SEND_RESPONSE));

    await waitFor(() => {
      expect(textOf(box)).toBe("");
    });
    expect(screen.queryByTestId("bot-thread-composer-editing")).toBeNull();
    // With the edit ended, the box under the reply starts its thread again.
    expect(boxInput("Reply in a new thread")).toBe(box);
    panel.rerender(panelTree(taking));
    expect(textOf(box)).toBe("");
    expect(screen.queryByTestId("bot-thread-composer-editing")).toBeNull();
  });

  it("drops the edit and its text when the person cancels it", async () => {
    const user = userEvent.setup();
    mountFailedReply();
    await user.click(within(replyRow()).getByTestId("bot-message-edit"));

    await user.click(screen.getByTestId("bot-thread-composer-edit-cancel"));

    expect(screen.queryByTestId("bot-thread-composer-editing")).toBeNull();
    const box = boxInput("Reply in the thread");
    expect(textOf(box)).toBe("");
    expect(sent).toEqual([]);
  });

  it("retries the post the thread answers as a channel post, and hands its edit to the channel's box", async () => {
    const user = userEvent.setup();
    channelMessages = [
      memberMessage(
        "anchor-1",
        POST_REQUEST,
        "Ship the release today?",
        VIEWER_USER_ID,
      ),
    ];
    activityStore.setState({ activity: threadFailedOn(POST_REQUEST) });
    mountPanel(listed(VIEWER_USER_ID), []);
    const anchor = screen.getByTestId("bot-thread-anchor");
    // The post it opens on says it, with nothing on hover.
    expect(within(anchor).queryByTestId("bot-message-actions")).toBeNull();
    expect(
      within(anchor).getByTestId("bot-message-unanswered").textContent,
    ).toBe("Not answered · Retry · Edit");

    await user.click(within(anchor).getByTestId("bot-message-unanswered-edit"));

    expect(onEditPost).toHaveBeenCalledWith({
      requestId: POST_REQUEST,
      text: "Ship the release today?",
      content: null,
    });
    expect(screen.queryByTestId("bot-thread-composer-editing")).toBeNull();

    await user.click(
      within(anchor).getByTestId("bot-message-unanswered-retry"),
    );

    expect(sent).toEqual([
      {
        botId: BOT_ID,
        conversationId: CONVERSATION_ID,
        text: "Ship the release today?",
        threadId: null,
        announcementId: null,
        redeliver: { requestId: POST_REQUEST },
        supersedes: null,
        answer: null,
      },
    ]);
  });

  it("takes Retry and Edit away once the thread's session has moved on", () => {
    mountFailedReply();
    expect(screen.getByTestId("bot-message-retry")).toBeTruthy();
    expect(screen.getByTestId("bot-message-edit")).toBeTruthy();

    act(() => {
      activityStore.setState({
        activity: {
          trunk: null,
          threads: {
            [THREAD_ID]: {
              state: "idle",
              startedAt: null,
              step: null,
              requestId: null,
              reason: null,
            },
          },
        },
      });
    });

    expect(screen.queryByTestId("bot-message-retry")).toBeNull();
    expect(screen.queryByTestId("bot-message-edit")).toBeNull();
    expect(screen.queryByTestId("bot-message-unanswered")).toBeNull();
    expect(screen.getByText("Hold for now")).toBeTruthy();
  });

  it("says why on the reply and on the anchor post, with neither Retry nor Edit, when the host negotiated bot.conversation.send 1.0", () => {
    negotiateBotSend(HOST_ID, { major: 1, minor: 0 });
    channelMessages = [
      memberMessage("anchor-1", POST_REQUEST, "Ship it?", VIEWER_USER_ID),
    ];
    // Both the reply's and the anchor post's requests are held by a failed session.
    activityStore.setState({
      activity: {
        trunk: {
          state: "failed",
          startedAt: 1_000,
          step: null,
          requestId: POST_REQUEST,
          reason: null,
        },
        threads: threadFailedOn(REPLY_REQUEST).threads,
      },
    });
    mountPanel(listed(VIEWER_USER_ID), [
      memberMessage(
        "member-reply-1",
        REPLY_REQUEST,
        "Hold for now",
        VIEWER_USER_ID,
      ),
    ]);

    expect(screen.getByText("Hold for now")).toBeTruthy();
    expect(screen.getByText("Ship it?")).toBeTruthy();
    expect(
      within(replyRow()).getByTestId("bot-message-unanswered").textContent,
    ).toBe("Not answered");
    expect(
      within(screen.getByTestId("bot-thread-anchor")).getByTestId(
        "bot-message-unanswered",
      ).textContent,
    ).toBe("Not answered");
    expect(screen.queryByTestId("bot-message-retry")).toBeNull();
    expect(screen.queryByTestId("bot-message-edit")).toBeNull();
    expect(screen.queryByTestId("bot-message-unanswered-retry")).toBeNull();
    expect(screen.queryByTestId("bot-message-unanswered-edit")).toBeNull();
  });

  it("says why on a failed anchor post whose row has not loaded, offering Retry and Edit only once its text is there", async () => {
    const user = userEvent.setup();
    activityStore.setState({
      activity: {
        trunk: null,
        threads: {
          [THREAD_ID]: {
            ...threadFailedOn(POST_REQUEST).threads[THREAD_ID],
            reason: {
              summary: "Claude is signed out.",
              code: null,
              harnessId: "claude",
              action: "sign-in",
            },
          },
        },
      },
    });
    mountPanel(listed(VIEWER_USER_ID), []);

    const bare = screen.getByTestId("bot-thread-anchor");
    expect(bare.getAttribute("data-loaded")).toBe("false");
    expect(within(bare).getByTestId("bot-message-unanswered").textContent).toBe(
      "Not answered: Claude is signed out. · Sign in",
    );
    expect(
      within(bare).queryByTestId("bot-message-unanswered-retry"),
    ).toBeNull();
    expect(
      within(bare).queryByTestId("bot-message-unanswered-edit"),
    ).toBeNull();

    act(() => {
      mocks.channelHandle?.store.setState({
        messages: [
          memberMessage("anchor-1", POST_REQUEST, "Ship it?", VIEWER_USER_ID),
        ],
      });
    });

    const anchor = screen.getByTestId("bot-thread-anchor");
    expect(anchor.getAttribute("data-loaded")).toBe("true");
    expect(
      within(anchor).getByTestId("bot-message-unanswered").textContent,
    ).toBe("Not answered: Claude is signed out. · Retry · Edit · Sign in");
    await user.click(
      within(anchor).getByTestId("bot-message-unanswered-retry"),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe("Ship it?");
    expect(sent[0].redeliver).toEqual({ requestId: POST_REQUEST });
    await user.click(within(anchor).getByTestId("bot-message-unanswered-edit"));
    expect(onEditPost).toHaveBeenCalledWith({
      requestId: POST_REQUEST,
      text: "Ship it?",
      content: null,
    });
  });

  it.each([
    ["not listed yet", { kind: "pending" } as const],
    ["failed to read", { kind: "failed", retry: () => undefined } as const],
  ])(
    "says a refused retry of the anchor post in the panel while the thread is %s",
    async (_name, thread) => {
      const user = userEvent.setup();
      sendAnswer = () => Promise.reject(new Error("host refused the retry"));
      channelMessages = [
        memberMessage("anchor-1", POST_REQUEST, "Ship it?", VIEWER_USER_ID),
      ];
      activityStore.setState({ activity: threadFailedOn(POST_REQUEST) });
      mountPanel(thread, []);
      expect(screen.queryByTestId("bot-thread-send-failed")).toBeNull();

      await user.click(
        within(screen.getByTestId("bot-thread-anchor")).getByTestId(
          "bot-message-unanswered-retry",
        ),
      );

      expect(sent).toHaveLength(1);
      const notice = await screen.findByTestId("bot-thread-send-failed");
      expect(notice.textContent).toBe("Couldn't send. Try again.");
    },
  );

  it("offers Retry on a reply its thread's session parked on, re-delivered in the thread", async () => {
    const user = userEvent.setup();
    activityStore.setState({
      activity: threadSession("parked", REPLY_REQUEST),
    });
    mountPanel(listed(VIEWER_USER_ID), [
      memberMessage(
        "member-reply-1",
        REPLY_REQUEST,
        "Hold for now",
        VIEWER_USER_ID,
      ),
    ]);

    await user.click(within(replyRow()).getByTestId("bot-message-retry"));

    expect(sent).toHaveLength(1);
    expect(sent[0].redeliver).toEqual({ requestId: REPLY_REQUEST });
    expect(sent[0].threadId).toBe(THREAD_ID);
  });

  it("offers Retry on the anchor post its thread's session parked on, as a channel post", async () => {
    const user = userEvent.setup();
    channelMessages = [
      memberMessage("anchor-1", POST_REQUEST, "Ship it?", VIEWER_USER_ID),
    ];
    activityStore.setState({ activity: threadSession("parked", POST_REQUEST) });
    mountPanel(listed(VIEWER_USER_ID), []);

    const line = within(screen.getByTestId("bot-thread-anchor")).getByTestId(
      "bot-message-unanswered",
    );
    expect(line.getAttribute("data-state")).toBe("parked");
    expect(line.textContent).toBe("Not answered · Retry");
    await user.click(within(line).getByTestId("bot-message-unanswered-retry"));

    expect(sent).toHaveLength(1);
    expect(sent[0].redeliver).toEqual({ requestId: POST_REQUEST });
    expect(sent[0].threadId).toBeNull();
  });

  it("offers nothing when the parked session carries no request", () => {
    activityStore.setState({ activity: threadSession("parked", null) });
    channelMessages = [
      memberMessage("anchor-1", POST_REQUEST, "Ship it?", VIEWER_USER_ID),
    ];
    mountPanel(listed(VIEWER_USER_ID), [
      memberMessage(
        "member-reply-1",
        REPLY_REQUEST,
        "Hold for now",
        VIEWER_USER_ID,
      ),
    ]);

    expect(screen.getByText("Hold for now")).toBeTruthy();
    expect(screen.queryByTestId("bot-message-retry")).toBeNull();
    expect(screen.queryByTestId("bot-message-edit")).toBeNull();
    expect(screen.queryByTestId("bot-message-unanswered")).toBeNull();
  });

  it("says a teammate's reply failed, with no Retry and no Edit, and sends nothing", () => {
    activityStore.setState({ activity: threadFailedOn(REPLY_REQUEST) });
    mountPanel(listed(VIEWER_USER_ID), [
      memberMessage(
        "member-reply-1",
        REPLY_REQUEST,
        "Hold for now",
        "user-teammate",
      ),
    ]);
    const row = replyRow();

    expect(within(row).getByTestId("bot-message-unanswered")).toBeTruthy();
    expect(within(row).queryByTestId("bot-message-retry")).toBeNull();
    expect(within(row).queryByTestId("bot-message-edit")).toBeNull();
    expect(within(row).queryAllByRole("button", { name: "Retry" })).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("says the anchor post a teammate wrote failed, with no Retry and no Edit", () => {
    channelMessages = [
      memberMessage("anchor-1", POST_REQUEST, "Ship it?", "user-teammate"),
    ];
    activityStore.setState({ activity: threadFailedOn(POST_REQUEST) });
    mountPanel(listed("user-teammate"), []);

    const anchor = screen.getByTestId("bot-thread-anchor");
    expect(within(anchor).getByTestId("bot-message-unanswered")).toBeTruthy();
    expect(
      within(anchor).queryByTestId("bot-message-unanswered-retry"),
    ).toBeNull();
    expect(
      within(anchor).queryByTestId("bot-message-unanswered-edit"),
    ).toBeNull();
  });
});

describe("<BotThreadPanel /> the thread's tasks", () => {
  function task(
    taskId: string,
    overrides: Partial<BotTaskEntry>,
  ): BotTaskEntry {
    return {
      taskId,
      cadence: { kind: "on-completion" },
      lastCheckinAt: null,
      lastCheckin: null,
      nextAt: null,
      state: "tracking",
      endedReason: null,
      createdByUserId: null,
      spun: true,
      label: null,
      originRequestId: null,
      createdByChatId: THREAD_ID,
      inputNeeded: null,
      pause: null,
      stop: null,
      runRequest: null,
      ...overrides,
    };
  }

  it("lists only the tasks this thread set up, each with the message it was set up for and no link out", () => {
    // The thread hangs off a member's post, whose row id its request names.
    const postId = conversationRequestMessageId("req-1");
    const summary = threadSummary("user-teammate");
    channelMessages = [announcement(postId, "Please review the release")];
    panelTasks = [
      task("task-watch", {
        cadence: { kind: "every", seconds: 3_600 },
        label: "Watching the release",
        originRequestId: "req-1",
      }),
      task("task-fix", { originRequestId: "req-followup" }),
      task("task-trunk", { createdByChatId: null }),
      task("task-other", { createdByChatId: "thread-2" }),
    ];
    mountPanel(
      {
        kind: "listed",
        thread: {
          ...summary,
          anchor: { ...summary.anchor, messageId: postId },
        },
        retry: null,
        sendable: true,
      },
      [
        announcement(
          conversationRequestMessageId("req-followup"),
          "Also rerun the flaky shard",
        ),
      ],
    );

    const section = screen.getByTestId("bot-thread-tasks");
    const rows = within(section).getAllByTestId("bot-task-row");
    expect(rows.map((row) => row.getAttribute("data-task-id"))).toEqual([
      "task-watch",
      "task-fix",
    ]);
    const [watch, fix] = rows;
    expect(within(watch).getByTestId("bot-task-open").textContent).toBe(
      "Release watch",
    );
    expect(within(watch).getByTestId("bot-task-label").textContent).toBe(
      "Watching the release",
    );
    expect(within(watch).getByTestId("bot-task-interval").textContent).toBe(
      "every hour",
    );
    const request = within(watch).getByTestId("bot-task-request");
    expect(request.textContent).toBe("for Please review the release");
    expect(request.tagName).toBe("SPAN");
    expect(within(fix).getByTestId("bot-task-request").textContent).toBe(
      "for Also rerun the flaky shard",
    );
    expect(within(fix).queryByTestId("bot-task-interval")).toBeNull();
    expect(within(section).queryByTestId("bot-task-thread")).toBeNull();
  });

  it("names the reply that opened the thread under the bot's question, not the question, for the task it set up", () => {
    // The thread's anchor is the bot's question; the request is the reply
    // under it, the thread's own first message.
    channelMessages = [
      announcement("anchor-1", "Which release should I watch?"),
    ];
    panelTasks = [task("task-watch", { originRequestId: "req-1" })];
    mountPanel(listed("user-teammate"), [
      announcement(
        conversationRequestMessageId("req-1"),
        "Watch the 2.4 release",
      ),
    ]);

    const section = screen.getByTestId("bot-thread-tasks");
    expect(within(section).getByTestId("bot-task-request").textContent).toBe(
      "for Watch the 2.4 release",
    );
  });

  it("draws nothing when the thread set up no task", () => {
    panelTasks = [
      task("task-trunk", { createdByChatId: null }),
      task("task-other", { createdByChatId: "thread-2" }),
    ];
    mountPanel(listed("user-teammate"), []);

    expect(screen.queryByTestId("bot-thread-tasks")).toBeNull();
  });
});

describe("<BotThreadPanel /> on a short viewport under the keyboard", () => {
  beforeEach(() => {
    setPhoneLayoutOnly(true);
    holdScreenLandscape();
    raiseNativeKeyboard(IPHONE_17);
  });

  afterEach(() => {
    setPhoneLayoutOnly(false);
    restoreKeyboardEnvironment();
  });

  function shown(testId: string): boolean {
    return screen.getByTestId(testId).closest("[hidden]") === null;
  }

  function composerForm(): HTMLElement {
    return screen.getByTestId("bot-thread-composer");
  }

  it("becomes one row while its box has the focus, keeps the draft and the focused field, and restores with the keyboard down", async () => {
    const user = userEvent.setup();
    mountPanel(listed("user-teammate"), [botReply(null)]);
    const box = boxInput("Reply in the thread");
    expect(composerForm().getAttribute("data-box-form")).toBe("full");

    // jsdom does not compute `isContentEditable` from the attribute, which is
    // how the focus layout tells a text entry from a button.
    Object.defineProperty(box, "isContentEditable", {
      configurable: true,
      value: true,
    });
    await user.click(box);
    typeInto(box, "Not yet");
    expect(composerForm().getAttribute("data-box-form")).toBe("one-row");
    expect(shown("bot-thread-session")).toBe(false);
    expect(shown("bot-thread-close")).toBe(true);
    expect(shown("bot-thread-composer-send")).toBe(true);
    expect(boxInput("Reply in the thread")).toBe(box);
    expect(document.activeElement).toBe(box);
    expect(textOf(box)).toBe("Not yet");

    lowerNativeKeyboard();
    expect(composerForm().getAttribute("data-box-form")).toBe("full");
    expect(shown("bot-thread-session")).toBe(true);
  });
});

describe("<BotThreadPanel /> the replying line as the way into the turn", () => {
  const OTHER_REQUEST = "req-trunk";

  function replying(requestId: string | null): BotSessionActivity {
    return {
      state: "replying",
      startedAt: Date.now() - 65_000,
      step: null,
      requestId,
      reason: null,
    };
  }

  function turnOf(chatId: string, requestId: string, threadId: string | null) {
    return turnRef({
      chatId,
      turnId: `turn-${requestId}`,
      userMessageId: `prompt-${requestId}`,
      threadId,
      startedAt: Date.now() - 65_000,
      endedAt: null,
      summary: null,
      messageIds: [],
      requestIds: [requestId],
    });
  }

  beforeEach(() => {
    recordNegotiatedHostManifest(HOST_ID, {
      "bot.conversation.send": { major: 1, minor: 1 },
      "bot.turn.locate": { major: 1, minor: 0 },
    });
  });

  afterEach(() => {
    resetNegotiatedManifests();
  });

  it("opens the thread's own session at its request, though the trunk is replying on another", async () => {
    const user = userEvent.setup();
    const threadTurn = turnOf("session-1", "req-1", THREAD_ID);
    const trunkTurn = turnOf("trunk-chat", OTHER_REQUEST, null);
    const asked: BotTurnLocateRequest[] = [];
    mocks.client = hostClientLocating(
      (request) => turnsAskedFor([threadTurn, trunkTurn], request),
      asked,
    );
    mountPanel(listed("user-teammate"), []);

    act(() => {
      activityStore.setState({
        activity: {
          trunk: replying(OTHER_REQUEST),
          threads: { [THREAD_ID]: replying("req-1") },
        },
      });
    });
    const button = await within(
      screen.getByTestId("bot-thread-replying-strip"),
    ).findByRole("button", { name: "Release Bot is replying…" });
    await user.click(button);

    const call = onOpenTurn.mock.calls.at(-1);
    if (call === undefined) throw new Error("the strip opened nothing");
    expect(call).toEqual([threadTurn, null]);
    expect(sessionTargetOfTurn(call[0], call[1])).toEqual({
      chatId: "session-1",
      threadId: THREAD_ID,
      messageId: "prompt-req-1",
      sendPostId: null,
    });
    expect(asked.map((request) => request.requestIds)).toEqual([["req-1"]]);
  });

  it("is only the status line for a turn that answers no request, and becomes the button on the same node once it names one", async () => {
    const turn = turnOf("session-1", "req-1", THREAD_ID);
    const asked: BotTurnLocateRequest[] = [];
    mocks.client = hostClientLocating(
      (request) => turnsAskedFor([turn], request),
      asked,
    );
    mountPanel(listed("user-teammate"), []);
    const composer = screen.getByTestId("bot-thread-composer");

    act(() => {
      activityStore.setState({
        activity: { trunk: null, threads: { [THREAD_ID]: replying(null) } },
      });
    });
    const strip = screen.getByTestId("bot-thread-replying-strip");
    expect(strip.getAttribute("role")).toBe("status");
    expect(within(strip).getByText("Release Bot is replying…")).toBeTruthy();
    expect(within(strip).queryByRole("button")).toBeNull();
    expect(asked).toEqual([]);

    act(() => {
      activityStore.setState({
        activity: { trunk: null, threads: { [THREAD_ID]: replying("req-1") } },
      });
    });
    await within(strip).findByRole("button", {
      name: "Release Bot is replying…",
    });

    expect(screen.getByTestId("bot-thread-replying-strip")).toBe(strip);
    expect(screen.getByTestId("bot-thread-composer")).toBe(composer);
  });
});

describe("<BotThreadPanel /> a reply that names the post the thread opens on", () => {
  function userPost(): Message {
    return {
      role: "user",
      messageId: "anchor-1",
      sender: { type: "user", userId: "user-teammate" },
      message: {
        kind: "user",
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Ship the release today?" }],
            },
          ],
        },
        browserAnnotations: [],
      },
      timestamp: 1_000,
      sessionAnchor: null,
    };
  }

  it("badges the second reply, not the first directly under the post, and shows the post highlighted when chosen", async () => {
    const user = userEvent.setup();
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
    onTestFinished(() => scrolled.mockRestore());
    channelMessages = [userPost()];
    mountPanel(listed("user-teammate"), [
      { ...botReply(null), repliesTo: "anchor-1" },
      { ...userPost(), messageId: "between-1", timestamp: 2_500 },
      {
        ...botReply(null),
        messageId: "reply-2",
        timestamp: 3_000,
        startedAt: 3_000,
        repliesTo: "anchor-1",
      },
    ]);

    const badges = screen.getAllByTestId("bot-reply-badge");
    expect(badges).toHaveLength(1);
    expect(badges[0]?.getAttribute("aria-label")).toBe(
      "Replying to Tess Teammate: Ship the release today?",
    );
    const opening = screen.getByTestId("bot-thread-opening");
    expect(scrolled).not.toHaveBeenCalled();

    await user.click(badges[0]);

    expect(scrolled).toHaveBeenCalledWith({ block: "nearest" });
    expect(scrolled.mock.contexts).toEqual([opening]);
    for (const token of CHAT_NAVIGATION_HIGHLIGHT_CLASSNAME.split(" ")) {
      expect(opening.classList.contains(token)).toBe(true);
    }
  });
});
