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
  anchorMoverShouldYieldToReader,
  applyChatAnchorDriftRepair,
  buildMessageIdToIndex,
  CHAT_ARROW_SCROLL_STEP_PX,
  chatAnchorScrollCaptureShouldCancel,
  chatTimelineAnchorShouldAnimateInitialIssue,
  chatTimelineLocationForMessage,
  chatTimelineNavigationLandedAtLocation,
  chatWheelShouldCancelLiveFollow,
  classifyChatEdgeMutation,
  isChatAnchorCandidateMessage,
  resolveChatAnchorTargetWithSetupCard,
  selectActiveUserMessageId,
  viewportActiveUserMessageId,
  type ChatAnchorScrollCapturePhysicalSnapshot,
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
  commitChatTabStateToDurable,
  hasSavedChatTabState,
  peekSavedChatTabAnchorMessageId,
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
import { appLogger } from "@/lib/logger";
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
  clearChatKeyTombstone,
  clearEpicPrefixTombstone,
} from "@/stores/chats/chat-tab-persistence-tombstone";
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
  /** Chat tab identity; keys the composer draft the quote affordance appends to.
   *  Also this chat's `chatId` half of the ticket-15 dual-key identity. */
  taskId: string;
  /** The epic this chat belongs to - the other half of the ticket-15
   *  dual-key `(epicId, chatId)` durable identity. */
  epicId: string;
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
  /** Host-owned run state (decision #29) - `isChatRunInProgress` already
   *  applied. Drives the streaming-aware fresh-open policy: no saved state
   *  while streaming seeds `following-end` instead of the idle anchor. */
  isChatStreaming: boolean;
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
/** Ticket 11: strict live-edge tolerance for reconciling `anchoring-new-turn`
 *  back to `following-end` once the reader has scrolled to the turn's actual
 *  end. Matches the reveal pass's own "close enough" tolerance
 *  (`metrics.scrollDeltaToRevealEnd <= 1`) so a fitting anchor's still-
 *  closing reserve near-end is never misread as "arrived". */
const CHAT_TIMELINE_LIVE_EDGE_EPSILON_PX = 1;
/** A smaller scrollTop is user movement away from an owned live-edge
 * position; equal or larger values are compatible with streaming growth. */
const CHAT_TIMELINE_SCROLL_DEPARTURE_EPSILON_PX = 1;
/** Ticket 10: pixel tolerance for the settle/re-issue validation below - a
 *  navigation whose landing is off by more than this is treated as a real
 *  undershoot, not float/rounding noise. */
const CHAT_TIMELINE_NAVIGATION_LANDING_EPSILON_PX = 1;
/** Ticket 10: bounded retry count for the settle/re-issue loop (ticket text:
 *  "max 2-3") - the upper end, since the field bug this fixes needed
 *  multiple manual pill re-clicks to converge and the goal is to absorb that
 *  automatically in one operation. */
const CHAT_TIMELINE_NAVIGATION_MAX_RETRIES = 3;
/** Ticket 18 (adopted verdict, rootcause-send-undershoot report): an ANIMATED
 *  anchor scroll targets ESTIMATED geometry that a long jump across many
 *  unmeasured rows can drift short of (LegendList 3.2.0 never retargets
 *  mid-flight). `animated:false` alone does not fix it either - the
 *  guarantee comes from the validated convergence loop, not travel speed -
 *  but bounding how far a single animated hop is trusted to travel
 *  accurately still matters for feel: instant for jumps beyond this many
 *  viewports from the current position, animated (subject to the caller's
 *  own animated intent) within it. */
const CHAT_TIMELINE_ANCHOR_ANIMATE_MAX_VIEWPORTS = 1.5;

function resolveOwnedAtEndReport(input: {
  readonly isAtEnd: boolean;
  readonly mode: ChatTimelineScrollMode;
  readonly generationOwned: boolean;
  readonly currentScrollTop: number | undefined;
  readonly previousOwnedScrollTop: number | null;
}): {
  readonly shouldSwallow: boolean;
  readonly nextOwnedScrollTop: number | null;
} {
  const {
    isAtEnd,
    mode,
    generationOwned,
    currentScrollTop,
    previousOwnedScrollTop,
  } = input;
  const isScrollOnlyFollowDeparture =
    !isAtEnd &&
    mode === "following-end" &&
    typeof currentScrollTop === "number" &&
    previousOwnedScrollTop !== null &&
    currentScrollTop <
      previousOwnedScrollTop - CHAT_TIMELINE_SCROLL_DEPARTURE_EPSILON_PX;
  return {
    shouldSwallow: !isAtEnd && generationOwned && !isScrollOnlyFollowDeparture,
    nextOwnedScrollTop:
      generationOwned &&
      !isScrollOnlyFollowDeparture &&
      typeof currentScrollTop === "number"
        ? currentScrollTop
        : previousOwnedScrollTop,
  };
}

