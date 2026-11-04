/**
 * What the surface suites of the search panel share: the fake hosts, the
 * hooks that read the bot, thread and member lists, the stubbed transcript,
 * and the lifecycle each suite installs. It registers the module mocks, so
 * a suite imports it before anything of the surface.
 */
import { useSyncExternalStore, type ReactNode } from "react";
import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import {
  botConversationSearchRequestSchema,
  type BotConversationSearchHit,
  type BotConversationSearchRequest,
  type BotConversationSearchResponse,
  type BotThreadSummary,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { BotSubscriptionSnapshot } from "@/hooks/bots/use-bot-subscription";
import type { TabNavigationIntent } from "@/lib/tab-navigation/intents";
import type { BotTranscriptLanding } from "@/components/bots/bot-chat-transcript";
import { CHAT_SEARCH_DEBOUNCE_MS } from "@/lib/chat-search/chat-search-results";
import {
  SEARCH_BOT_A,
  SEARCH_BOT_B,
  SEARCH_BOT_C,
  searchHit,
  searchResponse,
} from "@/lib/bots/__tests__/bot-search-test-support";
import { TranscriptStub } from "./bot-search-surface-transcript";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import { useBotSearchStore } from "@/stores/bots/bot-search-store";
import { useBotTabLandingStore } from "@/stores/bots/bot-tab-landing-store";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

type SearchAnswer = (
  hostId: string,
  request: BotConversationSearchRequest,
) =>
  | BotConversationSearchResponse
  | HostRpcError
  | Promise<BotConversationSearchResponse>;

/** A row the transcript stub draws. */
interface TranscriptRow {
  readonly messageId: string;
  readonly text: string;
}

interface AskedSearch {
  readonly hostId: string;
  readonly request: BotConversationSearchRequest;
}

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  /** Every intent the surface asked the tab-navigation controller to activate. */
  activateTabIntent: vi.fn<(intent: unknown) => void>(),
  /** Each `bot.conversation.search` a fake host was asked, in order. */
  asked: [] as AskedSearch[],
  state: {
    /** What the fake hosts answer; set by `beforeEach`, replaced by a case. */
    answer: null as SearchAnswer | null,
    bots: [] as BotRecord[],
    /** The threads of the channel in view (any bot's list answers these). */
    threads: [] as BotThreadSummary[],
    /** Host ids this client can dial. */
    connectable: [] as string[],
    /** Whether the directory has said which hosts those are yet. */
    connectableResolved: true,
    /** How the bot list stands: loaded, still loading, or failed. */
    botListState: "ready",
    searchSupported: true,
    /** The transcript stub's rows, by chat id. */
    rows: new Map<string, ReadonlyArray<TranscriptRow>>(),
  },
  /** The lists above are read by hooks: a change in them re-renders the readers. */
  lists: {
    version: 0,
    listeners: new Set<() => void>(),
  },
}));

function subscribeToLists(listener: () => void): () => void {
  mocks.lists.listeners.add(listener);
  return () => mocks.lists.listeners.delete(listener);
}

function listsVersion(): number {
  return mocks.lists.version;
}

/** Changes what the bot list and the connectable hosts answer, and re-renders their readers. */
export function changeLists(update: () => void): void {
  act(() => {
    update();
    mocks.lists.version += 1;
    for (const listener of mocks.lists.listeners) listener();
  });
}

/** What the surface asks of a host's client: the readiness it reports, and `request`. */
interface FakeHostClient {
  readonly getActiveHostId: () => string;
  readonly getRequestContextUserId: () => string;
  readonly onChange: () => () => void;
  readonly request: (
    method: string,
    request: BotConversationSearchRequest,
  ) => Promise<BotConversationSearchResponse>;
}

/** One stable fake client per host id, as the directory hands out. */
const clients = new Map<string, FakeHostClient>();

