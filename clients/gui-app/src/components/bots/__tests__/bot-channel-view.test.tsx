/**
 * A bot's channel and its open thread (Tracy Bots, decision 41). The real
 * `BotChannelView` and `BotThreadPanel` run over mocked hooks; the transcript
 * and the message box are stubs that expose what the view hands them, so what
 * the channel PASSES them is what is asserted: the thread line it draws under
 * each post, the chat the thread panel reads, and where each box writes.
 */
import type { ReactNode } from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  BotConversationSendRequest,
  BotConversationSendResponse,
  BotThreadAnchors,
  BotThreadSummary,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import type { ChatBotThreadLine } from "@/components/chat/chat-bot-presentation-context";
import type {
  BotTranscriptLanding,
  BotTranscriptSurface,
} from "@/components/bots/bot-chat-transcript";
import { TooltipProvider } from "@/components/ui/tooltip";

interface ThreadListCall {
  readonly botId: string;
  readonly enabled: boolean;
}

interface IndicatorState {
  readonly unreadDone: boolean;
  readonly unreadFailure: boolean;
  readonly unreadCount: number | null;
}

const mocks = vi.hoisted(() => {
  const chats: Record<string, IndicatorState> = {};
  // What the host answers a box's accepted send with.
  const sendResponse: BotConversationSendResponse = {
    messageId: "post-new",
    requestId: "request-new",
    delivery: "written",
    threadId: "thread-new",
  };
  return {
    client: { stub: "tab-host-client" },
    markRead: vi.fn<(entity: { epicId: string; chatId: string }) => void>(),
    refetchThreads: vi.fn<() => void>(),
    send: vi.fn<
      (
        variables: BotConversationSendRequest,
        options: { onError: (error: HostRpcError) => void },
      ) => void
    >(),
    toastFromHostError:
      vi.fn<(error: HostRpcError, fallback: string) => void>(),
    markReadMutation: {
      mutate: (entity: { epicId: string; chatId: string }): void => {
        mocks.markRead(entity);
      },
    },
    postIds: [] as string[],
    // Of `postIds`, the bot's direct replies: their action says so.
    answerIds: [] as string[],
    sendResponse,
    threadListCalls: [] as Array<{
      botId: string;
      enabled: boolean;
    }>,
    state: {
      paneVisible: true,
      threadListSupported: true,
      conversations: [] as Array<{ conversationId: string; createdAt: number }>,
      // What the bot record names as the channel; `null` from an older host.
      appConversationChatId: null as string | null,
      threads: [] as BotThreadSummary[],
      // The rows the bot's host roots a thread on beyond a post, and the
      // binding that said them (`threadAnchors`).
      threadAnchors: null as BotThreadAnchors | null,
      // The bot's binding, as the tab's snapshot names it.
      binding: { hostId: "host-bound", epoch: 1 },
      // `false`: the thread list has not answered (pending, or failed).
      threadListAnswered: true,
      threadListError: false,
      // Whether the read of the bot's conversations failed.
      conversationsError: false,
      // Whether a `bot.conversation.send` is in flight.
      sending: false,
      chats,
    },
  };
});

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.client,
}));
vi.mock("@/hooks/host/use-host-supports-method", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-supports-method")
  >()),
  useHostMethodSupport: () => mocks.state.threadListSupported,
}));
vi.mock("@/components/epic-tabs/pane-visibility-context", () => ({
  usePaneVisible: () => mocks.state.paneVisible,
}));
vi.mock("@/hooks/bots/use-bot-conversation-list-query", () => ({
  useBotConversationListQuery: () => ({
    data: { conversations: mocks.state.conversations },
    isError: mocks.state.conversationsError,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/bots/use-bot-thread-list-query", () => ({
  useBotThreadListQuery: (
    _client: unknown,
    botId: string,
    args: { enabled: boolean },
  ) => {
    mocks.threadListCalls.push({ botId, ...args });
    return {
      data: mocks.state.threadListAnswered
        ? {
            threads: mocks.state.threads,
            threadAnchors: mocks.state.threadAnchors,
          }
        : undefined,
      isError: mocks.state.threadListError,
      refetch: mocks.refetchThreads,
    };
  },
}));
vi.mock("@/hooks/bots/use-bot-mutations", () => ({
  useBotConversationSendMutation: () => ({
    mutate: mocks.send,
    isPending: mocks.state.sending,
    variables: { redeliver: null },
  }),
}));
vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: mocks.toastFromHostError,
}));
vi.mock("@/hooks/notifications/use-notification-indicators-query", () => ({
  useNotificationIndicators: () => ({ epics: {}, chats: mocks.state.chats }),
}));
vi.mock(
  "@/hooks/notifications/use-notification-mark-entity-read-mutation",
  () => ({
    useNotificationMarkEntityRead: () => mocks.markReadMutation,
  }),
);
// What the bot is doing reaches the view through one hook; these cases pin
// the thread lines and the boxes with the bot idle
// (`bot-channel-typing.test.tsx` drives it).
// The thread panel reads its post's text from the channel's session; none is
// loaded here, so the anchor shows without text.
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useChatSessionHandleForContainer: () => null,
}));
vi.mock("@/hooks/bots/use-bot-activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/bots/use-bot-activity")>()),
  useBotActivity: () => null,
}));
vi.mock("@/components/bots/bot-chat-transcript", () => ({
  BotChatTranscript: (props: {
    chatId: string;
    surface: BotTranscriptSurface | null;
    landOn: BotTranscriptLanding | null;
  }) => {
    const surface = props.surface;
    return (
      <div
        data-testid={`stub-transcript-${surface === null ? "session" : surface.kind}`}
        data-chat-id={props.chatId}
        data-land-on={props.landOn?.messageId ?? "none"}
        data-answer-threads={
          surface !== null && surface.kind === "channel"
            ? String(surface.threadAnchorKinds.includes("answer"))
            : ""
        }
      >
        {surface !== null && surface.kind === "channel"
          ? mocks.postIds.map((postId) => (
              <PostStub
                key={postId}
                postId={postId}
                threadLine={surface.threadLine}
                openThread={surface.openThread}
                openAnnouncementThread={surface.openAnnouncementThread}
              />
            ))
          : null}
        {surface !== null && surface.kind === "channel" ? (
          <ChannelChoice chooseOption={surface.chooseOption} />
        ) : null}
      </div>
    );
  },
}));
/** The channel surface's option pick, or a mark that none can be sent now. */
function ChannelChoice(props: {
  readonly chooseOption: ((choice: string) => void) | null;
}): ReactNode {
  if (props.chooseOption === null) {
    return <span data-testid="stub-choose-unavailable" />;
  }
  return <ChooseStub chooseOption={props.chooseOption} />;
}

vi.mock("@/components/bots/bot-message-composer", () => ({
  BotMessageComposer: (props: {
    conversationId: string;
    threadId: string | null;
    announcementId: string | null;
    sendable: boolean;
    placeholder: string;
    testId: string;
    failure: { readonly failed: boolean };
    onSent: (response: BotConversationSendResponse, text: string) => boolean;
  }) => (
    <div
      data-testid={`stub-${props.testId}`}
      data-conversation-id={props.conversationId}
      data-thread-id={props.threadId ?? "none"}
      data-announcement-id={props.announcementId ?? "none"}
      data-sendable={String(props.sendable)}
      data-placeholder={props.placeholder}
    >
      {props.failure.failed ? (
        <BotSendFailedNotice testId={`${props.testId}-send-failed`} />
      ) : null}
      {/* The host accepting what the box sent, answering `mocks.sendResponse`. */}
      <button
        type="button"
        data-testid={`stub-${props.testId}-sent`}
        onClick={() => props.onSent(mocks.sendResponse, POSTED_TEXT)}
      />
    </div>
  ),
}));

function ChooseStub(props: {
  readonly chooseOption: (choice: string) => void;
}): ReactNode {
  const { chooseOption } = props;
  return (
    <button
      type="button"
      data-testid="stub-choose"
      onClick={() => chooseOption("Ship it")}
    />
  );
}

