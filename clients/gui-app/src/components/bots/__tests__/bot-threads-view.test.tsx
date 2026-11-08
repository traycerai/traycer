/**
 * Threads in place of a bot's channel (Tracy Bots, decisions 149 and 184):
 * every thread the person follows across the bots the column lists, newest
 * reply first, each a card - the channel line, the origin post, every reply
 * and a reply box, mounted once the card is near the page's view. The real
 * view, fan-out hook, follow and send mutations, landing store, Tracy surface
 * store, the thread panel's own card body and the real transcript run over a
 * real HostClient and QueryClient whose host answers each bot's thread list,
 * follows, read cursors and levels from the case's script. Only the channels'
 * and threads' sessions (rows are read from them), the notification
 * indicators, the tab navigation and the browser's IntersectionObserver are
 * replaced.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type {
  BotThreadSummary,
  BotTurnRef,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type {
  BotNotificationLevel,
  BotReadCursorReadResponse,
  BotRecord,
  BotThreadFollow,
  BotThreadFollowSetRequest,
} from "@traycer/protocol/host/bot/schemas";
import { conversationRequestMessageId } from "@traycer/protocol/persistence/epic/messages";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import type { MobileLevel2Form } from "@/lib/layout/mobile-layout-form";
import { BotTestRunnerHost } from "@/components/bots/__tests__/bot-test-runner-host";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  signInViewer,
  resetBotFailedRequestSupport,
} from "@/components/bots/__tests__/bot-failed-request-test-support";
import {
  botReply,
  turnRef,
  turnsAskedFor,
} from "@/components/bots/__tests__/bot-turn-test-support";
import {
  chatSessionWithPosts,
  chatSessionWithThreadRows,
  postRow,
} from "./bot-channel-rows-test-support";

/** What the host answers for one bot. */
type BotScript = {
  threads: BotThreadSummary[];
  follows: Record<string, BotThreadFollow>;
  cursors: BotReadCursorReadResponse;
  levels: Record<string, BotNotificationLevel>;
};

const mocks = vi.hoisted(() => ({
  /** The host's answers by bot id. */
  hosted: {} as Record<string, BotScript>,
  /** The listed bots, in the column's order. */
  bots: [] as BotRecord[],
  /** Methods the host does not advertise. */
  unsupported: new Set<string>(),
  /** Each bot channel's posts by message id. */
  posts: {} as Record<string, Record<string, string>>,
  channels: {} as Record<string, ChatSessionStoreHandle>,
  /** Each thread's reply texts by thread id, in order; its session holds them. */
  replies: {} as Record<string, string[]>,
  /** A thread's rows by thread id, where a case scripts them in full. */
  replyRows: {} as Record<string, Message[]>,
  /** The turns `bot.turn.locate` knows. */
  turns: [] as BotTurnRef[],
  threadSessions: {} as Record<string, ChatSessionStoreHandle>,
  advances: [] as unknown[],
  /** Unread notifications by thread id, as the indicators read them. */
  unread: {} as Record<string, number>,
  writes: [] as BotThreadFollowSetRequest[],
  /** Every read the host answered: its method and the params it was sent. */
  reads: [] as Array<{ method: string; params: unknown }>,
  client: null as HostClient<HostRpcRegistry> | null,
  activateTabIntent: vi.fn<(intent: unknown) => void>(),
  /** How `bot.list` stands: answered, still being read, or failed. */
  botList: "listed" as "listed" | "pending" | "failed",
  refetchBots: vi.fn<() => Promise<unknown>>(),
  back: vi.fn<() => void>(),
}));

vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-1",
}));
vi.mock("@/hooks/host/use-host-supports-method", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-supports-method")
  >()),
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    !mocks.unsupported.has(method),
}));
vi.mock("@/hooks/host/use-host-directory-entry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-directory-entry")
  >()),
  useHostDirectoryEntry: () => null,
}));
// The bot's live snapshot (its tasks, binding and surface actions) is not
// what these cases read: no stream is opened.
vi.mock("@/hooks/bots/use-bot-subscription", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/bots/use-bot-subscription")
  >()),
  useBotSubscriptionForHost: () => ({
    snapshot: null,
    deleted: false,
    error: null,
    isPending: false,
    resubscribe: () => undefined,
  }),
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.client,
}));
vi.mock("@/hooks/bots/use-bot-list-query", () => ({
  useBotListQuery: () => ({
    data:
      mocks.botList === "listed"
        ? { bots: mocks.bots, mainBotIds: null }
        : undefined,
    isError: mocks.botList === "failed",
    refetch: mocks.refetchBots,
  }),
}));
vi.mock("@/hooks/notifications/use-notification-indicators-query", () => ({
  useNotificationIndicators: (args: { chatIds: ReadonlyArray<string> }) => ({
    epics: {},
    chats: Object.fromEntries(
      args.chatIds.map((id) => [id, { unreadCount: mocks.unread[id] ?? 0 }]),
    ),
  }),
}));
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useChatSessionHandleForContainer: (
    botId: string,
    chatId: string,
  ): ChatSessionStoreHandle | null => {
    if (Object.hasOwn(mocks.replyRows, chatId)) {
      mocks.threadSessions[chatId] ??= chatSessionWithThreadRows(
        mocks.replyRows[chatId],
      );
      return mocks.threadSessions[chatId];
    }
    if (Object.hasOwn(mocks.replies, chatId)) {
      mocks.threadSessions[chatId] ??= chatSessionWithThreadRows(
        mocks.replies[chatId].map((text, index) =>
          postRow(`${chatId}-reply-${String(index + 1)}`, text),
        ),
      );
      return mocks.threadSessions[chatId];
    }
    if (!Object.hasOwn(mocks.posts, botId)) return null;
    if (!Object.hasOwn(mocks.channels, botId)) {
      mocks.channels[botId] = chatSessionWithPosts(mocks.posts[botId]);
    }
    return mocks.channels[botId];
  },
}));
vi.mock("@/hooks/bots/use-bot-activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/bots/use-bot-activity")>()),
  useBotActivity: () => null,
}));
vi.mock("@/lib/chats/chat-serving-witness", () => ({
  useChatServingHostId: () => "host-1",
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));
vi.mock("@/lib/tab-navigation", () => ({
  activateTabIntent: (_navigate: unknown, intent: unknown) => {
    mocks.activateTabIntent(intent);
    return true;
  },
}));
vi.mock("@/hooks/host/use-connectable-host-ids", () => ({
  useConnectableHostIds: () => ({ hostIds: ["host-1"], resolved: true }),
}));

import { BotThreadsView } from "@/components/bots/bot-threads-view";
import { useBotThreadFoldStore } from "@/stores/bots/bot-thread-fold-store";
import { useBotTabLandingStore } from "@/stores/bots/bot-tab-landing-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";

const TRACY = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TEAM = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAW";

function bot(botId: string, title: string): BotRecord {
  return {
    botId,
    environmentId: `env-${title}`,
    createdByUserId: "user-1",
    title,
    harness: "claude",
    model: "opus",
    effort: null,
    profile: null,
    directive: null,
    replyMode: "thread",
    appConversationChatId: `channel-${botId}`,
    trunkChatId: `trunk-${botId}`,
    boundHostId: null,
    hostEpoch: 0,
    createdAt: 1_000,
    archivedAt: null,
  };
}

function thread(
  botId: string,
  threadId: string,
  lastReplyAt: number | null,
): BotThreadSummary {
  return {
    threadId,
    conversationId: `channel-${botId}`,
    sessionChatId: `session-${threadId}`,
    anchor: {
      messageId: conversationRequestMessageId(`req-${threadId}`),
      requestId: `req-${threadId}`,
      senderUserId: "user-1",
      sentAt: 1_000,
      resolvedAt: null,
      excerpt: null,
    },
    replyCount: 2,
    lastReplyAt,
    openRequestCount: 0,
    costUsd: null,
  };
}

/** A thread a call opened. */
function callThread(
  botId: string,
  threadId: string,
  lastReplyAt: number | null,
): BotThreadSummary {
  return { ...thread(botId, threadId, lastReplyAt), kind: "call" };
}

function script(
  threads: BotThreadSummary[],
  follows: Record<string, BotThreadFollow>,
): BotScript {
  return {
    threads,
    follows,
    cursors: { cursors: {}, latest: {} },
    levels: {},
  };
}

const FOLLOWING: BotThreadFollow = {
  state: "following",
  reason: "participated",
};

/** The installed app's form the next mount draws in; `null` where the container decides. */
let mountLevel2: MobileLevel2Form | null = null;
/** The last mount's query client, for a case that has the host read again. */
let queryClient = new QueryClient();

function mount(): void {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "bot.thread.list": (params) => {
          mocks.reads.push({ method: "bot.thread.list", params });
          const { threads } = mocks.hosted[params.botId];
          return {
            threads,
            trunkCostUsd: null,
            threadAnchors: null,
            nextCursor: null,
            total: threads.length,
          };
        },
        "bot.threadFollow.read": (params) => {
          mocks.reads.push({ method: "bot.threadFollow.read", params });
          return { follows: { ...mocks.hosted[params.botId].follows } };
        },
        "bot.threadFollow.set": (params) => {
          mocks.writes.push(params);
          const follow: BotThreadFollow = {
            state: params.state,
            reason: "manual",
          };
          mocks.hosted[params.botId].follows[params.threadId] = follow;
          return { follow };
        },
        "bot.readCursor.advance": (params) => {
          mocks.advances.push(params);
          const cursor = { messageId: params.messageId, seq: params.seq };
          const read = mocks.hosted[params.botId].cursors;
          mocks.hosted[params.botId].cursors = {
            ...read,
            cursors: { ...read.cursors, [params.conversationId]: cursor },
          };
          return { cursor };
        },
        "bot.readCursor.read": (params) => {
          mocks.reads.push({ method: "bot.readCursor.read", params });
          return mocks.hosted[params.botId].cursors;
        },
        "bot.notificationLevel.read": (params) => {
          mocks.reads.push({ method: "bot.notificationLevel.read", params });
          return { levels: mocks.hosted[params.botId].levels };
        },
        "bot.turn.locate": (params) => turnsAskedFor(mocks.turns, params),
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  mocks.client = spine.createRequester(mockLocalHostEntry);
  render(
    <QueryClientProvider client={queryClient}>
      <BotTestRunnerHost>
        <TooltipProvider>
          <ChatExpansionTestProviders tileInstanceId="tile-1">
            <BotThreadsView
              level2={mountLevel2}
              hostId="host-1"
              channelTitle="Tracy"
              onBack={mocks.back}
            />
          </ChatExpansionTestProviders>
        </TooltipProvider>
      </BotTestRunnerHost>
    </QueryClientProvider>,
  );
}

function listed(): ReadonlyArray<string | null> {
  return screen
    .getAllByTestId("bot-thread-card")
    .map((card) => card.getAttribute("data-thread-id"));
}

function card(threadId: string): HTMLElement {
  const found = screen
    .getAllByTestId("bot-thread-card")
    .find((li) => li.getAttribute("data-thread-id") === threadId);
  if (found === undefined) throw new Error(`no card for ${threadId}`);
  return found;
}

/** What an IntersectionObserver was built with, and what it watches. */
type ObserverOptions = { root: Element | null; rootMargin: string | undefined };
type ObserverEntries = ReadonlyArray<{
  target: Element;
  isIntersecting: boolean;
}>;

/** A controllable IntersectionObserver: nothing fires until the case says so. */
class FakeIntersectionObserver {
  static all: FakeIntersectionObserver[] = [];
  readonly targets = new Set<Element>();
  readonly options: ObserverOptions;
  constructor(
    private readonly callback: (entries: ObserverEntries) => void,
    init: IntersectionObserverInit | undefined,
  ) {
    this.options = {
      root: init?.root instanceof Element ? init.root : null,
      rootMargin: init?.rootMargin,
    };
    FakeIntersectionObserver.all.push(this);
  }
  observe(target: Element): void {
    this.targets.add(target);
  }
  unobserve(target: Element): void {
    this.targets.delete(target);
  }
  disconnect(): void {
    this.targets.clear();
  }
  fire(entries: ObserverEntries): void {
    this.callback(entries);
  }
}

/** The observers watching `target`: the near one has a margin, the view one none. */
function observersOf(
  target: Element,
  kind: "near" | "view",
): FakeIntersectionObserver[] {
  return FakeIntersectionObserver.all.filter(
    (observer) =>
      observer.targets.has(target) &&
      (observer.options.rootMargin !== undefined) === (kind === "near"),
  );
}

/** Tells the observers of `kind` on `target` that it is (not) intersecting. */
function intersectTarget(
  target: Element,
  kind: "near" | "view",
  isIntersecting: boolean,
): void {
  const observers = observersOf(target, kind);
  expect(observers.length).toBeGreaterThan(0);
  act(() => {
    for (const observer of observers) {
      observer.fire([{ target, isIntersecting }]);
    }
  });
}

/** The mark under the reply a full card's reading would acknowledge. */
function readMark(threadId: string): HTMLElement {
  return within(card(threadId)).getByTestId("bot-chat-transcript-mark");
}

/** Brings a card near the page's view and waits for its thread to draw. */
async function revealFull(threadId: string): Promise<HTMLElement> {
  intersectTarget(card(threadId), "near", true);
  await waitFor(() =>
    expect(card(threadId).getAttribute("data-full")).toBe("true"),
  );
  return card(threadId);
}

/** The thread's replies, `reply 1` to `reply count`, and the host's list saying so. */
function withReplies(
  botId: string,
  threadId: string,
  texts: string[],
  lastReplyAt: number,
): void {
  mocks.replies[threadId] = texts;
  mocks.hosted[botId].threads = mocks.hosted[botId].threads.map((summary) =>
    summary.threadId === threadId
      ? { ...summary, replyCount: texts.length, lastReplyAt }
      : summary,
  );
}

function replyTexts(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `reply ${String(index + 1)}`,
  );
}

