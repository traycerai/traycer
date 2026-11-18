/**
 * Select-to-quote in a bot's conversations, through the REAL `BotChannelView`
 * and `BotSessionView` over the REAL `ChatMessages` (the quote rig of the task
 * chat: `useQuoteSelection`, the popover, the native request). A quote goes
 * into the box of the conversation it was selected in - the channel's or the
 * open thread's - as markdown quote lines; a bot's session has no box, so it
 * offers none. Only the session registry (scripted sessions by chat id) and
 * the reads beside the transcripts are replaced.
 */
import {
  botMentionHostClientMock,
  emptyBotMentionHostListsMock,
} from "@/components/bots/__tests__/bot-mention-host-test-support";
import { StrictMode } from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotActivity } from "@traycer/protocol/host/bot/schemas";
import {
  BOT_ID,
  CHANNEL_ID,
  HOST_ID,
  POST_FIRST_LINE,
  POST_ID,
  POST_REQUEST,
  POST_SECOND_LINE,
  REPLY_ID,
  THREAD_ID,
  THREAD_OPEN,
  botReply,
  buildScene,
  hostClientLocating,
  memberPost,
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
import { BotSessionView } from "@/components/bots/bot-session-view";
import {
  advanceLegendListFrames,
  installLegendListTestClock,
  installLegendListViewportMetrics,
  settleLegendList,
} from "@/components/chat/__tests__/legend-list-test-environment";
import { NATIVE_QUOTE_REQUEST_EVENT } from "@/components/chat/quote/use-native-quote-request";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UNRESOLVED_BOT_MEMBERS } from "@/lib/bots/bot-member-names";
import type { HostRpcRegistry } from "@/lib/host";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import {
  useBotOpenThreadStore,
  type BotOpenThread,
} from "@/stores/bots/bot-open-thread-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { Selection } from "@tiptap/pm/state";
import {
  editableIn,
  editorOf,
  textOf,
  typeInto,
} from "@/components/bots/__tests__/bot-box-test-support";
import { currentBotLifetime } from "@/lib/bots/bot-lifetime";

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

/** Text the channel's transcript draws, from the bot's reply. */
const CHANNEL_TEXT = "CI is green.";
/** Text the thread panel's transcript draws, from the thread's reply. */
const THREAD_TEXT = "Yes, the thread agrees.";
const TYPED = "Agreed, but";

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

function flushFrame(): Promise<void> {
  return advanceLegendListFrames(1);
}

let scene: Scene;

beforeEach(() => {
  installLegendListTestClock();
  installLegendListViewportMetrics();
  // jsdom has no layout: give every range a paintable rect, or the popover's
  // anchor guard dismisses it.
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
  negotiateBotSend(HOST_ID, { major: 1, minor: 1 });
  signInViewer(VIEWER_USER_ID);
});

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  useBotDraftsStore.setState(useBotDraftsStore.getInitialState(), true);
  useBotOpenThreadStore.setState({ byBotId: {} });
  mocks.sessions = {};
  mocks.threads = [];
  mocks.threadListFailed = false;
  mocks.refetchThreads.mockClear();
  mocks.client = null;
  mocks.activity = null;
  resetBotFailedRequestSupport();
});

/** Selects the whole of `text`'s element inside `scope`, and releases the mouse on it. */
async function selectText(scope: HTMLElement, text: string): Promise<void> {
  const element = within(scope).getByText(text);
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  await act(async () => {
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await flushFrame();
  });
}

function channelSection(): HTMLElement {
  return screen.getByTestId("bot-channel");
}

function threadPanel(): HTMLElement {
  return screen.getByTestId("bot-thread-panel");
}

function inputIn(scope: HTMLElement, testId: string): HTMLElement {
  return editableIn(within(scope).getByTestId(testId));
}

/** Whether the box's caret sits at the end of what it holds. */
function caretAtEnd(box: HTMLElement): boolean {
  const { doc, selection } = editorOf(box).state;
  return selection.empty && selection.to === Selection.atEnd(doc).to;
}

function channelBox(): HTMLElement {
  return inputIn(channelSection(), "bot-channel-composer-input");
}

function threadBox(): HTMLElement {
  return inputIn(threadPanel(), "bot-thread-composer-input");
}

function keptThreadText(): string | undefined {
  return useBotDraftsStore.getState().threadBoxes[BOT_ID]?.[POST_ID]?.text;
}

async function mountChannel(): Promise<void> {
  render(<MountedChannel />);
  await settleLegendList();
}

