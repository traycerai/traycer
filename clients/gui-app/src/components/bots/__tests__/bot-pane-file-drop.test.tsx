/**
 * A file dropped on a Tracy pane (T386), through the REAL `BotChannelView`
 * over the real transcripts, the thread panel beside it and the quote rig of
 * `bot-channel-quote.test.tsx`: the channel and the thread pane are each one drop
 * zone for their own box, a thread pane with no box shows and says nothing, and
 * a layer portalled out of a pane is not the pane's. Only the session registry
 * and the reads beside the transcripts are replaced.
 */
import {
  botMentionHostClientMock,
  emptyBotMentionHostListsMock,
} from "@/components/bots/__tests__/bot-mention-host-test-support";
import { act, cleanup, render, screen, within } from "@testing-library/react";
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
  advanceLegendListFrames,
} from "@/components/chat/__tests__/legend-list-test-environment";
import { FILE_DROP_OVERLAY_CONTENT } from "@/components/home/composer/composer-drop-overlay-content";
import { BOT_CONVERSATION_IMAGES_VERSION } from "@/hooks/bots/use-bot-send-version";
import { runTimersUntilQuiet } from "@/components/chat/composer/__tests__/editor-timer-support";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import { resetLandingImageBudgetReservationsForTesting } from "@/lib/composer/landing-image-budget";
import type { HostRpcRegistry } from "@/lib/host";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  dragEnter,
  dragOver,
  dropOn,
  filesTransfer,
  imageFile,
  linkTransfer,
  spyOnNotices,
  textTransfer,
} from "@/components/bots/__tests__/bot-drop-test-support";

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

const CHANNEL_TEXT = "CI is green.";
const THREAD_TEXT = "Yes, the thread agrees.";
const IMAGES_TITLE = FILE_DROP_OVERLAY_CONTENT.images.title;

let scene: Scene;
let notices: MockInstance<typeof toast.info>;
let refusals: MockInstance<typeof toast.error>;

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
  localStorage.clear();
  installFreshIndexedDb();
  resetLandingImageBudgetReservationsForTesting();
  negotiateBotSend(HOST_ID, BOT_CONVERSATION_IMAGES_VERSION);
  signInViewer(VIEWER_USER_ID);
  notices = spyOnNotices();
  refusals = vi.spyOn(toast, "error");
});

afterEach(async () => {
  cleanup();
  try {
    await runTimersUntilQuiet();
  } finally {
    window.getSelection()?.removeAllRanges();
    notices.mockRestore();
    refusals.mockRestore();
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
  }
});

function channelSection(): HTMLElement {
  return screen.getByTestId("bot-channel");
}

function threadPanel(): HTMLElement {
  return screen.getByTestId("bot-thread-panel");
}

async function mountChannel(open: boolean): Promise<void> {
  if (open) {
    useBotOpenThreadStore
      .getState()
      .setRail(BOT_ID, { kind: "thread", ...THREAD_OPEN });
  }
  render(<MountedChannel />);
  await settleLegendList();
}