function newFakeClient(hostId: string): FakeHostClient {
  return {
    getActiveHostId: () => hostId,
    getRequestContextUserId: () => "user-viewer",
    onChange: () => () => undefined,
    request: (
      method: string,
      request: BotConversationSearchRequest,
    ): Promise<BotConversationSearchResponse> => {
      if (method !== "bot.conversation.search") {
        return Promise.reject(new Error(`unscripted request ${method}`));
      }
      mocks.asked.push({ hostId, request });
      // The host checks the request against its schema before it answers.
      const valid = botConversationSearchRequestSchema.safeParse(request);
      if (!valid.success) {
        return Promise.reject(
          new HostRpcError({
            code: "E_INVALID_ARGUMENT",
            message: valid.error.message,
            requestId: "request-invalid",
            method,
            fatalDetails: null,
          }),
        );
      }
      const answered = mocks.state.answer?.(hostId, request);
      if (answered === undefined) {
        return Promise.reject(new Error("no answer scripted"));
      }
      return answered instanceof Error
        ? Promise.reject(answered)
        : Promise.resolve(answered);
    },
  };
}

const openMutation = {
  mutate: (
    variables: { botId: string },
    options: { onSuccess: (response: unknown) => void },
  ): void => {
    options.onSuccess({
      bot: mocks.state.bots.find((entry) => entry.botId === variables.botId),
      outcome: { kind: "serve-here", claimed: null },
    });
  },
};