function PostStub(props: {
  readonly postId: string;
  readonly threadLine: (postMessageId: string) => ChatBotThreadLine | null;
  readonly openThread: ((postMessageId: string) => void) | null;
  readonly openAnnouncementThread:
    | ((announcementId: string, anchorKind: string | null) => void)
    | null;
}): ReactNode {
  const line = props.threadLine(props.postId);
  const openThread = props.openThread;
  const openAnnouncementThread = props.openAnnouncementThread;
  return (
    <div data-testid={`stub-post-${props.postId}`}>
      <span
        data-testid={`stub-line-${props.postId}`}
        data-has-line={String(line !== null)}
        data-reply-count={line === null ? "" : String(line.replyCount)}
        data-last-reply-at={
          line === null || line.lastReplyAt === null
            ? ""
            : String(line.lastReplyAt)
        }
        data-unread={line === null ? "" : String(line.unread)}
        data-unread-count={
          line === null || line.unreadCount === null
            ? ""
            : String(line.unreadCount)
        }
        data-participants={
          line === null
            ? ""
            : line.participants
                .map((entry) => (entry.kind === "bot" ? "bot" : entry.name))
                .join(",")
        }
      />
      {openThread === null ? null : (
        <button
          type="button"
          data-testid={`stub-open-${props.postId}`}
          onClick={() => openThread(props.postId)}
        />
      )}
      {openAnnouncementThread === null ? null : (
        <button
          type="button"
          data-testid={`stub-open-announcement-${props.postId}`}
          onClick={() =>
            openAnnouncementThread(
              props.postId,
              mocks.answerIds.includes(props.postId) ? "answer" : null,
            )
          }
        />
      )}
    </div>
  );
}

import {
  BotChannelView,
  type BotChannelLanding,
} from "@/components/bots/bot-channel-view";
import { BotSendFailedNotice } from "@/components/bots/bot-channel-notices";
import type { BotOpenThread } from "@/stores/bots/bot-open-thread-store";
import { threadOpenOf } from "@/lib/bots/bot-trunk-model";
import { useBotPaneWidthsStore } from "@/stores/bots/bot-pane-widths-store";
import type { BotMemberResolver } from "@/lib/bots/bot-member-names";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
/** What the stub box reports it sent. */
const POSTED_TEXT = "Ship the release today?";
const HOST_ID = "host-bound";

/** The thread anchors `kinds`, as `hostId` said them at `epoch`. */
function saidBy(
  hostId: string,
  epoch: number,
  kinds: string[],
): BotThreadAnchors {
  return { hostId, epoch, kinds };
}

const resolveMember: BotMemberResolver = (userId) =>
  userId === "user-teammate"
    ? { displayName: "Tess Teammate", avatarUrl: null }
    : null;

function thread(
  threadId: string,
  postId: string,
  overrides: Partial<BotThreadSummary>,
): BotThreadSummary {
  return {
    threadId,
    conversationId: "conversation-channel",
    sessionChatId: `session-${threadId}`,
    anchor: {
      messageId: postId,
      requestId: `req-${threadId}`,
      senderUserId: "user-teammate",
      sentAt: 1_000,
      resolvedAt: null,
    },
    replyCount: 0,
    lastReplyAt: null,
    openRequestCount: 1,
    costUsd: null,
    ...overrides,
  };
}

/** A thread's indicator, counting one unread row for each glyph it lights. */
function indicator(
  unreadDone: boolean,
  unreadFailure: boolean,
): IndicatorState {
  return {
    unreadDone,
    unreadFailure,
    unreadCount: Number(unreadDone) + Number(unreadFailure),
  };
}

interface MountOptions {
  /** A member's post whose thread is open; `null` for none. */
  readonly openThreadPostId: string | null;
}

const QUESTION_1: BotOpenThread = {
  anchorMessageId: "question-1",
  announcement: true,
  anchorKind: null,
  sent: null,
};

/** Where the next mount lands the channel; `null` for where it opens. */
let mountLanding: BotChannelLanding | null = null;

function mount(options: MountOptions): {
  readonly onOpenThread: Mock<(open: BotOpenThread | null) => void>;
  readonly onOpenActivity: Mock<() => void>;
  /** Renders the same view again, reading the mocks' current state. */
  readonly rerender: () => void;
  /** Renders the view again with the tab's open-thread selection changed. */
  readonly reopen: (openThread: BotOpenThread | null) => void;
} {
  const onOpenThread = vi.fn<(open: BotOpenThread | null) => void>();
  const onOpenActivity = vi.fn<() => void>();
  const queryClient = new QueryClient();
  const tree = (openThread: BotOpenThread | null): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ChatExpansionTestProviders tileInstanceId="tile-1">
          <BotChannelView
            botId={BOT_ID}
            hostId={HOST_ID}
            boundHostId={mocks.state.binding.hostId}
            boundHostEpoch={mocks.state.binding.epoch}
            botTitle="Release Bot"
            directive={null}
            appConversationChatId={mocks.state.appConversationChatId}
            trunkChatId="trunk-chat"
            onOpenTurn={vi.fn()}
            onOpenSession={vi.fn()}
            landOn={mountLanding}
            openMemory={null}
            onOpenMemory={vi.fn()}
            environmentId="env-1"
            botNameOf={() => null}
            resolveMember={resolveMember}
            tasks={[]}
            surfaceActions={null}
            openThread={openThread}
            onOpenThread={onOpenThread}
            onOpenActivity={onOpenActivity}
            setupHistory={null}
          />
        </ChatExpansionTestProviders>
      </TooltipProvider>
    </QueryClientProvider>
  );
  let current: BotOpenThread | null =
    options.openThreadPostId === null
      ? null
      : {
          anchorMessageId: options.openThreadPostId,
          announcement: false,
          anchorKind: null,
          sent: null,
        };
  const result = render(tree(current));
  return {
    onOpenThread,
    onOpenActivity,
    rerender: () => result.rerender(tree(current)),
    reopen: (openThread) => {
      current = openThread;
      result.rerender(tree(current));
    },
  };
}

function lastThreadListCall(): ThreadListCall {
  const call = mocks.threadListCalls.at(-1);
  if (call === undefined) throw new Error("the thread list was never read");
  return call;
}

