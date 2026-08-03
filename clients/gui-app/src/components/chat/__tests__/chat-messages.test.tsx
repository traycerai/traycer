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
  CHAT_TIMELINE_ANCHOR_SCROLL_PROMISE_TIMEOUT_MS,
  ChatMessages,
  type ChatMessageScrollRequest,
} from "@/components/chat/chat-messages";
import {
  acceptExhaustedPersistedRestoreFallback,
  anchorMoverShouldYieldToReader,
  CHAT_ARROW_SCROLL_STEP_PX,
  CHAT_TIMELINE_NAVIGATION_VIEW_OFFSET_PX,
  chatScrollCaptureLibraryOwnedTop,
  chatTimelineGetItemType,
  scrollOnlyMovementCarriesReaderIntent,
  type ChatAnchorDriftRepairOutcome,
} from "@/components/chat/chat-messages-scroll-helpers";
import {
  captureChatFreeScrollingOffset,
  CHAT_LIST_ANCHOR_OFFSET,
} from "@/components/chat/chat-scroll-anchoring";
import { appLogger } from "@/lib/logger";
import { preserveChatScrollAcrossDisclosureChange } from "@/components/chat/chat-scroll-disclosure";
import {
  evictChatTabState,
  evictChatTabStateForChat,
  hasSavedChatTabState,
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
import { useSettingsStore } from "@/stores/settings/settings-store";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type { SetupCardViewModel } from "@/components/chat/segments/setup-card-segment";
import type { BackgroundItem } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  makeAssistantMessage,
  makeMessage,
  makeMessageAt,
} from "./chat-message-fixtures";
import {
  installLegendListViewportMetrics,
  setLegendListMessageRowHeightOverrides,
  setLegendListScrollContainerScrollHeightOverride,
  settleLegendList,
} from "./legend-list-test-environment";

const VIEWPORT_HEIGHT_PX = 700;
const VIEWPORT_WIDTH_PX = 800;
const PILL_SHOW_DEBOUNCE_MS = 150;
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
    return (
      <div data-testid={`mock-message-${props.message.id}`}>
        {props.message.role}:{props.message.id}
        {props.message.content}
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
    const { ref, ...rest } = props;
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
    return <actual.LegendList {...rest} ref={teeRef} />;
  };
  return { ...actual, LegendList: TeedLegendList };
});

// Ticket 22 (review round 1, finding 4): a thin, behavior-preserving
// pass-through around the REAL `applyChatAnchorDriftRepair` - re-exports
// everything else unchanged, wraps only this one function to tee its call
// count into a module-scope counter. Zero production delta; the wrapped
// function still does exactly what the real one does, including its return
// value. This exists because "one `scrollToOffset` call" is not the same
// invariant as "one scheduled repair pass" - a missing coalescing guard lets
// several independent two-rAF chains run, but only the FIRST observes
// non-zero drift and writes, so a write-count oracle alone survives the
// guard's removal (review round 1, finding 4). Counting actual invocations
// of the shared repair function is deterministic (no rAF-timing noise,
// unlike spying on `window.requestAnimationFrame`, which also picks up
// LegendList's own unrelated internal rAF usage).
const applyChatAnchorDriftRepairCallCountRef = vi.hoisted(() => ({
  current: 0,
}));

vi.mock(
  "@/components/chat/chat-messages-scroll-helpers",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/chat/chat-messages-scroll-helpers")
      >();
    return {
      ...actual,
      applyChatAnchorDriftRepair: (
        ...args: Parameters<typeof actual.applyChatAnchorDriftRepair>
      ): ChatAnchorDriftRepairOutcome["kind"] => {
        applyChatAnchorDriftRepairCallCountRef.current += 1;
        return actual.applyChatAnchorDriftRepair(...args);
      },
    };
  },
);

// Ticket 17 (review round 3, finding 2 residual): LegendList's per-element
// size/layout notifications (row remeasure AND scroll-container resize) both
// route through ONE module-cached `ResizeObserver` singleton
// (`getGlobalResizeObserver()` in the installed 3.2.0 bundle), lazily
// constructed on the FIRST element it ever observes - a swap done from
// inside a single `it()` is too late, since some earlier test in this file
// has already triggered that construction using the real, globally no-op
// `MockResizeObserver` (`test-browser-apis.ts`). Installing a controllable
// class at MODULE-LOAD time (before any test's `beforeEach`/render ever
// runs) is early enough: the singleton is constructed lazily, on this
// file's FIRST LegendList mount, which happens after this module finishes
// evaluating. Mirrors `chat-turn-minimap.test.tsx`'s own
// `installControllableResizeObserver` shape - `observe`/`unobserve` are
// no-ops (LegendList keeps its OWN per-element dispatch table internally,
// keyed by the same `element` object passed to `observe`, so a genuinely
// no-op stub here does not break that routing), so every one of this
// file's other 200+ tests keeps seeing exactly the same non-firing
// behavior it always has. Only `triggerLegendListResizeObserverEntry`
// (called explicitly, by name, from one test) ever invokes the callback.
// NOTE: `ChatMessages` mounts MULTIPLE independent `new ResizeObserver(...)`
// consumers under one render (LegendList's own shared per-item/per-container
// singleton, `ChatTurnMinimap`'s own instance, per-row `chat-message-user-body`
// instances) - capturing only the LAST-constructed callback (mirroring
// `chat-turn-minimap.test.tsx`'s single-consumer pattern) silently captured
// the WRONG one here. Track every constructed callback and invoke all of
// them on trigger - non-LegendList consumers ignore an entry for an element
// they never observed (their own `entries` argument is unused - verified
// against `chat-turn-minimap.test.tsx`'s own trigger, which already calls
// its captured callback with an EMPTY entries array and still works, i.e.
// that callback re-measures its own DOM directly rather than reading
// `entries`), so invoking everyone is harmless.
const capturedResizeObserverCallbacks: Array<ResizeObserverCallback> = [];

class ControllableGlobalResizeObserver implements ResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    capturedResizeObserverCallbacks.push(callback);
  }

  observe(): void {}

  unobserve(): void {}

  disconnect(): void {}
}

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  writable: true,
  value: ControllableGlobalResizeObserver,
});

function triggerLegendListResizeObserverEntry(
  target: Element,
  contentRect: { readonly width: number; readonly height: number },
): void {
  if (capturedResizeObserverCallbacks.length === 0) {
    throw new Error(
      "No ResizeObserver has been constructed yet - no element has been observed",
    );
  }
  const entry: ResizeObserverEntry = {
    target,
    contentRect: {
      ...contentRect,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: contentRect.width,
      bottom: contentRect.height,
      toJSON: () => ({}),
    },
    borderBoxSize: [],
    contentBoxSize: [],
    devicePixelContentBoxSize: [],
  };
  const dummyObserverArg: ResizeObserver = {
    observe: () => undefined,
    unobserve: () => undefined,
    disconnect: () => undefined,
  };
  for (const callback of capturedResizeObserverCallbacks) {
    callback([entry], dummyObserverArg);
  }
}

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

/**
 * Queued auto-flush / A2A host row: arrives with persistentMessageId already
 * set to its own id (decision #9 gated path).
 */
function appendPersistentUserRow(
  messages: ReadonlyArray<ChatMessageModel>,
  id: string,
  createdAt: number,
): ReadonlyArray<ChatMessageModel> {
  return [
    ...messages,
    {
      ...makeMessageAt(0, "user", createdAt),
      id,
      content: "queued flush / a2a",
      persistentMessageId: id,
    },
  ];
}

const TICKET_13_SETUP_MODEL: SetupCardViewModel = {
  aggregate: {
    epicId: "epic-1",
    ownerId: "owner-1",
    ownerKind: "chat",
    state: "setting-up",
  },
  workspaces: [
    {
      workspacePath: "/repo",
      label: "repo",
      state: "setting-up",
      setupExitCode: null,
      terminalSessionId: "term-1",
      worktreePath: "/worktrees/repo/feature",
      branch: "feature",
      errorMessage: null,
      retryFolderIntent: null,
    },
  ],
  createdAt: 0,
  isActive: true,
};

/** Ticket 13 (decision #28): a synthesized setup-card system row, matching
 *  `rendered-messages.ts`'s `buildSetupCardMessage` shape (single-segment
 *  `role: "system"` row, `kind: "setup-card"`). `anchorMessageId` is the id
 *  this card GENUINELY owns (`SetupCardRow.triggeringMessageId` match) -
 *  the resolver now verifies this identity, not just array adjacency
 *  (reviewer-caught bug: a floating card can otherwise land directly above
 *  an unrelated row by `createdAt` coincidence). */
function setupCardRow(
  id: string,
  createdAt: number,
  anchorMessageId: string | null,
): ChatMessageModel {
  return {
    ...makeMessageAt(0, "system", createdAt),
    id,
    segments: [
      {
        id: `${id}:card`,
        kind: "setup-card",
        model: TICKET_13_SETUP_MODEL,
        viewTabId: "tab-1",
        anchorMessageId,
        isGenesisPin: false,
      },
    ],
  };
}

/** Ticket 13 (decision #27): a synthesized fork-marker system row, matching
 *  `rendered-messages.ts`'s `buildForkedChatLinkMessage` shape. */
function forkMarkerRow(id: string, createdAt: number): ChatMessageModel {
  return {
    ...makeMessageAt(0, "system", createdAt),
    id,
    segments: [
      {
        id: `${id}:link`,
        kind: "forked-chat-link",
        viewTabId: "tab-1",
        sourceChatId: "source-chat-1",
        sourceChatTitle: "Original chat",
        sourceHostId: "source-host-1",
      },
    ],
  };
}

/** Uniform row height under `legend-list-test-environment` (ITEM_HEIGHT_PX). */
const TICKET_13_ROW_HEIGHT_PX = 90;

/** Many trailing assistant rows so the anchored turn overflows the usable viewport. */
function appendStreamingAssistantChunks(
  messages: ReadonlyArray<ChatMessageModel>,
  count: number,
  baseCreatedAt: number,
): ReadonlyArray<ChatMessageModel> {
  const chunks = Array.from({ length: count }, (_unused, index) => ({
    ...makeMessageAt(0, "assistant", baseCreatedAt + index + 1),
    id: `stream-chunk-${index}`,
    content: `streamed chunk ${index}`,
    completedAt: null as number | null,
    runState: "running" as const,
  }));
  return [...messages, ...chunks];
}

/**
 * Appends exactly ONE new trailing assistant row with a globally-unique id
 * (`chunkIndex`, not scoped to `messages.length` like
 * `appendStreamingAssistantChunks`) - lets a test drive per-chunk growth
 * through several SEPARATE `rerenderMessages` calls (mirroring real token-
 * by-token streaming, where the reveal-pass effect fires once per delta)
 * instead of one batched jump, which a single effect run cannot expose an
 * indefinite-chase regression through.
 */
function appendOneStreamingChunk(
  messages: ReadonlyArray<ChatMessageModel>,
  chunkIndex: number,
  createdAt: number,
): ReadonlyArray<ChatMessageModel> {
  return [
    ...messages,
    {
      ...makeMessageAt(0, "assistant", createdAt),
      id: `incremental-chunk-${chunkIndex}`,
      content: `streamed chunk ${chunkIndex}`,
      completedAt: null,
      runState: "running" as const,
    },
  ];
}

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
 * Anchor engine settle: LegendList frames + the anchor engine's own
 * (review-fix-widened) `CHAT_TIMELINE_ANCHOR_SCROLL_PROMISE_TIMEOUT_MS`
 * watchdog - deliberately longer than the plain-nav `CHAT_ANCHOR_SETTLE_
 * FALLBACK_MS` (750ms) other settle paths use, since it must clear
 * LegendList's own 1500ms animated-scroll ownership ceiling with margin
 * (see that constant's own doc comment) - plus slack for the settle
 * callback's own scheduling.
 */
async function waitForAnchorEngineSettle(): Promise<void> {
  await settleLegendList();
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, CHAT_TIMELINE_ANCHOR_SCROLL_PROMISE_TIMEOUT_MS + 150);
    });
  });
}

/**
 * Plain-navigation settle (`scrollToEnd`/`navigateToMessage`, ticket 10):
 * these paths still use the DOM-`scrollend`-based `awaitScrollSettle` and
 * the shorter `CHAT_ANCHOR_SETTLE_FALLBACK_MS` - NOT the anchor engine's own
 * (review-fix-widened) `CHAT_TIMELINE_ANCHOR_SCROLL_PROMISE_TIMEOUT_MS`.
 * Waiting the anchor engine's much longer window here observably regresses
 * this suite (LegendList's own readiness/settle polling reacts differently
 * to how long a real idle gap it observes) - matching each wait to the
 * mechanism it is actually waiting on avoids that, and is also just more
 * correct: this file's `waitForAnchorEngineSettle` name is anchor-specific
 * for a reason.
 */
async function waitForNavigationSettle(): Promise<void> {
  await settleLegendList();
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, CHAT_ANCHOR_SETTLE_FALLBACK_MS + 150);
    });
  });
}

function getScrollToEndPill(): HTMLButtonElement {
  const pill = document.querySelector('button[aria-label="Scroll to end"]');
  if (!(pill instanceof HTMLButtonElement)) {
    throw new Error("Scroll-to-end pill button was not rendered");
  }
  return pill;
}

function pillVisibleLabel(): string {
  const pill = getScrollToEndPill();
  return pill.textContent;
}

