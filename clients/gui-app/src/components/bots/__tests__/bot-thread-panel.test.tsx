/**
 * A bot's thread panel (Tracy Bots, decisions 55, 56). The REAL panel, its
 * transcript (`useRenderedMessages` over a session store's records, each row
 * drawn by the real `<ChatMessage>`), its message box and the `bot.conversation
 * .send` mutation run over a host client whose messenger records the request
 * that leaves. Only the virtualised list is replaced by a stub, as in the
 * reply-jump suite. What is asserted is what the host RECEIVES: a first reply
 * under a question opens its thread, an option clicked in a thread is the
 * person's next message in it, and a thread hung off the bot's own row is
 * drawn as the bot's, with no request to show. Every state opens on the
 * channel row the thread answers, drawn by the channel's own row component.
 */
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
import type {
  BotConversationSendRequest,
  BotConversationSendResponse,
  BotThreadSummary,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { JsonContent } from "@traycer/protocol/common/registry";
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
import { TooltipProvider } from "@/components/ui/tooltip";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import type { ChatLocateRowArgs } from "@/hooks/chats/use-chat-locate-row";
import type {
  ChatSessionState,
  ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { emptyTranscriptWindow } from "@/stores/chats/transcript-window";
import type { BotActivity } from "@/hooks/bots/use-bot-activity";
import type { BotComposerEdit } from "@/components/bots/bot-message-composer";
import type { BotSentPost } from "@/stores/bots/bot-open-thread-store";
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
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessCatalogForClient: () => ({ harnesses: [] }),
}));
vi.mock("@/hooks/chats/use-chat-locate-row", () => ({
  useChatLocateRow: (args: ChatLocateRowArgs) => {
    if (args.target === null) return null;
    mocks.locateTargets.push(args.target);
    return mocks.locatedOrdinal;
  },
}));
vi.mock("@/components/chat/chat-messages", async () => {
  const { ChatExpansionTestProviders: Providers } =
    await import("@/components/chat/__tests__/chat-expansion-test-providers");
  const { ChatMessage } = await import("@/components/chat/chat-message");
  const { ChatEmptyState } = await import("@/components/chat/chat-empty-state");
  const noBackgroundToolBlockIds: ReadonlySet<string> = new Set();
  return {
    // As the real timeline does, a transcript with no row draws the empty state.
    ChatMessages: (props: {
      messages: ReadonlyArray<ChatMessageModel>;
      instanceId: string;
    }) => (
      <Providers tileInstanceId={props.instanceId}>
        <div data-testid="chat-messages-stub">
          {props.messages.length === 0 ? <ChatEmptyState /> : null}
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

import { BotThreadPanel } from "@/components/bots/bot-thread-panel";
import type { BotThreadPanelThread } from "@/components/bots/bot-thread-panel";
import type { BotMemberResolver } from "@/lib/bots/bot-member-names";

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

function threadSummary(anchorSenderUserId: string | null): BotThreadSummary {
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
    },
    replyCount: 1,
    lastReplyAt: 2_000,
    openRequestCount: 1,
    costUsd: null,
  };
}

function botReply(options: ReadonlyArray<string> | null): Message {
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

function announcement(messageId: string, text: string): Message {
  const base = botReply(null);
  if (base.role !== "assistant") throw new Error("botReply is the bot's row");
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
const onEditPost = vi.fn<(edit: BotComposerEdit) => void>();
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

/** The panel on `thread`, over the sessions the last mount made. */
function panelTree(thread: BotThreadPanelThread): ReactNode {
  return (
    <StrictMode>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <ChatExpansionTestProviders tileInstanceId="tile-1">
            <BotThreadPanel
              botId={BOT_ID}
              hostId={HOST_ID}
              boundHostId={HOST_ID}
              botTitle="Release Bot"
              conversationId={CONVERSATION_ID}
              originMessageId={originOf(thread)}
              sent={panelSent}
              thread={thread}
              anchorSenderLabel={(senderUserId) =>
                senderUserId === null ? "You" : "Tess Teammate"
              }
              resolveMember={resolveMember}
              onClose={vi.fn()}
              onOpenUnderTheHood={vi.fn()}
              onEditPost={onEditPost}
            />
          </ChatExpansionTestProviders>
        </TooltipProvider>
      </QueryClientProvider>
    </StrictMode>
  );
}

function listed(anchorSenderUserId: string | null): BotThreadPanelThread {
  return { kind: "listed", thread: threadSummary(anchorSenderUserId) };
}

beforeEach(() => {
  sent = [];
  panelSent = null;
  panelOrigin = null;
  mocks.threadHandle.held = false;
  onEditPost.mockClear();
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
    mountPanel({ kind: "unopened" }, []);

    const origin = screen.getByTestId("bot-thread-anchor");
    expect(within(origin).getByText("Release Bot")).toBeTruthy();
    expect(within(origin).getByText("Ship the release today?")).toBeTruthy();
    expect(within(origin).queryByTestId("bot-message-actions")).toBeNull();
    expect(origin.nextElementSibling?.getAttribute("data-testid")).toBe(
      "bot-thread-composer",
    );
    expect(
      screen.queryByText("Reply to start a thread. The bot answers there."),
    ).toBeNull();
    expect(screen.queryByTestId("chat-messages-stub")).toBeNull();
    expect(screen.queryByTestId("bot-thread-reply-count")).toBeNull();

    await user.type(
      screen.getByRole("textbox", { name: "Reply in a new thread" }),
      "Ship it",
    );
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
      },
    ]);
  });
});

