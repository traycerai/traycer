/**
 * A thread pane's box while it reads its stored draft's images (T386), through
 * the REAL `BotChannelView` with the thread open beside the channel, on the
 * quote rig of `bot-channel-quote.test.tsx`: the pane takes a file dragged
 * over it with its own overlay, holds what is dropped or picked, and the box
 * lands it after the restored image once the read is released. The channel's
 * box is a bystander. The same cases on a Threads card are in
 * `bot-box-reading-card.test.tsx`.
 */
import {
  botMentionHostClientMock,
  emptyBotMentionHostListsMock,
} from "@/components/bots/__tests__/bot-mention-host-test-support";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
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
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotActivity } from "@traycer/protocol/host/bot/schemas";
import {
  BOT_ID,
  CHANNEL_ID,
  HOST_ID,
  POST_ID,
  THREAD_OPEN,
  buildScene,
  hostClientLocating,
  postThread,
  type Scene,
} from "@/components/bots/__tests__/bot-turn-test-support";
import {
  negotiateBotSend,
  resetBotFailedRequestSupport,
  signInViewer,
  VIEWER_USER_ID,
} from "@/components/bots/__tests__/bot-failed-request-test-support";
import { MountedChannel } from "@/components/bots/__tests__/bot-turn-channel-harness";
import {
  installLegendListTestClock,
  installLegendListViewportMetrics,
  settleLegendList,
} from "@/components/chat/__tests__/legend-list-test-environment";
import { DROPS_WAIT_FOR_DRAFT_IMAGES } from "@/components/bots/bot-drop-lines";
import { FILE_DROP_OVERLAY_CONTENT } from "@/components/home/composer/composer-drop-overlay-content";
import { BOT_CONVERSATION_IMAGES_VERSION } from "@/hooks/bots/use-bot-send-version";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import { resetLandingImageBudgetReservationsForTesting } from "@/lib/composer/landing-image-budget";
import type { HostRpcRegistry } from "@/lib/host";
import { BotDraftsPersistLifecycleBridge } from "@/providers/bot-drafts-persist-lifecycle-bridge";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  dragEnter,
  dropOn,
  filesTransfer,
  imageFile,
  spyOnNotices,
  storeDraftWithImages,
  storedImageHash,
} from "@/components/bots/__tests__/bot-drop-test-support";
import { resetImageReads } from "@/components/bots/__tests__/bot-drop-image-reads";
import {
  accounts,
  newAccounts,
  release,
  signInAs,
  until,
} from "@/components/bots/__tests__/bot-drop-reading-support";

const mocks = vi.hoisted(() => ({
  client: null as HostRequester<HostRpcRegistry> | null,
  sessions: {} as Record<string, ChatSessionStoreHandle>,
  threads: [] as BotThreadSummary[],
  /** Whether the thread list's read has failed, as the query says. */
  threadListFailed: false,
  /** Bumped by every answer of the list, which the view re-renders on. */
  threadListVersion: 0,
  threadListListeners: new Set<() => void>(),
  refetchThreads: vi.fn<() => void>(),
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

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
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
vi.mock("@/hooks/bots/use-bot-conversation-list-query", () => ({
  useBotConversationListQuery: () => ({
    data: { conversations: [{ conversationId: CHANNEL_ID }] },
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/bots/use-bot-thread-list-query", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void): (() => void) => {
    mocks.threadListListeners.add(listener);
    return () => {
      mocks.threadListListeners.delete(listener);
    };
  };
  return {
    useBotThreadListQuery: () => {
      useSyncExternalStore(subscribe, () => mocks.threadListVersion);
      return {
        data: mocks.threadListFailed
          ? undefined
          : { threads: mocks.threads, threadAnchors: null },
        isError: mocks.threadListFailed,
        refetch: mocks.refetchThreads,
      };
    },
  };
});
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
vi.mock("@/hooks/bots/use-bot-turn-locate-query", () => ({
  useBotTurnLocateQuery: () => ({ data: undefined }),
}));
vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({ resolvedTheme: "light", themePreset: "neutral" }),
}));
vi.mock("@/hooks/bots/use-bot-activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/bots/use-bot-activity")>()),
  useBotActivity: () => mocks.activity,
}));

vi.mock("@/lib/composer/landing-image-store", async () =>
  (
    await import("@/components/bots/__tests__/bot-drop-image-reads")
  ).landingImageStoreMock(),
);

const THREAD_TEXT = "Yes, the thread agrees.";
const IMAGES_TITLE = FILE_DROP_OVERLAY_CONTENT.images.title;
const THREAD = "bot-thread-composer";
const READING = `${THREAD}-reading`;
const HELD = `${THREAD}-held`;

let scene: Scene;
let notices: MockInstance<typeof toast.info>;

function nonZeroRect(): DOMRect {
  return {
    x: 10,
    y: 20,
    width: 120,
    height: 18,
    top: 20,
    left: 10,
    right: 130,
    bottom: 38,
    toJSON: () => ({}),
  };
}

function clientRectsOf(rect: DOMRect): DOMRectList {
  return Object.assign([rect], {
    item: (index: number) => [rect][index] ?? null,
  });
}

