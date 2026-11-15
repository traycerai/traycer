/**
 * Which rows a bot's channel and thread keep when a read fails after it
 * loaded, through the REAL `BotChannelView`, its transcript rows and thread
 * panel, over the app's own query client and a fake host that answers each
 * read from a script. Rows the person lost access to (a lasting refusal), or
 * that another account fetched, are never drawn again by a later recoverable
 * failure; the box of a thread waits under a cloud drop or a silent host while
 * its other controls stay; and on a narrow pane the channel's line is outside
 * the section the rail hides.
 */
import {
  doorbellHostDirectoryEntryMock,
  doorbellStreamAuthRevalidatorMock,
  doorbellStreamClientForMock,
  resetDoorbellHosts,
} from "@/providers/__tests__/cloud-recovery-doorbell-test-support";
import {
  botMentionHostClientMock,
  emptyBotMentionHostListsMock,
} from "@/components/bots/__tests__/bot-mention-host-test-support";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import { resetHostConnectionRegistryForTest } from "@traycer-clients/shared/host-client/host-connection-registry";
import type {
  BotQuestionItem,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import {
  CHANNEL_ID,
  POST_FIRST_LINE,
  POST_ID,
  POST_REQUEST,
  THREAD_ID,
  THREAD_OPEN,
  THREAD_REPLY_ID,
  THREAD_SESSION_ID,
  botReply,
  memberPost,
  scriptedSession,
} from "@/components/bots/__tests__/bot-turn-test-support";
import {
  CHANNEL_LIST,
  TAB_HOST_ID,
  appClientWithoutRetries,
  freshScript,
  hostClientAnswering,
  type HostScript,
} from "@/components/bots/__tests__/bot-channel-cloud-test-support";
import {
  refetchRead,
  renderRealChannel,
} from "@/components/bots/__tests__/bot-channel-cloud-harness";
import {
  negotiateBotSend,
  resetBotFailedRequestSupport,
  signInViewer,
  VIEWER_USER_ID,
} from "@/components/bots/__tests__/bot-failed-request-test-support";
import {
  typeInto,
  boxWithin,
} from "@/components/bots/__tests__/bot-box-test-support";
import type { BotActivity } from "@/hooks/bots/use-bot-activity";
import {
  hostFailure,
  transportFailure,
} from "@/lib/host/test-support/cloud-failure-reads";
import type { HostRpcRegistry } from "@/lib/host";
import type { MobileTileCount } from "@/lib/layout/mobile-layout-form";
import { hostQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import type { BotOpenThread } from "@/stores/bots/bot-open-thread-store";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";

const mocks = vi.hoisted(() => ({
  client: null as HostRequester<HostRpcRegistry> | null,
  sessions: {} as Record<string, ChatSessionStoreHandle>,
  activity: null as BotActivity | null,
}));

vi.mock(
  "@/hooks/host/use-host-client-for-host-id",
  () => botMentionHostClientMock,
);
vi.mock(
  "@/hooks/bots/use-environment-host-lists-query",
  () => emptyBotMentionHostListsMock,
);
vi.mock(
  "@/hooks/host/use-host-directory-entry",
  () => doorbellHostDirectoryEntryMock,
);
vi.mock(
  "@/lib/host/stream-auth-revalidator",
  () => doorbellStreamAuthRevalidatorMock,
);
vi.mock(
  "@/hooks/host/use-host-stream-client-for",
  () => doorbellStreamClientForMock,
);
vi.mock("@/hooks/agent/use-host-reachability", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/agent/use-host-reachability")
  >()),
  useHostReachability: () => ({
    status: "reachable",
    hostLabel: "the host",
    unavailability: null,
    basis: "directory",
    hostKind: "remote",
  }),
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => VIEWER_USER_ID,
}));
// Signing in is the auth layer's; the sign-in button only needs a mutation to press.
vi.mock("@/hooks/auth/use-auth-sign-in-mutation", () => ({
  useAuthSignInMutation: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useChatSessionHandleForContainer: (
    _botId: string,
    chatId: string,
  ): ChatSessionStoreHandle | null =>
    Object.hasOwn(mocks.sessions, chatId) ? mocks.sessions[chatId] : null,
  useExistingChatSessionHandle: (
    _epicId: string,
    chatId: string,
  ): ChatSessionStoreHandle | null =>
    Object.hasOwn(mocks.sessions, chatId) ? mocks.sessions[chatId] : null,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.client,
}));
vi.mock("@/hooks/host/use-host-supports-method", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-supports-method")
  >()),
  useHostMethodSupport: () => true,
}));
vi.mock("@/components/epic-tabs/pane-visibility-context", () => ({
  usePaneVisible: () => true,
  usePaneFocused: () => true,
  usePaneFocusProbe: () => () => true,
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
  useChatLocateRowAnswer: () => ({ status: "waiting" }),
}));
vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({ resolvedTheme: "light", themePreset: "neutral" }),
}));
vi.mock("@/hooks/bots/use-bot-activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/bots/use-bot-activity")>()),
  useBotActivity: () => mocks.activity,
}));
vi.mock("@/components/chat/chat-messages", async () => {
  const { ChatExpansionTestProviders: Providers } =
    await import("@/components/chat/__tests__/chat-expansion-test-providers");
  const { use } = await import("react");
  const { ChatMessage } = await import("@/components/chat/chat-message");
  const { ChatTimelineHeaderContext } =
    await import("@/components/chat/chat-timeline-header-context");
  const noBackgroundToolBlockIds: ReadonlySet<string> = new Set();
  return {
    ChatMessages: (props: {
      messages: ReadonlyArray<ChatMessageModel>;
      instanceId: string;
    }) => (
      <Providers tileInstanceId={props.instanceId}>
        <div data-testid="chat-messages-stub">
          {use(ChatTimelineHeaderContext)}
          {props.messages.map((message) => (
            <div key={message.id} data-row-id={message.persistentMessageId}>
              <ChatMessage
                message={message}
                actions={null}
                backgroundToolBlockIds={noBackgroundToolBlockIds}
                nextStepActions={null}
              />
            </div>
          ))}
        </div>
      </Providers>
    ),
  };
});

