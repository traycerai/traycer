import { QuoteSelectionPopover } from "@/components/chat/quote/quote-selection-popover";
import { useQuoteSelection } from "@/components/chat/quote/use-quote-selection";
import { useChatFindController } from "@/components/chat/use-chat-find-controller";
import { ChatMeasuredItemChangeContext } from "@/components/chat/chat-measured-item-change-context";
import { type ChatMessageActions } from "@/components/chat/chat-message";
import {
  ChatTimeline,
  type ChatTimelineInitialScrollAnchor,
} from "@/components/chat/chat-timeline";
import {
  buildMessageIdToIndex,
  CHAT_ARROW_SCROLL_STEP_PX,
  chatTimelineLocationForMessage,
  chatTimelineNavigationLandedAtLocation,
  classifyChatEdgeMutation,
  selectActiveUserMessageId,
  viewportActiveUserMessageId,
  type ChatTimelineNavigationLocation,
  type ChatViewportAnchorListState,
} from "@/components/chat/chat-messages-scroll-helpers";
import {
  CHAT_LIST_ANCHOR_OFFSET,
  captureChatFreeScrollingOffset,
  getChatAnchoredTurnMetrics,
  getChatNaturalMaxScrollWithoutAnchorReserve,
  getChatRowBottom,
  chatTimelineRealContentOverflowsViewport,
  resolveChatTimelineInitialModeSeed,
  shouldAcceptChatAnchorReadyEvent,
  type ChatTimelineScrollMode,
} from "@/components/chat/chat-scroll-anchoring";
import { preserveChatScrollAcrossDisclosureChange } from "@/components/chat/chat-scroll-disclosure";
import {
  hasSavedChatTabState,
  restoreChatTabState,
  saveChatTabState,
  type ChatTabScrollMode,
  type SavedChatTabScrollState,
} from "@/stores/chats/chat-tab-state-cache";
import { ChatTurnMinimap } from "@/components/chat/chat-turn-minimap";
import { CHAT_TURN_MINIMAP_KEYBOARD_OWNER_SELECTOR } from "@/components/chat/chat-turn-minimap-logic";
import { buildChatActivityTimeline } from "@/components/chat/chat-activity-groups";
import { resolveScrollToEndPillState } from "@/components/chat/chat-scroll-to-end-pill-state";
import { ScrollToEndPill } from "@/components/chat/scroll-to-end-pill";
import {
  pickWorkingVerb,
  WorkingVerbContext,
} from "@/components/chat/working-verb";
import type { NextStepActionHandler } from "@/components/chat/segments/next-steps-action-group";
import { useAnimationFrameThrottle } from "@/hooks/use-animation-frame-throttle";
import {
  isPlainBoundaryKey,
  isPlatformModifiedBoundaryKey,
} from "@/lib/keybindings/chord";
import { isMac } from "@/lib/keybindings/platform";
import { ActivityGroupOpenStoreProvider } from "@/stores/chats/activity-group-open-store";
import { A2AOpenStoreProvider } from "@/stores/chats/a2a-open-store";
import { ChatFindForceStoreProvider } from "@/stores/chats/chat-find-force-store";
import { getOrCreateActivityGroupOpenStore } from "@/stores/chats/activity-group-open-store-core";
import { getOrCreateA2AOpenStore } from "@/stores/chats/a2a-open-store-context";
import { ChatOpenStoreScopeProvider } from "@/stores/chats/open-store-scope";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { isEpicCanvasTileInstanceLive } from "@/stores/epics/canvas/tile-instance-liveness";
import type {
  ChatMessage as ChatMessageModel,
  MessageSegment,
} from "@/stores/composer/chat-store";
import type { BackgroundItem } from "@traycer/protocol/host/agent/gui/subscribe";
import type { LegendListRef } from "@legendapp/list/react";
import {
  type CSSProperties,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

interface ChatMessagesProps {
  taskTitle: string;
  /** Chat tab identity; keys the composer draft the quote affordance appends to. */
  taskId: string;
  /** The full derived, pinned-todo-stripped row history to hand to LegendList. */
  messages: ReadonlyArray<ChatMessageModel>;
  /** Live host-owned background items; undefined means the connected host lacks support. */
  backgroundItems: ReadonlyArray<BackgroundItem> | undefined;
  /** Stable per-tile key used to restore reading position across layout remounts. */
  scrollStateKey: string;
  getMessageActions: (message: ChatMessageModel) => ChatMessageActions | null;
  nextStepActions: NextStepActionHandler | null;
  /** Per-tab identity; keys this transcript's saved scroll anchor. */
  instanceId: string;
  /** paneVisible ∧ tab selected: drives the reading-position tracking that
   *  feeds the ticket-5 free-scrolling save anchor. */
  visible: boolean;
  /** A frontmost system modal overlays the chat; body-portaled quote UI must stay hidden. */
  systemOverlayActive: boolean;
  scrollRequest: ChatMessageScrollRequest | null;
  /** Measured height of the overlaid composer/queue/pinned/agents dock
   *  (chat-tile.tsx), reserved as the transcript's bottom content inset. */
  composerOverlayHeight: number;
  /** Message ids THIS client minted and dispatched (composer send / steer /
   *  inline edit) - the anchor classifier's ground truth for unconditional
   *  vs decision-#9-gated anchoring (chat-scroller-refactor review round 2).
   *  Read from `chat-session-store.ts`. */
  localProvenanceMessageIds: ReadonlySet<string>;
  /** Removes a message id from the registry once the classifier has acted
   *  on it - see `localProvenanceMessageIds`. */
  consumeLocalProvenance: (messageId: string) => void;
}

export interface ChatMessageScrollRequest {
  readonly messageId: string;
  /** Card to open within the target row, or `null` for a row-level jump. */
  readonly blockId: string | null;
  readonly requestId: number;
}

const EMPTY_BACKGROUND_TOOL_BLOCK_IDS: ReadonlySet<string> = new Set();
const PILL_SHOW_DEBOUNCE_MS = 150;
const NAVIGATION_HIGHLIGHT_DURATION_MS = 3_000;
/** `awaitScrollSettle`'s fallback timeout when `scrollend` never fires
 *  (jsdom, some browsers) - exported so tests can wait past it rather than
 *  hardcoding a copy of this number. */
export const CHAT_ANCHOR_SETTLE_FALLBACK_MS = 750;
/** Ticket 11: strict live-edge tolerance for reconciling `anchoring-new-turn`
 *  back to `following-end` once the reader has scrolled to the turn's actual
 *  end. Matches the reveal pass's own "close enough" tolerance
 *  (`metrics.scrollDeltaToRevealEnd <= 1`) so a fitting anchor's still-
 *  closing reserve near-end is never misread as "arrived". */
const CHAT_TIMELINE_LIVE_EDGE_EPSILON_PX = 1;
/** Ticket 10: pixel tolerance for the settle/re-issue validation below - a
 *  navigation whose landing is off by more than this is treated as a real
 *  undershoot, not float/rounding noise. */
const CHAT_TIMELINE_NAVIGATION_LANDING_EPSILON_PX = 1;
/** Ticket 10: bounded retry count for the settle/re-issue loop (ticket text:
 *  "max 2-3") - the upper end, since the field bug this fixes needed
 *  multiple manual pill re-clicks to converge and the goal is to absorb that
 *  automatically in one operation. */
const CHAT_TIMELINE_NAVIGATION_MAX_RETRIES = 3;

/** Test-observability label for `ChatTimeline`'s `data-scroll-mode` prop -
 *  see that prop's own doc comment. */
function chatScrollModeDataAttribute(
  isAnchoringNewTurn: boolean,
  isFollowingEnd: boolean,
): string {
  if (isAnchoringNewTurn) return "anchoring-new-turn";
  if (isFollowingEnd) return "following-end";
  return "free-scrolling";
}

type ChatKeyboardScrollAction =
  "page-up" | "page-down" | "line-up" | "line-down" | "top" | "bottom";

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "TEXTAREA" ||
      target.tagName === "INPUT" ||
      target.isContentEditable)
  );
}

function isUnmodified(event: globalThis.KeyboardEvent): boolean {
  return !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
}

/**
 * Controls whose own keyboard contract is bound to the arrows: text entry,
 * value pickers, and anything that opens or steps a list on them (the
 * composer's provider-reauth `SelectTrigger` is a `role="combobox"`; Radix
 * dropdown triggers advertise `aria-haspopup` and open on ArrowDown). Arrows
 * aimed at those must reach them, so the transcript does not claim them.
 *
 * Deliberately NOT listed: plain buttons, links, `role="tab"`, and focusable
 * chrome in general. A canvas tab is a `role="tab"` div with `tabIndex={0}` and
 * has no arrow behaviour of its own - focus parks there after a tab click, and
 * that IS a transcript-scroll target.
 */
const ARROW_KEY_OWNER_SELECTOR = [
  "input",
  "select",
  "textarea",
  '[contenteditable="true"]',
  '[role="combobox"]',
  '[role="grid"]',
  '[role="gridcell"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="radiogroup"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="tablist"]',
  '[role="textbox"]',
  '[role="tree"]',
  '[role="treeitem"]',
  // Only popups the arrows actually open/step. A `dialog` popup (Radix
  // `PopoverTrigger`, e.g. the composer's context-usage chip) activates on
  // Enter/Space, so it must not hold the arrows hostage. Bare `true` is the
  // legacy spelling of `menu`.
  '[aria-haspopup="true"]',
  '[aria-haspopup="menu"]',
  '[aria-haspopup="listbox"]',
  '[aria-haspopup="tree"]',
  '[aria-haspopup="grid"]',
].join(",");

function ownsArrowKeys(target: EventTarget | null): boolean {
  if (isEditableTarget(target)) return true;
  if (!(target instanceof Element)) return false;
  if (target.closest(ARROW_KEY_OWNER_SELECTOR) !== null) return true;
  return target.closest(CHAT_TURN_MINIMAP_KEYBOARD_OWNER_SELECTOR) !== null;
}

/**
 * The minimap rail's single hit-target implements its own roving-selection
 * keyboard contract (arrows/Home/End/Enter/Space) while focused - unlike
 * `ownsArrowKeys`, plain Home/End otherwise has NO owner exemption at all
 * (they scroll the transcript unconditionally on macOS), so without this the
 * rail's own `onKeyDown` never sees them: this capture-phase listener runs
 * first and calls `stopPropagation`.
 */
function ownsBoundaryKeys(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(CHAT_TURN_MINIMAP_KEYBOARD_OWNER_SELECTOR) !== null;
}

function canvasPaneIdOf(node: Node | null): string | null {
  const element = node instanceof Element ? node : node?.parentElement;
  return (
    element?.closest("[data-group-id]")?.getAttribute("data-group-id") ?? null
  );
}

/**
 * Whether `target` sits in the same canvas pane as `tile` - the pane's tab
 * strip is a SIBLING of the tile, so containment alone cannot tell "this pane's
 * own chrome" apart from an unrelated surface.
 */
function sharesCanvasPane(tile: HTMLElement, target: Node): boolean {
  const paneId = canvasPaneIdOf(tile);
  return paneId !== null && canvasPaneIdOf(target) === paneId;
}

function chatKeyboardScrollAction(
  event: globalThis.KeyboardEvent,
): ChatKeyboardScrollAction | null {
  if (event.key === "PageUp") return "page-up";
  if (event.key === "PageDown") return "page-down";
  // Plain arrows step the transcript. The transcript rows are not focusable, so
  // the browser never adopts the scroller as its default keyboard scroller and
  // would otherwise scroll nothing at all. Targets that own the arrows
  // themselves keep them (see `ownsArrowKeys`), and any modifier makes it an
  // editor/selection chord we must not claim.
  if (
    (event.key === "ArrowUp" || event.key === "ArrowDown") &&
    isUnmodified(event) &&
    !ownsArrowKeys(event.target)
  ) {
    return event.key === "ArrowUp" ? "line-up" : "line-down";
  }
  // Plain Home/End scroll the transcript. On macOS they scroll even from the
  // composer (Cocoa editors never use them for caret movement - that's
  // Cmd+arrows); elsewhere an editable target keeps them for line navigation
  // and the modified chord (Ctrl+Home/End) is the always-available form. The
  // minimap rail keeps both forms for its own first/last-turn navigation.
  if (ownsBoundaryKeys(event.target)) return null;
  const boundary =
    isPlatformModifiedBoundaryKey(event) ||
    (isPlainBoundaryKey(event) && (isMac() || !isEditableTarget(event.target)));
  if (!boundary) return null;
  return event.key === "Home" ? "top" : "bottom";
}