function isJumpPillVisible(): boolean {
  const pill = getScrollToEndPill();
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

/**
 * Ticket 19: repositions the scroll node through the REAL LegendList
 * imperative API (`scrollToOffset`, non-animated) instead of a bare
 * `scrollTop` write. The installed library pre-writes its own internal
 * `getState().scroll` synchronously, before this jsdom harness's `scrollTo`
 * shim ever touches the DOM `scrollTop` (verified against installed
 * `@legendapp/list@3.2.0`: `react.mjs:2104-2110`) - so the capture-
 * provenance classifier (chat-messages-scroll-helpers.ts) correctly reads
 * this as a library-owned correction and stays silent, unlike
 * `fireScrollTopAndFlush`/`fireScrollOnlyTo`, which (correctly, post-
 * ticket-19) now cancels an owned anchoring-new-turn session on first use.
 *
 * Use this whenever a test needs to move the scroll node while remaining
 * inside whatever mode/generation currently owns it - the same shape
 * production code itself produces via the reveal pass / geometry repair -
 * NOT to simulate a reader gesture (that is exactly what
 * `fireScrollTopAndFlush` is for, and what should now correctly cancel).
 */
async function fireLibraryOwnedScrollTo(offset: number): Promise<void> {
  const list = legendListRefHolder.current;
  if (!list) throw new Error("expected LegendListRef to be attached");
  const scrollNode = getScrollNode();
  await act(async () => {
    void list.scrollToOffset({ offset, animated: false });
    fireEvent.scroll(scrollNode);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
}

/**
 * Ticket 19 silence pins: the jsdom harness's `scrollTop` setter and
 * `scrollTo` shim never `dispatchEvent` (legend-list-test-environment.ts),
 * so production's capture-phase classifier never runs unless a test fires
 * `scroll` explicitly. Call this after a library-owned write
 * (`scrollToOffset`/`scrollToIndex`/MVCP/`setItemSize` correction) so the
 * classifier actually observes the post-write DOM - same shape the hard-
 * gate pins and `fireLibraryOwnedScrollTo` use. Without it, a "silence"
 * pin can stay green under a maximally-broken classifier that always
 * cancels while owned.
 */
async function fireCaptureScrollAfterLibraryWrite(): Promise<void> {
  const scrollNode = getScrollNode();
  await act(async () => {
    fireEvent.scroll(scrollNode);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
}

/**
 * Ticket 19: wrap LegendList imperative scroll APIs so every call also
 * delivers a capture-phase `scroll` event (the harness never auto-fires
 * one). Used for anchor-engine issue/reissue paths that call
 * `scrollToIndex` from rAF inside production - without the wrap those
 * writes are invisible to `chatAnchorScrollCaptureShouldCancel`.
 * Fires scroll synchronously after the real method returns so the
 * capture listener runs while `activeAnchorImperativeMotionGenerationRef`
 * is still armed (guard 2) for in-flight anchor issues.
 */
function installLibraryScrollCaptureDispatch(): {
  dispose: () => void;
  scrollToIndexCallCount: () => number;
  scrollToOffsetCallCount: () => number;
} {
  const list = legendListRefHolder.current;
  if (!list) throw new Error("expected LegendListRef to be attached");
  let scrollToIndexCalls = 0;
  let scrollToOffsetCalls = 0;
  const originalScrollToIndex = list.scrollToIndex.bind(list);
  const originalScrollToOffset = list.scrollToOffset.bind(list);
  const indexSpy = vi
    .spyOn(list, "scrollToIndex")
    .mockImplementation((opts) => {
      scrollToIndexCalls += 1;
      const result = originalScrollToIndex(opts);
      fireEvent.scroll(getScrollNode());
      return result;
    });
  const offsetSpy = vi
    .spyOn(list, "scrollToOffset")
    .mockImplementation((opts) => {
      scrollToOffsetCalls += 1;
      const result = originalScrollToOffset(opts);
      fireEvent.scroll(getScrollNode());
      return result;
    });
  return {
    dispose: () => {
      indexSpy.mockRestore();
      offsetSpy.mockRestore();
    },
    scrollToIndexCallCount: () => scrollToIndexCalls,
    scrollToOffsetCallCount: () => scrollToOffsetCalls,
  };
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
 * Enter free-scrolling and leave the end so the Jump-to-latest pill can show
 * after the 150ms debounce. Wheel cancels the generation token; scrollTop=0
 * drives LegendList's isAtEnd=false into onIsAtEndChange.
 */
function enterFreeScrollingAwayFromEnd(): void {
  const scrollNode = getScrollNode();
  fireEvent.wheel(scrollNode, { deltaY: -80 });
  fireScrollAwayFromEnd();
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
  readonly isChatStreaming?: boolean;
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
   * Opts into decision #15's fresh-open policy (anchor the last user message
   * near the top) by leaving the scroll-state cache empty for this key. Most
   * tests here exercise following/free-scrolling/edge-mutation behavior, not
   * fresh-open itself, so `renderChatMessages` seeds a bottom-following saved
   * state by default (unless the caller already seeded one, e.g. the
   * restored-free-scrolling test) - matching what a returning tab's cache
   * would already hold.
   */
  readonly freshOpen?: boolean;
  /**
   * Seeds the store-side local-provenance registry (`chat-session-store.ts`)
   * this harness fakes - message ids the "client" minted and dispatched
   * (composer send / steer / inline edit), the anchor classifier's ground
   * truth for unconditional vs decision-#9-gated anchoring. Empty by
   * default (models a row arriving from elsewhere - queued flush, A2A, or
   * another window's edit).
   */
  readonly localProvenanceMessageIds?: ReadonlySet<string>;
}

interface ChatMessagesRenderState {
  messages: ReadonlyArray<ChatMessageModel>;
  systemOverlayActive: boolean;
  scrollRequest: ChatMessageScrollRequest | null;
  backgroundItems: ReadonlyArray<BackgroundItem> | undefined;
  visible: boolean;
  tileActive: boolean;
  composerOverlayHeight: number;
  localProvenanceMessageIds: ReadonlySet<string>;
  isChatStreaming: boolean;
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

  if (options.freshOpen !== true && !hasSavedChatTabState(identity)) {
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
    systemOverlayActive: options.systemOverlayActive ?? false,
    scrollRequest: options.scrollRequest ?? null,
    backgroundItems: options.backgroundItems,
    visible: options.visible ?? true,
    tileActive: options.tileActive ?? true,
    composerOverlayHeight:
      options.composerOverlayHeight ?? DEFAULT_COMPOSER_OVERLAY_HEIGHT_PX,
    localProvenanceMessageIds: options.localProvenanceMessageIds ?? new Set(),
    isChatStreaming: options.isChatStreaming ?? false,
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
          taskTitle={options.taskTitle ?? "Test chat"}
          taskId={taskId}
          epicId={epicId}
          messages={state.messages}
          localProvenanceMessageIds={state.localProvenanceMessageIds}
          consumeLocalProvenance={(messageId) => {
            if (!state.localProvenanceMessageIds.has(messageId)) return;
            const next = new Set(state.localProvenanceMessageIds);
            next.delete(messageId);
            state.localProvenanceMessageIds = next;
            result.rerender(jsx());
          }}
          backgroundItems={state.backgroundItems}
          getMessageActions={() => null}
          nextStepActions={null}
          instanceId={instanceId}
          visible={state.visible}
          systemOverlayActive={state.systemOverlayActive}
          isChatStreaming={state.isChatStreaming}
          scrollRequest={state.scrollRequest}
          composerOverlayHeight={state.composerOverlayHeight}
        />
      </div>
      {options.withSiblingChrome === true ? siblingChrome() : null}
    </div>
  );
  const jsx = (): ReactNode =>
    options.strictMode === true ? (
      <StrictMode>{content()}</StrictMode>
    ) : (
      content()
    );

  const result = render(jsx());
  return {
    ...result,
    scrollStateKey,
    instanceId,
    identity,
    epicId,
    taskId,
    /** Ticket 13: read the harness-local provenance set so pins can assert
     *  `consumeLocalProvenance` was invoked with the raw send id (not a
     *  setup-card substitute). */
    getLocalProvenanceMessageIds: (): ReadonlySet<string> =>
      state.localProvenanceMessageIds,
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
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, PILL_SHOW_DEBOUNCE_MS + 40);
    });
  });
  await waitFor(() => {
    expect(isJumpPillVisible()).toBe(true);
  });
}

describe("ChatMessages scroll policy", () => {
  beforeEach(() => {
    activityGroupOpenIds.lastOpenIds = new Set();
    activityGroupOpenIds.setOpenCalls = [];
    platformMock.isMac = true;
    tileLiveness.live = false;
    installLegendListViewportMetrics();
    vi.useRealTimers();
    useSettingsStore.setState({ chatTurnMinimapSide: "right" });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    // Do not restoreAllMocks - it clears module mocks for isMac / activity store.
    platformMock.isMac = true;
    tileLiveness.live = false;
    setLegendListScrollContainerScrollHeightOverride(null);
    useSettingsStore.setState({ chatTurnMinimapSide: "right" });
    // Ticket 15: dual-key durable entries survive tab-key cleanup - clear the
    // harness default epic so later tests' freshOpen paths see a true empty
    // chat-key cache rather than a leftover following-end/free-scrolling seed.
    evictChatTabPersistenceForEpic("epic-1");
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

  describe("pill debounce", () => {
    it("does not show the Jump-to-latest chip immediately on leaving the end, then shows after 150ms", async () => {
      const messages = makeTranscript(20);
      renderChatMessages({ messages, scrollStateKey: "pill-debounce-key" });
      await settleLegendList();

      expect(isJumpPillVisible()).toBe(false);

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });

      // Debounced show: still hidden before 150ms.
      expect(isJumpPillVisible()).toBe(false);

      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, PILL_SHOW_DEBOUNCE_MS - 30);
        });
      });
      expect(isJumpPillVisible()).toBe(false);

      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 60);
        });
      });
      expect(isJumpPillVisible()).toBe(true);
    });

    it("hides the pill immediately when clicking Jump to latest", async () => {
      const messages = makeTranscript(20);
      renderChatMessages({ messages, scrollStateKey: "pill-hide-key" });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, PILL_SHOW_DEBOUNCE_MS + 30);
        });
      });
      expect(isJumpPillVisible()).toBe(true);

      fireEvent.click(screen.getByRole("button", { name: "Scroll to end" }));
      expect(isJumpPillVisible()).toBe(false);
    });
  });

  it("wheel/pointerdown/touchmove cancel live-follow (generation token) so stream growth stays parked", async () => {
    const messages = makeTranscript(20);

    for (const gesture of ["wheel", "pointerdown", "touchmove"] as const) {
      const scrollStateKey = `manual-${gesture}-key`;
      const { rerenderMessages, unmount } = renderChatMessages({
        messages,
        scrollStateKey,
      });
      await settleLegendList();

      const scrollNode = getScrollNode();
      if (gesture === "wheel") {
        fireEvent.wheel(scrollNode, { deltaY: -80 });
      } else if (gesture === "pointerdown") {
        fireEvent.pointerDown(scrollNode);
      } else {
        fireEvent.touchMove(scrollNode);
      }
      fireScrollAwayFromEnd();
      // Park at a stable non-zero offset after leaving the end.
      scrollNode.scrollTop = 90;
      fireEvent.scroll(scrollNode);
      const parked = getScrollNode().scrollTop;
      expect(parked).toBe(90);

      rerenderMessages(appendAssistant(messages, `stream-${gesture}`, 10_000));
      await settleLegendList();
      expect(getScrollNode().scrollTop).toBe(parked);

      unmount();
    }
  });

  /**
   * Ticket 14 (direction A): edge-aware wheel cancellation. A downward wheel
   * at the true live edge must not cancel follow (clamped momentum shape:
   * wheel with no accompanying scroll). Upward / ambiguous wheels and
   * directionless touch movement are departures; explicit toward-end touch
   * movement may arm a later strict-edge resume.
   */
  describe("edge-aware wheel live-follow cancellation (ticket 14)", () => {
    async function renderFollowingAtLiveEdge(
      scrollStateKey: string,
    ): Promise<HTMLElement> {
      const messages = makeTranscript(20);
      renderChatMessages({ messages, scrollStateKey });
      await settleLegendList();
      act(() => {
        fireScrollToEnd();
      });
      const scrollNode = getScrollNode();
      expect(scrollNode.dataset.scrollMode).toBe("following-end");
      return scrollNode;
    }

    it("downward wheel at the live edge does not cancel follow", async () => {
      const scrollNode = await renderFollowingAtLiveEdge(
        "t14-down-at-edge-key",
      );
      const scrollTopBefore = scrollNode.scrollTop;

      fireEvent.wheel(scrollNode, { deltaY: 40 });

      expect(scrollNode.scrollTop).toBe(scrollTopBefore);
      expect(scrollNode.dataset.scrollMode).toBe("following-end");
    });

    it("upward wheel at the live edge cancels follow", async () => {
      const scrollNode = await renderFollowingAtLiveEdge("t14-up-at-edge-key");

      fireEvent.wheel(scrollNode, { deltaY: -40 });

      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
    });

    it("repeated downward clamped-momentum wheels at the live edge keep follow", async () => {
      const scrollNode = await renderFollowingAtLiveEdge(
        "t14-momentum-at-edge-key",
      );
      const scrollTopBefore = scrollNode.scrollTop;

      for (let tick = 0; tick < 5; tick += 1) {
        fireEvent.wheel(scrollNode, { deltaY: 40 });
        expect(scrollNode.scrollTop).toBe(scrollTopBefore);
        expect(scrollNode.dataset.scrollMode).toBe("following-end");
      }
    });

    it("touchmove without directional coordinates fails safe to departure", async () => {
      const scrollNode = await renderFollowingAtLiveEdge(
        "t14-touchmove-at-edge-key",
      );

      fireEvent.touchMove(scrollNode);

      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
    });

    it("touch direction must explicitly approach the strict edge before follow resumes", async () => {
      const scrollNode = await renderFollowingAtLiveEdge(
        "t14-touch-direction-key",
      );

      fireEvent.touchStart(scrollNode, {
        touches: [{ clientY: 300 }],
      });
      fireEvent.touchMove(scrollNode, {
        touches: [{ clientY: 320 }],
      });
      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");

      fireEvent.touchStart(scrollNode, {
        touches: [{ clientY: 320 }],
      });
      fireEvent.touchMove(scrollNode, {
        touches: [{ clientY: 300 }],
      });
      expect(scrollNode.dataset.scrollMode).toBe("following-end");
    });

    it("a scrollbar drag resumes follow only after it actually moves toward the strict edge", async () => {
      setLegendListScrollContainerScrollHeightOverride(2_000);
      const scrollNode = await renderFollowingAtLiveEdge(
        "t14-pointer-direction-key",
      );
      const atEnd = scrollNode.scrollTop;
      expect(atEnd).toBeGreaterThan(40);

      // Pointerdown alone is ambiguous (it may be text selection or an
      // inline-link click), so it relinquishes ownership without granting a
      // path back to follow. The scroll positions reported while that pointer
      // remains active provide the missing scrollbar-drag direction.
      fireEvent.pointerDown(scrollNode);
      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
      await fireScrollTopAndFlush(atEnd - 40);
      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");

      fireEvent.pointerMove(scrollNode);
      await fireScrollTopAndFlush(atEnd);
      expect(scrollNode.dataset.scrollMode).toBe("following-end");
      fireEvent.pointerUp(scrollNode);
    });

    it("an active text-selection pointer does not turn list-owned motion into scrollbar intent", async () => {
      setLegendListScrollContainerScrollHeightOverride(2_000);
      const scrollNode = await renderFollowingAtLiveEdge(
        "t14-pointer-list-owned-key",
      );
      const atEnd = scrollNode.scrollTop;

      fireEvent.pointerDown(scrollNode);
      await fireScrollTopAndFlush(atEnd - 40);
      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");

      // Pointer movement can be ordinary text selection. Legend List's
      // pre-written scroll state is the ownership proof that this later
      // toward-tail correction is MVCP/app motion, not a thumb drag.
      fireEvent.pointerMove(scrollNode);
      await fireLibraryOwnedScrollTo(atEnd);

      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
      fireEvent.pointerUp(scrollNode);
    });

    it("ambiguous wheel (deltaY 0) at the live edge still cancels follow", async () => {
      const scrollNode = await renderFollowingAtLiveEdge(
        "t14-ambiguous-at-edge-key",
      );

      fireEvent.wheel(scrollNode, { deltaY: 0 });

      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
    });

    it("downward wheel during a non-overflowing anchoring-new-turn session still cancels (review fix: isAtEnd alone is not 'the live edge')", async () => {
      // anchoredEndSpace parks a non-overflowing anchor at the maximum
      // REACHABLE scroll - a reserve/natural-bottom clamp, not necessarily
      // the turn's true content end - so LegendList's own getState().isAtEnd
      // can read true while the mode machine is still legitimately
      // "anchoring-new-turn" (the overflow-gated reconciliation branch in
      // onIsAtEndChange never fires, since anchoredTurnOverflowsViewportRef
      // stays false for a turn this short). A downward wheel arriving there
      // is real departure intent and must still cancel - the direction-A
      // exemption only applies while genuinely `following-end`.
      const sendId = "t14-anchoring-isatend-send";
      const messages = makeCompletedTranscript(10);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t14-anchoring-isatend-key",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      const afterSend = appendOptimisticUserSend(messages, sendId, 700_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      await waitForAnchorEngineSettle();
      // Precondition the finding depends on: the anchor settled without ever
      // reconciling to following-end - still legitimately anchoring.
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      const scrollNode = getScrollNode();
      fireEvent.wheel(scrollNode, { deltaY: 40 });

      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
    });
  });

  it("free-scrolling NEVER moves scroll position on streamed growth", async () => {
    const messages = makeTranscript(20);
    const { rerenderMessages } = renderChatMessages({
      messages,
      scrollStateKey: "free-stream-key",
    });
    await settleLegendList();

    const scrollNode = getScrollNode();
    fireEvent.wheel(scrollNode, { deltaY: -120 });
    scrollNode.scrollTop = 80;
    fireEvent.scroll(scrollNode);

    const parked = getScrollNode().scrollTop;
    expect(parked).toBe(80);

    const next = appendAssistant(messages, "streamed-a", 99_000);
    rerenderMessages(next);
    await settleLegendList();

    expect(getScrollNode().scrollTop).toBe(parked);
  });

  it("stays detached inside the near-end band and resumes only at the strict edge", async () => {
    const messages = makeTranscript(20);
    setLegendListScrollContainerScrollHeightOverride(
      LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
    );
    const { rerenderMessages } = renderChatMessages({
      messages,
      scrollStateKey: "near-end-restore-key",
    });
    await settleLegendList();

    act(() => {
      enterFreeScrollingAwayFromEnd();
    });
    await act(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, PILL_SHOW_DEBOUNCE_MS + 30);
      });
    });
    expect(isJumpPillVisible()).toBe(true);

    const scrollNode = getScrollNode();
    const maxScrollTop = Math.max(
      0,
      scrollNode.scrollHeight - scrollNode.clientHeight,
    );
    await fireScrollTopAndFlush(maxScrollTop - 30);
    expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");

    const parkedNearEnd = scrollNode.scrollTop;
    const streamedMessages = appendAssistant(
      messages,
      "near-end-stream",
      99_000,
    );
    rerenderMessages(streamedMessages);
    await settleLegendList();
    expect(getScrollNode().scrollTop).toBe(parkedNearEnd);
    expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

    setLegendListScrollContainerScrollHeightOverride(
      LEGEND_LIST_HEADER_PX + streamedMessages.length * 90 + 40,
    );
    act(() => {
      fireEvent.wheel(scrollNode, { deltaY: 40 });
      fireScrollToEnd();
    });

    await waitFor(
      () => {
        expect(isJumpPillVisible()).toBe(false);
        expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      },
      { timeout: 3_000 },
    );
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
      getScrollNode().scrollTop = 40;
      fireEvent.scroll(getScrollNode());
      const afterDown = getScrollNode().scrollTop;

      let next = appendAssistant(messages, "k-stream-1", 50_000);
      rerenderMessages(next);
      await settleLegendList();
      expect(getScrollNode().scrollTop).toBe(afterDown);

      // Re-enter following via the pill after free-scrolling away.
      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, PILL_SHOW_DEBOUNCE_MS + 30);
        });
      });
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

    it("Home steps the scroller to the top while canceling follow", async () => {
      const messages = makeTranscript(24);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "kbd-home-key",
      });
      await settleLegendList();

      // Confirm we start away from 0 after initialScrollAtEnd.
      expect(getScrollNode().scrollTop).toBeGreaterThan(0);

      act(() => {
        dispatchKeyInScope("Home");
      });
      // Programmatic scrollTop fires a native scroll event in real browsers;
      // jsdom's shim does not, so synthesize one so LegendList refreshes
      // isAtEnd/isNearEnd (otherwise maintainScrollAtEnd still thinks the
      // viewport is at the tail and re-pins on the next data change).
      fireEvent.scroll(getScrollNode());
      await waitFor(() => {
        expect(getScrollNode().scrollTop).toBe(0);
      });

      // Free-scrolling after Home: streamed growth must not move.
      const next = appendAssistant(messages, "page-stream", 70_000);
      rerenderMessages(next);
      await settleLegendList();
      expect(getScrollNode().scrollTop).toBe(0);
    });
  });

  describe("edge-mutation wiring", () => {
    it("suffix removal while free-scrolling does not throw and remounts the list", async () => {
      // Ticket 17: free-scrolling at the top (scrollTop 0) means the last
      // visible row is early in the transcript - at/past firstRemovedIndex
      // when shrinking to 4 rows - so this lands case (b) (following-end),
      // not the old unconditional free-scrolling scroll-to-index. Only the
      // "does not throw / stays mounted" contract is pinned here; the three
      // viewport cases have dedicated pins below.
      const messages = makeTranscript(24);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "edge-suffix-key",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });

      const next = messages.slice(0, 4);
      rerenderMessages(next);
      await settleLegendList();

      expect(screen.getByTestId("chat-messages-scroll")).toBeTruthy();
      // Suffix of 4 rows fits the viewport after shrink; list remains mounted.
      expect(getScrollNode()).toBeTruthy();
    });

    it("new user send at the tail anchors near the top even while free-scrolling (decision #8, unconditional)", async () => {
      // Ticket 4 replaces the old plain scroll-to-end + following bridge for
      // this transition with the full anchor-new-turn treatment: the sent
      // row is targeted by the anchor engine and the viewport moves toward
      // it regardless of the reader's current mode.
      const messages = makeTranscript(20);
      // Registered up front, mirroring chat-session-store.ts's dispatch-time
      // registration (decision #8/#9 review round 2: unconditional anchoring
      // is decided by local-provenance registry membership, not row shape).
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "edge-send-key",
        localProvenanceMessageIds: new Set(["user-send-new"]),
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, PILL_SHOW_DEBOUNCE_MS + 30);
        });
      });
      expect(isJumpPillVisible()).toBe(true);
      // Parked at the top (scrollTop 0), the sent row (would-be index 20) is
      // nowhere near the mounted virtualization window.
      expect(screen.queryByTestId("mock-message-user-send-new")).toBeNull();

      const next: ReadonlyArray<ChatMessageModel> = [
        ...messages,
        {
          ...makeMessageAt(0, "user", 999_000),
          id: "user-send-new",
          content: "hello",
        },
      ];
      rerenderMessages(next);
      await settleLegendList();

      // The anchor engine moved the viewport toward the sent row - it is now
      // mounted (virtualization only mounts rows near the viewport).
      await waitFor(() => {
        expect(screen.getByTestId("mock-message-user-send-new")).toBeTruthy();
      });
      // No reply yet - the anchored turn's content doesn't overflow the
      // usable viewport, so the pill has nothing to signal.
      await waitFor(
        () => {
          expect(isJumpPillVisible()).toBe(false);
        },
        { timeout: 3_000 },
      );
    });
  });

  describe("ticket 17 delete-landing (viewport-aware suffix removal)", () => {
    // Diagnosis harness numbers (ticket body): 120 uniform 90px rows, 700px
    // viewport, header/footer spacers 40px, delete keeping a long prefix.
    // Reference pins were (a) scrollTop 940→940 zero writes; (b) 9940 →
    // {following-end, 8500}; (c) already following → {following-end, 8500}.
    // Fixture-derived true-end may differ from 8500 when endInset/composer
    // differ - assert the qualitative contract with the app's own natural-max
    // formula, never jsdom's faked scrollHeight (LARGE_CONTENT_ROW_COUNT
    // constant - prior diagnosis silently passed on broken code that way).
    const T17_ROW_COUNT = 120;
    const T17_KEEP_COUNT = 100;
    const T17_FIRST_REMOVED_INDEX = T17_KEEP_COUNT;
    const T17_ITEM_PX = TICKET_13_ROW_HEIGHT_PX;
    const T17_HEADER_PX = LEGEND_LIST_HEADER_PX;
    const T17_FOOTER_PX = LEGEND_LIST_HEADER_PX;
    // Case (a) reference: scrollTop 940 → last visible well before index 100.
    const T17_CASE_A_SCROLL_TOP = 940;
    // Case (b) reference: scrollTop 9940 → deep into the deleted region.
    const T17_CASE_B_SCROLL_TOP = 9940;
    // Fixture-derived true end after keeping 100 rows under this harness
    // (matches the ticket's diagnosis pin of 8500). Do not derive from
    // jsdom's faked scrollHeight; do not assume save-path endInset accounting
    // matches LegendList's scrollToEnd geometry exactly.
    const T17_TRUE_END_SCROLL_TOP = 8500;
    // Naive "include footer" bound used only to catch the old last-row-only
    // regression (which landed footer-height short of the true end).
    const T17_NAIVE_WITH_FOOTER =
      T17_KEEP_COUNT * T17_ITEM_PX +
      T17_HEADER_PX +
      T17_FOOTER_PX -
      VIEWPORT_HEIGHT_PX;
    // Old buggy last-row navigation excluded the footer spacer.
    const T17_OLD_BUGGY_LAST_ROW_ONLY =
      T17_KEEP_COUNT * T17_ITEM_PX + T17_HEADER_PX - VIEWPORT_HEIGHT_PX;

    /** Free-scroll, seed an explicit scrollTop, fire scroll + settle so the
     *  rAF-throttled `viewportLastVisibleSnapshotRef` tracks the real
     *  LegendList `getState().end` before the delete. */
    async function t17SeedFreeScrollingAt(scrollTop: number): Promise<void> {
      const scrollNode = getScrollNode();
      act(() => {
        fireEvent.wheel(scrollNode, { deltaY: -80 });
        scrollNode.scrollTop = scrollTop;
        fireEvent.scroll(scrollNode);
      });
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().scrollTop).toBe(scrollTop);
    }

    it("(a) free-scrolling above the deletion boundary: no scroll write, mode and scrollTop unchanged", async () => {
      const messages = makeTranscript(T17_ROW_COUNT);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t17-case-a-untouched",
      });
      await settleLegendList();

      await t17SeedFreeScrollingAt(T17_CASE_A_SCROLL_TOP);

      const scrollToSpy = vi.spyOn(HTMLElement.prototype, "scrollTo");
      const scrollToCallsBefore = scrollToSpy.mock.calls.length;
      const modeBefore = getScrollNode().dataset.scrollMode;
      const scrollTopBefore = getScrollNode().scrollTop;

      // firstRemovedIndex = 100; last visible at scrollTop 940 is ~index 17
      // (strictly before 100) → case (a) none.
      expect(T17_CASE_A_SCROLL_TOP).toBeLessThan(
        T17_FIRST_REMOVED_INDEX * T17_ITEM_PX,
      );

      rerenderMessages(messages.slice(0, T17_KEEP_COUNT));
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe(modeBefore);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().scrollTop).toBe(scrollTopBefore);
      expect(getScrollNode().scrollTop).toBe(T17_CASE_A_SCROLL_TOP);
      expect(scrollToSpy.mock.calls.length).toBe(scrollToCallsBefore);
    });

    it("(a reserve cleanup) a deleted detached reserve cannot block reattachment at the real edge", async () => {
      const sendId = "t17-case-a-removed-reserve";
      const messages = makeCompletedTranscript(T17_ROW_COUNT);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t17-case-a-removed-reserve-key",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      const afterSend = appendOptimisticUserSend(messages, sendId, 700_000);
      rerenderMessages(afterSend);
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      await t17SeedFreeScrollingAt(T17_CASE_A_SCROLL_TOP);

      // The reader is above the deletion boundary, so the viewport remains
      // untouched while the suffix removes the row that owned reply-reserve
      // geometry.
      rerenderMessages(messages.slice(0, T17_KEEP_COUNT));
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().scrollTop).toBe(T17_CASE_A_SCROLL_TOP);

      setLegendListScrollContainerScrollHeightOverride(
        T17_HEADER_PX + T17_KEEP_COUNT * T17_ITEM_PX + T17_FOOTER_PX,
      );
      act(() => {
        fireEvent.wheel(getScrollNode(), { deltaY: 40 });
        fireScrollToEnd();
      });

      await waitFor(() => {
        expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      });
    });

    it("(b) free-scrolling inside the deleted region: following-end at the true end (not last-row-short)", async () => {
      const messages = makeTranscript(T17_ROW_COUNT);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t17-case-b-vanished",
      });
      await settleLegendList();

      await t17SeedFreeScrollingAt(T17_CASE_B_SCROLL_TOP);

      // Sanity: 9940 lands past firstRemovedIndex * item height.
      expect(T17_CASE_B_SCROLL_TOP).toBeGreaterThan(
        T17_FIRST_REMOVED_INDEX * T17_ITEM_PX,
      );

      rerenderMessages(messages.slice(0, T17_KEEP_COUNT));
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      // Do NOT derive expected from scrollNode.scrollHeight (jsdom fakes a
      // large constant for virtualization bootstrap). Pin the fixture's true
      // end (8500, same as the ticket diagnosis) and prove we are not the
      // old last-row-only landing (footer excluded → 40px short of naive).
      expect(getScrollNode().scrollTop).toBe(T17_TRUE_END_SCROLL_TOP);
      expect(T17_TRUE_END_SCROLL_TOP).toBeGreaterThanOrEqual(
        T17_NAIVE_WITH_FOOTER,
      );
      expect(getScrollNode().scrollTop).toBeGreaterThan(
        T17_OLD_BUGGY_LAST_ROW_ONLY,
      );
      expect(
        getScrollNode().scrollTop - T17_OLD_BUGGY_LAST_ROW_ONLY,
      ).toBeGreaterThanOrEqual(T17_FOOTER_PX);
    });

    it("(c) already following-end: stays following-end at the true end after suffix removal", async () => {
      const messages = makeTranscript(T17_ROW_COUNT);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t17-case-c-following",
      });
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("following-end");

      rerenderMessages(messages.slice(0, T17_KEEP_COUNT));
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      expect(getScrollNode().scrollTop).toBe(T17_TRUE_END_SCROLL_TOP);
    });

    // Review round (stack review, finding 2, CONFIRMED HIGH): the
    // `viewportLastVisibleSnapshotRef` snapshot must be gated on the EXACT
    // `messages` array identity it was observed against, not trusted by
    // ordering alone. Both pins below arrange a suffix delete to land BEFORE
    // any real scroll/rAF observation has ever populated the ref - anchored
    // to an EARLY restored row (index 10, strictly before firstRemovedIndex
    // 100) so that the OLD unconditional (pre-fix) reading-line-anchor seed
    // would have masqueraded as a real "last visible row" observation and
    // wrongly resolved case (a). Post-fix, an un-observed snapshot resolves
    // to `null` (unknown) regardless of what the seed claims, and unknown
    // defaults to case (b) - never a guessed case (a).
    it("(review finding 2) restored free-scrolling, delete arrives before the first rAF observation: unknown defaults to case (b), never a guessed case (a)", async () => {
      const messages = makeTranscript(T17_ROW_COUNT);
      const scrollStateKey = "t17-finding2-mount-before-rjaf";
      saveChatTabState({
        identity: makeDefaultTestIdentity(scrollStateKey),
        mode: "free-scrolling",
        anchorMessageId: messages[10]?.id ?? null,
        anchorIndex: null,
        offset: 0,
      });
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey,
      });

      // Deliberately no `await settleLegendList()` / scroll event here: the
      // mount-time classify effect's own tail call schedules an
      // rAF-throttled `getState().end` read (`scheduleActiveViewportUpdate`),
      // but no animation frame has fired yet - this is still the same tick
      // as mount. Delete immediately on top of that.
      rerenderMessages(messages.slice(0, T17_KEEP_COUNT));
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      expect(getScrollNode().scrollTop).toBe(T17_TRUE_END_SCROLL_TOP);
    });

    it("(review finding 2) a layout/size change with no scroll event does not manufacture an observation - delete before the first rAF still defaults to case (b)", async () => {
      const messages = makeTranscript(T17_ROW_COUNT);
      const scrollStateKey = "t17-finding2-layout-before-rjaf";
      saveChatTabState({
        identity: makeDefaultTestIdentity(scrollStateKey),
        mode: "free-scrolling",
        anchorMessageId: messages[10]?.id ?? null,
        anchorIndex: null,
        offset: 0,
      });
      const { rerenderMessages, rerenderWith } = renderChatMessages({
        messages,
        scrollStateKey,
      });

      // `composerOverlayHeight` is not a dependency of the edge-mutation
      // effect and does not touch `messages` - this re-render neither
      // writes to nor invalidates the snapshot ref; it only proves a
      // layout/size change alone cannot manufacture a fake observation.
      // `renderChatMessages`'s default is 80px - growing it here also
      // genuinely shifts the true end scroll target (a bigger bottom inset
      // needs a bigger scrollTop to clear it), so the expected true end
      // below accounts for that observed, non-hardcoded delta.
      const T17_GROWN_COMPOSER_OVERLAY_HEIGHT_PX = 400;
      rerenderWith({
        composerOverlayHeight: T17_GROWN_COMPOSER_OVERLAY_HEIGHT_PX,
      });

      // Still before the first rAF - same timing constraint as the pin
      // above, now with an intervening layout change that touches neither
      // `messages` nor the snapshot ref.
      rerenderMessages(messages.slice(0, T17_KEEP_COUNT));
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      // True end shifts 1:1 with the grown composer inset relative to the
      // default inset other ticket-17 pins render with (observed, not
      // derived from a formula - same methodology as T17_TRUE_END_SCROLL_TOP
      // itself).
      expect(getScrollNode().scrollTop).toBe(
        T17_TRUE_END_SCROLL_TOP +
          (T17_GROWN_COMPOSER_OVERLAY_HEIGHT_PX -
            DEFAULT_COMPOSER_OVERLAY_HEIGHT_PX),
      );
    });

    // Review round 2, finding 2 residual (CONFIRMED HIGH): the reviewer's
    // literal schedule - establish an authoritative snapshot, then a REAL
    // row-size change under the SAME `messages` array with NO scroll event
    // pushes the true last-visible row past the deletion boundary, then
    // delete. Driven via `legendListRefHolder.current.setItemSize` (the
    // real LegendList `setItemSize` ref method, teed through the
    // pass-through mock above) - this is the one lever that bypasses
    // jsdom's globally no-op ResizeObserver and fires a genuine
    // `onItemSizeChanged` with a real diff, matching how an activity-group
    // disclosure collapsing (state lives outside `messages`) would move
    // rows into view in a real browser.
    it("(review round 2, finding 2 residual) a real row-size change with no scroll crosses the deletion boundary - delete lands case (b), not a stale case (a)", async () => {
      const ROW_COUNT = 30;
      const KEEP_COUNT = 25;
      const messages = makeTranscript(ROW_COUNT);
      const scrollStateKey = "t17-finding2-r2-item-size";
      // Restore free-scrolling anchored at row 0 so the initial mount
      // bootstraps there, measuring the early rows we are about to shrink
      // before we scroll away to the authoritative snapshot position.
      saveChatTabState({
        identity: makeDefaultTestIdentity(scrollStateKey),
        mode: "free-scrolling",
        anchorMessageId: messages[0]?.id ?? null,
        anchorIndex: null,
        offset: 0,
      });
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey,
      });
      await settleLegendList();

      // Authoritative snapshot: scrolled to a row strictly before
      // KEEP_COUNT (25) - roughly rows 10-17 at this scrollTop.
      await t17SeedFreeScrollingAt(900);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      await waitFor(() => {
        expect(legendListRefHolder.current).not.toBeNull();
      });

      // Shrink 10 already-measured early rows (0-9) - a genuine,
      // no-scroll, same-array size change, pushing more rows into view
      // for the same scrollTop (the disclosure-collapse shape).
      act(() => {
        for (let index = 0; index < 10; index += 1) {
          legendListRefHolder.current?.setItemSize(`message-${index}`, {
            height: 5,
            width: VIEWPORT_WIDTH_PX,
          });
        }
      });

      rerenderMessages(messages.slice(0, KEEP_COUNT));
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
    });

    // Review round 3, finding 2 residual (CONFIRMED HIGH): a height-only
    // pane resize changes LegendList's `state.scrollLength` via its internal
    // `handleLayout`, WITHOUT firing a scroll event, a row remeasure
    // (`onTimelineItemSizeChanged`), or a header/footer change
    // (`onListMetricsChange`) - none of the earlier hooks see it. Driven via
    // `triggerLegendListResizeObserverEntry` (the controllable global
    // `ResizeObserver` installed at module-load time above) firing a
    // synthetic entry for the scroll container itself - this flows through
    // LegendList's REAL `useOnLayoutSync` -> `onLayoutChange` ->
    // `handleLayout` pipeline exactly as a genuine browser resize would,
    // recalculating items-in-view for the unchanged scrollTop.
    it("(review round 3, finding 2 residual) a height-only pane resize with no scroll/no row-remeasure/no header-footer-change crosses the deletion boundary - delete lands case (b)", async () => {
      const ROW_COUNT = 30;
      const KEEP_COUNT = 25;
      const messages = makeTranscript(ROW_COUNT);
      const scrollStateKey = "t17-finding2-r3-viewport-resize";
      saveChatTabState({
        identity: makeDefaultTestIdentity(scrollStateKey),
        mode: "free-scrolling",
        anchorMessageId: messages[0]?.id ?? null,
        anchorIndex: null,
        offset: 0,
      });
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey,
      });
      await settleLegendList();

      // Authoritative snapshot: scrolled to a row strictly before
      // KEEP_COUNT (25) - roughly rows 10-17 at this scrollTop.
      await t17SeedFreeScrollingAt(900);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      const stateBeforeResize = legendListRefHolder.current?.getState();
      expect(stateBeforeResize?.scrollLength).toBe(VIEWPORT_HEIGHT_PX);
      expect(stateBeforeResize?.end).toBeLessThan(KEEP_COUNT);

      // Height-only pane resize: same messages array, no scroll event, no
      // row remeasure, no header/footer change - grows the viewport so more
      // rows fit at the same scrollTop, crossing KEEP_COUNT (25). Real
      // evidence this reaches LegendList's genuine `handleLayout`, not a
      // no-op: `scrollLength`/`end` are asserted below to have actually
      // moved, through the real library, before the delete even happens.
      const GROWN_VIEWPORT_HEIGHT_PX = VIEWPORT_HEIGHT_PX + 800;
      act(() => {
        triggerLegendListResizeObserverEntry(getScrollNode(), {
          width: VIEWPORT_WIDTH_PX,
          height: GROWN_VIEWPORT_HEIGHT_PX,
        });
      });
      const stateAfterResize = legendListRefHolder.current?.getState();
      expect(stateAfterResize?.scrollLength).toBe(GROWN_VIEWPORT_HEIGHT_PX);
      expect(stateAfterResize?.end).toBeGreaterThanOrEqual(KEEP_COUNT);

      rerenderMessages(messages.slice(0, KEEP_COUNT));
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
    });
  });

  describe("live pass S4B: suffix delete during a programmatically-parked anchoring session", () => {
    // Live shape (retest/S4B, run-1275860c): a real composer send entered
    // `anchoring-new-turn`; the reader then parked deep in the transcript via
    // a PROGRAMMATIC `scrollTop` write (no wheel/touchmove/pointerdown/
    // keydown - the harness's own JS-driven scroll, not a real gesture); mode
    // stayed `anchoring-new-turn` since nothing in that path cancels it.
    // Deleting a user message above the parked position (a real suffix
    // removal) was then expected to land at the new live edge
    // (`following-end`) but did not move.
    it("(ticket 19 pin) a settled anchoring session cedes ownership on a scroll-only DOM departure - the scrollbar-thumb gesture the reachability pin above used to document as undetected", async () => {
      const sendId = "s4b-reachability-send";
      const messages = makeCompletedTranscript(30);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "s4b-reachability-key",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      const afterSend = appendOptimisticUserSend(messages, sendId, 700_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      // Same scroll-only departure the old (pre-ticket-19) reachability pin
      // documented as undetected: a direct DOM `scrollTop` write with no
      // wheel/touch/pointerdown event of its own - the live harness's exact
      // native-thumb-drag shape. Critically, this is also NOT a library
      // call of any kind, so `list.getState().scroll` never advances to
      // match - the capture-provenance classifier's state-equality check
      // (chat-messages-scroll-helpers.ts) sees the mismatch and cancels on
      // the very first captured event, before LegendList's own non-capture
      // target listener ever consumes it.
      const scrollNode = getScrollNode();
      act(() => {
        scrollNode.scrollTop = 900;
        fireEvent.scroll(scrollNode);
      });

      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
      expect(scrollNode.scrollTop).toBe(900);

      // Ownership oracle (design's integrated pin, item 3): the departed
      // generation must never again receive a reveal/follow correction.
      // Spying on the REAL LegendList instance's own imperative API is the
      // strongest available negative - it is the exact surface the reveal
      // pass and anchor engine would call to pull a still-owned reader back.
      const list = legendListRefHolder.current;
      if (!list) throw new Error("expected LegendListRef to be attached");
      const scrollToOffsetSpy = vi.spyOn(list, "scrollToOffset");
      const scrollToIndexSpy = vi.spyOn(list, "scrollToIndex");
      const withReply: ReadonlyArray<ChatMessageModel> = [
        ...afterSend,
        {
          ...makeMessageAt(0, "assistant", 700_001),
          id: "s4b-reachability-reply-1",
          content: "chunk",
          completedAt: null,
          runState: "running",
        },
      ];
      rerenderMessages(withReply);
      await settleLegendList();

      expect(scrollToOffsetSpy).not.toHaveBeenCalled();
      expect(scrollToIndexSpy).not.toHaveBeenCalled();
      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
      expect(scrollNode.scrollTop).toBe(900);
    });

    it("(delete pin) a suffix delete that sweeps a scroll-only-departed (now free-scrolling) reader lands at the new live edge", async () => {
      const sendId = "s4b-delete-send";
      const ROW_COUNT = 30;
      const KEEP_COUNT = 10;
      const messages = makeCompletedTranscript(ROW_COUNT);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "s4b-delete-key",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      const afterSend = appendOptimisticUserSend(messages, sendId, 700_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      // Same scroll-only departure as the ticket-19 pin above - lands well
      // past KEEP_COUNT (10), so the reader's current viewport (and the
      // anchored send itself, at index ROW_COUNT=30) both fall inside the
      // to-be-deleted suffix. Post-ticket-19, the capture-provenance
      // classifier cancels anchoring ownership on this SAME event (mode
      // transitions to `free-scrolling` immediately, not merely at delete
      // time) - the delete below now exercises `classifySuffixRemoval`'s
      // ordinary free-scrolling-viewport-touched branch, not the old
      // anchoring-reserve teardown this pin originally targeted; the
      // observable outcome (lands at the new live edge) is unchanged.
      const scrollNode = getScrollNode();
      act(() => {
        scrollNode.scrollTop = 900;
        fireEvent.scroll(scrollNode);
      });
      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");

      // Real suffix delete: a user message above the parked viewport is
      // removed, taking everything after it (including the parked position
      // and the anchored send) with it.
      rerenderMessages(afterSend.slice(0, KEEP_COUNT));
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
    });

    // Review round (fix 1's own pin gap): the delete pin above always
    // deletes the anchored send ITSELF, where `resolveChatListAnchoredEndSpace`
    // already fails to find the row post-delete regardless of whether
    // `timelineAnchorMessageId` was cleared - it cannot distinguish "the
    // teardown ran" from "the row is simply gone". This pin covers the
    // OTHER shape the reviewer named: the anchored message SURVIVES a case
    // (b) delete (only later content is removed) - the only schedule where
    // the teardown's own effect (clearing `timelineAnchorMessageId`) is
    // observable at all.
    it("(fix 1 pin) a surviving anchored message's end-space reserve is torn down by a case (b) delete", async () => {
      const sendId = "s4b-survives-send";
      const messages = makeCompletedTranscript(30);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "s4b-survives-key",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      const afterSend = appendOptimisticUserSend(messages, sendId, 700_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      // A streamed reply chunk arrives after the send - `sendId` (index 30)
      // now survives well before the array's own tail.
      const withReply: ReadonlyArray<ChatMessageModel> = [
        ...afterSend,
        {
          ...makeMessageAt(0, "assistant", 700_001),
          id: "s4b-survives-reply-1",
          content: "chunk",
          completedAt: null,
          runState: "running",
        },
      ];
      rerenderMessages(withReply);
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      // Case (b): delete removes only the reply chunk, keeping `sendId` -
      // the anchored row's own reserved end-space sits within the
      // anchoring-new-turn viewport, so the classifier's viewport snapshot
      // reads this as touched by the removed suffix.
      rerenderMessages(afterSend);
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");

      // Fix 1's own observable, empirically isolated: `resolveChatListAnchored
      // EndSpace` (chat-scroll-anchoring.ts) only returns truthy while
      // `timelineAnchorMessageId` is non-null AND that row still exists (it
      // does here - `sendId` survived) - its reserve inflates the target
      // `scrollToEnd({animated:false})` (issued by this same "scroll-to-end"
      // case, unconditionally) computes. Fixture-observed (not derived from a
      // formula, same methodology as this file's other true-end pins):
      // WITHOUT the teardown, the stale reserve for the now-inert `sendId`
      // session pushes the landing to 2764; WITH it (`timelineAnchorMessageId`
      // cleared, `anchoredEndSpace` undefined, no reserve), it lands at the
      // true natural end, 2290 - a 474px gap matching the reserve exactly.
      expect(getScrollNode().scrollTop).toBe(2290);
    });
  });

  // Ticket 19 (decision #31 binding condition c): these two pins are a HARD
  // dependency-upgrade gate against the INSTALLED @legendapp/list@3.2.0, not
  // ordinary behavior coverage. `chatAnchorScrollCaptureShouldCancel`'s
  // entire state-equality/clamp classification (chat-messages-scroll-
  // helpers.ts) depends on the library's OWN listener-ordering and pre-write
  // contract - these pins assert THAT contract directly, against a REAL
  // mounted LegendList instance, independent of the classifier's own logic.
  // A future @legendapp/list bump can break this contract in two OPPOSITE
  // directions - triage a red pin here by which one actually broke, they
  // are not interchangeable:
  //
  // (a) Losing the imperative/MVCP PRE-WRITE (the non-animated-scrollToOffset
  //     pin, or the MVCP pin below, goes red): a legitimate library-owned
  //     correction no longer advances `state.scroll` before its DOM event
  //     reaches ancestor capture, so it now mismatches the state-equality
  //     check. Effect: FALSE CANCELS - the classifier treats a real
  //     library-owned scroll as a departure. Reader-safe (the fail-safe bias
  //     is unsure -> cancel), degrades send UX with an extra unwanted
  //     free-scrolling transition. This is the safety net working exactly as
  //     designed - do NOT "fix" this direction by loosening the classifier;
  //     re-audit and restore the dependency contract instead.
  //
  // (b) Losing CAPTURE-BEFORE-CONSUMPTION ordering (the direct-DOM-write pin
  //     goes red): if the library's own consuming listener ever runs before
  //     this ancestor's capture-phase listener, then by the time capture
  //     observes an event, LegendList has ALREADY consumed and often
  //     resynchronized `state.scroll` to match DOM - including for a genuine
  //     native thumb-drag departure. Effect: FALSE SILENCE - a real reader
  //     departure now looks state-equal and slips past the classifier
  //     un-cancelled, recreating the exact intent violation ticket 19 exists
  //     to fix. This is the dangerous direction: it cannot be caught by
  //     "make the classifier stricter," because the classifier never even
  //     sees a mismatch to act on - only re-establishing capture-phase
  //     ordering (or an entirely different detection mechanism) fixes it.
  //
  // (See the module doc comment on chat-messages-scroll-helpers.ts for the
  // full writer-site table these pins are drawn from.)
  describe("ticket 19: installed @legendapp/list 3.2.0 contract pins (hard upgrade gate)", () => {
    it("a direct DOM scrollTop move is STALE at ancestor capture - react.mjs:5663-5671 installs the consuming listener on the scroll node with no capture flag", async () => {
      const sendId = "t19-contract-direct-send";
      const messages = makeCompletedTranscript(30);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t19-contract-direct-key",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();
      const afterSend = appendOptimisticUserSend(messages, sendId, 700_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();

      const list = legendListRefHolder.current;
      if (!list) throw new Error("expected LegendListRef to be attached");
      const wrapper = screen.getByTestId("chat-transcript-container");
      const scrollNode = getScrollNode();
      const observedListStateAtCapture: Array<number> = [];
      const observer = (event: Event): void => {
        if (event.target !== scrollNode) return;
        observedListStateAtCapture.push(list.getState().scroll);
      };
      wrapper.addEventListener("scroll", observer, { capture: true });
      try {
        const domScrollTopBeforeWrite = scrollNode.scrollTop;
        act(() => {
          scrollNode.scrollTop = domScrollTopBeforeWrite + 300;
          fireEvent.scroll(scrollNode);
        });
        expect(observedListStateAtCapture).toHaveLength(1);
        expect(observedListStateAtCapture[0]).toBe(domScrollTopBeforeWrite);
        expect(observedListStateAtCapture[0]).not.toBe(
          domScrollTopBeforeWrite + 300,
        );
      } finally {
        wrapper.removeEventListener("scroll", observer, { capture: true });
      }
    });

    it("a non-animated scrollToOffset call is ALREADY SYNCHRONIZED at ancestor capture - react.mjs:2104-2110 calls updateScroll before doScrollTo", async () => {
      const sendId = "t19-contract-scrollto-send";
      const messages = makeCompletedTranscript(30);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t19-contract-scrollto-key",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();
      const afterSend = appendOptimisticUserSend(messages, sendId, 700_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();

      const list = legendListRefHolder.current;
      if (!list) throw new Error("expected LegendListRef to be attached");
      const wrapper = screen.getByTestId("chat-transcript-container");
      const scrollNode = getScrollNode();
      const observedListStateAtCapture: Array<number> = [];
      const observer = (event: Event): void => {
        if (event.target !== scrollNode) return;
        observedListStateAtCapture.push(list.getState().scroll);
      };
      wrapper.addEventListener("scroll", observer, { capture: true });
      try {
        await act(async () => {
          void list.scrollToOffset({
            offset: scrollNode.scrollTop + 40,
            animated: false,
          });
          fireEvent.scroll(scrollNode);
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          });
        });
        expect(observedListStateAtCapture).toHaveLength(1);
        // Whatever position the (possibly clamped) call actually landed at,
        // the library's internal state must already equal it BEFORE this
        // ancestor capture listener ever runs - the load-bearing property
        // `chatAnchorScrollCaptureShouldCancel`'s state-equality check
        // depends on, proven here independent of that classifier's own code.
        expect(observedListStateAtCapture[0]).toBe(scrollNode.scrollTop);
      } finally {
        wrapper.removeEventListener("scroll", observer, { capture: true });
      }
    });

    // Decision #31 binding condition (c), third writer site: MVCP
    // `requestAdjust` (react.mjs:1611-1629) advances `state.scroll` before
    // the deferred web `ScrollAdjust` path issues DOM `scrollBy`
    // (:5849-5899,6456-6467). A future @legendapp/list bump that stops
    // pre-writing for data adjustments would break the state-equality
    // silence path for every above-anchor weave during anchoring - this
    // pin is the hard upgrade gate for that writer, same observation
    // shape as the two pins above.
    it("an MVCP data adjustment (row insertion above the anchor) is ALREADY SYNCHRONIZED at ancestor capture - react.mjs:1611-1629 requestAdjust pre-writes state.scroll before scrollBy", async () => {
      const sendId = "t19-contract-mvcp-send";
      const earlierUserId = "message-2";
      const initial = makeCompletedTranscript(12);
      const { rerenderMessages } = renderChatMessages({
        messages: initial,
        scrollStateKey: "t19-contract-mvcp-key",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();
      const afterSend = appendOptimisticUserSend(initial, sendId, 700_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      const scrollBeforeWeave = getScrollNode().scrollTop;

      const list = legendListRefHolder.current;
      if (!list) throw new Error("expected LegendListRef to be attached");
      const wrapper = screen.getByTestId("chat-transcript-container");
      const scrollNode = getScrollNode();
      const observedAtCapture: Array<{
        listScroll: number;
        domScroll: number;
      }> = [];
      const observer = (event: Event): void => {
        if (event.target !== scrollNode) return;
        observedAtCapture.push({
          listScroll: list.getState().scroll,
          domScroll: scrollNode.scrollTop,
        });
      };
      wrapper.addEventListener("scroll", observer, { capture: true });

      // jsdom does not fire `scroll` on Element.scrollBy (LegendList's web
      // MVCP path: react.mjs:5840). Polyfill on THIS node only so the
      // capture-phase observation actually runs for the library's own
      // scrollBy - without inventing a second production listener. The
      // load-bearing property is still "list state already matches DOM at
      // ancestor capture", not the polyfill itself.
      const originalScrollBy = scrollNode.scrollBy.bind(scrollNode);
      // `Element.scrollBy`'s overloaded native signature (`(options?)` /
      // `(x, y)`) genuinely permits fewer arguments than this polyfill
      // declares - house style bans `?:` (a caller-omittable parameter),
      // but the caller here is jsdom/LegendList's own internal invocation,
      // not code this file controls, so the params stay required-typed
      // (`| undefined`) and the assignment cast documents the real,
      // load-bearing arity gap instead of a redundant one: every code path
      // already treats a missing value as `undefined` correctly.
      scrollNode.scrollBy = ((
        options: ScrollToOptions | number | undefined,
        yArg: number | undefined,
      ): void => {
        if (typeof options === "number") {
          scrollNode.scrollLeft += options;
          scrollNode.scrollTop += typeof yArg === "number" ? yArg : 0;
        } else if (options && typeof options === "object") {
          if (typeof options.left === "number") {
            scrollNode.scrollLeft += options.left;
          }
          if (typeof options.top === "number") {
            scrollNode.scrollTop += options.top;
          }
        }
        fireEvent.scroll(scrollNode);
      }) as typeof scrollNode.scrollBy;

      try {
        // Same natural MVCP trigger as ticket 13 pin (e): a non-retarget
        // setup-card weave ABOVE an earlier (non-anchored) row - classify
        // as `none`, so the only scroll motion is LegendList's own data
        // MVCP adjustment keeping the anchored send pixel-stable
        // (+1 row height). Not a messages-array tail append (which would
        // not shift content above the viewport).
        const earlierIndex = afterSend.findIndex(
          (message) => message.id === earlierUserId,
        );
        expect(earlierIndex).toBeGreaterThanOrEqual(0);
        const foreignCard = setupCardRow(
          `setup-card:owner-1:0:${earlierUserId}`,
          100,
          earlierUserId,
        );
        const afterForeignCard: ReadonlyArray<ChatMessageModel> = [
          ...afterSend.slice(0, earlierIndex),
          foreignCard,
          ...afterSend.slice(earlierIndex),
        ];
        rerenderMessages(afterForeignCard);
        await waitForAnchorEngineSettle();

        // Behavioral ownership: mode + generation still owned across the
        // weave (classifier stayed silent for every library-owned event).
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
        expect(getScrollNode().scrollTop).toBe(
          scrollBeforeWeave + TICKET_13_ROW_HEIGHT_PX,
        );

        // Hard-gate observation: at least one capture-phase event during
        // the MVCP path must already show list state equal to DOM (the
        // pre-write). If the library never issued scrollBy for this
        // weave in this harness, fall through is impossible - the
        // behavioral +1-row assert above would have failed first.
        const synchronizedCaptures = observedAtCapture.filter(
          (sample) => Math.abs(sample.listScroll - sample.domScroll) <= 1,
        );
        expect(synchronizedCaptures.length).toBeGreaterThan(0);
        for (const sample of synchronizedCaptures) {
          expect(sample.listScroll).toBe(sample.domScroll);
        }
      } finally {
        scrollNode.scrollBy = originalScrollBy;
        wrapper.removeEventListener("scroll", observer, { capture: true });
      }
    });
  });

  // Ticket 19 (decision #31): remaining non-gesture sources from the
  // design's audit table. Each pin settles an `anchoring-new-turn`
  // session, drives ONE library/app/browser-owned scroll source, and
  // asserts the capture-provenance classifier stays SILENT (mode remains
  // `anchoring-new-turn`, session still owned). The core defect pin and
  // pure truth-table live elsewhere; these are the silence side of the
  // audit. Do NOT add production machinery to make a pin possible - if a
  // source cannot be expressed in jsdom, fall back to a behavioral mode/
  // generation-owned assertion and document the proof shape.
  describe("ticket 19: non-gesture sources stay silent during settled anchoring", () => {
    it("(browser-clamp integration) a content-height shrink that clamps scrollTop to the new max does not cancel anchoring", async () => {
      // Pure clamp-predicate unit tests already cover the math
      // (chat-messages-scroll-helpers.test.ts). This pin is the DOM-level
      // integration: settle anchoring, shrink the scroller's reported
      // scrollHeight so the new max falls BELOW the parked scrollTop
      // (previous.scrollTop > currentMax + 1 AND currentMax < previousMax),
      // then write scrollTop to the new max exactly as a real browser clamp
      // would - no library scroll call, no wheel/touch/pointer. The
      // classifier must recognize the exact clamp signature and stay silent
      // (design audit table: "Browser clamping after content/reserve/
      // viewport shrink"). A bare write that is NOT this signature is
      // exactly what the S4B defect pin proves DOES cancel.
      const sendId = "t19-clamp-integration-send";
      const messages = makeCompletedTranscript(30);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t19-clamp-integration-key",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();
      const afterSend = appendOptimisticUserSend(messages, sendId, 700_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      const scrollNode = getScrollNode();
      const parkedTop = scrollNode.scrollTop;
      expect(parkedTop).toBeGreaterThan(100);
      // Seed the capture listener's previousSnapshot at the parked
      // position against the (still-large) default max - one library-owned
      // no-op re-write so the next event has a real "previous" to compare.
      await fireLibraryOwnedScrollTo(parkedTop);
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      // Shrink content so the new max is well below the parked top. New
      // max = scrollHeight - clientHeight. Pick scrollHeight so
      // max = parkedTop - 120 (prior-over-max evidence with room for the
      // 1px exclusivity boundary).
      const clientHeight = scrollNode.clientHeight;
      const newMax = parkedTop - 120;
      expect(newMax).toBeGreaterThan(0);
      setLegendListScrollContainerScrollHeightOverride(newMax + clientHeight);
      try {
        act(() => {
          // Bare DOM write landing within 1px of the new max - the exact
          // browser-clamp shape (list state still at parkedTop → mismatch,
          // so state-equality does NOT silence; the clamp predicate must).
          scrollNode.scrollTop = newMax;
          fireEvent.scroll(scrollNode);
        });
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
        expect(getScrollNode().scrollTop).toBe(newMax);
      } finally {
        setLegendListScrollContainerScrollHeightOverride(null);
      }
    });

    it("(fresh-open / settle re-issue) undershoot-then-reissue during anchor settle never leaves anchoring-new-turn", async () => {
      // Ticket 10/18 F2-style: force the first large programmatic jumps
      // short of target so the settle loop re-issues. Ticket 19's capture
      // classifier must treat those issue/reissue DOM moves as
      // library-owned (guard 2: active-motion ref armed across the
      // scrollToIndex call; and/or state pre-write on non-animated path),
      // never as a scroll-only departure.
      //
      // Load-bearing shape: wrap list.scrollToIndex/scrollToOffset so each
      // real LegendList call also fires a capture-phase `scroll` event
      // (jsdom never auto-dispatches). Without that wrap the classifier is
      // dead code and this pin stays green under a maximally-broken
      // "cancel every owned scroll" mutation. F2 undershoot stays in place
      // so issue/reissue actually cycles; the fire happens inside the spy
      // while activeAnchorImperativeMotionGenerationRef is still armed.
      const history = makeCompletedTranscript(40);
      const sendId = "t19-reissue-silence-send";
      const { rerenderMessages } = renderChatMessages({
        messages: history,
        scrollStateKey: "t19-reissue-silence-key",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      const scrollNode = getScrollNode();
      const modesAtCapture: Array<string | undefined> = [];
      const wrapper = screen.getByTestId("chat-transcript-container");
      const captureObserver = (event: Event): void => {
        if (event.target !== scrollNode) return;
        modesAtCapture.push(scrollNode.dataset.scrollMode);
      };
      wrapper.addEventListener("scroll", captureObserver, { capture: true });

      // Local F2-style undershoot (same shape as ticket 18's helper).
      let remainingCorrupt = 2;
      let stored = scrollNode.scrollTop;
      const undershootPx = 500;
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
          if (remainingCorrupt > 0 && Math.abs(numeric - stored) > 80) {
            remainingCorrupt -= 1;
            stored =
              numeric > stored
                ? Math.max(0, numeric - undershootPx)
                : numeric + undershootPx;
            return;
          }
          stored = numeric;
        },
      });

      const dispatch = installLibraryScrollCaptureDispatch();
      try {
        const afterSend = appendOptimisticUserSend(history, sendId, 700_000);
        rerenderMessages(afterSend);
        await waitFor(() => {
          expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
        });
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
        await act(async () => {
          await new Promise<void>((resolve) => {
            setTimeout(
              resolve,
              (CHAT_TIMELINE_ANCHOR_SCROLL_PROMISE_TIMEOUT_MS + 100) * 5,
            );
          });
        });
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
        // Classifier actually ran: at least one capture-phase sample from
        // the scrollToIndex wrap, all while still anchoring.
        expect(dispatch.scrollToIndexCallCount()).toBeGreaterThan(0);
        expect(modesAtCapture.length).toBeGreaterThan(0);
        for (const mode of modesAtCapture) {
          expect(mode).toBe("anchoring-new-turn");
        }
      } finally {
        dispatch.dispose();
        wrapper.removeEventListener("scroll", captureObserver, {
          capture: true,
        });
        Reflect.deleteProperty(scrollNode, "scrollTop");
        scrollNode.scrollTop = stored;
      }
    });

    it("(fresh-open instant positioning) mount-time freshOpen seed never cancels itself via the capture classifier", async () => {
      // Decision #15: fresh-open with no saved scroll state seeds
      // anchoring-new-turn and positions non-animated at mount. That
      // initial positioning (and any settle re-issue it triggers) must not
      // be misclassified as a scroll-only departure.
      //
      // After settle, explicitly fire a capture-phase scroll at the
      // post-position DOM (library state already synchronized) so the
      // classifier runs. A "cancel every owned scroll" mutation must
      // redden this pin; without the fire it stayed green vacuously.
      const messages = makeCompletedTranscript(24);
      const scrollStateKey = `t19-fresh-open-silence-${Math.random().toString(36).slice(2)}`;
      expect(
        hasSavedChatTabState(makeDefaultTestIdentity(scrollStateKey)),
      ).toBe(false);

      renderChatMessages({
        messages,
        scrollStateKey,
        freshOpen: true,
      });
      // Mode seed is sync; capture listener is mounted via layout effect.
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await settleLegendList();
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await waitFor(() => {
        expect(screen.getByTestId("mock-message-message-22")).toBeTruthy();
      });

      // Deliver the capture event the harness never auto-fires after the
      // bootstrap scroll path. List state matches DOM → healthy silence;
      // a broken always-cancel classifier trips free-scrolling here.
      await fireCaptureScrollAfterLibraryWrite();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
    });

    it("(hydration-retry navigation) navigateToMessage cancels anchoring before its own scroll - capture does not misclassify the landing", async () => {
      // Design audit: "Hydration-retry navigation" - navigateToMessage
      // cancels ownership BEFORE issuing its own scroll (chat-messages.tsx),
      // so the capture classifier sees an unowned session for that landing.
      //
      // Load-bearing proof is cancel-first ordering observed AT CAPTURE:
      // wrap scrollToOffset/scrollToIndex so the landing write fires a
      // real capture-phase scroll, and assert mode is already
      // free-scrolling when that event is observed (not still
      // anchoring-new-turn). Ending free-scrolling alone is not enough -
      // without a capture fire the classifier never runs.
      //
      // Note on mutation shape: a "cancel every owned scroll" mutation
      // does NOT redden this pin by design - the landing event is already
      // unowned (`isAnchoringSessionOwned=false`). The capture-phase mode
      // sample is the load-bearing assertion for cancel-first ordering.
      const messages = makeCompletedTranscript(20);
      const sendId = "t19-hydration-nav-send";
      const targetId = messages[4]?.id;
      expect(targetId).toBeTruthy();
      const { rerenderMessages, rerenderWith } = renderChatMessages({
        messages,
        scrollStateKey: "t19-hydration-nav-key",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();
      const afterSend = appendOptimisticUserSend(messages, sendId, 700_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      const scrollNode = getScrollNode();
      const modesAtCapture: Array<string | undefined> = [];
      const wrapper = screen.getByTestId("chat-transcript-container");
      const captureObserver = (event: Event): void => {
        if (event.target !== scrollNode) return;
        modesAtCapture.push(scrollNode.dataset.scrollMode);
      };
      wrapper.addEventListener("scroll", captureObserver, { capture: true });
      const dispatch = installLibraryScrollCaptureDispatch();
      try {
        rerenderWith({
          scrollRequest: {
            messageId: targetId,
            blockId: null,
            requestId: 19_001,
          },
        });
        await waitForNavigationSettle();
        // Also flush one explicit capture in case the nav path used a
        // route that did not go through the wrapped list methods.
        await fireCaptureScrollAfterLibraryWrite();

        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
        expect(getScrollNode().dataset.scrollMode).not.toBe(
          "anchoring-new-turn",
        );
        // Capture-phase evidence: the classifier ran (at least one scroll
        // event reached the wrapper). dataset.scrollMode can lag one React
        // paint behind the ref cancel (cancel sets timelineScrollModeRef
        // synchronously but setScrollMode is async), so samples taken
        // mid-navigateToMessage may still read anchoring-new-turn on the
        // DOM attribute even though the classifier already saw unowned via
        // the ref. After settle the attribute is free-scrolling; the final
        // fire above must stay free-scrolling (classifier silent for
        // unowned). That post-settle capture is the cancel-first proof
        // that does not race React paint.
        expect(modesAtCapture.length).toBeGreaterThan(0);
        expect(modesAtCapture[modesAtCapture.length - 1]).toBe(
          "free-scrolling",
        );
      } finally {
        dispatch.dispose();
        wrapper.removeEventListener("scroll", captureObserver, {
          capture: true,
        });
      }
    });

    it("(disclosure preservation) a disclosure helper correction during settled anchoring does not cancel the session", async () => {
      // Design audit: "Disclosure preservation correction" - non-animated
      // scrollToOffset advances list state before DOM, so the classifier's
      // state-equality path silences it. After the helper writes, explicitly
      // fire capture-phase scroll (jsdom never does) so a broken always-
      // cancel classifier would free-scroll and redden this pin.
      const history = makeCompletedTranscript(10);
      const sendId = "t19-disclosure-silence-send";
      const { rerenderMessages } = renderChatMessages({
        messages: history,
        scrollStateKey: "t19-disclosure-silence-key",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();
      const afterSend = appendOptimisticUserSend(history, sendId, 830_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      await waitFor(() => {
        expect(legendListRefHolder.current).not.toBeNull();
      });
      const list = legendListRefHolder.current;
      if (!list) throw new Error("expected LegendListRef to be attached");
      // Auto-fire capture scroll on every library scroll write the helper
      // or geometry-repair path issues during mutate.
      const dispatch = installLibraryScrollCaptureDispatch();

      const DISCLOSURE_DELTA_PX = 180;
      const anchorElement = document.createElement("div");
      const rectSpy = vi.spyOn(anchorElement, "getBoundingClientRect");
      rectSpy.mockReturnValueOnce({
        x: 0,
        y: 100,
        width: 100,
        height: 20,
        top: 100,
        left: 0,
        right: 100,
        bottom: 120,
        toJSON: () => ({}),
      });
      rectSpy.mockReturnValueOnce({
        x: 0,
        y: 100 + DISCLOSURE_DELTA_PX,
        width: 100,
        height: 20,
        top: 100 + DISCLOSURE_DELTA_PX,
        left: 0,
        right: 100,
        bottom: 120 + DISCLOSURE_DELTA_PX,
        toJSON: () => ({}),
      });

      try {
        act(() => {
          preserveChatScrollAcrossDisclosureChange({
            list,
            anchorElement,
            mutate: () => {
              legendListRefHolder.current?.setItemSize("message-2", {
                height: 90 + DISCLOSURE_DELTA_PX,
                width: VIEWPORT_WIDTH_PX,
              });
            },
            correctionOwnedByMvcp: false,
          });
        });
        await waitForRevealPassTick();
        await waitForRevealPassTick();
        // Final capture flush: covers any write that bypassed the wrap and
        // ensures at least one classifier invocation while still owned.
        await fireCaptureScrollAfterLibraryWrite();

        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
        expect(
          dispatch.scrollToOffsetCallCount() +
            dispatch.scrollToIndexCallCount(),
        ).toBeGreaterThan(0);
      } finally {
        dispatch.dispose();
        rectSpy.mockRestore();
      }
    });

    it("(setup-card weave) mid-anchoring setup-card retarget does not cancel via the capture classifier", async () => {
      // Design audit: "Setup-card weave/anchor retarget" is the composition
      // of MVCP data adjustment + a new anchor issue under the current
      // settle generation. Wrap list scroll APIs (and polyfill scrollBy for
      // MVCP) so every library-owned DOM write delivers a capture-phase
      // scroll - without that the classifier is never invoked and a
      // broken always-cancel mutation would leave this pin green.
      const initial = makeCompletedTranscript(6);
      const sendId = "t19-setup-card-weave-send";
      const { rerenderMessages } = renderChatMessages({
        messages: initial,
        scrollStateKey: "t19-setup-card-weave-key",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();
      const afterSend = appendOptimisticUserSend(initial, sendId, 500_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      const scrollBeforeCard = getScrollNode().scrollTop;

      const scrollNode = getScrollNode();
      const originalScrollBy = scrollNode.scrollBy.bind(scrollNode);
      // `Element.scrollBy`'s overloaded native signature (`(options?)` /
      // `(x, y)`) genuinely permits fewer arguments than this polyfill
      // declares - house style bans `?:` (a caller-omittable parameter),
      // but the caller here is jsdom/LegendList's own internal invocation,
      // not code this file controls, so the params stay required-typed
      // (`| undefined`) and the assignment cast documents the real,
      // load-bearing arity gap instead of a redundant one: every code path
      // already treats a missing value as `undefined` correctly.
      scrollNode.scrollBy = ((
        options: ScrollToOptions | number | undefined,
        yArg: number | undefined,
      ): void => {
        if (typeof options === "number") {
          scrollNode.scrollLeft += options;
          scrollNode.scrollTop += typeof yArg === "number" ? yArg : 0;
        } else if (options && typeof options === "object") {
          if (typeof options.left === "number") {
            scrollNode.scrollLeft += options.left;
          }
          if (typeof options.top === "number") {
            scrollNode.scrollTop += options.top;
          }
        }
        fireEvent.scroll(scrollNode);
      }) as typeof scrollNode.scrollBy;

      const dispatch = installLibraryScrollCaptureDispatch();
      try {
        const sendIndex = afterSend.findIndex(
          (message) => message.id === sendId,
        );
        const card = setupCardRow(
          `setup-card:owner-1:0:${sendId}`,
          499_999,
          sendId,
        );
        const afterCard: ReadonlyArray<ChatMessageModel> = [
          ...afterSend.slice(0, sendIndex),
          card,
          ...afterSend.slice(sendIndex),
        ];
        rerenderMessages(afterCard);
        await waitForAnchorEngineSettle();
        // Explicit capture flush after settle so a retarget path that
        // only repositioned via already-fired wraps still has a final
        // owned event for the classifier to silence.
        await fireCaptureScrollAfterLibraryWrite();

        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
        expect(screen.getByTestId(`mock-message-${card.id}`)).toBeTruthy();
        // Uniform 90px rows: card takes the send's prior slot → same
        // scrollTop after a correct retarget (ticket 13 pin d geometry).
        expect(getScrollNode().scrollTop).toBe(scrollBeforeCard);
      } finally {
        dispatch.dispose();
        scrollNode.scrollBy = originalScrollBy;
      }
    });

    it("(endInset / lower-dock resize) composerOverlayHeight change while anchoring does not cancel the session", async () => {
      // Design audit: "endInset / lower-dock resize" - LegendList may
      // reprocess or requestAdjust on contentInsetEndAdjustment changes;
      // a pure max shrink uses the clamp predicate. Either path must stay
      // silent. After the prop change, fire a capture-phase scroll so the
      // classifier actually runs (library state equals DOM → silence;
      // broken always-cancel while owned → free-scrolling).
      const sendId = "t19-endinset-silence-send";
      const messages = makeCompletedTranscript(20);
      const { rerenderMessages, rerenderWith } = renderChatMessages({
        messages,
        scrollStateKey: "t19-endinset-silence-key",
        localProvenanceMessageIds: new Set([sendId]),
        composerOverlayHeight: 80,
      });
      await settleLegendList();
      const afterSend = appendOptimisticUserSend(messages, sendId, 700_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      const scrollBefore = getScrollNode().scrollTop;

      const scrollNode = getScrollNode();
      const originalScrollBy = scrollNode.scrollBy.bind(scrollNode);
      // `Element.scrollBy`'s overloaded native signature (`(options?)` /
      // `(x, y)`) genuinely permits fewer arguments than this polyfill
      // declares - house style bans `?:` (a caller-omittable parameter),
      // but the caller here is jsdom/LegendList's own internal invocation,
      // not code this file controls, so the params stay required-typed
      // (`| undefined`) and the assignment cast documents the real,
      // load-bearing arity gap instead of a redundant one: every code path
      // already treats a missing value as `undefined` correctly.
      scrollNode.scrollBy = ((
        options: ScrollToOptions | number | undefined,
        yArg: number | undefined,
      ): void => {
        if (typeof options === "number") {
          scrollNode.scrollLeft += options;
          scrollNode.scrollTop += typeof yArg === "number" ? yArg : 0;
        } else if (options && typeof options === "object") {
          if (typeof options.left === "number") {
            scrollNode.scrollLeft += options.left;
          }
          if (typeof options.top === "number") {
            scrollNode.scrollTop += options.top;
          }
        }
        fireEvent.scroll(scrollNode);
      }) as typeof scrollNode.scrollBy;
      const dispatch = installLibraryScrollCaptureDispatch();
      try {
        rerenderWith({ composerOverlayHeight: 240 });
        await settleLegendList();
        await waitForRevealPassTick();
        // Ensure the classifier sees at least one event while still owned
        // even if inset change produced no library write in this harness.
        await fireCaptureScrollAfterLibraryWrite();

        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
        expect(getScrollNode().dataset.scrollMode).not.toBe("free-scrolling");
        expect(Math.abs(getScrollNode().scrollTop - scrollBefore)).toBeLessThan(
          500,
        );
      } finally {
        dispatch.dispose();
        scrollNode.scrollBy = originalScrollBy;
      }
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
            turnReplyText: "partial",
          },
          runState: null,
        },
      ]);
      await settleLegendList();

      expect(live?.textContent ?? "").toBe("");
    });
  });

  describe("H2 intent-listener lifecycle across empty/repopulate", () => {
    it("attaches cancel-on-gesture listeners after empty -> first messages", async () => {
      const { rerenderMessages } = renderChatMessages({
        messages: [],
        scrollStateKey: "h2-empty-first",
      });
      // Empty transcript: no LegendList / no scroll node yet.
      expect(screen.queryByTestId("chat-messages-scroll")).toBeNull();

      const messages = makeTranscript(16);
      rerenderMessages(messages);
      await settleLegendList();

      const scrollNode = getScrollNode();
      fireEvent.wheel(scrollNode, { deltaY: -80 });
      scrollNode.scrollTop = 100;
      fireEvent.scroll(scrollNode);
      const parked = getScrollNode().scrollTop;

      rerenderMessages(appendAssistant(messages, "h2-stream", 50_000));
      await settleLegendList();
      // Listener attached after first content → free-scrolling, stream parked.
      expect(getScrollNode().scrollTop).toBe(parked);
    });

    it("re-arms listeners after non-empty -> empty -> repopulated", async () => {
      const messages = makeTranscript(16);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "h2-repopulate",
      });
      await settleLegendList();

      // Tear down the LegendList (empty state).
      rerenderMessages([]);
      expect(screen.queryByTestId("chat-messages-scroll")).toBeNull();

      // New node after repopulate - listeners must re-attach (hasContent toggle).
      const again = makeTranscript(18);
      rerenderMessages(again);
      await settleLegendList();

      const scrollNode = getScrollNode();
      fireEvent.pointerDown(scrollNode);
      scrollNode.scrollTop = 120;
      fireEvent.scroll(scrollNode);
      const parked = getScrollNode().scrollTop;

      rerenderMessages(appendAssistant(again, "h2-repop-stream", 60_000));
      await settleLegendList();
      expect(getScrollNode().scrollTop).toBe(parked);
    });
  });

  describe("H3 suppressFollowRestoreRef persists across programmatic scrolls, cleared only by a real gesture", () => {
    it("suffix removal whose viewport touched the removed region enters following-end (ticket 17 case b; no free-scrolling suppress path)", async () => {
      // Pre-ticket-17 free-scrolling suffix removal did scroll-to-index +
      // nextMode:null + suppressFollowRestoreRef and this test pinned H3
      // multi-report free-scrolling survival. Ticket 17: with scrollTop 0 the
      // last visible row is early in the list - at/past firstRemovedIndex
      // after shrinking to 3 rows - so classification is case (b): force
      // following-end + scroll-to-end. H3 suppress multi-report coverage for
      // free-scrolling programmatic landings lives on the minimap test below.
      const messages = makeTranscript(30);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "h3-suffix-multi-report",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      expect(isJumpPillVisible()).toBe(true);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      const next = messages.slice(0, 3);
      rerenderMessages(next);
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
    });

    it("minimap/navigateToMessage (animated) stays free-scrolling across false->true intermediate frames, then across a stream append", async () => {
      const messages = makeTranscript(24);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "h3-minimap-multi-report",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();

      // Select a near-tail user message on the minimap rail (last human
      // row). navigateToMessage's scroll is ANIMATED - the installed
      // LegendList forwards every native scroll event during the
      // animation, so several `false` reports (still moving toward the
      // target) arrive BEFORE the terminal `true`.
      await selectLastChatTurnMinimapItem();

      const scrollNode = getScrollNode();
      const settledScrollTop = Math.max(
        0,
        scrollNode.scrollHeight - scrollNode.clientHeight,
      );

      // Two intermediate "still animating toward the target" frames. Checked
      // via `dataset.scrollMode`, not pill visibility - the shim's fixed
      // `scrollHeight` (400 rows * 90px) is far beyond this 24-row
      // transcript's REAL measured content, so every one of these
      // `settledScrollTop`-derived offsets is already past the real content
      // end (confirmed: `isAtEnd: true` from the very first report) -
      // Ticket 11 fix #2's reader-position mirror correctly tracks that,
      // which is the point of this test (mode/suppression persistence), not
      // a claim about the pill's own decision-#16 visibility.
      await fireScrollTopAndFlush(Math.max(0, settledScrollTop - 500));
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      await fireScrollTopAndFlush(Math.max(0, settledScrollTop - 150));
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // Terminal `true` report at the animation's destination. A one-shot
      // token was already consumed by the FIRST intermediate `false` report
      // above, so THIS is the exact report that leaks under that design.
      await fireScrollTopAndFlush(settledScrollTop);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // Duplicate/correction true report - a slightly different scrollTop,
      // still within the near-end band, so LegendList does not skip it as a
      // no-op.
      await fireScrollTopAndFlush(Math.max(0, settledScrollTop - 20));
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // Settle (scrollend). Still free - the operation's own reports never
      // restored follow.
      act(() => {
        scrollNode.dispatchEvent(new Event("scrollend"));
      });
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // Suppression is never cleared by settle alone (only a real gesture or
      // an explicit following-end transition clears it), and mode is still
      // free-scrolling regardless - a subsequent stream append must not
      // auto-follow either.
      const parkedAfterSettle = scrollNode.scrollTop;
      rerenderMessages(appendAssistant(messages, "h3-nav-stream", 80_000));
      await settleLegendList();
      expect(getScrollNode().scrollTop).toBe(parkedAfterSettle);
    });

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

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
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

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
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

    it("a bare pointerdown mid-flight freezes the animated scroll and disarms a stray late edge echo", async () => {
      const messages = makeTranscript(24);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "h3-pointerdown-freeze",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();

      // Animated navigateToMessage (sets suppression).
      await selectLastChatTurnMinimapItem();

      const scrollNode = getScrollNode();
      const settledScrollTop = Math.max(
        0,
        scrollNode.scrollHeight - scrollNode.clientHeight,
      );
      const midFlight = Math.max(0, settledScrollTop - 500);

      // Mid-flight intermediate frame (still suppressed). Checked via
      // `dataset.scrollMode`, not pill visibility - the shim's fixed
      // `scrollHeight` puts every one of these `settledScrollTop`-derived
      // offsets past this 24-row transcript's REAL content end, so
      // Ticket 11 fix #2/#3 correctly treat them as "at the live edge" and
      // hide the pill; mode persistence (this test's actual claim) is
      // unaffected.
      await fireScrollTopAndFlush(midFlight);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // A bare pointerdown - NO accompanying scroll - is decision #6's "ANY
      // pointerdown relinquishes follow/anchor ownership" (text selection,
      // expanding a card). Unlike wheel/touch, it produces no scroll of its
      // own, so the browser's native smooth-scroll animation would keep
      // running unless explicitly frozen.
      act(() => {
        fireEvent.pointerDown(scrollNode);
      });
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // Deliver what would have been the operation's terminal near-end
      // report, as if an already-in-flight native animation frame still
      // fired one more time despite the freeze (a jsdom-only worst case - a
      // real browser's scrollTo/scrollTop write reliably cancels the native
      // smooth-scroll immediately). Must NOT reverse the cancellation.
      await fireScrollTopAndFlush(settledScrollTop);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // The viewport must not keep moving on top of that either: a
      // subsequent stream append does not auto-follow.
      const parked = scrollNode.scrollTop;
      rerenderMessages(appendAssistant(messages, "h3-freeze-stream", 90_000));
      await settleLegendList();
      expect(scrollNode.scrollTop).toBe(parked);
    });

    it.each([-40, 40])(
      "height-shift: wheel delta %s during the initial send landing freezes the anchor animation before the reader scroll takes over",
      async (deltaY) => {
        const direction = deltaY < 0 ? "up" : "down";
        const sendId = `height-shift-mid-anchor-wheel-${direction}`;
        const messages = makeCompletedTranscript(4);
        const { rerenderMessages } = renderChatMessages({
          messages,
          scrollStateKey: `height-shift-mid-anchor-wheel-${direction}`,
          localProvenanceMessageIds: new Set([sendId]),
        });
        await settleLegendList();

        const afterSend = appendOptimisticUserSend(messages, sendId, 701_000);
        rerenderMessages(afterSend);
        // React replaces Legend List's imperative-handle object on rerender,
        // so intercept the post-send handle before the anchor's queued rAFs
        // issue their animated scroll.
        const list = legendListRefHolder.current;
        if (list === null) throw new Error("Expected an attached LegendList");
        const realScrollToIndex = list.scrollToIndex.bind(list);
        const animatedScrollControl = { release: (): void => undefined };
        const animationStillInFlight = new Promise<void>((resolve) => {
          animatedScrollControl.release = resolve;
        });
        vi.spyOn(list, "scrollToIndex").mockImplementation((options) => {
          const realCompletion = realScrollToIndex(options);
          return options.animated
            ? Promise.all([realCompletion, animationStillInFlight]).then(
                () => undefined,
              )
            : realCompletion;
        });
        await waitFor(() => {
          expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
        });
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

        // Let the two-rAF anchor chain issue its animated scrollToIndex, but do
        // not wait for its settle watchdog. `height-shift.mov` gestures in this
        // exact interval: the first wheel moves toward history, then the native
        // anchor animation keeps advancing and pulls the query back upward.
        await waitForRevealPassTick();
        expect(list.scrollToIndex).toHaveBeenCalledWith(
          expect.objectContaining({ animated: true }),
        );
        const scrollNode = getScrollNode();
        const scrollAtGesture = scrollNode.scrollTop;
        const reservedContentLength = list.getState().contentLength;
        const freezeSpy = vi.spyOn(list, "scrollToOffset");
        freezeSpy.mockClear();

        fireEvent.wheel(scrollNode, { deltaY });

        expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
        expect(freezeSpy).toHaveBeenCalledWith({
          offset: scrollAtGesture,
          animated: false,
        });

        // Model the wheel's native default movement after the passive listener.
        // The canceled anchor operation must neither resume nor reissue over it.
        const readerPosition = Math.max(
          0,
          scrollAtGesture + Math.sign(deltaY) * 40,
        );
        await fireScrollTopAndFlush(readerPosition);
        await waitForAnchorEngineSettle();
        expect(scrollNode.scrollTop).toBe(readerPosition);
        expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
        expect(list.getState().contentLength).toBeGreaterThanOrEqual(
          reservedContentLength,
        );
        animatedScrollControl.release();
      },
    );

    it("a pointerdown freeze with NO stale echo still allows a later toward-end gesture to resume", async () => {
      const messages = makeTranscript(24);
      renderChatMessages({
        messages,
        scrollStateKey: "h3-pointerdown-freeze-no-echo",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
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

    it("H1 review fix: a bare pointerdown mid-animation during a PILL-CLICK scrollToEnd still freezes (suppression alone under-covers this path)", async () => {
      // Root cause: scrollToEnd's pill-click path clears
      // suppressFollowRestoreRef unconditionally (setTimelineMode
      // ("following-end") - an explicit go-live) BEFORE its own ANIMATED
      // scroll settles. The freeze in cancelTimelineLiveFollowForUserNavigation
      // was gated solely on suppression, so a bare pointerdown mid-animation
      // found nothing to freeze - the native smooth-scroll kept running and
      // its terminal near-end report re-enabled following against the
      // cancellation. Explicit animated-operation ownership closes that gap
      // independently of suppression or the rendered mode.
      const messages = makeTranscript(24);
      renderChatMessages({
        messages,
        scrollStateKey: "h1-pill-click-freeze",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();

      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Scroll to end" }));
      });
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");

      const scrollNode = getScrollNode();

      // A bare pointerdown - NO accompanying scroll - mid-animation (no
      // scrollend/750ms fallback has fired yet). Decision #6: cancels follow
      // AND must freeze the still-in-flight scrollToEnd animation.
      act(() => {
        fireEvent.pointerDown(scrollNode);
      });
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // Deliver what would be the animation's own terminal near-end report,
      // as if it kept running unfrozen (the actual bug) or a stale frame
      // still fired despite the freeze. Must NOT reverse the cancellation.
      act(() => {
        fireScrollToEnd();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
    });

    it("Round-2 finding 1: a bare pointerdown mid-animation during the STANDARD SEND-ANCHOR path still freezes (the anchor engine's own animated scroll must be covered by the same freeze condition)", async () => {
      // Root cause: EVERY real send/steer/edit/queued-flush/A2A anchor is
      // ANIMATED (decision #12) and beginAnchoringNewTurn clears
      // suppressFollowRestoreRef unconditionally - the same gap the pill-click
      // pin above closes, but reachable via the single most ordinary path in
      // the whole app: send a message, then pointerdown to select text while
      // the anchor is still animating into position. The anchor registers
      // that animated operation explicitly, so cancellation does not have to
      // guess from the rendered mode.
      const sendId = "round2-f1-send";
      const messages = makeCompletedTranscript(10);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "round2-f1-anchor-freeze",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      const afterSend = appendOptimisticUserSend(messages, sendId, 700_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      // Let the anchor engine's OWN async chain (onAnchorReady -> two nested
      // requestAnimationFrame calls inside positionAnchor) actually ISSUE its
      // ANIMATED scrollToIndex WITHOUT waiting for its full settle
      // (CHAT_ANCHOR_SETTLE_FALLBACK_MS is 750ms; this is ~2 frames + 20ms,
      // deliberately short of that) - the operation still owns its landing.
      await waitForRevealPassTick();

      const scrollNode = getScrollNode();

      // A bare pointerdown - NO accompanying scroll - mid-animation. Decision
      // #6: cancels follow AND must freeze the anchor engine's still-in-flight
      // positioning animation (round-2 finding 1 - this is the coverage that
      // was missing pre-fix, when the freeze condition read suppression
      // alone).
      act(() => {
        fireEvent.pointerDown(scrollNode);
      });
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // Deliver what would be the animation's own terminal near-end report,
      // as if it kept running unfrozen. Must NOT reverse the cancellation.
      act(() => {
        fireScrollToEnd();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
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

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
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
      // animation. Op1's older generation cannot clear op2's active one,
      // regardless of its pending or fired settle callback.
      act(() => {
        fireEvent.pointerDown(scrollNode);
      });
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      act(() => {
        fireScrollToEnd();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
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

    it("stays visible but leaves a narrow epic canvas transcript interactive", async () => {
      const messages = makeTranscript(20);
      renderChatMessages({ messages, scrollStateKey: "always-on-minimap" });
      // The rail stays painted as an orientation aid, but its transparent hit
      // strip must not cover transcript text when the centered content column
      // consumes the full pane width.
      mockNarrowTranscriptWidth(420);
      await settleLegendList();

      const rail = screen.getByTestId("chat-turn-minimap");
      const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
      expect(rail.classList).toContain("opacity-100");
      expect(rail.classList).not.toContain("opacity-0");
      expect(hitStrip.hasAttribute("inert")).toBe(true);
      expect(hitStrip.getAttribute("aria-hidden")).toBe("true");
      expect(hitStrip.classList.contains("pointer-events-none")).toBe(true);
      expect(hitStrip.tabIndex).toBe(-1);
      expect(
        screen.queryByRole("button", { name: "Message minimap" }),
      ).toBeNull();
    });

    it("stays interactive at the harness's default pane width", async () => {
      const messages = makeTranscript(20);
      renderChatMessages({ messages, scrollStateKey: "m3b-usable-hit-strip" });
      await settleLegendList();

      const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
      expect(hitStrip.hasAttribute("inert")).toBe(false);
      expect(hitStrip.getAttribute("aria-hidden")).toBeNull();
      expect(hitStrip.classList.contains("pointer-events-auto")).toBe(true);
      expect(screen.getByRole("button", { name: "Message minimap" })).toBe(
        hitStrip,
      );
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

  // O2 (ticket 16 listener consolidation, F8): proves the FULL production
  // chain end to end - a real LegendList scroll -> ChatTimeline's own
  // `onScroll` -> ChatMessages's `handleScroll` ->
  // `minimapInViewRefreshRef.current()` -> the minimap's `updateInView` ->
  // the strip's `data-in-view` dataset write. chat-turn-minimap.test.tsx's
  // own pins call `inViewRefreshRef.current()` directly (proving the
  // minimap's OWN contract in isolation); this one is the wiring pin that a
  // deleted link anywhere in that chain would fail.
  describe("minimap in-view highlighting via the real scroll chain (O2, ticket 16)", () => {
    it("updates minimap strip in-view state through a real fireEvent.scroll, not a direct inViewRefreshRef call", async () => {
      const messages = makeCompletedTranscript(12);
      renderChatMessages({
        messages,
        scrollStateKey: "o2-minimap-real-scroll-chain",
      });
      await settleLegendList();

      // Free-scrolling, not the default following-end - a stable, non-
      // drifting position (M3b's own comment above: following-end's reveal
      // pass keeps chasing the jsdom shim's fixed large scrollHeight).
      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();

      await waitFor(() => {
        expect(screen.getByTestId("chat-turn-minimap")).toBeTruthy();
      });

      const firstUserStrip = (): Element | null =>
        document.querySelector(
          '[data-chat-turn-minimap-strip][data-message-id="message-0"]',
        );
      const lastUserStrip = (): Element | null =>
        document.querySelector(
          '[data-chat-turn-minimap-strip][data-message-id="message-10"]',
        );

      // Parked at scrollTop 0: the first user turn is in view, the last is not.
      await waitFor(() => {
        expect(firstUserStrip()?.getAttribute("data-in-view")).toBe("true");
        expect(lastUserStrip()?.getAttribute("data-in-view")).toBe("false");
      });

      // Scroll deep into real (non-fake-ceiling) content - well below the
      // ~540px natural max for this 12-row/90px-shim transcript.
      await fireScrollTopAndFlush(500);

      await waitFor(() => {
        expect(lastUserStrip()?.getAttribute("data-in-view")).toBe("true");
        expect(firstUserStrip()?.getAttribute("data-in-view")).toBe("false");
      });
    });
  });

  describe("intent-latched strict-edge follow", () => {
    it("keeps a sub-pixel upward departure detached across repeated streaming row growth", async () => {
      const messages = makeTranscript(20);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "scroll-push-subpixel-departure",
      });
      await settleLegendList();

      // `scroll-push.mov`: the first slow trackpad samples move less than
      // Legend List's one-pixel strict-edge epsilon. Geometry therefore still
      // says isAtEnd=true, but the negative wheel has already declared the
      // reader's intent to leave and must revoke follow synchronously.
      const scrollNode = getScrollNode();
      const atEnd = scrollNode.scrollTop;
      fireEvent.wheel(scrollNode, { deltaY: -0.1 });
      await fireScrollTopAndFlush(atEnd - 0.25);
      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
      expect(isJumpPillVisible()).toBe(false);

      // Grow the SAME live assistant row several times. Each pass exercises
      // both the messages-driven reveal scheduler and Legend List's genuine
      // item-layout path. None may translate repeated edge geometry back into
      // follow intent or erase the 0.25px reading departure.
      const tailId = messages.at(-1)?.id;
      if (tailId === undefined) throw new Error("Expected a transcript tail");
      let current = messages;
      for (let growth = 0; growth < 3; growth += 1) {
        current = current.map((message) =>
          message.id === tailId
            ? {
                ...message,
                content: `${message.content}\nstream growth ${growth}`,
              }
            : message,
        );
        rerenderMessages(current);
        act(() => {
          legendListRefHolder.current?.setItemSize(tailId, {
            height: 120 + growth * 40,
            width: VIEWPORT_WIDTH_PX,
          });
        });
        await waitForRevealPassTick();
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
        expect(getScrollNode().scrollTop).toBe(atEnd - 0.25);
      }

      // A later, explicit toward-end gesture arms exactly one legitimate
      // strict-edge transition. Geometry still cannot do this on its own.
      fireEvent.wheel(scrollNode, { deltaY: 0.1 });
      await fireScrollTopAndFlush(atEnd);
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
    });

    it("still shows the pill when a gesture genuinely leaves the near-end band", async () => {
      const messages = makeTranscript(20);
      renderChatMessages({
        messages,
        scrollStateKey: "m1-leave-band",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      expect(isJumpPillVisible()).toBe(true);
    });
  });

  describe("M2 onEndReachedThreshold 10% (not library default 50%)", () => {
    it("treats a ~200px distance-from-end park as NOT near-end (pill stays)", async () => {
      // Library math: isNearEnd when distanceFromEnd <= onEndReachedThreshold * scrollLength.
      // Default 0.5 → 350px of a 700px viewport; decision #5 wants 0.1 → 70px.
      // A 200px park is near-end under the old default and NOT under 0.1.
      const messages = makeTranscript(40);
      renderChatMessages({
        messages,
        scrollStateKey: "m2-threshold",
        // Zero dock inset so distanceFromEnd is not complicated by content
        // inset end adjustment in this threshold pin.
        composerOverlayHeight: 0,
      });
      await settleLegendList();

      const scrollNode = getScrollNode();
      const settledEnd = scrollNode.scrollTop;
      expect(settledEnd).toBeGreaterThan(0);

      act(() => {
        fireEvent.wheel(scrollNode, { deltaY: -40 });
      });

      const distanceFromEnd = 200;
      expect(distanceFromEnd).toBeGreaterThan(scrollNode.clientHeight * 0.1);
      expect(distanceFromEnd).toBeLessThan(scrollNode.clientHeight * 0.5);

      scrollNode.scrollTop = Math.max(0, settledEnd - distanceFromEnd);
      fireEvent.scroll(scrollNode);

      await waitForPillVisible();
      expect(isJumpPillVisible()).toBe(true);
    });
  });

  describe("followEnabled gates LegendList's own maintainScrollAtEnd (review fix)", () => {
    it("free-scrolling parked near the true end does NOT auto-follow a subsequent append", async () => {
      // Pre-ticket-17 setup used free-scrolling suffix removal (H3:
      // scroll-to-index + suppress) to land near the true max while free.
      // Ticket 17: that path is gone (viewport-touching suffix removal
      // forces following-end). Mirror the H3 minimap suppress path: navigate
      // near-tail (sets suppressFollowRestoreRef), settle the operation,
      // park a forced near-end scrollTop under free-scrolling, then assert
      // followEnabled keeps LegendList stick-to-bottom off on append.
      const messages = makeTranscript(30);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "follow-gate-free-near-end",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      expect(isJumpPillVisible()).toBe(true);

      await selectLastChatTurnMinimapItem();
      const scrollNode = getScrollNode();
      // Settle the animated nav (clears in-flight re-issue; suppression stays).
      act(() => {
        scrollNode.dispatchEvent(new Event("scrollend"));
      });
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // Park inside the near-end band under suppress (same trick as H3's
      // multi-report pin - faked scrollHeight is huge, so a large scrollTop
      // is still free-scrolling thanks to suppress, not following-end).
      const nearEndPark = Math.max(
        0,
        scrollNode.scrollHeight - scrollNode.clientHeight - 40,
      );
      await fireScrollTopAndFlush(nearEndPark);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      const parkedScrollTop = getScrollNode().scrollTop;
      rerenderMessages(
        appendAssistant(messages, "follow-gate-stream", 120_000),
      );
      await settleLegendList();

      expect(getScrollNode().scrollTop).toBe(parkedScrollTop);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
    });

    it("following-end still catches up on append when parked at the true end (companion, no regression)", async () => {
      const messages = makeTranscript(20);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "follow-gate-following",
      });
      await settleLegendList();
      expect(isJumpPillVisible()).toBe(false);

      const before = getScrollNode().scrollTop;
      rerenderMessages(
        appendAssistant(messages, "follow-gate-catchup", 130_000),
      );
      await settleLegendList();

      await waitFor(() => {
        expect(getScrollNode().scrollTop).toBeGreaterThan(before);
      });
    });
  });

  describe("following-end catch-up (coverage restore)", () => {
    it("releases follow after a scroll-only upward departure and keeps later growth parked", async () => {
      const messages = makeTranscript(20);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "follow-scroll-only-departure",
      });
      await settleLegendList();

      const scrollNode = getScrollNode();
      const liveEdgeScrollTop = scrollNode.scrollTop;
      expect(liveEdgeScrollTop).toBeGreaterThan(200);

      const streaming = appendAssistant(
        messages,
        "growth-before-scroll-only-departure",
        100_000,
      );
      rerenderMessages(streaming);
      await settleLegendList();
      await waitForRevealPassTick();
      expect(scrollNode.dataset.scrollMode).toBe("following-end");
      expect(scrollNode.scrollTop).toBeGreaterThanOrEqual(liveEdgeScrollTop);

      // jsdom does not emit the terminal event from LegendList's
      // programmatic catch-up, so report the settled owned position before
      // simulating the browser's scroll-only scrollbar-drag event.
      const settledOwnedScrollTop = scrollNode.scrollTop;
      await fireScrollTopAndFlush(settledOwnedScrollTop);
      await fireScrollTopAndFlush(settledOwnedScrollTop - 200);

      await waitFor(() => {
        expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
      });
      await waitForPillVisible();

      const parked = scrollNode.scrollTop;
      rerenderMessages(
        appendAssistant(
          streaming,
          "growth-after-scroll-only-departure",
          100_001,
        ),
      );
      await settleLegendList();
      await waitForRevealPassTick();

      expect(scrollNode.scrollTop).toBe(parked);
      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
    });

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
        // The request shares navigateToMessage's suppression/settle choke
        // point rather than creating an external raw-scroll side channel.
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

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
            stopped: false,
            progress: null,
            startedAt: 0,
            backgroundTask: null,
            parentId: null,
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
          } satisfies BackgroundItem,
        ],
        scrollRequest: {
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
            stopped: false,
            progress: null,
            startedAt: 0,
            backgroundTask: null,
            parentId: null,
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
    it("PageUp and PageDown both cancel follow and step by clientHeight", async () => {
      const messages = makeTranscript(30);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "kbd-page",
      });
      await settleLegendList();

      const scrollNode = getScrollNode();
      // Use the settled content end (not shim scrollHeight) as the range base.
      const settledEnd = scrollNode.scrollTop;
      const mid = Math.floor(settledEnd / 2);
      scrollNode.scrollTop = mid;
      fireEvent.scroll(scrollNode);

      act(() => {
        dispatchKeyInScope("PageDown");
      });
      fireEvent.scroll(getScrollNode());
      const afterDown = getScrollNode().scrollTop;
      // Stepped toward the end by approximately clientHeight (clamped).
      expect(afterDown).toBeGreaterThan(mid);
      expect(afterDown - mid).toBeGreaterThanOrEqual(
        Math.min(CHAT_ARROW_SCROLL_STEP_PX, scrollNode.clientHeight) - 1,
      );

      // Free after PageDown: park well away from end, then stream must not move.
      scrollNode.scrollTop = 40;
      fireEvent.scroll(scrollNode);
      const parkedDown = getScrollNode().scrollTop;
      let next = appendAssistant(messages, "page-down-stream", 110_000);
      rerenderMessages(next);
      await settleLegendList();
      expect(getScrollNode().scrollTop).toBe(parkedDown);

      // Re-follow via pill, then PageUp from a mid offset.
      fireEvent.click(screen.getByRole("button", { name: "Scroll to end" }));
      await settleLegendList();
      const endAgain = getScrollNode().scrollTop;
      getScrollNode().scrollTop = Math.max(0, endAgain - 100);
      fireEvent.scroll(getScrollNode());

      const beforeUp = getScrollNode().scrollTop;
      act(() => {
        dispatchKeyInScope("PageUp");
      });
      fireEvent.scroll(getScrollNode());
      const afterUp = getScrollNode().scrollTop;
      expect(afterUp).toBeLessThan(beforeUp);

      // Free after PageUp: park and stream must not move.
      getScrollNode().scrollTop = 50;
      fireEvent.scroll(getScrollNode());
      const parkedUp = getScrollNode().scrollTop;
      next = appendAssistant(next, "page-up-stream", 120_000);
      rerenderMessages(next);
      await settleLegendList();
      expect(getScrollNode().scrollTop).toBe(parkedUp);
    });

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

    it("claims keys from a sibling in the same canvas pane when the tile is active", async () => {
      const messages = makeTranscript(16);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "kbd-sibling",
        withSiblingChrome: true,
        tileActive: true,
      });
      await settleLegendList();

      const sibling = screen.getByTestId("pane-sibling-chrome");
      act(() => {
        sibling.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "ArrowDown",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      // Claimed: cancel free-scrolling. Park and prove stream does not follow.
      getScrollNode().scrollTop = 50;
      fireEvent.scroll(getScrollNode());
      const parked = getScrollNode().scrollTop;

      rerenderMessages(appendAssistant(messages, "sibling-stream", 130_000));
      await settleLegendList();
      expect(getScrollNode().scrollTop).toBe(parked);
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

    it("on macOS, plain Home is claimed even from an editable target", async () => {
      platformMock.isMac = true;
      const messages = makeTranscript(20);
      renderChatMessages({ messages, scrollStateKey: "kbd-mac-home" });
      await settleLegendList();

      const textarea = document.createElement("textarea");
      document
        .querySelector("[data-chat-keyboard-scroll-scope]")
        ?.appendChild(textarea);

      expect(getScrollNode().scrollTop).toBeGreaterThan(0);
      act(() => {
        textarea.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Home",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      fireEvent.scroll(getScrollNode());
      await waitFor(() => {
        expect(getScrollNode().scrollTop).toBe(0);
      });
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

  describe("ticket 4: anchor engine integration (decisions #8-10, #15-16)", () => {
    it("composer-send optimistic row anchors while free-scrolling, settles, and keeps mode through stream growth (decision #8)", async () => {
      // Honest pin for unconditional local-provenance: free-scroll FIRST so a
      // bug that only anchors while following-end cannot pass. Registry
      // membership (not row shape / persistentMessageId) is the ground truth.
      const messages = makeCompletedTranscript(16);
      const sendId = "user-optimistic-send";
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t4-optimistic-anchor-key",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      // Parked at top: the would-be send row is outside the mounted window.
      expect(screen.queryByTestId(`mock-message-${sendId}`)).toBeNull();

      const afterSend = appendOptimisticUserSend(messages, sendId, 999_000);
      rerenderMessages(afterSend);
      await settleLegendList();

      // Honest #8 pin: free-scrolling + local registry → mode flips and the
      // target row mounts (a following-only bug would leave free-scrolling).
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      await waitForAnchorEngineSettle();
      const scrollAfterSettle = getScrollNode().scrollTop;
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      // Streamed growth after settle: still anchoring; compare two real
      // scrollTops (never a scrollHeight-derived maxScroll). Leaving
      // anchoring-new-turn would be the blank end-space chase regression.
      const afterStream = appendStreamingAssistantChunks(afterSend, 3, 999_000);
      rerenderMessages(afterStream);
      await settleLegendList();
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 100);
        });
      });

      expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      const scrollAfterStream = getScrollNode().scrollTop;
      expect(Math.abs(scrollAfterStream - scrollAfterSettle)).toBeLessThan(
        2_000,
      );
    });

    it("keeps a completed-turn composer send below the top fade and retains its reply viewport after a slight departure", async () => {
      const messages = makeCompletedTranscript(10);
      const sendId = "composer-send-reserve-departure";
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "composer-send-reserve-departure",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      const afterSend = appendOptimisticUserSend(messages, sendId, 205_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();

      const list = legendListRefHolder.current;
      if (list === null) throw new Error("Expected an attached LegendList");
      const sendIndex = afterSend.length - 1;
      const queryViewportTop =
        list.getState().positionAtIndex(sendIndex) +
        LEGEND_LIST_HEADER_PX -
        getScrollNode().scrollTop;
      // The compact fade is 40px tall. The query must start at or below its
      // fully opaque edge instead of the old 16px clipped position.
      expect(queryViewportTop).toBeGreaterThanOrEqual(LEGEND_LIST_HEADER_PX);

      const reservedContentLength = list.getState().contentLength;
      const anchoredScrollTop = getScrollNode().scrollTop;
      fireEvent.wheel(getScrollNode(), { deltaY: -0.1 });
      await fireScrollTopAndFlush(anchoredScrollTop - 0.25);
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().scrollTop).toBe(anchoredScrollTop - 0.25);
      // Detaching the mover must not destroy the independent reply reserve;
      // otherwise the browser clamps the now-shorter range and yanks the
      // viewport exactly as reported.
      expect(list.getState().contentLength).toBeGreaterThanOrEqual(
        reservedContentLength,
      );
    });

    it("distinguishes a scroll-only settle departure from an ordinary anchor undershoot", () => {
      // The initial anchor started at 300 and targets 940. A landing between
      // those positions is an ordinary animated undershoot and must be
      // re-issued; only a position meaningfully ABOVE the starting/target
      // floor means the reader moved upward during the settle window.
      expect(anchorMoverShouldYieldToReader(100, 300, 940)).toBe(true);
      expect(anchorMoverShouldYieldToReader(700, 300, 940)).toBe(false);
    });

    it("overflowing anchored turn (from free-scroll send) shows streaming pill then New reply with no mode flip on completion (decision #10)", async () => {
      // Enough rows to free-scroll away from the would-be send, but not so many
      // that LegendList measurement of the anchor index is flaky under the
      // jsdom shim (overflow metrics need a measured anchor + last row).
      const messages = makeCompletedTranscript(10);
      const sendId = "user-overflow-send";
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t4-overflow-new-reply-key",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(screen.queryByTestId(`mock-message-${sendId}`)).toBeNull();

      const afterSend = appendOptimisticUserSend(messages, sendId, 888_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      // Settle must complete before the reveal pass will accept size growth
      // (positioned === settled). jsdom relies on the 750ms scrollend fallback.
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      // 14 * 90px ≈ 1260 > usable viewport (~580 with endInset 80 + offset 40)
      // so the reveal pass flips anchoredTurnOverflowsViewport → streaming pill.
      const afterOverflow = appendStreamingAssistantChunks(
        afterSend,
        14,
        888_000,
      );
      rerenderMessages(afterOverflow);
      await settleLegendList();
      // Two-rAF reveal pass + state commit for overflowsUsableViewport.
      await act(async () => {
        for (let frame = 0; frame < 6; frame += 1) {
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          });
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 300);
        });
      });

      await waitFor(
        () => {
          expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
          expect(isJumpPillVisible()).toBe(true);
          expect(screen.getByTestId("scroll-to-end-pill-spinner")).toBeTruthy();
          expect(pillVisibleLabel()).toMatch(/…$/);
        },
        { timeout: 4_000 },
      );

      const scrollWhileStreaming = getScrollNode().scrollTop;

      // Complete the trailing assistant while still anchored / not following.
      const trailing = afterOverflow[afterOverflow.length - 1];
      const afterComplete: ReadonlyArray<ChatMessageModel> = [
        ...afterOverflow.slice(0, -1),
        {
          ...trailing,
          completedAt: 1_700_000_000_000,
          runState: null,
        },
      ];
      rerenderMessages(afterComplete);
      await settleLegendList();
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 200);
        });
      });

      // Decision #10: stay anchored - no flip to following-end (that would be
      // the auto-reveal regression). Compare two real scrollTops, never a
      // shim scrollHeight-derived maxScroll.
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      const scrollAfterComplete = getScrollNode().scrollTop;
      expect(Math.abs(scrollAfterComplete - scrollWhileStreaming)).toBeLessThan(
        500,
      );

      await waitFor(
        () => {
          expect(isJumpPillVisible()).toBe(true);
          expect(screen.queryByTestId("scroll-to-end-pill-spinner")).toBeNull();
          expect(pillVisibleLabel()).toContain("New reply");
        },
        { timeout: 3_000 },
      );
    });

    it("second- and third-turn anchor engagement lands at the EXACT anchor offset, not merely 'somewhere far' (live-E2E merge-blocker: multi-turn anchor engagement)", async () => {
      // Row height is uniform (90px, ITEM_HEIGHT_PX) under the jsdom shim,
      // so a correctly-landed anchor's scrollTop must differ from another
      // correctly-landed anchor's scrollTop by EXACTLY (indexDelta * 90),
      // regardless of any header/inset constant this test doesn't know.
      // This is what distinguishes a real landing from an undershoot: the
      // live third-turn regression settled ~512px SHORT of the target
      // (528px landed vs the fade-safe offset expected) while holding
      // rock-steady there -
      // a loose "moved far enough" check cannot see that at all.
      const ROW_HEIGHT_PX = 90;
      const initial = makeCompletedTranscript(4);
      const turn1Id = "user-turn1-send";
      const turn2Id = "user-turn2-send";
      const turn3Id = "user-turn3-send";
      const { rerenderMessages } = renderChatMessages({
        messages: initial,
        scrollStateKey: "t4-multiturn-engagement-key",
        localProvenanceMessageIds: new Set([turn1Id, turn2Id, turn3Id]),
      });
      await settleLegendList();

      // Turn 1: send + full anchor-lifecycle settle - its refs must be
      // SETTLED, not merely pending, before turn 2 begins (stale-ref hint).
      const afterTurn1Send = appendOptimisticUserSend(
        initial,
        turn1Id,
        100_000,
      );
      rerenderMessages(afterTurn1Send);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${turn1Id}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      const scrollAfterTurn1 = getScrollNode().scrollTop;
      const turn1AnchorIndex = afterTurn1Send.length - 1;

      // Grow + complete turn 1's reply to substantial size (~70 rows ≈
      // 6300px, matching the live trace's "~7000px content").
      const afterOverflow = appendStreamingAssistantChunks(
        afterTurn1Send,
        70,
        100_000,
      );
      rerenderMessages(afterOverflow);
      await settleLegendList();
      await act(async () => {
        for (let frame = 0; frame < 6; frame += 1) {
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          });
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 300);
        });
      });
      const trailing1 = afterOverflow[afterOverflow.length - 1];
      const afterTurn1Complete: ReadonlyArray<ChatMessageModel> = [
        ...afterOverflow.slice(0, -1),
        { ...trailing1, completedAt: 1_700_000_000_000, runState: null },
      ];
      rerenderMessages(afterTurn1Complete);
      await settleLegendList();

      // Free-scroll far from wherever turn 1's anchor left us. jsdom's flat
      // getBoundingClientRect makes scrollTop the only trustworthy geometry
      // signal, so parking at the very top makes "did the anchor scroll
      // actually land" an unmissable jump rather than a coincidental no-op.
      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(screen.queryByTestId(`mock-message-${turn2Id}`)).toBeNull();

      // Turn 2: second send. Decision #8: unconditional anchor regardless
      // of current mode/position.
      const afterTurn2Send = appendOptimisticUserSend(
        afterTurn1Complete,
        turn2Id,
        300_000,
      );
      rerenderMessages(afterTurn2Send);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${turn2Id}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await waitForAnchorEngineSettle();
      const scrollAfterTurn2 = getScrollNode().scrollTop;
      const turn2AnchorIndex = afterTurn2Send.length - 1;

      // Exact-landing check: turn 2's anchor must sit precisely
      // (indexDelta * rowHeight) away from turn 1's - not merely "moved
      // far", which an undershot-but-still-large jump would also satisfy.
      expect(scrollAfterTurn2 - scrollAfterTurn1).toBe(
        (turn2AnchorIndex - turn1AnchorIndex) * ROW_HEIGHT_PX,
      );

      // Grow + complete turn 2's reply too, mirroring a real multi-turn
      // chat (the live regression only showed up on the THIRD anchor
      // session - a bare unfilled send for turn 2, as this test used to
      // do, may not exercise the same compounding-reserve state).
      // `appendOneStreamingChunk` (globally-unique ids), not
      // `appendStreamingAssistantChunks` (scoped `stream-chunk-0..9`,
      // which would collide with turn 1's own `stream-chunk-0..69`
      // still in the array and corrupt LegendList's keyExtractor).
      let turn2Overflow: ReadonlyArray<ChatMessageModel> = afterTurn2Send;
      for (let chunkIndex = 0; chunkIndex < 10; chunkIndex += 1) {
        turn2Overflow = appendOneStreamingChunk(
          turn2Overflow,
          100 + chunkIndex,
          300_000,
        );
      }
      rerenderMessages(turn2Overflow);
      await settleLegendList();
      await act(async () => {
        for (let frame = 0; frame < 6; frame += 1) {
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          });
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 300);
        });
      });
      const trailing2 = turn2Overflow[turn2Overflow.length - 1];
      const afterTurn2Complete: ReadonlyArray<ChatMessageModel> = [
        ...turn2Overflow.slice(0, -1),
        { ...trailing2, completedAt: 1_700_000_100_000, runState: null },
      ];
      rerenderMessages(afterTurn2Complete);
      await settleLegendList();

      // Third turn (twice-settled refs): turn 1's AND turn 2's anchor
      // lifecycles have both already run to settle before this begins -
      // exactly the "stale refs from a prior turn" shape the live finding's
      // hint #1 called out.
      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(screen.queryByTestId(`mock-message-${turn3Id}`)).toBeNull();

      const afterTurn3Send = appendOptimisticUserSend(
        afterTurn2Complete,
        turn3Id,
        500_000,
      );
      rerenderMessages(afterTurn3Send);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${turn3Id}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await waitForAnchorEngineSettle();
      const scrollAfterTurn3 = getScrollNode().scrollTop;
      const turn3AnchorIndex = afterTurn3Send.length - 1;

      // The live regression: turn 3 settled ~512px SHORT of its target
      // (missing-reserve undershoot) while turn 2 landed exactly. This
      // must fail loudly, not just "still moved some" - same exact-delta
      // check as turn 1 -> turn 2 above.
      expect(scrollAfterTurn3 - scrollAfterTurn2).toBe(
        (turn3AnchorIndex - turn2AnchorIndex) * ROW_HEIGHT_PX,
      );
    });

    it("re-asserts the anchor position when content ABOVE it grows after settle (live-E2E: late-arriving prior-turn metadata following a short reply)", async () => {
      // The bug this guards: a prior turn's completion metadata (e.g. a
      // "Thought for Xs" disclosure) can land ABOVE the current anchor
      // AFTER this turn's anchor has already settled -
      // `maintainVisibleContentPosition` has `size:false`, so LegendList never
      // compensates, and nothing else corrects it: the reveal-delta check only
      // accounts for growth BELOW the anchor.
      const ROW_HEIGHT_PX = 90;
      const initial = makeCompletedTranscript(4);
      const turn1Id = "user-turn1-send";
      const turn2Id = "user-turn2-send";
      const { rerenderMessages } = renderChatMessages({
        messages: initial,
        scrollStateKey: "t4-anchor-drift-key",
        localProvenanceMessageIds: new Set([turn1Id, turn2Id]),
      });
      await settleLegendList();

      const afterTurn1Send = appendOptimisticUserSend(
        initial,
        turn1Id,
        100_000,
      );
      rerenderMessages(afterTurn1Send);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${turn1Id}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();

      // Turn 1 gets a short reply that completes immediately - the shape
      // t9's live repro isolated (long prior turns don't show this, only
      // short ones).
      const afterTurn1Reply: ReadonlyArray<ChatMessageModel> = [
        ...afterTurn1Send,
        {
          ...makeMessageAt(0, "assistant", 100_001),
          id: "turn1-reply",
          content: "OK",
          completedAt: 100_002,
          runState: null,
        },
      ];
      rerenderMessages(afterTurn1Reply);
      await settleLegendList();

      const afterTurn2Send = appendOptimisticUserSend(
        afterTurn1Reply,
        turn2Id,
        200_000,
      );
      rerenderMessages(afterTurn2Send);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${turn2Id}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await waitForAnchorEngineSettle();
      const scrollAfterSettle = getScrollNode().scrollTop;
      const turn2AnchorIndex = afterTurn2Send.length - 1;

      // Late-arriving metadata for turn 1: a new row lands ABOVE turn 2's
      // anchor via the SAME `messages` array the reveal-pass effect
      // already watches - not a new data source, just a delayed update to
      // existing history.
      const withLateMetadata: ReadonlyArray<ChatMessageModel> = [
        ...afterTurn2Send.slice(0, turn2AnchorIndex),
        {
          ...makeMessageAt(0, "assistant", 100_003),
          id: "turn1-late-metadata",
          content: "Thought for 4s",
          completedAt: 100_004,
          runState: null,
        },
        ...afterTurn2Send.slice(turn2AnchorIndex),
      ];
      rerenderMessages(withLateMetadata);
      await waitForRevealPassTick();

      // The anchor must hold its EXACT offset from the viewport top - the
      // inserted row grew content above it by one row height, so scroll
      // must grow by exactly that much to compensate. A flat (zero) delta
      // here is the live regression: the anchor silently drifts down by
      // the inserted row's height instead.
      const scrollAfterMetadata = getScrollNode().scrollTop;
      expect(scrollAfterMetadata - scrollAfterSettle).toBe(ROW_HEIGHT_PX);
    });

    it("does not re-assert anchor drift after a scroll-only upward departure", async () => {
      const initial = makeCompletedTranscript(10);
      const sendId = "anchor-drift-scroll-only-departure";
      const { rerenderMessages } = renderChatMessages({
        messages: initial,
        scrollStateKey: "anchor-drift-scroll-only-departure",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      const afterSend = appendOptimisticUserSend(initial, sendId, 210_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();

      const scrollNode = getScrollNode();
      const departedScrollTop = scrollNode.scrollTop - 180;
      expect(departedScrollTop).toBeGreaterThan(0);
      // Ticket 19: `anchorMoverShouldYieldToReader`'s yield check is a pure
      // position comparison - it does not care HOW `scrollTop` ended up
      // below the expected anchor position, only that it did. Using the
      // real library API to set up that precondition (instead of a bare
      // `scrollTop` write, which the capture-provenance classifier now
      // correctly cancels as an unexplained departure) keeps this test
      // inside `anchoring-new-turn` so it still reaches the SAME reveal-
      // pass yield branch it always exercised.
      await fireLibraryOwnedScrollTo(departedScrollTop);
      expect(scrollNode.dataset.scrollMode).toBe("anchoring-new-turn");

      const anchorIndex = afterSend.length - 1;
      const withLateMetadata: ReadonlyArray<ChatMessageModel> = [
        ...afterSend.slice(0, anchorIndex),
        {
          ...makeMessageAt(0, "assistant", 210_001),
          id: "anchor-drift-late-metadata",
          content: "Thought for 4s",
          completedAt: 210_002,
          runState: null,
        },
        ...afterSend.slice(anchorIndex),
      ];
      rerenderMessages(withLateMetadata);
      await waitForRevealPassTick();

      expect(scrollNode.scrollTop).toBe(departedScrollTop);
      expect(scrollNode.dataset.scrollMode).toBe("anchoring-new-turn");
    });

    describe("reveal pass stops advancing once the anchored turn overflows (live-E2E merge-blocker: decisions #1/#10/#16)", () => {
      // The bug this guards: a single batched jump to N streamed rows (like
      // the test above) only fires the reveal-pass effect ONCE, which can
      // never expose an indefinite-chase regression - real streaming is
      // incremental (one effect run per token/delta). These tests drive
      // growth one chunk at a time, awaiting a reveal-pass tick between each,
      // to mirror that shape.
      it("holds the anchor position (no drift, no pill) while growth stays within the usable viewport", async () => {
        const messages = makeCompletedTranscript(10);
        const sendId = "user-fits-send";
        const { rerenderMessages } = renderChatMessages({
          messages,
          scrollStateKey: "t4-reveal-fits-key",
          localProvenanceMessageIds: new Set([sendId]),
        });
        await settleLegendList();

        const afterSend = appendOptimisticUserSend(messages, sendId, 500_000);
        rerenderMessages(afterSend);
        await waitFor(() => {
          expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
        });
        await waitForAnchorEngineSettle();
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
        const scrollAtAnchor = getScrollNode().scrollTop;

        // Usable viewport ≈ 580px / 90px rows ≈ 6.4 rows - well under overflow.
        // With uniform 90px rows, `anchoredEndSpace`'s reserved trailing
        // space absorbs each new row exactly (decision #12's fade-safe offset
        // budgets ~564px below the anchor before overflow) - growth inside
        // that budget needs no scroll adjustment at all, since the newly
        // measured row simply replaces reserved blank space that was
        // already within the viewport. scrollTop staying put here is the
        // correct behavior, not an absence of coverage: the sibling "STOPS
        // scrolling" test below exercises the one case that DOES require a
        // scroll response (crossing into overflow).
        let current = afterSend;
        for (let chunkIndex = 0; chunkIndex < 5; chunkIndex += 1) {
          current = appendOneStreamingChunk(current, chunkIndex, 500_000);
          rerenderMessages(current);
          await waitForRevealPassTick();
          // Still fits - the pill must not show a streaming/overflow state,
          // and the anchor must not drift off its settled position.
          expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
          expect(getScrollNode().scrollTop).toBe(scrollAtAnchor);
        }
        expect(isJumpPillVisible()).toBe(false);
      });

      it("STOPS scrolling the instant the turn overflows, flips the pill to streaming, and never moves again across further chunks (red-on-baseline: fails pre-fix with continuous movement)", async () => {
        const messages = makeCompletedTranscript(10);
        const sendId = "user-overflow-stop-send";
        const { rerenderMessages } = renderChatMessages({
          messages,
          scrollStateKey: "t4-reveal-stops-key",
          localProvenanceMessageIds: new Set([sendId]),
        });
        await settleLegendList();

        const afterSend = appendOptimisticUserSend(messages, sendId, 600_000);
        rerenderMessages(afterSend);
        await waitFor(() => {
          expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
        });
        await waitForAnchorEngineSettle();

        // Grow one chunk at a time until the pill reports streaming (first
        // overflow), then keep growing 4 MORE chunks and assert scrollTop is
        // frozen across every one of them - not just "eventually settles."
        let current = afterSend;
        let scrollAtFirstOverflow: number | null = null;
        for (let chunkIndex = 0; chunkIndex < 20; chunkIndex += 1) {
          current = appendOneStreamingChunk(current, chunkIndex, 600_000);
          rerenderMessages(current);
          await waitForRevealPassTick();
          if (isJumpPillVisible()) {
            scrollAtFirstOverflow = getScrollNode().scrollTop;
            break;
          }
        }
        if (scrollAtFirstOverflow === null) {
          throw new Error(
            "Turn never overflowed the usable viewport within 20 chunks - test setup is wrong, not the assertion.",
          );
        }
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
        expect(screen.getByTestId("scroll-to-end-pill-spinner")).toBeTruthy();

        for (let more = 0; more < 4; more += 1) {
          current = appendOneStreamingChunk(current, 100 + more, 600_000);
          rerenderMessages(current);
          await waitForRevealPassTick();
          // The live-E2E bug: this kept advancing (163 -> 7494px) instead of
          // staying frozen at the overflow boundary.
          expect(getScrollNode().scrollTop).toBe(scrollAtFirstOverflow);
          expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
          expect(isJumpPillVisible()).toBe(true);
        }

        // Completion below the fold: decision #10, still zero movement.
        const trailingId = `incremental-chunk-${103}`;
        const completed = current.map((message) =>
          message.id === trailingId
            ? { ...message, completedAt: 1_700_000_000_000, runState: null }
            : message,
        );
        rerenderMessages(completed);
        await waitForRevealPassTick();
        await act(async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 200);
          });
        });

        expect(getScrollNode().scrollTop).toBe(scrollAtFirstOverflow);
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
        await waitFor(() => {
          expect(isJumpPillVisible()).toBe(true);
          expect(screen.queryByTestId("scroll-to-end-pill-spinner")).toBeNull();
          expect(pillVisibleLabel()).toContain("New reply");
        });
      });
    });

    it("queued-flush/A2A row (no local provenance) anchors while following-end (decision #9)", async () => {
      // No localProvenance: proves the gated path, not the unconditional one.
      // data-scroll-mode is the honest signal that the anchor engine engaged
      // (following-end catchup alone would not leave "following-end").
      const messages = makeCompletedTranscript(16);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t4-gated-follow-key",
      });
      await settleLegendList();
      expect(isJumpPillVisible()).toBe(false);
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");

      const afterFlush = appendPersistentUserRow(
        messages,
        "user-queued-flush-follow",
        777_000,
      );
      rerenderMessages(afterFlush);
      await settleLegendList();

      await waitFor(() => {
        expect(
          screen.getByTestId("mock-message-user-queued-flush-follow"),
        ).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
    });

    it("queued-flush/A2A row while free-scrolling does not move scrollTop and keeps free-scroll mode (decision #9)", async () => {
      const messages = makeCompletedTranscript(20);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t4-gated-free-key",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(isJumpPillVisible()).toBe(true);
      expect(pillVisibleLabel()).toContain("Scroll to end");
      expect(screen.queryByTestId("scroll-to-end-pill-spinner")).toBeNull();
      expect(pillVisibleLabel()).not.toContain("New reply");

      const parkedScrollTop = getScrollNode().scrollTop;
      expect(
        screen.queryByTestId("mock-message-user-queued-flush-free"),
      ).toBeNull();

      const afterFlush = appendPersistentUserRow(
        messages,
        "user-queued-flush-free",
        666_000,
      );
      rerenderMessages(afterFlush);
      await settleLegendList();
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 100);
        });
      });

      // Classifier returned none: park + free-scrolling mode both hold.
      expect(getScrollNode().scrollTop).toBe(parkedScrollTop);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(
        screen.queryByTestId("mock-message-user-queued-flush-free"),
      ).toBeNull();
      expect(isJumpPillVisible()).toBe(true);
      expect(pillVisibleLabel()).toContain("Scroll to end");
      expect(screen.queryByTestId("scroll-to-end-pill-spinner")).toBeNull();
      expect(pillVisibleLabel()).not.toContain("New reply");
    });

    it("fresh open with no saved scroll state anchors the last user message (decision #15)", async () => {
      // 20 rows: last is assistant (message-19); last user is message-18.
      // data-scroll-mode is the honest pin (not scrollHeight-derived maxScroll).
      const messages = makeCompletedTranscript(20);
      const scrollStateKey = `t4-fresh-open-${Math.random().toString(36).slice(2)}`;
      expect(
        hasSavedChatTabState(makeDefaultTestIdentity(scrollStateKey)),
      ).toBe(false);

      renderChatMessages({
        messages,
        scrollStateKey,
        freshOpen: true,
      });
      // Mode seed is synchronous at construction
      // (`resolveChatTimelineInitialModeSeed`) - first render, before settle.
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await settleLegendList();
      await waitForAnchorEngineSettle();

      await waitFor(() => {
        expect(screen.getByTestId("mock-message-message-18")).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(isJumpPillVisible()).toBe(false);
    });

    it("empty transcript still renders ChatEmptyState under the fresh-open path", async () => {
      const scrollStateKey = `t4-fresh-empty-${Math.random().toString(36).slice(2)}`;
      renderChatMessages({
        messages: [],
        scrollStateKey,
        freshOpen: true,
      });
      await settleLegendList();

      expect(screen.getByText("Start the conversation")).toBeTruthy();
      expect(screen.getByText("Send a message to get started.")).toBeTruthy();
      expect(screen.queryByTestId("chat-messages-scroll")).toBeNull();
    });

    describe("H1: empty -> non-empty live edge", () => {
      it("local-provenance first message anchors even with a saved bottom-following state", async () => {
        // Mount empty with a cache entry (freshOpen: false default seed). The
        // mount-time fresh-open seed has nothing to target; the local send on
        // the later transition must still anchor unconditionally via the
        // registry - proving that branch is independent of saved state.
        const sendId = "first-local-send";
        const { rerenderMessages } = renderChatMessages({
          messages: [],
          scrollStateKey: "t4-h1-local-empty-key",
          freshOpen: false,
          localProvenanceMessageIds: new Set([sendId]),
        });
        await settleLegendList();
        expect(screen.getByText("Start the conversation")).toBeTruthy();

        const next: ReadonlyArray<ChatMessageModel> = [
          {
            ...makeMessageAt(0, "user", 1_000),
            id: sendId,
            content: "hello empty chat",
            persistentMessageId: null,
          },
        ];
        rerenderMessages(next);
        await settleLegendList();

        await waitFor(() => {
          expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
        });
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      });

      it("saved empty chat anchors a live passive first turn while following", async () => {
        // ChatMessages mounts only after ChatSessionMessagesSurface has an
        // authoritative snapshot. An empty mount is therefore a real empty
        // chat, and this later non-local batch is a live passive arrival
        // governed by decision #9 rather than initial hydration.
        const history = makeCompletedTranscript(8);
        const { rerenderMessages } = renderChatMessages({
          messages: [],
          scrollStateKey: "t4-h1-saved-no-local-key",
          freshOpen: false,
        });
        await settleLegendList();

        rerenderMessages(history);
        await settleLegendList();

        await waitFor(() => {
          expect(screen.getByTestId("chat-messages-scroll")).toBeTruthy();
        });
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      });

      it("saved empty chat keeps a live passive first turn parked after a pointerdown relinquishes follow", async () => {
        const history = makeCompletedTranscript(8);
        const { rerenderMessages } = renderChatMessages({
          messages: [],
          scrollStateKey: "t4-h1-saved-user-departed-key",
          freshOpen: false,
        });
        await settleLegendList();

        fireEvent.pointerDown(screen.getByTestId("chat-transcript-container"));
        rerenderMessages(history);
        await settleLegendList();
        await waitForPillVisible();

        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
        expect(getScrollNode().scrollTop).toBe(0);
        expect(isJumpPillVisible()).toBe(true);
      });
    });

    describe("H2: same-turn steer-shaped insert (new user before still-present trailing assistant)", () => {
      it("anchors when the inserted user id is in the local-provenance registry", async () => {
        // Not a pure append and not a clean first-divergence replacement:
        // the trailing assistant keeps its id while a new user row is
        // spliced ahead of it (same-turn steer row-splitting shape). Prefix
        // history keeps the free-scroll park far from the insert so
        // row-mount is a real virtualization signal.
        const prefix = makeCompletedTranscript(16);
        const userTail = {
          ...makeMessageAt(0, "user", 200),
          id: "u-tail",
          completedAt: null,
        };
        const assistantLive = {
          ...makeMessageAt(1, "assistant", 201),
          id: "a-live",
          content: "still streaming",
          completedAt: null,
          runState: "running" as const,
        };
        const messages: ReadonlyArray<ChatMessageModel> = [
          ...prefix,
          userTail,
          assistantLive,
        ];
        const steerId = "u-steer";
        const { rerenderMessages } = renderChatMessages({
          messages,
          scrollStateKey: "t4-h2-steer-local-key",
          localProvenanceMessageIds: new Set([steerId]),
        });
        await settleLegendList();

        act(() => {
          enterFreeScrollingAwayFromEnd();
        });
        await waitForPillVisible();
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
        expect(screen.queryByTestId(`mock-message-${steerId}`)).toBeNull();

        const afterSteer: ReadonlyArray<ChatMessageModel> = [
          ...prefix,
          userTail,
          {
            ...makeMessageAt(0, "user", 202),
            id: steerId,
            content: "steer instruction",
            persistentMessageId: null,
          },
          assistantLive,
        ];
        rerenderMessages(afterSteer);
        await settleLegendList();

        await waitFor(() => {
          expect(screen.getByTestId(`mock-message-${steerId}`)).toBeTruthy();
        });
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

        await waitForAnchorEngineSettle();
        const list = legendListRefHolder.current;
        if (list === null) throw new Error("Expected an attached LegendList");
        const reservedContentLength = list.getState().contentLength;
        const anchoredScrollTop = getScrollNode().scrollTop;
        fireEvent.wheel(getScrollNode(), { deltaY: -0.1 });
        await fireScrollTopAndFlush(anchoredScrollTop - 0.25);
        await settleLegendList();

        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
        expect(getScrollNode().scrollTop).toBe(anchoredScrollTop - 0.25);
        expect(list.getState().contentLength).toBeGreaterThanOrEqual(
          reservedContentLength,
        );
      });

      it("stays free-scrolling when the inserted user id is NOT in the registry", async () => {
        const prefix = makeCompletedTranscript(16);
        const userTail = {
          ...makeMessageAt(0, "user", 200),
          id: "u-tail-gate",
          completedAt: null,
        };
        const assistantDone = {
          ...makeMessageAt(1, "assistant", 201),
          id: "a-live-gate",
          content: "done",
          completedAt: 300,
          runState: null,
        };
        const messages: ReadonlyArray<ChatMessageModel> = [
          ...prefix,
          userTail,
          assistantDone,
        ];
        const foreignId = "u-foreign-steer";
        const { rerenderMessages } = renderChatMessages({
          messages,
          scrollStateKey: "t4-h2-steer-foreign-key",
          // Empty registry: foreign window / A2A-shaped insert.
        });
        await settleLegendList();

        act(() => {
          enterFreeScrollingAwayFromEnd();
        });
        await waitForPillVisible();
        const parkedScrollTop = getScrollNode().scrollTop;
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

        const afterForeign: ReadonlyArray<ChatMessageModel> = [
          ...prefix,
          userTail,
          {
            ...makeMessageAt(0, "user", 202),
            id: foreignId,
            content: "other window edit",
            persistentMessageId: foreignId,
          },
          assistantDone,
        ];
        rerenderMessages(afterForeign);
        await settleLegendList();
        await act(async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 100);
          });
        });

        expect(getScrollNode().scrollTop).toBe(parkedScrollTop);
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
        expect(screen.queryByTestId(`mock-message-${foreignId}`)).toBeNull();
      });
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
        act(() => {
          enterFreeScrollingAwayFromEnd();
        });
        // Then a single, deterministic scroll write (the same mechanism many
        // existing tests in this file already use) to a KNOWN position -
        // deliberately NOT a multi-frame settle window, which would let
        // LegendList's own virtualization keep adjusting scroll afterward and
        // make "the exact position at unmount" a moving target rather than a
        // controlled one.
        await fireScrollTopAndFlush(360);
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

        const originalScrollTop = getScrollNode().scrollTop;
        expect(originalScrollTop).toBe(360);

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

    it("anchors a variable-height reading position to the actual assistant row", async () => {
      const messages = makeCompletedTranscript(12);
      const tallAssistantId = messages[1].id;
      setLegendListMessageRowHeightOverrides(new Map([[tallAssistantId, 900]]));
      setLegendListScrollContainerScrollHeightOverride(2_000);

      const instanceId = `t5-tall-assistant-${Math.random().toString(36).slice(2)}`;
      tileLiveness.live = true;
      const first = renderChatMessages({
        messages,
        scrollStateKey: instanceId,
        instanceId,
      });
      await settleLegendList();

      act(() => enterFreeScrollingAwayFromEnd());
      // Header (40) + first row (90) + 300px into the tall assistant.
      await fireScrollTopAndFlush(430);
      expect(getScrollNode().scrollTop).toBe(430);

      first.unmount();

      const saved = restoreChatTabState(
        makeDefaultTestIdentity(instanceId),
        messages,
      );
      expect(saved.anchorMessageId).toBe(tallAssistantId);
      expect(saved.anchorIndex).toBe(1);
      expect(saved.offset).toBe(-300);

      const second = renderChatMessages({
        messages,
        scrollStateKey: instanceId,
        instanceId,
      });
      await settleLegendList();
      await settleLegendList();

      expect(getScrollNode().scrollTop).toBe(430);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      second.unmount();
    });

    it("captures inline-navigation source positions synchronously and replaces stale captures", async () => {
      const messages = makeCompletedTranscript(24);
      const instanceId = `t5-inline-source-${Math.random().toString(36).slice(2)}`;
      tileLiveness.live = true;
      const view = renderChatMessages({
        messages,
        scrollStateKey: instanceId,
        instanceId,
      });
      await settleLegendList();

      act(() => enterFreeScrollingAwayFromEnd());
      await fireScrollTopAndFlush(360);
      fireEvent.pointerDown(screen.getByTestId("chat-transcript-container"));

      const firstCapture = restoreChatTabState(
        makeDefaultTestIdentity(instanceId),
        messages,
      );
      expect(firstCapture.mode).toBe("free-scrolling");
      expect(firstCapture.anchorMessageId).not.toBeNull();

      await fireScrollTopAndFlush(720);
      fireEvent.pointerDown(screen.getByTestId("chat-transcript-container"));

      const secondCapture = restoreChatTabState(
        makeDefaultTestIdentity(instanceId),
        messages,
      );
      expect(secondCapture.mode).toBe("free-scrolling");
      expect(secondCapture.anchorMessageId).not.toBe(
        firstCapture.anchorMessageId,
      );
      expect(secondCapture.anchorIndex).toBeGreaterThan(
        firstCapture.anchorIndex ?? -1,
      );
      view.unmount();
    });

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

    it("restores the validated reading anchor without waiting for a deleted reply reserve after streaming ends", async () => {
      const messages = makeCompletedTranscript(20);
      const targetIndex = 8;
      const targetId = messages[targetIndex].id;
      const instanceId = `t5-deleted-reserve-restore-${Math.random().toString(36).slice(2)}`;
      const identity = makeDefaultTestIdentity(instanceId);
      saveChatTabState({
        identity,
        mode: "free-scrolling",
        anchorMessageId: targetId,
        anchorIndex: targetIndex,
        offset: -12,
        replyReserveMessageId: "deleted-reply-reserve",
      });

      tileLiveness.live = true;
      const view = renderChatMessages({
        messages,
        scrollStateKey: instanceId,
        instanceId,
        isChatStreaming: true,
      });
      const list = legendListRefHolder.current;
      if (list === null) throw new Error("LegendList ref did not mount");
      getScrollNode().scrollTop = 0;
      vi.spyOn(list, "scrollToIndex").mockResolvedValue(undefined);
      const absoluteRestore = vi.spyOn(list, "scrollToOffset");

      await settleLegendList();
      await settleLegendList();

      expect(absoluteRestore).not.toHaveBeenCalled();

      view.rerenderWith({ isChatStreaming: false });
      await settleLegendList();
      await settleLegendList();

      const expectedScrollTop = LEGEND_LIST_HEADER_PX + targetIndex * 90 + 12;
      expect(absoluteRestore).toHaveBeenCalledWith({
        offset: expectedScrollTop,
        animated: false,
      });
      expect(getScrollNode().scrollTop).toBe(expectedScrollTop);
      expect(getScrollNode().dataset.replyReserveMessageId).toBe("");
      view.unmount();
    });

    it("retains a validated detached reply reserve after streaming ends", async () => {
      const messages = makeCompletedTranscript(20);
      const anchorIndex = 1;
      const reserveIndex = 18;
      const instanceId = `t5-completed-valid-reserve-${Math.random().toString(36).slice(2)}`;
      saveChatTabState({
        identity: makeDefaultTestIdentity(instanceId),
        mode: "free-scrolling",
        anchorMessageId: messages[anchorIndex].id,
        anchorIndex,
        offset: -300,
        replyReserveMessageId: messages[reserveIndex].id,
      });

      const view = renderChatMessages({
        messages,
        scrollStateKey: instanceId,
        instanceId,
        isChatStreaming: false,
      });
      await settleLegendList();
      await settleLegendList();

      expect(getScrollNode().dataset.replyReserveMessageId).toBe(
        messages[reserveIndex].id,
      );
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      view.unmount();
    });

    it("keeps the pre-restore snapshot authoritative when a bootstrap mount unmounts before convergence", () => {
      const messages = makeCompletedTranscript(20);
      const anchorIndex = 8;
      const reserveIndex = 18;
      const instanceId = `t5-bootstrap-unmount-${Math.random().toString(36).slice(2)}`;
      const identity = makeDefaultTestIdentity(instanceId);
      const expected = {
        mode: "free-scrolling" as const,
        anchorMessageId: messages[anchorIndex].id,
        anchorIndex,
        offset: -1_185,
        replyReserveMessageId: messages[reserveIndex].id,
      };
      saveChatTabState({ identity, ...expected });

      tileLiveness.live = true;
      const bootstrap = renderChatMessages({
        messages,
        scrollStateKey: instanceId,
        instanceId,
        isChatStreaming: true,
      });

      // Strict Mode and rapid canvas switches can destroy this mount before
      // the reserve and measured-row convergence complete. Its transient DOM
      // geometry is not a reader decision and must not become last-writer-wins.
      bootstrap.unmount();

      expect(restoreChatTabState(identity, messages)).toEqual(expected);
    });

    it("publishes an explicit wheel detachment even when no follow-up scroll event fires before unmount", async () => {
      const messages = makeCompletedTranscript(20);
      const anchorIndex = 18;
      const instanceId = `t5-bootstrap-reader-detach-${Math.random().toString(36).slice(2)}`;
      const identity = makeDefaultTestIdentity(instanceId);
      saveChatTabState({
        identity,
        mode: "anchoring-new-turn",
        anchorMessageId: messages[anchorIndex].id,
        anchorIndex,
        offset: 0,
      });

      tileLiveness.live = true;
      const bootstrap = renderChatMessages({
        messages,
        scrollStateKey: instanceId,
        instanceId,
        isChatStreaming: true,
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      // The scroll node can appear one frame after the component's layout
      // effect; wait only for its passive wheel listener, not anchor settle.
      await act(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          }),
      );
      fireEvent.wheel(getScrollNode(), { deltaY: -0.1 });
      getScrollNode().scrollTop = 360;
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      bootstrap.unmount();

      const saved = restoreChatTabState(identity, messages);
      expect(saved.mode).toBe("free-scrolling");
      expect(saved.anchorMessageId).not.toBeNull();
      expect(saved.anchorIndex).not.toBeNull();
    });

    it("treats Strict Mode initial-index placement as a bootstrap and converges from measured reserve geometry", async () => {
      const messages = makeCompletedTranscript(20);
      const anchorIndex = 1;
      const reserveIndex = 18;
      const instanceId = `t5-strict-measured-restore-${Math.random().toString(36).slice(2)}`;
      const identity = makeDefaultTestIdentity(instanceId);
      setLegendListMessageRowHeightOverrides(
        new Map([[messages[anchorIndex].id, 6_049]]),
      );
      saveChatTabState({
        identity,
        mode: "free-scrolling",
        anchorMessageId: messages[anchorIndex].id,
        anchorIndex,
        offset: -300,
        replyReserveMessageId: messages[reserveIndex].id,
      });

      tileLiveness.live = true;
      const view = renderChatMessages({
        messages,
        scrollStateKey: instanceId,
        instanceId,
        isChatStreaming: true,
        strictMode: true,
      });
      await settleLegendList();
      await settleLegendList();

      const expectedScrollTop = LEGEND_LIST_HEADER_PX + 90 + 300;
      expect(getScrollNode().scrollTop).toBe(expectedScrollTop);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      view.unmount();
      expect(restoreChatTabState(identity, messages)).toEqual({
        mode: "free-scrolling",
        anchorMessageId: messages[anchorIndex].id,
        anchorIndex,
        offset: -300,
        replyReserveMessageId: messages[reserveIndex].id,
      });
    });

    it("captures the live DOM offset when an animated navigation has not settled before unmount", async () => {
      const messages = makeCompletedTranscript(30);
      const targetIndex = 10;
      const targetId = messages[targetIndex]?.id;
      expect(targetId).toBeTruthy();
      const scrollStateKey = `t5-live-dom-capture-${Math.random().toString(36).slice(2)}`;
      const instanceId = `t5-live-dom-instance-${Math.random().toString(36).slice(2)}`;

      tileLiveness.live = true;
      const first = renderChatMessages({
        messages,
        scrollStateKey,
        instanceId,
      });
      await settleLegendList();

      first.rerenderWith({
        scrollRequest: {
          requestId: 5_001,
          messageId: targetId,
          blockId: null,
        },
      });
      const liveScrollTop = getScrollNode().scrollTop;
      expect(liveScrollTop).toBeGreaterThan(0);

      // Unmount before scrollend/the fallback can reconcile LegendList's
      // tracked scroll. The DOM is already at the visible navigation landing,
      // so persistence must capture that live position rather than the
      // controller's previous internal value.
      first.unmount();

      const second = renderChatMessages({
        messages,
        scrollStateKey,
        instanceId,
      });
      await settleLegendList();
      await settleLegendList();

      expect(getScrollNode().scrollTop).toBe(liveScrollTop);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      second.unmount();
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

        act(() => {
          enterFreeScrollingAwayFromEnd();
        });
        await fireScrollTopAndFlush(360);
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

        const originalScrollTop = getScrollNode().scrollTop;
        expect(originalScrollTop).toBe(360);

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
        expect(saved.offset).not.toBe(0);

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

    it("F1: a restored free-scrolling position landing near the tail does not flip to following-end", async () => {
      const messages = makeCompletedTranscript(20);
      const anchorId = messages[4]?.id;
      expect(anchorId).toBeTruthy();
      const scrollStateKey = `t5-f1-nearend-${Math.random().toString(36).slice(2)}`;

      // Valid mid-list free restore so LegendList's initialScrollIndex bootstrap
      // actually converges (the old huge-negative near-end offset aborted
      // bootstrap - pin stayed green under the F1 suppress-seed mutation).
      // F1 is the suppressFollowRestoreRef seed for that bootstrap: same class
      // as ticket 3 H3. After bootstrap arms suppression, a subsequent
      // programmatic near-end landing must NOT flip to following-end.
      saveChatTabState({
        identity: makeDefaultTestIdentity(scrollStateKey),
        mode: "free-scrolling",
        anchorMessageId: anchorId,
        anchorIndex: null,
        offset: 40,
      });

      renderChatMessages({ messages, scrollStateKey });
      await settleLegendList();
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // Programmatic near-end landing (no wheel/pointerdown/touch - not a
      // real gesture, so suppression stays armed). Without F1's seed this
      // report would re-pin following-end.
      act(() => {
        fireScrollToEnd();
      });
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().dataset.scrollMode).not.toBe("following-end");
    });

    it("restores a just-sent turn's semantic anchor and reply reserve after a tab-switch remount", async () => {
      const messages = makeCompletedTranscript(16);
      const sendId = "t5-mid-anchor-send";
      const scrollStateKey = `t5-mid-anchor-${Math.random().toString(36).slice(2)}`;
      const instanceId = `t5-mid-anchor-inst-${Math.random().toString(36).slice(2)}`;
      const composerOverlayHeight = 80;

      tileLiveness.live = true;
      const first = renderChatMessages({
        messages,
        scrollStateKey,
        instanceId,
        localProvenanceMessageIds: new Set([sendId]),
        composerOverlayHeight,
        isChatStreaming: true,
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();

      const afterSend = appendOptimisticUserSend(messages, sendId, 777_000);
      first.rerenderMessages(afterSend);
      await settleLegendList();
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      // `scroll-yank-tab-switch.mov`: switch tabs immediately after the send,
      // while the anchor operation is still allowed to be in flight.
      first.unmount();

      const saved = restoreChatTabState(
        makeDefaultTestIdentity(instanceId),
        afterSend,
      );
      expect(saved.mode).toBe("anchoring-new-turn");
      expect(saved.anchorMessageId).toBe(sendId);

      const second = renderChatMessages({
        messages: afterSend,
        scrollStateKey,
        instanceId,
        composerOverlayHeight,
        isChatStreaming: true,
        // Provenance was already consumed before the switch. Restoration must
        // come from the saved semantic session, not reclassification as a new
        // local send.
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await waitForAnchorEngineSettle();

      const list = legendListRefHolder.current;
      if (list === null) throw new Error("Expected an attached LegendList");
      const sendIndex = afterSend.length - 1;
      const restoredQueryTop =
        list.getState().positionAtIndex(sendIndex) +
        LEGEND_LIST_HEADER_PX -
        getScrollNode().scrollTop;
      expect(
        Math.abs(restoredQueryTop - CHAT_LIST_ANCHOR_OFFSET),
      ).toBeLessThanOrEqual(1);

      // First streamed reply content consumes the already-reserved space. It
      // must not turn the remount into a free-scroll resize/yank.
      const scrollBeforeReply = getScrollNode().scrollTop;
      const withReply = appendStreamingAssistantChunks(afterSend, 2, 778_000);
      second.rerenderMessages(withReply);
      await settleLegendList();
      await waitForRevealPassTick();

      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(getScrollNode().scrollTop).toBe(scrollBeforeReply);

      second.unmount();
    });

    it("preserves a detached streaming viewport and its reply reserve across repeated tab switches", async () => {
      const history = makeCompletedTranscript(12);
      const sendId = "t5-detached-reserve-send";
      const instanceId = `t5-detached-reserve-${Math.random().toString(36).slice(2)}`;
      const afterSend = appendOptimisticUserSend(history, sendId, 780_000);
      const streaming = appendStreamingAssistantChunks(afterSend, 2, 781_000);

      tileLiveness.live = true;
      const first = renderChatMessages({
        messages: history,
        instanceId,
        scrollStateKey: instanceId,
        localProvenanceMessageIds: new Set([sendId]),
        isChatStreaming: true,
      });
      await settleLegendList();

      first.rerenderMessages(afterSend);
      await waitForAnchorEngineSettle();
      first.rerenderMessages(streaming);
      await settleLegendList();

      const anchoredScrollTop = getScrollNode().scrollTop;
      fireEvent.wheel(getScrollNode(), { deltaY: -0.1 });
      await fireScrollTopAndFlush(Math.max(0, anchoredScrollTop - 0.25));
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      const readingScrollTop = getScrollNode().scrollTop;
      first.unmount();

      const saved = restoreChatTabState(
        makeDefaultTestIdentity(instanceId),
        streaming,
      );
      // Scroll ownership and reply-space geometry have independent lifetimes.
      // A detached reader must persist both, rather than clamping the viewport
      // into no-reserve geometry and losing another line on every remount.
      expect(saved).toHaveProperty("replyReserveMessageId", sendId);

      const grownStreaming = appendStreamingAssistantChunks(
        afterSend,
        3,
        781_000,
      );
      const second = renderChatMessages({
        messages: grownStreaming,
        instanceId,
        scrollStateKey: instanceId,
        isChatStreaming: true,
      });
      await settleLegendList();
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().dataset.replyReserveMessageId).toBe(sendId);
      expect(getScrollNode().scrollTop).toBe(readingScrollTop);

      second.unmount();
      const third = renderChatMessages({
        messages: grownStreaming,
        instanceId,
        scrollStateKey: instanceId,
        isChatStreaming: true,
      });
      await settleLegendList();
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().dataset.replyReserveMessageId).toBe(sendId);
      expect(getScrollNode().scrollTop).toBe(readingScrollTop);
      third.unmount();
    });

    it("resumes a saved new-turn anchor when hydration delivers its query after mount", async () => {
      const history = makeCompletedTranscript(12);
      const sendId = "t5-delayed-anchor-send";
      const afterSend = appendOptimisticUserSend(history, sendId, 779_000);
      const scrollStateKey = `t5-delayed-anchor-${Math.random().toString(36).slice(2)}`;
      const identity = makeDefaultTestIdentity(scrollStateKey);

      saveChatTabState({
        identity,
        mode: "anchoring-new-turn",
        anchorMessageId: sendId,
        anchorIndex: afterSend.length - 1,
        offset: 0,
      });

      // The tab can remount from a partial snapshot before the just-sent row
      // is hydrated. Its temporary nearest-neighbor landing must be passive;
      // once the original semantic id arrives, restore the anchor session
      // instead of treating the query as an unrelated append.
      const view = renderChatMessages({
        messages: history,
        scrollStateKey,
        isChatStreaming: true,
      });
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      view.rerenderMessages(afterSend);
      await waitFor(() => {
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      });
      await waitForAnchorEngineSettle();

      const list = legendListRefHolder.current;
      if (list === null) throw new Error("Expected an attached LegendList");
      const queryTop =
        list.getState().positionAtIndex(afterSend.length - 1) +
        LEGEND_LIST_HEADER_PX -
        getScrollNode().scrollTop;
      expect(Math.abs(queryTop - CHAT_LIST_ANCHOR_OFFSET)).toBeLessThanOrEqual(
        1,
      );
    });

    it("recreates a detached reply reserve delivered after a partial hydration mount before replaying the raw viewport", async () => {
      const messages = makeCompletedTranscript(10);
      const partial = messages.slice(0, 4);
      const viewportAnchorId = messages[1]?.id;
      const reserveMessageId = messages[8]?.id;
      expect(viewportAnchorId).toBeTruthy();
      expect(reserveMessageId).toBeTruthy();
      const instanceId = `t5-delayed-detached-reserve-${Math.random().toString(36).slice(2)}`;

      saveChatTabState({
        identity: makeDefaultTestIdentity(instanceId),
        mode: "free-scrolling",
        anchorMessageId: viewportAnchorId,
        anchorIndex: 1,
        offset: -24,
        replyReserveMessageId: reserveMessageId,
      });

      const view = renderChatMessages({
        messages: partial,
        instanceId,
        scrollStateKey: instanceId,
        isChatStreaming: true,
      });
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().dataset.replyReserveMessageId).toBe("");

      view.rerenderMessages(messages);
      await settleLegendList();
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().dataset.replyReserveMessageId).toBe(
        reserveMessageId,
      );
      // position(1)=90, header=40, viewOffset=-24 => scrollTop=154.
      expect(getScrollNode().scrollTop).toBe(154);
      view.unmount();
    });

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
        replyReserveMessageId: null,
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
        replyReserveMessageId: null,
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

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
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
      expect(hasSavedChatTabState(identity)).toBe(false);
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
  describe("ticket 11: live-edge reconciliation for mode + pill", () => {
    /**
     * Drive the scroll node to an absolute `scrollTop` and fire a native
     * `scroll` event ONLY - no wheel/touchmove/pointerdown. Models an OS
     * scrollbar drag that never cancels generation ownership.
     */
    async function fireScrollOnlyTo(scrollTop: number): Promise<void> {
      await fireScrollTopAndFlush(scrollTop);
    }

    async function setupOverflowingAnchoredTurn(options: {
      readonly scrollStateKey: string;
      readonly sendId: string;
      readonly additionalLocalProvenanceMessageIds?: ReadonlyArray<string>;
    }): Promise<{
      rerenderMessages: (messages: ReadonlyArray<ChatMessageModel>) => void;
      afterOverflow: ReadonlyArray<ChatMessageModel>;
    }> {
      const messages = makeCompletedTranscript(10);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: options.scrollStateKey,
        localProvenanceMessageIds: new Set([
          options.sendId,
          ...(options.additionalLocalProvenanceMessageIds ?? []),
        ]),
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();

      const afterSend = appendOptimisticUserSend(
        messages,
        options.sendId,
        888_000,
      );
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(
          screen.getByTestId(`mock-message-${options.sendId}`),
        ).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await waitForAnchorEngineSettle();

      const afterOverflow = appendStreamingAssistantChunks(
        afterSend,
        14,
        888_000,
      );
      rerenderMessages(afterOverflow);
      await settleLegendList();
      await act(async () => {
        for (let frame = 0; frame < 6; frame += 1) {
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          });
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 300);
        });
      });

      await waitFor(
        () => {
          expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
          expect(isJumpPillVisible()).toBe(true);
        },
        { timeout: 4_000 },
      );

      return { rerenderMessages, afterOverflow };
    }

    it("(a) scroll-only overflow-to-tail stays detached with its reply reserve until explicit go-live", async () => {
      const { rerenderMessages, afterOverflow } =
        await setupOverflowingAnchoredTurn({
          scrollStateKey: "t11-a-scroll-only",
          sendId: "t11-a-send",
        });

      // Scroll-ONLY route: the capture classifier recognizes a native
      // scrollbar drag even without wheel/pointerdown and releases anchor
      // ownership. Reaching the synthetic reserve's strict edge is geometry,
      // not permission to destroy the reply viewport; only explicit go-live
      // may clear that independent reserve.
      //
      // Walk scrollTop upward from the parked anchor (not the shim's huge
      // fixed scrollHeight max - that overshoots real content and leaves no
      // room for maintainScrollAtEnd to advance on the next chunk).
      const parkedAtAnchor = getScrollNode().scrollTop;
      let reachedEndAt: number | null = null;
      for (let top = parkedAtAnchor; top <= parkedAtAnchor + 4_000; top += 80) {
        await fireScrollOnlyTo(top);
        if (legendListRefHolder.current?.getState().isAtEnd === true) {
          reachedEndAt = getScrollNode().scrollTop;
          break;
        }
      }
      expect(reachedEndAt).not.toBeNull();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().dataset.replyReserveMessageId).toBe("t11-a-send");
      expect(isJumpPillVisible()).toBe(false);

      // Stream growth consumes the retained reserve without reacquiring a
      // mover or shifting the reader's physical viewport.
      const beforeChunk = getScrollNode().scrollTop;
      let afterChunk: ReadonlyArray<ChatMessageModel> = afterOverflow;
      for (let i = 0; i < 8; i += 1) {
        afterChunk = appendOneStreamingChunk(afterChunk, 900 + i, 900_000 + i);
      }
      rerenderMessages(afterChunk);
      await settleLegendList();
      await waitForRevealPassTick();
      await waitForRevealPassTick();

      expect(getScrollNode().scrollTop).toBe(beforeChunk);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().dataset.replyReserveMessageId).toBe("t11-a-send");
    });

    it("(b) ordinary wheel cancel + pill-click path stays green (no regression)", async () => {
      // Companion to (a): the gesture-driven path must still cancel ownership
      // and restore follow via the pill - Ticket 11's mirror must not break it.
      const messages = makeTranscript(20);
      renderChatMessages({
        messages,
        scrollStateKey: "t11-b-wheel-path",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(isJumpPillVisible()).toBe(true);

      fireEvent.click(screen.getByRole("button", { name: "Scroll to end" }));
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      expect(isJumpPillVisible()).toBe(false);
    });

    it("(b2) a scroll-only native scrollbar drag toward the strict tail reacquires follow", async () => {
      const messages = makeTranscript(20);
      renderChatMessages({
        messages,
        scrollStateKey: "t11-b2-scroll-only-reattach",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      const scrollNode = getScrollNode();
      await fireScrollOnlyTo(
        Math.max(0, scrollNode.scrollHeight - scrollNode.clientHeight),
      );

      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      expect(isJumpPillVisible()).toBe(false);
    });

    it("(b3) an MVCP-owned scroll adjustment does not impersonate a scrollbar drag", () => {
      const libraryOwnedScrollTop = chatScrollCaptureLibraryOwnedTop(990, 990);
      expect(
        scrollOnlyMovementCarriesReaderIntent({
          previousScrollTop: 900,
          currentScrollTop: 990,
          libraryOwnedScrollTop,
        }),
      ).toBe(false);
      expect(
        scrollOnlyMovementCarriesReaderIntent({
          previousScrollTop: 900,
          currentScrollTop: 990,
          libraryOwnedScrollTop: chatScrollCaptureLibraryOwnedTop(990, 900),
        }),
      ).toBe(true);
    });

    it("(c) pill click while anchoring immediately enters following-end", async () => {
      await setupOverflowingAnchoredTurn({
        scrollStateKey: "t11-c-pill-while-anchoring",
        sendId: "t11-c-send",
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(isJumpPillVisible()).toBe(true);

      fireEvent.click(screen.getByRole("button", { name: "Scroll to end" }));
      // scrollToEnd sets following-end unconditionally on click - no wait.
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      expect(isJumpPillVisible()).toBe(false);
    });

    it("(c2) explicit go-live can tear down reply reserve and a later send cleanly recreates it", async () => {
      const firstSendId = "t11-c2-first-send";
      const secondSendId = "t11-c2-second-send";
      const { rerenderMessages, afterOverflow } =
        await setupOverflowingAnchoredTurn({
          scrollStateKey: "t11-c2-reserve-lifecycle",
          sendId: firstSendId,
          additionalLocalProvenanceMessageIds: [secondSendId],
        });

      fireEvent.click(screen.getByRole("button", { name: "Scroll to end" }));
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");

      const trailingReply = afterOverflow.at(-1);
      if (trailingReply === undefined) {
        throw new Error("Expected a trailing assistant reply");
      }
      expect(trailingReply.role).toBe("assistant");
      const completedFirstTurn: ReadonlyArray<ChatMessageModel> = [
        ...afterOverflow.slice(0, -1),
        {
          ...trailingReply,
          completedAt: 889_000,
          runState: null,
        },
      ];
      rerenderMessages(completedFirstTurn);
      await settleLegendList();

      const afterSecondSend = appendOptimisticUserSend(
        completedFirstTurn,
        secondSendId,
        890_000,
      );
      rerenderMessages(afterSecondSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${secondSendId}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();

      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      const list = legendListRefHolder.current;
      if (list === null) throw new Error("Expected an attached LegendList");
      const secondSendViewportTop =
        list.getState().positionAtIndex(afterSecondSend.length - 1) +
        LEGEND_LIST_HEADER_PX -
        getScrollNode().scrollTop;
      expect(
        Math.abs(secondSendViewportTop - CHAT_LIST_ANCHOR_OFFSET),
      ).toBeLessThanOrEqual(1);
    });

    it("(d) suppressed nav at tail stays free, hides pill at edge, shows pill on offscreen growth without scroll event", async () => {
      // Ticket 5 F1-style: free-scrolling restore seeds suppressFollowRestore
      // from the first frame. A subsequent programmatic near-end landing
      // (no wheel) must stay free AND hide the pill via Ticket 11 fix #3's
      // suppressed-branch bookkeeping - then growth without a scroll event
      // must re-show the pill via the reveal-pass branch.
      const messages = makeCompletedTranscript(20);
      const anchorId = messages[4]?.id;
      expect(anchorId).toBeTruthy();
      const scrollStateKey = `t11-d-suppressed-${Math.random().toString(36).slice(2)}`;

      saveChatTabState({
        identity: makeDefaultTestIdentity(scrollStateKey),
        mode: "free-scrolling",
        anchorMessageId: anchorId,
        anchorIndex: null,
        offset: 40,
      });

      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey,
      });
      await settleLegendList();
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // Programmatic near-end landing (still suppressed - no real gesture).
      // Walk to a content-relative end from the restored mid-list park so we
      // don't overshoot into the shim's fixed huge scrollHeight.
      const start = getScrollNode().scrollTop;
      for (let top = start; top <= start + 6_000; top += 120) {
        await fireScrollTopAndFlush(top);
        if (!isJumpPillVisible()) break;
      }
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, PILL_SHOW_DEBOUNCE_MS + 40);
        });
      });

      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      await waitFor(
        () => {
          expect(isJumpPillVisible()).toBe(false);
        },
        { timeout: 2_000 },
      );

      // Growth WITHOUT a scroll event: append enough that the parked free
      // position is no longer at the end. Ticket 11 fix #3's reveal-pass
      // branch is the only bookkeeping path for this (no native scroll).
      let grown: ReadonlyArray<ChatMessageModel> = messages;
      for (let i = 0; i < 20; i += 1) {
        grown = appendOneStreamingChunk(grown, 2000 + i, 1_000_000 + i);
      }
      rerenderMessages(grown);
      await settleLegendList();
      await waitForRevealPassTick();
      await waitForPillVisible();

      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(isJumpPillVisible()).toBe(true);
    });

    it("shows the pill when growth leaves an ordinary pointerdown-released reader behind", async () => {
      const messages = makeCompletedTranscript(20);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t11-pointerdown-growth-pill",
      });
      await settleLegendList();

      const scrollNode = getScrollNode();
      expect(scrollNode.dataset.scrollMode).toBe("following-end");
      expect(isJumpPillVisible()).toBe(false);

      fireEvent.pointerDown(scrollNode);
      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
      expect(isJumpPillVisible()).toBe(false);
      const parked = scrollNode.scrollTop;

      let grown: ReadonlyArray<ChatMessageModel> = messages;
      for (let i = 0; i < 20; i += 1) {
        grown = appendOneStreamingChunk(grown, 2200 + i, 1_100_000 + i);
      }
      rerenderMessages(grown);
      await settleLegendList();
      await waitForRevealPassTick();
      await waitForPillVisible();

      expect(scrollNode.scrollTop).toBe(parked);
      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
      expect(isJumpPillVisible()).toBe(true);
    });

    it("(e) strict 1px epsilon gates mode reconciliation, not loose isNearEnd alone", async () => {
      await setupOverflowingAnchoredTurn({
        scrollStateKey: "t11-e-strict-epsilon",
        sendId: "t11-e-send",
      });

      // Find the minimal content-end scroll that flips to following-end via
      // the Ticket 11 reconciliation (scrollDeltaToRevealEnd <= 1), walking
      // from the parked anchor rather than the shim's fixed max scroll.
      //
      // Ticket 19: this probe walk must stay OWNED (still `anchoring-new-
      // turn`) at every intermediate step so the boundary it finds is the
      // ONE `onIsAtEndChange`'s strict-epsilon gate itself produces, not an
      // earlier capture-classifier cancellation. `fireScrollOnlyTo` (a bare
      // `scrollTop` write) is now correctly read as an unexplained reader
      // departure and cancels on the very first divergent step - the same
      // false-input class this ticket's classifier exists to police, which
      // is exactly why probing the boundary now needs the real library API
      // (pre-writes internal state, so the classifier stays silent) instead.
      const parkedAtAnchor = getScrollNode().scrollTop;
      let contentEndScroll: number | null = null;
      for (let top = parkedAtAnchor; top <= parkedAtAnchor + 4_000; top += 40) {
        await fireLibraryOwnedScrollTo(top);
        if (getScrollNode().dataset.scrollMode === "following-end") {
          contentEndScroll = getScrollNode().scrollTop;
          break;
        }
      }
      if (contentEndScroll === null) {
        throw new Error(
          "Never reached the content end within the probe range - test setup is wrong, not the assertion.",
        );
      }

      // Re-enter anchoring so we can probe the SHORT-OF-END case under the
      // same overflow geometry. A fresh local-provenance send does that.
      // Simpler: the probe above already proved the true edge flips; now
      // re-setup and park well short of that edge while still inside a
      // typical loose near-end band of the CONTENT range.
      //
      // Tear down and re-drive: park at contentEnd - 200 (strict fail) then
      // contentEnd (strict pass). Re-setup is the honest way after the flip
      // already consumed anchoring.
      cleanup();
      await setupOverflowingAnchoredTurn({
        scrollStateKey: "t11-e-strict-epsilon-2",
        sendId: "t11-e-send-2",
      });
      const end = contentEndScroll;

      // ~200px short of the true content end: scrollDeltaToRevealEnd >> 1,
      // so even if isNearEnd is true the strict gate must keep anchoring.
      // Library-owned (see above) - a bare write would cancel before the
      // strict-epsilon branch is even reached.
      await fireLibraryOwnedScrollTo(Math.max(0, end - 200));
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 50);
        });
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      // True live edge: strict epsilon satisfied → following-end.
      await fireLibraryOwnedScrollTo(end);
      await waitFor(
        () => {
          expect(getScrollNode().dataset.scrollMode).toBe("following-end");
        },
        { timeout: 2_000 },
      );
    });

    it("(f) includes the LegendList header pad in the anchored live-edge gate", async () => {
      const { afterOverflow } = await setupOverflowingAnchoredTurn({
        scrollStateKey: "t11-f-header-adjusted-edge",
        sendId: "t11-f-send",
      });

      const usableViewportHeight =
        VIEWPORT_HEIGHT_PX - 80 - CHAT_LIST_ANCHOR_OFFSET;
      const oldEarlyThreshold =
        afterOverflow.length * 90 - usableViewportHeight;

      // Row positions are content-relative, while scrollTop includes the
      // measured 40px LegendList header. The old mixed-coordinate gate
      // declared following-end here, one whole header before the real edge.
      //
      // Ticket 19: library-owned (not a bare `scrollTop` write) - see the
      // matching comment on test (e) above. A bare write would cancel the
      // session on this very first probe, before the header-pad gate this
      // test targets is ever reached.
      await fireLibraryOwnedScrollTo(oldEarlyThreshold);
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      await fireLibraryOwnedScrollTo(oldEarlyThreshold + LEGEND_LIST_HEADER_PX);
      await waitFor(
        () => {
          expect(getScrollNode().dataset.scrollMode).toBe("following-end");
        },
        { timeout: 2_000 },
      );
    });
  });

  // -------------------------------------------------------------------------
  // Ticket 10: settle/re-issue generalization + item-type split.
  // ANIMATED undershoot itself is jsdom-blind (no real animation timing);
  // pins exercise the settle/validate/re-issue LOGIC by driving geometry
  // between issue and settle (F2-style).
  // -------------------------------------------------------------------------
  describe("ticket 10: settle/re-issue navigation + item-type split", () => {
    /**
     * Ticket 10 F2-style: force the scroll node to land short of wherever
     * LegendList tries to place it, so the first settle's validate fails and
     * the re-issue path must recover. `enable` toggles the undershoot so a
     * later re-issue (or the final accept) can land honestly when cleared.
     */
    function installScrollUndershoot(
      scrollNode: HTMLElement,
      undershootPx: number,
    ): { setEnabled: (enabled: boolean) => void; dispose: () => void } {
      let enabled = true;
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
          if (!enabled) {
            stored = numeric;
            return;
          }
          stored = Math.max(0, numeric - undershootPx);
        },
      });
      return {
        setEnabled: (next: boolean) => {
          enabled = next;
        },
        dispose: () => {
          // Leave the last stored value; the prototype setter from the
          // viewport-metrics shim takes over again once this own-property
          // is removed.
          Reflect.deleteProperty(scrollNode, "scrollTop");
          scrollNode.scrollTop = stored;
        },
      };
    }

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
            return;
          }
          stored = numeric;
        },
      });
      try {
        // Deep-link scrollRequest shares navigateToMessage's choke point
        // (scrollToTimelineLocationSuppressingFollowRestore).
        rerenderWith({
          scrollRequest: {
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

    it("scrollToEnd settle re-issues to the true end after a short first landing", async () => {
      const messages = makeCompletedTranscript(24);
      renderChatMessages({
        messages,
        scrollStateKey: "t10-scroll-to-end-reissue",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      const freePark = getScrollNode().scrollTop;

      const scrollNode = getScrollNode();
      // Only the FIRST end-landing undershoots; re-issues land honestly so
      // the settle/validate/re-issue chain can converge (mirrors estimate →
      // measurement mid-flight, not permanent geometry sabotage).
      let undershootNextIncrease = true;
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
          if (undershootNextIncrease && numeric > stored + 100) {
            undershootNextIncrease = false;
            stored = Math.max(0, numeric - 600);
            return;
          }
          stored = numeric;
        },
      });
      try {
        fireEvent.click(screen.getByRole("button", { name: "Scroll to end" }));
        expect(getScrollNode().dataset.scrollMode).toBe("following-end");

        await waitForNavigationSettle();
        await waitForNavigationSettle();

        const recovered = getScrollNode().scrollTop;
        // Recovered past the free-scroll park and past the intentional
        // 600px undershoot of the first landing.
        expect(recovered).toBeGreaterThan(freePark + 600);
        expect(getScrollNode().dataset.scrollMode).toBe("following-end");
        expect(isJumpPillVisible()).toBe(false);

        // A second clean pill click must not move further - exact end.
        Reflect.deleteProperty(scrollNode, "scrollTop");
        scrollNode.scrollTop = recovered;
        fireEvent.click(getScrollToEndPill());
        await waitForNavigationSettle();
        expect(
          Math.abs(getScrollNode().scrollTop - recovered),
        ).toBeLessThanOrEqual(2);
      } finally {
        Reflect.deleteProperty(scrollNode, "scrollTop");
      }
    });

    it("scrollToEnd retry exhaustion reconciles to free-scrolling with the pill visible (never stranded following-end)", async () => {
      const messages = makeCompletedTranscript(24);
      renderChatMessages({
        messages,
        scrollStateKey: "t10-scroll-to-end-exhaust",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();

      const scrollNode = getScrollNode();
      // Keep undershooting for every attempt so validate never passes across
      // the bounded 3 retries + initial attempt.
      const undershoot = installScrollUndershoot(scrollNode, 600);
      try {
        fireEvent.click(screen.getByRole("button", { name: "Scroll to end" }));
        expect(getScrollNode().dataset.scrollMode).toBe("following-end");

        // initial settle + 3 re-issue settles = 4 * fallback.
        await act(async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, (CHAT_ANCHOR_SETTLE_FALLBACK_MS + 100) * 5);
          });
        });

        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
        expect(isJumpPillVisible()).toBe(true);
      } finally {
        undershoot.dispose();
      }
    });

    it("navigateToMessage settle chain aborts on a real mid-flight wheel gesture (no snap-back)", async () => {
      const messages = makeCompletedTranscript(30);
      renderChatMessages({
        messages,
        scrollStateKey: "t10-nav-abort-gesture",
      });
      await settleLegendList();

      const scrollNode = getScrollNode();
      const undershoot = installScrollUndershoot(scrollNode, 800);
      try {
        const minimapButton = screen.getByTestId("chat-turn-minimap-hit-strip");
        fireEvent.keyDown(minimapButton, { key: "Home" });
        await act(async () => {
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          });
        });
        fireEvent.keyDown(minimapButton, { key: "Enter" });

        // Mid-settle: a real wheel gesture must abort the re-issue chain
        // (generation bump + suppression clear). Park at a known offset.
        await act(async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 120);
          });
        });
        undershoot.setEnabled(false);
        act(() => {
          fireEvent.wheel(scrollNode, { deltaY: -80 });
          scrollNode.scrollTop = 220;
          fireEvent.scroll(scrollNode);
        });
        const parked = getScrollNode().scrollTop;
        expect(parked).toBe(220);

        // Wait well past any remaining settle/re-issue windows. A buggy
        // non-aborted re-issue would snap scroll away from the user's park.
        await act(async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, (CHAT_ANCHOR_SETTLE_FALLBACK_MS + 100) * 4);
          });
        });

        expect(getScrollNode().scrollTop).toBe(parked);
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      } finally {
        undershoot.dispose();
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

    it("getItemType splits human-sent user rows from A2A agent-sent rows", () => {
      const human = makeMessage(0, "user");
      expect(human.agentSenderInfo).toBeNull();
      expect(chatTimelineGetItemType(human)).toBe("user:human");

      const a2a: ChatMessageModel = {
        ...makeMessage(1, "user"),
        agentSenderInfo: {
          agentId: "agent-peer-1",
          senderTitle: "Peer",
          expectReply: false,
          responseId: null,
        },
      };
      expect(chatTimelineGetItemType(a2a)).toBe("user:a2a");
      expect(chatTimelineGetItemType(makeMessage(2, "assistant"))).toBe(
        "assistant",
      );
      // Distinct pools: the two user shapes must never collapse to one string.
      expect(chatTimelineGetItemType(human)).not.toBe(
        chatTimelineGetItemType(a2a),
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
  describe("ticket 12: sizePreservationEnabled interaction audit", () => {
    // jsdom-blind: a mounted row's measured size changing after the initial
    // estimate (MVCP size:true path). The shared shim uses fixed 90px row
    // heights; LegendList's ScrollAdjust sizeDiff only fires when its own
    // measurement pipeline observes a layout change, which the fixed-height
    // getBoundingClientRect override never produces. Extending the shim's
    // rect height alone is insufficient without driving LegendList's internal
    // size-at-index cache. Declared honestly rather than faked.

    it("L3 review fix: sizePreservationEnabled is wired true ONLY in free-scrolling, false in following-end AND anchoring-new-turn", async () => {
      // `maintainVisibleContentPosition.size` has no DOM signature to read
      // back directly - `data-size-preservation-enabled` (review-round
      // test-observability, mirrors `data-scroll-mode`'s own "not read by
      // any production code" contract) is the prop-level pin: the five
      // interaction-audit tests below only re-confirm EXISTING contracts
      // hold under the new wiring - none of them fail if the wiring itself
      // silently regresses to always-false (a mutation flip confirmed this:
      // all five stayed green).
      const sendId = "t12-l3-send";
      const messages = makeCompletedTranscript(10);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t12-l3-wiring",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      expect(getScrollNode().dataset.sizePreservationEnabled).toBe("false");

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().dataset.sizePreservationEnabled).toBe("true");

      const afterSend = appendOptimisticUserSend(messages, sendId, 500_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(getScrollNode().dataset.sizePreservationEnabled).toBe("false");
    });

    it("(1) anchoring drift re-assert still holds with sizePreservationEnabled=false during anchoring-new-turn", async () => {
      // Re-runs the existing Ticket 4 above-anchor growth pin under the
      // Ticket 12 wiring: anchoring-new-turn never enables size:true, so the
      // reveal-pass anchorPositionDrift re-assert must still single-correct.
      const ROW_HEIGHT_PX = 90;
      const initial = makeCompletedTranscript(4);
      const turn1Id = "t12-drift-turn1";
      const turn2Id = "t12-drift-turn2";
      const { rerenderMessages } = renderChatMessages({
        messages: initial,
        scrollStateKey: "t12-anchor-drift",
        localProvenanceMessageIds: new Set([turn1Id, turn2Id]),
      });
      await settleLegendList();

      const afterTurn1Send = appendOptimisticUserSend(
        initial,
        turn1Id,
        100_000,
      );
      rerenderMessages(afterTurn1Send);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${turn1Id}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();

      const afterTurn1Reply: ReadonlyArray<ChatMessageModel> = [
        ...afterTurn1Send,
        {
          ...makeMessageAt(0, "assistant", 100_001),
          id: "t12-turn1-reply",
          content: "OK",
          completedAt: 100_002,
          runState: null,
        },
      ];
      rerenderMessages(afterTurn1Reply);
      await settleLegendList();

      const afterTurn2Send = appendOptimisticUserSend(
        afterTurn1Reply,
        turn2Id,
        200_000,
      );
      rerenderMessages(afterTurn2Send);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${turn2Id}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await waitForAnchorEngineSettle();
      const scrollAfterSettle = getScrollNode().scrollTop;
      const turn2AnchorIndex = afterTurn2Send.length - 1;

      const withLateMetadata: ReadonlyArray<ChatMessageModel> = [
        ...afterTurn2Send.slice(0, turn2AnchorIndex),
        {
          ...makeMessageAt(0, "assistant", 100_003),
          id: "t12-turn1-late-metadata",
          content: "Thought for 4s",
          completedAt: 100_004,
          runState: null,
        },
        ...afterTurn2Send.slice(turn2AnchorIndex),
      ];
      rerenderMessages(withLateMetadata);
      await settleLegendList();
      await waitForRevealPassTick();
      await waitForRevealPassTick();

      // Reveal-pass re-assert: scroll advances by exactly one row (the
      // late metadata), not double-corrected by an accidental size:true.
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(getScrollNode().scrollTop - scrollAfterSettle).toBe(ROW_HEIGHT_PX);
    });

    it("(2) following-end maintainScrollAtEnd catch-up is unaffected (size:false there)", async () => {
      const messages = makeTranscript(20);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t12-follow-catchup",
      });
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");

      const before = getScrollNode().scrollTop;
      rerenderMessages(appendAssistant(messages, "t12-follow-stream", 130_000));
      await settleLegendList();

      await waitFor(() => {
        expect(getScrollNode().scrollTop).toBeGreaterThan(before);
      });
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
    });

    it("(3) disclosure helper skips its OWN manual correction under free-scrolling - MVCP is the sole owner there (M2 fix)", async () => {
      // Review round M2: static analysis proved the manual correction below
      // and LegendList's own MVCP size-correction are ADDITIVE (not self-
      // cancelling) when both fire for the same disclosure - an
      // over-correction. Ownership is now exclusive per mode:
      // `correctionOwnedByMvcp: true` (free-scrolling, sizePreservationEnabled)
      // must skip the manual scrollToOffset write entirely (mutate still
      // runs). ChatMessage is mocked in this suite, so a real activity-group
      // expand cannot drive LegendList's own row remeasure to independently
      // prove MVCP's side of the fix - the unit-level pins in
      // chat-scroll-disclosure.test.ts cover both ownership branches
      // directly; this test proves the free-scrolling INTEGRATION context
      // (a real ChatMessages render) still reaches the "owned by MVCP,
      // skip" branch, not just the pure-function contract in isolation.
      const messages = makeCompletedTranscript(16);
      renderChatMessages({
        messages,
        scrollStateKey: "t12-disclosure-single-delta",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      const scrollNode = getScrollNode();
      await fireScrollTopAndFlush(300);
      const before = scrollNode.scrollTop;

      // Synthetic list handle mirroring what ChatMessages passes the helper.
      const scrollToOffsetCalls: Array<{ offset: number }> = [];
      const listHandle = {
        getState: () => ({ scroll: before }),
        scrollToOffset: (opts: { offset: number; animated: boolean }) => {
          scrollToOffsetCalls.push({ offset: opts.offset });
          scrollNode.scrollTop = opts.offset;
        },
      };
      const anchor = document.createElement("div");
      const rect = vi.spyOn(anchor, "getBoundingClientRect");
      rect.mockReturnValueOnce({
        x: 0,
        y: 120,
        width: 100,
        height: 40,
        top: 120,
        left: 0,
        right: 100,
        bottom: 160,
        toJSON: () => ({}),
      });
      // Expand pushes the anchor top down by 80px (content above grew).
      rect.mockReturnValueOnce({
        x: 0,
        y: 200,
        width: 100,
        height: 40,
        top: 200,
        left: 0,
        right: 100,
        bottom: 240,
        toJSON: () => ({}),
      });

      const mutate = vi.fn();
      preserveChatScrollAcrossDisclosureChange({
        list: listHandle as never,
        anchorElement: anchor,
        mutate,
        // Mirrors `requestMeasuredItemChange`'s own
        // `timelineScrollModeRef.current === "free-scrolling"` computation -
        // true here since the mode was driven to free-scrolling above.
        correctionOwnedByMvcp: true,
      });

      expect(mutate).toHaveBeenCalledOnce();
      expect(scrollToOffsetCalls).toEqual([]);
      expect(scrollNode.scrollTop).toBe(before);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      rect.mockRestore();
    });

    it("(4) suppressed programmatic nav under free-scrolling never auto-restores follow (sizePreservation active)", async () => {
      const messages = makeCompletedTranscript(20);
      const anchorId = messages[4]?.id;
      expect(anchorId).toBeTruthy();
      const scrollStateKey = `t12-suppress-${Math.random().toString(36).slice(2)}`;

      saveChatTabState({
        identity: makeDefaultTestIdentity(scrollStateKey),
        mode: "free-scrolling",
        anchorMessageId: anchorId,
        anchorIndex: null,
        offset: 40,
      });

      renderChatMessages({ messages, scrollStateKey });
      await settleLegendList();
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // Programmatic near-end landing (no real gesture): suppression must
      // hold even with sizePreservationEnabled=true on free-scrolling.
      act(() => {
        fireScrollToEnd();
      });
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().dataset.scrollMode).not.toBe("following-end");
    });

    it("(5) ticket-5 free-scrolling restore bootstrap still lands the exact pixel with sizePreservation from first render", async () => {
      const messages = makeCompletedTranscript(20);
      const scrollStateKey = `t12-restore-${Math.random().toString(36).slice(2)}`;
      const instanceId = `t12-restore-inst-${Math.random().toString(36).slice(2)}`;

      tileLiveness.live = true;
      const first = renderChatMessages({
        messages,
        scrollStateKey,
        instanceId,
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await fireScrollTopAndFlush(360);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      const originalScrollTop = getScrollNode().scrollTop;
      expect(originalScrollTop).toBe(360);

      first.unmount();

      const second = renderChatMessages({
        messages,
        scrollStateKey,
        instanceId,
      });
      await settleLegendList();
      await settleLegendList();

      // Exact-pixel restore must not fight MVCP size-correction on bootstrap.
      expect(getScrollNode().scrollTop).toBe(originalScrollTop);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      second.unmount();
    });
  });

  describe("ticket 13: fork-marker candidacy (decision #27)", () => {
    /**
     * jsdom note: mount-time fresh-open seeds `timelineAnchorMessageId` and
     * mode correctly, but the LegendList anchor engine does not actually move
     * `scrollTop` on that first paint (scrollTop stays 0). The late-history
     * path (`empty → snapshot` through `beginAnchoringNewTurn`) DOES land a
     * real scrollTop - same candidate predicate, effect-driven. Pins (a)/(b)
     * therefore use late-history for the geometric assertion; a separate
     * mount-time pin below covers mode seed + row presence.
     */
    async function lateHistoryAnchor(
      history: ReadonlyArray<ChatMessageModel>,
      keyPrefix: string,
    ): Promise<{ scrollTop: number; unmount: () => void }> {
      // Ticket 15 review (live pass S5): a unique `epicId` per call, not just
      // a unique `scrollStateKey` - callers in this describe block invoke
      // this twice per test (control, subject) against the SAME default
      // epicId/taskId, so without this they share one durable chat-key.
      // Control's non-live unmount below commits its landed position to
      // THAT shared durable entry (F1's fix), which the hydration-retry
      // effect (live pass S5 fix) now genuinely chases as subject's
      // `messages` grows from `[]` - a real fix correctly acting on
      // leftover state that used to be silently dropped, surfacing this
      // test's own cross-call sharing rather than a defect in the fix.
      const { rerenderMessages, unmount } = renderChatMessages({
        messages: [],
        scrollStateKey: `${keyPrefix}-${Math.random().toString(36).slice(2)}`,
        epicId: `${keyPrefix}-epic-${Math.random().toString(36).slice(2)}`,
        freshOpen: true,
      });
      await settleLegendList();
      expect(screen.getByText("Start the conversation")).toBeTruthy();
      rerenderMessages(history);
      await settleLegendList();
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      return { scrollTop: getScrollNode().scrollTop, unmount };
    }

    it("(pin a) fresh fork open anchors the fork marker, not the last copied user query", async () => {
      // Copied history ends with a user/assistant pair; the fork marker sits
      // after every copied row. Decision #27 lands on the marker; pre-#27
      // lands on the last user two indices earlier. Uniform 90px rows.
      const prefix = makeCompletedTranscript(20);
      // last user = message-18 at index 18; marker at index 20 → delta 2.
      const lastUserId = "message-18";
      const markerId = "forked-chat-link:fork-open-a";
      const withMarker: ReadonlyArray<ChatMessageModel> = [
        ...prefix,
        forkMarkerRow(markerId, 10_000),
      ];

      const control = await lateHistoryAnchor(prefix, "t13-pin-a-control");
      expect(control.scrollTop).toBeGreaterThan(0);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${lastUserId}`)).toBeTruthy();
      });
      control.unmount();

      const subject = await lateHistoryAnchor(withMarker, "t13-pin-a-subject");
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${markerId}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(subject.scrollTop - control.scrollTop).toBe(
        2 * TICKET_13_ROW_HEIGHT_PX,
      );
      subject.unmount();
    });

    it("(pin b) fork with a newer user turn anchors that turn (self-superseding)", async () => {
      // Same long prefix + marker as pin (a), plus a real user send after the
      // marker. findLast must pick the newer user, not stick on the marker.
      const prefix = makeCompletedTranscript(20);
      const markerId = "forked-chat-link:fork-open-b";
      const newUserId = "user-fork-turn-b";
      const withMarker: ReadonlyArray<ChatMessageModel> = [
        ...prefix,
        forkMarkerRow(markerId, 10_000),
      ];
      const withNewTurn: ReadonlyArray<ChatMessageModel> = [
        ...withMarker,
        {
          ...makeMessageAt(0, "user", 20_000),
          id: newUserId,
          content: "first turn in the fork",
          completedAt: null,
        },
      ];

      const control = await lateHistoryAnchor(withMarker, "t13-pin-b-control");
      expect(control.scrollTop).toBeGreaterThan(0);
      control.unmount();

      const subject = await lateHistoryAnchor(withNewTurn, "t13-pin-b-subject");
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${newUserId}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(subject.scrollTop - control.scrollTop).toBe(
        TICKET_13_ROW_HEIGHT_PX,
      );
      subject.unmount();
    });

    it("mount-time freshOpen seed enters anchoring-new-turn on a fork-marker-only transcript", async () => {
      // Complements the late-history geometric pins: the mount-time
      // `freshOpenAnchorMessageId` initializer must also accept the marker
      // (mode seed is sync; jsdom does not land scrollTop on this path).
      // Marker-ONLY so a user-only candidate regression cannot hide behind a
      // copied user row still seeding anchoring-new-turn.
      const markerId = "forked-chat-link:mount-seed";
      const messages: ReadonlyArray<ChatMessageModel> = [
        forkMarkerRow(markerId, 10_000),
      ];
      renderChatMessages({
        messages,
        scrollStateKey: `t13-mount-seed-${Math.random().toString(36).slice(2)}`,
        freshOpen: true,
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await settleLegendList();
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${markerId}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
    });

    it("late-history empty→fork-marker-only snapshot anchors the marker (effect path, not just mount seed)", async () => {
      // Mount-time `freshOpenAnchorMessageId` sees an empty transcript and
      // seeds null. The late-history branch of `classifyChatEdgeMutation`
      // (`!hadSavedScrollState`) must still widen to the fork marker when the
      // snapshot arrives - same decision #27 predicate as the mount seed.
      const markerId = "forked-chat-link:late-history";
      const history: ReadonlyArray<ChatMessageModel> = [
        forkMarkerRow(markerId, 1),
      ];
      const { rerenderMessages } = renderChatMessages({
        messages: [],
        scrollStateKey: `t13-late-fork-${Math.random().toString(36).slice(2)}`,
        freshOpen: true,
      });
      await settleLegendList();
      expect(screen.getByText("Start the conversation")).toBeTruthy();

      rerenderMessages(history);
      await settleLegendList();
      await waitForAnchorEngineSettle();

      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${markerId}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
    });
  });

  describe("ticket 13: setup-card turn-group anchoring (decision #28)", () => {
    it("(pin c) beginAnchoringNewTurn with a setup card already above the send lands on the card", async () => {
      // Decision #28 at begin time (card already woven when the send is
      // classified - genesis pin and mid-chat card that raced ahead of the
      // optimistic row both look like this). Control: send with no card →
      // anchors the send at history.length. Subject: card + send arrive
      // together → resolveChatAnchorTargetWithSetupCard rewrites the target
      // to the card, which occupies the SAME index the control's send used
      // (content above is identical) → bit-for-bit same scrollTop. Without
      // the resolve, subject lands on the send one slot later (+90px).
      // (Mount-time fresh-open leaves scrollTop at 0 in jsdom, so the
      // geometric pin uses the live beginAnchoringNewTurn path; pure-function
      // pin c covers the genesis-shaped array walk.)
      const history = makeCompletedTranscript(16);
      const sendId = "user-pin-c-send";
      const cardId = "setup-card:owner-1:0:pin-c";

      // Ticket 15 review (live pass S5 round 3): a unique `epicId` per
      // render, not just a unique `scrollStateKey` - `control` and
      // `subject` otherwise share the default epicId/taskId durable
      // chat-key. `control`'s unmount below now (correctly, per the round-3
      // fix) commits a coherent durable entry for its active anchor session;
      // without this
      // isolation, `subject`'s own mount would inherit it via
      // `hasSavedChatTabState`/`restoredTabState`, skipping the
      // following-end default this test's `subject` assumes.
      const control = renderChatMessages({
        messages: history,
        scrollStateKey: `t13-pin-c-control-${Math.random().toString(36).slice(2)}`,
        epicId: `t13-pin-c-control-epic-${Math.random().toString(36).slice(2)}`,
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();
      const controlAfterSend = appendOptimisticUserSend(
        history,
        sendId,
        500_000,
      );
      control.rerenderMessages(controlAfterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      const controlScrollTop = getScrollNode().scrollTop;
      expect(controlScrollTop).toBeGreaterThan(0);
      control.unmount();

      const subject = renderChatMessages({
        messages: history,
        scrollStateKey: `t13-pin-c-subject-${Math.random().toString(36).slice(2)}`,
        epicId: `t13-pin-c-subject-epic-${Math.random().toString(36).slice(2)}`,
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();
      // Card already above the send when the anchor-new-turn fires (no mid-
      // weave retarget - pure begin-time substitution).
      const subjectAfter: ReadonlyArray<ChatMessageModel> = [
        ...history,
        setupCardRow(cardId, 499_999, sendId),
        {
          ...makeMessageAt(0, "user", 500_000),
          id: sendId,
          content: "hello from send",
          persistentMessageId: null,
        },
      ];
      subject.rerenderMessages(subjectAfter);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${cardId}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(getScrollNode().scrollTop).toBe(controlScrollTop);
      // Provenance consumed with the RAW send id, not the card substitute.
      expect(subject.getLocalProvenanceMessageIds().has(sendId)).toBe(false);
      subject.unmount();
    });

    it("(pin d) mid-anchoring setup-card weave retargets the anchor to the card, without exiting anchoring-new-turn", async () => {
      // Row height is uniform (90px, ITEM_HEIGHT_PX) under the jsdom shim: the
      // card takes over the EXACT array slot the send row occupied before the
      // weave, so a correct retarget lands at the bit-for-bit SAME scrollTop -
      // not shifted by one row height, which is what leaving
      // `maintainVisibleContentPosition` to keep the send row pixel-stable
      // (the pre-ticket-13 behavior) would do, scrolling the new card
      // off-screen above the still-anchored send row instead of revealing it.
      // Also pins that `consumeLocalProvenance` still receives the RAW send
      // id (the card is never a provenance entry; substituting it would leave
      // the real send never consumed).
      const initial = makeCompletedTranscript(6);
      const sendId = "user-worktree-send";
      const { rerenderMessages, getLocalProvenanceMessageIds } =
        renderChatMessages({
          messages: initial,
          scrollStateKey: "t13-retarget-key",
          localProvenanceMessageIds: new Set([sendId]),
        });
      await settleLegendList();

      const afterSend = appendOptimisticUserSend(initial, sendId, 500_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      // Provenance for the send is consumed on the anchor-new-turn outcome,
      // before any card weave - still the raw send id.
      expect(getLocalProvenanceMessageIds().has(sendId)).toBe(false);
      const scrollBeforeCard = getScrollNode().scrollTop;

      // The `setup.creating` event lands async - the card weaves in directly
      // above the send row (by `triggeringMessageId`), at the exact index
      // the send row used to occupy.
      const sendIndex = afterSend.findIndex((message) => message.id === sendId);
      const card = setupCardRow(
        `setup-card:owner-1:0:${sendId}`,
        499_999,
        sendId,
      );
      const afterCard: ReadonlyArray<ChatMessageModel> = [
        ...afterSend.slice(0, sendIndex),
        card,
        ...afterSend.slice(sendIndex),
      ];
      rerenderMessages(afterCard);
      await waitForAnchorEngineSettle();

      // Still the SAME anchoring session - a retarget, not a cancel/exit.
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(screen.getByTestId(`mock-message-${card.id}`)).toBeTruthy();

      const scrollAfterCard = getScrollNode().scrollTop;
      expect(scrollAfterCard).toBe(scrollBeforeCard);
      // Card weave is a `none` outcome - provenance set stays empty (the
      // send was already consumed; we never re-added the card id).
      expect(getLocalProvenanceMessageIds().has(sendId)).toBe(false);
      expect(getLocalProvenanceMessageIds().has(card.id)).toBe(false);
    });

    it("(pin e) mid-chat setup card woven above a NON-anchored message leaves the active anchor untouched", async () => {
      // Anchoring turn N (the latest send). A setup card for an EARLIER turn
      // weaves in elsewhere in the transcript - classify as `none`, and
      // `resolveChatAnchorTargetWithSetupCard` from the CURRENT target finds
      // no card above it, so retarget is a no-op. scrollTop and mode hold.
      const initial = makeCompletedTranscript(6);
      const sendId = "user-turn-n-send";
      const earlierUserId = "message-2"; // index 2 in the prefix
      const { rerenderMessages } = renderChatMessages({
        messages: initial,
        scrollStateKey: "t13-pin-e-key",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      const afterSend = appendOptimisticUserSend(initial, sendId, 500_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      const scrollBeforeWeave = getScrollNode().scrollTop;

      // Weave a card above an EARLIER user row (not the anchored send).
      const earlierIndex = afterSend.findIndex(
        (message) => message.id === earlierUserId,
      );
      expect(earlierIndex).toBeGreaterThanOrEqual(0);
      const foreignCard = setupCardRow(
        `setup-card:owner-1:0:${earlierUserId}`,
        100,
        earlierUserId,
      );
      const afterForeignCard: ReadonlyArray<ChatMessageModel> = [
        ...afterSend.slice(0, earlierIndex),
        foreignCard,
        ...afterSend.slice(earlierIndex),
      ];
      // Inserting above an earlier row shifts every later row (including the
      // anchored send) down by one slot. MVCP should keep the anchored send's
      // pixel position stable for a `none` non-retarget outcome - scrollTop
      // rises by exactly one row height so the SAME row stays on-screen at
      // the same visual place. Retargeting to the foreign card would jump
      // scrollTop back toward the earlier index (a multi-row shift).
      rerenderMessages(afterForeignCard);
      await waitForAnchorEngineSettle();

      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      // Still showing the send, not retargeted onto the foreign card.
      expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      // MVCP holds the anchored row's visual place: +1 row of content above.
      expect(getScrollNode().scrollTop).toBe(
        scrollBeforeWeave + TICKET_13_ROW_HEIGHT_PX,
      );
    });

    it("newer user send after a setup-card retarget re-derives on the new send (decision #28 never sticks)", async () => {
      // After pin (d)'s retarget has pointed the session at a setup card, a
      // REAL subsequent user send must begin a new anchoring session on that
      // send - not stick to the stale card from the previous turn. Delta from
      // card → second send is exactly 2 rows (card, firstSend, secondSend).
      const history = makeCompletedTranscript(16);
      const firstSendId = "user-sticky-first-send";
      const secondSendId = "user-sticky-second-send";
      const cardId = "setup-card:owner-1:0:sticky";
      const { rerenderMessages, getLocalProvenanceMessageIds } =
        renderChatMessages({
          messages: history,
          scrollStateKey: `t13-sticky-${Math.random().toString(36).slice(2)}`,
          localProvenanceMessageIds: new Set([firstSendId, secondSendId]),
        });
      await settleLegendList();

      // First send + card weave → retarget onto the card (decision #28 live).
      const afterFirstSend = appendOptimisticUserSend(
        history,
        firstSendId,
        500_000,
      );
      rerenderMessages(afterFirstSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${firstSendId}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();
      const firstSendIndex = afterFirstSend.findIndex(
        (message) => message.id === firstSendId,
      );
      const card = setupCardRow(cardId, 499_999, firstSendId);
      const afterCard: ReadonlyArray<ChatMessageModel> = [
        ...afterFirstSend.slice(0, firstSendIndex),
        card,
        ...afterFirstSend.slice(firstSendIndex),
      ];
      rerenderMessages(afterCard);
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      const scrollOnCard = getScrollNode().scrollTop;
      expect(scrollOnCard).toBeGreaterThan(0);

      // Second send: no setup card for this turn. Must re-derive onto the
      // new send. Array: [...history, card, firstSend, secondSend] → delta 2.
      const afterSecondSend = appendOptimisticUserSend(
        afterCard,
        secondSendId,
        600_000,
      );
      rerenderMessages(afterSecondSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${secondSendId}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(getScrollNode().scrollTop - scrollOnCard).toBe(
        2 * TICKET_13_ROW_HEIGHT_PX,
      );
      // Second send's provenance was consumed on the anchor-new-turn outcome
      // (raw send id, not the previous turn's card).
      expect(getLocalProvenanceMessageIds().has(secondSendId)).toBe(false);
    });
  });

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
  describe("ticket 18: send-anchor validated convergence", () => {
    const T18_ROW_HEIGHT_PX = 90;
    const T18_HEADER_PX = LEGEND_LIST_HEADER_PX;

    /**
     * Ticket 10 F2-style undershoot: force programmatic scroll jumps short of
     * their requested target so the first settle's validate fails and the
     * re-issue path must recover. `maxCorruptJumps` limits how many large
     * jumps are sabotaged (cleared afterward so a later reissue can land).
     *
     * Harness note: free-scroll-to-top + anchor scrollToIndex does not stick
     * scrollTop in this jsdom LegendList setup (0 HTMLElement.scrollTo calls
     * observed) - the same limitation ticket 4's free-scroll send pin never
     * asserted absolute offsets for. Pins below drive from following-end
     * (where scrollToIndex is known to stick) and sabotage landings instead.
     */
    function installAnchorScrollUndershoot(
      scrollNode: HTMLElement,
      undershootPx: number,
      maxCorruptJumps: number,
    ): { setEnabled: (enabled: boolean) => void; dispose: () => void } {
      let enabled = true;
      let remainingCorrupt = maxCorruptJumps;
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
          if (
            enabled &&
            remainingCorrupt > 0 &&
            Math.abs(numeric - stored) > 80
          ) {
            remainingCorrupt -= 1;
            // Jump toward the end is numeric > stored; short landing = less
            // travel. Jump upward is the inverse.
            stored =
              numeric > stored
                ? Math.max(0, numeric - undershootPx)
                : numeric + undershootPx;
            return;
          }
          stored = numeric;
        },
      });
      return {
        setEnabled: (next: boolean) => {
          enabled = next;
        },
        dispose: () => {
          Reflect.deleteProperty(scrollNode, "scrollTop");
          scrollNode.scrollTop = stored;
        },
      };
    }

    function expectedAnchorScrollTopForIndex(anchorIndex: number): number {
      return (
        anchorIndex * T18_ROW_HEIGHT_PX +
        T18_HEADER_PX -
        CHAT_LIST_ANCHOR_OFFSET
      );
    }

    async function waitForMultiRetryAnchorSettle(): Promise<void> {
      // Initial issue + up to 3 reissues. Promise settle is usually fast in
      // jsdom (sync scrollTo); cover the anchor engine's own (wider,
      // review-fix) watchdog window per attempt, not the shorter plain-nav
      // fallback other settle paths use.
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(
            resolve,
            (CHAT_TIMELINE_ANCHOR_SCROLL_PROMISE_TIMEOUT_MS + 100) * 5,
          );
        });
      });
    }

    function scrollToOptionsFromCallArg(
      arg: unknown,
    ):
      | { readonly top: number; readonly behavior: ScrollBehavior | undefined }
      | undefined {
      if (arg === null || typeof arg !== "object") return undefined;
      if (!("top" in arg)) return undefined;
      const record = arg as { top: unknown; behavior?: unknown };
      if (typeof record.top !== "number" || !Number.isFinite(record.top)) {
        return undefined;
      }
      const behavior =
        typeof record.behavior === "string"
          ? (record.behavior as ScrollBehavior)
          : undefined;
      return { top: record.top, behavior };
    }

    function firstScrollBehaviorAfter(
      scrollToSpy: {
        readonly mock: {
          readonly calls: ReadonlyArray<ReadonlyArray<unknown>>;
        };
      },
      callsBefore: number,
    ): ScrollBehavior | undefined {
      const newCalls = scrollToSpy.mock.calls.slice(callsBefore);
      for (const call of newCalls) {
        const options = scrollToOptionsFromCallArg(call[0]);
        if (options === undefined) continue;
        return options.behavior;
      }
      return undefined;
    }

    async function flushAnchorPositionFrames(): Promise<void> {
      await act(async () => {
        for (let frame = 0; frame < 10; frame += 1) {
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          });
        }
      });
    }

    it("(pin A) send recovers via validated reissue to the exact fade-safe anchor offset after short landings", async () => {
      // Regression pin for the validated-convergence loop (rootcause probe's
      // "instant OR animated + reissue → fade-safe offset" half). jsdom
      // cannot freeze a mid-flight animated pixel endpoint; F2 undershoot is
      // the deterministic stand-in for estimate drift.
      const history = makeCompletedTranscript(40);
      const sendId = "t18-pin-a-send";
      const { rerenderMessages } = renderChatMessages({
        messages: history,
        scrollStateKey: "t18-pin-a",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      const scrollNode = getScrollNode();
      // Sabotage the first two large jumps; the next reissue lands honestly.
      const undershoot = installAnchorScrollUndershoot(scrollNode, 500, 2);
      try {
        const afterSend = appendOptimisticUserSend(history, sendId, 700_000);
        rerenderMessages(afterSend);
        await waitFor(() => {
          expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
        });
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
        await waitForMultiRetryAnchorSettle();

        const expected = expectedAnchorScrollTopForIndex(afterSend.length - 1);
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
        expect(
          Math.abs(getScrollNode().scrollTop - expected),
        ).toBeLessThanOrEqual(1);
      } finally {
        undershoot.dispose();
      }
    });

    it("(pin B near) initial scrollToIndex is animated for a near multi-turn send", async () => {
      // Second turn from a settled first: distance is one short reply + send
      // (~2 rows) ≪ 1.5 viewports, and prior rows are measured so
      // expectedScrollTopAtIssue is finite (unmeasured targets default to
      // far/instant). Real send keeps anchorAnimatedRef true → smooth.
      const initial = makeCompletedTranscript(8);
      const turn1Id = "t18-pin-b-near-t1";
      const turn2Id = "t18-pin-b-near-t2";
      const realisticScrollHeight =
        (initial.length + 12) * T18_ROW_HEIGHT_PX + T18_HEADER_PX + 2_000;
      setLegendListScrollContainerScrollHeightOverride(realisticScrollHeight);
      try {
        const { rerenderMessages } = renderChatMessages({
          messages: initial,
          scrollStateKey: "t18-pin-b-near",
          localProvenanceMessageIds: new Set([turn1Id, turn2Id]),
        });
        await settleLegendList();

        const afterTurn1 = appendOptimisticUserSend(initial, turn1Id, 100_000);
        rerenderMessages(afterTurn1);
        await waitFor(() => {
          expect(screen.getByTestId(`mock-message-${turn1Id}`)).toBeTruthy();
        });
        await waitForAnchorEngineSettle();

        const afterTurn1Reply: ReadonlyArray<ChatMessageModel> = [
          ...afterTurn1,
          {
            ...makeMessageAt(0, "assistant", 100_001),
            id: "t18-pin-b-near-reply",
            content: "OK",
            completedAt: 100_002,
            runState: null,
          },
        ];
        rerenderMessages(afterTurn1Reply);
        await settleLegendList();

        const scrollToSpy = vi.spyOn(HTMLElement.prototype, "scrollTo");
        const callsBefore = scrollToSpy.mock.calls.length;

        const afterTurn2 = appendOptimisticUserSend(
          afterTurn1Reply,
          turn2Id,
          200_000,
        );
        rerenderMessages(afterTurn2);
        await waitFor(() => {
          expect(screen.getByTestId(`mock-message-${turn2Id}`)).toBeTruthy();
        });
        await flushAnchorPositionFrames();

        const expectedTop = expectedAnchorScrollTopForIndex(
          afterTurn2.length - 1,
        );
        const newCalls = scrollToSpy.mock.calls.slice(callsBefore);
        let anchorBehavior: ScrollBehavior | undefined;
        for (const call of newCalls) {
          const options = scrollToOptionsFromCallArg(call[0]);
          if (options === undefined) continue;
          if (Math.abs(options.top - expectedTop) > 2) continue;
          anchorBehavior = options.behavior;
          break;
        }
        expect(anchorBehavior).toBe("smooth");
      } finally {
        setLegendListScrollContainerScrollHeightOverride(null);
      }
    });

    it("(pin B far/instant intent) fresh-open seed issues instant scroll (animated:false)", async () => {
      // Distance-based far jump is jsdom-limited (park-away leaves
      // scrollToIndex unissued in this harness). Pin the OTHER half of
      // shouldAnimateInitialIssue: anchorAnimatedRef is false for the
      // fresh-open seed (decision #15) → instant regardless of distance.
      const messages = makeCompletedTranscript(24);
      const scrollStateKey = `t18-pin-b-fresh-${Math.random().toString(36).slice(2)}`;
      expect(
        hasSavedChatTabState(makeDefaultTestIdentity(scrollStateKey)),
      ).toBe(false);

      const scrollToSpy = vi.spyOn(HTMLElement.prototype, "scrollTo");
      const callsBefore = scrollToSpy.mock.calls.length;

      renderChatMessages({
        messages,
        scrollStateKey,
        freshOpen: true,
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await settleLegendList();
      await flushAnchorPositionFrames();
      await waitForAnchorEngineSettle();

      // Fresh-open may bootstrap via initialScrollIndex rather than a later
      // scrollToIndex; when a post-mount scroll DOES fire it must be instant.
      const behavior = firstScrollBehaviorAfter(scrollToSpy, callsBefore);
      if (behavior !== undefined) {
        expect(behavior).toBe("auto");
      }
      // Mode + target row still pin the seed path ran.
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await waitFor(() => {
        expect(screen.getByTestId("mock-message-message-22")).toBeTruthy();
      });
    });

    it("(pin C) retry exhaustion fails safe to free-scrolling + pill and warns once (never writes settled)", async () => {
      const history = makeCompletedTranscript(24);
      const sendId = "t18-pin-c-exhaust-send";
      const { rerenderMessages } = renderChatMessages({
        messages: history,
        scrollStateKey: "t18-pin-c-exhaust",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      const warnSpy = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
      const scrollNode = getScrollNode();
      // Permanent undershoot: every attempt lands short → validate never
      // passes across initial + 3 retries.
      const undershoot = installAnchorScrollUndershoot(scrollNode, 400, 99);
      try {
        const afterSend = appendOptimisticUserSend(history, sendId, 740_000);
        rerenderMessages(afterSend);
        await waitFor(() => {
          expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
        });
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

        await waitForMultiRetryAnchorSettle();

        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
        expect(isJumpPillVisible()).toBe(true);

        const exhaustWarns = warnSpy.mock.calls.filter(
          (call) =>
            call[0] ===
            "[chat-messages] anchor settle exhausted retries without a validated landing",
        );
        expect(exhaustWarns).toHaveLength(1);
        expect(exhaustWarns[0]?.[1]).toMatchObject({
          messageId: sendId,
        });
      } finally {
        undershoot.dispose();
        warnSpy.mockRestore();
      }
    });

    it("(pin D) scroll-only reader departure mid-settle fails safe without the exhaust warn", async () => {
      // OS-scrollbar-drag style: scrollTop moves up with no wheel/touch/
      // pointerdown generation bump. shouldYieldToReader must win and
      // onSettledInvalid must NOT log the non-convergence warn.
      // Pure-function coverage of anchorMoverShouldYieldToReader already
      // exists in ticket 4 ("distinguishes a scroll-only settle departure…");
      // this pin is the NEW loop-integration behavior.
      const history = makeCompletedTranscript(24);
      const sendId = "t18-pin-d-yield-send";
      const { rerenderMessages } = renderChatMessages({
        messages: history,
        scrollStateKey: "t18-pin-d-yield",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      const warnSpy = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
      const scrollNode = getScrollNode();
      // Keep landings short so settle stays in-flight long enough for a
      // mid-loop yield without converging first.
      const undershoot = installAnchorScrollUndershoot(scrollNode, 400, 99);
      try {
        const afterSend = appendOptimisticUserSend(history, sendId, 750_000);
        rerenderMessages(afterSend);
        await waitFor(() => {
          expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
        });
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

        // Let the first issue land short, then simulate an OS-scrollbar drag
        // upward (no generation-bumping gesture).
        await act(async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 120);
          });
        });
        undershoot.setEnabled(false);
        const departed = Math.max(0, getScrollNode().scrollTop - 500);
        act(() => {
          scrollNode.scrollTop = departed;
          fireEvent.scroll(scrollNode);
        });

        await waitForMultiRetryAnchorSettle();

        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
        const exhaustWarns = warnSpy.mock.calls.filter(
          (call) =>
            call[0] ===
            "[chat-messages] anchor settle exhausted retries without a validated landing",
        );
        expect(exhaustWarns).toHaveLength(0);
      } finally {
        undershoot.dispose();
        warnSpy.mockRestore();
      }
    });

    it("(pin E) overflowed anchored turn still repairs content-above drift (reveal-effect reorder regression)", async () => {
      // Pre-ticket-18 order: overflow early-return ran BEFORE the anchor-
      // position repair, so a turn that already overflows never corrected
      // content-above growth. Existing ticket 4 pin covers the non-overflow
      // content-above case; this one requires overflow first.
      const history = makeCompletedTranscript(10);
      const sendId = "t18-pin-e-overflow-repair";
      const { rerenderMessages } = renderChatMessages({
        messages: history,
        scrollStateKey: "t18-pin-e-overflow-repair",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      const afterSend = appendOptimisticUserSend(history, sendId, 760_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      // Grow past usable viewport → streaming pill (overflow true).
      let current = afterSend;
      let overflowed = false;
      for (let chunkIndex = 0; chunkIndex < 20; chunkIndex += 1) {
        current = appendOneStreamingChunk(current, chunkIndex, 760_000);
        rerenderMessages(current);
        await waitForRevealPassTick();
        if (isJumpPillVisible()) {
          overflowed = true;
          break;
        }
      }
      expect(overflowed).toBe(true);
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      const scrollAtOverflow = getScrollNode().scrollTop;

      // Content ABOVE the still-anchored send grows after overflow.
      const anchorIndex = current.findIndex((message) => message.id === sendId);
      expect(anchorIndex).toBeGreaterThan(0);
      const withLateMetadata: ReadonlyArray<ChatMessageModel> = [
        ...current.slice(0, anchorIndex),
        {
          ...makeMessageAt(0, "assistant", 759_000),
          id: "t18-pin-e-late-above",
          content: "Thought for 4s",
          completedAt: 759_001,
          runState: null,
        },
        ...current.slice(anchorIndex),
      ];
      rerenderMessages(withLateMetadata);
      await waitForRevealPassTick();
      await waitForRevealPassTick();

      // Repair must still run despite overflowsUsableViewport: scroll grows
      // by exactly one row so the anchor holds its fade-safe offset.
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(getScrollNode().scrollTop - scrollAtOverflow).toBe(
        T18_ROW_HEIGHT_PX,
      );
    });

    it("(pin F) same-turn steer path also converges to the exact fade-safe offset (not send-only)", async () => {
      // Decision #8 events share beginAnchoringNewTurn. Ticket 4 already pins
      // mode engagement for send/steer/queued/fresh-open; this extends the
      // NEW convergence landing assertion to the steer-shaped insert.
      const base = makeCompletedTranscript(24);
      const trailingAssistant: ChatMessageModel = {
        ...makeMessageAt(0, "assistant", 400_000),
        id: "t18-pin-f-trailing-asst",
        content: "still running",
        completedAt: null,
        runState: "running",
      };
      const initial: ReadonlyArray<ChatMessageModel> = [
        ...base,
        trailingAssistant,
      ];
      const steerId = "t18-pin-f-steer";
      const { rerenderMessages } = renderChatMessages({
        messages: initial,
        scrollStateKey: "t18-pin-f-steer",
        localProvenanceMessageIds: new Set([steerId]),
      });
      await settleLegendList();

      const scrollNode = getScrollNode();
      const undershoot = installAnchorScrollUndershoot(scrollNode, 400, 2);
      try {
        // Steer shape: new local user spliced BEFORE the still-present
        // trailing assistant (H2 / same-turn steering).
        const afterSteer: ReadonlyArray<ChatMessageModel> = [
          ...base,
          {
            ...makeMessageAt(0, "user", 401_000),
            id: steerId,
            content: "steer instruction",
            persistentMessageId: null,
          },
          trailingAssistant,
        ];
        rerenderMessages(afterSteer);
        await waitFor(() => {
          expect(screen.getByTestId(`mock-message-${steerId}`)).toBeTruthy();
        });
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
        await waitForMultiRetryAnchorSettle();

        const steerIndex = afterSteer.findIndex(
          (message) => message.id === steerId,
        );
        const expected = expectedAnchorScrollTopForIndex(steerIndex);
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
        expect(
          Math.abs(getScrollNode().scrollTop - expected),
        ).toBeLessThanOrEqual(1);
      } finally {
        undershoot.dispose();
      }
    });

    it("(pin G, review round 2 residual) a watchdog-timeout wakeup never settles even when the DOM sits exactly at the target - it reissues/fails safe instead", async () => {
      // Source-proven residual: LegendList's own contract is TWO sequential
      // windows before its promise resolves - a readiness poll up to
      // IMPERATIVE_SCROLL_SETTLE_MAX_WAIT_MS (800ms) BEFORE it even issues
      // the scroll, then SCROLL_END_MAX_MS (1500ms) of animated ownership
      // after. A finite fallback can still fire while the DOM is
      // TRANSIENTLY at the target without the library's own promise having
      // resolved. `validate` must therefore treat a timed-out wakeup as an
      // unconditional failure - never settle off it - regardless of what
      // the geometry says. Simulated here by applying the REAL scroll (so
      // the DOM lands exactly where the library would place it - the
      // "transient crossing" case) but returning a promise that never
      // resolves, so only the watchdog can ever wake this settle.
      const history = makeCompletedTranscript(24);
      const sendId = "t18-pin-g-watchdog-send";
      const { rerenderMessages } = renderChatMessages({
        messages: history,
        scrollStateKey: "t18-pin-g-watchdog",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      await waitFor(() => {
        expect(legendListRefHolder.current).not.toBeNull();
      });
      const list = legendListRefHolder.current;
      if (!list) throw new Error("expected LegendListRef to be attached");
      const originalScrollToIndex = list.scrollToIndex.bind(list);
      const hangingScrollToIndex = vi
        .spyOn(list, "scrollToIndex")
        .mockImplementation((params) => {
          void originalScrollToIndex(params);
          return new Promise<void>(() => {});
        });
      const warnSpy = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
      try {
        const afterSend = appendOptimisticUserSend(history, sendId, 770_000);
        rerenderMessages(afterSend);
        await waitFor(() => {
          expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
        });
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

        // Every attempt's promise hangs -> every attempt times out ->
        // validate is unconditionally false regardless of the (actually
        // correct) DOM position -> retries exhaust -> fail-safe, never a
        // phantom settle at the transiently-correct position.
        await waitForMultiRetryAnchorSettle();

        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
        expect(isJumpPillVisible()).toBe(true);

        const exhaustWarns = warnSpy.mock.calls.filter(
          (call) =>
            call[0] ===
            "[chat-messages] anchor settle exhausted retries without a validated landing",
        );
        expect(exhaustWarns).toHaveLength(1);
        expect(exhaustWarns[0]?.[1]).toMatchObject({ messageId: sendId });
      } finally {
        hangingScrollToIndex.mockRestore();
        warnSpy.mockRestore();
      }
    });
  });

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

    it("releases both persistence gates when an unreachable saved coordinate exhausts restore retries", () => {
      const restorePersistencePendingRef = { current: true };
      const pendingMeasuredRestoreRef = {
        current: { messageId: "saved-row", viewOffset: 10_000 },
      };

      acceptExhaustedPersistedRestoreFallback(
        restorePersistencePendingRef,
        pendingMeasuredRestoreRef,
      );

      expect(restorePersistencePendingRef.current).toBe(false);
      expect(pendingMeasuredRestoreRef.current).toBeNull();
    });

    it("streaming fresh-open (no saved state) seeds following-end, not the idle anchor candidate", async () => {
      const messages = makeCompletedTranscript(16);
      const key = `t15-stream-fresh-${Math.random().toString(36).slice(2)}`;
      expect(hasSavedChatTabState(makeDefaultTestIdentity(key))).toBe(false);

      renderChatMessages({
        messages,
        scrollStateKey: key,
        freshOpen: true,
        isChatStreaming: true,
      });
      await settleLegendList();

      // Idle fresh-open would enter anchoring-new-turn on the last user
      // message. Streaming fresh-open skips that scan and stays following-end.
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      expect(getScrollNode().dataset.scrollMode).not.toBe("anchoring-new-turn");
      expect(isJumpPillVisible()).toBe(false);
    });

    it("idle fresh-open still anchors the last user message (ticket-13 path unchanged)", async () => {
      const messages = makeCompletedTranscript(16);
      const key = `t15-idle-fresh-${Math.random().toString(36).slice(2)}`;
      expect(hasSavedChatTabState(makeDefaultTestIdentity(key))).toBe(false);

      renderChatMessages({
        messages,
        scrollStateKey: key,
        freshOpen: true,
        isChatStreaming: false,
      });
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
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
      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await fireScrollTopAndFlush(360);
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
      expect(hasSavedChatTabState(reopenedIdentity)).toBe(true);
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
      expect(getScrollNode().scrollTop).toBe(360);
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
      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
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
      const first = render(
        <StrictMode>
          <div
            data-chat-keyboard-scroll-scope
            data-active="true"
            style={{ height: VIEWPORT_HEIGHT_PX, width: VIEWPORT_WIDTH_PX }}
          >
            <ChatMessages
              taskTitle="Test chat"
              taskId={taskId}
              epicId={epicId}
              messages={messages}
              localProvenanceMessageIds={new Set()}
              consumeLocalProvenance={() => undefined}
              backgroundItems={undefined}
              getMessageActions={() => null}
              nextStepActions={null}
              instanceId={closedInstance}
              visible
              systemOverlayActive={false}
              isChatStreaming={false}
              scrollRequest={null}
              composerOverlayHeight={80}
            />
          </div>
        </StrictMode>,
      );
      await settleLegendList();
      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
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
      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
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
      expect(hasSavedChatTabState(identity)).toBe(false);
      tileLiveness.live = true;
      const { rerenderWith } = renderChatMessages({
        messages,
        instanceId,
        freshOpen: true,
        composerOverlayHeight: 80,
      });
      await settleLegendList();
      expect(hasSavedChatTabState(identity)).toBe(false);

      // Resize the overlaid composer - previously re-ran the unmount-save
      // effect cleanup because endInset was in the dep array, flipping
      // "no saved state" permanently.
      rerenderWith({ composerOverlayHeight: 240 });
      await settleLegendList();

      expect(hasSavedChatTabState(identity)).toBe(false);
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
            messages={messages}
            localProvenanceMessageIds={new Set()}
            consumeLocalProvenance={() => undefined}
            backgroundItems={undefined}
            getMessageActions={() => null}
            nextStepActions={null}
            instanceId={instanceId}
            visible
            systemOverlayActive={false}
            isChatStreaming={false}
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

        act(() => {
          enterFreeScrollingAwayFromEnd();
        });
        await fireScrollTopAndFlush(360);
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
        const preMoveScrollTop = getScrollNode().scrollTop;
        expect(preMoveScrollTop).toBe(360);

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
        act(() => {
          enterFreeScrollingAwayFromEnd();
        });
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
      expect(hasSavedChatTabState(makeDefaultTestIdentity(instanceId))).toBe(
        false,
      );
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

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
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

  // ---------------------------------------------------------------------
  // Ticket 22 (painted-chat lifecycle audit, finding 3): the two-rAF anchor
  // repair (ticket 18's drift re-assert) is keyed to `messages` - a
  // divider/split/join/header/disclosure geometry change under the SAME
  // `messages` array reports through `onItemSizeChanged`/`onLayout` but
  // nothing schedules a repair for it. Row(s) above the anchor moving height
  // shifts the anchored turn's content position with scrollTop unchanged.
  //
  // All four pins settle into an OVERFLOWING anchored turn first (same
  // recipe as ticket 18's pin E) rather than a short, non-overflowing one:
  // `anchoredEndSpace` pins a non-overflowing anchor at the maximum
  // REACHABLE scroll, and LegendList's own internal reserve tracking for
  // that config does not know about a raw `setItemSize` call on a row it
  // isn't watching - it silently re-clamps scrollTop back to its own
  // believed-correct position on the next settle, which would make a
  // perfectly-landed real repair look like a no-op. Once the turn overflows,
  // there is no such natural boundary to fight the repair's write.
  // ---------------------------------------------------------------------
  describe("ticket 22: geometry-only changes repair the anchored turn", () => {
    const T22_GEOMETRY_DELTA_PX = 220;

    /** Sends, then streams chunks until the turn genuinely overflows the
     *  usable viewport (mirrors ticket 18 pin E's own recipe exactly). */
    async function sendAndOverflowAnchor(
      rerenderMessages: (messages: ReadonlyArray<ChatMessageModel>) => void,
      history: ReadonlyArray<ChatMessageModel>,
      sendId: string,
      createdAt: number,
    ): Promise<ReadonlyArray<ChatMessageModel>> {
      const afterSend = appendOptimisticUserSend(history, sendId, createdAt);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      let current = afterSend;
      let overflowed = false;
      for (let chunkIndex = 0; chunkIndex < 20; chunkIndex += 1) {
        current = appendOneStreamingChunk(current, chunkIndex, createdAt);
        rerenderMessages(current);
        await waitForRevealPassTick();
        if (isJumpPillVisible()) {
          overflowed = true;
          break;
        }
      }
      expect(overflowed).toBe(true);
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      return current;
    }

    it("(pin 1) a same-messages row-remeasure above a settled anchor re-asserts the anchor offset", async () => {
      const history = makeCompletedTranscript(10);
      const sendId = "t22-pin1-geometry-repair";
      const { rerenderMessages } = renderChatMessages({
        messages: history,
        scrollStateKey: "t22-pin1-geometry-repair",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      await sendAndOverflowAnchor(rerenderMessages, history, sendId, 810_000);
      const scrollBefore = getScrollNode().scrollTop;

      await waitFor(() => {
        expect(legendListRefHolder.current).not.toBeNull();
      });
      const list = legendListRefHolder.current;
      if (!list) throw new Error("expected LegendListRef to be attached");
      const scrollToOffsetSpy = vi.spyOn(list, "scrollToOffset");

      // Grow a row strictly ABOVE the anchor - SAME `messages` array, no
      // scroll, no rerender. Driven via the real LegendList `setItemSize`
      // ref method (teed through the pass-through mock) - the one lever
      // that fires a genuine, no-scroll `onItemSizeChanged`, matching how a
      // disclosure collapse/expand or a rewrap from a divider/pane resize
      // would move rows under the anchor in a real browser.
      act(() => {
        legendListRefHolder.current?.setItemSize("message-2", {
          height: 90 + T22_GEOMETRY_DELTA_PX,
          width: VIEWPORT_WIDTH_PX,
        });
      });

      await waitForRevealPassTick();

      // The anchor must hold its EXACT offset from the viewport top - the
      // grown row pushed content above it down by exactly this much, so
      // scroll must grow by the same amount to compensate. A flat (zero)
      // delta here is the ticket-22 defect: the anchor silently drifts.
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(getScrollNode().scrollTop - scrollBefore).toBe(
        T22_GEOMETRY_DELTA_PX,
      );
      // Review round 1 (finding 3, CONFIRMED MEDIUM): decision #31's
      // non-animated departure classifier depends on every anchor
      // correction being instant - assert the exact `scrollToOffset`
      // params, not just the resulting position.
      expect(scrollToOffsetSpy).toHaveBeenCalledWith(
        expect.objectContaining({ animated: false }),
      );
    });

    it("(pin 2) a viewport resize coalesces with a coincident item-size change into exactly one repair", async () => {
      const history = makeCompletedTranscript(10);
      const sendId = "t22-pin2-viewport-resize";
      const { rerenderMessages } = renderChatMessages({
        messages: history,
        scrollStateKey: "t22-pin2-viewport-resize",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      await sendAndOverflowAnchor(rerenderMessages, history, sendId, 820_000);
      const scrollBefore = getScrollNode().scrollTop;

      await waitFor(() => {
        expect(legendListRefHolder.current).not.toBeNull();
      });
      const list = legendListRefHolder.current;
      if (!list) throw new Error("expected LegendListRef to be attached");

      const scrollToOffsetSpy = vi.spyOn(list, "scrollToOffset");

      // A pure viewport-length change alone (no row remeasure) never moves
      // `positionAtIndex` for a single-column vertical list - it changes
      // what's REVEALED, not the anchor's own content-relative position.
      // Fired here to prove the new wiring is inert (no spurious
      // correction) when there is genuinely nothing to repair.
      act(() => {
        triggerLegendListResizeObserverEntry(getScrollNode(), {
          width: VIEWPORT_WIDTH_PX + 200,
          height: VIEWPORT_HEIGHT_PX,
        });
      });
      await waitForRevealPassTick();
      expect(scrollToOffsetSpy).not.toHaveBeenCalled();
      expect(getScrollNode().scrollTop).toBe(scrollBefore);

      // Now pair the SAME resize signal with the real-browser consequence
      // it would cause (a rewrapped row above the anchor growing) - jsdom's
      // shim never rewraps text on its own, so the row-height change is
      // driven explicitly alongside the resize event. Both signals land in
      // the same coalescing window; the repair must fire exactly ONCE, not
      // once per trigger. Review round 1 (finding 4): a single
      // `scrollToOffset` call alone survives a missing coalescing guard (a
      // second scheduled pass can settle at zero drift and never write), so
      // also assert the shared repair function itself ran exactly once -
      // two independent triggers (resize + item-size) collapsing to ONE
      // scheduled pass, not two.
      const repairCallsBefore = applyChatAnchorDriftRepairCallCountRef.current;
      act(() => {
        triggerLegendListResizeObserverEntry(getScrollNode(), {
          width: VIEWPORT_WIDTH_PX + 400,
          height: VIEWPORT_HEIGHT_PX,
        });
        legendListRefHolder.current?.setItemSize("message-2", {
          height: 90 + T22_GEOMETRY_DELTA_PX,
          width: VIEWPORT_WIDTH_PX + 400,
        });
      });
      await waitForRevealPassTick();

      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(getScrollNode().scrollTop - scrollBefore).toBe(
        T22_GEOMETRY_DELTA_PX,
      );
      expect(scrollToOffsetSpy).toHaveBeenCalledOnce();
      expect(
        applyChatAnchorDriftRepairCallCountRef.current - repairCallsBefore,
      ).toBe(1);
    });

    it("(pin 3) no double-correction with the disclosure helper's own manual correction during anchoring", async () => {
      const history = makeCompletedTranscript(10);
      const sendId = "t22-pin3-no-double-correction";
      const { rerenderMessages } = renderChatMessages({
        messages: history,
        scrollStateKey: "t22-pin3-no-double-correction",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      await sendAndOverflowAnchor(rerenderMessages, history, sendId, 830_000);
      const scrollBefore = getScrollNode().scrollTop;

      await waitFor(() => {
        expect(legendListRefHolder.current).not.toBeNull();
      });

      // Simulates a disclosure toggle whose own trigger row sits above the
      // anchor and genuinely shifts on-screen by the SAME delta the real
      // row growth below produces - `correctionOwnedByMvcp: false` matches
      // production's own `timelineScrollModeRef.current === "free-scrolling"`
      // computation while anchoring (M2, tickets 10-12): the disclosure
      // helper owns and applies the correction synchronously.
      const anchorElement = document.createElement("div");
      const rectSpy = vi.spyOn(anchorElement, "getBoundingClientRect");
      rectSpy.mockReturnValueOnce({
        x: 0,
        y: 100,
        width: 100,
        height: 20,
        top: 100,
        left: 0,
        right: 100,
        bottom: 120,
        toJSON: () => ({}),
      });
      rectSpy.mockReturnValueOnce({
        x: 0,
        y: 100 + T22_GEOMETRY_DELTA_PX,
        width: 100,
        height: 20,
        top: 100 + T22_GEOMETRY_DELTA_PX,
        left: 0,
        right: 100,
        bottom: 120 + T22_GEOMETRY_DELTA_PX,
        toJSON: () => ({}),
      });

      act(() => {
        preserveChatScrollAcrossDisclosureChange({
          list: legendListRefHolder.current,
          anchorElement,
          mutate: () => {
            legendListRefHolder.current?.setItemSize("message-2", {
              height: 90 + T22_GEOMETRY_DELTA_PX,
              width: VIEWPORT_WIDTH_PX,
            });
          },
          correctionOwnedByMvcp: false,
        });
      });

      // The disclosure helper's own delta-based correction issues
      // synchronously; the real `setItemSize` call inside `mutate` also
      // fires a genuine `onItemSizeChanged` - ticket 22's new coalesced
      // geometry scheduler reacts to it independently. Let BOTH settle
      // (LegendList's own geometry bookkeeping is not guaranteed to reflect
      // a `scrollToOffset` call within the same act() it was issued in, and
      // the scheduler's own pass needs its two-rAF window) before checking
      // where the anchor landed.
      await waitForRevealPassTick();
      await waitForRevealPassTick();

      // Exactly the delta the row growth produced - not double-applied by
      // two independent correctors racing the same shift.
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(getScrollNode().scrollTop - scrollBefore).toBe(
        T22_GEOMETRY_DELTA_PX,
      );

      // Idempotence: with both correctors already settled and drift at
      // zero, a further settle window must not move it again - the
      // regression this pin guards is a SECOND correction stacking a
      // further +220 on top (landing at +440), not merely "some correction
      // happened".
      await waitForRevealPassTick();
      expect(getScrollNode().scrollTop - scrollBefore).toBe(
        T22_GEOMETRY_DELTA_PX,
      );
    });

    it("(pin 4) a departed/cancelled session gets no geometry repair", async () => {
      const history = makeCompletedTranscript(10);
      const sendId = "t22-pin4-departure-guard";
      const { rerenderMessages } = renderChatMessages({
        messages: history,
        scrollStateKey: "t22-pin4-departure-guard",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      await sendAndOverflowAnchor(rerenderMessages, history, sendId, 840_000);

      const scrollNode = getScrollNode();
      // A real downward-wheel departure gesture cancels the anchoring
      // session unconditionally (decision #14/ticket 14) - bumps the
      // generation the same way any other real-gesture cancel does.
      fireEvent.wheel(scrollNode, { deltaY: 40 });
      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
      const departedScrollTop = scrollNode.scrollTop;

      await waitFor(() => {
        expect(legendListRefHolder.current).not.toBeNull();
      });
      const list = legendListRefHolder.current;
      if (!list) throw new Error("expected LegendListRef to be attached");

      const scrollToOffsetSpy = vi.spyOn(list, "scrollToOffset");

      // The exact same geometry change pin 1 proves DOES repair while
      // still anchoring - here the session has already departed, so this
      // must be a pure no-op.
      act(() => {
        legendListRefHolder.current?.setItemSize("message-2", {
          height: 90 + T22_GEOMETRY_DELTA_PX,
          width: VIEWPORT_WIDTH_PX,
        });
      });

      await waitForRevealPassTick();

      expect(scrollToOffsetSpy).not.toHaveBeenCalled();
      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
      expect(scrollNode.scrollTop).toBe(departedScrollTop);
    });

    it("(pin 4b) departure DURING the deferred two-rAF window still blocks the repair", async () => {
      const history = makeCompletedTranscript(10);
      const sendId = "t22-pin4b-mid-window-departure";
      const { rerenderMessages } = renderChatMessages({
        messages: history,
        scrollStateKey: "t22-pin4b-mid-window-departure",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      await sendAndOverflowAnchor(rerenderMessages, history, sendId, 845_000);
      const scrollNode = getScrollNode();
      const scrollBefore = scrollNode.scrollTop;

      await waitFor(() => {
        expect(legendListRefHolder.current).not.toBeNull();
      });
      const list = legendListRefHolder.current;
      if (!list) throw new Error("expected LegendListRef to be attached");
      const scrollToOffsetSpy = vi.spyOn(list, "scrollToOffset");

      // Review round 1 (finding 2, CONFIRMED MEDIUM): pin 4 departs BEFORE
      // scheduling, so it only exercises the schedule-time mode guard - the
      // deferred callback's OWN fire-time mode/generation checks never run
      // in that pin at all. Schedule a real repair here (the same
      // setItemSize trigger pin 1 uses), let only the FIRST of the two rAFs
      // elapse - arms the second frame, does not run it yet, the
      // scheduler's own pending window - THEN depart with a real
      // downward-wheel gesture, THEN let the deferred frame actually fire.
      act(() => {
        list.setItemSize("message-2", {
          height: 90 + T22_GEOMETRY_DELTA_PX,
          width: VIEWPORT_WIDTH_PX,
        });
      });
      expect(scrollNode.dataset.scrollMode).toBe("anchoring-new-turn");

      await act(async () => {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      });

      fireEvent.wheel(scrollNode, { deltaY: 40 });
      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");

      await waitForRevealPassTick();

      // The already-scheduled pass must see the departure at fire time and
      // yield - pin 1's repair signature (+T22_GEOMETRY_DELTA_PX via
      // `scrollToOffset`) must never land for this departed session.
      expect(scrollToOffsetSpy).not.toHaveBeenCalled();
      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
      expect(scrollNode.scrollTop).toBe(scrollBefore);
    });

    it("geometry repair does not fire while following-end", async () => {
      // Pure following-end (never entered anchoring-new-turn). The scheduler
      // mode-gates at schedule time and again inside the deferred frame -
      // pin 1's +T22_GEOMETRY_DELTA_PX signature is the anchoring-only path.
      const history = makeCompletedTranscript(12);
      renderChatMessages({
        messages: history,
        scrollStateKey: "t22-mode-following-end",
      });
      await settleLegendList();

      const scrollNode = getScrollNode();
      expect(scrollNode.dataset.scrollMode).toBe("following-end");
      const scrollBefore = scrollNode.scrollTop;

      await waitFor(() => {
        expect(legendListRefHolder.current).not.toBeNull();
      });

      act(() => {
        legendListRefHolder.current?.setItemSize("message-2", {
          height: 90 + T22_GEOMETRY_DELTA_PX,
          width: VIEWPORT_WIDTH_PX,
        });
      });
      await waitForRevealPassTick();

      // following-end may still move for maintainScrollAtEnd end-stick; the
      // load-bearing contract is mode stays non-anchoring and we never see
      // the anchor-hold repair signature from pin 1.
      expect(scrollNode.dataset.scrollMode).toBe("following-end");
      expect(scrollNode.scrollTop - scrollBefore).not.toBe(
        T22_GEOMETRY_DELTA_PX,
      );
    });

    it("geometry repair does not fire while free-scrolling", async () => {
      // Pure free-scrolling seed (not a post-departure pin-4 shape): park
      // away from the end, grow a history row, confirm the geometry
      // scheduler does not apply the anchoring-new-turn repair signature.
      // MVCP size-preservation may adjust scrollTop for reading stability -
      // that is a different mechanism; pin 4 already pins zero
      // scrollToOffset for a departed overflowing session.
      const history = makeCompletedTranscript(12);
      const scrollStateKey = "t22-mode-free-scrolling";
      saveChatTabState({
        identity: makeDefaultTestIdentity(scrollStateKey),
        mode: "free-scrolling",
        anchorMessageId: history[0]?.id ?? null,
        anchorIndex: 0,
        offset: 0,
      });
      renderChatMessages({
        messages: history,
        scrollStateKey,
      });
      await settleLegendList();

      const scrollNode = getScrollNode();
      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
      const scrollBefore = scrollNode.scrollTop;

      await waitFor(() => {
        expect(legendListRefHolder.current).not.toBeNull();
      });
      const freeScrollingList = legendListRefHolder.current;
      if (!freeScrollingList) {
        throw new Error("expected LegendListRef to be attached");
      }
      const scrollToOffsetSpy = vi.spyOn(freeScrollingList, "scrollToOffset");

      act(() => {
        legendListRefHolder.current?.setItemSize("message-2", {
          height: 90 + T22_GEOMETRY_DELTA_PX,
          width: VIEWPORT_WIDTH_PX,
        });
      });
      await waitForRevealPassTick();

      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
      expect(scrollNode.scrollTop - scrollBefore).not.toBe(
        T22_GEOMETRY_DELTA_PX,
      );
      // Mirror pin 4 when MVCP has nothing to compensate at scrollTop=0:
      // the geometry scheduler itself must not have called scrollToOffset.
      // If MVCP did compensate via another path, scrollTop would move but
      // still must not land on the pure anchor-repair signature above.
      if (scrollNode.scrollTop === scrollBefore) {
        expect(scrollToOffsetSpy).not.toHaveBeenCalled();
      }
    });

    it("a row growing BELOW the anchor produces no geometry correction", async () => {
      const history = makeCompletedTranscript(10);
      const sendId = "t22-below-anchor-no-repair";
      const { rerenderMessages } = renderChatMessages({
        messages: history,
        scrollStateKey: "t22-below-anchor-no-repair",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      const overflowing = await sendAndOverflowAnchor(
        rerenderMessages,
        history,
        sendId,
        850_000,
      );
      const scrollBefore = getScrollNode().scrollTop;

      // Streaming reply rows sit AFTER the anchored user send - growing one
      // of those changes content below the anchor only. positionAtIndex for
      // the anchor is unchanged, so the repair must see zero drift.
      const belowAnchorId = overflowing.find(
        (message) => message.id === "incremental-chunk-0",
      )?.id;
      expect(belowAnchorId).toBe("incremental-chunk-0");

      await waitFor(() => {
        expect(legendListRefHolder.current).not.toBeNull();
      });
      const belowAnchorList = legendListRefHolder.current;
      if (!belowAnchorList) {
        throw new Error("expected LegendListRef to be attached");
      }
      const scrollToOffsetSpy = vi.spyOn(belowAnchorList, "scrollToOffset");

      act(() => {
        legendListRefHolder.current?.setItemSize("incremental-chunk-0", {
          height: 90 + T22_GEOMETRY_DELTA_PX,
          width: VIEWPORT_WIDTH_PX,
        });
      });
      await waitForRevealPassTick();

      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(getScrollNode().scrollTop).toBe(scrollBefore);
      expect(scrollToOffsetSpy).not.toHaveBeenCalled();
    });

    it("multiple same-frame item-size changes above the anchor coalesce into one repair", async () => {
      const history = makeCompletedTranscript(10);
      const sendId = "t22-coalesce-multi-item-size";
      const { rerenderMessages } = renderChatMessages({
        messages: history,
        scrollStateKey: "t22-coalesce-multi-item-size",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      await sendAndOverflowAnchor(rerenderMessages, history, sendId, 860_000);

      await waitFor(() => {
        expect(legendListRefHolder.current).not.toBeNull();
      });
      const coalesceList = legendListRefHolder.current;
      if (!coalesceList) {
        throw new Error("expected LegendListRef to be attached");
      }
      const scrollToOffsetSpy = vi.spyOn(coalesceList, "scrollToOffset");
      const scrollBefore = getScrollNode().scrollTop;

      // Review round 1 (finding 4, CONFIRMED LOW): a single `scrollToOffset`
      // call proves idempotence, not "one scheduled pass" - if the
      // coalescing ref were missing, several independent two-rAF chains
      // would run, but only the FIRST observes non-zero drift and writes;
      // the rest settle at zero and never call `scrollToOffset`, so that
      // oracle alone survives the guard's removal. Count invocations of the
      // shared repair function itself instead (via the module-level
      // call-count tee above) - deterministic, unlike spying on
      // `window.requestAnimationFrame`, which also picks up LegendList's own
      // unrelated internal rAF usage.
      const repairCallsBefore = applyChatAnchorDriftRepairCallCountRef.current;

      // Four separate setItemSize notifications in one act() - each would
      // schedule its OWN two-rAF chain if the coalescing ref were missing;
      // the scheduler must collapse them into a single repair pass.
      const rowsAboveAnchor = [
        "message-0",
        "message-2",
        "message-4",
        "message-6",
      ] as const;
      act(() => {
        for (const rowId of rowsAboveAnchor) {
          legendListRefHolder.current?.setItemSize(rowId, {
            height: 90 + T22_GEOMETRY_DELTA_PX,
            width: VIEWPORT_WIDTH_PX,
          });
        }
      });
      await waitForRevealPassTick();

      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(getScrollNode().scrollTop - scrollBefore).toBe(
        T22_GEOMETRY_DELTA_PX * rowsAboveAnchor.length,
      );
      expect(scrollToOffsetSpy).toHaveBeenCalledOnce();
      expect(
        applyChatAnchorDriftRepairCallCountRef.current - repairCallsBefore,
      ).toBe(1);
    });

    it("unmount while a geometry repair is scheduled cancels cleanly (no throw, no late scrollToOffset)", async () => {
      const history = makeCompletedTranscript(10);
      const sendId = "t22-unmount-mid-repair";
      const { rerenderMessages, unmount } = renderChatMessages({
        messages: history,
        scrollStateKey: "t22-unmount-mid-repair",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      await sendAndOverflowAnchor(rerenderMessages, history, sendId, 870_000);

      await waitFor(() => {
        expect(legendListRefHolder.current).not.toBeNull();
      });
      const list = legendListRefHolder.current;
      if (!list) throw new Error("expected LegendListRef to be attached");
      const scrollToOffsetSpy = vi.spyOn(list, "scrollToOffset");
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const consoleWarnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});

      try {
        // Schedule the two-rAF geometry repair, then unmount before the
        // deferred frame runs - the cleanup effect must cancel the pending
        // frame so the callback never touches an unmounted list.
        act(() => {
          list.setItemSize("message-2", {
            height: 90 + T22_GEOMETRY_DELTA_PX,
            width: VIEWPORT_WIDTH_PX,
          });
          unmount();
        });

        await waitForRevealPassTick();

        expect(scrollToOffsetSpy).not.toHaveBeenCalled();
        expect(consoleErrorSpy).not.toHaveBeenCalled();
        expect(consoleWarnSpy).not.toHaveBeenCalled();
      } finally {
        consoleErrorSpy.mockRestore();
        consoleWarnSpy.mockRestore();
      }
    });

    it("(pin 1b) survives a StrictMode setup->cleanup->setup replay while already anchoring at mount (finding 1)", async () => {
      // Fresh-open (decision #15): no saved scroll state + a transcript
      // ending in a user send, so this mounts DIRECTLY into
      // `anchoring-new-turn` - the exact shape the review flagged (LegendList's
      // initial `onLayout` arms the coalescing sentinel during the FIRST
      // StrictMode setup; the dev-only cleanup->setup replay must not leave
      // it poisoned).
      const history = makeCompletedTranscript(10);
      const sendId = "t22-strict-fresh-open-anchor";
      const baseCreatedAt = 895_000;
      const messages = appendOptimisticUserSend(history, sendId, baseCreatedAt);
      const instanceId = `t22-strict-fresh-open-${Math.random().toString(36).slice(2)}`;
      const epicId = "epic-1";
      const taskId = "task-1";
      const identity = makeTestIdentity(instanceId, epicId, taskId);
      expect(hasSavedChatTabState(identity)).toBe(false);

      const { unmount } = render(
        <StrictMode>
          <div
            data-chat-keyboard-scroll-scope
            data-active="true"
            style={{ height: VIEWPORT_HEIGHT_PX, width: VIEWPORT_WIDTH_PX }}
          >
            <ChatMessages
              taskTitle="Test chat"
              taskId={taskId}
              epicId={epicId}
              messages={messages}
              localProvenanceMessageIds={new Set()}
              consumeLocalProvenance={() => undefined}
              backgroundItems={undefined}
              getMessageActions={() => null}
              nextStepActions={null}
              instanceId={instanceId}
              visible
              systemOverlayActive={false}
              isChatStreaming={false}
              scrollRequest={null}
              composerOverlayHeight={80}
            />
          </div>
        </StrictMode>,
      );

      // Mode seed is synchronous at construction (decision #15) - already
      // anchoring before StrictMode's dev-only setup->cleanup->setup replay
      // has even finished. This is the exact commit the review flagged:
      // LegendList's initial `onLayout` arms the coalescing sentinel WHILE
      // mode is already `anchoring-new-turn`, then StrictMode's replay
      // cancels those frames.
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await settleLegendList();
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      await waitFor(() => {
        expect(legendListRefHolder.current).not.toBeNull();
      });
      const list = legendListRefHolder.current;
      if (!list) throw new Error("expected LegendListRef to be attached");

      // The replay is long over by now - this is an ORDINARY later trigger,
      // identical to pin 1's own recipe. Pre-fix, the sentinel armed during
      // the first StrictMode setup stays non-null forever (the cleanup
      // cancels those frames without clearing it), so every later trigger
      // for the lifetime of this mount silently no-ops here.
      //
      // Signal choice: neither `scrollTop` nor the `applyChatAnchorDriftRepair`
      // call-count tee (finding 4's signal) work for THIS specific
      // construction - a SEPARATE, pre-existing harness limitation (fresh-
      // open's own `scrollToIndex` bootstrap never converges `scrollTop` for
      // a raw-StrictMode mount in this jsdom setup, so the anchor reaches
      // "positioned" but never "settled" - unrelated to ticket 22, flagged
      // to the reviewer rather than worked around here) means the deferred
      // callback's OWN unsettled-anchor guard always blocks it BEFORE
      // reaching the repair function, on both healthy and poisoned code.
      // Count synchronous `requestAnimationFrame` registrations instead,
      // scoped tightly to this one `act()`: `scheduleChatAnchorGeometryRepair`
      // returns at its entry guard (`pendingGeometryRepairCancelRef.current
      // !== null`) BEFORE calling `scheduleChatTimelineDoubleRaf` - which
      // itself always registers exactly one synchronous rAF per call - so a
      // poisoned sentinel drops the count by exactly one relative to a
      // healthy one. Mutation-verified directly against this exact test: 2
      // calls with the cleanup fix in place, 1 with it reverted (the `1` is
      // LegendList's own unrelated internal rAF usage for this `setItemSize`
      // call, present either way).
      const rafSpy = vi.spyOn(window, "requestAnimationFrame");
      rafSpy.mockClear();
      act(() => {
        list.setItemSize("message-2", {
          height: 90 + T22_GEOMETRY_DELTA_PX,
          width: VIEWPORT_WIDTH_PX,
        });
      });

      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(rafSpy.mock.calls.length).toBeGreaterThan(1);

      unmount();
    });

    it("geometry repair does not run while a new anchor is still pending/positioning (not yet settled)", async () => {
      const history = makeCompletedTranscript(10);
      const sendId = "t22-mid-flight-anchor-guard";
      const { rerenderMessages } = renderChatMessages({
        messages: history,
        scrollStateKey: "t22-mid-flight-anchor-guard",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      await waitFor(() => {
        expect(legendListRefHolder.current).not.toBeNull();
      });
      const list = legendListRefHolder.current;
      if (!list) throw new Error("expected LegendListRef to be attached");

      // Hang the library's scroll promise so the engine stays in
      // positioned-but-not-settled (pendingTimelineAnchorRef cleared on
      // onAnchorReady, settledTimelineAnchorRef still null) - the same
      // mid-flight window the scheduler's "no anchor navigation currently
      // mid-flight" guard is meant to refuse.
      const originalScrollToIndex = list.scrollToIndex.bind(list);
      const hangingScrollToIndex = vi
        .spyOn(list, "scrollToIndex")
        .mockImplementation((params) => {
          void originalScrollToIndex(params);
          return new Promise<void>(() => {});
        });
      const scrollToOffsetSpy = vi.spyOn(list, "scrollToOffset");

      try {
        const afterSend = appendOptimisticUserSend(history, sendId, 880_000);
        rerenderMessages(afterSend);
        await waitFor(() => {
          expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
        });
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

        // Wait until the hang is engaged (positioning issued) but well
        // before the settle watchdog fails safe out of anchoring-new-turn.
        await waitFor(() => {
          expect(hangingScrollToIndex).toHaveBeenCalled();
        });
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

        scrollToOffsetSpy.mockClear();
        const scrollBefore = getScrollNode().scrollTop;

        act(() => {
          list.setItemSize("message-2", {
            height: 90 + T22_GEOMETRY_DELTA_PX,
            width: VIEWPORT_WIDTH_PX,
          });
        });
        await waitForRevealPassTick();

        // Still mid-flight - must not apply the settled-session repair
        // signature (+T22_GEOMETRY_DELTA_PX via scrollToOffset).
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
        expect(getScrollNode().scrollTop - scrollBefore).not.toBe(
          T22_GEOMETRY_DELTA_PX,
        );
        expect(scrollToOffsetSpy).not.toHaveBeenCalled();
      } finally {
        hangingScrollToIndex.mockRestore();
      }
    });

    it("a genuine shrink of a row above the anchor repairs with negative drift", async () => {
      const history = makeCompletedTranscript(10);
      const sendId = "t22-shrink-above-anchor";
      const { rerenderMessages } = renderChatMessages({
        messages: history,
        scrollStateKey: "t22-shrink-above-anchor",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      await sendAndOverflowAnchor(rerenderMessages, history, sendId, 890_000);
      const scrollBefore = getScrollNode().scrollTop;

      await waitFor(() => {
        expect(legendListRefHolder.current).not.toBeNull();
      });

      // Shrink, not grow - all four required pins only exercise positive
      // delta. The repair math is signed; a shorter row above the anchor
      // must pull scrollTop down by the same amount.
      const shrinkPx = 50;
      act(() => {
        legendListRefHolder.current?.setItemSize("message-2", {
          height: 90 - shrinkPx,
          width: VIEWPORT_WIDTH_PX,
        });
      });
      await waitForRevealPassTick();

      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(getScrollNode().scrollTop - scrollBefore).toBe(-shrinkPx);
    });

    it("(pin 4c) a scroll-only departure through following-end still blocks a pending repair (review round 2, finding 2 residual)", async () => {
      // Review round 2 (finding 2 residual): pin 4b's wheel departure nulls
      // `activeTimelineAnchorIndexRef` (via `cancelTimelineLiveFollowFor
      // UserNavigation`), so `getActiveTimelineTurnMetrics` independently
      // returns null there and backstops a deleted mode/generation check -
      // pin 4b stays green even if those checks are removed. A REAL
      // reachable route does not null that ref at all: a scroll-only
      // reconcile (ticket 11 fix #1, `chat-messages.tsx` ~1915-1929) takes
      // an overflowing anchoring session to `following-end` purely from
      // reaching the true content edge - no wheel/touchmove/pointerdown ever
      // fires - and a SUBSEQUENT native-OS-scrollbar-style decrease (the
      // equality fast-path's else branch, ~1931-1941) then takes it to
      // `free-scrolling`. Neither transition touches
      // `activeTimelineAnchorIndexRef`/`positionedTimelineAnchorRef`/
      // `settledTimelineAnchorRef` (only `cancelTimelineLiveFollowForUser
      // Navigation` - the wheel/touch/pointerdown path - does). On this
      // route the fire-time mode/generation checks are the SOLE barrier.
      const history = makeCompletedTranscript(10);
      const sendId = "t22-pin4c-scroll-only-departure";
      const { rerenderMessages } = renderChatMessages({
        messages: history,
        scrollStateKey: "t22-pin4c-scroll-only-departure",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      await sendAndOverflowAnchor(rerenderMessages, history, sendId, 900_000);

      await waitFor(() => {
        expect(legendListRefHolder.current).not.toBeNull();
      });
      const list = legendListRefHolder.current;
      if (!list) throw new Error("expected LegendListRef to be attached");
      const scrollToOffsetSpy = vi.spyOn(list, "scrollToOffset");

      const scrollNode = getScrollNode();
      // Learn the REAL "true end" offset from LegendList's own
      // `getMaxScrollOffset()` via the public `scrollToEnd` imperative API -
      // NOT jsdom's shimmed `scrollHeight - clientHeight` (memory:
      // legendlist-jsdom-shim-scrollheight-trap - the fake scrollHeight sits
      // nowhere near LegendList's own tracked content size, and any offset
      // derived from it reads as permanently "past the end"). This call
      // alone does not report through `onIsAtEndChange` in this harness (no
      // synthetic 'scroll' event follows it), so mode stays untouched.
      act(() => {
        // Intentionally not awaited: this call alone does not report
        // through `onIsAtEndChange` in this harness (see comment above), so
        // nothing here depends on its resolution - the very next line reads
        // the synchronous DOM side effect it already produced.
        void list.scrollToEnd({ animated: false });
      });
      const trueEnd = scrollNode.scrollTop;

      // Schedule the two-rAF geometry repair while still anchoring (arms
      // the entry guard's cancel function) - same trigger pin 1/4b use.
      act(() => {
        list.setItemSize("message-2", {
          height: 90 + T22_GEOMETRY_DELTA_PX,
          width: VIEWPORT_WIDTH_PX,
        });
      });
      expect(scrollNode.dataset.scrollMode).toBe("anchoring-new-turn");

      // First scroll-only report: reaching the true end reconciles mode to
      // `following-end` (ticket 11 fix #1) without touching the anchor refs.
      await act(async () => {
        scrollNode.scrollTop = trueEnd;
        fireEvent.scroll(scrollNode);
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
      });
      expect(scrollNode.dataset.scrollMode).toBe("following-end");

      // Second scroll-only report: a real decrease (an OS-scrollbar drag
      // away from the tail, no gesture event) takes `following-end` to
      // `free-scrolling` via the equality fast-path's else branch - nulling
      // `liveFollowUserScrollGenerationRef` but NOT `activeTimelineAnchor
      // IndexRef`. This is where the still-pending geometry repair's
      // deferred frame actually fires (confirmed empirically: this second
      // report flushes synchronously - `following-end`'s own MVCP-active
      // state short-circuits the scroll coalescer - so the already-armed
      // second rAF from the schedule above elapses after this transition
      // has already landed, not before it).
      await act(async () => {
        scrollNode.scrollTop = trueEnd - 900;
        fireEvent.scroll(scrollNode);
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
      });
      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");

      await waitForRevealPassTick();

      // The already-scheduled repair must see the departure at fire time and
      // yield, exactly like pin 4b - but here `getActiveTimelineTurnMetrics`
      // would NOT independently return null (the anchor refs were never
      // cleared), so this is a genuine, isolated proof that the mode/
      // generation checks alone are load-bearing on this route.
      expect(scrollToOffsetSpy).not.toHaveBeenCalled();
      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
      expect(scrollNode.scrollTop).toBe(trueEnd - 900);
    });
  });
});
