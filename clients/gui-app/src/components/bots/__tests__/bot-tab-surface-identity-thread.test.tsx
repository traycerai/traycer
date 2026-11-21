/**
 * The Tracy surface and the signed-in account (T186), for a thread's box, a
 * task card's answer and a thread box's answer and quote across an account
 * switch. The tree, the host client and the per-case lifecycle are in
 * `bot-tab-surface-identity-harness.tsx`.
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
import { channelHandles } from "./bot-tab-surface-identity-state";
import {
  chatMessagesMock,
  chatSessionRegistryMock,
  composerProbeMock,
  landingImageStoreMock,
} from "./bot-tab-surface-identity-mocks";
import { emptyBotMentionHostListsMock } from "@/components/bots/__tests__/bot-mention-host-test-support";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type {
  BotInputNeeded,
  BotTaskEntry,
} from "@traycer/protocol/host/bot/schemas";
import type { BotSurfaceReference } from "@traycer/protocol/persistence/epic/messages";
import { useBotSurfaceActionsStore } from "@/stores/bots/bot-surface-actions-store";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import {
  editableIn,
  textOf,
} from "@/components/bots/__tests__/bot-box-test-support";
import {
  chatSessionWithThreadRows,
  postRow,
} from "@/components/bots/__tests__/bot-channel-rows-test-support";
import { botReply } from "@/components/bots/__tests__/bot-turn-test-support";
import { BOT, BOT_ID, snapshot, TAB_HOST } from "./bot-tab-surface-harness";
import { currentBotLifetime } from "@/lib/bots/bot-lifetime";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  activityStore,
  answerAct,
  CHANNEL,
  installIdentityCaseLifecycle,
  listedThreadOf,
  mountSurface,
  question,
  sent,
  setRefuseSends,
  signInAs,
} from "./bot-tab-surface-identity-harness";

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
vi.mock("@/components/bots/bot-message-composer", async (importOriginal) =>
  composerProbeMock(
    await importOriginal<
      typeof import("@/components/bots/bot-message-composer")
    >(),
  ),
);
vi.mock("@/lib/composer/landing-image-store", async (importOriginal) =>
  landingImageStoreMock(
    await importOriginal<typeof import("@/lib/composer/landing-image-store")>(),
  ),
);
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) =>
  chatSessionRegistryMock(
    await importOriginal<
      typeof import("@/lib/registries/chat-session-registry")
    >(),
  ),
);
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
vi.mock("@/hooks/bots/use-bot-activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/bots/use-bot-activity")>()),
  useBotActivity: () => activityStore((state) => state.activity),
}));
vi.mock("@/components/chat/chat-messages", () => chatMessagesMock());

installIdentityCaseLifecycle();

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

/** The post the thread cases open. */
const POST_ID = "post-1";

function openThread(): void {
  act(() =>
    useBotOpenThreadStore.getState().setRail(
      BOT_ID,
      {
        kind: "thread",
        anchorMessageId: POST_ID,
        announcement: false,
        anchorKind: null,
        sent: null,
      },
      currentBotLifetime(),
    ),
  );
}

describe("<BotTabSurface /> a thread's box across an account switch", () => {
  const THREAD_ID = "thread-1";
  const REPLY_REQUEST = "req-reply";

  it("shows account B an empty thread box, with no edit, when A's refused replacement was put back as an edit in the thread before the switch", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setRefuseSends(true);
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
      useBotOpenThreadStore.getState().setRail(
        BOT_ID,
        {
          kind: "thread",
          anchorMessageId: POST_ID,
          announcement: false,
          anchorKind: null,
          sent: null,
        },
        currentBotLifetime(),
      ),
    );
    mountSurface();
    const panel = await screen.findByTestId("bot-thread-panel");
    await user.click(await within(panel).findByTestId("bot-message-edit"));
    const box = (): HTMLElement =>
      editableIn(
        within(screen.getByTestId("bot-thread-panel")).getByTestId(
          "bot-thread-composer-input",
        ),
      );
    expect(textOf(box())).toBe("Thread failed text");
    expect(
      within(panel)
        .getByRole("group", { name: "Reply in the thread" })
        .contains(box()),
    ).toBe(true);
    await user.click(screen.getByTestId("bot-thread-composer-send"));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await vi.waitFor(() =>
      expect(screen.getByTestId("bot-thread-composer-editing")).toBeTruthy(),
    );

    signInAs(ACCOUNT_B);
    // The account change emptied the rail; B opens the same thread.
    openThread();

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
  const REPLY_REQUEST = "req-reply";

  const listedThread = (): BotThreadSummary =>
    listedThreadOf(THREAD_ID, POST_ID);

  function closeThread(): void {
    act(() =>
      useBotOpenThreadStore
        .getState()
        .setRail(BOT_ID, null, currentBotLifetime()),
    );
  }

  it("gives the moved answer back, once, in the thread box opened again after the person left it while it edited the failed reply", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setRefuseSends(true);
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
      expect(
        textOf(
          editableIn(within(panel).getByTestId("bot-thread-composer-input")),
        ),
      ).toBe("Thread failed text\n\nHold the migration"),
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
    expect(
      textOf(
        editableIn(within(reopened).getByTestId("bot-thread-composer-input")),
      ),
    ).toBe("Hold the migration");
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
    // The account change emptied the rail; B opens the same thread.
    openThread();
    mocks.state.threads = [listedThread()];
    view.redraw();

    const panel = await screen.findByTestId("bot-thread-panel");
    await vi.waitFor(() =>
      expect(
        textOf(
          editableIn(within(panel).getByTestId("bot-thread-composer-input")),
        ),
      ).toBe(""),
    );
  });
});