function clientFor(hostId: string): FakeHostClient {
  const held = clients.get(hostId);
  if (held !== undefined) return held;
  const made = newFakeClient(hostId);
  clients.set(hostId, made);
  return made;
}

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => mocks.navigate,
}));
// The controller accepts a navigation at once and commits the channel, as a
// history push does; the intents it was asked for are what a case reads.
vi.mock("@/lib/tab-navigation", async (importOriginal) => {
  const { useTracySurfaceStore: surfaceStore } =
    await import("@/stores/bots/tracy-surface-store");
  return {
    ...(await importOriginal<typeof import("@/lib/tab-navigation")>()),
    activateTabIntent: (
      _navigate: unknown,
      intent: TabNavigationIntent,
      _options: unknown,
    ) => {
      mocks.activateTabIntent(intent);
      if (intent.kind === "tracy") {
        surfaceStore.getState().selectChannel(intent.botId);
      }
      return true;
    },
  };
});
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    method === "bot.conversation.search" ? mocks.state.searchSupported : true,
  useHostMethodSchemaVersion: () => ({ major: 1, minor: 1 }),
  useHostSupportsMethod: () => true,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => clientFor("host-tab"),
}));
vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-tab",
}));
vi.mock("@/components/epic-canvas/tab-host-provider", () => ({
  TabHostProvider: (props: { hostId: string; children: ReactNode }) => (
    <>{props.children}</>
  ),
}));
// The directory hands a requester for any host this client can dial.
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => ({
    hostClient: {
      createRequesterForHostId: (hostId: string) => clientFor(hostId),
    },
  }),
}));
vi.mock("@/hooks/host/use-connectable-host-ids", () => ({
  useConnectableHostIds: () => {
    useSyncExternalStore(subscribeToLists, listsVersion);
    return {
      hostIds: mocks.state.connectable,
      resolved: mocks.state.connectableResolved,
    };
  },
}));
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: [] }),
}));
vi.mock("@/hooks/bots/use-bot-list-query", () => ({
  useBotListQuery: () => {
    useSyncExternalStore(subscribeToLists, listsVersion);
    const state = mocks.state.botListState;
    return {
      status: state === "ready" ? "success" : state,
      data:
        state === "ready"
          ? { bots: mocks.state.bots, mainBotIds: null }
          : undefined,
      isPending: state === "pending",
      isError: state === "error",
      dataUpdatedAt: state === "ready" ? 1_000 : 0,
      errorUpdatedAt: 0,
      isFetchedAfterMount: true,
      isFetching: false,
      refetch: vi.fn(),
    };
  },
}));
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({
    status: "success",
    data: {
      environments: [
        {
          environmentId: "env-team",
          label: "Acme",
          ownerKind: "organization",
        },
      ],
    },
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/bots/use-bot-list-changed-subscription", () => ({
  useBotListChangedSubscriptionForHost: () => undefined,
}));
vi.mock("@/hooks/bots/use-host-environment-bindings-query", () => ({
  useHostEnvironmentBindings: () => ({
    byHostId: {},
    failedHostIds: [],
    retryFailed: () => undefined,
  }),
}));
vi.mock("@/hooks/bots/use-bot-subscription", () => ({
  useBotSubscriptionForHost: (input: { botId: string }) => ({
    snapshot: snapshotOf(input.botId),
    deleted: false,
    error: null,
    isPending: false,
    resubscribe: vi.fn(),
  }),
}));
// One stable mutation object, like TanStack's `mutate`: the surface opens the
// bot from an effect keyed on it. The host serves every bot here.
vi.mock("@/hooks/bots/use-bot-mutations", () => ({
  useBotOpenMutation: () => openMutation,
  useBotConversationSendMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    variables: { redeliver: null },
  }),
}));
vi.mock("@/hooks/bots/use-bot-memory", () => ({
  useBotMemory: () => ({ kind: "unsupported" }),
}));
// The members of the bot's environment: one teammate, known by name.
vi.mock("@/hooks/bots/use-environment-members-query", () => {
  const teammate = {
    userId: "user-teammate",
    displayName: "Tess Teammate",
    avatarUrl: null,
  };
  const resolve = (userId: string) =>
    userId === teammate.userId
      ? { displayName: teammate.displayName, avatarUrl: null }
      : null;
  return {
    useEnvironmentMembers: () => resolve,
    useEnvironmentMemberDirectory: () => ({ resolve, members: [teammate] }),
  };
});
vi.mock("@/hooks/bots/use-bot-conversation-list-query", () => ({
  useBotConversationListQuery: (_client: unknown, botId: string) => ({
    data: conversationListOf(botId),
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/bots/use-bot-thread-list-query", () => ({
  botThreadListParams: (botId: string) => ({
    botId,
    limit: null,
    cursor: null,
  }),
  useBotThreadListQuery: () => ({
    data: {
      threads: mocks.state.threads,
      threadAnchors: null,
      nextCursor: null,
      total: mocks.state.threads.length,
    },
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
// The rest of what the sidebar and the channel read from the host.
vi.mock("@/hooks/host/use-host-queries", () => ({
  useHostQueries: (args: {
    requests: ReadonlyArray<{ method: string }>;
    options: { enabled?: boolean } | null;
  }) =>
    args.requests.map((request) => {
      if (args.options?.enabled !== true) {
        return { status: "pending", isPending: true, data: undefined };
      }
      const answers: Record<string, unknown> = {
        "bot.thread.list": {
          threads: [],
          trunkCostUsd: null,
          threadAnchors: null,
          nextCursor: null,
          total: 0,
        },
        "bot.threadFollow.read": { follows: {} },
        "bot.readCursor.read": { cursors: {}, latest: {} },
        "bot.notificationLevel.read": { levels: {} },
      };
      return {
        status: "success",
        isPending: false,
        isError: false,
        data: answers[request.method],
      };
    }),
}));
vi.mock("@/hooks/host/use-host-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/host/use-host-query")>()),
  useHostQuery: () => ({ data: undefined }),
}));
vi.mock("@/hooks/bots/use-bot-thread-follow", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/bots/use-bot-thread-follow")
  >()),
  useBotThreadFollows: () => ({ data: undefined }),
}));
vi.mock("@/hooks/bots/use-bot-read-cursor", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/bots/use-bot-read-cursor")
  >()),
  useBotReadCursors: () => ({ data: undefined }),
  useBotReadCursorAdvanceMutation: () => ({
    mutateAsync: () => Promise.resolve(),
  }),
}));
vi.mock("@/hooks/bots/use-bot-notification-level", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/bots/use-bot-notification-level")
  >()),
  useBotNotificationLevelsQuery: () => ({ data: undefined }),
}));
vi.mock("@/hooks/bots/use-bot-activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/bots/use-bot-activity")>()),
  useBotActivity: () => null,
}));
vi.mock("@/hooks/notifications/use-notification-indicators-query", () => ({
  useNotificationIndicators: () => ({ epics: {}, chats: {} }),
}));
vi.mock(
  "@/hooks/notifications/use-notification-mark-entity-read-mutation",
  () => ({ useNotificationMarkEntityRead: () => ({ mutate: vi.fn() }) }),
);
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useChatSessionHandleForContainer: () => null,
}));
vi.mock("@/lib/host-error-toast", () => ({ toastFromHostError: vi.fn() }));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => null,
}));
vi.mock("@/components/bots/bot-message-composer", () => ({
  BotMessageComposer: (props: { testId: string }) => (
    <div data-testid={`stub-${props.testId}`} />
  ),
}));
vi.mock("@/components/bots/bot-session-view", () => ({
  BotSessionView: () => <div data-testid="stub-session" />,
}));
vi.mock("@/components/bots/bot-activity-page", () => ({
  BotActivityPage: () => <div data-testid="stub-activity" />,
}));
vi.mock("@/components/bots/bot-threads-view", () => ({
  BotThreadsView: () => <div data-testid="stub-threads" />,
}));
vi.mock("@/components/bots/bot-settings-panel", () => ({
  BotChannelSettingsPanel: () => <div data-testid="stub-settings" />,
}));
vi.mock("@/components/bots/bot-chat-transcript", () => ({
  BotChatTranscript: (props: {
    chatId: string;
    surface: { kind: string } | null;
    header: ReactNode;
    landOn: BotTranscriptLanding | null;
  }) => <TranscriptStub {...props} />,
}));

