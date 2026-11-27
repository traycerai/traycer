/**
 * A file dropped on a Threads card, through the REAL `BotThreadsView`
 * and its cards: a card is always a drop zone, its box takes the drop once the
 * card is near the page's view, and a card with no box refuses it. The
 * fixtures, the mounted tree, the controllable IntersectionObserver and the
 * per-case lifecycle are in `bot-threads-view-harness.tsx`.
 */
import {
  botMentionHostClientMock,
  emptyBotMentionHostListsMock,
} from "@/components/bots/__tests__/bot-mention-host-test-support";
import { act, screen, within } from "@testing-library/react";
import { toast } from "sonner";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { conversationRequestMessageId } from "@traycer/protocol/persistence/epic/messages";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import type { TabNavigationIntent } from "@/lib/tab-navigation/intents";
import { DROP_AFTER_POST_GONE } from "@/components/bots/bot-drop-lines";
import { FILE_DROP_OVERLAY_CONTENT } from "@/components/home/composer/composer-drop-overlay-content";
import { BOT_CONVERSATION_IMAGES_VERSION } from "@/hooks/bots/use-bot-send-version";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import { resetLandingImageBudgetReservationsForTesting } from "@/lib/composer/landing-image-budget";
import { negotiateBotSend } from "@/components/bots/__tests__/bot-failed-request-test-support";
import {
  dragEnter,
  dragOver,
  dropOn,
  fileReferenceTransfer,
  filesTransfer,
  gatedImage,
  imageFile,
  linkTransfer,
  noticeIds,
  noticeMessages,
  spyOnNotices,
  textTransfer,
} from "@/components/bots/__tests__/bot-drop-test-support";
import {
  chatSessionWithPosts,
  chatSessionWithThreadRows,
  postRow,
} from "./bot-channel-rows-test-support";
import { installLegendListTestClock } from "@/components/chat/__tests__/legend-list-test-environment";
import {
  settleLong,
  until,
} from "@/components/bots/__tests__/bot-drop-reading-support";
import { mocks } from "./bot-threads-view-state";
import { intersectTarget } from "@/components/bots/__tests__/bot-read-observer-test-support";
import {
  card,
  FOLLOWING,
  drainEditorTimersAtTeardown,
  installBotThreadsViewCaseLifecycle,
  mount,
  queryClient,
  script,
  TEAM,
  thread,
  TRACY,
} from "./bot-threads-view-harness";