/** The reply texts a card draws, in order. */
function drawnReplies(threadId: string): string[] {
  return within(card(threadId))
    .queryAllByText(/^reply \d+$/)
    .map((node) => node.textContent);
}

/** Element's own scrollIntoView before a case replaced it, read by key. */
let originalScrollIntoView: PropertyDescriptor | undefined;

beforeEach(() => {
  originalScrollIntoView = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollIntoView",
  );
  vi.clearAllMocks();
  mountLevel2 = null;
  mocks.bots = [bot(TRACY, "Tracy"), bot(TEAM, "Team Tracy")];
  mocks.botList = "listed";
  mocks.refetchBots.mockResolvedValue(undefined);
  mocks.hosted = {};
  mocks.unsupported.clear();
  mocks.posts = {};
  mocks.channels = {};
  mocks.unread = {};
  mocks.writes = [];
  mocks.reads = [];
  mocks.replies = {};
  mocks.replyRows = {};
  mocks.turns = [];
  mocks.threadSessions = {};
  mocks.advances = [];
  FakeIntersectionObserver.all = [];
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  signInViewer("user-1");
  useBotThreadFoldStore.setState({ unfolded: {} });
  useBotTabLandingStore.setState({ byBotId: {} });
  useSelectionAuthorityStore.setState({ effectiveHostId: "host-1" });
  useTracySurfaceStore.setState({
    open: false,
    hostId: null,
    botId: null,
    visitedBotIds: [],
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalScrollIntoView === undefined) {
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  } else {
    Object.defineProperty(
      Element.prototype,
      "scrollIntoView",
      originalScrollIntoView,
    );
  }
  resetBotFailedRequestSupport();
});