export const TAB_HOST = "host-tab";
export const HOST_A = "host-a";
export const HOST_B = "host-b";
const HOST_C = "host-c";

const CONVERSATIONS: Readonly<Record<string, string>> = {
  [SEARCH_BOT_A]: "conversation-a",
  [SEARCH_BOT_B]: "conversation-b",
  [SEARCH_BOT_C]: "conversation-c",
};

export function conversationOf(botId: string): string {
  return Object.hasOwn(CONVERSATIONS, botId) ? CONVERSATIONS[botId] : botId;
}

/** One list object per bot, as a query holds one answer between reads. */
const conversationLists = new Map<
  string,
  { conversations: Array<{ conversationId: string; createdAt: number }> }
>();

function conversationListOf(botId: string): {
  conversations: Array<{ conversationId: string; createdAt: number }>;
} {
  const held = conversationLists.get(botId);
  if (held !== undefined) return held;
  const made = {
    conversations: [
      { conversationId: conversationOf(botId), createdAt: 1_000 },
    ],
  };
  conversationLists.set(botId, made);
  return made;
}

function bot(botId: string, title: string, boundHostId: string): BotRecord {
  return {
    botId,
    environmentId: "env-team",
    createdByUserId: "user-1",
    title,
    harness: "claude",
    model: "opus",
    effort: null,
    profile: null,
    trunkChatId: `trunk-${botId}`,
    boundHostId,
    hostEpoch: 1,
    createdAt: 1_000,
    archivedAt: null,
    directive: null,
    replyMode: "thread",
    appConversationChatId: conversationOf(botId),
  };
}

const BOTS: BotRecord[] = [
  bot(SEARCH_BOT_A, "Release Bot", HOST_A),
  bot(SEARCH_BOT_B, "Notes Bot", HOST_B),
  bot(SEARCH_BOT_C, "Ops Bot", HOST_C),
];

function snapshotOf(botId: string): BotSubscriptionSnapshot {
  const record = mocks.state.bots.find((entry) => entry.botId === botId);
  if (record === undefined) throw new Error(`no bot ${botId}`);
  return {
    bot: record,
    tasks: [],
    openRequestCount: 0,
    conversationsRevision: null,
    notificationSubscriptions: null,
    surfaceActions: null,
    stoppedNotificationWatches: null,
    boundHost: {
      hostId: record.boundHostId ?? TAB_HOST,
      epoch: 1,
      isThisHost: false,
    },
    activity: null,
  };
}

/** The viewer, who is not the teammate. */
const VIEWER = {
  userId: "user-viewer",
  userName: "Vee Viewer",
  email: "vee@example.com",
} as const;

let queryClient = new QueryClient();

/** The client the running case reads through; a new one each case. */
export function searchQueryClient(): QueryClient {
  return queryClient;
}

export const SEARCH_RESULT_A: BotConversationSearchHit = searchHit({
  messageId: "post-1",
  snippet: {
    text: "ship the release today",
    highlights: [{ start: 9, end: 16 }],
  },
  score: 5,
});

