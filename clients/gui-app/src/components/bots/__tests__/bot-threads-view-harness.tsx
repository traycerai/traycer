/**
 * What the `bot-threads-view*.test.tsx` files share: the fixtures (bots,
 * threads and the host's script for each), the controllable
 * IntersectionObserver, the pane gate, `mount()` - the real view over a real
 * HostClient and QueryClient whose host answers from the case's script - and
 * the per-case lifecycle. Their `vi.mock` calls read
 * `bot-threads-view-state.ts`.
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
import { afterEach, beforeEach, expect, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type {
  BotRecord,
  BotThreadFollow,
} from "@traycer/protocol/host/bot/schemas";
import { conversationRequestMessageId } from "@traycer/protocol/persistence/epic/messages";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";
import type { MobileLevel2Form } from "@/lib/layout/mobile-layout-form";
import {
  FakeIntersectionObserver,
  intersectTarget,
} from "@/components/bots/__tests__/bot-read-observer-test-support";
import { BotTestRunnerHost } from "@/components/bots/__tests__/bot-test-runner-host";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MobileAppHeader } from "@/components/layout/header/mobile-app-header";
import { MobileBotHeaderSlotProvider } from "@/components/layout/header/mobile-bot-header-slot";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import {
  negotiateBotSend,
  signInViewer,
  resetBotFailedRequestSupport,
} from "@/components/bots/__tests__/bot-failed-request-test-support";
import { turnsAskedFor } from "@/components/bots/__tests__/bot-turn-test-support";
import {
  chatSessionWithThreadRows,
  postRow,
} from "./bot-channel-rows-test-support";
import { BotThreadsView } from "@/components/bots/bot-threads-view";
import { TracyPlaybackScope } from "@/components/bots/tracy-playback-slot";
import { useBotThreadFoldStore } from "@/stores/bots/bot-thread-fold-store";
import { useBotTabLandingStore } from "@/stores/bots/bot-tab-landing-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import { runTimersUntilQuiet } from "@/components/chat/composer/__tests__/editor-timer-support";
import { mocks, pane, type BotScript } from "./bot-threads-view-state";
import { PaneGate } from "./bot-threads-view-pane-gate";

export const TRACY = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const TEAM = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAW";

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

export function thread(
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
export function callThread(
  botId: string,
  threadId: string,
  lastReplyAt: number | null,
): BotThreadSummary {
  return { ...thread(botId, threadId, lastReplyAt), kind: "call" };
}

export function script(
  threads: BotThreadSummary[],
  follows: Record<string, BotThreadFollow>,
): BotScript {
  return {
    threads,
    threadAnchors: null,
    follows,
    cursors: { cursors: {}, latest: {} },
    levels: {},
  };
}

export const FOLLOWING: BotThreadFollow = {
  state: "following",
  reason: "participated",
};

/** The pane goes off screen or comes back, with the view mounted throughout. */
export function setPaneVisible(visible: boolean): void {
  act(() => {
    pane.visible = visible;
    for (const listener of pane.listeners) listener();
  });
}

/** The installed app's form the next mount draws in; `null` where the container decides. */
let mountLevel2: MobileLevel2Form | null = null;
/** Whether the next mount draws the app header beside the view, which the view portals its picker into. */
let mountUnderHeader = false;
/** The last mount's query client, for a case that has the host read again. */
export let queryClient = new QueryClient();

export function setMountLevel2(form: MobileLevel2Form | null): void {
  mountLevel2 = form;
}

export function setMountUnderHeader(under: boolean): void {
  mountUnderHeader = under;
}

export function mount(): void {
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
          const { threads, threadAnchors } = mocks.hosted[params.botId];
          return {
            threads,
            trunkCostUsd: null,
            threadAnchors,
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
          if (mocks.failNextAdvance) {
            mocks.failNextAdvance = false;
            throw new Error("the host is offline");
          }
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
      <PaneGate>
        <MobileBotHeaderSlotProvider>
          {mountUnderHeader ? <MobileAppHeader /> : null}
          <BotTestRunnerHost>
            <TooltipProvider>
              <ChatExpansionTestProviders tileInstanceId="tile-1">
                <TracyPlaybackScope>
                  <BotThreadsView
                    level2={mountLevel2}
                    hostId="host-1"
                    channelId={TRACY}
                    channelTitle="Tracy"
                    onBack={mocks.back}
                  />
                </TracyPlaybackScope>
              </ChatExpansionTestProviders>
            </TooltipProvider>
          </BotTestRunnerHost>
        </MobileBotHeaderSlotProvider>
      </PaneGate>
    </QueryClientProvider>,
  );
}