/** The relative steps - `top`/`bottom` are absolute and carry no delta. */
type ChatKeyboardScrollStep = Exclude<
  ChatKeyboardScrollAction,
  "top" | "bottom"
>;

function chatKeyboardScrollDelta(
  scroller: HTMLElement,
  action: ChatKeyboardScrollStep,
): number {
  if (action === "page-up") return -scroller.clientHeight;
  if (action === "page-down") return scroller.clientHeight;
  return action === "line-up"
    ? -CHAT_ARROW_SCROLL_STEP_PX
    : CHAT_ARROW_SCROLL_STEP_PX;
}

function applyChatKeyboardScroll(
  scroller: HTMLElement,
  action: ChatKeyboardScrollAction,
): void {
  const maxScrollTop = Math.max(
    0,
    scroller.scrollHeight - scroller.clientHeight,
  );
  if (action === "top") {
    scroller.scrollTop = 0;
    return;
  }
  if (action === "bottom") {
    scroller.scrollTop = maxScrollTop;
    return;
  }
  scroller.scrollTop = Math.min(
    maxScrollTop,
    Math.max(0, scroller.scrollTop + chatKeyboardScrollDelta(scroller, action)),
  );
}

function segmentContainsBlockId(
  segment: MessageSegment,
  blockId: string,
): boolean {
  if (segment.id === blockId) return true;
  if (segment.kind === "subagent") {
    return segment.children.some((child) => child.id === blockId);
  }
  if (segment.kind === "file_change_group") {
    return segment.files.some((file) => file.id === blockId);
  }
  return false;
}

function activityGroupIdForBlock(
  messages: ReadonlyArray<ChatMessageModel>,
  messageId: string,
  blockId: string,
  promotedToolBlockIds: ReadonlySet<string>,
): string | null {
  const message = messages.find((candidate) => candidate.id === messageId);
  if (message === undefined) return null;
  const timeline = buildChatActivityTimeline(message.segments, {
    turnState: message.completedAt === null ? "active" : "complete",
    promotedToolBlockIds,
  });
  for (const item of timeline) {
    if (item.kind !== "activity_group") continue;
    if (
      item.group.segments.some((segment) =>
        segmentContainsBlockId(segment, blockId),
      )
    ) {
      return item.group.id;
    }
  }
  return null;
}

/**
 * Waits for `scrollNode` to settle after an issued scroll: the native
 * `scrollend` event, or a `timeoutMs` fallback (some environments never fire
 * `scrollend`), whichever comes first - then calls `onSettle` exactly once.
 * Returns a cancel function that tears down the pending listener/timeout
 * WITHOUT calling `onSettle`, for when something else pre-empts the wait
 * (a real user gesture, a newer operation superseding this one).
 */
function awaitScrollSettle(
  scrollNode: HTMLElement,
  onSettle: () => void,
  timeoutMs: number,
): () => void {
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    window.clearTimeout(fallbackTimer);
    scrollNode.removeEventListener("scrollend", finish);
    onSettle();
  };
  const fallbackTimer = window.setTimeout(finish, timeoutMs);
  scrollNode.addEventListener("scrollend", finish, { once: true });
  return (): void => {
    if (finished) return;
    finished = true;
    window.clearTimeout(fallbackTimer);
    scrollNode.removeEventListener("scrollend", finish);
  };
}

/**
 * Schedules `callback` two animation frames out - the reveal pass's own
 * post-layout timing convention (waits for LegendList's measurement pass to
 * settle before reading geometry). Returns a cleanup that cancels whichever
 * frame is still pending.
 */
function scheduleChatTimelineDoubleRaf(callback: () => void): () => void {
  let secondFrame: number | null = null;
  const firstFrame = requestAnimationFrame(() => {
    secondFrame = requestAnimationFrame(callback);
  });
  return (): void => {
    cancelAnimationFrame(firstFrame);
    if (secondFrame !== null) cancelAnimationFrame(secondFrame);
  };
}

/**
 * Ticket 10: generalizes the anchor engine's settle/re-issue pattern
 * (`onTimelineAnchorReady`, ticket 3) to plain programmatic navigation
 * (`navigateToMessage`/find/deep-link, `scrollToEnd`). An ANIMATED intent
 * targets ESTIMATED geometry; the installed LegendList 3.2.0 has no
 * mid-flight retargeting as real measurements replace estimates during the
 * animation, so a long jump can settle short (root-cause: rootcause-nav-
 * landing report). After `awaitScrollSettle`, `validate` checks the landing
 * against fresh geometry; if off, `reissue` re-issues the SAME semantic
 * target non-animated (which resolves synchronously - `scrollTo`'s
 * `!animated` branch calls `updateScroll` directly) and this re-settles, up
 * to `maxRetries` times. `isAborted` (checked before every validate AND
 * before every re-issue) is the caller's own ownership check - a generation
 * bump, a real gesture, or a mode change all supersede a still-in-flight
 * operation; it must stop correcting a position nobody wants anymore, same
 * as the anchor engine's own `positionedTimelineAnchorRef`/generation guards.
 * `onSettledInvalid` runs once if every retry is exhausted and the landing
 * is still off (never called if `isAborted` fires first). `onFirstSettle`
 * (H1 fix) runs exactly once, the moment the FIRST `awaitScrollSettle`
 * resolves (scrollend or the fallback timeout) - regardless of `isAborted`/
 * `validate` outcome - so a caller can release "an animated scroll is in
 * flight" bookkeeping the instant the native animation genuinely stops,
 * independent of whether settle/re-issue continues correcting the landing.
 */
function settleChatTimelineNavigation(input: {
  readonly scrollNode: HTMLElement;
  readonly isAborted: () => boolean;
  readonly validate: () => boolean;
  readonly reissue: () => void;
  readonly onSettledInvalid: () => void;
  readonly maxRetries: number;
  readonly onFirstSettle?: () => void;
}): void {
  let firstSettleFired = false;
  const attempt = (retriesLeft: number): void => {
    awaitScrollSettle(
      input.scrollNode,
      () => {
        if (!firstSettleFired) {
          firstSettleFired = true;
          input.onFirstSettle?.();
        }
        if (input.isAborted()) return;
        if (input.validate()) return;
        if (retriesLeft <= 0) {
          input.onSettledInvalid();
          return;
        }
        input.reissue();
        attempt(retriesLeft - 1);
      },
      CHAT_ANCHOR_SETTLE_FALLBACK_MS,
    );
  };
  attempt(input.maxRetries);
}

/**
 * Virtualized chat transcript. The full derived row history is handed to
 * `ChatTimeline` (LegendList), which windows the mounted DOM to the viewport.
 * This component owns the three-mode scroll policy (`following-end` /
 * `anchoring-new-turn` / `free-scrolling` - decision log #1) and the
 * composer/queued-surface overlay inset math (decision #13).
 */
export function ChatMessages(props: ChatMessagesProps) {
  // Ticket 5: registry-backed, keyed by tile instance id, so expanded A2A
  // cards survive the chat tile's full remount on tab switch (decision #17) -
  // evicted only when the tab permanently closes (canvas store's
  // tile-removal subscriber), never on a mere remount.
  const [a2aOpenStore] = useState(() =>
    getOrCreateA2AOpenStore(props.instanceId),
  );
  return (
    <A2AOpenStoreProvider store={a2aOpenStore}>
      <ChatFindForceStoreProvider tileInstanceId={props.instanceId}>
        <ChatMessagesInner {...props} />
      </ChatFindForceStoreProvider>
    </A2AOpenStoreProvider>
  );
}

