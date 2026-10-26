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
  ): ChatSessionStoreHandle | null =>
    chatId === CONVERSATION_ID ? mocks.channelHandle : mocks.handle,
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

function mountPanel(
  thread: BotThreadPanelThread,
  messages: ReadonlyArray<Message>,
): RenderResult {
  mocks.handle = {
    store: createThreadStore(messages, () => () => undefined),
  } as ChatSessionStoreHandle;
  mocks.channelHandle = {
    store: createThreadStore(channelMessages, channelHold),
  } as ChatSessionStoreHandle;
  return render(
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
              onEditPost={onEditPost}
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
});

afterEach(() => {
  cleanup();
  mocks.handle = null;
  mocks.channelHandle = null;
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
        redeliver: null,
        supersedes: null,
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
    ).toBe("Couldn't send. Edit and try again.");
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

describe("<BotThreadPanel /> the anchor", () => {
  it("draws a member's post under their name, with no request badge whether it is open or resolved", () => {
    mountPanel(listed("user-teammate"), []);

    const anchor = screen.getByTestId("bot-thread-anchor");
    expect(within(anchor).getByText("Tess Teammate")).toBeTruthy();
    expect(within(anchor).queryByText("APP")).toBeNull();
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
    expect(within(anchor).getByText("APP")).toBeTruthy();
    expect(within(anchor).getByTestId("bot-avatar")).toBeTruthy();
    expect(within(anchor).getByText("Ship the release today?")).toBeTruthy();
    expect(within(anchor).queryByTestId("conversation-request")).toBeNull();
    expect(within(anchor).queryByText("Open")).toBeNull();
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

  /** A member's message in the thread (or the channel), its request open. */
  function memberMessage(
    messageId: string,
    requestId: string,
    text: string,
  ): Message {
    return {
      role: "user",
      messageId,
      sender: { type: "user", userId: "user-teammate" },
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

  /** The thread's own session failed answering `requestId`. */
  function threadFailedOn(requestId: string): BotActivity {
    return {
      trunk: null,
      threads: {
        [THREAD_ID]: {
          state: "failed",
          startedAt: 1_000,
          step: null,
          requestId,
          reason: null,
        },
      },
    };
  }

  function mountFailedReply(): void {
    activityStore.setState({ activity: threadFailedOn(REPLY_REQUEST) });
    mountPanel(listed("user-teammate"), [
      memberMessage("member-reply-1", REPLY_REQUEST, "Hold for now"),
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
    const row = screen.getByTestId("bot-member-row");
    expect(
      within(screen.getByTestId("bot-thread-anchor")).queryByTestId(
        "bot-message-retry",
      ),
    ).toBeNull();

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

    await user.click(
      within(screen.getByTestId("bot-member-row")).getByTestId(
        "bot-message-edit",
      ),
    );

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
    await user.click(
      within(screen.getByTestId("bot-member-row")).getByTestId(
        "bot-message-edit",
      ),
    );

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
      memberMessage("anchor-1", POST_REQUEST, "Ship the release today?"),
    ];
    activityStore.setState({ activity: threadFailedOn(POST_REQUEST) });
    mountPanel(listed("user-teammate"), []);
    const anchor = screen.getByTestId("bot-thread-anchor");

    await user.click(within(anchor).getByTestId("bot-message-edit"));

    expect(onEditPost).toHaveBeenCalledWith({
      requestId: POST_REQUEST,
      text: "Ship the release today?",
    });
    expect(screen.queryByTestId("bot-thread-composer-editing")).toBeNull();

    await user.click(within(anchor).getByTestId("bot-message-retry"));

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
    expect(screen.getByText("Hold for now")).toBeTruthy();
  });
});
