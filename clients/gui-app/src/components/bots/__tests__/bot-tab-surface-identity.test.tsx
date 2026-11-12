/**
 * The Tracy surface and the signed-in account (T186): the REAL `BotTabSurface`
 * with its REAL channel view, box, question cards and send mutation, under
 * `BotDraftsPersistLifecycleBridge`, over a host client that records and
 * answers `bot.conversation.send`. An account switch goes through the auth
 * store. What is asserted is what the next account sees in its channel, and
 * what the drafts store and the mutation cache keep of the last one.
 */
import {
  botListChangedMock,
  botListQueryMock,
  botMemoryMock,
  botSubscriptionMock,
  botThreadListQueryMock,
  connectableHostIdsMock,
  environmentListMock,
  environmentMembersMock,
  hostDirectoryListMock,
  hostEnvironmentBindingsMock,
  cloudEpicTasksMock,
  epicTaskContextsMock,
  hostClientForHostIdMock,
  hostQueriesMock,
  hostSupportsMethodMock,
  mocks,
  notificationHostMock,
  tabHostProviderMock,
  tabNavigationMock,
} from "./bot-tab-surface-mocks";
import { emptyBotMentionHostListsMock } from "@/components/bots/__tests__/bot-mention-host-test-support";
import { StrictMode, type ReactNode } from "react";
import {
  QueryClient,
  QueryClientProvider,
  type Mutation,
} from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { create } from "zustand";
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
  BotInputNeeded,
  BotTaskEntry,
} from "@traycer/protocol/host/bot/schemas";
import type { BotSurfaceActResponse } from "@traycer/protocol/host/bot/surface-schemas";
import type { BotSurfaceReference } from "@traycer/protocol/persistence/epic/messages";
import { useBotSurfaceActionsStore } from "@/stores/bots/bot-surface-actions-store";
import { botQuestionsText } from "@traycer/protocol/persistence/epic/messages";
import type {
  BotQuestionItem,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { botBoxDraftsKey } from "@/lib/persist/keys";
import { installLegendListTestClock } from "@/components/chat/__tests__/legend-list-test-environment";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { BotTestRunnerHost } from "@/components/bots/__tests__/bot-test-runner-host";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BotDraftsPersistLifecycleBridge } from "@/providers/bot-drafts-persist-lifecycle-bridge";
import { BotTabSurface } from "@/components/bots/bot-tab-surface";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  answerDraftKey,
  useBotDraftsStore,
} from "@/stores/bots/bot-drafts-store";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import type {
  BotActivity,
  BotSessionActivity,
} from "@/hooks/bots/use-bot-activity";
import {
  boxInput,
  boxWithin,
  textOf,
  typeInto,
} from "@/components/bots/__tests__/bot-box-test-support";
import { botMutationKeys } from "@/lib/query-keys/bot-mutation-keys";
import {
  chatSessionWithThreadRows,
  postRow,
} from "@/components/bots/__tests__/bot-channel-rows-test-support";
import { botReply } from "@/components/bots/__tests__/bot-turn-test-support";
import {
  negotiateBotSend,
  resetBotFailedRequestSupport,
} from "@/components/bots/__tests__/bot-failed-request-test-support";
import {
  BOT,
  BOT_ID,
  endBotTabSurfaceCase,
  resetBotTabSurfaceMocks,
  snapshot,
  TAB_HOST,
} from "./bot-tab-surface-harness";