export function listed(): ReadonlyArray<string | null> {
  return screen
    .getAllByTestId("bot-thread-card")
    .map((card) => card.getAttribute("data-thread-id"));
}

export function card(threadId: string): HTMLElement {
  const found = screen
    .getAllByTestId("bot-thread-card")
    .find((li) => li.getAttribute("data-thread-id") === threadId);
  if (found === undefined) throw new Error(`no card for ${threadId}`);
  return found;
}

const BOUND_ELSEWHERE = "host-elsewhere";
const BOUND_EPOCH = 3;

/**
 * The Team bot runs on a host other than the tab's, which lists `kinds` in
 * its thread list, and its thread holds `rows`; the tab's host negotiated
 * `bot.conversation.send` at 1.`minor`. Mounts the view.
 */
export function mountBotBoundElsewhere(input: {
  readonly minor: number;
  readonly kinds: readonly string[];
  readonly rows: Message[];
}): void {
  negotiateBotSend("host-1", { major: 1, minor: input.minor });
  mocks.bots = [
    bot(TRACY, "Tracy"),
    {
      ...bot(TEAM, "Team Tracy"),
      boundHostId: BOUND_ELSEWHERE,
      hostEpoch: BOUND_EPOCH,
    },
  ];
  mocks.hosted[TEAM] = {
    ...script([thread(TEAM, "team-new", 3_000)], { "team-new": FOLLOWING }),
    threadAnchors: {
      hostId: BOUND_ELSEWHERE,
      epoch: BOUND_EPOCH,
      kinds: [...input.kinds],
    },
  };
  mocks.hosted[TRACY] = script([], {});
  mocks.replyRows["team-new"] = input.rows;
  mount();
}

/** The row the card's reading watches for the reply drawn as `text`. */
export function readRow(threadId: string, text: string): HTMLElement {
  const row = within(card(threadId))
    .getByText(text)
    .closest("[data-bot-read-row]");
  if (!(row instanceof HTMLElement)) throw new Error(`no read row for ${text}`);
  return row;
}

/** Brings a card near the page's view and waits for its thread to draw. */
export async function revealFull(threadId: string): Promise<HTMLElement> {
  intersectTarget(card(threadId), "near", true);
  await waitFor(() =>
    expect(card(threadId).getAttribute("data-full")).toBe("true"),
  );
  return card(threadId);
}

