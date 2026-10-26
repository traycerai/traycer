/**
 * A bot's channel and threads draw their rows in Slack's layout (Tracy Bots,
 * decision 41). `<ChatMessage>` hands a row to `ChatBotMessage` when a
 * `ChatBotPresentationContext` is provided and draws the ordinary transcript
 * row when it is not. The rows come from `useRenderedMessages`, which carries
 * the persisted record's `announcement` and `conversationRequest` onto them.
 */
import { StrictMode, type ReactNode } from "react";
import {
  cleanup,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
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
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { hostEntryFixture } from "@/lib/environment/__tests__/environment-test-support";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  BotAnnouncement,
  BotAnnouncementKind,
  ConversationRequest,
} from "@traycer/protocol/persistence/epic/messages";
import type {
  AgentSender,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import { avatarShape } from "@/components/bots/__tests__/avatar-shape";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { makeMessage } from "@/components/chat/__tests__/chat-message-fixtures";
import {
  ChatBotPresentationContext,
  type ChatBotPresentation,
  type ChatBotThreadLine,
} from "@/components/chat/chat-bot-presentation-context";
import { ChatEmptyState } from "@/components/chat/chat-empty-state";
import { ChatMessage } from "@/components/chat/chat-message";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useRetrospectiveSheetStore } from "@/stores/settings/retrospective-sheet-store";
import {
  useRenderedMessages,
  type RenderedMessagesDisplayContext,
  type RenderedMessagesInput,
} from "@/stores/chats/rendered-messages";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";

const mocks = vi.hoisted(
  (): {
    openLink: Mock<
      (url: string, kind: string, event: unknown) => Promise<void>
    >;
    hostLabel: { current: string | null };
  } => ({
    openLink:
      vi.fn<(url: string, kind: string, event: unknown) => Promise<void>>(),
    hostLabel: { current: null },
  }),
);

// The host directory is the boundary: which label a host id carries.
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostDirectoryEntryForHostId: (
    hostId: string | null,
  ): HostDirectoryEntry | null =>
    hostId === null || mocks.hostLabel.current === null
      ? null
      : { ...hostEntryFixture(hostId), label: mocks.hostLabel.current },
}));

vi.mock("@/lib/links/open-link", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/links/open-link")>()),
  useOpenLink: () => mocks.openLink,
}));

const EMPTY_BACKGROUND_TOOL_BLOCK_IDS: ReadonlySet<string> = new Set();
const POST_ID = "post-1";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hostLabel.current = null;
  mocks.openLink.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  useRetrospectiveSheetStore.setState({ target: null, open: false });
});

function channelPresentation(
  threadLine: (postMessageId: string) => ChatBotThreadLine | null,
  openThread: (postMessageId: string) => void,
): ChatBotPresentation {
  return {
    botTitle: "Release Bot",
    scrollToMessage: null,
    replyFollowsPost: null,
    repliedPost: null,
    threadLine,
    openThread,
    openAnnouncementThread: null,
    chooseOption: null,
  };
}

function renderRow(
  message: ChatMessageModel,
  presentation: ChatBotPresentation | null,
): void {
  function Providers(props: { readonly children: ReactNode }) {
    return (
      <StrictMode>
        <TooltipProvider>
          <ChatExpansionTestProviders tileInstanceId="tile-1">
            <ChatBotPresentationContext.Provider value={presentation}>
              {props.children}
            </ChatBotPresentationContext.Provider>
          </ChatExpansionTestProviders>
        </TooltipProvider>
      </StrictMode>
    );
  }
  render(
    <ChatMessage
      message={message}
      actions={null}
      backgroundToolBlockIds={EMPTY_BACKGROUND_TOOL_BLOCK_IDS}
      nextStepActions={null}
    />,
    { wrapper: Providers },
  );
}

function memberPost(
  conversationRequest: ConversationRequest | undefined,
): ChatMessageModel {
  const base: ChatMessageModel = {
    ...makeMessage(0, "user"),
    persistentMessageId: POST_ID,
    senderLabel: "Tess Teammate",
    content: "Please review the release",
    segments: [
      {
        id: "message-0:text",
        kind: "text",
        markdown: "Please review the release",
        isStreaming: false,
      },
    ],
  };
  return conversationRequest === undefined
    ? base
    : { ...base, conversationRequest };
}

function botRow(announcement: BotAnnouncement | undefined): ChatMessageModel {
  const base: ChatMessageModel = {
    ...makeMessage(1, "assistant"),
    segments: [
      {
        id: "message-1:text",
        kind: "text",
        markdown: "The bot says hello",
        isStreaming: false,
      },
    ],
  };
  return announcement === undefined ? base : { ...base, announcement };
}

const NO_THREAD_LINE = (): ChatBotThreadLine | null => null;

