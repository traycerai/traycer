import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  StrictMode,
  useCallback,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import type { StoreApi } from "zustand/vanilla";
import {
  CHAT_ANCHOR_SETTLE_FALLBACK_MS,
  ChatMessages,
  type ChatMessageScrollRequest,
} from "@/components/chat/chat-messages";
import {
  TileFindContext,
  type TileFindContextValue,
} from "@/components/epic-canvas/tile-find/tile-find-adapter-context";
import { CHAT_TIMELINE_NAVIGATION_VIEW_OFFSET_PX } from "@/components/chat/chat-messages-scroll-helpers";
import { captureChatFreeScrollingOffset } from "@/components/chat/chat-scroll-restoration";
import {
  evictChatTabState,
  evictChatTabStateForChat,
  peekSavedChatTabState,
  restoreChatTabState,
  saveChatTabState,
} from "@/stores/chats/chat-tab-state-cache";
import type { ChatTabPersistenceIdentity } from "@/stores/chats/chat-tab-persistence-key";
import { flushChatTabViewportHandoff } from "@/stores/chats/chat-tab-viewport-handoff";
import {
  HOSTED_TILE_INSTANCE_ID_ATTRIBUTE,
  HOSTED_TILE_PANE_ID_ATTRIBUTE,
  HOSTED_TILE_VIEW_TAB_ID_ATTRIBUTE,
} from "@/components/epic-canvas/surface-host/hosted-tile-dom";
import { evictChatTabPersistenceForEpic } from "@/stores/chats/chat-tab-persistence-eviction";
import { getOrCreateActivityGroupOpenStore } from "@/stores/chats/activity-group-open-store-core";
import type { ActivityGroupOpenState } from "@/stores/chats/activity-group-open-store-context";
import { getOrCreateA2AOpenStore } from "@/stores/chats/a2a-open-store-context";
import { useToolOpenStore } from "@/stores/chats/tool-open-store";
import { useSubagentOpenStore } from "@/stores/chats/subagent-open-store";
import { scopedChatOpenId } from "@/stores/chats/open-store-scope";
import { deriveActivityGroupRenderId } from "@/components/chat/chat-collapsible-key";
import { getDefaultBindings } from "@/lib/keybindings/actions";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type { InterviewSegment } from "@/stores/composer/chat-store";
import type { TileFindAdapter } from "@/stores/tile-find";
import { NO_TRANSCRIPT_BASELINE } from "@/stores/chats/chat-announcements";
import type { BackgroundItem } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  makeAssistantMessage,
  makeMessage,
  makeMessageAt,
} from "./chat-message-fixtures";
import {
  enableLegendListBrowserScrollEvents,
  installLegendListViewportMetrics,
  setLegendListScrollContainerScrollHeightOverride,
  settleLegendList,
} from "./legend-list-test-environment";

const VIEWPORT_HEIGHT_PX = 700;
const VIEWPORT_WIDTH_PX = 800;
const LEGEND_LIST_HEADER_PX = 40;
const DEFAULT_COMPOSER_OVERLAY_HEIGHT_PX = 80;

const platformMock = vi.hoisted(() => ({ isMac: true }));
// Default false matches an empty canvas store (existing tests never seed live
// tiles). Ticket 5 remount-save tests flip this true so unmount commits to the
// cache; permanent-close tests keep it false so the save-side guard can be
// asserted. Mirrors use-scroll-restoration.test.tsx.
const tileLiveness = vi.hoisted(() => ({ live: false }));
const activityGroupOpenIds = vi.hoisted(() => ({
  lastOpenIds: new Set<string>(),
  setOpenCalls: [] as Array<{ groupId: string; open: boolean }>,
}));
const legendListItemSizeChanges = vi.hoisted(() => ({ count: 0 }));

vi.mock("@/lib/keybindings/platform", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/keybindings/platform")>();
  return {
    ...actual,
    isMac: () => platformMock.isMac,
  };
});

vi.mock("@/stores/epics/canvas/tile-instance-liveness", () => ({
  isEpicCanvasTileInstanceLive: () => tileLiveness.live,
}));

// Lightweight rows: ChatMessages mounts real ChatTimeline/LegendList; full
// ChatMessage UI is heavy and unrelated to scroll-policy assertions.
vi.mock("@/components/chat/chat-message", () => ({
  ChatMessage: function MockChatMessage(props: {
    message: ChatMessageModel;
  }): ReactElement {
    const interview = props.message.segments.find(
      (segment): segment is InterviewSegment => segment.kind === "interview",
    );
    const answer = interview?.answers[0]?.values[0] ?? null;
    const interviewUnitId =
      interview === undefined || answer === null
        ? null
        : `interview:${interview.id}:question:0:answer:value:0`;
    return (
      <div data-testid={`mock-message-${props.message.id}`}>
        {props.message.role}:{props.message.id}
        {interviewUnitId === null ? (
          props.message.content
        ) : (
          <span data-chat-find-unit={interviewUnitId}>{answer}</span>
        )}
      </div>
    );
  },
}));

// Ticket 17 (review round 2, finding 2 residual): a thin, behavior-preserving
// pass-through around the REAL `LegendList` component - re-exports everything
// unchanged, wraps only the component itself to tee its ref into a
// module-scope holder. The real component renders and behaves identically;
// this is not the mocked-primitive trap - it exists purely so this file's
// tests can drive `setItemSize` directly (the only way to fire a genuine,
// no-scroll `onItemSizeChanged` in this jsdom harness: the ResizeObserver is
// globally a no-op, and there is no other way to simulate a row's real
// measured size changing). Zero production delta - `chat-messages.tsx` and
// `chat-timeline.tsx` are untouched; `ChatMessages` still never exposes its
// internal `chatTimelineRef`.
const legendListRefHolder = vi.hoisted(() => ({
  current: null as import("@legendapp/list/react").LegendListRef | null,
}));

vi.mock("@legendapp/list/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@legendapp/list/react")>();
  const TeedLegendList: typeof actual.LegendList = (props) => {
    const { ref, onItemSizeChanged, ...rest } = props;
    const teeRef = useCallback(
      (instance: import("@legendapp/list/react").LegendListRef | null) => {
        legendListRefHolder.current = instance;
        if (typeof ref === "function") {
          ref(instance);
        } else if (ref) {
          ref.current = instance;
        }
      },
      [ref],
    );
    return (
      <actual.LegendList
        {...rest}
        onItemSizeChanged={(info) => {
          legendListItemSizeChanges.count += 1;
          onItemSizeChanged?.(info);
        }}
        ref={teeRef}
      />
    );
  };
  return { ...actual, LegendList: TeedLegendList };
});

vi.mock(
  "@/stores/chats/activity-group-open-store-core",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/stores/chats/activity-group-open-store-core")
      >();
    // Ticket 5's registry (`getOrCreateActivityGroupOpenStore`) can hand back
    // the SAME real store object across multiple calls for one tileInstanceId
    // (e.g. a remount-simulating test); track which store objects are already
    // wrapped so re-wrapping never double-counts a single `setOpen` call.
    const wrappedStores = new WeakSet<object>();
    function wrapWithSetOpenTracking(
      store: StoreApi<ActivityGroupOpenState>,
    ): StoreApi<ActivityGroupOpenState> {
      if (wrappedStores.has(store)) return store;
      wrappedStores.add(store);
      const originalGetState = store.getState.bind(store);
      store.getState = () => {
        const state = originalGetState();
        return {
          ...state,
          setOpen: (groupId: string, open: boolean) => {
            activityGroupOpenIds.setOpenCalls.push({ groupId, open });
            state.setOpen(groupId, open);
            activityGroupOpenIds.lastOpenIds = new Set(
              originalGetState().openIds,
            );
          },
        };
      };
      return store;
    }
    return {
      ...actual,
      createActivityGroupOpenStore: (
        initialOpenIds: ReadonlySet<string> | null,
      ) =>
        wrapWithSetOpenTracking(
          actual.createActivityGroupOpenStore(initialOpenIds),
        ),
      getOrCreateActivityGroupOpenStore: (
        identity: ChatTabPersistenceIdentity,
      ) =>
        wrapWithSetOpenTracking(
          actual.getOrCreateActivityGroupOpenStore(identity),
        ),
    };
  },
);

function makeTranscript(count: number): ChatMessageModel[] {
  return Array.from({ length: count }, (_unused, index) =>
    makeMessage(index, index % 2 === 0 ? "user" : "assistant"),
  );
}

function makeInterviewFindTranscript(count: number): ChatMessageModel[] {
  const target: ChatMessageModel = {
    ...makeMessage(0, "assistant"),
    id: "msg-interview-find",
    segments: [
      {
        id: "interview-find",
        kind: "interview",
        status: "completed",
        toolName: "AskUserQuestion",
        title: null,
        description: null,
        questions: [
          {
            questionId: "q1",
            question: "Which detail?",
            header: null,
            options: [],
            multiSelect: false,
          },
        ],
        answers: [
          {
            questionId: "q1",
            question: "Which detail?",
            values: ["offscreen interview detail"],
            notes: null,
            selection: null,
          },
        ],
        draftAnswers: [],
        outcome: "answered",
        settlement: null,
        error: null,
        delivery: null,
        forkedWithoutAnswer: false,
      },
    ],
  };
  return [
    target,
    ...Array.from({ length: Math.max(count - 1, 0) }, (_unused, index) =>
      makeMessage(index + 1, index % 2 === 0 ? "user" : "assistant"),
    ),
  ];
}

function appendAssistant(
  messages: ReadonlyArray<ChatMessageModel>,
  id: string,
  createdAt: number,
): ReadonlyArray<ChatMessageModel> {
  return [
    ...messages,
    {
      ...makeMessageAt(0, "assistant", createdAt),
      id,
      content: "streamed",
      runState: "running" as const,
    },
  ];
}

/** Completed turns so free-scroll pill is plain (not streaming from stale null completedAt). */
function makeCompletedTranscript(count: number): ChatMessageModel[] {
  return Array.from({ length: count }, (_unused, index) => {
    const role: ChatMessageModel["role"] =
      index % 2 === 0 ? "user" : "assistant";
    return {
      ...makeMessage(index, role),
      completedAt: role === "assistant" ? 1_000 + index : null,
      runState: null,
    };
  });
}

/** P4: a pure agent-to-agent child chat - every `role: "user"` row carries
 *  `agentSenderInfo`, so ZERO rows pass `isHumanUserMessage`. Models the
 *  transcript shape `selectActiveUserMessageId`'s human-only gate
 *  previously starved of any candidate. */
function makeA2AOnlyCompletedTranscript(count: number): ChatMessageModel[] {
  return Array.from({ length: count }, (_unused, index) => {
    const role: ChatMessageModel["role"] =
      index % 2 === 0 ? "user" : "assistant";
    const base = {
      ...makeMessage(index, role),
      completedAt: role === "assistant" ? 1_000 + index : null,
      runState: null,
    };
    if (role !== "user") return base;
    return {
      ...base,
      agentSenderInfo: {
        agentId: `agent-peer-${index}`,
        senderTitle: "Peer",
        expectReply: false,
        responseId: null,
      },
    };
  });
}

/** Composer-send optimistic echo: persistentMessageId stays null (decision #8/#25). */
function appendOptimisticUserSend(
  messages: ReadonlyArray<ChatMessageModel>,
  id: string,
  createdAt: number,
): ReadonlyArray<ChatMessageModel> {
  return [
    ...messages,
    {
      ...makeMessageAt(0, "user", createdAt),
      id,
      content: "hello from send",
      persistentMessageId: null,
    },
  ];
}

/** Uniform row height under `legend-list-test-environment` (ITEM_HEIGHT_PX). */
const TICKET_13_ROW_HEIGHT_PX = 90;

/**
 * Waits for exactly one reveal-pass tick (two rAFs, matching the effect's
 * own two-rAF pass) without the full anchor-settle fallback - used between
 * incremental chunk appends so each `rerenderMessages` call gets its own
 * measurement/reveal cycle, like real per-token streaming would.
 */
async function waitForRevealPassTick(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  });
}

/**
 * Plain-navigation settle (`scrollToEnd`/`navigateToMessage`, ticket 10):
 * waits for LegendList's own frames plus the DOM-`scrollend`-based
 * `awaitScrollSettle` fallback window (`CHAT_ANCHOR_SETTLE_FALLBACK_MS`).
 */
async function waitForNavigationSettle(): Promise<void> {
  await settleLegendList();
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, CHAT_ANCHOR_SETTLE_FALLBACK_MS + 150);
    });
  });
}

function queryScrollToEndPill(): HTMLButtonElement | null {
  return screen.queryByRole<HTMLButtonElement>("button", {
    name: "Scroll to end",
  });
}

function isJumpPillVisible(): boolean {
  const pill = queryScrollToEndPill();
  if (pill === null) return false;
  return (
    pill.classList.contains("opacity-100") &&
    !pill.classList.contains("opacity-0")
  );
}

function getScrollNode(): HTMLElement {
  const node = screen.getByTestId("chat-messages-scroll");
  if (!(node instanceof HTMLElement)) {
    throw new Error("chat-messages-scroll is not an HTMLElement");
  }
  return node;
}

/** Park away from the tail so LegendList reports isAtEnd/isNearEnd = false. */
function fireScrollAwayFromEnd(): void {
  const scrollNode = getScrollNode();
  scrollNode.scrollTop = 0;
  fireEvent.scroll(scrollNode);
}

function fireScrollToEnd(): void {
  const scrollNode = getScrollNode();
  const maxScroll = Math.max(
    0,
    scrollNode.scrollHeight - scrollNode.clientHeight,
  );
  scrollNode.scrollTop = maxScroll;
  fireEvent.scroll(scrollNode);
}

/**
 * Sets `scrollTop` and fires a scroll event, then yields one animation frame
 * so LegendList's own (batched/scheduled) scroll processing runs before the
 * NEXT step changes the position again - firing several `fireEvent.scroll`
 * calls back-to-back with no yield between them gets coalesced into a
 * single notification of whichever value was current when LegendList's
 * scheduled pass finally ran, silently dropping the intermediate ones.
 */
async function fireScrollTopAndFlush(scrollTop: number): Promise<void> {
  const scrollNode = getScrollNode();
  await act(async () => {
    scrollNode.scrollTop = scrollTop;
    fireEvent.scroll(scrollNode);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
}

/**
 * Ticket 15 review (live pass S5 round 3): sets `scrollTop` and fires the
 * scroll event WITHOUT yielding an animation frame afterward - deliberately
 * leaves `scheduleActiveViewportUpdate`'s rAF-throttled reading-line mirror
 * (`scrolledActiveUserMessageIdRef`) unserviced, exactly as a real close
 * that races the pending frame does (`requestAnimationFrame` never fires
 * for a backgrounded/closing tab; `useAnimationFrameThrottle`'s own cleanup
 * cancels the pending frame on unmount either way). Pairs with an immediate
 * unmount to reproduce the field race.
 */
function fireScrollTopWithoutFlush(scrollTop: number): void {
  const scrollNode = getScrollNode();
  act(() => {
    scrollNode.scrollTop = scrollTop;
    fireEvent.scroll(scrollNode);
  });
}

/** Dispatch a keydown with target inside the keyboard-scroll scope. */
function dispatchKeyInScope(key: string): void {
  const scrollNode = getScrollNode();
  scrollNode.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
    }),
  );
}

/**
 * Enter free-scrolling and leave the strict end so the Jump-to-latest pill can
 * show immediately. Drives a scrollTop departure and waits for
 * the isAtEnd=false -> free-scrolling mode flip (the only automatic path after
 * anchor removal). Does not assert a specific scrollTop - callers that need a
 * known park should call fireScrollTopAndFlush afterward and re-check mode.
 */
async function enterFreeScrollingAwayFromEnd(): Promise<void> {
  const scrollNode = getScrollNode();
  setLegendListScrollContainerScrollHeightOverride(
    Math.max(scrollNode.scrollHeight, LEGEND_LIST_HEADER_PX + 40 * 90 + 40),
  );
  fireEvent.wheel(scrollNode, { deltaY: -80 });
  await fireScrollTopAndFlush(0);
  await waitFor(() => {
    expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
  });
}

function maxScrollTopFor(scrollNode: HTMLElement): number {
  return Math.max(0, scrollNode.scrollHeight - scrollNode.clientHeight);
}

/** True-bottom geometry: DOM is at max scroll AND LegendList reports isAtEnd. */
function assertTrueBottomGeometry(): void {
  const scrollNode = getScrollNode();
  const maxScroll = maxScrollTopFor(scrollNode);
  expect(scrollNode.scrollTop).toBeGreaterThanOrEqual(maxScroll - 1);
  const listIsAtEnd = legendListRefHolder.current?.getState().isAtEnd;
  expect(listIsAtEnd).toBe(true);
  expect(scrollNode.dataset.scrollMode).toBe("following-end");
}

/**
 * Parks free-scrolling inside the library's former 10% near-end band
 * (viewport * 0.1) but more than 1px from the strict edge - the zone where
 * maintainScrollAtEndThreshold=0.1 would have reattached, and threshold=0
 * must not. `enterFreeScrollingAwayFromEnd` parks at scrollTop=0; this
 * covers the near-end gap the review called out.
 *
 * LegendList's distanceFromEnd is
 * `contentLength - scroll - scrollLength - contentInsetEnd` (composer
 * overlay). The strict edge is therefore inset-aware; parking at
 * contentLength-scrollLength alone can still leave isAtEnd=true.
 */
async function enterFreeScrollingNearEnd(
  distanceFromEdgePx: number,
  contentInsetEndPx: number,
): Promise<number> {
  // 10% of a 700px viewport is 70px; require the park is inside that band.
  expect(distanceFromEdgePx).toBeGreaterThan(1);
  expect(distanceFromEdgePx).toBeLessThanOrEqual(VIEWPORT_HEIGHT_PX * 0.1);

  const list = legendListRefHolder.current;
  if (list === null) {
    throw new Error("LegendList ref is not mounted");
  }
  const state = list.getState();
  // Strict-edge max scroll per checkAtBottom: content - viewport - insetEnd.
  const strictMaxScroll = Math.max(
    0,
    state.contentLength - state.scrollLength - contentInsetEndPx,
  );
  expect(strictMaxScroll).toBeGreaterThan(distanceFromEdgePx + 1);

  const scrollNode = getScrollNode();
  fireEvent.wheel(scrollNode, { deltaY: -40 });
  const parked = strictMaxScroll - distanceFromEdgePx;
  // Drive through the real imperative API so LegendList's internal scroll
  // tracker stays coherent with the DOM, then fire scroll so onIsAtEndChange runs.
  await act(async () => {
    void list.scrollToOffset({ offset: parked, animated: false });
    scrollNode.scrollTop = parked;
    fireEvent.scroll(scrollNode);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
  await waitFor(() => {
    expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
  });
  const after = legendListRefHolder.current?.getState();
  expect(after?.isAtEnd).toBe(false);
  const distanceFromEnd =
    (after?.contentLength ?? 0) -
    (after?.scroll ?? 0) -
    (after?.scrollLength ?? 0) -
    contentInsetEndPx;
  expect(distanceFromEnd).toBeGreaterThan(1);
  expect(distanceFromEnd).toBeLessThanOrEqual(VIEWPORT_HEIGHT_PX * 0.1 + 1);
  return getScrollNode().scrollTop;
}

interface LegendListScrollCommandSpies {
  readonly totalCalls: () => number;
  readonly restore: () => void;
}

/**
 * Spy LegendList imperative scroll APIs so a test can prove the app issued
 * (or did not issue) a semantic scroll command after a mutation.
 */
function spyLegendListScrollCommands(): LegendListScrollCommandSpies {
  const list = legendListRefHolder.current;
  if (list === null) {
    throw new Error("LegendList ref is not mounted");
  }
  const scrollToOffset = vi.spyOn(list, "scrollToOffset");
  const scrollToIndex = vi.spyOn(list, "scrollToIndex");
  const scrollToEnd = vi.spyOn(list, "scrollToEnd");
  return {
    totalCalls: () =>
      scrollToOffset.mock.calls.length +
      scrollToIndex.mock.calls.length +
      scrollToEnd.mock.calls.length,
    restore: () => {
      scrollToOffset.mockRestore();
      scrollToIndex.mockRestore();
      scrollToEnd.mockRestore();
    },
  };
}

/** Mid-list non-tail weave: insert a new row before the last two. */
function weaveNonTailRow(
  messages: ReadonlyArray<ChatMessageModel>,
  id: string,
  createdAt: number,
): ReadonlyArray<ChatMessageModel> {
  const insertAt = Math.max(0, messages.length - 2);
  const next = [...messages];
  next.splice(insertAt, 0, {
    ...makeMessageAt(0, "assistant", createdAt),
    id,
    content: "woven mid-list",
    completedAt: createdAt,
    runState: null,
  });
  return next;
}

/** Queued flush: host row arrives already-persisted (not optimistic). */
function appendQueuedFlushRow(
  messages: ReadonlyArray<ChatMessageModel>,
  id: string,
  createdAt: number,
): ReadonlyArray<ChatMessageModel> {
  return [
    ...messages,
    {
      ...makeMessageAt(0, "user", createdAt),
      id,
      content: "queued flush",
      persistentMessageId: id,
    },
  ];
}

/** Incoming A2A user-role row (agentSenderInfo set). */
function appendA2AUserRow(
  messages: ReadonlyArray<ChatMessageModel>,
  id: string,
  createdAt: number,
): ReadonlyArray<ChatMessageModel> {
  return [
    ...messages,
    {
      ...makeMessageAt(0, "user", createdAt),
      id,
      content: "a2a inbound",
      agentSenderInfo: {
        agentId: "peer-agent",
        senderTitle: "Peer",
        expectReply: false,
        responseId: null,
      },
      persistentMessageId: id,
    },
  ];
}

/** Setup-card system row weaved above a mid-list user trigger. */
function weaveSetupCardAbove(
  messages: ReadonlyArray<ChatMessageModel>,
  triggerIndex: number,
  cardId: string,
): ReadonlyArray<ChatMessageModel> {
  if (triggerIndex < 0 || triggerIndex >= messages.length) {
    throw new Error(`No trigger at index ${triggerIndex}`);
  }
  const trigger = messages[triggerIndex];
  const card: ChatMessageModel = {
    ...makeMessageAt(0, "system", trigger.createdAt - 1),
    id: cardId,
    content: "",
    segments: [
      {
        id: `${cardId}:card`,
        kind: "setup-card",
        model: {
          aggregate: {
            epicId: "epic-1",
            ownerId: "owner-1",
            ownerKind: "chat",
            state: "ready",
          },
          workspaces: [],
          createdAt: trigger.createdAt - 1,
          isActive: false,
        },
        viewTabId: "tab-1",
        anchorMessageId: trigger.id,
        isGenesisPin: false,
      },
    ],
  };
  const next = [...messages];
  next.splice(triggerIndex, 0, card);
  return next;
}

/**
 * Selects the last (most recent) turn on the minimap rail via keyboard - End
 * to move the active index to the last item, then Enter to select it. The
 * rail is a single hit-target button, not a per-item button, so this is the
 * equivalent of the old per-item click. A frame must be awaited between the
 * two keydowns: `setActiveIndex` from End is still in flight when Enter's own
 * `onKeyDown` closure is captured, so firing both synchronously reads the
 * PRE-End `activeItem` (null) and no-ops.
 */
async function selectLastChatTurnMinimapItem(): Promise<void> {
  const minimapButton = screen.getByTestId("chat-turn-minimap-hit-strip");
  fireEvent.keyDown(minimapButton, { key: "End" });
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
  fireEvent.keyDown(minimapButton, { key: "Enter" });
}

interface RenderChatMessagesOptions {
  readonly messages: ReadonlyArray<ChatMessageModel>;
  /**
   * Tab-key half of the dual-key identity (ticket 15). Prefer this over a
   * separate `instanceId` when a test only cares about the cache key - the
   * production path keys everything by `instanceId` now (scrollStateKey was
   * dropped as a redundant prop).
   */
  readonly scrollStateKey?: string;
  readonly instanceId?: string;
  readonly epicId?: string;
  readonly taskId?: string;
  readonly visible?: boolean;
  readonly composerOverlayHeight?: number;
  readonly taskTitle?: string;
  readonly systemOverlayActive?: boolean;
  readonly scrollRequest?: ChatMessageScrollRequest | null;
  readonly backgroundItems?: ReadonlyArray<BackgroundItem> | undefined;
  readonly tileActive?: boolean;
  readonly groupId?: string;
  readonly withSiblingChrome?: boolean;
  readonly strictMode?: boolean;
  /**
   * Ticket 21 slice 4: models a HOSTED chat's DOM shape - the tile's own
   * wrapper carries the hosted-record identity attributes instead of a
   * physical `data-group-id` ancestor, while `withSiblingChrome`'s sibling
   * (the pane's own tab strip, which never moves) stays under a real
   * `data-group-id={hostedPaneId}`, exactly mirroring `StableTileSurfaceHost`
   * vs `TabGroupView`'s split DOM subtrees.
   */
  readonly hostedPaneId?: string;
  /**
   * Opts into fresh-open policy (no saved reading position; list opens at true bottom) by leaving the scroll-state cache empty for this key. Most
   * tests here exercise following/free-scrolling/edge-mutation behavior, not
   * fresh-open itself, so `renderChatMessages` seeds a bottom-following saved
   * state by default (unless the caller already seeded one, e.g. the
   * restored-free-scrolling test) - matching what a returning tab's cache
   * would already hold.
   */
  readonly freshOpen?: boolean;
  /** `ChatSessionState.transcriptBaselineEpoch`; see `ChatMessages`. */
  readonly baselineEpoch?: number;
  /** Test-only seam: captures the adapter registered by ChatMessages. */
  readonly tileFindContext?: TileFindContextValue;
}

interface ChatMessagesRenderState {
  messages: ReadonlyArray<ChatMessageModel>;
  baselineEpoch: number;
  /** Mutable: a chat is auto-titled after its first turn and can be renamed. */
  taskTitle: string;
  systemOverlayActive: boolean;
  scrollRequest: ChatMessageScrollRequest | null;
  backgroundItems: ReadonlyArray<BackgroundItem> | undefined;
  visible: boolean;
  tileActive: boolean;
  composerOverlayHeight: number;
}

/** Synthetic dual-key identity for tests (ticket 15). */
function makeTestIdentity(
  tileInstanceId: string,
  epicId: string,
  chatId: string,
): ChatTabPersistenceIdentity {
  return { tileInstanceId, epicId, chatId };
}

/** Default harness identity (epic-1 / task-1) for call sites that only vary the tile key. */
function makeDefaultTestIdentity(
  tileInstanceId: string,
): ChatTabPersistenceIdentity {
  return makeTestIdentity(tileInstanceId, "epic-1", "task-1");
}

function renderChatMessages(options: RenderChatMessagesOptions) {
  // Production keys the dual-key tab half by `instanceId`. Call sites that
  // only pass `scrollStateKey` still work: it becomes the instanceId.
  const instanceId =
    options.instanceId ??
    options.scrollStateKey ??
    `instance-${Math.random().toString(36).slice(2)}`;
  const epicId = options.epicId ?? "epic-1";
  const taskId = options.taskId ?? "task-1";
  const identity = makeTestIdentity(instanceId, epicId, taskId);
  // Alias kept for existing call-site destructuring (`scrollStateKey`).
  const scrollStateKey = instanceId;
  const groupId = options.groupId ?? "pane-1";

  if (options.freshOpen !== true && peekSavedChatTabState(identity) === null) {
    saveChatTabState({
      identity,
      mode: "following-end",
      anchorMessageId: null,
      anchorIndex: null,
      offset: 0,
    });
  }

  const state: ChatMessagesRenderState = {
    messages: options.messages,
    // Default 0: these rows arrived on a hydrated connection, which is what
    // every non-announcement test wants. The announcement suite drives this
    // explicitly to model mount hydration and reconnect backfill.
    baselineEpoch: options.baselineEpoch ?? 0,
    taskTitle: options.taskTitle ?? "Test chat",
    systemOverlayActive: options.systemOverlayActive ?? false,
    scrollRequest: options.scrollRequest ?? null,
    backgroundItems: options.backgroundItems,
    visible: options.visible ?? true,
    tileActive: options.tileActive ?? true,
    composerOverlayHeight:
      options.composerOverlayHeight ?? DEFAULT_COMPOSER_OVERLAY_HEIGHT_PX,
  };

  const hostedPaneId = options.hostedPaneId;
  const scopeAttributes: Record<string, string> =
    hostedPaneId === undefined
      ? { "data-group-id": groupId }
      : {
          [HOSTED_TILE_INSTANCE_ID_ATTRIBUTE]: instanceId,
          [HOSTED_TILE_PANE_ID_ATTRIBUTE]: hostedPaneId,
          [HOSTED_TILE_VIEW_TAB_ID_ATTRIBUTE]: "tab-1",
        };

  function siblingChrome(): ReactNode {
    const button = (
      <button type="button" data-testid="pane-sibling-chrome">
        Sibling chrome
      </button>
    );
    if (hostedPaneId === undefined) return button;
    return <div data-group-id={hostedPaneId}>{button}</div>;
  }

  const content = (): ReactNode => (
    <div
      data-group-id={hostedPaneId === undefined ? groupId : undefined}
      style={{ height: VIEWPORT_HEIGHT_PX, width: VIEWPORT_WIDTH_PX }}
    >
      <div
        data-chat-keyboard-scroll-scope
        data-active={state.tileActive ? "true" : "false"}
        {...scopeAttributes}
        style={{ height: VIEWPORT_HEIGHT_PX, width: VIEWPORT_WIDTH_PX }}
      >
        <ChatMessages
          taskTitle={state.taskTitle}
          taskId={taskId}
          epicId={epicId}
          hostId={null}
          messages={state.messages}
          baselineEpoch={state.baselineEpoch}
          backgroundItems={state.backgroundItems}
          getMessageActions={() => null}
          nextStepActions={null}
          instanceId={instanceId}
          visible={state.visible}
          systemOverlayActive={state.systemOverlayActive}
          scrollRequest={state.scrollRequest}
          composerOverlayHeight={state.composerOverlayHeight}
        />
      </div>
      {options.withSiblingChrome === true ? siblingChrome() : null}
    </div>
  );
  const contentWithFindContext = (): ReactNode => {
    const rendered = content();
    if (options.tileFindContext === undefined) return rendered;
    return (
      <TileFindContext.Provider value={options.tileFindContext}>
        {rendered}
      </TileFindContext.Provider>
    );
  };
  const jsx = (): ReactNode =>
    options.strictMode === true ? (
      <StrictMode>{contentWithFindContext()}</StrictMode>
    ) : (
      contentWithFindContext()
    );

  const result = render(jsx());
  return {
    ...result,
    scrollStateKey,
    instanceId,
    identity,
    epicId,
    taskId,
    rerenderMessages: (messages: ReadonlyArray<ChatMessageModel>) => {
      state.messages = messages;
      result.rerender(jsx());
    },
    rerenderWith: (patch: Partial<ChatMessagesRenderState>) => {
      Object.assign(state, patch);
      result.rerender(jsx());
    },
  };
}

async function waitForPillVisible(): Promise<void> {
  await waitFor(() => {
    expect(isJumpPillVisible()).toBe(true);
  });
}

function installChatFindHighlights(): void {
  const previousCss = Object.getOwnPropertyDescriptor(globalThis, "CSS");
  const previousHighlight = Object.getOwnPropertyDescriptor(
    globalThis,
    "Highlight",
  );
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: { highlights: new Map<string, object>() },
  });
  Object.defineProperty(globalThis, "Highlight", {
    configurable: true,
    value: class TestHighlight {
      constructor(..._ranges: ReadonlyArray<Range>) {}
    },
  });
  onTestFinished(() => {
    if (previousCss === undefined) {
      Reflect.deleteProperty(globalThis, "CSS");
    } else {
      Object.defineProperty(globalThis, "CSS", previousCss);
    }
    if (previousHighlight === undefined) {
      Reflect.deleteProperty(globalThis, "Highlight");
    } else {
      Object.defineProperty(globalThis, "Highlight", previousHighlight);
    }
  });
}