async function mountChannelWithThread(): Promise<void> {
  useBotOpenThreadStore
    .getState()
    .setRail(BOT_ID, { kind: "thread", ...THREAD_OPEN }, currentBotLifetime());
  await mountChannel();
}

/** The rail's thread under the bot's own post, which nobody has replied under: no thread is listed for it. */
const UNOPENED_THREAD_OPEN: BotOpenThread = {
  anchorMessageId: REPLY_ID,
  announcement: true,
  anchorKind: null,
  sent: null,
};

/** The thread beside the channel is the bot's reply, `CHANNEL_TEXT`, with no reply under it yet. */
async function mountChannelWithUnopenedThread(): Promise<void> {
  mocks.threads = [];
  useBotOpenThreadStore
    .getState()
    .setRail(
      BOT_ID,
      { kind: "thread", ...UNOPENED_THREAD_OPEN },
      currentBotLifetime(),
    );
  await mountChannel();
}

/** The rail's thread the member's post opened as its send was accepted: the list has not answered for it yet. */
const POSTED_THREAD_OPEN: BotOpenThread = {
  ...THREAD_OPEN,
  sent: {
    threadId: THREAD_ID,
    requestId: POST_REQUEST,
    text: POST_FIRST_LINE,
    senderUserId: VIEWER_USER_ID,
    sentAt: 1_000,
    delivery: "written",
    provisional: false,
  },
};

/** The thread the member's post opened, listed before anyone has replied. */
function unrepliedPostThread(): BotThreadSummary {
  return { ...postThread(), replyCount: 0, lastReplyAt: null };
}

async function mountChannelOpenOn(open: BotOpenThread): Promise<void> {
  useBotOpenThreadStore
    .getState()
    .setRail(BOT_ID, { kind: "thread", ...open }, currentBotLifetime());
  await mountChannel();
}

/** The thread list answers `threads`, as the host's next read of it does. */
async function answerThreadList(
  threads: ReadonlyArray<BotThreadSummary>,
): Promise<void> {
  mocks.threads = [...threads];
  mocks.threadListFailed = false;
  mocks.threadListVersion += 1;
  await act(async () => {
    for (const listener of mocks.threadListListeners) listener();
    await flushFrame();
  });
  await settleLegendList();
}

function quoteButton(): HTMLElement | null {
  return screen.queryByRole("button", { name: "Quote" });
}

async function clickQuote(user: UserEvent): Promise<void> {
  const button = quoteButton();
  if (button === null) throw new Error("no Quote button");
  await user.click(button);
}

function expectSelectionCleared(): void {
  expect(window.getSelection()?.toString()).toBe("");
}

describe("select-to-quote in a bot's channel with no thread open", () => {
  it("quotes a selection of the channel after what the channel's box holds, focuses the box with the caret after the quote and clears the selection", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await mountChannel();
    typeInto(channelBox(), TYPED);

    await selectText(channelSection(), CHANNEL_TEXT);
    const button = quoteButton();
    if (button === null) throw new Error("no Quote button");
    await user.click(button);

    const box = channelBox();
    expect(textOf(box)).toBe(`${TYPED}\n\n> ${CHANNEL_TEXT}`);
    expect(document.activeElement).toBe(box);
    expect(caretAtEnd(box)).toBe(true);
    expectSelectionCleared();
    expect(quoteButton()).toBeNull();
  });

  it("follows the same sink for a native quote request", async () => {
    await mountChannel();
    await selectText(channelSection(), CHANNEL_TEXT);

    act(() => {
      window.dispatchEvent(new Event(NATIVE_QUOTE_REQUEST_EVENT));
    });

    const box = channelBox();
    expect(textOf(box)).toBe(`> ${CHANNEL_TEXT}`);
    expect(document.activeElement).toBe(box);
    expectSelectionCleared();
  });
});

describe("select-to-quote in a bot's channel while its box edits a failed message", () => {
  it("adds the quote after the failed message's text, keeps the edit and focuses the box", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    // The viewer's post went unanswered: the trunk failed on its request.
    scene.channel.setState({
      messages: [
        memberPost({
          messageId: POST_ID,
          requestId: POST_REQUEST,
          lines: [POST_FIRST_LINE, POST_SECOND_LINE],
          timestamp: 1_000,
          resolvedBy: null,
        }),
        botReply({ messageId: REPLY_ID, text: CHANNEL_TEXT, timestamp: 2_000 }),
      ],
    });
    mocks.activity = {
      trunk: {
        state: "failed",
        startedAt: 100_000,
        step: null,
        requestId: POST_REQUEST,
        reason: {
          code: null,
          summary: "The provider returned an error",
          harnessId: "claude",
          action: "none",
        },
      },
      threads: {},
    };
    await mountChannel();
    await user.click(
      within(screen.getByTestId("bot-member-row")).getByTestId(
        "bot-message-edit",
      ),
    );
    const failedText = textOf(channelBox());
    expect(failedText).toContain(POST_FIRST_LINE);
    expect(screen.getByTestId("bot-channel-composer-editing")).toBeTruthy();

    await selectText(channelSection(), CHANNEL_TEXT);
    const button = quoteButton();
    if (button === null) throw new Error("no Quote button");
    await user.click(button);

    const box = channelBox();
    expect(textOf(box)).toBe(`${failedText}\n\n> ${CHANNEL_TEXT}`);
    expect(screen.getByTestId("bot-channel-composer-editing")).toBeTruthy();
    expect(document.activeElement).toBe(box);
    expect(caretAtEnd(box)).toBe(true);
    expectSelectionCleared();
  });
});