beforeEach(() => {
  vi.clearAllMocks();
  mountLanding = null;
  mocks.threadListCalls.length = 0;
  mocks.state.paneVisible = true;
  mocks.state.threadListSupported = true;
  mocks.state.conversations = [
    { conversationId: "conversation-later", createdAt: 9_000 },
    { conversationId: "conversation-channel", createdAt: 1_000 },
  ];
  mocks.state.appConversationChatId = "conversation-channel";
  mocks.state.threads = [];
  mocks.state.threadAnchors = null;
  mocks.state.binding = { hostId: HOST_ID, epoch: 1 };
  mocks.answerIds = [];
  mocks.state.threadListAnswered = true;
  mocks.state.threadListError = false;
  mocks.state.conversationsError = false;
  mocks.state.sending = false;
  mocks.state.chats = {};
  mocks.postIds = [];
  mocks.sendResponse = {
    messageId: "post-new",
    requestId: "request-new",
    delivery: "written",
    threadId: "thread-new",
  };
  // jsdom reports no focus until an element takes it; the window starts in
  // the person's foreground here, and a case that needs it elsewhere says so.
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<BotChannelView /> channel", () => {
  it("posts at the channel's top level on the conversation the bot record names", () => {
    mount({ openThreadPostId: null });

    const composer = screen.getByTestId("stub-bot-channel-composer");
    expect(composer.getAttribute("data-conversation-id")).toBe(
      "conversation-channel",
    );
    expect(composer.getAttribute("data-thread-id")).toBe("none");
    expect(composer.getAttribute("data-announcement-id")).toBe("none");
    expect(composer.getAttribute("data-placeholder")).toBe(
      "Message Release Bot",
    );
    expect(screen.queryByTestId("bot-thread-panel")).toBeNull();
    expect(
      screen
        .getByTestId("stub-transcript-channel")
        .getAttribute("data-chat-id"),
    ).toBe("conversation-channel");
  });

  it("opens the named conversation even when another one under the bot is older", () => {
    // A bound host can file a conversation under the bot with any timestamp.
    mocks.state.conversations = [
      { conversationId: "conversation-backdated", createdAt: 1 },
      { conversationId: "conversation-channel", createdAt: 1_000 },
    ];
    mount({ openThreadPostId: null });

    expect(
      screen
        .getByTestId("stub-bot-channel-composer")
        .getAttribute("data-conversation-id"),
    ).toBe("conversation-channel");
    expect(
      screen
        .getByTestId("stub-transcript-channel")
        .getAttribute("data-chat-id"),
    ).toBe("conversation-channel");
  });

  it("says the bot has no channel, rather than opening another, when the named conversation is not listed", () => {
    mocks.state.conversations = [
      { conversationId: "conversation-other", createdAt: 1 },
    ];
    mount({ openThreadPostId: null });

    expect(screen.getByTestId("bot-channel-empty")).toBeTruthy();
    expect(screen.queryByTestId("stub-bot-channel-composer")).toBeNull();
  });

  it("falls back to the earliest conversation only when the host names none", () => {
    mocks.state.appConversationChatId = null;
    mount({ openThreadPostId: null });

    expect(
      screen
        .getByTestId("stub-bot-channel-composer")
        .getAttribute("data-conversation-id"),
    ).toBe("conversation-channel");
  });

  it("reads the thread list, and not at all while unsupported", () => {
    mount({ openThreadPostId: null });
    expect(lastThreadListCall()).toEqual({ botId: BOT_ID, enabled: true });
    cleanup();

    mocks.state.threadListSupported = false;
    mount({ openThreadPostId: null });
    expect(lastThreadListCall().enabled).toBe(false);
  });

  it("gives each post the line of the thread anchored on it, with the thread's unread state", () => {
    mocks.state.threads = [
      thread("thread-a", "post-a", { replyCount: 3, lastReplyAt: 7_000 }),
      thread("thread-b", "post-b", { replyCount: 1, lastReplyAt: 8_000 }),
      thread("thread-c", "post-c", { replyCount: 2, lastReplyAt: 9_500 }),
      thread("thread-d", "post-d", { replyCount: 4, lastReplyAt: 9_900 }),
      thread("thread-e", "post-e", { replyCount: 1, lastReplyAt: 9_950 }),
    ];
    mocks.state.chats = {
      "thread-a": { ...indicator(true, false), unreadCount: 2 },
      "thread-b": indicator(false, false),
      "thread-c": indicator(false, true),
      // A host that does not count lights the glyph and leaves the count out.
      "thread-e": { ...indicator(true, false), unreadCount: null },
    };
    mocks.postIds = [
      "post-a",
      "post-b",
      "post-c",
      "post-d",
      "post-e",
      "post-new",
    ];
    mount({ openThreadPostId: null });

    const line = (postId: string): HTMLElement =>
      screen.getByTestId(`stub-line-${postId}`);
    expect(line("post-a").getAttribute("data-reply-count")).toBe("3");
    expect(line("post-a").getAttribute("data-last-reply-at")).toBe("7000");
    expect(line("post-a").getAttribute("data-unread")).toBe("true");
    expect(line("post-a").getAttribute("data-unread-count")).toBe("2");
    expect(line("post-b").getAttribute("data-reply-count")).toBe("1");
    expect(line("post-b").getAttribute("data-unread")).toBe("false");
    expect(line("post-b").getAttribute("data-unread-count")).toBe("0");
    expect(line("post-c").getAttribute("data-unread")).toBe("true");
    expect(line("post-c").getAttribute("data-unread-count")).toBe("1");
    // A thread the viewer took part in nowhere has no indicator and no dot.
    expect(line("post-d").getAttribute("data-reply-count")).toBe("4");
    expect(line("post-d").getAttribute("data-unread")).toBe("false");
    expect(line("post-d").getAttribute("data-unread-count")).toBe("0");
    expect(line("post-e").getAttribute("data-unread")).toBe("true");
    expect(line("post-e").getAttribute("data-unread-count")).toBe("");
    // A post with no thread listed yet has no line to read.
    expect(line("post-new").getAttribute("data-has-line")).toBe("false");
  });

  it("stacks a thread's line with the post's writer, and the bot once the thread has a reply", () => {
    mocks.state.threads = [
      thread("thread-a", "post-a", { replyCount: 0 }),
      thread("thread-b", "post-b", { replyCount: 2, lastReplyAt: 8_000 }),
    ];
    mocks.postIds = ["post-a", "post-b"];
    mount({ openThreadPostId: null });

    const participants = (postId: string): string | null =>
      screen
        .getByTestId(`stub-line-${postId}`)
        .getAttribute("data-participants");
    expect(participants("post-a")).toBe("Tess Teammate");
    expect(participants("post-b")).toBe("Tess Teammate,bot");
  });

  it("asks the host to open a post's thread when its line is clicked", async () => {
    const user = userEvent.setup();
    mocks.state.threads = [thread("thread-a", "post-a", { replyCount: 1 })];
    mocks.postIds = ["post-a"];
    const { onOpenThread } = mount({ openThreadPostId: null });

    await user.click(screen.getByTestId("stub-open-post-a"));

    expect(onOpenThread).toHaveBeenCalledTimes(1);
    expect(onOpenThread).toHaveBeenCalledWith({
      anchorMessageId: "post-a",
      announcement: false,
      anchorKind: null,
      sent: null,
    });
  });

  it("opens a question's thread by its message id, and shows a box that starts it while none is listed", async () => {
    const user = userEvent.setup();
    mocks.postIds = ["question-1"];
    const { onOpenThread, reopen } = mount({
      openThreadPostId: null,
    });
    expect(screen.queryByTestId("bot-thread-panel")).toBeNull();

    await user.click(screen.getByTestId("stub-open-announcement-question-1"));

    expect(onOpenThread).toHaveBeenCalledTimes(1);
    expect(onOpenThread).toHaveBeenCalledWith(QUESTION_1);

    reopen(QUESTION_1);

    const panel = screen.getByTestId("bot-thread-panel");
    expect(within(panel).queryByTestId("bot-thread-loading")).toBeNull();
    const composer = within(panel).getByTestId("stub-bot-thread-composer");
    expect(composer.getAttribute("data-announcement-id")).toBe("question-1");
    expect(composer.getAttribute("data-thread-id")).toBe("none");
    expect(composer.getAttribute("data-conversation-id")).toBe(
      "conversation-channel",
    );
  });

  it("lets a direct reply open its own thread only where the bot's binding names it among the rows a thread roots on", () => {
    const answerThreads = (): string | null =>
      screen
        .getByTestId("stub-transcript-channel")
        .getAttribute("data-answer-threads");
    mocks.state.threadAnchors = saidBy(HOST_ID, 1, ["answer"]);
    const { rerender } = mount({ openThreadPostId: null });
    expect(answerThreads()).toBe("true");

    // A host that predates the anchors, or one whose room is not written yet.
    mocks.state.threadAnchors = null;
    rerender();
    expect(answerThreads()).toBe("false");

    // An anchor this build does not know opens nothing new.
    mocks.state.threadAnchors = saidBy(HOST_ID, 1, ["later-kind"]);
    rerender();
    expect(answerThreads()).toBe("false");

    // Said by another host, or by this one under another epoch.
    mocks.state.threadAnchors = saidBy("host-earlier", 1, ["answer"]);
    rerender();
    expect(answerThreads()).toBe("false");
    mocks.state.threadAnchors = saidBy(HOST_ID, 0, ["answer"]);
    rerender();
    expect(answerThreads()).toBe("false");

    // A host without the thread list has nothing to say.
    mocks.state.threadAnchors = saidBy(HOST_ID, 1, ["answer"]);
    mocks.state.threadListSupported = false;
    rerender();
    expect(answerThreads()).toBe("false");
  });

  it("withdraws a direct reply's own thread the moment the bot is claimed, keeps it withdrawn through the earlier binding's answer, and blocks the open box's send until the new binding says it", () => {
    const answerThreads = (): string | null =>
      screen
        .getByTestId("stub-transcript-channel")
        .getAttribute("data-answer-threads");
    const sendable = (): string | null =>
      within(screen.getByTestId("bot-thread-panel"))
        .getByTestId("stub-bot-thread-composer")
        .getAttribute("data-sendable");
    mocks.postIds = ["answer-1"];
    mocks.answerIds = ["answer-1"];
    mocks.state.binding = { hostId: "host-capable", epoch: 3 };
    mocks.state.threadAnchors = saidBy("host-capable", 3, ["answer"]);
    const { reopen } = mount({ openThreadPostId: null });
    expect(answerThreads()).toBe("true");
    reopen({
      anchorMessageId: "answer-1",
      announcement: true,
      anchorKind: "answer",
      sent: null,
    });
    expect(sendable()).toBe("true");

    // The bot moves to an older host. The list read under the new binding is
    // still pending: what it holds is the capable host's answer.
    mocks.state.binding = { hostId: "host-older", epoch: 4 };
    reopen({
      anchorMessageId: "answer-1",
      announcement: true,
      anchorKind: "answer",
      sent: null,
    });
    expect(answerThreads()).toBe("false");
    expect(sendable()).toBe("false");
    // The box is the same one, so what the person typed stays in it.
    expect(
      screen
        .getByTestId("stub-bot-thread-composer")
        .getAttribute("data-announcement-id"),
    ).toBe("answer-1");

    // A read that started before the claim answers late, for the earlier binding.
    mocks.state.threadAnchors = saidBy("host-capable", 3, ["answer"]);
    reopen({
      anchorMessageId: "answer-1",
      announcement: true,
      anchorKind: "answer",
      sent: null,
    });
    expect(answerThreads()).toBe("false");
    expect(sendable()).toBe("false");

    // The new binding's own answer: the older host names nothing.
    mocks.state.threadAnchors = null;
    reopen({
      anchorMessageId: "answer-1",
      announcement: true,
      anchorKind: "answer",
      sent: null,
    });
    expect(sendable()).toBe("false");

    // Claimed again by a host that roots threads on an answer.
    mocks.state.binding = { hostId: "host-capable", epoch: 5 };
    mocks.state.threadAnchors = saidBy("host-capable", 5, ["answer"]);
    reopen({
      anchorMessageId: "answer-1",
      announcement: true,
      anchorKind: "answer",
      sent: null,
    });
    expect(answerThreads()).toBe("true");
    expect(sendable()).toBe("true");
  });

  it("takes no send in a listed thread under a direct reply once the bot is claimed onto a binding that does not open it, and takes one again once a binding does", () => {
    const sendable = (): string | null =>
      within(screen.getByTestId("bot-thread-panel"))
        .getByTestId("stub-bot-thread-composer")
        .getAttribute("data-sendable");
    const ANSWER_THREAD: BotOpenThread = {
      anchorMessageId: "answer-1",
      announcement: true,
      anchorKind: "answer",
      sent: null,
    };
    mocks.state.binding = { hostId: "host-capable", epoch: 3 };
    mocks.state.threadAnchors = saidBy("host-capable", 3, ["answer"]);
    mocks.state.threads = [
      thread("thread-answer", "answer-1", {
        replyCount: 2,
        lastReplyAt: 8_000,
      }),
    ];
    const { reopen } = mount({ openThreadPostId: null });
    reopen(ANSWER_THREAD);
    const panel = screen.getByTestId("bot-thread-panel");
    expect(panel.getAttribute("data-thread-id")).toBe("thread-answer");
    expect(sendable()).toBe("true");

    // Claimed by an older host; the cached list still lists the thread.
    mocks.state.binding = { hostId: "host-older", epoch: 4 };
    reopen(ANSWER_THREAD);
    expect(panel.getAttribute("data-thread-id")).toBe("thread-answer");
    expect(sendable()).toBe("false");

    mocks.state.binding = { hostId: "host-capable", epoch: 5 };
    mocks.state.threadAnchors = saidBy("host-capable", 5, ["answer"]);
    reopen(ANSWER_THREAD);
    expect(sendable()).toBe("true");
  });

  it("sends from the box under another row of the bot only while the bot's binding names that row among the rows a thread roots on", () => {
    const sendable = (): string | null =>
      within(screen.getByTestId("bot-thread-panel"))
        .getByTestId("stub-bot-thread-composer")
        .getAttribute("data-sendable");
    const NOTICE_THREAD: BotOpenThread = {
      anchorMessageId: "notice-1",
      announcement: true,
      anchorKind: "message",
      sent: null,
    };
    mocks.state.binding = { hostId: "host-capable", epoch: 3 };
    mocks.state.threadAnchors = saidBy("host-capable", 3, [
      "answer",
      "message",
    ]);
    const { reopen } = mount({ openThreadPostId: null });
    reopen(NOTICE_THREAD);
    expect(sendable()).toBe("true");

    // A host that roots threads on a direct answer and on nothing else.
    mocks.state.threadAnchors = saidBy("host-capable", 3, ["answer"]);
    reopen(NOTICE_THREAD);
    expect(sendable()).toBe("false");
  });

  it("takes no send in a listed thread whose anchor no member wrote, opened by its anchor alone, until the channel's row says which row it is", () => {
    const sendable = (): string | null =>
      within(screen.getByTestId("bot-thread-panel"))
        .getByTestId("stub-bot-thread-composer")
        .getAttribute("data-sendable");
    mocks.state.binding = { hostId: "host-capable", epoch: 3 };
    mocks.state.threadAnchors = saidBy("host-capable", 3, [
      "answer",
      "message",
    ]);
    mocks.state.threads = [
      thread("thread-notice", "notice-1", {
        anchor: {
          messageId: "notice-1",
          requestId: "req-thread-notice",
          senderUserId: null,
          sentAt: 1_000,
          resolvedAt: null,
        },
        replyCount: 1,
        lastReplyAt: 8_000,
      }),
    ];
    const { reopen } = mount({ openThreadPostId: null });
    reopen({
      anchorMessageId: "notice-1",
      announcement: false,
      anchorKind: null,
      sent: null,
    });

    expect(sendable()).toBe("false");
  });

  it("offers no box in a thread opened by its anchor alone before the list has it, and one that sends once the list says a member wrote the anchor", () => {
    const panel = (): HTMLElement => screen.getByTestId("bot-thread-panel");
    const BY_ANCHOR: BotOpenThread = {
      anchorMessageId: "post-late",
      announcement: false,
      anchorKind: null,
      sent: null,
    };
    mocks.state.threads = [];
    const { reopen } = mount({ openThreadPostId: null });
    reopen(BY_ANCHOR);

    expect(
      within(panel()).queryByTestId("stub-bot-thread-composer"),
    ).toBeNull();

    mocks.state.threads = [thread("thread-late", "post-late", {})];
    reopen(BY_ANCHOR);

    expect(
      within(panel())
        .getByTestId("stub-bot-thread-composer")
        .getAttribute("data-sendable"),
    ).toBe("true");
  });

  it("keeps the box under a direct reply mounted, beside Retry, through a failed read of the list after a claim, and sending once the read recovers", async () => {
    const user = userEvent.setup();
    const ANSWER_THREAD: BotOpenThread = {
      anchorMessageId: "answer-1",
      announcement: true,
      anchorKind: "answer",
      sent: null,
    };
    mocks.state.binding = { hostId: "host-capable", epoch: 3 };
    mocks.state.threadAnchors = saidBy("host-capable", 3, ["answer"]);
    const { reopen } = mount({ openThreadPostId: null });
    reopen(ANSWER_THREAD);
    const box = screen.getByTestId("stub-bot-thread-composer");

    // Claimed, and the read of the list that follows fails.
    mocks.state.binding = { hostId: "host-capable", epoch: 4 };
    mocks.state.threadListError = true;
    reopen(ANSWER_THREAD);

    expect(screen.getByTestId("stub-bot-thread-composer")).toBe(box);
    expect(box.getAttribute("data-sendable")).toBe("false");
    await user.click(
      within(screen.getByTestId("bot-thread-error")).getByRole("button", {
        name: "Retry",
      }),
    );
    expect(mocks.refetchThreads).toHaveBeenCalledTimes(1);

    mocks.state.threadListError = false;
    mocks.state.threadAnchors = saidBy("host-capable", 4, ["answer"]);
    reopen(ANSWER_THREAD);

    expect(screen.queryByTestId("bot-thread-error")).toBeNull();
    expect(screen.getByTestId("stub-bot-thread-composer")).toBe(box);
    expect(box.getAttribute("data-sendable")).toBe("true");
  });

  it("keeps the one box of a direct reply's thread while a claim's list drops the thread and lists it again", () => {
    const ANSWER_THREAD: BotOpenThread = {
      anchorMessageId: "answer-1",
      announcement: true,
      anchorKind: "answer",
      sent: null,
    };
    mocks.state.binding = { hostId: "host-capable", epoch: 3 };
    mocks.state.threadAnchors = saidBy("host-capable", 3, ["answer"]);
    mocks.state.threads = [
      thread("thread-answer", "answer-1", {
        replyCount: 2,
        lastReplyAt: 8_000,
      }),
    ];
    const { reopen } = mount({ openThreadPostId: null });
    reopen(ANSWER_THREAD);
    const box = screen.getByTestId("stub-bot-thread-composer");
    expect(box.getAttribute("data-thread-id")).toBe("thread-answer");

    // Claimed: the list reads fine, and holds none of the earlier host's threads.
    mocks.state.binding = { hostId: "host-capable", epoch: 4 };
    mocks.state.threads = [];
    reopen(ANSWER_THREAD);
    expect(screen.getByTestId("stub-bot-thread-composer")).toBe(box);
    expect(box.getAttribute("data-thread-id")).toBe("none");
    expect(box.getAttribute("data-announcement-id")).toBe("answer-1");

    mocks.state.threadAnchors = saidBy("host-capable", 4, ["answer"]);
    mocks.state.threads = [
      thread("thread-answer", "answer-1", {
        replyCount: 2,
        lastReplyAt: 8_000,
      }),
    ];
    reopen(ANSWER_THREAD);
    expect(screen.getByTestId("stub-bot-thread-composer")).toBe(box);
    expect(box.getAttribute("data-thread-id")).toBe("thread-answer");
    expect(box.getAttribute("data-sendable")).toBe("true");
  });

  it("gates a direct reply's thread opened from a task row as the reply's own row gates it: no send after a claim the binding does not say, and the box kept while the list drops the thread", () => {
    // The bot's direct reply, as the channel's session holds it: a task row
    // opens the thread rooted on it as the row's kind says (Tracy Bots T82).
    const reply: Message = {
      role: "assistant",
      messageId: "answer-1",
      sender: {
        type: "agent",
        harnessId: "claude",
        agentId: "claude-sonnet-4",
        displayName: "Claude Sonnet 4",
        reply: { expectsReply: false },
        inReplyTo: null,
      },
      blocks: [],
      startedAt: 1_000,
      timestamp: 1_000,
      turnId: null,
      usage: null,
      reasoningEffort: null,
      serviceTier: null,
      envCredentialVar: null,
      imageResolutions: [],
      repliesTo: "post-1",
    };
    const how = threadOpenOf(reply);
    const fromTask: BotOpenThread = {
      anchorMessageId: reply.messageId,
      ...how,
      sent: null,
    };
    mocks.state.binding = { hostId: "host-capable", epoch: 3 };
    mocks.state.threadAnchors = saidBy("host-capable", 3, ["answer"]);
    mocks.state.threads = [
      thread("thread-answer", "answer-1", {
        replyCount: 2,
        lastReplyAt: 8_000,
      }),
    ];
    const { reopen } = mount({ openThreadPostId: null });
    reopen(fromTask);
    const box = screen.getByTestId("stub-bot-thread-composer");
    expect(box.getAttribute("data-thread-id")).toBe("thread-answer");
    expect(box.getAttribute("data-sendable")).toBe("true");

    // Claimed by an older host; the cached list still lists the thread.
    mocks.state.binding = { hostId: "host-older", epoch: 4 };
    reopen(fromTask);
    expect(box.getAttribute("data-thread-id")).toBe("thread-answer");
    expect(box.getAttribute("data-sendable")).toBe("false");

    // The list read under the claim drops the thread: the same box, its
    // draft with it, still not sending.
    mocks.state.threads = [];
    reopen(fromTask);
    expect(screen.getByTestId("stub-bot-thread-composer")).toBe(box);
    expect(box.getAttribute("data-announcement-id")).toBe("answer-1");
    expect(box.getAttribute("data-sendable")).toBe("false");
  });

  it("says a failed read of the list after a claim beside the thread it last listed, with Retry, and takes a send once the read recovers", async () => {
    const user = userEvent.setup();
    const ANSWER_THREAD: BotOpenThread = {
      anchorMessageId: "answer-1",
      announcement: true,
      anchorKind: "answer",
      sent: null,
    };
    mocks.state.binding = { hostId: "host-capable", epoch: 3 };
    mocks.state.threadAnchors = saidBy("host-capable", 3, ["answer"]);
    mocks.state.threads = [
      thread("thread-answer", "answer-1", {
        replyCount: 2,
        lastReplyAt: 8_000,
      }),
    ];
    const { reopen } = mount({ openThreadPostId: null });
    reopen(ANSWER_THREAD);

    // Claimed by another capable host; the read that follows fails, and the
    // list still holds what it last returned.
    mocks.state.binding = { hostId: "host-other", epoch: 4 };
    mocks.state.threadListError = true;
    reopen(ANSWER_THREAD);

    const panel = screen.getByTestId("bot-thread-panel");
    expect(panel.getAttribute("data-thread-id")).toBe("thread-answer");
    expect(
      within(panel)
        .getByTestId("stub-bot-thread-composer")
        .getAttribute("data-sendable"),
    ).toBe("false");
    await user.click(
      within(within(panel).getByTestId("bot-thread-error")).getByRole(
        "button",
        { name: "Retry" },
      ),
    );
    expect(mocks.refetchThreads).toHaveBeenCalledTimes(1);

    mocks.state.threadListError = false;
    mocks.state.threadAnchors = saidBy("host-other", 4, ["answer"]);
    reopen(ANSWER_THREAD);
    expect(within(panel).queryByTestId("bot-thread-error")).toBeNull();
    expect(
      within(panel)
        .getByTestId("stub-bot-thread-composer")
        .getAttribute("data-sendable"),
    ).toBe("true");
  });

  it("keeps the box under a question sending whatever the bot's binding says of answers", () => {
    mocks.postIds = ["question-1"];
    mocks.state.threadAnchors = null;
    const { reopen } = mount({ openThreadPostId: null });
    reopen(QUESTION_1);

    expect(
      screen
        .getByTestId("stub-bot-thread-composer")
        .getAttribute("data-sendable"),
    ).toBe("true");
  });

  it("keeps a direct post's thread and its reply's thread apart: each row its own line, each opening its own thread", async () => {
    const user = userEvent.setup();
    mocks.postIds = ["post-1", "answer-1"];
    mocks.answerIds = ["answer-1"];
    mocks.state.threadAnchors = saidBy(HOST_ID, 1, ["answer"]);
    mocks.state.threads = [
      thread("thread-post", "post-1", { replyCount: 1, lastReplyAt: 7_000 }),
      {
        ...thread("thread-answer", "answer-1", {
          replyCount: 3,
          lastReplyAt: 8_000,
        }),
        anchor: {
          messageId: "answer-1",
          requestId: "req-under-answer",
          senderUserId: null,
          sentAt: 1_500,
          resolvedAt: null,
        },
      },
    ];
    const { onOpenThread, reopen } = mount({ openThreadPostId: null });

    expect(
      screen.getByTestId("stub-line-post-1").getAttribute("data-reply-count"),
    ).toBe("1");
    expect(
      screen.getByTestId("stub-line-answer-1").getAttribute("data-reply-count"),
    ).toBe("3");

    await user.click(screen.getByTestId("stub-open-announcement-answer-1"));
    await user.click(screen.getByTestId("stub-open-announcement-post-1"));

    expect(onOpenThread.mock.calls).toEqual([
      [
        {
          anchorMessageId: "answer-1",
          announcement: true,
          anchorKind: "answer",
          sent: null,
        },
      ],
      [
        {
          anchorMessageId: "post-1",
          announcement: true,
          anchorKind: null,
          sent: null,
        },
      ],
    ]);
    reopen({
      anchorMessageId: "answer-1",
      announcement: true,
      anchorKind: "answer",
      sent: null,
    });
    expect(
      screen.getByTestId("bot-thread-panel").getAttribute("data-thread-id"),
    ).toBe("thread-answer");
    reopen({
      anchorMessageId: "post-1",
      announcement: true,
      anchorKind: null,
      sent: null,
    });
    expect(
      screen.getByTestId("bot-thread-panel").getAttribute("data-thread-id"),
    ).toBe("thread-post");
  });

  it("shows the question's thread, not the box that starts one, once the thread is listed", async () => {
    const user = userEvent.setup();
    mocks.postIds = ["question-1"];
    const { reopen } = mount({ openThreadPostId: null });
    await user.click(screen.getByTestId("stub-open-announcement-question-1"));
    reopen(QUESTION_1);
    expect(
      screen
        .getByTestId("stub-bot-thread-composer")
        .getAttribute("data-announcement-id"),
    ).toBe("question-1");

    mocks.state.threads = [
      thread("thread-q", "question-1", { replyCount: 1, lastReplyAt: 7_000 }),
    ];
    reopen(QUESTION_1);

    const panel = screen.getByTestId("bot-thread-panel");
    expect(panel.getAttribute("data-thread-id")).toBe("thread-q");
    const composer = within(panel).getByTestId("stub-bot-thread-composer");
    expect(composer.getAttribute("data-thread-id")).toBe("thread-q");
    expect(composer.getAttribute("data-announcement-id")).toBe("none");
  });

  it("makes a member post's own thread wait for the host rather than offering the box that starts one", () => {
    mocks.postIds = ["post-a"];
    const { reopen } = mount({ openThreadPostId: null });

    reopen({
      anchorMessageId: "post-a",
      announcement: false,
      anchorKind: null,
      sent: null,
    });

    const waiting = screen.getByTestId("bot-thread-panel");
    expect(within(waiting).getByTestId("bot-thread-loading")).toBeTruthy();
    expect(
      within(waiting).queryByTestId("stub-bot-thread-composer"),
    ).toBeNull();

    mocks.state.threads = [thread("thread-a", "post-a", { replyCount: 0 })];
    reopen({
      anchorMessageId: "post-a",
      announcement: false,
      anchorKind: null,
      sent: null,
    });

    const panel = screen.getByTestId("bot-thread-panel");
    expect(panel.getAttribute("data-thread-id")).toBe("thread-a");
    const composer = within(panel).getByTestId("stub-bot-thread-composer");
    expect(composer.getAttribute("data-thread-id")).toBe("thread-a");
    expect(composer.getAttribute("data-announcement-id")).toBe("none");
  });

  it("shows the box that starts a question's thread when the view mounts again with it open, as after a switch between the tab's views", async () => {
    const user = userEvent.setup();
    mocks.postIds = ["question-1"];
    const first = mount({ openThreadPostId: null });
    await user.click(screen.getByTestId("stub-open-announcement-question-1"));
    const opened = first.onOpenThread.mock.calls.at(-1)?.[0] ?? null;
    // The tab holds what was opened; the view itself is unmounted and mounted
    // fresh, so nothing it remembered survives.
    cleanup();

    const again = mount({ openThreadPostId: null });
    again.reopen(opened);

    const panel = screen.getByTestId("bot-thread-panel");
    expect(within(panel).queryByTestId("bot-thread-loading")).toBeNull();
    expect(
      within(panel)
        .getByTestId("stub-bot-thread-composer")
        .getAttribute("data-announcement-id"),
    ).toBe("question-1");
  });

  it("posts a direct reply's chosen option as a new top-level post in the channel", async () => {
    const user = userEvent.setup();
    mount({ openThreadPostId: null });
    expect(mocks.send).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("stub-choose"));

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0][0]).toEqual({
      botId: BOT_ID,
      conversationId: "conversation-channel",
      text: "Ship it",
      threadId: null,
      announcementId: null,
      redeliver: null,
      supersedes: null,
      answer: null,
    });
  });

  it("offers no option to pick while an earlier pick is still being sent", () => {
    mocks.state.sending = true;
    mount({ openThreadPostId: null });

    expect(screen.getByTestId("stub-choose-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("stub-choose")).toBeNull();
  });
});