describe("<BotThreadPanel /> a direct reply nobody has replied under", () => {
  /** The member's post, then the bot's direct reply to it, on the channel. */
  function answeredPost(): void {
    const answer = announcement("answer-1", "It failed on the retry job.");
    if (answer.role !== "assistant") throw new Error("expected the bot's row");
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
    mountPanel({ kind: "unopened" }, []);

    const origin = screen.getByTestId("bot-thread-anchor");
    expect(within(origin).getByText("Release Bot")).toBeTruthy();
    expect(
      within(origin).getByText("It failed on the retry job."),
    ).toBeTruthy();
    expect(within(origin).queryByText("Why did the build fail?")).toBeNull();
    expect(within(origin).queryByTestId("bot-message-actions")).toBeNull();

    await user.type(
      screen.getByRole("textbox", { name: "Reply in a new thread" }),
      "Which job?",
    );
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
    mountPanel({ kind: "unopened" }, []);

    await user.type(
      screen.getByRole("textbox", { name: "Reply in a new thread" }),
      "Which job?",
    );
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
});

describe("<BotThreadPanel /> a listed thread", () => {
  it("puts the box right under the post of a listed thread with no reply yet, with no count or rule, and keeps its replies subscribed", () => {
    const zero = listed("user-teammate");
    if (zero.kind !== "listed") throw new Error("expected a listed thread");
    mountPanel(
      { kind: "listed", thread: { ...zero.thread, replyCount: 0 } },
      [],
    );

    expect(screen.queryByTestId("bot-thread-reply-count")).toBeNull();
    const replies = screen.getByTestId("bot-thread-replies");
    expect(replies.getAttribute("data-has-replies")).toBe("false");
    expect(replies.className).not.toContain("flex-1");
    expect(within(replies).getByTestId("bot-chat-transcript")).toBeTruthy();
    // The empty thread's transcript draws nothing between the post and the box.
    expect(replies.textContent).toBe("");
    expect(screen.queryByText("No replies yet.")).toBeNull();
    expect(screen.getByTestId("bot-thread-anchor").nextElementSibling).toBe(
      replies,
    );

    // The subscription held while empty brings the first reply in.
    act(() => {
      mocks.handle?.store.setState({ messages: [botReply(null)] });
    });
    expect(within(replies).getByText("Which way should I go?")).toBeTruthy();
    cleanup();

    mountPanel(listed("user-teammate"), [botReply(null)]);
    const listedReplies = screen.getByTestId("bot-thread-replies");
    expect(listedReplies.getAttribute("data-has-replies")).toBe("true");
    expect(listedReplies.className).toContain("flex-1");
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

  it("draws no choices under a reply that offers none", () => {
    mountPanel(listed("user-teammate"), [botReply(null)]);

    expect(screen.getByText("Which way should I go?")).toBeTruthy();
    expect(screen.queryByTestId("bot-reply-options")).toBeNull();
  });

  it("replies into the thread with its id and no announcement", async () => {
    const user = userEvent.setup();
    mountPanel(listed("user-teammate"), []);

    await user.type(
      screen.getByRole("textbox", { name: "Reply in the thread" }),
      "Hold for now",
    );
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
      },
    ]);
  });
});