/** A host with the bot's two posts matching, answering any search the same. */
export function answerWith(
  response: BotConversationSearchResponse,
): SearchAnswer {
  return () => response;
}

export function lastAsked(): AskedSearch {
  const asked = mocks.asked.at(-1);
  if (asked === undefined) throw new Error("no search was asked");
  return asked;
}

/** Past the keystroke debounce and through the answer's promises. */
export async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(CHAT_SEARCH_DEBOUNCE_MS);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

export async function typeIntoPanel(text: string): Promise<void> {
  fireEvent.change(screen.getByTestId("bot-search-input"), {
    target: { value: text },
  });
  await settle();
}

export function panel(): HTMLElement {
  return screen.getByTestId("bot-search-panel");
}

export function installSearchSurfaceLifecycle(): void {
  beforeEach(() => {
    vi.useFakeTimers();
    // A local afternoon, so a day filter starts at the midnight before it.
    vi.setSystemTime(new Date(2026, 10, 4, 15, 30));
    vi.clearAllMocks();
    mocks.asked.length = 0;
    clients.clear();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mocks.state.answer = answerWith(
      searchResponse({ hits: [SEARCH_RESULT_A], total: 1 }),
    );
    mocks.state.bots = BOTS;
    mocks.state.threads = [];
    mocks.state.connectable = [TAB_HOST, HOST_A, HOST_B];
    mocks.state.connectableResolved = true;
    mocks.state.botListState = "ready";
    mocks.state.searchSupported = true;
    mocks.state.rows = new Map([
      [
        conversationOf(SEARCH_BOT_A),
        [{ messageId: "post-1", text: "ship the release today" }],
      ],
    ]);
    useSelectionAuthorityStore.setState({ effectiveHostId: TAB_HOST });
    useBotDraftsStore.setState({ answers: {}, threadBoxes: {} });
    useBotOpenThreadStore.setState({ byBotId: {} });
    useBotTabLandingStore.setState({ byBotId: {} });
    useBotSearchStore.getState().reset();
    useBotSearchStore.setState({ recents: [] });
    useTracySurfaceStore.setState({
      open: true,
      hostId: TAB_HOST,
      botId: SEARCH_BOT_A,
      visitedBotIds: [],
    });
    useAuthStore.setState({ profile: VIEWER });
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
    vi.useRealTimers();
    useAuthStore.setState({ profile: null });
  });
}

/** Picks `option` from the filter menu `testId` opens. */
export function pickFilter(testId: string, option: string): void {
  fireEvent.keyDown(screen.getByTestId(testId), { key: "Enter" });
  fireEvent.click(screen.getByRole("menuitemradio", { name: option }));
}

export function thread(threadId: string, postId: string): BotThreadSummary {
  return {
    threadId,
    conversationId: conversationOf(SEARCH_BOT_A),
    sessionChatId: `session-${threadId}`,
    anchor: {
      messageId: postId,
      requestId: `request-${threadId}`,
      senderUserId: "user-teammate",
      sentAt: 1_000,
      resolvedAt: null,
      excerpt: "Is the release ready?",
    },
    replyCount: 2,
    lastReplyAt: 2_000,
    openRequestCount: 0,
    costUsd: null,
  };
}

export const THREAD_HIT: BotConversationSearchHit = searchHit({
  threadId: "thread-1",
  messageId: "reply-2",
  rowKind: "reply",
  senderUserId: null,
  threadExcerpt: "Is the release ready?",
  snippet: {
    text: "the release is ready",
    highlights: [{ start: 4, end: 11 }],
  },
  score: 9,
});

export function hitRows(): HTMLElement[] {
  return screen.getAllByTestId("bot-search-hit");
}

/** The transcript stub showing `chatId`. */
export function transcriptOf(chatId: string): HTMLElement {
  const found = [
    ...document.querySelectorAll<HTMLElement>("[data-chat-id]"),
  ].find((element) => element.dataset.chatId === chatId);
  if (found === undefined) throw new Error(`no transcript of ${chatId}`);
  return found;
}

export { mocks };