describe("<BotThreadsView />", () => {
  beforeEach(() => {
    mocks.hosted[TRACY] = script(
      [thread(TRACY, "tracy-old", 1_000), thread(TRACY, "tracy-other", 5_000)],
      {
        "tracy-old": FOLLOWING,
        "tracy-other": { state: "unfollowed", reason: "manual" },
      },
    );
    mocks.hosted[TEAM] = script(
      [thread(TEAM, "team-new", 3_000), thread(TEAM, "team-quiet", null)],
      { "team-new": FOLLOWING, "team-quiet": FOLLOWING },
    );
  });

  it("asks for the whole thread list of each bot and for the follows, read cursors and levels by bot id alone", async () => {
    mount();
    await waitFor(() =>
      expect(listed()).toEqual(["team-new", "tracy-old", "team-quiet"]),
    );

    // The distinct params each read was sent, exactly: a refetch repeats them.
    const sentTo = (method: string): Set<string> =>
      new Set(
        mocks.reads
          .filter((read) => read.method === method)
          .map((read) => JSON.stringify(read.params)),
      );
    for (const method of [
      "bot.threadFollow.read",
      "bot.readCursor.read",
      "bot.notificationLevel.read",
    ]) {
      expect(sentTo(method)).toEqual(
        new Set([
          JSON.stringify({ botId: TRACY }),
          JSON.stringify({ botId: TEAM }),
        ]),
      );
    }
    expect(sentTo("bot.thread.list")).toEqual(
      new Set([
        JSON.stringify({ botId: TRACY, limit: null, cursor: null }),
        JSON.stringify({ botId: TEAM, limit: null, cursor: null }),
      ]),
    );
  });

  it("lists the followed threads of every bot as cards, newest reply first, each with its bot, its post's first line, its replies, its new replies and its unread count, until the card is near the view", async () => {
    mocks.posts[TEAM] = {
      [conversationRequestMessageId("req-team-new")]:
        "Nightly train: what failed?\nThe Windows leg.",
    };
    mocks.hosted[TEAM].cursors = {
      cursors: { "team-new": { messageId: "m-1", seq: 2_000 } },
      latest: { "team-new": { messageId: "m-2", seq: 3_000 } },
    };
    mocks.hosted[TRACY].cursors = {
      cursors: { "tracy-old": { messageId: "m-3", seq: 1_000 } },
      latest: { "tracy-old": { messageId: "m-3", seq: 1_000 } },
    };
    mocks.unread = { "team-new": 2 };
    mount();

    await waitFor(() =>
      expect(listed()).toEqual(["team-new", "tracy-old", "team-quiet"]),
    );
    const team = within(card("team-new"));
    expect(team.getByTestId("bot-thread-card-channel-link").textContent).toBe(
      "Team Tracy",
    );
    expect(team.getByTestId("bot-thread-card-summary").textContent).toContain(
      "Nightly train: what failed?",
    );
    expect(
      team.getByTestId("bot-thread-card-summary").textContent,
    ).not.toContain("The Windows leg.");
    expect(
      team.getByTestId("bot-thread-card-summary-replies").textContent,
    ).toBe("2 replies");
    expect(team.getByTestId("bot-thread-row-new-replies")).toBeTruthy();
    expect(team.getByTestId("bot-thread-row-unread-count").textContent).toBe(
      "2 unread",
    );
    const tracy = within(card("tracy-old"));
    expect(tracy.getByTestId("bot-thread-card-channel-link").textContent).toBe(
      "Tracy",
    );
    // Its post is older than what the channel has loaded.
    expect(tracy.getByTestId("bot-thread-card-summary").textContent).toContain(
      "Thread",
    );
    expect(tracy.queryByTestId("bot-thread-row-new-replies")).toBeNull();
    expect(tracy.queryByTestId("bot-thread-row-unread-count")).toBeNull();
    expect(card("team-new").getAttribute("data-full")).toBe("false");
  });

  it("marks a thread a call opened with a phone, and draws none on a plain thread", async () => {
    mocks.hosted[TEAM] = script(
      [callThread(TEAM, "team-call", 4_000), thread(TEAM, "team-new", 3_000)],
      { "team-call": FOLLOWING, "team-new": FOLLOWING },
    );
    mount();
    await waitFor(() => expect(listed()).toContain("team-call"));

    const phone = within(card("team-call")).getByTestId("bot-thread-row-call");
    expect(phone.getAttribute("role")).toBe("img");
    expect(phone.getAttribute("aria-label")).toBe("Call");
    expect(
      within(card("team-new")).queryByTestId("bot-thread-row-call"),
    ).toBeNull();
  });

  it("mounts a card's thread only once it is within a screen of the page's view, and keeps it, watching the card for nothing else", async () => {
    mocks.posts[TEAM] = {
      [conversationRequestMessageId("req-team-new")]: "Nightly train",
    };
    withReplies(TEAM, "team-new", replyTexts(2), 3_000);
    mount();
    await waitFor(() => expect(listed()).toContain("team-new"));

    const target = card("team-new");
    const scroller = screen.getByTestId("bot-threads-scroll");
    // Near: a screen's margin around the page's own scroller. The card in
    // view reads nothing, so nothing watches it for that.
    expect(observersOf(target, "near").map((o) => o.options)).toEqual([
      { root: scroller, rootMargin: "100% 0px" },
    ]);
    expect(observersOf(target, "view")).toEqual([]);
    expect(within(target).getByTestId("bot-thread-card-summary")).toBeTruthy();
    expect(within(target).queryByTestId("bot-thread-anchor")).toBeNull();
    expect(within(target).queryByTestId("bot-thread-composer")).toBeNull();

    await revealFull("team-new");
    expect(within(target).queryByTestId("bot-thread-card-summary")).toBeNull();
    expect(within(target).getByTestId("bot-thread-anchor")).toBeTruthy();

    // Once near, nothing watches the card, so nothing can take its thread
    // back.
    expect(
      FakeIntersectionObserver.all.filter((o) => o.targets.has(target)),
    ).toEqual([]);
    expect(card("team-new").getAttribute("data-full")).toBe("true");
  });

  it("draws a near card in full: the origin post, the replies through the real transcript and a reply box", async () => {
    mocks.posts[TEAM] = {
      [conversationRequestMessageId("req-team-new")]:
        "Nightly train: what failed?",
    };
    withReplies(TEAM, "team-new", replyTexts(2), 3_000);
    mount();
    await waitFor(() => expect(listed()).toContain("team-new"));

    const full = within(await revealFull("team-new"));

    expect(full.getByTestId("bot-thread-anchor").textContent).toContain(
      "Nightly train: what failed?",
    );
    expect(full.getByTestId("bot-thread-reply-count-open").textContent).toBe(
      "2 replies",
    );
    expect(await full.findByText("reply 1")).toBeTruthy();
    expect(full.getByText("reply 2")).toBeTruthy();
    expect(full.getByTestId("bot-chat-transcript-flow")).toBeTruthy();
    expect(full.getByTestId("bot-thread-composer")).toBeTruthy();
  });

  it("opens the bot's channel landed on the origin post, with no thread panel, from the channel line", async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(listed()).toContain("team-new"));

    await user.click(
      within(card("team-new")).getByTestId("bot-thread-card-channel-link"),
    );

    expect(useBotTabLandingStore.getState().byBotId).toEqual({
      [TEAM]: {
        kind: "thread",
        threadId: null,
        messageId: conversationRequestMessageId("req-team-new"),
      },
    });
    expect(useTracySurfaceStore.getState()).toMatchObject({
      open: true,
      hostId: "host-1",
    });
    expect(mocks.activateTabIntent).toHaveBeenCalledTimes(1);
    expect(mocks.activateTabIntent).toHaveBeenCalledWith({
      kind: "tracy",
      botId: TEAM,
    });
  });

  it("opens the bot's channel with the thread's panel beside it from the menu's Open thread", async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(listed()).toContain("team-new"));

    await user.click(
      within(card("team-new")).getByTestId("bot-thread-row-menu"),
    );
    await user.click(await screen.findByTestId("bot-thread-row-open"));

    expect(useBotTabLandingStore.getState().byBotId).toEqual({
      [TEAM]: { kind: "thread", threadId: "team-new", messageId: null },
    });
    expect(mocks.activateTabIntent).toHaveBeenCalledWith({
      kind: "tracy",
      botId: TEAM,
    });
  });

  it("shows every message of a thread of six: the origin and its five replies, with no fold", async () => {
    withReplies(TEAM, "team-new", replyTexts(5), 3_000);
    mount();
    await waitFor(() => expect(listed()).toContain("team-new"));

    const full = within(await revealFull("team-new"));

    await full.findByText("reply 5");
    expect(drawnReplies("team-new")).toEqual(replyTexts(5));
    expect(full.queryByTestId("bot-chat-transcript-unfold")).toBeNull();
    expect(full.getByTestId("bot-thread-anchor")).toBeTruthy();
  });

  it("folds a longer thread to the origin, a line counting the hidden replies and the last two replies, and the line shows the rest in place and keeps them shown", async () => {
    const user = userEvent.setup();
    withReplies(TEAM, "team-new", replyTexts(8), 3_000);
    mount();
    await waitFor(() => expect(listed()).toContain("team-new"));

    const full = within(await revealFull("team-new"));

    const unfold = await full.findByTestId("bot-chat-transcript-unfold");
    expect(unfold.textContent).toBe("Show 6 more replies");
    expect(full.getByTestId("bot-thread-anchor")).toBeTruthy();
    expect(drawnReplies("team-new")).toEqual(["reply 7", "reply 8"]);

    await user.click(unfold);

    await waitFor(() =>
      expect(drawnReplies("team-new")).toEqual(replyTexts(8)),
    );
    expect(full.queryByTestId("bot-chat-transcript-unfold")).toBeNull();
    expect(useBotThreadFoldStore.getState().unfolded).toEqual({
      "team-new": true,
    });
  });

  it("counts the followed threads with new replies in a pill and jumps to the next one below the page's top, else the first", async () => {
    const user = userEvent.setup();
    mocks.hosted[TEAM] = script(
      [thread(TEAM, "team-a", 5_000), thread(TEAM, "team-b", 4_000)],
      { "team-a": FOLLOWING, "team-b": FOLLOWING },
    );
    mocks.hosted[TRACY] = script([thread(TRACY, "tracy-c", 3_000)], {
      "tracy-c": FOLLOWING,
    });
    mocks.hosted[TEAM].cursors = {
      cursors: {},
      latest: {
        "team-a": { messageId: "m-a", seq: 5_000 },
        "team-b": { messageId: "m-b", seq: 4_000 },
      },
    };
    mocks.hosted[TRACY].cursors = {
      cursors: { "tracy-c": { messageId: "m-c", seq: 3_000 } },
      latest: { "tracy-c": { messageId: "m-c", seq: 3_000 } },
    };
    // jsdom has no scrollIntoView; afterEach puts the prototype back.
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      scrolled.push(this);
    };
    mount();
    await waitFor(() =>
      expect(listed()).toEqual(["team-a", "team-b", "tracy-c"]),
    );

    const pill = await screen.findByTestId("bot-threads-unread-pill");
    expect(pill.textContent).toBe("2 unread threads");
    // jsdom lays nothing out: place the cards against the page's top by hand.
    const place = (element: HTMLElement, top: number): void => {
      vi.spyOn(element, "getBoundingClientRect").mockReturnValue(
        new DOMRect(0, top, 100, 100),
      );
    };
    place(screen.getByTestId("bot-threads-scroll"), 0);
    place(card("team-a"), -300);
    place(card("team-b"), 200);
    place(card("tracy-c"), 600);

    await user.click(pill);
    expect(scrolled).toEqual([card("team-b")]);

    // Every unread card now starts above the page's top: back to the first.
    place(card("team-b"), -100);
    await user.click(pill);
    expect(scrolled).toEqual([card("team-b"), card("team-a")]);
  });

  it("draws no pill once every followed thread's replies are read", async () => {
    mocks.hosted[TEAM].cursors = {
      cursors: { "team-new": { messageId: "m-2", seq: 3_000 } },
      latest: { "team-new": { messageId: "m-2", seq: 3_000 } },
    };
    mocks.hosted[TRACY].cursors = {
      cursors: { "tracy-old": { messageId: "m-3", seq: 1_000 } },
      latest: { "tracy-old": { messageId: "m-3", seq: 1_000 } },
    };
    mount();
    await waitFor(() => expect(listed()).toContain("team-new"));
    await waitFor(() =>
      expect(
        mocks.reads.filter((read) => read.method === "bot.readCursor.read"),
      ).toHaveLength(2),
    );

    expect(
      within(card("team-new")).queryByTestId("bot-thread-row-new-replies"),
    ).toBeNull();
    expect(screen.queryByTestId("bot-threads-unread-pill")).toBeNull();
  });

  it("names who is in a thread on its channel line: Just you when only the viewer wrote, the names when anyone else did", async () => {
    mocks.hosted[TRACY] = script([], {});
    mocks.hosted[TEAM] = script(
      [
        {
          ...thread(TEAM, "team-solo", 4_000),
          replyParticipants: [{ kind: "person", userId: "user-1" }],
        },
        {
          ...thread(TEAM, "team-mixed", 3_000),
          replyParticipants: [{ kind: "bot" }],
        },
      ],
      { "team-solo": FOLLOWING, "team-mixed": FOLLOWING },
    );
    mount();
    await waitFor(() => expect(listed()).toEqual(["team-solo", "team-mixed"]));

    expect(
      within(card("team-solo")).getByTestId("bot-thread-card-participants")
        .textContent,
    ).toBe("Just you");
    expect(
      within(card("team-mixed")).getByTestId("bot-thread-card-participants")
        .textContent,
    ).toBe("Olive Owner, Team Tracy");
  });

  it("reads a card's replies only once its newest reply has stayed in view, never for the card's line or post in view", async () => {
    mocks.hosted[TRACY] = script([], {});
    mocks.hosted[TEAM] = script(
      [thread(TEAM, "team-a", 5_000), thread(TEAM, "team-b", 4_000)],
      { "team-a": FOLLOWING, "team-b": FOLLOWING },
    );
    mocks.hosted[TEAM].cursors = {
      cursors: {
        "team-a": { messageId: "m-0", seq: 1_000 },
        "team-b": { messageId: "m-0", seq: 1_000 },
      },
      latest: {
        "team-a": { messageId: "team-a-reply-2", seq: 5_000 },
        "team-b": { messageId: "team-b-reply-2", seq: 4_000 },
      },
    };
    withReplies(TEAM, "team-a", replyTexts(2), 5_000);
    withReplies(TEAM, "team-b", replyTexts(2), 4_000);
    mount();
    await waitFor(() => expect(listed()).toEqual(["team-a", "team-b"]));

    // Both summaries come near together and draw their threads in full.
    await within(await revealFull("team-a")).findByText("reply 2");
    await within(await revealFull("team-b")).findByText("reply 2");
    // The mark sits under the newest reply, watched in the page's view alone.
    expect(readMark("team-a").getAttribute("data-mark-message-id")).toBe(
      "team-a-reply-2",
    );
    expect(
      observersOf(readMark("team-a"), "view").map((o) => o.options),
    ).toEqual([
      { root: screen.getByTestId("bot-threads-scroll"), rootMargin: undefined },
    ]);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    intersectTarget(readMark("team-a"), "view", true);
    intersectTarget(readMark("team-b"), "view", true);
    // The card's read hold is a second.
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(mocks.advances).toEqual([]);
    // The second card's newest reply leaves the view before the second is up.
    intersectTarget(readMark("team-b"), "view", false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    vi.useRealTimers();

    await waitFor(() =>
      expect(mocks.advances).toEqual([
        {
          botId: TEAM,
          conversationId: "team-a",
          messageId: "team-a-reply-2",
          seq: 5_000,
        },
      ]),
    );
  });

  it("acknowledges a newer reply only once it is drawn and has stayed in view itself, not on the strength of the reply seen before it", async () => {
    mocks.hosted[TEAM].cursors = {
      cursors: { "team-new": { messageId: "team-new-reply-1", seq: 2_000 } },
      latest: { "team-new": { messageId: "team-new-reply-2", seq: 3_000 } },
    };
    withReplies(TEAM, "team-new", replyTexts(2), 3_000);
    mount();
    await waitFor(() => expect(listed()).toContain("team-new"));
    await within(await revealFull("team-new")).findByText("reply 2");

    // The tail is read.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    intersectTarget(readMark("team-new"), "view", true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    vi.useRealTimers();
    await waitFor(() => expect(mocks.advances).toHaveLength(1));

    // The host names a newer reply the thread's session has not brought in.
    mocks.hosted[TEAM].cursors = {
      ...mocks.hosted[TEAM].cursors,
      latest: { "team-new": { messageId: "team-new-reply-3", seq: 4_000 } },
    };
    await act(() => queryClient.invalidateQueries());
    await waitFor(() =>
      expect(
        within(card("team-new")).queryByTestId("bot-chat-transcript-mark"),
      ).toBeNull(),
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    vi.useRealTimers();
    expect(mocks.advances).toHaveLength(1);

    // The reply arrives: its own mark, held anew.
    const session = mocks.threadSessions["team-new"].store;
    act(() => {
      session.setState({
        messages: [
          ...session.getState().messages,
          postRow("team-new-reply-3", "reply 3"),
        ],
      });
    });
    await within(card("team-new")).findByText("reply 3");
    expect(readMark("team-new").getAttribute("data-mark-message-id")).toBe(
      "team-new-reply-3",
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    intersectTarget(readMark("team-new"), "view", true);
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(mocks.advances).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    vi.useRealTimers();

    await waitFor(() =>
      expect(mocks.advances.at(-1)).toEqual({
        botId: TEAM,
        conversationId: "team-new",
        messageId: "team-new-reply-3",
        seq: 4_000,
      }),
    );
    expect(mocks.advances).toHaveLength(2);
  });

  it("opens a reply's turn from its receipt in a card, landed on the send that wrote the reply", async () => {
    const user = userEvent.setup();
    const reply = botReply({
      messageId: "team-new-bot-1",
      text: "The Windows leg failed.",
      timestamp: 3_000,
    });
    mocks.replyRows["team-new"] = [reply];
    mocks.turns = [
      turnRef({
        chatId: "session-team-new",
        turnId: "turn-1",
        userMessageId: "prompt-1",
        threadId: "team-new",
        startedAt: 2_000,
        endedAt: 3_000,
        summary: "Read 1 file",
        messageIds: [reply.messageId],
        requestIds: [],
      }),
    ];
    mount();
    await waitFor(() => expect(listed()).toContain("team-new"));
    const full = within(await revealFull("team-new"));

    await user.click(await full.findByTestId("bot-turn-receipt"));

    expect(useBotTabLandingStore.getState().byBotId).toEqual({
      [TEAM]: {
        kind: "chat",
        chatId: "session-team-new",
        messageId: "prompt-1",
        sendPostId: reply.messageId,
      },
    });
  });

  it("drops a thread from the list when Unfollow is chosen from its menu", async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() =>
      expect(listed()).toEqual(["team-new", "tracy-old", "team-quiet"]),
    );

    await user.click(
      within(card("tracy-old")).getByTestId("bot-thread-row-menu"),
    );
    await user.click(await screen.findByTestId("bot-thread-row-unfollow"));

    await waitFor(() => expect(listed()).toEqual(["team-new", "team-quiet"]));
    expect(mocks.writes).toEqual([
      { botId: TRACY, threadId: "tracy-old", state: "unfollowed" },
    ]);
  });
});