describe("select-to-quote with a thread open beside the channel", () => {
  it("quotes a selection of the channel into the channel's box while the thread's box holds the caret, and leaves the thread's box alone", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await mountChannelWithThread();
    typeInto(threadBox(), TYPED);
    act(() => threadBox().focus());

    await selectText(channelSection(), CHANNEL_TEXT);
    const button = quoteButton();
    if (button === null) throw new Error("no Quote button");
    await user.click(button);

    expect(textOf(channelBox())).toBe(`> ${CHANNEL_TEXT}`);
    expect(textOf(threadBox())).toBe(TYPED);
    expect(keptThreadText()).toBe(TYPED);
    expect(document.activeElement).toBe(channelBox());
    expectSelectionCleared();
  });

  it("quotes a selection of the thread's own transcript into the thread's box", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await mountChannelWithThread();
    typeInto(threadBox(), TYPED);

    await selectText(threadPanel(), THREAD_TEXT);
    const button = quoteButton();
    if (button === null) throw new Error("no Quote button");
    await user.click(button);

    const expected = `${TYPED}\n\n> ${THREAD_TEXT}`;
    expect(textOf(threadBox())).toBe(expected);
    expect(keptThreadText()).toBe(expected);
    expect(textOf(channelBox())).toBe("");
    expectSelectionCleared();
  });

  it("quotes a selection of the post a thread opens on, before anyone has replied, into the thread's box after what it holds", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await mountChannelWithUnopenedThread();
    typeInto(threadBox(), TYPED);

    await selectText(threadPanel(), CHANNEL_TEXT);
    const button = quoteButton();
    if (button === null) throw new Error("no Quote button");
    await user.click(button);

    const box = threadBox();
    expect(textOf(box)).toBe(`${TYPED}\n\n> ${CHANNEL_TEXT}`);
    expect(document.activeElement).toBe(box);
    expect(caretAtEnd(box)).toBe(true);
    expect(textOf(channelBox())).toBe("");
    expectSelectionCleared();
  });

  it("follows the thread's box for a native quote request on the post it opens on, before anyone has replied", async () => {
    await mountChannelWithUnopenedThread();
    await selectText(threadPanel(), CHANNEL_TEXT);

    act(() => {
      window.dispatchEvent(new Event(NATIVE_QUOTE_REQUEST_EVENT));
    });

    const box = threadBox();
    expect(textOf(box)).toBe(`> ${CHANNEL_TEXT}`);
    expect(document.activeElement).toBe(box);
    expect(textOf(channelBox())).toBe("");
    expectSelectionCleared();
  });
});

