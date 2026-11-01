/**
 * Select-to-quote in a bot's conversations, through the REAL `BotChannelView`
 * and `BotSessionView` over the REAL `ChatMessages` (the quote rig of the task
 * chat: `useQuoteSelection`, the popover, the native request). A quote goes
 * into the box that is open - the thread panel's while a thread is open, else
 * the channel's - as markdown quote lines; a bot's session has no box, so it
 * offers none. Only the session registry (scripted sessions by chat id) and
 * the reads beside the transcripts are replaced.
 */
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
  installLegendListViewportMetrics,
  settleLegendList,
} from "@/components/chat/__tests__/legend-list-test-environment";
import { NATIVE_QUOTE_REQUEST_EVENT } from "@/components/chat/quote/use-native-quote-request";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UNRESOLVED_BOT_MEMBERS } from "@/lib/bots/bot-member-names";
import type { HostRpcRegistry } from "@/lib/host";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import { useSettingsStore } from "@/stores/settings/settings-store";

const mocks = vi.hoisted(() => ({
  client: null as HostRequester<HostRpcRegistry> | null,
  sessions: {} as Record<string, ChatSessionStoreHandle>,
  threads: [] as BotThreadSummary[],
  activity: null as BotActivity | null,
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
vi.mock("@/hooks/bots/use-bot-thread-list-query", () => ({
  useBotThreadListQuery: () => ({
    data: { threads: mocks.threads, threadAnchors: null },
    isError: false,
    refetch: vi.fn(),
  }),
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
const SECOND_CHANNEL_TEXT = "The nightly is red.";
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
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

let scene: Scene;

beforeEach(() => {
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
  mocks.client = null;
  mocks.activity = null;
  resetBotFailedRequestSupport();
});

/** Selects the whole of `text`'s element inside `scope`, and releases the mouse. */
async function selectText(scope: HTMLElement, text: string): Promise<void> {
  const range = document.createRange();
  range.selectNodeContents(within(scope).getByText(text));
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  const transcript = within(scope).getByTestId("chat-transcript-container");
  await act(async () => {
    transcript.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await flushFrame();
  });
}

function channelSection(): HTMLElement {
  return screen.getByTestId("bot-channel");
}

function threadPanel(): HTMLElement {
  return screen.getByTestId("bot-thread-panel");
}

function inputIn(scope: HTMLElement, testId: string): HTMLTextAreaElement {
  const input = within(scope).getByTestId(testId);
  if (!(input instanceof HTMLTextAreaElement)) {
    throw new Error(`${testId} is not a textarea`);
  }
  return input;
}

function channelBox(): HTMLTextAreaElement {
  return inputIn(channelSection(), "bot-channel-composer-input");
}

function threadBox(): HTMLTextAreaElement {
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
    .setRail(BOT_ID, { kind: "thread", ...THREAD_OPEN });
  await mountChannel();
}

function quoteButton(): HTMLElement | null {
  return screen.queryByRole("button", { name: "Quote" });
}

function expectSelectionCleared(): void {
  expect(window.getSelection()?.toString()).toBe("");
}

describe("select-to-quote in a bot's channel with no thread open", () => {
  it("quotes a selection of the channel after what the channel's box holds, focuses the box with the caret after the quote and clears the selection", async () => {
    const user = userEvent.setup();
    await mountChannel();
    await user.type(channelBox(), TYPED);

    await selectText(channelSection(), CHANNEL_TEXT);
    const button = quoteButton();
    if (button === null) throw new Error("no Quote button");
    await user.click(button);

    const box = channelBox();
    expect(box.value).toBe(`${TYPED}\n\n> ${CHANNEL_TEXT}\n\n`);
    expect(document.activeElement).toBe(box);
    expect(box.selectionStart).toBe(box.value.length);
    expect(box.selectionEnd).toBe(box.value.length);
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
    expect(box.value).toBe(`> ${CHANNEL_TEXT}\n\n`);
    expect(document.activeElement).toBe(box);
    expectSelectionCleared();
  });
});

describe("select-to-quote in a bot's channel while its box edits a failed message", () => {
  it("adds the quote after the failed message's text, keeps the edit and focuses the box", async () => {
    const user = userEvent.setup();
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
    const failedText = channelBox().value;
    expect(failedText).toContain(POST_FIRST_LINE);
    expect(screen.getByTestId("bot-channel-composer-editing")).toBeTruthy();

    await selectText(channelSection(), CHANNEL_TEXT);
    const button = quoteButton();
    if (button === null) throw new Error("no Quote button");
    await user.click(button);

    const box = channelBox();
    expect(box.value).toBe(`${failedText}\n\n> ${CHANNEL_TEXT}\n\n`);
    expect(screen.getByTestId("bot-channel-composer-editing")).toBeTruthy();
    expect(document.activeElement).toBe(box);
    expect(box.selectionStart).toBe(box.value.length);
    expectSelectionCleared();
  });
});

describe("select-to-quote with a thread open beside the channel", () => {
  it("quotes a selection of the channel into the thread's box, kept under the bot, and leaves the channel's box alone", async () => {
    const user = userEvent.setup();
    await mountChannelWithThread();
    await user.type(channelBox(), TYPED);

    await selectText(channelSection(), CHANNEL_TEXT);
    const button = quoteButton();
    if (button === null) throw new Error("no Quote button");
    await user.click(button);

    expect(threadBox().value).toBe(`> ${CHANNEL_TEXT}\n\n`);
    expect(keptThreadText()).toBe(`> ${CHANNEL_TEXT}\n\n`);
    expect(channelBox().value).toBe(TYPED);
    expect(document.activeElement).toBe(threadBox());
    expectSelectionCleared();
  });

  it("quotes a selection of the thread's own transcript into the thread's box", async () => {
    const user = userEvent.setup();
    await mountChannelWithThread();
    await user.type(threadBox(), TYPED);

    await selectText(threadPanel(), THREAD_TEXT);
    const button = quoteButton();
    if (button === null) throw new Error("no Quote button");
    await user.click(button);

    const expected = `${TYPED}\n\n> ${THREAD_TEXT}\n\n`;
    expect(threadBox().value).toBe(expected);
    expect(keptThreadText()).toBe(expected);
    expect(channelBox().value).toBe("");
    expectSelectionCleared();
  });
});

/** Selects `text` of the channel and quotes it with the button. */
async function quoteChannelText(user: UserEvent, text: string): Promise<void> {
  await selectText(channelSection(), text);
  const button = quoteButton();
  if (button === null) throw new Error("no Quote button");
  await user.click(button);
}

describe("select-to-quote while the open thread's box is not drawn", () => {
  // The thread is open but not listed yet: its panel draws no box.
  beforeEach(() => {
    mocks.threads = [];
    scene.channel.setState({
      messages: [
        botReply({ messageId: REPLY_ID, text: CHANNEL_TEXT, timestamp: 2_000 }),
        botReply({
          messageId: "reply-second",
          text: SECOND_CHANNEL_TEXT,
          timestamp: 3_000,
        }),
      ],
    });
  });

  it("holds the quotes for the thread's box, in order, until it is drawn", async () => {
    const user = userEvent.setup();
    await mountChannelWithThread();
    expect(screen.queryByTestId("bot-thread-composer-input")).toBeNull();

    await quoteChannelText(user, CHANNEL_TEXT);
    await quoteChannelText(user, SECOND_CHANNEL_TEXT);
    expect(channelBox().value).toBe("");

    mocks.threads = [postThread()];
    act(() => {
      useBotOpenThreadStore.getState().setRail(BOT_ID, null);
      useBotOpenThreadStore
        .getState()
        .setRail(BOT_ID, { kind: "thread", ...THREAD_OPEN });
    });

    expect(threadBox().value).toBe(
      `> ${CHANNEL_TEXT}\n\n> ${SECOND_CHANNEL_TEXT}\n\n`,
    );
    expect(channelBox().value).toBe("");
  });

  it("keeps a quote for the thread's box when the thread is closed and the channel is quoted, each reaching its own box", async () => {
    const user = userEvent.setup();
    await mountChannelWithThread();
    await quoteChannelText(user, CHANNEL_TEXT);

    act(() => useBotOpenThreadStore.getState().setRail(BOT_ID, null));
    await quoteChannelText(user, SECOND_CHANNEL_TEXT);
    expect(channelBox().value).toBe(`> ${SECOND_CHANNEL_TEXT}\n\n`);

    mocks.threads = [postThread()];
    act(() =>
      useBotOpenThreadStore
        .getState()
        .setRail(BOT_ID, { kind: "thread", ...THREAD_OPEN }),
    );

    expect(threadBox().value).toBe(`> ${CHANNEL_TEXT}\n\n`);
    expect(channelBox().value).toBe(`> ${SECOND_CHANNEL_TEXT}\n\n`);
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