const CHANNEL_READ = "bot.conversation.list";
const THREAD_READ = "bot.thread.list";
const CURSOR_READ = "bot.readCursor.read";
const REPLY_TEXT = "Which way should I go?";
const THREAD_BOX = "Reply in the thread";

type Failure = (method: string) => Error;

/** The three failures a read recovers from, by what the person is told. */
const RECOVERABLE = [
  {
    name: "a server error",
    kind: "server",
    error: (method: string): Error => hostFailure("RPC_ERROR", method),
  },
  {
    name: "a cloud drop",
    kind: "reconnecting",
    error: (method: string): Error =>
      hostFailure("E_CLOUD_UNREACHABLE", method),
  },
  {
    name: "a silent host",
    kind: "host-not-answering",
    error: (method: string): Error => transportFailure(method),
  },
] as const satisfies ReadonlyArray<{
  readonly name: string;
  readonly kind: string;
  readonly error: Failure;
}>;

const REFUSED =
  (code: "FORBIDDEN" | "UNAUTHORIZED" | "E_HOST_UNSUPPORTED") =>
  (method: string): Error =>
    hostFailure(code, method);

let script: HostScript;
let queryClient: QueryClient;

function mount(args: {
  readonly openThread: BotOpenThread | null;
  readonly tiles: MobileTileCount | null;
}): void {
  queryClient = appClientWithoutRetries();
  mocks.client = hostClientAnswering(script, queryClient);
  renderRealChannel({ queryClient, ...args, extra: null });
}

function signInAs(userId: string): void {
  useAuthStore.setState({ contextMetadata: { userId, username: userId } });
}

function questionItem(
  text: string,
  options: ReadonlyArray<string>,
  allowFreeText: boolean,
): BotQuestionItem {
  return { text, options: [...options], allowFreeText, settlement: null };
}