beforeEach(() => {
  installLegendListTestClock();
  installLegendListViewportMetrics();
  vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(
    nonZeroRect(),
  );
  vi.spyOn(Range.prototype, "getClientRects").mockReturnValue(
    clientRectsOf(nonZeroRect()),
  );
  useSettingsStore.setState({ quoteReplyEnabled: true });
  useBotOpenThreadStore.setState({ byBotId: {} });
  scene = buildScene();
  mocks.sessions = scene.sessions;
  mocks.threads = [postThread()];
  mocks.client = hostClientLocating(() => ({ turns: [] }), []);
  mocks.activity = null;
  newAccounts();
  localStorage.clear();
  installFreshIndexedDb();
  resetLandingImageBudgetReservationsForTesting();
  resetImageReads();
  negotiateBotSend(HOST_ID, BOT_CONVERSATION_IMAGES_VERSION);
  signInViewer(VIEWER_USER_ID);
  notices = spyOnNotices();
});

afterEach(() => {
  cleanup();
  notices.mockRestore();
  vi.restoreAllMocks();
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  useBotDraftsStore.setState(useBotDraftsStore.getInitialState(), true);
  useBotOpenThreadStore.setState({ byBotId: {} });
  mocks.sessions = {};
  mocks.threads = [];
  mocks.threadListFailed = false;
  mocks.client = null;
  mocks.activity = null;
  resetBotFailedRequestSupport();
});

function channelSection(): HTMLElement {
  return screen.getByTestId("bot-channel");
}

function threadPanel(): HTMLElement {
  return screen.getByTestId("bot-thread-panel");
}

/** The images a pane's own box holds, by file name. */
function chipsIn(pane: HTMLElement): ReadonlyArray<string> {
  return within(pane)
    .queryAllByRole("button", { name: /^Open Image#\d+:/ })
    .map((chip) =>
      (chip.getAttribute("aria-label") ?? "").replace(/^Open Image#\d+: /, ""),
    );
}

function overlaysIn(element: HTMLElement): number {
  return within(element).queryAllByText(IMAGES_TITLE).length;
}

/** The channel with the thread open beside it, the thread box reading its stored draft's images. */
async function mountThreadReading(): Promise<{ readonly hash: string }> {
  const hash = await storedImageHash();
  signInAs(accounts.a);
  storeDraftWithImages(accounts.a, POST_ID, hash, 1);
  useBotOpenThreadStore
    .getState()
    .setRail(BOT_ID, { kind: "thread", ...THREAD_OPEN });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <BotDraftsPersistLifecycleBridge>
        <MountedChannel />
      </BotDraftsPersistLifecycleBridge>
    </QueryClientProvider>,
  );
  await settleLegendList();
  await until(() => expect(screen.getByTestId(READING)).toBeTruthy());
  return { hash };
}

describe("<BotChannelView /> a thread pane's box reading its stored draft's images", () => {
  it("shows the box's own overlay over the thread section, not the channel's, for a file drag, with no notice", async () => {
    await mountThreadReading();

    dragEnter(
      within(threadPanel()).getByText(THREAD_TEXT),
      filesTransfer(imageFile("shot.png")),
    );

    expect(overlaysIn(threadPanel())).toBe(1);
    expect(overlaysIn(channelSection())).toBe(0);
    expect(notices).not.toHaveBeenCalled();
  });

  it("holds a dropped file, says so in the reading view's status, and lands nothing in either box yet", async () => {
    await mountThreadReading();

    const drop = dropOn(
      within(threadPanel()).getByText(THREAD_TEXT),
      filesTransfer(imageFile("dropped.png")),
    );

    expect(drop.prevented).toBe(true);
    const held = screen.getByTestId(HELD);
    expect(held.textContent).toBe(DROPS_WAIT_FOR_DRAFT_IMAGES);
    expect(held.getAttribute("role")).toBe("status");
    expect(threadPanel().contains(held)).toBe(true);
    expect(chipsIn(threadPanel())).toEqual([]);
    expect(chipsIn(channelSection())).toEqual([]);
  });

  it("lands the restored image first and the held file after it in the thread's box once the read is released, and nothing in the channel's", async () => {
    const { hash } = await mountThreadReading();
    dropOn(
      within(threadPanel()).getByText(THREAD_TEXT),
      filesTransfer(imageFile("dropped.png")),
    );

    release(hash);

    await until(() =>
      expect(chipsIn(threadPanel())).toEqual(["shot.png", "dropped.png"]),
    );
    expect(chipsIn(channelSection())).toEqual([]);
  });

  it("enables Attach in the reading view, and lands a pick after the restored draft", async () => {
    const { hash } = await mountThreadReading();
    const attach = screen.getByTestId(`${THREAD}-attach`);
    expect(attach).toHaveProperty("disabled", false);
    const picker = screen
      .getByTestId(`${THREAD}-picker`)
      .querySelector<HTMLInputElement>('input[type="file"]');
    if (picker === null) throw new Error("the thread box has no file input");
    const user = userEvent.setup({
      advanceTimers: vi.advanceTimersByTime,
      applyAccept: false,
    });

    await user.click(attach);
    await user.upload(picker, imageFile("picked.png"));
    expect(screen.getByTestId(HELD).textContent).toBe(
      DROPS_WAIT_FOR_DRAFT_IMAGES,
    );
    release(hash);

    await until(() =>
      expect(chipsIn(threadPanel())).toEqual(["shot.png", "picked.png"]),
    );
    expect(chipsIn(channelSection())).toEqual([]);
  });
});