describe("select-to-quote on the post a thread opens on, with nobody replied under it", () => {
  beforeEach(() => {
    scene.sessions[THREAD_ID].store.setState({ messages: [] });
  });

  /** The region the panel draws the post in while no reply is listed. */
  function postRegion(): HTMLElement {
    return within(threadPanel()).getByTestId("bot-thread-post-scroll");
  }

  /** The thread is listed, so its replies' transcript, with a quote area of its own, is drawn under the post. */
  function expectEmptyTranscriptUnderPost(): void {
    const replies = within(threadPanel()).getByTestId("bot-thread-replies");
    expect(replies.getAttribute("data-has-replies")).toBe("false");
    expect(
      within(replies).getByTestId("chat-transcript-container"),
    ).toBeTruthy();
  }

  it("quotes a selection of the post into the box of a thread its send opened, which the list has not answered for, after what it holds", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocks.threads = [];
    await mountChannelOpenOn(POSTED_THREAD_OPEN);
    expect(
      within(threadPanel()).queryByTestId("bot-thread-replies"),
    ).toBeNull();
    typeInto(threadBox(), TYPED);

    await selectText(postRegion(), POST_FIRST_LINE);
    await clickQuote(user);

    const box = threadBox();
    expect(textOf(box)).toBe(`${TYPED}\n\n> ${POST_FIRST_LINE}`);
    expect(document.activeElement).toBe(box);
    expect(textOf(channelBox())).toBe("");
    expectSelectionCleared();
  });

  it("quotes a selection of the post into the box of a listed thread with no reply once, where the empty replies' transcript draws a quote area of its own", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocks.threads = [unrepliedPostThread()];
    await mountChannelOpenOn(THREAD_OPEN);
    expectEmptyTranscriptUnderPost();
    typeInto(threadBox(), TYPED);

    await selectText(postRegion(), POST_FIRST_LINE);
    await clickQuote(user);

    const box = threadBox();
    expect(textOf(box)).toBe(`${TYPED}\n\n> ${POST_FIRST_LINE}`);
    expect(document.activeElement).toBe(box);
    expect(textOf(channelBox())).toBe("");
    expectSelectionCleared();
  });

  it("takes a native quote request on the post of a listed thread with no reply once", async () => {
    mocks.threads = [unrepliedPostThread()];
    await mountChannelOpenOn(THREAD_OPEN);
    expectEmptyTranscriptUnderPost();
    await selectText(postRegion(), POST_FIRST_LINE);

    act(() => {
      window.dispatchEvent(new Event(NATIVE_QUOTE_REQUEST_EVENT));
    });

    const box = threadBox();
    expect(textOf(box)).toBe(`> ${POST_FIRST_LINE}`);
    expect(document.activeElement).toBe(box);
    expect(textOf(channelBox())).toBe("");
    expectSelectionCleared();
  });

  it("holds a quote of the post while the thread list has not listed its thread, and gives it to the box once, when the box appears", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocks.threads = [];
    await mountChannelOpenOn(THREAD_OPEN);
    const panel = threadPanel();
    expect(within(panel).getByTestId("bot-thread-loading")).toBeTruthy();
    expect(within(panel).queryByTestId("bot-thread-composer-input")).toBeNull();

    await selectText(postRegion(), POST_FIRST_LINE);
    await clickQuote(user);
    expect(within(panel).queryByTestId("bot-thread-composer-input")).toBeNull();
    expectSelectionCleared();

    await answerThreadList([unrepliedPostThread()]);

    expect(textOf(threadBox())).toBe(`> ${POST_FIRST_LINE}`);
    expect(textOf(channelBox())).toBe("");
  });

  it("holds a quote of the post while the thread list failed, past a Retry, and gives it to the box once, when the box appears", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocks.threads = [];
    mocks.threadListFailed = true;
    await mountChannelOpenOn(THREAD_OPEN);
    const panel = threadPanel();
    const failure = within(panel).getByTestId("bot-thread-error");
    expect(within(panel).queryByTestId("bot-thread-composer-input")).toBeNull();

    await selectText(postRegion(), POST_FIRST_LINE);
    await clickQuote(user);
    await user.click(within(failure).getByRole("button", { name: "Retry" }));
    expect(mocks.refetchThreads).toHaveBeenCalledTimes(1);
    expect(within(panel).queryByTestId("bot-thread-composer-input")).toBeNull();

    await answerThreadList([unrepliedPostThread()]);

    expect(textOf(threadBox())).toBe(`> ${POST_FIRST_LINE}`);
    expect(textOf(channelBox())).toBe("");
  });
});

describe("a bot's session offers no quote", () => {
  it("shows no Quote button for a selection and takes no native request, leaving the selection", async () => {
    render(
      <StrictMode>
        <QueryClientProvider client={new QueryClient()}>
          <TooltipProvider>
            <BotSessionView
              botId={BOT_ID}
              hostId={HOST_ID}
              botTitle="Release Bot"
              session={{ chatId: CHANNEL_ID, threadId: null, landOn: null }}
              threads={[]}
              resolveMember={UNRESOLVED_BOT_MEMBERS}
              onClose={vi.fn()}
              onOpenChannel={vi.fn()}
              onOpenThread={vi.fn()}
            />
          </TooltipProvider>
        </QueryClientProvider>
      </StrictMode>,
    );
    await settleLegendList();

    await selectText(screen.getByTestId("bot-session-view"), CHANNEL_TEXT);
    expect(quoteButton()).toBeNull();

    // A quote taken would have cleared the selection.
    act(() => {
      window.dispatchEvent(new Event(NATIVE_QUOTE_REQUEST_EVENT));
    });
    expect(window.getSelection()?.toString()).toContain(CHANNEL_TEXT);
  });
});
