/**
 * A bot notification's opening settles only when the channel it opened shows
 * the exact message it named: the real owner (`openBotNotification`), its
 * landing carried through the staged store into the real `BotChannelView`
 * and transcript. Only the virtualised message list (which reports how a
 * scroll request ended), the chat session registry and the channel's
 * neighbouring reads are replaced. The opening's own result is what is
 * observed; no case supplies a completion of its own.
 */
import {
  botActivityMock,
  botConversationListQueryMock,
  botReadCursorMock,
  botThreadListQueryMock,
  chatLocateRowMock,
  chatMessagesStubMock,
  chatSessionRegistryMock,
  harnessCatalogMock,
  hostSupportsMethodMock,
  markEntityReadMock,
  notificationIndicatorsMock,
  paneVisibilityMock,
  resolvedThemeMock,
  setRead,
  tabHostClientMock,
  type ChannelMockState,
} from "@/components/bots/__tests__/bot-channel-mock-factories";
import {
  botMentionHostClientMock,
  emptyBotMentionHostListsMock,
} from "@/components/bots/__tests__/bot-mention-host-test-support";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOT_ID,
  CHANNEL_ID,
  HOST_ID as OPENING_HOST,
  botReply,
  hostClientLocating,
  scriptedSession,
} from "@/components/bots/__tests__/bot-turn-test-support";
import { MountedLandingChannel } from "@/components/bots/__tests__/bot-turn-channel-harness";
import { botMember } from "@/components/notifications/__tests__/notification-bot-members-test-support";
import { parseNotificationActivationPayload } from "@/lib/notifications/notification-activation-envelope";
import type { NotificationPayload } from "@/lib/notifications/payload";
import { activationPayloadFromPushData } from "../../../../../mobile/src/push-registration";
import { useNotificationActivation } from "@/hooks/notifications/use-notification-activation";
import {
  rowFromHostEntry,
  type MergedNotificationRow,
} from "@/stores/notifications/merged-notifications";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import { useBotTabLandingStore } from "@/stores/bots/bot-tab-landing-store";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";

const mocks = vi.hoisted((): ChannelMockState => ({
  client: null,
  sessions: {},
  read: { value: { cursors: {}, latest: {} }, listeners: new Set() },
  pane: { visible: true, listeners: new Set() },
  advances: [],
  threads: [],
  locate: { status: "waiting" },
  settleScroll: null,
}));

vi.mock(
  "@/hooks/host/use-host-client-for-host-id",
  () => botMentionHostClientMock,
);
vi.mock(
  "@/hooks/bots/use-environment-host-lists-query",
  () => emptyBotMentionHostListsMock,
);
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) =>
  chatSessionRegistryMock(mocks, await importOriginal()),
);
vi.mock("@/hooks/host/use-tab-host-client", () => tabHostClientMock(mocks));
vi.mock("@/hooks/host/use-host-supports-method", async (importOriginal) =>
  hostSupportsMethodMock(await importOriginal()),
);
vi.mock("@/components/epic-tabs/pane-visibility-context", () =>
  paneVisibilityMock(mocks),
);
vi.mock("@/hooks/bots/use-bot-conversation-list-query", () =>
  botConversationListQueryMock(CHANNEL_ID),
);
vi.mock("@/hooks/bots/use-bot-thread-list-query", () =>
  botThreadListQueryMock(mocks),
);
vi.mock("@/hooks/notifications/use-notification-indicators-query", () =>
  notificationIndicatorsMock(),
);
vi.mock(
  "@/hooks/notifications/use-notification-mark-entity-read-mutation",
  () => markEntityReadMock(),
);
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () =>
  harnessCatalogMock(),
);
vi.mock("@/hooks/chats/use-chat-locate-row", () => chatLocateRowMock(mocks));
vi.mock("@/providers/use-resolved-theme", () => resolvedThemeMock());
vi.mock("@/hooks/bots/use-bot-activity", async (importOriginal) =>
  botActivityMock(await importOriginal()),
);
vi.mock("@/hooks/bots/use-bot-read-cursor", async (importOriginal) =>
  botReadCursorMock(mocks, await importOriginal()),
);
vi.mock("@/components/chat/chat-messages", async () => {
  const { ChatExpansionTestProviders } =
    await import("@/components/chat/__tests__/chat-expansion-test-providers");
  const { use } = await import("react");
  const { ChatMessage } = await import("@/components/chat/chat-message");
  const { ChatTimelineHeaderContext } =
    await import("@/components/chat/chat-timeline-header-context");
  return chatMessagesStubMock(mocks, {
    Providers: ChatExpansionTestProviders,
    ChatMessage,
    TimelineHeader: () => use(ChatTimelineHeaderContext),
  });
});

