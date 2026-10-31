/**
 * Threads in place of a bot's channel (Tracy Bots T103, decision 149): every
 * thread the person follows across the bots the column lists, newest reply
 * first, each named by its bot, with its new-replies mark and unread count;
 * choosing one asks its bot's channel to land it, and Unfollow drops it. The real
 * view, fan-out hook, follow mutation, landing store and Tracy surface store run
 * over a real HostClient and QueryClient whose host answers each bot's thread
 * list, follows, read cursors and levels from the case's script. Only the
 * channels' sessions (the posts are read from), the notification indicators
 * and the tab navigation are replaced.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
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
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type {
  BotNotificationLevel,
  BotReadCursorReadResponse,
  BotRecord,
  BotThreadFollow,
  BotThreadFollowSetRequest,
} from "@traycer/protocol/host/bot/schemas";
import { conversationRequestMessageId } from "@traycer/protocol/persistence/epic/messages";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import { chatSessionWithPosts } from "./bot-channel-rows-test-support";

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
  /** Unread notifications by thread id, as the indicators read them. */
  unread: {} as Record<string, number>,
  writes: [] as BotThreadFollowSetRequest[],
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
  ): ChatSessionStoreHandle | null => {
    if (!Object.hasOwn(mocks.posts, botId)) return null;
    if (!Object.hasOwn(mocks.channels, botId)) {
      mocks.channels[botId] = chatSessionWithPosts(mocks.posts[botId]);
    }
    return mocks.channels[botId];
  },
}));
vi.mock("@/lib/chats/chat-serving-witness", () => ({
  useChatServingHostId: () => "host-1",
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
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

function mount(): void {
  const queryClient = new QueryClient({
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
        "bot.thread.list": ({ botId }) => ({
          threads: mocks.hosted[botId].threads,
          trunkCostUsd: null,
          threadAnchors: null,
        }),
        "bot.threadFollow.read": ({ botId }) => ({
          follows: { ...mocks.hosted[botId].follows },
        }),
        "bot.threadFollow.set": (params) => {
          mocks.writes.push(params);
          const follow: BotThreadFollow = {
            state: params.state,
            reason: "manual",
          };
          mocks.hosted[params.botId].follows[params.threadId] = follow;
          return { follow };
        },
        "bot.readCursor.read": ({ botId }) => mocks.hosted[botId].cursors,
        "bot.notificationLevel.read": ({ botId }) => ({
          levels: mocks.hosted[botId].levels,
        }),
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  mocks.client = spine.createRequester(mockLocalHostEntry);
  render(
    <QueryClientProvider client={queryClient}>
      <BotThreadsView
        hostId="host-1"
        channelTitle="Tracy"
        onBack={mocks.back}
      />
    </QueryClientProvider>,
  );
}

function listed(): ReadonlyArray<string | null> {
  return screen
    .getAllByTestId("bot-thread-list-item")
    .map((item) => item.getAttribute("data-thread-id"));
}

function item(threadId: string): HTMLElement {
  const found = screen
    .getAllByTestId("bot-thread-list-item")
    .find((li) => li.getAttribute("data-thread-id") === threadId);
  if (found === undefined) throw new Error(`no row for ${threadId}`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.bots = [bot(TRACY, "Tracy"), bot(TEAM, "Team Tracy")];
  mocks.botList = "listed";
  mocks.refetchBots.mockResolvedValue(undefined);
  mocks.hosted = {};
  mocks.unsupported.clear();
  mocks.posts = {};
  mocks.channels = {};
  mocks.unread = {};
  mocks.writes = [];
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

  it("lists the followed threads of every bot, newest reply first, each with its bot, its post, its new replies and its unread count", async () => {
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
    const team = item("team-new");
    expect(within(team).getByTestId("bot-thread-row-bot").textContent).toBe(
      "Team Tracy",
    );
    expect(
      within(team).getByRole("button", { name: /Nightly train: what failed\?/ })
        .textContent,
    ).not.toContain("The Windows leg.");
    expect(team.textContent).toContain("2 replies");
    expect(within(team).getByTestId("bot-thread-row-new-replies")).toBeTruthy();
    expect(
      within(team).getByTestId("bot-thread-row-unread-count").textContent,
    ).toBe("2 unread");
    const tracy = item("tracy-old");
    expect(within(tracy).getByTestId("bot-thread-row-bot").textContent).toBe(
      "Tracy",
    );
    // Its post is older than what the channel has loaded.
    expect(within(tracy).getByTestId("bot-thread-row").textContent).toContain(
      "Thread",
    );
    expect(
      within(tracy).queryByTestId("bot-thread-row-new-replies"),
    ).toBeNull();
    expect(
      within(tracy).queryByTestId("bot-thread-row-unread-count"),
    ).toBeNull();
  });

  it("asks the thread's bot's channel to land it beside it, and opens the surface on that channel", async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(listed()).toContain("team-new"));

    await user.click(within(item("team-new")).getByTestId("bot-thread-row"));

    expect(useBotTabLandingStore.getState().byBotId).toEqual({
      [TEAM]: { kind: "thread", threadId: "team-new", messageId: null },
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

  it("drops a thread from the list when Unfollow is chosen from its menu", async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() =>
      expect(listed()).toEqual(["team-new", "tracy-old", "team-quiet"]),
    );

    await user.click(
      within(item("tracy-old")).getByTestId("bot-thread-row-menu"),
    );
    await user.click(await screen.findByTestId("bot-thread-row-unfollow"));

    await waitFor(() => expect(listed()).toEqual(["team-new", "team-quiet"]));
    expect(mocks.writes).toEqual([
      { botId: TRACY, threadId: "tracy-old", state: "unfollowed" },
    ]);
  });
});

describe("<BotThreadsView /> header", () => {
  it("goes back to the tab's channel from its back control, which only a tab too narrow for the column draws", async () => {
    const user = userEvent.setup();
    mocks.hosted[TRACY] = script([], {});
    mocks.hosted[TEAM] = script([], {});
    mount();

    const back = screen.getByRole("button", { name: "Back to Tracy" });
    expect(back.className).toContain("@3xl:hidden");
    await user.click(back);

    expect(mocks.back).toHaveBeenCalledTimes(1);
  });
});

describe("<BotThreadsView /> before the bots are listed", () => {
  it("shows its loading state while the bot list is read, not the empty state", () => {
    mocks.botList = "pending";
    mount();

    expect(screen.getByTestId("bot-threads-loading")).toBeTruthy();
    expect(
      screen.queryByText("Threads you take part in appear here."),
    ).toBeNull();
  });

  it("says the read failed when the bot list does, and Retry reads it again", async () => {
    const user = userEvent.setup();
    mocks.botList = "failed";
    mount();

    const failure = screen.getByTestId("bot-threads-error");
    expect(failure.textContent).toContain("Couldn't load your threads.");
    expect(
      screen.queryByText("Threads you take part in appear here."),
    ).toBeNull();
    await user.click(within(failure).getByRole("button", { name: "Retry" }));

    expect(mocks.refetchBots).toHaveBeenCalledTimes(1);
  });
});

describe("<BotThreadsView /> with nothing to list", () => {
  it("says threads the person takes part in appear here when they follow none", async () => {
    mocks.hosted[TRACY] = script([thread(TRACY, "tracy-a", 1_000)], {});
    mocks.hosted[TEAM] = script([], {});
    mount();

    expect(
      await screen.findByText("Threads you take part in appear here."),
    ).toBeTruthy();
  });

  it("says once that the host cannot list the threads, where it does not read follows", () => {
    mocks.unsupported.add("bot.threadFollow.read");
    mount();

    expect(
      screen.getAllByText("This host can't list your threads."),
    ).toHaveLength(1);
    expect(screen.queryByTestId("bot-thread-list-item")).toBeNull();
  });
});