describe("<BotChannelView /> channel read mark", () => {
  it("marks the channel read when it is shown unread, and leaves a read one alone", () => {
    mocks.state.chats = { "conversation-channel": indicator(true, false) };
    mount({ openThreadPostId: null });
    expect(mocks.markRead).toHaveBeenCalledTimes(1);
    expect(mocks.markRead).toHaveBeenCalledWith({
      epicId: BOT_ID,
      chatId: "conversation-channel",
    });
    cleanup();
    mocks.markRead.mockClear();

    mocks.state.chats = { "conversation-channel": indicator(false, false) };
    mount({ openThreadPostId: null });
    expect(mocks.markRead).not.toHaveBeenCalled();
  });

  it("marks the channel read for a failure as well as a done mark", () => {
    mocks.state.chats = { "conversation-channel": indicator(false, true) };
    mount({ openThreadPostId: null });
    expect(mocks.markRead).toHaveBeenCalledTimes(1);
  });

  it("leaves the channel unread while its tab is not on screen, and reads it when the person comes back", () => {
    mocks.state.chats = { "conversation-channel": indicator(true, false) };
    mocks.state.paneVisible = false;
    const { rerender } = mount({ openThreadPostId: null });
    expect(mocks.markRead).not.toHaveBeenCalled();

    mocks.state.paneVisible = true;
    rerender();
    expect(mocks.markRead).toHaveBeenCalledTimes(1);
    expect(mocks.markRead).toHaveBeenCalledWith({
      epicId: BOT_ID,
      chatId: "conversation-channel",
    });
  });

  it("leaves the channel unread while the window is in the background, and reads it when the window returns", () => {
    mocks.state.chats = { "conversation-channel": indicator(true, false) };
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    mount({ openThreadPostId: null });
    expect(mocks.markRead).not.toHaveBeenCalled();

    hasFocus.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(mocks.markRead).toHaveBeenCalledTimes(1);
  });
});