describe("<ChatMessage /> in a bot channel", () => {
  it("draws a member's post with the sender, a round picture and the text, no badge for its resolved request, and no jump to a reply", () => {
    renderRow(
      memberPost({
        requestId: "req-1",
        resolvedAt: 5_000,
        resolvedByMessageId: "reply-9",
      }),
      channelPresentation(NO_THREAD_LINE, vi.fn()),
    );

    const row = screen.getByTestId("bot-member-row");
    expect(within(row).getByText("Tess Teammate")).toBeTruthy();
    expect(within(row).getByText("Please review the release")).toBeTruthy();
    expect(avatarShape(within(row).getByTestId("chat-sender-avatar"))).toBe(
      "circle",
    );
    expect(screen.queryByTestId("conversation-request")).toBeNull();
    expect(within(row).queryByText("Resolved")).toBeNull();
    expect(screen.queryByTestId("conversation-request-reply-link")).toBeNull();
  });

  it("draws no badge on a post whose request is unresolved", () => {
    renderRow(
      memberPost({
        requestId: "req-2",
        resolvedAt: null,
        resolvedByMessageId: null,
      }),
      channelPresentation(NO_THREAD_LINE, vi.fn()),
    );

    const row = screen.getByTestId("bot-member-row");
    expect(screen.queryByTestId("conversation-request")).toBeNull();
    expect(within(row).queryByText("Open")).toBeNull();
  });

  it("opens the post's thread from the thread line, with the replies and the last reply named", async () => {
    const user = userEvent.setup();
    const openThread = vi.fn<(postMessageId: string) => void>();
    renderRow(
      memberPost(undefined),
      channelPresentation(
        () => ({
          participants: [],
          replyCount: 3,
          lastReplyAt: Date.now() - 5 * 60_000,
          unread: false,
          replying: false,
        }),
        openThread,
      ),
    );

    const line = screen.getByTestId("bot-thread-line");
    expect(within(line).getByText("3 replies")).toBeTruthy();
    expect(within(line).getByText(/Last reply/)).toBeTruthy();
    expect(openThread).not.toHaveBeenCalled();

    await user.click(line);

    expect(openThread).toHaveBeenCalledTimes(1);
    expect(openThread).toHaveBeenCalledWith(POST_ID);
  });

  it("offers Reply in thread among a member post's hover actions, with no thread line until the thread has a reply", async () => {
    const user = userEvent.setup();
    const openThread = vi.fn<(postMessageId: string) => void>();
    renderRow(
      memberPost(undefined),
      channelPresentation(
        () => ({
          participants: [],
          replyCount: 0,
          lastReplyAt: null,
          unread: false,
          replying: false,
        }),
        openThread,
      ),
    );
    expect(screen.queryByTestId("bot-thread-line")).toBeNull();
    expect(
      screen.queryByText("Reply in thread", { selector: "span" }),
    ).toBeNull();
    const actions = screen.getByTestId("bot-message-actions");
    expect(openThread).not.toHaveBeenCalled();

    await user.click(
      within(actions).getByRole("button", { name: "Reply in thread" }),
    );

    expect(openThread).toHaveBeenCalledTimes(1);
    expect(openThread).toHaveBeenCalledWith(POST_ID);
    cleanup();

    renderRow(
      memberPost(undefined),
      channelPresentation(NO_THREAD_LINE, openThread),
    );
    expect(screen.queryByTestId("bot-thread-line")).toBeNull();
    expect(screen.getByTestId("bot-message-reply-in-thread")).toBeTruthy();
  });

  it("shows the thread line while the bot answers in a thread that has no reply yet", () => {
    renderRow(
      memberPost(undefined),
      channelPresentation(
        () => ({
          participants: [],
          replyCount: 0,
          lastReplyAt: null,
          unread: false,
          replying: true,
        }),
        vi.fn(),
      ),
    );

    expect(screen.getByTestId("bot-thread-line")).toBeTruthy();
  });

  it("stacks who is in the thread: the post's writer as a circle, the bot as a squircle", () => {
    renderRow(
      memberPost(undefined),
      channelPresentation(
        () => ({
          participants: [
            {
              kind: "person",
              userId: "user-teammate",
              name: "Tess Teammate",
              avatarUrl: null,
            },
            { kind: "bot" },
          ],
          replyCount: 2,
          lastReplyAt: 1_000,
          unread: false,
          replying: false,
        }),
        vi.fn(),
      ),
    );

    const stack = within(screen.getByTestId("bot-thread-line")).getByTestId(
      "bot-thread-participants",
    );
    expect(
      Array.from(
        stack.querySelectorAll<HTMLElement>('[data-slot="avatar"]'),
        avatarShape,
      ),
    ).toEqual(["circle", "squircle"]);
    expect(
      within(stack).queryByTestId("bot-thread-participants-more"),
    ).toBeNull();
  });

  it("draws the post's writer in one colour in its row and in its thread's stack", () => {
    renderRow(
      { ...memberPost(undefined), senderUserId: "user-teammate" },
      channelPresentation(
        () => ({
          participants: [
            {
              kind: "person",
              userId: "user-teammate",
              name: "Tess Teammate",
              avatarUrl: null,
            },
          ],
          replyCount: 1,
          lastReplyAt: 1_000,
          unread: false,
          replying: false,
        }),
        vi.fn(),
      ),
    );

    const swatchIn = (scope: HTMLElement): string | undefined =>
      scope
        .querySelector<HTMLElement>('[data-slot="avatar-fallback"]')
        ?.style.getPropertyValue("--swatch");
    const row = screen.getByTestId("bot-member-row");
    const stack = within(row).getByTestId("bot-thread-participants");
    const rowAvatar = within(row)
      .getAllByTestId("chat-sender-avatar")
      .find((avatar) => !stack.contains(avatar));
    expect(rowAvatar).toBeDefined();
    if (rowAvatar === undefined) return;
    expect(swatchIn(rowAvatar)).toBeTruthy();
    expect(swatchIn(rowAvatar)).toBe(swatchIn(stack));
  });

  it("marks a thread line unread with a dot, and a read one with none", () => {
    renderRow(
      memberPost(undefined),
      channelPresentation(
        () => ({
          participants: [],
          replyCount: 2,
          lastReplyAt: 1_000,
          unread: true,
          replying: false,
        }),
        vi.fn(),
      ),
    );
    expect(
      screen.getByTestId("bot-thread-line").getAttribute("data-unread"),
    ).toBe("true");
    expect(screen.getByTestId("bot-thread-unread")).toBeTruthy();
    cleanup();

    renderRow(
      memberPost(undefined),
      channelPresentation(
        () => ({
          participants: [],
          replyCount: 2,
          lastReplyAt: 1_000,
          unread: false,
          replying: false,
        }),
        vi.fn(),
      ),
    );
    expect(
      screen.getByTestId("bot-thread-line").getAttribute("data-unread"),
    ).toBe("false");
    expect(screen.queryByTestId("bot-thread-unread")).toBeNull();
  });
});