const channelHandles = vi.hoisted(() => ({
  handles: new Map<string, unknown>(),
  client: null as HostRequester<HostRpcRegistry> | null,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => mocks.navigate,
  useRouter: () => ({
    history: { subscribe: () => () => undefined, canGoBack: () => false },
  }),
}));
vi.mock("@/lib/tab-navigation", async (importOriginal) =>
  tabNavigationMock(
    await importOriginal<typeof import("@/lib/tab-navigation")>(),
  ),
);
vi.mock(
  "@/hooks/epic/use-epic-get-task-contexts-query",
  () => epicTaskContextsMock,
);
vi.mock("@/hooks/epics/use-cloud-epic-tasks-query", async (importOriginal) =>
  cloudEpicTasksMock(
    await importOriginal<
      typeof import("@/hooks/epics/use-cloud-epic-tasks-query")
    >(),
  ),
);
vi.mock("@/hooks/host/use-host-supports-method", () => hostSupportsMethodMock);
vi.mock(
  "@/hooks/notifications/use-notification-host",
  () => notificationHostMock,
);
vi.mock(
  "@/hooks/host/use-host-client-for-host-id",
  () => hostClientForHostIdMock,
);
vi.mock("@/hooks/host/use-host-queries", () => hostQueriesMock);
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => mocks.binding,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-defaults", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/sandboxes/use-sandbox-defaults")
  >()),
  useSandboxDefaults: (environmentIds: readonly string[]) =>
    new Map(environmentIds.map((id) => [id, mocks.sandboxDefaults])),
}));
vi.mock(
  "@/hooks/bots/use-host-environment-bindings-query",
  () => hostEnvironmentBindingsMock,
);
vi.mock(
  "@/hooks/bots/use-environment-members-query",
  () => environmentMembersMock,
);
vi.mock(
  "@/components/epic-canvas/tab-host-provider",
  () => tabHostProviderMock,
);
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => channelHandles.client,
}));
vi.mock(
  "@/components/epic-tabs/pane-visibility-context",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/epic-tabs/pane-visibility-context")
    >()),
    usePaneVisible: () => mocks.state.paneVisible,
    usePaneFocused: () => true,
    usePaneFocusProbe: () => () => true,
  }),
);
vi.mock("@/hooks/bots/use-bot-memory", () => botMemoryMock);
vi.mock("@/hooks/bots/use-bot-subscription", () => botSubscriptionMock);
vi.mock("@/hooks/host/use-connectable-host-ids", () => connectableHostIdsMock);
vi.mock(
  "@/hooks/host/use-host-directory-list-query",
  () => hostDirectoryListMock,
);
vi.mock("@/hooks/bots/use-bot-list-query", () => botListQueryMock);
vi.mock(
  "@/hooks/bots/use-bot-list-changed-subscription",
  () => botListChangedMock,
);
vi.mock("@/hooks/bots/use-environment-list-query", () => environmentListMock);
// The channel sends through the real mutation; only the surface's own `bot.open` is scripted.
vi.mock("@/hooks/bots/use-bot-mutations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/bots/use-bot-mutations")>()),
  useBotOpenMutation: () => mocks.openMutation,
}));
vi.mock("@/hooks/bots/use-bot-thread-list-query", () => botThreadListQueryMock);
vi.mock(
  "@/hooks/bots/use-environment-host-lists-query",
  () => emptyBotMentionHostListsMock,
);
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));
vi.mock("@/components/bots/bot-channel-sidebar", () => ({
  BotChannelSidebar: () => null,
}));
vi.mock("@/components/bots/bot-session-view", () => ({
  BotSessionView: () => null,
}));
vi.mock("@/components/bots/bot-activity-page", () => ({
  BotActivityPage: () => null,
}));
vi.mock("@/components/bots/bot-threads-view", () => ({
  BotThreadsView: () => null,
}));
vi.mock("@/components/bots/bot-settings-panel", () => ({
  BotChannelSettingsPanel: () => null,
}));
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useChatSessionHandleForContainer: (
    _botId: string,
    chatId: string,
  ): ChatSessionStoreHandle | null => {
    const handle = channelHandles.handles.get(chatId);
    return handle === undefined ? null : (handle as ChatSessionStoreHandle);
  },
}));
vi.mock("@/hooks/bots/use-bot-conversation-list-query", () => ({
  useBotConversationListQuery: () => ({
    data: { conversations: [{ conversationId: "conversation-app" }] },
    isError: false,
    refetch: vi.fn(),
  }),
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
  useChatLocateRowAnswer: () => ({ status: "waiting" }),
}));
const activityStore = create<{ activity: BotActivity | null }>()(() => ({
  activity: null,
}));
vi.mock("@/hooks/bots/use-bot-activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/bots/use-bot-activity")>()),
  useBotActivity: () => activityStore((state) => state.activity),
}));
vi.mock("@/components/chat/chat-messages", async () => {
  const { ChatExpansionTestProviders: Providers } =
    await import("@/components/chat/__tests__/chat-expansion-test-providers");
  const { use } = await import("react");
  const { ChatMessage } = await import("@/components/chat/chat-message");
  const { ChatTimelineHeaderContext } =
    await import("@/components/chat/chat-timeline-header-context");
  const { QuoteSinkContext } =
    await import("@/components/chat/quote/quote-sink-context");
  const noBackgroundToolBlockIds: ReadonlySet<string> = new Set();
  /** Stands for the selection's Quote action, which hands the transcript's quote sink a snapshot. */
  function QuoteProbe(props: { readonly chatId: string }) {
    const sink = use(QuoteSinkContext);
    return (
      <button
        type="button"
        data-testid="stub-quote"
        onClick={() => {
          const root = document.createElement("div");
          const range = document.createRange();
          range.selectNodeContents(root);
          sink?.(props.chatId, {
            text: "A's quoted line",
            fenceLanguage: null,
            range,
            root,
          });
        }}
      />
    );
  }
  return {
    ChatMessages: (props: {
      messages: ReadonlyArray<ChatMessageModel>;
      instanceId: string;
    }) => (
      <Providers tileInstanceId={props.instanceId}>
        <div data-testid="chat-messages-stub">
          <QuoteProbe chatId={props.instanceId} />
          {use(ChatTimelineHeaderContext)}
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

const CHANNEL = "conversation-app";
const ACCOUNT_A = "user-1";
const ACCOUNT_B = "user-2";
const FAILED_POST = "post-failed";
const QUESTION_ID = "bot-question:req-q";
const HOLD = "Anything to hold back from the train?";

let queryClient = new QueryClient();
let sent: ReadonlyArray<BotConversationSendRequest>;
/** While set, the host refuses every send. */
let refuseSends: boolean;
/** While set, the host holds every send until `refuseHeldSend` refuses it. */
let holdSends: boolean;
/** Refuses the send the host holds. */
let refuseHeldSend: (() => void) | null;
/** While set, the host holds every card action, answering it when `answerAct` is called. */
let answerAct: ((response: BotSurfaceActResponse) => void) | null;

function hostClient(): HostRequester<HostRpcRegistry> {
  let seq = 0;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => `request-${String(++seq)}`,
    handlers: {
      "bot.surface.act": () =>
        new Promise<BotSurfaceActResponse>((resolve) => {
          answerAct = resolve;
        }),
      "bot.conversation.send": (params) => {
        sent = [...sent, params];
        if (refuseSends) return Promise.reject(new Error("the host refused"));
        if (holdSends) {
          return new Promise<BotConversationSendResponse>((_, reject) => {
            refuseHeldSend = () => reject(new Error("the host refused"));
          });
        }
        const response: BotConversationSendResponse = {
          messageId: "message-new",
          requestId: "req-new",
          delivery: "written",
          threadId: null,
        };
        return Promise.resolve(response);
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

function question(settled: boolean): Message {
  const questions: BotQuestionItem[] = [
    {
      text: HOLD,
      options: [],
      allowFreeText: true,
      settlement: settled
        ? {
            answer: "Nothing",
            skipped: false,
            by: { kind: "person", userId: "user-teammate" },
            at: 3_000,
          }
        : null,
    },
  ];
  return {
    ...botReply({
      messageId: QUESTION_ID,
      text: botQuestionsText(questions),
      timestamp: 2_000,
    }),
    question: { requestId: "req-q", questions },
  };
}

const FAILED_ON_POST: BotSessionActivity = {
  state: "failed",
  startedAt: 1_500,
  step: null,
  requestId: FAILED_POST,
  reason: null,
};

/** The channel's session: the viewer's failed post and an open question. */
function channelRows(settled: boolean): ReadonlyArray<Message> {
  return [postRow(FAILED_POST, "Failed text"), question(settled)];
}

/** The viewer's reply in a thread, written under `requestId`, which its session failed to answer. */
function failedReply(requestId: string): Message {
  const base = postRow("reply-1", "Thread failed text");
  if (base.role !== "user") throw new Error("a post is the viewer's row");
  return {
    ...base,
    conversationRequest: {
      requestId,
      resolvedAt: null,
      resolvedByMessageId: null,
    },
  };
}

function signInAs(userId: string): void {
  act(() => {
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId,
        userName: userId,
        email: `${userId}@example.com`,
        avatarUrl: null,
      },
      contextMetadata: { userId, username: userId },
    });
  });
}

function signOut(): void {
  act(() => {
    useAuthStore.setState({
      status: "signed-out",
      profile: null,
      contextMetadata: null,
    });
  });
}

function surfaceTree(): ReactNode {
  return (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BotDraftsPersistLifecycleBridge>
          <BotTestRunnerHost>
            <TooltipProvider>
              <ChatExpansionTestProviders tileInstanceId="tile-1">
                <BotTabSurface botId={BOT_ID} hostId={TAB_HOST} />
              </ChatExpansionTestProviders>
            </TooltipProvider>
          </BotTestRunnerHost>
        </BotDraftsPersistLifecycleBridge>
      </QueryClientProvider>
    </StrictMode>
  );
}

/** Mounts the surface; the result draws it again, as a hook's new answer would. */
function mountSurface(): { readonly redraw: () => void } {
  const view = render(surfaceTree());
  return { redraw: () => view.rerender(surfaceTree()) };
}

function channelBox(): HTMLElement {
  return boxInput("Message Release Bot");
}

beforeEach(() => {
  installLegendListTestClock();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  resetBotTabSurfaceMocks();
  // The bot runs on the tab's host: the card's answers are taken here.
  mocks.state.snapshot = {
    ...snapshot(),
    bot: { ...BOT, boundHostId: TAB_HOST },
  };
  // The host takes a card's answers and a set of them.
  mocks.state.onboardingVersion = { major: 1, minor: 5 };
  sent = [];
  refuseSends = false;
  holdSends = false;
  refuseHeldSend = null;
  answerAct = null;
  useBotSurfaceActionsStore.setState({ entries: {} });
  channelHandles.handles.clear();
  activityStore.setState({ activity: null });
  localStorage.clear();
  useBotDraftsStore.setState({
    answers: {},
    threadBoxes: {},
    unsentBoxes: {},
    boxCarries: {},
    boxNotices: {},
  });
  channelHandles.client = hostClient();
  negotiateBotSend(TAB_HOST, { major: 1, minor: 2 });
  signInAs(ACCOUNT_A);
});

afterEach(async () => {
  endBotTabSurfaceCase(queryClient);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  resetBotFailedRequestSupport();
  channelHandles.handles.clear();
  localStorage.clear();
});

/**
 * A's channel box editing a failed post, an answer moved in below it by a
 * teammate's settlement, and the replacement refused: the document is back
 * as the edit.
 */
async function refusedEditWithMovedAnswer(): Promise<void> {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  refuseSends = true;
  activityStore.setState({
    activity: { trunk: FAILED_ON_POST, threads: {} },
  });
  const handle = chatSessionWithThreadRows(channelRows(false));
  channelHandles.handles.set(CHANNEL, handle);
  mountSurface();
  await user.click(await screen.findByTestId("bot-message-edit"));
  expect(textOf(channelBox())).toBe("Failed text");
  await user.type(
    within(screen.getByTestId("question-card")).getByRole("textbox", {
      name: "Your answer",
    }),
    "Hold the migration",
  );
  act(() => handle.store.setState({ messages: channelRows(true) }));
  await vi.waitFor(() =>
    expect(textOf(channelBox())).toBe(`Failed text\n\nHold the migration`),
  );
  await user.click(screen.getByTestId("bot-channel-composer-send"));
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  await vi.waitFor(() =>
    expect(screen.getByTestId("bot-channel-composer-editing")).toBeTruthy(),
  );
}

describe("<BotTabSurface /> the channel's state across an account switch", () => {
  it("shows account B an empty box, with no edit and none of A's answer, when A's refused replacement was put back as an edit before the switch", async () => {
    await refusedEditWithMovedAnswer();

    signInAs(ACCOUNT_B);

    await vi.waitFor(() => expect(textOf(channelBox())).toBe(""));
    expect(screen.queryByTestId("bot-channel-composer-editing")).toBeNull();
    const state = useBotDraftsStore.getState();
    expect(JSON.stringify(state)).not.toContain("Hold the migration");
    expect(JSON.stringify(state)).not.toContain("Failed text");
    expect(
      localStorage.getItem(botBoxDraftsKey(ACCOUNT_B)) ?? "",
    ).not.toContain("Hold the migration");
    void answerDraftKey;
  });

  it("gives the answer back to the channel's box, once, when the person cancels the edit a refused replacement resumed", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await refusedEditWithMovedAnswer();

    await user.click(screen.getByTestId("bot-channel-composer-edit-cancel"));

    expect(textOf(channelBox())).toBe("Hold the migration");
  });

  it("gives A the newer draft followed by the failed message, with the moved answer once, when A signs out and signs in again after the send that carried the answer failed beside a newer draft", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    holdSends = true;
    const handle = chatSessionWithThreadRows([question(false)]);
    channelHandles.handles.set(CHANNEL, handle);
    mountSurface();
    await user.type(
      within(await screen.findByTestId("question-card")).getByRole("textbox", {
        name: "Your answer",
      }),
      "Hold the migration",
    );
    act(() => handle.store.setState({ messages: [question(true)] }));
    await vi.waitFor(() =>
      expect(textOf(channelBox())).toBe("Hold the migration"),
    );
    await user.click(screen.getByTestId("bot-channel-composer-send"));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    typeInto(channelBox(), "Newer draft");
    act(() => refuseHeldSend?.());
    await vi.waitFor(() =>
      expect(
        screen.getByTestId("bot-channel-composer-send-failed"),
      ).toBeTruthy(),
    );

    signOut();
    signInAs(ACCOUNT_A);

    await vi.waitFor(() =>
      expect(textOf(channelBox())).toBe("Newer draft\n\nHold the migration"),
    );
  });
});

describe("<BotTabSurface /> what the channel's parents hold of a send, across an account switch", () => {
  it("shows account B no couldn't-send line under its box when A's send failed before the switch", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    refuseSends = true;
    channelHandles.handles.set(
      CHANNEL,
      chatSessionWithThreadRows([postRow("post-1", "An earlier post")]),
    );
    mountSurface();
    await screen.findByTestId("bot-channel-composer-input");
    typeInto(channelBox(), "Hello from A");
    await user.click(screen.getByTestId("bot-channel-composer-send"));
    await vi.waitFor(() =>
      expect(
        screen.getByTestId("bot-channel-composer-send-failed"),
      ).toBeTruthy(),
    );

    signInAs(ACCOUNT_B);

    await vi.waitFor(() => expect(textOf(channelBox())).toBe(""));
    expect(screen.queryByTestId("bot-channel-composer-send-failed")).toBeNull();
  });

  it("clears A's settled sends from the mutation cache at the switch, and keeps a send still out", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const sends = (): Mutation[] =>
      queryClient
        .getMutationCache()
        .findAll({ mutationKey: botMutationKeys.conversationSend() });
    channelHandles.handles.set(
      CHANNEL,
      chatSessionWithThreadRows([postRow("post-1", "An earlier post")]),
    );
    mountSurface();
    await screen.findByTestId("bot-channel-composer-input");
    refuseSends = true;
    typeInto(channelBox(), "First");
    await user.click(screen.getByTestId("bot-channel-composer-send"));
    await vi.waitFor(() =>
      expect(sends().some((send) => send.state.status === "error")).toBe(true),
    );
    refuseSends = false;
    holdSends = true;
    await vi.waitFor(() => expect(textOf(channelBox())).toBe("First"));
    await user.click(screen.getByTestId("bot-channel-composer-send"));
    await vi.waitFor(() =>
      expect(sends().some((send) => send.state.status === "pending")).toBe(
        true,
      ),
    );

    signInAs(ACCOUNT_B);

    await vi.waitFor(() =>
      expect(sends().filter((send) => send.state.status !== "pending")).toEqual(
        [],
      ),
    );
    expect(
      sends().filter((send) => send.state.status === "pending"),
    ).toHaveLength(1);
  });
});