/** The images a pane's own box holds, by file name. */
function chipsIn(pane: HTMLElement): ReadonlyArray<string> {
  return within(pane)
    .queryAllByRole("button", { name: /^Open Image#\d+:/ })
    .map((chip) =>
      (chip.getAttribute("aria-label") ?? "").replace(/^Open Image#\d+: /, ""),
    );
}

async function chipsAre(
  pane: HTMLElement,
  names: ReadonlyArray<string>,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      expect(chipsIn(pane)).toEqual(names);
      return;
    } catch (error) {
      if (attempt >= 20) throw error;
      await act(async () => {
        await advanceLegendListFrames(1);
      });
    }
  }
}

function overlaysIn(element: HTMLElement): number {
  return within(element).queryAllByText(IMAGES_TITLE).length;
}

function overlaysAnywhere(): number {
  return screen.queryAllByText(IMAGES_TITLE).length;
}

async function settle(): Promise<void> {
  await act(async () => {
    await advanceLegendListFrames(5);
  });
}

describe("<BotChannelView /> a file dropped on the channel", () => {
  it("lands in the channel's box when dropped on the transcript, with the overlay covering the section and not just the box", async () => {
    await mountChannel(false);
    const transcript = within(channelSection()).getByText(CHANNEL_TEXT);
    const transfer = filesTransfer(imageFile("shot.png"));

    dragEnter(transcript, transfer);

    const overlays = within(channelSection()).getAllByText(IMAGES_TITLE);
    expect(overlays).toHaveLength(1);
    expect(
      within(screen.getByTestId("bot-channel-composer")).queryAllByText(
        IMAGES_TITLE,
      ),
    ).toHaveLength(0);
    dropOn(transcript, transfer);
    await chipsAre(channelSection(), ["shot.png"]);
    expect(overlaysAnywhere()).toBe(0);
  });
});

describe("<BotChannelView /> a file dropped with the thread open beside the channel", () => {
  it("lands a drop on the thread pane in the thread's box alone", async () => {
    await mountChannel(true);
    const transfer = filesTransfer(imageFile("shot.png"));
    const target = within(threadPanel()).getByText(THREAD_TEXT);

    dragEnter(target, transfer);
    expect(overlaysIn(threadPanel())).toBe(1);
    expect(overlaysIn(channelSection())).toBe(0);
    dropOn(target, transfer);

    await chipsAre(threadPanel(), ["shot.png"]);
    expect(chipsIn(channelSection())).toEqual([]);
  });

  it("lands a drop on the channel in the channel's box alone", async () => {
    await mountChannel(true);
    const transfer = filesTransfer(imageFile("shot.png"));
    const target = within(channelSection()).getByText(CHANNEL_TEXT);

    dragEnter(target, transfer);
    expect(overlaysIn(channelSection())).toBe(1);
    expect(overlaysIn(threadPanel())).toBe(0);
    dropOn(target, transfer);

    await chipsAre(channelSection(), ["shot.png"]);
    expect(chipsIn(threadPanel())).toEqual([]);
  });
});

describe("<BotChannelView /> a file dropped on a thread pane with no box", () => {
  it.each(["pending", "failed"])(
    "shows no overlay, raises no notice, refuses the file and lands it nowhere while the thread is %s",
    async (state) => {
      mocks.threads = [];
      mocks.threadListFailed = state === "failed";
      await mountChannel(true);
      const transfer = filesTransfer(imageFile("shot.png"));
      const target = threadPanel();

      dragEnter(target, transfer);
      const over = dragOver(target, transfer);
      const drop = dropOn(target, transfer);

      expect(overlaysAnywhere()).toBe(0);
      expect(over).toEqual({ prevented: true, dropEffect: "none" });
      expect(drop).toEqual({ prevented: true, dropEffect: "none" });
      expect(notices).not.toHaveBeenCalled();
      expect(refusals).not.toHaveBeenCalled();
      await settle();
      expect(chipsIn(channelSection())).toEqual([]);
      expect(chipsIn(threadPanel())).toEqual([]);
    },
  );

  it("ends the overlay, and refuses a later drop silently, when the pane stays and its box goes mid-drag with no other claimant", async () => {
    await mountChannel(true);
    const transfer = filesTransfer(imageFile("shot.png"));
    const target = within(threadPanel()).getByText(THREAD_TEXT);
    dragEnter(target, transfer);
    expect(overlaysIn(threadPanel())).toBe(1);

    mocks.threads = [];
    mocks.threadListFailed = true;
    mocks.threadListVersion += 1;
    await act(async () => {
      for (const listener of mocks.threadListListeners) listener();
      await advanceLegendListFrames(1);
    });
    await settle();

    expect(
      within(threadPanel()).queryByTestId("bot-thread-composer"),
    ).toBeNull();
    expect(overlaysAnywhere()).toBe(0);
    const later = dropOn(threadPanel(), transfer);
    expect(later).toEqual({ prevented: true, dropEffect: "none" });
    expect(notices).not.toHaveBeenCalled();
    expect(refusals).not.toHaveBeenCalled();
    await settle();
    expect(chipsIn(threadPanel())).toEqual([]);
    expect(chipsIn(channelSection())).toEqual([]);
  });
});

describe("<BotChannelView /> drags that carry no file", () => {
  it("leaves text and an https link alone on both panes, after a file drop that lands", async () => {
    await mountChannel(true);
    dropOn(
      within(channelSection()).getByText(CHANNEL_TEXT),
      filesTransfer(imageFile("shot.png")),
    );
    await chipsAre(channelSection(), ["shot.png"]);

    for (const pane of [channelSection(), threadPanel()]) {
      expect(dropOn(pane, textTransfer("some words")).prevented).toBe(false);
      expect(
        dropOn(pane, linkTransfer("https://example.com/a")).prevented,
      ).toBe(false);
    }

    expect(notices).not.toHaveBeenCalled();
    expect(overlaysAnywhere()).toBe(0);
  });
});

describe("<BotChannelView /> a drop from a layer portalled out of a pane", () => {
  /** Selects the thread's reply text, which offers Quote in a layer outside the pane. */
  async function quoteLayer(): Promise<HTMLElement> {
    const element = within(threadPanel()).getByText(THREAD_TEXT);
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    await act(async () => {
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      await advanceLegendListFrames(1);
    });
    const button = screen.getByRole("button", { name: "Quote" });
    expect(threadPanel().contains(button)).toBe(false);
    return button;
  }

  it("shows no overlay and lands nothing when no drag was over the pane first", async () => {
    await mountChannel(true);
    const layer = await quoteLayer();
    dropOn(
      within(threadPanel()).getByText(THREAD_TEXT),
      filesTransfer(imageFile("first.png")),
    );
    await chipsAre(threadPanel(), ["first.png"]);
    const transfer = filesTransfer(imageFile("shot.png"));

    dragEnter(layer, transfer);
    dragOver(layer, transfer);
    dropOn(layer, transfer);

    expect(overlaysAnywhere()).toBe(0);
    await settle();
    expect(chipsIn(threadPanel())).toEqual(["first.png"]);
    expect(chipsIn(channelSection())).toEqual([]);
  });

  it("clears the pane's overlay that was up when the drag moves onto the layer and drops, and lands nothing", async () => {
    await mountChannel(true);
    const layer = await quoteLayer();
    const transfer = filesTransfer(imageFile("shot.png"));
    dragEnter(within(threadPanel()).getByText(THREAD_TEXT), transfer);
    expect(overlaysIn(threadPanel())).toBe(1);

    dragOver(layer, transfer);
    expect(overlaysAnywhere()).toBe(0);
    dropOn(layer, transfer);

    await settle();
    expect(chipsIn(threadPanel())).toEqual([]);
    expect(chipsIn(channelSection())).toEqual([]);
  });
});
