/**
 * A post the bot failed to answer (Tracy Bots T69), through the REAL
 * `BotChannelView`: its transcript rows, hover actions, message box and the
 * `bot.conversation.send` mutation run over a host client whose messenger
 * records the request that leaves. Only the virtualised list is replaced, as
 * in the thread-panel suite, and what the bot is doing is scripted through
 * the one `useBotActivity` the view reads. What is asserted is what the
 * person sees on the row and what the host RECEIVES: Retry re-delivers the
 * request as it is, Edit loads the text into the channel's box and the send
 * replaces the failed post.
 */
import { StrictMode } from "react";
import {
  act,
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
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  BotConversationSendRequest,
  BotThreadSummary,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { TooltipProvider } from "@/components/ui/tooltip";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import type {
  BotActivity,
  BotSessionActivity,
} from "@/hooks/bots/use-bot-activity";
import type {
  ChatSessionState,
  ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { emptyTranscriptWindow } from "@/stores/chats/transcript-window";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";

type ChannelTranscriptState = Pick<
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
  channelHandle: null as ChatSessionStoreHandle | null,
  client: null as HostRequester<HostRpcRegistry> | null,
  threads: [] as BotThreadSummary[],
}));

vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  // The channel reads its own session; a thread's session has no rows here.
  useChatSessionHandleForContainer: (
    _botId: string,
    chatId: string,
  ): ChatSessionStoreHandle | null =>
    chatId === CHANNEL_ID ? mocks.channelHandle : null,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.client,
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
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
    data: { threads: mocks.threads },
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
import type { BotOpenThread } from "@/stores/bots/bot-open-thread-store";
import type { BotMemberResolver } from "@/lib/bots/bot-member-names";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HOST_ID = "host-bound";
const CHANNEL_ID = "conversation-channel";
const THREAD_ID = "thread-1";
const POST_ID = "post-1";
const POST_REQUEST = "req-post";
const POST_TEXT = "Is CI green?";

const resolveMember: BotMemberResolver = (userId) =>
  userId === "user-teammate"
    ? { displayName: "Tess Teammate", avatarUrl: null }
    : null;

