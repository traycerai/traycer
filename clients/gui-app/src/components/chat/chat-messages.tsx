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
  buildMessageIdToIndex,
  CHAT_ARROW_SCROLL_STEP_PX,
  chatTimelineLocationForMessage,
  chatTimelineNavigationLandedAtLocation,
  selectActiveUserMessageId,
  viewportAnchorMessageId,
  viewportActiveUserMessageId,
  type ChatTimelineNavigationLocation,
} from "@/components/chat/chat-messages-scroll-helpers";
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
import { useSettingsStore } from "@/stores/settings/settings-store";
import { isEpicCanvasTileInstanceLive } from "@/stores/epics/canvas/tile-instance-liveness";
import { resolveHostedTileOwnership } from "@/components/epic-canvas/surface-host/hosted-tile-resolver";
import type {
  ChatMessage as ChatMessageModel,
  MessageSegment,
} from "@/stores/composer/chat-store";
import type { BackgroundItem } from "@traycer/protocol/host/agent/gui/subscribe";
import type { LegendListRef } from "@legendapp/list/react";
import {
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
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
  /** Measured height of the overlaid composer/queue/pinned/agents dock
   *  (chat-tile.tsx), reserved as the transcript's bottom content inset. */
  composerOverlayHeight: number;
}

export interface ChatMessageScrollRequest {
  readonly messageId: string;
  /** Card to open within the target row, or `null` for a row-level jump. */
  readonly blockId: string | null;
  readonly requestId: number;
}

const EMPTY_BACKGROUND_TOOL_BLOCK_IDS: ReadonlySet<string> = new Set();
const NAVIGATION_HIGHLIGHT_DURATION_MS = 3_000;
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
  readonly messages: ReadonlyArray<ChatMessageModel>;
  readonly geometry: FreeRestoreGeometry;
}

/** Fixup (atomic-reader-supersession): a past-target landing is only
 *  trustworthy as reader motion if nothing that could have moved the
 *  viewport out from under the restore happened in between - append,
 *  in-place growth, or a reorder all drive LegendList's own static
 *  `maintainScrollAtEnd` regardless of reader input. Require message
 *  identity/order, scroll height, viewport height, and the target row's own
 *  position to still match what was issued before trusting the raw
 *  scrollTop comparison. */