describe("<ChatMessage /> in a bot thread", () => {
  it("draws no thread line, and a resolved request's See reply lands the list on the reply", async () => {
    const user = userEvent.setup();
    const scrollToMessage = vi.fn<(messageId: string) => void>();
    renderRow(
      memberPost({
        requestId: "req-3",
        resolvedAt: 5_000,
        resolvedByMessageId: "reply-9",
      }),
      {
        botTitle: "Release Bot",
        scrollToMessage,
        threadLine: null,
        openThread: null,
        openAnnouncementThread: null,
        chooseOption: null,
        replyFollowsPost: null,
        repliedPost: null,
      },
    );

    expect(screen.queryByTestId("bot-thread-line")).toBeNull();
    expect(screen.queryByTestId("bot-message-actions")).toBeNull();
    const link = screen.getByTestId("conversation-request-reply-link");
    expect(link.textContent).toBe("See reply");
    expect(scrollToMessage).not.toHaveBeenCalled();

    await user.click(link);

    expect(scrollToMessage).toHaveBeenCalledTimes(1);
    expect(scrollToMessage).toHaveBeenCalledWith("reply-9");
  });
});

describe("<ChatMessage /> bot rows", () => {
  const presentation: ChatBotPresentation = {
    botTitle: "Release Bot",
    scrollToMessage: null,
    replyFollowsPost: null,
    repliedPost: null,
    threadLine: null,
    openThread: null,
    openAnnouncementThread: null,
    chooseOption: null,
  };

  it("labels a bot's reply with the bot's current title and the APP tag", () => {
    renderRow(botRow(undefined), presentation);

    const row = screen.getByTestId("bot-reply-row");
    expect(within(row).getByText("Release Bot")).toBeTruthy();
    expect(within(row).getByText("APP")).toBeTruthy();
    expect(within(row).getByText("The bot says hello")).toBeTruthy();
    expect(screen.queryByTestId("bot-announcement")).toBeNull();
    expect(screen.queryByTestId("bot-reply-options")).toBeNull();
  });

  const KIND_LABELS: ReadonlyArray<readonly [BotAnnouncementKind, string]> = [
    ["proposal", "New proposal"],
    ["automation", "Automation created"],
    ["bot-created", "New bot"],
    ["policy", "Policy change"],
    ["question", "Question"],
  ];

  it.each(KIND_LABELS)(
    "draws a %s announcement under the label %s",
    (kind, label) => {
      renderRow(botRow({ kind, link: null }), presentation);

      const row = screen.getByTestId("bot-announcement");
      expect(screen.queryByTestId("bot-reply-row")).toBeNull();
      expect(within(row).getByText("APP")).toBeTruthy();
      expect(within(row).getByText(label)).toBeTruthy();
      expect(within(row).getByText("The bot says hello")).toBeTruthy();
      expect(
        row
          .querySelector("[data-announcement-kind]")
          ?.getAttribute("data-announcement-kind"),
      ).toBe(kind);
      expect(screen.queryByTestId("bot-announcement-link")).toBeNull();
    },
  );

  it("opens an announcement's web link through the link opener", async () => {
    const user = userEvent.setup();
    renderRow(
      botRow({ kind: "proposal", link: "https://example.com/proposal/7" }),
      presentation,
    );

    const link = screen.getByTestId("bot-announcement-link");
    expect(link.textContent).toBe("https://example.com/proposal/7");
    expect(
      within(screen.getByTestId("bot-announcement")).getByText("New proposal"),
    ).toBeTruthy();
    expect(mocks.openLink).not.toHaveBeenCalled();

    await user.click(link);

    expect(mocks.openLink).toHaveBeenCalledTimes(1);
    expect(mocks.openLink.mock.calls[0]?.[0]).toBe(
      "https://example.com/proposal/7",
    );
  });

  it.each<readonly [string | null, string]>([
    [null, "this computer"],
    ["Office Mac", "Office Mac"],
  ])(
    "draws a retrospective sheet link as a Review action that opens that host's sheet (directory label %s)",
    async (label, hostName) => {
      const user = userEvent.setup();
      const hostId = "host/a b";
      mocks.hostLabel.current = label;
      renderRow(
        botRow({
          kind: "proposal",
          link: `environment/retrospective?host=${encodeURIComponent(hostId)}`,
        }),
        presentation,
      );

      expect(screen.queryByText(/environment\/retrospective/)).toBeNull();
      const row = screen.getByTestId("bot-announcement");
      expect(
        within(row).getByText("Shared by an earlier version"),
      ).toBeTruthy();
      expect(within(row).queryByText("New proposal")).toBeNull();
      expect(screen.queryByTestId("bot-announcement-link")).toBeNull();
      expect(useRetrospectiveSheetStore.getState().open).toBe(false);

      await user.click(screen.getByTestId("bot-announcement-review"));

      const state = useRetrospectiveSheetStore.getState();
      expect(state.open).toBe(true);
      expect(state.target).toEqual({ hostId, hostName });
    },
  );

  it("shows an epic-relative path as the path it is, not as a link", () => {
    renderRow(
      botRow({ kind: "proposal", link: "artifacts/plan/index.md" }),
      presentation,
    );

    expect(screen.getByText("artifacts/plan/index.md")).toBeTruthy();
    expect(screen.queryByTestId("bot-announcement-link")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("<ChatMessage /> bot row choices and announcement threads", () => {
  const ANNOUNCEMENT_ID = "announcement-1";
  const OPTIONS = ["Ship it", "Hold"];

  function announcementRow(kind: BotAnnouncementKind): ChatMessageModel {
    return {
      ...botRow({ kind, link: null }),
      persistentMessageId: ANNOUNCEMENT_ID,
    };
  }

  function withActions(input: {
    readonly threadLine:
      | ((postMessageId: string) => ChatBotThreadLine | null)
      | null;
    readonly openAnnouncementThread: ((announcementId: string) => void) | null;
    readonly chooseOption: ((choice: string) => void) | null;
  }): ChatBotPresentation {
    return {
      botTitle: "Release Bot",
      scrollToMessage: null,
      replyFollowsPost: null,
      repliedPost: null,
      threadLine: input.threadLine,
      openThread: null,
      openAnnouncementThread: input.openAnnouncementThread,
      chooseOption: input.chooseOption,
    };
  }

  it("draws a question on the chart-2 bar", () => {
    renderRow(
      announcementRow("question"),
      withActions({
        threadLine: NO_THREAD_LINE,
        openAnnouncementThread: vi.fn(),
        chooseOption: null,
      }),
    );

    const bar = screen
      .getByTestId("bot-announcement")
      .querySelector("[data-announcement-kind]");
    expect(bar?.classList.contains("border-l-chart-2")).toBe(true);
  });

  it("draws a reply's options as buttons and posts the clicked choice", async () => {
    const user = userEvent.setup();
    const chooseOption = vi.fn<(choice: string) => void>();
    renderRow(
      { ...botRow(undefined), options: OPTIONS },
      withActions({
        threadLine: null,
        openAnnouncementThread: null,
        chooseOption,
      }),
    );

    const group = screen.getByRole("group", { name: "Choices" });
    const buttons = within(group).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(OPTIONS);
    expect(chooseOption).not.toHaveBeenCalled();

    await user.click(within(group).getByRole("button", { name: "Hold" }));

    expect(chooseOption).toHaveBeenCalledTimes(1);
    expect(chooseOption).toHaveBeenCalledWith("Hold");
  });

  it("shows a reply's options disabled where nothing can post them", () => {
    renderRow(
      { ...botRow(undefined), options: OPTIONS },
      withActions({
        threadLine: NO_THREAD_LINE,
        openAnnouncementThread: null,
        chooseOption: null,
      }),
    );

    const buttons = within(
      screen.getByTestId("bot-reply-options"),
    ).getAllByRole("button");
    expect(buttons).toHaveLength(OPTIONS.length);
    expect(buttons.every((button) => button.hasAttribute("disabled"))).toBe(
      true,
    );
  });

  it.each<BotAnnouncementKind>(["question", "proposal"])(
    "opens the thread under a %s from its thread line, by the row's persisted message id",
    async (kind) => {
      const user = userEvent.setup();
      const threadLine = vi.fn<
        (postMessageId: string) => ChatBotThreadLine | null
      >(() => ({
        participants: [],
        replyCount: 2,
        lastReplyAt: 1_000,
        unread: false,
        replying: false,
      }));
      const openAnnouncementThread = vi.fn<(announcementId: string) => void>();
      renderRow(
        announcementRow(kind),
        withActions({ threadLine, openAnnouncementThread, chooseOption: null }),
      );

      const line = screen.getByTestId("bot-thread-line");
      expect(within(line).getByText("2 replies")).toBeTruthy();
      expect(threadLine).toHaveBeenCalledWith(ANNOUNCEMENT_ID);
      expect(openAnnouncementThread).not.toHaveBeenCalled();

      await user.click(line);

      expect(openAnnouncementThread).toHaveBeenCalledTimes(1);
      expect(openAnnouncementThread).toHaveBeenCalledWith(ANNOUNCEMENT_ID);
    },
  );

  it.each<BotAnnouncementKind>(["question", "proposal"])(
    "opens a %s's own thread from its hover action while its thread is not listed yet, with no thread line",
    async (kind) => {
      const user = userEvent.setup();
      const openAnnouncementThread = vi.fn<(announcementId: string) => void>();
      renderRow(
        announcementRow(kind),
        withActions({
          threadLine: NO_THREAD_LINE,
          openAnnouncementThread,
          chooseOption: null,
        }),
      );

      expect(screen.queryByTestId("bot-thread-line")).toBeNull();
      await user.click(screen.getByRole("button", { name: "Reply in thread" }));

      expect(openAnnouncementThread).toHaveBeenCalledTimes(1);
      expect(openAnnouncementThread).toHaveBeenCalledWith(ANNOUNCEMENT_ID);
    },
  );

  it.each<BotAnnouncementKind>(["automation", "bot-created", "policy"])(
    "draws no thread line and no hover actions on a %s announcement",
    (kind) => {
      renderRow(
        announcementRow(kind),
        withActions({
          threadLine: NO_THREAD_LINE,
          openAnnouncementThread: vi.fn(),
          chooseOption: null,
        }),
      );

      expect(screen.getByTestId("bot-announcement")).toBeTruthy();
      expect(screen.queryByTestId("bot-thread-line")).toBeNull();
      expect(screen.queryByTestId("bot-message-actions")).toBeNull();
    },
  );

  it("draws no thread line under a question that cannot open a thread, or has no persisted id", () => {
    renderRow(
      announcementRow("question"),
      withActions({
        threadLine: null,
        openAnnouncementThread: null,
        chooseOption: vi.fn(),
      }),
    );
    expect(screen.queryByTestId("bot-thread-line")).toBeNull();
    expect(screen.queryByTestId("bot-message-actions")).toBeNull();
    cleanup();

    renderRow(
      { ...announcementRow("question"), persistentMessageId: null },
      withActions({
        threadLine: NO_THREAD_LINE,
        openAnnouncementThread: vi.fn(),
        chooseOption: null,
      }),
    );
    expect(screen.queryByTestId("bot-thread-line")).toBeNull();
    expect(screen.queryByTestId("bot-message-actions")).toBeNull();
  });
});

describe("<ChatMessage /> direct replies in a bot channel", () => {
  const REPLY_ID = "reply-9";
  const CHANNEL: ChatBotPresentation = {
    botTitle: "Release Bot",
    scrollToMessage: null,
    replyFollowsPost: null,
    repliedPost: null,
    threadLine: NO_THREAD_LINE,
    openThread: null,
    openAnnouncementThread: null,
    chooseOption: null,
  };

  function resolvedPost(direct: boolean): ChatMessageModel {
    const request: ConversationRequest = {
      requestId: "req-d",
      resolvedAt: 5_000,
      resolvedByMessageId: REPLY_ID,
    };
    return memberPost(direct ? { ...request, direct: true } : request);
  }

  it("opens the thread box under a direct post, not a post thread", async () => {
    const user = userEvent.setup();
    const openThread = vi.fn<(postMessageId: string) => void>();
    const openAnnouncementThread = vi.fn<(announcementId: string) => void>();
    renderRow(
      memberPost({
        requestId: "req-d",
        resolvedAt: null,
        resolvedByMessageId: null,
        direct: true,
      }),
      { ...CHANNEL, openThread, openAnnouncementThread },
    );

    await user.click(screen.getByRole("button", { name: "Reply in thread" }));

    expect(openAnnouncementThread).toHaveBeenCalledTimes(1);
    expect(openAnnouncementThread).toHaveBeenCalledWith(POST_ID);
    expect(openThread).not.toHaveBeenCalled();
  });

  it("still opens the post's own thread from a post that is not direct", async () => {
    const user = userEvent.setup();
    const openThread = vi.fn<(postMessageId: string) => void>();
    const openAnnouncementThread = vi.fn<(announcementId: string) => void>();
    renderRow(
      memberPost({
        requestId: "req-t",
        resolvedAt: null,
        resolvedByMessageId: null,
      }),
      { ...CHANNEL, openThread, openAnnouncementThread },
    );

    await user.click(screen.getByRole("button", { name: "Reply in thread" }));

    expect(openThread).toHaveBeenCalledTimes(1);
    expect(openThread).toHaveBeenCalledWith(POST_ID);
    expect(openAnnouncementThread).not.toHaveBeenCalled();
  });

  it("jumps from a resolved direct post to the reply that is in the channel", async () => {
    const user = userEvent.setup();
    const scrollToMessage = vi.fn<(messageId: string) => void>();
    renderRow(resolvedPost(true), {
      ...CHANNEL,
      scrollToMessage,
      replyFollowsPost: () => false,
    });

    const link = screen.getByTestId("conversation-request-reply-link");
    expect(link.textContent).toBe("See reply");

    await user.click(link);

    expect(scrollToMessage).toHaveBeenCalledTimes(1);
    expect(scrollToMessage).toHaveBeenCalledWith(REPLY_ID);
  });

  it("offers no jump from a resolved direct post whose reply is the very next row", () => {
    const replyFollowsPost = vi.fn<(post: string, reply: string) => boolean>(
      () => true,
    );
    renderRow(resolvedPost(true), {
      ...CHANNEL,
      scrollToMessage: vi.fn(),
      replyFollowsPost,
    });

    expect(replyFollowsPost).toHaveBeenCalledWith(POST_ID, REPLY_ID);
    expect(screen.queryByTestId("conversation-request-reply-link")).toBeNull();
  });

  it("offers no jump from a resolved post that is not direct, whose reply is in its thread", () => {
    renderRow(resolvedPost(false), {
      ...CHANNEL,
      scrollToMessage: vi.fn(),
    });

    expect(screen.queryByTestId("conversation-request-reply-link")).toBeNull();
  });

  it("names the post a reply answers above the reply, and lands the list on it when clicked", async () => {
    const user = userEvent.setup();
    const scrollToMessage = vi.fn<(messageId: string) => void>();
    const repliedPost = vi.fn<
      (messageId: string) => { senderLabel: string; excerpt: string } | null
    >(() => ({ senderLabel: "Tess Teammate", excerpt: "Please review" }));
    renderRow(
      { ...botRow(undefined), repliesTo: POST_ID },
      { ...CHANNEL, scrollToMessage, repliedPost },
    );

    const line = screen.getByTestId("bot-replied-post");
    expect(within(line).getByText("Tess Teammate")).toBeTruthy();
    expect(within(line).getByText("Please review")).toBeTruthy();
    expect(repliedPost).toHaveBeenCalledWith(POST_ID);
    expect(scrollToMessage).not.toHaveBeenCalled();

    await user.click(line);

    expect(scrollToMessage).toHaveBeenCalledTimes(1);
    expect(scrollToMessage).toHaveBeenCalledWith(POST_ID);
  });

  it("names the replied post without a jump where the list cannot scroll", () => {
    renderRow(
      { ...botRow(undefined), repliesTo: POST_ID },
      {
        ...CHANNEL,
        repliedPost: () => ({ senderLabel: "Tess Teammate", excerpt: "Hi" }),
      },
    );

    const line = screen.getByTestId("bot-replied-post");
    expect(line.tagName).toBe("DIV");
    expect(within(line).getByText("Tess Teammate")).toBeTruthy();
  });

  it("draws no replied-post line while the post it answers is not in the list", () => {
    renderRow(
      { ...botRow(undefined), repliesTo: POST_ID },
      { ...CHANNEL, repliedPost: () => null },
    );

    expect(screen.getByTestId("bot-reply-row")).toBeTruthy();
    expect(screen.queryByTestId("bot-replied-post")).toBeNull();
  });

  it("draws no replied-post line on a bot row that answers no post", () => {
    renderRow(botRow(undefined), {
      ...CHANNEL,
      repliedPost: () => ({ senderLabel: "Tess Teammate", excerpt: "Hi" }),
    });

    expect(screen.queryByTestId("bot-replied-post")).toBeNull();
  });

  it("opens the thread under the post a direct reply answers from the reply's hover action, with no thread line of its own", async () => {
    const user = userEvent.setup();
    const openThread = vi.fn<(postMessageId: string) => void>();
    const openAnnouncementThread = vi.fn<(announcementId: string) => void>();
    renderRow(
      {
        ...botRow(undefined),
        persistentMessageId: "reply-row-1",
        repliesTo: POST_ID,
      },
      { ...CHANNEL, openThread, openAnnouncementThread },
    );

    expect(screen.queryByTestId("bot-thread-line")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Reply in thread" }));

    expect(openAnnouncementThread).toHaveBeenCalledTimes(1);
    expect(openAnnouncementThread).toHaveBeenCalledWith(POST_ID);
    expect(openThread).not.toHaveBeenCalled();
  });

  it("offers no hover actions on a bot reply that answers no post", () => {
    renderRow(botRow(undefined), {
      ...CHANNEL,
      openThread: vi.fn(),
      openAnnouncementThread: vi.fn(),
    });

    expect(screen.queryByTestId("bot-message-actions")).toBeNull();
  });

  it("posts the clicked option of a direct reply as a new post", async () => {
    const user = userEvent.setup();
    const chooseOption = vi.fn<(choice: string) => void>();
    renderRow(
      {
        ...botRow(undefined),
        repliesTo: POST_ID,
        options: ["Ship it", "Hold"],
      },
      { ...CHANNEL, chooseOption },
    );

    await user.click(screen.getByRole("button", { name: "Hold" }));

    expect(chooseOption).toHaveBeenCalledTimes(1);
    expect(chooseOption).toHaveBeenCalledWith("Hold");
  });

  it("disables a direct reply's options while a pick is being sent", () => {
    renderRow(
      {
        ...botRow(undefined),
        repliesTo: POST_ID,
        options: ["Ship it", "Hold"],
      },
      CHANNEL,
    );

    const buttons = within(
      screen.getByTestId("bot-reply-options"),
    ).getAllByRole("button");
    expect(buttons.every((button) => button.hasAttribute("disabled"))).toBe(
      true,
    );
  });
});

describe("<ChatMessage /> with no bot presentation", () => {
  it("draws a user row as the ordinary transcript row", () => {
    renderRow(
      memberPost({
        requestId: "req-4",
        resolvedAt: null,
        resolvedByMessageId: null,
      }),
      null,
    );

    expect(screen.getByText("Please review the release")).toBeTruthy();
    expect(screen.queryByTestId("bot-member-row")).toBeNull();
    expect(screen.queryByTestId("conversation-request")).toBeNull();
    expect(screen.queryByTestId("bot-thread-line")).toBeNull();
  });
});

describe("useRenderedMessages bot rows", () => {
  const CONTENT: JsonContent = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Please review" }] },
    ],
  };
  const BOT_SENDER: AgentSender = {
    type: "agent",
    harnessId: "claude",
    agentId: "claude-sonnet-4",
    displayName: "Claude Sonnet 4",
    reply: { expectsReply: false },
    inReplyTo: null,
  };
  const displayContext: RenderedMessagesDisplayContext = {
    resolveUserSenderLabel: () => "You",
    resolveUserSenderAvatarUrl: () => null,
    resolveAgentSenderDisplay: () => ({
      senderLabel: "Claude",
      providerLabel: "Claude Code",
      modelLabel: null,
    }),
    resolveAgentReasoningLabel: () => null,
    resolveAgentServiceTierLabel: () => null,
    contentBlocksPreview: () => "",
  };

  function assistantRecord(
    messageId: string,
    announcement: BotAnnouncement | undefined,
  ): Extract<Message, { role: "assistant" }> {
    const base: Extract<Message, { role: "assistant" }> = {
      role: "assistant",
      messageId,
      sender: BOT_SENDER,
      blocks: [
        {
          type: "text",
          blockId: `${messageId}:text`,
          status: "completed",
          timestamp: 2_000,
          text: "Heads up",
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
    return announcement === undefined ? base : { ...base, announcement };
  }

  function withOptions(
    record: Extract<Message, { role: "assistant" }>,
    options: ReadonlyArray<string>,
  ): Extract<Message, { role: "assistant" }> {
    return { ...record, options: [...options] };
  }

  function userRecord(
    messageId: string,
    conversationRequest: ConversationRequest,
  ): Extract<Message, { role: "user" }> {
    return {
      role: "user",
      messageId,
      sender: { type: "user", userId: "owner-1" },
      message: { kind: "user", content: CONTENT, browserAnnotations: [] },
      timestamp: 1_000,
      sessionAnchor: null,
      conversationRequest,
    };
  }

  function renderRows(messages: ReadonlyArray<Message>) {
    const input: RenderedMessagesInput = {
      epicId: "epic-1",
      ownerId: "owner-1",
      ownerKind: "chat",
      viewTabId: "tab-1",
      messages,
      events: [],
      rowContext: {},
      setupCardWindows: [],
      pendingUserMessages: [],
      withdrawnMessageId: null,
      liveAssistantMessage: null,
      activeTurn: null,
      runStatus: "idle",
    };
    return renderHook(() => useRenderedMessages(input, displayContext));
  }

  it("carries a persisted assistant record's announcement onto its rendered row", () => {
    const announcement: BotAnnouncement = {
      kind: "automation",
      link: "https://example.com/a/1",
    };
    const { result } = renderRows([assistantRecord("m-a", announcement)]);

    const row = result.current.find(
      (candidate) => candidate.role === "assistant",
    );
    expect(row?.announcement).toEqual(announcement);
  });

  it("keeps an announcement made mid-turn when the turn's records merge into one row", () => {
    const announcement: BotAnnouncement = { kind: "policy", link: null };
    const inTurn = (
      record: Extract<Message, { role: "assistant" }>,
    ): Extract<Message, { role: "assistant" }> => ({
      ...record,
      turnId: "turn-1",
    });
    const { result } = renderRows([
      inTurn(assistantRecord("m-1", undefined)),
      inTurn(assistantRecord("m-2", announcement)),
      inTurn(assistantRecord("m-3", undefined)),
    ]);

    const rows = result.current.filter(
      (candidate) => candidate.role === "assistant",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].announcement).toEqual(announcement);
  });

  it("leaves the key absent on an assistant row that announces nothing", () => {
    const { result } = renderRows([assistantRecord("m-plain", undefined)]);

    const row = result.current.find(
      (candidate) => candidate.role === "assistant",
    );
    expect(row).toBeDefined();
    expect(row !== undefined && "announcement" in row).toBe(false);
  });

  it("carries a persisted assistant record's options onto its rendered row", () => {
    const { result } = renderRows([
      withOptions(assistantRecord("m-o", undefined), ["Ship it", "Hold"]),
    ]);

    const row = result.current.find(
      (candidate) => candidate.role === "assistant",
    );
    expect(row?.options).toEqual(["Ship it", "Hold"]);
  });

  it("keeps options offered mid-turn when the turn's records merge into one row", () => {
    const inTurn = (
      record: Extract<Message, { role: "assistant" }>,
    ): Extract<Message, { role: "assistant" }> => ({
      ...record,
      turnId: "turn-1",
    });
    const { result } = renderRows([
      inTurn(assistantRecord("m-1", undefined)),
      inTurn(withOptions(assistantRecord("m-2", undefined), ["Yes", "No"])),
      inTurn(assistantRecord("m-3", undefined)),
    ]);

    const rows = result.current.filter(
      (candidate) => candidate.role === "assistant",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].options).toEqual(["Yes", "No"]);
  });

  it("leaves the options key absent on an assistant row that offers none", () => {
    const { result } = renderRows([assistantRecord("m-plain", undefined)]);

    const row = result.current.find(
      (candidate) => candidate.role === "assistant",
    );
    expect(row).toBeDefined();
    expect(row !== undefined && "options" in row).toBe(false);
  });

  it("carries a persisted assistant record's repliesTo onto its rendered row", () => {
    const { result } = renderRows([
      { ...assistantRecord("m-r", undefined), repliesTo: "post-7" },
    ]);

    const row = result.current.find(
      (candidate) => candidate.role === "assistant",
    );
    expect(row?.repliesTo).toBe("post-7");
  });

  it("keeps the post a mid-turn record answers when the turn's records merge into one row", () => {
    const inTurn = (
      record: Extract<Message, { role: "assistant" }>,
    ): Extract<Message, { role: "assistant" }> => ({
      ...record,
      turnId: "turn-1",
    });
    const { result } = renderRows([
      inTurn(assistantRecord("m-1", undefined)),
      inTurn({ ...assistantRecord("m-2", undefined), repliesTo: "post-7" }),
      inTurn(assistantRecord("m-3", undefined)),
    ]);

    const rows = result.current.filter(
      (candidate) => candidate.role === "assistant",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].repliesTo).toBe("post-7");
  });

  it("leaves the repliesTo key absent on an assistant row that answers no post", () => {
    const { result } = renderRows([assistantRecord("m-plain", undefined)]);

    const row = result.current.find(
      (candidate) => candidate.role === "assistant",
    );
    expect(row).toBeDefined();
    expect(row !== undefined && "repliesTo" in row).toBe(false);
  });

  it("carries a user record's conversation request onto its rendered row", () => {
    const request: ConversationRequest = {
      requestId: "req-1",
      resolvedAt: 7_000,
      resolvedByMessageId: "reply-1",
    };
    const { result } = renderRows([userRecord("m-open", request)]);

    const row = result.current.find((candidate) => candidate.id === "m-open");
    expect(row?.role).toBe("user");
    expect(row?.conversationRequest).toEqual(request);
  });
});

describe("<ChatEmptyState /> in a bot channel", () => {
  function renderEmpty(presentation: ChatBotPresentation | null): void {
    render(
      <ChatBotPresentationContext.Provider value={presentation}>
        <ChatEmptyState />
      </ChatBotPresentationContext.Provider>,
    );
  }

  it("opens an empty channel with its name and no hash", () => {
    renderEmpty(channelPresentation(NO_THREAD_LINE, vi.fn()));

    const intro = screen.getByTestId("bot-channel-intro").textContent;
    expect(intro).toContain("Release Bot");
    expect(intro).not.toContain("#");

    expect(screen.queryByText("Start the conversation")).toBeNull();
  });

  it("says an empty thread has no reply yet", () => {
    renderEmpty({
      botTitle: "Release Bot",
      scrollToMessage: vi.fn(),
      replyFollowsPost: null,
      repliedPost: null,
      threadLine: null,
      openThread: null,
      openAnnouncementThread: null,
      chooseOption: null,
    });

    expect(screen.getByText("No replies yet.")).toBeTruthy();
    expect(screen.queryByTestId("bot-channel-intro")).toBeNull();
  });
});
