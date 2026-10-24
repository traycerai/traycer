/**
 * A bot's thread panel (Tracy Bots, decisions 55, 56). The REAL panel, its
 * transcript (`useRenderedMessages` over a session store's records, each row
 * drawn by the real `<ChatMessage>`), its message box and the `bot.conversation
 * .send` mutation run over a host client whose messenger records the request
 * that leaves. Only the virtualised list is replaced by a stub, as in the
 * reply-jump suite. What is asserted is what the host RECEIVES: a first reply
 * under a question opens its thread, an option clicked in a thread is the
 * person's next message in it, and a thread hung off the bot's own row is
 * drawn as the bot's, with no request to show.
 */
import { StrictMode } from "react";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
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
import type {
  AgentSender,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
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
>;

const mocks = vi.hoisted(() => ({
  handle: null as ChatSessionStoreHandle | null,
  client: null as HostRequester<HostRpcRegistry> | null,
  toastFromHostError: vi.fn<(error: Error, fallback: string) => void>(),
}));

vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: mocks.toastFromHostError,
}));

vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useChatSessionHandleForContainer: () => mocks.handle,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.client,
}));
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessCatalogForClient: () => ({ harnesses: [] }),
}));
vi.mock("@/hooks/chats/use-chat-locate-row", () => ({
  useChatLocateRow: (_args: ChatLocateRowArgs) => null,
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
      text: "Ship the release today?",
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
  }));
}

const SEND_RESPONSE: BotConversationSendResponse = {
  messageId: "message-1",
  requestId: "request-1",
  delivery: "written",
  threadId: THREAD_ID,
};

let sent: ReadonlyArray<BotConversationSendRequest>;
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

function mountPanel(
  thread: BotThreadPanelThread,
  messages: ReadonlyArray<Message>,
): void {
  mocks.handle = {
    store: createThreadStore(messages),
  } as ChatSessionStoreHandle;
  render(
    <StrictMode>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <ChatExpansionTestProviders tileInstanceId="tile-1">
            <BotThreadPanel
              botId={BOT_ID}
              hostId={HOST_ID}
              botTitle="Release Bot"
              thread={thread}
              anchorSenderLabel={(senderUserId) =>
                senderUserId === null ? "You" : "Tess Teammate"
              }
              resolveMember={resolveMember}
              onClose={vi.fn()}
              onOpenUnderTheHood={vi.fn()}
            />
          </ChatExpansionTestProviders>
        </TooltipProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

function listed(anchorSenderUserId: string | null): BotThreadPanelThread {
  return { kind: "listed", thread: threadSummary(anchorSenderUserId) };
}

beforeEach(() => {
  sent = [];
  sendAnswer = () => Promise.resolve(SEND_RESPONSE);
  mocks.toastFromHostError.mockClear();
  mocks.client = hostClientRecordingSends();
});

afterEach(() => {
  cleanup();
  mocks.handle = null;
  mocks.client = null;
});

describe("<BotThreadPanel /> a question or proposal nobody has replied under", () => {
  it("sends the first reply with the announcement's id and no thread, and shows no transcript", async () => {
    const user = userEvent.setup();
    mountPanel(
      {
        kind: "unopened",
        conversationId: CONVERSATION_ID,
        announcementId: "question-1",
      },
      [],
    );

    expect(screen.getByTestId("bot-thread-unopened")).toBeTruthy();
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
      },
    ]);
  });
});

describe("<BotThreadPanel /> a listed thread", () => {
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

  it("tells the person when their pick could not be sent", async () => {
    const user = userEvent.setup();
    sendAnswer = () => Promise.reject(new Error("host refused the pick"));
    mountPanel(listed("user-teammate"), [botReply(["Ship it", "Hold"])]);

    await user.click(screen.getByRole("button", { name: "Hold" }));

    await waitFor(() => {
      expect(mocks.toastFromHostError).toHaveBeenCalledTimes(1);
    });
    const [error, fallback] = mocks.toastFromHostError.mock.calls[0];
    expect(error.message).toBe("host refused the pick");
    expect(fallback).toBe("Couldn't send your choice.");
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
      },
    ]);
  });
});

describe("<BotThreadPanel /> the anchor", () => {
  it("draws a member's post under their name with its request state", () => {
    mountPanel(listed("user-teammate"), []);

    const anchor = screen.getByTestId("bot-thread-anchor");
    expect(within(anchor).getByText("Tess Teammate")).toBeTruthy();
    expect(within(anchor).queryByText("APP")).toBeNull();
    expect(
      within(anchor)
        .getByTestId("conversation-request")
        .getAttribute("data-request-state"),
    ).toBe("open");
  });

  it("draws a bot's own announcement in the bot's frame, with no request badge", () => {
    mountPanel(listed(null), []);

    const anchor = screen.getByTestId("bot-thread-anchor");
    expect(within(anchor).getByText("Release Bot")).toBeTruthy();
    expect(within(anchor).getByText("APP")).toBeTruthy();
    expect(within(anchor).getByTestId("bot-avatar")).toBeTruthy();
    expect(within(anchor).getByText("Ship the release today?")).toBeTruthy();
    expect(within(anchor).queryByTestId("conversation-request")).toBeNull();
    expect(within(anchor).queryByText("Open")).toBeNull();
  });
});
