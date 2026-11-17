/**
 * The channel's unread banner and its automatic reading (T284 part A),
 * through the REAL `BotChannelView`, transcript and rows: the cursor reaches
 * a row only once the person has been shown it (never on mount, never for a
 * newest row the transcript has not loaded), and the banner's cross marks
 * the range it was counting read, as it stood when it was clicked. Only the
 * virtualised message list, the chat session registry, the channel's
 * neighbouring reads and the read-cursor host calls are replaced; the clock,
 * the window's focus and the observers that report a row in view are
 * driven by the case.
 */
import {
  botMentionHostClientMock,
  emptyBotMentionHostListsMock,
} from "@/components/bots/__tests__/bot-mention-host-test-support";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type {
  BotReadCursorAdvanceRequest,
  BotReadCursorReadResponse,
  BotReadPosition,
} from "@traycer/protocol/host/bot/schemas";
import {
  BOT_ID,
  CHANNEL_ID,
  botReply,
  hostClientLocating,
  memberPost,
  scriptedSession,
  sessionPrompt,
  textDoc,
} from "@/components/bots/__tests__/bot-turn-test-support";
import {
  MountedChannel,
  MountedLandingChannel,
} from "@/components/bots/__tests__/bot-turn-channel-harness";
import type { HostRpcRegistry } from "@/lib/host";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import { useAuthStore } from "@/stores/auth/auth-store";