describe("<BotChannelView /> channel read mark beside an open thread", () => {
  /** The `ResizeObserver`s the view made, to report a size for the channel's section. */
  const observers: FakeResizeObserver[] = [];

  class FakeResizeObserver implements ResizeObserver {
    readonly observed: Element[] = [];

    constructor(private readonly callback: ResizeObserverCallback) {
      observers.push(this);
    }

    observe(element: Element): void {
      this.observed.push(element);
    }

    unobserve(): void {}

    disconnect(): void {
      this.observed.length = 0;
    }

    report(width: number): void {
      const entry = { contentRect: { width } } as ResizeObserverEntry;
      this.callback([entry], this);
    }
  }

  /** Reports `width` for the channel section, the way the browser does once it lays out. */
  function reportChannelWidth(width: number): void {
    const section = screen.getByTestId("bot-channel");
    const observer = observers.find((candidate) =>
      candidate.observed.includes(section),
    );
    if (observer === undefined) {
      throw new Error("the channel section is not observed");
    }
    act(() => {
      observer.report(width);
    });
  }

  beforeEach(() => {
    observers.length = 0;
    mocks.state.threads = [
      thread("thread-a", "post-a", { replyCount: 2, lastReplyAt: 7_000 }),
    ];
    mocks.postIds = ["post-a"];
    mocks.state.chats = { "conversation-channel": indicator(true, false) };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("leaves the channel unread while it is hidden beside the thread, and reads it when the pane is wide enough to show it", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    mount({ openThreadPostId: "post-a" });
    expect(screen.getByTestId("bot-thread-panel")).toBeTruthy();
    // Not measured yet: the channel is taken as hidden.
    expect(mocks.markRead).not.toHaveBeenCalled();

    // A narrow pane hides the channel section, so it has no width.
    reportChannelWidth(0);
    expect(mocks.markRead).not.toHaveBeenCalled();

    // A wide pane shows the channel beside the thread.
    reportChannelWidth(480);
    expect(mocks.markRead).toHaveBeenCalledTimes(1);
    expect(mocks.markRead).toHaveBeenCalledWith({
      epicId: BOT_ID,
      chatId: "conversation-channel",
    });
  });

  it("leaves the channel unread beside an open thread where nothing can measure it", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    mount({ openThreadPostId: "post-a" });
    expect(screen.getByTestId("bot-thread-panel")).toBeTruthy();
    expect(mocks.markRead).not.toHaveBeenCalled();
  });
});