/** The thread's replies, `reply 1` to `reply count`, and the host's list saying so. */
export function withReplies(
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

/** A reply arrives: the host's list counts `count`, and the thread's session holds its row. */
export async function deliverReply(
  threadId: string,
  count: number,
): Promise<void> {
  mocks.hosted[TEAM].threads = mocks.hosted[TEAM].threads.map((summary) =>
    summary.threadId === threadId
      ? { ...summary, replyCount: count, lastReplyAt: 4_000 }
      : summary,
  );
  const session = mocks.threadSessions[threadId].store;
  act(() => {
    session.setState({
      messages: [
        ...session.getState().messages,
        postRow(`${threadId}-reply-${String(count)}`, `reply ${String(count)}`),
      ],
    });
  });
  await act(() => queryClient.invalidateQueries());
}

/** The count a card gives assistive technology, where it draws no divider. */
export function screenReaderCount(threadId: string): HTMLElement | null {
  return within(card(threadId)).queryByTestId("bot-thread-reply-count-sr");
}

/** What a summary card shows a sighted reader: its text without the screen-reader count. */
export function summaryVisibleText(threadId: string): string {
  const summary = within(card(threadId)).getByTestId("bot-thread-card-summary");
  const clone = summary.cloneNode(true);
  if (!(clone instanceof HTMLElement))
    throw new Error("summary is not an element");
  for (const hidden of clone.querySelectorAll(
    '[data-testid="bot-thread-reply-count-sr"]',
  )) {
    hidden.remove();
  }
  return clone.textContent;
}

/**
 * The thread's session as a windowed transcript of `total` replies, none of
 * them hydrated: every reply is a placeholder.
 */
export function windowedPlaceholders(threadId: string, total: number): void {
  const handle = chatSessionWithThreadRows([]);
  const derived: NonNullable<ChatSessionState["transcriptDerived"]> = {
    latestAssistantUsage: null,
    pinnedTodo: null,
    pinnedTaskTodoItems: [],
    latestForkableAssistantMessageId: null,
    restorableSetupInterruption: null,
    interviewAnswerability: [],
    latestAssistantAuthFailureTurnKey: null,
    setupCardWindows: [],
  };
  handle.store.setState({
    transcriptDerived: derived,
    transcriptWindow: {
      ...handle.store.getState().transcriptWindow,
      rowCount: total,
      spans: [],
    },
  });
  mocks.threadSessions[threadId] = handle;
}

/** The thread's session as a windowed transcript, for the real transcript to read. */
export function windowedSession(threadId: string): void {
  const handle = chatSessionWithThreadRows([]);
  const derived: NonNullable<ChatSessionState["transcriptDerived"]> = {
    latestAssistantUsage: null,
    pinnedTodo: null,
    pinnedTaskTodoItems: [],
    latestForkableAssistantMessageId: null,
    restorableSetupInterruption: null,
    interviewAnswerability: [],
    latestAssistantAuthFailureTurnKey: null,
    setupCardWindows: [],
  };
  handle.store.setState({ transcriptDerived: derived });
  mocks.threadSessions[threadId] = handle;
}

/** The thread's replies at `ordinals` (from 0) hydrated in a `total`-row window. */
export function hydrateRepliesAt(
  threadId: string,
  total: number,
  ordinals: readonly number[],
): void {
  const session = mocks.threadSessions[threadId].store;
  const ids = ordinals.map(
    (ordinal) => `${threadId}-reply-${String(ordinal + 1)}`,
  );
  act(() => {
    session.setState({
      messages: ids.map((id, index) => ({
        ...postRow(id, `reply ${id.split("-").at(-1)}`),
        timestamp: (ordinals[index] + 1) * 1_000,
      })),
      transcriptWindow: {
        ...session.getState().transcriptWindow,
        rowCount: total,
        spans: ordinals.map((ordinal, index) => ({
          fromOrdinal: ordinal,
          rowIds: [ids[index]],
          rowContext: {},
          messageIds: [ids[index]],
          eventIds: [],
          contextBytes: 0,
        })),
      },
    });
  });
}

export function replyTexts(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `reply ${String(index + 1)}`,
  );
}

/** The reply texts a card draws, in order. */
export function drawnReplies(threadId: string): string[] {
  return within(card(threadId))
    .queryAllByText(/^reply \d+$/)
    .map((node) => node.textContent);
}

/** Element's own scrollIntoView before a case replaced it, read by key. */
let originalScrollIntoView: PropertyDescriptor | undefined;

/**
 * Whether the running case's teardown lets the editors it mounted be destroyed
 * before the clock goes; set by `drainEditorTimersAtTeardown`.
 */
let drainsEditorTimers = false;

export function installBotThreadsViewCaseLifecycle(): void {
  beforeEach(() => {
    originalScrollIntoView = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollIntoView",
    );
    vi.clearAllMocks();
    pane.visible = true;
    mountLevel2 = null;
    mountUnderHeader = false;
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
    mocks.failNextAdvance = false;
    FakeIntersectionObserver.all = [];
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    signInViewer("user-1");
    useBotThreadFoldStore.setState({ unfolded: {} });
    useBotDraftsStore.setState({
      answers: {},
      threadBoxes: {},
      unsentBoxes: {},
      boxCarries: {},
      boxNotices: {},
    });
    useBotTabLandingStore.setState({ byBotId: {} });
    useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
    useSelectionAuthorityStore.setState({ effectiveHostId: "host-1" });
    useTracySurfaceStore.setState({
      open: false,
      hostId: null,
      botId: null,
      visitedBotIds: [],
    });
  });

  afterEach(async () => {
    try {
      cleanup();
      if (drainsEditorTimers) await runTimersUntilQuiet();
    } finally {
      drainsEditorTimers = false;
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
    }
  });
}

/**
 * Opts a file's cases into waiting for the editors they mounted to be
 * destroyed in teardown: after the unmount, the pending timers run until none
 * is left, and a case that leaves one fails. Called beside
 * `installBotThreadsViewCaseLifecycle()`; the lifecycle's restores run either way.
 */
export function drainEditorTimersAtTeardown(): void {
  beforeEach(() => {
    drainsEditorTimers = true;
  });
}
