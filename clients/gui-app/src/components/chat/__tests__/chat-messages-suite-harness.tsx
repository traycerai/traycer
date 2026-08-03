import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { afterEach, beforeEach, expect, vi } from "vitest";
import {
  ChatMessages,
  type ChatMessageScrollRequest,
} from "@/components/chat/chat-messages";
import {
  hasSavedChatTabState,
  saveChatTabState,
} from "@/stores/chats/chat-tab-state-cache";
import { type ChatTabPersistenceIdentity } from "@/stores/chats/chat-tab-persistence-key";
import {
  HOSTED_TILE_INSTANCE_ID_ATTRIBUTE,
  HOSTED_TILE_PANE_ID_ATTRIBUTE,
  HOSTED_TILE_VIEW_TAB_ID_ATTRIBUTE,
} from "@/components/epic-canvas/surface-host/hosted-tile-dom";
import { evictChatTabPersistenceForEpic } from "@/stores/chats/chat-tab-persistence-eviction";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { type ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import { type SetupCardViewModel } from "@/components/chat/segments/setup-card-segment";
import { type BackgroundItem } from "@traycer/protocol/host/agent/gui/subscribe";
import { makeMessage, makeMessageAt } from "./chat-message-fixtures";
import {
  installLegendListViewportMetrics,
  setLegendListScrollContainerScrollHeightOverride,
  settleLegendList,
} from "./legend-list-test-environment";
import {
  activityGroupOpenIds,
  legendListRefHolder,
  platformMock,
  tileLiveness,
} from "./chat-messages-suite-refs";

export const VIEWPORT_HEIGHT_PX = 700;
export const VIEWPORT_WIDTH_PX = 800;
export const PILL_SHOW_DEBOUNCE_MS = 150;
export const LEGEND_LIST_HEADER_PX = 40;
export const DEFAULT_COMPOSER_OVERLAY_HEIGHT_PX = 80;

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
export const capturedResizeObserverCallbacks: Array<ResizeObserverCallback> =
  [];

export class ControllableGlobalResizeObserver implements ResizeObserver {
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

export function triggerLegendListResizeObserverEntry(
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

export function makeTranscript(count: number): ChatMessageModel[] {
  return Array.from({ length: count }, (_unused, index) =>
    makeMessage(index, index % 2 === 0 ? "user" : "assistant"),
  );
}

export function appendAssistant(
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
export function makeCompletedTranscript(count: number): ChatMessageModel[] {
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
export function makeA2AOnlyCompletedTranscript(
  count: number,
): ChatMessageModel[] {
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
export function appendOptimisticUserSend(
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
export function appendPersistentUserRow(
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

export const TICKET_13_SETUP_MODEL: SetupCardViewModel = {
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
export function setupCardRow(
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
export function forkMarkerRow(id: string, createdAt: number): ChatMessageModel {
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
export const TICKET_13_ROW_HEIGHT_PX = 90;

/** Many trailing assistant rows so the anchored turn overflows the usable viewport. */
export function appendStreamingAssistantChunks(
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
export function appendOneStreamingChunk(
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
export async function waitForRevealPassTick(): Promise<void> {
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
 * Anchor engine settle. The LegendList test environment dispatches the
 * browser's synthetic scroll/scrollend events for programmatic scrolls (see
 * `setLegendListSyntheticScrollEventsEnabled`), so the library's
 * `scrollToIndex` promise resolves within frames - the engine's 2600ms
 * `CHAT_TIMELINE_ANCHOR_SCROLL_PROMISE_TIMEOUT_MS` watchdog is now the
 * abnormal path (exercised explicitly by the pin G tests, which hang the
 * promise on purpose). The budget here only covers the settled promise's
 * double-rAF quiet window plus up to one non-animated reissue cycle (a real
 * 100ms `finishScrollTo` timer in the vendored library) with margin.
 */
export async function waitForAnchorEngineSettle(): Promise<void> {
  await settleLegendList();
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 250);
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
export async function waitForNavigationSettle(): Promise<void> {
  await settleLegendList();
  await act(async () => {
    await new Promise<void>((resolve) => {
      // With synthetic scrollend dispatched by the test environment,
      // `awaitScrollSettle` resolves on the event within frames; its 750ms
      // `CHAT_ANCHOR_SETTLE_FALLBACK_MS` fallback is the abnormal path. The
      // budget covers one non-animated reissue (100ms library timer) with
      // margin.
      setTimeout(resolve, 250);
    });
  });
}

export function getScrollToEndPill(): HTMLButtonElement {
  const pill = document.querySelector('button[aria-label="Scroll to end"]');
  if (!(pill instanceof HTMLButtonElement)) {
    throw new Error("Scroll-to-end pill button was not rendered");
  }
  return pill;
}

export function pillVisibleLabel(): string {
  const pill = getScrollToEndPill();
  return pill.textContent;
}

export function isJumpPillVisible(): boolean {
  const pill = getScrollToEndPill();
  return (
    pill.classList.contains("opacity-100") &&
    !pill.classList.contains("opacity-0")
  );
}

export function getScrollNode(): HTMLElement {
  const node = screen.getByTestId("chat-messages-scroll");
  if (!(node instanceof HTMLElement)) {
    throw new Error("chat-messages-scroll is not an HTMLElement");
  }
  return node;
}

/** Park away from the tail so LegendList reports isAtEnd/isNearEnd = false. */
export function fireScrollAwayFromEnd(): void {
  const scrollNode = getScrollNode();
  scrollNode.scrollTop = 0;
  fireEvent.scroll(scrollNode);
}

export function fireScrollToEnd(): void {
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
export async function fireScrollTopAndFlush(scrollTop: number): Promise<void> {
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
export function fireScrollTopWithoutFlush(scrollTop: number): void {
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
export async function fireLibraryOwnedScrollTo(offset: number): Promise<void> {
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
export async function fireCaptureScrollAfterLibraryWrite(): Promise<void> {
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
export function installLibraryScrollCaptureDispatch(): {
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
export function dispatchKeyInScope(key: string): void {
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
export function enterFreeScrollingAwayFromEnd(): void {
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
export async function selectLastChatTurnMinimapItem(): Promise<void> {
  const minimapButton = screen.getByTestId("chat-turn-minimap-hit-strip");
  fireEvent.keyDown(minimapButton, { key: "End" });
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
  fireEvent.keyDown(minimapButton, { key: "Enter" });
}

export interface RenderChatMessagesOptions {
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

export interface ChatMessagesRenderState {
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
export function makeTestIdentity(
  tileInstanceId: string,
  epicId: string,
  chatId: string,
): ChatTabPersistenceIdentity {
  return { tileInstanceId, epicId, chatId };
}

/** Default harness identity (epic-1 / task-1) for call sites that only vary the tile key. */
export function makeDefaultTestIdentity(
  tileInstanceId: string,
): ChatTabPersistenceIdentity {
  return makeTestIdentity(tileInstanceId, "epic-1", "task-1");
}

export function renderChatMessages(options: RenderChatMessagesOptions) {
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

export async function waitForPillVisible(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, PILL_SHOW_DEBOUNCE_MS + 40);
    });
  });
  await waitFor(() => {
    expect(isJumpPillVisible()).toBe(true);
  });
}

/**
 * The split chat-messages-*.test.tsx files share one root describe title and
 * these hooks - the exact beforeEach/afterEach the original single-file suite
 * ran. Call inside the root describe of every split file.
 */
export function registerChatMessagesSuiteHooks(): void {
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
}