describe("<BotChannelView /> open thread", () => {
  beforeEach(() => {
    mocks.state.threads = [
      thread("thread-a", "post-a", {
        conversationId: "conversation-channel",
        sessionChatId: "session-a",
        replyCount: 2,
        lastReplyAt: 7_000,
        costUsd: 0.42,
      }),
      thread("thread-b", "post-b", { replyCount: 1, lastReplyAt: 8_000 }),
    ];
    mocks.postIds = ["post-a", "post-b"];
  });

  afterEach(() => {
    useBotPaneWidthsStore.getState().resetWidth("thread");
  });

  it("lands the open thread's replies on the message of it the tab named, and leaves the channel where it opens", () => {
    mountLanding = {
      messageId: "reply-a9",
      sendPostId: null,
      threadId: "thread-a",
      visit: 1,
    };
    mount({ openThreadPostId: "post-a" });

    const panel = screen.getByTestId("bot-thread-panel");
    expect(
      within(panel)
        .getByTestId("stub-transcript-thread")
        .getAttribute("data-land-on"),
    ).toBe("reply-a9");
    expect(
      screen
        .getByTestId("stub-transcript-channel")
        .getAttribute("data-land-on"),
    ).toBe("none");
  });

  it("lands the thread once: the memory taking its place and Back to it open it where it opens", () => {
    mountLanding = {
      messageId: "reply-a9",
      sendPostId: null,
      threadId: "thread-a",
      visit: 1,
    };
    const view = mount({ openThreadPostId: "post-a" });
    const threadLanding = (): string | null =>
      within(screen.getByTestId("bot-thread-panel"))
        .getByTestId("stub-transcript-thread")
        .getAttribute("data-land-on");
    expect(threadLanding()).toBe("reply-a9");

    // The memory takes the thread's slot; its Back puts the thread back.
    view.reopen(null);
    expect(screen.queryByTestId("bot-thread-panel")).toBeNull();
    view.reopen({
      anchorMessageId: "post-a",
      announcement: false,
      anchorKind: null,
      sent: null,
    });

    expect(threadLanding()).toBe("none");
  });

  it("lands the thread once: a failed read of the channel and its retry draw it where it opens", () => {
    mountLanding = {
      messageId: "reply-a9",
      sendPostId: null,
      threadId: "thread-a",
      visit: 1,
    };
    const view = mount({ openThreadPostId: "post-a" });
    const threadLanding = (): string | null =>
      within(screen.getByTestId("bot-thread-panel"))
        .getByTestId("stub-transcript-thread")
        .getAttribute("data-land-on");
    expect(threadLanding()).toBe("reply-a9");

    mocks.state.conversationsError = true;
    view.rerender();
    expect(screen.getByTestId("bot-channel-error")).toBeTruthy();
    expect(screen.queryByTestId("bot-thread-panel")).toBeNull();
    mocks.state.conversationsError = false;
    view.rerender();

    expect(threadLanding()).toBe("none");
  });

  it("holds the landing while the thread list has not answered, and lands once it does", () => {
    mocks.state.threadListAnswered = false;
    mountLanding = {
      messageId: "reply-a9",
      sendPostId: null,
      threadId: "thread-a",
      visit: 1,
    };
    const view = mount({ openThreadPostId: "post-a" });
    expect(screen.queryByTestId("stub-transcript-thread")).toBeNull();

    mocks.state.threadListAnswered = true;
    view.rerender();

    expect(
      within(screen.getByTestId("bot-thread-panel"))
        .getByTestId("stub-transcript-thread")
        .getAttribute("data-land-on"),
    ).toBe("reply-a9");
  });

  it("lands no thread on a message the tab named for another thread", () => {
    mountLanding = {
      messageId: "reply-b9",
      sendPostId: null,
      threadId: "thread-b",
      visit: 1,
    };
    mount({ openThreadPostId: "post-a" });

    expect(
      within(screen.getByTestId("bot-thread-panel"))
        .getByTestId("stub-transcript-thread")
        .getAttribute("data-land-on"),
    ).toBe("none");
  });

  it("reads the thread's chat in the panel and replies into that thread", () => {
    mount({ openThreadPostId: "post-a" });

    const panel = screen.getByTestId("bot-thread-panel");
    expect(panel.getAttribute("data-thread-id")).toBe("thread-a");
    expect(
      within(panel)
        .getByTestId("stub-transcript-thread")
        .getAttribute("data-chat-id"),
    ).toBe("thread-a");
    const composer = within(panel).getByTestId("stub-bot-thread-composer");
    expect(composer.getAttribute("data-thread-id")).toBe("thread-a");
    expect(composer.getAttribute("data-conversation-id")).toBe(
      "conversation-channel",
    );
    expect(composer.getAttribute("data-placeholder")).toBe("Reply…");
    // The anchor post is drawn above the replies, under the member's name;
    // its text comes from the channel's row (`bot-thread-panel.test.tsx`).
    const anchor = within(panel).getByTestId("bot-thread-anchor");
    expect(within(anchor).getByText("Tess Teammate")).toBeTruthy();
    // The channel's own box keeps posting at the top level beside it.
    expect(
      screen
        .getByTestId("stub-bot-channel-composer")
        .getAttribute("data-thread-id"),
    ).toBe("none");
  });

  it("draws the thread in a pane as wide as the person set it, beside a channel labelled by the bot's title", () => {
    useBotPaneWidthsStore.getState().setWidthPx("thread", 700);
    mount({ openThreadPostId: "post-a" });

    const pane = screen.getByTestId("bot-thread-pane");
    expect(pane.style.getPropertyValue("--bot-pane-width")).toBe("700px");
    expect(within(pane).getByTestId("bot-thread-panel")).toBeTruthy();
    expect(
      within(pane)
        .getByTestId("bot-thread-pane-resize-handle")
        .getAttribute("aria-label"),
    ).toBe("Resize thread");
    expect(screen.getByRole("region", { name: "Release Bot" })).toBe(
      screen.getByTestId("bot-channel"),
    );
  });

  it("shows no cost in the thread's header, even for a thread the host prices", () => {
    mount({ openThreadPostId: "post-a" });

    const panel = screen.getByTestId("bot-thread-panel");
    expect(within(panel).queryByTestId("bot-thread-cost")).toBeNull();
    expect(panel.textContent).not.toContain("$0.42");
  });

  it("opens the bot's Activity from the thread's header", async () => {
    const user = userEvent.setup();
    const { onOpenActivity } = mount({ openThreadPostId: "post-a" });

    await user.click(screen.getByRole("button", { name: "Activity" }));

    expect(onOpenActivity).toHaveBeenCalledTimes(1);
  });

  it("closes the thread from its header", async () => {
    const user = userEvent.setup();
    const { onOpenThread } = mount({
      openThreadPostId: "post-a",
    });

    await user.click(screen.getByTestId("bot-thread-close"));

    expect(onOpenThread).toHaveBeenCalledWith(null);
  });

  it("marks an unread thread read when it is opened, and leaves a read one alone", () => {
    mocks.state.chats = { "thread-a": indicator(true, false) };
    mount({ openThreadPostId: "post-a" });
    expect(mocks.markRead).toHaveBeenCalledTimes(1);
    expect(mocks.markRead).toHaveBeenCalledWith({
      epicId: BOT_ID,
      chatId: "thread-a",
    });
    cleanup();
    mocks.markRead.mockClear();

    mocks.state.chats = { "thread-b": indicator(false, false) };
    mount({ openThreadPostId: "post-b" });
    expect(mocks.markRead).not.toHaveBeenCalled();
  });

  it("leaves a verdict unread while the tab is not on screen, and reads it when the person comes back", () => {
    mocks.state.chats = { "thread-a": indicator(true, false) };
    mocks.state.paneVisible = false;
    const { rerender } = mount({ openThreadPostId: "post-a" });
    expect(mocks.markRead).not.toHaveBeenCalled();

    mocks.state.paneVisible = true;
    rerender();
    expect(mocks.markRead).toHaveBeenCalledTimes(1);
    expect(mocks.markRead).toHaveBeenCalledWith({
      epicId: BOT_ID,
      chatId: "thread-a",
    });
  });

  it("leaves a verdict unread while the window is in the background, and reads it when the window returns", () => {
    mocks.state.chats = { "thread-a": indicator(true, false) };
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    mount({ openThreadPostId: "post-a" });
    expect(mocks.markRead).not.toHaveBeenCalled();

    hasFocus.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(mocks.markRead).toHaveBeenCalledTimes(1);
  });
});