describe("<BotTabSurface /> a thread's box across an account switch", () => {
  const THREAD_ID = "thread-1";
  const POST_ID = "post-1";
  const REPLY_REQUEST = "req-reply";

  it("shows account B an empty thread box, with no edit, when A's refused replacement was put back as an edit in the thread before the switch", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    refuseSends = true;
    mocks.state.threads = [
      {
        threadId: THREAD_ID,
        conversationId: CHANNEL,
        sessionChatId: "session-1",
        anchor: {
          messageId: POST_ID,
          requestId: "req-post",
          senderUserId: ACCOUNT_A,
          sentAt: 1_000,
          resolvedAt: null,
          excerpt: null,
        },
        replyCount: 1,
        lastReplyAt: 2_000,
        openRequestCount: 1,
        costUsd: null,
      },
    ];
    activityStore.setState({
      activity: {
        trunk: null,
        threads: {
          [THREAD_ID]: {
            state: "failed",
            startedAt: 3_000,
            step: null,
            requestId: REPLY_REQUEST,
            reason: null,
          },
        },
      },
    });
    channelHandles.handles.set(
      CHANNEL,
      chatSessionWithThreadRows([postRow(POST_ID, "Ship it?")]),
    );
    const reply = failedReply(REPLY_REQUEST);
    channelHandles.handles.set(THREAD_ID, chatSessionWithThreadRows([reply]));
    act(() =>
      useBotOpenThreadStore.getState().setRail(BOT_ID, {
        kind: "thread",
        anchorMessageId: POST_ID,
        announcement: false,
        anchorKind: null,
        sent: null,
      }),
    );
    mountSurface();
    const panel = await screen.findByTestId("bot-thread-panel");
    await user.click(await within(panel).findByTestId("bot-message-edit"));
    const box = (): HTMLElement =>
      boxWithin(screen.getByTestId("bot-thread-panel"), "Reply in the thread");
    expect(textOf(box())).toBe("Thread failed text");
    await user.click(screen.getByTestId("bot-thread-composer-send"));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await vi.waitFor(() =>
      expect(screen.getByTestId("bot-thread-composer-editing")).toBeTruthy(),
    );

    signInAs(ACCOUNT_B);

    await vi.waitFor(() => expect(textOf(box())).toBe(""));
    expect(screen.queryByTestId("bot-thread-composer-editing")).toBeNull();
  });
});

