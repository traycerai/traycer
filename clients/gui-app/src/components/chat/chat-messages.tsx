import { useCoarsePointer } from "@/hooks/ui/use-coarse-pointer";
import { CustomizeDropSlot } from "@/components/customize/customize-drop-slot";
import { QuoteSelectionPopover } from "@/components/chat/quote/quote-selection-popover";
import { useQuoteSelection } from "@/components/chat/quote/use-quote-selection";
import { useChatFindController } from "@/components/chat/use-chat-find-controller";
import { type ChatMessageActions } from "@/components/chat/chat-message";
import {
  ChatTimeline,
  type ChatTimelineInitialScrollAnchor,
} from "@/components/chat/chat-timeline";
import type {
  ChatTimelineFollowLatch,
  ChatTimelineReaderGestureIntent,
} from "@/components/chat/chat-timeline-follow-latch";
import {
  acceptExhaustedPersistedRestoreFallback,
  buildRowKeyToIndex,
  CHAT_ARROW_SCROLL_STEP_PX,
  CHAT_TIMELINE_NAVIGATION_VIEW_OFFSET_PX,
  chatTimelineLocationForMessage,
  chatTimelineNavigationLandedAtLocation,
  selectActiveUserMessageId,
  viewportAnchorRowKey,
  viewportActiveUserMessageId,
  type ChatTimelineNavigationLocation,
} from "@/components/chat/chat-messages-scroll-helpers";
import {
  isUnplacedRowKey,
  transcriptListRows,
  visibleOrdinalRange,
  type TranscriptListRow,
} from "@/stores/chats/transcript-list-rows";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import {
  createChatTranscriptRowHeightMemory,
  type ChatTranscriptRowHeightMemory,
} from "@/components/chat/chat-transcript-row-height-memory";
import { unhydratedRowCount } from "@/stores/chats/transcript-window";
import { chatFindCoverageMessage } from "@/components/chat/chat-find";
import {
  CHAT_NAVIGATION_HIGHLIGHT_DURATION_MS,
  resolvedScrollBlockId,
  useChatNavigationBlockReveal,
  type ChatNavigationHighlightTarget,
} from "@/components/chat/chat-navigation-highlight";
import { queryMountedChatMessageRoot } from "@/components/chat/chat-find-highlighter";
import type {
  OrdinalRange,
  TranscriptWindow,
} from "@/stores/chats/transcript-window";
import { captureChatFreeScrollingOffset } from "@/components/chat/chat-scroll-restoration";
import {
  commitChatTabStateToDurable,
  peekSavedChatTabState,
  restoreChatTabState,
  saveChatTabState,
  type ChatTabScrollMode,
  type SavedChatTabScrollState,
  type SaveChatTabStateInput,
} from "@/stores/chats/chat-tab-state-cache";
import { registerChatTabViewportCapture } from "@/stores/chats/chat-tab-viewport-handoff";
import { ChatTurnMinimap } from "@/components/chat/chat-turn-minimap";
import {
  CHAT_TURN_MINIMAP_KEYBOARD_OWNER_SELECTOR,
  shouldMountChatTurnMinimap,
  shouldRunChatTurnMinimapRail,
} from "@/components/chat/chat-turn-minimap-logic";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
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
  type ChordString,
} from "@/lib/keybindings/chord";
import { isMac } from "@/lib/keybindings/platform";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import { ActivityGroupOpenStoreProvider } from "@/stores/chats/activity-group-open-store";
import { A2AOpenStoreProvider } from "@/stores/chats/a2a-open-store";
import { ChatFindForceStoreProvider } from "@/stores/chats/chat-find-force-store";
import { getOrCreateActivityGroupOpenStore } from "@/stores/chats/activity-group-open-store-core";
import { getOrCreateA2AOpenStore } from "@/stores/chats/a2a-open-store-context";
import { ChatOpenStoreScopeProvider } from "@/stores/chats/open-store-scope";
import {
  ChatTranscriptProvider,
  type ChatTranscriptIdentity,
} from "@/components/chat/chat-transcript-context";
import {
  chatTabPersistenceChatKey,
  type ChatTabPersistenceIdentity,
} from "@/stores/chats/chat-tab-persistence-key";
import {
  forgetPendingHydrationRestore,
  pendingHydrationRestore,
  rememberPendingHydrationRestore,
} from "@/stores/chats/chat-tab-pending-hydration-restore";
import {
  clearChatKeyTombstone,
  clearEpicPrefixTombstone,
} from "@/stores/chats/chat-tab-persistence-tombstone";
import {
  clearReadingPositionTombstones,
  readingPositionIdentityForChat,
} from "@/lib/reading-position";
import { useChatScopedOpenStoreDualKeySeed } from "@/stores/chats/chat-scoped-open-store-dual-key";
import {
  toolOpenDurableCache,
  toolOpenInitializedScopes,
  useToolOpenStore,
} from "@/stores/chats/tool-open-store";
import {
  subagentOpenDurableCache,
  subagentOpenInitializedScopes,
  useSubagentOpenStore,
} from "@/stores/chats/subagent-open-store";
import { useLayoutSetting } from "@/lib/layout-overrides";
import { useLayoutHotspot } from "@/components/customize/use-layout-hotspot";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { isEpicCanvasTileInstanceLive } from "@/stores/epics/canvas/tile-instance-liveness";
import { resolveHostedTileOwnership } from "@/components/epic-canvas/surface-host/hosted-tile-resolver";
import type {
  ChatMessage as ChatMessageModel,
  MessageSegment,
} from "@/stores/composer/chat-store";
import {
  createFallbackAnnouncementObserver,
  fallbackNoticeAnnouncements,
  fallbackOutcomeAnnouncement,
  fallbackReturnAnnouncement,
  fallbackTraversalAnnouncement,
  NO_TRANSCRIPT_BASELINE,
  useChatAnnouncementQueue,
  useChatAnnouncements,
  type ChatAnnouncement,
  type ChatAnnouncementKind,
  type FallbackAnnouncement,
  type FallbackAnnouncementObserver,
  type FallbackAnnouncementPlan,
  type FallbackNoticeAnnouncement,
} from "@/stores/chats/chat-announcements";
import {
  fallbackDestinationOfTuple,
  fallbackDestinationSentence,
  fallbackResolvedIdentitySentence,
  pendingFallbackHarnessSubjects,
  useFallbackModelCatalogues,
  useFallbackProfileLabels,
  type FallbackIdentityResolvers,
} from "@/components/chat/fallback/fallback-identity";
import { useExistingChatSessionHandle } from "@/lib/registries/chat-session-registry";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import type {
  ChatSessionState,
  ChatSessionStoreHandle,
  ConfirmedManualFallbackAction,
  UnattendedFallbackOutcome,
} from "@/stores/chats/chat-session-store";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type {
  BackgroundItem,
  FallbackImpendingAction,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { LegendListRef } from "@legendapp/list/react";
import {
  use,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useInsertionEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

interface ChatMessagesProps {
  taskTitle: string;
  /** Chat tab identity; keys the composer draft the quote affordance appends to.
   *  Also this chat's `chatId` half of the ticket-15 dual-key identity. */
  taskId: string;
  /** The epic this chat belongs to - the other half of the ticket-15
   *  dual-key `(epicId, chatId)` durable identity. */
  epicId: string;
  /** Host this chat tab is bound to for its full lifetime. */
  hostId: string | null;
  /** The full derived, pinned-todo-stripped row history to hand to LegendList. */
  messages: ReadonlyArray<ChatMessageModel>;
  /**
   * The transcript index on the windowed line (`chat.subscribe@1.8`), or
   * `null` on the legacy line where `messages` IS the whole transcript. The
   * merge with `messages` happens here (`transcriptListRows`), so everything
   * below this component - the timeline, the minimap, every saved or computed
   * LIST index - lives in one index space that includes placeholder rows.
   */
  transcriptWindow: TranscriptWindow | null;
  /**
   * Reports which ordinals the viewport is showing, for viewport-driven
   * hydration. Called with `null` when no placed row is visible (the pending
   * tail, or the legacy line where rows own no ordinals) - the store treats
   * that as "no viewport obligation", never as a request.
   */
  onVisibleOrdinalRangeChange: (range: OrdinalRange | null) => void;
  /**
   * `ChatSessionState.transcriptBaselineEpoch` - which connection's snapshot
   * established these rows. The polite-announcement deriver needs it to tell
   * a live arrival from (re)hydrated history without guessing from row shape.
   */
  baselineEpoch: number;
  /**
   * `ChatSessionState.transcriptHydrationSequence` - bumped when a range
   * response seated rows the reader scrolled to, so the deriver can absorb
   * them as history rather than announce them as arrivals.
   */
  hydrationSequence: number;
  /**
   * `ChatSessionState.coldRewrittenMessageIds` - rows rewritten while their
   * span was evicted. The announcement deriver exempts these from the history
   * rule above, once each, because a row updated while cold first appears
   * during a hydration and is otherwise indistinguishable from old scrollback.
   */
  coldRewrittenMessageIds: ReadonlySet<string>;
  /** Live host-owned background items; undefined means the connected host lacks support. */
  backgroundItems: ReadonlyArray<BackgroundItem> | undefined;
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
  /**
   * How a `kind: "message"` scroll request ended. `landed` means the hydrated
   * target row was mounted at the navigation offset; `exhausted` means the
   * bounded re-issue loop gave up; `cancelled` means a reader gesture or a
   * newer request superseded it. The owner uses this to release whatever it
   * was holding open for the landing (the windowed line's required
   * hydration ordinal). Never called for `kind: "end"`.
   */
  onScrollRequestSettled:
    | ((requestId: number, outcome: ChatScrollRequestOutcome) => void)
    | null;
  /** Measured height of the overlaid composer/queue/pinned/agents dock
   *  (chat-tile.tsx), reserved as the transcript's bottom content inset. */
  composerOverlayHeight: number;
}

export type ChatScrollRequestOutcome = "landed" | "exhausted" | "cancelled";

/**
 * A `kind: "message"` request whose landing has not reached a terminal
 * outcome: issued and settling, or still waiting for its row key to appear in
 * the rendered index. Kept in a ref so a `listRows` change or a hidden→visible
 * transition can re-issue it - a request must not be burned by a row that has
 * not hydrated yet.
 */
interface PendingScrollRequestLanding {
  readonly requestId: number;
  readonly messageId: string;
  readonly blockId: string | null;
}

export type ChatMessageScrollRequest =
  | {
      readonly kind: "message";
      readonly messageId: string;
      /** Card to open within the target row, or `null` for a row-level jump. */
      readonly blockId: string | null;
      readonly requestId: number;
    }
  | {
      readonly kind: "end";
      readonly requestId: number;
    };

const EMPTY_BACKGROUND_TOOL_BLOCK_IDS: ReadonlySet<string> = new Set();
const EMPTY_ROW_INDEX_BY_KEY: ReadonlyMap<string, number> = new Map();
/** Stable identity, so the legacy line's skeleton hand-off stays a no-op. */
const EMPTY_ROW_SKELETON: readonly (RowSkeletonEntry | undefined)[] = [];
/** `awaitScrollSettle`'s fallback timeout when `scrollend` never fires
 *  (jsdom, some browsers) - exported so tests can wait past it rather than
 *  hardcoding a copy of this number. Used only by the DOM-event-based
 *  `scrollToEnd`/`navigateToMessage` settle paths - the anchor engine's
 *  Promise-based settle uses its own, longer, `CHAT_TIMELINE_ANCHOR_SCROLL_
 *  PROMISE_TIMEOUT_MS` below (review finding: this shorter window is unsafe
 *  as a validate-and-settle deadline for an animated anchor scroll). */
export const CHAT_ANCHOR_SETTLE_FALLBACK_MS = 750;
/** Ticket 18 (review fix round 2, watchdog false-early-settle - source-
 *  proven residual): the full library contract this must clear is TWO
 *  sequential windows, not one - `IMPERATIVE_SCROLL_SETTLE_MAX_WAIT_MS` =
 *  800ms (vendored `react.js:6624`, the readiness poll BEFORE the library
 *  even issues the underlying scroll - a data/measurement transition can
 *  occupy this whole window) THEN `SCROLL_END_MAX_MS` = 1500ms (vendored
 *  `react.js:1486`, the animated-scroll ownership ceiling AFTER issue) -
 *  worst case 2300ms before the library's own promise resolves. 800 + 1500
 *  + ~300ms scheduling margin = 2600ms. NOTE: correctness no longer
 *  depends on this exact number - `awaitChatTimelineScrollPromiseSettle`'s
 *  fallback now ALWAYS routes into the validate-failure path on expiry
 *  (never a blind settle), so a future LegendList bump past this value
 *  degrades to an extra reissue cycle, not a false-settled anchor. Kept
 *  contract-accurate anyway so an expiry remains the rare, truly-abnormal
 *  case rather than routinely consuming a retry against a scroll that was
 *  always going to finish on its own - if either cited constant changes,
 *  this comment (not just the number) needs updating. */
export const CHAT_TIMELINE_ANCHOR_SCROLL_PROMISE_TIMEOUT_MS = 2_600;
/** Ticket 10: pixel tolerance for the settle/re-issue validation below - a
 *  navigation whose landing is off by more than this is treated as a real
 *  undershoot, not float/rounding noise. */
const CHAT_TIMELINE_NAVIGATION_LANDING_EPSILON_PX = 1;
/** Ticket 10: bounded retry count for the settle/re-issue loop (ticket text:
 *  "max 2-3") - the upper end, since the field bug this fixes needed
 *  multiple manual pill re-clicks to converge and the goal is to absorb that
 *  automatically in one operation. */
const CHAT_TIMELINE_NAVIGATION_MAX_RETRIES = 3;

/** The controller's own follow-vs-free scroll state - a pure mirror of
 *  LegendList's strict `isAtEnd`, never an independent source of truth. */
type ChatTimelineScrollMode = "following-end" | "free-scrolling";

function resolvePersistedChatTabScrollMode(
  scrollMode: ChatTimelineScrollMode,
): ChatTabScrollMode {
  return scrollMode === "following-end" ? "following-end" : "free-scrolling";
}

/** The scroll offset that lands `index`'s row at `viewOffset` px from the
 *  viewport top - the restoration convergence loop's issue/reissue target.
 *  Inverse of `captureChatFreeScrollingOffset`. */
function expectedTimelineScrollTop(
  list: LegendListRef,
  index: number,
  viewOffset: number,
  topOffsetAdjustment: number,
): number | null {
  const rowTop = list.getState().positionAtIndex(index);
  if (typeof rowTop !== "number" || !Number.isFinite(rowTop)) {
    return null;
  }
  return rowTop + topOffsetAdjustment - viewOffset;
}

/** A snapshot of the list geometry a mount-time free-scrolling restore's
 *  target row depends on - read fresh from the list at either issue or
 *  abort time, so both call sites stay in sync by construction.
 *  `rowPosition` is the target row's own measured position, independent of
 *  header/footer padding: LegendList reports its real header size via a
 *  metrics callback shortly after every mount, settling from an initial 0
 *  as a routine bootstrap unrelated to content - comparing that pad
 *  directly would treat that normal settling as a geometry change on every
 *  restore. */
interface FreeRestoreGeometry {
  readonly scrollTop: number | null;
  readonly scrollHeight: number | null;
  readonly clientHeight: number | null;
  readonly rowPosition: number | null;
}

/** LegendList's web implementation can return null before its scroll element
 * attaches even though the cross-platform public type is non-null. Keep that
 * runtime boundary explicit for mount-time restoration reads. */
function getScrollableNodeOrNull(list: LegendListRef): HTMLElement | null {
  return list.getScrollableNode();
}

function measureFreeRestoreGeometry(
  list: LegendListRef | null,
  index: number | undefined,
): FreeRestoreGeometry {
  if (list === null) {
    return {
      scrollTop: null,
      scrollHeight: null,
      clientHeight: null,
      rowPosition: null,
    };
  }
  const scrollNode = getScrollableNodeOrNull(list);
  const rowPosition =
    index === undefined ? null : list.getState().positionAtIndex(index);
  if (!scrollNode) {
    return {
      scrollTop: null,
      scrollHeight: null,
      clientHeight: null,
      rowPosition,
    };
  }
  return {
    scrollTop: scrollNode.scrollTop,
    scrollHeight: scrollNode.scrollHeight,
    clientHeight: scrollNode.clientHeight,
    rowPosition,
  };
}

/** The target and content/geometry fingerprint actually issued by a
 *  mount-time free-scrolling restore, captured once - never recomputed from
 *  the latest list state, or automatic content/layout movement during
 *  settle (append, in-place growth, reorder) would always agree with
 *  wherever the geometry currently sits. */
interface IssuedFreeRestoreTarget {
  readonly targetScrollTop: number | null;
  readonly rows: ReadonlyArray<TranscriptListRow>;
  readonly geometry: FreeRestoreGeometry;
}

/** Fixup (atomic-reader-supersession): a past-target landing is only
 *  trustworthy as reader motion if nothing that could have moved the
 *  viewport out from under the restore happened in between - append,
 *  in-place growth, or a reorder all drive LegendList's own static
 *  `maintainScrollAtEnd` regardless of reader input. Require row
 *  identity/order, scroll height, viewport height, and the target row's own
 *  position to still match what was issued before trusting the raw
 *  scrollTop comparison. */
function isDemonstrablyPastIssuedFreeRestoreTarget(
  issued: IssuedFreeRestoreTarget,
  liveRows: ReadonlyArray<TranscriptListRow>,
  live: FreeRestoreGeometry,
): boolean {
  const geometryAndContentUnchanged =
    liveRows === issued.rows &&
    issued.geometry.scrollHeight !== null &&
    live.scrollHeight === issued.geometry.scrollHeight &&
    issued.geometry.clientHeight !== null &&
    live.clientHeight === issued.geometry.clientHeight &&
    issued.geometry.rowPosition !== null &&
    live.rowPosition === issued.geometry.rowPosition;
  return (
    geometryAndContentUnchanged &&
    issued.targetScrollTop !== null &&
    live.scrollTop !== null &&
    live.scrollTop >
      issued.targetScrollTop + CHAT_TIMELINE_NAVIGATION_LANDING_EPSILON_PX
  );
}

type ChatKeyboardScrollAction =
  | "page-up"
  | "page-down"
  | "line-up"
  | "line-down"
  | "top"
  | "bottom";

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

/**
 * A hosted chat's own DOM lives in `StableTileSurfaceHost`'s plane, not
 * inside its canvas pane's `[data-group-id]` subtree - the physical
 * ancestry lookup misses for it (and for any target inside it), so a miss
 * falls back to the hosted resolver, which walks the SAME node up to its
 * hosted-record ancestor's stamped pane id instead.
 */
function canvasPaneIdOf(node: Node | null): string | null {
  const element = node instanceof Element ? node : node?.parentElement;
  if (element === undefined || element === null) return null;
  const physicalPaneId = element
    .closest("[data-group-id]")
    ?.getAttribute("data-group-id");
  if (physicalPaneId !== undefined && physicalPaneId !== null) {
    return physicalPaneId;
  }
  return resolveHostedTileOwnership(element)?.paneId ?? null;
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

function hasConfiguredKeybinding(chord: ChordString): boolean {
  return Object.values(useKeybindingStore.getState().bindings).some(
    (binding) => binding === chord,
  );
}

function isMacCommandArrow(event: globalThis.KeyboardEvent): boolean {
  return (
    isMac() &&
    (event.key === "ArrowUp" || event.key === "ArrowDown") &&
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  );
}

/** Chromium's macOS document-boundary chord, unless a user binding owns it. */
function macCommandArrowBoundaryScrollAction(
  event: globalThis.KeyboardEvent,
): ChatKeyboardScrollAction | null {
  if (!isMacCommandArrow(event) || ownsArrowKeys(event.target)) return null;
  const chord: ChordString =
    event.key === "ArrowUp" ? "mod+arrowup" : "mod+arrowdown";
  if (hasConfiguredKeybinding(chord)) return null;
  return event.key === "ArrowUp" ? "top" : "bottom";
}

function plainArrowScrollAction(
  event: globalThis.KeyboardEvent,
): ChatKeyboardScrollAction | null {
  if (
    (event.key !== "ArrowUp" && event.key !== "ArrowDown") ||
    !isUnmodified(event) ||
    ownsArrowKeys(event.target)
  ) {
    return null;
  }
  return event.key === "ArrowUp" ? "line-up" : "line-down";
}

function homeEndBoundaryScrollAction(
  event: globalThis.KeyboardEvent,
): ChatKeyboardScrollAction | null {
  if (ownsBoundaryKeys(event.target)) return null;
  const boundary =
    isPlatformModifiedBoundaryKey(event) ||
    (isPlainBoundaryKey(event) && (isMac() || !isEditableTarget(event.target)));
  if (!boundary) return null;
  return event.key === "Home" ? "top" : "bottom";
}

function chatKeyboardScrollAction(
  event: globalThis.KeyboardEvent,
): ChatKeyboardScrollAction | null {
  if (event.key === "PageUp") return "page-up";
  if (event.key === "PageDown") return "page-down";
  const macCommandBoundary = macCommandArrowBoundaryScrollAction(event);
  if (macCommandBoundary !== null) return macCommandBoundary;
  const plainArrow = plainArrowScrollAction(event);
  if (plainArrow !== null) return plainArrow;
  return homeEndBoundaryScrollAction(event);
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
 * Ticket 18: waits for LegendList's OWN `scrollToIndex`/`scrollToOffset`
 * Promise to resolve - its target-aware finish (`finishScrollTo` in the
 * vendored source only resolves once the library itself considers that
 * specific scroll done), not any `scrollend` DOM event/timeout race
 * (`awaitScrollSettle`, still used by the pill/nav callers below - see
 * `settleChatTimelineNavigation`'s own doc comment for why those stay as-is).
 * Then a further double-rAF quiet window, since rows can still be mid-
 * measurement the instant the library considers itself finished.
 * `getPendingScroll` is re-invoked on every wait (never captured once) - a
 * reissue creates a NEW promise each attempt, and this must await THAT one,
 * not a stale earlier one.
 *
 * Review fix round 1 (finding: watchdog-as-false-early-settle): the fallback
 * timer routes through the SAME `settleAfterQuietWindow` the promise path
 * uses - never settles "raw".
 *
 * Review fix round 2 (source-proven residual: no finite `timeoutMs` can be
 * PROVEN to exceed the library's full contract window with certainty - see
 * `CHAT_TIMELINE_ANCHOR_SCROLL_PROMISE_TIMEOUT_MS`'s own doc comment for the
 * two sequential library windows this is trying to clear). `onSettle` now
 * receives `timedOut` - `false` when the library's own promise genuinely
 * resolved (or - defensively, it never actually rejects today - if it somehow
 * rejected), `true` only when the local fallback timer fired first. The
 * caller's `validate` MUST treat `timedOut === true` as an unconditional
 * validation failure (never inspect DOM geometry in that case) so a timeout
 * can only ever drive the SAME reissue/fail-safe path an ordinary failed
 * validation already does - never a blind settle. This makes correctness
 * independent of the exact timeout value: it only trades a slower legitimate
 * scroll for an extra (still-bounded, still-safe) reissue cycle.
 */
function awaitChatTimelineScrollPromiseSettle(
  getPendingScroll: () => Promise<void>,
  onSettle: (timedOut: boolean) => void,
  timeoutMs: number,
): () => void {
  let finished = false;
  let cancelDoubleRaf = (): void => {};
  const finish = (timedOut: boolean): void => {
    if (finished) return;
    finished = true;
    window.clearTimeout(fallbackTimer);
    onSettle(timedOut);
  };
  const settleAfterQuietWindow = (timedOut: boolean): void => {
    if (finished) return;
    cancelDoubleRaf = scheduleChatTimelineDoubleRaf(() => finish(timedOut));
  };
  void getPendingScroll().then(
    () => settleAfterQuietWindow(false),
    () => settleAfterQuietWindow(true),
  );
  const fallbackTimer = window.setTimeout(
    () => settleAfterQuietWindow(true),
    timeoutMs,
  );
  return (): void => {
    if (finished) return;
    finished = true;
    window.clearTimeout(fallbackTimer);
    cancelDoubleRaf();
  };
}

/**
 * Ticket 10: a generic settle/re-issue pattern for validated explicit
 * navigation (`navigateToMessage`/find/deep-link, `scrollToEnd`, restoration
 * convergence). An ANIMATED intent targets ESTIMATED geometry; the installed
 * LegendList 3.2.0 has no mid-flight retargeting as real measurements replace
 * estimates during the animation, so a long jump can settle short
 * (root-cause: rootcause-nav-landing / rootcause-send-undershoot reports).
 * After `awaitSettle` calls back, `shouldYieldToReader` (a real gesture -
 * e.g. an OS scrollbar drag that fires no wheel/touch/pointerdown of its own -
 * must still win over a still-in-flight correction, never yanking the reader
 * back) takes priority over `validate`; if it yields, `onSettledInvalid` runs
 * directly, same remedy as exhausting retries. Otherwise `validate` checks
 * the landing against fresh geometry; if off, `reissue` re-issues the SAME
 * semantic target non-animated (which resolves synchronously - `scrollTo`'s
 * `!animated` branch calls `updateScroll` directly) and this re-settles, up
 * to `maxRetries` times. `isAborted` (checked before every check) is the
 * caller's own ownership check - a generation bump or a real gesture
 * supersedes a still-in-flight operation; it must stop correcting a position
 * nobody wants anymore - a fired `isAborted` abandons silently (someone else
 * is already driving the UI). `onSettledValid` runs once the landing
 * validates; `onSettledInvalid` runs once every retry is exhausted and the
 * landing is still off, or `shouldYieldToReader` fires (neither ever called
 * if `isAborted` fires first).
 */
function settleChatTimelineNavigation(input: {
  readonly awaitSettle: (onSettle: () => void) => () => void;
  readonly isAborted: () => boolean;
  readonly shouldYieldToReader: () => boolean;
  readonly validate: () => boolean;
  readonly reissue: () => void;
  readonly onSettledValid: () => void;
  readonly onSettledInvalid: () => void;
  readonly maxRetries: number;
}): () => void {
  let cancelled = false;
  let cancelActiveWait = (): void => {};
  const attempt = (retriesLeft: number): void => {
    cancelActiveWait = input.awaitSettle(() => {
      if (cancelled) return;
      if (input.isAborted()) return;
      if (input.shouldYieldToReader()) {
        input.onSettledInvalid();
        return;
      }
      if (input.validate()) {
        input.onSettledValid();
        return;
      }
      if (retriesLeft <= 0) {
        input.onSettledInvalid();
        return;
      }
      input.reissue();
      attempt(retriesLeft - 1);
    });
  };
  attempt(input.maxRetries);
  return () => {
    cancelled = true;
    cancelActiveWait();
  };
}

/**
 * Virtualized chat transcript. The full derived row history is handed to
 * `ChatTimeline` (LegendList), which windows the mounted DOM to the viewport.
 * Scroll ownership is a pure mirror of LegendList's own strict `isAtEnd`
 * (`following-end` / `free-scrolling` - behavior contract: "one edge, one
 * rule"). This component also owns the composer/queued-surface overlay
 * inset math (decision #13).
 */
export function ChatMessages(props: ChatMessagesProps) {
  // Ticket 15 (decision #29): one identity built once per mount, threaded to
  // every registry in the dual-key restoration family - the tab instanceId
  // stays primary (unchanged from ticket 5); `epicId`/`taskId` (chatId) are
  // the durable fallback. Stable for the component's whole lifetime (a chat
  // tile fully remounts on any real identity change - decision #17), so a
  // `useState` initializer is enough; no need to react to prop changes.
  const [identity] = useState<ChatTabPersistenceIdentity>(() => ({
    tileInstanceId: props.instanceId,
    epicId: props.epicId,
    chatId: props.taskId,
    hostId: props.hostId,
  }));
  // The transcript's own chat, for segments that ask its live session whether
  // a shell still exists. Memoised so the provider does not re-render every
  // consumer per transcript render; `null` with no bound host, where no live
  // session can exist to ask.
  const transcriptIdentity = useMemo<ChatTranscriptIdentity | null>(
    () =>
      props.hostId === null
        ? null
        : { chatId: props.taskId, hostId: props.hostId },
    [props.hostId, props.taskId],
  );
  // Ticket 15 review round 3: opening a chat clears its own tombstone (a
  // prior deletion is over; this is the SAME chatId only if the host has
  // genuinely recreated it, which mints a fresh chatId in practice - this
  // clear is a no-op then, but cheap and correct either way). An effect,
  // not inline in the identity's own useState initializer above - no store
  // writes during render (round-3 finding: render-phase purity).
  //
  // Also clears the EPIC-level tombstone: `handleEpicAccessLoss` tombstones
  // by epic PREFIX (not an exact chat key - see chat-tab-persistence-
  // tombstone.ts), and unlike a chat delete, access loss is not necessarily
  // terminal (access can be regained). This tile mounting under `epicId` is
  // the signal that the epic is open/accessible again.
  useLayoutEffect(() => {
    clearChatKeyTombstone(chatTabPersistenceChatKey(identity));
    clearEpicPrefixTombstone(identity.epicId);
    clearReadingPositionTombstones(readingPositionIdentityForChat(identity));
  }, [identity]);
  // Ticket 5: registry-backed, keyed by tile instance id, so expanded A2A
  // cards survive a remount of this SAME instance - retention-cap or top-level
  // eviction, or a hosted-eligibility flip; no longer an inner tab switch
  // (decision #17 was reversed by pane chat retention) - and are evicted when
  // the tab permanently closes (canvas store's tile-removal subscriber), never
  // on a mere remount. A reopen is a new instance, not a revival of this one.
  //
  // Ticket 15 review round 3 (mandated simplification): no longer commits
  // to durable on its OWN unmount - the canvas close sweep's promotion
  // choke point (store.ts) now owns that, reading this store directly
  // before eviction. That single point covers both an active view's close
  // AND an inactive (never-mounted) view's close, which a component-owned
  // commit structurally cannot (nothing here ever runs for a view that
  // never rendered).
  const [a2aOpenStore] = useState(() => getOrCreateA2AOpenStore(identity));
  return (
    <A2AOpenStoreProvider store={a2aOpenStore}>
      <ChatFindForceStoreProvider tileInstanceId={props.instanceId}>
        <ChatTranscriptProvider value={transcriptIdentity}>
          <ChatMessagesInner {...props} identity={identity} />
        </ChatTranscriptProvider>
      </ChatFindForceStoreProvider>
    </A2AOpenStoreProvider>
  );
}

interface ChatMessagesInnerProps extends ChatMessagesProps {
  readonly identity: ChatTabPersistenceIdentity;
}

/**
 * Ticket 15 review (live pass S5, confirmed defect): non-null only when the
 * mount-time restore had to clamp away from the true saved anchor - i.e.
 * `restoreChatTabState` silently substituted a neighbor because `messages`
 * was still mid-hydration, not because the anchor is genuinely gone. The
 * hydration-retry effect resolves this against `messages` as it grows.
 */
function resolvePendingHydrationRestoreAnchorId(
  restoredTabState: SavedChatTabScrollState,
  rawSavedTabState: SavedChatTabScrollState | null,
): string | null {
  if (rawSavedTabState?.mode === "following-end") return null;
  const rawSavedAnchorMessageId = rawSavedTabState?.anchorMessageId ?? null;
  if (rawSavedAnchorMessageId === null) return null;
  if (restoredTabState.anchorMessageId === rawSavedAnchorMessageId) {
    return null;
  }
  return rawSavedAnchorMessageId;
}

function savedRestoreRequiresPersistenceGate(
  saved: SavedChatTabScrollState | null,
): boolean {
  return (
    saved !== null &&
    saved.mode !== "following-end" &&
    saved.anchorMessageId !== null
  );
}

interface PendingMeasuredFreeRestore {
  readonly messageId: string;
  readonly viewOffset: number;
}

function resolvePendingMeasuredFreeRestore(
  restored: SavedChatTabScrollState,
): PendingMeasuredFreeRestore | null {
  if (restored.mode !== "free-scrolling" || restored.anchorMessageId === null) {
    return null;
  }
  return {
    messageId: restored.anchorMessageId,
    viewOffset: restored.offset,
  };
}

function announcementTextFor(
  taskTitle: string,
  kind: ChatAnnouncementKind,
): string {
  switch (kind) {
    case "turn-completed":
      return `${taskTitle} finished responding.`;
    case "background-update":
      return `${taskTitle} received a background update.`;
    default:
      return `${taskTitle} received a background completion.`;
  }
}

interface ChatAnnouncementScope {
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string | null;
}

interface ChatLiveAnnouncementsProps extends ChatAnnouncementScope {
  readonly messages: ReadonlyArray<ChatMessageModel>;
  readonly baselineEpoch: number;
  readonly hydrationSequence: number;
  readonly coldRewrittenMessageIds: ReadonlySet<string>;
  readonly visible: boolean;
  readonly taskTitle: string;
  readonly completion: ChatAnnouncement | null;
}

function fallbackPlanForAnnouncement(
  action: FallbackImpendingAction | null,
  destination: string | null,
): FallbackAnnouncementPlan | null {
  if (action === null) return null;
  let kind: FallbackAnnouncementPlan["action"];
  if (action.pending !== null) {
    kind = "checking";
  } else if (action.rung === "profile" || action.rung === "tier") {
    kind = "switch";
  } else {
    kind = action.rung;
  }
  return {
    planId: action.planId,
    action: kind,
    destination,
    resumesAt: action.resumesAt,
  };
}

interface ManualFallbackAnnouncementObservation {
  readonly sequence: number;
  readonly announcement: FallbackAnnouncement | null;
}

/**
 * The shared identity pair, plus the one question only a CONSUMING surface has
 * any use for.
 *
 * One bundle rather than a fifth positional argument, and not merely to satisfy
 * the parameter count: these three are read together on every call, and a
 * resolver arriving separately from the question "is this resolver ready" is
 * exactly the pairing that let the defect below exist in the first place.
 */
interface ManualAnnouncementResolvers extends FallbackIdentityResolvers {
  /**
   * Whether the destination's model catalogue has settled.
   *
   * This observation CONSUMES its event - returning a sequence advances
   * `lastManualSequence`, and the action is never looked at again - so unlike
   * every rendered surface it cannot correct a name afterwards. The subjects
   * are read off live store state inside an effect event, but the resolver
   * beside them is built from the LAST render's subscription list: a manual
   * switch that introduces a harness this chat had not named before is seen by
   * the store callback one render BEFORE that harness's catalogue is even
   * requested. Consuming there spoke the raw slug permanently.
   */
  readonly modelCatalogueSettledFor: (harnessId: string) => boolean;
}

/**
 * How long the manual-switch sentence waits for a real model label before going
 * out with whatever has resolved.
 *
 * It exists because neither "failed" nor "frozen" covers every stall: a host
 * row that keeps advertising an endpoint while every request fails leaves the
 * poll retrying forever, and a wedged probe never clears `availabilityPending`
 * at all. Both are an unbounded wait for a label, and this is the only bound
 * that does not depend on guessing which query field means "terminal".
 *
 * Note what it is NOT a bound on: reaching the user. Delivery is gated on
 * `canSpeak`, which has no clock at all - a hold kept because the surface
 * cannot announce is not even holding a timer, so a tab left hidden for an
 * hour announces when it comes back. That is intended. The event is known to
 * be news by then (it was established as such on first sight), and the
 * alternative is dropping a switch the user asked for.
 *
 * The figure is a TRADE, not a proof, and it is worth being exact about which.
 *
 * What is measurable from here is the GUI's own share, and only for the lane
 * this wait actually sits in. `agent.gui.listHarnesses` has several
 * condition-poll lanes and they are nothing like each other:
 * `harnesses.all-available` is 15 minutes flat, `harnesses.unavailable` climbs
 * to 5. What bounds THIS wait is `harnesses.pending` (800ms to a 5s ceiling)
 * and its two error spreads - and it is that lane precisely because the hold
 * is waiting on a probe, which is the condition putting the row there. So
 * noticing a settle costs at most one 5s tick, and the catalogue fetch after
 * it is a single un-polled round trip (`listModels` is `poll: null`). 10s is
 * two of those ticks: one for the notice, the second left for the fetch.
 *
 * What is NOT measurable from here is how long the host takes to probe a
 * provider in the first place - that is a CLI or SDK call on the far side, and
 * nothing in this client bounds it. So this cannot be a figure that only a
 * broken read reaches; a genuinely slow probe will reach it too, and then the
 * sentence goes out with the slug. That is the trade the deadline makes, and it
 * is made in the direction the rest of this hold already argues for: a clumsy
 * announcement beats silence about a switch that happened.
 */
const MANUAL_LABEL_HOLD_MS = 10_000;

interface ManualHoldRecord {
  readonly sequence: number;
  readonly startedAt: number;
}

/**
 * Clears the pending hold wake and schedules the next one, returning its id.
 *
 * Extracted from the observation so the deadline's arithmetic is readable on
 * its own, and because a wait that is going to time out is the one case where
 * nothing else re-renders: this is the only thing that brings the observer
 * back.
 */
function rescheduleManualHoldWake(input: {
  readonly held: ManualHoldRecord | null;
  readonly deliverable: boolean;
  readonly now: number;
  readonly ready: boolean;
  readonly currentTimerId: number | null;
  readonly wake: () => void;
}): number | null {
  if (input.currentTimerId !== null) {
    window.clearTimeout(input.currentTimerId);
  }
  const held = input.held;
  if (held === null) return null;
  if (input.deliverable) {
    // The wait ended on its own terms and the event was kept only because the
    // observation would have absorbed it. Whether that is worth another wake
    // is a question about READINESS, not about the clock - which is exactly
    // why the observer reports this rather than letting the arithmetic below
    // guess: a settle arriving early is ripe with 9 seconds still unspent.
    //
    // Not ready, stay quiet. Re-arming would spin at 0ms until readiness
    // moved, and nothing is lost by waiting: readiness moving re-observes
    // through the store subscription or the effect's dependencies.
    //
    // Ready yet absorbed, wake once more, because the `observe` in that same
    // pass is what clears the `wasReady` which caused it. The next observation
    // will speak, and no other trigger is guaranteed to arrive. It converges
    // rather than loops - every `observe` moves the observer's own state
    // towards not absorbing.
    return input.ready ? window.setTimeout(input.wake, 0) : null;
  }
  // Still genuinely waiting, so bring the observer back when the deadline
  // lands. Measured from the ORIGINAL start, so repeated observations during a
  // hold cannot push it away.
  //
  // Necessarily positive: the observer only leaves a hold undeliverable while
  // it reads the elapsed as within the window, off this same `now` and
  // `startedAt`. That is the whole reason the clock is read once per
  // observation and handed to both halves.
  const remainingMs = MANUAL_LABEL_HOLD_MS - (input.now - held.startedAt);
  return window.setTimeout(input.wake, remainingMs);
}

/**
 * Everything the hold needs that is not the event itself, passed in rather than
 * kept in a module singleton so each surface holds its own and tests can drive
 * it. Two fields in, two out.
 *
 * In: {@link now}, one clock reading for the whole observation, and
 * {@link canSpeak}, what the `observe` after this one will do with an
 * announcement.
 *
 * Out, both written by the observer: {@link held}, set when a hold begins and
 * cleared when the sentence is finally consumed, and {@link deliverable}, which
 * the wake scheduler reads.
 */
interface ManualHoldClock {
  /** `Date.now()` for this observation. */
  readonly now: number;
  /**
   * Whether an announcement made in THIS observation would actually reach the
   * user, i.e. whether the observer would push it rather than absorb it.
   *
   * Read at both ends of the hold, and it means something different at each,
   * because absorption is both the delivery gate and the history filter. On
   * first sight false means "this is history" - consume it and drop it, which
   * is what every unheld slot does. Once deferred, false means "speaking now
   * would be speaking into the void" - keep waiting, because the event was
   * already established as news.
   */
  readonly canSpeak: boolean;
  held: ManualHoldRecord | null;
  /**
   * Written by the observer: the held event's wait is over - the catalogue
   * answered or the deadline passed - and only {@link canSpeak} is keeping it.
   *
   * An output rather than something the scheduler derives, because the two
   * would disagree. "Ripe" is not "the deadline elapsed": the ordinary case is
   * an answer arriving with most of the window unspent, and a scheduler
   * reading the clock would arm for the full remainder and leave the event
   * waiting on a re-observation nothing is obliged to produce.
   */
  deliverable: boolean;
}

interface ManualObservation {
  readonly manual: ConfirmedManualFallbackAction | null;
  readonly scope: ChatAnnouncementScope;
  readonly lastSequence: number;
  readonly resolvers: ManualAnnouncementResolvers;
  readonly hold: ManualHoldClock;
}

function observeManualFallbackAction({
  manual,
  scope,
  lastSequence,
  resolvers,
  hold,
}: ManualObservation): ManualFallbackAnnouncementObservation {
  const { labelFor, modelLabelFor, modelCatalogueSettledFor } = resolvers;
  // Every exit that is not a hold clears the hold. A held record outliving the
  // event it names is not merely stale: the deadline below is woken by a timer
  // armed from this field, so a record with nothing left to announce would
  // re-arm that timer on every expiry and spin.
  if (
    manual === null ||
    manual.hostId !== scope.hostId ||
    manual.epicId !== scope.epicId ||
    manual.chatId !== scope.chatId
  ) {
    hold.held = null;
    return { sequence: lastSequence, announcement: null };
  }
  const newManual = manual.sequence > lastSequence;
  const sequence = Math.max(lastSequence, manual.sequence);
  // A hold deliberately returns the OLD sequence, so `newManual` stays true for
  // as long as one is in force - reaching here means this event is consumed or
  // was never announceable, and either way nothing is waiting on it.
  if (!newManual || manual.rung !== "switch" || manual.target === null) {
    hold.held = null;
    return { sequence, announcement: null };
  }
  // Bound once, because `manual` is a destructured PARAMETER: the guard above
  // narrows it here, but that narrowing does not follow the field into the
  // closure below, where TypeScript assumes a parameter may have been
  // reassigned. A local const carries it, and reads better at the three sites
  // that need the harness id anyway.
  const target = manual.target;
  // Announcing this switch and giving up the right to announce it again, in
  // one step. Every exit that speaks goes through here, and there are three of
  // them - two that decline to hold and one that stops holding - so the pairing
  // of "clear the hold" with "return the NEW sequence" is written once. Split
  // apart, a consume that advanced the sequence while leaving the record set
  // would re-arm the deadline for an event nothing is waiting on.
  const consume = (): ManualFallbackAnnouncementObservation => {
    hold.held = null;
    return {
      sequence,
      announcement: {
        key: JSON.stringify([
          "manual",
          manual.hostId,
          manual.epicId,
          manual.chatId,
          manual.userMessageId,
          manual.turnId,
          manual.sequence,
        ]),
        text: `Switched this chat to ${fallbackDestinationSentence(
          fallbackDestinationOfTuple(target, labelFor, modelLabelFor),
          true,
        )}.`,
      },
    };
  };
  const held = hold.held;
  const deferred = held !== null && held.sequence === manual.sequence;

  if (!deferred) {
    // FIRST sight of this event, and the one decision only takeable here: is
    // it news at all?
    //
    // An observation that would absorb IS this system's history filter. Every
    // other outcome slot hands its event straight to `observe`, which records
    // the key and pushes nothing, and that is what keeps a warm store quiet:
    // `confirmedManualFallbackAction` is never cleared, and a remount resets
    // the sequence high-water mark to 0, so an hour-old switch reads as new
    // again and is silenced only by being handed over while absorbing.
    //
    // Deferring instead would carry it PAST that window - the hold survives
    // every absorbing observation and the deadline then keeps waking until one
    // would speak, which is precisely the frame the filter is no longer up.
    // The old switch is then told as live news. So absorbing here means
    // consume-and-drop, exactly as the pre-hold code did.
    if (!hold.canSpeak) return consume();
    // Hold the event rather than consume it, and return the OLD sequence so
    // the next observation sees it as new again. The layout effect below lists
    // the catalogues among its dependencies, so the render that subscribes
    // this harness - and then the frame its catalogue lands on - each
    // re-observe, and the switch is announced once, by its real name.
    //
    // Bounded by `settled`, never by `loaded`: a catalogue read that cannot
    // run reports settled and the sentence goes out with the slug. Waiting for
    // a label that is not coming would trade a clumsy announcement for silence
    // about a switch that actually happened, which is the worse of the two for
    // someone driving this by ear.
    if (!modelCatalogueSettledFor(target.harnessId)) {
      hold.held = { sequence: manual.sequence, startedAt: hold.now };
      return { sequence: lastSequence, announcement: null };
    }
    return consume();
  }

  // Deferred, so this event was news AND deliverable when it was taken. From
  // here it may only be consumed into an observation that will actually speak.
  // Consuming into an absorbing one records the key and pushes nothing, and
  // the sequence has already moved - the switch is then lost outright, which
  // is the failure the hold exists to prevent, reached from the third side.
  //
  // This governs BOTH exits. The deadline is the rarer one; the catalogue
  // simply settling is the common one, and it was the gap: a hold taken while
  // ready, whose `listModels` answer lands during a reconnect, used to consume
  // straight into an absorbing observe.
  //
  // So the wait's own terms are settled FIRST, and delivery second. Deciding
  // them in that order is what lets the scheduler below be told that a held
  // event is ripe, rather than re-deriving it from the clock and getting a
  // different answer.
  //
  // The clock is the second bound, and it is here because `settled` can only
  // speak for the reads it can SEE. A poll that keeps failing against a host
  // still advertising an endpoint, or a probe wedged with `availabilityPending`
  // set, are both "an answer is still coming" forever. The wait therefore ends
  // either when the answer arrives or when this deadline does.
  const elapsedMs = hold.now - held.startedAt;
  // A backwards system-clock jump reads as a negative elapsed. Treat that as
  // expired rather than as "keep waiting": this deadline exists to bound
  // silence, so on a nonsense reading the safe direction is to SPEAK.
  const stillWaiting = elapsedMs >= 0 && elapsedMs < MANUAL_LABEL_HOLD_MS;
  if (!modelCatalogueSettledFor(target.harnessId) && stillWaiting) {
    return { sequence: lastSequence, announcement: null };
  }
  if (!hold.canSpeak) {
    // Ripe, and held back only by this observation being an absorbing one.
    // Nothing about the wait will change again, so no further catalogue answer
    // or deadline is coming to bring the observer back - the scheduler has to,
    // and it cannot see this from the clock: the common case gets here with
    // most of the deadline still unspent.
    hold.deliverable = true;
    return { sequence: lastSequence, announcement: null };
  }
  return consume();
}

interface UnattendedFallbackAnnouncementObservation {
  readonly sequence: number;
  readonly announcement: FallbackAnnouncement | null;
}

/**
 * A fallback answer that reached no surface, as an announcement (MF11).
 *
 * Same shape as {@link observeManualFallbackAction} and the same two guards,
 * for the same reasons: a warm store outlives the surfaces that write to it, so
 * the scope triple is re-checked here rather than trusted, and a high-water
 * mark keeps a replayed frame carrying an older record silent.
 *
 * No copy of its own. The publisher records the sentence its own surface would
 * have shown (`describeFallbackOutcome`), because a second wording for one set
 * of outcomes is how the transcript and the toast come to disagree about what
 * happened.
 */
function observeUnattendedFallbackOutcome(
  outcome: UnattendedFallbackOutcome | null,
  scope: ChatAnnouncementScope,
  lastSequence: number,
): UnattendedFallbackAnnouncementObservation {
  if (
    outcome === null ||
    outcome.hostId !== scope.hostId ||
    outcome.epicId !== scope.epicId ||
    outcome.chatId !== scope.chatId
  ) {
    return { sequence: lastSequence, announcement: null };
  }
  if (outcome.sequence <= lastSequence) {
    return { sequence: lastSequence, announcement: null };
  }
  return {
    sequence: outcome.sequence,
    announcement: {
      key: JSON.stringify([
        "unattended",
        outcome.hostId,
        outcome.epicId,
        outcome.chatId,
        outcome.sequence,
      ]),
      text: outcome.text,
    },
  };
}

/**
 * `fallbackNoticeAnnouncements(messages)`, held at its PREVIOUS reference for
 * as long as the notices it produces have not changed.
 *
 * `messages` is rebuilt wholesale on every store update - which is every
 * streamed token; `useStableChatTimelineRows` in `chat-timeline.tsx` exists for
 * that same fact and says so. So a plain `useMemo` on `messages` handed out a
 * fresh array per token even for a transcript whose notices had not moved, and
 * the observation effect below lists this among its dependencies: an otherwise
 * idle chat re-ran `observer.observe` and the whole announcement pipeline once
 * per token, over the whole transcript, to recompute exactly what it had the
 * token before.
 *
 * Reuse is taken only on a field-for-field match of everything the observer
 * reads, so a reused reference always agrees with the transcript on screen.
 *
 * **The carry is `useState`, not `useRef`, and that is not a style choice.**
 * A ref read and written during render is what the React Compiler's
 * `Cannot access refs during render` rejects, and the reason it rejects it is
 * exactly the case this cache lives in: React may discard a render, and a ref
 * written by a discarded render is NOT rolled back, so the next attempt starts
 * from a "previous" value that never reached the screen. `setState` during
 * render is the sanctioned form of the same carry - React re-runs this
 * component with the new state and commits nothing from the discarded pass.
 */
function useStableFallbackNotices(
  messages: ReadonlyArray<ChatMessageModel>,
): ReadonlyArray<FallbackNoticeAnnouncement> {
  const next = useMemo(() => fallbackNoticeAnnouncements(messages), [messages]);
  const [stable, setStable] =
    useState<ReadonlyArray<FallbackNoticeAnnouncement>>(next);
  if (stable !== next && !fallbackNoticeListsEqual(stable, next)) {
    setStable(next);
    // The re-render this schedules returns `stable`, which will BE `next` by
    // then. Returning it here keeps this pass self-consistent rather than
    // handing the observer one render of a list it is about to replace.
    return next;
  }
  return stable;
}

function fallbackNoticeListsEqual(
  left: ReadonlyArray<FallbackNoticeAnnouncement>,
  right: ReadonlyArray<FallbackNoticeAnnouncement>,
): boolean {
  return (
    left.length === right.length &&
    left.every((notice, index) => {
      // `noUncheckedIndexedAccess` is off, and the lengths already match, so
      // this index is a value rather than a value-or-undefined.
      const other = right[index];
      return (
        notice.key === other.key &&
        notice.messageId === other.messageId &&
        notice.text === other.text
      );
    })
  );
}

/**
 * The resident message-id set, on the same hot path and the same terms as
 * {@link useStableFallbackNotices} - with one extra thing at stake.
 *
 * The observer RETAINS this set and compares the next observation against it
 * (`priorResidentMessageIds`, which decides whether a hydrated notice is news
 * or history). What that comparison needs is the SET, not the object: a reused
 * reference carries exactly the same ids, and the only observation this skips
 * is one where the ids did not move - in which case the prior set and the
 * current set are the same set either way.
 *
 * Carried in state rather than a ref for the reason given on
 * {@link useStableFallbackNotices}.
 */
function useStableResidentMessageIds(
  messages: ReadonlyArray<ChatMessageModel>,
): ReadonlySet<string> {
  const next = useMemo(
    () => new Set(messages.map((message) => message.id)),
    [messages],
  );
  const [stable, setStable] = useState<ReadonlySet<string>>(next);
  if (stable !== next && !residentMessageIdsEqual(stable, next)) {
    setStable(next);
    return next;
  }
  return stable;
}

/**
 * Size plus membership IS set equality here, because both sides are sets of
 * transcript message ids and a `Set` already collapsed any duplicate.
 */
function residentMessageIdsEqual(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  if (left.size !== right.size) return false;
  for (const id of right) {
    if (!left.has(id)) return false;
  }
  return true;
}

/**
 * Every harness the announcer may have to name, read off live store state.
 *
 * Module level rather than inline in the `useShallow` below, so the selector is
 * one stable function instead of a fresh closure per render - and so the
 * component itself is not carrying this list's branching.
 *
 * FIXED length, including the three-`null` arm: `useShallow` compares
 * element-wise, and a list whose LENGTH moves with the state it describes makes
 * "did my subjects change" depend on two things at once. Padding keeps each
 * slot meaning one subject for the life of the chat.
 */
function announcedHarnessIdsOf(
  state: ChatSessionState,
): ReadonlyArray<string | null> {
  const pending = state.pendingFallback;
  return [
    // The three a pending fallback can name, shared with the countdown card so
    // the card and the announcer cannot drift apart about where a chat is going.
    ...(pending === undefined
      ? [null, null, null]
      : pendingFallbackHarnessSubjects(pending)),
    state.pendingReturn?.preferredTuple.harnessId ?? null,
    state.pendingReturn?.fallbackTuple.harnessId ?? null,
    state.confirmedManualFallbackAction?.target?.harnessId ?? null,
  ];
}

function ChatFallbackAnnouncementSource(
  props: ChatLiveAnnouncementsProps & {
    readonly hostId: string;
    readonly handle: ChatSessionStoreHandle;
    readonly enqueue: (texts: ReadonlyArray<string>) => void;
    readonly reset: () => void;
  },
) {
  const { handle, enqueue, reset } = props;
  const client = useHostClientForHostId(props.hostId);
  const hasFallback = useStore(
    handle.store,
    (state) =>
      state.pendingFallback !== undefined ||
      state.pendingReturn !== undefined ||
      state.confirmedManualFallbackAction?.rung === "switch",
  );
  const labelFor = useFallbackProfileLabels(
    client,
    props.visible && hasFallback,
  );
  // The harnesses this announcer may have to name, subscribed rather than
  // assembled from props: its subjects are read inside an effect event off live
  // store state, so there is no tuple in hand at render. `useShallow` is what
  // keeps the array from being a new reference every frame.
  //
  // It resolves the same labels the cards do BY CONSTRUCTION - one resolver,
  // one catalogue - which is the rule this file already states for the sentence
  // itself: an announcement naming a destination differently from the row the
  // user is looking at would be a second voice describing one event.
  const announcedHarnessIds = useStore(
    handle.store,
    useShallow(announcedHarnessIdsOf),
  );
  // `settledFor` beside the resolver, because this surface is the one that
  // cannot take back a name it has already spoken - see its use in
  // `observeState` below.
  const { labelFor: modelLabelFor, settledFor: modelCatalogueSettledFor } =
    useFallbackModelCatalogues(
      client,
      announcedHarnessIds,
      props.visible && hasFallback,
    );
  const observerRef = useRef<FallbackAnnouncementObserver | null>(null);
  const lastManualSequence = useRef(0);
  const lastUnattendedSequence = useRef(0);
  const manualHold = useRef<ManualHoldRecord | null>(null);
  const manualHoldTimer = useRef<number | null>(null);
  // Bumped by the hold's wake timer, and listed by the observing effect below.
  // A counter rather than a direct re-entry, because the wake is created INSIDE
  // `observeState` and a const cannot name itself from its own body - and going
  // back through the effect is the better shape anyway: the re-observation then
  // reads every dependency afresh instead of one captured store snapshot.
  const [manualHoldTick, setManualHoldTick] = useState(0);
  const notices = useStableFallbackNotices(props.messages);
  const residentMessageIds = useStableResidentMessageIds(props.messages);

  const observeState = useEffectEvent((state: ChatSessionState) => {
    const observer = observerRef.current;
    if (observer === null) return;
    const pending = state.pendingFallback;
    const targetIdentity =
      pending === undefined
        ? null
        : fallbackResolvedIdentitySentence(
            { kind: "fallback", pending },
            labelFor,
            modelLabelFor,
          );
    const plan = fallbackPlanForAnnouncement(
      pending?.impendingAction ?? null,
      targetIdentity,
    );
    const returning = state.pendingReturn;
    const preferredIdentity =
      returning === undefined
        ? null
        : fallbackResolvedIdentitySentence(
            { kind: "return", pending: returning },
            labelFor,
            modelLabelFor,
          );
    // A store rebase can precede React's new transcript props. Do not pair
    // that epoch with the OLD rows, or its history would arrive as live news.
    // Transport `open` can also precede its authoritative snapshot. The
    // subscribed connection epoch detects this even after a warm remount
    // whose observer never saw the disconnect.
    //
    // Computed HERE, above the manual observation, because the hold's deadline
    // has to consult it. It reads only props and store state, never `manual`.
    const ready =
      props.visible &&
      state.connectionStatus === "open" &&
      state.snapshotLoaded &&
      state.transcriptBaselineEpoch === state.connectionEpoch &&
      props.baselineEpoch !== NO_TRANSCRIPT_BASELINE &&
      props.baselineEpoch === state.transcriptBaselineEpoch;
    const holdClock: ManualHoldClock = {
      now: Date.now(),
      // Whether the `observe` below this will push or absorb - the one fact
      // the hold needs at both of its ends, for two different reasons.
      //
      // Consuming the event into an absorbing observe records the key and
      // pushes nothing, while the sequence counter advances regardless. On the
      // way out that loses the switch outright, which is the failure this hold
      // exists to prevent reached from the other side. On the way IN it is the
      // intended behaviour, because absorption is also how every other slot
      // filters a warm store's history.
      //
      // `ready` alone is not enough, and this is the trap: absorption also
      // covers the FIRST ready observation after a not-ready one, because the
      // observer sets `wasReady` at the end of `observe`. So readiness
      // returning does not by itself mean the next sentence lands - it means
      // the one after it does. Ask the observer rather than inferring, and ask
      // with the inputs the following `observe` will get.
      canSpeak: !observer.willAbsorb({
        ready,
        baselineEpoch: props.baselineEpoch,
      }),
      held: manualHold.current,
      deliverable: false,
    };
    const manual = observeManualFallbackAction({
      manual: state.confirmedManualFallbackAction,
      scope: props,
      lastSequence: lastManualSequence.current,
      resolvers: { labelFor, modelLabelFor, modelCatalogueSettledFor },
      hold: holdClock,
    });
    lastManualSequence.current = manual.sequence;
    manualHold.current = holdClock.held;
    // The deadline needs its own wake. Every other re-observation here is
    // driven by something CHANGING - a store write, or a catalogue landing in
    // this effect's dependencies - and a wait that is going to time out is
    // precisely the case where nothing changes. Without this timer the bound
    // would only be honoured if some unrelated render happened to arrive after
    // it elapsed.
    manualHoldTimer.current = rescheduleManualHoldWake({
      held: manualHold.current,
      deliverable: holdClock.deliverable,
      now: holdClock.now,
      ready,
      currentTimerId: manualHoldTimer.current,
      wake: () => {
        manualHoldTimer.current = null;
        setManualHoldTick((tick) => tick + 1);
      },
    });
    const unattended = observeUnattendedFallbackOutcome(
      state.unattendedFallbackOutcome,
      props,
      lastUnattendedSequence.current,
    );
    lastUnattendedSequence.current = unattended.sequence;
    if (!ready) reset();
    const next = observer.observe({
      ready,
      baselineEpoch: props.baselineEpoch,
      hydrationSequence: props.hydrationSequence,
      coldRewrittenMessageIds: props.coldRewrittenMessageIds,
      residentMessageIds,
      traversal: fallbackTraversalAnnouncement({
        pending,
        plan,
        failedIdentity:
          pending === undefined
            ? ""
            : fallbackDestinationSentence(
                fallbackDestinationOfTuple(
                  pending.failedTuple,
                  labelFor,
                  modelLabelFor,
                ),
                true,
              ),
        targetIdentity,
        now: Date.now(),
      }),
      returnOffer:
        preferredIdentity === null
          ? null
          : fallbackReturnAnnouncement(returning, preferredIdentity),
      liveOutcome: fallbackOutcomeAnnouncement(state.lastFallbackOutcome),
      notices,
      manualOutcome: manual.announcement,
      unattendedOutcome: unattended.announcement,
    });
    enqueue(next.map((entry) => entry.text));
  });

  useLayoutEffect(() => {
    observerRef.current = createFallbackAnnouncementObserver();
    lastManualSequence.current = 0;
    lastUnattendedSequence.current = 0;
    manualHold.current = null;
    reset();
    observeState(handle.store.getState());
    // Observe the store itself: React may batch hold, choosing and switching
    // into one render, and the initiating popover can unmount before success.
    const unsubscribe = handle.store.subscribe((state, prior) => {
      if (
        state.pendingFallback !== prior.pendingFallback ||
        state.pendingReturn !== prior.pendingReturn ||
        state.lastFallbackOutcome !== prior.lastFallbackOutcome ||
        state.confirmedManualFallbackAction !==
          prior.confirmedManualFallbackAction ||
        state.unattendedFallbackOutcome !== prior.unattendedFallbackOutcome ||
        state.connectionEpoch !== prior.connectionEpoch ||
        state.connectionStatus !== prior.connectionStatus ||
        state.snapshotLoaded !== prior.snapshotLoaded ||
        state.transcriptBaselineEpoch !== prior.transcriptBaselineEpoch
      ) {
        observeState(state);
      }
    });
    return () => {
      unsubscribe();
      // The hold timer calls back into `observeState`, which reads the store
      // and the observer this effect owns, so it must not outlive them.
      if (manualHoldTimer.current !== null) {
        window.clearTimeout(manualHoldTimer.current);
        manualHoldTimer.current = null;
      }
      manualHold.current = null;
    };
  }, [handle, reset]);

  useLayoutEffect(() => {
    observeState(handle.store.getState());
  }, [
    handle,
    notices,
    residentMessageIds,
    props.baselineEpoch,
    props.hydrationSequence,
    props.coldRewrittenMessageIds,
    props.visible,
    labelFor,
    // Beside `labelFor`, and for the same reason: both resolvers start
    // unresolved and land asynchronously. Omitting this one meant a catalogue
    // that resolved after the first observation never reached the announcer,
    // so a cold session announced the raw model slug and never corrected it.
    // The resolver is referentially stable (see the `combine` in
    // `useFallbackModelCatalogues`), so this dependency does not re-run the
    // effect on every render.
    modelLabelFor,
    // The other half of the same subscription, and it is what actually
    // releases a HELD manual switch: `observeManualFallbackAction` declines to
    // consume one whose catalogue has not settled, and this dependency is the
    // thing that brings the observation back once it has.
    modelCatalogueSettledFor,
    // And the case where the catalogue never settles. The hold's deadline is
    // woken by a timer, and a timer cannot call back into `observeState` - it
    // is a `const` whose own body would have to name it. So the wake bumps
    // this counter instead and the re-observation arrives the ordinary way,
    // through this effect, with every other dependency freshly read.
    manualHoldTick,
  ]);
  return null;
}

function ChatLiveAnnouncements(props: ChatLiveAnnouncementsProps) {
  const handle = useExistingChatSessionHandle(
    props.epicId,
    props.chatId,
    props.hostId,
  );
  const { announcement, enqueue, reset } = useChatAnnouncementQueue();
  const lastCompletion = useRef<number | null>(null);
  const observeCompletion = useEffectEvent((rebase: boolean) => {
    if (rebase) {
      lastCompletion.current = props.completion?.sequence ?? null;
      reset();
      return;
    }
    const completion = props.completion;
    if (completion === null || completion.sequence === lastCompletion.current) {
      return;
    }
    lastCompletion.current = completion.sequence;
    if (props.visible) {
      enqueue([announcementTextFor(props.taskTitle, completion.kind)]);
    }
  });
  useLayoutEffect(() => {
    observeCompletion(true);
  }, [props.baselineEpoch, props.visible]);
  useLayoutEffect(() => {
    observeCompletion(false);
  }, [props.completion]);

  return (
    <>
      {handle !== null && props.hostId !== null ? (
        <ChatFallbackAnnouncementSource
          {...props}
          hostId={props.hostId}
          handle={handle}
          enqueue={enqueue}
          reset={reset}
        />
      ) : null}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {props.visible && announcement !== null ? (
          <span key={announcement.sequence}>{announcement.text}</span>
        ) : null}
      </div>
    </>
  );
}

// eslint-disable-next-line complexity
function ChatMessagesInner(props: ChatMessagesInnerProps) {
  const {
    getMessageActions,
    backgroundItems,
    baselineEpoch,
    coldRewrittenMessageIds,
    hydrationSequence,
    composerOverlayHeight,
    identity,
    instanceId,
    messages,
    nextStepActions,
    onVisibleOrdinalRangeChange,
    onScrollRequestSettled,
    scrollRequest,
    systemOverlayActive,
    taskId,
    taskTitle,
    transcriptWindow,
    visible,
  } = props;

  // The array the list actually renders: hydrated bodies and placeholders in
  // one sequence. On the legacy line (`transcriptWindow === null`) this is the
  // identity mapping over `messages`, so nothing below behaves differently
  // there. Computed before the mount-time restore initializers because they
  // resolve saved anchors against LIST indexes, which are row indexes.
  const listRows = useMemo(
    () => transcriptListRows({ window: transcriptWindow, rendered: messages }),
    [transcriptWindow, messages],
  );

  // Restore the persisted reading position once, on mount (ticket 15: tries
  // the tab-key entry first, then the durable chat-key entry - RESTORE-FIRST,
  // decision #29). The identity is stable for the mount, so re-reading per
  // render would only repeat an O(n) row scan whose result the
  // initializers below already captured.
  const [restoredTabState] = useState<SavedChatTabScrollState>(() =>
    restoreChatTabState(
      identity,
      listRows.map((row) => row.key),
    ),
  );
  // Ticket 5: a restored row becomes LegendList's own `initialScrollIndex`
  // measurement bootstrap - the same self-correcting path
  // `initialScrollAtEnd` uses, carrying the saved pixel offset. `null` for a
  // fresh open or a saved bottom-following view (LegendList's own
  // `initialScrollAtEnd` covers those).
  const [initialScrollIndexAnchor] =
    useState<ChatTimelineInitialScrollAnchor | null>(() => {
      if (
        restoredTabState.mode !== "free-scrolling" ||
        restoredTabState.anchorMessageId === null
      ) {
        return null;
      }
      const index = listRows.findIndex(
        (row) => row.key === restoredTabState.anchorMessageId,
      );
      if (index === -1) return null;
      return { index, viewOffset: restoredTabState.offset, viewPosition: 0 };
    });
  // Raw saved state, peeked WITHOUT `restoreChatTabState`'s messages-dependent
  // clamp. Hydration retry needs the original anchor id to replay a measured
  // location once the transcript has hydrated enough to contain it.
  const [rawSavedTabState] = useState<SavedChatTabScrollState | null>(
    () => pendingHydrationRestore(identity) ?? peekSavedChatTabState(identity),
  );
  const pendingHydrationRestoreAnchorId =
    resolvePendingHydrationRestoreAnchorId(restoredTabState, rawSavedTabState);
  // Non-null only when the mount-time restore above had to clamp away from
  // the true saved anchor - the hydration-retry effect below (declared
  // after `navigateToMessage`, which it needs) resolves this against
  // `messages` as it grows, then nulls it out permanently, so an ordinary
  // NEW live message arriving later can never re-trigger a jump back here.
  const pendingHydrationRestoreAnchorIdRef = useRef<string | null>(
    pendingHydrationRestoreAnchorId,
  );
  useLayoutEffect(() => {
    if (pendingHydrationRestoreAnchorId !== null && rawSavedTabState !== null) {
      rememberPendingHydrationRestore(identity, rawSavedTabState);
    }
  }, [identity, pendingHydrationRestoreAnchorId, rawSavedTabState]);
  const pendingMeasuredFreeRestoreRef =
    useRef<PendingMeasuredFreeRestore | null>(
      resolvePendingMeasuredFreeRestore(restoredTabState),
    );
  const resolvePendingRestoreEndLandingRef = useRef<(() => boolean) | null>(
    null,
  );
  const chatTimelineRef = useRef<LegendListRef | null>(null);
  // Per mounted transcript, exactly like the row-stability caches: row ids are
  // chat-scoped, and a memory that outlived its tile would hold heights
  // measured at a width this one may not share.
  // `useState` with a lazy initializer, not a ref: render READS this to hand it
  // to the timeline, and a ref read during render is exactly what
  // `react-hooks/refs` forbids. Same shape as `restoredTabState` above - a
  // value computed once for the mount and never set again.
  const [rowHeightMemory] = useState<ChatTranscriptRowHeightMemory>(() =>
    createChatTranscriptRowHeightMemory(),
  );
  const rowSkeleton = transcriptWindow?.skeleton ?? EMPTY_ROW_SKELETON;
  // The skeleton is how a measured row is matched back to the `byteLength` it
  // was estimated from. A layout effect rather than a render-time call: this
  // writes, and the memory must not be advanced by a render React discards.
  // LegendList measures inside its OWN layout effect, which runs before this
  // one, so the first commit's measurements land before the memory has a
  // skeleton to match them against - `observeSkeleton` back-fills exactly
  // those on its next call, which is what that pass is for.
  useLayoutEffect(() => {
    rowHeightMemory.observeSkeleton(rowSkeleton);
  }, [rowHeightMemory, rowSkeleton]);
  // The effective root font size the rows lay out at - `theme-provider` writes
  // it to `document.documentElement.style.fontSize`, and this is the setting it
  // writes from. Read here rather than via `getComputedStyle` so a change is
  // reactive: the height memory has to be told, and nothing else would.
  const uiFontSize = useSettingsStore((state) => state.uiFontSize);
  const followLatchRef = useRef<ChatTimelineFollowLatch | null>(null);
  const minimapInViewRefreshRef = useRef<() => void>(() => undefined);
  const transcriptContainerRef = useRef<HTMLDivElement>(null);
  // Width AND typography invalidate every remembered height at once - see
  // `observeLayoutBasis`. A ResizeObserver on the container rather than React
  // state, for the reason the memory itself is not state: a resize must not
  // re-render a mounted transcript, and the basis is only wanted as a hint for
  // the placeholders that mount next. A layout effect for the same ordering as
  // the skeleton pass above - LegendList measures in its own, which runs first,
  // so the opening commit's heights are already recorded when the baseline is
  // adopted (and `observeLayoutBasis` deliberately keeps them).
  //
  // `uiFontSize` is a DEPENDENCY, not just a read: changing it re-flows every
  // row without necessarily changing the container's width, so the
  // ResizeObserver may never fire and this effect re-running is the only thing
  // that reports the new basis.
  useLayoutEffect(() => {
    const container = transcriptContainerRef.current;
    if (container === null) return;
    const report = (): void => {
      rowHeightMemory.observeLayoutBasis({
        width: container.getBoundingClientRect().width,
        fontSizePx: uiFontSize,
      });
    };
    const observer = new ResizeObserver(report);
    observer.observe(container);
    report();
    return () => observer.disconnect();
  }, [rowHeightMemory, uiFontSize]);
  const messagesRef = useRef(messages);
  const listRowsRef = useRef(listRows);
  // Seeded EMPTY, not with `buildRowKeyToIndex(listRows)`: a `useRef`
  // argument is evaluated on every render and discarded after the first, and
  // this one is an O(rows) map build per streaming token. Its layout effect
  // populates it before paint. Unlike `listRowsRef`, no descendant layout
  // callback consumes this map, so it does not need insertion-phase freshness.
  const rowIndexByKeyRef = useRef(EMPTY_ROW_INDEX_BY_KEY);
  const scrollRequestRef = useRef(scrollRequest);
  const handledScrollRequestIdRef = useRef<number | null>(null);
  const pendingScrollRequestLandingRef =
    useRef<PendingScrollRequestLanding | null>(null);
  /** The pending request whose landing has been issued at least once. */
  const scrollRequestLandingIssuedRef = useRef<number | null>(null);
  /**
   * Set while `landScrollRequestRow` supersedes its OWN earlier landing of
   * the same request (a `listRows` retry, a hidden→visible re-issue), so the
   * superseded landing's cleanup does not report the request `cancelled`.
   */
  const reissuingScrollRequestIdRef = useRef<number | null>(null);
  const onScrollRequestSettledRef = useRef(onScrollRequestSettled);
  const backgroundToolBlockIdsRef = useRef<ReadonlySet<string>>(
    EMPTY_BACKGROUND_TOOL_BLOCK_IDS,
  );
  // Read only by find's coverage supplier, and through a ref for the same
  // reason `messages` is: the window changes identity on every hydration, and
  // a value dependency would re-register the find adapter each time.
  const transcriptWindowRef = useRef<TranscriptWindow | null>(transcriptWindow);
  // Ticket 5 / decision #18: LegendList's measured header size (the main
  // component of getTopOffsetAdjustment). Capture folds this into the saved
  // viewOffset so initialScrollIndex restore lands on the same pixel - bare
  // positionAtIndex - scroll under-counts by exactly this pad.
  const listTopOffsetAdjustmentRef = useRef(0);
  // The restored reading row (if any) is also the immediately-active minimap
  // row - no need to wait for the async viewport scan to catch up.
  const scrolledActiveUserMessageIdRef = useRef(
    restoredTabState.anchorMessageId,
  );
  const [navigationHighlight, setNavigationHighlight] =
    useState<ChatNavigationHighlightTarget | null>(null);
  const navigationHighlightTimeoutRef = useRef<number | null>(null);
  const getScroller = useCallback(
    (): HTMLElement | null =>
      chatTimelineRef.current?.getScrollableNode() ?? null,
    [],
  );
  const blockReveal = useChatNavigationBlockReveal({
    getScroller,
  });
  const activeNavigationSettleCleanupRef = useRef<(() => void) | null>(null);
  const resolveSuppressedEndLanding = useCallback((): boolean => {
    const resolvePendingEndLanding = resolvePendingRestoreEndLandingRef.current;
    if (
      pendingMeasuredFreeRestoreRef.current === null ||
      resolvePendingEndLanding === null
    ) {
      return false;
    }
    // A partial transcript can clamp the measured bootstrap to its own end.
    // Stop that placeholder restore before its valid/exhausted callbacks
    // normalize durable state. The raw hydration coordinate stays armed
    // unless the frozen issued target proves the reader moved past it.
    activeNavigationSettleCleanupRef.current?.();
    activeNavigationSettleCleanupRef.current = null;
    resolvePendingRestoreEndLandingRef.current = null;
    const isPastTarget = resolvePendingEndLanding();
    pendingMeasuredFreeRestoreRef.current = null;
    return isPastTarget;
  }, []);
  // Native smooth scrolling outlives the JavaScript call that starts it. Track
  // the exact animated imperative operation that currently owns that motion
  // so a physical reader gesture can freeze it without issuing disruptive
  // same-offset writes during ordinary, already-settled follow mode. A
  // generation token prevents an older settle callback from clearing a newer
  // overlapping operation's ownership.
  const imperativeScrollGenerationRef = useRef(0);
  const activeAnimatedImperativeScrollGenerationRef = useRef<number | null>(
    null,
  );
  const beginImperativeScrollOperation = useCallback(
    (animated: boolean): number => {
      const generation = imperativeScrollGenerationRef.current + 1;
      imperativeScrollGenerationRef.current = generation;
      activeAnimatedImperativeScrollGenerationRef.current = animated
        ? generation
        : null;
      return generation;
    },
    [],
  );
  const finishImperativeScrollOperation = useCallback(
    (generation: number): void => {
      if (activeAnimatedImperativeScrollGenerationRef.current === generation) {
        activeAnimatedImperativeScrollGenerationRef.current = null;
      }
    },
    [],
  );
  const persistCurrentScrollRef = useRef<() => void>(() => undefined);
  const clearNavigationHighlight = useCallback((): void => {
    if (navigationHighlightTimeoutRef.current !== null) {
      window.clearTimeout(navigationHighlightTimeoutRef.current);
      navigationHighlightTimeoutRef.current = null;
    }
    blockReveal.clearReveal();
    setNavigationHighlight(null);
  }, [blockReveal]);
  const showNavigationHighlight = useCallback(
    (messageId: string, blockId: string | null): void => {
      if (navigationHighlightTimeoutRef.current !== null) {
        window.clearTimeout(navigationHighlightTimeoutRef.current);
      }
      setNavigationHighlight({ messageId, blockId });
      navigationHighlightTimeoutRef.current = window.setTimeout(() => {
        navigationHighlightTimeoutRef.current = null;
        blockReveal.clearReveal();
        setNavigationHighlight(null);
      }, CHAT_NAVIGATION_HIGHLIGHT_DURATION_MS);
    },
    [blockReveal],
  );
  useEffect(
    () => () => {
      if (navigationHighlightTimeoutRef.current !== null) {
        window.clearTimeout(navigationHighlightTimeoutRef.current);
      }
      activeNavigationSettleCleanupRef.current?.();
      activeAnimatedImperativeScrollGenerationRef.current = null;
    },
    [],
  );

  // --- Follow-vs-free scroll state (behavior contract: one edge, one rule) --
  //
  // Bottom permission is geometry, not a mode machine: `scrollMode` and
  // `isAtEndRef` are render/persistence mirrors of the latch's fresh-DOM
  // strict edge (the library's same 1px epsilon). Transient correction and
  // explicit-navigation ownership live only inside that latch.
  const initialIsAtEnd = restoredTabState.mode === "following-end";
  const [initialScrollAtEnd] = useState(initialIsAtEnd);
  const initialScrollMode: ChatTimelineScrollMode = initialIsAtEnd
    ? "following-end"
    : "free-scrolling";
  const timelineScrollModeRef =
    useRef<ChatTimelineScrollMode>(initialScrollMode);
  // The one ref every imperative callback reads/writes synchronously;
  // `scrollMode` below is purely a render-time mirror of it.
  const isAtEndRef = useRef(initialIsAtEnd);
  // A generation bump marks any in-flight settle/navigation loop (explicit
  // navigation, restoration convergence) superseded - decoupled from follow
  // ownership, which no longer exists as a separate concept.
  const anchorUserScrollGenerationRef = useRef(0);
  // Persistence is a publication step, not an unmount side effect that may
  // sample arbitrary bootstrap geometry. Until a saved pixel restore
  // validates, the cache entry read at mount remains the authoritative reader
  // state. This is essential under Strict Mode and rapid canvas switches: an
  // intermediate mount can unmount while Legend List is still unmeasured.
  const restorePersistencePendingRef = useRef(
    savedRestoreRequiresPersistenceGate(rawSavedTabState),
  );
  // A restored free-reading chat can briefly report measurable strict-bottom
  // geometry when a hidden task canvas becomes visible, before LegendList has
  // reinflated its rows and applied the saved anchor. Maintenance callbacks in
  // that window are bootstrap layout, not evidence that the reader returned to
  // the tail. Keep follow reconciliation suppressed until the saved landing is
  // validated, as well as during the narrower partial-hydration transaction.
  const isFollowCorrectionSuppressed = useCallback(
    (): boolean =>
      restorePersistencePendingRef.current ||
      pendingHydrationRestoreAnchorIdRef.current !== null,
    [],
  );
  // Fixup (fix-top-level-task-tab-scroll-restoration): continuously mirrors
  // the last KNOWN-COHERENT scroll snapshot while the DOM is genuinely
  // measurable (kept fresh by the rAF-throttled viewport update below, same
  // cadence as `scrolledActiveUserMessageIdRef`). A top-level pane hide
  // zeroes this tile's scroll container's measured geometry in the SAME
  // commit as the `visible` prop flipping false - a hide-time read would
  // already observe zeroed geometry, so the visibility-handoff effect
  // publishes THIS ref's last-good value instead of reading live DOM at
  // that moment. See `hooks/scroll/use-scroll-restoration.ts`'s doc comment
  // for the same hazard already solved this way for other tile kinds.
  const lastVisibleScrollSnapshotRef = useRef<Omit<
    SaveChatTabStateInput,
    "identity"
  > | null>(null);
  // Mirrors `timelineScrollModeRef.current` into render - the pill formula
  // and `data-scroll-mode` derive from this single value. The ref above
  // stays the authoritative value every imperative callback reads/writes
  // synchronously; this is purely a render-time mirror of it.
  const [scrollMode, setScrollMode] =
    useState<ChatTimelineScrollMode>(initialScrollMode);
  const [showScrollToBottom, setShowScrollToBottom] = useState(!initialIsAtEnd);
  // A turn completed while the reader was away from the tail and they have
  // not returned since - drives the pill's "New reply" state. Reset on
  // returning to the tail.
  const [hasUnseenTurnCompletion, setHasUnseenTurnCompletion] = useState(false);
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

  // `releasePersistenceGate` decouples "publish following-end" from "the
  // saved coordinate is resolved" (fixup: hydration-transaction). A temporary
  // landing at the strict edge while `pendingHydrationRestoreAnchorIdRef` is
  // still unresolved is not reader intent and must not release the
  // persistence gate - every caller that already represents a real gesture
  // or explicit navigation passes `true` (their own code already cleared the
  // pending id before reaching here, or never gated it in the first place).
  const setTimelineMode = useCallback(
    (next: ChatTimelineScrollMode, releasePersistenceGate: boolean): void => {
      followLatchRef.current?.setFollowIntent(next === "following-end");
      timelineScrollModeRef.current = next;
      isAtEndRef.current = next === "following-end";
      if (next === "following-end") {
        if (releasePersistenceGate) {
          restorePersistencePendingRef.current = false;
        }
        if (pendingHydrationRestoreAnchorIdRef.current === null) {
          pendingMeasuredFreeRestoreRef.current = null;
        }
        setShowScrollToBottom(false);
        // Reaching the tail "sees" everything.
        setHasUnseenTurnCompletion(false);
      }
      setScrollMode(next);
    },
    [],
  );

  // Geometry-only mode reconciliation - the sole caller is the latch's
  // strict-end intent report. Must NOT clear `pendingHydrationRestoreAnchorIdRef`:
  // a temporary hydration-clamp restore landing at the current (still
  // partial) end reports the same `isAtEnd=true` as a genuine reader
  // reaching the tail, but is not reader intent and must not discard an
  // unresolved saved coordinate. That ref is cleared only by an actual
  // reader gesture or explicit navigation (`cancelTimelineLiveFollowForUser
  // Navigation`'s `publishesReaderPosition` branch, `navigateToMessage`,
  // `cancelManualNavigationForFind`) or once the hydration-retry effect
  // itself resolves the coordinate. Same reasoning gates the persistence
  // release below: a passive geometry report must not publish the temporary
  // tail as durably authoritative while that coordinate is still pending.
  const setFollowingEndFromTimelinePosition = useCallback((): void => {
    if (pendingHydrationRestoreAnchorIdRef.current !== null) {
      resolveSuppressedEndLanding();
    }
    if (pendingHydrationRestoreAnchorIdRef.current !== null) {
      setTimelineMode("free-scrolling", false);
      setShowScrollToBottom(true);
      return;
    }
    setTimelineMode("following-end", true);
  }, [resolveSuppressedEndLanding, setTimelineMode]);

  // Decision #6/#5/#7: reader input freezes an in-flight native smooth-scroll
  // and re-syncs ownership against the actual physical position. Transcript
  // pointerdown is a preflight because a disclosure click can resize content
  // without publishing a reading position; wheel/touch/keyboard and scrollbar
  // input publish, so their subsequent scroll report may detach the latch.
  const handleTimelineReaderGesture = useCallback(
    ({
      freezeInFlightScroll,
      publishesReaderPosition,
    }: ChatTimelineReaderGestureIntent): void => {
      clearNavigationHighlight();
      const hadActiveAnimatedImperativeScroll =
        activeAnimatedImperativeScrollGenerationRef.current !== null;
      // This cancel supersedes the operation immediately. Its eventual settle
      // callback is generation-guarded and cannot clear ownership belonging
      // to a newer operation.
      activeAnimatedImperativeScrollGenerationRef.current = null;
      anchorUserScrollGenerationRef.current += 1;
      // A bare pointer preflight is not yet a published reading position.
      // Keep the measured restore target armed so a subsequent strict-bottom
      // landing can still prove it moved past that frozen target atomically.
      // Explicit navigation has already cleared the hydration id before it
      // reaches here, while wheel/touch/keyboard publish immediately.
      if (
        publishesReaderPosition ||
        pendingHydrationRestoreAnchorIdRef.current === null
      ) {
        pendingMeasuredFreeRestoreRef.current = null;
      }
      if (publishesReaderPosition) {
        pendingHydrationRestoreAnchorIdRef.current = null;
        forgetPendingHydrationRestore(identity);
        restorePersistencePendingRef.current = false;
      }
      // A preflight is not a departure. The latch remains authoritative and
      // publishes a mode change only after the gesture/navigation produces a
      // measurable scroll, so a disclosure click cannot detach a reader and
      // an owned under-landing cannot be mistaken for reader motion.
      // A real gesture (or a fresh navigation, which calls this first) wins
      // immediately over a still-in-flight programmatic-scroll operation,
      // regardless of what that operation was in the middle of doing.
      // `freezeInFlightScroll` additionally cancels the browser's native
      // smooth-scroll animation in place. Every real reader gesture passes
      // `true`; only programmatic navigation that immediately replaces the
      // operation with its own scroll passes `false`.
      if (freezeInFlightScroll && hadActiveAnimatedImperativeScroll) {
        const list = chatTimelineRef.current;
        const currentScroll = list?.getScrollableNode().scrollTop;
        if (list && typeof currentScroll === "number") {
          void list.scrollToOffset({ offset: currentScroll, animated: false });
        }
      }
    },
    [clearNavigationHighlight, identity],
  );
  const cancelTimelineLiveFollowForUserNavigation = useCallback(
    (intent: ChatTimelineReaderGestureIntent): void => {
      const followLatch = followLatchRef.current;
      if (followLatch) {
        followLatch.noteReaderGesture(intent);
      } else {
        handleTimelineReaderGesture(intent);
      }
    },
    [handleTimelineReaderGesture],
  );
  const handleTranscriptPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      // Inline artifact/A2A navigation starts with pointerdown and can unmount
      // this tile before a later passive scroll snapshot runs. Capture the
      // exact source viewport synchronously, before cancellation changes mode.
      persistCurrentScrollRef.current();
      const scrollNode = chatTimelineRef.current?.getScrollableNode();
      // A disclosure/card click is only a correction-cancelling preflight: its
      // ensuing ResizeObserver/MVCP movement is layout-owned and must not
      // detach follow. Pointer input targeting the scroll node itself is the
      // scrollbar interaction shape; it publishes the ensuing scroll position.
      const publishesReaderPosition = event.target === scrollNode;
      cancelTimelineLiveFollowForUserNavigation({
        direction: "indeterminate",
        freezeInFlightScroll: true,
        publishesReaderPosition,
      });
    },
    [cancelTimelineLiveFollowForUserNavigation],
  );

  // ChatTimeline unmounts LegendList entirely for an empty transcript
  // (ChatEmptyState instead), so this - not just `messages` identity - is
  // the signal that tracks whether a real scroll node can exist right now.
  const hasContent = listRows.length > 0;
  const endInset = composerOverlayHeight;

  const reconcileInvalidTimelineLanding = useCallback((): void => {
    setTimelineMode("free-scrolling", true);
    setShowScrollToBottom(true);
  }, [setTimelineMode]);

  // scrollToEnd reset (pill click / any future explicit "go live" action).
  // Ticket 10: this is an explicit user action - the `setTimelineMode`
  // call below is decision-sanctioned and unconditional, same as before;
  // the settle/re-issue only corrects the LANDING it produces, never
  // re-decides whether the click counts as "following". Pill action is an
  // explicit supersession (fixup: hydration-transaction), so the pending
  // hydration id is cleared above and the gate always releases.
  const scrollToEnd = useCallback(
    (animated: boolean): void => {
      activeNavigationSettleCleanupRef.current?.();
      activeNavigationSettleCleanupRef.current = null;
      clearNavigationHighlight();
      pendingHydrationRestoreAnchorIdRef.current = null;
      forgetPendingHydrationRestore(identity);
      setTimelineMode("following-end", true);
      const generationAtIssue = anchorUserScrollGenerationRef.current;
      const list = chatTimelineRef.current;
      if (!list) return;
      const imperativeScrollGeneration =
        beginImperativeScrollOperation(animated);
      followLatchRef.current?.beginOwnedEndNavigation();
      void list.scrollToEnd({ animated });
      const scrollNode = list.getScrollableNode();
      activeNavigationSettleCleanupRef.current = settleChatTimelineNavigation({
        awaitSettle: (onSettle) =>
          awaitScrollSettle(
            scrollNode,
            onSettle,
            CHAT_ANCHOR_SETTLE_FALLBACK_MS,
          ),
        isAborted: () =>
          anchorUserScrollGenerationRef.current !== generationAtIssue,
        // The pill-click "go live" path has no reader-departure detection of
        // its own - a real gesture already bumps the generation and is
        // caught by `isAborted` above.
        shouldYieldToReader: () => false,
        validate: () => followLatchRef.current?.isAtStrictEnd() === true,
        reissue: () => {
          finishImperativeScrollOperation(imperativeScrollGeneration);
          followLatchRef.current?.beginOwnedEndNavigation();
          void list.scrollToEnd({ animated: false });
        },
        onSettledValid: () => {
          finishImperativeScrollOperation(imperativeScrollGeneration);
          followLatchRef.current?.completeOwnedEndNavigation(true);
        },
        // Ticket 10: free-scrolling with the pill visible beats silently
        // claiming ownership from an invalid landing.
        onSettledInvalid: () => {
          finishImperativeScrollOperation(imperativeScrollGeneration);
          followLatchRef.current?.completeOwnedEndNavigation(false);
          reconcileInvalidTimelineLanding();
        },
        maxRetries: CHAT_TIMELINE_NAVIGATION_MAX_RETRIES,
      });
    },
    [
      beginImperativeScrollOperation,
      clearNavigationHighlight,
      finishImperativeScrollOperation,
      identity,
      reconcileInvalidTimelineLanding,
      setTimelineMode,
    ],
  );

  // Render/persistence mirror of the latch's ONE live follow authority.
  // LegendList's cached `isAtEnd` never writes this state.
  const onFollowIntentChange = useCallback(
    (isFollowing: boolean): void => {
      // Cross-check the rendered mode, not just the cached ref, before
      // taking the fast path: `setTimelineMode` always keeps both in sync,
      // but this guards against any future path that could otherwise leave
      // them briefly out of step (behavior contract: an equality fast path
      // must never let `{mode: free-scrolling, isAtEnd: true}` stand).
      const modeAlreadyMatches =
        (timelineScrollModeRef.current === "following-end") === isFollowing;
      if (isAtEndRef.current === isFollowing && modeAlreadyMatches) return;
      if (isFollowing) {
        setFollowingEndFromTimelinePosition();
      } else {
        // Fixup (remove-passive-supersession): a following-to-free
        // transition is NOT necessarily reader intent - it is also the
        // expected geometry of the hydration catch-up's OWN programmatic
        // scroll away from a temporary tail landing, reported via the
        // browser `scroll` event BEFORE that operation's bounded settle has
        // validated (`restorePersistedTimelineLocation`). Clearing the
        // pending coordinate here would resolve the transaction before
        // validation and defeat the whole point of routing hydration
        // catch-up through a validated retry. Bare edge geometry must never
        // supersede - only a validated landing or a recognized reader/
        // explicit-navigation path (their own direct clears) may.
        setTimelineMode("free-scrolling", true);
        setShowScrollToBottom(true);
      }
    },
    [setFollowingEndFromTimelinePosition, setTimelineMode],
  );

  // --- Keyboard scrolling (existing window-level claiming survives) ---------

  const handleKeyDownCapture = useCallback(
    (event: globalThis.KeyboardEvent): void => {
      const scroller = chatTimelineRef.current?.getScrollableNode();
      if (!scroller) return;
      const scrollAction = chatKeyboardScrollAction(event);
      if (scrollAction === null) return;
      event.preventDefault();
      event.stopPropagation();
      // Freeze an owned native smooth-scroll at its current pixel first, then
      // apply this key's deterministic step as the replacement movement. The
      // resulting native `scroll` event is what determines follow, via
      // the latch's geometry observer - no separate reattach check needed here.
      cancelTimelineLiveFollowForUserNavigation({
        direction:
          scrollAction === "page-down" ||
          scrollAction === "line-down" ||
          scrollAction === "bottom"
            ? "toward-end"
            : "away-from-end",
        freezeInFlightScroll: true,
        publishesReaderPosition: true,
      });
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
    transcriptWindowRef.current = transcriptWindow;
  }, [messages, transcriptWindow]);

  useInsertionEffect(() => {
    listRowsRef.current = listRows;
  }, [listRows]);

  useLayoutEffect(() => {
    rowIndexByKeyRef.current = buildRowKeyToIndex(listRows);
  }, [listRows]);

  useLayoutEffect(() => {
    scrollRequestRef.current = scrollRequest;
  }, [scrollRequest]);

  useLayoutEffect(() => {
    onScrollRequestSettledRef.current = onScrollRequestSettled;
  }, [onScrollRequestSettled]);

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

  // Ticket 20: the coherent-snapshot capture used by BOTH this component's
  // own unmount-cleanup save below AND the pre-structural-mutation viewport
  // handoff (`chat-tab-viewport-handoff.ts`) a canvas-store action creator
  // flushes just before a drag/split-wrap/dissolve/tear-off commits a move
  // that retains this SAME instanceId under a NEW React parent. Without the
  // proactive flush, React would mount the replacement fiber's
  // `restoreChatTabState` render-time state initializer BEFORE this
  // component's own unmount cleanup ever runs - render happens before ANY
  // commit-phase effect, including a removed fiber's layout-effect cleanup
  // (painted-chat lifecycle audit finding 1: a disposable probe recorded
  // `initialize:stale` then `cleanup:fresh`). One function backs both call
  // sites so the coherent-snapshot invariant below can never drift into two
  // independently maintained copies.
  const captureLiveChatTabScrollSnapshot = useCallback((): Omit<
    SaveChatTabStateInput,
    "identity"
  > | null => {
    if (restorePersistencePendingRef.current) return null;
    const mode = resolvePersistedChatTabScrollMode(
      timelineScrollModeRef.current,
    );
    const list = chatTimelineRef.current;
    // Ticket 15 review (live pass S5 round 3, confirmed regression):
    // `scrolledActiveUserMessageIdRef` is an rAF-throttled mirror
    // (`scheduleActiveViewportUpdate`) of "which row is at the reading
    // line" - it can lag a scroll that happened in the same tick as this
    // capture (rAF never runs for a backgrounded/closing tab, but the race
    // exists in a visible renderer too: scroll then close/move before the
    // pending frame). The offset captured below reads the CURRENT live
    // `scroll` unconditionally - pairing that with a STALE anchor row
    // produces an internally-inconsistent {anchorMessageId, anchorIndex,
    // offset} triple (a huge/negative offset relative to the wrong row),
    // which restore then clamps to nonsense. Recompute the anchor row
    // SYNCHRONOUSLY from the SAME live list snapshot the offset capture
    // below reads, so both halves of the pair are drawn from one
    // coherent, never-mixed-time snapshot - restoring the invariant the
    // pre-LegendList `chat-scroll-state-cache.ts` `saveChatScrollState`
    // documented ("captures any reading position the last animation-frame
    // update had not yet committed"). The rAF mirror is only a fallback
    // for when the list itself is unmeasurable (never mounted a real
    // LegendList instance, or genuinely reports nothing yet).
    //
    // `list.getState().scroll` is ITSELF a candidate for the same class
    // of lag (its own doc comment two blocks below: "LegendList's tracked
    // scroll can lag the DOM while an animated navigation is still
    // settling") - overridden here with `getScrollableNode().scrollTop`
    // (the RAW, always-current DOM value, same source the offset capture
    // below uses) so the anchor computation cannot reintroduce a mismatch
    // through LegendList's own internal state lagging instead of React's.
    const liveViewportAnchorMessageId =
      list === null
        ? null
        : viewportAnchorRowKey(
            {
              ...list.getState(),
              scroll: list.getScrollableNode().scrollTop,
              topOffsetAdjustment: listTopOffsetAdjustmentRef.current,
            },
            listRowsRef.current,
          );
    const resolvedAnchorMessageId =
      mode === "free-scrolling"
        ? (liveViewportAnchorMessageId ??
          scrolledActiveUserMessageIdRef.current)
        : null;
    // A placeholder the skeleton has not described yet has a SYNTHESIZED key -
    // an ordinal, with no row identity and no epoch (`isUnplacedRowKey`). It is
    // fine to scroll by and useless to persist: reindex the transcript before
    // the tab is reopened and that same key names a different row, which
    // `restoreChatTabState` accepts as an exact match and restores to. Saving
    // no anchor at all is the better answer - restore falls back to the offset
    // and to its pending-hydration correction, both of which are built for
    // "the anchor is not resolvable yet".
    const anchorMessageId =
      resolvedAnchorMessageId !== null &&
      isUnplacedRowKey(resolvedAnchorMessageId)
        ? null
        : resolvedAnchorMessageId;
    const anchorIndex =
      anchorMessageId === null
        ? undefined
        : rowIndexByKeyRef.current.get(anchorMessageId);
    // Narrow measurement source so capture can fold in the live header pad
    // (list.getState() does not expose headerSize; metrics keep it current).
    const measurementSource =
      list === null
        ? null
        : {
            getState: () => ({
              positionAtIndex: (index: number) =>
                list.getState().positionAtIndex(index),
              // LegendList's tracked scroll can lag the DOM while an
              // animated navigation is still settling. Persist the pixels
              // the reader can actually see right now; row positions still
              // come from the library's measured state.
              scroll: list.getScrollableNode().scrollTop,
              topOffsetAdjustment: listTopOffsetAdjustmentRef.current,
            }),
          };
    return {
      mode,
      anchorMessageId,
      anchorIndex: anchorIndex ?? null,
      offset: captureChatFreeScrollingOffset(measurementSource, anchorIndex),
    };
  }, []);

  // Persist the reading position on unmount and synchronously on transcript
  // pointerdown. This tile can still be unmounted without warning (evicted past
  // its pane's chat retention cap or with its top-level surface, closed, or its
  // hosted eligibility flipped - no longer merely an inner tab switch), and
  // inline artifact/A2A navigation can hand control to browser history in the
  // same interaction; the eager capture guarantees Back observes the source
  // viewport even if unmount ordering changes. The unmount capture remains
  // authoritative and overwrites it whenever a later position exists.
  //
  // Liveness-guarded (ticket 5; ticket-15 review round F1): a permanent tab
  // close removes the tile from the canvas FIRST, synchronously - which
  // fires the canvas store's tile-removal subscriber that evicts the
  // tab-key entry - before this unmount cleanup runs, so
  // `isEpicCanvasTileInstanceLive` already reads false by the time we get
  // here. Writing the tab-key unconditionally would resurrect the entry
  // that sweep just cleared (mirrors `use-scroll-restoration.ts`'s
  // `commitIfTileLive` guard) - but skipping the save ENTIRELY on a
  // non-live unmount was the bug: it is the field symptom's actual trigger,
  // since a genuine direct close (no prior switch-away) then wrote NOTHING
  // anywhere, and a reopen either got no saved state or - worse - a STALE
  // durable entry from some earlier session. Live -> `saveChatTabState`
  // (both keys, tab-key legitimately restores a same-instanceId remount).
  // Not live -> `commitChatTabStateToDurable` (durable only - this is the
  // one and only chance this closing view's position reaches durable
  // storage at all).
  useLayoutEffect(() => {
    const persistCurrentScroll = (): void => {
      const isLive = isEpicCanvasTileInstanceLive(instanceId);
      if (restorePersistencePendingRef.current) {
        // A live tab already has both cache entries that this mount read. Do
        // not overwrite them from a transient bootstrap viewport. A permanent
        // close may have synchronously evicted the tab entry before cleanup;
        // re-commit the pre-restore snapshot to the durable key in that case.
        if (!isLive && rawSavedTabState !== null) {
          commitChatTabStateToDurable({ identity, ...rawSavedTabState });
        }
        return;
      }
      // Fixup (hidden-close-and-rapid-capture, P1): a still-mounted tile
      // whose top-level pane is currently hidden/zero-sized (concealed via
      // the geometry coordinator, not unmounted) reports zeroed geometry
      // here just like it would to any other live read - sampling it would
      // overwrite the already-published `lastVisibleScrollSnapshotRef`
      // value (published by the visibility-handoff effect on the earlier
      // hide transition) with row-zero/clamped garbage. Fall back to that
      // already-known-good mirror instead of a live read whenever the
      // surface cannot be measured right now.
      const list = chatTimelineRef.current;
      const scrollableNode =
        list === null ? null : getScrollableNodeOrNull(list);
      const isMeasurable =
        scrollableNode !== null && scrollableNode.clientHeight !== 0;
      const snapshot = isMeasurable
        ? captureLiveChatTabScrollSnapshot()
        : lastVisibleScrollSnapshotRef.current;
      if (snapshot === null) return;
      const commit = isLive ? saveChatTabState : commitChatTabStateToDurable;
      commit({ identity, ...snapshot });
    };
    persistCurrentScrollRef.current = persistCurrentScroll;
    return (): void => {
      if (persistCurrentScrollRef.current === persistCurrentScroll) {
        persistCurrentScrollRef.current = () => undefined;
      }
      persistCurrentScroll();
    };
  }, [
    captureLiveChatTabScrollSnapshot,
    identity,
    instanceId,
    rawSavedTabState,
  ]);

  // Structural moves can mount the replacement fiber before this fiber's
  // unmount cleanup. Publish the same coherent snapshot synchronously so the
  // replacement restores current geometry, while the restore gate still
  // rejects transient bootstrap measurements.
  useLayoutEffect(
    () =>
      registerChatTabViewportCapture(
        instanceId,
        () => {
          const snapshot = captureLiveChatTabScrollSnapshot();
          if (snapshot !== null) {
            saveChatTabState({ identity, ...snapshot });
          }
        },
        readingPositionIdentityForChat(identity),
      ),
    [captureLiveChatTabScrollSnapshot, identity, instanceId],
  );

  const onListMetricsChange = useCallback(
    (metrics: { readonly headerSize: number }): void => {
      // Chat timeline does not set stylePaddingTop / alignItemsAtEndPadding, so
      // headerSize alone is the getTopOffsetAdjustment pad that restore re-adds.
      listTopOffsetAdjustmentRef.current = metrics.headerSize;
    },
    [],
  );
  const onTimelineItemSizeChanged = useCallback((): void => {
    minimapInViewRefreshRef.current();
  }, []);

  // Quote-to-composer: track selections inside the transcript wrapper below and
  // surface the floating quote button. The hook attaches no listeners while the
  // setting is off, so a disabled affordance costs nothing.
  const quoteReplyEnabled = useSettingsStore(
    (state) => state.quoteReplyEnabled,
  );
  const chatTurnMinimapSide = useLayoutSetting("chatTurnMinimapSide");
  const isMobileViewport = useIsMobileViewport();
  const coarsePointer = useCoarsePointer();
  const minimapDrawn =
    hasContent &&
    shouldRunChatTurnMinimapRail({
      side: chatTurnMinimapSide,
      coarsePointer,
      mobileViewport: isMobileViewport,
    });
  let minimapCondition: string | null = null;
  if (!hasContent) minimapCondition = "No messages yet";
  if (coarsePointer)
    minimapCondition = "Minimap is unavailable with a coarse pointer";
  if (chatTurnMinimapSide === "hide") minimapCondition = "Hidden";
  const { ref: minimapHotspotRef, editing: minimapEditing } = useLayoutHotspot({
    settingId: "chat.minimapSide",
    tileId: taskId,
    ghost: !minimapDrawn,
    condition: minimapCondition,
  });
  const quoteSelection = useQuoteSelection({
    containerRef: transcriptContainerRef,
    enabled: quoteReplyEnabled && visible && !systemOverlayActive,
  });

  // Ticket 5: registry-backed, keyed by tile instance id, so expanded
  // activity groups survive a remount of this SAME instance - retention-cap or
  // top-level eviction, or a hosted-eligibility flip; no longer an inner tab
  // switch (decision #17 was reversed by pane chat retention) - and are evicted
  // when the tab permanently closes (canvas store's tile-removal subscriber),
  // never on a mere remount. A reopen is a new instance, not a revival.
  //
  // Ticket 15 review round 3: no longer commits to durable on its own
  // unmount - see the matching comment on `a2aOpenStore` above.
  const [activityGroupOpenStore] = useState(() =>
    getOrCreateActivityGroupOpenStore(identity),
  );

  // Ticket 15 (decision #29): dual-keys the global tool/subagent open
  // stores for this tab - seeds this tab's expanded cards from the durable
  // chat-key snapshot on a genuinely fresh (never-initialized) scope only.
  // Round 3: the durable commit moved to the canvas sweep's promotion
  // choke point - see the hook's own doc comment.
  useChatScopedOpenStoreDualKeySeed(
    useToolOpenStore,
    identity,
    toolOpenDurableCache,
    toolOpenInitializedScopes,
  );
  useChatScopedOpenStoreDualKeySeed(
    useSubagentOpenStore,
    identity,
    subagentOpenDurableCache,
    subagentOpenInitializedScopes,
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
          listRows,
          messages,
        );
        if (nextActiveUserMessageId !== null) {
          setScrolledActiveUserMessageIdIfChanged(nextActiveUserMessageId);
        }
      },
      [listRows, messages, setScrolledActiveUserMessageIdIfChanged],
    ),
  );

  // Fixup (hidden-close-and-rapid-capture, P1): must run SYNCHRONOUSLY inside
  // the scroll event handler, never rAF-throttled. A reader who scrolls then
  // immediately switches away hides the pane in the SAME tick the scroll
  // event was dispatched - a throttled capture scheduled for the next frame
  // never runs before the hide-time effect below reads the mirror, which
  // would publish the previous (stale) position instead of the new one.
  const captureLastVisibleScrollSnapshot = useCallback((): void => {
    const list = chatTimelineRef.current;
    // A concealed container reports a zero-height box; ignore so a
    // hidden-state read never clobbers the last known-good snapshot
    // (same guard `use-native-div-scroll-restoration.ts` uses).
    if (list === null || list.getScrollableNode().clientHeight === 0) {
      return;
    }
    const snapshot = captureLiveChatTabScrollSnapshot();
    if (snapshot !== null) {
      lastVisibleScrollSnapshotRef.current = snapshot;
    }
  }, [captureLiveChatTabScrollSnapshot]);

  const handleScroll = useCallback((): void => {
    // O2 (ticket 16 listener consolidation): drives the minimap's in-view highlighting
    // off THIS existing LegendList scroll callback instead of a second
    // scroll-listener lifecycle the minimap used to attach itself
    // (rAF-polling attach + native listener + detach). Called unconditionally,
    // ahead of the `visible` early-return below - the minimap's own previous
    // native listener never gated on this component's `visible` prop either,
    // and there is no reason a background/not-yet-selected tile's scroll
    // (e.g. a still-settling restore) should leave its in-view dots stale.
    minimapInViewRefreshRef.current();
    if (!visible) return;
    scheduleActiveViewportUpdate(
      timelineScrollModeRef.current === "following-end",
    );
    captureLastVisibleScrollSnapshot();
  }, [captureLastVisibleScrollSnapshot, scheduleActiveViewportUpdate, visible]);

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

  // Explicit navigation (find/minimap/deep-link/restoration) is programmatic,
  // not a gesture. It declares a free-scrolling destination before moving;
  // a landing at the strict bottom resumes follow through the latch's ordinary
  // strict-end report. Bare scrollTop direction is never used as intent
  // because MVCP and layout compensation produce the same browser signal.
  //
  // Ticket 10: settle/re-issue against the CURRENT geometry - an ANIMATED
  // long jump targets ESTIMATED heights; no mid-flight retargeting in the
  // installed LegendList.
  //
  // `afterSettle` runs once the ROW landing is done (valid or exhausted), so
  // a block-level `scrollIntoView` cannot fight the 1px row-top re-issue.
  // Find passes `null`; `navigateToMessage` requests the inner reveal here.
  const issueFreeTimelineNavigation = useCallback(
    (
      location: ChatTimelineNavigationLocation,
      afterSettle: (() => void) | null,
    ): void => {
      activeNavigationSettleCleanupRef.current?.();
      const generationAtIssue = anchorUserScrollGenerationRef.current;
      const list = chatTimelineRef.current;
      if (!list) return;
      followLatchRef.current?.beginOwnedFreeNavigation();
      const imperativeScrollGeneration = beginImperativeScrollOperation(
        location.animated,
      );
      scrollToTimelineLocation(location);
      const scrollNode = list.getScrollableNode();
      const finishFreeNavigation = (): void => {
        finishImperativeScrollOperation(imperativeScrollGeneration);
        followLatchRef.current?.completeOwnedFreeNavigation();
        afterSettle?.();
      };
      activeNavigationSettleCleanupRef.current = settleChatTimelineNavigation({
        awaitSettle: (onSettle) =>
          awaitScrollSettle(
            scrollNode,
            onSettle,
            CHAT_ANCHOR_SETTLE_FALLBACK_MS,
          ),
        isAborted: () =>
          anchorUserScrollGenerationRef.current !== generationAtIssue,
        // No reader-departure detection here - a real gesture already bumps
        // the generation and is caught above.
        shouldYieldToReader: () => false,
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
          finishImperativeScrollOperation(imperativeScrollGeneration);
          void list.scrollToIndex({
            index: location.index,
            animated: false,
            viewPosition: 0,
            viewOffset: location.viewOffset,
          });
        },
        onSettledValid: () => {
          finishFreeNavigation();
          restorePersistencePendingRef.current = false;
        },
        onSettledInvalid: () => {
          finishFreeNavigation();
          acceptExhaustedPersistedRestoreFallback(
            restorePersistencePendingRef,
            pendingMeasuredFreeRestoreRef,
          );
          // Accept - already correctly free-scrolling/suppressed wherever
          // the bounded retries landed; nothing claims to be "at this exact
          // spot" the way following-end does, so there is no mode to
          // reconcile.
        },
        maxRetries: CHAT_TIMELINE_NAVIGATION_MAX_RETRIES,
      });
    },
    [
      beginImperativeScrollOperation,
      finishImperativeScrollOperation,
      scrollToTimelineLocation,
    ],
  );

  const scrollToTimelineLocationSuppressingFollowRestore = useCallback(
    (location: ChatTimelineNavigationLocation): void => {
      issueFreeTimelineNavigation(location, null);
    },
    [issueFreeTimelineNavigation],
  );

  // Ticket 20 (no-visible-traversal requirement): `animated` is an explicit
  // caller intent, not a hardcoded constant - minimap/deep-link navigation
  // (this function's other two callers below) are real (if programmatic)
  // user-triggered jumps, animated by design (decision #21's "manual-
  // navigation cancellation" framing already treats them as navigations the
  // reader should perceive happening). Find does NOT go through this
  // function at all - `use-chat-find-controller.ts`'s own
  // `scrollToMessageForFind` independently builds its location with
  // `animated: false` already, unchanged by this ticket. The late-hydration
  // catch-up effect below is different from either: it is a RESTORE landing
  // where the transcript simply grew to finally contain a position already
  // decided at mount, not a fresh navigation the reader initiated - it must
  // reposition in a single frame like any other mount-time restore, never
  // visibly scroll/animate to get there.
  /**
   * Restoration is a measured convergence operation, not a one-shot index
   * guess. LegendList's mount bootstrap gives the first paint a useful seed;
   * this pass validates the exact row + pixel offset after measurements and
   * reissues the same semantic target, bounded, if geometry moved underneath
   * it. A reader gesture bumps the shared generation and wins immediately.
   *
   * `isAborted`/`onValidated`/`onExhausted` are caller-supplied (fixup:
   * hydration-transaction) because the two callers below need different
   * failure policy: the reserve-convergence caller (below) accepts the
   * browser-clamped landing as its new fallback truth on exhaustion, while
   * the late-hydration catch-up caller must instead retain the original
   * coordinate and persistence gate so a later eligible retry can still
   * land it - only a validated success may resolve that one. `onValidated`
   * runs only after the shared success bookkeeping below.
   */
  const restorePersistedTimelineLocation = useCallback(
    (
      messageId: string,
      viewOffset: number,
      policy: {
        readonly isAborted: () => boolean;
        readonly onValidated: () => void;
        readonly onExhausted: () => void;
      },
    ): boolean => {
      const { isAborted, onValidated, onExhausted } = policy;
      const list = chatTimelineRef.current;
      const initialIndex = rowIndexByKeyRef.current.get(messageId);
      if (!list || initialIndex === undefined) return false;

      activeNavigationSettleCleanupRef.current?.();
      const generationAtIssue = anchorUserScrollGenerationRef.current;
      const scrollNode = list.getScrollableNode();
      const targetIndex = (): number | null =>
        rowIndexByKeyRef.current.get(messageId) ?? null;
      const landedAtSavedLocation = (): boolean => {
        const index = targetIndex();
        if (index === null) return false;
        return chatTimelineNavigationLandedAtLocation(
          {
            positionAtIndex: (positionIndex) =>
              list.getState().positionAtIndex(positionIndex),
            scroll: scrollNode.scrollTop,
            topOffsetAdjustment: listTopOffsetAdjustmentRef.current,
          },
          { index, viewOffset, animated: false },
          CHAT_TIMELINE_NAVIGATION_LANDING_EPSILON_PX,
        );
      };
      const issue = (index: number): Promise<void> => {
        const target = expectedTimelineScrollTop(
          list,
          index,
          viewOffset,
          listTopOffsetAdjustmentRef.current,
        );
        if (target === null) return Promise.resolve();
        return list.scrollToOffset({
          offset: target,
          animated: false,
        });
      };

      let pendingRestoreScrollPromise = issue(initialIndex);
      let lastRestoreSettleTimedOut = false;
      activeNavigationSettleCleanupRef.current = settleChatTimelineNavigation({
        awaitSettle: (onSettle) =>
          awaitChatTimelineScrollPromiseSettle(
            () => pendingRestoreScrollPromise,
            (timedOut) => {
              lastRestoreSettleTimedOut = timedOut;
              onSettle();
            },
            CHAT_TIMELINE_ANCHOR_SCROLL_PROMISE_TIMEOUT_MS,
          ),
        // Fixup (pointer-generation-order): the caller's own predicate must
        // run FIRST. `handleTranscriptPointerDown` bumps
        // `anchorUserScrollGenerationRef` on every pointerdown, including
        // one that goes on to scroll past this restore's issued target to
        // true bottom - with the generation check first, `||` short-circuits
        // and the caller's atomic frozen-target predicate (which performs
        // the pending-id/registry/gate clear as a side effect when it
        // resolves) never runs at all, leaving all three pieces armed after
        // a pointer-driven reach-the-edge. Callers whose own predicate never
        // has a resolving side effect (`() => false`, the hydration-retry
        // and visibility-replay callers) are unaffected by the reorder -
        // `false || X` and `X || false` are equivalent there.
        isAborted: () =>
          isAborted() ||
          anchorUserScrollGenerationRef.current !== generationAtIssue,
        shouldYieldToReader: () => false,
        validate: () => !lastRestoreSettleTimedOut && landedAtSavedLocation(),
        reissue: () => {
          const index = targetIndex();
          if (index !== null) {
            pendingRestoreScrollPromise = issue(index);
          }
        },
        onSettledValid: () => {
          // This operation restores a persisted free-reading coordinate.
          // Publish that semantic result through the latch explicitly so a
          // temporary partial-transcript end report cannot remain the live
          // follow authority after the saved row has actually landed.
          setTimelineMode("free-scrolling", false);
          acceptExhaustedPersistedRestoreFallback(
            restorePersistencePendingRef,
            pendingMeasuredFreeRestoreRef,
          );
          // Fixup (fix-top-level-task-tab-scroll-restoration, acceptance
          // criterion 5): warm the visibility-handoff mirror IMMEDIATELY on
          // every validated convergence (mount-time reserve, hydration
          // catch-up, and the visibility-replay below all route through
          // here) rather than waiting on the next native `scroll` event.
          // Without this, a rapid hide landing between "restoration just
          // validated" and "the next scroll-driven capture" would find the
          // mirror still unwarmed and fall back to the last-persisted
          // value - harmless (still never a jump to row 0), but not the
          // freshest coherent snapshot the acceptance criterion asks for.
          const settledSnapshot = captureLiveChatTabScrollSnapshot();
          if (settledSnapshot !== null) {
            lastVisibleScrollSnapshotRef.current = settledSnapshot;
          }
          onValidated();
        },
        onSettledInvalid: onExhausted,
        maxRetries: CHAT_TIMELINE_NAVIGATION_MAX_RETRIES,
      });
      return true;
    },
    [captureLiveChatTabScrollSnapshot, setTimelineMode],
  );

  const settleScrollRequest = useCallback(
    (requestId: number, outcome: ChatScrollRequestOutcome): void => {
      const pending = pendingScrollRequestLandingRef.current;
      if (pending === null || pending.requestId !== requestId) return;
      pendingScrollRequestLandingRef.current = null;
      onScrollRequestSettledRef.current?.(requestId, outcome);
    },
    [],
  );

  /**
   * Lands a cross-tile / panel scroll request's row. Same semantic-key,
   * promise-settled, NON-animated mechanics as the reading-position restore
   * above, because that is the path already proven across unmeasured rows on
   * the windowed line: the row is placed where its position was computed
   * from, so the first frame is right by construction, and the re-issue loop
   * only absorbs the remeasurement of what just came into view. An ANIMATED
   * `scrollToIndex` targets estimated geometry for the whole flight and the
   * library never retargets mid-way, which is how a cold tile landed a
   * viewport short with nothing to correct it.
   *
   * Success is the HYDRATED target row mounted at the navigation offset - a
   * placeholder at the right pixel is still pending, since nothing can ring
   * or center inside it. The row's index is re-read on every issue and check
   * so a reindex mid-flight is followed rather than fought.
   *
   * Returns `false` when it could not issue at all (no list, or the row key
   * is not in the rendered index yet); the request then stays pending and the
   * `listRows` effect below re-attempts it. Navigation ownership and the
   * reader-gesture generation are the same as `navigateToMessage`'s.
   */
  const landScrollRequestRow = useCallback(
    (request: PendingScrollRequestLanding): boolean => {
      const { messageId, blockId, requestId } = request;
      const list = chatTimelineRef.current;
      const initialIndex = rowIndexByKeyRef.current.get(messageId);
      if (!list || initialIndex === undefined) return false;

      // Superseding an earlier landing of THIS request is a re-issue, not a
      // cancellation; any other active navigation is torn down as cancelled.
      reissuingScrollRequestIdRef.current = requestId;
      activeNavigationSettleCleanupRef.current?.();
      reissuingScrollRequestIdRef.current = null;
      const generationAtIssue = anchorUserScrollGenerationRef.current;
      followLatchRef.current?.beginOwnedFreeNavigation();
      const imperativeScrollGeneration = beginImperativeScrollOperation(false);
      const scrollNode = list.getScrollableNode();
      const viewOffset = CHAT_TIMELINE_NAVIGATION_VIEW_OFFSET_PX;
      const targetIndex = (): number | null =>
        rowIndexByKeyRef.current.get(messageId) ?? null;
      const issue = (index: number): Promise<void> => {
        const target = expectedTimelineScrollTop(
          list,
          index,
          viewOffset,
          listTopOffsetAdjustmentRef.current,
        );
        if (target === null) return Promise.resolve();
        return list.scrollToOffset({ offset: target, animated: false });
      };
      const landedOnHydratedRow = (): boolean => {
        const index = targetIndex();
        if (index === null) return false;
        if (
          !chatTimelineNavigationLandedAtLocation(
            {
              positionAtIndex: (positionIndex) =>
                list.getState().positionAtIndex(positionIndex),
              scroll: scrollNode.scrollTop,
              topOffsetAdjustment: listTopOffsetAdjustmentRef.current,
            },
            { index, viewOffset, animated: false },
            CHAT_TIMELINE_NAVIGATION_LANDING_EPSILON_PX,
          )
        ) {
          return false;
        }
        return queryMountedChatMessageRoot(scrollNode, messageId) !== null;
      };
      // Idempotent: the cleanup below runs `finish` again after a landing
      // that already settled, and ownership must be released exactly once.
      let landingFinished = false;
      const finish = (): void => {
        if (landingFinished) return;
        landingFinished = true;
        finishImperativeScrollOperation(imperativeScrollGeneration);
        followLatchRef.current?.completeOwnedFreeNavigation();
      };

      let pendingScrollPromise = issue(initialIndex);
      let lastSettleTimedOut = false;
      const cancelLandingLoop = settleChatTimelineNavigation({
        awaitSettle: (onSettle) =>
          awaitChatTimelineScrollPromiseSettle(
            () => pendingScrollPromise,
            (timedOut) => {
              lastSettleTimedOut = timedOut;
              onSettle();
            },
            CHAT_TIMELINE_ANCHOR_SCROLL_PROMISE_TIMEOUT_MS,
          ),
        isAborted: () => {
          if (anchorUserScrollGenerationRef.current === generationAtIssue) {
            return false;
          }
          // A reader gesture (or a newer navigation, which bumps the same
          // generation first) took the viewport. The settle helper calls
          // neither settled callback on abort, so this is the only place the
          // owner can learn the request is over.
          settleScrollRequest(requestId, "cancelled");
          return true;
        },
        shouldYieldToReader: () => false,
        validate: () => !lastSettleTimedOut && landedOnHydratedRow(),
        reissue: () => {
          const index = targetIndex();
          if (index !== null) pendingScrollPromise = issue(index);
        },
        onSettledValid: () => {
          finish();
          restorePersistencePendingRef.current = false;
          // Re-arm from the real landing so the 3s is measured from when the
          // reader can actually see the target; an already-in-view row
          // rang at issue and simply keeps ringing.
          showNavigationHighlight(messageId, blockId);
          if (blockId !== null) {
            // Inner card centering only after the row landing is done: a
            // `scrollIntoView` during the settle window would fail the 1px
            // row-top check and be snapped back to the turn header.
            blockReveal.requestReveal(messageId, blockId);
          }
          settleScrollRequest(requestId, "landed");
        },
        onSettledInvalid: () => {
          finish();
          acceptExhaustedPersistedRestoreFallback(
            restorePersistencePendingRef,
            pendingMeasuredFreeRestoreRef,
          );
          // The offset can be unreachable - a transcript shorter than the
          // viewport, or a target in the last screenful - while the row is
          // nonetheless mounted where the browser clamped. That is a landing
          // the reader can see, so it still rings and reveals its card; only
          // a row that never mounted is a genuine miss.
          if (queryMountedChatMessageRoot(scrollNode, messageId) !== null) {
            showNavigationHighlight(messageId, blockId);
            if (blockId !== null) blockReveal.requestReveal(messageId, blockId);
            settleScrollRequest(requestId, "landed");
            return;
          }
          settleScrollRequest(requestId, "exhausted");
        },
        maxRetries: CHAT_TIMELINE_NAVIGATION_MAX_RETRIES,
      });
      // Another navigation (`scrollToEnd`, find, a restore, unmount) tears
      // this landing down through the shared cleanup without bumping the
      // reader generation, so `isAborted` never sees it. Report `cancelled`
      // from here instead - otherwise the request stays pending, a later
      // hidden→visible transition re-issues the stale landing over the tail,
      // and the tile keeps the target row's hydration hold until its TTL.
      activeNavigationSettleCleanupRef.current = (): void => {
        cancelLandingLoop();
        finish();
        if (reissuingScrollRequestIdRef.current !== requestId) {
          settleScrollRequest(requestId, "cancelled");
        }
      };
      return true;
    },
    [
      beginImperativeScrollOperation,
      blockReveal,
      finishImperativeScrollOperation,
      settleScrollRequest,
      showNavigationHighlight,
    ],
  );

  useLayoutEffect(() => {
    const pending = pendingMeasuredFreeRestoreRef.current;
    if (pending === null) return;
    if (timelineScrollModeRef.current !== "free-scrolling") return;

    // Fixup (atomic-reader-supersession): freeze the target and the content/
    // geometry fingerprint actually issued below - `isAborted` must compare
    // against THESE frozen values, never recompute them, or automatic
    // content/layout movement during settle (append, in-place growth,
    // reorder) could be misread as reader motion: recomputing from the
    // LATEST list state would follow that same movement and always agree
    // with wherever the geometry currently sits.
    const list = chatTimelineRef.current;
    const issuedIndex = rowIndexByKeyRef.current.get(pending.messageId);
    const issuedTarget: IssuedFreeRestoreTarget = {
      targetScrollTop:
        list === null || issuedIndex === undefined
          ? null
          : expectedTimelineScrollTop(
              list,
              issuedIndex,
              pending.viewOffset,
              listTopOffsetAdjustmentRef.current,
            ),
      rows: listRowsRef.current,
      geometry: measureFreeRestoreGeometry(list, issuedIndex),
    };
    const resolvePendingEndLanding = (): boolean => {
      const isPastTarget = isDemonstrablyPastIssuedFreeRestoreTarget(
        issuedTarget,
        listRowsRef.current,
        measureFreeRestoreGeometry(chatTimelineRef.current, issuedIndex),
      );
      if (isPastTarget) {
        pendingHydrationRestoreAnchorIdRef.current = null;
        forgetPendingHydrationRestore(identity);
        restorePersistencePendingRef.current = false;
      }
      return isPastTarget;
    };
    resolvePendingRestoreEndLandingRef.current = resolvePendingEndLanding;

    // `initialScrollIndex` is only an estimate-driven first-paint bootstrap.
    // The React commit that mounts restored reserve geometry owns the final
    // measured landing synchronously; correctness cannot depend on rAF, which
    // is legitimately paused for background/unfocused Electron renderers.
    restorePersistedTimelineLocation(pending.messageId, pending.viewOffset, {
      isAborted: () => {
        // A scrollbar/manual strict-end landing can be observed by the
        // restoration settle before the browser publishes its native scroll
        // event. Reconcile that fresh DOM geometry through the latch (the
        // sole authority) before deciding whether the restore still owns the
        // viewport.
        followLatchRef.current?.observeLiveGeometry();
        if (timelineScrollModeRef.current === "free-scrolling") return false;
        // Fixup (internal-tab-bottom-follow): `settleChatTimelineNavigation`'s
        // own abort path (`if (input.isAborted()) return;`) calls neither
        // `onSettledValid` nor `onSettledInvalid`, so nothing else would
        // ever release the persistence gate for this mount if a saved
        // free-scrolling restore was still converging when the timeline
        // reported following-end - every later scroll-mirror capture and
        // the eventual unmount save would silently no-op forever
        // (`captureLiveChatTabScrollSnapshot`'s own gate check), leaving a
        // stale free-scrolling cache entry across the next same-pane
        // remount. But hydration-transaction P1 (chat-messages.test.tsx
        // "close-before-hydration"/"bare pointerdown... before hydration")
        // needs the OPPOSITE outcome for a tail-only partial snapshot,
        // whose clamped restore target IS the current tail - that landing
        // reports following-end purely because not enough content has
        // hydrated yet, not because the reader moved anywhere, and must
        // NOT release the gate (a later remount still needs the ORIGINAL
        // saved row, not this transient tail).
        // `isDemonstrablyPastIssuedFreeRestoreTarget` distinguishes the two
        // against the frozen `issuedTarget` above, not a recomputed one.
        const isPastTarget = resolvePendingEndLanding();
        if (isPastTarget) {
          // Atomic reader-supersession: resolve the WHOLE pending
          // hydration transaction as one transition, not just the
          // persistence gate. A missing raw coordinate also lives in the
          // module-level pending registry (`pendingHydrationRestoreByTabKey`),
          // which a same-instance remount's `rawSavedTabState` initializer
          // prefers over the ordinary cache, and which the hydration-retry
          // effect below still watches. Leaving either armed after a
          // proven reader move would let a later arrival of the formerly
          // missing row yank the reader back off the bottom they
          // deliberately reached, or let a permanent close before that
          // arrival re-commit the stale coordinate to durable storage.
          pendingHydrationRestoreAnchorIdRef.current = null;
          forgetPendingHydrationRestore(identity);
          restorePersistencePendingRef.current = false;
        }
        resolvePendingRestoreEndLandingRef.current = null;
        pendingMeasuredFreeRestoreRef.current = null;
        return true;
      },
      onValidated: () => {
        resolvePendingRestoreEndLandingRef.current = null;
      },
      onExhausted: () => {
        resolvePendingRestoreEndLandingRef.current = null;
        // The bounded restore has accepted the browser-clamped position as
        // its safe fallback. Publish that real viewport from now on rather
        // than retaining/replaying an unreachable saved coordinate across
        // every later remount.
        restorePersistencePendingRef.current = false;
        pendingMeasuredFreeRestoreRef.current = null;
        reconcileInvalidTimelineLanding();
      },
    });
  }, [
    identity,
    reconcileInvalidTimelineLanding,
    restorePersistedTimelineLocation,
  ]);

  // Fixup (fix-top-level-task-tab-scroll-restoration): `ChatMessages` stays
  // mounted while its top-level task/epic pane hides (`TopLevelTabHost`'s
  // keep-alive). A same-pane inner chat-tab switch now takes THIS path too
  // (pane chat retention, which reversed decision #17); the mount-time path
  // above is reached only by a real remount - retention-cap or top-level
  // eviction, a close, or a hosted-eligibility flip. A hide
  // eventually zeroes this tile's measured geometry (`PaneVisibilityContext`'s
  // own doc comment: "size-measuring surfaces... read a 0x0 box while
  // hidden"), so this effect never TRUSTS a live DOM read on the transition -
  // it publishes through the SAME chat-tab-state-cache/restoration seam
  // mount-time restore uses, not a second store or a new automatic-scroll
  // policy. On show, re-deriving via `restoreChatTabState` (not the frozen
  // mount-time `restoredTabState`) picks up the SAME clamp-to-surviving-
  // neighbor/natural-clamp fallback a destructive mutation while hidden
  // already gets on an ordinary remount.
  const wasSurfaceVisibleRef = useRef(visible);
  useLayoutEffect(() => {
    const wasVisible = wasSurfaceVisibleRef.current;
    wasSurfaceVisibleRef.current = visible;
    if (visible === wasVisible) return;

    if (!visible) {
      // Fixup (hidden-close-and-rapid-capture, P1 #2): publish the
      // continuously-mirrored snapshot (kept fresh, synchronously, by
      // `captureLastVisibleScrollSnapshot` above - no app-level rAF
      // throttle sits between a scroll event and this ref anymore).
      // Deliberately NOT a live read here: LegendList's OWN internal
      // scroll/position bookkeeping (`getState().scroll`, `positionAtIndex`,
      // and the rendered-window bounds `viewportAnchorMessageId` searches)
      // can still be internally INCONSISTENT for a handful of milliseconds
      // after a raw `scrollTop` write, even while `clientHeight` already
      // reads non-zero - a guarded live read in that window does not fail
      // safely (return null); it can silently resolve to the WRONG row
      // (verified empirically: row 0, not the target). The mirror is only
      // ever written from `handleScroll`, after LegendList's own state is
      // internally coherent, so it never carries that failure mode - at
      // worst it is one scroll event behind, which is still a position the
      // reader genuinely was at.
      const snapshot = lastVisibleScrollSnapshotRef.current;
      if (snapshot !== null) {
        saveChatTabState({ identity, ...snapshot });
      }
      return;
    }

    // A scroll request that has not reached a terminal outcome is the newer
    // intent: re-issue it against the now-measurable geometry instead of
    // replaying the saved reading position over it. Its ring stays. The
    // re-issue supersedes its own earlier landing itself (silently, as the
    // same request); the shared cleanup runs here only when no request is
    // pending, or it would report that request cancelled and release it.
    const pendingLanding = pendingScrollRequestLandingRef.current;
    if (pendingLanding !== null) {
      if (landScrollRequestRow(pendingLanding)) {
        scrollRequestLandingIssuedRef.current = pendingLanding.requestId;
      }
      return;
    }
    activeNavigationSettleCleanupRef.current?.();
    activeNavigationSettleCleanupRef.current = null;
    queueMicrotask(() => {
      clearNavigationHighlight();
    });
    const replay = restoreChatTabState(
      identity,
      listRowsRef.current.map((row) => row.key),
    );
    if (replay.mode === "following-end") {
      void chatTimelineRef.current?.scrollToEnd({ animated: false });
      return;
    }
    if (replay.anchorMessageId === null) return;
    // Re-arm the same persistence/correction gate used by mount-time restore.
    // A top-level task canvas is kept mounted, so showing it again can deliver
    // ResizeObserver maintenance while LegendList still exposes its temporary
    // zero/incomplete geometry. Without this gate that transient strict edge
    // can reacquire follow before the saved anchor is replayed, permanently
    // replacing the reading position with `following-end`.
    restorePersistencePendingRef.current = true;
    // Unlike the hydration catch-up above, nothing re-attempts a failed
    // visibility replay (this effect only fires on hide/show transitions), so
    // retaining the gate on failure would leave follow reconciliation and
    // scroll persistence suppressed until an unrelated reader gesture. Reuse
    // the mount-time exhaustion fallback instead: accept wherever the bounded
    // retries (or an unavailable list/anchor) left the viewport as the new
    // truth and release the gate.
    const acceptFailedReplayLanding = (): void => {
      restorePersistencePendingRef.current = false;
      pendingMeasuredFreeRestoreRef.current = null;
      reconcileInvalidTimelineLanding();
    };
    const issued = restorePersistedTimelineLocation(
      replay.anchorMessageId,
      replay.offset,
      {
        isAborted: () => false,
        onValidated: () => undefined,
        onExhausted: acceptFailedReplayLanding,
      },
    );
    if (!issued) acceptFailedReplayLanding();
  }, [
    clearNavigationHighlight,
    identity,
    landScrollRequestRow,
    reconcileInvalidTimelineLanding,
    restorePersistedTimelineLocation,
    visible,
  ]);

  const navigateToMessage = useCallback(
    (
      messageId: string,
      highlight: boolean,
      animated: boolean,
      blockId: string | null,
    ): void => {
      // Decision #21: minimap/find/deep-link navigation all perform
      // manual-navigation cancellation first. Not a real gesture - a plain
      // release, no freeze: the navigation's own scroll (right below, via
      // issueFreeTimelineNavigation) takes over immediately regardless.
      forgetPendingHydrationRestore(identity);
      pendingHydrationRestoreAnchorIdRef.current = null;
      cancelTimelineLiveFollowForUserNavigation({
        direction: "indeterminate",
        freezeInFlightScroll: false,
        publishesReaderPosition: false,
      });
      setScrolledActiveUserMessageIdIfChanged(messageId);
      const location = chatTimelineLocationForMessage(
        messageId,
        rowIndexByKeyRef.current,
        animated,
      );
      if (location === null) return;
      if (highlight) {
        showNavigationHighlight(messageId, blockId);
      }
      // Inner card centering has to wait until the row-top settle/re-issue
      // loop is done: a `scrollIntoView` during that window fails the 1px
      // row-top check and the re-issue snaps back to the turn header. Paint
      // at issue so an already-in-view card rings immediately; re-arm in
      // `afterSettle` so the 3s is measured from the real landing.
      issueFreeTimelineNavigation(
        location,
        highlight && blockId !== null
          ? () => {
              showNavigationHighlight(messageId, blockId);
              blockReveal.requestReveal(messageId, blockId);
            }
          : null,
      );
    },
    [
      blockReveal,
      cancelTimelineLiveFollowForUserNavigation,
      identity,
      issueFreeTimelineNavigation,
      setScrolledActiveUserMessageIdIfChanged,
      showNavigationHighlight,
    ],
  );

  // Ticket 15 review (live pass S5, confirmed defect): `restoredTabState`/
  // `initialScrollIndexAnchor` are computed ONCE at mount against whatever
  // `messages` the tile had at that instant. `chat.subscribe`'s snapshot can
  // still grow after this tile's own `snapshotLoaded` first flips true (a
  // reconnect resends a fuller snapshot; backfill can trail the flag - see
  // chat-session-store.ts's reconnect/rehydrate comments), so a mount that
  // races that growth silently clamps to whatever short prefix had arrived,
  // landing near the wrong end of a still-growing transcript - and nothing
  // ever revisited that decision even once the real transcript caught up.
  //
  // Re-attempts the ORIGINAL saved-anchor lookup as `messages` grows, same
  // "hold until the target resolves, not merely until the snapshot loaded"
  // shape as the cross-tile transcript jump in chat-tile.tsx (a warm tile
  // routinely learns about content before its own stream delivers it) -
  // and, like that precedent, UNBOUNDED: an anchor-absent `messages`
  // transition is free to observe (an O(1) map lookup) and costs nothing,
  // so there is no budget to exhaust. Ticket 15 review (live pass S5 round
  // 2): an earlier version bounded this by counting every anchor-absent
  // transition as an "attempt" - a live reopen can replay dozens of
  // incremental `messages` reference changes before the anchor's own
  // commit lands, exhausting a small counter and disarming the retry
  // before it ever got the chance to see the anchor arrive. A genuinely
  // branch-deleted anchor simply never disarms; that is harmless (nothing
  // is displayed for it - round-1's own clamp stays whatever it already
  // was) for the lifetime of the tile, the same tradeoff the transcript-jump
  // precedent already accepts. Disarms permanently the first time it
  // lands - a NEW live message arriving afterward can never re-trigger a
  // jump back here.
  // Fixup (hydration-transaction): route the catch-up through the same
  // bounded validate/retry operation restoration convergence uses, and only
  // clear the pending id/session fallback from the VALIDATED-success path
  // (`onValidated` below) - never up front. If measurement, list
  // availability, timeout, or landing validation fails, `onExhausted` is a
  // no-op: the coordinate and persistence gate stay armed, so this same
  // effect re-attempts on the next `messages` change (unbounded, matching
  // the retry precedent documented above - never disarmed by a failed
  // attempt). A real gesture or explicit navigation supersedes immediately
  // via its own unconditional clear (`cancelTimelineLiveFollowForUser
  // Navigation`'s `publishesReaderPosition` branch, `navigateToMessage`,
  // `cancelManualNavigationForFind`), independent of this effect.
  useEffect(() => {
    const anchorId = pendingHydrationRestoreAnchorIdRef.current;
    if (anchorId === null) return;
    const index = rowIndexByKeyRef.current.get(anchorId);
    if (index === undefined) return;
    const rawOffset = rawSavedTabState?.offset ?? 0;
    restorePersistedTimelineLocation(anchorId, rawOffset, {
      isAborted: () => false,
      onValidated: () => {
        pendingHydrationRestoreAnchorIdRef.current = null;
        forgetPendingHydrationRestore(identity);
      },
      onExhausted: () => undefined,
    });
  }, [identity, listRows, rawSavedTabState, restorePersistedTimelineLocation]);

  const onMinimapItemSelect = useCallback(
    (messageId: string): void =>
      navigateToMessage(messageId, false, true, null),
    [navigateToMessage],
  );

  // Find navigation is not a real gesture (like navigateToMessage) - a plain
  // release, no freeze.
  const cancelManualNavigationForFind = useCallback((): void => {
    forgetPendingHydrationRestore(identity);
    pendingHydrationRestoreAnchorIdRef.current = null;
    cancelTimelineLiveFollowForUserNavigation({
      direction: "indeterminate",
      freezeInFlightScroll: false,
      publishesReaderPosition: false,
    });
  }, [cancelTimelineLiveFollowForUserNavigation, identity]);

  // Find scans the records the client HOLDS. On the windowed line that is a
  // subset, so the bar has to say so - a count over a subset presented as a
  // total is wrong in the one direction a reader cannot detect.
  const getFindCoverageMessage = useCallback((): string | null => {
    const window = transcriptWindowRef.current;
    if (window === null) return null;
    return chatFindCoverageMessage(unhydratedRowCount(window));
  }, []);

  const {
    onRenderedDataChange: onChatFindRenderedDataChange,
    scheduleMountedHighlightSync: scheduleChatFindMountedHighlightSync,
  } = useChatFindController({
    instanceId,
    messages,
    messagesRef,
    backgroundToolBlockIds,
    backgroundToolBlockIdsRef,
    getFindCoverageMessage,
    rowIndexByKeyRef,
    getScroller,
    scrollToLocation: scrollToTimelineLocationSuppressingFollowRestore,
    cancelManualNavigation: cancelManualNavigationForFind,
    setScrolledActiveUserMessageIdIfChanged,
  });

  // Viewport-driven hydration (slice C of the windowed line): translate the
  // list's visible ROW indexes into the ordinal range they cover and report
  // upward, where the session store folds it into `planTranscriptHydration`.
  // Keep one callback identity for LegendList's passive callback slot. The
  // library can run a new-data layout pass before installing a changed callback
  // prop; closing over `listRows` would therefore pair new indexes with old
  // rows. `useInsertionEffect` refreshes this ref before any child layout
  // callback in the commit, while the stable callback avoids the slot race.
  const onChatTimelineVisibleRowsChange = useCallback(
    (fromIndex: number, toIndex: number): void => {
      onVisibleOrdinalRangeChange(
        visibleOrdinalRange(listRowsRef.current, fromIndex, toIndex),
      );
    },
    [onVisibleOrdinalRangeChange],
  );

  const onChatTimelineItemSizeChanged = useCallback((): void => {
    onTimelineItemSizeChanged();
  }, [onTimelineItemSizeChanged]);

  const onChatTimelineRowMount = useCallback(
    (messageId: string): void => {
      scheduleChatFindMountedHighlightSync();
      blockReveal.onRowMount(messageId);
    },
    [blockReveal, scheduleChatFindMountedHighlightSync],
  );

  // The controller does not diff message arrays to decide scrolling - append,
  // prepend, reorder/weave, in-place update, and suffix replacement all flow
  // directly into LegendList's own static `maintainScrollAtEnd`/
  // `maintainVisibleContentPosition` configuration (behavior contract: "one
  // edge, one rule"). This effect only keeps the restoration viewport-tracker
  // and find's rendered-data index in sync with a new `messages` reference.
  useLayoutEffect(() => {
    scheduleActiveViewportUpdate(
      timelineScrollModeRef.current === "following-end",
    );
    onChatFindRenderedDataChange();
  }, [listRows, scheduleActiveViewportUpdate, onChatFindRenderedDataChange]);

  useLayoutEffect(() => {
    const request = scrollRequestRef.current;
    if (request === null) return;
    if (handledScrollRequestIdRef.current === request.requestId) return;
    handledScrollRequestIdRef.current = request.requestId;
    if (request.kind === "end") {
      scrollToEnd(true);
      scrollRequestRef.current = null;
      return;
    }
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
    // A newer request supersedes whatever the previous one was still doing.
    const superseded = pendingScrollRequestLandingRef.current;
    if (superseded !== null)
      settleScrollRequest(superseded.requestId, "cancelled");
    const landing: PendingScrollRequestLanding = {
      requestId: request.requestId,
      messageId: request.messageId,
      blockId: resolvedScrollBlockId(request.blockId),
    };
    pendingScrollRequestLandingRef.current = landing;
    // Same prelude as `navigateToMessage`: a cross-tile jump is an explicit
    // navigation, so it releases any pending hydration restore and the live
    // follow, and the ring paints at issue so an already-in-view target rings
    // immediately (it is re-armed from the real landing).
    forgetPendingHydrationRestore(identity);
    pendingHydrationRestoreAnchorIdRef.current = null;
    cancelTimelineLiveFollowForUserNavigation({
      direction: "indeterminate",
      freezeInFlightScroll: false,
      publishesReaderPosition: false,
    });
    setScrolledActiveUserMessageIdIfChanged(request.messageId);
    showNavigationHighlight(landing.messageId, landing.blockId);
    // Deliberately NOT the animated `navigateToMessage` path: the landing
    // effect right below issues `landScrollRequestRow` in this same commit,
    // and keeps retrying while the row key is not rendered yet.
    scrollRequestRef.current = null;
  }, [
    activityGroupOpenStore,
    cancelTimelineLiveFollowForUserNavigation,
    identity,
    scrollRequest?.requestId,
    scrollToEnd,
    setScrolledActiveUserMessageIdIfChanged,
    settleScrollRequest,
    showNavigationHighlight,
  ]);

  // A request whose row was not in the rendered index when it arrived (cold
  // row on the windowed line, or a tile that learned about the message before
  // its own stream delivered it) is re-attempted as the rows change, rather
  // than burned. Only while it has not been ISSUED: an issued landing owns its
  // own re-issue loop and re-reads the index itself.
  useLayoutEffect(() => {
    const pending = pendingScrollRequestLandingRef.current;
    if (pending === null) return;
    if (scrollRequestLandingIssuedRef.current === pending.requestId) return;
    if (landScrollRequestRow(pending)) {
      scrollRequestLandingIssuedRef.current = pending.requestId;
    }
  }, [landScrollRequestRow, listRows, scrollRequest?.requestId]);

  // --- Transcript completion signal (decision #24) -------------------------

  // The transcript observer uses the store's provenance to identify live
  // completions. They feed both the shared region and the "New reply" latch;
  // the separate fallback observer never changes that latch.
  const announcement = useChatAnnouncements({
    messages,
    baselineEpoch,
    coldRewrittenMessageIds,
    hydrationSequence,
  });
  useLayoutEffect(() => {
    if (announcement === null) return;
    // Decision #10/#16: turn completion below the fold stays anchored - no
    // auto-reveal. The pill flips to "New reply" instead, unless the reader
    // is already at the tail (nothing to signal).
    if (timelineScrollModeRef.current === "following-end") return;
    setHasUnseenTurnCompletion(true);
  }, [announcement]);

  // --- Stateful scroll-to-end pill (decision #16) ----------------------------

  const lastAssistantMessage = messages
    .filter((message) => message.role === "assistant")
    .at(-1);
  const turnRunning =
    lastAssistantMessage !== undefined &&
    lastAssistantMessage.completedAt === null;
  const contextWorkingVerb = use(WorkingVerbContext);
  const workingVerb = contextWorkingVerb ?? pickWorkingVerb(taskId);
  // Behavior contract: pill visibility mirrors the latch's single live
  // follow authority: immediate hide at the edge and immediate show on the
  // first confirmed reader departure.
  const scrollToEndPillState = resolveScrollToEndPillState({
    visible: showScrollToBottom,
    turnRunning,
    unseenCompletion: hasUnseenTurnCompletion,
    workingVerb,
  });

  // A dashed placeholder rail while `editing` and the real minimap has
  // nothing to mount on (hidden, or no content yet) - so the Customize
  // popover still has something to anchor to. Computed here, in the same
  // component that calls `useLayoutHotspot`, rather than in a helper function
  // it would be passed into: `minimapHotspotRef` is a plain callback, not a
  // React ref, but a value threaded straight from that hook reads as one to
  // the react-compiler's ref-safety check once it crosses a function boundary.
  // `hide` has no remembered side of its own, so the ghost defaults to the
  // app's own default side rather than inventing one.
  const minimapGhostSide =
    chatTurnMinimapSide === "hide" ? "right" : chatTurnMinimapSide;
  const minimapGhostRail =
    minimapEditing && !isMobileViewport ? (
      <div
        ref={minimapHotspotRef}
        data-testid="chat-minimap-ghost"
        className={cn(
          "pointer-events-none absolute top-0 bottom-0 hidden w-2 md:block",
          minimapGhostSide === "left" ? "left-3" : "right-3",
        )}
      >
        <div className="absolute inset-y-0 w-px rounded-full border border-dashed border-border/60" />
      </div>
    ) : null;

  return (
    <ChatOpenStoreScopeProvider value={instanceId}>
      <ActivityGroupOpenStoreProvider store={activityGroupOpenStore}>
        <div
          ref={transcriptContainerRef}
          data-testid="chat-transcript-container"
          // Ctrl/Cmd+A selects the transcript, not the whole window (#592).
          // Marked here rather than on the chat tile's transcript wrapper: that
          // wrapper also holds the absolutely-positioned lower-surfaces dock
          // (composer, approvals, todo), which must stay out of the selection.
          // The timeline is virtualized, so this covers the mounted rows.
          data-selection-root=""
          onPointerDown={handleTranscriptPointerDown}
          className="relative flex-1 overflow-hidden"
        >
          <CustomizeDropSlot
            id="minimap:left"
            group="chat-minimap"
            tileId={taskId}
            className="absolute inset-y-0 left-0 w-6"
          />
          <CustomizeDropSlot
            id="minimap:right"
            group="chat-minimap"
            tileId={taskId}
            className="absolute inset-y-0 right-0 w-6"
          />
          <ChatTimeline
            rows={listRows}
            onVisibleRowRangeChange={onChatTimelineVisibleRowsChange}
            taskTitle={taskTitle}
            backgroundToolBlockIds={backgroundToolBlockIds}
            getMessageActions={getMessageActions}
            nextStepActions={nextStepActions}
            listRef={chatTimelineRef}
            onScroll={handleScroll}
            initialScrollAtEnd={initialScrollAtEnd}
            initialScrollIndex={initialScrollIndexAnchor}
            contentInsetEndAdjustment={endInset}
            onFollowIntentChange={onFollowIntentChange}
            onReaderGesture={handleTimelineReaderGesture}
            followLatchRef={followLatchRef}
            isFollowCorrectionSuppressed={isFollowCorrectionSuppressed}
            resolveSuppressedEndLanding={resolveSuppressedEndLanding}
            navigationHighlightedMessageId={
              navigationHighlight?.messageId ?? null
            }
            navigationHighlightedBlockId={navigationHighlight?.blockId ?? null}
            rowHeightMemory={rowHeightMemory}
            onItemSizeChanged={onChatTimelineItemSizeChanged}
            onRowMount={onChatTimelineRowMount}
            onListMetricsChange={onListMetricsChange}
            data-testid="chat-messages-scroll"
            data-scroll-mode={scrollMode}
          />
          {/* The minimap rail is untappable on touch and its hover-expand
              never fires; hide it below md and reclaim the right edge.
              `contents` keeps the absolutely-positioned rail's layout
              identical on desktop (>=768px). The `side` setting is a user
              preference, not a viewport rule, so it cannot stand in for this. */}
          {shouldMountChatTurnMinimap({
            hasContent,
            side: chatTurnMinimapSide,
            mobileViewport: isMobileViewport,
          }) ? (
            <div className="contents max-md:hidden">
              <ChatTurnMinimap
                ref={minimapDrawn ? minimapHotspotRef : null}
                rows={listRows}
                transcriptWindow={transcriptWindow}
                inViewRefreshRef={minimapInViewRefreshRef}
                listRef={chatTimelineRef}
                topOffsetAdjustmentRef={listTopOffsetAdjustmentRef}
                viewportRef={transcriptContainerRef}
                bottomInset={endInset}
                onSelect={onMinimapItemSelect}
                side={chatTurnMinimapSide}
              />
            </div>
          ) : null}
          {!minimapDrawn ? minimapGhostRail : null}
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
        <ChatLiveAnnouncements
          epicId={props.epicId}
          chatId={taskId}
          hostId={props.hostId}
          messages={messages}
          baselineEpoch={baselineEpoch}
          hydrationSequence={hydrationSequence}
          coldRewrittenMessageIds={coldRewrittenMessageIds}
          visible={visible}
          taskTitle={taskTitle}
          completion={announcement}
        />
      </ActivityGroupOpenStoreProvider>
    </ChatOpenStoreScopeProvider>
  );
}