/** Observers the transcript watches rows with: nothing is ever reported in view. */
class SilentObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const NAMED = "row-2";
const OTHER_ROW = "row-3";
const THREAD = "thread-1";
const ANCHOR = "post-7";
const THREAD_REPLY = "reply-2";

const navigateSpy = vi.hoisted(() =>
  vi.fn<(options: unknown) => Promise<void>>(),
);

const bindingState = vi.hoisted<{ current: object | null }>(() => ({
  current: null,
}));

vi.mock("@tanstack/react-router", async (importActual) => {
  const actual = await importActual<typeof import("@tanstack/react-router")>();
  return { ...actual, useNavigate: () => navigateSpy };
});
vi.mock("@/lib/host", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/host")>()),
  useHostBinding: () => bindingState.current,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

/** The channel's rows `row-1` to `row-3`, as its session holds them. */
function loadRows(): void {
  mocks.sessions = {
    [CHANNEL_ID]: scriptedSession(
      CHANNEL_ID,
      [1, 2, 3].map((index) =>
        botReply({
          messageId: `row-${String(index)}`,
          text: `update ${String(index)}`,
          timestamp: index * 1_000,
        }),
      ),
    ).handle,
  };
}

/** The thread beside the channel: its session holds replies `reply-1` to `reply-3`, and the channel lists it on its anchor. */
function loadThread(): void {
  mocks.sessions = {
    ...mocks.sessions,
    [THREAD]: scriptedSession(
      THREAD,
      [1, 2, 3].map((index) =>
        botReply({
          messageId: `reply-${String(index)}`,
          text: `thread update ${String(index)}`,
          timestamp: index * 1_000,
        }),
      ),
    ).handle,
  };
  mocks.threads = [threadSummary()];
  useBotOpenThreadStore.getState().setRail(BOT_ID, {
    kind: "thread",
    anchorMessageId: ANCHOR,
    announcement: false,
    anchorKind: null,
    sent: null,
  });
}

function threadSummary(): object {
  return {
    threadId: THREAD,
    conversationId: CHANNEL_ID,
    sessionChatId: `session-${THREAD}`,
    anchor: {
      messageId: ANCHOR,
      requestId: "req-7",
      senderUserId: "user-other",
      sentAt: 1_000,
      resolvedAt: null,
      excerpt: null,
    },
    replyCount: 3,
    lastReplyAt: 3_000,
    openRequestCount: 0,
    costUsd: null,
  };
}

/** The host the opening asks: the bot's main channel is the one the rows are in. */
function bindOpeningHost(): void {
  const answer = (method: string): Promise<unknown> => {
    if (method === "bot.read")
      return Promise.resolve({
        bot: {
          botId: BOT_ID,
          title: "Release Bot",
          appConversationChatId: CHANNEL_ID,
          trunkChatId: "trunk-chat",
          archivedAt: null,
        },
      });
    if (method === "bot.thread.list")
      return Promise.resolve({
        threads: [threadSummary()],
        trunkCostUsd: null,
        threadAnchors: null,
        nextCursor: null,
        total: 1,
      });
    return Promise.resolve({});
  };
  const hostClient = {
    getActiveHostId: () => OPENING_HOST,
    createRequesterForHostId: () => hostClient,
    request: answer,
    requestWithSignal: answer,
    requestWithSignalRequiringHostMethodVersion: answer,
  };
  bindingState.current = {
    hostClient,
    directory: {
      list: () => Promise.resolve([]),
      findById: () => null,
      refresh: () => Promise.resolve([]),
      refreshForEra: () => Promise.resolve([]),
      invalidateInFlightRefresh: () => undefined,
    },
  };
}

function wrapper(props: { readonly children: ReactNode }): ReactNode {
  return createElement(
    QueryClientProvider,
    { client: new QueryClient() },
    props.children,
  );
}

function postRow(
  messageId: string,
  threadId: string | null,
): MergedNotificationRow {
  return rowFromHostEntry(
    botMember(messageId, 100, "A message", {
      event: threadId === null ? "post" : "reply",
      severity: threadId === null ? "info" : "done",
      conversationId: CHANNEL_ID,
      threadId,
      messageId,
    }),
  );
}

/**
 * The reader activates the notification of `NAMED` and the opening navigates:
 * the landing it staged, with the token that is its own, is what the channel is
 * handed. Resolves once the opening has navigated.
 */
async function activateMessage(
  messageId: string,
  threadId: string | null,
  onResult: (outcome: "success" | "failure") => void,
): Promise<{ readonly notificationToken: string | undefined }> {
  const row = postRow(messageId, threadId);
  if (row.payload === null) throw new Error("the bot row carried no payload");
  return activatePayload(row.payload, row.feedId, onResult);
}

/** The opening of `payload` by the reader: resolves once it has navigated, with the token it staged. */
async function activatePayload(
  payload: NotificationPayload,
  feedId: string,
  onResult: (outcome: "success" | "failure") => void,
): Promise<{ readonly notificationToken: string | undefined }> {
  let staged: { readonly notificationToken?: string } | undefined;
  navigateSpy.mockImplementation(() => {
    staged = useBotTabLandingStore.getState().byBotId[BOT_ID];
    return Promise.resolve();
  });
  const hook = renderHook(() => useNotificationActivation(), { wrapper });
  act(() => {
    hook.result.current.activate({
      payload,
      receivedAt: 2_000,
      feedId,
      originHostId: null,
      onResult,
    });
  });
  await waitFor(() => {
    expect(navigateSpy).toHaveBeenCalledTimes(1);
  });
  return { notificationToken: staged?.notificationToken };
}

/**
 * The channel as it shows `landOn`. Where the landing is the opening's own, its
 * message list is ready to report how the scroll request ended; where it is
 * not, the transcript refuses to issue one, so nothing is waited for.
 */
async function mountChannelOn(
  landing: {
    readonly messageId: string;
    readonly threadId: string | null;
    readonly notificationToken: string | undefined;
  },
  issuesScroll: boolean,
): Promise<void> {
  render(
    <MountedLandingChannel
      landOn={{
        messageId: landing.messageId,
        sendPostId: null,
        visit: 1,
        threadId: landing.threadId,
        notificationToken: landing.notificationToken,
      }}
    />,
  );
  await screen.findAllByTestId("chat-messages-stub");
  if (issuesScroll) {
    await waitFor(() => {
      expect(mocks.settleScroll).not.toBeNull();
    });
  } else {
    expect(mocks.settleScroll).toBeNull();
  }
}

function settleScroll(outcome: "landed" | "exhausted" | "cancelled"): void {
  const settle = mocks.settleScroll;
  if (settle === null) throw new Error("no scroll request is showing");
  act(() => {
    settle(outcome);
  });
}

beforeEach(() => {
  __resetTabNavigationControllerForTesting();
  useTracySurfaceStore.setState(useTracySurfaceStore.getInitialState(), true);
  useSelectionAuthorityStore.setState({ effectiveHostId: OPENING_HOST });
  useBotTabLandingStore.setState({ byBotId: {} });
  useBotOpenThreadStore.setState({ byBotId: {} });
  useAuthStore
    .getState()
    .setSignedIn(
      { userId: "user-a", userName: "A", email: "a@example.com" },
      { userId: "user-a", username: "A" },
      [],
    );
  navigateSpy.mockReset();
  mocks.advances = [];
  mocks.pane.visible = true;
  mocks.client = hostClientLocating(() => ({ turns: [] }), []);
  // The person is behind in the channel, as a notification finds them.
  setRead(mocks, {
    cursors: { [CHANNEL_ID]: { messageId: "row-1", seq: 1_000 } },
    latest: { [CHANNEL_ID]: { messageId: "row-3", seq: 3_000 } },
  });
  vi.stubGlobal("ResizeObserver", SilentObserver);
  vi.stubGlobal("IntersectionObserver", SilentObserver);
  loadRows();
  bindOpeningHost();
});

afterEach(() => {
  cleanup();
  useAuthStore.getState().setSignedOut();
  vi.unstubAllGlobals();
  mocks.sessions = {};
  mocks.client = null;
  mocks.settleScroll = null;
  mocks.locate = { status: "waiting" };
  bindingState.current = null;
});

describe("a bot notification's opening", () => {
  it("is not acknowledged by routing, and is once the channel shows the exact message it named", async () => {
    const onResult = vi.fn();
    const landing = await activateMessage(NAMED, null, onResult);
    await mountChannelOn(
      {
        messageId: NAMED,
        threadId: null,
        notificationToken: landing.notificationToken,
      },
      true,
    );

    expect(onResult).not.toHaveBeenCalled();
    settleScroll("landed");

    expect(onResult.mock.calls).toEqual([["success"]]);
  });

  it("is acknowledged once the channel shows the exact message a mobile push of the channel named, by the mapping, the envelope and the opening", async () => {
    const parsed = parseNotificationActivationPayload(
      activationPayloadFromPushData({
        entryId: "entry-1",
        epicId: BOT_ID,
        chatId: CHANNEL_ID,
        botId: BOT_ID,
        messageId: NAMED,
      }),
    );
    if (parsed.kind !== "v1") throw new Error("the push is not an envelope");
    const onResult = vi.fn();
    const landing = await activatePayload(
      parsed.envelope.route,
      "cloud:entry-1",
      onResult,
    );
    await mountChannelOn(
      {
        messageId: NAMED,
        threadId: null,
        notificationToken: landing.notificationToken,
      },
      true,
    );

    expect(onResult).not.toHaveBeenCalled();
    settleScroll("landed");

    expect(onResult.mock.calls).toEqual([["success"]]);
  });

  it.each(["exhausted", "cancelled"] as const)(
    "ends as a failure, never an acknowledgment, when the message it named was %s",
    async (outcome) => {
      const onResult = vi.fn();
      const landing = await activateMessage(NAMED, null, onResult);
      await mountChannelOn(
        {
          messageId: NAMED,
          threadId: null,
          notificationToken: landing.notificationToken,
        },
        true,
      );

      settleScroll(outcome);

      expect(onResult.mock.calls).toEqual([["failure"]]);
    },
  );

  it("is not acknowledged by a search or a permalink that lands on the same message and settles its own request", async () => {
    const onResult = vi.fn();
    await activateMessage(NAMED, null, onResult);
    await mountChannelOn(
      {
        messageId: NAMED,
        threadId: null,
        notificationToken: undefined,
      },
      true,
    );

    settleScroll("landed");

    expect(onResult.mock.calls).not.toContainEqual(["success"]);
  });

  it("is not acknowledged when the channel lands another message under its token", async () => {
    const onResult = vi.fn();
    const landing = await activateMessage(NAMED, null, onResult);
    await mountChannelOn(
      {
        messageId: OTHER_ROW,
        threadId: null,
        notificationToken: landing.notificationToken,
      },
      false,
    );

    expect(onResult.mock.calls).not.toContainEqual(["success"]);
  });

  it("is not acknowledged when the channel lands the message under a token that is not its own", async () => {
    const onResult = vi.fn();
    await activateMessage(NAMED, null, onResult);
    await mountChannelOn(
      {
        messageId: NAMED,
        threadId: null,
        notificationToken: "another-opening",
      },
      false,
    );

    expect(onResult.mock.calls).not.toContainEqual(["success"]);
  });

  it("ends as a failure when the host says the message it named is not in the channel", async () => {
    mocks.locate = { status: "missing" };
    const onResult = vi.fn();
    const landing = await activateMessage("row-absent", null, onResult);
    await mountChannelOn(
      {
        messageId: "row-absent",
        threadId: null,
        notificationToken: landing.notificationToken,
      },
      false,
    );

    await waitFor(() => {
      expect(onResult.mock.calls).toEqual([["failure"]]);
    });
  });

  it("ends as a failure when the reader presses the unread banner, and the scroll that was showing no longer acknowledges it", async () => {
    const onResult = vi.fn();
    const landing = await activateMessage(NAMED, null, onResult);
    await mountChannelOn(
      {
        messageId: NAMED,
        threadId: null,
        notificationToken: landing.notificationToken,
      },
      true,
    );
    const settle = mocks.settleScroll;
    expect(onResult).not.toHaveBeenCalled();

    fireEvent.click(
      within(screen.getByTestId("bot-unread-banner")).getByRole("button", {
        name: /Unread messages/,
      }),
    );

    expect(onResult.mock.calls).toEqual([["failure"]]);
    act(() => {
      settle?.("landed");
    });
    expect(onResult.mock.calls).toEqual([["failure"]]);
  });

  describe("in a thread beside the channel", () => {
    beforeEach(() => {
      loadThread();
    });

    it("is acknowledged once the thread shows the exact reply it named, not by routing", async () => {
      const onResult = vi.fn();
      const landing = await activateMessage(THREAD_REPLY, THREAD, onResult);
      await mountChannelOn(
        {
          messageId: THREAD_REPLY,
          threadId: THREAD,
          notificationToken: landing.notificationToken,
        },
        true,
      );

      expect(onResult).not.toHaveBeenCalled();
      settleScroll("landed");

      expect(onResult.mock.calls).toEqual([["success"]]);
    });

    it.each(["exhausted", "cancelled"] as const)(
      "ends as a failure when the reply it named was %s",
      async (outcome) => {
        const onResult = vi.fn();
        const landing = await activateMessage(THREAD_REPLY, THREAD, onResult);
        await mountChannelOn(
          {
            messageId: THREAD_REPLY,
            threadId: THREAD,
            notificationToken: landing.notificationToken,
          },
          true,
        );

        settleScroll(outcome);

        expect(onResult.mock.calls).toEqual([["failure"]]);
      },
    );

    it("is not acknowledged when another reply is landed under its token", async () => {
      const onResult = vi.fn();
      const landing = await activateMessage(THREAD_REPLY, THREAD, onResult);
      await mountChannelOn(
        {
          messageId: "reply-3",
          threadId: THREAD,
          notificationToken: landing.notificationToken,
        },
        false,
      );

      expect(onResult.mock.calls).not.toContainEqual(["success"]);
    });

    it("is not acknowledged when the thread landed on is not the one it named", async () => {
      const onResult = vi.fn();
      const landing = await activateMessage(THREAD_REPLY, THREAD, onResult);
      await mountChannelOn(
        {
          messageId: THREAD_REPLY,
          threadId: "thread-elsewhere",
          notificationToken: landing.notificationToken,
        },
        false,
      );

      expect(onResult.mock.calls).not.toContainEqual(["success"]);
    });
  });
});