describe("<BotThreadPanel /> a thread its post opened as it was sent", () => {
  const POSTED: BotThreadPanelThread = {
    kind: "posted",
    threadId: THREAD_ID,
    retry: null,
  };

  /** The thread's session acquired by the registry, as its effect does after the first render. */
  function acquireThreadHandle(): void {
    act(() => {
      mocks.threadHandle.held = false;
      for (const listener of mocks.threadHandle.listeners) listener();
    });
  }

  function replyBox(): HTMLTextAreaElement {
    const box = screen.getByRole("textbox", { name: "Reply in the thread" });
    if (!(box instanceof HTMLTextAreaElement)) throw new Error("no reply box");
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

    await user.type(replyBox(), "And the nightly?");
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
        },
      ]);
    });
  });

  it("keeps the reply box, its draft and its focus when the list returns the thread", async () => {
    const user = userEvent.setup();
    channelMessages = [announcement("anchor-1", "Ship the release today?")];
    const view = mountPanel(POSTED, []);
    const box = replyBox();
    await user.type(box, "And the nightly?");
    expect(document.activeElement).toBe(box);

    view.rerender(panelTree(listed("user-teammate")));

    expect(screen.getByTestId("bot-thread-under-the-hood")).toBeTruthy();
    expect(screen.getByTestId("bot-thread-replies")).toBeTruthy();
    expect(replyBox()).toBe(box);
    expect(box.value).toBe("And the nightly?");
    expect(document.activeElement).toBe(box);
  });

  it("draws nothing between the post and the box while a listed thread's session connects", async () => {
    const user = userEvent.setup();
    channelMessages = [announcement("anchor-1", "Ship the release today?")];
    const view = mountPanel(POSTED, []);
    const box = replyBox();
    await user.type(box, "And the nightly?");
    const zero = listed("user-teammate");
    if (zero.kind !== "listed") throw new Error("expected a listed thread");

    mocks.threadHandle.held = true;
    view.rerender(
      panelTree({ kind: "listed", thread: { ...zero.thread, replyCount: 0 } }),
    );

    expect(screen.queryByTestId("bot-chat-transcript-connecting")).toBeNull();
    const replies = screen.getByTestId("bot-thread-replies");
    expect(replies.childElementCount).toBe(0);
    expect(screen.getByTestId("bot-thread-anchor").nextElementSibling).toBe(
      replies,
    );

    acquireThreadHandle();
    expect(screen.queryByTestId("bot-chat-transcript-connecting")).toBeNull();
    expect(within(replies).getByTestId("bot-chat-transcript")).toBeTruthy();
    expect(replies.textContent).toBe("");
    expect(replyBox()).toBe(box);
    expect(box.value).toBe("And the nightly?");
  });

  it("holds the place of a thread with replies with a spinner while its session connects", () => {
    mocks.threadHandle.held = true;
    mountPanel(listed("user-teammate"), [botReply(null)]);

    expect(
      within(screen.getByTestId("bot-thread-replies")).getByTestId(
        "bot-chat-transcript-connecting",
      ),
    ).toBeTruthy();
  });

  it("says a failed read of the list under the post, keeps the box and its draft, and shows the thread once Retry reads it", async () => {
    const user = userEvent.setup();
    const retry = vi.fn<() => void>();
    channelMessages = [announcement("anchor-1", "Ship the release today?")];
    const view = mountPanel({ ...POSTED, retry }, []);
    const box = replyBox();
    await user.type(box, "And the nightly?");

    const failure = screen.getByTestId("bot-thread-error");
    expect(
      screen
        .getByTestId("bot-thread-anchor")
        .nextElementSibling?.contains(failure),
    ).toBe(true);
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
    expect(box.value).toBe("And the nightly?");
  });
});