const mocks = vi.hoisted(() => ({
  client: null as HostRequester<HostRpcRegistry> | null,
  sessions: {} as Record<string, ChatSessionStoreHandle>,
  /** The read cursors the host answers, and who is told when they move. */
  read: {
    value: { cursors: {}, latest: {} },
    listeners: new Set<() => void>(),
  },
  /** Whether the pane the channel is in is on screen, and who is told when it changes. */
  pane: { visible: true, listeners: new Set<() => void>() },
  /** Every advance the view sent, in order. */
  advances: [] as BotReadCursorAdvanceRequest[],
  /** The next advance is refused, as one to an offline host is. */
  failNextAdvance: false,
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
vi.mock("@/components/epic-tabs/pane-visibility-context", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    usePaneVisible: () =>
      useSyncExternalStore(
        (listener) => {
          mocks.pane.listeners.add(listener);
          return () => mocks.pane.listeners.delete(listener);
        },
        () => mocks.pane.visible,
      ),
    usePaneFocused: () => true,
    usePaneFocusProbe: () => () => true,
  };
});
vi.mock("@/hooks/bots/use-bot-conversation-list-query", () => ({
  useBotConversationListQuery: () => ({
    data: { conversations: [{ conversationId: CHANNEL_ID }] },
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/bots/use-bot-thread-list-query", () => ({
  useBotThreadListQuery: () => ({
    data: { threads: [], threadAnchors: null },
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
vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({ resolvedTheme: "light", themePreset: "neutral" }),
}));
vi.mock("@/hooks/bots/use-bot-activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/bots/use-bot-activity")>()),
  useBotActivity: () => null,
}));
// The person's read cursors are read from the cloud through the host: here
// the read answers `mocks.read`, and an advance that is accepted moves it.
vi.mock("@/hooks/bots/use-bot-read-cursor", async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await importOriginal<
      typeof import("@/hooks/bots/use-bot-read-cursor")
    >()),
    useBotReadCursors: () => ({
      data: useSyncExternalStore(
        (listener) => {
          mocks.read.listeners.add(listener);
          return () => mocks.read.listeners.delete(listener);
        },
        () => mocks.read.value,
      ),
    }),
    useBotReadCursorAdvanceMutation: () => ({
      // The view's batch hands over its request with a retirement signal of
      // its own; the real hook sends only the request, so that is what the
      // host is recorded as getting.
      mutateAsync: (
        variables: BotReadCursorAdvanceRequest & {
          readonly signal?: AbortSignal | null;
        },
      ): Promise<void> => {
        const { botId, conversationId, messageId, seq } = variables;
        const request: BotReadCursorAdvanceRequest = {
          botId,
          conversationId,
          messageId,
          seq,
        };
        mocks.advances.push(request);
        if (mocks.failNextAdvance) {
          mocks.failNextAdvance = false;
          return Promise.reject(new Error("the host is offline"));
        }
        setRead({
          cursors: {
            ...mocks.read.value.cursors,
            [request.conversationId]: { messageId, seq },
          },
          latest: mocks.read.value.latest,
        });
        return Promise.resolve();
      },
    }),
  };
});
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
      scrollRequest?: {
        kind?: string;
        messageId?: string;
        rowId?: string;
      } | null;
    }) => (
      <Providers tileInstanceId={props.instanceId}>
        <div
          data-testid="chat-messages-stub"
          data-instance-id={props.instanceId}
          data-scroll-to={props.scrollRequest?.messageId ?? ""}
          data-boundary-to={
            props.scrollRequest?.kind === "boundary"
              ? (props.scrollRequest.rowId ?? "")
              : ""
          }
        >
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

/** The pane goes off screen or comes back, with the channel mounted throughout. */
function setPaneVisible(visible: boolean): void {
  act(() => {
    mocks.pane.visible = visible;
    for (const listener of mocks.pane.listeners) listener();
  });
}

function setRead(next: BotReadCursorReadResponse): void {
  mocks.read.value = next;
  for (const listener of mocks.read.listeners) listener();
}

/** A controllable IntersectionObserver: nothing is in view until a case says so. */
class FakeIntersectionObserver {
  static all: FakeIntersectionObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(private readonly callback: (entries: Entry[]) => void) {
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
  /** The row `id` reported with its box at `box` and `visible` of it in view. */
  fireBox(id: string, box: DOMRect, visible: DOMRect): void {
    for (const target of this.targets) {
      if (target.getAttribute("data-bot-read-row") !== id) continue;
      target.getBoundingClientRect = () => box;
      this.callback([
        {
          target,
          isIntersecting: true,
          boundingClientRect: box,
          intersectionRect: visible,
        },
      ]);
    }
  }

  /** Every watched row reported whole in view, as a person looking at it sees it. */
  fire(isIntersecting: boolean, only: ReadonlySet<string> | null): void {
    const rect = new DOMRect(0, 0, 100, 100);
    for (const target of this.targets)
      target.getBoundingClientRect = () => rect;
    this.callback(
      [...this.targets]
        .filter(
          (target) =>
            only === null ||
            only.has(target.getAttribute("data-bot-read-row") ?? ""),
        )
        .map((target) => ({
          target,
          isIntersecting,
          boundingClientRect: rect,
          intersectionRect: isIntersecting ? rect : new DOMRect(0, 0, 0, 0),
        })),
    );
  }
}
type Entry = {
  target: Element;
  isIntersecting: boolean;
  boundingClientRect: DOMRect;
  intersectionRect: DOMRect;
};

/** Everything the view watches comes into view, as a person scrolling the whole channel would. */
function showEverything(): void {
  showRows(null);
}

/** A ResizeObserver a case reports sizes through. */
class FakeResizeObserver {
  static all: FakeResizeObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(private readonly callback: (entries: SizeEntry[]) => void) {
    FakeResizeObserver.all.push(this);
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
  report(id: string, width: number, height: number): void {
    const entries = [...this.targets]
      .filter((target) => target.getAttribute("data-bot-read-row") === id)
      .map((target) => ({ target, contentRect: { width, height } }));
    if (entries.length > 0) this.callback(entries);
  }
}
type SizeEntry = {
  target: Element;
  contentRect: { width: number; height: number };
};

/** The row written at `at` has this size, as the browser reports it. */
function resizeRow(at: number, width: number, height: number): void {
  act(() => {
    for (const observer of FakeResizeObserver.all) {
      observer.report(`assistant:ts:${String(at)}`, width, height);
    }
  });
}

/** The row written at `at` is in view with `visible` of its `box`. */
function showRowPart(at: number, box: DOMRect, visible: DOMRect): void {
  act(() => {
    for (const observer of FakeIntersectionObserver.all) {
      observer.fireBox(`assistant:ts:${String(at)}`, box, visible);
    }
  });
}

/** The ids the transcript gives the rows written at these times. */
function rowsAt(...timestamps: number[]): ReadonlySet<string> {
  return new Set(timestamps.map((at) => `assistant:ts:${String(at)}`));
}

/** The ids of the drawn rows whose text holds `text`, whatever the transcript keyed them by. */
function rowsHolding(text: string): ReadonlySet<string> {
  return new Set(
    [...document.querySelectorAll("[data-bot-read-row]")]
      .filter((row) => row.textContent.includes(text))
      .map((row) => row.getAttribute("data-bot-read-row") ?? ""),
  );
}

/** Only the rows with these ids come into view; `null` is every row. */
function showRows(only: ReadonlySet<string> | null): void {
  act(() => {
    for (const observer of FakeIntersectionObserver.all) {
      observer.fire(true, only);
    }
  });
}

/** The window's focus, which presenting needs; jsdom's own answer depends on what ran before. */
function foregroundWindow(): void {
  const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  onTestFinished(() => hasFocus.mockRestore());
}

/** Runs the fake clock `ms` on, with the work it queues. */
async function pass(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const OLD: BotReadPosition = { messageId: "row-1", seq: 1_000 };
const NEWEST: BotReadPosition = { messageId: "row-4", seq: 4_000 };
/** The last row before the newest: what shown rows 2 and 3 are read through. */
const PREFIX: BotReadPosition = { messageId: "row-3", seq: 3_000 };
const WRITE_PREFIX = { botId: BOT_ID, conversationId: CHANNEL_ID, ...PREFIX };

/** The channel's rows `row-1` to `row-count`, as its session holds them. */
function loadRows(count: number): void {
  mocks.sessions = {
    [CHANNEL_ID]: scriptedSession(
      CHANNEL_ID,
      Array.from({ length: count }, (_, index) =>
        botReply({
          messageId: `row-${String(index + 1)}`,
          text: `update ${String(index + 1)}`,
          timestamp: (index + 1) * 1_000,
        }),
      ),
    ).handle,
  };
}

function behind(latest: BotReadPosition): void {
  setRead({
    cursors: { [CHANNEL_ID]: OLD },
    latest: { [CHANNEL_ID]: latest },
  });
}

function banner(): HTMLElement {
  return screen.getByTestId("bot-unread-banner");
}

/** The row the transcript was asked to scroll to as the divider's row, with no highlight. */
function boundaryRequest(): string | null {
  return screen
    .getByTestId("chat-messages-stub")
    .getAttribute("data-boundary-to");
}

/**
 * The requests a mutation record shows, whichever attribute it changed, message
 * or boundary: the value it replaced, which a later change would otherwise
 * hide from a reader of the current value, and the value it left.
 */
function requestsOfRecord(record: MutationRecord): string[] {
  if (!(record.target instanceof Element) || record.attributeName === null)
    return [];
  return [
    record.oldValue ?? "",
    record.target.getAttribute(record.attributeName) ?? "",
  ];
}

/** The message the transcript was asked to scroll to and highlight. */
function messageRequest(): string | null {
  return screen
    .getByTestId("chat-messages-stub")
    .getAttribute("data-scroll-to");
}

function markAllRead(): HTMLElement {
  return within(banner()).getByRole("button", { name: "Mark all read" });
}

beforeEach(() => {
  useBotOpenThreadStore.setState({ byBotId: {} });
  mocks.advances = [];
  mocks.failNextAdvance = false;
  mocks.pane.visible = true;
  mocks.client = hostClientLocating(() => ({ turns: [] }), []);
  setRead({ cursors: {}, latest: {} });
  FakeIntersectionObserver.all = [];
  FakeResizeObserver.all = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  foregroundWindow();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  mocks.sessions = {};
  mocks.client = null;
});

describe("the channel's unread banner and automatic reading", () => {
  it("names the unread messages in a banner, and reads none of them for being mounted, however long it is on screen", async () => {
    loadRows(4);
    behind(NEWEST);

    render(<MountedChannel />);
    await pass(10_000);

    expect(
      within(banner()).getByRole("button", { name: /Unread messages/ }),
    ).toBeTruthy();
    expect(mocks.advances).toEqual([]);
  });

  it("reads through the newest row once every unread row has been in view for a second, and the banner goes", async () => {
    loadRows(4);
    behind(NEWEST);
    render(<MountedChannel />);

    showEverything();
    await pass(999);
    expect(mocks.advances).toEqual([]);
    await pass(1);

    expect(mocks.advances).toEqual([
      { botId: BOT_ID, conversationId: CHANNEL_ID, ...NEWEST },
    ]);
    expect(screen.queryByTestId("bot-unread-banner")).toBeNull();
  });

  it("reads the shown prefix when the newest row is not loaded, to the last row shown and never to the newest, and keeps the banner", async () => {
    loadRows(2);
    behind(NEWEST);
    render(<MountedChannel />);

    showEverything();
    await pass(5_000);

    expect(mocks.advances).toEqual([
      {
        botId: BOT_ID,
        conversationId: CHANNEL_ID,
        messageId: "row-2",
        seq: 2_000,
      },
    ]);
    expect(screen.getByTestId("bot-unread-banner")).toBeTruthy();
  });

  it("reads nothing while the window is in the background, and holds each row afresh for a second once the person is back", async () => {
    loadRows(4);
    behind(NEWEST);
    render(<MountedChannel />);
    const hasFocus = vi.spyOn(document, "hasFocus");

    // The window goes to the background half way through the hold.
    showEverything();
    await pass(500);
    hasFocus.mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    showEverything();
    await pass(5_000);
    expect(mocks.advances).toEqual([]);
    expect(screen.getByTestId("bot-unread-banner")).toBeTruthy();

    // Back in the window, the rows are held again from the start.
    hasFocus.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    showEverything();
    await pass(999);
    expect(mocks.advances).toEqual([]);
    await pass(1);
    expect(mocks.advances).toEqual([
      { botId: BOT_ID, conversationId: CHANNEL_ID, ...NEWEST },
    ]);
  });

  it("reads the prefix before an unread row nobody was shown and nothing across it, until that row is shown too", async () => {
    loadRows(4);
    behind(NEWEST);
    render(<MountedChannel />);

    showRows(rowsAt(2_000, 4_000));
    await pass(5_000);
    expect(mocks.advances).toEqual([
      {
        botId: BOT_ID,
        conversationId: CHANNEL_ID,
        messageId: "row-2",
        seq: 2_000,
      },
    ]);

    showRows(rowsAt(3_000));
    await pass(1_000);
    expect(mocks.advances).toEqual([
      {
        botId: BOT_ID,
        conversationId: CHANNEL_ID,
        messageId: "row-2",
        seq: 2_000,
      },
      { botId: BOT_ID, conversationId: CHANNEL_ID, ...NEWEST },
    ]);
  });

  it("reads a tall row only once every part of it has been held in view for a second, and a scroll drops the hold in progress", async () => {
    loadRows(4);
    behind(NEWEST);
    render(<MountedChannel />);
    showRows(rowsAt(2_000, 3_000));
    await pass(1_000);
    const box = new DOMRect(0, 0, 100, 400);
    const top = new DOMRect(0, 0, 100, 200);
    const bottom = new DOMRect(0, 200, 100, 200);

    // A scroll half way through the hold of the top half starts it over.
    showRowPart(4_000, box, top);
    await pass(500);
    act(() => {
      document.dispatchEvent(new Event("scroll"));
    });
    await pass(2_000);
    expect(mocks.advances).toEqual([WRITE_PREFIX]);

    showRowPart(4_000, box, top);
    await pass(1_000);
    expect(mocks.advances).toEqual([WRITE_PREFIX]);
    showRowPart(4_000, box, bottom);
    await pass(999);
    expect(mocks.advances).toEqual([WRITE_PREFIX]);
    await pass(1);

    expect(mocks.advances).toEqual([
      WRITE_PREFIX,
      { botId: BOT_ID, conversationId: CHANNEL_ID, ...NEWEST },
    ]);
  });

  it("forgets what it had read of a row whose size changed, and holds the whole row again before reading past it", async () => {
    loadRows(4);
    behind(NEWEST);
    render(<MountedChannel />);
    showRows(rowsAt(2_000, 3_000));
    await pass(1_000);
    const box = new DOMRect(0, 0, 100, 400);
    const top = new DOMRect(0, 0, 100, 200);
    resizeRow(4_000, 100, 400);
    showRowPart(4_000, box, top);
    await pass(1_000);

    // The row grows after its top half was held: that hold no longer counts.
    resizeRow(4_000, 100, 500);
    const grown = new DOMRect(0, 0, 100, 500);
    showRowPart(4_000, grown, new DOMRect(0, 250, 100, 250));
    await pass(1_000);
    expect(mocks.advances).toEqual([
      {
        botId: BOT_ID,
        conversationId: CHANNEL_ID,
        messageId: "row-3",
        seq: 3_000,
      },
    ]);

    showRowPart(4_000, grown, new DOMRect(0, 0, 100, 250));
    await pass(1_000);
    expect(mocks.advances).toEqual([
      {
        botId: BOT_ID,
        conversationId: CHANNEL_ID,
        messageId: "row-3",
        seq: 3_000,
      },
      { botId: BOT_ID, conversationId: CHANNEL_ID, ...NEWEST },
    ]);
  });

  it("takes the person to the first unread row through the transcript's pending-jump request, and scrolls to it once it is hydrated, writing nothing for the navigation", async () => {
    const session = scriptedSession(CHANNEL_ID, []);
    mocks.sessions = { [CHANNEL_ID]: session.handle };
    const request = vi.fn<(ordinal: number | null) => void>();
    const rowAt = (n: number) =>
      botReply({
        messageId: `row-${String(n)}`,
        text: `update ${String(n)}`,
        timestamp: n * 1_000,
      });
    const hydrate = (ordinals: readonly number[]): void => {
      const rows = ordinals.map((ordinal) => rowAt(ordinal + 1));
      act(() => {
        session.store.setState({
          requestTranscriptOrdinal: request,
          // A windowed transcript: the window, not the loaded rows, says how many there are.
          transcriptDerived: {
            latestAssistantUsage: null,
            pinnedTodo: null,
            pinnedTaskTodoItems: [],
            latestForkableAssistantMessageId: null,
            restorableSetupInterruption: null,
            interviewAnswerability: [],
            latestAssistantAuthFailureTurnKey: null,
            setupCardWindows: [],
          },
          messages: rows,
          transcriptWindow: {
            ...session.store.getState().transcriptWindow,
            rowCount: 4,
            spans: ordinals.map((ordinal, index) => ({
              fromOrdinal: ordinal,
              rowIds: [`assistant:ts:${String(rows[index].timestamp)}`],
              rowContext: {},
              messageIds: [rows[index].messageId],
              eventIds: [],
              contextBytes: 0,
            })),
          },
        });
      });
    };
    behind(NEWEST);
    // The window knows four rows; the first unread one (ordinal 1) has no body.
    render(<MountedChannel />);
    hydrate([0, 2, 3]);

    fireEvent.click(
      within(banner()).getByRole("button", { name: /Unread messages/ }),
    );

    expect(request).toHaveBeenLastCalledWith(1);
    expect(mocks.advances).toEqual([]);

    hydrate([0, 1, 2, 3]);
    await pass(0);

    expect(boundaryRequest()).toBe("assistant:ts:2000");
    expect(messageRequest()).toBe("");
    expect(mocks.advances).toEqual([]);
  });

  it("drops the ordinal it captured when the transcript is rebased with a row inserted before it, and a fresh press lands on the current first unread row", async () => {
    const session = scriptedSession(CHANNEL_ID, []);
    mocks.sessions = { [CHANNEL_ID]: session.handle };
    const request = vi.fn<(ordinal: number | null) => void>();
    /** One window entry: the row at `ordinal`, written at `at` ms, with its message id. */
    interface Entry {
      readonly ordinal: number;
      readonly at: number;
    }
    const install = (
      epoch: number,
      rowCount: number,
      entries: readonly Entry[],
    ): void => {
      const rows = entries.map(({ at }) =>
        botReply({
          messageId: `row-${String(at / 1_000)}`,
          text: `update ${String(at)}`,
          timestamp: at,
        }),
      );
      act(() => {
        session.store.setState({
          requestTranscriptOrdinal: request,
          transcriptBaselineEpoch: epoch,
          transcriptDerived: {
            latestAssistantUsage: null,
            pinnedTodo: null,
            pinnedTaskTodoItems: [],
            latestForkableAssistantMessageId: null,
            restorableSetupInterruption: null,
            interviewAnswerability: [],
            latestAssistantAuthFailureTurnKey: null,
            setupCardWindows: [],
          },
          messages: rows,
          transcriptWindow: {
            ...session.store.getState().transcriptWindow,
            rowCount,
            spans: entries.map(({ ordinal, at }, index) => ({
              fromOrdinal: ordinal,
              rowIds: [`assistant:ts:${String(at)}`],
              rowContext: {},
              messageIds: [rows[index].messageId],
              eventIds: [],
              contextBytes: 0,
            })),
          },
        });
      });
    };
    const scrolledTo: string[] = [];
    const watcher = new MutationObserver((records) => {
      scrolledTo.push(...records.flatMap(requestsOfRecord));
    });
    onTestFinished(() => watcher.disconnect());
    watcher.observe(document.body, {
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ["data-scroll-to", "data-boundary-to"],
      subtree: true,
    });
    behind(NEWEST);
    render(<MountedChannel />);
    // Four rows; the first unread one (ordinal 1, written at 2000) has no body.
    install(0, 4, [
      { ordinal: 0, at: 1_000 },
      { ordinal: 2, at: 3_000 },
      { ordinal: 3, at: 4_000 },
    ]);

    fireEvent.click(
      within(banner()).getByRole("button", { name: /Unread messages/ }),
    );
    expect(request).toHaveBeenLastCalledWith(1);

    // The transcript is rebased: an older row now stands at ordinal 0, so the
    // row the cursor is on is at ordinal 1 and the first unread one at 2.
    install(1, 5, [
      { ordinal: 0, at: 500 },
      { ordinal: 1, at: 1_000 },
      { ordinal: 2, at: 2_000 },
      { ordinal: 3, at: 3_000 },
      { ordinal: 4, at: 4_000 },
    ]);
    await pass(0);
    scrolledTo.push(...watcher.takeRecords().flatMap(requestsOfRecord));

    // The captured ordinal is dropped, not carried over to the new window: it
    // never lands on what stands at ordinal 1 now (the row already read), and
    // nothing is scrolled to on the person's behalf.
    expect(scrolledTo).not.toContain("assistant:ts:1000");
    expect(request).toHaveBeenLastCalledWith(null);
    expect(boundaryRequest()).toBe("");
    expect(messageRequest()).toBe("");

    // A fresh press of the banner goes to the first unread row of the window as it is.
    fireEvent.click(
      within(banner()).getByRole("button", { name: /Unread messages/ }),
    );
    await pass(0);

    expect(boundaryRequest()).toBe("assistant:ts:2000");
    expect(messageRequest()).toBe("");
    expect(scrolledTo).not.toContain("assistant:ts:1000");
    expect(mocks.advances).toEqual([]);
  });

  it("does not read across a steer the person has not been shown when a later slice of the same turn is held in view, and reads on once the steer is shown too", async () => {
    // One turn written in two records with the person's steer between them,
    // as a safe-point steer persists (rendered-messages.test.tsx: "renders
    // persisted steered user messages at the steer point").
    const before = {
      ...botReply({
        messageId: "turn-a1",
        text: "Before steer",
        timestamp: 1_000,
      }),
      turnId: "turn-1",
    };
    const steer = sessionPrompt("steer-1", 2_000);
    const afterBase = botReply({
      messageId: "turn-a2",
      text: "After steer",
      timestamp: 3_000,
    });
    const after = {
      ...afterBase,
      turnId: "turn-1",
      blocks: [
        {
          type: "steer" as const,
          blockId: "steer:queue-1",
          status: "completed" as const,
          timestamp: 2_000,
          queueItemId: "queue-1",
          messageId: "steer-1",
          mode: "safe_point" as const,
          sender: null,
          content: textDoc(["A prompt the host wrote for the bot"]),
        },
        ...afterBase.blocks,
      ],
    };
    mocks.sessions = {
      [CHANNEL_ID]: scriptedSession(CHANNEL_ID, [before, steer, after]).handle,
    };
    setRead({
      cursors: { [CHANNEL_ID]: { messageId: "turn-a1", seq: 1_000 } },
      latest: { [CHANNEL_ID]: { messageId: "turn-a2", seq: 3_000 } },
    });
    render(<MountedChannel />);

    // The later slice is held in view; the steer before it never was.
    showRows(rowsHolding("After steer"));
    await pass(5_000);
    expect(mocks.advances).toEqual([]);
    expect(screen.getByTestId("bot-unread-banner")).toBeTruthy();

    // Shown too, the steer and the slice after it are one unbroken prefix.
    showRows(rowsHolding("A prompt the host wrote for the bot"));
    await pass(1_000);
    expect(mocks.advances).toEqual([
      {
        botId: BOT_ID,
        conversationId: CHANNEL_ID,
        messageId: "turn-a2",
        seq: 3_000,
      },
    ]);
  });

  it("does not count a hold in which the row moved without any threshold being crossed, and reads it from a fresh hold", async () => {
    loadRows(4);
    behind(NEWEST);
    render(<MountedChannel />);
    showRows(rowsAt(2_000, 3_000));
    const box = new DOMRect(0, 0, 100, 100);
    showRowPart(4_000, box, box);
    await pass(500);

    // Content above grows: the row now stands lower than the box it was seen in.
    const row = document.querySelector(
      '[data-bot-read-row="assistant:ts:4000"]',
    );
    if (!(row instanceof HTMLElement)) throw new Error("no newest row");
    row.getBoundingClientRect = () => new DOMRect(0, 60, 100, 100);
    await pass(2_000);
    expect(mocks.advances).toEqual([WRITE_PREFIX]);

    showRowPart(4_000, box, box);
    await pass(1_000);
    expect(mocks.advances).toEqual([
      WRITE_PREFIX,
      { botId: BOT_ID, conversationId: CHANNEL_ID, ...NEWEST },
    ]);
  });

  it("does not read a restored or jumped-to view of the newest rows while the rows between them and the person's cursor are not loaded", async () => {
    // Only the last two rows are loaded, as after a restore at the bottom or a
    // jump to the newest; the cursor still sits on a row before them.
    mocks.sessions = {
      [CHANNEL_ID]: scriptedSession(CHANNEL_ID, [
        botReply({ messageId: "row-3", text: "update 3", timestamp: 3_000 }),
        botReply({ messageId: "row-4", text: "update 4", timestamp: 4_000 }),
      ]).handle,
    };
    behind(NEWEST);
    render(<MountedChannel />);

    showEverything();
    await pass(5_000);

    expect(mocks.advances).toEqual([]);
    expect(screen.getByTestId("bot-unread-banner")).toBeTruthy();
  });

  it("marks the range it counted read from its cross even though none of it was in view, at the newest row it had when clicked, and a row that lands later stays unread", async () => {
    loadRows(4);
    behind(NEWEST);
    render(<MountedChannel />);

    fireEvent.click(markAllRead());
    await pass(0);

    expect(mocks.advances).toEqual([
      { botId: BOT_ID, conversationId: CHANNEL_ID, ...NEWEST },
    ]);
    expect(screen.queryByTestId("bot-unread-banner")).toBeNull();

    const landed = { messageId: "row-5", seq: 5_000 };
    act(() => {
      setRead({
        cursors: mocks.read.value.cursors,
        latest: { [CHANNEL_ID]: landed },
      });
    });
    await pass(10_000);

    expect(screen.getByTestId("bot-unread-banner")).toBeTruthy();
    expect(mocks.advances).toHaveLength(1);
  });

  it("keeps the banner when the cross's write fails, and writes the same boundary again from the next click, not a newer one", async () => {
    loadRows(4);
    behind(NEWEST);
    mocks.failNextAdvance = true;
    render(<MountedChannel />);

    fireEvent.click(markAllRead());
    await pass(0);
    expect(mocks.advances).toHaveLength(1);
    expect(screen.getByTestId("bot-unread-banner")).toBeTruthy();

    act(() => {
      setRead({
        cursors: mocks.read.value.cursors,
        latest: { [CHANNEL_ID]: { messageId: "row-5", seq: 5_000 } },
      });
    });
    fireEvent.click(markAllRead());
    await pass(0);

    expect(mocks.advances).toEqual([
      { botId: BOT_ID, conversationId: CHANNEL_ID, ...NEWEST },
      { botId: BOT_ID, conversationId: CHANNEL_ID, ...NEWEST },
    ]);
  });
});

describe("the unread boundary in the channel's transcript", () => {
  const VIEWER = "user-viewer";

  beforeEach(() => {
    useAuthStore.getState().setSignedIn(
      {
        userId: VIEWER,
        userName: "Olive Owner",
        email: "owner@example.com",
        avatarUrl: null,
      },
      { userId: VIEWER, username: "Olive Owner" },
      [],
    );
  });

  afterEach(() => {
    useAuthStore.getState().setSignedOut();
  });

  /** The channel's rows `1..n`, each the bot's reply or, when `own` names it, the viewer's own post. */
  function loadTimeline(count: number, own: ReadonlySet<number>): void {
    mocks.sessions = {
      [CHANNEL_ID]: scriptedSession(
        CHANNEL_ID,
        Array.from({ length: count }, (_, index) => {
          const n = index + 1;
          return own.has(n)
            ? memberPost({
                messageId: `row-${String(n)}`,
                requestId: `request-${String(n)}`,
                lines: [`my note ${String(n)}`],
                timestamp: n * 1_000,
                resolvedBy: null,
              })
            : botReply({
                messageId: `row-${String(n)}`,
                text: `update ${String(n)}`,
                timestamp: n * 1_000,
              });
        }),
      ).handle,
    };
  }

  /** Every unread divider drawn in the transcript. */
  function dividers(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>("[data-unread-divider]")];
  }

  /** The row directly below `divider`: the one that contains it, or the next one after it. */
  function rowElementBelow(divider: HTMLElement): Element | undefined {
    return [...document.querySelectorAll("[data-bot-read-row]")].find(
      (candidate) =>
        candidate.contains(divider) ||
        (divider.compareDocumentPosition(candidate) &
          Node.DOCUMENT_POSITION_FOLLOWING) !==
          0,
    );
  }

  function rowBelow(divider: HTMLElement): string {
    return rowElementBelow(divider)?.textContent ?? "";
  }

  function onlyDivider(): HTMLElement {
    const found = dividers();
    const divider = found.at(0);
    if (divider === undefined || found.length > 1) {
      throw new Error(
        `expected one divider, found ${String(dividers().length)}`,
      );
    }
    return divider;
  }

  it("draws one New divider directly above the first unread row, and writes nothing for drawing it", () => {
    loadTimeline(4, new Set());
    behind(NEWEST);

    render(<MountedChannel />);

    expect(onlyDivider().textContent).toBe("New");
    expect(rowBelow(onlyDivider())).toContain("update 2");
    expect(mocks.advances).toEqual([]);
  });

  it("draws no divider once the channel is read through its newest row", () => {
    loadTimeline(4, new Set());
    setRead({
      cursors: { [CHANNEL_ID]: NEWEST },
      latest: { [CHANNEL_ID]: NEWEST },
    });

    render(<MountedChannel />);

    expect(dividers()).toEqual([]);
  });

  it("draws the divider above the first unread row the viewer did not write, skipping their own", () => {
    loadTimeline(4, new Set([2]));
    behind(NEWEST);

    render(<MountedChannel />);

    expect(rowBelow(onlyDivider())).toContain("update 3");
  });

  it("keeps the divider where it was, through the dwell that reads the channel and clears the banner, for as long as the visit lasts", async () => {
    loadTimeline(4, new Set());
    behind(NEWEST);
    render(<MountedChannel />);

    showEverything();
    await pass(1_000);

    expect(mocks.advances).toEqual([
      { botId: BOT_ID, conversationId: CHANNEL_ID, ...NEWEST },
    ]);
    expect(screen.queryByTestId("bot-unread-banner")).toBeNull();
    expect(rowBelow(onlyDivider())).toContain("update 2");
  });

  it("draws no divider when the person leaves the channel and comes back after reading it", async () => {
    loadTimeline(4, new Set());
    behind(NEWEST);
    const visit = render(<MountedChannel />);
    showEverything();
    await pass(1_000);
    expect(mocks.advances).toHaveLength(1);
    expect(rowBelow(onlyDivider())).toContain("update 2");

    visit.unmount();
    render(<MountedChannel />);

    expect(dividers()).toEqual([]);
  });

  it("keeps the divider through the window losing and regaining focus, the pane staying on screen", async () => {
    loadTimeline(4, new Set());
    behind(NEWEST);
    render(<MountedChannel />);
    showEverything();
    await pass(1_000);
    expect(mocks.advances).toHaveLength(1);

    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    hasFocus.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await pass(0);

    expect(rowBelow(onlyDivider())).toContain("update 2");
  });

  it("draws no divider once the pane has been hidden and shown again without the channel unmounting, after the channel was read", async () => {
    loadTimeline(4, new Set());
    behind(NEWEST);
    render(<MountedChannel />);
    showEverything();
    await pass(1_000);
    expect(mocks.advances).toHaveLength(1);
    expect(rowBelow(onlyDivider())).toContain("update 2");

    setPaneVisible(false);
    setPaneVisible(true);
    await pass(0);

    expect(dividers()).toEqual([]);
  });

  it("takes the banner's press to the row carrying the divider, with no message request and no highlight, even when the newest unread row is the viewer's own", async () => {
    loadTimeline(3, new Set([3]));
    setRead({
      cursors: { [CHANNEL_ID]: OLD },
      latest: { [CHANNEL_ID]: { messageId: "row-3", seq: 3_000 } },
    });
    render(<MountedChannel />);

    fireEvent.click(
      within(banner()).getByRole("button", { name: /Unread messages/ }),
    );
    await pass(0);

    expect(boundaryRequest()).toBe("assistant:ts:2000");
    expect(
      rowElementBelow(onlyDivider())?.getAttribute("data-bot-read-row"),
    ).toBe("assistant:ts:2000");
    expect(messageRequest()).toBe("");
    expect(document.querySelector(".ring-primary\\/80")).toBeNull();
  });

  it("still scrolls to and highlights the message a permalink names, with the channel unread, and requests no boundary", async () => {
    loadRows(4);
    behind(NEWEST);

    render(
      <MountedLandingChannel
        landOn={{
          messageId: "row-3",
          sendPostId: null,
          visit: 1,
          threadId: null,
        }}
      />,
    );
    await pass(0);

    expect(
      screen.getByTestId("chat-messages-stub").getAttribute("data-scroll-to"),
    ).toBe("assistant:ts:3000");
    expect(boundaryRequest()).toBe("");
  });

  /**
   * One bot turn written as two records, which the transcript draws as a
   * single row carrying both ids (`turnMessageIds`), between an older row
   * and a newer one.
   */
  function loadMergedTurn(newer: "bot" | "own"): void {
    const first = {
      ...botReply({
        messageId: "turn-a1",
        text: "Merged part one",
        timestamp: 2_000,
      }),
      turnId: "turn-1",
    };
    const second = {
      ...botReply({
        messageId: "turn-a2",
        text: "Merged part two",
        timestamp: 3_000,
      }),
      turnId: "turn-1",
    };
    const after =
      newer === "own"
        ? memberPost({
            messageId: "row-after",
            requestId: "request-after",
            lines: ["my note after"],
            timestamp: 4_000,
            resolvedBy: null,
          })
        : botReply({
            messageId: "row-after",
            text: "update after",
            timestamp: 4_000,
          });
    mocks.sessions = {
      [CHANNEL_ID]: scriptedSession(CHANNEL_ID, [
        botReply({
          messageId: "row-0",
          text: "update before",
          timestamp: 1_000,
        }),
        first,
        second,
        after,
      ]).handle,
    };
  }

  function readTo(cursor: BotReadPosition, latest: BotReadPosition): void {
    setRead({
      cursors: { [CHANNEL_ID]: cursor },
      latest: { [CHANNEL_ID]: latest },
    });
  }

  it("draws the divider above a merged row that holds the cursor's record and newer unread ones, and takes the banner's press there with no highlight", async () => {
    loadMergedTurn("bot");
    readTo(
      { messageId: "turn-a1", seq: 2_000 },
      { messageId: "row-after", seq: 4_000 },
    );
    render(<MountedChannel />);

    expect(rowBelow(onlyDivider())).toContain("Merged part two");
    fireEvent.click(
      within(banner()).getByRole("button", { name: /Unread messages/ }),
    );
    await pass(0);

    expect(boundaryRequest()).toBe(
      rowElementBelow(onlyDivider())?.getAttribute("data-bot-read-row"),
    );
    expect(boundaryRequest()).not.toBe("");
    expect(messageRequest()).toBe("");
    expect(document.querySelector(".ring-primary\\/80")).toBeNull();
  });

  it("draws the divider below a merged row whose last record the cursor is on, above the newer row", () => {
    loadMergedTurn("bot");
    readTo(
      { messageId: "turn-a2", seq: 3_000 },
      { messageId: "row-after", seq: 4_000 },
    );
    render(<MountedChannel />);

    expect(rowBelow(onlyDivider())).toContain("update after");
  });

  it("draws no divider when the cursor is on the last record of the merged row and nothing is newer", () => {
    loadMergedTurn("bot");
    readTo(
      { messageId: "turn-a2", seq: 3_000 },
      { messageId: "turn-a2", seq: 3_000 },
    );
    render(<MountedChannel />);

    expect(dividers()).toEqual([]);
  });

  it("skips the viewer's own row after a merged row read through its last record, and draws no divider when nothing else is newer", () => {
    loadMergedTurn("own");
    readTo(
      { messageId: "turn-a2", seq: 3_000 },
      { messageId: "row-after", seq: 4_000 },
    );
    render(<MountedChannel />);

    expect(dividers()).toEqual([]);
  });
});