function isDemonstrablyPastIssuedFreeRestoreTarget(
  issued: IssuedFreeRestoreTarget,
  liveMessages: ReadonlyArray<ChatMessageModel>,
  live: FreeRestoreGeometry,
): boolean {
  const geometryAndContentUnchanged =
    liveMessages === issued.messages &&
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
  // cards survive the chat tile's full remount on tab switch (decision #17) -
  // evicted only when the tab permanently closes (canvas store's
  // tile-removal subscriber), never on a mere remount.
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
        <ChatMessagesInner {...props} identity={identity} />
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

/** Per-row snapshot the completion announcer diffs between observations. */
interface AssistantCompletionObservation {
  readonly completedAt: number | null;
  readonly footerless: boolean;
  /** Notification-content version; see `notificationSignatureOf`. */
  readonly notificationSignature: string | null;
  /** Settled (non-`live`) trigger count; decides completion vs update copy. */
  readonly terminalTriggerCount: number;
}

/** What the completion announcer remembers from its previous observation. */
interface TranscriptObservation {
  readonly assistantById: ReadonlyMap<string, AssistantCompletionObservation>;
  /** Every message id (any role) - the positional fallback frame. */
  readonly messageIds: ReadonlySet<string>;
  /** Newest completion timestamp observed - the recency frame. */
  readonly maxCompletedAt: number | null;
}

/**
 * Content version of a row's autonomous-resume notification: the protocol
 * appends additional triggers to the existing divider when more monitored
 * tasks settle while the chat stays idle, so the same row can gain a new
 * background completion without any footer or id change. Each trigger is
 * encoded by its `live` state, not just counted - a still-running producer
 * that settles flips in place (`l` → `t`) with no length change, and that
 * transition is exactly the completion the reader is waiting to hear.
 */
function notificationSignatureOf(message: ChatMessageModel): string | null {
  const parts: string[] = [];
  for (const segment of message.segments) {
    if (segment.kind !== "autonomous_resume") continue;
    const states = segment.triggers
      .map((trigger) => (trigger.live ? "l" : "t"))
      .join("");
    parts.push(`${segment.id}:${states}`);
  }
  return parts.length === 0 ? null : parts.join("|");
}

function terminalTriggerCountOf(message: ChatMessageModel): number {
  let count = 0;
  for (const segment of message.segments) {
    if (segment.kind !== "autonomous_resume") continue;
    for (const trigger of segment.triggers) {
      if (!trigger.live) count += 1;
    }
  }
  return count;
}

function hasLiveTrigger(message: ChatMessageModel): boolean {
  return message.segments.some(
    (segment) =>
      segment.kind === "autonomous_resume" &&
      segment.triggers.some((trigger) => trigger.live),
  );
}

/**
 * A footerless row's announcement mirrors what actually settled. A `live`
 * trigger is a producer that was STILL RUNNING when the digest rendered -
 * the visible card says so - and announcing it as a "completion" would
 * contradict the screen. Completion copy therefore requires a settled
 * trigger the reader has not heard yet; news that is only still-running
 * producers is an update. A footerless row with no trigger digest at all
 * keeps completion copy - its only announceable change is its own terminal
 * transition.
 */
function turnCompletionAnnouncementText(input: {
  readonly taskTitle: string;
  readonly message: ChatMessageModel;
  readonly priorTerminalTriggerCount: number;
}): string {
  if (input.message.showCompletionFooter !== false) {
    return `${input.taskTitle} finished responding.`;
  }
  const terminalAdded =
    terminalTriggerCountOf(input.message) > input.priorTerminalTriggerCount;
  if (!terminalAdded && hasLiveTrigger(input.message)) {
    return `${input.taskTitle} received a background update.`;
  }
  return `${input.taskTitle} received a background completion.`;
}

/**
 * Whether an unknown terminal row is a live arrival rather than
 * hydration/backfill (this component supports transcripts growing after
 * mount). Sorted position cannot decide this alone: the projector
 * deliberately anchors a notification at its turn's original transcript
 * position, so a background task from an earlier turn that settles late
 * inserts BEFORE later rows. Completion recency is therefore the primary
 * frame - a live arrival's completion is at least as new as everything
 * previously observed. An exact timestamp tie counts as live BY CHOICE:
 * wall-clock stamps are not unique, the row snapshot carries no further
 * evidence (position provably cannot rank a tie - a tied live insertion
 * lands before known rows), and the failure costs are asymmetric - a
 * spurious polite announcement on the astronomically rare tied backfill is
 * noise, while a swallowed real completion strands a screen-reader user
 * waiting on a background task. Position decides only before any completion
 * has been observed, and needs a baseline - a previously observed row still
 * present in the transcript. Without one (first non-empty frame after
 * mounting on a still-hydrating chat) every row is history, not a live
 * tail.
 */
function unknownRowIsLiveCompletion(input: {
  readonly previous: TranscriptObservation;
  readonly message: ChatMessageModel;
  readonly index: number;
  readonly lastKnownIndex: number;
  readonly replacedIncompleteAssistant: boolean;
}): boolean {
  if (input.replacedIncompleteAssistant) return true;
  const { maxCompletedAt } = input.previous;
  const { completedAt } = input.message;
  if (maxCompletedAt !== null && completedAt !== null) {
    return completedAt >= maxCompletedAt;
  }
  return input.lastKnownIndex >= 0 && input.index > input.lastKnownIndex;
}

/**
 * Whether a known row's change is a fresh completion: `completedAt`
 * transitioning null → timestamp; a footerless notification adopted by its
 * provider turn (footer flips on, `completedAt` moves between two non-null
 * lifecycle values); or a footerless notification's content changing - an
 * added trigger, or a still-running trigger settling in place. A bare
 * `completedAt` shift with footer and notification content unchanged - a
 * canonicalized snapshot timestamp - stays silent.
 */
function knownRowNewlyCompleted(
  prior: AssistantCompletionObservation,
  message: ChatMessageModel,
): boolean {
  if (prior.completedAt === null) return true;
  if (!prior.footerless) return false;
  if (message.showCompletionFooter !== false) return true;
  return notificationSignatureOf(message) !== prior.notificationSignature;
}

function findNewlyCompletedAssistant(
  previous: TranscriptObservation,
  messages: ReadonlyArray<ChatMessageModel>,
): ChatMessageModel | null {
  const currentIds = new Set(messages.map((message) => message.id));
  const replacedIncompleteAssistant = [...previous.assistantById].some(
    ([id, observation]) =>
      observation.completedAt === null && !currentIds.has(id),
  );
  let lastKnownIndex = -1;
  for (const [index, message] of messages.entries()) {
    if (previous.messageIds.has(message.id)) lastKnownIndex = index;
  }
  let completedAssistant: ChatMessageModel | null = null;
  for (const [index, message] of messages.entries()) {
    if (message.role !== "assistant") continue;
    if (message.completedAt === null || message.stopped !== null) continue;
    const prior = previous.assistantById.get(message.id);
    const isFreshCompletion =
      prior === undefined
        ? unknownRowIsLiveCompletion({
            previous,
            message,
            index,
            lastKnownIndex,
            replacedIncompleteAssistant,
          })
        : knownRowNewlyCompleted(prior, message);
    if (isFreshCompletion) {
      completedAssistant = message;
    }
  }
  return completedAssistant;
}

function ChatMessagesInner(props: ChatMessagesInnerProps) {
  const {
    getMessageActions,
    backgroundItems,
    composerOverlayHeight,
    identity,
    instanceId,
    messages,
    nextStepActions,
    scrollRequest,
    systemOverlayActive,
    taskId,
    taskTitle,
    visible,
  } = props;

  // Restore the persisted reading position once, on mount (ticket 15: tries
  // the tab-key entry first, then the durable chat-key entry - RESTORE-FIRST,
  // decision #29). The identity is stable for the mount, so re-reading per
  // render would only repeat an O(n) message scan whose result the
  // initializers below already captured.
  const [restoredTabState] = useState<SavedChatTabScrollState>(() =>
    restoreChatTabState(identity, messages),
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
      const index = messages.findIndex(
        (message) => message.id === restoredTabState.anchorMessageId,
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
  const followLatchRef = useRef<ChatTimelineFollowLatch | null>(null);
  const minimapInViewRefreshRef = useRef<() => void>(() => undefined);
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
  // The restored reading row (if any) is also the immediately-active minimap
  // row - no need to wait for the async viewport scan to catch up.
  const scrolledActiveUserMessageIdRef = useRef(
    restoredTabState.anchorMessageId,
  );
  const [navigationHighlightedMessageId, setNavigationHighlightedMessageId] =
    useState<string | null>(null);
  const navigationHighlightTimeoutRef = useRef<number | null>(null);
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
    setNavigationHighlightedMessageId(null);
  }, []);
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
  const hasContent = messages.length > 0;
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
        : viewportAnchorMessageId(
            {
              ...list.getState(),
              scroll: list.getScrollableNode().scrollTop,
              topOffsetAdjustment: listTopOffsetAdjustmentRef.current,
            },
            messagesRef.current,
          );
    const anchorMessageId =
      mode === "free-scrolling"
        ? (liveViewportAnchorMessageId ??
          scrolledActiveUserMessageIdRef.current)
        : null;
    const anchorIndex =
      anchorMessageId === null
        ? undefined
        : messageIndexByIdRef.current.get(anchorMessageId);
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
  // pointerdown. Chat tiles fully remount per tab switch (decision #17), and
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
  const chatTurnMinimapSide = useSettingsStore(
    (state) => state.chatTurnMinimapSide,
  );
  const quoteSelection = useQuoteSelection({
    containerRef: transcriptContainerRef,
    enabled: quoteReplyEnabled && visible && !systemOverlayActive,
  });

  // Ticket 5: registry-backed, keyed by tile instance id, so expanded
  // activity groups survive the chat tile's full remount on tab switch
  // (decision #17) - evicted only when the tab permanently closes (canvas
  // store's tile-removal subscriber), never on a mere remount.
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
          messages,
        );
        if (nextActiveUserMessageId !== null) {
          setScrolledActiveUserMessageIdIfChanged(nextActiveUserMessageId);
        }
      },
      [messages, setScrolledActiveUserMessageIdIfChanged],
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

  const getScroller = useCallback(
    (): HTMLElement | null =>
      chatTimelineRef.current?.getScrollableNode() ?? null,
    [],
  );

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
  const scrollToTimelineLocationSuppressingFollowRestore = useCallback(
    (location: ChatTimelineNavigationLocation): void => {
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
          finishImperativeScrollOperation(imperativeScrollGeneration);
          followLatchRef.current?.completeOwnedFreeNavigation();
          restorePersistencePendingRef.current = false;
        },
        onSettledInvalid: () => {
          finishImperativeScrollOperation(imperativeScrollGeneration);
          followLatchRef.current?.completeOwnedFreeNavigation();
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
      const initialIndex = messageIndexByIdRef.current.get(messageId);
      if (!list || initialIndex === undefined) return false;

      activeNavigationSettleCleanupRef.current?.();
      const generationAtIssue = anchorUserScrollGenerationRef.current;
      const scrollNode = list.getScrollableNode();
      const targetIndex = (): number | null =>
        messageIndexByIdRef.current.get(messageId) ?? null;
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
    const issuedIndex = messageIndexByIdRef.current.get(pending.messageId);
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
      messages: messagesRef.current,
      geometry: measureFreeRestoreGeometry(list, issuedIndex),
    };
    const resolvePendingEndLanding = (): boolean => {
      const isPastTarget = isDemonstrablyPastIssuedFreeRestoreTarget(
        issuedTarget,
        messagesRef.current,
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
  // keep-alive) - unlike a same-pane inner chat-tab switch, which fully
  // unmounts and restores through the mount-time path above. A hide
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

    const replay = restoreChatTabState(identity, messagesRef.current);
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
    identity,
    reconcileInvalidTimelineLanding,
    restorePersistedTimelineLocation,
    visible,
  ]);

  const navigateToMessage = useCallback(
    (messageId: string, highlight: boolean, animated: boolean): void => {
      // Decision #21: minimap/find/deep-link navigation all perform
      // manual-navigation cancellation first. Not a real gesture - a plain
      // release, no freeze: the navigation's own scroll (right below, via
      // scrollToTimelineLocationSuppressingFollowRestore) takes over
      // immediately regardless.
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
        messageIndexByIdRef.current,
        animated,
      );
      if (location === null) return;
      if (highlight) {
        showNavigationHighlight(messageId);
      }
      scrollToTimelineLocationSuppressingFollowRestore(location);
    },
    [
      cancelTimelineLiveFollowForUserNavigation,
      identity,
      scrollToTimelineLocationSuppressingFollowRestore,
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
    const index = messageIndexByIdRef.current.get(anchorId);
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
  }, [identity, messages, rawSavedTabState, restorePersistedTimelineLocation]);

  const onMinimapItemSelect = useCallback(
    (messageId: string): void => navigateToMessage(messageId, false, true),
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

  const { onRenderedDataChange: onChatFindRenderedDataChange } =
    useChatFindController({
      instanceId,
      messages,
      messagesRef,
      backgroundToolBlockIds,
      backgroundToolBlockIdsRef,
      messageIndexByIdRef,
      getScroller,
      scrollToLocation: scrollToTimelineLocationSuppressingFollowRestore,
      cancelManualNavigation: cancelManualNavigationForFind,
      setScrolledActiveUserMessageIdIfChanged,
    });

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
  }, [messages, scheduleActiveViewportUpdate, onChatFindRenderedDataChange]);

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
    // Animated (ticket 20 does not change minimap/deep-link semantics - find
    // is unrelated to this call site, see navigateToMessage's own comment):
    // a cross-tile jump is a real navigation the reader triggered elsewhere.
    navigateToMessage(request.messageId, true, true);
    scrollRequestRef.current = null;
  }, [activityGroupOpenStore, navigateToMessage, scrollRequest?.requestId]);

  // --- Accessibility (decision #24): polite turn-completion announcement ----

  const [turnCompletionAnnouncement, setTurnCompletionAnnouncement] = useState<{
    readonly key: string;
    readonly text: string;
  } | null>(null);
  const transcriptObservationRef = useRef<TranscriptObservation | null>(null);
  const announcementSeqRef = useRef(0);
  useLayoutEffect(() => {
    const previous = transcriptObservationRef.current;
    const assistantById = new Map<string, AssistantCompletionObservation>();
    const messageIds = new Set<string>();
    let maxCompletedAt: number | null = null;
    for (const message of messages) {
      messageIds.add(message.id);
      if (message.role !== "assistant") continue;
      assistantById.set(message.id, {
        completedAt: message.completedAt,
        footerless: message.showCompletionFooter === false,
        notificationSignature: notificationSignatureOf(message),
        terminalTriggerCount: terminalTriggerCountOf(message),
      });
      if (
        message.completedAt !== null &&
        (maxCompletedAt === null || message.completedAt > maxCompletedAt)
      ) {
        maxCompletedAt = message.completedAt;
      }
    }
    transcriptObservationRef.current = {
      assistantById,
      messageIds,
      maxCompletedAt,
    };
    // The first observation only records the baseline: transcript history
    // present at mount must never announce, including footerless rows that
    // are born terminal.
    if (previous === null) return;
    const completedAssistant = findNewlyCompletedAssistant(previous, messages);
    if (completedAssistant !== null) {
      // The key is a monotonic sequence, NOT row identity: two consecutive
      // announcements can share id, completion timestamp AND text (a second
      // trigger settling in the same millisecond), and an unchanged key
      // would leave the live-region DOM unmutated - silent to screen
      // readers.
      announcementSeqRef.current += 1;
      const announcement = {
        key: String(announcementSeqRef.current),
        text: turnCompletionAnnouncementText({
          taskTitle,
          message: completedAssistant,
          priorTerminalTriggerCount:
            previous.assistantById.get(completedAssistant.id)
              ?.terminalTriggerCount ?? 0,
        }),
      };
      // Decision #10/#16: turn completion below the fold stays anchored - no
      // auto-reveal. The pill flips to "New reply" instead, unless the
      // reader is already at the tail (nothing to signal).
      const hasUnseenCompletion =
        timelineScrollModeRef.current !== "following-end";
      queueMicrotask(() => {
        setTurnCompletionAnnouncement(announcement);
        if (hasUnseenCompletion) setHasUnseenTurnCompletion(true);
      });
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
          <ChatTimeline
            messages={messages}
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
            navigationHighlightedMessageId={navigationHighlightedMessageId}
            onItemSizeChanged={onTimelineItemSizeChanged}
            onListMetricsChange={onListMetricsChange}
            data-testid="chat-messages-scroll"
            data-scroll-mode={scrollMode}
          />
          {hasContent && chatTurnMinimapSide !== "hide" ? (
            <ChatTurnMinimap
              messages={messages}
              inViewRefreshRef={minimapInViewRefreshRef}
              listRef={chatTimelineRef}
              topOffsetAdjustmentRef={listTopOffsetAdjustmentRef}
              viewportRef={transcriptContainerRef}
              bottomInset={endInset}
              onSelect={onMinimapItemSelect}
              identity={identity}
              side={chatTurnMinimapSide}
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
          {turnCompletionAnnouncement === null ? null : (
            <span key={turnCompletionAnnouncement.key}>
              {turnCompletionAnnouncement.text}
            </span>
          )}
        </div>
      </ActivityGroupOpenStoreProvider>
    </ChatOpenStoreScopeProvider>
  );
}