beforeEach(() => {
  script = freshScript();
  mocks.activity = null;
  mocks.sessions = {
    [CHANNEL_ID]: scriptedSession(CHANNEL_ID, [
      memberPost({
        messageId: POST_ID,
        requestId: POST_REQUEST,
        lines: [POST_FIRST_LINE],
        timestamp: 1_000,
        resolvedBy: null,
      }),
    ]).handle,
  };
  const thread = scriptedSession(THREAD_ID, [
    botReply({
      messageId: THREAD_REPLY_ID,
      text: REPLY_TEXT,
      timestamp: 2_000,
    }),
  ]).handle;
  mocks.sessions[THREAD_ID] = thread;
  mocks.sessions[THREAD_SESSION_ID] = thread;
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

afterEach(() => {
  useBotDraftsStore.setState({ answers: {}, threadBoxes: {} });
  cleanup();
  queryClient.clear();
  resetHostConnectionRegistryForTest();
  resetDoorbellHosts();
  resetBotFailedRequestSupport();
  useAuthStore.setState({ contextMetadata: null });
  mocks.client = null;
  mocks.sessions = {};
  vi.restoreAllMocks();
});

describe("<BotChannelView /> rows after a refusal, then a failure that recovers", () => {
  it.each([
    ...RECOVERABLE.map((then) => ({
      first: "FORBIDDEN" as const,
      refusal: REFUSED("FORBIDDEN"),
      then,
    })),
    {
      first: "UNAUTHORIZED" as const,
      refusal: REFUSED("UNAUTHORIZED"),
      then: RECOVERABLE[0],
    },
    {
      first: "E_HOST_UNSUPPORTED" as const,
      refusal: REFUSED("E_HOST_UNSUPPORTED"),
      then: RECOVERABLE[0],
    },
  ])(
    "draws no channel rows after $first then $then.name",
    async ({ refusal, then }) => {
      mount({ openThread: null, tiles: null });
      await screen.findByText(POST_FIRST_LINE);
      script.conversationList = () => Promise.reject(refusal(CHANNEL_READ));
      await refetchRead(queryClient, CHANNEL_READ);
      expect(screen.queryByText(POST_FIRST_LINE)).toBeNull();

      script.conversationList = () => Promise.reject(then.error(CHANNEL_READ));
      await refetchRead(queryClient, CHANNEL_READ);

      expect(screen.queryByText(POST_FIRST_LINE)).toBeNull();
      expect(screen.queryByTestId("bot-channel-stale")).toBeNull();
      expect(
        screen.getByTestId("bot-channel-error").getAttribute("data-failure"),
      ).toBe(then.kind);
    },
  );

  it.each(RECOVERABLE)(
    "draws no thread replies, no chip under the post and no cursor advance after FORBIDDEN then $name",
    async ({ error, kind }) => {
      mount({ openThread: THREAD_OPEN, tiles: null });
      const panel = await screen.findByTestId("bot-thread-panel");
      await within(panel).findByText(REPLY_TEXT);
      expect(screen.getByTestId("bot-thread-line")).toBeDefined();
      script.threadList = () =>
        Promise.reject(REFUSED("FORBIDDEN")(THREAD_READ));
      await refetchRead(queryClient, THREAD_READ);
      expect(within(panel).queryByText(REPLY_TEXT)).toBeNull();

      script.threadList = () => Promise.reject(error(THREAD_READ));
      await refetchRead(queryClient, THREAD_READ);

      expect(within(panel).queryByText(REPLY_TEXT)).toBeNull();
      expect(screen.queryByTestId("bot-thread-line")).toBeNull();
      expect(screen.queryByTestId("bot-thread-stale")).toBeNull();
      expect(
        within(panel)
          .getByTestId("bot-thread-error")
          .getAttribute("data-failure"),
      ).toBe(kind);
      const asked = script.advances.length;
      script.readCursor = () => ({
        cursors: {},
        latest: { [THREAD_ID]: { messageId: "thread-newer", seq: 9 } },
      });
      await act(async () => {
        await queryClient.refetchQueries({
          queryKey: hostQueryKeys.methodScope(TAB_HOST_ID, CURSOR_READ),
        });
      });
      await act(() => Promise.resolve());
      expect(
        script.advances
          .slice(asked)
          .filter((ask) => ask.conversationId === THREAD_ID),
      ).toEqual([]);
    },
  );

  it("draws the channel's rows again under a fresh answer after the refusal, and keeps them under the line when a failure follows", async () => {
    mount({ openThread: null, tiles: null });
    await screen.findByText(POST_FIRST_LINE);
    script.conversationList = () =>
      Promise.reject(REFUSED("FORBIDDEN")(CHANNEL_READ));
    await refetchRead(queryClient, CHANNEL_READ);
    expect(screen.queryByText(POST_FIRST_LINE)).toBeNull();

    // The host's answer is the same one: the cache keeps the object it holds.
    script.conversationList = () => Promise.resolve(CHANNEL_LIST);
    await refetchRead(queryClient, CHANNEL_READ);
    expect(screen.getByText(POST_FIRST_LINE)).toBeDefined();
    script.conversationList = () =>
      Promise.reject(hostFailure("RPC_ERROR", CHANNEL_READ));
    await refetchRead(queryClient, CHANNEL_READ);

    expect(screen.getByText(POST_FIRST_LINE)).toBeDefined();
    expect(
      screen.getByTestId("bot-channel-stale").getAttribute("data-failure"),
    ).toBe("server");
  });

  it("draws the thread's replies again under a fresh answer after the refusal", async () => {
    mount({ openThread: THREAD_OPEN, tiles: null });
    const panel = await screen.findByTestId("bot-thread-panel");
    await within(panel).findByText(REPLY_TEXT);
    const answering = script.threadList;
    script.threadList = () => Promise.reject(REFUSED("FORBIDDEN")(THREAD_READ));
    await refetchRead(queryClient, THREAD_READ);
    expect(within(panel).queryByText(REPLY_TEXT)).toBeNull();
    script.threadList = answering;

    await refetchRead(queryClient, THREAD_READ);

    expect(await within(panel).findByText(REPLY_TEXT)).toBeDefined();
    expect(screen.getByTestId("bot-thread-line")).toBeDefined();
  });
});

describe("<BotChannelView /> rows another account fetched", () => {
  it.each(RECOVERABLE)(
    "withholds the channel's rows from the next account when $name follows an answer fetched for the first",
    async ({ error, kind }) => {
      signInAs("user-a");
      mount({ openThread: null, tiles: null });
      await screen.findByText(POST_FIRST_LINE);

      act(() => signInAs("user-b"));
      script.conversationList = () => Promise.reject(error(CHANNEL_READ));
      await refetchRead(queryClient, CHANNEL_READ);

      expect(screen.queryByText(POST_FIRST_LINE)).toBeNull();
      expect(screen.queryByTestId("bot-channel-stale")).toBeNull();
      expect(
        screen.getByTestId("bot-channel-error").getAttribute("data-failure"),
      ).toBe(kind);
    },
  );

  it.each(RECOVERABLE)(
    "withholds the thread's replies from the next account when $name follows an answer fetched for the first",
    async ({ error, kind }) => {
      signInAs("user-a");
      mount({ openThread: THREAD_OPEN, tiles: null });
      const panel = await screen.findByTestId("bot-thread-panel");
      await within(panel).findByText(REPLY_TEXT);

      act(() => signInAs("user-b"));
      script.threadList = () => Promise.reject(error(THREAD_READ));
      await refetchRead(queryClient, THREAD_READ);

      expect(within(panel).queryByText(REPLY_TEXT)).toBeNull();
      expect(screen.queryByTestId("bot-thread-line")).toBeNull();
      expect(
        within(panel)
          .getByTestId("bot-thread-error")
          .getAttribute("data-failure"),
      ).toBe(kind);
    },
  );

  it("withholds the rows of an answer whose fetch started for the first account and settled for the next", async () => {
    signInAs("user-a");
    mount({ openThread: null, tiles: null });
    await screen.findByText(POST_FIRST_LINE);
    const answer = Promise.withResolvers<void>();
    // A different answer, so a mark set at its settling would show.
    const later = {
      conversations: [{ ...CHANNEL_LIST.conversations[0], title: "Renamed" }],
    };
    script.conversationList = () => answer.promise.then(() => later);
    const asked = script.conversationListCalls;
    void queryClient.refetchQueries({
      queryKey: hostQueryKeys.methodScope(TAB_HOST_ID, CHANNEL_READ),
    });
    await waitFor(() => expect(script.conversationListCalls).toBe(asked + 1));

    act(() => signInAs("user-b"));
    act(() => answer.resolve());
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    script.conversationList = () =>
      Promise.reject(hostFailure("RPC_ERROR", CHANNEL_READ));
    await refetchRead(queryClient, CHANNEL_READ);

    expect(screen.queryByText(POST_FIRST_LINE)).toBeNull();
    expect(
      screen.getByTestId("bot-channel-error").getAttribute("data-failure"),
    ).toBe("server");
  });

  it.each([RECOVERABLE[0], RECOVERABLE[1]])(
    "withholds the rows of a patch written to the cache after a refusal when $name follows",
    async ({ error }) => {
      mount({ openThread: null, tiles: null });
      await screen.findByText(POST_FIRST_LINE);
      script.conversationList = () =>
        Promise.reject(REFUSED("FORBIDDEN")(CHANNEL_READ));
      await refetchRead(queryClient, CHANNEL_READ);
      const [query] = queryClient.getQueryCache().findAll({
        queryKey: hostQueryKeys.methodScope(TAB_HOST_ID, CHANNEL_READ),
      });
      act(() => {
        queryClient.setQueryData(query.queryKey, {
          conversations: [...CHANNEL_LIST.conversations],
        });
      });

      script.conversationList = () => Promise.reject(error(CHANNEL_READ));
      await refetchRead(queryClient, CHANNEL_READ);

      expect(screen.queryByText(POST_FIRST_LINE)).toBeNull();
      expect(screen.queryByTestId("bot-channel-stale")).toBeNull();
      expect(screen.getByTestId("bot-channel-error")).toBeDefined();
    },
  );

  it("withholds an earlier fetched answer a cache write puts back after the read was reset, when a failure follows", async () => {
    mount({ openThread: null, tiles: null });
    await screen.findByText(POST_FIRST_LINE);
    const [query] = queryClient.getQueryCache().findAll({
      queryKey: hostQueryKeys.methodScope(TAB_HOST_ID, CHANNEL_READ),
    });
    const first = query.state.data;
    script.conversationList = () =>
      Promise.resolve({
        conversations: [{ ...CHANNEL_LIST.conversations[0], title: "Renamed" }],
      });
    await refetchRead(queryClient, CHANNEL_READ);
    expect(query.state.data).not.toBe(first);
    // A reset leaves the read no data, so the write that follows stores the
    // object it is given, as a rollback of an answer captured earlier does.
    act(() => {
      query.reset();
    });
    act(() => {
      queryClient.setQueryData(query.queryKey, first);
    });
    expect(query.state.data).toBe(first);

    script.conversationList = () =>
      Promise.reject(hostFailure("RPC_ERROR", CHANNEL_READ));
    await refetchRead(queryClient, CHANNEL_READ);

    expect(screen.queryByText(POST_FIRST_LINE)).toBeNull();
    expect(screen.queryByTestId("bot-channel-stale")).toBeNull();
    expect(screen.getByTestId("bot-channel-error")).toBeDefined();
  });
});

describe("<BotChannelView tiles={1} /> a read that fails beside an open thread", () => {
  async function mountNarrowWithThreadBox(): Promise<HTMLElement> {
    mount({ openThread: THREAD_OPEN, tiles: 1 });
    const panel = await screen.findByTestId("bot-thread-panel");
    await within(panel).findByRole("group", { name: THREAD_BOX });
    typeInto(boxWithin(panel, THREAD_BOX), "Not yet");
    return panel;
  }

  it("says the channel's failure above the section the rail hides, with Retry, and holds the thread's Send", async () => {
    const panel = await mountNarrowWithThreadBox();
    script.conversationList = () =>
      Promise.reject(hostFailure("E_CLOUD_UNREACHABLE", CHANNEL_READ));

    await refetchRead(queryClient, CHANNEL_READ);

    const line = screen.getByTestId("bot-channel-stale");
    expect(screen.getByTestId("bot-channel").className).toMatch(/\bhidden\b/);
    expect(line.closest("[data-testid=bot-channel]")).toBeNull();
    expect(within(line).getByRole("button", { name: "Retry" })).toBeDefined();
    expect(
      within(panel)
        .getByTestId("bot-thread-composer-send")
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("says the thread's own failure in the panel, with Retry, and holds its Send", async () => {
    const panel = await mountNarrowWithThreadBox();
    script.threadList = () =>
      Promise.reject(hostFailure("E_CLOUD_UNREACHABLE", THREAD_READ));

    await refetchRead(queryClient, THREAD_READ);

    const line = within(panel).getByTestId("bot-thread-stale");
    expect(within(line).getByRole("button", { name: "Retry" })).toBeDefined();
    expect(screen.queryByTestId("bot-channel-stale")).toBeNull();
    expect(
      within(panel)
        .getByTestId("bot-thread-composer-send")
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});

describe("<BotChannelView /> a thread's controls while its box waits", () => {
  const SOURCES = [
    {
      name: "the channel's read, a cloud drop",
      fail: async (): Promise<void> => {
        script.conversationList = () =>
          Promise.reject(hostFailure("E_CLOUD_UNREACHABLE", CHANNEL_READ));
        await refetchRead(queryClient, CHANNEL_READ);
      },
    },
    {
      name: "the channel's read, a silent host",
      fail: async (): Promise<void> => {
        script.conversationList = () =>
          Promise.reject(transportFailure(CHANNEL_READ));
        await refetchRead(queryClient, CHANNEL_READ);
      },
    },
    {
      name: "the thread list, a cloud drop",
      fail: async (): Promise<void> => {
        script.threadList = () =>
          Promise.reject(hostFailure("E_CLOUD_UNREACHABLE", THREAD_READ));
        await refetchRead(queryClient, THREAD_READ);
      },
    },
    {
      name: "the thread list, a silent host",
      fail: async (): Promise<void> => {
        script.threadList = () => Promise.reject(transportFailure(THREAD_READ));
        await refetchRead(queryClient, THREAD_READ);
      },
    },
  ];

  /** The thread open, a draft in its box, and the send holding until `fail` has run. */
  async function waitingThread(
    fail: () => Promise<void>,
    rows: ReadonlyArray<Message>,
  ): Promise<HTMLElement> {
    negotiateBotSend(TAB_HOST_ID, { major: 1, minor: 5 });
    signInViewer(VIEWER_USER_ID);
    mocks.sessions[THREAD_ID] = scriptedSession(THREAD_ID, rows).handle;
    mocks.sessions[THREAD_SESSION_ID] = mocks.sessions[THREAD_ID];
    mount({ openThread: THREAD_OPEN, tiles: null });
    const panel = await screen.findByTestId("bot-thread-panel");
    await within(panel).findByRole("group", { name: THREAD_BOX });
    typeInto(boxWithin(panel, THREAD_BOX), "Not yet");
    await fail();
    expect(
      within(panel)
        .getByTestId("bot-thread-composer-send")
        .hasAttribute("disabled"),
    ).toBe(true);
    return panel;
  }

  it.each(SOURCES)(
    "still sends a picked option while $name fails",
    async ({ fail }) => {
      const panel = await waitingThread(fail, [
        {
          ...botReply({
            messageId: "reply-choices",
            text: "Ship?",
            timestamp: 2_000,
          }),
          options: ["Ship it", "Hold"],
        },
      ]);

      await userEvent
        .setup()
        .click(
          within(
            within(panel).getByRole("group", { name: "Choices" }),
          ).getByRole("button", { name: "Hold" }),
        );

      await waitFor(() =>
        expect(script.sends.map((ask) => ask.text)).toEqual(["Hold"]),
      );
      expect(script.sends[0].threadId).toBe(THREAD_ID);
    },
  );

  it.each(SOURCES)(
    "still submits a question card's answers together while $name fails",
    async ({ fail }) => {
      const first = questionItem("Deploy now?", ["Now", "Later"], false);
      const second = questionItem("Anything to hold back?", [], true);
      const panel = await waitingThread(fail, [
        {
          ...botReply({
            messageId: "question-row",
            text: first.text,
            timestamp: 2_000,
          }),
          question: { requestId: "req-question", questions: [first, second] },
        },
      ]);
      const card = within(panel).getByTestId("question-card");
      fireEvent.click(
        within(
          within(card).getByRole("region", { name: first.text }),
        ).getByRole("button", { name: "Now" }),
      );
      fireEvent.change(
        within(
          within(card).getByRole("region", { name: second.text }),
        ).getByRole("textbox", { name: "Your answer" }),
        { target: { value: "Nothing" } },
      );

      fireEvent.click(within(card).getByTestId("question-card-submit"));

      await waitFor(() => expect(script.sends).toHaveLength(1));
      expect(script.sends[0].threadId).toBe(THREAD_ID);
    },
  );

  it.each(SOURCES)(
    "still offers Retry and Edit on a failed reply while $name fails",
    async ({ fail }) => {
      const REPLY_REQUEST = "req-reply";
      mocks.activity = {
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
      };
      const panel = await waitingThread(fail, [
        botReply({
          messageId: THREAD_REPLY_ID,
          text: REPLY_TEXT,
          timestamp: 2_000,
        }),
        memberPost({
          messageId: "reply-mine",
          requestId: REPLY_REQUEST,
          lines: ["Ship it?"],
          timestamp: 3_000,
          resolvedBy: null,
        }),
      ]);

      fireEvent.click(
        within(panel).getByTestId("bot-message-unanswered-retry"),
      );

      await waitFor(() => expect(script.sends).toHaveLength(1));
      expect(script.sends[0].redeliver).toEqual({ requestId: REPLY_REQUEST });
      expect(
        within(panel)
          .getByTestId("bot-message-unanswered-edit")
          .hasAttribute("disabled"),
      ).toBe(false);
    },
  );
});