function ChatMessagesInner(props: ChatMessagesProps) {
  const {
    consumeLocalProvenance,
    getMessageActions,
    backgroundItems,
    composerOverlayHeight,
    instanceId,
    localProvenanceMessageIds,
    messages,
    nextStepActions,
    scrollRequest,
    scrollStateKey,
    systemOverlayActive,
    taskId,
    taskTitle,
    visible,
  } = props;

  // Restore the persisted reading position once, on mount. The cache key is
  // the stable tile instance id, so re-reading per render would only repeat an
  // O(n) message scan whose result the initializers below already captured.
  const [restoredTabState] = useState<SavedChatTabScrollState>(() =>
    restoreChatTabState(scrollStateKey, messages),
  );
  // Distinguishes a genuinely never-before-opened chat from a restored
  // following-end tab (both produce the same `restoredTabState` shape - see
  // `hasSavedChatTabState`'s doc comment). Only the former triggers the
  // fresh-open policy below.
  const [hadSavedScrollState] = useState<boolean>(() =>
    hasSavedChatTabState(scrollStateKey),
  );
  // Fresh open (decision #15): no saved state -> anchor the LAST user
  // message near the top via the same anchor path as a send, non-animated,
  // instead of `initialScrollAtEnd`. `null` when a saved state exists (that
  // restore keeps precedence) or the transcript has no user row yet.
  const [freshOpenAnchorMessageId] = useState<string | null>(() => {
    if (hadSavedScrollState) return null;
    return messages.findLast((message) => message.role === "user")?.id ?? null;
  });
  // Ticket 5: a restored `free-scrolling` position with a still-valid anchor
  // row (`restoreChatTabState` already dropped it if stale) becomes LegendList's
  // own `initialScrollIndex` bootstrap - the same measurement-aware convergence
  // path `initialScrollAtEnd` already relies on (verified against the installed
  // @legendapp/list 3.2.0 source: both route through the same bootstrap-scroll
  // pipeline), rather than a hand-rolled scrollToIndex retry: a one-shot call
  // positioned against 90px row-size estimates cannot self-correct as real
  // heights arrive, so a deep anchor past variable-height rows would drift.
  // `freshOpenAnchorMessageId` takes precedence - a genuinely fresh chat has
  // nothing to restore. `anchoring-new-turn` never round-trips through the
  // cache (see `chat-tab-state-cache.ts`), so this is the only other mode that
  // can carry a mount-time anchor.
  const [initialScrollIndexAnchor] =
    useState<ChatTimelineInitialScrollAnchor | null>(() => {
      if (freshOpenAnchorMessageId !== null) return null;
      if (restoredTabState.mode !== "free-scrolling") return null;
      if (restoredTabState.anchorMessageId === null) return null;
      const index = messages.findIndex(
        (message) => message.id === restoredTabState.anchorMessageId,
      );
      if (index === -1) return null;
      return { index, viewOffset: restoredTabState.offset, viewPosition: 0 };
    });

  const chatTimelineRef = useRef<LegendListRef | null>(null);
  const transcriptContainerRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef(messages);
  const messageIndexByIdRef = useRef(buildMessageIdToIndex(messages));
  const scrollRequestRef = useRef(scrollRequest);
  const handledScrollRequestIdRef = useRef<number | null>(null);
  const backgroundToolBlockIdsRef = useRef<ReadonlySet<string>>(
    EMPTY_BACKGROUND_TOOL_BLOCK_IDS,
  );
  // Ticket 5 / decision #18: LegendList's measured header size (the main
  // component of getTopOffsetAdjustment). Capture folds this into the saved
  // viewOffset so initialScrollIndex restore lands on the same pixel - bare
  // positionAtIndex - scroll under-counts by exactly this pad.
  const listTopOffsetAdjustmentRef = useRef(0);
  // Ticket 5 / F3: footer size joins header in the true no-reserve max-scroll
  // bound (LegendList content length). Kept from the same metrics callback.
  const listFooterSizeRef = useRef(0);
  // The fresh-open anchor target (if any) is also the immediately-active
  // minimap row - no need to wait for the async viewport scan to catch up.
  const scrolledActiveUserMessageIdRef = useRef(
    freshOpenAnchorMessageId ?? restoredTabState.anchorMessageId,
  );
  const previousMessagesForEdgeMutationRef =
    useRef<ReadonlyArray<ChatMessageModel> | null>(null);
  const [navigationHighlightedMessageId, setNavigationHighlightedMessageId] =
    useState<string | null>(null);
  const navigationHighlightTimeoutRef = useRef<number | null>(null);
  const showNavigationHighlight = useCallback((messageId: string): void => {
    if (navigationHighlightTimeoutRef.current !== null) {
      window.clearTimeout(navigationHighlightTimeoutRef.current);
    }
    setNavigationHighlightedMessageId(messageId);
    navigationHighlightTimeoutRef.current = window.setTimeout(() => {
      navigationHighlightTimeoutRef.current = null;
      setNavigationHighlightedMessageId(null);
    }, NAVIGATION_HIGHLIGHT_DURATION_MS);
  }, []);
  useEffect(
    () => () => {
      if (navigationHighlightTimeoutRef.current !== null) {
        window.clearTimeout(navigationHighlightTimeoutRef.current);
      }
    },
    [],
  );

  // --- Three-mode scroll policy (decision log #1) ---------------------------
  //
  // `freshOpenAnchorMessageId` (decision #15) takes precedence over the
  // restored tab state's `mode` - see the seed's own doc comment for the
  // full precedence rule.
  const [initialModeSeed] = useState(() =>
    resolveChatTimelineInitialModeSeed({
      freshOpenAnchorMessageId,
      bottomFollowing: restoredTabState.mode === "following-end",
    }),
  );
  const timelineScrollModeRef = useRef<ChatTimelineScrollMode>(
    initialModeSeed.mode,
  );
  // `null` is a distinct "stale/needs reconciliation" sentinel, not a guessed
  // boolean (M1): a cancel invalidates this to `null` rather than `false`, so
  // the NEXT onIsAtEndChange report - whichever value it turns out to be -
  // always proceeds past the equality fast-path exactly once, instead of a
  // guessed `false` accidentally matching a genuinely-left-the-end report
  // and swallowing its pill/mode reconciliation.
  const isAtEndRef = useRef<boolean | null>(initialModeSeed.isAtEnd);
  // Seeded to the fresh-open target (if any) so the anchor engine's first
  // `onAnchorReady` for it is accepted (`shouldAcceptChatAnchorReadyEvent`)
  // instead of rejected as stale.
  const pendingTimelineAnchorRef = useRef<string | null>(
    freshOpenAnchorMessageId,
  );
  const positionedTimelineAnchorRef = useRef<string | null>(null);
  const settledTimelineAnchorRef = useRef<string | null>(null);
  const activeTimelineAnchorIndexRef = useRef<number | null>(null);
  const anchorUserScrollGenerationRef = useRef(0);
  const liveFollowUserScrollGenerationRef = useRef<number | null>(
    initialModeSeed.liveFollowGeneration,
  );
  const pendingAnchorScrollRestoreRef = useRef<{
    readonly offset: number;
    readonly userScrollGeneration: number;
  } | null>(null);
  const anchorScrollRestoreFrameRef = useRef<number | null>(null);
  // Whether the anchor engine's positioning `scrollToIndex` call animates.
  // `true` for every real anchor-triggering event (send/steer/edit/queued-
  // flush/A2A - decision #12); `false` only for the fresh-open seed (decision
  // #15: "same anchor math as a send, not animated"). Set back to `true` by
  // `beginAnchoringNewTurn` so a later real turn in the same session animates
  // normally.
  const anchorAnimatedRef = useRef(freshOpenAnchorMessageId === null);
  // A programmatic scroll that must not silently re-enable follow (decision
  // #14, #21 - preserved-not-following suffix removal, find/minimap/deep-link
  // navigation) sets this until a real gesture cancel clears it (see
  // cancelTimelineLiveFollowForUserNavigation below) or setTimelineMode
  // ("following-end") supersedes it outright. While set, `isAtEndRef` keeps
  // tracking the real physical position (see onIsAtEndChange), but no report
  // - false, true, or a duplicate - may flip mode to following-end. This is a
  // deliberately accepted gap, not a bug: an autonomous (non-gesture) true
  // report arriving after the operation has long settled, with no gesture in
  // between, no longer re-pins follow on its own.
  //
  // Ticket 5 (F1): seeded `true` when mount is bootstrapping a restored
  // free-scrolling position (`initialScrollIndexAnchor !== null`) - that
  // bootstrap can land near the tail by coincidence, same as the classifier's
  // own "stay free-scrolling" scroll-to-index case (decision #14/#21), and
  // must not be misread as the reader gesturing to the end. Cleared by the
  // first real gesture cancel or an explicit go-live, same as any other
  // suppression.
  const suppressFollowRestoreRef = useRef(initialScrollIndexAnchor !== null);
  // Review round (tickets 10/11/12, H1/round-2 finding 2): whether an
  // ANIMATED imperative scroll (pill-click `scrollToEnd`, minimap/find
  // navigation, the anchor engine's own positioning scrollToIndex) is
  // currently in flight, tracked INDEPENDENTLY of `suppressFollowRestoreRef`
  // - the freeze below was gated solely on suppression, but these paths are
  // explicit actions that legitimately clear suppression (`setTimelineMode
  // ("following-end")`, `beginAnchoringNewTurn`) BEFORE their own animated
  // scroll settles. A bare pointerdown mid-animation then found nothing to
  // freeze: the native smooth-scroll kept running, and its terminal
  // near-end report re-enabled following against the cancellation.
  //
  // An OPERATION ID (not a boolean) - round-2 finding: a bare boolean is not
  // operation-safe. `onFirstSettle`/the anchor engine's own settle callback
  // fire unconditionally regardless of `isAborted`, and each one used to
  // write `false` unconditionally - op1's late 750ms fallback (its
  // `awaitScrollSettle` cancellation is never invoked, only ever left to
  // expire) could clear op2's freshly-armed ownership if op2 started before
  // op1's fallback fired (e.g. a quick minimap-nav-then-pill-click). Each
  // operation captures a freshly minted id at issue
  // (`++animatedImperativeScrollOperationCounterRef.current`) and clears
  // `activeAnimatedImperativeScrollOperationIdRef` ONLY if it still owns it
  // (captured id === current) - a superseded operation's late settle is a
  // no-op instead of clobbering the new owner. The freeze check below reads
  // "owned by ANYONE" (`!== null`) since a pointerdown must freeze whichever
  // operation is currently in flight; the cancel path clears unconditionally
  // (after the freeze reads it - read-before-clear ordering preserved from
  // round 1), same as `suppressFollowRestoreRef`.
  const animatedImperativeScrollOperationCounterRef = useRef(0);
  const activeAnimatedImperativeScrollOperationIdRef = useRef<number | null>(
    null,
  );
  // A real cancel while suppressed freezes the in-flight scroll (see
  // cancelTimelineLiveFollowForUserNavigation below) rather than just
  // clearing suppression: an ANIMATED scrollToIndex is the browser's native
  // smooth-scroll, which keeps running after a bare pointerdown (decision
  // #6) - a pointerdown produces no scroll of its own, so nothing else stops
  // it, and its eventual terminal near-end report would otherwise arrive
  // UNSUPPRESSED and reverse the cancellation. The freeze reliably cancels
  // that native animation in a real browser; this flag is a narrow, bounded
  // defense for the one report that MAY follow immediately after - consumed
  // by the very next report regardless of value, mirroring how a real
  // browser's own scrollTop write pre-empts anything already in flight. It is
  // ALSO bounded by time, not just by report: the freeze's own same-offset
  // write is not guaranteed to emit a report at all (jsdom, or a real browser
  // deduping a same-position write), so it is unconditionally cleared at the
  // top of every subsequent cancel too - an unconsumed grace must never
  // survive into a LATER, unrelated gesture and swallow THAT gesture's own
  // legitimate terminal report.
  const justFrozeProgrammaticScrollRef = useRef(false);
  // Message id the anchor engine is actively tracking - a sent/steered/
  // queued turn's user row, or the fresh-open seed. `null` is the ordinary
  // follow/free-scroll case.
  const [timelineAnchorMessageId, setTimelineAnchorMessageId] = useState<
    string | null
  >(freshOpenAnchorMessageId);
  // Mirrors `timelineScrollModeRef.current === "following-end"` into render -
  // the minimap's active-dot selection needs to read it during render, which
  // a ref cannot do.
  const [isFollowingEnd, setIsFollowingEnd] = useState(
    initialModeSeed.isFollowingEnd,
  );
  // Mirrors `timelineScrollModeRef.current === "anchoring-new-turn"` into
  // render, same reasoning as `isFollowingEnd` - the pill's visibility
  // branches on which of the three modes is live. Mutually exclusive with
  // `isFollowingEnd` by construction (every setter that flips one clears the
  // other).
  const [isAnchoringNewTurn, setIsAnchoringNewTurn] = useState(
    initialModeSeed.mode === "anchoring-new-turn",
  );
  const [showScrollToBottom, setShowScrollToBottom] = useState(
    initialModeSeed.showScrollToBottom,
  );
  // Ticket 11: mirrors the latest REAL scroll-driven isAtEnd/isNearEnd
  // report, updated unconditionally at the very top of onIsAtEndChange -
  // independent of the mode machine's "owned"/suppressed filtering below it.
  // A scroll-only route (native OS scrollbar drag) fires no wheel/touchmove/
  // pointerdown, so this is the only signal for "where is the reader right
  // now" while anchoring; the anchoring-mode pill (below) consults it
  // directly instead of pure turn geometry (root-cause: field bug 4 - pill
  // shown while the reader is already at the live edge).
  //
  // Seeded from `isFollowingEnd`, NOT `initialModeSeed.isAtEnd` - that flag
  // is `true` for BOTH the `following-end` seed (genuinely at the edge) AND
  // decision #15's fresh-open `anchoring-new-turn` seed (anchored near the
  // TOP of a long final reply - the reader is, by construction, NOT at the
  // edge; that's the entire point of the seed). `isAtEnd` there means "the
  // owned/mid-flight baseline for the equality fast-path", a different
  // contract than "is the reader standing at the live edge".
  const [isReaderAtLiveEdge, setIsReaderAtLiveEdge] = useState(
    initialModeSeed.isFollowingEnd,
  );
  // Whether the anchored turn's real content extends past the usable
  // viewport - gates the pill while `isAnchoringNewTurn` (decision #16: the
  // pill only matters when there's something hidden below the fold).
  const [anchoredTurnOverflowsViewport, setAnchoredTurnOverflowsViewport] =
    useState(false);
  // Ref mirror read by `cancelTimelineLiveFollowForUserNavigation` (a stable
  // `useCallback`) - a real gesture cancelling out of `anchoring-new-turn`
  // while this was true (M4 fix) must hand pill visibility off to
  // `showScrollToBottom` immediately rather than reading a stale closure
  // value or waiting on a scroll event that a bare pointerdown never
  // produces.
  const anchoredTurnOverflowsViewportRef = useRef(false);
  // A turn completed while the reader was away (not `following-end`) and
  // they have not returned to the tail since - drives the pill's "New reply"
  // state (decision #16). Reset on returning to `following-end` and on
  // beginning a fresh anchor session.
  const [hasUnseenTurnCompletion, setHasUnseenTurnCompletion] = useState(false);
  const pillShowTimeoutRef = useRef<number | null>(null);

  const cancelPillShow = useCallback((): void => {
    if (pillShowTimeoutRef.current !== null) {
      window.clearTimeout(pillShowTimeoutRef.current);
      pillShowTimeoutRef.current = null;
    }
  }, []);
  // 150ms debounced pill *show*; hiding is always immediate. LegendList fires
  // scroll events with isAtEnd=false while `initialScrollAtEnd` is settling,
  // so showing eagerly would flash the pill during thread/tab opens.
  const maybeShowPillDebounced = useCallback((): void => {
    if (pillShowTimeoutRef.current !== null) return;
    pillShowTimeoutRef.current = window.setTimeout(() => {
      pillShowTimeoutRef.current = null;
      setShowScrollToBottom(true);
    }, PILL_SHOW_DEBOUNCE_MS);
  }, []);

  // Ref-only (no React state): the minimap derives in-view highlighting from
  // list state, not a stored active id, so nothing renders off this value
  // anymore - only the ticket-5 unmount-save effect reads it imperatively. A
  // state setter here would just re-render the whole component on every
  // scroll tick for no observable effect.
  const setScrolledActiveUserMessageIdIfChanged = useCallback(
    (next: string | null): void => {
      scrolledActiveUserMessageIdRef.current = next;
    },
    [],
  );

  const setTimelineMode = useCallback(
    (next: "following-end" | "free-scrolling"): void => {
      timelineScrollModeRef.current = next;
      // Both destinations here leave `anchoring-new-turn` (if it was active).
      setIsAnchoringNewTurn(false);
      if (next === "following-end") {
        isAtEndRef.current = true;
        liveFollowUserScrollGenerationRef.current =
          anchorUserScrollGenerationRef.current;
        cancelPillShow();
        setShowScrollToBottom(false);
        suppressFollowRestoreRef.current = false;
        // Reaching the tail "sees" everything - decision #10's unseen-turn
        // signal no longer applies.
        setHasUnseenTurnCompletion(false);
      } else {
        liveFollowUserScrollGenerationRef.current = null;
      }
      setIsFollowingEnd(next === "following-end");
    },
    [cancelPillShow],
  );

  // Decision #6: ANY pointerdown in the transcript - expanding a card,
  // selecting text, clicking a link - relinquishes follow/anchor ownership,
  // same as a wheel/touch/keyboard gesture (decision #5, #7).
  //
  // `freezeInFlightScroll` distinguishes the two ways a caller can cancel:
  // wheel/touchmove/keyboard scrolling, and navigateToMessage/find (a
  // programmatic navigation whose OWN immediate follow-up scroll already
  // takes over) all produce their own real, immediate movement right after
  // cancelling and must NOT have that movement's own report swallowed - they
  // pass `false` (plain release). A bare pointerdown produces no scroll of
  // its own, so a suppressed ANIMATED scroll (the browser's native
  // smooth-scroll) keeps running unless explicitly frozen - it passes `true`.
  const cancelTimelineLiveFollowForUserNavigation = useCallback(
    (freezeInFlightScroll: boolean): void => {
      // M4 fix: a real gesture (a bare pointerdown selecting text, expanding
      // a card - produces no scroll of its own) leaving `anchoring-new-turn`
      // while its overflow pill was visible must hand visibility off to the
      // free-scroll pill immediately - the reader is demonstrably no longer
      // at the end, and waiting for an `onIsAtEndChange` report that a
      // scroll-less gesture will never produce would leave the pill
      // (wrongly) hidden until some later, unrelated scroll happens to fire.
      const wasAnchoringWithVisiblePill =
        timelineScrollModeRef.current === "anchoring-new-turn" &&
        anchoredTurnOverflowsViewportRef.current;
      anchorUserScrollGenerationRef.current += 1;
      timelineScrollModeRef.current = "free-scrolling";
      // Invalidate the cached "at end" flag along with the mode (M1): leaving
      // it stale (true) would make the NEXT onIsAtEndChange(true) report -
      // even an identical, still-in-the-near-end-band one - hit the equality
      // fast-path and never reconcile, permanently desyncing mode from
      // isAtEndRef and blocking "isNearEnd restores follow" for a reader who
      // never actually left the band. `null` (not a guessed `false`) so the
      // next report - whichever value it is - always reconciles exactly once.
      isAtEndRef.current = null;
      setIsFollowingEnd(false);
      setIsAnchoringNewTurn(false);
      if (wasAnchoringWithVisiblePill) {
        cancelPillShow();
        setShowScrollToBottom(true);
      }
      liveFollowUserScrollGenerationRef.current = null;
      pendingTimelineAnchorRef.current = null;
      positionedTimelineAnchorRef.current = null;
      settledTimelineAnchorRef.current = null;
      activeTimelineAnchorIndexRef.current = null;
      pendingAnchorScrollRestoreRef.current = null;
      // A real gesture (or a fresh navigation, which calls this first) wins
      // immediately over a still-in-flight programmatic-scroll operation,
      // regardless of what that operation was in the middle of doing.
      // `freezeInFlightScroll` (pointerdown only) additionally cancels
      // the browser's native smooth-scroll animation in place; the other
      // callers' own immediate follow-up movement already takes over without
      // it (see the comment above).
      //
      // Unconditionally cleared FIRST: an earlier freeze's grace window may
      // never see the report it exists to absorb (see the ref's own comment
      // above) and must not leak into THIS cancel's own gesture.
      justFrozeProgrammaticScrollRef.current = false;
      // H1 fix: freeze on suppression OR an in-flight animated imperative
      // scroll (owned by ANY operation - `!== null`, not which one) -
      // `scrollToEnd`'s pill-click path and `beginAnchoringNewTurn` both
      // legitimately clear suppression before their own animation settles
      // (see `activeAnimatedImperativeScrollOperationIdRef`'s own doc
      // comment), so suppression alone under-covers exactly the case this
      // ref exists for.
      if (
        freezeInFlightScroll &&
        (suppressFollowRestoreRef.current ||
          activeAnimatedImperativeScrollOperationIdRef.current !== null)
      ) {
        const list = chatTimelineRef.current;
        const currentScroll = list?.getState().scroll;
        if (list && typeof currentScroll === "number") {
          void list.scrollToOffset({ offset: currentScroll, animated: false });
          justFrozeProgrammaticScrollRef.current = true;
        }
      }
      suppressFollowRestoreRef.current = false;
      activeAnimatedImperativeScrollOperationIdRef.current = null;
      if (anchorScrollRestoreFrameRef.current !== null) {
        cancelAnimationFrame(anchorScrollRestoreFrameRef.current);
        anchorScrollRestoreFrameRef.current = null;
      }
    },
    [cancelPillShow],
  );
  const cancelTimelineLiveFollowForUserNavigationRef = useRef(
    cancelTimelineLiveFollowForUserNavigation,
  );
  useLayoutEffect(() => {
    cancelTimelineLiveFollowForUserNavigationRef.current =
      cancelTimelineLiveFollowForUserNavigation;
  }, [cancelTimelineLiveFollowForUserNavigation]);

  // ChatTimeline unmounts LegendList entirely for an empty transcript
  // (ChatEmptyState instead), so this - not just `messages` identity - is
  // the signal that tracks whether a real scroll node can exist right now.
  const hasContent = messages.length > 0;

  // Insets (decision #12-13): flat 16px top anchor offset; the composer/queue
  // dock's measured height reserves the bottom. Folding the pinned-todo-stack
  // height into the anchor offset separately is deferred - see ticket-3
  // report.
  const anchorOffset = CHAT_LIST_ANCHOR_OFFSET;
  const endInset = composerOverlayHeight;
  const anchorOffsetRef = useRef(anchorOffset);
  useLayoutEffect(() => {
    anchorOffsetRef.current = anchorOffset;
  }, [anchorOffset]);

  const getActiveTimelineTurnMetrics = useCallback(
    (list: LegendListRef) => {
      const anchorIndex = activeTimelineAnchorIndexRef.current;
      const state = list.getState();
      if (anchorIndex === null) {
        return null;
      }
      return getChatAnchoredTurnMetrics({
        state,
        anchorIndex,
        endInset,
        anchorOffset,
      });
    },
    [endInset, anchorOffset],
  );
  const timelineRealContentOverflowsViewport = useCallback(
    (list: LegendListRef) => {
      return chatTimelineRealContentOverflowsViewport(
        list.getState(),
        endInset,
        anchorOffset,
      );
    },
    [endInset, anchorOffset],
  );

  // scrollToEnd reset (pill click / any future explicit "go live" action).
  // Ticket 10: this is an explicit user action - the `setTimelineMode`
  // call below is decision-sanctioned and unconditional, same as before;
  // the settle/re-issue only corrects the LANDING it produces, never
  // re-decides whether the click counts as "following".
  const scrollToEnd = useCallback(
    (animated: boolean): void => {
      setTimelineMode("following-end");
      pendingTimelineAnchorRef.current = null;
      activeTimelineAnchorIndexRef.current = null;
      const generationAtIssue = anchorUserScrollGenerationRef.current;
      const list = chatTimelineRef.current;
      // H1 fix: an animated pill click legitimately clears
      // `suppressFollowRestoreRef` (explicit go-live), so it's the freeze
      // condition's OTHER input that must cover a bare pointerdown arriving
      // mid-animation - see the ref's own doc comment. Round-2: an operation
      // id, not a boolean - captured locally so the clear below can verify
      // this operation still owns it before clobbering a newer one.
      const animatedScrollOperationId = animated
        ? ++animatedImperativeScrollOperationCounterRef.current
        : null;
      if (animatedScrollOperationId !== null) {
        activeAnimatedImperativeScrollOperationIdRef.current =
          animatedScrollOperationId;
      }
      void list?.scrollToEnd({ animated });
      if (!list) return;
      const scrollNode = list.getScrollableNode();
      settleChatTimelineNavigation({
        scrollNode,
        isAborted: () =>
          anchorUserScrollGenerationRef.current !== generationAtIssue ||
          timelineScrollModeRef.current !== "following-end",
        validate: () => list.getState().isAtEnd,
        reissue: () => {
          void list.scrollToEnd({ animated: false });
        },
        onSettledInvalid: () => {
          // Ticket 10: the video-evidence stranded state - a failed
          // end-landing must never leave `following-end` idling mid-list
          // outside maintainScrollAtEnd's threshold. Reconcile honestly
          // instead: free-scrolling with the pill visible beats silently
          // claiming to follow from wherever this settled.
          setTimelineMode("free-scrolling");
          cancelPillShow();
          setShowScrollToBottom(true);
        },
        onFirstSettle: () => {
          if (
            animatedScrollOperationId !== null &&
            activeAnimatedImperativeScrollOperationIdRef.current ===
              animatedScrollOperationId
          ) {
            activeAnimatedImperativeScrollOperationIdRef.current = null;
          }
        },
        maxRetries: CHAT_TIMELINE_NAVIGATION_MAX_RETRIES,
      });
    },
    [cancelPillShow, setTimelineMode],
  );

  // Enters `anchoring-new-turn` for `messageId` using the ref sequence from
  // decisions #8/#9/#12, driven here from the data-diff layer
  // (`classifyChatEdgeMutation`'s `anchor-new-turn` action) since composer
  // send/steer/edit/queued-flush/A2A-row live outside this component. Setting
  // `timelineAnchorMessageId` is what actually kicks off the anchor engine:
  // `ChatTimeline` recomputes `anchoredEndSpace` from the new prop and
  // LegendList calls back `onAnchorReady` once it resolves the row's index -
  // the rest of the engine (positioning, settle, reveal) is ticket 3's dark,
  // unmodified machinery.
  const beginAnchoringNewTurn = useCallback(
    (messageId: string, animated: boolean): void => {
      isAtEndRef.current = true;
      timelineScrollModeRef.current = "anchoring-new-turn";
      liveFollowUserScrollGenerationRef.current =
        anchorUserScrollGenerationRef.current;
      pendingTimelineAnchorRef.current = messageId;
      positionedTimelineAnchorRef.current = null;
      settledTimelineAnchorRef.current = null;
      activeTimelineAnchorIndexRef.current = null;
      pendingAnchorScrollRestoreRef.current = null;
      if (anchorScrollRestoreFrameRef.current !== null) {
        cancelAnimationFrame(anchorScrollRestoreFrameRef.current);
        anchorScrollRestoreFrameRef.current = null;
      }
      suppressFollowRestoreRef.current = false;
      anchorAnimatedRef.current = animated;
      cancelPillShow();
      setShowScrollToBottom(false);
      setIsFollowingEnd(false);
      setIsAnchoringNewTurn(true);
      anchoredTurnOverflowsViewportRef.current = false;
      setAnchoredTurnOverflowsViewport(false);
      // Ticket 11 fix #2: every anchoring session starts with the anchored
      // row positioned near the TOP (decision #12's flat offset) - the
      // reader is, by construction, never at the live edge the instant this
      // begins. Without this reset, a session that starts FROM
      // `following-end` (genuinely at the edge, mirror `true`) would leave
      // the mirror stale, permanently gating the overflow pill hidden for
      // the whole turn (`anchoredTurnOverflowsViewport && !isReaderAtLiveEdge`
      // never turns visible).
      setIsReaderAtLiveEdge(false);
      setHasUnseenTurnCompletion(false);
      setTimelineAnchorMessageId(messageId);
    },
    [cancelPillShow],
  );

  // Intent listeners (decision #5): passive wheel/touchmove/pointerdown on the
  // scroll node cancel live-follow. `ChatTimeline` unmounts its `LegendList`
  // entirely for an empty transcript (rendering `ChatEmptyState` instead), so
  // the scroll node's lifecycle does not match this component's own mount:
  // it may not exist yet at mount (an empty-then-first-message chat), and it
  // is torn down and replaced by a NEW node across any non-empty -> empty ->
  // repopulated cycle. Poll every frame until the node appears (cheap - one
  // ref read + identity check), re-attaching whenever it changes; stop
  // polling once attached. Re-armed whenever `hasContent` toggles so a later
  // empty/repopulate cycle gets picked up again.
  useLayoutEffect(() => {
    if (!hasContent) return;
    let cancelled = false;
    let frame: number | null = null;
    let attachedNode: HTMLElement | null = null;

    // Wheel/touchmove already replace whatever the scroll was doing with
    // real, immediate movement of their own, so their own subsequent report
    // must not be swallowed - plain release, no freeze. A bare pointerdown
    // (selecting text, expanding a card) produces no scroll of its own, so
    // a suppressed ANIMATED scroll (the browser's native smooth-scroll) keeps
    // running unless explicitly frozen (see cancelTimelineLiveFollowForUserNavigation).
    const handleManualNavigationWithMovement = () => {
      cancelTimelineLiveFollowForUserNavigationRef.current(false);
    };
    const handlePointerDownManualNavigation = () => {
      cancelTimelineLiveFollowForUserNavigationRef.current(true);
    };
    const detach = (): void => {
      if (attachedNode === null) return;
      attachedNode.removeEventListener(
        "wheel",
        handleManualNavigationWithMovement,
      );
      attachedNode.removeEventListener(
        "touchmove",
        handleManualNavigationWithMovement,
      );
      attachedNode.removeEventListener(
        "pointerdown",
        handlePointerDownManualNavigation,
      );
      attachedNode = null;
    };
    const tryAttach = (): void => {
      if (cancelled) return;
      const scrollNode = chatTimelineRef.current?.getScrollableNode() ?? null;
      if (scrollNode === null) {
        frame = requestAnimationFrame(tryAttach);
        return;
      }
      if (scrollNode === attachedNode) return;
      detach();
      scrollNode.addEventListener("wheel", handleManualNavigationWithMovement, {
        passive: true,
      });
      scrollNode.addEventListener(
        "touchmove",
        handleManualNavigationWithMovement,
        {
          passive: true,
        },
      );
      scrollNode.addEventListener(
        "pointerdown",
        handlePointerDownManualNavigation,
        {
          passive: true,
        },
      );
      attachedNode = scrollNode;
    };
    frame = requestAnimationFrame(tryAttach);

    return () => {
      cancelled = true;
      if (frame !== null) cancelAnimationFrame(frame);
      detach();
    };
  }, [hasContent]);

  // --- Anchor engine --------------------------------------------------------

  const onTimelineAnchorReady = useCallback(
    (messageId: string, anchorIndex: number): void => {
      if (
        !shouldAcceptChatAnchorReadyEvent({
          messageId,
          pendingAnchorMessageId: pendingTimelineAnchorRef.current,
          positionedAnchorMessageId: positionedTimelineAnchorRef.current,
        })
      ) {
        // Stale/abandoned: a cancel (or a newer anchor request) already
        // superseded this messageId. Do not resurrect anchor tracking for it.
        return;
      }
      if (pendingTimelineAnchorRef.current === messageId) {
        pendingTimelineAnchorRef.current = null;
      }
      // Always refresh to the latest index, even when we're already
      // positioning/positioned for this messageId - a weave can shift the
      // anchored row between LegendList's measure pass and the scroll
      // actually executing several frames later; `positionAnchor` below
      // re-reads this ref at scroll time instead of trusting a captured
      // closure value.
      activeTimelineAnchorIndexRef.current = anchorIndex;
      if (positionedTimelineAnchorRef.current === messageId) {
        return;
      }
      positionedTimelineAnchorRef.current = messageId;
      settledTimelineAnchorRef.current = null;
      const generationAtReady = anchorUserScrollGenerationRef.current;
      const positionAnchor = (remainingAttempts: number): void => {
        requestAnimationFrame(() => {
          if (anchorUserScrollGenerationRef.current !== generationAtReady) {
            // A cancel happened since this anchor was scheduled - abandon.
            return;
          }
          if (positionedTimelineAnchorRef.current !== messageId) {
            return;
          }
          const list = chatTimelineRef.current;
          if (!list) {
            if (remainingAttempts > 0) {
              positionAnchor(remainingAttempts - 1);
            }
            return;
          }
          // Re-read the CURRENT anchor index, not the value captured when
          // this call chain started.
          const currentAnchorIndex =
            activeTimelineAnchorIndexRef.current ?? anchorIndex;
          const scrollNode = list.getScrollableNode();
          // Round-2 finding 1: every real send/steer/edit/queued-flush/A2A
          // anchor is ANIMATED (decision #12) and `beginAnchoringNewTurn`
          // clears `suppressFollowRestoreRef` unconditionally - the SAME gap
          // H1 fixed for `scrollToEnd`/navigation, reachable via the most
          // ordinary path: send -> reader pointerdowns to select text
          // mid-animation -> mode goes free, but nothing had armed the
          // freeze's OTHER input, so the still-running native animation's
          // terminal report could re-pin follow against the cancel. Fresh-
          // open stays safe automatically - `anchorAnimatedRef.current` is
          // `false` there (decision #15), so `animatedAnchorOperationId` is
          // `null` and both the arm below and the clear are no-ops.
          const animatedAnchorOperationId = anchorAnimatedRef.current
            ? ++animatedImperativeScrollOperationCounterRef.current
            : null;
          if (animatedAnchorOperationId !== null) {
            activeAnimatedImperativeScrollOperationIdRef.current =
              animatedAnchorOperationId;
          }
          awaitScrollSettle(
            scrollNode,
            () => {
              // Cleared FIRST, unconditionally relative to this operation's
              // OWN bookkeeping below (mirrors `settleChatTimelineNavigation`'s
              // `onFirstSettle` - "the animation genuinely stopped" holds
              // regardless of whether this settle goes on to reposition) -
              // but ownership-checked against the SHARED ref (round-2 finding
              // 2): a superseded/late settle must not clobber a newer
              // operation's own armed ownership.
              if (
                animatedAnchorOperationId !== null &&
                activeAnimatedImperativeScrollOperationIdRef.current ===
                  animatedAnchorOperationId
              ) {
                activeAnimatedImperativeScrollOperationIdRef.current = null;
              }
              if (positionedTimelineAnchorRef.current !== messageId) return;
              if (anchorUserScrollGenerationRef.current !== generationAtReady)
                return;
              // Re-issue the SAME positioning command, non-animated, rather
              // than re-pinning to wherever we happen to be. Two distinct
              // failure modes both need this by settle time: (1) the
              // ANIMATED `scrollToIndex` above only syncs LegendList's own
              // tracked `state.scroll` off a completed native
              // scroll/scrollend cycle - a long jump across many unmeasured
              // rows can settle (via this very `awaitScrollSettle`
              // fallback) before that internal value ever catches up, and
              // (2) `anchoredEndSpace`'s reserved trailing space for a NEW
              // anchor can still be resolving off estimated (not yet
              // measured) row sizes at the moment the FIRST `scrollToIndex`
              // ran, clamping its target short by however much the reserve
              // was still missing - a shortfall nothing else re-corrects,
              // since the reveal-pass effect only re-fires on `messages`
              // changes, not on a later, more-accurate `onSizeChanged`.
              // Re-running `scrollToIndex` (not `scrollToOffset` to a
              // captured position) against NOW-current geometry fixes both:
              // non-animated resolves synchronously (recall
              // `scrollTo`'s `!animated` branch calls `updateScroll`
              // directly), and recomputing the target from the anchor
              // index - not reusing a stale captured offset - self-corrects
              // any clamp shortfall once the reserve has finished settling.
              void list.scrollToIndex({
                index: currentAnchorIndex,
                animated: false,
                viewPosition: 0,
                viewOffset: anchorOffsetRef.current,
              });
              settledTimelineAnchorRef.current = messageId;
              // The reveal-pass effect only re-measures overflow on a
              // `messages` change - a fresh-open anchor onto an already-
              // settled turn (decision #15: "the pill points at the tail of
              // a long final reply") never gets one after this. Measure once
              // here too so the pill reflects overflow even when nothing
              // streams in afterward.
              const metrics = getActiveTimelineTurnMetrics(list);
              if (metrics) {
                anchoredTurnOverflowsViewportRef.current =
                  metrics.overflowsUsableViewport;
                setAnchoredTurnOverflowsViewport(
                  metrics.overflowsUsableViewport,
                );
              }
            },
            CHAT_ANCHOR_SETTLE_FALLBACK_MS,
          );
          void list.scrollToIndex({
            index: currentAnchorIndex,
            animated: anchorAnimatedRef.current,
            viewPosition: 0,
            viewOffset: anchorOffsetRef.current,
          });
        });
      };
      requestAnimationFrame(() => positionAnchor(12));
    },
    [getActiveTimelineTurnMetrics],
  );

  const onTimelineAnchorSizeChanged = useCallback((messageId: string): void => {
    if (settledTimelineAnchorRef.current !== messageId) return;
    // While THIS generation still owns live-follow (mid-anchor, or plain
    // following-end), the two-rAF reveal-pass effect is the sole owner of
    // scroll adjustments in response to content growth - restoring here too
    // would race it.
    //
    // The restore below is written for a settled anchor whose live-follow
    // generation has since been invalidated (a size change landing after the
    // reader manually opted into free-scrolling). Every place that invalidates
    // the generation (`cancelTimelineLiveFollowForUserNavigation`) also clears
    // `settledTimelineAnchorRef` in the same breath, so the two conditions this
    // function guards on - settled for `messageId`, AND generation mismatched -
    // never hold at once today. This is treated as settled machinery rather
    // than a ticket-4 regression. (chat-messages.test.tsx pins the reachable
    // half: the early-return above during active anchoring/following.)
    if (
      liveFollowUserScrollGenerationRef.current ===
      anchorUserScrollGenerationRef.current
    ) {
      return;
    }
    const scrollOffset = chatTimelineRef.current?.getState().scroll;
    if (scrollOffset === undefined) return;
    if (pendingAnchorScrollRestoreRef.current === null) {
      pendingAnchorScrollRestoreRef.current = {
        offset: scrollOffset,
        userScrollGeneration: anchorUserScrollGenerationRef.current,
      };
    }
    if (anchorScrollRestoreFrameRef.current !== null) return;
    anchorScrollRestoreFrameRef.current = requestAnimationFrame(() => {
      anchorScrollRestoreFrameRef.current = null;
      const pending = pendingAnchorScrollRestoreRef.current;
      pendingAnchorScrollRestoreRef.current = null;
      if (
        pending !== null &&
        settledTimelineAnchorRef.current === messageId &&
        pending.userScrollGeneration === anchorUserScrollGenerationRef.current
      ) {
        const list = chatTimelineRef.current;
        const currentScrollOffset = list?.getState().scroll;
        if (
          typeof currentScrollOffset === "number" &&
          Math.abs(currentScrollOffset - pending.offset) <= 2
        ) {
          void list?.scrollToOffset({
            offset: pending.offset,
            animated: false,
          });
        }
      }
    });
  }, []);

  const onIsAtEndChange = useCallback(
    (isAtEnd: boolean): void => {
      // Ticket 11: unconditional reader-position mirror - ahead of every
      // filter below, since those filters exist to gate MODE decisions, not
      // "where does the reader physically appear to be right now". Uses the
      // STRICT `isAtEnd` flag (LegendList's own small-epsilon "truly at the
      // bottom" computation), NOT the lenient `isAtEnd` parameter this
      // callback receives (that one prefers `isNearEnd`, the 10% decision-#5
      // threshold that restores follow - too generous for "did the reader
      // reach the LIVE edge", ticket 11's own wording for fix #2/#3).
      const strictAtLiveEdge =
        chatTimelineRef.current?.getState().isAtEnd ?? isAtEnd;
      setIsReaderAtLiveEdge(strictAtLiveEdge);

      if (
        !isAtEnd &&
        liveFollowUserScrollGenerationRef.current ===
          anchorUserScrollGenerationRef.current
      ) {
        // Transient isAtEnd=false while WE own the scroll (mid-flight
        // animated scrollToIndex, initialScrollAtEnd settling): not a gesture.
        cancelPillShow();
        setShowScrollToBottom(false);
        return;
      }
      if (suppressFollowRestoreRef.current) {
        // A programmatic scroll operation that intentionally stays
        // free-scrolling/non-following (a free-scrolling suffix removal
        // landing near the new tail, or a find/minimap/deep-link navigation
        // to a near-tail target - decision #14, #21). Keep isAtEndRef
        // tracking the real physical position, but no report from this
        // operation - false, true, or a duplicate/correction - may flip mode
        // to following-end. Cleared only by the next real gesture cancel or
        // an explicit setTimelineMode("following-end").
        isAtEndRef.current = isAtEnd;
        // Ticket 11 fix #3: the no-follow contract stays intact (mode is
        // untouched above) but the pill's OWN bookkeeping was never wired
        // here - hide it once a real scroll lands the reader at the ACTUAL
        // (strict) live edge; show it (debounced, same as the ordinary
        // free-scrolling path) while they're away from it. Strict, not the
        // lenient `isAtEnd` param - the 10% isNearEnd band is generous enough
        // that "still visibly approaching the tail" would otherwise register
        // as "arrived" and hide the pill prematurely. Decision #16's "out of
        // view" semantic governs pill visibility independently of the mode
        // machine's follow-restore suppression.
        if (strictAtLiveEdge) {
          cancelPillShow();
          setShowScrollToBottom(false);
        } else {
          maybeShowPillDebounced();
        }
        return;
      }
      if (justFrozeProgrammaticScrollRef.current) {
        // Consumed regardless of value: the ONE report that may still be a
        // stale echo of the just-interrupted native animation (see
        // cancelTimelineLiveFollowForUserNavigation). Bookkeeping only -
        // never flips mode - so a genuinely real gesture immediately after a
        // freeze is never blocked, only this single potentially-stale report.
        justFrozeProgrammaticScrollRef.current = false;
        isAtEndRef.current = isAtEnd;
        return;
      }
      // Ticket 11 fix #1: mode reconciliation BEFORE the equality fast-path
      // below. A scroll-only route (native OS scrollbar drag; no
      // wheel/touchmove/pointerdown ever fires) reaching the true end of an
      // OVERFLOWED anchored turn must still reconcile mode even though
      // `isAtEndRef` was pre-seeded `true` at `beginAnchoringNewTurn` and
      // every intermediate `false` report along the way was swallowed by the
      // "owned, not a gesture" filter above (`liveFollowUserScrollGenerationRef`
      // stays matched for the WHOLE anchoring session, not just the initial
      // positioning) - so the terminal `true` report would otherwise hit the
      // stale-true equality fast-path and never reconcile (root-cause: field
      // bug 3, at-bottom streaming does not auto-follow). Gated on the
      // overflow flag (never written here - see its own doc comment, it
      // gates the reveal pass's stop-at-overflow) so a fitting anchor's
      // still-closing reserve near-end is never misread as "arrived".
      if (
        isAtEnd &&
        timelineScrollModeRef.current === "anchoring-new-turn" &&
        anchoredTurnOverflowsViewportRef.current
      ) {
        const list = chatTimelineRef.current;
        const metrics = list ? getActiveTimelineTurnMetrics(list) : null;
        if (
          metrics !== null &&
          metrics.scrollDeltaToRevealEnd <= CHAT_TIMELINE_LIVE_EDGE_EPSILON_PX
        ) {
          isAtEndRef.current = isAtEnd;
          setTimelineMode("following-end");
          return;
        }
      }
      if (isAtEndRef.current === isAtEnd) return;
      isAtEndRef.current = isAtEnd;
      if (isAtEnd) {
        setTimelineMode("following-end");
      } else {
        timelineScrollModeRef.current = "free-scrolling";
        liveFollowUserScrollGenerationRef.current = null;
        setIsFollowingEnd(false);
        setIsAnchoringNewTurn(false);
        maybeShowPillDebounced();
      }
    },
    [
      cancelPillShow,
      getActiveTimelineTurnMetrics,
      maybeShowPillDebounced,
      setTimelineMode,
    ],
  );

  // Streaming reveal + following-end catch-up: two-rAF pass per data change,
  // gated on the live-follow generation so free-scrolling never moves.
  useLayoutEffect(() => {
    const generationOwned =
      liveFollowUserScrollGenerationRef.current ===
      anchorUserScrollGenerationRef.current;
    if (!generationOwned) {
      // Ticket 11 fix #3: a suppressed programmatic nav that landed at/near
      // the tail (decision #14/#21 - stays free-scrolling, never restores
      // follow via position) fires no scroll event of its own when LATER
      // streaming growth pushes content back off-screen - nothing moves the
      // scroll, so no native `scroll` event exists to drive
      // `onIsAtEndChange`. This per-`messages`-change effect is the only
      // EXISTING hook that already reacts to content growth without a real
      // scroll; piggyback on it purely for pill bookkeeping (no scroll
      // mutation here - the no-follow contract is untouched).
      if (!suppressFollowRestoreRef.current) return;
      return scheduleChatTimelineDoubleRaf(() => {
        if (!suppressFollowRestoreRef.current) return;
        const list = chatTimelineRef.current;
        if (!list) return;
        // Strict `isAtEnd`, not `resolveChatTimelineIsAtEnd`'s lenient
        // isNearEnd preference - same reasoning as the `onIsAtEndChange`
        // suppressed branch this mirrors (ticket 11 fix #3's "actual live
        // edge" wording).
        const isAtEnd = list.getState().isAtEnd;
        setIsReaderAtLiveEdge(isAtEnd);
        if (isAtEnd) {
          cancelPillShow();
          setShowScrollToBottom(false);
        } else {
          maybeShowPillDebounced();
        }
      });
    }
    let secondFrame: number | null = null;
    const frame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (
          liveFollowUserScrollGenerationRef.current !==
          anchorUserScrollGenerationRef.current
        ) {
          return;
        }
        if (pendingTimelineAnchorRef.current !== null) return;
        if (
          positionedTimelineAnchorRef.current !== null &&
          settledTimelineAnchorRef.current !==
            positionedTimelineAnchorRef.current
        ) {
          return;
        }
        const list = chatTimelineRef.current;
        if (!list) return;

        if (timelineScrollModeRef.current === "anchoring-new-turn") {
          const metrics = getActiveTimelineTurnMetrics(list);
          if (!metrics) return;
          // Decision #16: the pill only matters once the anchored turn's
          // real content extends past the usable viewport - gate its
          // visibility on the same measurement the reveal scroll below uses.
          anchoredTurnOverflowsViewportRef.current =
            metrics.overflowsUsableViewport;
          setAnchoredTurnOverflowsViewport(metrics.overflowsUsableViewport);
          // Deliberate live-E2E merge-blocker fix: revealing the minimum delta
          // toward the real end for the WHOLE turn would create genuine
          // bottom-follow-while-streaming. Decision #1 drops that default;
          // decision #10 requires completion below the fold to stay anchored
          // with no auto-reveal; decision #16's "streaming" pill state exists
          // specifically for content that has accumulated below the fold. So
          // once the anchored turn's real content overflows the usable
          // viewport, this pass must STOP moving the scroll position - the
          // anchor row stays at its offset for the rest of the turn, and the
          // pill (now showing "streaming") is the sole affordance for what
          // follows.
          // Before this point (content still fits), continuing to reveal is
          // correct - it's what lets the anchored row's own reply fill the
          // space below it as it streams in.
          if (metrics.overflowsUsableViewport) return;
          // Decision #12: content ABOVE the anchor - a prior turn's
          // completion metadata/disclosure landing after THIS turn's anchor
          // already settled - can grow between settle and this pass,
          // pushing the anchor row down from its offset with nothing else
          // to correct it (`maintainVisibleContentPosition` is size:false,
          // so LegendList itself never compensates). Re-assert the anchor's
          // own position first - the reveal-delta check below only accounts
          // for growth BELOW the anchor, not a shift of the anchor's own
          // position.
          // `positionAtIndex` is content-relative and excludes LegendList's
          // top pad (header/style padding/align-at-end - `topOffsetAdjustment`,
          // decision #18); DOM `scroll` includes it. Fold it in the same way
          // `captureChatFreeScrollingOffset`/`getViewportAnchorListState`
          // already do, or this drift check itself introduces a false
          // "correction" equal to that pad on every fitting turn. Compare
          // against the scroll node's OWN `scrollTop`, not
          // `list.getState().scroll` - the same staleness the settle
          // callback above already guards against: a content-above change
          // can update LegendList's internal tracked position ahead of (or
          // independent of) the real DOM value actually moving.
          const currentScrollTop = list.getScrollableNode().scrollTop;
          const anchorOffsetFromTop =
            metrics.anchorTop +
            listTopOffsetAdjustmentRef.current -
            currentScrollTop;
          const anchorPositionDrift =
            anchorOffsetFromTop - anchorOffsetRef.current;
          if (Math.abs(anchorPositionDrift) > 1) {
            void list.scrollToOffset({
              offset: currentScrollTop + anchorPositionDrift,
              animated: false,
            });
            return;
          }
          if (metrics.scrollDeltaToRevealEnd <= 1) return;
          const nextOffset =
            list.getState().scroll + metrics.scrollDeltaToRevealEnd;
          void list.scrollToOffset({ offset: nextOffset, animated: false });
          return;
        }

        if (timelineScrollModeRef.current !== "following-end") return;
        if (!timelineRealContentOverflowsViewport(list)) return;
        void list.scrollToEnd({ animated: false });
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      if (secondFrame !== null) cancelAnimationFrame(secondFrame);
    };
  }, [
    messages,
    getActiveTimelineTurnMetrics,
    timelineRealContentOverflowsViewport,
    cancelPillShow,
    maybeShowPillDebounced,
  ]);

  // --- Keyboard scrolling (existing window-level claiming survives) ---------

  const handleKeyDownCapture = useCallback(
    (event: globalThis.KeyboardEvent): void => {
      const scroller = chatTimelineRef.current?.getScrollableNode();
      if (!scroller) return;
      const scrollAction = chatKeyboardScrollAction(event);
      if (scrollAction === null) return;
      event.preventDefault();
      event.stopPropagation();
      // Decision #7: both directions feed the same manual-navigation cancel.
      // Keyboard scrolling steps the scroller itself right below - a plain
      // release, no freeze needed (that step's own movement takes over
      // immediately).
      cancelTimelineLiveFollowForUserNavigation(false);
      applyChatKeyboardScroll(scroller, scrollAction);
    },
    [cancelTimelineLiveFollowForUserNavigation],
  );

  useLayoutEffect(() => {
    const tile = transcriptContainerRef.current?.closest(
      "[data-chat-keyboard-scroll-scope]",
    );
    if (!(tile instanceof HTMLElement)) return;
    const handleWindowKeyDown = (event: globalThis.KeyboardEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (tile.contains(target)) {
        handleKeyDownCapture(event);
        return;
      }
      if (tile.dataset.active !== "true") return;
      if (!target.contains(tile) && !sharesCanvasPane(tile, target)) return;
      handleKeyDownCapture(event);
    };
    window.addEventListener("keydown", handleWindowKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleWindowKeyDown, {
        capture: true,
      });
    };
  }, [handleKeyDownCapture]);

  // --- Bookkeeping refs kept fresh post-render -------------------------------

  useLayoutEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useLayoutEffect(() => {
    messageIndexByIdRef.current = buildMessageIdToIndex(messages);
  }, [messages]);

  useLayoutEffect(() => {
    scrollRequestRef.current = scrollRequest;
  }, [scrollRequest]);

  const backgroundToolBlockIds = useMemo<ReadonlySet<string>>(() => {
    if (backgroundItems === undefined || backgroundItems.length === 0) {
      return EMPTY_BACKGROUND_TOOL_BLOCK_IDS;
    }
    return new Set(
      backgroundItems
        .filter((item) => item.kind !== "subagent")
        .map((item) => item.blockId),
    );
  }, [backgroundItems]);

  useLayoutEffect(() => {
    backgroundToolBlockIdsRef.current = backgroundToolBlockIds;
  }, [backgroundToolBlockIds]);

  // Ticket 5: tool/subagent open state now survives a chat tile's remount
  // (module-scope stores scoped by `instanceId` - see `tool-open-store.ts` /
  // `subagent-open-store.ts`), so mount no longer resets it. A permanently
  // closed tab's entries are reclaimed by the canvas store's tile-removal
  // subscriber (`stores/epics/canvas/store.ts`) instead.

  // Persist the reading position on unmount (chat tiles fully remount per tab
  // switch - decision #17 - so this is the sole persistence path; the
  // display:none keep-alive `useScrollRestoration` machinery other tile kinds
  // use does not apply here and is intentionally not wired in).
  //
  // Liveness-guarded (ticket 5): a permanent tab close removes the tile from
  // the canvas FIRST, synchronously - which fires the canvas store's
  // tile-removal subscriber that evicts this same key - before this unmount
  // cleanup runs. Saving unconditionally would resurrect the entry that
  // sweep just cleared; mirrors `use-scroll-restoration.ts`'s
  // `commitIfTileLive` guard.
  useLayoutEffect(
    () => () => {
      if (!isEpicCanvasTileInstanceLive(instanceId)) return;
      // `anchoring-new-turn` never persists as its own mode (see
      // `chat-tab-state-cache.ts`): a remount mid-anchor has no live
      // anchor/settle sequence left to resume, so it collapses to
      // `free-scrolling` at wherever it had settled - same as any other
      // unpinned reading position.
      const wasAnchoring =
        timelineScrollModeRef.current === "anchoring-new-turn";
      const mode: ChatTabScrollMode =
        timelineScrollModeRef.current === "following-end"
          ? "following-end"
          : "free-scrolling";
      const anchorMessageId =
        mode === "free-scrolling"
          ? scrolledActiveUserMessageIdRef.current
          : null;
      const anchorIndex =
        anchorMessageId === null
          ? undefined
          : messageIndexByIdRef.current.get(anchorMessageId);
      const list = chatTimelineRef.current;
      // F3: while still anchoring, `anchoredEndSpace` reserves trailing blank
      // space below the anchor for a still-streaming reply - the live
      // `scroll` may only be reachable because of that reserve. Clamp the
      // captured offset to LegendList's true no-reserve max scroll (header +
      // footer + last-row bottom + endInset - viewport) so the saved position
      // stays valid once restored without the reserve. Do NOT use
      // `targetScrollToRevealEnd` here - that is the reveal-pass target and
      // under-clamps by header+footer-anchorOffset.
      let naturalMaxScroll: number | null = null;
      if (wasAnchoring && list !== null) {
        const listState = list.getState();
        const lastBottom = getChatRowBottom(
          listState,
          listState.data.length - 1,
        );
        if (lastBottom !== null) {
          naturalMaxScroll = getChatNaturalMaxScrollWithoutAnchorReserve({
            headerSize: listTopOffsetAdjustmentRef.current,
            footerSize: listFooterSizeRef.current,
            lastBottom,
            endInset,
            viewportLength: listState.scrollLength,
          });
        }
      }
      // Narrow measurement source so capture can fold in the live header pad
      // (list.getState() does not expose headerSize; metrics keep it current).
      const measurementSource =
        list === null
          ? null
          : {
              getState: () => ({
                positionAtIndex: (index: number) =>
                  list.getState().positionAtIndex(index),
                scroll: list.getState().scroll,
                topOffsetAdjustment: listTopOffsetAdjustmentRef.current,
              }),
            };
      saveChatTabState({
        key: scrollStateKey,
        mode,
        anchorMessageId,
        offset: captureChatFreeScrollingOffset(
          measurementSource,
          anchorIndex,
          naturalMaxScroll,
        ),
      });
    },
    [scrollStateKey, instanceId, endInset],
  );

  const onListMetricsChange = useCallback(
    (metrics: {
      readonly headerSize: number;
      readonly footerSize: number;
    }): void => {
      // Chat timeline does not set stylePaddingTop / alignItemsAtEndPadding, so
      // headerSize alone is the getTopOffsetAdjustment pad that restore re-adds.
      listTopOffsetAdjustmentRef.current = metrics.headerSize;
      // Footer joins header in F3's no-reserve max-scroll bound.
      listFooterSizeRef.current = metrics.footerSize;
    },
    [],
  );

  // Quote-to-composer: track selections inside the transcript wrapper below and
  // surface the floating quote button. The hook attaches no listeners while the
  // setting is off, so a disabled affordance costs nothing.
  const quoteReplyEnabled = useSettingsStore(
    (state) => state.quoteReplyEnabled,
  );
  const quoteSelection = useQuoteSelection({
    containerRef: transcriptContainerRef,
    enabled: quoteReplyEnabled && visible && !systemOverlayActive,
  });

  // Ticket 5: registry-backed, keyed by tile instance id, so expanded
  // activity groups survive the chat tile's full remount on tab switch
  // (decision #17) - evicted only when the tab permanently closes (canvas
  // store's tile-removal subscriber), never on a mere remount.
  const [activityGroupOpenStore] = useState(() =>
    getOrCreateActivityGroupOpenStore(instanceId),
  );

  // Recompute the ticket-5 free-scrolling save anchor (nearest human user
  // message to the reading line) from LegendList's own measured positions -
  // no DOM rect probing - coalesced to one read per frame.
  const scheduleActiveViewportUpdate = useAnimationFrameThrottle(
    useCallback(
      (atBottom: boolean): void => {
        if (atBottom) {
          // P4: same zero-human-row fallback as `viewportActiveUserMessageId`
          // (see its own doc comment) - an A2A-only transcript has no
          // candidate for the human-only gate, so at the tail the natural
          // role-agnostic anchor is simply the last row, any role.
          setScrolledActiveUserMessageIdIfChanged(
            selectActiveUserMessageId(messages, null, true) ??
              messages.at(-1)?.id ??
              null,
          );
          return;
        }
        const rawState = chatTimelineRef.current?.getState();
        if (rawState === undefined) return;
        // list.getState() does not expose headerSize/topOffsetAdjustment -
        // fold in the live measured value (decision #18), same as the
        // ticket-5 save path's measurementSource below.
        const state = {
          ...rawState,
          topOffsetAdjustment: listTopOffsetAdjustmentRef.current,
        };
        const nextActiveUserMessageId = viewportActiveUserMessageId(
          state,
          messages,
        );
        if (nextActiveUserMessageId === null) return;
        setScrolledActiveUserMessageIdIfChanged(nextActiveUserMessageId);
      },
      [messages, setScrolledActiveUserMessageIdIfChanged],
    ),
  );

  const handleScroll = useCallback((): void => {
    if (!visible) return;
    scheduleActiveViewportUpdate(
      timelineScrollModeRef.current === "following-end",
    );
  }, [scheduleActiveViewportUpdate, visible]);

  const getScroller = useCallback(
    (): HTMLElement | null =>
      chatTimelineRef.current?.getScrollableNode() ?? null,
    [],
  );

  const getViewportAnchorListState =
    useCallback((): ChatViewportAnchorListState | null => {
      const state = chatTimelineRef.current?.getState();
      if (state === undefined) return null;
      // list.getState() does not expose headerSize/topOffsetAdjustment - fold
      // in the live measured value (decision #18), same as scheduleActiveViewportUpdate.
      return {
        ...state,
        topOffsetAdjustment: listTopOffsetAdjustmentRef.current,
      };
    }, []);

  const scrollToTimelineLocation = useCallback(
    (location: ChatTimelineNavigationLocation): void => {
      void chatTimelineRef.current?.scrollToIndex({
        index: location.index,
        animated: location.animated,
        viewPosition: 0,
        viewOffset: location.viewOffset,
      });
    },
    [],
  );

  // Decision #21: find/minimap/deep-link navigation is programmatic, not a
  // gesture - a near-tail target landing in the near-end band must not
  // silently re-enable follow (H3). Suppresses the same way the
  // edge-mutation classifier's scroll-to-index does.
  //
  // Ticket 10: settle/re-issue against the CURRENT geometry - same
  // root-cause class as `scrollToEnd` (an ANIMATED long jump targets
  // ESTIMATED heights; no mid-flight retargeting in the installed
  // LegendList). No mode reconciliation on exhaustion here (unlike
  // `scrollToEnd`) - this path never claims to be "following"; it accepts
  // wherever the bounded retries land, still correctly free-scrolling.
  const scrollToTimelineLocationSuppressingFollowRestore = useCallback(
    (location: ChatTimelineNavigationLocation): void => {
      suppressFollowRestoreRef.current = true;
      const generationAtIssue = anchorUserScrollGenerationRef.current;
      // H1 fix: already covered by suppression's own freeze condition, but
      // set uniformly for every animated imperative scroll (same pattern as
      // `scrollToEnd`) - see `activeAnimatedImperativeScrollOperationIdRef`'s
      // doc. Round-2: operation id, not a boolean.
      const animatedScrollOperationId = location.animated
        ? ++animatedImperativeScrollOperationCounterRef.current
        : null;
      if (animatedScrollOperationId !== null) {
        activeAnimatedImperativeScrollOperationIdRef.current =
          animatedScrollOperationId;
      }
      scrollToTimelineLocation(location);
      const list = chatTimelineRef.current;
      if (!list) return;
      const scrollNode = list.getScrollableNode();
      settleChatTimelineNavigation({
        scrollNode,
        isAborted: () =>
          anchorUserScrollGenerationRef.current !== generationAtIssue ||
          !suppressFollowRestoreRef.current,
        validate: () =>
          chatTimelineNavigationLandedAtLocation(
            {
              positionAtIndex: (index) =>
                list.getState().positionAtIndex(index),
              scroll: scrollNode.scrollTop,
              topOffsetAdjustment: listTopOffsetAdjustmentRef.current,
            },
            location,
            CHAT_TIMELINE_NAVIGATION_LANDING_EPSILON_PX,
          ),
        reissue: () => {
          void list.scrollToIndex({
            index: location.index,
            animated: false,
            viewPosition: 0,
            viewOffset: location.viewOffset,
          });
        },
        onSettledInvalid: () => {
          // Accept - already correctly free-scrolling/suppressed wherever
          // the bounded retries landed; nothing claims to be "at this exact
          // spot" the way following-end does, so there is no mode to
          // reconcile.
        },
        onFirstSettle: () => {
          if (
            animatedScrollOperationId !== null &&
            activeAnimatedImperativeScrollOperationIdRef.current ===
              animatedScrollOperationId
          ) {
            activeAnimatedImperativeScrollOperationIdRef.current = null;
          }
        },
        maxRetries: CHAT_TIMELINE_NAVIGATION_MAX_RETRIES,
      });
    },
    [scrollToTimelineLocation],
  );

  const navigateToMessage = useCallback(
    (messageId: string, highlight: boolean): void => {
      // Decision #21: minimap/find/deep-link navigation all perform
      // manual-navigation cancellation first. Not a real gesture - a plain
      // release, no freeze: the navigation's own scroll (right below, via
      // scrollToTimelineLocationSuppressingFollowRestore) takes over
      // immediately regardless.
      cancelTimelineLiveFollowForUserNavigation(false);
      setScrolledActiveUserMessageIdIfChanged(messageId);
      const location = chatTimelineLocationForMessage(
        messageId,
        messageIndexByIdRef.current,
        true,
      );
      if (location === null) return;
      if (highlight) {
        showNavigationHighlight(messageId);
      }
      scrollToTimelineLocationSuppressingFollowRestore(location);
    },
    [
      cancelTimelineLiveFollowForUserNavigation,
      scrollToTimelineLocationSuppressingFollowRestore,
      setScrolledActiveUserMessageIdIfChanged,
      showNavigationHighlight,
    ],
  );

  const onMinimapItemSelect = useCallback(
    (messageId: string): void => navigateToMessage(messageId, false),
    [navigateToMessage],
  );

  // Find navigation is not a real gesture (like navigateToMessage) - a plain
  // release, no freeze.
  const cancelManualNavigationForFind = useCallback((): void => {
    cancelTimelineLiveFollowForUserNavigation(false);
  }, [cancelTimelineLiveFollowForUserNavigation]);

  // --- Disclosure preservation (replaces ChatMeasuredItemChangeContext's old
  //     scroll-modifier-based approach with a flushSync + geometric delta) -
  // Hoisted above useChatFindController: find's reveal-open (invoked from a
  // real find-navigation event handler, a safe context for flushSync) routes
  // its chain-open through this same helper. The scroll-request deep-link
  // effect below does NOT - it always runs from a layout effect, where
  // flushSync degrades to a warned no-op (see its own comment).

  const requestMeasuredItemChange = useCallback(
    (anchorElement: HTMLElement | null, mutate: () => void): void => {
      preserveChatScrollAcrossDisclosureChange({
        list: chatTimelineRef.current,
        anchorElement,
        mutate,
        // M2: MVCP owns the correction only in free-scrolling - the one mode
        // `sizePreservationEnabled` turns `size:true` (see its own doc
        // comment) - read from the ref (not a render-time boolean) since
        // this callback fires imperatively from disclosure-toggle handlers,
        // not during render.
        correctionOwnedByMvcp:
          timelineScrollModeRef.current === "free-scrolling",
      });
    },
    [],
  );

  const { onRenderedDataChange: onChatFindRenderedDataChange } =
    useChatFindController({
      instanceId,
      messages,
      messagesRef,
      messageIndexByIdRef,
      getScroller,
      getViewportAnchorListState,
      scrollToLocation: scrollToTimelineLocationSuppressingFollowRestore,
      cancelManualNavigation: cancelManualNavigationForFind,
      setScrolledActiveUserMessageIdIfChanged,
      requestMeasuredItemChange,
    });

  // --- Edge-mutation transitions (decision #14) ------------------------------
  //
  // Runs in a layout effect (not render-phase) since its outcomes are
  // imperative ref-method calls. Anchor-triggering events (composer send,
  // steer/inline edit, queued auto-flush, A2A rows - decisions #8/#9) resolve
  // to `anchor-new-turn` here and hand off to `beginAnchoringNewTurn`, which
  // owns its own mode transition (see the outcome type's own doc comment).
  useLayoutEffect(() => {
    const previousMessages = previousMessagesForEdgeMutationRef.current;
    previousMessagesForEdgeMutationRef.current = messages;
    const outcome = classifyChatEdgeMutation({
      previousMessages,
      nextMessages: messages,
      isFollowingEnd: timelineScrollModeRef.current === "following-end",
      hadSavedScrollState,
      localProvenanceMessageIds,
    });
    if (outcome.nextMode !== null) {
      setTimelineMode(outcome.nextMode);
    }
    switch (outcome.action.kind) {
      case "scroll-to-end":
        void chatTimelineRef.current?.scrollToEnd({ animated: false });
        break;
      case "scroll-to-index":
        if (outcome.nextMode === null) {
          // Staying free-scrolling (a suffix removal's remaining-tail
          // anchor, decision #14): the anchor row can land in the near-end
          // band by coincidence. Suppress so no report it produces is
          // misread as a gesture re-enabling follow.
          suppressFollowRestoreRef.current = true;
        }
        void chatTimelineRef.current?.scrollToIndex({
          index: outcome.action.index,
          animated: false,
          viewPosition: 0,
          viewOffset: 0,
        });
        break;
      case "anchor-new-turn":
        beginAnchoringNewTurn(
          outcome.action.messageId,
          outcome.action.animated,
        );
        // A no-op if `messageId` was never a local-provenance match (a
        // gated queued-flush/A2A row that anchored because the reader was
        // already following-end) - `consumeLocalProvenance` guards on
        // membership itself.
        consumeLocalProvenance(outcome.action.messageId);
        break;
      case "none":
        break;
    }
    scheduleActiveViewportUpdate(
      timelineScrollModeRef.current === "following-end",
    );
    onChatFindRenderedDataChange();
  }, [
    messages,
    setTimelineMode,
    beginAnchoringNewTurn,
    hadSavedScrollState,
    localProvenanceMessageIds,
    consumeLocalProvenance,
    scheduleActiveViewportUpdate,
    onChatFindRenderedDataChange,
  ]);

  useLayoutEffect(() => {
    const request = scrollRequestRef.current;
    if (request === null) return;
    if (handledScrollRequestIdRef.current === request.requestId) return;
    handledScrollRequestIdRef.current = request.requestId;
    const activityGroupId =
      request.blockId === null
        ? null
        : activityGroupIdForBlock(
            messagesRef.current,
            request.messageId,
            request.blockId,
            backgroundToolBlockIdsRef.current,
          );
    if (activityGroupId !== null) {
      // NOT routed through requestMeasuredItemChange: this effect always
      // runs from a layout effect, and flushSync is a documented no-op (with
      // a console warning - "React cannot flush when React is already
      // rendering") when called from inside React's own commit/effect pass,
      // since it cannot re-enter a synchronous work loop. The store update
      // still applies (React schedules and commits it before paint, same as
      // any layout-effect-triggered update) - it just isn't guaranteed
      // synchronous by the time navigateToMessage runs right below, so its
      // scrollToIndex can race a still-collapsed measurement on the first
      // frame. Same tradeoff this call already had before ticket 6; wrapping
      // it added a warning without actually closing the race.
      activityGroupOpenStore.getState().setOpen(activityGroupId, true);
    }
    // Cross-tile jumps use the same programmatic-navigation choke point as
    // every in-tile navigation: suppression, settle validation, and bounded
    // re-issue are all armed before the scroll. The highlight is visual only.
    navigateToMessage(request.messageId, true);
    scrollRequestRef.current = null;
  }, [activityGroupOpenStore, navigateToMessage, scrollRequest?.requestId]);

  // --- Accessibility (decision #24): polite turn-completion announcement ----

  const [turnCompletionAnnouncement, setTurnCompletionAnnouncement] =
    useState("");
  const lastAssistantCompletionRef = useRef<{
    readonly id: string;
    readonly completedAt: number | null;
  } | null>(null);
  useLayoutEffect(() => {
    const lastAssistant = messages
      .filter((message) => message.role === "assistant")
      .at(-1);
    if (lastAssistant === undefined) {
      lastAssistantCompletionRef.current = null;
      return;
    }
    const previous = lastAssistantCompletionRef.current;
    lastAssistantCompletionRef.current = {
      id: lastAssistant.id,
      completedAt: lastAssistant.completedAt,
    };
    if (
      previous !== null &&
      previous.id === lastAssistant.id &&
      previous.completedAt === null &&
      lastAssistant.completedAt !== null &&
      !lastAssistant.stopped
    ) {
      setTurnCompletionAnnouncement(`${taskTitle} finished responding.`);
      // Decision #10/#16: turn completion below the fold stays anchored - no
      // auto-reveal. The pill flips to "New reply" instead, unless the
      // reader is already at the tail (nothing to signal).
      if (timelineScrollModeRef.current !== "following-end") {
        setHasUnseenTurnCompletion(true);
      }
    }
  }, [messages, taskTitle]);

  // --- Stateful scroll-to-end pill (decision #16) ----------------------------

  const lastAssistantMessage = messages
    .filter((message) => message.role === "assistant")
    .at(-1);
  const turnRunning =
    lastAssistantMessage !== undefined &&
    lastAssistantMessage.completedAt === null;
  const contextWorkingVerb = use(WorkingVerbContext);
  const workingVerb =
    contextWorkingVerb ?? pickWorkingVerb(timelineAnchorMessageId ?? taskId);
  const scrollToEndPillState = resolveScrollToEndPillState({
    // Ticket 11 fix #2: anchoring-mode visibility now also consults reader
    // position - `anchoredTurnOverflowsViewport` alone is pure turn geometry
    // and stays true for the rest of the turn even after the reader has
    // scrolled themselves to the actual live edge via a scroll-only route
    // (root-cause: field bug 4). `anchoredTurnOverflowsViewport` itself is
    // untouched - it still gates the reveal pass's stop-at-overflow.
    visible: isAnchoringNewTurn
      ? anchoredTurnOverflowsViewport && !isReaderAtLiveEdge
      : showScrollToBottom,
    turnRunning,
    unseenCompletion: hasUnseenTurnCompletion,
    workingVerb,
  });

  // Ticket 12: the third mode, purely derived - no new state. Gates
  // `sizePreservationEnabled` below (reading stability while free-scrolling;
  // `following-end`/`anchoring-new-turn` each already own their own
  // correction path and must not double it with MVCP's).
  const isFreeScrolling = !isFollowingEnd && !isAnchoringNewTurn;

  return (
    <ChatOpenStoreScopeProvider value={instanceId}>
      <ActivityGroupOpenStoreProvider store={activityGroupOpenStore}>
        <ChatMeasuredItemChangeContext.Provider
          value={requestMeasuredItemChange}
        >
          <div
            ref={transcriptContainerRef}
            data-testid="chat-transcript-container"
            className="relative flex-1 overflow-hidden"
            style={
              {
                "--chat-bottom-overlay-inset": `${endInset}px`,
              } as CSSProperties
            }
          >
            <ChatTimeline
              messages={messages}
              taskTitle={taskTitle}
              backgroundToolBlockIds={backgroundToolBlockIds}
              getMessageActions={getMessageActions}
              nextStepActions={nextStepActions}
              listRef={chatTimelineRef}
              onScroll={handleScroll}
              topFadeEnabled
              initialScrollAtEnd={initialModeSeed.isFollowingEnd}
              initialScrollIndex={initialScrollIndexAnchor}
              anchorMessageId={timelineAnchorMessageId}
              anchorOffset={anchorOffset}
              onAnchorReady={onTimelineAnchorReady}
              onAnchorSizeChanged={onTimelineAnchorSizeChanged}
              contentInsetEndAdjustment={endInset}
              onIsAtEndChange={onIsAtEndChange}
              followEnabled={isFollowingEnd}
              sizePreservationEnabled={isFreeScrolling}
              navigationHighlightedMessageId={navigationHighlightedMessageId}
              onListMetricsChange={onListMetricsChange}
              data-testid="chat-messages-scroll"
              data-scroll-mode={chatScrollModeDataAttribute(
                isAnchoringNewTurn,
                isFollowingEnd,
              )}
            />
            {hasContent ? (
              <ChatTurnMinimap
                messages={messages}
                listRef={chatTimelineRef}
                topOffsetAdjustmentRef={listTopOffsetAdjustmentRef}
                viewportRef={transcriptContainerRef}
                bottomInset={endInset}
                onSelect={onMinimapItemSelect}
              />
            ) : null}
            {hasContent ? (
              <ScrollToEndPill
                state={scrollToEndPillState}
                onClick={() => scrollToEnd(true)}
                bottomOffsetPx={endInset + 4}
              />
            ) : null}
            {quoteSelection.snapshot !== null ? (
              <QuoteSelectionPopover
                taskId={taskId}
                snapshot={quoteSelection.snapshot}
                onDismiss={quoteSelection.dismiss}
                boundaryRef={transcriptContainerRef}
                bottomOverlayInsetPx={endInset}
              />
            ) : null}
          </div>
          <div aria-live="polite" className="sr-only">
            {turnCompletionAnnouncement}
          </div>
        </ChatMeasuredItemChangeContext.Provider>
      </ActivityGroupOpenStoreProvider>
    </ChatOpenStoreScopeProvider>
  );
}
