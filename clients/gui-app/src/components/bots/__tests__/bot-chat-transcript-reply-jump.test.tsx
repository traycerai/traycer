/**
 * "See reply" on a bot conversation's user row (Tracy Bots). The row names the
 * reply's MESSAGE id; the list scrolls by RENDERED ROW key, and an assistant
 * row is not keyed by its message id. These cases drive the REAL scroller in
 * `BotChatTranscript` against REAL projected rows (`useRenderedMessages` over a
 * session store's messages), with only the virtualised list replaced by a stub
 * that renders each projected row through the real `<ChatMessage>` and exposes
 * the scroll request it was handed.
 */
import { StrictMode, type ReactNode } from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ConversationRequest } from "@traycer/protocol/persistence/epic/messages";
import type {
  AgentSender,
  ContentBlock,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import type { ChatLocateRowArgs } from "@/hooks/chats/use-chat-locate-row";
import type {
  ChatSessionState,
  ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { emptyTranscriptWindow } from "@/stores/chats/transcript-window";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";

type ReplyJumpState = Pick<
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
>;

const mocks = vi.hoisted(() => ({
  handle: null as ChatSessionStoreHandle | null,
  locateRow: vi.fn<(args: ChatLocateRowArgs) => number | null>(),
  state: { locatedOrdinal: null as number | null },
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
vi.mock("@/hooks/chats/use-chat-locate-row", () => ({
  useChatLocateRow: (args: ChatLocateRowArgs) => {
    mocks.locateRow(args);
    return mocks.state.locatedOrdinal;
  },
}));
vi.mock("@/components/chat/chat-messages", async () => {
  const { ChatExpansionTestProviders } =
    await import("@/components/chat/__tests__/chat-expansion-test-providers");
  const { ChatMessage } = await import("@/components/chat/chat-message");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const noBackgroundToolBlockIds: ReadonlySet<string> = new Set();
  return {
    ChatMessages: (props: {
      messages: ReadonlyArray<ChatMessageModel>;
      instanceId: string;
      scrollRequest: { kind: string; messageId?: string } | null;
    }) => {
      const request = props.scrollRequest;
      return (
        <TooltipProvider>
          <ChatExpansionTestProviders tileInstanceId={props.instanceId}>
            <div
              data-testid="chat-messages-stub"
              data-scroll-kind={request === null ? "none" : request.kind}
              data-scroll-row-id={request?.messageId ?? ""}
            >
              {props.messages.map((message) => (
                <div
                  key={message.id}
                  data-testid="stub-row"
                  data-row-id={message.id}
                >
                  <ChatMessage
                    message={message}
                    actions={null}
                    backgroundToolBlockIds={noBackgroundToolBlockIds}
                    nextStepActions={null}
                  />
                </div>
              ))}
            </div>
          </ChatExpansionTestProviders>
        </TooltipProvider>
      );
    },
  };
});

import {
  BotChatTranscript,
  type BotTranscriptSurface,
} from "@/components/bots/bot-chat-transcript";
import {
  UNRESOLVED_BOT_MEMBERS,
  type BotMemberResolver,
} from "@/lib/bots/bot-member-names";
import { MemberAvatar } from "@/components/bots/bot-avatars";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CHAT_ID = "conversation-app";
const REPLY_ID = "reply-uuid";

const ASK: JsonContent = {
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

function resolvedUserMessage(): Extract<Message, { role: "user" }> {
  return {
    role: "user",
    messageId: "ask-1",
    sender: { type: "user", userId: "owner-1" },
    message: { kind: "user", content: ASK, browserAnnotations: [] },
    timestamp: 1_000,
    sessionAnchor: null,
    conversationRequest: {
      requestId: "req-1",
      resolvedAt: 1_000,
      resolvedByMessageId: REPLY_ID,
    },
  };
}

/** A message between a post and its reply, so the reply is not the next row. */
function otherUserMessage(): Extract<Message, { role: "user" }> {
  return {
    role: "user",
    messageId: "other-1",
    sender: { type: "user", userId: "owner-1" },
    message: { kind: "user", content: ASK, browserAnnotations: [] },
    timestamp: 1_500,
    sessionAnchor: null,
  };
}

function textBlock(blockId: string, text: string): ContentBlock {
  return {
    type: "text",
    blockId,
    status: "completed",
    timestamp: 2_000,
    text,
    providerNotice: null,
  };
}

function assistantMessage(input: {
  readonly messageId: string;
  readonly turnId: string | null;
  readonly timestamp: number;
  readonly text: string;
}): Extract<Message, { role: "assistant" }> {
  return {
    role: "assistant",
    messageId: input.messageId,
    sender: BOT_SENDER,
    blocks: [textBlock(`${input.messageId}:text`, input.text)],
    startedAt: input.timestamp,
    timestamp: input.timestamp,
    turnId: input.turnId,
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: [],
  };
}

function reply(): Extract<Message, { role: "assistant" }> {
  return assistantMessage({
    messageId: REPLY_ID,
    turnId: null,
    timestamp: 2_000,
    text: "Here is my review",
  });
}

let requestTranscriptOrdinal: Mock<(ordinal: number | null) => void>;
let store: UseBoundStore<StoreApi<ReplyJumpState>>;

function createReplyJumpStore(
  messages: ReadonlyArray<Message>,
): UseBoundStore<StoreApi<ReplyJumpState>> {
  return create<ReplyJumpState>()(() => ({
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
    requestTranscriptOrdinal,
  }));
}

const THREAD_SURFACE: BotTranscriptSurface = {
  kind: "thread",
  chooseOption: vi.fn(),
  failedRequest: () => null,
};

/** The member directory a mounted transcript reads; none by default. */
let members: BotMemberResolver = UNRESOLVED_BOT_MEMBERS;

function mountTranscript(
  messages: ReadonlyArray<Message>,
  surface: BotTranscriptSurface,
): {
  readonly rerender: () => void;
} {
  store = createReplyJumpStore(messages);
  mocks.handle = { store } as ChatSessionStoreHandle;
  const queryClient = new QueryClient();
  const tree = (): ReactNode => (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BotChatTranscript
          botId={BOT_ID}
          chatId={CHAT_ID}
          hostId="host-1"
          title="Release Bot"
          instanceId="bot-thread:test"
          surface={surface}
          resolveMember={members}
          showConnecting
        />
      </QueryClientProvider>
    </StrictMode>
  );
  const view = render(tree());
  return { rerender: () => view.rerender(tree()) };
}

function scrollStub(): HTMLElement {
  return screen.getByTestId("chat-messages-stub");
}

beforeEach(() => {
  vi.clearAllMocks();
  members = UNRESOLVED_BOT_MEMBERS;
  requestTranscriptOrdinal = vi.fn<(ordinal: number | null) => void>();
  mocks.state.locatedOrdinal = null;
});

afterEach(() => {
  cleanup();
  mocks.handle = null;
});

describe("<BotChatTranscript /> See reply", () => {
  it("scrolls to the projected reply ROW key, never the reply's message id", async () => {
    const user = userEvent.setup();
    mountTranscript(
      [resolvedUserMessage(), otherUserMessage(), reply()],
      THREAD_SURFACE,
    );
    expect(scrollStub().getAttribute("data-scroll-kind")).toBe("none");

    await user.click(screen.getByTestId("conversation-request-reply-link"));

    const rowId = scrollStub().getAttribute("data-scroll-row-id");
    expect(scrollStub().getAttribute("data-scroll-kind")).toBe("message");
    expect(rowId).not.toBeNull();
    expect(rowId).not.toBe(REPLY_ID);
    expect(rowId?.startsWith("assistant:")).toBe(true);
    expect(rowId).toBe("assistant:ts:2000");

    const replyRow = within(scrollStub())
      .getByText("Here is my review")
      .closest("[data-row-id]");
    expect(replyRow?.getAttribute("data-row-id")).toBe(rowId);

    expect(mocks.locateRow).toHaveBeenCalled();
    expect(
      mocks.locateRow.mock.calls.every(([args]) => args.target === null),
    ).toBe(true);
    expect(requestTranscriptOrdinal).not.toHaveBeenCalledWith(42);
  });

  it("scrolls to the folded row when the reply is one record of a multi-record turn", async () => {
    const user = userEvent.setup();
    const request = resolvedUserMessage();
    mountTranscript(
      [
        {
          ...request,
          conversationRequest: {
            requestId: "req-1",
            resolvedAt: 1_000,
            resolvedByMessageId: "reply-first",
          },
        },
        otherUserMessage(),
        assistantMessage({
          messageId: "reply-first",
          turnId: "turn-1",
          timestamp: 2_000,
          text: "First part",
        }),
        assistantMessage({
          messageId: "reply-last",
          turnId: "turn-1",
          timestamp: 2_100,
          text: "Second part",
        }),
      ],
      THREAD_SURFACE,
    );

    await user.click(screen.getByTestId("conversation-request-reply-link"));

    const rowId = scrollStub().getAttribute("data-scroll-row-id");
    expect(rowId).not.toBeNull();
    expect(rowId).not.toBe("reply-first");
    expect(rowId?.startsWith("assistant:")).toBe(true);
    const row = within(scrollStub())
      .getByText("First part")
      .closest("[data-row-id]");
    expect(row?.getAttribute("data-row-id")).toBe(rowId);
  });

  it("offers no See reply when the reply is the very next row", () => {
    mountTranscript([resolvedUserMessage(), reply()], THREAD_SURFACE);

    expect(within(scrollStub()).getByText("Here is my review")).toBeTruthy();
    expect(screen.queryByTestId("conversation-request-reply-link")).toBeNull();
  });

  it("holds an absent reply, locates it, requests its ordinal, then scrolls once its row appears", async () => {
    const user = userEvent.setup();
    const view = mountTranscript(
      [resolvedUserMessage(), otherUserMessage()],
      THREAD_SURFACE,
    );
    requestTranscriptOrdinal.mockClear();
    mocks.locateRow.mockClear();

    await user.click(screen.getByTestId("conversation-request-reply-link"));

    expect(scrollStub().getAttribute("data-scroll-kind")).toBe("none");
    expect(mocks.locateRow).toHaveBeenLastCalledWith(
      expect.objectContaining({
        epicId: BOT_ID,
        chatId: CHAT_ID,
        target: { kind: "message", messageId: REPLY_ID },
      }),
    );
    expect(requestTranscriptOrdinal).not.toHaveBeenCalledWith(42);

    mocks.state.locatedOrdinal = 42;
    act(() => view.rerender());
    expect(requestTranscriptOrdinal).toHaveBeenCalledWith(42);
    expect(scrollStub().getAttribute("data-scroll-kind")).toBe("none");

    act(() => {
      store.setState({
        messages: [resolvedUserMessage(), otherUserMessage(), reply()],
      });
    });

    expect(requestTranscriptOrdinal).toHaveBeenLastCalledWith(null);
    expect(scrollStub().getAttribute("data-scroll-kind")).toBe("message");
    expect(scrollStub().getAttribute("data-scroll-row-id")).toBe(
      "assistant:ts:2000",
    );
    expect(mocks.locateRow).toHaveBeenLastCalledWith(
      expect.objectContaining({ target: null }),
    );
  });
});

describe("<BotChatTranscript /> in the channel", () => {
  const QUESTION_ID = "question-1";

  function question(options: ReadonlyArray<string> | null): Message {
    const base: Extract<Message, { role: "assistant" }> = {
      ...assistantMessage({
        messageId: QUESTION_ID,
        turnId: null,
        timestamp: 2_000,
        text: "Which environment?",
      }),
      announcement: { kind: "question", link: null },
    };
    return options === null ? base : { ...base, options: [...options] };
  }

  function channelSurface(
    openAnnouncementThread: ((announcementId: string) => void) | null,
    chooseOption: ((choice: string) => void) | null,
  ): BotTranscriptSurface {
    return {
      kind: "channel",
      threadLine: () => null,
      openThread: null,
      openAnnouncementThread,
      chooseOption,
      failedRequest: () => null,
      intro: { botTitle: "Release Bot", directive: null },
    };
  }

  it("opens a question's thread from its hover action, by the record's message id", async () => {
    const user = userEvent.setup();
    const openAnnouncementThread = vi.fn<(announcementId: string) => void>();
    mountTranscript(
      [question(null)],
      channelSurface(openAnnouncementThread, null),
    );

    expect(screen.queryByTestId("bot-thread-line")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Reply in thread" }));

    expect(openAnnouncementThread).toHaveBeenCalledTimes(1);
    expect(openAnnouncementThread).toHaveBeenCalledWith(QUESTION_ID);
  });

  it("draws a question's options as buttons that cannot be clicked in the channel", () => {
    mountTranscript(
      [question(["Staging", "Production"])],
      channelSurface(vi.fn(), null),
    );

    const buttons = within(
      screen.getByTestId("bot-reply-options"),
    ).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Staging",
      "Production",
    ]);
    expect(buttons.every((button) => button.hasAttribute("disabled"))).toBe(
      true,
    );
  });
});

describe("<BotChatTranscript /> a bot that answers posts in the channel", () => {
  const POST_ID = "ask-1";

  const DIRECT_REQUEST: ConversationRequest = {
    requestId: "req-1",
    resolvedAt: 1_000,
    resolvedByMessageId: REPLY_ID,
    direct: true,
  };

  function directPost(
    request: ConversationRequest,
  ): Extract<Message, { role: "user" }> {
    return { ...resolvedUserMessage(), conversationRequest: request };
  }

  function directReply(
    options: ReadonlyArray<string> | null,
  ): Extract<Message, { role: "assistant" }> {
    const base: Extract<Message, { role: "assistant" }> = {
      ...reply(),
      repliesTo: POST_ID,
    };
    return options === null ? base : { ...base, options: [...options] };
  }

  function channel(
    chooseOption: ((choice: string) => void) | null,
  ): BotTranscriptSurface {
    return {
      kind: "channel",
      threadLine: () => null,
      openThread: vi.fn(),
      openAnnouncementThread: vi.fn(),
      chooseOption,
      failedRequest: () => null,
      intro: { botTitle: "Release Bot", directive: null },
    };
  }

  it("names the post a reply answers by its sender and first line, and lands the list on that post's row", async () => {
    const user = userEvent.setup();
    mountTranscript(
      [directPost(DIRECT_REQUEST), directReply(null)],
      channel(null),
    );

    const line = screen.getByTestId("bot-replied-post");
    expect(within(line).getByText("Please review")).toBeTruthy();
    const postRow = within(scrollStub())
      .getByTestId("bot-member-row")
      .closest("[data-row-id]");
    expect(postRow).not.toBeNull();
    expect(scrollStub().getAttribute("data-scroll-kind")).toBe("none");

    await user.click(line);

    expect(scrollStub().getAttribute("data-scroll-kind")).toBe("message");
    expect(scrollStub().getAttribute("data-scroll-row-id")).toBe(
      postRow?.getAttribute("data-row-id"),
    );
  });

  it("draws a member's post in the colour its sender's id hashes to, as every other picture of that member is", () => {
    // The directory names the member, so the row's name is not its id.
    members = (userId) =>
      userId === "owner-1"
        ? { displayName: "Olive Owner", avatarUrl: null }
        : null;
    mountTranscript([directPost(DIRECT_REQUEST)], channel(null));
    const rowSwatch = within(
      scrollStub().querySelector<HTMLElement>(
        '[data-testid="bot-member-row"]',
      ) ?? document.body,
    )
      .getByTestId("chat-sender-avatar")
      .querySelector<HTMLElement>('[data-slot="avatar-fallback"]')
      ?.style.getPropertyValue("--swatch");
    cleanup();

    // The thread line's stack and the thread's anchor draw the member by id.
    render(
      <MemberAvatar
        userId="owner-1"
        name="Someone"
        avatarUrl={null}
        size="lg"
      />,
    );
    const byId = screen
      .getByTestId("chat-sender-avatar")
      .querySelector<HTMLElement>('[data-slot="avatar-fallback"]')
      ?.style.getPropertyValue("--swatch");
    expect(rowSwatch).toBeTruthy();
    expect(rowSwatch).toBe(byId);
  });

  it("lands the list on the reply in the channel from a direct post's See reply", async () => {
    const user = userEvent.setup();
    mountTranscript(
      [directPost(DIRECT_REQUEST), otherUserMessage(), directReply(null)],
      channel(null),
    );

    await user.click(screen.getByTestId("conversation-request-reply-link"));

    expect(scrollStub().getAttribute("data-scroll-row-id")).toBe(
      "assistant:ts:2000",
    );
  });

  it("offers no See reply on a resolved post that is not direct, whose verdict is in its thread", () => {
    mountTranscript(
      [resolvedUserMessage(), otherUserMessage(), reply()],
      channel(vi.fn()),
    );

    expect(screen.queryByTestId("conversation-request")).toBeNull();
    expect(screen.queryByTestId("conversation-request-reply-link")).toBeNull();
  });

  it("posts the option a person clicks under a direct reply through the channel surface", async () => {
    const user = userEvent.setup();
    const chooseOption = vi.fn<(choice: string) => void>();
    mountTranscript(
      [directPost(DIRECT_REQUEST), directReply(["Staging", "Production"])],
      channel(chooseOption),
    );

    await user.click(screen.getByRole("button", { name: "Production" }));

    expect(chooseOption).toHaveBeenCalledTimes(1);
    expect(chooseOption).toHaveBeenCalledWith("Production");
  });

  it("names no replied post in a thread, whose rows answer within it", () => {
    mountTranscript(
      [directPost(DIRECT_REQUEST), directReply(null)],
      THREAD_SURFACE,
    );

    expect(screen.queryByTestId("bot-replied-post")).toBeNull();
  });
});