vi.mock(
  "@/hooks/host/use-host-client-for-host-id",
  () => botMentionHostClientMock,
);
vi.mock(
  "@/hooks/bots/use-environment-host-lists-query",
  () => emptyBotMentionHostListsMock,
);

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
        // Each reply is written one second after the one before it, as the
        // host's read positions name them.
        mocks.replies[chatId].map((text, index) => ({
          ...postRow(`${chatId}-reply-${String(index + 1)}`, text),
          timestamp: (index + 1) * 1_000,
        })),
      );
      return mocks.threadSessions[chatId];
    }
    if (!Object.hasOwn(mocks.channels, botId)) {
      if (!Object.hasOwn(mocks.posts, botId)) return null;
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
vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({ resolvedTheme: "dark", themePreset: "neutral" }),
}));
vi.mock("@/components/layout/header/rate-limit-icon", () => ({
  RateLimitIconButton: () => null,
}));
vi.mock("@/components/resources/resource-monitor-popover", () => ({
  ResourceMonitorPopover: () => null,
}));
vi.mock("@/components/notifications/mobile-notifications-button", () => ({
  MobileNotificationsButton: () => null,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));
// An accepted navigation commits the channel it arrives at, as the tab's
// controller does once the path is acknowledged; the landing staged for it is
// then the channel's to spend.
vi.mock("@/lib/tab-navigation", async (importOriginal) => {
  const { useTracySurfaceStore: surfaceStore } =
    await import("@/stores/bots/tracy-surface-store");
  return {
    ...(await importOriginal<typeof import("@/lib/tab-navigation")>()),
    activateTabIntent: (_navigate: unknown, intent: TabNavigationIntent) => {
      mocks.activateTabIntent(intent);
      if (intent.kind === "tracy") {
        surfaceStore.getState().selectChannel(intent.botId);
      }
      return true;
    },
  };
});
vi.mock("@/hooks/host/use-connectable-host-ids", () => ({
  useConnectableHostIds: () => ({ hostIds: ["host-1"], resolved: true }),
}));

installBotThreadsViewCaseLifecycle();
drainEditorTimersAtTeardown();

const IMAGES_TITLE = FILE_DROP_OVERLAY_CONTENT.images.title;

let notices: MockInstance<typeof toast.info>;
let refusals: MockInstance<typeof toast.error>;

/** The team bot follows these threads; each has a post and two replies. */
function followThreads(...threadIds: ReadonlyArray<string>): void {
  mocks.hosted[TRACY] = script([], {});
  mocks.hosted[TEAM] = script(
    threadIds.map((threadId, index) => thread(TEAM, threadId, 3_000 - index)),
    Object.fromEntries(threadIds.map((threadId) => [threadId, FOLLOWING])),
  );
  mocks.posts[TEAM] = Object.fromEntries(
    threadIds.map((threadId) => [
      conversationRequestMessageId(`req-${threadId}`),
      `Post of ${threadId}`,
    ]),
  );
  for (const threadId of threadIds) {
    mocks.replies[threadId] = ["reply 1", "reply 2"];
  }
}

/** The thread's post is gone from the channel: its summary lists no anchor. */
function postGone(threadId: string): void {
  mocks.hosted[TEAM].threads = mocks.hosted[TEAM].threads.map((summary) =>
    summary.threadId === threadId ? { ...summary, anchor: null } : summary,
  );
}

async function listedCards(...threadIds: ReadonlyArray<string>): Promise<void> {
  await until(() =>
    expect(
      screen
        .getAllByTestId("bot-thread-card")
        .map((li) => li.getAttribute("data-thread-id")),
    ).toEqual(expect.arrayContaining([...threadIds])),
  );
}

/** Brings a card near the page's view and waits for its thread to draw. */
async function revealFull(threadId: string): Promise<void> {
  intersectTarget(card(threadId), "near", true);
  await until(() =>
    expect(card(threadId).getAttribute("data-full")).toBe("true"),
  );
}

/** The images a card's own box holds, by file name. */
function chipsIn(threadId: string): ReadonlyArray<string> {
  return within(card(threadId))
    .queryAllByRole("button", { name: /^Open Image#\d+:/ })
    .map((chip) =>
      (chip.getAttribute("aria-label") ?? "").replace(/^Open Image#\d+: /, ""),
    );
}

function overlaysIn(element: HTMLElement): number {
  return within(element).queryAllByText(IMAGES_TITLE).length;
}

function overlaysAnywhere(): number {
  return screen.queryAllByText(IMAGES_TITLE).length;
}

beforeEach(() => {
  installLegendListTestClock();
  localStorage.clear();
  installFreshIndexedDb();
  resetLandingImageBudgetReservationsForTesting();
  negotiateBotSend("host-1", BOT_CONVERSATION_IMAGES_VERSION);
  notices = spyOnNotices();
  refusals = vi.spyOn(toast, "error");
});

afterEach(() => {
  notices.mockRestore();
  refusals.mockRestore();
});

describe("<BotThreadsView /> a file dropped on a card that is not near yet", () => {
  it("shows no overlay, raises no notice, refuses the file, and lands it in no box", async () => {
    followThreads("team-a");
    mount();
    await listedCards("team-a");
    const transfer = filesTransfer(imageFile("shot.png"));

    dragEnter(card("team-a"), transfer);
    const over = dragOver(card("team-a"), transfer);
    const drop = dropOn(card("team-a"), transfer);

    expect(overlaysAnywhere()).toBe(0);
    expect(over).toEqual({ prevented: true, dropEffect: "none" });
    expect(drop).toEqual({ prevented: true, dropEffect: "none" });
    expect(notices).not.toHaveBeenCalled();
    expect(refusals).not.toHaveBeenCalled();
    await revealFull("team-a");
    expect(chipsIn("team-a")).toEqual([]);
  });
});

describe("<BotThreadsView /> a file dropped on a card whose post is gone", () => {
  it.each(["not near", "near"])(
    "refuses it with the post-gone notice, once per drop under one id, when the card is %s",
    async (nearness) => {
      followThreads("team-a");
      postGone("team-a");
      mount();
      await listedCards("team-a");
      if (nearness === "near") revealNear("team-a");
      const target = card("team-a");

      dragEnter(target, filesTransfer(imageFile("shot.png")));
      dragOver(target, filesTransfer(imageFile("shot.png")));
      expect(notices).not.toHaveBeenCalled();
      const first = dropOn(target, filesTransfer(imageFile("one.png")));
      const second = dropOn(target, fileReferenceTransfer("/tmp/two.png"));
      dropOn(target, textTransfer("some words"));
      dropOn(target, linkTransfer("https://example.com/a"));

      expect(first).toEqual({ prevented: true, dropEffect: "none" });
      expect(second).toEqual({ prevented: true, dropEffect: "none" });
      expect(noticeMessages(notices)).toEqual([
        DROP_AFTER_POST_GONE,
        DROP_AFTER_POST_GONE,
      ]);
      const [firstId, secondId] = noticeIds(notices);
      expect(firstId).toBeDefined();
      expect(secondId).toBe(firstId);
      expect(overlaysAnywhere()).toBe(0);
      expect(chipsIn("team-a")).toEqual([]);
      expect(refusals).not.toHaveBeenCalled();
    },
  );
});

/** A card whose post is gone is near the view: nothing draws in full, so only its latch is set. */
function revealNear(threadId: string): void {
  intersectTarget(card(threadId), "near", true);
}

describe("<BotThreadsView /> a file dropped on a card that is near", () => {
  it("shows the overlay over that card alone and lands the file in that card's box alone", async () => {
    followThreads("team-a", "team-b");
    mount();
    await listedCards("team-a", "team-b");
    await revealFull("team-a");
    await revealFull("team-b");
    const transfer = filesTransfer(imageFile("shot.png"));

    dragEnter(
      within(card("team-a")).getByTestId("bot-thread-anchor"),
      transfer,
    );

    expect(overlaysIn(card("team-a"))).toBe(1);
    expect(overlaysIn(card("team-b"))).toBe(0);
    dropOn(within(card("team-a")).getByTestId("bot-thread-anchor"), transfer);
    await until(() => expect(chipsIn("team-a")).toEqual(["shot.png"]));
    expect(chipsIn("team-b")).toEqual([]);
    expect(overlaysAnywhere()).toBe(0);
  });

  it("ends the overlay, and refuses a later drop, when the card stays and its box goes mid-drag", async () => {
    followThreads("team-a");
    mount();
    await listedCards("team-a");
    await revealFull("team-a");
    const transfer = filesTransfer(imageFile("shot.png"));
    dragEnter(card("team-a"), transfer);
    expect(overlaysIn(card("team-a"))).toBe(1);

    postGone("team-a");
    await act(() => queryClient.invalidateQueries());
    await until(() =>
      expect(card("team-a").getAttribute("data-full")).toBe("false"),
    );

    expect(overlaysAnywhere()).toBe(0);
    const later = dropOn(card("team-a"), transfer);
    expect(later).toEqual({ prevented: true, dropEffect: "none" });
    expect(noticeMessages(notices)).toEqual([DROP_AFTER_POST_GONE]);
    expect(chipsIn("team-a")).toEqual([]);
  });
});

describe("<BotThreadsView /> a file dropped on the unread banner", () => {
  const OLD = { messageId: "team-a-reply-1", seq: 1_000 };
  const NEW = { messageId: "team-a-reply-2", seq: 2_000 };

  async function mountWithBanner(): Promise<void> {
    followThreads("team-a", "team-b");
    mocks.hosted[TEAM].cursors = {
      cursors: { "team-a": OLD, "team-b": OLD },
      latest: { "team-a": NEW, "team-b": NEW },
    };
    mount();
    await listedCards("team-a", "team-b");
    await revealFull("team-a");
    await revealFull("team-b");
    await until(() =>
      expect(screen.getByTestId("bot-unread-banner")).toBeTruthy(),
    );
  }

  it("shows no card's overlay and lands nothing in any box when no overlay was up", async () => {
    await mountWithBanner();
    dropOn(card("team-a"), filesTransfer(imageFile("first.png")));
    await until(() => expect(chipsIn("team-a")).toEqual(["first.png"]));
    const banner = screen.getByTestId("bot-unread-banner");
    const gated = gatedImage("shot.png", "same");
    const transfer = filesTransfer(gated.file);

    dragEnter(banner, transfer);
    expect(overlaysAnywhere()).toBe(0);
    dragOver(banner, transfer);
    dropOn(banner, transfer);

    expect(overlaysAnywhere()).toBe(0);
    act(() => gated.open());
    await settleLong();
    expect(gated.asked()).toBe(0);
    expect(chipsIn("team-a")).toEqual(["first.png"]);
    expect(chipsIn("team-b")).toEqual([]);
  });

  it("clears a card's overlay that was up when the drag moves to the banner and drops there, and lands nothing", async () => {
    await mountWithBanner();
    const gated = gatedImage("shot.png", "same");
    const transfer = filesTransfer(gated.file);
    dragEnter(card("team-a"), transfer);
    expect(overlaysIn(card("team-a"))).toBe(1);
    const banner = screen.getByTestId("bot-unread-banner");

    dragOver(banner, transfer);
    expect(overlaysAnywhere()).toBe(0);
    dropOn(banner, transfer);

    act(() => gated.open());
    await settleLong();
    expect(gated.asked()).toBe(0);
    expect(chipsIn("team-a")).toEqual([]);
    expect(chipsIn("team-b")).toEqual([]);
  });
});