function textDoc(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

/** The member's post in the channel, its request open. */
function memberPost(): Message {
  return {
    role: "user",
    messageId: POST_ID,
    sender: { type: "user", userId: "user-teammate" },
    message: {
      kind: "user",
      content: textDoc(POST_TEXT),
      browserAnnotations: [],
    },
    timestamp: 1_000,
    sessionAnchor: null,
    conversationRequest: {
      requestId: POST_REQUEST,
      resolvedAt: null,
      resolvedByMessageId: null,
    },
  };
}

const POST_THREAD: BotThreadSummary = {
  threadId: THREAD_ID,
  conversationId: CHANNEL_ID,
  sessionChatId: "session-1",
  anchor: {
    messageId: POST_ID,
    requestId: POST_REQUEST,
    senderUserId: "user-teammate",
    sentAt: 1_000,
    resolvedAt: null,
  },
  replyCount: 1,
  lastReplyAt: 2_000,
  openRequestCount: 1,
  costUsd: null,
};

function failedOn(requestId: string): BotSessionActivity {
  return {
    state: "failed",
    startedAt: 1_000,
    step: null,
    requestId,
    reason: null,
  };
}

/** The bot's trunk failed answering `requestId`. */
function trunkFailedOn(requestId: string): BotActivity {
  return { trunk: failedOn(requestId), threads: {} };
}

function createChannelStore(
  messages: ReadonlyArray<Message>,
): UseBoundStore<StoreApi<ChannelTranscriptState>> {
  return create<ChannelTranscriptState>()(() => ({
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
const onOpenThread = vi.fn<(open: BotOpenThread | null) => void>();

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
        return Promise.resolve({
          messageId: "message-new",
          requestId: "req-new",
          delivery: "written",
          threadId: null,
        });
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

function mountChannel(openThread: BotOpenThread | null): void {
  mocks.channelHandle = {
    store: createChannelStore([memberPost()]),
  } as ChatSessionStoreHandle;
  render(
    <StrictMode>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <ChatExpansionTestProviders tileInstanceId="tile-1">
            <BotChannelView
              botId={BOT_ID}
              hostId={HOST_ID}
              botTitle="Release Bot"
              directive={null}
              appConversationChatId={CHANNEL_ID}
              resolveMember={resolveMember}
              openThread={openThread}
              onOpenThread={onOpenThread}
              onOpenUnderTheHood={vi.fn()}
              onOpenTrunkUnderTheHood={vi.fn()}
            />
          </ChatExpansionTestProviders>
        </TooltipProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

function channelBox(): HTMLTextAreaElement {
  const box = screen.getByRole("textbox", { name: "Message Release Bot" });
  if (!(box instanceof HTMLTextAreaElement)) throw new Error("not a textarea");
  return box;
}

beforeEach(() => {
  sent = [];
  onOpenThread.mockClear();
  mocks.threads = [];
  activityStore.setState({ activity: null });
  mocks.client = hostClientRecordingSends();
});

afterEach(() => {
  cleanup();
  mocks.channelHandle = null;
  mocks.client = null;
});

describe("<BotChannelView /> Retry on a post the bot failed to answer", () => {
  it("re-delivers the post as it is, as a channel post", async () => {
    const user = userEvent.setup();
    activityStore.setState({ activity: trunkFailedOn(POST_REQUEST) });
    mountChannel(null);

    await user.click(
      within(screen.getByTestId("bot-member-row")).getByTestId(
        "bot-message-retry",
      ),
    );

    expect(sent).toEqual([
      {
        botId: BOT_ID,
        conversationId: CHANNEL_ID,
        text: POST_TEXT,
        threadId: null,
        announcementId: null,
        redeliver: { requestId: POST_REQUEST },
        supersedes: null,
      },
    ]);
  });

  it("offers it, still as a channel post, when the thread the post opened is the session that failed", async () => {
    const user = userEvent.setup();
    mocks.threads = [POST_THREAD];
    activityStore.setState({
      activity: {
        trunk: null,
        threads: { [THREAD_ID]: failedOn(POST_REQUEST) },
      },
    });
    mountChannel(null);

    await user.click(
      within(screen.getByTestId("bot-member-row")).getByTestId(
        "bot-message-retry",
      ),
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].threadId).toBeNull();
    expect(sent[0].redeliver).toEqual({ requestId: POST_REQUEST });
  });

  it("is not offered while the session failed on a different request", () => {
    activityStore.setState({ activity: trunkFailedOn("req-other") });
    mountChannel(null);

    expect(screen.getByText(POST_TEXT)).toBeTruthy();
    expect(screen.queryByTestId("bot-message-retry")).toBeNull();
    expect(screen.queryByTestId("bot-message-edit")).toBeNull();
  });
});

describe("<BotChannelView /> Edit on a post the bot failed to answer", () => {
  it("loads its text into the channel's box, and the send replaces the failed post", async () => {
    const user = userEvent.setup();
    activityStore.setState({ activity: trunkFailedOn(POST_REQUEST) });
    mountChannel(null);
    const box = channelBox();
    expect(screen.queryByTestId("bot-channel-composer-editing")).toBeNull();

    await user.click(
      within(screen.getByTestId("bot-member-row")).getByTestId(
        "bot-message-edit",
      ),
    );

    expect(box.value).toBe(POST_TEXT);
    expect(
      screen.getByTestId("bot-channel-composer-editing").textContent,
    ).toContain("Sending replaces your message that failed.");

    await user.type(box, " Check nightly too.");
    await user.click(screen.getByTestId("bot-channel-composer-send"));

    expect(sent).toEqual([
      {
        botId: BOT_ID,
        conversationId: CHANNEL_ID,
        text: `${POST_TEXT} Check nightly too.`,
        threadId: null,
        announcementId: null,
        redeliver: null,
        supersedes: POST_REQUEST,
      },
    ]);
    await waitFor(() => {
      expect(screen.queryByTestId("bot-channel-composer-editing")).toBeNull();
    });
    expect(box.value).toBe("");
  });

  it("leaves the box empty and sends nothing when the person cancels", async () => {
    const user = userEvent.setup();
    activityStore.setState({ activity: trunkFailedOn(POST_REQUEST) });
    mountChannel(null);
    await user.click(
      within(screen.getByTestId("bot-member-row")).getByTestId(
        "bot-message-edit",
      ),
    );

    await user.click(screen.getByTestId("bot-channel-composer-edit-cancel"));

    expect(screen.queryByTestId("bot-channel-composer-editing")).toBeNull();
    expect(channelBox().value).toBe("");
    expect(sent).toEqual([]);
  });

  it("closes the open thread and edits there, in the channel's box, when the post is a thread's anchor", async () => {
    const user = userEvent.setup();
    mocks.threads = [POST_THREAD];
    activityStore.setState({
      activity: {
        trunk: null,
        threads: { [THREAD_ID]: failedOn(POST_REQUEST) },
      },
    });
    mountChannel({ anchorMessageId: POST_ID, announcement: false });

    await user.click(
      within(screen.getByTestId("bot-thread-anchor")).getByTestId(
        "bot-message-edit",
      ),
    );

    expect(onOpenThread).toHaveBeenCalledWith(null);
    expect(channelBox().value).toBe(POST_TEXT);
    expect(screen.getByTestId("bot-channel-composer-editing")).toBeTruthy();
  });
});

describe("<BotChannelView /> a post the bot has since moved on from", () => {
  it("loses Retry and Edit when the session's activity moves on", () => {
    activityStore.setState({ activity: trunkFailedOn(POST_REQUEST) });
    mountChannel(null);
    expect(screen.getByTestId("bot-message-retry")).toBeTruthy();
    expect(screen.getByTestId("bot-message-edit")).toBeTruthy();

    act(() => {
      activityStore.setState({
        activity: {
          trunk: {
            state: "replying",
            startedAt: 3_000,
            step: null,
            requestId: POST_REQUEST,
            reason: null,
          },
          threads: {},
        },
      });
    });

    expect(screen.queryByTestId("bot-message-retry")).toBeNull();
    expect(screen.queryByTestId("bot-message-edit")).toBeNull();
    expect(screen.getByText(POST_TEXT)).toBeTruthy();
  });
});