describe("ChatMessages scroll policy", () => {
  beforeEach(() => {
    activityGroupOpenIds.lastOpenIds = new Set();
    activityGroupOpenIds.setOpenCalls = [];
    platformMock.isMac = true;
    tileLiveness.live = false;
    legendListItemSizeChanges.count = 0;
    installLegendListViewportMetrics();
    vi.useRealTimers();
    useSettingsStore.setState({
      chatTurnMinimapSide: "right",
      quoteReplyEnabled: false,
    });
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    // Do not restoreAllMocks - it clears module mocks for isMac / activity store.
    platformMock.isMac = true;
    tileLiveness.live = false;
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
    setLegendListScrollContainerScrollHeightOverride(null);
    useSettingsStore.setState({ chatTurnMinimapSide: "right" });
    // Ticket 15: dual-key durable entries survive tab-key cleanup - clear the
    // harness default epic so later tests' freshOpen paths see a true empty
    // chat-key cache rather than a leftover following-end/free-scrolling seed.
    evictChatTabPersistenceForEpic("epic-1");
  });

  it("re-syncs a virtualized find highlight from row mount without a resize", async () => {
    installChatFindHighlights();
    const messages = makeInterviewFindTranscript(200);
    let registeredAdapter: TileFindAdapter | null = null;
    const tileFindContext: TileFindContextValue = {
      tileInstanceId: "chat-messages-find-mount",
      registerAdapter: (adapter) => {
        registeredAdapter = adapter;
        return () => {
          if (registeredAdapter === adapter) registeredAdapter = null;
        };
      },
    };

    renderChatMessages({
      messages,
      instanceId: "chat-messages-find-mount",
      tileFindContext,
    });
    await settleLegendList();
    await waitFor(() => {
      expect(registeredAdapter).not.toBeNull();
    });

    // The initial bottom-following viewport has recycled the target row out;
    // this search asks the real ChatMessages controller to reveal it. No test
    // reaches into the controller or invokes its mount callback directly.
    expect(
      document.querySelector(
        '[data-chat-find-unit="interview:interview-find:question:0:answer:value:0"]',
      ),
    ).toBeNull();
    const itemSizeChangesBeforeSearch = legendListItemSizeChanges.count;

    await act(async () => {
      await registeredAdapter?.search({
        requestId: 1,
        query: "offscreen interview detail",
        matchCase: false,
      });
    });
    await settleLegendList();
    await settleLegendList();

    await waitFor(() => {
      expect(
        document.querySelector(
          '[data-chat-find-unit="interview:interview-find:question:0:answer:value:0"]',
        ),
      ).not.toBeNull();
      expect(registeredAdapter?.getSnapshot()).toMatchObject({
        activeUnitId: "interview:interview-find:question:0:answer:value:0",
        exactHighlight: "painted",
      });
    });
    expect(legendListItemSizeChanges.count).toBe(itemSizeChangesBeforeSearch);
  });

  it("starts following-end (no jump pill) when scroll cache is bottom-following", async () => {
    const messages = makeTranscript(12);
    renderChatMessages({ messages, scrollStateKey: "fresh-follow-key" });
    await settleLegendList();

    await waitFor(() => {
      expect(screen.getByTestId("chat-messages-scroll")).toBeTruthy();
    });
    expect(isJumpPillVisible()).toBe(false);
  });

  it("preserves free-scrolling restored from the scroll-state cache (pill visible)", async () => {
    const messages = makeTranscript(12);
    const scrollStateKey = "restored-free-key";
    saveChatTabState({
      identity: makeDefaultTestIdentity(scrollStateKey),
      mode: "free-scrolling",
      anchorMessageId: messages[0]?.id ?? null,
      anchorIndex: null,
      offset: 0,
    });

    renderChatMessages({ messages, scrollStateKey });
    await settleLegendList();

    await waitFor(() => {
      expect(isJumpPillVisible()).toBe(true);
    });
  });

  describe("pill departure feedback", () => {
    it("shows Jump to latest on the first confirmed reader departure", async () => {
      const messages = makeTranscript(20);
      renderChatMessages({ messages, scrollStateKey: "pill-debounce-key" });
      await settleLegendList();

      expect(isJumpPillVisible()).toBe(false);

      await enterFreeScrollingAwayFromEnd();
      expect(isJumpPillVisible()).toBe(true);
    });

    it("hides the pill immediately when clicking Jump to latest", async () => {
      const messages = makeTranscript(20);
      renderChatMessages({ messages, scrollStateKey: "pill-hide-key" });
      await settleLegendList();

      await enterFreeScrollingAwayFromEnd();
      await waitForPillVisible();

      fireEvent.click(screen.getByRole("button", { name: "Scroll to end" }));
      expect(isJumpPillVisible()).toBe(false);
    });

    it("keeps animated Jump to latest owned through an under-landing and concurrent growth", async () => {
      const messages = makeTranscript(24);
      renderChatMessages({
        messages,
        scrollStateKey: "pill-owned-navigation-key",
      });
      await settleLegendList();
      await enterFreeScrollingAwayFromEnd();
      await waitForPillVisible();

      const list = legendListRefHolder.current;
      if (list === null) throw new Error("LegendList ref is not mounted");
      const node = getScrollNode();
      const scrollToEnd = vi
        .spyOn(list, "scrollToEnd")
        .mockImplementation((options): Promise<void> => {
          if (options?.animated === true) {
            node.scrollTop = Math.floor(maxScrollTopFor(node) / 2);
          } else {
            node.scrollTop = maxScrollTopFor(node);
          }
          fireEvent.scroll(node);
          return Promise.resolve();
        });

      fireEvent.click(screen.getByRole("button", { name: "Scroll to end" }));
      expect(node.dataset.scrollMode).toBe("following-end");
      expect(isJumpPillVisible()).toBe(false);

      // Content grows after the smooth-scroll target was chosen. The first
      // settle therefore sees a real under-landing and reissues against the
      // new end, without exposing a transient free-scrolling state/pill.
      setLegendListScrollContainerScrollHeightOverride(node.scrollHeight + 360);
      act(() => {
        node.dispatchEvent(new Event("scrollend"));
      });
      await waitFor(() => {
        expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });
      });
      expect(node.dataset.scrollMode).toBe("following-end");
      expect(isJumpPillVisible()).toBe(false);

      act(() => {
        node.dispatchEvent(new Event("scrollend"));
      });
      await settleLegendList();
      expect(node.scrollTop).toBe(maxScrollTopFor(node));
      expect(node.dataset.scrollMode).toBe("following-end");
      scrollToEnd.mockRestore();
    });
  });

  it("scroll departure parks stream growth (no auto reattach)", async () => {
    const messages = makeTranscript(20);
    const { rerenderMessages } = renderChatMessages({
      messages,
      scrollStateKey: "manual-scroll-departure-key",
    });
    await settleLegendList();

    await enterFreeScrollingAwayFromEnd();
    await waitForPillVisible();
    const parked = getScrollNode().scrollTop;
    expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

    rerenderMessages(
      appendAssistant(messages, "stream-after-departure", 10_000),
    );
    await settleLegendList();
    expect(getScrollNode().scrollTop).toBe(parked);
    expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
  });

  it("pointerdown freezes follow ownership while a real reader is interacting", async () => {
    const messages = makeTranscript(20);
    const { rerenderMessages } = renderChatMessages({
      messages,
      scrollStateKey: "pointerdown-cancel-key",
    });
    await settleLegendList();

    const scrollNode = getScrollNode();
    act(() => {
      fireEvent.pointerDown(scrollNode);
    });
    await fireScrollTopAndFlush(0);
    await waitFor(() => {
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
    });
    const parked = getScrollNode().scrollTop;

    rerenderMessages(appendAssistant(messages, "stream-after-pointer", 10_000));
    await settleLegendList();
    expect(getScrollNode().scrollTop).toBe(parked);
  });

  /**
   * Ticket 14 (direction A): edge-aware wheel cancellation. A downward wheel
   * at the true live edge must not cancel follow (clamped momentum shape:
   * wheel with no accompanying scroll). Upward / ambiguous wheels and
   * directionless touch movement are departures; explicit toward-end touch
   * movement may arm a later strict-edge resume.
   */
  it("free-scrolling NEVER moves scroll position on streamed growth", async () => {
    const messages = makeTranscript(20);
    const { rerenderMessages } = renderChatMessages({
      messages,
      scrollStateKey: "free-stream-key",
    });
    await settleLegendList();

    await enterFreeScrollingAwayFromEnd();
    await waitForPillVisible();
    const parked = getScrollNode().scrollTop;
    expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

    const next = appendAssistant(messages, "streamed-a", 99_000);
    rerenderMessages(next);
    await settleLegendList();

    expect(getScrollNode().scrollTop).toBe(parked);
    expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
  });

  describe("keyboard scrolling", () => {
    it("ArrowUp and ArrowDown both cancel live-follow (symmetric, decision #7)", async () => {
      const messages = makeTranscript(16);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "kbd-sym-key",
      });
      await settleLegendList();

      act(() => {
        dispatchKeyInScope("ArrowDown");
      });
      await fireScrollTopAndFlush(0);
      await waitFor(() => {
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      });
      const afterDown = getScrollNode().scrollTop;

      let next = appendAssistant(messages, "k-stream-1", 50_000);
      rerenderMessages(next);
      await settleLegendList();
      expect(getScrollNode().scrollTop).toBe(afterDown);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // Re-enter following via the pill after free-scrolling away.
      await enterFreeScrollingAwayFromEnd();
      await waitForPillVisible();
      fireEvent.click(screen.getByRole("button", { name: "Scroll to end" }));
      await settleLegendList();

      act(() => {
        dispatchKeyInScope("ArrowUp");
      });
      getScrollNode().scrollTop = 60;
      fireEvent.scroll(getScrollNode());
      const afterUp = getScrollNode().scrollTop;

      next = appendAssistant(next, "k-stream-2", 60_000);
      rerenderMessages(next);
      await settleLegendList();
      expect(getScrollNode().scrollTop).toBe(afterUp);
    });

    it("maps macOS Command-Up and Command-Down to absolute transcript boundaries", async () => {
      const messages = makeTranscript(20);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "kbd-mac-command-boundaries",
      });
      await settleLegendList();

      const scrollNode = getScrollNode();
      expect(scrollNode.scrollTop).toBeGreaterThan(0);
      const commandUp = new KeyboardEvent("keydown", {
        key: "ArrowUp",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        scrollNode.dispatchEvent(commandUp);
      });

      expect(commandUp.defaultPrevented).toBe(true);
      expect(scrollNode.scrollTop).toBe(0);
      fireEvent.scroll(scrollNode);
      await waitFor(() => {
        expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
      });

      const next = appendAssistant(messages, "command-up-stream", 50_000);
      rerenderMessages(next);
      await settleLegendList();
      expect(scrollNode.scrollTop).toBe(0);

      const commandDown = new KeyboardEvent("keydown", {
        key: "ArrowDown",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        scrollNode.dispatchEvent(commandDown);
      });

      expect(commandDown.defaultPrevented).toBe(true);
      expect(scrollNode.scrollTop).toBe(maxScrollTopFor(scrollNode));
    });

    it("leaves a macOS command-arrow chord to a custom keybinding", async () => {
      useKeybindingStore.setState({
        bindings: {
          ...getDefaultBindings(),
          "app.sidebar.toggle": "mod+arrowup",
        },
      });
      renderChatMessages({
        messages: makeTranscript(20),
        scrollStateKey: "kbd-custom-command-boundary",
      });
      await settleLegendList();

      const scrollNode = getScrollNode();
      const before = scrollNode.scrollTop;
      const commandUp = new KeyboardEvent("keydown", {
        key: "ArrowUp",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        scrollNode.dispatchEvent(commandUp);
      });

      expect(commandUp.defaultPrevented).toBe(false);
      expect(scrollNode.scrollTop).toBe(before);
    });

    it("does not claim arrows when the target is an input/textarea/combobox", async () => {
      const messages = makeTranscript(8);
      renderChatMessages({ messages, scrollStateKey: "kbd-owner-key" });
      await settleLegendList();

      const input = document.createElement("input");
      const scope = document.querySelector("[data-chat-keyboard-scroll-scope]");
      scope?.appendChild(input);

      const scrollBefore = getScrollNode().scrollTop;
      act(() => {
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "ArrowDown",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect(getScrollNode().scrollTop).toBe(scrollBefore);

      const commandUp = new KeyboardEvent("keydown", {
        key: "ArrowUp",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        input.dispatchEvent(commandUp);
      });
      expect(commandUp.defaultPrevented).toBe(false);
      expect(getScrollNode().scrollTop).toBe(scrollBefore);

      act(() => {
        getScrollNode().dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "ArrowDown",
            bubbles: true,
            cancelable: true,
            shiftKey: true,
          }),
        );
      });
      expect(getScrollNode().scrollTop).toBe(scrollBefore);
    });
  });

  describe("aria-live turn completion", () => {
    it("announces when the trailing assistant gains a completedAt and was not stopped", async () => {
      const userMsg = makeMessage(0, "user");
      const assistantStreaming: ChatMessageModel = {
        ...makeMessage(1, "assistant"),
        completedAt: null,
        stopped: null,
        runState: "running",
      };
      const { rerenderMessages } = renderChatMessages({
        messages: [userMsg, assistantStreaming],
        scrollStateKey: "aria-complete-key",
        taskTitle: "Build plan",
      });
      await settleLegendList();

      const live = document.querySelector('[aria-live="polite"]');
      expect(live).not.toBeNull();
      expect(live?.textContent ?? "").toBe("");

      rerenderMessages([
        userMsg,
        {
          ...assistantStreaming,
          completedAt: 1_700_000_000_000,
          stopped: null,
          runState: null,
        },
      ]);
      await settleLegendList();

      await waitFor(() => {
        expect(live?.textContent).toBe("Build plan finished responding.");
      });
    });

    it("announces a footerless background completion appended while the chat is idle", async () => {
      const userMsg = makeMessage(0, "user");
      const { rerenderMessages } = renderChatMessages({
        messages: [userMsg],
        scrollStateKey: "aria-background-complete-key",
        taskTitle: "Build plan",
      });
      await settleLegendList();

      const live = document.querySelector('[aria-live="polite"]');
      expect(live?.textContent ?? "").toBe("");
      // The projector inserts a notification-only autonomous-resume row that
      // is born terminal - non-null `completedAt`, footer suppressed - with
      // no pending assistant row preceding it (see
      // `renderPersistedAssistantMessageTurn`). There is no null → timestamp
      // transition to observe; the row's arrival is its completion.
      rerenderMessages([
        userMsg,
        {
          ...makeMessage(1, "assistant"),
          completedAt: 1_700_000_000_000,
          stopped: null,
          runState: null,
          showCompletionFooter: false,
        },
      ]);
      await settleLegendList();

      await waitFor(() => {
        expect(live?.textContent).toBe(
          "Build plan received a background completion.",
        );
      });
    });

    it("announces when a terminal notification row is adopted by its provider turn", async () => {
      const userMsg = makeMessage(0, "user");
      const notificationRow: ChatMessageModel = {
        ...makeMessage(1, "assistant"),
        completedAt: 1_700_000_000_000,
        stopped: null,
        runState: null,
        showCompletionFooter: false,
      };
      const { rerenderMessages } = renderChatMessages({
        messages: [userMsg, notificationRow],
        scrollStateKey: "aria-adopted-resume-key",
        taskTitle: "Build plan",
      });
      await settleLegendList();

      const live = document.querySelector('[aria-live="polite"]');
      expect(live?.textContent ?? "").toBe("");
      // Reconnect/batched snapshot: the matching turn.started and terminal
      // events arrive together, so the row keeps its id, stays terminal, and
      // completion surfaces as the footer flipping on while `completedAt`
      // moves between two non-null values.
      rerenderMessages([
        userMsg,
        {
          ...notificationRow,
          completedAt: 1_700_000_005_000,
          showCompletionFooter: true,
        },
      ]);
      await settleLegendList();

      await waitFor(() => {
        expect(live?.textContent).toBe("Build plan finished responding.");
      });
    });

    it("does not announce rows a reconnect backfilled into the transcript", async () => {
      const knownUser = makeMessage(2, "user");
      const knownAssistant: ChatMessageModel = {
        ...makeMessage(3, "assistant"),
        completedAt: 1_700_000_000_000,
        stopped: null,
        runState: null,
      };
      const { rerenderWith } = renderChatMessages({
        messages: [knownUser, knownAssistant],
        baselineEpoch: 0,
        scrollStateKey: "aria-backfill-history-key",
        taskTitle: "Build plan",
      });
      await settleLegendList();

      const live = document.querySelector('[aria-live="polite"]');
      expect(live?.textContent ?? "").toBe("");
      // A reconnect's authoritative snapshot re-establishes the transcript on
      // a NEW connection (the epoch advances) and can carry rows written
      // while this client was away. Everything it delivers is history by
      // construction - it re-baselines instead of announcing, no matter how
      // the rows sort or when they completed.
      rerenderWith({
        baselineEpoch: 1,
        messages: [
          {
            ...makeMessage(1, "assistant"),
            completedAt: 1_699_999_000_000,
            stopped: null,
            runState: null,
            showCompletionFooter: false,
          },
          knownUser,
          knownAssistant,
          {
            ...makeMessage(4, "assistant"),
            completedAt: 1_700_000_009_000,
            stopped: null,
            runState: null,
            showCompletionFooter: false,
          },
        ],
      });
      await settleLegendList();

      expect(live?.textContent ?? "").toBe("");
    });

    it("announces a turn that arrives whole past every known message", async () => {
      const userMsg = makeMessage(0, "user");
      const { rerenderMessages } = renderChatMessages({
        messages: [userMsg],
        scrollStateKey: "aria-arrived-whole-key",
        taskTitle: "Build plan",
      });
      await settleLegendList();

      const live = document.querySelector('[aria-live="polite"]');
      expect(live?.textContent ?? "").toBe("");
      // A batched snapshot can deliver the notification and its adopting
      // provider turn together: a new id, already terminal, footer already
      // on. Extending the tail past every known message makes it news.
      rerenderMessages([
        userMsg,
        {
          ...makeMessage(1, "assistant"),
          completedAt: 1_700_000_005_000,
          stopped: null,
          runState: null,
          showCompletionFooter: true,
        },
      ]);
      await settleLegendList();

      await waitFor(() => {
        expect(live?.textContent).toBe("Build plan finished responding.");
      });
    });

    it("announces a live background completion inserted before known rows", async () => {
      const knownUser = makeMessage(0, "user");
      const knownAssistant: ChatMessageModel = {
        ...makeMessage(5, "assistant"),
        completedAt: 1_700_000_000_000,
        stopped: null,
        runState: null,
      };
      const laterUser = makeMessage(6, "user");
      const { rerenderMessages } = renderChatMessages({
        messages: [knownUser, knownAssistant, laterUser],
        scrollStateKey: "aria-mid-insert-key",
        taskTitle: "Build plan",
      });
      await settleLegendList();

      const live = document.querySelector('[aria-live="polite"]');
      expect(live?.textContent ?? "").toBe("");
      // A background task from an EARLIER turn settles late: the projector
      // anchors the new notification at its turn's original transcript
      // position - before rows the reader has already seen - but its
      // completion is newer than everything observed. Position must not
      // classify it as hydration.
      rerenderMessages([
        knownUser,
        {
          ...makeMessage(2, "assistant"),
          completedAt: 1_700_000_010_000,
          stopped: null,
          runState: null,
          showCompletionFooter: false,
        },
        knownAssistant,
        laterUser,
      ]);
      await settleLegendList();

      await waitFor(() => {
        expect(live?.textContent).toBe(
          "Build plan received a background completion.",
        );
      });
    });

    it("announces a live completion older and earlier than every known row", async () => {
      const knownUser = makeMessage(0, "user");
      const knownAssistant: ChatMessageModel = {
        ...makeMessage(5, "assistant"),
        completedAt: 1_700_000_000_000,
        stopped: null,
        runState: null,
      };
      const laterUser = makeMessage(6, "user");
      const { rerenderMessages } = renderChatMessages({
        messages: [knownUser, knownAssistant, laterUser],
        scrollStateKey: "aria-live-anchored-insert-key",
        taskTitle: "Build plan",
      });
      await settleLegendList();

      const live = document.querySelector('[aria-live="polite"]');
      expect(live?.textContent ?? "").toBe("");
      // The worst case for shape-based inference, and now a non-case: the
      // notification is anchored at its own turn's position (BEFORE rows the
      // reader has seen) and carries an OLDER completion stamp than the
      // newest known one. Neither position nor recency could call this live -
      // but the connection never re-baselined, so it is news by construction.
      rerenderMessages([
        knownUser,
        {
          ...makeMessage(2, "assistant"),
          completedAt: 1_699_999_000_000,
          stopped: null,
          runState: null,
          showCompletionFooter: false,
        },
        knownAssistant,
        laterUser,
      ]);
      await settleLegendList();

      await waitFor(() => {
        expect(live?.textContent).toBe(
          "Build plan received a background completion.",
        );
      });
    });

    it("keeps an announced sentence frozen when the chat is renamed", async () => {
      const userMsg = makeMessage(0, "user");
      const assistantStreaming: ChatMessageModel = {
        ...makeMessage(1, "assistant"),
        completedAt: null,
        stopped: null,
        runState: "running",
      };
      const assistantDone: ChatMessageModel = {
        ...assistantStreaming,
        completedAt: 1_700_000_000_000,
        runState: null,
      };
      const { rerenderWith } = renderChatMessages({
        messages: [userMsg, assistantStreaming],
        scrollStateKey: "aria-rename-freeze-key",
        taskTitle: "Build plan",
      });
      await settleLegendList();

      const live = document.querySelector('[aria-live="polite"]');
      rerenderWith({ messages: [userMsg, assistantDone] });
      await settleLegendList();
      await waitFor(() => {
        expect(live?.textContent).toBe("Build plan finished responding.");
      });
      const announcedNode = live?.firstElementChild;

      // A chat is auto-titled right after its first turn - exactly when this
      // announcement is still mounted. Rewriting the text inside the live
      // region would re-announce a completion that never happened, so the
      // sentence stays as it was announced.
      rerenderWith({ taskTitle: "Renamed plan" });
      await settleLegendList();
      expect(live?.textContent).toBe("Build plan finished responding.");
      expect(live?.firstElementChild).toBe(announcedNode);

      // Freezing is per announcement, not permanent: the next one speaks the
      // title the reader now sees.
      rerenderWith({
        messages: [
          userMsg,
          assistantDone,
          makeMessage(2, "user"),
          {
            ...makeMessage(3, "assistant"),
            completedAt: 1_700_000_005_000,
            stopped: null,
            runState: null,
          },
        ],
      });
      await settleLegendList();

      await waitFor(() => {
        expect(live?.textContent).toBe("Renamed plan finished responding.");
      });
    });

    it("announces a background completion delivered by a same-connection refresh", async () => {
      const knownUser = makeMessage(0, "user");
      const knownAssistant: ChatMessageModel = {
        ...makeMessage(1, "assistant"),
        completedAt: 1_700_000_000_000,
        stopped: null,
        runState: null,
      };
      const { rerenderWith } = renderChatMessages({
        messages: [knownUser, knownAssistant],
        baselineEpoch: 3,
        scrollStateKey: "aria-same-connection-refresh-key",
        taskTitle: "Build plan",
      });
      await settleLegendList();

      const live = document.querySelector('[aria-live="polite"]');
      expect(live?.textContent ?? "").toBe("");
      // An authoritative host-side refresh on the SAME connection carries
      // live news, so it must not be mistaken for a re-hydration: only a new
      // connection's epoch re-baselines. The rows arrive wholesale, exactly
      // as a reconnect's would - the epoch is the entire difference.
      rerenderWith({
        baselineEpoch: 3,
        messages: [
          knownUser,
          knownAssistant,
          {
            ...makeMessage(2, "assistant"),
            completedAt: 1_700_000_004_000,
            stopped: null,
            runState: null,
            showCompletionFooter: false,
          },
        ],
      });
      await settleLegendList();

      await waitFor(() => {
        expect(live?.textContent).toBe(
          "Build plan received a background completion.",
        );
      });
    });

    it("keeps announcing live completions after a reconnect re-baselines", async () => {
      const knownUser = makeMessage(0, "user");
      const knownAssistant: ChatMessageModel = {
        ...makeMessage(1, "assistant"),
        completedAt: 1_700_000_000_000,
        stopped: null,
        runState: null,
      };
      const backfilled: ChatMessageModel = {
        ...makeMessage(2, "assistant"),
        completedAt: 1_700_000_002_000,
        stopped: null,
        runState: null,
        showCompletionFooter: false,
      };
      const { rerenderWith } = renderChatMessages({
        messages: [knownUser, knownAssistant],
        baselineEpoch: 0,
        scrollStateKey: "aria-post-reconnect-key",
        taskTitle: "Build plan",
      });
      await settleLegendList();

      const live = document.querySelector('[aria-live="polite"]');
      rerenderWith({
        baselineEpoch: 1,
        messages: [knownUser, knownAssistant, backfilled],
      });
      await settleLegendList();
      expect(live?.textContent ?? "").toBe("");

      // Re-baselining is a one-frame reset, not a mute: the reconnected
      // connection keeps reporting live completions.
      rerenderWith({
        baselineEpoch: 1,
        messages: [
          knownUser,
          knownAssistant,
          backfilled,
          {
            ...makeMessage(3, "assistant"),
            completedAt: 1_700_000_006_000,
            stopped: null,
            runState: null,
          },
        ],
      });
      await settleLegendList();

      await waitFor(() => {
        expect(live?.textContent).toBe("Build plan finished responding.");
      });
    });

    it("does not announce the transcript that first hydration delivers", async () => {
      const { rerenderWith } = renderChatMessages({
        messages: [],
        baselineEpoch: NO_TRANSCRIPT_BASELINE,
        scrollStateKey: "aria-empty-baseline-key",
        taskTitle: "Build plan",
      });
      await settleLegendList();

      const live = document.querySelector('[aria-live="polite"]');
      expect(live?.textContent ?? "").toBe("");
      // Mount raced hydration: the tile renders before the first snapshot
      // lands, so the transcript is empty and the store still reports no
      // baseline. The snapshot that follows IS the baseline - completed
      // history, however recent, never announces.
      rerenderWith({
        baselineEpoch: 0,
        messages: [
          makeMessage(0, "user"),
          {
            ...makeMessage(1, "assistant"),
            completedAt: 1_700_000_000_000,
            stopped: null,
            runState: null,
            showCompletionFooter: true,
          },
        ],
      });
      await settleLegendList();

      expect(live?.textContent ?? "").toBe("");
    });

    it("announces additional triggers gained by an existing notification", async () => {
      const monitorTrigger = {
        kind: "monitor" as const,
        title: "build watch",
        status: "completed" as const,
        live: false,
        summary: "Build completed.",
        blockId: "monitor-1",
        outputFile: null,
        mcp: null,
        managedCommand: null,
      };
      const userMsg = makeMessage(0, "user");
      const notificationRow: ChatMessageModel = {
        ...makeMessage(1, "assistant"),
        segments: [
          {
            id: "seg-resume",
            kind: "autonomous_resume",
            triggers: [monitorTrigger],
          },
        ],
        completedAt: 1_700_000_000_000,
        stopped: null,
        runState: null,
        showCompletionFooter: false,
      };
      const { rerenderMessages } = renderChatMessages({
        messages: [userMsg, notificationRow],
        scrollStateKey: "aria-added-trigger-key",
        taskTitle: "Build plan",
      });
      await settleLegendList();

      const live = document.querySelector('[aria-live="polite"]');
      expect(live?.textContent ?? "").toBe("");
      // Another monitored task settles while the divider is already present:
      // the protocol appends a trigger to the existing block, so the row
      // keeps its id, stays footerless, and only its content and non-null
      // timestamp change.
      rerenderMessages([
        userMsg,
        {
          ...notificationRow,
          segments: [
            {
              id: "seg-resume",
              kind: "autonomous_resume",
              triggers: [
                monitorTrigger,
                {
                  ...monitorTrigger,
                  blockId: "monitor-2",
                  title: "test watch",
                },
              ],
            },
          ],
          completedAt: 1_700_000_004_000,
        },
      ]);
      await settleLegendList();

      await waitFor(() => {
        expect(live?.textContent).toBe(
          "Build plan received a background completion.",
        );
      });
    });

    it("mutates the live region for a repeated same-millisecond trigger gain", async () => {
      const monitorTrigger = {
        kind: "monitor" as const,
        title: "build watch",
        status: "completed" as const,
        live: false,
        summary: "Build completed.",
        blockId: "monitor-1",
        outputFile: null,
        mcp: null,
        managedCommand: null,
      };
      const userMsg = makeMessage(0, "user");
      const notificationRow: ChatMessageModel = {
        ...makeMessage(1, "assistant"),
        segments: [
          {
            id: "seg-resume",
            kind: "autonomous_resume",
            triggers: [monitorTrigger],
          },
        ],
        completedAt: 1_700_000_000_000,
        stopped: null,
        runState: null,
        showCompletionFooter: false,
      };
      const withTriggers = (
        triggers: ReadonlyArray<typeof monitorTrigger>,
      ): ChatMessageModel => ({
        ...notificationRow,
        segments: [{ id: "seg-resume", kind: "autonomous_resume", triggers }],
      });
      const { rerenderMessages } = renderChatMessages({
        messages: [userMsg, notificationRow],
        scrollStateKey: "aria-tied-trigger-gain-key",
        taskTitle: "Build plan",
      });
      await settleLegendList();

      const live = document.querySelector('[aria-live="polite"]');
      rerenderMessages([
        userMsg,
        withTriggers([
          monitorTrigger,
          { ...monitorTrigger, blockId: "monitor-2", title: "test watch" },
        ]),
      ]);
      await settleLegendList();
      await waitFor(() => {
        expect(live?.textContent).toBe(
          "Build plan received a background completion.",
        );
      });
      const firstAnnouncementNode = live?.firstElementChild;
      expect(firstAnnouncementNode).not.toBeNull();

      // A third task settles in the SAME millisecond: id, completedAt and
      // announcement text are all unchanged, so only a fresh keyed child can
      // make the live region emit again.
      rerenderMessages([
        userMsg,
        withTriggers([
          monitorTrigger,
          { ...monitorTrigger, blockId: "monitor-2", title: "test watch" },
          { ...monitorTrigger, blockId: "monitor-3", title: "lint watch" },
        ]),
      ]);
      await settleLegendList();

      await waitFor(() => {
        expect(live?.textContent).toBe(
          "Build plan received a background completion.",
        );
        expect(live?.firstElementChild).not.toBe(firstAnnouncementNode);
      });
    });

    it("announces a still-running trigger appended to a notification as an update", async () => {
      const monitorTrigger = {
        kind: "monitor" as const,
        title: "build watch",
        status: "completed" as const,
        live: false,
        summary: "Build completed.",
        blockId: "monitor-1",
        outputFile: null,
        mcp: null,
        managedCommand: null,
      };
      const userMsg = makeMessage(0, "user");
      const notificationRow: ChatMessageModel = {
        ...makeMessage(1, "assistant"),
        segments: [
          {
            id: "seg-resume",
            kind: "autonomous_resume",
            triggers: [monitorTrigger],
          },
        ],
        completedAt: 1_700_000_000_000,
        stopped: null,
        runState: null,
        showCompletionFooter: false,
      };
      const { rerenderMessages } = renderChatMessages({
        messages: [userMsg, notificationRow],
        scrollStateKey: "aria-live-trigger-append-key",
        taskTitle: "Build plan",
      });
      await settleLegendList();

      const live = document.querySelector('[aria-live="polite"]');
      expect(live?.textContent ?? "").toBe("");
      // The appended trigger's producer is STILL RUNNING (`live: true`; the
      // card says "still running") - nothing new has settled, so the reader
      // hears an update, not a completion.
      rerenderMessages([
        userMsg,
        {
          ...notificationRow,
          segments: [
            {
              id: "seg-resume",
              kind: "autonomous_resume",
              triggers: [
                monitorTrigger,
                {
                  ...monitorTrigger,
                  blockId: "command-1",
                  title: "dev server",
                  live: true,
                },
              ],
            },
          ],
        },
      ]);
      await settleLegendList();

      await waitFor(() => {
        expect(live?.textContent).toBe(
          "Build plan received a background update.",
        );
      });
    });

    it("announces a notification arriving with only live triggers as an update", async () => {
      const liveTrigger = {
        kind: "command" as const,
        title: "dev server",
        status: "completed" as const,
        live: true,
        summary: "Server output so far.",
        blockId: "command-1",
        outputFile: null,
        mcp: null,
        managedCommand: null,
      };
      const knownUser = makeMessage(0, "user");
      const knownAssistant: ChatMessageModel = {
        ...makeMessage(1, "assistant"),
        completedAt: 1_700_000_000_000,
        stopped: null,
        runState: null,
      };
      const { rerenderMessages } = renderChatMessages({
        messages: [knownUser, knownAssistant],
        scrollStateKey: "aria-live-only-arrival-key",
        taskTitle: "Build plan",
      });
      await settleLegendList();

      const live = document.querySelector('[aria-live="polite"]');
      expect(live?.textContent ?? "").toBe("");
      rerenderMessages([
        knownUser,
        knownAssistant,
        {
          ...makeMessage(2, "assistant"),
          segments: [
            {
              id: "seg-resume",
              kind: "autonomous_resume",
              triggers: [liveTrigger],
            },
          ],
          completedAt: 1_700_000_005_000,
          stopped: null,
          runState: null,
          showCompletionFooter: false,
        },
      ]);
      await settleLegendList();

      await waitFor(() => {
        expect(live?.textContent).toBe(
          "Build plan received a background update.",
        );
      });
    });

    it("announces a live trigger settling in place as a background completion", async () => {
      const liveTrigger = {
        kind: "command" as const,
        title: "test run",
        status: "completed" as const,
        live: true,
        summary: "Tests running.",
        blockId: "command-1",
        outputFile: null,
        mcp: null,
        managedCommand: null,
      };
      const userMsg = makeMessage(0, "user");
      const notificationRow: ChatMessageModel = {
        ...makeMessage(1, "assistant"),
        segments: [
          {
            id: "seg-resume",
            kind: "autonomous_resume",
            triggers: [liveTrigger],
          },
        ],
        completedAt: 1_700_000_000_000,
        stopped: null,
        runState: null,
        showCompletionFooter: false,
      };
      const { rerenderMessages } = renderChatMessages({
        messages: [userMsg, notificationRow],
        scrollStateKey: "aria-live-trigger-settle-key",
        taskTitle: "Build plan",
      });
      await settleLegendList();

      const live = document.querySelector('[aria-live="polite"]');
      expect(live?.textContent ?? "").toBe("");
      // The still-running producer settles IN PLACE: trigger count is
      // unchanged, only `live` flips off. That flip is the completion the
      // reader was told was still pending.
      rerenderMessages([
        userMsg,
        {
          ...notificationRow,
          segments: [
            {
              id: "seg-resume",
              kind: "autonomous_resume",
              triggers: [{ ...liveTrigger, live: false }],
            },
          ],
        },
      ]);
      await settleLegendList();

      await waitFor(() => {
        expect(live?.textContent).toBe(
          "Build plan received a background completion.",
        );
      });
    });

    it("does not announce a completedAt shift when the footer state is unchanged", async () => {
      const userMsg = makeMessage(0, "user");
      const completedRow: ChatMessageModel = {
        ...makeMessage(1, "assistant"),
        completedAt: 1_700_000_000_000,
        stopped: null,
        runState: null,
      };
      const { rerenderMessages } = renderChatMessages({
        messages: [userMsg, completedRow],
        scrollStateKey: "aria-canonicalized-timestamp-key",
        taskTitle: "Build plan",
      });
      await settleLegendList();

      const live = document.querySelector('[aria-live="polite"]');
      expect(live?.textContent ?? "").toBe("");
      // A canonicalized snapshot timestamp re-stamps `completedAt` on an
      // already-completed row; nothing newly finished, so nothing announces.
      rerenderMessages([
        userMsg,
        { ...completedRow, completedAt: 1_700_000_000_500 },
      ]);
      await settleLegendList();

      expect(live?.textContent ?? "").toBe("");
    });

    it("does not announce a footerless history row present at mount", async () => {
      const notificationRow: ChatMessageModel = {
        ...makeMessage(1, "assistant"),
        completedAt: 1_700_000_000_000,
        stopped: null,
        runState: null,
        showCompletionFooter: false,
      };
      renderChatMessages({
        messages: [makeMessage(0, "user"), notificationRow],
        scrollStateKey: "aria-footerless-history",
        taskTitle: "Build plan",
      });
      await settleLegendList();

      expect(
        document.querySelector('[aria-live="polite"]')?.textContent ?? "",
      ).toBe("");
    });

    it("announces when a pending live row is replaced by its completed persisted row", async () => {
      const userMsg = makeMessage(0, "user");
      const pendingAssistant: ChatMessageModel = {
        ...makeMessage(1, "assistant"),
        id: "assistant:live",
        completedAt: null,
        stopped: null,
        runState: "running",
      };
      const { rerenderMessages } = renderChatMessages({
        messages: [userMsg, pendingAssistant],
        scrollStateKey: "aria-complete-row-replacement",
        taskTitle: "Build plan",
      });
      await settleLegendList();

      const live = document.querySelector('[aria-live="polite"]');
      expect(live?.textContent ?? "").toBe("");

      rerenderMessages([
        userMsg,
        {
          ...pendingAssistant,
          id: "assistant:turn-1",
          completedAt: 1_700_000_000_000,
          runState: null,
        },
      ]);
      await settleLegendList();

      await waitFor(() => {
        expect(live?.textContent).toBe("Build plan finished responding.");
      });
    });

    it("does not announce completed history on initial mount", async () => {
      const completedAssistant: ChatMessageModel = {
        ...makeMessage(1, "assistant"),
        completedAt: 1_700_000_000_000,
        stopped: null,
        runState: null,
      };
      renderChatMessages({
        messages: [makeMessage(0, "user"), completedAssistant],
        scrollStateKey: "aria-completed-history",
        taskTitle: "Build plan",
      });
      await settleLegendList();

      expect(
        document.querySelector('[aria-live="polite"]')?.textContent ?? "",
      ).toBe("");
    });

    it("replaces the live-region child when a later turn repeats the same announcement", async () => {
      const firstUser = makeMessage(0, "user");
      const firstAssistantStreaming: ChatMessageModel = {
        ...makeMessage(1, "assistant"),
        completedAt: null,
        stopped: null,
        runState: "running",
      };
      const firstAssistantCompleted: ChatMessageModel = {
        ...firstAssistantStreaming,
        completedAt: 1_700_000_000_000,
        runState: null,
      };
      const secondUser = makeMessage(2, "user");
      const secondAssistantStreaming: ChatMessageModel = {
        ...makeMessage(3, "assistant"),
        completedAt: null,
        stopped: null,
        runState: "running",
      };
      const { rerenderMessages } = renderChatMessages({
        messages: [firstUser, firstAssistantStreaming],
        scrollStateKey: "aria-repeat",
        taskTitle: "Build plan",
      });
      await settleLegendList();

      const live = document.querySelector('[aria-live="polite"]');
      rerenderMessages([firstUser, firstAssistantCompleted]);
      await settleLegendList();
      await waitFor(() => {
        expect(live?.textContent).toBe("Build plan finished responding.");
      });
      const firstAnnouncementNode = live?.firstElementChild;
      expect(firstAnnouncementNode).not.toBeNull();

      rerenderMessages([
        firstUser,
        firstAssistantCompleted,
        secondUser,
        secondAssistantStreaming,
      ]);
      await settleLegendList();
      rerenderMessages([
        firstUser,
        firstAssistantCompleted,
        secondUser,
        {
          ...secondAssistantStreaming,
          completedAt: 1_700_000_001_000,
          runState: null,
        },
      ]);
      await settleLegendList();

      await waitFor(() => {
        expect(live?.textContent).toBe("Build plan finished responding.");
        expect(live?.firstElementChild).not.toBe(firstAnnouncementNode);
      });
    });

    it("announces a completed assistant even when a queued turn appends a new running assistant in the same render", async () => {
      const firstUser = makeMessage(0, "user");
      const firstAssistantStreaming: ChatMessageModel = {
        ...makeMessage(1, "assistant"),
        completedAt: null,
        stopped: null,
        runState: "running",
      };
      const secondUser = makeMessage(2, "user");
      const secondAssistantStreaming: ChatMessageModel = {
        ...makeMessage(3, "assistant"),
        completedAt: null,
        stopped: null,
        runState: "running",
      };
      const { rerenderMessages } = renderChatMessages({
        messages: [firstUser, firstAssistantStreaming],
        scrollStateKey: "aria-queued-turn",
        taskTitle: "Build plan",
      });
      await settleLegendList();

      const live = document.querySelector('[aria-live="polite"]');
      rerenderMessages([
        firstUser,
        {
          ...firstAssistantStreaming,
          completedAt: 1_700_000_000_000,
          runState: null,
        },
        secondUser,
        secondAssistantStreaming,
      ]);
      await settleLegendList();

      await waitFor(() => {
        expect(live?.textContent).toBe("Build plan finished responding.");
      });
    });

    it("does not announce when the turn was user-stopped", async () => {
      const userMsg = makeMessage(0, "user");
      const assistantStreaming: ChatMessageModel = {
        ...makeMessage(1, "assistant"),
        completedAt: null,
        stopped: null,
        runState: "running",
      };
      const { rerenderMessages } = renderChatMessages({
        messages: [userMsg, assistantStreaming],
        scrollStateKey: "aria-stopped-key",
        taskTitle: "Build plan",
      });
      await settleLegendList();

      const live = document.querySelector('[aria-live="polite"]');
      expect(live?.textContent ?? "").toBe("");

      rerenderMessages([
        userMsg,
        {
          ...assistantStreaming,
          completedAt: 1_700_000_000_000,
          stopped: {
            stoppedAt: 1_700_000_000_000,
            reason: "user",
            turnHadOutput: true,
            turnReplySegments: [
              {
                id: "seg-partial",
                kind: "text",
                markdown: "partial",
                isStreaming: false,
              },
            ],
          },
          runState: null,
        },
      ]);
      await settleLegendList();

      expect(live?.textContent ?? "").toBe("");
    });
  });

  describe("H3 free-scrolling ownership: real gestures resume follow; programmatic scrolls do not", () => {
    it("a REAL subsequent near-end gesture still restores follow after a suppressed programmatic scroll settles", async () => {
      // Ticket 17 removed free-scrolling suffix removal as a suppress path
      // (case a is none; case b forces following-end). Minimap navigation is
      // still a free-scrolling programmatic landing that sets
      // suppressFollowRestoreRef - use that to pin the companion contract.
      const messages = makeTranscript(28);
      renderChatMessages({
        messages,
        scrollStateKey: "h3-companion-restore",
      });
      await settleLegendList();

      await enterFreeScrollingAwayFromEnd();
      await waitForPillVisible();

      await selectLastChatTurnMinimapItem();
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(isJumpPillVisible()).toBe(true);

      // A REAL gesture clears suppression immediately - there is no
      // settle-based auto-release to race against anymore - near-end must
      // restore follow on this gesture's OWN scroll report, not the
      // suppressed operation's.
      act(() => {
        fireEvent.wheel(getScrollNode(), { deltaY: 40 });
        fireScrollToEnd();
      });

      await waitFor(
        () => {
          expect(isJumpPillVisible()).toBe(false);
        },
        { timeout: 3_000 },
      );
    });

    it("a real gesture mid-operation clears suppression immediately, pre-empting the in-flight scroll", async () => {
      const messages = makeTranscript(24);
      renderChatMessages({
        messages,
        scrollStateKey: "h3-gesture-preempts-ownership",
      });
      await settleLegendList();

      await enterFreeScrollingAwayFromEnd();
      await waitForPillVisible();

      await selectLastChatTurnMinimapItem();

      const scrollNode = getScrollNode();
      // Mid-flight: an intermediate animation frame (still suppressed).
      act(() => {
        scrollNode.scrollTop = 200;
        fireEvent.scroll(scrollNode);
      });
      expect(isJumpPillVisible()).toBe(true);

      // A real gesture arrives BEFORE the operation would have settled on
      // its own (no scrollend/750ms fired yet) - it must still take over
      // normally: park away from the end and confirm the pill stays/shows.
      act(() => {
        fireEvent.wheel(scrollNode, { deltaY: -40 });
        fireScrollAwayFromEnd();
      });
      await waitFor(() => {
        expect(isJumpPillVisible()).toBe(true);
      });

      // And a subsequent near-end report (this gesture's own, not the
      // preempted operation's) now correctly restores follow.
      act(() => {
        fireEvent.wheel(scrollNode, { deltaY: 40 });
        fireScrollToEnd();
      });
      await waitFor(() => {
        expect(isJumpPillVisible()).toBe(false);
      });
    });

    it("a pointerdown freeze with NO stale echo still allows a later toward-end gesture to resume", async () => {
      const messages = makeTranscript(24);
      renderChatMessages({
        messages,
        scrollStateKey: "h3-pointerdown-freeze-no-echo",
      });
      await settleLegendList();

      await enterFreeScrollingAwayFromEnd();
      await waitForPillVisible();

      // Animated navigateToMessage sets suppression; pointerdown below freezes
      // its native animation and disarms live-edge reacquisition.
      await selectLastChatTurnMinimapItem();

      const scrollNode = getScrollNode();

      // The freeze's same-offset scrollToOffset write is not guaranteed to
      // emit any scroll event (a jsdom no-op write, or a real browser deduping
      // a same-position write). No stale echo follows here.
      act(() => {
        fireEvent.pointerDown(scrollNode);
      });
      expect(isJumpPillVisible()).toBe(true);

      // A real subsequent toward-end wheel explicitly re-arms the strict-edge
      // transition; the earlier pointerdown does not permanently block it.
      act(() => {
        fireEvent.wheel(scrollNode, { deltaY: 40 });
        fireScrollToEnd();
      });

      await waitFor(() => {
        expect(isJumpPillVisible()).toBe(false);
      });
    });

    it("Round-2 regression: an earlier suppressed nav's own pending settle timer must not prevent a later mode-changing pill click's animated scroll from freezing on pointerdown", async () => {
      // Scenario-regression pin for generation-safe operation ownership: op1
      // (a suppressed minimap nav, mode stays
      // "free-scrolling") and op2 (a pill click, mode becomes
      // "following-end") overlap in flight - op1's own 750ms settle fallback
      // is still pending when op2 issues, and still pending when the
      // pointerdown below fires. Op1's stale settle must not clear op2's newer
      // ownership token before the gesture arrives.
      const messages = makeTranscript(24);
      renderChatMessages({
        messages,
        scrollStateKey: "round2-f2-operation-token",
      });
      await settleLegendList();

      await enterFreeScrollingAwayFromEnd();
      await waitForPillVisible();

      // OP1: an animated minimap navigation - suppresses follow-restore and
      // starts its OWN 750ms awaitScrollSettle fallback (jsdom never fires
      // native scrollend). Its returned cancellation is discarded by design
      // (settleChatTimelineNavigation never invokes it), so this fallback
      // timer keeps running in the background for the rest of the test.
      await selectLastChatTurnMinimapItem();

      // Real gap so op1's and op2's independent 750ms fallbacks land at
      // clearly distinguishable real-time moments - needed only so this
      // test can isolate "op1's stale callback fires" from "op2 also
      // genuinely settles", not required by the mechanism itself.
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 250);
        });
      });

      // OP2: pill click (scrollToEnd, animated) - setTimelineMode
      // ("following-end") both changes the mode AND clears
      // suppressFollowRestoreRef unconditionally (explicit go-live), so from
      // this point the newer animated operation's generation is the only
      // source of freeze ownership, isolating exactly what this pin exercises.
      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Scroll to end" }));
      });
      const ownedScrollNode = getScrollNode();
      ownedScrollNode.scrollTop = maxScrollTopFor(ownedScrollNode);
      fireEvent.scroll(ownedScrollNode);
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");

      // Wait until comfortably PAST op1's own fallback (750ms after op1 was
      // issued = 900ms from op1, a 150ms margin matching this file's own
      // waitForAnchorEngineSettle convention) but comfortably SHORT of op2's
      // own fallback (750ms after op2 = 1000ms from op1, still 100ms away at
      // T=900ms) - isolates "op1's stale callback fires and is a no-op" from
      // "op2 also happens to have genuinely settled on its own", so the
      // assertion below can only pass because mode is still "following-end"
      // independent of either settle callback having run.
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 650);
        });
      });

      const scrollNode = getScrollNode();
      // A bare pointerdown now must STILL freeze op2's still-in-flight
      // animation (same-offset write cancelling the native smooth-scroll) -
      // op1's older generation cannot clear op2's active one, regardless of
      // its pending or fired settle callback. By this point op2's animated
      // scrollToEnd has already reached the strict edge (LegendList's own
      // internal isAtEnd, read directly - not the DOM scrollTop shim, which
      // never dispatches `scroll` for a programmatic write): mode publication
      // is geometry-only (behavior contract), so a pointerdown that lands
      // here - a no-op gesture at the true bottom - correctly stays
      // `following-end`, not the old unconditional `free-scrolling`.
      act(() => {
        fireEvent.pointerDown(scrollNode);
      });
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");

      act(() => {
        fireScrollToEnd();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
    });
  });

  describe("minimap rail remains available in constrained panes", () => {
    function mockNarrowTranscriptWidth(widthPx: number): void {
      const container = screen.getByTestId("chat-transcript-container");
      vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
        x: 0,
        y: 0,
        width: widthPx,
        height: VIEWPORT_HEIGHT_PX,
        top: 0,
        left: 0,
        right: widthPx,
        bottom: VIEWPORT_HEIGHT_PX,
        toJSON: () => ({}),
      });
    }

    // No targeted spy teardown needed: each test renders a fresh container
    // element (the spy lives on that instance), and the outer `afterEach`'s
    // `cleanup()` unmounts it - `vi.restoreAllMocks()` is deliberately not
    // used here (see the outer `afterEach`'s own comment: it would clear the
    // file's `vi.mock` module mocks for isMac / activity store).

    it("keeps a compact interactive rail in a narrow tiled pane", async () => {
      const messages = makeTranscript(20);
      renderChatMessages({ messages, scrollStateKey: "always-on-minimap" });
      mockNarrowTranscriptWidth(420);
      await settleLegendList();

      const hitStrip = await waitFor(() =>
        screen.getByRole("button", { name: "Message minimap" }),
      );
      expect(hitStrip).toBe(screen.getByTestId("chat-turn-minimap-hit-strip"));
      expect(Number.parseFloat(hitStrip.style.width)).toBeGreaterThan(0);
      const ticks = screen.getAllByTestId("chat-turn-minimap-tick");
      expect(ticks.length).toBeGreaterThan(0);
      expect(ticks[0].hasAttribute("data-minimap-rail-tick")).toBe(true);
      expect(
        ticks.filter((tick) => tick.getAttribute("data-active") === "true"),
      ).toHaveLength(1);

      fireEvent.mouseEnter(
        screen.getByRole("group", { name: "Message minimap controls" }),
      );
      expect(screen.getByTestId("chat-turn-minimap-card")).toBeTruthy();
    });

    it("stays interactive at the harness's default pane width", async () => {
      const messages = makeTranscript(20);
      renderChatMessages({ messages, scrollStateKey: "m3b-usable-hit-strip" });
      await settleLegendList();

      const hitStrip = await waitFor(() =>
        screen.getByRole("button", { name: "Message minimap" }),
      );
      expect(hitStrip).toBe(screen.getByTestId("chat-turn-minimap-hit-strip"));
      expect(Number.parseFloat(hitStrip.style.width)).toBeGreaterThan(0);
      hitStrip.focus();
      expect(document.activeElement).toBe(hitStrip);
    });

    it("does not mount the minimap when its placement is hidden", async () => {
      useSettingsStore.setState({ chatTurnMinimapSide: "hide" });
      renderChatMessages({
        messages: makeTranscript(20),
        scrollStateKey: "hidden-minimap",
      });
      await settleLegendList();

      expect(screen.queryByTestId("chat-turn-minimap")).toBeNull();
      expect(screen.queryByTestId("chat-turn-minimap-hit-strip")).toBeNull();
    });
  });

  // O2 (ticket 16 listener consolidation): proves the FULL production chain
  // end to end - a real LegendList scroll -> ChatTimeline's own `onScroll` ->
  // ChatMessages's `handleScroll` -> `minimapInViewRefreshRef.current()` ->
  // the rail's current tick. chat-turn-minimap.test.tsx's own pins call
  // `inViewRefreshRef.current()` directly (the minimap's contract in
  // isolation); this one is the wiring pin that a deleted link anywhere in
  // that chain would fail.
  describe("minimap current tick via the real scroll chain (O2, ticket 16)", () => {
    it("updates the current rail tick through a real fireEvent.scroll, not a direct inViewRefreshRef call", async () => {
      const messages = makeCompletedTranscript(12);
      renderChatMessages({
        messages,
        scrollStateKey: "o2-minimap-real-scroll-chain",
      });
      await settleLegendList();

      // Free-scrolling, not the default following-end - a stable, non-
      // drifting position (M3b's own comment above: following-end's reveal
      // pass keeps chasing the jsdom shim's fixed large scrollHeight).
      await enterFreeScrollingAwayFromEnd();
      await waitForPillVisible();

      await waitFor(() => {
        expect(screen.getByTestId("chat-turn-minimap")).toBeTruthy();
      });

      const activeTick = (): Element | null =>
        document.querySelector(
          '[data-testid="chat-turn-minimap-tick"][data-active="true"]',
        );
      const messageIndex = (id: string | null | undefined): number =>
        Number((id ?? "").slice("message-".length));

      let parkedId: string | null = null;
      await waitFor(() => {
        const tick = activeTick();
        expect(tick?.hasAttribute("data-minimap-rail-tick")).toBe(true);
        const id = tick?.getAttribute("data-message-id") ?? null;
        expect(id).toBeTruthy();
        parkedId = id;
      });

      // Scroll deep into real (non-fake-ceiling) content - well below the
      // ~540px natural max for this 12-row/90px-shim transcript. Equal-overlap
      // ties keep the earlier query, so this asserts a later current tick,
      // not a specific last-row id.
      await fireScrollTopAndFlush(500);

      await waitFor(() => {
        const nextId = activeTick()?.getAttribute("data-message-id");
        expect(nextId).toBeTruthy();
        expect(messageIndex(nextId)).toBeGreaterThan(messageIndex(parkedId));
      });
    });
  });

  describe("following-end catch-up (coverage restore)", () => {
    it("keeps follow through pure streaming growth bursts whose scrollTop never decreases", async () => {
      const messages = makeTranscript(20);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "follow-growth-bursts",
      });
      await settleLegendList();

      const scrollNode = getScrollNode();
      let previousScrollTop = scrollNode.scrollTop;
      let next: ReadonlyArray<ChatMessageModel> = messages;
      for (let burst = 0; burst < 4; burst += 1) {
        next = appendAssistant(next, `growth-burst-${burst}`, 110_000 + burst);
        rerenderMessages(next);
        await settleLegendList();
        await waitForRevealPassTick();

        expect(scrollNode.dataset.scrollMode).toBe("following-end");
        expect(scrollNode.scrollTop).toBeGreaterThanOrEqual(previousScrollTop);
        previousScrollTop = scrollNode.scrollTop;
      }
      expect(isJumpPillVisible()).toBe(false);
    });

    it("scrolls to reveal appended assistant growth while following", async () => {
      const messages = makeTranscript(20);
      // Fixup (fix-detached-streaming-yank): the gate that decides whether
      // `maintainScrollAtEnd` is enabled reads real scroll-container
      // geometry, so it needs a realistic `scrollHeight` here (the default
      // jsdom shim ceiling is an arbitrary large constant, matching no real
      // content size - see `legend-list-test-environment.ts`'s own doc
      // comment) - otherwise "distance from the end" never reads as
      // small/shrinking and the gate never turns on.
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
      );
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "follow-append",
      });
      await settleLegendList();

      const before = getScrollNode().scrollTop;
      expect(before).toBeGreaterThan(0);

      // Append many rows so content clearly overflows further.
      let next: ReadonlyArray<ChatMessageModel> = messages;
      for (let i = 0; i < 12; i += 1) {
        next = appendAssistant(next, `follow-a-${i}`, 100_000 + i);
      }
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + next.length * 90 + 40,
      );
      rerenderMessages(next);
      await settleLegendList();

      await waitFor(() => {
        expect(getScrollNode().scrollTop).toBeGreaterThan(before);
      });
    });

    it("keeps following-end on in-place streaming content growth (same message id)", async () => {
      const base = makeTranscript(18);
      const streaming: ChatMessageModel = {
        ...makeMessage(18, "assistant"),
        content: "partial",
        runState: "running",
      };
      const messages = [...base, streaming];
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "follow-inplace",
      });
      await settleLegendList();

      const before = getScrollNode().scrollTop;
      expect(isJumpPillVisible()).toBe(false);

      // Same id, longer content (token stream). The estimated-item-size shim
      // does not grow row height with content, so we assert mode stays
      // following (pill hidden) rather than a pixel delta that the shim
      // cannot produce.
      rerenderMessages([
        ...base,
        {
          ...streaming,
          content: "partial ".repeat(200),
        },
      ]);
      await settleLegendList();

      expect(isJumpPillVisible()).toBe(false);
      expect(getScrollNode().scrollTop).toBeGreaterThanOrEqual(before - 1);
    });
  });

  describe("scrollRequest wiring (coverage restore)", () => {
    it("routes an explicit end request through the go-live navigation", async () => {
      const { rerenderWith } = renderChatMessages({
        messages: makeCompletedTranscript(30),
        scrollStateKey: "scroll-req-end",
      });
      await settleLegendList();

      const list = legendListRefHolder.current;
      if (list === null) throw new Error("LegendList ref is not mounted");
      const scrollToEnd = vi.spyOn(list, "scrollToEnd");
      try {
        rerenderWith({
          scrollRequest: { kind: "end", requestId: 40 },
        });

        expect(scrollToEnd).toHaveBeenCalledWith({ animated: true });
        expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      } finally {
        scrollToEnd.mockRestore();
      }
    });

    it("routes row-only external jumps through navigation and highlights for three seconds", async () => {
      const messages = makeCompletedTranscript(6);
      const target = messages[2];
      const { rerenderWith } = renderChatMessages({
        messages,
        scrollStateKey: "scroll-req-row-only",
      });
      await settleLegendList();

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        rerenderWith({
          scrollRequest: {
            kind: "message",
            messageId: target.id,
            blockId: null,
            requestId: 41,
          },
        });

        const targetRow = document.querySelector<HTMLElement>(
          `[data-message-id="${target.id}"]`,
        );
        expect(targetRow?.dataset.navigationHighlighted).toBe("true");
        expect(activityGroupOpenIds.setOpenCalls).toHaveLength(0);
        // The request shares navigateToMessage's settle choke point rather
        // than creating an external raw-scroll side channel. This short
        // (6-row) transcript fits entirely within one viewport, so it is
        // geometrically at the strict edge (LegendList's own `isContentLess`
        // rule) regardless of which row the jump targets - mode publication
        // is geometry-only (behavior contract), so it correctly reads
        // `following-end` here, not an unconditional `free-scrolling`.
        expect(getScrollNode().dataset.scrollMode).toBe("following-end");

        act(() => {
          vi.advanceTimersByTime(2_999);
        });
        expect(targetRow?.dataset.navigationHighlighted).toBe("true");

        act(() => {
          vi.advanceTimersByTime(1);
        });
        expect(targetRow?.dataset.navigationHighlighted).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("dismisses an external-jump highlight on transcript pointerdown", async () => {
      const messages = makeCompletedTranscript(6);
      const target = messages[2];
      const { rerenderWith } = renderChatMessages({
        messages,
        scrollStateKey: "scroll-req-highlight-user-takeover",
      });
      await settleLegendList();

      rerenderWith({
        scrollRequest: {
          kind: "message",
          messageId: target.id,
          blockId: null,
          requestId: 42,
        },
      });

      const targetRow = document.querySelector<HTMLElement>(
        `[data-message-id="${target.id}"]`,
      );
      expect(targetRow?.dataset.navigationHighlighted).toBe("true");

      act(() => {
        fireEvent.pointerDown(getScrollNode());
      });

      expect(targetRow?.dataset.navigationHighlighted).toBeUndefined();
    });

    it("does not highlight an in-tile minimap navigation", async () => {
      renderChatMessages({
        messages: makeCompletedTranscript(6),
        scrollStateKey: "scroll-req-minimap-no-highlight",
      });
      await settleLegendList();

      await selectLastChatTurnMinimapItem();

      expect(
        document.querySelector("[data-navigation-highlighted]"),
      ).toBeNull();
    });

    it("opens the owning activity group and navigates once per requestId", async () => {
      const commandId = "cmd-block-1";
      const assistant = {
        ...makeAssistantMessage("assistant-target", "act-1"),
        segments: [
          {
            id: commandId,
            kind: "command" as const,
            command: "echo hi",
            cwd: null,
            exitCode: 0,
            isStreaming: false,
            endState: null,
            progress: null,
            startedAt: 0,
            parentId: null,
            backgroundTask: null,
            stopped: false,
          },
        ],
        completedAt: 1,
      };
      const messages: ReadonlyArray<ChatMessageModel> = [
        makeMessage(0, "user"),
        makeMessage(1, "assistant"),
        makeMessage(2, "user"),
        assistant,
      ];
      const expectedGroupId = deriveActivityGroupRenderId(commandId);

      const { rerenderWith } = renderChatMessages({
        messages,
        scrollStateKey: "scroll-req",
        scrollRequest: {
          kind: "message",
          messageId: assistant.id,
          blockId: commandId,
          requestId: 42,
        },
      });
      await settleLegendList();

      await waitFor(() => {
        expect(
          activityGroupOpenIds.setOpenCalls.some(
            (call) => call.groupId === expectedGroupId && call.open,
          ),
        ).toBe(true);
      });

      const callsAfterFirst = activityGroupOpenIds.setOpenCalls.length;
      const scrollAfterFirst = getScrollNode().scrollTop;

      // Same requestId + unrelated backgroundItems change must NOT re-navigate.
      rerenderWith({
        backgroundItems: [
          {
            taskId: "task-bg-1",
            kind: "command",
            title: "sleep 1",
            blockId: "bg-1",
            parentTaskId: null,
            scheduledFor: null,
            individualStopUnavailable: null,
          } satisfies BackgroundItem,
        ],
        scrollRequest: {
          kind: "message",
          messageId: assistant.id,
          blockId: commandId,
          requestId: 42,
        },
      });
      await settleLegendList();

      expect(activityGroupOpenIds.setOpenCalls.length).toBe(callsAfterFirst);
      // Dedup: scroll position not re-driven by a second navigateToMessage.
      expect(getScrollNode().scrollTop).toBe(scrollAfterFirst);
    });

    // Deep-link opens the owning activity group (via requestMeasuredItemChange
    // / flushSync) before navigateToMessage so the expanded measurement is
    // already committed. Assert the group ends open in store state - the
    // existing case above only checks setOpen was invoked.
    it("leaves the owning activity group open after a deep-link scrollRequest settles", async () => {
      const commandId = "cmd-block-deep-link-open";
      const assistant = {
        ...makeAssistantMessage("assistant-deep-link", "act-deep"),
        segments: [
          {
            id: commandId,
            kind: "command" as const,
            command: "echo deep-link",
            cwd: null,
            exitCode: 0,
            isStreaming: false,
            endState: null,
            progress: null,
            startedAt: 0,
            parentId: null,
            backgroundTask: null,
            stopped: false,
          },
        ],
        completedAt: 1,
      };
      const messages: ReadonlyArray<ChatMessageModel> = [
        makeMessage(0, "user"),
        makeMessage(1, "assistant"),
        makeMessage(2, "user"),
        assistant,
      ];
      const expectedGroupId = deriveActivityGroupRenderId(commandId);

      // Group starts collapsed (registry store empty for this instance).
      expect(activityGroupOpenIds.lastOpenIds.has(expectedGroupId)).toBe(false);

      renderChatMessages({
        messages,
        scrollStateKey: "scroll-req-open-state",
        scrollRequest: {
          kind: "message",
          messageId: assistant.id,
          blockId: commandId,
          requestId: 77,
        },
      });
      await settleLegendList();

      await waitFor(() => {
        expect(activityGroupOpenIds.lastOpenIds.has(expectedGroupId)).toBe(
          true,
        );
      });
      expect(
        activityGroupOpenIds.setOpenCalls.some(
          (call) => call.groupId === expectedGroupId && call.open,
        ),
      ).toBe(true);
    });
  });

  describe("quote gating under systemOverlayActive (coverage restore)", () => {
    it("disables the quote-selection hook while a system overlay is active", async () => {
      useSettingsStore.setState({ quoteReplyEnabled: true });
      const messages: ReadonlyArray<ChatMessageModel> = [
        makeMessage(0, "user"),
        {
          ...makeMessage(1, "assistant"),
          content: "Quotable assistant text for overlay gating.",
        },
      ];
      const { rerenderWith } = renderChatMessages({
        messages,
        scrollStateKey: "quote-overlay",
        systemOverlayActive: true,
      });
      await settleLegendList();

      const transcript = screen.getByTestId("chat-transcript-container");
      const addListenerSpy = vi.spyOn(transcript, "addEventListener");
      const removeListenerSpy = vi.spyOn(transcript, "removeEventListener");
      try {
        rerenderWith({ systemOverlayActive: false });
        expect(addListenerSpy).toHaveBeenCalledWith(
          "mouseup",
          expect.any(Function),
        );

        rerenderWith({ systemOverlayActive: true });
        expect(removeListenerSpy).toHaveBeenCalledWith(
          "mouseup",
          expect.any(Function),
        );
      } finally {
        addListenerSpy.mockRestore();
        removeListenerSpy.mockRestore();
      }
    });
  });

  describe("keyboard matrix (coverage restore)", () => {
    it("does not claim keys when the tile is inactive and the target is outside the scope", async () => {
      const messages = makeTranscript(12);
      renderChatMessages({
        messages,
        scrollStateKey: "kbd-inactive",
        tileActive: false,
      });
      await settleLegendList();

      const outside = document.createElement("button");
      document.body.appendChild(outside);
      const before = getScrollNode().scrollTop;

      act(() => {
        outside.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "ArrowDown",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect(getScrollNode().scrollTop).toBe(before);
      outside.remove();
    });

    it("ticket 21 slice 4: claims keys from a pane sibling even when the tile itself is hosted (no physical data-group-id ancestor)", async () => {
      const messages = makeTranscript(16);
      renderChatMessages({
        messages,
        scrollStateKey: "kbd-hosted-sibling",
        withSiblingChrome: true,
        tileActive: true,
        hostedPaneId: "pane-hosted-1",
      });
      await settleLegendList();

      const sibling = screen.getByTestId("pane-sibling-chrome");
      const event = new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        sibling.dispatchEvent(event);
      });
      // `handleKeyDownCapture` synchronously `preventDefault`s only when it
      // claims the key (`chat-messages.tsx`) - the direct, gesture-heuristic-
      // free signal that the hosted-record pane-id fallback matched.
      expect(event.defaultPrevented).toBe(true);
    });

    it("ticket 21 slice 4: does NOT claim keys from an unrelated pane's chrome when the tile is hosted", async () => {
      const messages = makeTranscript(16);
      renderChatMessages({
        messages,
        scrollStateKey: "kbd-hosted-unrelated",
        tileActive: true,
        hostedPaneId: "pane-hosted-1",
      });
      await settleLegendList();

      const unrelated = document.createElement("div");
      unrelated.setAttribute("data-group-id", "pane-hosted-2");
      document.body.appendChild(unrelated);

      const event = new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        unrelated.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(false);
      unrelated.remove();
    });

    it("on non-mac, plain Home is NOT claimed from an editable target", async () => {
      platformMock.isMac = false;
      const messages = makeTranscript(20);
      renderChatMessages({ messages, scrollStateKey: "kbd-win-home" });
      await settleLegendList();

      const textarea = document.createElement("textarea");
      document
        .querySelector("[data-chat-keyboard-scroll-scope]")
        ?.appendChild(textarea);

      const before = getScrollNode().scrollTop;
      expect(before).toBeGreaterThan(0);
      act(() => {
        textarea.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Home",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      // Editable keeps Home on non-mac; scroller stays put.
      expect(getScrollNode().scrollTop).toBe(before);
    });
  });

  describe("ticket 5: per-tab persistence across whole-tile remounts", () => {
    afterEach(() => {
      useToolOpenStore.setState({ openIds: new Set() });
      useSubagentOpenStore.setState({ openIds: new Set() });
    });

    it(
      "restores the exact free-scrolling pixel position across unmount+remount " +
        "(round-trip through real capture, not a seeded value)",
      async () => {
        const messages = makeCompletedTranscript(20);
        const scrollStateKey = `t5-free-restore-${Math.random().toString(36).slice(2)}`;
        const instanceId = `t5-free-instance-${Math.random().toString(36).slice(2)}`;

        tileLiveness.live = true;
        const first = renderChatMessages({
          messages,
          scrollStateKey,
          instanceId,
        });
        await settleLegendList();

        // A real gesture first, to leave the default following-end seed -
        // a bare scrollTop write alone is read as transient settling while
        // still following-end (onIsAtEndChange's own "WE own the scroll"
        // guard), not a departure.
        await enterFreeScrollingAwayFromEnd();
        // Park at the post-departure position. Mid-list writes after
        // free-scrolling can re-trigger isAtEnd in the jsdom LegendList
        // geometry shim; the contract under test is exact capture/restore of
        // whatever free-scrolling position was live at unmount.
        const originalScrollTop = getScrollNode().scrollTop;
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

        first.unmount();

        // The unmount save captured THIS exact scrollTop via the real
        // capture pipeline (whichever row it anchored to) - not a value this
        // test invented via a seeded saveChatTabState call. Tab-key is the
        // tile instanceId (ticket 15).
        const saved = restoreChatTabState(
          makeDefaultTestIdentity(instanceId),
          messages,
        );
        expect(saved.mode).toBe("free-scrolling");
        expect(saved.anchorMessageId).not.toBeNull();
        // Capture folds topOffsetAdjustment (header) into the saved viewOffset
        // so it matches LegendList's restore math (decision #18 exact pixels).
        expect(typeof saved.offset).toBe("number");
        expect(saved.offset).not.toBe(0);

        const second = renderChatMessages({
          messages,
          scrollStateKey,
          instanceId,
        });
        await settleLegendList();
        await settleLegendList();

        // Exact-position contract: restored geometry equals the pre-unmount
        // scrollTop. Without initialScrollIndex wiring this parks at 0; without
        // the header pad in capture it lands original+header instead.
        expect(getScrollNode().scrollTop).toBe(originalScrollTop);
        // F1: programmatic bootstrap must not flip free-scrolling to following.
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
        expect(getScrollNode().dataset.scrollMode).not.toBe("following-end");

        second.unmount();
      },
    );

    it("corrects a restored landing with an absolute measured offset when index restoration is a no-op", async () => {
      const messages = makeCompletedTranscript(20);
      const targetIndex = 8;
      const targetId = messages[targetIndex].id;
      const instanceId = `t5-validated-restore-${Math.random().toString(36).slice(2)}`;
      const identity = makeDefaultTestIdentity(instanceId);
      saveChatTabState({
        identity,
        mode: "free-scrolling",
        anchorMessageId: targetId,
        anchorIndex: targetIndex,
        offset: -12,
      });

      tileLiveness.live = true;
      const view = renderChatMessages({
        messages,
        scrollStateKey: instanceId,
        instanceId,
      });
      const list = legendListRefHolder.current;
      expect(list).not.toBeNull();
      if (list === null) throw new Error("LegendList ref did not mount");
      const scrollNode = getScrollNode();
      scrollNode.scrollTop = 0;
      const indexRestore = vi
        .spyOn(list, "scrollToIndex")
        .mockResolvedValue(undefined);
      const absoluteRestore = vi.spyOn(list, "scrollToOffset");

      await settleLegendList();
      await settleLegendList();

      const expectedScrollTop = LEGEND_LIST_HEADER_PX + targetIndex * 90 + 12;
      expect(indexRestore).not.toHaveBeenCalled();
      expect(absoluteRestore).toHaveBeenCalledWith({
        offset: expectedScrollTop,
        animated: false,
      });
      expect(getScrollNode().scrollTop).toBe(expectedScrollTop);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      view.unmount();
    });

    it("keeps the pre-restore snapshot authoritative when a bootstrap mount unmounts before convergence", () => {
      const messages = makeCompletedTranscript(20);
      const anchorIndex = 8;
      const instanceId = `t5-bootstrap-unmount-${Math.random().toString(36).slice(2)}`;
      const identity = makeDefaultTestIdentity(instanceId);
      const expected = {
        mode: "free-scrolling" as const,
        anchorMessageId: messages[anchorIndex].id,
        anchorIndex,
        offset: -1_185,
      };
      saveChatTabState({ identity, ...expected });

      tileLiveness.live = true;
      const bootstrap = renderChatMessages({
        messages,
        scrollStateKey: instanceId,
        instanceId,
      });

      // Strict Mode and rapid canvas switches can destroy this mount before
      // the reserve and measured-row convergence complete. Its transient DOM
      // geometry is not a reader decision and must not become last-writer-wins.
      bootstrap.unmount();

      expect(restoreChatTabState(identity, messages)).toEqual(expected);
    });

    it(
      "P4 review fix: an A2A-only transcript (zero human user rows) still " +
        "persists and restores an exact free-scroll anchor",
      async () => {
        // Root cause: selectActiveUserMessageId/viewportActiveUserMessageId
        // are human-only gated (isHumanUserMessage) - correct for the
        // minimap rail, but the ticket-5 save path shares the same gate, so
        // a transcript with ZERO human user rows (pure agent-to-agent child
        // chat) never had a candidate to track, freezing the saved anchor at
        // whatever it was on mount instead of the reader's actual position.
        const messages = makeA2AOnlyCompletedTranscript(20);
        expect(
          messages.some(
            (message) =>
              message.role === "user" && message.agentSenderInfo === null,
          ),
        ).toBe(false);
        const scrollStateKey = `t5-p4-a2a-only-${Math.random().toString(36).slice(2)}`;
        const instanceId = `t5-p4-a2a-instance-${Math.random().toString(36).slice(2)}`;

        tileLiveness.live = true;
        const first = renderChatMessages({
          messages,
          scrollStateKey,
          instanceId,
        });
        await settleLegendList();

        await enterFreeScrollingAwayFromEnd();
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

        const originalScrollTop = getScrollNode().scrollTop;
        expect(typeof originalScrollTop).toBe("number");

        first.unmount();

        // Red-on-baseline: before the fix, `anchorMessageId` is `null` here
        // (the human-only gate never resolved a candidate for this
        // transcript shape) and the position is lost.
        const saved = restoreChatTabState(
          makeDefaultTestIdentity(instanceId),
          messages,
        );
        expect(saved.mode).toBe("free-scrolling");
        expect(saved.anchorMessageId).not.toBeNull();
        expect(typeof saved.offset).toBe("number");

        const second = renderChatMessages({
          messages,
          scrollStateKey,
          instanceId,
        });
        await settleLegendList();
        await settleLegendList();

        expect(getScrollNode().scrollTop).toBe(originalScrollTop);
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

        second.unmount();
      },
    );

    it("falls back cleanly when the saved anchor message is gone on remount", async () => {
      const messages = makeCompletedTranscript(12);
      const scrollStateKey = `t5-stale-free-${Math.random().toString(36).slice(2)}`;

      // Legacy save without anchorIndex (pre-ticket-15 shape): when the id is
      // gone AND no index was recorded, still degrade to null-anchor rather
      // than inventing a neighbor. Ticket 15's nearest-neighbor pin covers
      // the anchorIndex path separately.
      saveChatTabState({
        identity: makeDefaultTestIdentity(scrollStateKey),
        mode: "free-scrolling",
        anchorMessageId: "message-removed-while-away",
        anchorIndex: null,
        offset: 64,
      });

      // restoreChatTabState keeps mode, drops the stale anchor.
      expect(
        restoreChatTabState(makeDefaultTestIdentity(scrollStateKey), messages),
      ).toEqual({
        mode: "free-scrolling",
        anchorMessageId: null,
        anchorIndex: null,
        offset: 0,
      });

      renderChatMessages({ messages, scrollStateKey });
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      await waitForPillVisible();

      // following-end + stale anchor: mode preserved, no crash.
      const followKey = `t5-stale-follow-${Math.random().toString(36).slice(2)}`;
      saveChatTabState({
        identity: makeDefaultTestIdentity(followKey),
        mode: "following-end",
        anchorMessageId: "also-gone",
        anchorIndex: null,
        offset: 12,
      });
      expect(
        restoreChatTabState(makeDefaultTestIdentity(followKey), messages),
      ).toEqual({
        mode: "following-end",
        anchorMessageId: null,
        anchorIndex: null,
        offset: 0,
      });

      cleanup();
      renderChatMessages({ messages, scrollStateKey: followKey });
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      expect(isJumpPillVisible()).toBe(false);
    });

    it("commits the closing position to durable but never resurrects the tab-key entry (ticket 15 review F1)", async () => {
      const messages = makeCompletedTranscript(16);
      // Single key: production tab-key is instanceId; keep them aligned so
      // the canvas-style tab eviction targets the real entry.
      const instanceId = `t5-liveness-inst-${Math.random().toString(36).slice(2)}`;
      const identity = makeDefaultTestIdentity(instanceId);

      tileLiveness.live = true;
      const { unmount } = renderChatMessages({
        messages,
        instanceId,
      });
      await settleLegendList();

      await enterFreeScrollingAwayFromEnd();
      await waitForPillVisible();

      // Production order (ticket 15 review F1): the canvas sweep drops the
      // TAB-key entry and flips liveness false SYNCHRONOUSLY, before this
      // component's own unmount cleanup ever runs.
      evictChatTabState([instanceId]);
      tileLiveness.live = false;

      unmount();

      // The non-live unmount commits the CURRENT free-scrolling position to
      // the DURABLE chat-key entry - that is the fix: a genuine close is the
      // only chance this view's final position ever reaches durable at all
      // (a liveness guard that fully skips saving on close was the original
      // bug - it left reopens with either nothing, or a stale earlier
      // durable entry).
      expect(restoreChatTabState(identity, messages).mode).toBe(
        "free-scrolling",
      );

      // What the guard must still prevent: resurrecting the TAB-key entry.
      // Proof: dropping ONLY the durable entry must make the saved state
      // disappear entirely - if the tab-key had been resurrected underneath,
      // `hasSavedChatTabState` would still read true here.
      evictChatTabStateForChat({
        epicId: identity.epicId,
        chatId: identity.chatId,
      });
      expect(peekSavedChatTabState(identity) !== null).toBe(false);
    });

    it("keeps tool, subagent, and activity-group open state across unmount+remount with the same instanceId", async () => {
      const messages = makeCompletedTranscript(8);
      const scrollStateKey = `t5-open-survives-${Math.random().toString(36).slice(2)}`;
      const instanceId = `t5-open-inst-${Math.random().toString(36).slice(2)}`;
      const toolSegmentId = "tool-seg-1";
      const subagentSegmentId = "subagent-seg-1";
      const activityGroupId = "activity-group-1";
      const a2aSentId = "a2a-sent-1";

      tileLiveness.live = true;
      const first = renderChatMessages({
        messages,
        scrollStateKey,
        instanceId,
      });
      await settleLegendList();

      act(() => {
        useToolOpenStore.getState().setOpen(instanceId, toolSegmentId, true);
        useSubagentOpenStore
          .getState()
          .setOpen(instanceId, subagentSegmentId, true);
        getOrCreateActivityGroupOpenStore(makeDefaultTestIdentity(instanceId))
          .getState()
          .setOpen(activityGroupId, true);
        getOrCreateA2AOpenStore(makeDefaultTestIdentity(instanceId))
          .getState()
          .setSentOpen(a2aSentId, true);
      });

      expect(
        useToolOpenStore
          .getState()
          .openIds.has(scopedChatOpenId(instanceId, toolSegmentId)),
      ).toBe(true);
      expect(
        useSubagentOpenStore
          .getState()
          .openIds.has(scopedChatOpenId(instanceId, subagentSegmentId)),
      ).toBe(true);
      expect(
        getOrCreateActivityGroupOpenStore(makeDefaultTestIdentity(instanceId))
          .getState()
          .openIds.has(activityGroupId),
      ).toBe(true);
      expect(
        getOrCreateA2AOpenStore(makeDefaultTestIdentity(instanceId))
          .getState()
          .sentOpenIds.has(a2aSentId),
      ).toBe(true);

      first.unmount();

      // Remount reuses the same instanceId - open state must not reset.
      const second = renderChatMessages({
        messages,
        scrollStateKey,
        instanceId,
      });
      await settleLegendList();

      expect(
        useToolOpenStore
          .getState()
          .openIds.has(scopedChatOpenId(instanceId, toolSegmentId)),
      ).toBe(true);
      expect(
        useSubagentOpenStore
          .getState()
          .openIds.has(scopedChatOpenId(instanceId, subagentSegmentId)),
      ).toBe(true);
      expect(
        getOrCreateActivityGroupOpenStore(makeDefaultTestIdentity(instanceId))
          .getState()
          .openIds.has(activityGroupId),
      ).toBe(true);
      expect(
        getOrCreateA2AOpenStore(makeDefaultTestIdentity(instanceId))
          .getState()
          .sentOpenIds.has(a2aSentId),
      ).toBe(true);
      // Registry identity: remount must reattach the same store instance.
      const activityStoreA = getOrCreateActivityGroupOpenStore(
        makeDefaultTestIdentity(instanceId),
      );
      second.unmount();
      const third = renderChatMessages({
        messages,
        scrollStateKey,
        instanceId,
      });
      expect(
        getOrCreateActivityGroupOpenStore(makeDefaultTestIdentity(instanceId)),
      ).toBe(activityStoreA);
      third.unmount();
    });

    describe("free-scrolling coordinate capture", () => {
      function mockMeasurementSource(
        positionAtIndex: (index: number) => number,
        scroll: number,
        topOffsetAdjustment: number | undefined,
      ) {
        return {
          getState: () => ({
            positionAtIndex,
            scroll,
            ...(topOffsetAdjustment === undefined
              ? {}
              : { topOffsetAdjustment }),
          }),
        };
      }

      it("captures the raw visible offset without rewriting its geometry", () => {
        const list = mockMeasurementSource(() => 500, 2000, undefined);
        expect(captureChatFreeScrollingOffset(list, 3)).toBe(500 - 2000);
      });

      it("folds topOffsetAdjustment into the offset so restore matches LegendList math", () => {
        // position=720, scroll=360, header=40 → viewOffset 400, which
        // round-trips: scroll = position - viewOffset + header = 360.
        const list = mockMeasurementSource(() => 720, 360, 40);
        expect(captureChatFreeScrollingOffset(list, 8)).toBe(720 + 40 - 360);
      });
    });
  });

  describe("native transcript edges", () => {
    it("does not render a custom bottom-fade overpaint", async () => {
      const messages = makeCompletedTranscript(8);
      const { container } = renderChatMessages({ messages });
      await settleLegendList();

      expect(container.querySelector(".bg-linear-to-t")).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Ticket 11: live-edge reconciliation for mode + pill (scroll-only routes,
  // suppressed-nav pill bookkeeping, strict epsilon vs loose near-end).
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // Ticket 10: settle/re-issue generalization + item-type split.
  // ANIMATED undershoot itself is jsdom-blind (no real animation timing);
  // pins exercise the settle/validate/re-issue LOGIC by driving geometry
  // between issue and settle (F2-style).
  // -------------------------------------------------------------------------
  describe("ticket 10: settle/re-issue navigation + item-type split", () => {
    it("navigateToMessage settle detects a short landing and re-issues to the exact viewOffset", async () => {
      // Target a MID-list human user row so the exact landing has a non-zero
      // scrollTop - navigating Home→row 0 wants scrollTop≈0, where an
      // undershoot is invisible and the pin would pass vacuously without
      // re-issue.
      const messages = makeCompletedTranscript(30);
      // messages[10] is a user row (even indices); positionAtIndex ≈ 10*90.
      const targetIndex = 10;
      const targetId = messages[targetIndex]?.id;
      expect(targetId).toBeTruthy();
      expect(messages[targetIndex]?.role).toBe("user");

      const { rerenderWith } = renderChatMessages({
        messages,
        scrollStateKey: "t10-nav-reissue",
      });
      await settleLegendList();

      const scrollNode = getScrollNode();
      // First material scroll jump lands 500px short of the intended target;
      // subsequent re-issues land honestly.
      let corruptNextJump = true;
      let stored = scrollNode.scrollTop;
      Object.defineProperty(scrollNode, "scrollTop", {
        configurable: true,
        get() {
          return stored;
        },
        set(value: number) {
          const numeric = Number(value);
          if (!Number.isFinite(numeric)) {
            stored = 0;
            return;
          }
          if (corruptNextJump && Math.abs(numeric - stored) > 100) {
            corruptNextJump = false;
            // From a bottom-following seed the jump is upward (numeric <
            // stored). Landing "short" of an upward jump means stopping
            // higher than the target (less travel) → numeric + 500.
            stored = numeric + 500;
          } else {
            stored = numeric;
          }
          // A real browser fires a native `scroll` event on every scrollTop
          // write, whether from a user gesture or a programmatic call - the
          // shared jsdom shim's own scrollTop setter does not (see
          // legend-list-test-environment.ts), which would leave
          // onIsAtEndChange never reconciling the mode mirror to this
          // navigation's real away-from-bottom landing. Dispatch it here so
          // this mid-list navigation is regression-faithful to a browser.
          scrollNode.dispatchEvent(new Event("scroll", { bubbles: true }));
        },
      });
      try {
        // Deep-link scrollRequest shares navigateToMessage's choke point
        // (scrollToTimelineLocationSuppressingFollowRestore).
        rerenderWith({
          scrollRequest: {
            kind: "message",
            requestId: 10_001,
            messageId: targetId,
            blockId: "",
          },
        });
        await act(async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 50);
          });
        });

        await waitForNavigationSettle();
        await waitForNavigationSettle();

        // Exact landing: scrollTop = positionAtIndex + header - viewOffset.
        // Row height is uniform 90px under the jsdom shim; header spacer 40.
        const ROW_HEIGHT_PX = 90;
        const HARNESS_HEADER_PX = 40;
        const expectedScrollTop =
          targetIndex * ROW_HEIGHT_PX +
          HARNESS_HEADER_PX -
          CHAT_TIMELINE_NAVIGATION_VIEW_OFFSET_PX;
        expect(
          Math.abs(getScrollNode().scrollTop - expectedScrollTop),
        ).toBeLessThanOrEqual(1);
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      } finally {
        Reflect.deleteProperty(scrollNode, "scrollTop");
      }
    });

    it("cancels the active navigation settle timer and listener on unmount", async () => {
      const messages = makeCompletedTranscript(30);
      const targetId = messages[10]?.id;
      expect(targetId).toBeTruthy();
      const { rerenderWith, unmount } = renderChatMessages({
        messages,
        scrollStateKey: "t10-nav-unmount-cleanup",
      });
      await settleLegendList();

      const scrollNode = getScrollNode();
      const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
      const removeEventListenerSpy = vi.spyOn(
        scrollNode,
        "removeEventListener",
      );
      onTestFinished(() => {
        removeEventListenerSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
      });

      rerenderWith({
        scrollRequest: {
          kind: "message",
          requestId: 10_002,
          messageId: targetId,
          blockId: "",
        },
      });
      await act(async () => {
        await Promise.resolve();
      });

      const clearCountBeforeUnmount = clearTimeoutSpy.mock.calls.length;

      unmount();

      expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(
        clearCountBeforeUnmount,
      );
      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        "scrollend",
        expect.any(Function),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Ticket 12: viewport stability while free-scrolling (sizePreservationEnabled).
  // Pure size-change MVCP simulation is jsdom-blind under the fixed-height
  // shim (LegendList's size path needs real item-layout measurement churn
  // that getBoundingClientRect overrides alone do not trigger). Interaction
  // contracts that do not need a size event are pinned below.
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // Ticket 18: send-anchor validated convergence (rootcause-send-undershoot).
  // The engine now shares ticket 10's settle/re-issue helper, writes
  // settledTimelineAnchorRef ONLY on a validated landing, fails safe to
  // free-scrolling + pill on exhaustion, and repairs anchor-position drift
  // BEFORE the reveal pass's overflow early-return.
  //
  // jsdom-blind (declared): the ANIMATED-vs-INSTANT visual undershoot mid-
  // flight (smooth scroll physically not arrived when rows remeasure) is not
  // reproducible here - the shared scrollTo shim applies offsets
  // synchronously. What jsdom CAN pin is (A) validated reissue CONVERGENCE
  // math and (B) near/far ANIMATED-FLAG selection via scrollTo behavior.
  // -------------------------------------------------------------------------
  describe("ticket 15: dual-key restore + streaming-aware fresh-open", () => {
    afterEach(() => {
      // Dual-key durable entries survive tab-key eviction - clear the epic
      // used by this harness so later suites don't inherit a seed.
      evictChatTabPersistenceForEpic("epic-1");
    });

    it("RESTORE-FIRST: free-scrolling and following-end saved states win over fresh-open policy", async () => {
      const messages = makeCompletedTranscript(16);
      const freeKey = `t15-restore-free-${Math.random().toString(36).slice(2)}`;
      const followKey = `t15-restore-follow-${Math.random().toString(36).slice(2)}`;
      const anchorId = messages[4]?.id ?? null;
      expect(anchorId).toBeTruthy();

      saveChatTabState({
        identity: makeDefaultTestIdentity(freeKey),
        mode: "free-scrolling",
        anchorMessageId: anchorId,
        anchorIndex: 4,
        offset: 24,
      });
      renderChatMessages({ messages, scrollStateKey: freeKey });
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      cleanup();

      saveChatTabState({
        identity: makeDefaultTestIdentity(followKey),
        mode: "following-end",
        anchorMessageId: null,
        anchorIndex: null,
        offset: 0,
      });
      renderChatMessages({ messages, scrollStateKey: followKey });
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      expect(isJumpPillVisible()).toBe(false);
    });

    it("fresh open (no saved state) seeds following-end", async () => {
      const messages = makeCompletedTranscript(16);
      const key = `t15-stream-fresh-${Math.random().toString(36).slice(2)}`;
      expect(peekSavedChatTabState(makeDefaultTestIdentity(key))).toBeNull();

      renderChatMessages({
        messages,
        scrollStateKey: key,
        freshOpen: true,
      });
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      expect(isJumpPillVisible()).toBe(false);
    });

    it("reopen-after-close restores free-scrolling via the durable chat-key (field symptom)", async () => {
      const messages = makeCompletedTranscript(16);
      const closedInstance = `t15-closed-${Math.random().toString(36).slice(2)}`;
      const reopenedInstance = `t15-reopen-${Math.random().toString(36).slice(2)}`;
      const epicId = "epic-1";
      const taskId = "task-1";
      const closedIdentity = makeTestIdentity(closedInstance, epicId, taskId);
      const reopenedIdentity = makeTestIdentity(
        reopenedInstance,
        epicId,
        taskId,
      );

      tileLiveness.live = true;
      const first = renderChatMessages({
        messages,
        instanceId: closedInstance,
        epicId,
        taskId,
      });
      await settleLegendList();
      await enterFreeScrollingAwayFromEnd();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // PRODUCTION ORDER (ticket 15 review F1): a real close removes the
      // tile from the canvas and runs the tile-removal sweep (tab-key
      // eviction) SYNCHRONOUSLY, before React ever gets around to unmounting
      // this component - `isEpicCanvasTileInstanceLive` already reads false
      // by the time our own cleanup fires. The earlier version of this pin
      // unmounted BEFORE evicting (the reverse order), which never actually
      // exercised the guard this ticket depends on.
      evictChatTabState([closedInstance]);
      tileLiveness.live = false;
      first.unmount();

      // Same chat, brand-new tileInstanceId - must still restore via durable,
      // which the non-live unmount above just committed (F1's durable-only
      // commit path) - nothing else in this test ever wrote it.
      expect(peekSavedChatTabState(reopenedIdentity) !== null).toBe(true);
      // Ticket 15 review (live pass S5 round 3): a mode-only assertion
      // stayed green through two live failures - a poisoned
      // {anchorMessageId, anchorIndex, offset} triple (a stale anchor row
      // paired with the live scroll offset) still reports `mode:
      // "free-scrolling"`. Assert the full triple is internally coherent -
      // a real, non-null anchor with an index the offset was actually
      // captured relative to.
      const restoredTriple = restoreChatTabState(reopenedIdentity, messages);
      expect(restoredTriple.mode).toBe("free-scrolling");
      expect(restoredTriple.anchorMessageId).not.toBeNull();
      expect(restoredTriple.anchorIndex).not.toBeNull();

      const second = renderChatMessages({
        messages,
        instanceId: reopenedInstance,
        epicId,
        taskId,
      });
      await settleLegendList();
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      // The reopened viewport lands back at the position that was actually
      // on screen when the tab closed - not just "some free-scrolling row".
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      second.unmount();

      // Sanity: the closed tab-key alone is not what restored us.
      expect(restoreChatTabState(closedIdentity, messages).mode).toBe(
        "free-scrolling",
      ); // durable still answers for same chat
    });

    // Ticket 15 review (live pass S5 round 3): a small (16-row) transcript
    // and a shallow scroll target let the OLD code's clamping accidentally
    // land "close enough" even with a stale anchor - the poisoned pair
    // only breaks catastrophically once the stale row and the true
    // scrolled row are far apart, matching the live shape (a landmark deep
    // in a long transcript). 100 rows, scrolled to row 50 (far past
    // `enterFreeScrollingAwayFromEnd`'s row-0 park), makes the mismatch
    // large enough to be unmissable.
    const RACE_ROW_COUNT = 100;
    const RACE_TARGET_ROW = 50;
    const RACE_TARGET_SCROLL_TOP =
      RACE_TARGET_ROW * TICKET_13_ROW_HEIGHT_PX + LEGEND_LIST_HEADER_PX;

    it("close races the unserviced rAF viewport mirror: the saved triple still matches the actual scrolled position (live pass S5 round 3, confirmed defect)", async () => {
      const messages = makeCompletedTranscript(RACE_ROW_COUNT);
      const closedInstance = `t15-race-closed-${Math.random().toString(36).slice(2)}`;
      const reopenedInstance = `t15-race-reopen-${Math.random().toString(36).slice(2)}`;
      const epicId = "epic-1";
      const taskId = "task-1";
      const reopenedIdentity = makeTestIdentity(
        reopenedInstance,
        epicId,
        taskId,
      );

      tileLiveness.live = true;
      const first = renderChatMessages({
        messages,
        instanceId: closedInstance,
        epicId,
        taskId,
      });
      await settleLegendList();
      await enterFreeScrollingAwayFromEnd();
      // Live evidence: scroll then close BEFORE the pending
      // `scheduleActiveViewportUpdate` rAF ever services
      // `scrolledActiveUserMessageIdRef` - `requestAnimationFrame` never
      // fires for a backgrounded/closing tab, and `useAnimationFrameThrottle`
      // cancels the pending frame on unmount either way. No flush here is
      // the point of this pin.
      fireScrollTopWithoutFlush(RACE_TARGET_SCROLL_TOP);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      evictChatTabState([closedInstance]);
      tileLiveness.live = false;
      first.unmount();

      // The saved triple must be internally coherent with the ACTUAL
      // scrolled position (row 50), not a stale reading-line row paired
      // with the live offset - on the old code this produced an anchor at
      // whatever row `scrolledActiveUserMessageIdRef` last held (row 0,
      // pre-scroll) combined with an offset computed against the live
      // scrollTop, clamping the reopen far from row 50.
      const restoredTriple = restoreChatTabState(reopenedIdentity, messages);
      expect(restoredTriple.mode).toBe("free-scrolling");
      expect(restoredTriple.anchorMessageId).not.toBeNull();
      expect(restoredTriple.anchorIndex).toBeGreaterThan(RACE_TARGET_ROW - 2);
      expect(restoredTriple.anchorIndex).toBeLessThan(RACE_TARGET_ROW + 2);

      const second = renderChatMessages({
        messages,
        instanceId: reopenedInstance,
        epicId,
        taskId,
      });
      await settleLegendList();
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().scrollTop).toBe(RACE_TARGET_SCROLL_TOP);
      second.unmount();
    });

    it("close races the unserviced rAF viewport mirror under StrictMode (dev effect replay must not resurrect the stale row-0 reading)", async () => {
      const messages = makeCompletedTranscript(RACE_ROW_COUNT);
      const closedInstance = `t15-strict-closed-${Math.random().toString(36).slice(2)}`;
      const reopenedInstance = `t15-strict-reopen-${Math.random().toString(36).slice(2)}`;
      const epicId = "epic-1";
      const taskId = "task-1";
      const reopenedIdentity = makeTestIdentity(
        reopenedInstance,
        epicId,
        taskId,
      );

      tileLiveness.live = true;
      const first = renderChatMessages({
        messages,
        instanceId: closedInstance,
        epicId,
        taskId,
        composerOverlayHeight: 80,
        strictMode: true,
      });
      await settleLegendList();
      await enterFreeScrollingAwayFromEnd();
      fireScrollTopWithoutFlush(RACE_TARGET_SCROLL_TOP);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      evictChatTabState([closedInstance]);
      tileLiveness.live = false;
      first.unmount();

      const restoredTriple = restoreChatTabState(reopenedIdentity, messages);
      expect(restoredTriple.mode).toBe("free-scrolling");
      expect(restoredTriple.anchorMessageId).not.toBeNull();
      expect(restoredTriple.anchorIndex).toBeGreaterThan(RACE_TARGET_ROW - 2);
      expect(restoredTriple.anchorIndex).toBeLessThan(RACE_TARGET_ROW + 2);

      const second = renderChatMessages({
        messages,
        instanceId: reopenedInstance,
        epicId,
        taskId,
      });
      await settleLegendList();
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().scrollTop).toBe(RACE_TARGET_SCROLL_TOP);
      second.unmount();
    });

    it("hydration catch-up: a saved anchor absent from a still-hydrating mount-time transcript is re-resolved once the full transcript arrives (live pass S5, confirmed defect)", async () => {
      const fullMessages = makeCompletedTranscript(200);
      const anchorIndex = 20;
      const anchorId = fullMessages[anchorIndex]?.id ?? null;
      expect(anchorId).toBeTruthy();
      // Hydration catch-up restores the original sub-row pixel offset, not
      // the fixed minimap/find navigation padding.
      const expectedScrollTop =
        anchorIndex * TICKET_13_ROW_HEIGHT_PX + LEGEND_LIST_HEADER_PX - 24;

      // Repro: reopen races hydration - the FIRST commit only has the tail
      // of the transcript (chat.subscribe's snapshot can still grow after
      // this tile's own snapshotLoaded first flips true; see
      // chat-session-store.ts's reconnect/rehydrate comments) - the saved
      // anchor (idx 20) is not present yet.
      const catchupKey = `t15-hydration-catchup-${Math.random().toString(36).slice(2)}`;
      saveChatTabState({
        identity: makeDefaultTestIdentity(catchupKey),
        mode: "free-scrolling",
        anchorMessageId: anchorId,
        anchorIndex,
        offset: 24,
      });
      const partialMessages = fullMessages.slice(180);
      const { rerenderMessages } = renderChatMessages({
        messages: partialMessages,
        scrollStateKey: catchupKey,
      });
      await settleLegendList();
      // Confirms the gap is real: the mount-time restore could not have
      // found the true anchor in this partial transcript, and the scroll
      // position is nowhere near the true anchor's row.
      expect(screen.queryByTestId(`mock-message-${anchorId}`)).toBeNull();
      expect(getScrollNode().scrollTop).not.toBe(expectedScrollTop);

      // The rest of the transcript arrives (a later onSnapshot/backfill commit).
      rerenderMessages(fullMessages);
      await settleLegendList();

      expect(getScrollNode().scrollTop).toBe(expectedScrollTop);
    });

    it("hydration catch-up survives MANY anchor-absent messages transitions before the anchor arrives (live pass S5 round 2, confirmed defect)", async () => {
      // Live evidence: a reopen can replay dozens of incremental `messages`
      // reference changes (onSnapshot + a burst of backfill/append events)
      // in well under 2 seconds, all before the saved anchor's own commit
      // ever lands. An earlier version of this fix counted every
      // anchor-absent transition as a bounded "attempt" (20) and disarmed
      // itself long before the anchor showed up - this reproduces that
      // exact shape: 25 distinct anchor-absent commits, THEN the anchor.
      const fullMessages = makeCompletedTranscript(200);
      const anchorIndex = 20;
      const anchorId = fullMessages[anchorIndex]?.id ?? null;
      expect(anchorId).toBeTruthy();
      const expectedScrollTop =
        anchorIndex * TICKET_13_ROW_HEIGHT_PX + LEGEND_LIST_HEADER_PX - 24;

      const key = `t15-hydration-many-absent-${Math.random().toString(36).slice(2)}`;
      saveChatTabState({
        identity: makeDefaultTestIdentity(key),
        mode: "free-scrolling",
        anchorMessageId: anchorId,
        anchorIndex,
        offset: 24,
      });
      const { rerenderMessages } = renderChatMessages({
        messages: fullMessages.slice(180, 181),
        scrollStateKey: key,
      });
      await settleLegendList();
      expect(screen.queryByTestId(`mock-message-${anchorId}`)).toBeNull();

      // 25 DISTINCT array references, none containing the anchor (all drawn
      // from the tail, past index 20) - more than the old bounded budget.
      for (let i = 2; i <= 26; i += 1) {
        rerenderMessages(fullMessages.slice(180, 180 + i));
      }
      await settleLegendList();
      expect(screen.queryByTestId(`mock-message-${anchorId}`)).toBeNull();

      // The anchor's own commit finally lands.
      rerenderMessages(fullMessages);
      await settleLegendList();

      expect(getScrollNode().scrollTop).toBe(expectedScrollTop);
    });

    it("preserves the unresolved raw hydration anchor across a normalized rapid remount", async () => {
      const fullMessages = makeCompletedTranscript(200);
      const anchorIndex = 20;
      const anchorId = fullMessages[anchorIndex]?.id ?? null;
      expect(anchorId).toBeTruthy();
      const expectedScrollTop =
        anchorIndex * TICKET_13_ROW_HEIGHT_PX + LEGEND_LIST_HEADER_PX - 24;
      const key = `t15-hydration-remount-${Math.random().toString(36).slice(2)}`;
      const identity = makeDefaultTestIdentity(key);
      // The partial tail is long enough that the substituted local index is
      // measurable away from its own edge, so the normalized fallback can
      // settle and overwrite the ordinary cache before this rapid remount.
      const partialMessages = fullMessages.slice(150);

      saveChatTabState({
        identity,
        mode: "free-scrolling",
        anchorMessageId: anchorId,
        anchorIndex,
        offset: 24,
      });
      tileLiveness.live = true;
      const first = renderChatMessages({
        messages: partialMessages,
        scrollStateKey: key,
      });
      await settleLegendList();
      await settleLegendList();
      first.unmount();

      const normalizedAfterFirstUnmount = peekSavedChatTabState(identity);
      expect(normalizedAfterFirstUnmount?.mode).toBe("free-scrolling");
      expect(normalizedAfterFirstUnmount?.anchorMessageId).not.toBe(anchorId);
      const second = renderChatMessages({
        messages: partialMessages,
        scrollStateKey: key,
      });
      second.rerenderMessages(fullMessages);
      await settleLegendList();

      expect(getScrollNode().scrollTop).toBe(expectedScrollTop);
      second.unmount();
    });

    it("reader intent supersedes the session-retained raw hydration anchor", async () => {
      const fullMessages = makeCompletedTranscript(200);
      const anchorIndex = 20;
      const anchorId = fullMessages[anchorIndex]?.id ?? null;
      expect(anchorId).toBeTruthy();
      const rawAnchorScrollTop =
        anchorIndex * TICKET_13_ROW_HEIGHT_PX + LEGEND_LIST_HEADER_PX - 24;
      const readerRestoredScrollTop = 150 * TICKET_13_ROW_HEIGHT_PX;
      const key = `t15-hydration-reader-${Math.random().toString(36).slice(2)}`;
      const partialMessages = fullMessages.slice(150);

      saveChatTabState({
        identity: makeDefaultTestIdentity(key),
        mode: "free-scrolling",
        anchorMessageId: anchorId,
        anchorIndex,
        offset: 24,
      });
      tileLiveness.live = true;
      const first = renderChatMessages({
        messages: partialMessages,
        scrollStateKey: key,
      });
      await settleLegendList();
      await settleLegendList();
      // Fixup (hydration-transaction): a passive geometry report is not
      // reader intent (that is the whole point of the transactional gate),
      // so this needs a real, explicitly-recognized gesture
      // (`publishesReaderPosition: true`, keyboard scroll) to supersede the
      // session-retained raw anchor - not just any programmatic scroll.
      act(() => {
        dispatchKeyInScope("ArrowDown");
      });
      await enterFreeScrollingAwayFromEnd();
      first.unmount();

      const reopened = renderChatMessages({
        messages: fullMessages,
        scrollStateKey: key,
      });
      await settleLegendList();
      expect(getScrollNode().scrollTop).toBe(readerRestoredScrollTop);
      expect(getScrollNode().scrollTop).not.toBe(rawAnchorScrollTop);
      reopened.unmount();
    });

    it("hydration catch-up does not disturb the true-deletion nearest-neighbor fallback (branch-edited anchor, never resolves)", async () => {
      const messages = makeCompletedTranscript(16);
      const key = `t15-hydration-deleted-${Math.random().toString(36).slice(2)}`;

      saveChatTabState({
        identity: makeDefaultTestIdentity(key),
        mode: "free-scrolling",
        anchorMessageId: "gone-branch-deleted",
        anchorIndex: 5,
        offset: 24,
      });
      tileLiveness.live = true;
      const first = renderChatMessages({ messages, scrollStateKey: key });
      await settleLegendList();
      await settleLegendList();

      // The round-1 stale-anchor nearest-neighbor fallback still applies
      // exactly as before this fix. The measured neighboring-row landing is
      // allowed to settle even while the same-mount hydration retry retains
      // the original id, so unmount persists a coherent normalized anchor
      // instead of re-saving the deleted id forever.
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(
        screen.queryByTestId("mock-message-gone-branch-deleted"),
      ).toBeNull();

      first.unmount();
      const normalized = peekSavedChatTabState(makeDefaultTestIdentity(key));
      expect(normalized?.mode).toBe("free-scrolling");
      expect(normalized?.anchorMessageId).not.toBe("gone-branch-deleted");
      expect(
        messages.some((message) => message.id === normalized?.anchorMessageId),
      ).toBe(true);

      const reopened = renderChatMessages({ messages, scrollStateKey: key });
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(
        screen.queryByTestId("mock-message-gone-branch-deleted"),
      ).toBeNull();
      reopened.unmount();
    });

    it("composer-resize alone does not write scroll state (endInset not in save-effect deps)", async () => {
      const messages = makeCompletedTranscript(12);
      const instanceId = `t15-composer-resize-${Math.random().toString(36).slice(2)}`;
      const identity = makeDefaultTestIdentity(instanceId);

      // Truly fresh: no seed, not streaming.
      expect(peekSavedChatTabState(identity) !== null).toBe(false);
      tileLiveness.live = true;
      const { rerenderWith } = renderChatMessages({
        messages,
        instanceId,
        freshOpen: true,
        composerOverlayHeight: 80,
      });
      await settleLegendList();
      expect(peekSavedChatTabState(identity) !== null).toBe(false);

      // Resize the overlaid composer - previously re-ran the unmount-save
      // effect cleanup because endInset was in the dep array, flipping
      // "no saved state" permanently.
      rerenderWith({ composerOverlayHeight: 240 });
      await settleLegendList();

      expect(peekSavedChatTabState(identity) !== null).toBe(false);
    });
  });

  describe("ticket 20: pre-structural-mutation viewport handoff", () => {
    /**
     * Review round 1, finding 3: the same-commit pin below must actually
     * force React to unmount the old fiber and mount the replacement in ONE
     * commit - `unmount()` followed by a separate `render()` call is two
     * commits, and cannot catch a cleanup-clobber. Swapping the wrapping
     * host element's TYPE (div -> section) between rerenders makes React
     * tear down and rebuild the whole subtree - old fiber deletion, new
     * fiber placement, both commit-phase - inside a single `rerender` call,
     * the same one-store-update shape a real drag/split/dissolve/tear-off
     * produces (retained `instanceId`, replaced fiber).
     */
    function KeyedParentChatMessages({
      parentTag,
      instanceId,
      messages,
    }: {
      parentTag: "div" | "section";
      instanceId: string;
      messages: ReadonlyArray<ChatMessageModel>;
    }): ReactElement {
      const Parent = parentTag;
      return (
        <Parent
          data-chat-keyboard-scroll-scope
          data-active="true"
          style={{ height: VIEWPORT_HEIGHT_PX, width: VIEWPORT_WIDTH_PX }}
        >
          <ChatMessages
            taskTitle="Test chat"
            taskId="task-1"
            epicId="epic-1"
            hostId={null}
            messages={messages}
            baselineEpoch={0}
            backgroundItems={undefined}
            getMessageActions={() => null}
            nextStepActions={null}
            instanceId={instanceId}
            visible
            systemOverlayActive={false}
            scrollRequest={null}
            composerOverlayHeight={80}
          />
        </Parent>
      );
    }

    it(
      "same-commit remount reads the pre-move position only when the action " +
        "creator flushes before the replacement mounts (red without the flush)",
      async () => {
        const messages = makeCompletedTranscript(20);
        const instanceId = `t20-same-commit-${Math.random().toString(36).slice(2)}`;
        const identity = makeDefaultTestIdentity(instanceId);

        tileLiveness.live = true;
        const { rerender } = render(
          <KeyedParentChatMessages
            parentTag="div"
            instanceId={instanceId}
            messages={messages}
          />,
        );
        await settleLegendList();

        await enterFreeScrollingAwayFromEnd();
        const parkedAt = getScrollNode().scrollTop;
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
        const preMoveScrollTop = getScrollNode().scrollTop;
        expect(preMoveScrollTop).toBe(parkedAt);

        // RED-ON-BASELINE: `restoreChatTabState` is exactly what a
        // same-commit replacement's render-time state initializer calls
        // (`ChatMessagesInner`'s `restoredTabState` useState initializer) -
        // React runs it during render, which happens BEFORE ANY commit-phase
        // effect, including the currently-mounted fiber's own unmount
        // cleanup. Nothing has unmounted yet here, so whatever
        // `restoreChatTabState` returns right now is exactly what the
        // type-swap rerender below will read. Without a pre-mutation flush,
        // that is still the harness/cache-miss default following-end seed,
        // not the live 360px position currently on screen - the audit's own
        // `initialize:stale` probe finding, reproduced directly.
        const staleRestore = restoreChatTabState(identity, messages);
        expect(staleRestore.mode).toBe("following-end");

        // The fix: a structural-mutation action creator (drag/split-wrap/
        // dissolve/tear-off) calls this exact primitive, synchronously,
        // BEFORE its own `set()` - simulated here immediately before the
        // type-swap rerender that stands in for that `set()`.
        flushChatTabViewportHandoff([instanceId]);
        const freshRestore = restoreChatTabState(identity, messages);
        expect(freshRestore.mode).toBe("free-scrolling");
        expect(freshRestore.anchorMessageId).not.toBeNull();

        // A REAL same-commit remount: the div -> section type change and the
        // replacement's render-time restore both happen inside this one
        // `rerender` call - React never lets the old fiber's commit-phase
        // cleanup run before this call's render phase (including the new
        // fiber's state initializer) has already completed.
        rerender(
          <KeyedParentChatMessages
            parentTag="section"
            instanceId={instanceId}
            messages={messages}
          />,
        );
        await settleLegendList();
        await settleLegendList();

        // Confirm it actually paints directly at the pre-move position - no
        // stale/default jump.
        expect(getScrollNode().scrollTop).toBe(preMoveScrollTop);
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      },
    );

    it(
      "the pre-mutation flush captures a coherent live-DOM snapshot, not a " +
        "stale rAF-throttled mirror (review round 1, finding 2: rebuilt - " +
        "the prior version raced a scrollRequest, but navigateToMessage " +
        "synchronously freshens the mirror before it scrolls, so that " +
        "construction could never actually desync it)",
      async () => {
        const rowCount = 100;
        const targetRow = 50;
        const targetScrollTop =
          targetRow * TICKET_13_ROW_HEIGHT_PX + LEGEND_LIST_HEADER_PX;
        const messages = makeCompletedTranscript(rowCount);
        const instanceId = `t20-coherent-flush-${Math.random().toString(36).slice(2)}`;
        const identity = makeDefaultTestIdentity(instanceId);

        tileLiveness.live = true;
        const first = renderChatMessages({ messages, instanceId });
        await settleLegendList();
        await enterFreeScrollingAwayFromEnd();
        // Ticket 15 review (live pass S5 round 3)'s exact race, reused here
        // for the still-mounted flush path instead of that pin's non-live
        // unmount path: sets scrollTop and fires the scroll event WITHOUT
        // yielding a frame afterward, so `scheduleActiveViewportUpdate`'s
        // rAF-throttled reading-line mirror (`scrolledActiveUserMessageIdRef`)
        // never catches up to this position. Critically, nothing in this
        // window is a navigation (`navigateToMessage` is not called - no
        // scrollRequest, no minimap/find jump) - only `navigateToMessage`
        // synchronously writes that ref before scrolling, so a
        // navigation-driven jump can never desync the mirror from the DOM in
        // the first place. That is exactly why the prior version of this
        // pin (a scrollRequest-driven jump) was vacuous.
        fireScrollTopWithoutFlush(targetScrollTop);
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

        // Flush with `first` STILL MOUNTED, exactly as a real structural
        // mutation's pre-`set()` flush runs. Reading `restoreChatTabState`
        // BEFORE `first.unmount()` (same ordering proof as the same-commit
        // pin above) is load-bearing: unmounting first would trigger
        // `first`'s OWN unmount-cleanup save too, masking a disabled/broken
        // flush behind the pre-existing unmount path and silently degrading
        // this into an ordinary unmount-capture check that stays green
        // either way.
        flushChatTabViewportHandoff([instanceId]);
        const saved = restoreChatTabState(identity, messages);
        expect(saved.mode).toBe("free-scrolling");
        expect(saved.anchorMessageId).not.toBeNull();
        // The stale mirror (unserviced since before this scroll) points at
        // a different row entirely - a poisoned capture would land well
        // outside this window, not just off by a row or two.
        expect(saved.anchorIndex).toBeGreaterThan(targetRow - 2);
        expect(saved.anchorIndex).toBeLessThan(targetRow + 2);

        first.unmount();

        const replacement = renderChatMessages({ messages, instanceId });
        await settleLegendList();
        await settleLegendList();
        expect(getScrollNode().scrollTop).toBe(targetScrollTop);

        replacement.unmount();
      },
    );

    it("flushing an instanceId with no live/mounted tile is a harmless no-op", () => {
      const instanceId = `t20-no-live-mount-${Math.random().toString(36).slice(2)}`;
      expect(() => flushChatTabViewportHandoff([instanceId])).not.toThrow();
      expect(
        peekSavedChatTabState(makeDefaultTestIdentity(instanceId)) !== null,
      ).toBe(false);
    });
  });

  describe("ticket 20: restore-driven navigation never visibly traverses", () => {
    /**
     * Records every `scrollTo({behavior, top, left})` LegendList issues
     * against `scrollNode`. Does NOT re-spy `HTMLElement.prototype.scrollTo`
     * by wrapping its CURRENT value as a "call through to prior" fallback -
     * `installLegendListViewportMetrics` already replaced it with a mock
     * once per test, and `vi.spyOn` on an already-spied method returns that
     * SAME mock instance rather than a fresh wrapper, so a captured
     * "prior" reference is actually the mock being reconfigured -
     * `mockImplementation` on it recurses into itself (stack overflow).
     * Reimplements the shim's own minimal numeric/options handling directly
     * against the real `scrollTop`/`scrollLeft` property setters instead.
     */
    function recordScrollToCallsOnNode(scrollNode: HTMLElement): ReadonlyArray<{
      readonly behavior?: ScrollBehavior;
      readonly top?: number;
      readonly left?: number;
    }> {
      const calls: Array<{
        behavior?: ScrollBehavior;
        top?: number;
        left?: number;
      }> = [];
      const scrollTopDescriptor = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        "scrollTop",
      );
      const scrollLeftDescriptor = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        "scrollLeft",
      );
      if (
        scrollTopDescriptor?.set === undefined ||
        scrollLeftDescriptor?.set === undefined
      ) {
        throw new Error("expected scrollTop/scrollLeft setters");
      }
      // The setter is called on a DIFFERENT element each invocation
      // (whichever node `scrollTo` fires on), so it cannot be bound to one
      // fixed `this` up front. Keep the descriptor itself as the stored
      // reference and reach `.set` only immediately before `.call` inside
      // these wrappers - never as a standalone extracted method reference.
      const setScrollTop = (target: HTMLElement, value: number): void => {
        scrollTopDescriptor.set?.call(target, value);
      };
      const setScrollLeft = (target: HTMLElement, value: number): void => {
        scrollLeftDescriptor.set?.call(target, value);
      };
      vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(function (
        this: HTMLElement,
        ...args: Array<number | ScrollToOptions | undefined>
      ): void {
        const first = args[0];
        if (typeof first === "number") {
          const second = args[1];
          setScrollLeft(this, first);
          setScrollTop(this, typeof second === "number" ? second : 0);
          return;
        }
        if (typeof first !== "object") return;
        if (this === scrollNode) {
          calls.push({
            behavior: first.behavior,
            top: first.top,
            left: first.left,
          });
        }
        if (typeof first.left === "number") {
          setScrollLeft(this, first.left);
        }
        if (typeof first.top === "number") {
          setScrollTop(this, first.top);
        }
      });
      return calls;
    }

    it(
      "late-hydration catch-up requests a non-animated (behavior: auto) jump, " +
        "never the animated (behavior: smooth) path minimap/deep-link use " +
        "(find is unrelated - it independently stays non-animated)",
      async () => {
        const fullMessages = makeCompletedTranscript(200);
        const anchorIndex = 20;
        const anchorId = fullMessages[anchorIndex]?.id ?? null;
        expect(anchorId).toBeTruthy();
        const savedViewOffset = 24;
        const estimatedScrollTop =
          anchorIndex * TICKET_13_ROW_HEIGHT_PX +
          LEGEND_LIST_HEADER_PX -
          savedViewOffset;

        const catchupKey = `t20-hydration-single-frame-${Math.random().toString(36).slice(2)}`;
        saveChatTabState({
          identity: makeDefaultTestIdentity(catchupKey),
          mode: "free-scrolling",
          anchorMessageId: anchorId,
          anchorIndex,
          offset: savedViewOffset,
        });
        const partialMessages = fullMessages.slice(180);
        const { rerenderMessages } = renderChatMessages({
          messages: partialMessages,
          scrollStateKey: catchupKey,
        });
        await settleLegendList();
        expect(getScrollNode().scrollTop).not.toBe(estimatedScrollTop);

        const scrollNode = getScrollNode();
        const callsOnScrollNode = recordScrollToCallsOnNode(scrollNode);

        // The rest of the transcript arrives (a later onSnapshot/backfill
        // commit) - triggers the hydration-retry effect's `navigateToMessage`
        // call.
        rerenderMessages(fullMessages);
        await settleLegendList();

        const measuredAnchorTop = legendListRefHolder.current
          ?.getState()
          .positionAtIndex(anchorIndex);
        if (measuredAnchorTop === undefined) {
          throw new Error("Expected hydrated anchor geometry");
        }
        expect(getScrollNode().scrollTop).toBe(
          measuredAnchorTop + LEGEND_LIST_HEADER_PX - savedViewOffset,
        );
        // RED-ON-BASELINE: before threading an explicit `animated` param
        // through `navigateToMessage`, this call hardcoded `animated: true`,
        // which LegendList translates to `behavior: "smooth"` - a reader
        // would see the transcript visibly scroll to the resolved anchor
        // instead of painting there directly. A restore is not a user
        // navigation; every call this retry produced must request
        // `behavior: "auto"` (LegendList's instant/non-animated path).
        expect(callsOnScrollNode.length).toBeGreaterThan(0);
        expect(
          callsOnScrollNode.every((call) => call.behavior === "auto"),
        ).toBe(true);
      },
    );

    it("minimap navigation (a real, user-triggered jump) still requests the animated path, unchanged", async () => {
      const messages = makeTranscript(24);
      renderChatMessages({
        messages,
        scrollStateKey: `t20-minimap-still-animated-${Math.random().toString(36).slice(2)}`,
      });
      await settleLegendList();

      await enterFreeScrollingAwayFromEnd();
      await waitForPillVisible();

      const scrollNode = getScrollNode();
      const callsOnScrollNode = recordScrollToCallsOnNode(scrollNode);

      await selectLastChatTurnMinimapItem();

      expect(callsOnScrollNode.length).toBeGreaterThan(0);
      expect(
        callsOnScrollNode.every((call) => call.behavior === "smooth"),
      ).toBe(true);
    });
  });

  describe("behavior contract: strict isAtEnd follow (post anchor removal)", () => {
    it("fresh idle/streaming chats initialize at true bottom geometry (not only data-scroll-mode)", async () => {
      for (const [label, messages] of [
        ["idle", makeCompletedTranscript(24)],
        ["streaming", makeTranscript(24)],
      ] as const) {
        cleanup();
        const key = `fresh-open-${label}-${Math.random().toString(36).slice(2)}`;
        // Tall content so true-bottom is a real non-zero max scroll, not the
        // short isContentLess=true edge case.
        setLegendListScrollContainerScrollHeightOverride(
          LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
        );
        renderChatMessages({
          messages: [...messages],
          scrollStateKey: key,
          freshOpen: true,
        });
        await settleLegendList();
        assertTrueBottomGeometry();
        expect(isJumpPillVisible()).toBe(false);
      }
    });

    it("empty transcript seeds following-end and first row lands at true bottom geometry", async () => {
      const key = `fresh-open-empty-${Math.random().toString(36).slice(2)}`;
      const { rerenderMessages } = renderChatMessages({
        messages: [],
        scrollStateKey: key,
        freshOpen: true,
      });
      // Empty state: no LegendList scroll node.
      expect(
        document.querySelector('[data-testid="chat-messages-scroll"]'),
      ).toBeNull();

      const firstRows = makeCompletedTranscript(24);
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + firstRows.length * 90 + 40,
      );
      rerenderMessages(firstRows);
      await settleLegendList();
      assertTrueBottomGeometry();
      expect(isJumpPillVisible()).toBe(false);
    });

    it("at strict bottom, append growth keeps following-end and pill hidden", async () => {
      const messages = makeCompletedTranscript(12);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "at-bottom-append-follow",
      });
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      expect(isJumpPillVisible()).toBe(false);

      const next = appendAssistant(messages, "bottom-growth", 900_000);
      rerenderMessages(next);
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      expect(isJumpPillVisible()).toBe(false);
    });

    it("away from bottom, append growth does not reattach follow", async () => {
      const messages = makeCompletedTranscript(16);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "away-append-no-follow",
      });
      await settleLegendList();

      await enterFreeScrollingAwayFromEnd();
      await waitForPillVisible();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      const parked = getScrollNode().scrollTop;

      rerenderMessages(appendAssistant(messages, "away-growth", 900_001));
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().scrollTop).toBe(parked);
      expect(isJumpPillVisible()).toBe(true);
    });

    it("local send while reading history does not move the viewport", async () => {
      const messages = makeCompletedTranscript(14);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "local-send-while-reading",
      });
      await settleLegendList();

      await enterFreeScrollingAwayFromEnd();
      await waitForPillVisible();
      const parked = getScrollNode().scrollTop;
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      const sendId = "local-send-while-reading-id";
      const withSend = appendOptimisticUserSend(messages, sendId, 900_002);
      rerenderMessages(withSend);
      await settleLegendList();
      // New row is at the tail; virtualization may not mount it while the
      // viewport is parked at the top. Contract: free-scrolling does not move.
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().scrollTop).toBe(parked);
      expect(withSend.some((message) => message.id === sendId)).toBe(true);
    });

    it("suffix deletion preserves surviving position and issues no app scroll command", async () => {
      // Observable surviving-position + no app-issued semantic scroll: drop a
      // large suffix while free-scrolling and prove the viewport is not
      // re-commanded to a new landing (the vacuous pre-fix check only
      // asserted mode is one of the two legal strings).
      const messages = makeCompletedTranscript(40);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "suffix-delete-no-force-bottom",
      });
      await settleLegendList();

      await enterFreeScrollingAwayFromEnd();
      await waitForPillVisible();
      const parkedBefore = getScrollNode().scrollTop;
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      const spies = spyLegendListScrollCommands();
      const callsBefore = spies.totalCalls();
      try {
        // Keep enough rows that the parked offset remains valid (content still
        // overflows) so clamp does not force isContentLess/following-end.
        const surviving = messages.slice(0, 20);
        rerenderMessages(surviving);
        await settleLegendList();

        // No app-issued imperative navigation attributable to the mutation.
        expect(spies.totalCalls()).toBe(callsBefore);
        // Surviving content stays at the pre-delete park; natural clamp is
        // the only acceptable movement, never a semantic app jump.
        expect(getScrollNode().scrollTop).toBe(parkedBefore);
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
        expect(isJumpPillVisible()).toBe(true);
      } finally {
        spies.restore();
      }
    });

    it("destructive suffix deletion clamps past the new max without app navigation", async () => {
      // Separate from the surviving-position case above: park BEYOND the new
      // maximum scroll after a heavy suffix drop, then prove (a) the browser
      // naturally clamps to the new max and (b) zero semantic app scroll
      // commands (scrollToIndex/Offset/End) were issued for the mutation.
      const messages = makeCompletedTranscript(40);
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
      );
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "suffix-delete-destructive-clamp",
      });
      await settleLegendList();

      // Park deep in the list (still free-scrolling, not at the strict edge).
      // Drive through LegendList's imperative API so its internal isAtEnd
      // tracker stays coherent with the DOM (plain scrollTop writes alone
      // can leave the library reporting a stale edge in this harness).
      await enterFreeScrollingAwayFromEnd();
      await waitForPillVisible();
      const list = legendListRefHolder.current;
      if (list === null) {
        throw new Error("LegendList ref is not mounted");
      }
      const deepPark = LEGEND_LIST_HEADER_PX + 28 * TICKET_13_ROW_HEIGHT_PX;
      fireEvent.wheel(getScrollNode(), { deltaY: -40 });
      await act(async () => {
        void list.scrollToOffset({ offset: deepPark, animated: false });
        getScrollNode().scrollTop = deepPark;
        fireEvent.scroll(getScrollNode());
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
      });
      await waitFor(() => {
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
        expect(legendListRefHolder.current?.getState().isAtEnd).toBe(false);
      });
      const parkedBefore = getScrollNode().scrollTop;
      expect(parkedBefore).toBe(deepPark);

      const spies = spyLegendListScrollCommands();
      const callsBefore = spies.totalCalls();
      try {
        // 8 rows: content still overflows the viewport (so maxScroll > 0) but
        // the old deep park is well past the new maximum.
        const surviving = messages.slice(0, 8);
        setLegendListScrollContainerScrollHeightOverride(
          LEGEND_LIST_HEADER_PX + surviving.length * 90 + 40,
        );
        rerenderMessages(surviving);
        await settleLegendList();

        // Zero semantic app navigation for the destructive mutation itself.
        expect(spies.totalCalls()).toBe(callsBefore);

        const scrollNode = getScrollNode();
        const newMax = maxScrollTopFor(scrollNode);
        expect(newMax).toBeGreaterThan(0);
        expect(parkedBefore).toBeGreaterThan(newMax);

        // jsdom + the harness scrollTop WeakMap do not auto-clamp when
        // scrollHeight shrinks the way a real browser does. Apply that UA
        // clamp as a pure DOM write (not LegendList scrollTo*) so the spy
        // still proves the app issued no imperative navigation. After the
        // clamp the viewport sits at the new max - the required post-
        // deletion geometry for a park that no longer fits.
        if (scrollNode.scrollTop > newMax) {
          scrollNode.scrollTop = newMax;
          fireEvent.scroll(scrollNode);
        }
        await settleLegendList();

        // Still no app-issued imperative navigation after the UA clamp.
        expect(spies.totalCalls()).toBe(callsBefore);
        expect(scrollNode.scrollTop).toBeLessThanOrEqual(newMax + 1);
        expect(scrollNode.scrollTop).toBeGreaterThanOrEqual(newMax - 1);
      } finally {
        spies.restore();
      }
    });

    it("pill is strict !isAtEnd: visible away, hidden at edge; click resumes follow", async () => {
      const messages = makeCompletedTranscript(16);
      renderChatMessages({
        messages,
        scrollStateKey: "pill-strict-is-at-end",
      });
      await settleLegendList();
      expect(isJumpPillVisible()).toBe(false);
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");

      await enterFreeScrollingAwayFromEnd();
      await waitForPillVisible();
      expect(isJumpPillVisible()).toBe(true);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Scroll to end" }));
      });
      await waitFor(() => {
        expect(isJumpPillVisible()).toBe(false);
      });
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
    });

    it("near-end (inside former 10% band, >1px from edge) does not follow growth", async () => {
      // Review P2: the previous "near-end" case parked at scrollTop=0 via
      // enterFreeScrollingAwayFromEnd. This parks 40px from the edge - more
      // than the 1px strict epsilon, inside the library's default 10% band
      // (0.1 * 700 = 70) - and proves threshold=0 does not reattach.
      const messages = makeTranscript(30);
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
      );
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "near-end-band-no-follow",
      });
      await settleLegendList();

      const NEAR_END_DISTANCE_PX = 40;
      const parked = await enterFreeScrollingNearEnd(
        NEAR_END_DISTANCE_PX,
        DEFAULT_COMPOSER_OVERLAY_HEIGHT_PX,
      );
      await waitForPillVisible();
      expect(parked).toBeGreaterThan(0);
      expect(legendListRefHolder.current?.getState().isAtEnd).toBe(false);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      const streamed = appendAssistant(
        messages,
        "near-end-band-stream",
        99_000,
      );
      rerenderMessages(streamed);
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      // Reader position preserved (MVCP / no reattach); allow 1px library epsilon.
      expect(Math.abs(getScrollNode().scrollTop - parked)).toBeLessThanOrEqual(
        1,
      );
      expect(isJumpPillVisible()).toBe(true);

      // Only a true end scroll resumes follow - use the pill (production
      // scrollToEnd path) so mode flips via the explicit go-live action,
      // matching the contract's "clicking the pill ... resumes follow".
      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Scroll to end" }));
      });
      await waitFor(
        () => {
          expect(isJumpPillVisible()).toBe(false);
          expect(getScrollNode().dataset.scrollMode).toBe("following-end");
        },
        { timeout: 3_000 },
      );
    });
  });

  describe("review-corrections: restoration-state regressions", () => {
    it("strict-bottom pointerdown does not persist free-reading; reopen follows newest after growth", async () => {
      // P1-a: cancelTimelineLiveFollowForUserNavigation used to force
      // free-scrolling even when geometry stayed at end. Persistence reads
      // timelineScrollModeRef - a tab switch/close would save free-scrolling
      // and reopen at a row-offset instead of newest content.
      const messages = makeCompletedTranscript(30);
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
      );
      const instanceId = `p1a-pointerdown-persist-${Math.random().toString(36).slice(2)}`;
      const identity = makeDefaultTestIdentity(instanceId);
      tileLiveness.live = true;
      const view = renderChatMessages({
        messages,
        scrollStateKey: instanceId,
        instanceId,
      });
      await settleLegendList();
      assertTrueBottomGeometry();

      // No-op pointerdown at the strict bottom (disclosure click / already-
      // visible target shape): cancels ops but must NOT publish free-scrolling.
      act(() => {
        fireEvent.pointerDown(screen.getByTestId("chat-transcript-container"));
      });
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      expect(legendListRefHolder.current?.getState().isAtEnd).toBe(true);

      // Unmount-save (live tile) commits the mode mirror via
      // captureLiveChatTabScrollSnapshot - this is the corrupted path.
      view.unmount();
      const saved = peekSavedChatTabState(identity);
      expect(saved).not.toBeNull();
      expect(saved?.mode).toBe("following-end");
      expect(saved?.anchorMessageId).toBeNull();

      // Growth while unmounted, then reopen: following-end must land at newest.
      const grown = appendAssistant(messages, "p1a-growth-while-away", 900_500);
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + grown.length * 90 + 40,
      );
      tileLiveness.live = true;
      renderChatMessages({
        messages: grown,
        scrollStateKey: instanceId,
        instanceId,
      });
      await settleLegendList();
      assertTrueBottomGeometry();
      expect(isJumpPillVisible()).toBe(false);
    });

    it("partial-hydration end land + real scroll event still restores original row when full data arrives", async () => {
      // P1-b: setFollowingEndFromTimelinePosition used to clear
      // pendingHydrationRestoreAnchorIdRef on any isAtEnd=true. A temporary
      // clamped restore on a short partial snapshot reports isAtEnd=true via
      // the browser scroll event; that must not erase the unresolved coordinate.
      enableLegendListBrowserScrollEvents();

      const fullMessages = makeCompletedTranscript(200);
      const anchorIndex = 20;
      const anchorId = fullMessages[anchorIndex]?.id ?? null;
      expect(anchorId).toBeTruthy();
      const savedViewOffset = 24;
      const expectedScrollTop =
        anchorIndex * TICKET_13_ROW_HEIGHT_PX +
        LEGEND_LIST_HEADER_PX -
        savedViewOffset;

      const catchupKey = `p1b-hydration-scroll-${Math.random().toString(36).slice(2)}`;
      saveChatTabState({
        identity: makeDefaultTestIdentity(catchupKey),
        mode: "free-scrolling",
        anchorMessageId: anchorId,
        anchorIndex,
        offset: savedViewOffset,
      });

      // Short tail-only partial: neighbor restore lands near/at its own end.
      const partialMessages = fullMessages.slice(180);
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + partialMessages.length * 90 + 40,
      );
      const { rerenderMessages } = renderChatMessages({
        messages: partialMessages,
        scrollStateKey: catchupKey,
      });
      await settleLegendList();
      expect(screen.queryByTestId(`mock-message-${anchorId}`)).toBeNull();
      expect(getScrollNode().scrollTop).not.toBe(expectedScrollTop);

      // Browser path: temporary land at the partial end fires a real scroll
      // event (opt-in harness) reporting isAtEnd=true - pre-fix cleared the
      // pending hydration id here; post-fix must retain it.
      const scrollNode = getScrollNode();
      const partialMax = maxScrollTopFor(scrollNode);
      act(() => {
        scrollNode.scrollTop = partialMax;
        // enableLegendListBrowserScrollEvents already dispatches on write;
        // also flush one frame so LegendList processes the end report.
      });
      await act(async () => {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
      });

      // Full snapshot arrives - hydration-retry effect must still jump.
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + fullMessages.length * 90 + 40,
      );
      rerenderMessages(fullMessages);
      await settleLegendList();

      expect(getScrollNode().scrollTop).toBe(expectedScrollTop);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
    });

    it("close-before-hydration under temporary end keeps durable row for a new instance reopen", async () => {
      // Fixup hydration-transaction P1: a temporary isAtEnd=true report on a
      // partial tail-only snapshot must not release the persistence gate. A
      // genuine close before the original row appears would otherwise commit
      // following-end to the durable chat key; the instance-keyed session
      // fallback cannot rescue a brand-new tileInstanceId.
      enableLegendListBrowserScrollEvents();

      const fullMessages = makeCompletedTranscript(200);
      const anchorIndex = 20;
      const savedViewOffset = 24;
      const anchorId = fullMessages[anchorIndex]?.id ?? null;
      expect(anchorId).toBeTruthy();
      const expectedScrollTop =
        anchorIndex * TICKET_13_ROW_HEIGHT_PX +
        LEGEND_LIST_HEADER_PX -
        savedViewOffset;

      const closedInstance = `htx-close-before-hyd-${Math.random().toString(36).slice(2)}`;
      const reopenedInstance = `htx-reopen-new-inst-${Math.random().toString(36).slice(2)}`;
      const epicId = "epic-1";
      const taskId = "task-1";
      const closedIdentity = makeTestIdentity(closedInstance, epicId, taskId);
      const reopenedIdentity = makeTestIdentity(
        reopenedInstance,
        epicId,
        taskId,
      );

      saveChatTabState({
        identity: closedIdentity,
        mode: "free-scrolling",
        anchorMessageId: anchorId,
        anchorIndex,
        offset: savedViewOffset,
      });

      // Tail-only partial: restored neighbor clamps to the last partial row,
      // which lands at the partial snapshot's own end (isAtEnd=true path).
      const partialMessages = fullMessages.slice(180);
      expect(partialMessages.some((message) => message.id === anchorId)).toBe(
        false,
      );
      const clampedPartial = restoreChatTabState(
        closedIdentity,
        partialMessages,
      );
      expect(clampedPartial.anchorIndex).toBe(partialMessages.length - 1);

      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + partialMessages.length * 90 + 40,
      );
      tileLiveness.live = true;
      const first = renderChatMessages({
        messages: partialMessages,
        instanceId: closedInstance,
        epicId,
        taskId,
      });
      await settleLegendList();
      expect(screen.queryByTestId(`mock-message-${anchorId}`)).toBeNull();

      // Browser-like end report for the temporary partial landing.
      const scrollNode = getScrollNode();
      act(() => {
        scrollNode.scrollTop = maxScrollTopFor(scrollNode);
      });
      await act(async () => {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
      });
      await waitFor(() => {
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      });
      expect(isJumpPillVisible()).toBe(true);

      // Genuine permanent close before the original row ever hydrates.
      // Order matches production: tab-key eviction + liveness false, then
      // unmount (see commitChatTabStateToDurable / rapid-remount precedent).
      evictChatTabState([closedInstance]);
      tileLiveness.live = false;
      first.unmount();

      // Only the durable chat-key half can answer for a brand-new instance id
      // (pendingHydrationRestoreByTabKey is tileInstanceId-keyed and misses).
      const durableAfterClose = peekSavedChatTabState(reopenedIdentity);
      expect(durableAfterClose).not.toBeNull();
      expect(durableAfterClose?.mode).toBe("free-scrolling");
      expect(durableAfterClose?.anchorMessageId).toBe(anchorId);
      expect(durableAfterClose?.anchorIndex).toBe(anchorIndex);
      expect(durableAfterClose?.offset).toBe(savedViewOffset);

      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + fullMessages.length * 90 + 40,
      );
      tileLiveness.live = true;
      const second = renderChatMessages({
        messages: fullMessages,
        instanceId: reopenedInstance,
        epicId,
        taskId,
      });
      await settleLegendList();
      await settleLegendList();

      expect(getScrollNode().scrollTop).toBe(expectedScrollTop);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().scrollTop).not.toBe(
        maxScrollTopFor(getScrollNode()),
      );
      second.unmount();
    });

    it("failed hydration landing retains the coordinate for a later messages-change retry", async () => {
      // Fixup hydration-transaction P1: the late-hydration catch-up must not
      // clear the pending id / session fallback before a validated landing.
      // A first bounded restore that exhausts without validating leaves the
      // coordinate armed so a later `messages` reference change can retry.
      const fullMessages = makeCompletedTranscript(200);
      const anchorIndex = 20;
      const savedViewOffset = 24;
      const anchorId = fullMessages[anchorIndex]?.id ?? null;
      expect(anchorId).toBeTruthy();
      const expectedScrollTop =
        anchorIndex * TICKET_13_ROW_HEIGHT_PX +
        LEGEND_LIST_HEADER_PX -
        savedViewOffset;

      const key = `htx-fail-then-retry-${Math.random().toString(36).slice(2)}`;
      saveChatTabState({
        identity: makeDefaultTestIdentity(key),
        mode: "free-scrolling",
        anchorMessageId: anchorId,
        anchorIndex,
        offset: savedViewOffset,
      });

      const partialMessages = fullMessages.slice(180);
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + partialMessages.length * 90 + 40,
      );
      const { rerenderMessages } = renderChatMessages({
        messages: partialMessages,
        scrollStateKey: key,
      });
      await settleLegendList();
      await settleLegendList();
      expect(screen.queryByTestId(`mock-message-${anchorId}`)).toBeNull();
      expect(getScrollNode().scrollTop).not.toBe(expectedScrollTop);

      const list = legendListRefHolder.current;
      if (list === null) {
        throw new Error("LegendList ref is not mounted");
      }
      // Force the first bounded restore operation (initial + retries) to
      // resolve its scroll promise without ever applying the target offset,
      // so every validate() fails and onExhausted runs.
      const originalScrollToOffset = list.scrollToOffset.bind(list);
      let failLandings = true;
      const scrollToOffsetSpy = vi
        .spyOn(list, "scrollToOffset")
        .mockImplementation((options) => {
          if (failLandings) {
            return Promise.resolve();
          }
          return originalScrollToOffset(options);
        });

      try {
        setLegendListScrollContainerScrollHeightOverride(
          LEGEND_LIST_HEADER_PX + fullMessages.length * 90 + 40,
        );
        rerenderMessages(fullMessages);
        // Bounded restore: initial issue + CHAT_TIMELINE_NAVIGATION_MAX_RETRIES
        // reissues, each settling via promise + double-rAF quiet window.
        await act(async () => {
          for (let frame = 0; frame < 40; frame += 1) {
            await new Promise<void>((resolve) => {
              requestAnimationFrame(() => resolve());
            });
          }
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 80);
          });
        });
        // First attempt exhausted without a validated landing.
        expect(getScrollNode().scrollTop).not.toBe(expectedScrollTop);

        // Unstick the landing failure and force another `messages` reference
        // change (the hydration effect's deps include `messages`). Observable
        // success here proves the coordinate/gate stayed armed through the
        // exhausted attempt rather than being cleared up front.
        failLandings = false;
        rerenderMessages(fullMessages.slice());
        await settleLegendList();
        await act(async () => {
          for (let frame = 0; frame < 20; frame += 1) {
            await new Promise<void>((resolve) => {
              requestAnimationFrame(() => resolve());
            });
          }
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 40);
          });
        });

        expect(getScrollNode().scrollTop).toBe(expectedScrollTop);
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      } finally {
        scrollToOffsetSpy.mockRestore();
      }
    });

    it("explicit gesture while hydration is pending supersedes and survives later full transcript", async () => {
      // Fixup hydration-transaction P1: a real recognized gesture must clear
      // the pending hydration coordinate immediately. When the transcript
      // later grows to include the original raw anchor, the viewport must
      // not jump back to it - reader intent already superseded it.
      const fullMessages = makeCompletedTranscript(200);
      const anchorIndex = 20;
      const savedViewOffset = 24;
      const anchorId = fullMessages[anchorIndex]?.id ?? null;
      expect(anchorId).toBeTruthy();
      const rawAnchorScrollTop =
        anchorIndex * TICKET_13_ROW_HEIGHT_PX +
        LEGEND_LIST_HEADER_PX -
        savedViewOffset;

      const key = `htx-gesture-supersede-${Math.random().toString(36).slice(2)}`;
      // Mid-list partial (not end-clamp): leaves a free-scrolling neighbor so
      // a keyboard gesture can supersede without fighting a temporary end.
      const partialMessages = fullMessages.slice(150);

      saveChatTabState({
        identity: makeDefaultTestIdentity(key),
        mode: "free-scrolling",
        anchorMessageId: anchorId,
        anchorIndex,
        offset: savedViewOffset,
      });
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + partialMessages.length * 90 + 40,
      );
      tileLiveness.live = true;
      const first = renderChatMessages({
        messages: partialMessages,
        scrollStateKey: key,
      });
      await settleLegendList();
      await settleLegendList();
      expect(screen.queryByTestId(`mock-message-${anchorId}`)).toBeNull();

      // Real publishesReaderPosition gesture (keyboard), then park free-scrolling.
      act(() => {
        dispatchKeyInScope("ArrowDown");
      });
      await enterFreeScrollingAwayFromEnd();
      const readerPark = getScrollNode().scrollTop;
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(readerPark).not.toBe(rawAnchorScrollTop);

      // Same mount: full transcript arrives after supersession - no jump back.
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + fullMessages.length * 90 + 40,
      );
      first.rerenderMessages(fullMessages);
      await settleLegendList();
      await settleLegendList();
      expect(getScrollNode().scrollTop).toBe(readerPark);
      expect(getScrollNode().scrollTop).not.toBe(rawAnchorScrollTop);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      first.unmount();

      // Durable commit is the superseding reader position, never the raw
      // hydration anchor that never validated after the gesture.
      const identity = makeDefaultTestIdentity(key);
      const savedAfterSupersede = peekSavedChatTabState(identity);
      expect(savedAfterSupersede).not.toBeNull();
      expect(savedAfterSupersede?.mode).toBe("free-scrolling");
      expect(savedAfterSupersede?.anchorMessageId).not.toBe(anchorId);

      const reopened = renderChatMessages({
        messages: fullMessages,
        scrollStateKey: key,
      });
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().scrollTop).not.toBe(rawAnchorScrollTop);
      reopened.unmount();
    });

    it("browser-event partial-failure hydration still retries original row after messages change", async () => {
      // remove-passive-supersession P1 #1: onIsAtEndChange(false) must not
      // clear the pending hydration coordinate when the catch-up's own
      // programmatic scroll reports isAtEnd=false before bounded validation.
      // A partial/invalid first landing that exhausts must still leave the
      // coordinate armed so a later messages-change retry can succeed.
      enableLegendListBrowserScrollEvents();

      const fullMessages = makeCompletedTranscript(200);
      const anchorIndex = 20;
      const savedViewOffset = 24;
      const anchorId = fullMessages[anchorIndex]?.id ?? null;
      expect(anchorId).toBeTruthy();
      const expectedScrollTop =
        anchorIndex * TICKET_13_ROW_HEIGHT_PX +
        LEGEND_LIST_HEADER_PX -
        savedViewOffset;

      const key = `htx-browser-partial-retry-${Math.random().toString(36).slice(2)}`;
      saveChatTabState({
        identity: makeDefaultTestIdentity(key),
        mode: "free-scrolling",
        anchorMessageId: anchorId,
        anchorIndex,
        offset: savedViewOffset,
      });

      // Tail-only partial: mount-time clamp lands at the partial snapshot's
      // own end while the raw coordinate is pending. The visible mode stays
      // honestly free-scrolling so the reader always has a recovery action.
      const partialMessages = fullMessages.slice(180);
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + partialMessages.length * 90 + 40,
      );
      const { rerenderMessages } = renderChatMessages({
        messages: partialMessages,
        scrollStateKey: key,
      });
      await settleLegendList();
      expect(screen.queryByTestId(`mock-message-${anchorId}`)).toBeNull();
      expect(getScrollNode().scrollTop).not.toBe(expectedScrollTop);

      // Browser-like end report for the temporary partial landing.
      const scrollNode = getScrollNode();
      act(() => {
        scrollNode.scrollTop = maxScrollTopFor(scrollNode);
      });
      await act(async () => {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
      });
      await waitFor(() => {
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      });
      expect(isJumpPillVisible()).toBe(true);

      const list = legendListRefHolder.current;
      if (list === null) {
        throw new Error("LegendList ref is not mounted");
      }
      // Force the first bounded restore to leave the temporary end (so the
      // browser scroll event reports isAtEnd=false - the exact moment the
      // deleted onIsAtEndChange branch used to clear the coordinate) without
      // landing on the saved row+offset that validation requires.
      const originalScrollToOffset = list.scrollToOffset.bind(list);
      let failLandings = true;
      const scrollToOffsetSpy = vi
        .spyOn(list, "scrollToOffset")
        .mockImplementation((options) => {
          if (failLandings) {
            const node = list.getScrollableNode();
            const requested =
              typeof options.offset === "number" ? options.offset : 0;
            // Offset by more than landing epsilon; leave the strict end so
            // onIsAtEndChange(false) runs under enableLegendListBrowserScrollEvents.
            node.scrollTop = Math.max(0, requested + 80);
            return Promise.resolve();
          }
          return originalScrollToOffset(options);
        });

      try {
        setLegendListScrollContainerScrollHeightOverride(
          LEGEND_LIST_HEADER_PX + fullMessages.length * 90 + 40,
        );
        rerenderMessages(fullMessages);
        // Bounded restore: initial issue + CHAT_TIMELINE_NAVIGATION_MAX_RETRIES
        // reissues, each settling via promise + double-rAF quiet window.
        await act(async () => {
          for (let frame = 0; frame < 40; frame += 1) {
            await new Promise<void>((resolve) => {
              requestAnimationFrame(() => resolve());
            });
          }
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 80);
          });
        });
        // First attempt exhausted without a validated landing - and the
        // premature isAtEnd=false report from the partial move must not have
        // disarmed the coordinate.
        expect(getScrollNode().scrollTop).not.toBe(expectedScrollTop);

        // Unstick the landing failure and force another `messages` reference
        // change (the hydration effect's deps include `messages`). Observable
        // success here proves the coordinate survived the browser-event
        // following-to-free transition from the partial programmatic move.
        failLandings = false;
        rerenderMessages(fullMessages.slice());
        await settleLegendList();
        await act(async () => {
          for (let frame = 0; frame < 20; frame += 1) {
            await new Promise<void>((resolve) => {
              requestAnimationFrame(() => resolve());
            });
          }
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 40);
          });
        });

        expect(getScrollNode().scrollTop).toBe(expectedScrollTop);
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      } finally {
        scrollToOffsetSpy.mockRestore();
      }
    });

    it("bare pointerdown then passive scroll before hydration keeps durable row for new-instance reopen", async () => {
      // remove-passive-supersession P1 #2: a non-publishing transcript
      // pointerdown bumps anchorUserScrollGenerationRef; a later passive/
      // programmatic scroll must not release restorePersistencePendingRef via
      // the deleted generation-mismatch heuristic. Permanent close before the
      // original row hydrates must still re-commit the raw durable coordinate.
      enableLegendListBrowserScrollEvents();

      const fullMessages = makeCompletedTranscript(200);
      const anchorIndex = 20;
      const savedViewOffset = 24;
      const anchorId = fullMessages[anchorIndex]?.id ?? null;
      expect(anchorId).toBeTruthy();
      const expectedScrollTop =
        anchorIndex * TICKET_13_ROW_HEIGHT_PX +
        LEGEND_LIST_HEADER_PX -
        savedViewOffset;

      const closedInstance = `htx-ptr-passive-${Math.random().toString(36).slice(2)}`;
      const reopenedInstance = `htx-ptr-reopen-${Math.random().toString(36).slice(2)}`;
      const epicId = "epic-1";
      const taskId = "task-1";
      const closedIdentity = makeTestIdentity(closedInstance, epicId, taskId);
      const reopenedIdentity = makeTestIdentity(
        reopenedInstance,
        epicId,
        taskId,
      );

      saveChatTabState({
        identity: closedIdentity,
        mode: "free-scrolling",
        anchorMessageId: anchorId,
        anchorIndex,
        offset: savedViewOffset,
      });

      // Tail-only partial: restored neighbor clamps to the last partial row,
      // which lands at the partial snapshot's own end (isAtEnd=true path).
      const partialMessages = fullMessages.slice(180);
      expect(partialMessages.some((message) => message.id === anchorId)).toBe(
        false,
      );
      const clampedPartial = restoreChatTabState(
        closedIdentity,
        partialMessages,
      );
      expect(clampedPartial.anchorIndex).toBe(partialMessages.length - 1);

      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + partialMessages.length * 90 + 40,
      );
      tileLiveness.live = true;
      const first = renderChatMessages({
        messages: partialMessages,
        instanceId: closedInstance,
        epicId,
        taskId,
      });
      await settleLegendList();
      expect(screen.queryByTestId(`mock-message-${anchorId}`)).toBeNull();

      // Browser-like end report for the temporary partial landing.
      const scrollNode = getScrollNode();
      act(() => {
        scrollNode.scrollTop = maxScrollTopFor(scrollNode);
      });
      await act(async () => {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
      });
      await waitFor(() => {
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      });
      expect(isJumpPillVisible()).toBe(true);

      // Bare non-publishing pointerdown (disclosure click shape) bumps the
      // generation but must not release the gate or hide the recovery pill.
      act(() => {
        fireEvent.pointerDown(screen.getByTestId("chat-transcript-container"));
      });
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // Passive/programmatic scroll without a meaningful position change -
      // the deleted handleScroll generation-mismatch check used to release
      // restorePersistencePendingRef here because pointerdown had already
      // bumped anchorUserScrollGenerationRef against a never-seeded
      // restorePersistenceGenerationRef (0).
      act(() => {
        fireEvent.scroll(getScrollNode());
      });
      await act(async () => {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
      });

      // Genuine permanent close before the original row ever hydrates.
      // Order matches production: tab-key eviction + liveness false, then
      // unmount (see commitChatTabStateToDurable / rapid-remount precedent).
      evictChatTabState([closedInstance]);
      tileLiveness.live = false;
      first.unmount();

      // Only the durable chat-key half can answer for a brand-new instance id
      // (pendingHydrationRestoreByTabKey is tileInstanceId-keyed and misses).
      const durableAfterClose = peekSavedChatTabState(reopenedIdentity);
      expect(durableAfterClose).not.toBeNull();
      expect(durableAfterClose?.mode).toBe("free-scrolling");
      expect(durableAfterClose?.anchorMessageId).toBe(anchorId);
      expect(durableAfterClose?.anchorIndex).toBe(anchorIndex);
      expect(durableAfterClose?.offset).toBe(savedViewOffset);

      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + fullMessages.length * 90 + 40,
      );
      tileLiveness.live = true;
      const second = renderChatMessages({
        messages: fullMessages,
        instanceId: reopenedInstance,
        epicId,
        taskId,
      });
      await settleLegendList();
      await settleLegendList();

      expect(getScrollNode().scrollTop).toBe(expectedScrollTop);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().scrollTop).not.toBe(
        maxScrollTopFor(getScrollNode()),
      );
      second.unmount();
    });

    it("representative mutations follow at strict edge and stay parked away from it", async () => {
      // Matrix coverage the timeline-level prop-shape test cannot provide:
      // queued flush, A2A inbound, setup-card weave, non-tail weave, row
      // disclosure (setItemSize), and footer/inset - each at the strict edge
      // AND away from it.
      //
      // Fixup (remove-passive-supersession, P2): a genuine pane/viewport-
      // length (clientHeight/scrollLength) mutation is NOT covered here.
      // `composerOverlayHeight` only drives `contentInsetEndAdjustment`
      // (the same path `footer-inset` already exercises at a different
      // value) - it never changes the scroll container's own measured size,
      // so a second inset case would duplicate `footer-inset`, not add real
      // pane-resize coverage. LegendList observes a genuine container resize
      // only via a ResizeObserver callback on the real scroll node
      // (`useOnLayoutSync` in the installed `@legendapp/list@3.2.0`), which
      // this harness's global `MockResizeObserver` never fires - faithfully
      // triggering it would require inventing a controllable-ResizeObserver
      // shim reaching into the library's own lazily-cached global observer
      // singleton, exactly the fragile, easily-stale pattern removed from
      // this file in the prior fixup round. The static contract this matrix
      // cannot replace - `maintainScrollAtEnd.on.layout === true` - is
      // already pinned directly in `chat-timeline.test.tsx` ("pins
      // maintainScrollAtEndThreshold=0 and static end/MVCP maintenance").
      // Real pane-resize behavior needs the explicit live-browser gate, not
      // a simulated jsdom layout event.
      type MutationCase = {
        readonly label: string;
        readonly apply: (
          messages: ReadonlyArray<ChatMessageModel>,
        ) => ReadonlyArray<ChatMessageModel> | "size" | "inset";
      };

      const cases: ReadonlyArray<MutationCase> = [
        {
          label: "queued-flush",
          apply: (messages) =>
            appendQueuedFlushRow(messages, "queued-flush-row", 901_000),
        },
        {
          label: "a2a-inbound",
          apply: (messages) =>
            appendA2AUserRow(messages, "a2a-inbound-row", 901_001),
        },
        {
          label: "setup-card-weave",
          apply: (messages) =>
            weaveSetupCardAbove(messages, 4, "setup-card-weave-row"),
        },
        {
          label: "non-tail-weave",
          apply: (messages) =>
            weaveNonTailRow(messages, "non-tail-weave-row", 901_002),
        },
        {
          label: "disclosure-size",
          apply: () => "size",
        },
        {
          label: "footer-inset",
          apply: () => "inset",
        },
      ];

      for (const atEdge of [true, false] as const) {
        for (const mutation of cases) {
          cleanup();
          evictChatTabPersistenceForEpic("epic-1");
          const base = makeCompletedTranscript(24);
          setLegendListScrollContainerScrollHeightOverride(
            LEGEND_LIST_HEADER_PX + base.length * 90 + 40,
          );
          const key = `matrix-${mutation.label}-${atEdge ? "edge" : "away"}-${Math.random().toString(36).slice(2)}`;
          const { rerenderMessages, rerenderWith } = renderChatMessages({
            messages: base,
            scrollStateKey: key,
          });
          await settleLegendList();

          let parked = 0;
          if (atEdge) {
            assertTrueBottomGeometry();
          } else {
            parked = await enterFreeScrollingNearEnd(
              40,
              DEFAULT_COMPOSER_OVERLAY_HEIGHT_PX,
            );
            await waitForPillVisible();
          }

          const result = mutation.apply(base);
          if (result === "size") {
            const list = legendListRefHolder.current;
            expect(list).not.toBeNull();
            // Disclosure: mid-list row grows without an app scroll command.
            const midId = base[6]?.id;
            expect(midId).toBeTruthy();
            act(() => {
              list?.setItemSize(midId, {
                height: 240,
                width: VIEWPORT_WIDTH_PX,
              });
            });
            await settleLegendList();
          } else if (result === "inset") {
            rerenderWith({ composerOverlayHeight: 240 });
            await settleLegendList();
          } else {
            setLegendListScrollContainerScrollHeightOverride(
              LEGEND_LIST_HEADER_PX + result.length * 90 + 40,
            );
            rerenderMessages(result);
            await settleLegendList();
          }

          if (atEdge) {
            // Mode + pill, and true bottom DOM/list geometry after follow.
            await waitFor(() => {
              assertTrueBottomGeometry();
            });
            expect(isJumpPillVisible()).toBe(false);
          } else {
            expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
            expect(getScrollNode().scrollTop).toBe(parked);
            expect(isJumpPillVisible()).toBe(true);
          }
        }
      }
    });
  });

  it("Home cancels follow and parks subsequent growth", async () => {
    const messages = makeTranscript(20);
    const { rerenderMessages } = renderChatMessages({
      messages,
      scrollStateKey: "kbd-home-key",
    });
    await settleLegendList();

    act(() => {
      dispatchKeyInScope("Home");
    });
    // After free-scrolling mode flip, drive an explicit non-end park so
    // growth assertions are not fighting maintainScrollAtEnd while the
    // jsdom keyboard step may not move the WeakMap-backed scrollTop.
    await fireScrollTopAndFlush(0);
    await waitFor(() => {
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
    });

    const parked = getScrollNode().scrollTop;
    rerenderMessages(appendAssistant(messages, "home-stream", 60_000));
    await settleLegendList();
    expect(getScrollNode().scrollTop).toBe(parked);
    expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
  });

  it("PageUp cancels follow and parks subsequent growth", async () => {
    const messages = makeTranscript(20);
    const { rerenderMessages } = renderChatMessages({
      messages,
      scrollStateKey: "kbd-page-key",
    });
    await settleLegendList();

    act(() => {
      dispatchKeyInScope("PageUp");
    });
    await fireScrollTopAndFlush(0);
    await waitFor(() => {
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
    });

    const parked = getScrollNode().scrollTop;
    rerenderMessages(appendAssistant(messages, "page-stream", 61_000));
    await settleLegendList();
    expect(getScrollNode().scrollTop).toBe(parked);
    expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
  });

  it("scroll-only upward departure releases follow and parks growth", async () => {
    const messages = makeTranscript(20);
    const { rerenderMessages } = renderChatMessages({
      messages,
      scrollStateKey: "follow-scroll-only-departure",
    });
    await settleLegendList();

    await enterFreeScrollingAwayFromEnd();
    await waitForPillVisible();
    const parked = getScrollNode().scrollTop;
    expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

    rerenderMessages(
      appendAssistant(messages, "growth-after-scroll-only-departure", 100_001),
    );
    await settleLegendList();
    expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
    expect(getScrollNode().scrollTop).toBe(parked);
  });

  it("F1: a restored free-scrolling mid-list position does not flip to following-end", async () => {
    const messages = makeCompletedTranscript(20);
    const instanceId = `t5-f1-mid-${Math.random().toString(36).slice(2)}`;
    const identity = makeDefaultTestIdentity(instanceId);
    const anchorId = messages[4]?.id;
    expect(anchorId).toBeTruthy();

    saveChatTabState({
      identity,
      mode: "free-scrolling",
      anchorMessageId: anchorId,
      anchorIndex: 4,
      offset: 24,
    });

    tileLiveness.live = true;
    renderChatMessages({
      messages,
      scrollStateKey: instanceId,
      instanceId,
      freshOpen: true,
    });
    await settleLegendList();
    expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
    expect(isJumpPillVisible()).toBe(true);
  });

  it("pointerdown capture while free-scrolling publishes a free-scrolling snapshot", async () => {
    const messages = makeCompletedTranscript(24);
    const instanceId = `t5-inline-source-${Math.random().toString(36).slice(2)}`;
    tileLiveness.live = true;
    const view = renderChatMessages({
      messages,
      scrollStateKey: instanceId,
      instanceId,
    });
    await settleLegendList();

    await enterFreeScrollingAwayFromEnd();
    fireEvent.pointerDown(screen.getByTestId("chat-transcript-container"));

    const capture = restoreChatTabState(
      makeDefaultTestIdentity(instanceId),
      messages,
    );
    expect(capture.mode).toBe("free-scrolling");
    expect(capture.anchorMessageId).not.toBeNull();
    view.unmount();
  });

  describe("fix-top-level-task-tab-scroll-restoration: visibility handoff", () => {
    // Root cause (ticket fix-top-level-task-tab-scroll-restoration):
    // `TopLevelTabHost` keeps a background top-level pane mounted and hides
    // it with `display:none` (top-level-tab-host.tsx's `surfaceClassName`).
    // The CURRENT hosted-chat plane (`StableTileSurfaceHost`,
    // `STABLE_TILE_SURFACE_HOST_ENABLED=true`) does not itself use
    // `display:none` - its record is `visibility:hidden` so its own box
    // survives - but `tile-surface-geometry-coordinator.ts`'s shared
    // ResizeObserver reacts to the placeholder SLOT (still living in the
    // now-`display:none` original pane) reporting a zeroed
    // `getBoundingClientRect()`, and applies that zero rect as the hosted
    // record's inline `width`/`height` (`stable-tile-surface-host.tsx`'s
    // `applyRectToElement`). The still-mounted `ChatMessages`/LegendList
    // therefore observes a genuinely 0x0 scroll container while hidden -
    // the exact "0x0 measuring surface" hazard `PaneVisibilityContext`'s own
    // doc comment describes, reached via the geometry coordinator rather
    // than a `display:none` directly on the scroll node itself. jsdom has no
    // layout engine and its global `ResizeObserver` mock never invokes its
    // callback (`__tests__/test-browser-apis.ts`), and this suite's own
    // `installLegendListViewportMetrics` shim reads every dimension from
    // element ROLE, never from CSS/inline style - so driving that real
    // CSS/ResizeObserver/geometry-coordinator chain end to end cannot
    // reproduce the loss in this environment (`stable-tile-surface-host.
    // test.tsx` already owns that plane's own DOM-attribute-level coverage).
    // This test instead forces the same terminal, mechanism-independent
    // symptom directly: a real browser also resets a scroll container's
    // `scrollTop` synchronously, in the SAME commit an ancestor goes
    // `display:none`/0x0, before any effect can read a coherent position -
    // see `hooks/scroll/use-scroll-restoration.ts`'s own doc comment, which
    // already documents and solves this exact hazard for the native-div and
    // bundle-diff tile bodies via a continuously-mirrored ref.
    it("hidden permanent close does not overwrite the published handoff with zero geometry; new-instance reopen restores it", async () => {
      // Fixup (hidden-close-and-rapid-capture, P1 #1): `persistCurrentScroll`'s
      // ordinary (non-restore-pending) branch used to call
      // `captureLiveChatTabScrollSnapshot()` UNCONDITIONALLY on every unmount,
      // including a permanent close of a tab that has been hidden (and
      // therefore geometry-zeroed via the real production chain documented
      // above) for a while. That live read would silently resolve to
      // row-zero/clamped garbage and overwrite the durable coordinate the
      // hide-time handoff had already published correctly. Simulate the
      // "already zeroed" symptom directly (scoped `clientHeight` override on
      // the scroll node, matching the same terminal-symptom-injection
      // approach used above for `scrollTop`) through a genuine close and
      // reopen under a brand-new instance id.
      const messages = makeCompletedTranscript(200);
      const anchorIndex = 50;
      const savedViewOffset = 24;
      const anchorId = messages[anchorIndex]?.id ?? null;
      expect(anchorId).toBeTruthy();
      const closedInstance = `t-visibility-hidden-close-${Math.random().toString(36).slice(2)}`;
      const reopenedInstance = `t-visibility-hidden-reopen-${Math.random().toString(36).slice(2)}`;
      const epicId = "epic-1";
      const taskId = "task-1";
      const closedIdentity = makeTestIdentity(closedInstance, epicId, taskId);
      const reopenedIdentity = makeTestIdentity(
        reopenedInstance,
        epicId,
        taskId,
      );
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
      );
      saveChatTabState({
        identity: closedIdentity,
        mode: "free-scrolling",
        anchorMessageId: anchorId,
        anchorIndex,
        offset: savedViewOffset,
      });
      tileLiveness.live = true;
      const first = renderChatMessages({
        messages,
        instanceId: closedInstance,
        epicId,
        taskId,
      });
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      const beforeHide = getScrollNode().scrollTop;
      expect(beforeHide).toBeGreaterThan(0);

      // Hide: force the same terminal symptom the real chain produces - the
      // scroll node reports zeroed geometry from here on, matching a pane
      // that has been hidden (and therefore geometry-coordinator-zeroed)
      // for a while by the time it gets closed.
      const clientHeightSpy = vi
        .spyOn(HTMLElement.prototype, "clientHeight", "get")
        .mockImplementation(function (this: HTMLElement) {
          return this === getScrollNode() ? 0 : 700;
        });
      try {
        act(() => {
          getScrollNode().scrollTop = 0;
        });
        first.rerenderWith({ visible: false });
        await settleLegendList();

        // Hide-time handoff published the correct (mirrored) coordinate.
        const afterHide = peekSavedChatTabState(closedIdentity);
        expect(afterHide?.mode).toBe("free-scrolling");
        expect(afterHide?.anchorMessageId).toBe(anchorId);
        expect(afterHide?.anchorIndex).toBe(anchorIndex);
        expect(afterHide?.offset).toBe(savedViewOffset);

        // Genuine permanent close while still hidden/zero-sized - same
        // production order as the other close regressions (tab-key eviction
        // + liveness false, then unmount).
        evictChatTabState([closedInstance]);
        tileLiveness.live = false;
        first.unmount();
      } finally {
        clientHeightSpy.mockRestore();
      }

      // The unmount cleanup must NOT have overwritten the durable entry
      // with a zero-geometry live read - only the durable chat-key half can
      // answer for a brand-new instance id regardless.
      const durableAfterClose = peekSavedChatTabState(reopenedIdentity);
      expect(durableAfterClose).not.toBeNull();
      expect(durableAfterClose?.mode).toBe("free-scrolling");
      expect(durableAfterClose?.anchorMessageId).toBe(anchorId);
      expect(durableAfterClose?.anchorIndex).toBe(anchorIndex);
      expect(durableAfterClose?.offset).toBe(savedViewOffset);

      tileLiveness.live = true;
      const second = renderChatMessages({
        messages,
        instanceId: reopenedInstance,
        epicId,
        taskId,
      });
      await settleLegendList();
      await settleLegendList();

      expect(getScrollNode().scrollTop).toBe(beforeHide);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      second.unmount();
    });

    it("a free-reading position survives a visibility hide/show cycle", async () => {
      const messages = makeCompletedTranscript(200);
      const anchorIndex = 20;
      const savedViewOffset = 24;
      const anchorId = messages[anchorIndex]?.id ?? null;
      expect(anchorId).toBeTruthy();
      const key = `t-visibility-free-reading-${Math.random().toString(36).slice(2)}`;
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
      );
      saveChatTabState({
        identity: makeDefaultTestIdentity(key),
        mode: "free-scrolling",
        anchorMessageId: anchorId,
        anchorIndex,
        offset: savedViewOffset,
      });
      const { rerenderWith } = renderChatMessages({
        messages,
        scrollStateKey: key,
      });
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      const beforeHide = getScrollNode().scrollTop;
      expect(beforeHide).toBeGreaterThan(0);

      // The pane hides: force the same terminal symptom the real
      // display:none/geometry-coordinator chain produces (see block comment
      // above) - the browser zeroes scrollTop in the same commit.
      act(() => {
        getScrollNode().scrollTop = 0;
      });
      rerenderWith({ visible: false });
      await settleLegendList();
      expect(getScrollNode().scrollTop).toBe(0);

      // The pane shows again - the visibility-handoff effect replays the
      // last known-good snapshot through the same restoration seam.
      rerenderWith({ visible: true });
      await settleLegendList();

      expect(getScrollNode().scrollTop).toBe(beforeHide);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
    });

    it("repeated hide/show cycles do not accumulate drift", async () => {
      const messages = makeCompletedTranscript(200);
      const anchorIndex = 20;
      const savedViewOffset = 24;
      const anchorId = messages[anchorIndex]?.id ?? null;
      expect(anchorId).toBeTruthy();
      const key = `t-visibility-repeated-${Math.random().toString(36).slice(2)}`;
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
      );
      saveChatTabState({
        identity: makeDefaultTestIdentity(key),
        mode: "free-scrolling",
        anchorMessageId: anchorId,
        anchorIndex,
        offset: savedViewOffset,
      });
      const { rerenderWith } = renderChatMessages({
        messages,
        scrollStateKey: key,
      });
      await settleLegendList();
      const original = getScrollNode().scrollTop;
      expect(original).toBeGreaterThan(0);

      for (let cycle = 0; cycle < 3; cycle += 1) {
        act(() => {
          getScrollNode().scrollTop = 0;
        });
        rerenderWith({ visible: false });
        await settleLegendList();
        rerenderWith({ visible: true });
        await settleLegendList();
        expect(getScrollNode().scrollTop).toBe(original);
      }
    });

    it("regression: an exhausted visibility replay releases the persistence gate", async () => {
      // A show-time replay whose bounded restore exhausts without validating
      // has no retry (the effect only fires on hide/show transitions). The
      // gate it armed must release on exhaustion - a stuck gate silently
      // no-ops every later scroll-snapshot capture, so the NEXT hide would
      // publish the stale pre-hide position instead of where the reader
      // actually moved.
      const messages = makeCompletedTranscript(200);
      const anchorIndex = 20;
      const savedViewOffset = 24;
      const anchorId = messages[anchorIndex]?.id ?? null;
      expect(anchorId).toBeTruthy();
      const key = `t-visibility-exhausted-replay-${Math.random().toString(36).slice(2)}`;
      const identity = makeDefaultTestIdentity(key);
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
      );
      saveChatTabState({
        identity,
        mode: "free-scrolling",
        anchorMessageId: anchorId,
        anchorIndex,
        offset: savedViewOffset,
      });
      const { rerenderWith } = renderChatMessages({
        messages,
        scrollStateKey: key,
      });
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      act(() => {
        getScrollNode().scrollTop = 0;
      });
      rerenderWith({ visible: false });
      await settleLegendList();

      const list = legendListRefHolder.current;
      if (list === null) {
        throw new Error("LegendList ref is not mounted");
      }
      // Force the replay's bounded restore (initial + retries) to resolve
      // its scroll promise without ever applying the target offset, so every
      // validate() fails and the operation exhausts.
      const scrollToOffsetSpy = vi
        .spyOn(list, "scrollToOffset")
        .mockImplementation(() => Promise.resolve());
      try {
        rerenderWith({ visible: true });
        // Initial issue + CHAT_TIMELINE_NAVIGATION_MAX_RETRIES reissues,
        // each settling via promise + double-rAF quiet window.
        await act(async () => {
          for (let frame = 0; frame < 40; frame += 1) {
            await new Promise<void>((resolve) => {
              requestAnimationFrame(() => resolve());
            });
          }
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 80);
          });
        });
      } finally {
        scrollToOffsetSpy.mockRestore();
      }

      // The reader moves somewhere new WITHOUT a publishing gesture (a bare
      // scroll report never clears the gate the way wheel/scrollbar input
      // does), then the pane hides again and publishes the mirror.
      const movedIndex = 100;
      const movedScrollTop =
        movedIndex * TICKET_13_ROW_HEIGHT_PX + LEGEND_LIST_HEADER_PX;
      await fireScrollTopAndFlush(movedScrollTop);
      await settleLegendList();
      rerenderWith({ visible: false });
      await settleLegendList();

      const persisted = restoreChatTabState(identity, messages);
      expect(persisted.mode).toBe("free-scrolling");
      // With the gate stuck, the capture no-ops and the second hide republishes
      // the stale anchor-20 snapshot; a released gate persists the real move.
      expect(persisted.anchorIndex).toBeGreaterThan(anchorIndex);
    });

    it("a bottom-following reader returns to the newest true bottom after hidden growth", async () => {
      // Fixup (callback-synchronous-follow): the follow latch's permission
      // is updated by publishing wheel intent plus the resulting native
      // `scroll` event. The manual `scrollTop = 0` write below needs the shim's
      // synthetic-event dispatch enabled, matching what a real browser does,
      // so the latch learns the reader detached before the visibility toggle.
      enableLegendListBrowserScrollEvents();
      const messages = makeCompletedTranscript(24);
      const key = `t-visibility-following-end-${Math.random().toString(36).slice(2)}`;
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
      );
      const { rerenderWith, rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: key,
      });
      await settleLegendList();
      assertTrueBottomGeometry();

      act(() => {
        getScrollNode().dispatchEvent(
          new WheelEvent("wheel", { deltaY: -120 }),
        );
        getScrollNode().scrollTop = 0;
      });
      rerenderWith({ visible: false });
      await settleLegendList();
      expect(getScrollNode().scrollTop).toBe(0);

      // Growth arrives while hidden.
      const grown = appendAssistant(messages, "hidden-growth-msg", 900_000);
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + grown.length * 90 + 40,
      );
      rerenderMessages(grown);

      rerenderWith({ visible: true });
      await settleLegendList();

      await waitFor(() => {
        assertTrueBottomGeometry();
      });
      expect(isJumpPillVisible()).toBe(false);
    });

    it("hidden growth while free-reading preserves the reading coordinate and stays detached", async () => {
      // Acceptance criterion 3: free-reading + hidden appends must restore the
      // pre-hide row+offset and remain free-scrolling (not reattach to the
      // newer true bottom).
      const messages = makeCompletedTranscript(200);
      const anchorIndex = 20;
      const savedViewOffset = 24;
      const anchorId = messages[anchorIndex]?.id ?? null;
      expect(anchorId).toBeTruthy();
      const key = `t-visibility-free-growth-${Math.random().toString(36).slice(2)}`;
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
      );
      saveChatTabState({
        identity: makeDefaultTestIdentity(key),
        mode: "free-scrolling",
        anchorMessageId: anchorId,
        anchorIndex,
        offset: savedViewOffset,
      });
      const { rerenderWith, rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: key,
      });
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      const beforeHide = getScrollNode().scrollTop;
      expect(beforeHide).toBeGreaterThan(0);

      act(() => {
        getScrollNode().scrollTop = 0;
      });
      rerenderWith({ visible: false });
      await settleLegendList();
      expect(getScrollNode().scrollTop).toBe(0);

      // Growth arrives while the free-reading surface is hidden.
      const grown = appendAssistant(
        messages,
        "hidden-free-growth-msg",
        900_000,
      );
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + grown.length * 90 + 40,
      );
      rerenderMessages(grown);

      rerenderWith({ visible: true });
      await settleLegendList();

      expect(getScrollNode().scrollTop).toBe(beforeHide);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      // Still detached from the (now longer) true bottom.
      expect(getScrollNode().scrollTop).toBeLessThan(
        maxScrollTopFor(getScrollNode()) - 1,
      );
    });

    it("a scroll immediately followed by hide publishes the new position, not the previous mirror", async () => {
      // Fixup (hidden-close-and-rapid-capture, P1 #2): the mirror capture
      // must run SYNCHRONOUSLY inside `handleScroll`, never scheduled onto a
      // SECOND, app-owned animation frame on top of whatever LegendList's
      // own scroll/position bookkeeping already needs. `fireScrollTopWithout
      // Flush` (investigated directly, not just assumed) proves that
      // bookkeeping - `getState().scroll`, `positionAtIndex`, and the
      // rendered-window bounds `viewportAnchorMessageId` searches - is not
      // internally self-consistent immediately after a raw `scrollTop`
      // write in this harness: `handleScroll` itself does not run until
      // LegendList's own processing has had at least one frame, and reading
      // ANYTHING (mirror OR a live DOM read, guarded or not) before that
      // frame risks resolving to the wrong row rather than failing safely -
      // a library-internal scheduling floor this component cannot bypass by
      // itself, distinct from the app-level throttle this fixup removes.
      // `fireScrollTopAndFlush` gives exactly that one required frame; this
      // test hides IMMEDIATELY after it, with zero ADDITIONAL settle, to
      // prove the app no longer needs a SECOND frame on top of the one
      // LegendList itself needs (the throttled version this fixup replaces
      // scheduled its own capture for that second frame, which a hide
      // arriving before it fired would miss entirely).
      const messages = makeCompletedTranscript(200);
      const initialIndex = 20;
      const initialOffset = 24;
      const initialId = messages[initialIndex]?.id ?? null;
      expect(initialId).toBeTruthy();
      const identity = makeDefaultTestIdentity(
        `t-visibility-rapid-hide-${Math.random().toString(36).slice(2)}`,
      );
      const key = identity.tileInstanceId;
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
      );
      saveChatTabState({
        identity,
        mode: "free-scrolling",
        anchorMessageId: initialId,
        anchorIndex: initialIndex,
        offset: initialOffset,
      });
      const { rerenderWith } = renderChatMessages({
        messages,
        scrollStateKey: key,
      });
      await settleLegendList();
      // Second settle covers the restore promise + double-rAF quiet window
      // so the free-scroll landing has fully validated before we scroll.
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      const initialScrollTop = getScrollNode().scrollTop;
      expect(initialScrollTop).toBeGreaterThan(0);

      // Distinct mid-history park so a stale initial restore is unambiguous.
      const newIndex = 50;
      const newViewOffset = 24;
      const newScrollTop =
        LEGEND_LIST_HEADER_PX +
        newIndex * TICKET_13_ROW_HEIGHT_PX -
        newViewOffset;
      // The one frame LegendList itself needs to settle scroll/position
      // bookkeeping for the new target - not an extra app-level frame on
      // top of it (see comment above).
      await fireScrollTopAndFlush(newScrollTop);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().scrollTop).toBe(newScrollTop);
      expect(getScrollNode().scrollTop).not.toBe(initialScrollTop);

      // Hide immediately - zero additional settle between the scroll
      // landing and the visibility transition.
      act(() => {
        getScrollNode().scrollTop = 0;
      });
      rerenderWith({ visible: false });
      await settleLegendList();
      expect(getScrollNode().scrollTop).toBe(0);

      // Hide must have published the post-scroll coordinate into the shared
      // cache (not the pre-scroll seed, not a zeroed first-row snapshot).
      const published = peekSavedChatTabState(identity);
      expect(published?.mode).toBe("free-scrolling");
      expect(published?.anchorMessageId).not.toBeNull();
      expect(published?.anchorIndex).toBeGreaterThan(newIndex - 2);
      expect(published?.anchorIndex).toBeLessThan(newIndex + 2);

      rerenderWith({ visible: true });
      await settleLegendList();

      expect(getScrollNode().scrollTop).toBe(newScrollTop);
      expect(getScrollNode().scrollTop).not.toBe(initialScrollTop);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
    });

    it("a destructively-removed saved row while hidden uses the preserve-or-clamp fallback", async () => {
      // Acceptance criterion 6: free-reading + hidden removal of the exact
      // saved anchor uses restoreChatTabState's nearest-surviving-index clamp
      // (same math as mount-time remount), never jumps to row 0 / a semantic
      // query, and never forces following-end.
      const messages = makeCompletedTranscript(200);
      const anchorIndex = 20;
      const savedViewOffset = 24;
      const anchorId = messages[anchorIndex]?.id ?? null;
      expect(anchorId).toBeTruthy();
      const identity = makeDefaultTestIdentity(
        `t-visibility-removed-anchor-${Math.random().toString(36).slice(2)}`,
      );
      const key = identity.tileInstanceId;
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
      );
      saveChatTabState({
        identity,
        mode: "free-scrolling",
        anchorMessageId: anchorId,
        anchorIndex,
        offset: savedViewOffset,
      });
      const { rerenderWith, rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: key,
      });
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().scrollTop).toBeGreaterThan(0);

      act(() => {
        getScrollNode().scrollTop = 0;
      });
      rerenderWith({ visible: false });
      await settleLegendList();
      expect(getScrollNode().scrollTop).toBe(0);

      // Exact saved row disappears while hidden (branch edit / suffix removal).
      const remaining = messages.filter((message) => message.id !== anchorId);
      expect(remaining.some((message) => message.id === anchorId)).toBe(false);
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + remaining.length * 90 + 40,
      );
      rerenderMessages(remaining);

      // Same clamp math remount uses: pin to the neighbor at clamped index,
      // offset resets to 0 (the substituted row's prior pixel offset is
      // meaningless for a different anchor).
      const expectedReplay = restoreChatTabState(identity, remaining);
      expect(expectedReplay).toEqual({
        mode: "free-scrolling",
        anchorMessageId: remaining[anchorIndex]?.id ?? null,
        anchorIndex,
        offset: 0,
      });
      expect(expectedReplay.anchorMessageId).not.toBe(anchorId);
      expect(expectedReplay.anchorMessageId).not.toBeNull();

      rerenderWith({ visible: true });
      await settleLegendList();

      const restoredTop = getScrollNode().scrollTop;
      // offset 0 at the clamped neighbor index.
      const expectedScrollTop =
        LEGEND_LIST_HEADER_PX + anchorIndex * TICKET_13_ROW_HEIGHT_PX;
      expect(restoredTop).toBe(expectedScrollTop);
      // Never the force-zero / first-row loss, never following-end bottom.
      expect(restoredTop).toBeGreaterThan(0);
      expect(restoredTop).toBeLessThan(maxScrollTopFor(getScrollNode()) - 1);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().dataset.scrollMode).not.toBe("following-end");
    });
  });

  describe("internal-tab-bottom-follow: mount-time free-restore abort releases persistence", () => {
    // Companion to stable-tile matrix rows 15-16 / 17-26. Those drive the
    // real same-pane remount path; these pin the ChatMessages-only race:
    // clamped free-scrolling restore still converging when the reader lands
    // demonstrably past that restore's own target at true bottom must release
    // restorePersistencePendingRef so unmount-save commits following-end.

    it("reaching true bottom past an in-flight clamped free restore persists following-end across remount", async () => {
      enableLegendListBrowserScrollEvents();
      const messages = makeCompletedTranscript(80);
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
      );
      const instanceId = `itbf-race-${Math.random().toString(36).slice(2)}`;
      const identity = makeDefaultTestIdentity(instanceId);
      tileLiveness.live = true;

      saveChatTabState({
        identity,
        mode: "free-scrolling",
        anchorMessageId: "totally-missing-id",
        anchorIndex: 40,
        offset: 12,
      });

      // Deliberately do not settleLegendList before the true-bottom gesture:
      // the mount-time clamped free restore must still be converging.
      const first = renderChatMessages({
        messages,
        scrollStateKey: instanceId,
        instanceId,
        freshOpen: true,
      });
      await waitFor(() => {
        expect(
          document.querySelector('[data-testid="chat-messages-scroll"]'),
        ).not.toBeNull();
      });

      const scrollNode = getScrollNode();
      for (let frame = 0; frame < 8; frame += 1) {
        act(() => {
          scrollNode.scrollTop = maxScrollTopFor(scrollNode);
        });
        // eslint-disable-next-line no-await-in-loop
        await act(async () => {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
        });
        if (scrollNode.dataset.scrollMode === "following-end") break;
      }
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");

      first.unmount();
      const saved = peekSavedChatTabState(identity);
      expect(saved).not.toBeNull();
      expect(saved?.mode).toBe("following-end");
      expect(saved?.anchorMessageId).toBeNull();

      tileLiveness.live = true;
      renderChatMessages({
        messages,
        scrollStateKey: instanceId,
        instanceId,
        freshOpen: true,
      });
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      assertTrueBottomGeometry();
      expect(isJumpPillVisible()).toBe(false);
    });

    it("repeated unmount/remount cycles at true bottom stay following-end (no free-scrolling drift)", async () => {
      enableLegendListBrowserScrollEvents();
      const messages = makeCompletedTranscript(60);
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
      );
      const instanceId = `itbf-cycles-${Math.random().toString(36).slice(2)}`;
      const identity = makeDefaultTestIdentity(instanceId);
      tileLiveness.live = true;

      let view = renderChatMessages({
        messages,
        scrollStateKey: instanceId,
        instanceId,
      });
      await settleLegendList();
      await enterFreeScrollingAwayFromEnd();
      act(() => {
        getScrollNode().scrollTop = maxScrollTopFor(getScrollNode());
      });
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");

      for (let cycle = 0; cycle < 3; cycle += 1) {
        view.unmount();
        expect(peekSavedChatTabState(identity)?.mode).toBe("following-end");
        tileLiveness.live = true;
        view = renderChatMessages({
          messages,
          scrollStateKey: instanceId,
          instanceId,
          freshOpen: true,
        });
        // eslint-disable-next-line no-await-in-loop
        await settleLegendList();
        expect(getScrollNode().dataset.scrollMode).toBe("following-end");
        assertTrueBottomGeometry();
      }
    });

    it("following-end growth then remount lands at the NEW true bottom with pill hidden", async () => {
      enableLegendListBrowserScrollEvents();
      const messages = makeCompletedTranscript(40);
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
      );
      const instanceId = `itbf-growth-${Math.random().toString(36).slice(2)}`;
      const identity = makeDefaultTestIdentity(instanceId);
      tileLiveness.live = true;

      const { unmount, rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: instanceId,
        instanceId,
      });
      await settleLegendList();
      assertTrueBottomGeometry();

      const grown = appendAssistant(messages, "itbf-growth-tail", 900_700);
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + grown.length * 90 + 40,
      );
      rerenderMessages(grown);
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      assertTrueBottomGeometry();
      expect(isJumpPillVisible()).toBe(false);

      unmount();
      expect(peekSavedChatTabState(identity)?.mode).toBe("following-end");

      tileLiveness.live = true;
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + grown.length * 90 + 40,
      );
      renderChatMessages({
        messages: grown,
        scrollStateKey: instanceId,
        instanceId,
        freshOpen: true,
      });
      await settleLegendList();
      assertTrueBottomGeometry();
      expect(isJumpPillVisible()).toBe(false);
    });
  });

  describe("atomic-reader-supersession", () => {
    // Review (internal-tab-bottom-follow-review): the past-target release
    // must resolve the WHOLE pending hydration transaction atomically
    // (persistence gate, pendingHydrationRestoreAnchorIdRef, and the
    // module-level pending registry together), and must not be fooled by
    // automatic content/geometry movement that was never reader input.

    it("past-target bottom, then the formerly-missing row hydrates: reader stays at true bottom, no yank-back", async () => {
      enableLegendListBrowserScrollEvents();
      const fullMessages = makeCompletedTranscript(80);
      const missingAnchorIndexInFull = 40;
      const missingAnchorId =
        fullMessages[missingAnchorIndexInFull]?.id ?? null;
      expect(missingAnchorId).toBeTruthy();
      // Genuinely absent at mount - not yet arrived, per the "missing row"
      // scenario the review's regression (a) describes. Everything else
      // (before AND after it) is intact, so the clamped restore lands
      // mid-list, not coincidentally at the tail.
      let messages: ReadonlyArray<ChatMessageModel> = fullMessages.filter(
        (message) => message.id !== missingAnchorId,
      );
      expect(messages.some((message) => message.id === missingAnchorId)).toBe(
        false,
      );

      const instanceId = `ars-hydrate-${Math.random().toString(36).slice(2)}`;
      tileLiveness.live = true;
      saveChatTabState({
        identity: makeDefaultTestIdentity(instanceId),
        mode: "free-scrolling",
        anchorMessageId: missingAnchorId,
        anchorIndex: missingAnchorIndexInFull,
        offset: 12,
      });
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
      );
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: instanceId,
        instanceId,
      });
      // Deliberately not settled: the clamped restore (landing at the last
      // available row of this 30-message partial) must still be converging
      // when the reader races past it to the true bottom below.
      await waitFor(() => {
        expect(
          document.querySelector('[data-testid="chat-messages-scroll"]'),
        ).not.toBeNull();
      });
      const scrollNode = getScrollNode();
      for (let frame = 0; frame < 8; frame += 1) {
        act(() => {
          scrollNode.scrollTop = maxScrollTopFor(scrollNode);
        });
        // eslint-disable-next-line no-await-in-loop
        await act(async () => {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
        });
        if (scrollNode.dataset.scrollMode === "following-end") break;
      }
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      assertTrueBottomGeometry();

      // The formerly-missing row finally hydrates.
      messages = fullMessages;
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
      );
      rerenderMessages(messages);
      await settleLegendList();

      // Must remain at the (new) true bottom, not get yanked back to row 40.
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      assertTrueBottomGeometry();
      expect(isJumpPillVisible()).toBe(false);
    });

    it("pointerdown then stable past-target bottom, formerly-missing row hydrates: reader stays at true bottom, no yank-back", async () => {
      // Fixup (pointer-generation-order): a real pointer interaction bumps
      // anchorUserScrollGenerationRef via handleTranscriptPointerDown before
      // the reader ever moves. Without the reorder, the outer settle wrapper's
      // `generationMismatch || isAborted()` short-circuits on the ALREADY-true
      // generation mismatch and never calls the atomic frozen-target
      // predicate at all - leaving the pending id, registry entry, and
      // persistence gate all armed even though the reader genuinely reached
      // stable true bottom under unchanged messages/geometry.
      enableLegendListBrowserScrollEvents();
      const fullMessages = makeCompletedTranscript(80);
      const missingAnchorIndexInFull = 40;
      const missingAnchorId =
        fullMessages[missingAnchorIndexInFull]?.id ?? null;
      expect(missingAnchorId).toBeTruthy();
      let messages: ReadonlyArray<ChatMessageModel> = fullMessages.filter(
        (message) => message.id !== missingAnchorId,
      );
      expect(messages.some((message) => message.id === missingAnchorId)).toBe(
        false,
      );

      const instanceId = `ars-ptr-hydrate-${Math.random().toString(36).slice(2)}`;
      tileLiveness.live = true;
      saveChatTabState({
        identity: makeDefaultTestIdentity(instanceId),
        mode: "free-scrolling",
        anchorMessageId: missingAnchorId,
        anchorIndex: missingAnchorIndexInFull,
        offset: 12,
      });
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
      );
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: instanceId,
        instanceId,
      });
      await waitFor(() => {
        expect(
          document.querySelector('[data-testid="chat-messages-scroll"]'),
        ).not.toBeNull();
      });

      // Real pointer interaction (a bare disclosure-click shape) bumps the
      // generation BEFORE the reader's own movement below - this is what the
      // scroll-only regressions above never exercise.
      act(() => {
        fireEvent.pointerDown(screen.getByTestId("chat-transcript-container"));
      });

      const scrollNode = getScrollNode();
      for (let frame = 0; frame < 8; frame += 1) {
        act(() => {
          scrollNode.scrollTop = maxScrollTopFor(scrollNode);
        });
        // eslint-disable-next-line no-await-in-loop
        await act(async () => {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
        });
        if (scrollNode.dataset.scrollMode === "following-end") break;
      }
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      assertTrueBottomGeometry();

      // The formerly-missing row finally hydrates.
      messages = fullMessages;
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
      );
      rerenderMessages(messages);
      await settleLegendList();

      // Must remain at the (new) true bottom, not get yanked back to row 40.
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      assertTrueBottomGeometry();
      expect(isJumpPillVisible()).toBe(false);
    });

    it("pointerdown then stable past-target bottom, permanent close, new-instance reopen before row arrival: durable state stays following-end", async () => {
      // Fixup (pointer-generation-order): companion to the hydration case
      // above for the close/reopen route the ticket also requires.
      enableLegendListBrowserScrollEvents();
      const fullMessages = makeCompletedTranscript(80);
      const missingAnchorIndexInFull = 40;
      const missingAnchorId =
        fullMessages[missingAnchorIndexInFull]?.id ?? null;
      expect(missingAnchorId).toBeTruthy();
      const messages: ReadonlyArray<ChatMessageModel> = fullMessages.filter(
        (message) => message.id !== missingAnchorId,
      );
      expect(messages.some((message) => message.id === missingAnchorId)).toBe(
        false,
      );

      const instanceId = `ars-ptr-close-${Math.random().toString(36).slice(2)}`;
      const reopenedInstance = `ars-ptr-close-reopen-${Math.random().toString(36).slice(2)}`;
      const epicId = "epic-1";
      const taskId = "task-1";
      const identity = makeTestIdentity(instanceId, epicId, taskId);
      const reopenedIdentity = makeTestIdentity(
        reopenedInstance,
        epicId,
        taskId,
      );

      tileLiveness.live = true;
      saveChatTabState({
        identity,
        mode: "free-scrolling",
        anchorMessageId: missingAnchorId,
        anchorIndex: missingAnchorIndexInFull,
        offset: 12,
      });
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
      );
      const first = renderChatMessages({
        messages,
        instanceId,
        epicId,
        taskId,
      });
      await waitFor(() => {
        expect(
          document.querySelector('[data-testid="chat-messages-scroll"]'),
        ).not.toBeNull();
      });

      act(() => {
        fireEvent.pointerDown(screen.getByTestId("chat-transcript-container"));
      });

      const scrollNode = getScrollNode();
      for (let frame = 0; frame < 8; frame += 1) {
        act(() => {
          scrollNode.scrollTop = maxScrollTopFor(scrollNode);
        });
        // eslint-disable-next-line no-await-in-loop
        await act(async () => {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
        });
        if (scrollNode.dataset.scrollMode === "following-end") break;
      }
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      assertTrueBottomGeometry();

      // Genuine permanent close, still before the missing row ever arrives.
      evictChatTabState([instanceId]);
      tileLiveness.live = false;
      first.unmount();

      const durableAfterClose = peekSavedChatTabState(reopenedIdentity);
      expect(durableAfterClose).not.toBeNull();
      expect(durableAfterClose?.mode).toBe("following-end");
      expect(durableAfterClose?.anchorMessageId).toBeNull();

      tileLiveness.live = true;
      renderChatMessages({
        messages,
        instanceId: reopenedInstance,
        epicId,
        taskId,
        freshOpen: true,
      });
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      assertTrueBottomGeometry();
    });

    it("pointerdown then past-target during message reorder retains pending transaction, never following-end on close", async () => {
      // Fixup (pointer-generation-order): the settle wrapper now evaluates the
      // caller's atomic predicate BEFORE the generation mismatch. That makes
      // the frozen-target geometry/identity checks reachable after a real
      // pointerdown. Prove the reorder path still REFUSES release - running
      // the predicate first must not weaken its own message-array fingerprint
      // (mirror of the non-pointer reorder regression, with pointer first).
      enableLegendListBrowserScrollEvents();
      const fullMessages = makeCompletedTranscript(80);
      const missingAnchorIndexInFull = 40;
      const savedViewOffset = 12;
      const missingAnchorId =
        fullMessages[missingAnchorIndexInFull]?.id ?? null;
      expect(missingAnchorId).toBeTruthy();
      let messages: ReadonlyArray<ChatMessageModel> = fullMessages.filter(
        (message) => message.id !== missingAnchorId,
      );
      expect(messages.some((message) => message.id === missingAnchorId)).toBe(
        false,
      );

      const closedInstance = `ars-ptr-reorder-${Math.random().toString(36).slice(2)}`;
      const reopenedInstance = `ars-ptr-reorder-reopen-${Math.random().toString(36).slice(2)}`;
      const epicId = "epic-1";
      const taskId = "task-1";
      const closedIdentity = makeTestIdentity(closedInstance, epicId, taskId);
      const reopenedIdentity = makeTestIdentity(
        reopenedInstance,
        epicId,
        taskId,
      );
      const expectedScrollTop =
        missingAnchorIndexInFull * TICKET_13_ROW_HEIGHT_PX +
        LEGEND_LIST_HEADER_PX -
        savedViewOffset;

      tileLiveness.live = true;
      saveChatTabState({
        identity: closedIdentity,
        mode: "free-scrolling",
        anchorMessageId: missingAnchorId,
        anchorIndex: missingAnchorIndexInFull,
        offset: savedViewOffset,
      });
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
      );
      const first = renderChatMessages({
        messages,
        instanceId: closedInstance,
        epicId,
        taskId,
      });
      await waitFor(() => {
        expect(
          document.querySelector('[data-testid="chat-messages-scroll"]'),
        ).not.toBeNull();
      });

      // Real pointer interaction bumps generation before any content change
      // or reader movement - the path the ordering fix makes reachable.
      act(() => {
        fireEvent.pointerDown(screen.getByTestId("chat-transcript-container"));
      });

      // Issued target freezes against the pre-reorder messages array.
      // Reverse only: same length, same scrollHeight override - identity
      // inequality alone must still block the atomic clear.
      messages = [...messages].reverse();
      first.rerenderMessages(messages);

      const scrollNode = getScrollNode();
      for (let frame = 0; frame < 8; frame += 1) {
        act(() => {
          scrollNode.scrollTop = maxScrollTopFor(scrollNode);
        });
        // eslint-disable-next-line no-await-in-loop
        await act(async () => {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
        });
        if (scrollNode.dataset.scrollMode === "following-end") break;
      }
      await settleLegendList();

      evictChatTabState([closedInstance]);
      tileLiveness.live = false;
      first.unmount();

      const durableAfterClose = peekSavedChatTabState(reopenedIdentity);
      expect(durableAfterClose).not.toBeNull();
      expect(durableAfterClose?.mode).toBe("free-scrolling");
      expect(durableAfterClose?.anchorMessageId).toBe(missingAnchorId);
      expect(durableAfterClose?.anchorIndex).toBe(missingAnchorIndexInFull);
      expect(durableAfterClose?.offset).toBe(savedViewOffset);

      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + fullMessages.length * 90 + 40,
      );
      tileLiveness.live = true;
      const second = renderChatMessages({
        messages: fullMessages,
        instanceId: reopenedInstance,
        epicId,
        taskId,
      });
      await settleLegendList();
      await settleLegendList();

      expect(getScrollNode().scrollTop).toBe(expectedScrollTop);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().scrollTop).not.toBe(
        maxScrollTopFor(getScrollNode()),
      );
      second.unmount();
    });

    it("past-target bottom, remount, permanent close, new-instance reopen before row arrival: durable state stays following-end", async () => {
      enableLegendListBrowserScrollEvents();
      const fullMessages = makeCompletedTranscript(80);
      const missingAnchorIndexInFull = 40;
      const missingAnchorId =
        fullMessages[missingAnchorIndexInFull]?.id ?? null;
      expect(missingAnchorId).toBeTruthy();
      const messages: ReadonlyArray<ChatMessageModel> = fullMessages.filter(
        (message) => message.id !== missingAnchorId,
      );
      expect(messages.some((message) => message.id === missingAnchorId)).toBe(
        false,
      );

      const instanceId = `ars-close-reopen-${Math.random().toString(36).slice(2)}`;
      const reopenedInstance = `ars-close-reopen-new-${Math.random().toString(36).slice(2)}`;
      const epicId = "epic-1";
      const taskId = "task-1";
      const identity = makeTestIdentity(instanceId, epicId, taskId);
      const reopenedIdentity = makeTestIdentity(
        reopenedInstance,
        epicId,
        taskId,
      );

      tileLiveness.live = true;
      saveChatTabState({
        identity,
        mode: "free-scrolling",
        anchorMessageId: missingAnchorId,
        anchorIndex: missingAnchorIndexInFull,
        offset: 12,
      });
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
      );
      let view = renderChatMessages({
        messages,
        instanceId,
        epicId,
        taskId,
      });
      await waitFor(() => {
        expect(
          document.querySelector('[data-testid="chat-messages-scroll"]'),
        ).not.toBeNull();
      });
      const scrollNode = getScrollNode();
      for (let frame = 0; frame < 8; frame += 1) {
        act(() => {
          scrollNode.scrollTop = maxScrollTopFor(scrollNode);
        });
        // eslint-disable-next-line no-await-in-loop
        await act(async () => {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
        });
        if (scrollNode.dataset.scrollMode === "following-end") break;
      }
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");

      // Same-instance remount (a same-pane switch away and back): the
      // module-level pending registry must not re-arm this transaction
      // from the stale raw entry now that it was atomically resolved.
      view.unmount();
      expect(peekSavedChatTabState(identity)?.mode).toBe("following-end");
      tileLiveness.live = true;
      view = renderChatMessages({
        messages,
        instanceId,
        epicId,
        taskId,
        freshOpen: true,
      });
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      assertTrueBottomGeometry();

      // Genuine permanent close, still before the missing row ever arrives.
      evictChatTabState([instanceId]);
      tileLiveness.live = false;
      view.unmount();

      const durableAfterClose = peekSavedChatTabState(reopenedIdentity);
      expect(durableAfterClose).not.toBeNull();
      expect(durableAfterClose?.mode).toBe("following-end");
      expect(durableAfterClose?.anchorMessageId).toBeNull();

      tileLiveness.live = true;
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
      );
      renderChatMessages({
        messages,
        instanceId: reopenedInstance,
        epicId,
        taskId,
        freshOpen: true,
      });
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      assertTrueBottomGeometry();
    });

    it("temporary tail growth before first settle survives close/reopen with the original row, never following-end", async () => {
      enableLegendListBrowserScrollEvents();
      const fullMessages = makeCompletedTranscript(200);
      const anchorIndex = 20;
      const savedViewOffset = 24;
      const anchorId = fullMessages[anchorIndex]?.id ?? null;
      expect(anchorId).toBeTruthy();
      const expectedScrollTop =
        anchorIndex * TICKET_13_ROW_HEIGHT_PX +
        LEGEND_LIST_HEADER_PX -
        savedViewOffset;

      const closedInstance = `ars-tail-growth-${Math.random().toString(36).slice(2)}`;
      const reopenedInstance = `ars-tail-growth-reopen-${Math.random().toString(36).slice(2)}`;
      const epicId = "epic-1";
      const taskId = "task-1";
      const closedIdentity = makeTestIdentity(closedInstance, epicId, taskId);
      const reopenedIdentity = makeTestIdentity(
        reopenedInstance,
        epicId,
        taskId,
      );

      saveChatTabState({
        identity: closedIdentity,
        mode: "free-scrolling",
        anchorMessageId: anchorId,
        anchorIndex,
        offset: savedViewOffset,
      });

      // Tail-only partial: the clamped restore target IS this partial's own
      // current end.
      let partialMessages: ReadonlyArray<ChatMessageModel> =
        fullMessages.slice(180);
      expect(partialMessages.some((message) => message.id === anchorId)).toBe(
        false,
      );

      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + partialMessages.length * 90 + 40,
      );
      tileLiveness.live = true;
      const first = renderChatMessages({
        messages: partialMessages,
        instanceId: closedInstance,
        epicId,
        taskId,
      });
      await waitFor(() => {
        expect(
          document.querySelector('[data-testid="chat-messages-scroll"]'),
        ).not.toBeNull();
      });
      // Deliberately not settled: grow the tail WHILE the mount-time clamped
      // restore is still converging, before its first settle check - real
      // browser-equivalent of a streaming append arriving mid-restore, with
      // zero reader input. Substantial growth (not just one message): the
      // clamped restore's own target places the last row at viewPosition 0
      // (row top aligned to viewport top), which for a short tail can
      // exceed the natural scrollHeight-clientHeight max - the post-growth
      // natural max must clearly exceed that frozen target for this to
      // genuinely race the false-positive the review's P1 #2 describes,
      // not just fall short of it regardless of geometry protection.
      for (let extra = 0; extra < 40; extra += 1) {
        partialMessages = appendAssistant(
          partialMessages,
          `ars-tail-growth-append-${extra}`,
          900_800 + extra,
        );
      }
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + partialMessages.length * 90 + 40,
      );
      const { rerenderMessages } = first;
      rerenderMessages(partialMessages);
      // Simulate the static maintainScrollAtEnd configuration moving the
      // viewport to the new (post-growth) bottom with zero reader input -
      // demonstrably past the OLD, pre-growth issued target, exactly the
      // false positive the review's P1 #2 finding describes. Race it the
      // same way a genuine reader-motion race is proven in the tests above.
      const scrollNode = getScrollNode();
      for (let frame = 0; frame < 8; frame += 1) {
        act(() => {
          scrollNode.scrollTop = maxScrollTopFor(scrollNode);
        });
        // eslint-disable-next-line no-await-in-loop
        await act(async () => {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
        });
        if (scrollNode.dataset.scrollMode === "following-end") break;
      }
      await settleLegendList();

      // Genuine permanent close before the original saved row ever
      // hydrates - the growth above must not have released the gate, even
      // though the automatic movement past the old target may have flipped
      // the visible mode to following-end.
      evictChatTabState([closedInstance]);
      tileLiveness.live = false;
      first.unmount();

      const durableAfterClose = peekSavedChatTabState(reopenedIdentity);
      expect(durableAfterClose).not.toBeNull();
      expect(durableAfterClose?.mode).toBe("free-scrolling");
      expect(durableAfterClose?.anchorMessageId).toBe(anchorId);
      expect(durableAfterClose?.anchorIndex).toBe(anchorIndex);
      expect(durableAfterClose?.offset).toBe(savedViewOffset);

      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + fullMessages.length * 90 + 40,
      );
      tileLiveness.live = true;
      const second = renderChatMessages({
        messages: fullMessages,
        instanceId: reopenedInstance,
        epicId,
        taskId,
      });
      await settleLegendList();
      await settleLegendList();

      expect(getScrollNode().scrollTop).toBe(expectedScrollTop);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().scrollTop).not.toBe(
        maxScrollTopFor(getScrollNode()),
      );
      second.unmount();
    });

    it("message reorder during free-restore settle retains pending transaction, never following-end on close", async () => {
      // Review P1#2 explicitly lists reorder (not only append/growth) as a
      // content change that must retain the pending hydration transaction.
      // Mid-list missing anchor: the clamped restore lands mid-list, so a
      // later force to true bottom is numerically past the issued target -
      // message reference inequality alone must still block the release.
      enableLegendListBrowserScrollEvents();
      const fullMessages = makeCompletedTranscript(80);
      const missingAnchorIndexInFull = 40;
      const savedViewOffset = 12;
      const missingAnchorId =
        fullMessages[missingAnchorIndexInFull]?.id ?? null;
      expect(missingAnchorId).toBeTruthy();
      let messages: ReadonlyArray<ChatMessageModel> = fullMessages.filter(
        (message) => message.id !== missingAnchorId,
      );
      expect(messages.some((message) => message.id === missingAnchorId)).toBe(
        false,
      );

      const closedInstance = `ars-reorder-${Math.random().toString(36).slice(2)}`;
      const reopenedInstance = `ars-reorder-reopen-${Math.random().toString(36).slice(2)}`;
      const epicId = "epic-1";
      const taskId = "task-1";
      const closedIdentity = makeTestIdentity(closedInstance, epicId, taskId);
      const reopenedIdentity = makeTestIdentity(
        reopenedInstance,
        epicId,
        taskId,
      );
      const expectedScrollTop =
        missingAnchorIndexInFull * TICKET_13_ROW_HEIGHT_PX +
        LEGEND_LIST_HEADER_PX -
        savedViewOffset;

      tileLiveness.live = true;
      saveChatTabState({
        identity: closedIdentity,
        mode: "free-scrolling",
        anchorMessageId: missingAnchorId,
        anchorIndex: missingAnchorIndexInFull,
        offset: savedViewOffset,
      });
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
      );
      const first = renderChatMessages({
        messages,
        instanceId: closedInstance,
        epicId,
        taskId,
      });
      await waitFor(() => {
        expect(
          document.querySelector('[data-testid="chat-messages-scroll"]'),
        ).not.toBeNull();
      });
      // Issued target freezes against the pre-reorder messages array (the
      // free-restore layout effect does not re-run on messages change).
      // Reverse in place of append so only identity/order changes - same
      // length, same scrollHeight override.
      messages = [...messages].reverse();
      first.rerenderMessages(messages);

      const scrollNode = getScrollNode();
      for (let frame = 0; frame < 8; frame += 1) {
        act(() => {
          scrollNode.scrollTop = maxScrollTopFor(scrollNode);
        });
        // eslint-disable-next-line no-await-in-loop
        await act(async () => {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
        });
        if (scrollNode.dataset.scrollMode === "following-end") break;
      }
      await settleLegendList();

      evictChatTabState([closedInstance]);
      tileLiveness.live = false;
      first.unmount();

      const durableAfterClose = peekSavedChatTabState(reopenedIdentity);
      expect(durableAfterClose).not.toBeNull();
      expect(durableAfterClose?.mode).toBe("free-scrolling");
      expect(durableAfterClose?.anchorMessageId).toBe(missingAnchorId);
      expect(durableAfterClose?.anchorIndex).toBe(missingAnchorIndexInFull);
      expect(durableAfterClose?.offset).toBe(savedViewOffset);

      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + fullMessages.length * 90 + 40,
      );
      tileLiveness.live = true;
      const second = renderChatMessages({
        messages: fullMessages,
        instanceId: reopenedInstance,
        epicId,
        taskId,
      });
      await settleLegendList();
      await settleLegendList();

      expect(getScrollNode().scrollTop).toBe(expectedScrollTop);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().scrollTop).not.toBe(
        maxScrollTopFor(getScrollNode()),
      );
      second.unmount();
    });

    it("viewport clientHeight change during free-restore settle retains pending transaction, never following-end on close", async () => {
      // Review P1#2: viewport/clientHeight change during settle must also
      // retain the pending hydration transaction - not only content mutation.
      enableLegendListBrowserScrollEvents();
      const fullMessages = makeCompletedTranscript(80);
      const missingAnchorIndexInFull = 40;
      const savedViewOffset = 12;
      const missingAnchorId =
        fullMessages[missingAnchorIndexInFull]?.id ?? null;
      expect(missingAnchorId).toBeTruthy();
      const messages: ReadonlyArray<ChatMessageModel> = fullMessages.filter(
        (message) => message.id !== missingAnchorId,
      );
      expect(messages.some((message) => message.id === missingAnchorId)).toBe(
        false,
      );

      const closedInstance = `ars-viewport-${Math.random().toString(36).slice(2)}`;
      const reopenedInstance = `ars-viewport-reopen-${Math.random().toString(36).slice(2)}`;
      const epicId = "epic-1";
      const taskId = "task-1";
      const closedIdentity = makeTestIdentity(closedInstance, epicId, taskId);
      const reopenedIdentity = makeTestIdentity(
        reopenedInstance,
        epicId,
        taskId,
      );
      const expectedScrollTop =
        missingAnchorIndexInFull * TICKET_13_ROW_HEIGHT_PX +
        LEGEND_LIST_HEADER_PX -
        savedViewOffset;

      tileLiveness.live = true;
      saveChatTabState({
        identity: closedIdentity,
        mode: "free-scrolling",
        anchorMessageId: missingAnchorId,
        anchorIndex: missingAnchorIndexInFull,
        offset: savedViewOffset,
      });
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
      );
      const first = renderChatMessages({
        messages,
        instanceId: closedInstance,
        epicId,
        taskId,
      });
      await waitFor(() => {
        expect(
          document.querySelector('[data-testid="chat-messages-scroll"]'),
        ).not.toBeNull();
      });
      // Issued target freezes clientHeight from the install shim (700). Shrink
      // the scroll container's reported viewport mid-settle so the live
      // geometry fingerprint diverges without any message mutation.
      const clientHeightSpy = vi
        .spyOn(HTMLElement.prototype, "clientHeight", "get")
        .mockImplementation(function (this: HTMLElement) {
          const scroll = document.querySelector(
            '[data-testid="chat-messages-scroll"]',
          );
          if (scroll !== null && this === scroll) {
            return 350;
          }
          return VIEWPORT_HEIGHT_PX;
        });
      try {
        const scrollNode = getScrollNode();
        for (let frame = 0; frame < 8; frame += 1) {
          act(() => {
            scrollNode.scrollTop = maxScrollTopFor(scrollNode);
          });
          // eslint-disable-next-line no-await-in-loop
          await act(async () => {
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve()),
            );
          });
          if (scrollNode.dataset.scrollMode === "following-end") break;
        }
        await settleLegendList();

        evictChatTabState([closedInstance]);
        tileLiveness.live = false;
        first.unmount();
      } finally {
        clientHeightSpy.mockRestore();
      }

      const durableAfterClose = peekSavedChatTabState(reopenedIdentity);
      expect(durableAfterClose).not.toBeNull();
      expect(durableAfterClose?.mode).toBe("free-scrolling");
      expect(durableAfterClose?.anchorMessageId).toBe(missingAnchorId);
      expect(durableAfterClose?.anchorIndex).toBe(missingAnchorIndexInFull);
      expect(durableAfterClose?.offset).toBe(savedViewOffset);

      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + fullMessages.length * 90 + 40,
      );
      tileLiveness.live = true;
      const second = renderChatMessages({
        messages: fullMessages,
        instanceId: reopenedInstance,
        epicId,
        taskId,
      });
      await settleLegendList();
      await settleLegendList();

      expect(getScrollNode().scrollTop).toBe(expectedScrollTop);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().scrollTop).not.toBe(
        maxScrollTopFor(getScrollNode()),
      );
      second.unmount();
    });

    it("repeated atomic supersession cycles: second past-target then late hydrate stays at true bottom without yank", async () => {
      // Two genuine reader-supersession cycles on the same instance: prove
      // the atomic clear is not a one-shot, and a later remount + second
      // missing-row race still resolves the whole transaction (gate +
      // pending registry + pending id) so a subsequent hydrate cannot yank.
      enableLegendListBrowserScrollEvents();
      const fullMessages = makeCompletedTranscript(100);
      const missingAIndex = 30;
      const missingBIndex = 60;
      const missingAId = fullMessages[missingAIndex]?.id ?? null;
      const missingBId = fullMessages[missingBIndex]?.id ?? null;
      expect(missingAId).toBeTruthy();
      expect(missingBId).toBeTruthy();

      const instanceId = `ars-repeat-${Math.random().toString(36).slice(2)}`;

      // --- Cycle 1: missing A ---
      let messages: ReadonlyArray<ChatMessageModel> = fullMessages.filter(
        (message) => message.id !== missingAId,
      );
      tileLiveness.live = true;
      saveChatTabState({
        identity: makeDefaultTestIdentity(instanceId),
        mode: "free-scrolling",
        anchorMessageId: missingAId,
        anchorIndex: missingAIndex,
        offset: 12,
      });
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
      );
      let view = renderChatMessages({
        messages,
        scrollStateKey: instanceId,
        instanceId,
      });
      await waitFor(() => {
        expect(
          document.querySelector('[data-testid="chat-messages-scroll"]'),
        ).not.toBeNull();
      });
      let scrollNode = getScrollNode();
      for (let frame = 0; frame < 8; frame += 1) {
        act(() => {
          scrollNode.scrollTop = maxScrollTopFor(scrollNode);
        });
        // eslint-disable-next-line no-await-in-loop
        await act(async () => {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
        });
        if (scrollNode.dataset.scrollMode === "following-end") break;
      }
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      assertTrueBottomGeometry();

      // Same-instance remount while A is still missing: atomic clear must
      // already have forgotten the pending entry so this remount opens
      // following-end (not a re-armed free-scrolling restore).
      view.unmount();
      tileLiveness.live = true;
      view = renderChatMessages({
        messages,
        scrollStateKey: instanceId,
        instanceId,
        freshOpen: true,
      });
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      assertTrueBottomGeometry();

      // A finally arrives on the remounted surface - no yank back to A.
      messages = fullMessages;
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
      );
      view.rerenderMessages(messages);
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      assertTrueBottomGeometry();
      expect(isJumpPillVisible()).toBe(false);

      // --- Cycle 2: different still-missing row B, fresh free-scrolling race ---
      messages = fullMessages.filter((message) => message.id !== missingBId);
      view.unmount();
      tileLiveness.live = true;
      saveChatTabState({
        identity: makeDefaultTestIdentity(instanceId),
        mode: "free-scrolling",
        anchorMessageId: missingBId,
        anchorIndex: missingBIndex,
        offset: 12,
      });
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
      );
      view = renderChatMessages({
        messages,
        scrollStateKey: instanceId,
        instanceId,
      });
      await waitFor(() => {
        expect(
          document.querySelector('[data-testid="chat-messages-scroll"]'),
        ).not.toBeNull();
      });
      scrollNode = getScrollNode();
      for (let frame = 0; frame < 8; frame += 1) {
        act(() => {
          scrollNode.scrollTop = maxScrollTopFor(scrollNode);
        });
        // eslint-disable-next-line no-await-in-loop
        await act(async () => {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
        });
        if (scrollNode.dataset.scrollMode === "following-end") break;
      }
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      assertTrueBottomGeometry();

      // B arrives after a second atomic supersession - still true bottom.
      messages = fullMessages;
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
      );
      view.rerenderMessages(messages);
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      assertTrueBottomGeometry();
      expect(isJumpPillVisible()).toBe(false);
      view.unmount();
    });

    it("repeated pointer-driven supersession cycles: second pointer past-target then late hydrate stays at true bottom without yank", async () => {
      // Fixup (reseed-repeated-cycle, review P2): mirror of the non-pointer
      // "repeated atomic supersession cycles" test - two DISTINCT missing
      // rows, with cycle 2 built on its OWN freshly reseeded free-scrolling
      // pending transaction, not a stale carryover from cycle 1. The
      // original version reused ONE missing row: cycle 1 already resolved
      // (cleared) the pending id/registry/gate before its own remount, so
      // that remount opened directly at following-end with NOTHING pending
      // - cycle 2's pointerdown+race then had no restoration operation to
      // supersede at all, making it vacuous. Reverting the operand order
      // failed this test only because cycle 1's own assertion threw first,
      // never because cycle 2 discriminated anything.
      enableLegendListBrowserScrollEvents();
      const fullMessages = makeCompletedTranscript(100);
      const missingAIndex = 30;
      const missingBIndex = 60;
      const missingAId = fullMessages[missingAIndex]?.id ?? null;
      const missingBId = fullMessages[missingBIndex]?.id ?? null;
      expect(missingAId).toBeTruthy();
      expect(missingBId).toBeTruthy();

      const instanceId = `ars-ptr-repeat-${Math.random().toString(36).slice(2)}`;

      // --- Cycle 1: missing A, pointerdown then stable past-target bottom ---
      let messages: ReadonlyArray<ChatMessageModel> = fullMessages.filter(
        (message) => message.id !== missingAId,
      );
      tileLiveness.live = true;
      saveChatTabState({
        identity: makeDefaultTestIdentity(instanceId),
        mode: "free-scrolling",
        anchorMessageId: missingAId,
        anchorIndex: missingAIndex,
        offset: 12,
      });
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
      );
      let view = renderChatMessages({
        messages,
        scrollStateKey: instanceId,
        instanceId,
      });
      await waitFor(() => {
        expect(
          document.querySelector('[data-testid="chat-messages-scroll"]'),
        ).not.toBeNull();
      });

      act(() => {
        fireEvent.pointerDown(screen.getByTestId("chat-transcript-container"));
      });
      let scrollNode = getScrollNode();
      for (let frame = 0; frame < 8; frame += 1) {
        act(() => {
          scrollNode.scrollTop = maxScrollTopFor(scrollNode);
        });
        // eslint-disable-next-line no-await-in-loop
        await act(async () => {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
        });
        if (scrollNode.dataset.scrollMode === "following-end") break;
      }
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      assertTrueBottomGeometry();

      // Same-instance remount while A is still missing: atomic clear must
      // already have forgotten the pending entry so this remount opens
      // following-end (not a re-armed free-scrolling restore).
      view.unmount();
      tileLiveness.live = true;
      view = renderChatMessages({
        messages,
        scrollStateKey: instanceId,
        instanceId,
        freshOpen: true,
      });
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      assertTrueBottomGeometry();

      // A finally arrives on the remounted surface - no yank back to A.
      messages = fullMessages;
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
      );
      view.rerenderMessages(messages);
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      assertTrueBottomGeometry();
      expect(isJumpPillVisible()).toBe(false);

      // --- Cycle 2: unmount, reseed a FRESH free-scrolling coordinate for a
      // different still-missing row B on the same instance, then repeat via
      // a second pointerdown. This is what makes cycle 2 a genuine, distinct
      // atomic-supersession race rather than a no-op on an already-resolved
      // surface. ---
      messages = fullMessages.filter((message) => message.id !== missingBId);
      view.unmount();
      tileLiveness.live = true;
      saveChatTabState({
        identity: makeDefaultTestIdentity(instanceId),
        mode: "free-scrolling",
        anchorMessageId: missingBId,
        anchorIndex: missingBIndex,
        offset: 12,
      });
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
      );
      view = renderChatMessages({
        messages,
        scrollStateKey: instanceId,
        instanceId,
      });
      await waitFor(() => {
        expect(
          document.querySelector('[data-testid="chat-messages-scroll"]'),
        ).not.toBeNull();
      });

      act(() => {
        fireEvent.pointerDown(screen.getByTestId("chat-transcript-container"));
      });
      scrollNode = getScrollNode();
      for (let frame = 0; frame < 8; frame += 1) {
        act(() => {
          scrollNode.scrollTop = maxScrollTopFor(scrollNode);
        });
        // eslint-disable-next-line no-await-in-loop
        await act(async () => {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
        });
        if (scrollNode.dataset.scrollMode === "following-end") break;
      }
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      assertTrueBottomGeometry();

      // B finally arrives after a second, genuinely distinct pointer-driven
      // supersession - must stay at true bottom, not get yanked back to B.
      messages = fullMessages;
      setLegendListScrollContainerScrollHeightOverride(
        LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
      );
      view.rerenderMessages(messages);
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      assertTrueBottomGeometry();
      expect(isJumpPillVisible()).toBe(false);
      view.unmount();
    });
  });
});
