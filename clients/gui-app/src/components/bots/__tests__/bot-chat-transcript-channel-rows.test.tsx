/**
 * A bot channel's rows (Tracy Bots): a question's, a direct post's and its
 * reply's. These cases drive the REAL `BotChatTranscript` against REAL
 * projected rows (`useRenderedMessages` over a session store's messages),
 * with only the virtualised list replaced by a stub that renders each
 * projected row through the real `<ChatMessage>`.
 */
import { StrictMode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ConversationRequest } from "@traycer/protocol/persistence/epic/messages";
import type {
  AgentSender,
  ContentBlock,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
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
>;

const mocks = vi.hoisted(() => ({
  handle: null as ChatSessionStoreHandle | null,
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
// No turn receipts here: the transcript asks for none from a host this
// suite does not stand up.
vi.mock("@/hooks/bots/use-bot-turn-locate-query", () => ({
  useBotTurnLocateQuery: () => ({ data: undefined }),
}));
vi.mock("@/hooks/chats/use-chat-locate-row", () => ({
  useChatLocateRowAnswer: () => ({ status: "waiting" }),
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
    }) => {
      return (
        <TooltipProvider>
          <ChatExpansionTestProviders tileInstanceId={props.instanceId}>
            <div data-testid="chat-messages-stub">
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
import type { ChatBotThreadLine } from "@/components/chat/chat-bot-presentation-context";

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

function createTranscriptStore(
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
  }));
}

/** The member directory a mounted transcript reads; none by default. */
let members: BotMemberResolver = UNRESOLVED_BOT_MEMBERS;

function mountTranscript(
  messages: ReadonlyArray<Message>,
  surface: BotTranscriptSurface,
): void {
  const store = createTranscriptStore(messages);
  mocks.handle = { store } as ChatSessionStoreHandle;
  const queryClient = new QueryClient();
  render(
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
          header={null}
          landOn={null}
        />
      </QueryClientProvider>
    </StrictMode>,
  );
}

function scrollStub(): HTMLElement {
  return screen.getByTestId("chat-messages-stub");
}

beforeEach(() => {
  vi.clearAllMocks();
  members = UNRESOLVED_BOT_MEMBERS;
});

afterEach(() => {
  cleanup();
  mocks.handle = null;
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
      threadAnchorKinds: [],
      chooseOption,
      answerQuestion: null,
      discussQuestion: null,
      failedRequest: () => null,
      openTurn: null,
      sessionChatId: null,
      intro: { botTitle: "Release Bot", directive: null },
      history: null,
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
    expect(openAnnouncementThread).toHaveBeenCalledWith(QUESTION_ID, null);
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
    threadLine: (postMessageId: string) => ChatBotThreadLine | null,
  ): BotTranscriptSurface {
    return {
      kind: "channel",
      threadLine,
      openThread: vi.fn(),
      openAnnouncementThread: vi.fn(),
      threadAnchorKinds: [],
      chooseOption,
      answerQuestion: null,
      discussQuestion: null,
      failedRequest: () => null,
      openTurn: null,
      sessionChatId: null,
      intro: { botTitle: "Release Bot", directive: null },
      history: null,
    };
  }

  it("draws a direct reply as its own row, with nothing of the post it answers above it", () => {
    mountTranscript(
      [directPost(DIRECT_REQUEST), otherUserMessage(), directReply(null)],
      channel(null, () => null),
    );

    const replyRow = within(scrollStub()).getByTestId("bot-reply-row");
    expect(screen.queryByTestId("bot-replied-post")).toBeNull();
    expect(within(replyRow).queryByText(/Please review/)).toBeNull();
  });

  it("draws a member's post in the colour its sender's id hashes to, as every other picture of that member is", () => {
    // The directory names the member, so the row's name is not its id.
    members = (userId) =>
      userId === "owner-1"
        ? { displayName: "Olive Owner", avatarUrl: null }
        : null;
    mountTranscript(
      [directPost(DIRECT_REQUEST)],
      channel(null, () => null),
    );
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

  it("draws no link to a direct post's answer two rows below it, and keeps the post's thread line", () => {
    const line: ChatBotThreadLine = {
      participants: [],
      replyCount: 2,
      lastReplyAt: 3_000,
      unread: false,
      unreadCount: null,
      replying: false,
      followedUnwritten: false,
      newReplies: null,
    };
    mountTranscript(
      [directPost(DIRECT_REQUEST), otherUserMessage(), directReply(null)],
      channel(null, (postMessageId) =>
        postMessageId === POST_ID ? line : null,
      ),
    );

    expect(within(scrollStub()).getByTestId("bot-thread-line")).toBeTruthy();
    expect(within(scrollStub()).queryByText("See reply")).toBeNull();
    expect(within(scrollStub()).getByText("Here is my review")).toBeTruthy();
  });

  it("draws nothing of the request on a resolved post that is not direct, whose verdict is in its thread", () => {
    mountTranscript(
      [resolvedUserMessage(), otherUserMessage(), reply()],
      channel(vi.fn(), () => null),
    );

    expect(screen.queryByTestId("conversation-request")).toBeNull();
  });

  it("posts the option a person clicks under a direct reply through the channel surface", async () => {
    const user = userEvent.setup();
    const chooseOption = vi.fn<(choice: string) => void>();
    mountTranscript(
      [directPost(DIRECT_REQUEST), directReply(["Staging", "Production"])],
      channel(chooseOption, () => null),
    );

    await user.click(screen.getByRole("button", { name: "Production" }));

    expect(chooseOption).toHaveBeenCalledTimes(1);
    expect(chooseOption).toHaveBeenCalledWith("Production");
  });
});