describe("<BotThreadsView /> header", () => {
  it("goes back to the tab's channel when Back to Tracy is clicked", async () => {
    const user = userEvent.setup();
    mocks.hosted[TRACY] = script([], {});
    mocks.hosted[TEAM] = script([], {});
    mount();

    const back = screen.getByRole("button", { name: "Back to Tracy" });
    await user.click(back);

    expect(mocks.back).toHaveBeenCalledTimes(1);
  });

  it("draws no back control beside a level 2 column, whose channel row is the way back", () => {
    mountLevel2 = { column: 256 };
    mocks.hosted[TRACY] = script([], {});
    mocks.hosted[TEAM] = script([], {});
    mount();

    expect(screen.queryByTestId("bot-threads-back")).toBeNull();
  });

  it("draws the back control at every width of the menu form", () => {
    mountLevel2 = "menu";
    mocks.hosted[TRACY] = script([], {});
    mocks.hosted[TEAM] = script([], {});
    mount();

    expect(screen.getByTestId("bot-threads-back").className).not.toContain(
      "@3xl",
    );
  });
});

describe("<BotThreadsView /> before the bots are listed", () => {
  it("shows its loading state while the bot list is read, not the empty state", () => {
    mocks.botList = "pending";
    mount();

    expect(screen.getByTestId("bot-threads-loading")).toBeTruthy();
    expect(screen.queryByText("No threads yet.")).toBeNull();
  });

  it("says the read failed when the bot list does, and Retry reads it again", async () => {
    const user = userEvent.setup();
    mocks.botList = "failed";
    mount();

    const failure = screen.getByTestId("bot-threads-error");
    expect(failure.textContent).toContain("Couldn't load your threads.");
    expect(failure.className).toContain("text-destructive");
    expect(screen.queryByText("No threads yet.")).toBeNull();
    await user.click(within(failure).getByRole("button", { name: "Retry" }));

    expect(mocks.refetchBots).toHaveBeenCalledTimes(1);
  });
});

describe("<BotThreadsView /> with nothing to list", () => {
  it("says there are no threads yet when the person follows none", async () => {
    mocks.hosted[TRACY] = script([thread(TRACY, "tracy-a", 1_000)], {});
    mocks.hosted[TEAM] = script([], {});
    mount();

    expect(await screen.findByText("No threads yet.")).toBeTruthy();
  });

  it("says once that the host cannot list the threads, where it does not read follows", () => {
    mocks.unsupported.add("bot.threadFollow.read");
    mount();

    expect(
      screen.getAllByText("This host can't list your threads."),
    ).toHaveLength(1);
    expect(screen.queryByTestId("bot-thread-card")).toBeNull();
  });
});