describe("<BotTabSurface /> a task card's answer across an account switch", () => {
  const TASK_ID = "task-deploy";
  const SURFACE_POST = "bot-reply:surface";
  const QUESTION_SURFACE: BotSurfaceReference = {
    kind: "question",
    epicId: TASK_ID,
    hostId: "host-task",
    chatId: "chat-agent",
    blockId: "block-interview",
    resolution: null,
  };
  const OPEN_QUESTION: BotInputNeeded = {
    hostId: "host-task",
    hostName: "Studio Mac",
    agentChatId: "chat-agent",
    surfaceId: "block-interview",
    surface: {
      kind: "question",
      blockId: "block-interview",
      questions: [
        {
          questionId: "q-branch",
          text: "Which branch should I deploy?",
          options: ["main", "release"],
          allowsFreeText: true,
        },
      ],
      askedAt: 900,
    },
    reportedAt: 1_000,
    acceptsActions: true,
  };
  const TASK: BotTaskEntry = {
    taskId: TASK_ID,
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
    createdByChatId: null,
    inputNeeded: [OPEN_QUESTION],
    pause: null,
    stop: null,
    runRequest: null,
  };

  it("shows account B's card no answer of A's, now or when A's action is answered after the switch", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocks.state.snapshot = {
      ...snapshot(),
      bot: { ...BOT, boundHostId: TAB_HOST },
      tasks: [TASK],
      surfaceActions: [],
    };
    channelHandles.handles.set(
      CHANNEL,
      chatSessionWithThreadRows([
        {
          ...botReply({
            messageId: SURFACE_POST,
            text: "The deploy agent needs your call on the branch.",
            timestamp: 2_000,
          }),
          surface: QUESTION_SURFACE,
        },
      ]),
    );
    mountSurface();
    const card = await screen.findByTestId("bot-surface-card");
    await user.click(within(card).getByRole("button", { name: "release" }));
    await user.click(within(card).getByRole("button", { name: "Submit" }));
    await vi.waitFor(() =>
      expect(
        screen.getByTestId("bot-surface-card").getAttribute("data-state"),
      ).not.toBe("open"),
    );
    const stateWhileOut = screen
      .getByTestId("bot-surface-card")
      .getAttribute("data-state");

    signInAs(ACCOUNT_B);

    await vi.waitFor(() =>
      expect(
        screen.getByTestId("bot-surface-card").getAttribute("data-state"),
      ).not.toBe(stateWhileOut),
    );
    expect(useBotSurfaceActionsStore.getState().entries).toEqual({});

    act(() => answerAct?.({ outcome: "settled", code: null }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(useBotSurfaceActionsStore.getState().entries).toEqual({});
  });
});

describe("<BotTabSurface /> a thread box's answer and quote, through the real thread panel", () => {
  const THREAD_ID = "thread-1";
  const POST_ID = "post-1";
  const REPLY_REQUEST = "req-reply";

  function listedThread(): BotThreadSummary {
    return {
      threadId: THREAD_ID,
      conversationId: CHANNEL,
      sessionChatId: "session-1",
      anchor: {
        messageId: POST_ID,
        requestId: "req-post",
        senderUserId: ACCOUNT_A,
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

  function openThread(): void {
    act(() =>
      useBotOpenThreadStore.getState().setRail(BOT_ID, {
        kind: "thread",
        anchorMessageId: POST_ID,
        announcement: false,
        anchorKind: null,
        sent: null,
      }),
    );
  }

  function closeThread(): void {
    act(() => useBotOpenThreadStore.getState().setRail(BOT_ID, null));
  }

  it("gives the moved answer back, once, in the thread box opened again after the person left it while it edited the failed reply", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    refuseSends = true;
    mocks.state.threads = [listedThread()];
    activityStore.setState({
      activity: {
        trunk: null,
        threads: {
          [THREAD_ID]: {
            state: "failed",
            startedAt: 3_000,
            step: null,
            requestId: REPLY_REQUEST,
            reason: null,
          },
        },
      },
    });
    channelHandles.handles.set(
      CHANNEL,
      chatSessionWithThreadRows([postRow(POST_ID, "Ship it?")]),
    );
    const reply = failedReply(REPLY_REQUEST);
    const thread = chatSessionWithThreadRows([question(false), reply]);
    channelHandles.handles.set(THREAD_ID, thread);
    openThread();
    mountSurface();
    const panel = await screen.findByTestId("bot-thread-panel");
    await user.click(await within(panel).findByTestId("bot-message-edit"));
    await user.type(
      within(within(panel).getByTestId("question-card")).getByRole("textbox", {
        name: "Your answer",
      }),
      "Hold the migration",
    );
    act(() => thread.store.setState({ messages: [question(true), reply] }));
    await vi.waitFor(() =>
      expect(textOf(boxWithin(panel, "Reply in the thread"))).toBe(
        "Thread failed text\n\nHold the migration",
      ),
    );
    await user.click(screen.getByTestId("bot-thread-composer-send"));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await vi.waitFor(() =>
      expect(screen.getByTestId("bot-thread-composer-editing")).toBeTruthy(),
    );

    closeThread();
    expect(screen.queryByTestId("bot-thread-panel")).toBeNull();
    openThread();

    const reopened = await screen.findByTestId("bot-thread-panel");
    expect(textOf(boxWithin(reopened, "Reply in the thread"))).toBe(
      "Hold the migration",
    );
  });

  it("shows account B's thread box no quote of A's when A quoted while the open thread was still being read and B's box was drawn after the switch", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocks.state.threads = [];
    channelHandles.handles.set(
      CHANNEL,
      chatSessionWithThreadRows([postRow(POST_ID, "Ship it?")]),
    );
    channelHandles.handles.set(
      THREAD_ID,
      chatSessionWithThreadRows([postRow("reply-1", "A reply")]),
    );
    openThread();
    const view = mountSurface();
    await screen.findByTestId("bot-thread-panel");
    expect(screen.queryByTestId("bot-thread-composer-input")).toBeNull();
    await user.click(screen.getAllByTestId("stub-quote")[0]);

    signInAs(ACCOUNT_B);
    mocks.state.threads = [listedThread()];
    view.redraw();

    const panel = await screen.findByTestId("bot-thread-panel");
    await vi.waitFor(() =>
      expect(textOf(boxWithin(panel, "Reply in the thread"))).toBe(""),
    );
  });
});
