/**
 * A bot's channel and its open thread (Tracy Bots, decision 41). The real
 * `BotChannelView` and `BotThreadPanel` run over mocked hooks; the transcript
 * and the message box are stubs that expose what the view hands them, so what
 * the channel PASSES them is what is asserted: the thread line it draws under
 * each post, the chat the thread panel reads, and where each box writes.
 */
import type { ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
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
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import type { ChatBotThreadLine } from "@/components/chat/chat-bot-presentation-context";
import type { BotTranscriptSurface } from "@/components/bots/bot-chat-transcript";
import { TooltipProvider } from "@/components/ui/tooltip";

interface ThreadListCall {
  readonly botId: string;
  readonly enabled: boolean;
  readonly poll: boolean;
}

interface IndicatorState {
  readonly unreadDone: boolean;
  readonly unreadFailure: boolean;
}

const mocks = vi.hoisted(() => {
  const chats: Record<string, IndicatorState> = {};
  return {
    client: { stub: "tab-host-client" },
    markRead: vi.fn<(entity: { epicId: string; chatId: string }) => void>(),
    markReadMutation: {
      mutate: (entity: { epicId: string; chatId: string }): void => {
        mocks.markRead(entity);
      },
    },
    postIds: [] as string[],
    threadListCalls: [] as Array<{
      botId: string;
      enabled: boolean;
      poll: boolean;
    }>,
    state: {
      paneVisible: true,
      threadListSupported: true,
      conversations: [] as Array<{ conversationId: string; createdAt: number }>,
      threads: [] as BotThreadSummary[],
      chats,
    },
  };
});

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.client,
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => mocks.state.threadListSupported,
}));
vi.mock("@/components/epic-tabs/pane-visibility-context", () => ({
  usePaneVisible: () => mocks.state.paneVisible,
}));
vi.mock("@/hooks/bots/use-bot-conversation-list-query", () => ({
  useBotConversationListQuery: () => ({
    data: { conversations: mocks.state.conversations },
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/bots/use-bot-thread-list-query", () => ({
  useBotThreadListQuery: (
    _client: unknown,
    botId: string,
    args: { enabled: boolean; poll: boolean },
  ) => {
    mocks.threadListCalls.push({ botId, ...args });
    return { data: { threads: mocks.state.threads } };
  },
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
vi.mock("@/components/bots/bot-chat-transcript", () => ({
  BotChatTranscript: (props: {
    chatId: string;
    surface: BotTranscriptSurface | null;
  }) => {
    const surface = props.surface;
    return (
      <div
        data-testid={`stub-transcript-${surface === null ? "session" : surface.kind}`}
        data-chat-id={props.chatId}
      >
        {surface !== null && surface.kind === "channel"
          ? mocks.postIds.map((postId) => (
              <PostStub
                key={postId}
                postId={postId}
                threadLine={surface.threadLine}
                openThread={surface.openThread}
              />
            ))
          : null}
      </div>
    );
  },
}));
vi.mock("@/components/bots/bot-message-composer", () => ({
  BotMessageComposer: (props: {
    conversationId: string;
    threadId: string | null;
    placeholder: string;
    testId: string;
  }) => (
    <div
      data-testid={`stub-${props.testId}`}
      data-conversation-id={props.conversationId}
      data-thread-id={props.threadId ?? "none"}
      data-placeholder={props.placeholder}
    />
  ),
}));

function PostStub(props: {
  readonly postId: string;
  readonly threadLine: (postMessageId: string) => ChatBotThreadLine | null;
  readonly openThread: (postMessageId: string) => void;
}): ReactNode {
  const line = props.threadLine(props.postId);
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
      />
      <button
        type="button"
        data-testid={`stub-open-${props.postId}`}
        onClick={() => props.openThread(props.postId)}
      />
    </div>
  );
}

import { BotChannelView } from "@/components/bots/bot-channel-view";
import type { BotMemberResolver } from "@/lib/bots/bot-member-names";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HOST_ID = "host-bound";

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
      text: `Post ${postId}`,
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

function indicator(
  unreadDone: boolean,
  unreadFailure: boolean,
): IndicatorState {
  return { unreadDone, unreadFailure };
}

interface MountOptions {
  readonly paused: boolean;
  readonly openThreadPostId: string | null;
}

function mount(options: MountOptions): {
  readonly onOpenThread: Mock<(id: string | null) => void>;
  readonly onOpenUnderTheHood: Mock<(id: string) => void>;
} {
  const onOpenThread = vi.fn<(id: string | null) => void>();
  const onOpenUnderTheHood = vi.fn<(id: string) => void>();
  render(
    <TooltipProvider>
      <ChatExpansionTestProviders tileInstanceId="tile-1">
        <BotChannelView
          botId={BOT_ID}
          hostId={HOST_ID}
          botTitle="Release Bot"
          paused={options.paused}
          resolveMember={resolveMember}
          openThreadPostId={options.openThreadPostId}
          onOpenThread={onOpenThread}
          onOpenUnderTheHood={onOpenUnderTheHood}
        />
      </ChatExpansionTestProviders>
    </TooltipProvider>,
  );
  return { onOpenThread, onOpenUnderTheHood };
}

function lastThreadListCall(): ThreadListCall {
  const call = mocks.threadListCalls.at(-1);
  if (call === undefined) throw new Error("the thread list was never read");
  return call;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.threadListCalls.length = 0;
  mocks.state.paneVisible = true;
  mocks.state.threadListSupported = true;
  mocks.state.conversations = [
    { conversationId: "conversation-later", createdAt: 9_000 },
    { conversationId: "conversation-channel", createdAt: 1_000 },
  ];
  mocks.state.threads = [];
  mocks.state.chats = {};
  mocks.postIds = [];
});

afterEach(() => {
  cleanup();
});

describe("<BotChannelView /> channel", () => {
  it("posts at the channel's top level on the bot's first conversation", () => {
    mount({ paused: false, openThreadPostId: null });

    const composer = screen.getByTestId("stub-bot-channel-composer");
    expect(composer.getAttribute("data-conversation-id")).toBe(
      "conversation-channel",
    );
    expect(composer.getAttribute("data-thread-id")).toBe("none");
    expect(composer.getAttribute("data-placeholder")).toBe(
      "Message #Release Bot",
    );
    expect(screen.queryByTestId("bot-thread-panel")).toBeNull();
    expect(
      screen
        .getByTestId("stub-transcript-channel")
        .getAttribute("data-chat-id"),
    ).toBe("conversation-channel");
  });

  it("reads the thread list only while the pane is on screen, and not at all while paused or unsupported", () => {
    mount({ paused: false, openThreadPostId: null });
    expect(lastThreadListCall()).toEqual({
      botId: BOT_ID,
      enabled: true,
      poll: true,
    });
    cleanup();

    mocks.state.paneVisible = false;
    mount({ paused: false, openThreadPostId: null });
    expect(lastThreadListCall()).toEqual({
      botId: BOT_ID,
      enabled: true,
      poll: false,
    });
    cleanup();

    mocks.state.paneVisible = true;
    mount({ paused: true, openThreadPostId: null });
    expect(lastThreadListCall().enabled).toBe(false);
    cleanup();

    mocks.state.threadListSupported = false;
    mount({ paused: false, openThreadPostId: null });
    expect(lastThreadListCall().enabled).toBe(false);
  });

  it("gives each post the line of the thread anchored on it, with the thread's unread state", () => {
    mocks.state.threads = [
      thread("thread-a", "post-a", { replyCount: 3, lastReplyAt: 7_000 }),
      thread("thread-b", "post-b", { replyCount: 1, lastReplyAt: 8_000 }),
      thread("thread-c", "post-c", { replyCount: 2, lastReplyAt: 9_500 }),
      thread("thread-d", "post-d", { replyCount: 4, lastReplyAt: 9_900 }),
    ];
    mocks.state.chats = {
      "thread-a": indicator(true, false),
      "thread-b": indicator(false, false),
      "thread-c": indicator(false, true),
    };
    mocks.postIds = ["post-a", "post-b", "post-c", "post-d", "post-new"];
    mount({ paused: false, openThreadPostId: null });

    const line = (postId: string): HTMLElement =>
      screen.getByTestId(`stub-line-${postId}`);
    expect(line("post-a").getAttribute("data-reply-count")).toBe("3");
    expect(line("post-a").getAttribute("data-last-reply-at")).toBe("7000");
    expect(line("post-a").getAttribute("data-unread")).toBe("true");
    expect(line("post-b").getAttribute("data-reply-count")).toBe("1");
    expect(line("post-b").getAttribute("data-unread")).toBe("false");
    expect(line("post-c").getAttribute("data-unread")).toBe("true");
    // A thread the viewer took part in nowhere has no indicator and no dot.
    expect(line("post-d").getAttribute("data-reply-count")).toBe("4");
    expect(line("post-d").getAttribute("data-unread")).toBe("false");
    // A post with no thread listed yet has no line to read.
    expect(line("post-new").getAttribute("data-has-line")).toBe("false");
  });

  it("asks the host to open a post's thread when its line is clicked", async () => {
    const user = userEvent.setup();
    mocks.state.threads = [thread("thread-a", "post-a", { replyCount: 1 })];
    mocks.postIds = ["post-a"];
    const { onOpenThread } = mount({ paused: false, openThreadPostId: null });

    await user.click(screen.getByTestId("stub-open-post-a"));

    expect(onOpenThread).toHaveBeenCalledTimes(1);
    expect(onOpenThread).toHaveBeenCalledWith("post-a");
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

  it("reads the thread's chat in the panel and replies into that thread", () => {
    mount({ paused: false, openThreadPostId: "post-a" });

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
    // The anchor post is drawn above the replies, under the member's name.
    const anchor = within(panel).getByTestId("bot-thread-anchor");
    expect(within(anchor).getByText("Tess Teammate")).toBeTruthy();
    expect(within(anchor).getByText("Post post-a")).toBeTruthy();
    // The channel's own box keeps posting at the top level beside it.
    expect(
      screen
        .getByTestId("stub-bot-channel-composer")
        .getAttribute("data-thread-id"),
    ).toBe("none");
  });

  it("shows the thread's cost in the header only when the host can say", () => {
    mount({ paused: false, openThreadPostId: "post-a" });
    expect(screen.getByTestId("bot-thread-cost").textContent).toBe("$0.42");
    cleanup();

    mount({ paused: false, openThreadPostId: "post-b" });
    expect(screen.getByTestId("bot-thread-panel")).toBeTruthy();
    expect(screen.queryByTestId("bot-thread-cost")).toBeNull();
  });

  it("opens the thread's session under the hood", async () => {
    const user = userEvent.setup();
    const { onOpenUnderTheHood } = mount({
      paused: false,
      openThreadPostId: "post-a",
    });

    await user.click(screen.getByTestId("bot-thread-under-the-hood"));

    expect(onOpenUnderTheHood).toHaveBeenCalledTimes(1);
    expect(onOpenUnderTheHood).toHaveBeenCalledWith("session-a");
  });

  it("closes the thread from its header", async () => {
    const user = userEvent.setup();
    const { onOpenThread } = mount({
      paused: false,
      openThreadPostId: "post-a",
    });

    await user.click(screen.getByTestId("bot-thread-close"));

    expect(onOpenThread).toHaveBeenCalledWith(null);
  });

  it("marks an unread thread read when it is opened, and leaves a read one alone", () => {
    mocks.state.chats = { "thread-a": indicator(true, false) };
    mount({ paused: false, openThreadPostId: "post-a" });
    expect(mocks.markRead).toHaveBeenCalledTimes(1);
    expect(mocks.markRead).toHaveBeenCalledWith({
      epicId: BOT_ID,
      chatId: "thread-a",
    });
    cleanup();
    mocks.markRead.mockClear();

    mocks.state.chats = { "thread-b": indicator(false, false) };
    mount({ paused: false, openThreadPostId: "post-b" });
    expect(mocks.markRead).not.toHaveBeenCalled();
  });
});