describe("<BotChannelView /> thread list unavailable", () => {
  it("offers no thread on a host without the thread list", () => {
    mocks.state.threadListSupported = false;
    mocks.state.threadListAnswered = false;
    mocks.postIds = ["post-a"];
    mount({ openThreadPostId: "post-a" });

    expect(screen.queryByTestId("stub-open-post-a")).toBeNull();
    expect(screen.queryByTestId("stub-open-announcement-post-a")).toBeNull();
    expect(screen.queryByTestId("bot-thread-panel")).toBeNull();
    expect(screen.queryByTestId("bot-thread-loading")).toBeNull();
  });

  it("says the thread list failed and reads it again on Retry, rather than loading forever", async () => {
    const user = userEvent.setup();
    mocks.state.threadListAnswered = false;
    mocks.state.threadListError = true;
    mount({ openThreadPostId: "post-a" });

    const panel = screen.getByTestId("bot-thread-panel");
    expect(within(panel).queryByTestId("bot-thread-loading")).toBeNull();
    const failure = within(panel).getByTestId("bot-thread-error");
    await user.click(within(failure).getByRole("button", { name: "Retry" }));
    expect(mocks.refetchThreads).toHaveBeenCalledTimes(1);
  });

  it("waits for a just-posted thread the list has not answered yet", () => {
    mocks.state.threads = [thread("thread-a", "post-a", { replyCount: 1 })];
    mount({ openThreadPostId: "post-new" });

    const panel = screen.getByTestId("bot-thread-panel");
    expect(within(panel).getByTestId("bot-thread-loading")).toBeTruthy();
    expect(within(panel).queryByTestId("bot-thread-error")).toBeNull();
    expect(within(panel).queryByTestId("stub-bot-thread-composer")).toBeNull();
  });
});