function expectedAnchorScrollTop(
  list: LegendListRef,
  anchorIndex: number,
  anchorOffset: number,
  topOffsetAdjustment: number,
): number | null {
  const anchorTop = list.getState().positionAtIndex(anchorIndex);
  if (typeof anchorTop !== "number" || !Number.isFinite(anchorTop)) {
    return null;
  }
  return anchorTop + topOffsetAdjustment - anchorOffset;
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
 * Ticket 10: generalizes the anchor engine's settle/re-issue pattern
 * (`onTimelineAnchorReady`, ticket 3) to plain programmatic navigation
 * (`navigateToMessage`/find/deep-link, `scrollToEnd`) - ticket 18 further
 * generalizes it back onto the anchor engine itself (the ORIGINAL bespoke
 * one-shot settle that predated this helper). An ANIMATED intent targets
 * ESTIMATED geometry; the installed LegendList 3.2.0 has no mid-flight
 * retargeting as real measurements replace estimates during the animation,
 * so a long jump can settle short (root-cause: rootcause-nav-landing /
 * rootcause-send-undershoot reports). After `awaitSettle` calls back,
 * `shouldYieldToReader` (ticket 18: a real gesture - e.g. an OS scrollbar
 * drag that fires no wheel/touch/pointerdown of its own - must still win
 * over a still-in-flight correction, never yanking the reader back) takes
 * priority over `validate`; if it yields, `onSettledInvalid` runs directly,
 * same remedy as exhausting retries. Otherwise `validate` checks the landing
 * against fresh geometry; if off, `reissue` re-issues the SAME semantic
 * target non-animated (which resolves synchronously - `scrollTo`'s
 * `!animated` branch calls `updateScroll` directly) and this re-settles, up
 * to `maxRetries` times. `isAborted` (checked before every check) is the
 * caller's own ownership check - a generation bump, a real gesture, or a
 * mode change all supersede a still-in-flight operation; it must stop
 * correcting a position nobody wants anymore, same as the anchor engine's
 * own `positionedTimelineAnchorRef`/generation guards - a fired `isAborted`
 * abandons silently (someone else is already driving the UI). `onSettledValid`
 * runs once the landing validates; `onSettledInvalid` runs once every retry
 * is exhausted and the landing is still off, or `shouldYieldToReader` fires
 * (neither ever called if `isAborted` fires first).
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
 * This component owns the three-mode scroll policy (`following-end` /
 * `anchoring-new-turn` / `free-scrolling` - decision log #1) and the
 * composer/queued-surface overlay inset math (decision #13).
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
  rawSavedAnchorMessageId: string | null,
): string | null {
  if (restoredTabState.mode !== "free-scrolling") return null;
  if (rawSavedAnchorMessageId === null) return null;
  if (restoredTabState.anchorMessageId === rawSavedAnchorMessageId) {
    return null;
  }
  return rawSavedAnchorMessageId;
}

function ChatMessagesInner(props: ChatMessagesInnerProps) {
  const {
    consumeLocalProvenance,
    getMessageActions,
    backgroundItems,
    composerOverlayHeight,
    identity,
    instanceId,
    isChatStreaming,
    localProvenanceMessageIds,
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
  // Distinguishes a genuinely never-before-opened chat from a restored
  // following-end tab (both produce the same `restoredTabState` shape - see
  // `hasSavedChatTabState`'s doc comment). Only the former triggers the
  // fresh-open policy below.
  const [hadSavedScrollState] = useState<boolean>(() =>
    hasSavedChatTabState(identity),
  );
  // Fresh open (decision #15): no saved state -> anchor the LAST user
  // message near the top via the same anchor path as a send, non-animated,
  // instead of `initialScrollAtEnd`. `null` when a saved state exists (that
  // restore keeps precedence) or the transcript has no anchor candidate yet.
  // Decision #27 widens the candidate to a `forked-chat-link` marker (a
  // freshly opened fork lands on its own start marker, not the last copied
  // query above it); decision #28 then substitutes a setup card woven
  // directly above the resolved candidate (mid-chat weave or genesis pin).
  // Decision #29 (ticket 15): a genuinely fresh open while the chat is
  // actively STREAMING skips this candidate search entirely - `mode`'s own
  // resolver below then falls through to its `following-end` default
  // (`restoredTabState.mode` is exactly `DEFAULT_CHAT_TAB_SCROLL_STATE.mode`
  // when nothing was saved), keeping the reader pinned to the live tail
  // instead of anchoring to a turn that may already be scrolled past.
  const [freshOpenAnchorMessageId] = useState<string | null>(() => {
    if (hadSavedScrollState) return null;
    if (isChatStreaming) return null;
    const candidate = messages.findLast(isChatAnchorCandidateMessage);
    if (candidate === undefined) return null;
    return resolveChatAnchorTargetWithSetupCard(messages, candidate.id);
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
  // Ticket 15 review (live pass S5, confirmed defect): the raw saved anchor
  // id, peeked WITHOUT `restoreChatTabState`'s messages-dependent clamp -
  // needed to tell "the true saved anchor was found at mount" apart from
  // "restoreChatTabState had to clamp to a neighbor because `messages` was
  // still mid-hydration" (`chat.subscribe`'s snapshot can keep growing after
  // this tile's own `snapshotLoaded` first flips true - a reconnect resends
  // a fuller snapshot, or backfill trails the flag; see chat-session-store.ts's
  // reconnect/rehydrate comments). A clamped `restoreChatTabState` result
  // always returns SOME id present in whatever `messages` it was given, so
  // the clamped return value alone cannot distinguish the two cases.
  const [rawSavedAnchorMessageId] = useState<string | null>(() =>
    peekSavedChatTabAnchorMessageId(identity),
  );
  // Non-null only when the mount-time restore above had to clamp away from
  // the true saved anchor - the hydration-retry effect below (declared
  // after `navigateToMessage`, which it needs) resolves this against
  // `messages` as it grows, then nulls it out permanently, so an ordinary
  // NEW live message arriving later can never re-trigger a jump back here.
  const pendingHydrationRestoreAnchorIdRef = useRef<string | null>(
    resolvePendingHydrationRestoreAnchorId(
      restoredTabState,
      rawSavedAnchorMessageId,
    ),
  );

  const chatTimelineRef = useRef<LegendListRef | null>(null);
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
  // Ticket 5 / F3: footer size joins header in the true no-reserve max-scroll
  // bound (LegendList content length). Kept from the same metrics callback.
  const listFooterSizeRef = useRef(0);
  // The fresh-open anchor target (if any) is also the immediately-active
  // minimap row - no need to wait for the async viewport scan to catch up.
  const scrolledActiveUserMessageIdRef = useRef(
    freshOpenAnchorMessageId ?? restoredTabState.anchorMessageId,
  );
  // Ticket 17 (review round: finding 2 fix) - last (bottom-most) row actually
  // visible in the viewport, the suffix-removal classifier's viewport input.
  // Tagged with the EXACT `messages` array reference the observation was
  // computed against, NOT trusted implicitly by ordering: `scheduleActive
  // ViewportUpdate` is rAF-throttled (`use-animation-frame-throttle.ts`
  // coalesces same-frame calls to the latest arg) and is ALSO invoked
  // unconditionally from the tail of the edge-mutation effect below on every
  // `messages` change (not just real scroll) - so a second transition can
  // arrive before that scheduled frame fires, leaving this ref one (or more)
  // transitions stale relative to the CURRENT `previousMessages`. The
  // classify call site below only trusts `snapshot.messages ===
  // previousMessages`; otherwise it passes `null` (documented unknown ->
  // case (b) fallback), never the stale id. Starts at `null` (no snapshot at
  // all, not a same-render tag) rather than seeding from
  // `freshOpenAnchorMessageId`/`restoredTabState.anchorMessageId` (the
  // READING-LINE anchor, not the last-visible/bottom row) - a mount-time
  // seed tagged to the mount `messages` array would trivially pass the
  // identity check on the very FIRST transition (that transition's
  // `previousMessages` IS the mount array), reintroducing exactly the bug
  // this gate exists to close. Trade-off (accepted, not a regression): a
  // reader who restores/mounts and deletes before the first real
  // scroll-driven read takes case (b) even if they never actually touched
  // the deleted region - the documented safe default, never a guess.
  //
  // Also tagged with `scrollLength` (review round 3, finding 2 residual,
  // CONFIRMED HIGH): a height-only pane resize changes LegendList's own
  // `state.scrollLength` via its internal `handleLayout` WITHOUT firing a
  // `scroll` event, a row remeasure (`onTimelineItemSizeChanged`), or a
  // header/footer change (`onListMetricsChange`) - none of the earlier
  // round's invalidation hooks see it at all, so a snapshot whose `messages`
  // still matches can silently describe a viewport that no longer exists.
  // `getState().scrollLength` is LegendList's own LIVE internal value
  // (continuously updated by its internal ResizeObserver independent of our
  // own re-renders), safe to read fresh at classify time - see the classify
  // call site below.
  const viewportLastVisibleSnapshotRef = useRef<{
    readonly messages: ReadonlyArray<ChatMessageModel>;
    readonly lastVisibleMessageId: string | null;
    readonly scrollLength: number;
  } | null>(null);
  const previousMessagesForEdgeMutationRef =
    useRef<ReadonlyArray<ChatMessageModel> | null>(null);
  const [navigationHighlightedMessageId, setNavigationHighlightedMessageId] =
    useState<string | null>(null);
  const navigationHighlightTimeoutRef = useRef<number | null>(null);
  const activeNavigationSettleCleanupRef = useRef<(() => void) | null>(null);
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
  // Last physical position reported while follow ownership was intact.
  // LegendList's false reports alone cannot distinguish an OS-scrollbar drag
  // upward from content growth reopening the distance to end; their scrollTop
  // direction can.
  const lastOwnedScrollTopRef = useRef<number | null>(null);
  // The anchor mover's last geometry-derived target. Content growth/shrink
  // moves the current target, while a reader departure moves only scrollTop;
  // comparing against both prevents either geometry change from looking like
  // user intent.
  const expectedAnchorScrollTopRef = useRef<number | null>(null);
  // Ticket 19 (decision #31, capture-provenance classifier): the physical
  // DOM snapshot the capture-phase scroll listener compares each new event
  // against (browser-clamp signature) - refreshed on every captured event
  // regardless of mode/ownership, and reseeded at `beginAnchoringNewTurn` so
  // the FIRST captured event of a session always has a same-session
  // baseline. See `chatAnchorScrollCaptureShouldCancel`'s doc comment.
  const anchoringPhysicalSnapshotRef =
    useRef<ChatAnchorScrollCapturePhysicalSnapshot | null>(null);
  // Ticket 19: the ONE generation-scoped in-flight ref the design/decision
  // #31 machinery cap allows - non-null (holding the owning generation)
  // only while the anchor engine's `scrollToIndex` issue/reissue is inside
  // ticket 18's settle lifecycle (`positionAnchor` below). Armed
  // immediately before each issue, cleared symmetrically in
  // begin/retarget/cancel/valid/invalid - see each site's own comment.
  const activeAnchorImperativeMotionGenerationRef = useRef<number | null>(null);
  // Ticket 22: coalesces item-size/viewport-layout triggers into ONE pending
  // two-rAF geometry-repair pass at a time - `scheduleChatAnchorGeometryRepair`'s
  // own doc comment covers why.
  const pendingGeometryRepairCancelRef = useRef<(() => void) | null>(null);
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
  // bootstrap can land near the tail by coincidence (decision #14/#21's
  // general "a programmatic free-scrolling landing must not be misread as a
  // gesture" category), and must not be misread as the reader gesturing to
  // the end. Cleared by the first real gesture cancel or an explicit
  // go-live, same as any other suppression.
  const suppressFollowRestoreRef = useRef(initialScrollIndexAnchor !== null);
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
  // Ticket 13 (decision #28): mirrors `timelineAnchorMessageId` so the
  // mid-anchoring card-retarget check (below) can read the CURRENT target
  // synchronously from inside the edge-mutation effect without adding that
  // state to the effect's own dependency array - doing so would re-run the
  // effect a second time per retarget (the state update lands a render
  // after the ref does), re-classifying the SAME `messages` transition for
  // no purpose beyond confirming there's nothing left to retarget.
  const timelineAnchorMessageIdRef = useRef(freshOpenAnchorMessageId);
  // O1 (ticket 16 mode consolidation): mirrors `timelineScrollModeRef.current` into
  // render as the ONE rendered representation - `followEnabled`,
  // `sizePreservationEnabled`, the pill formula, and `data-scroll-mode` all
  // derive from this single value (replaces the old `isFollowingEnd` /
  // `isAnchoringNewTurn` boolean pair). `timelineScrollModeRef` (above)
  // stays the authoritative ref every imperative callback reads/writes
  // synchronously; this is purely a render-time mirror of it, same
  // reasoning the old mirror had (a ref cannot be read during render).
  const [scrollMode, setScrollMode] = useState<ChatTimelineScrollMode>(
    initialModeSeed.mode,
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
      if (next === "following-end") {
        isAtEndRef.current = true;
        liveFollowUserScrollGenerationRef.current =
          anchorUserScrollGenerationRef.current;
        lastOwnedScrollTopRef.current =
          chatTimelineRef.current?.getScrollableNode().scrollTop ?? null;
        cancelPillShow();
        setShowScrollToBottom(false);
        suppressFollowRestoreRef.current = false;
        // Reaching the tail "sees" everything - decision #10's unseen-turn
        // signal no longer applies.
        setHasUnseenTurnCompletion(false);
      } else {
        liveFollowUserScrollGenerationRef.current = null;
        lastOwnedScrollTopRef.current = null;
      }
      expectedAnchorScrollTopRef.current = null;
      setScrollMode(next);
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
      // Overengineering-audit collapse (round-2 finding 2's operation-token
      // superseded): every ANIMATED imperative scroll (pill-click
      // `scrollToEnd`, minimap/find navigation, the anchor engine's own
      // positioning scrollToIndex) is issued from `following-end` or
      // `anchoring-new-turn`, or otherwise covered by
      // `suppressFollowRestoreRef` - free-scrolling-and-unsuppressed is the
      // only state in which NO animated imperative scroll can be in flight.
      // Reading the MODE this cancel is racing against is therefore sufficient
      // to decide whether a
      // native smooth-scroll might still be running; no per-operation
      // bookkeeping is needed.
      const modeAtEntry = timelineScrollModeRef.current;
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
      setScrollMode("free-scrolling");
      if (wasAnchoringWithVisiblePill) {
        cancelPillShow();
        setShowScrollToBottom(true);
      }
      liveFollowUserScrollGenerationRef.current = null;
      lastOwnedScrollTopRef.current = null;
      expectedAnchorScrollTopRef.current = null;
      pendingTimelineAnchorRef.current = null;
      positionedTimelineAnchorRef.current = null;
      settledTimelineAnchorRef.current = null;
      activeTimelineAnchorIndexRef.current = null;
      pendingAnchorScrollRestoreRef.current = null;
      // Ticket 19: a cancel (real gesture or superseding navigation) ends
      // whatever anchor motion window was in flight for the OLD generation -
      // symmetric with the arm sites in `positionAnchor` below.
      activeAnchorImperativeMotionGenerationRef.current = null;
      anchoringPhysicalSnapshotRef.current = null;
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
      // H1 fix: freeze on suppression OR a mode that could still have an
      // animated imperative scroll in flight (`modeAtEntry !==
      // "free-scrolling"`, captured above BEFORE this cancel overwrites the
      // mode) - `scrollToEnd`'s pill-click path and `beginAnchoringNewTurn`
      // both legitimately clear suppression before their own animation
      // settles, so suppression alone under-covers exactly the case this
      // check exists for.
      if (
        freezeInFlightScroll &&
        (suppressFollowRestoreRef.current || modeAtEntry !== "free-scrolling")
      ) {
        const list = chatTimelineRef.current;
        const currentScroll = list?.getState().scroll;
        if (list && typeof currentScroll === "number") {
          void list.scrollToOffset({ offset: currentScroll, animated: false });
          justFrozeProgrammaticScrollRef.current = true;
        }
      }
      suppressFollowRestoreRef.current = false;
      if (anchorScrollRestoreFrameRef.current !== null) {
        cancelAnimationFrame(anchorScrollRestoreFrameRef.current);
        anchorScrollRestoreFrameRef.current = null;
      }
    },
    [cancelPillShow],
  );
  const cancelTimelineLiveFollowForRealUserGesture = useCallback(
    (freezeInFlightScroll: boolean): void => {
      clearNavigationHighlight();
      cancelTimelineLiveFollowForUserNavigation(freezeInFlightScroll);
    },
    [cancelTimelineLiveFollowForUserNavigation, clearNavigationHighlight],
  );
  const cancelTimelineLiveFollowForUserNavigationRef = useRef(
    cancelTimelineLiveFollowForRealUserGesture,
  );
  useLayoutEffect(() => {
    cancelTimelineLiveFollowForUserNavigationRef.current =
      cancelTimelineLiveFollowForRealUserGesture;
  }, [cancelTimelineLiveFollowForRealUserGesture]);
  const handleTranscriptPointerDown = useCallback((): void => {
    cancelTimelineLiveFollowForRealUserGesture(true);
  }, [cancelTimelineLiveFollowForRealUserGesture]);

  // ChatTimeline unmounts LegendList entirely for an empty transcript
  // (ChatEmptyState instead), so this - not just `messages` identity - is
  // the signal that tracks whether a real scroll node can exist right now.
  const hasContent = messages.length > 0;

  // Insets (decision #12-13, resolved 2026-07-31 - ticket 18): flat 16px top
  // anchor offset, permanently - not deferred. `chat-tile.tsx` renders the
  // ENTIRE lower dock (composer + queue + pinned-todo stack + agents +
  // background) as one `absolute inset-x-0 bottom-0` overlay, ResizeObserver-
  // measured as a single unit into `composerOverlayHeight` -> `endInset`
  // below. There is no top-rendered surface today for anything to fold into
  // this offset - the pinned-todo stack (like every other lower-dock member)
  // only ever occupies the bottom, so decision #13's "anchored rows never
  // hide behind those surfaces" is already satisfied entirely through
  // `endInset`. If a FUTURE surface ever renders above the transcript, that
  // surface's measured height is what would compose into `anchorOffset` -
  // not any lower-dock member.
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
        topOffsetAdjustment: listTopOffsetAdjustmentRef.current,
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

  const reconcileInvalidTimelineLanding = useCallback((): void => {
    // A corrective operation that cannot safely land must never leave the
    // controller claiming ownership from the wrong position.
    setTimelineMode("free-scrolling");
    cancelPillShow();
    setShowScrollToBottom(true);
  }, [cancelPillShow, setTimelineMode]);

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
      void list?.scrollToEnd({ animated });
      if (!list) return;
      const scrollNode = list.getScrollableNode();
      activeNavigationSettleCleanupRef.current = settleChatTimelineNavigation({
        awaitSettle: (onSettle) =>
          awaitScrollSettle(
            scrollNode,
            onSettle,
            CHAT_ANCHOR_SETTLE_FALLBACK_MS,
          ),
        isAborted: () =>
          anchorUserScrollGenerationRef.current !== generationAtIssue ||
          timelineScrollModeRef.current !== "following-end",
        // The pill-click "go live" path has no reader-departure detection of
        // its own (unlike the anchor engine below) - a real gesture already
        // bumps the generation and is caught by `isAborted` above.
        shouldYieldToReader: () => false,
        validate: () => list.getState().isAtEnd,
        reissue: () => {
          void list.scrollToEnd({ animated: false });
        },
        onSettledValid: () => {},
        // Ticket 10: free-scrolling with the pill visible beats silently
        // claiming ownership from an invalid landing.
        onSettledInvalid: reconcileInvalidTimelineLanding,
        maxRetries: CHAT_TIMELINE_NAVIGATION_MAX_RETRIES,
      });
    },
    [reconcileInvalidTimelineLanding, setTimelineMode],
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
      expectedAnchorScrollTopRef.current = null;
      pendingTimelineAnchorRef.current = messageId;
      positionedTimelineAnchorRef.current = null;
      settledTimelineAnchorRef.current = null;
      activeTimelineAnchorIndexRef.current = null;
      pendingAnchorScrollRestoreRef.current = null;
      if (anchorScrollRestoreFrameRef.current !== null) {
        cancelAnimationFrame(anchorScrollRestoreFrameRef.current);
        anchorScrollRestoreFrameRef.current = null;
      }
      // Ticket 19: fresh session, fresh motion/physical bookkeeping - a
      // stale active-motion generation from a superseded session must not
      // exempt this one, and the physical snapshot needs a same-session
      // baseline for the capture listener's clamp check (design's "seeded
      // on entry to an anchoring generation"). Reading the scroll node here
      // (not deferring to the first captured event) means a session with no
      // natural scroll before its own positioning still has a baseline.
      activeAnchorImperativeMotionGenerationRef.current = null;
      const scrollNodeAtBegin = chatTimelineRef.current?.getScrollableNode();
      anchoringPhysicalSnapshotRef.current = scrollNodeAtBegin
        ? {
            scrollTop: scrollNodeAtBegin.scrollTop,
            maxScrollTop: Math.max(
              0,
              scrollNodeAtBegin.scrollHeight - scrollNodeAtBegin.clientHeight,
            ),
          }
        : null;
      suppressFollowRestoreRef.current = false;
      anchorAnimatedRef.current = animated;
      cancelPillShow();
      setShowScrollToBottom(false);
      setScrollMode("anchoring-new-turn");
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
      timelineAnchorMessageIdRef.current = messageId;
      setTimelineAnchorMessageId(messageId);
    },
    [cancelPillShow],
  );

  // Ticket 13 (decision #28, the "hard half"): a setup card can weave in
  // directly above the turn's anchor row AFTER anchoring already began - the
  // `setup.creating` event lands async, later than the send that created the
  // pending row, so `classifyChatEdgeMutation` sees a plain non-tail system-row
  // insertion (`NONE_OUTCOME`) rather than a fresh anchor-triggering event.
  // Left alone, LegendList's `maintainVisibleContentPosition` would keep the
  // ALREADY-anchored row pinned at its current pixel position, scrolling the
  // new card entirely off-screen above it instead of revealing setup progress.
  // This re-points the SAME anchoring session at the card's row id - same
  // semantic turn, new target row, called from the edge-mutation effect below
  // whenever the resolved target changes while still anchoring.
  //
  // Deliberately REUSES `anchorUserScrollGenerationRef` rather than bumping
  // it: a bump is this component's signal for a genuine CANCEL (a real
  // gesture invalidating in-flight `onAnchorReady`/settle callbacks for
  // every previously-issued messageId at once, `cancelTimelineLiveFollowFor-
  // UserNavigation`); a retarget is not a cancel, so nothing else about the
  // turn (mode, live-follow generation, `animated`, overflow tracking)
  // should reset. Staleness for the OLD target is instead handled the same
  // way any other superseded anchor request already is:
  // `shouldAcceptChatAnchorReadyEvent` only accepts an `onAnchorReady` whose
  // messageId matches `pendingTimelineAnchorRef`/`positionedTimelineAnchorRef`
  // - both of which this reassigns to the new id up front, so a late
  // `onAnchorReady` for the old row falls through as stale on its own. Also
  // resets `expectedAnchorScrollTopRef` (the anchor mover's departure-guard
  // baseline, `anchorMoverShouldYieldToReader`) since it was computed against
  // the OLD target's geometry - stale to the new target, and safely `null`
  // until the fresh positioning cycle below recomputes it (both mover checks
  // that consult it treat `null` as "nothing to compare against yet").
  const retargetAnchoringNewTurn = useCallback((messageId: string): void => {
    if (timelineAnchorMessageIdRef.current === messageId) return;
    expectedAnchorScrollTopRef.current = null;
    pendingTimelineAnchorRef.current = messageId;
    positionedTimelineAnchorRef.current = null;
    settledTimelineAnchorRef.current = null;
    activeTimelineAnchorIndexRef.current = null;
    pendingAnchorScrollRestoreRef.current = null;
    if (anchorScrollRestoreFrameRef.current !== null) {
      cancelAnimationFrame(anchorScrollRestoreFrameRef.current);
      anchorScrollRestoreFrameRef.current = null;
    }
    // Ticket 19: the OLD target's settle window (if any) is being
    // superseded the same way `positionedTimelineAnchorRef` above is - the
    // new target's own positioning re-arms this fresh, same generation.
    activeAnchorImperativeMotionGenerationRef.current = null;
    timelineAnchorMessageIdRef.current = messageId;
    setTimelineAnchorMessageId(messageId);
  }, []);

  // Intent listeners (decision #5): passive wheel/touchmove on the scroll
  // node cancel live-follow. Pointerdown is handled by the stable transcript
  // container below (decision #6), including while `ChatTimeline` renders its
  // empty state with no LegendList node. The scroll node's lifecycle does not
  // match this component's own mount: it may not exist yet at mount (an
  // empty-then-first-message chat), and it is torn down and replaced by a NEW
  // node across any non-empty -> empty -> repopulated cycle. Poll every frame
  // until the node appears (cheap - one ref read + identity check),
  // re-attaching whenever it changes; stop polling once attached. Re-armed
  // whenever `hasContent` toggles so a later empty/repopulate cycle gets
  // picked up again.
  useLayoutEffect(() => {
    if (!hasContent) return;
    let cancelled = false;
    let frame: number | null = null;
    let attachedNode: HTMLElement | null = null;

    // Touchmove already replaces whatever the scroll was doing with real,
    // immediate movement of its own, so its own subsequent report must not
    // be swallowed - plain release, no freeze.
    const handleManualNavigationWithMovement = () => {
      cancelTimelineLiveFollowForUserNavigationRef.current(false);
    };
    // Ticket 14 (direction A): unlike touchmove, `wheel` keeps firing after
    // the viewport has clamped at the bottom - macOS trackpad momentum
    // synthesizes further wheel events with no scroll of their own. A
    // downward one arriving there must not cancel follow (root-cause:
    // rootcause-follow-loss field bug H-B); an upward one still does. Reads
    // `getState().isAtEnd` and `timelineScrollModeRef` fresh on every event
    // rather than closing over a render value - this listener is attached
    // once via `addEventListener`, not re-subscribed on state changes. The
    // mode check (review fix) scopes the exemption to `following-end` only -
    // `anchoring-new-turn`'s reserve-capped geometry can also read
    // `isAtEnd=true` short of the turn's true end (see
    // `chatWheelShouldCancelLiveFollow`'s own doc comment), where a downward
    // wheel is real departure intent and must still cancel.
    const handleWheelNavigation = (event: globalThis.WheelEvent): void => {
      const isAtLiveEdge = chatTimelineRef.current?.getState().isAtEnd ?? false;
      const isFollowingEnd = timelineScrollModeRef.current === "following-end";
      if (
        !chatWheelShouldCancelLiveFollow(
          event.deltaY,
          isAtLiveEdge,
          isFollowingEnd,
        )
      ) {
        return;
      }
      cancelTimelineLiveFollowForUserNavigationRef.current(false);
    };
    const detach = (): void => {
      if (attachedNode === null) return;
      attachedNode.removeEventListener("wheel", handleWheelNavigation);
      attachedNode.removeEventListener(
        "touchmove",
        handleManualNavigationWithMovement,
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
      scrollNode.addEventListener("wheel", handleWheelNavigation, {
        passive: true,
      });
      scrollNode.addEventListener(
        "touchmove",
        handleManualNavigationWithMovement,
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

  // Ticket 19 (decision #31): the capture-provenance classifier's ONE
  // native listener - installed on the STABLE transcript wrapper (unlike
  // the wheel/touch listeners above, it never needs to track scroll-node
  // replacement across an empty/repopulate cycle; it simply filters each
  // captured event to whichever scroll node is current right now). Capture
  // phase (`{ capture: true }`) is load-bearing - it is what lets this
  // listener observe the raw DOM state before LegendList's own non-capture
  // target listener consumes the event; see
  // `chatAnchorScrollCaptureShouldCancel`'s doc comment (chat-messages-
  // scroll-helpers.ts) for the full library-ordering proof this depends on,
  // and the dedicated library-contract pins that gate a future
  // `@legendapp/list` upgrade.
  useLayoutEffect(() => {
    const container = transcriptContainerRef.current;
    if (!container) return;
    const handleCapturedScroll = (event: Event): void => {
      const list = chatTimelineRef.current;
      if (!list) return;
      const scrollNode = list.getScrollableNode();
      // Any nested scrollable region (a code block, a horizontally
      // overflowing table) also dispatches `scroll` events this ancestor
      // capture listener observes - `scroll` never bubbles, but capturing
      // phase runs regardless, for EVERY descendant's own scroll, not just
      // the transcript's. Only the transcript's own scroll node is this
      // classifier's concern.
      if (event.target !== scrollNode) return;
      const domScrollTop = scrollNode.scrollTop;
      const currentMaxScrollTop = Math.max(
        0,
        scrollNode.scrollHeight - scrollNode.clientHeight,
      );
      const generationOwned =
        liveFollowUserScrollGenerationRef.current ===
        anchorUserScrollGenerationRef.current;
      const shouldCancel = chatAnchorScrollCaptureShouldCancel({
        isAnchoringSessionOwned:
          timelineScrollModeRef.current === "anchoring-new-turn" &&
          generationOwned,
        activeAnchorMotionOwnsGeneration:
          activeAnchorImperativeMotionGenerationRef.current ===
          anchorUserScrollGenerationRef.current,
        domScrollTop,
        listStateScroll: list.getState().scroll,
        previousSnapshot: anchoringPhysicalSnapshotRef.current,
        currentMaxScrollTop,
      });
      // Design step 2: refresh regardless of outcome, so the NEXT captured
      // event - in any mode - always compares against the last real
      // physical position, not a stale one from several mode transitions
      // ago. Refreshed AFTER classifying this event (which needs the OLD
      // snapshot as its "previous" input), BEFORE acting on the result.
      anchoringPhysicalSnapshotRef.current = {
        scrollTop: domScrollTop,
        maxScrollTop: currentMaxScrollTop,
      };
      if (shouldCancel) {
        cancelTimelineLiveFollowForUserNavigationRef.current(false);
      }
    };
    container.addEventListener("scroll", handleCapturedScroll, {
      capture: true,
    });
    return () => {
      container.removeEventListener("scroll", handleCapturedScroll, {
        capture: true,
      });
    };
  }, []);

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
          const scrollTopBeforeIssue = scrollNode.scrollTop;
          const expectedScrollTopAtIssue = expectedAnchorScrollTop(
            list,
            currentAnchorIndex,
            anchorOffsetRef.current,
            listTopOffsetAdjustmentRef.current,
          );
          expectedAnchorScrollTopRef.current = expectedScrollTopAtIssue;
          const minimumUndepartedScrollTop =
            expectedScrollTopAtIssue === null
              ? scrollTopBeforeIssue
              : Math.min(scrollTopBeforeIssue, expectedScrollTopAtIssue);
          // Ticket 18 (near/far split, adopted verdict; extracted to a pure
          // function per review finding for direct truth-table coverage):
          // trust an ANIMATED hop only across a bounded distance - an
          // unmeasured target's position is unknowable, so treat it as far
          // (instant) rather than guess near. `anchorAnimatedRef.current` is
          // `false` only for the fresh-open seed (decision #15) - that stays
          // instant regardless of distance, same as before.
          const shouldAnimateInitialIssue =
            chatTimelineAnchorShouldAnimateInitialIssue({
              anchorAnimated: anchorAnimatedRef.current,
              currentScrollTop: scrollTopBeforeIssue,
              expectedTargetScrollTop: expectedScrollTopAtIssue,
              viewportLength: list.getState().scrollLength,
              maxAnimateViewports: CHAT_TIMELINE_ANCHOR_ANIMATE_MAX_VIEWPORTS,
            });

          // Ticket 18: resolves the anchor's CURRENT target index fresh on
          // every check - a weave (ticket 13's setup-card retarget) or a
          // measurement pass can shift it between attempts, same reasoning
          // as `currentAnchorIndex` above.
          const anchorSettleTargetIndex = (): number =>
            activeTimelineAnchorIndexRef.current ?? currentAnchorIndex;
          // Round-2 finding 1 (now covered by the mode-based freeze condition
          // in `cancelTimelineLiveFollowForUserNavigation`, overengineering-
          // audit collapse): every real send/steer/edit/queued-flush/A2A
          // anchor runs during `anchoring-new-turn` - a bare pointerdown
          // mid-animation is covered by `modeAtEntry !== "free-scrolling"`
          // with no per-operation bookkeeping needed here. The live-verified
          // OS-scrollbar-drag exception (no wheel/touch/pointerdown of its
          // own) is what `shouldYieldToReader` below still exists to catch.
          const shouldYieldToReader = (): boolean =>
            anchorMoverShouldYieldToReader(
              scrollNode.scrollTop,
              minimumUndepartedScrollTop,
              expectedAnchorScrollTop(
                list,
                anchorSettleTargetIndex(),
                anchorOffsetRef.current,
                listTopOffsetAdjustmentRef.current,
              ),
            );
          // Ticket 18: the same index-offset validator ticket 10 already
          // uses for minimap/find/deep-link (`chatTimelineNavigationLandedAtLocation`)
          // - commonizing rather than keeping the anchor engine's own
          // bespoke offset check.
          const anchorLandedAtLocation = (): boolean =>
            chatTimelineNavigationLandedAtLocation(
              {
                positionAtIndex: (index) =>
                  list.getState().positionAtIndex(index),
                scroll: scrollNode.scrollTop,
                topOffsetAdjustment: listTopOffsetAdjustmentRef.current,
              },
              {
                index: anchorSettleTargetIndex(),
                viewOffset: anchorOffsetRef.current,
                animated: false,
              },
              CHAT_TIMELINE_NAVIGATION_LANDING_EPSILON_PX,
            );
          const measureSettledOverflow = (): void => {
            const metrics = getActiveTimelineTurnMetrics(list);
            if (metrics) {
              anchoredTurnOverflowsViewportRef.current =
                metrics.overflowsUsableViewport;
              setAnchoredTurnOverflowsViewport(metrics.overflowsUsableViewport);
            }
          };

          // Ticket 19: arm immediately before issuing the command - the
          // ONE generation-scoped in-flight ref the machinery cap allows
          // (decision #31d). Every guard above this point has already
          // confirmed `generationAtReady` is still current, so arming to it
          // here (not `anchorUserScrollGenerationRef.current` - same value,
          // but this documents which one this closure owns) is safe.
          activeAnchorImperativeMotionGenerationRef.current = generationAtReady;
          let pendingAnchorScrollPromise = list.scrollToIndex({
            index: currentAnchorIndex,
            animated: shouldAnimateInitialIssue,
            viewPosition: 0,
            viewOffset: anchorOffsetRef.current,
          });
          // Review round 2: whether the MOST RECENT `awaitSettle` wakeup was
          // the local fallback timer, not LegendList's own promise. Local to
          // this closure (never read outside it) - `validate` below checks
          // it first, so a timeout can only ever drive the SAME reissue/
          // fail-safe path an ordinary failed validation already takes,
          // never a blind settle against a possibly-still-animating DOM
          // position. Reassigned synchronously inside the same callback
          // chain that leads to `validate` running, so there is no window
          // where a stale value from an earlier attempt could be read.
          let lastAnchorSettleTimedOut = false;
          activeNavigationSettleCleanupRef.current =
            settleChatTimelineNavigation({
              awaitSettle: (onSettle) =>
                awaitChatTimelineScrollPromiseSettle(
                  () => pendingAnchorScrollPromise,
                  (timedOut) => {
                    lastAnchorSettleTimedOut = timedOut;
                    onSettle();
                  },
                  CHAT_TIMELINE_ANCHOR_SCROLL_PROMISE_TIMEOUT_MS,
                ),
              isAborted: () =>
                anchorUserScrollGenerationRef.current !== generationAtReady ||
                positionedTimelineAnchorRef.current !== messageId ||
                timelineScrollModeRef.current !== "anchoring-new-turn",
              shouldYieldToReader,
              validate: () =>
                !lastAnchorSettleTimedOut && anchorLandedAtLocation(),
              // Re-issue the SAME positioning command, non-animated, rather
              // than re-pinning to wherever we happen to be - recomputing
              // the target from the anchor index (not a stale captured
              // offset) self-corrects both an estimate-drift undershoot and
              // a still-resolving `anchoredEndSpace` reserve clamp.
              reissue: () => {
                // Ticket 19: retained across the re-issue - still the same
                // generation, still the same anchor-issue closure (design's
                // "retain across settle re-issues"). Re-set (not just left
                // alone) so a reissue is defensively self-arming too.
                activeAnchorImperativeMotionGenerationRef.current =
                  generationAtReady;
                pendingAnchorScrollPromise = list.scrollToIndex({
                  index: anchorSettleTargetIndex(),
                  animated: false,
                  viewPosition: 0,
                  viewOffset: anchorOffsetRef.current,
                });
              },
              onSettledValid: () => {
                // Ticket 19: the motion window this session owned is over -
                // symmetric with the arm sites above.
                if (
                  activeAnchorImperativeMotionGenerationRef.current ===
                  generationAtReady
                ) {
                  activeAnchorImperativeMotionGenerationRef.current = null;
                }
                expectedAnchorScrollTopRef.current = expectedAnchorScrollTop(
                  list,
                  anchorSettleTargetIndex(),
                  anchorOffsetRef.current,
                  listTopOffsetAdjustmentRef.current,
                );
                settledTimelineAnchorRef.current = messageId;
                // The reveal-pass effect only re-measures overflow on a
                // `messages` change - a fresh-open anchor onto an already-
                // settled turn (decision #15: "the pill points at the tail
                // of a long final reply") never gets one after this.
                // Measure once here too so the pill reflects overflow even
                // when nothing streams in afterward.
                measureSettledOverflow();
              },
              onSettledInvalid: () => {
                // Ticket 19: same symmetric clear as onSettledValid - a
                // corrective operation that gives up must not leave the
                // capture classifier believing motion is still in flight.
                if (
                  activeAnchorImperativeMotionGenerationRef.current ===
                  generationAtReady
                ) {
                  activeAnchorImperativeMotionGenerationRef.current = null;
                }
                // Ticket 18 safety cap: a corrective operation that cannot
                // safely land must never claim settled. Log only the
                // genuine non-convergence case, not the (expected, correct)
                // reader-departure yield - `shouldYieldToReader` is a pure
                // re-check of the same condition the loop just evaluated,
                // synchronously, so it reflects exactly which branch called
                // this.
                if (!shouldYieldToReader()) {
                  appLogger.warn(
                    "[chat-messages] anchor settle exhausted retries without a validated landing",
                    {
                      messageId,
                      anchorIndex: anchorSettleTargetIndex(),
                    },
                  );
                }
                reconcileInvalidTimelineLanding();
              },
              maxRetries: CHAT_TIMELINE_NAVIGATION_MAX_RETRIES,
            });
        });
      };
      requestAnimationFrame(() => positionAnchor(12));
    },
    [getActiveTimelineTurnMetrics, reconcileInvalidTimelineLanding],
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

      const currentScrollTop =
        chatTimelineRef.current?.getScrollableNode().scrollTop;
      const previousOwnedScrollTop = lastOwnedScrollTopRef.current;
      const generationOwned =
        liveFollowUserScrollGenerationRef.current ===
        anchorUserScrollGenerationRef.current;
      const { shouldSwallow, nextOwnedScrollTop } = resolveOwnedAtEndReport({
        isAtEnd,
        mode: timelineScrollModeRef.current,
        generationOwned,
        currentScrollTop,
        previousOwnedScrollTop,
      });
      lastOwnedScrollTopRef.current = nextOwnedScrollTop;

      if (shouldSwallow) {
        // Transient isAtEnd=false while WE own the scroll (mid-flight
        // animated scrollToIndex, initialScrollAtEnd settling, or streaming
        // growth with a non-decreasing scrollTop): not a gesture. A decrease
        // while following is an OS-scrollbar-style user departure and falls
        // through to the ordinary free-scrolling transition below.
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
        lastOwnedScrollTopRef.current = null;
        setScrollMode("free-scrolling");
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
      const suppressionAtSchedule = suppressFollowRestoreRef.current;
      // A free-scrolling reader may be at the tail when follow is released,
      // either through a suppressed programmatic navigation or a scroll-less
      // gesture such as pointerdown. Later growth moves no scroll position,
      // so no native event exists to drive onIsAtEndChange. Reconcile only
      // the pill here while that suppression state remains stable; the
      // no-follow contract and scroll position stay intact.
      return scheduleChatTimelineDoubleRaf(() => {
        if (
          liveFollowUserScrollGenerationRef.current ===
            anchorUserScrollGenerationRef.current ||
          suppressFollowRestoreRef.current !== suppressionAtSchedule
        ) {
          return;
        }
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
          // Ticket 18 (reorder, root-cause: rootcause-send-undershoot report,
          // fix requirement #3): the anchor-position invariant repair below
          // must run BEFORE "stop revealing after overflow" - that
          // early-return presumes the anchor is already correctly
          // positioned, which a still-growing prior turn's content ABOVE the
          // anchor can invalidate regardless of whether THIS turn's own
          // content overflows.
          //
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
          //
          // Ticket 22: this repair is shared with the geometry-only
          // scheduler below (`scheduleChatAnchorGeometryRepair`) - same
          // computation, same generation/departure guards, invoked here
          // unchanged for a `messages` change and there for a coalesced
          // item-size/viewport-length change under the SAME `messages`.
          const repairOutcome = applyChatAnchorDriftRepair({
            list,
            anchorTop: metrics.anchorTop,
            listTopOffsetAdjustment: listTopOffsetAdjustmentRef.current,
            anchorOffset: anchorOffsetRef.current,
            expectedAnchorScrollTopRef,
          });
          if (repairOutcome !== "settled") {
            // A scroll-only upward departure ("yielded") leaves mode
            // ownership intact, but the corrective mover must not pull the
            // reader back; a "corrected" pass already issued this frame's
            // scroll write.
            return;
          }
          // Deliberate live-E2E merge-blocker fix: revealing the minimum delta
          // toward the real end for the WHOLE turn would create genuine
          // bottom-follow-while-streaming. Decision #1 drops that default;
          // decision #10 requires completion below the fold to stay anchored
          // with no auto-reveal; decision #16's "streaming" pill state exists
          // specifically for content that has accumulated below the fold. So
          // once the anchored turn's real content overflows the usable
          // viewport, this pass must STOP moving the scroll position - the
          // anchor row stays at its (now correctly repaired) offset for the
          // rest of the turn, and the pill (now showing "streaming") is the
          // sole affordance for what follows.
          // Before this point (content still fits), continuing to reveal is
          // correct - it's what lets the anchored row's own reply fill the
          // space below it as it streams in.
          if (metrics.overflowsUsableViewport) return;
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
      cancelTimelineLiveFollowForRealUserGesture(false);
      applyChatKeyboardScroll(scroller, scrollAction);
    },
    [cancelTimelineLiveFollowForRealUserGesture],
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

  // Ticket 17 (review round 2, finding 2 residual): `endInset` was
  // considered as a THIRD no-scroll geometry invalidation trigger alongside
  // `onTimelineItemSizeChanged`/`onListMetricsChange` above, and deliberately
  // dropped - it is PROVABLY unable to affect `viewportLastVisibleSnapshotRef`'s
  // correctness, not just unlikely to. `contentInsetEndAdjustment` only pads
  // scrollable space AFTER the last real row (verified against the installed
  // LegendList 3.2.0 source's `getContentInsetEnd`/max-scroll math, same
  // conclusion the F3 save-path's own natural-max-scroll formula relies on);
  // `getState().end` is purely a function of row positions vs. scrollTop -
  // for any scrollTop still within actual content, `end` cannot depend on
  // `endInset` at all, and once scrolled far enough to reach the true tail,
  // `end` simply clamps to `data.length - 1` regardless of inset size. There
  // is no scrollTop at which changing `endInset` alone changes what
  // `getState().end` reports, so there is nothing here for an invalidation
  // to protect against.

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

  // Ticket 15 (review-round en-route fix a): the save effect below only
  // needs `endInset`'s LATEST value at the moment it actually fires
  // (genuine unmount/hide), not a reason to re-fire itself - reading it via
  // a ref, not a dependency, keeps the effect from tearing down and
  // resaving on every composer resize (which made `hasSavedChatTabState`
  // unreliable: an in-progress reader kept getting treated as freshly
  // saved).
  const endInsetRef = useRef(endInset);
  useLayoutEffect(() => {
    endInsetRef.current = endInset;
  }, [endInset]);

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
  > => {
    // `anchoring-new-turn` never persists as its own mode (see
    // `chat-tab-state-cache.ts`): a remount mid-anchor has no live
    // anchor/settle sequence left to resume, so it collapses to
    // `free-scrolling` at wherever it had settled - same as any other
    // unpinned reading position.
    const wasAnchoring = timelineScrollModeRef.current === "anchoring-new-turn";
    const mode: ChatTabScrollMode =
      timelineScrollModeRef.current === "following-end"
        ? "following-end"
        : "free-scrolling";
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
    const liveActiveUserMessageId =
      list === null
        ? null
        : viewportActiveUserMessageId(
            {
              ...list.getState(),
              scroll: list.getScrollableNode().scrollTop,
              topOffsetAdjustment: listTopOffsetAdjustmentRef.current,
            },
            messagesRef.current,
          );
    const anchorMessageId =
      mode === "free-scrolling"
        ? (liveActiveUserMessageId ?? scrolledActiveUserMessageIdRef.current)
        : null;
    const anchorIndex =
      anchorMessageId === null
        ? undefined
        : messageIndexByIdRef.current.get(anchorMessageId);
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
      const lastBottom = getChatRowBottom(listState, listState.data.length - 1);
      if (lastBottom !== null) {
        naturalMaxScroll = getChatNaturalMaxScrollWithoutAnchorReserve({
          headerSize: listTopOffsetAdjustmentRef.current,
          footerSize: listFooterSizeRef.current,
          lastBottom,
          endInset: endInsetRef.current,
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
      offset: captureChatFreeScrollingOffset(
        measurementSource,
        anchorIndex,
        naturalMaxScroll,
      ),
    };
  }, []);

  // Persist the reading position on unmount (chat tiles fully remount per tab
  // switch - decision #17 - so this is the sole persistence path; the
  // display:none keep-alive `useScrollRestoration` machinery other tile kinds
  // use does not apply here and is intentionally not wired in).
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
  useLayoutEffect(
    () => () => {
      const isLive = isEpicCanvasTileInstanceLive(instanceId);
      const commit = isLive ? saveChatTabState : commitChatTabStateToDurable;
      commit({ identity, ...captureLiveChatTabScrollSnapshot() });
    },
    [identity, instanceId, captureLiveChatTabScrollSnapshot],
  );

  // Ticket 20: register the SAME capture for the canvas store's pre-
  // structural-mutation viewport handoff (`chat-tab-viewport-handoff.ts`) - a
  // drag/split-wrap/dissolve/tear-off action creator flushes this
  // synchronously just BEFORE it commits a move that retains `instanceId`
  // under a new React parent, so the replacement mount's `restoreChatTabState`
  // initializer reads the fresh position instead of whatever was already
  // cached. Registered live-only (only a currently-mounted tile has any DOM
  // viewport worth capturing) - a background/never-mounted-yet tab is simply
  // absent from the registry, same shape as the close-sweep promotion
  // (`promoteChatTabPersistenceToDurable`) this pattern reuses. Always
  // `saveChatTabState` (never the durable-only commit): this component is by
  // construction live for the whole window it stays registered.
  useLayoutEffect(
    () =>
      registerChatTabViewportCapture(instanceId, () => {
        saveChatTabState({ identity, ...captureLiveChatTabScrollSnapshot() });
      }),
    [identity, instanceId, captureLiveChatTabScrollSnapshot],
  );

  const onListMetricsChange = useCallback(
    (metrics: {
      readonly headerSize: number;
      readonly footerSize: number;
    }): void => {
      // Ticket 17 (review round 2, finding 2 residual) - invalidate BEFORE
      // overwriting the previous values, and only on a GENUINE change: the
      // fade header's `h-10 sm:h-12` (ticket 16/M4 - was `h-16 sm:h-20`) is a
      // responsive breakpoint (a viewport resize crossing it remeasures
      // headerSize with no scroll or `messages` change - same class as
      // `onTimelineItemSizeChanged` below and the `scrollLength` tag on the
      // classify read site further below), but this callback can also just
      // re-report an UNCHANGED value on an ordinary settle pass - nulling on
      // every call regardless would make the snapshot never usably survive
      // to the next classify, which is not what this fix is for.
      if (
        metrics.headerSize !== listTopOffsetAdjustmentRef.current ||
        metrics.footerSize !== listFooterSizeRef.current
      ) {
        viewportLastVisibleSnapshotRef.current = null;
      }
      // Chat timeline does not set stylePaddingTop / alignItemsAtEndPadding, so
      // headerSize alone is the getTopOffsetAdjustment pad that restore re-adds.
      listTopOffsetAdjustmentRef.current = metrics.headerSize;
      // Footer joins header in F3's no-reserve max-scroll bound.
      listFooterSizeRef.current = metrics.footerSize;
    },
    [],
  );
  // Ticket 22 (painted-chat lifecycle audit, finding 3): the two-rAF reveal
  // pass's anchor-drift repair only re-runs on a `messages` change - a
  // divider drag/pane split-join/header resize/disclosure toggle can rewrap
  // rows under the SAME `messages` array, and nothing schedules a repair for
  // that today. Reuses `applyChatAnchorDriftRepair` (the same computation the
  // reveal pass calls) behind an independent two-rAF coalescing window, so
  // several item-size/viewport-layout notifications inside one resize/toggle
  // collapse into a single repair pass instead of one per notification.
  //
  // Guarded exactly like the reveal pass's own anchoring-new-turn branch:
  // mode, generation ownership, "no anchor navigation currently mid-flight",
  // then the shared repair's own departure (`anchorMoverShouldYieldToReader`)
  // check - a departed/cancelled session gets no correction (base rule:
  // never move the reader against their intent). Re-checked fresh INSIDE the
  // deferred frame (not just at schedule time), same convention as
  // `onTimelineAnchorSizeChanged` above - either can change between the
  // triggering call and the frame actually running.
  const scheduleChatAnchorGeometryRepair = useCallback((): void => {
    if (timelineScrollModeRef.current !== "anchoring-new-turn") return;
    if (pendingGeometryRepairCancelRef.current !== null) return;
    pendingGeometryRepairCancelRef.current = scheduleChatTimelineDoubleRaf(
      () => {
        pendingGeometryRepairCancelRef.current = null;
        if (timelineScrollModeRef.current !== "anchoring-new-turn") return;
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
        const metrics = getActiveTimelineTurnMetrics(list);
        if (!metrics) return;
        applyChatAnchorDriftRepair({
          list,
          anchorTop: metrics.anchorTop,
          listTopOffsetAdjustment: listTopOffsetAdjustmentRef.current,
          anchorOffset: anchorOffsetRef.current,
          expectedAnchorScrollTopRef,
        });
      },
    );
  }, [getActiveTimelineTurnMetrics]);

  useEffect(() => {
    return () => {
      // Review round 1 (finding 1, CONFIRMED HIGH): cancelling without
      // clearing the sentinel leaves it permanently non-null after a
      // StrictMode setup->cleanup->setup replay (the deferred callback that
      // would have cleared it never runs, since `cancel()` cancels the rAFs
      // it was scheduled in) - every later trigger then exits at the
      // `!== null` guard above for the rest of the mount's lifetime. Read
      // once and clear before invoking, so a schedule call made from the
      // replayed setup (or any later mount) is never blocked by a dead
      // cancel function from a cleanup that already ran.
      const cancel = pendingGeometryRepairCancelRef.current;
      if (cancel === null) return;
      pendingGeometryRepairCancelRef.current = null;
      cancel();
    };
  }, []);

  const onTimelineItemSizeChanged = useCallback((): void => {
    minimapInViewRefreshRef.current();
    // Ticket 17 (review round 2, finding 2 residual, CONFIRMED HIGH): a row's
    // real measured size can change under the SAME `messages` array with no
    // scroll (e.g. an activity-group disclosure collapsing/expanding - that
    // open/closed state lives in a separate store, not in `messages`), moving
    // MORE or fewer rows into view without ever touching the identity gate
    // from the earlier round's fix. Invalidate rather than trust a snapshot
    // whose geometry may have shifted underneath it; unknown -> case (b), the
    // same safe default as an un-observed snapshot.
    viewportLastVisibleSnapshotRef.current = null;
    // Ticket 22: the same real, no-scroll size change can also move an
    // anchoring-new-turn session's already-settled anchor.
    scheduleChatAnchorGeometryRepair();
  }, [scheduleChatAnchorGeometryRepair]);

  // Ticket 22: viewport-length changes (divider drag/pane resize) - unlike
  // item-size changes, LegendList never reports these as a scroll, a data
  // change, or an item resize; nothing else in this file observes them.
  const onTimelineViewportLayoutChanged = useCallback((): void => {
    scheduleChatAnchorGeometryRepair();
  }, [scheduleChatAnchorGeometryRepair]);

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
          // Ticket 17: at the tail, the last visible row IS the last row.
          const scrollLengthAtBottom =
            chatTimelineRef.current?.getState().scrollLength;
          if (scrollLengthAtBottom !== undefined) {
            viewportLastVisibleSnapshotRef.current = {
              messages,
              lastVisibleMessageId: messages.at(-1)?.id ?? null,
              scrollLength: scrollLengthAtBottom,
            };
          }
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
        // Ticket 17: `end` is LegendList's own no-buffer last-visible index
        // (`getState().end`) - the suffix-removal classifier's viewport
        // input. Tracked independently of the reading-line anchor above
        // (`nextActiveUserMessageId`, which can be `null` on an
        // all-assistant transcript with no human row to report). Tagged with
        // this callback's own `messages` closure AND `rawState.scrollLength`
        // (see the ref's own doc comment for why both tags - not just update
        // ordering - are load bearing).
        viewportLastVisibleSnapshotRef.current = {
          messages,
          lastVisibleMessageId: messages[rawState.end]?.id ?? null,
          scrollLength: rawState.scrollLength,
        };
      },
      [messages, setScrolledActiveUserMessageIdIfChanged],
    ),
  );

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
  // silently re-enable follow (H3). Suppresses the same way any other
  // programmatic free-scrolling landing does.
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
      scrollToTimelineLocation(location);
      const list = chatTimelineRef.current;
      if (!list) return;
      const scrollNode = list.getScrollableNode();
      activeNavigationSettleCleanupRef.current = settleChatTimelineNavigation({
        awaitSettle: (onSettle) =>
          awaitScrollSettle(
            scrollNode,
            onSettle,
            CHAT_ANCHOR_SETTLE_FALLBACK_MS,
          ),
        isAborted: () =>
          anchorUserScrollGenerationRef.current !== generationAtIssue ||
          !suppressFollowRestoreRef.current,
        // No reader-departure detection here (unlike the anchor engine) - a
        // real gesture already bumps the generation and is caught above.
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
          void list.scrollToIndex({
            index: location.index,
            animated: false,
            viewPosition: 0,
            viewOffset: location.viewOffset,
          });
        },
        onSettledValid: () => {},
        onSettledInvalid: () => {
          // Accept - already correctly free-scrolling/suppressed wherever
          // the bounded retries landed; nothing claims to be "at this exact
          // spot" the way following-end does, so there is no mode to
          // reconcile.
        },
        maxRetries: CHAT_TIMELINE_NAVIGATION_MAX_RETRIES,
      });
    },
    [scrollToTimelineLocation],
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
  const navigateToMessage = useCallback(
    (messageId: string, highlight: boolean, animated: boolean): void => {
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
  useEffect(() => {
    const anchorId = pendingHydrationRestoreAnchorIdRef.current;
    if (anchorId === null) return;
    const index = messageIndexByIdRef.current.get(anchorId);
    if (index === undefined) return;
    pendingHydrationRestoreAnchorIdRef.current = null;
    // Lands the ROW - the severity this fixes is losing the anchor
    // entirely (landing in the wrong region of the transcript), not
    // sub-row pixel precision. Reuses the same jump-and-land machinery
    // every other programmatic navigation in this file already goes
    // through (minimap/find/deep-link), rather than hand-driving
    // `scrollToIndex`'s own `viewOffset` outside its one established
    // caller (`chatTimelineLocationForMessage`'s fixed navigation
    // padding). Non-animated (ticket 20): this is a restore finally
    // resolving, not a fresh navigation - the reader must never see it
    // visibly scroll to land.
    navigateToMessage(anchorId, false, false);
  }, [messages, navigateToMessage]);

  const onMinimapItemSelect = useCallback(
    (messageId: string): void => navigateToMessage(messageId, false, true),
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
      backgroundToolBlockIds,
      backgroundToolBlockIdsRef,
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
    // Ticket 17 (review round: finding 2 fix) - only trust the snapshot when
    // it was observed against THIS EXACT `previousMessages` array; a stale
    // (coalesced-away or never-yet-observed) snapshot resolves to `null`
    // (unknown -> case (b), never a guessed case (a)). See
    // `viewportLastVisibleSnapshotRef`'s own doc comment.
    //
    // Ticket 17 (review round 3, finding 2 residual) - ALSO require the
    // snapshot's `scrollLength` to still match a FRESH read: a height-only
    // pane resize can move the observation's `messages` identity along
    // unchanged while genuinely invalidating what row was last-visible.
    // `getState().scrollLength` is LegendList's own live internal value, not
    // something derived from React props, so reading it here (synchronously,
    // before acting on this transition) reflects the CURRENT viewport even
    // if no React render happened between the resize and this delete.
    const lastVisibleSnapshot = viewportLastVisibleSnapshotRef.current;
    const currentScrollLength =
      chatTimelineRef.current?.getState().scrollLength;
    const lastVisibleMessageId =
      lastVisibleSnapshot !== null &&
      lastVisibleSnapshot.messages === previousMessages &&
      lastVisibleSnapshot.scrollLength === currentScrollLength
        ? lastVisibleSnapshot.lastVisibleMessageId
        : null;
    const outcome = classifyChatEdgeMutation({
      previousMessages,
      nextMessages: messages,
      isFollowingEnd: timelineScrollModeRef.current === "following-end",
      hadSavedScrollState,
      isChatStreaming,
      localProvenanceMessageIds,
      lastVisibleMessageId,
    });
    if (outcome.action.kind === "scroll-to-end") {
      // Ticket 17 (live pass S4B, confirmed defect): `setTimelineMode`
      // alone flips the rendered mode but does NOT terminate a live
      // `anchoring-new-turn` session - its generation, pending/positioned/
      // settled refs, and `timelineAnchorMessageId` all survive untouched.
      // Two independent problems this closes, regardless of which one
      // explains any specific live symptom: (1) `timelineAnchorMessageId`
      // feeds `anchorMessageId` on `<ChatTimeline>` unconditionally
      // (`resolveChatListAnchoredEndSpace` in chat-scroll-anchoring.ts has
      // no mode gate of its own) - left set, it keeps reserving trailing
      // space for a turn this session no longer tracks as anchoring, even
      // if that message survived the deletion (pinned - "(fix 1 pin) a
      // surviving anchored message's..." below: the stale reserve measurably
      // inflates the true-end landing). (2) an in-flight `onAnchorReady`/
      // settle continuation for the OLD anchor, still carrying the OLD
      // generation/messageId, must not be able to re-assert anchor state
      // afterward - bump the generation (the same "real cancel" signal
      // `cancelTimelineLiveFollowForUserNavigation` uses) and null every
      // anchor ref so a stale continuation's own guards (`generationAtReady`/
      // `positionedTimelineAnchorRef.current !== messageId` checks) reject
      // it. Applied unconditionally for BOTH `scroll-to-end` sub-cases
      // (already-following, and a free-scrolling suffix removal whose
      // viewport touched the removed rows) - idempotent/no-op when there was
      // nothing to tear down.
      //
      // MUST run BEFORE `setTimelineMode` below, not after (review-caught
      // regression): `setTimelineMode("following-end")` captures
      // `liveFollowUserScrollGenerationRef.current =
      // anchorUserScrollGenerationRef.current` at the moment it runs. Bumping
      // the generation AFTER that capture desyncs the two refs, so every
      // subsequent `onIsAtEndChange` report reads `generationOwned: false` -
      // `resolveOwnedAtEndReport` then treats LegendList's OWN in-progress
      // `maintainScrollAtEnd` correction (jsdom's shim starts `scrollToEnd`
      // at its fake, oversized `scrollHeight` ceiling and relies on
      // LegendList's own follow-driven re-measurement passes to converge on
      // the real content end - see the [[legendlist-jsdom-shim-scrollheight-
      // trap]] class) as an unowned real departure, flipping mode away from
      // `following-end` before that convergence finishes and leaving the
      // scrollTop stuck at the fake ceiling. Bumping first keeps both refs
      // in sync, so `setTimelineMode`'s own capture reads the POST-bump
      // value and every report for this transition stays correctly owned.
      anchorUserScrollGenerationRef.current += 1;
      pendingTimelineAnchorRef.current = null;
      positionedTimelineAnchorRef.current = null;
      settledTimelineAnchorRef.current = null;
      activeTimelineAnchorIndexRef.current = null;
      timelineAnchorMessageIdRef.current = null;
      setTimelineAnchorMessageId(null);
    }
    if (outcome.nextMode !== null) {
      setTimelineMode(outcome.nextMode);
    }
    switch (outcome.action.kind) {
      case "scroll-to-end":
        // Forced here for BOTH an already-following reader and a
        // free-scrolling suffix removal whose viewport touched the removed
        // rows (`outcome.nextMode` is "following-end" in both cases) -
        // rewrite the reader mirror to the new tail SYNCHRONOUSLY rather
        // than waiting on the next rAF-throttled `scheduleActiveViewportUpdate`
        // tick below: a deleted id must never be observable in
        // `scrolledActiveUserMessageIdRef` even for the brief window before
        // that tick, since an unmount (tab close) in between would persist
        // the stale id (root-cause report's secondary finding).
        setScrolledActiveUserMessageIdIfChanged(
          selectActiveUserMessageId(messages, null, true) ??
            messages.at(-1)?.id ??
            null,
        );
        void chatTimelineRef.current?.scrollToEnd({ animated: false });
        break;
      case "anchor-new-turn":
        // Decision #28: substitute a setup card ALREADY woven above the
        // trigger row at the id level only - `consumeLocalProvenance` below
        // still needs the trigger's own id (the card is never a
        // local-provenance entry itself; substituting it there would leave
        // the real send's provenance never consumed).
        beginAnchoringNewTurn(
          resolveChatAnchorTargetWithSetupCard(
            messages,
            outcome.action.messageId,
          ),
          outcome.action.animated,
        );
        // A no-op if `messageId` was never a local-provenance match (a
        // gated queued-flush/A2A row that anchored because the reader was
        // already following-end) - `consumeLocalProvenance` guards on
        // membership itself.
        consumeLocalProvenance(outcome.action.messageId);
        break;
      case "none":
        // Ticket 13 (decision #28): a setup card weaving in directly above
        // the row this session is anchoring reads as a harmless non-tail
        // insertion here (the card is a system row, never a fresh
        // anchor-triggering event of its own) - retarget in place instead.
        if (timelineScrollModeRef.current === "anchoring-new-turn") {
          const currentTarget = timelineAnchorMessageIdRef.current;
          if (currentTarget !== null) {
            retargetAnchoringNewTurn(
              resolveChatAnchorTargetWithSetupCard(messages, currentTarget),
            );
          }
        }
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
    retargetAnchoringNewTurn,
    hadSavedScrollState,
    isChatStreaming,
    localProvenanceMessageIds,
    consumeLocalProvenance,
    scheduleActiveViewportUpdate,
    onChatFindRenderedDataChange,
    setScrolledActiveUserMessageIdIfChanged,
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
  const assistantCompletionByIdRef = useRef<ReadonlyMap<string, number | null>>(
    new Map(),
  );
  useLayoutEffect(() => {
    const previous = assistantCompletionByIdRef.current;
    const current = new Map<string, number | null>();
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      current.set(message.id, message.completedAt);
    }
    const replacedIncompleteAssistant = [...previous].some(
      ([id, completedAt]) => completedAt === null && !current.has(id),
    );
    let completedAssistant: ChatMessageModel | null = null;
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      if (
        (previous.get(message.id) === null ||
          (replacedIncompleteAssistant && !previous.has(message.id))) &&
        message.completedAt !== null &&
        !message.stopped
      ) {
        completedAssistant = message;
      }
    }
    assistantCompletionByIdRef.current = current;
    if (completedAssistant !== null) {
      const announcement = {
        key: `${completedAssistant.id}:${completedAssistant.completedAt}`,
        text: `${taskTitle} finished responding.`,
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
  const workingVerb =
    contextWorkingVerb ?? pickWorkingVerb(timelineAnchorMessageId ?? taskId);
  const scrollToEndPillState = resolveScrollToEndPillState({
    // Ticket 11 fix #2: anchoring-mode visibility now also consults reader
    // position - `anchoredTurnOverflowsViewport` alone is pure turn geometry
    // and stays true for the rest of the turn even after the reader has
    // scrolled themselves to the actual live edge via a scroll-only route
    // (root-cause: field bug 4). `anchoredTurnOverflowsViewport` itself is
    // untouched - it still gates the reveal pass's stop-at-overflow.
    visible:
      scrollMode === "anchoring-new-turn"
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
  const isFreeScrolling = scrollMode === "free-scrolling";

  return (
    <ChatOpenStoreScopeProvider value={instanceId}>
      <ActivityGroupOpenStoreProvider store={activityGroupOpenStore}>
        <ChatMeasuredItemChangeContext.Provider
          value={requestMeasuredItemChange}
        >
          <div
            ref={transcriptContainerRef}
            data-testid="chat-transcript-container"
            onPointerDown={handleTranscriptPointerDown}
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
              initialScrollAtEnd={scrollMode === "following-end"}
              initialScrollIndex={initialScrollIndexAnchor}
              anchorMessageId={timelineAnchorMessageId}
              anchorOffset={anchorOffset}
              onAnchorReady={onTimelineAnchorReady}
              onAnchorSizeChanged={onTimelineAnchorSizeChanged}
              contentInsetEndAdjustment={endInset}
              onIsAtEndChange={onIsAtEndChange}
              followEnabled={scrollMode === "following-end"}
              sizePreservationEnabled={isFreeScrolling}
              navigationHighlightedMessageId={navigationHighlightedMessageId}
              onItemSizeChanged={onTimelineItemSizeChanged}
              onListMetricsChange={onListMetricsChange}
              onLayout={onTimelineViewportLayoutChanged}
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
        </ChatMeasuredItemChangeContext.Provider>
      </ActivityGroupOpenStoreProvider>
    </ChatOpenStoreScopeProvider>
  );
}