describe("<BotThreadPanel /> the anchor", () => {
  it("draws a member's post under their name, with no request badge whether it is open or resolved", () => {
    mountPanel(listed("user-teammate"), []);

    const anchor = screen.getByTestId("bot-thread-anchor");
    expect(within(anchor).getByText("Tess Teammate")).toBeTruthy();
    expect(within(anchor).queryByTestId("conversation-request")).toBeNull();
    expect(within(anchor).queryByText("Open")).toBeNull();
    expect(within(anchor).queryByTestId("bot-message-actions")).toBeNull();
    cleanup();

    const resolved = listed("user-teammate");
    if (resolved.kind !== "listed" || resolved.thread.anchor === null) {
      throw new Error("expected a listed thread with an anchor");
    }
    mountPanel(
      {
        kind: "listed",
        thread: {
          ...resolved.thread,
          anchor: { ...resolved.thread.anchor, resolvedAt: 3_000 },
        },
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
    expect(
      anchor.compareDocumentPosition(count) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      count.compareDocumentPosition(replies) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(anchor).queryByText("Which way should I go?")).toBeNull();
    expect(within(replies).getByText("Which way should I go?")).toBeTruthy();
  });

  it("opens a thread the list does not show yet on its post, above the wait", () => {
    channelMessages = [announcement("anchor-1", "Ship the release today?")];
    mountPanel({ kind: "pending" }, []);

    const anchor = screen.getByTestId("bot-thread-anchor");
    expect(within(anchor).getByText("Ship the release today?")).toBeTruthy();
    expect(
      anchor.compareDocumentPosition(screen.getByTestId("bot-thread-loading")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("heads the thread with its name, the bot's picture and the bot's title, without a hash", () => {
    mountPanel(listed("user-teammate"), []);

    const channel = screen.getByTestId("bot-thread-channel");
    expect(within(channel).getByText("Release Bot")).toBeTruthy();
    expect(channel.textContent).not.toContain("#");
    expect(within(channel).getByTestId("bot-avatar")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Thread" })).toBeTruthy();
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
          openActivity: null,
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
    return within(screen.getByTestId("chat-messages-stub")).getByTestId(
      "bot-member-row",
    );
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

  it("puts a failed reply back in the thread's box, and what is sent replaces it", async () => {
    const user = userEvent.setup();
    mountFailedReply();
    const box = screen.getByRole("textbox", { name: "Reply in the thread" });
    expect(screen.queryByTestId("bot-thread-composer-editing")).toBeNull();

    await user.click(within(replyRow()).getByTestId("bot-message-edit"));

    expect((box as HTMLTextAreaElement).value).toBe("Hold for now");
    expect(
      screen.getByTestId("bot-thread-composer-editing").textContent,
    ).toContain("Sending replaces your message that failed.");

    await user.type(box, " please");
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
      },
    ]);
    await waitFor(() => {
      expect(screen.queryByTestId("bot-thread-composer-editing")).toBeNull();
    });
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  it("drops the edit and its text when the person cancels it", async () => {
    const user = userEvent.setup();
    mountFailedReply();
    await user.click(within(replyRow()).getByTestId("bot-message-edit"));

    await user.click(screen.getByTestId("bot-thread-composer-edit-cancel"));

    expect(screen.queryByTestId("bot-thread-composer-editing")).toBeNull();
    const box = screen.getByRole("textbox", { name: "Reply in the thread" });
    if (!(box instanceof HTMLTextAreaElement))
      throw new Error("not a textarea");
    expect(box.value).toBe("");
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
      expect(notice.textContent).not.toContain("Edit");
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

  it("offers Retry and no Edit on a teammate's reply", async () => {
    const user = userEvent.setup();
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

    expect(within(row).queryByTestId("bot-message-edit")).toBeNull();
    await user.click(within(row).getByTestId("bot-message-retry"));

    expect(sent).toHaveLength(1);
    expect(sent[0].redeliver).toEqual({ requestId: REPLY_REQUEST });
    expect(sent[0].threadId).toBe(THREAD_ID);
  });

  it("offers Retry and no Edit on the anchor post a teammate wrote", () => {
    channelMessages = [
      memberMessage("anchor-1", POST_REQUEST, "Ship it?", "user-teammate"),
    ];
    activityStore.setState({ activity: threadFailedOn(POST_REQUEST) });
    mountPanel(listed("user-teammate"), []);

    const anchor = screen.getByTestId("bot-thread-anchor");
    expect(
      within(anchor).getByTestId("bot-message-unanswered-retry"),
    ).toBeTruthy();
    expect(
      within(anchor).queryByTestId("bot-message-unanswered-edit"),
    ).toBeNull();
  });
});