describe("<BotChannelView /> a post whose answer lands in a thread", () => {
  const POSTED: BotOpenThread = {
    anchorMessageId: "post-new",
    announcement: false,
    anchorKind: null,
    sent: {
      threadId: "thread-new",
      requestId: "request-new",
      text: POSTED_TEXT,
      senderUserId: null,
      sentAt: 5_000,
      delivery: "written",
    },
  };

  /** The thread the channel opened, as the tab's store would hold it. */
  function opened(
    onOpenThread: Mock<(open: BotOpenThread | null) => void>,
  ): BotOpenThread {
    expect(onOpenThread).toHaveBeenCalledTimes(1);
    const open = onOpenThread.mock.calls[0][0];
    if (open === null) throw new Error("the channel closed the thread");
    return open;
  }

  it("opens the post's thread as the channel's box reports the send, before the list has it", async () => {
    const user = userEvent.setup();
    const { onOpenThread, reopen } = mount({ openThreadPostId: null });

    await user.click(screen.getByTestId("stub-bot-channel-composer-sent"));

    const open = opened(onOpenThread);
    // Accepted just now; the rest is what the box sent and the host answered.
    expect(open.sent?.sentAt).toBeGreaterThan(0);
    expect({
      ...open,
      sent: open.sent === null ? null : { ...open.sent, sentAt: 5_000 },
    }).toEqual(POSTED);
    reopen(open);

    const panel = screen.getByTestId("bot-thread-panel");
    expect(panel.getAttribute("data-thread-id")).toBe("thread-new");
    expect(within(panel).queryByTestId("bot-thread-loading")).toBeNull();
    // The channel has no row for the post yet: it is drawn as it was sent.
    const anchor = within(panel).getByTestId("bot-thread-anchor");
    expect(within(anchor).getByText(POSTED_TEXT)).toBeTruthy();
    expect(within(panel).queryByTestId("bot-thread-queued")).toBeNull();
    const composer = within(panel).getByTestId("stub-bot-thread-composer");
    expect(composer.getAttribute("data-thread-id")).toBe("thread-new");
    expect(composer.getAttribute("data-announcement-id")).toBe("none");
  });

  it("opens the thread of a post the host queued for a paused bot, on the post as sent and saying it was saved", async () => {
    const user = userEvent.setup();
    mocks.sendResponse = { ...mocks.sendResponse, delivery: "queued" };
    const { onOpenThread, reopen } = mount({ openThreadPostId: null });

    await user.click(screen.getByTestId("stub-bot-channel-composer-sent"));

    const open = opened(onOpenThread);
    expect(open.sent?.delivery).toBe("queued");
    reopen(open);
    const panel = screen.getByTestId("bot-thread-panel");
    const anchor = within(panel).getByTestId("bot-thread-anchor");
    expect(within(anchor).getByText(POSTED_TEXT)).toBeTruthy();
    expect(within(panel).getByTestId("bot-thread-queued").textContent).toBe(
      "Saved. The bot will read it.",
    );
  });

  it("keeps the box beside a failed read of the thread list, and reads it again on Retry", async () => {
    const user = userEvent.setup();
    mocks.state.threadListAnswered = false;
    mocks.state.threadListError = true;
    const { reopen } = mount({ openThreadPostId: null });
    reopen(POSTED);

    const panel = screen.getByTestId("bot-thread-panel");
    expect(within(panel).getByTestId("stub-bot-thread-composer")).toBeTruthy();
    const failure = within(panel).getByTestId("bot-thread-error");
    await user.click(within(failure).getByRole("button", { name: "Retry" }));
    expect(mocks.refetchThreads).toHaveBeenCalledTimes(1);
  });

  it("opens nothing for a post the bot answers in the channel", async () => {
    const user = userEvent.setup();
    mocks.sendResponse = { ...mocks.sendResponse, threadId: null };
    const { onOpenThread } = mount({ openThreadPostId: null });

    await user.click(screen.getByTestId("stub-bot-channel-composer-sent"));

    expect(onOpenThread).not.toHaveBeenCalled();
  });

  it("opens nothing on a host without the thread list", async () => {
    const user = userEvent.setup();
    mocks.state.threadListSupported = false;
    const { onOpenThread } = mount({ openThreadPostId: null });

    await user.click(screen.getByTestId("stub-bot-channel-composer-sent"));

    expect(onOpenThread).not.toHaveBeenCalled();
  });

  it("replaces the thread open beside the channel with the new post's", async () => {
    const user = userEvent.setup();
    mocks.state.threads = [thread("thread-a", "post-a", { replyCount: 1 })];
    mocks.postIds = ["post-a"];
    const { onOpenThread, reopen } = mount({ openThreadPostId: "post-a" });
    expect(
      screen.getByTestId("bot-thread-panel").getAttribute("data-thread-id"),
    ).toBe("thread-a");

    await user.click(screen.getByTestId("stub-bot-channel-composer-sent"));
    const open = opened(onOpenThread);
    expect(open.sent?.threadId).toBe("thread-new");
    reopen(open);

    expect(
      screen.getByTestId("bot-thread-panel").getAttribute("data-thread-id"),
    ).toBe("thread-new");
  });

  it("leaves the open thread as it is when its own box sends", async () => {
    const user = userEvent.setup();
    mocks.state.threads = [thread("thread-a", "post-a", { replyCount: 1 })];
    mocks.sendResponse = {
      ...mocks.sendResponse,
      messageId: "reply-new",
      threadId: "thread-a",
    };
    const { onOpenThread } = mount({ openThreadPostId: "post-a" });

    await user.click(screen.getByTestId("stub-bot-thread-composer-sent"));

    expect(onOpenThread).not.toHaveBeenCalled();
  });

  it("leaves a question's thread as it is when the box under it sends", async () => {
    const user = userEvent.setup();
    const { onOpenThread, reopen } = mount({ openThreadPostId: null });
    reopen(QUESTION_1);

    await user.click(screen.getByTestId("stub-bot-thread-composer-sent"));

    expect(onOpenThread).not.toHaveBeenCalled();
  });
});
