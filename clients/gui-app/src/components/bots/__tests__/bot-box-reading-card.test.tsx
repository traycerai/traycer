/**
 * A Threads card's box while it reads its stored draft's images (T386),
 * through the REAL `BotThreadsView`: a near card takes a file dragged over it
 * with its own overlay, holds what is dropped, and its box lands it after the
 * restored image once the read ends, in that card alone. The fixtures, the
 * mounted tree and the lifecycle are in `bot-threads-view-harness.tsx`. A
 * card's box reading is set and ended through the drafts store, as
 * `bot-channel-view.test.tsx` sets a channel box's; the real read is covered on
 * the channel in `bot-box-held-drops.test.tsx`.
 */
import {
  botMentionHostClientMock,
  emptyBotMentionHostListsMock,
} from "@/components/bots/__tests__/bot-mention-host-test-support";
import { act, cleanup, within } from "@testing-library/react";
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
import { DROPS_WAIT_FOR_DRAFT_IMAGES } from "@/components/bots/bot-drop-lines";
import { FILE_DROP_OVERLAY_CONTENT } from "@/components/home/composer/composer-drop-overlay-content";
import { BOT_CONVERSATION_IMAGES_VERSION } from "@/hooks/bots/use-bot-send-version";
import { runTimersUntilQuiet } from "@/components/chat/composer/__tests__/editor-timer-support";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import { resetLandingImageBudgetReservationsForTesting } from "@/lib/composer/landing-image-budget";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import { negotiateBotSend } from "@/components/bots/__tests__/bot-failed-request-test-support";
import {
  boxDoc,
  INLINE_IMAGE,
} from "@/stores/bots/__tests__/bot-box-draft-persist-support";
import {
  dragEnter,
  dropOn,
  filesTransfer,
  imageFile,
  spyOnNotices,
  STORED_TEXT,
} from "@/components/bots/__tests__/bot-drop-test-support";
import {
  chatSessionWithPosts,
  chatSessionWithThreadRows,
  postRow,
} from "./bot-channel-rows-test-support";
import { installLegendListTestClock } from "@/components/chat/__tests__/legend-list-test-environment";
import { until } from "@/components/bots/__tests__/bot-drop-reading-support";
import { mocks } from "./bot-threads-view-state";
import {
  card,
  FOLLOWING,
  installBotThreadsViewCaseLifecycle,
  mount,
  intersectTarget,
  script,
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

const IMAGES_TITLE = FILE_DROP_OVERLAY_CONTENT.images.title;
const HELD = "bot-thread-composer-held";
const FIRST = "tracy-a";
const SECOND = "tracy-b";

let notices: MockInstance<typeof toast.info>;

beforeEach(() => {
  installLegendListTestClock();
  localStorage.clear();
  installFreshIndexedDb();
  resetLandingImageBudgetReservationsForTesting();
  negotiateBotSend("host-1", BOT_CONVERSATION_IMAGES_VERSION);
  notices = spyOnNotices();
});

afterEach(async () => {
  cleanup();
  await runTimersUntilQuiet();
  notices.mockRestore();
  useBotDraftsStore.setState({ boxesReading: {} });
});

/** Tracy follows two threads, each with a post and two replies. */
function followBoth(): void {
  mocks.hosted[TRACY] = script(
    [thread(TRACY, FIRST, 3_000), thread(TRACY, SECOND, 2_000)],
    { [FIRST]: FOLLOWING, [SECOND]: FOLLOWING },
  );
  mocks.posts[TRACY] = Object.fromEntries(
    [FIRST, SECOND].map((threadId) => [
      conversationRequestMessageId(`req-${threadId}`),
      `Post of ${threadId}`,
    ]),
  );
  for (const threadId of [FIRST, SECOND]) {
    mocks.replies[threadId] = ["reply 1", "reply 2"];
  }
}

const FIRST_BOX = conversationRequestMessageId(`req-${FIRST}`);

/** Both cards near, and the first card's box reading its stored draft's images. */
async function mountReadingCard(): Promise<void> {
  followBoth();
  mount();
  await until(() => expect(card(FIRST)).toBeTruthy());
  for (const threadId of [FIRST, SECOND]) {
    intersectTarget(card(threadId), "near", true);
    await until(() =>
      expect(card(threadId).getAttribute("data-full")).toBe("true"),
    );
  }
  act(() => {
    useBotDraftsStore.setState({
      boxesReading: {
        [TRACY]: { [FIRST_BOX]: { text: STORED_TEXT, replyTo: null } },
      },
    });
  });
  await until(() =>
    expect(
      within(card(FIRST)).getByTestId("bot-thread-composer-reading"),
    ).toBeTruthy(),
  );
}

/** The read ends: the box gets its stored draft, and its restored image. */
function endRead(): void {
  act(() => {
    useBotDraftsStore.setState({
      boxesReading: {},
      threadBoxes: {
        [TRACY]: {
          [FIRST_BOX]: {
            text: STORED_TEXT,
            content: boxDoc(STORED_TEXT, [INLINE_IMAGE]),
            seedId: 1,
            replyTo: null,
          },
        },
      },
    });
  });
}

function chipsIn(threadId: string): ReadonlyArray<string> {
  return within(card(threadId))
    .queryAllByRole("button", { name: /^Open Image#\d+:/ })
    .map((chip) =>
      (chip.getAttribute("aria-label") ?? "").replace(/^Open Image#\d+: /, ""),
    );
}

function overlaysIn(threadId: string): number {
  return within(card(threadId)).queryAllByText(IMAGES_TITLE).length;
}

describe("<BotThreadsView /> a near card's box reading its stored draft's images", () => {
  it("shows the box's own overlay over that card alone for a file drag, with no notice", async () => {
    await mountReadingCard();

    dragEnter(card(FIRST), filesTransfer(imageFile("shot.png")));

    expect(overlaysIn(FIRST)).toBe(1);
    expect(overlaysIn(SECOND)).toBe(0);
    expect(notices).not.toHaveBeenCalled();
  });

  it("holds a dropped file in that card, and lands it after the restored image in that card's box alone once the read ends", async () => {
    await mountReadingCard();

    const drop = dropOn(card(FIRST), filesTransfer(imageFile("dropped.png")));

    expect(drop.prevented).toBe(true);
    expect(within(card(FIRST)).getByTestId(HELD).textContent).toBe(
      DROPS_WAIT_FOR_DRAFT_IMAGES,
    );
    expect(within(card(SECOND)).queryByTestId(HELD)).toBeNull();
    expect(chipsIn(FIRST)).toEqual([]);
    endRead();
    await until(() =>
      expect(chipsIn(FIRST)).toEqual(["shot.png", "dropped.png"]),
    );
    expect(chipsIn(SECOND)).toEqual([]);
  });
});
