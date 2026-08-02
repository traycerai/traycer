import type { LegendListRef } from "@legendapp/list/react";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";

/**
 * Per-press step for the transcript's arrow-key scrolling. Chromium's own
 * arrow-key scroll step is 40px; matching it keeps the transcript feeling like
 * any other scroll region.
 */
export const CHAT_ARROW_SCROLL_STEP_PX = 40;

/** Reveal offset for programmatic message navigation (minimap clicks, find,
 *  deep links): the target row's top sits this many px below the viewport
 *  top, leaving a sliver of the preceding row visible for context. */
export const CHAT_TIMELINE_NAVIGATION_VIEW_OFFSET_PX = 48;

const CHAT_ANCHOR_MOVER_DEPARTURE_EPSILON_PX = 1;
const CHAT_SCROLL_ONLY_INTENT_EPSILON_PX = 1;

export function acceptExhaustedPersistedRestoreFallback<T>(
  restorePersistencePendingRef: { current: boolean },
  pendingMeasuredRestoreRef: { current: T | null },
): void {
  restorePersistencePendingRef.current = false;
  pendingMeasuredRestoreRef.current = null;
}

export function scrollOnlyMovementCarriesReaderIntent(input: {
  readonly previousScrollTop: number | null;
  readonly currentScrollTop: number;
  readonly libraryOwnedScrollTop: number | null;
}): boolean {
  if (input.previousScrollTop === null) return false;
  if (
    input.libraryOwnedScrollTop !== null &&
    Math.abs(input.currentScrollTop - input.libraryOwnedScrollTop) <=
      CHAT_SCROLL_ONLY_INTENT_EPSILON_PX
  ) {
    return false;
  }
  return (
    input.currentScrollTop - input.previousScrollTop >
    CHAT_SCROLL_ONLY_INTENT_EPSILON_PX
  );
}

export function anchorMoverShouldYieldToReader(
  currentScrollTop: number,
  previousExpectedScrollTop: number | null,
  currentExpectedScrollTop: number | null,
): boolean {
  if (previousExpectedScrollTop === null || currentExpectedScrollTop === null) {
    return false;
  }
  return (
    currentScrollTop <
    Math.min(previousExpectedScrollTop, currentExpectedScrollTop) -
      CHAT_ANCHOR_MOVER_DEPARTURE_EPSILON_PX
  );
}

/**
 * Ticket 22 (painted-chat lifecycle audit, finding 3): the anchoring-new-turn
 * drift re-assert, pulled out of the two-rAF reveal-pass effect so it can
 * also be invoked from a geometry-only trigger (row remeasure / viewport
 * resize under the SAME `messages` array - the effect only re-runs on a
 * `messages` change). Pure math only; the caller owns reading/writing
 * `scrollTop` and `expectedAnchorScrollTopRef`.
 */
export type ChatAnchorDriftRepairOutcome =
  | { readonly kind: "yielded" }
  | { readonly kind: "corrected"; readonly nextScrollTop: number }
  | { readonly kind: "settled" };

export function computeChatAnchorDriftRepair(input: {
  readonly currentScrollTop: number;
  readonly currentExpectedScrollTop: number;
  readonly previousExpectedScrollTop: number | null;
}): ChatAnchorDriftRepairOutcome {
  const {
    currentScrollTop,
    currentExpectedScrollTop,
    previousExpectedScrollTop,
  } = input;
  if (
    anchorMoverShouldYieldToReader(
      currentScrollTop,
      previousExpectedScrollTop,
      currentExpectedScrollTop,
    )
  ) {
    return { kind: "yielded" };
  }
  const anchorPositionDrift = currentExpectedScrollTop - currentScrollTop;
  if (Math.abs(anchorPositionDrift) > 1) {
    return {
      kind: "corrected",
      nextScrollTop: currentScrollTop + anchorPositionDrift,
    };
  }
  return { kind: "settled" };
}

/**
 * Imperative wrapper around `computeChatAnchorDriftRepair`: reads the live
 * scroll position + anchor metrics, applies the correction (if any), and
 * keeps `expectedAnchorScrollTopRef` in sync exactly as the reveal pass
 * always has (updated on both "corrected" and "settled", left untouched on
 * "yielded" - a departed reader's baseline must not be overwritten by the
 * drift it declined).
 */
export function applyChatAnchorDriftRepair(input: {
  readonly list: Pick<LegendListRef, "getScrollableNode" | "scrollToOffset">;
  readonly anchorTop: number;
  readonly listTopOffsetAdjustment: number;
  readonly anchorOffset: number;
  readonly expectedAnchorScrollTopRef: {
    current: number | null;
  };
}): ChatAnchorDriftRepairOutcome["kind"] {
  const {
    list,
    anchorTop,
    listTopOffsetAdjustment,
    anchorOffset,
    expectedAnchorScrollTopRef,
  } = input;
  const currentScrollTop = list.getScrollableNode().scrollTop;
  const currentExpectedScrollTop =
    anchorTop + listTopOffsetAdjustment - anchorOffset;
  const outcome = computeChatAnchorDriftRepair({
    currentScrollTop,
    currentExpectedScrollTop,
    previousExpectedScrollTop: expectedAnchorScrollTopRef.current,
  });
  if (outcome.kind === "yielded") {
    return "yielded";
  }
  expectedAnchorScrollTopRef.current = currentExpectedScrollTop;
  if (outcome.kind === "corrected") {
    void list.scrollToOffset({
      offset: outcome.nextScrollTop,
      animated: false,
    });
    return "corrected";
  }
  return "settled";
}

/**
 * Ticket 19 (adversarially-reviewed design, decision #31): the capture-
 * provenance classifier for the anchoring-scrollbar-departure gap. A native
 * OS scrollbar-thumb drag fires ONLY `scroll` events - no wheel/touchmove/
 * pointerdown - so none of the intent listeners above ever see it, and a
 * reader parked deep in history via a thumb drag leaves a settled
 * `anchoring-new-turn` session live with full generation ownership.
 * `resolveOwnedAtEndReport`'s `following-end` departure branch cannot be
 * widened to cover this: `isAtEnd=false` is anchoring's NORMAL parked state
 * (the anchor row sits near the viewport top with reserved space below), so
 * widening would self-cancel every anchoring session on its own first
 * report.
 *
 * The caller (`chat-messages.tsx`) installs ONE native CAPTURE-phase
 * `scroll` listener on the stable transcript wrapper - an ancestor of
 * LegendList's own scroll node. A capture listener on an ancestor runs
 * BEFORE any listener on the target, for every event type, regardless of
 * whether that event type bubbles (`scroll` does not bubble, but capturing
 * phase does not depend on bubbling - only on reaching the target from the
 * root). Verified against installed `@legendapp/list@3.2.0`
 * (`react.mjs:5663-5671`): the web adapter installs its own consuming
 * listener with `target.addEventListener("scroll", handleScroll, {
 * passive: true })` - directly on the scroll node, no capture flag - so an
 * ancestor capture listener always observes the raw DOM state first.
 *
 * At that moment `domScrollTop` may already reflect the move, while
 * `listStateScroll` (`list.getState().scroll`) reflects the PREVIOUS
 * position UNLESS a library-owned write already advanced it ahead of the
 * DOM event. Three writer sites matter, all verified against the installed
 * 3.2.0 source:
 *
 * | Writer | Site | Pre-writes before DOM event? |
 * | --- | --- | --- |
 * | Non-animated imperative `scrollToOffset`/`scrollToIndex` | `updateScroll` call at `react.mjs:2107`, inside the same synchronous call that later invokes `doScrollTo` at `:2110` | Yes - `state.scroll` is set before `scroller.scrollTo()` is even called |
 * | MVCP data/size/inset adjustment | `requestAdjust` at `react.mjs:1611-1629` - `state.scroll += positionDiff` at `:1622`, before the deferred `scrollAdjustHandler.requestAdjust` call (`:1626`) that eventually issues a DOM `scrollBy` | Yes |
 * | Direct DOM `scrollTop` write (native thumb, or anything else that never went through the library's own API) | none - nothing in the library ever runs | No - this is exactly the signal this classifier exists to catch |
 *
 * Governing invariant (decision #31, binding): a scroll-only reader
 * departure cancels anchoring ownership, but no browser-, library-,
 * geometry-, hydration-, or app-owned scroll may ever be classified as
 * reader intent. `chatAnchorScrollCaptureShouldCancel` is biased toward
 * CANCEL when unrecognized (review finding 4, binding): every case this
 * classifier cannot positively explain as library/app/browser-owned falls
 * through to `true`. A false cancel only costs an extra following-end/
 * free-scrolling transition; a false silence can strand a departed reader
 * under live anchor ownership, or worse let the next reveal pass snap them
 * back (design-review finding 2) - never the acceptable direction.
 *
 * These are LegendList 3.2.0 dependency contracts, not browser folklore. A
 * future `@legendapp/list` bump that reorders listener installation or stops
 * pre-writing `state.scroll` for either writer above must FAIL this
 * module's dedicated library-contract pins (`chat-messages.test.tsx`) - that
 * failure is the safety net working, not a regression to chase: on this
 * classifier's fail-safe bias, losing the pre-write proof only pushes
 * legitimate library-owned corrections into more false cancels (degrades
 * anchoring UX), it can never turn a real departure invisible again. Do not
 * "fix" a red library-contract pin by loosening the classifier itself -
 * re-audit the dependency contract instead.
 */
export interface ChatAnchorScrollCapturePhysicalSnapshot {
  readonly scrollTop: number;
  readonly maxScrollTop: number;
}

const CHAT_ANCHOR_CAPTURE_STATE_EQUALITY_EPSILON_PX = 1;
const CHAT_ANCHOR_CAPTURE_CLAMP_EPSILON_PX = 1;

export function chatScrollCaptureLibraryOwnedTop(
  domScrollTop: number,
  listStateScroll: number,
): number | null {
  return Math.abs(domScrollTop - listStateScroll) <=
    CHAT_ANCHOR_CAPTURE_STATE_EQUALITY_EPSILON_PX
    ? domScrollTop
    : null;
}

/**
 * Design-review finding 3 (PLAUSIBLE MEDIUM, decision #31 binding condition
 * b): the exact browser-clamp signature - not a guessed distance or timing
 * window. A content/reserve/viewport shrink can pull an anchored reader's
 * `scrollTop` DOWN to the new (smaller) maximum with no app scroll call at
 * all, producing the exact same DOM shape as a thumb drag landing near the
 * max. This three-part signature is the tightest predicate that separates
 * them without a grace window - a grace window would recreate the exact
 * clamp-vs-intent ambiguity this ticket exists to resolve (design's
 * "failure policy": do not add one).
 *
 * Accepted ambiguity envelope (irreducible - not a bug, do not try to widen
 * the epsilon to close it):
 *
 * | Case | Result |
 * | --- | --- |
 * | Pure content/viewport shrink clamps a fractional prior top to the new max | Silent (expected) |
 * | Real thumb movement of at most 1px from list state | Silent (blind zone) |
 * | User move + MVCP/app correction net to list state within 1px | Silent (false negative) |
 * | User thumb ends at the new max in the same delivery window as a max shrink | Indistinguishable from clamp; silent |
 * | Browser emits an intermediate event before the new max is observable | Possible false cancel |
 * | User ends merely near the max without prior-over-max evidence | Cancel (expected - not a guessed clamp) |
 */
export function chatAnchorScrollCaptureIsExactBrowserClamp(
  previous: ChatAnchorScrollCapturePhysicalSnapshot,
  current: ChatAnchorScrollCapturePhysicalSnapshot,
): boolean {
  return (
    previous.scrollTop >
      current.maxScrollTop + CHAT_ANCHOR_CAPTURE_CLAMP_EPSILON_PX &&
    current.maxScrollTop < previous.maxScrollTop &&
    Math.abs(current.scrollTop - current.maxScrollTop) <=
      CHAT_ANCHOR_CAPTURE_CLAMP_EPSILON_PX
  );
}

export interface ChatAnchorScrollCaptureInput {
  /** `mode === "anchoring-new-turn"` AND the live-follow generation still
   *  matches the current user-scroll generation - the caller's own
   *  ownership gate (same shape `resolveOwnedAtEndReport` uses). `false`
   *  means this capture is not this classifier's session to police at all
   *  (following-end, free-scrolling, or an already-departed generation). */
  readonly isAnchoringSessionOwned: boolean;
  /**
   * Ticket 18's settle lifecycle owns THIS generation's animated anchor
   * `scrollToIndex` issue/reissue window right now (armed immediately
   * before the command is issued, cleared on valid/invalid/cancel - see
   * `chat-messages.tsx`'s `positionAnchor`).
   *
   * Design-review finding 1 (CONFIRMED HIGH, binding condition a): this
   * exemption is DELIBERATELY BROADER than what ticket 18's own
   * `anchorMoverShouldYieldToReader` can actually protect - that predicate
   * only detects an UPWARD departure. A downward or intermediate thumb
   * drag arriving during this exact window is silently deferred here (not
   * classified as departure) even though ticket 18's settle loop will not
   * yield to it either - the settle loop can re-issue/snap back once this
   * window closes (review finding 2). This is an ACCEPTED, EXPLICITLY-
   * TRACKED residual, not a claimed fix: jsdom cannot express the real-time
   * race between an in-flight animated scroll and a native thumb drag, so
   * BOTH directions during active motion are live-checklist-only items,
   * never simulated as a passing jsdom pin.
   */
  readonly activeAnchorMotionOwnsGeneration: boolean;
  /** The scroll node's live `scrollTop`, read synchronously inside the
   *  capture-phase handler - i.e. AFTER the DOM already moved but BEFORE
   *  LegendList's own target listener has run. */
  readonly domScrollTop: number;
  /** `list.getState().scroll` read at the SAME synchronous moment - still
   *  describes the PREVIOUS position unless a library-owned write already
   *  advanced it ahead of the DOM event (see the module doc comment above
   *  for the three writer sites this depends on). */
  readonly listStateScroll: number;
  /** The physical snapshot captured on the PREVIOUS captured event (or
   *  `null` when no scroll has been observed yet this session - in which
   *  case the clamp predicate cannot fire, since there is nothing to
   *  compare against, and an otherwise-unexplained event still cancels). */
  readonly previousSnapshot: ChatAnchorScrollCapturePhysicalSnapshot | null;
  readonly currentMaxScrollTop: number;
}

/**
 * Top-level classifier (design's numbered steps 3-7; steps 1-2 - "read
 * fresh, refresh the snapshot regardless of outcome" - are the caller's own
 * imperative bookkeeping around this pure decision, not part of it).
 * Returns `true` only for the one case this ticket exists to catch: a
 * settled `anchoring-new-turn` session's `scrollTop` moved by a route this
 * classifier cannot explain as library-, app-, or browser-owned. See the
 * module doc comment above for the unsure-cancels fail-safe bias.
 */
export function chatAnchorScrollCaptureShouldCancel(
  input: ChatAnchorScrollCaptureInput,
): boolean {
  if (!input.isAnchoringSessionOwned) return false;
  if (input.activeAnchorMotionOwnsGeneration) return false;
  if (
    chatScrollCaptureLibraryOwnedTop(
      input.domScrollTop,
      input.listStateScroll,
    ) !== null
  ) {
    // Library/app-owned correction: non-animated imperative scrollTo*/
    // scrollToOffset and MVCP requestAdjust both advance `state.scroll`
    // before their DOM write reaches this capture listener - see the
    // module doc comment's writer table.
    return false;
  }
  if (
    input.previousSnapshot !== null &&
    chatAnchorScrollCaptureIsExactBrowserClamp(input.previousSnapshot, {
      scrollTop: input.domScrollTop,
      maxScrollTop: input.currentMaxScrollTop,
    })
  ) {
    return false;
  }
  return true;
}

export type ChatWheelVerticalDirection = "down" | "up" | "ambiguous";

export type ChatWheelFollowIntent =
  "preserve-follow" | "depart" | "approach-live-edge";

/**
 * `WheelEvent.deltaY`'s SIGN convention (positive = scrolling toward the
 * content's end) is invariant across all three `deltaMode` values (pixel/
 * line/page) - only the MAGNITUDE's unit changes with the mode. Direction
 * classification only ever looks at the sign, so it deliberately never reads
 * `deltaMode` - doing the pixel/line/page conversion would only matter for a
 * magnitude-based epsilon, which nothing here uses. A zero delta (some
 * synthetic events, or a real trackpad's very first sub-pixel sample) is
 * `"ambiguous"` - not a direction to reason about.
 */
export function chatWheelVerticalDirection(
  deltaY: number,
): ChatWheelVerticalDirection {
  if (deltaY > 0) return "down";
  if (deltaY < 0) return "up";
  return "ambiguous";
}

/**
 * Ticket 14 (direction A, root-cause: rootcause-follow-loss field bug H-B):
 * a DOWNWARD wheel arriving while the viewport is already at the actual live
 * edge (`isAtLiveEdge` - cannot advance further) must NOT cancel follow.
 * macOS trackpad momentum keeps firing `wheel` events after the viewport has
 * clamped at the bottom; a clamped wheel moves nothing, so no `scroll` event
 * ever fires to restore follow afterward, and repeated momentum ticks used to
 * cancel it over and over. An UPWARD wheel always cancels - unambiguous
 * departure intent regardless of position. A zero/ambiguous delta preserves
 * the pre-fix behavior (cancel), since there is no direction to reason about.
 *
 * The exemption is further scoped to `isFollowingEnd` (review fix, ticket
 * 14): `anchoredEndSpace` parks `anchoring-new-turn` sessions at the maximum
 * REACHABLE scroll (a reserve, not the true content end), and LegendList
 * derives `isAtEnd` purely from that reachable geometry - so an anchoring
 * session can report `isAtEnd=true` well short of the turn's real end. A
 * downward wheel arriving there is real departure intent (the reader wants
 * to see past the reserve) and must still cancel/exit anchoring, same as
 * every other non-following mode. Only `following-end` - where "at the live
 * edge" and "at the true content end" coincide - gets the exemption.
 *
 * The result is an intent transition rather than a cancellation boolean:
 * a downward gesture away from the edge arms a later strict-edge resume,
 * while upward/ambiguous input explicitly disarms it. This keeps physical
 * edge geometry from silently recreating reader intent after departure.
 *
 * `isAtLiveEdge` and `isFollowingEnd` are both expected to be FRESH reads
 * taken at the moment the wheel fires (LegendList's own small-epsilon
 * `getState().isAtEnd`, the same strict signal ticket 11 uses for "did the
 * reader reach the live edge"; `timelineScrollModeRef.current ===
 * "following-end"`) - not values captured earlier in a closure. `isAtEnd` is
 * recomputed both on scroll and on content-size changes, so a chunk
 * streaming in while the reader is already following is reflected before
 * the next wheel event can possibly fire (there is no same-tick race
 * between a content mutation and a subsequent input event). LegendList's
 * own epsilon additionally absorbs overscroll/rubber-band bounce - a
 * momentary elastic overshoot past the clamped edge still reads as "at the
 * edge", so it does not cancel either.
 */
export function resolveChatWheelFollowIntent(
  deltaY: number,
  isAtLiveEdge: boolean,
  isFollowingEnd: boolean,
): ChatWheelFollowIntent {
  const direction = chatWheelVerticalDirection(deltaY);
  if (direction !== "down") return "depart";
  if (isFollowingEnd && isAtLiveEdge) return "preserve-follow";
  return "approach-live-edge";
}

/**
 * Touch content moves opposite the finger: decreasing clientY scrolls toward
 * the transcript end, while increasing/unchanged clientY is departure or
 * ambiguous and therefore cannot authorize follow reacquisition.
 */
export function resolveChatTouchFollowIntent(
  previousClientY: number | null,
  currentClientY: number | null,
): Exclude<ChatWheelFollowIntent, "preserve-follow"> {
  if (
    previousClientY !== null &&
    currentClientY !== null &&
    currentClientY < previousClientY
  ) {
    return "approach-live-edge";
  }
  return "depart";
}

export function buildMessageIdToIndex(
  messages: ReadonlyArray<ChatMessageModel>,
): ReadonlyMap<string, number> {
  return new Map(
    messages.map((message, index) => [message.id, index] as const),
  );
}

/**
 * Ticket 10: `role: "user"` covers two visually distinct row shapes -
 * genuinely human-sent turns and A2A agent-sent rows (`agentSenderInfo !==
 * null` - decision #8's fourth anchor-triggering event). Sharing one
 * LegendList item type meant they shared one recycling pool and one running
 * measured-height average (`averageSizes[itemType]`), skewing the estimate
 * LegendList uses for not-yet-measured rows of either shape and letting a
 * container get reused across the two. Splitting keeps both honest; no other
 * code keys off this string (verified - LegendList consumes it purely
 * internally for container reuse and per-type size averaging). Lives here
 * (not `chat-timeline.tsx`) so that component file keeps exporting only
 * components (Fast Refresh).
 */
export function chatTimelineGetItemType(item: ChatMessageModel): string {
  if (item.role === "user") {
    return item.agentSenderInfo === null ? "user:human" : "user:a2a";
  }
  return item.role;
}

export interface ChatTimelineNavigationLocation {
  readonly index: number;
  readonly viewOffset: number;
  readonly animated: boolean;
}

export function chatTimelineLocationForMessage(
  messageId: string,
  messageIndexById: ReadonlyMap<string, number>,
  animated: boolean,
): ChatTimelineNavigationLocation | null {
  const index = messageIndexById.get(messageId);
  if (index === undefined) return null;
  return {
    index,
    viewOffset: CHAT_TIMELINE_NAVIGATION_VIEW_OFFSET_PX,
    animated,
  };
}

/** Ticket 10: the list-state slice `chatTimelineNavigationLandedAtLocation`
 *  needs to validate a settled navigation - same content-relative-vs-DOM-
 *  scroll shape as `ChatFreeScrollingMeasurementSource`/
 *  `ChatViewportAnchorListState` (decision #18), but the caller supplies
 *  `scroll` directly (the scroll NODE's own live `scrollTop`, not
 *  `list.getState().scroll` - that internal value can lag a completed
 *  animated scroll for exactly the reason this validation exists, see the
 *  function's own doc comment). */
export interface ChatTimelineNavigationListState {
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly scroll: number;
  readonly topOffsetAdjustment: number;
}

/**
 * Ticket 10: whether `location`'s target row is CURRENTLY sitting at its
 * intended `viewOffset` from the viewport top - the validation half of the
 * settle/re-issue pattern (root-cause: rootcause-nav-landing report). An
 * ANIMATED `scrollToIndex` targets ESTIMATED geometry; the installed
 * LegendList 3.2.0 never retargets mid-flight as real measurements replace
 * estimates during the animation, so a long jump across many unmeasured rows
 * can settle short (video evidence: click 1 landed several viewports short,
 * click 2 ~300-400px short). `false` for an unmeasured row - nothing to
 * validate against yet, so the caller should treat it as needing another
 * attempt rather than accepting blind.
 */
export function chatTimelineNavigationLandedAtLocation(
  state: ChatTimelineNavigationListState,
  location: ChatTimelineNavigationLocation,
  epsilonPx: number,
): boolean {
  const position = state.positionAtIndex(location.index);
  if (typeof position !== "number" || !Number.isFinite(position)) {
    return false;
  }
  const actualOffset = position + state.topOffsetAdjustment - state.scroll;
  return Math.abs(actualOffset - location.viewOffset) <= epsilonPx;
}

/**
 * Ticket 18 (near/far animation split, extracted per review finding - the
 * inline version left the distance branch untestable independent of the
 * jsdom-blind animated-scroll paths). Trusts an ANIMATED anchor scroll only
 * within a bounded distance of the current position - a long jump across
 * many unmeasured rows can drift its estimated pixel endpoint mid-flight
 * (root-cause: rootcause-send-undershoot report; the validated convergence
 * loop guarantees the eventual landing either way, this only bounds how far
 * a single animated hop is trusted to travel accurately). An unmeasured
 * target (`expectedTargetScrollTop === null`) is unknowable, so it is
 * treated as far - never guessed near. `anchorAnimated` is the caller's own
 * animated INTENT (`false` only for the fresh-open seed, decision #15) -
 * short-circuits to instant regardless of distance, same as before
 * extraction.
 */
export function chatTimelineAnchorShouldAnimateInitialIssue(input: {
  readonly anchorAnimated: boolean;
  readonly currentScrollTop: number;
  readonly expectedTargetScrollTop: number | null;
  readonly viewportLength: number;
  readonly maxAnimateViewports: number;
}): boolean {
  if (!input.anchorAnimated) return false;
  if (input.expectedTargetScrollTop === null) return false;
  const distance = Math.abs(
    input.currentScrollTop - input.expectedTargetScrollTop,
  );
  return distance <= input.maxAnimateViewports * input.viewportLength;
}

function isUserMessage(message: ChatMessageModel): boolean {
  return message.role === "user";
}

function isHumanUserMessage(message: ChatMessageModel): boolean {
  return message.role === "user" && message.agentSenderInfo === null;
}

/** A synthesized `role: "system"` row whose single segment is `kind`
 *  (`chat-special-segment.ts`'s shape, re-checked here rather than imported
 *  since that helper returns the segment itself, not a predicate). */
function isSingleSpecialSegmentMessage(
  message: ChatMessageModel,
  kind: "setup-card" | "forked-chat-link",
): boolean {
  return (
    message.role === "system" &&
    message.segments.length === 1 &&
    message.segments[0].kind === kind
  );
}

/**
 * Decision #27: the fresh-open (and late-history-arrival equivalent) anchor
 * predicate widens from "user rows only" to "user rows OR `forked-chat-link`
 * system markers" - a freshly opened fork lands on its own "Forked from
 * conversation" marker instead of the last COPIED user query above it.
 * Self-superseding via the callers' shared `findLast`: any user turn sent in
 * the fork is newer and wins naturally. The setup card is deliberately NOT a
 * candidate here (non-goal) - it only ever substitutes for the message it
 * belongs to, via `resolveChatAnchorTargetWithSetupCard` below.
 */
export function isChatAnchorCandidateMessage(
  message: ChatMessageModel,
): boolean {
  return (
    isUserMessage(message) ||
    isSingleSpecialSegmentMessage(message, "forked-chat-link")
  );
}

/**
 * Decision #28: a setup-card row is only a valid substitute for `targetId`
 * when it is GENUINELY its card - `anchorMessageId` (`SetupCardRow.
 * triggeringMessageId`) matches, or it's the pinned genesis card (no real
 * trigger to match - decision #28 says it substitutes unconditionally).
 * Array adjacency alone is NOT proof of ownership: a card whose triggering
 * message never became an anchor target (queued/steered/branched/deleted)
 * FLOATS by `createdAt` instead (`rendered-messages.ts`'s `floatingCards`)
 * and can land directly above a completely unrelated row by coincidence.
 */
function setupCardMatchesTarget(
  candidate: ChatMessageModel,
  targetId: string,
): boolean {
  if (candidate.role !== "system" || candidate.segments.length !== 1) {
    return false;
  }
  const segment = candidate.segments[0];
  if (segment.kind !== "setup-card") return false;
  return segment.isGenesisPin || segment.anchorMessageId === targetId;
}

/**
 * Decision #28: when the row(s) directly above `messageId` in `messages` are
 * setup-card rows GENUINELY OWNED by it (`setupCardMatchesTarget`), the
 * anchor should target the TOPMOST one instead - "anchor the top of the turn
 * group" so worktree-setup progress is visible before streaming starts.
 * Walks past more than one consecutive owned card rather than stopping at
 * the row immediately above - defensive robustness for a message anchoring
 * more than one lifecycle window, even though today's model (`setup-card-
 * rows.ts`) consolidates one send's setup into a single window/card. Covers
 * both the mid-chat weave (a card sorts immediately above the message whose
 * send created it) and the pinned genesis card (unshifted at array index 0,
 * so it always sits directly above whatever row is first). Returns
 * `messageId` unchanged when there's no owned card above it, or `messageId`
 * isn't found at all.
 */
export function resolveChatAnchorTargetWithSetupCard(
  messages: ReadonlyArray<ChatMessageModel>,
  messageId: string,
): string {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index <= 0) return messageId;
  let topIndex = index;
  while (
    topIndex > 0 &&
    setupCardMatchesTarget(messages[topIndex - 1], messageId)
  ) {
    topIndex -= 1;
  }
  return topIndex === index ? messageId : messages[topIndex].id;
}

export function selectActiveUserMessageId(
  messages: ReadonlyArray<ChatMessageModel>,
  viewportRowMessageId: string | null,
  atBottom: boolean,
): string | null {
  // The minimap rail only lists human-sent rows, so the active id must be
  // selected from the same set - agent-to-agent traffic renders as
  // `role: "user"` but never appears as a rail dot.
  const userMessages = messages.filter(isHumanUserMessage);
  if (userMessages.length === 0) return null;
  if (atBottom) return userMessages.at(-1)?.id ?? null;

  if (viewportRowMessageId === null) return userMessages.at(-1)?.id ?? null;

  const viewportRowIndex = messages.findIndex(
    (message) => message.id === viewportRowMessageId,
  );
  if (viewportRowIndex === -1) return userMessages.at(-1)?.id ?? null;

  const crossedUser = messages
    .slice(0, viewportRowIndex + 1)
    .filter(isHumanUserMessage)
    .at(-1);
  if (crossedUser !== undefined) return crossedUser.id;

  return (
    messages.slice(viewportRowIndex + 1).find(isHumanUserMessage)?.id ?? null
  );
}

/** One pixel past where a programmatic navigation parks the target row's
 *  top, so the row it scrolled to is the one reported active. */
export const VIEWPORT_ACTIVE_ANCHOR_OFFSET_PX =
  CHAT_TIMELINE_NAVIGATION_VIEW_OFFSET_PX + 1;

export interface ChatViewportAnchorListState {
  readonly scroll?: number;
  readonly positionAtIndex?: (index: number) => number | undefined;
  /**
   * LegendList top pad before row 0 (`headerSize` + `stylePaddingTop` +
   * `alignItemsAtEndPadding` - `getTopOffsetAdjustment`). `positionAtIndex`
   * is content-relative and excludes it; `scroll` includes it. Same field
   * name/contract as `ChatFreeScrollingMeasurementSource.topOffsetAdjustment`
   * (chat-scroll-anchoring.ts) - omit or `0` when unknown.
   */
  readonly topOffsetAdjustment?: number;
}

/**
 * Row index nearest the reading line, from LegendList's own measured
 * positions - NOT a DOM rect scan (jsdom reports unreliable, non-scroll-
 * relative rects for virtualized rows, and a real-browser rect scan re-reads
 * layout on every tick). `positionAtIndex` is monotonically increasing with
 * row index, so a binary search finds the last row whose top has scrolled
 * past the anchor line in O(log n).
 *
 * `positionAtIndex` is content-relative (excludes the header pad); `scroll`
 * includes it - comparing them directly is off by the header's height
 * (decision #18's `topOffsetAdjustment`, same fix as
 * `captureChatFreeScrollingOffset`). `targetY` is computed in
 * content-relative space (`scroll - topOffsetAdjustment`), matching
 * LegendList's own `computeViewability`'s `scroll = scrollState - topPad`.
 *
 * Returns `null` (not a guessed index) the moment the search encounters an
 * unmeasured row - a partial binary search result is not the true anchor,
 * and both callers already treat `null` as "no anchor this tick" gracefully.
 */
export function chatViewportAnchorRowIndex(
  state: ChatViewportAnchorListState,
  rowCount: number,
  anchorOffsetPx: number,
): number | null {
  if (rowCount <= 0 || state.positionAtIndex === undefined) return null;
  const topOffset =
    typeof state.topOffsetAdjustment === "number" &&
    Number.isFinite(state.topOffsetAdjustment)
      ? state.topOffsetAdjustment
      : 0;
  const targetY = (state.scroll ?? 0) - topOffset + anchorOffsetPx;
  let low = 0;
  let high = rowCount - 1;
  let result: number | null = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const top = state.positionAtIndex(mid);
    if (top === undefined || !Number.isFinite(top)) return null;
    if (top <= targetY) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return result ?? 0;
}

/**
 * Resolves the active (human) user message for an unpinned viewport: finds
 * the transcript row nearest the reading line from list state, then maps it
 * to the owning rail entry. `null` when the list state cannot be measured
 * (concealed surface, no rows yet).
 *
 * Sole caller is the ticket-5 free-scroll save path (`scheduleActiveViewportUpdate`
 * in chat-messages.tsx) - NOT the minimap, which derives its own active-dot
 * highlighting independently. That single-purpose scope is what makes the P4
 * fallback below safe here: an A2A-only transcript (zero human user rows)
 * has no candidate for `selectActiveUserMessageId`'s human-only gate (it
 * returns `null` in that case ONLY - any human row anywhere in `messages`
 * always resolves a candidate), which previously meant the ticket-5 anchor
 * never tracked a reading position at all for that transcript shape -
 * `viewportRowMessageId` (already resolved, any role) is the natural
 * role-agnostic fallback. `selectActiveUserMessageId` itself is untouched,
 * so the minimap rail and find-controller's own call to it stay strictly
 * human-only as before.
 */
export function viewportActiveUserMessageId(
  state: ChatViewportAnchorListState,
  messages: ReadonlyArray<ChatMessageModel>,
): string | null {
  const rowIndex = chatViewportAnchorRowIndex(
    state,
    messages.length,
    VIEWPORT_ACTIVE_ANCHOR_OFFSET_PX,
  );
  const viewportRowMessageId =
    rowIndex === null ? null : (messages[rowIndex]?.id ?? null);
  if (viewportRowMessageId === null) return null;
  return (
    selectActiveUserMessageId(messages, viewportRowMessageId, false) ??
    viewportRowMessageId
  );
}

/**
 * Resolves the actual measured transcript row at the viewport reading line.
 * Unlike `viewportActiveUserMessageId`, this deliberately does not collapse
 * an assistant/tool/A2A row back to the preceding human query. Scroll
 * restoration needs the physical row the reader was inside so its saved
 * pixel offset remains local to that row, including for very tall replies.
 */
export function viewportAnchorMessageId(
  state: ChatViewportAnchorListState,
  messages: ReadonlyArray<ChatMessageModel>,
): string | null {
  const rowIndex = chatViewportAnchorRowIndex(
    state,
    messages.length,
    VIEWPORT_ACTIVE_ANCHOR_OFFSET_PX,
  );
  return rowIndex === null ? null : (messages[rowIndex]?.id ?? null);
}

// --- Edge-mutation classification -------------------------------------------
//
// Re-expresses the previous `ScrollModifier`-style classifier (the old
// message-list helpers, deleted) as an imperative outcome the
// LegendList-backed controller can act on directly. Decision log #14: the
// underlying detection (suffix removal, branch reset, non-tail
// weave/genesis-pin/out-of-order arrival) keeps its semantics; only the
// vocabulary for expressing the outcome changes; from a `ScrollModifier`
// to a plain `scroll-to-end` / `none` / `anchor-new-turn`
// action plus an optional forced mode transition.

export type ChatEdgeMutationAction =
  | { readonly kind: "none" }
  | { readonly kind: "scroll-to-end" }
  | {
      readonly kind: "anchor-new-turn";
      readonly messageId: string;
      /** `false` only for the fresh-open re-derivation below (decision #15:
       *  "same anchor math as a send, not animated"); `true` for every real
       *  anchor-triggering event. */
      readonly animated: boolean;
    };

export interface ChatEdgeMutationOutcome {
  readonly action: ChatEdgeMutationAction;
  /** `null` means "leave the current mode alone" - either because nothing
   *  changed, or because an `"anchor-new-turn"` action owns its own mode
   *  transition (the controller's `beginAnchoringNewTurn` sets
   *  `"anchoring-new-turn"` directly; folding that into this union would
   *  force every other caller of `setTimelineMode` to handle a mode it can
   *  never actually request). Never produces `"free-scrolling"` - every case
   *  here that forces a mode picks `"following-end"`. */
  readonly nextMode: "following-end" | null;
}

const NONE_OUTCOME: ChatEdgeMutationOutcome = {
  action: { kind: "none" },
  nextMode: null,
};

interface ChatEdgeMutationInput {
  readonly previousMessages: ReadonlyArray<ChatMessageModel> | null;
  readonly nextMessages: ReadonlyArray<ChatMessageModel>;
  readonly isFollowingEnd: boolean;
  /** No saved scroll-state cache entry existed for this tile (decision #15).
   *  Re-checked on the initial render because the mount-time fresh-open seed
   *  and this classifier share ownership of that first authoritative
   *  snapshot. */
  readonly hadSavedScrollState: boolean;
  /** Host-owned run-in-progress (decision #29 / ticket 15). On the
   *  mount-time first non-empty path (`previousMessages === null` and no
   *  saved state), a streaming chat must NOT re-derive the idle fresh-open
   *  anchor - it stays following-end so the live tail remains in view. The
   *  mount-seed in `ChatMessages` already gates the same way; this field
   *  keeps the classifier's own mount branch in lockstep. */
  readonly isChatStreaming: boolean;
  /** Message ids THIS client minted and successfully dispatched
   *  (`chat-session-store.ts`) - the unconditional-anchor ground truth. */
  readonly localProvenanceMessageIds: ReadonlySet<string>;
  /**
   * Ticket 17: message id of the last (bottom-most) row actually visible in
   * the viewport, tracked continuously from LegendList's own
   * `getState().end` - BEFORE this transition (the caller reads it from a
   * ref, same "snapshot ahead of the mutation" reasoning as `isFollowingEnd`
   * above; the array shrinking during a suffix removal makes a raw index
   * meaningless post-mutation, so the id is resolved back against
   * `previousMessages` inside the suffix-removal branch below, not
   * `nextMessages`). `null` when no measurement has ever landed (nothing
   * scrolled since mount) - treated as "unknown", never as "safely above the
   * boundary": a guessed position is exactly the "unknown place" this ticket
   * exists to eliminate.
   */
  readonly lastVisibleMessageId: string | null;
}

/**
 * Classifies a `previousMessages -> nextMessages` transition into a single
 * imperative scroll outcome. `isFollowingEnd` is the mode snapshot at
 * classification time (the caller reads it from a ref, not state, since this
 * runs from a layout effect keyed on `messages` identity).
 *
 * Anchor-triggering events (decision log #8-9): explicit composer send,
 * steer / inline edit, queued-message auto-flush, and A2A agent-sent
 * user-role rows all resolve to `"anchor-new-turn"` here - the controller
 * positions the target row `anchorOffset` px from the viewport top and the
 * reply streams into the reserved space below it.
 *
 * The UNCONDITIONAL (decision #8) vs GATED-on-`isFollowingEnd` (decision #9)
 * split is decided PURELY by `localProvenanceMessageIds` membership - ground
 * truth for "this client minted this messageId and dispatched it"
 * (`chat-session-store.ts`'s `sendMessage`/`sendSeededUserMessage`/
 * `editUserMessage`, recorded at successful dispatch). It is deliberately
 * NOT inferred from row shape (a first-divergence replacement vs. a tail
 * append) or `persistentMessageId`: neither can tell a genuinely local action
 * apart from an identically-shaped row arriving from elsewhere - a queued
 * auto-flush, an A2A row, or ANOTHER window's edit reaching this one via the
 * host's snapshot broadcast on every accepted `editUserMessage`
 * (chat-session-manager.ts `afterAcceptAction`). Row-shape detection
 * (`newUserMessages`) still matters for finding WHICH row is even a
 * candidate - a same-turn steer can land as a replacement ahead of a still-
 * continuing live-assistant turn, in whatever chunked/split row projection
 * the renderer gives it (`:part:N` splitting, a steer row carrying the
 * turn's own start `createdAt` rather than "now") - but no longer decides
 * unconditional vs gated once a candidate is found; that decision is
 * registry-only.
 */
export function classifyChatEdgeMutation(
  input: ChatEdgeMutationInput,
): ChatEdgeMutationOutcome {
  const {
    nextMessages,
    previousMessages,
    isFollowingEnd,
    localProvenanceMessageIds,
    lastVisibleMessageId,
  } = input;
  if (nextMessages.length === 0) {
    return { action: { kind: "none" }, nextMode: "following-end" };
  }
  if (previousMessages === null || previousMessages.length === 0) {
    return classifyFirstNonEmptyChatEdge(input);
  }

  const removedSuffixAnchorIndex = removedMessageSuffixAnchorIndex(
    previousMessages,
    nextMessages,
  );
  if (removedSuffixAnchorIndex !== null) {
    return classifySuffixRemoval({
      previousMessages,
      isFollowingEnd,
      lastVisibleMessageId,
      firstRemovedIndex: removedSuffixAnchorIndex + 1,
    });
  }

  // Decision #14: a pure prepend (older-history hydration) keeps retained
  // rows stable regardless of role - never an anchor candidate, whatever new
  // ids it introduces.
  if (!isPrependOnlyChange(previousMessages, nextMessages)) {
    const candidates = newUserMessages(previousMessages, nextMessages);
    if (candidates.length > 0) {
      const localMatch = candidates.find((message) =>
        localProvenanceMessageIds.has(message.id),
      );
      if (localMatch !== undefined) {
        return {
          action: {
            kind: "anchor-new-turn",
            messageId: localMatch.id,
            animated: true,
          },
          nextMode: null,
        };
      }
      // Not ours - decision #9 gate. `candidates` is virtually always a
      // single row in practice; the tail-most one wins if more than one
      // landed in the same batch.
      const gatedTarget = candidates[candidates.length - 1];
      if (isFollowingEnd) {
        return {
          action: {
            kind: "anchor-new-turn",
            messageId: gatedTarget.id,
            animated: true,
          },
          nextMode: null,
        };
      }
      return NONE_OUTCOME;
    }
  }

  if (isAppendOnlyChange(previousMessages, nextMessages)) {
    // Streamed growth: the reveal-pass effect handles both the anchored-turn
    // delta scroll and the plain following-end overflow catch-up;
    // free-scrolling never moves.
    return NONE_OUTCOME;
  }

  if (isSameMessageIdSequence(previousMessages, nextMessages)) {
    // Every row kept its id and position - an in-place content mutation
    // (streamed token update, edited text, tool status) regardless of which
    // row changed or its role. No scroll transition is needed.
    return NONE_OUTCOME;
  }

  // Non-tail weave / genesis pin / out-of-order arrival: LegendList's
  // `maintainVisibleContentPosition.data` keeps retained rows visually
  // stable regardless of mode; a following reader's own catch-up already
  // comes from the reveal-pass effect + `maintainScrollAtEnd` while
  // following, so no explicit scroll-to-end is needed here either.
  return NONE_OUTCOME;
}

function findLocalProvenanceUserMessage(
  nextMessages: ReadonlyArray<ChatMessageModel>,
  localProvenanceMessageIds: ReadonlySet<string>,
): ChatMessageModel | undefined {
  return nextMessages.find(
    (message) =>
      isUserMessage(message) && localProvenanceMessageIds.has(message.id),
  );
}

function classifyFirstNonEmptyChatEdge(
  input: ChatEdgeMutationInput,
): ChatEdgeMutationOutcome {
  const {
    nextMessages,
    previousMessages,
    isFollowingEnd,
    hadSavedScrollState,
    isChatStreaming,
    localProvenanceMessageIds,
  } = input;

  if (previousMessages === null) {
    // ChatMessages has one production mount path, gated behind the
    // authoritative chat snapshot. `null` therefore means this is that
    // initial render.
    //
    // Ticket 15 review round (F9, orchestrator ruling): RESTORE-FIRST is
    // LITERAL - a saved scroll state wins over EVERYTHING at mount,
    // including a local-provenance match (e.g. a send that was in flight
    // when the tab was last closed and has since completed) - the restored
    // position is what the reader asked for by returning to this chat. Only
    // when there is genuinely nothing saved does a fresh open anchor the
    // last user row without animation (decision #15) - local provenance
    // first, then the general anchor-candidate scan. This does NOT affect
    // an actively open chat's OWN live send (the branch below, decisions
    // #8/#18) - that always anchors through the live edge-mutation path
    // unconditionally, regardless of what happened to be true at ITS mount.
    // Decision #27 widens the candidate to a `forked-chat-link` marker - a
    // fork's copied history + marker are already present in this very first
    // snapshot (a fork is always fresh-open, never a saved-state restore),
    // so this mount-time branch is precisely where a freshly opened fork
    // lands on its own marker.
    // Decision #29: a streaming fresh open stays following-end (no idle
    // anchor re-derive) - must match the mount-seed gate in ChatMessages.
    if (hadSavedScrollState || isChatStreaming) {
      return { action: { kind: "none" }, nextMode: null };
    }
    const localMessage = findLocalProvenanceUserMessage(
      nextMessages,
      localProvenanceMessageIds,
    );
    if (localMessage !== undefined) {
      return {
        action: {
          kind: "anchor-new-turn",
          messageId: localMessage.id,
          animated: true,
        },
        nextMode: null,
      };
    }
    const lastAnchorCandidate = nextMessages.findLast(
      isChatAnchorCandidateMessage,
    );
    if (lastAnchorCandidate !== undefined) {
      return {
        action: {
          kind: "anchor-new-turn",
          messageId: lastAnchorCandidate.id,
          animated: false,
        },
        nextMode: null,
      };
    }
    return { action: { kind: "none" }, nextMode: null };
  }

  // An empty array can only occur after that snapshot-gated mount: a real
  // empty chat has now received its first live turn - an actively open
  // chat's own send, which always anchors unconditionally regardless of
  // saved state (decisions #8, #18; `hadSavedScrollState` is a mount-only
  // concern, not consulted here).
  const localMessage = findLocalProvenanceUserMessage(
    nextMessages,
    localProvenanceMessageIds,
  );
  if (localMessage !== undefined) {
    return {
      action: {
        kind: "anchor-new-turn",
        messageId: localMessage.id,
        animated: true,
      },
      nextMode: null,
    };
  }

  // Treat a passive row exactly like any later queued/A2A arrival (decision
  // #9) - anchor the tail-most user only while following; a reader who
  // relinquished follow stays parked. Widened to `isChatAnchorCandidateMessage`
  // for consistency with decision #27, though a fork marker realistically
  // never reaches this branch (a fork's history is already present at
  // mount, never arriving as a live batch into a genuinely empty chat).
  const gatedTarget = nextMessages.findLast(isChatAnchorCandidateMessage);
  if (isFollowingEnd && gatedTarget !== undefined) {
    return {
      action: {
        kind: "anchor-new-turn",
        messageId: gatedTarget.id,
        animated: true,
      },
      nextMode: null,
    };
  }
  return { action: { kind: "none" }, nextMode: null };
}

function isAppendOnlyChange(
  previousMessages: ReadonlyArray<ChatMessageModel>,
  nextMessages: ReadonlyArray<ChatMessageModel>,
): boolean {
  if (nextMessages.length <= previousMessages.length) return false;
  for (let index = 0; index < previousMessages.length; index += 1) {
    if (previousMessages[index].id !== nextMessages[index]?.id) return false;
  }
  return true;
}

function isPrependOnlyChange(
  previousMessages: ReadonlyArray<ChatMessageModel>,
  nextMessages: ReadonlyArray<ChatMessageModel>,
): boolean {
  if (nextMessages.length <= previousMessages.length) return false;
  const offset = nextMessages.length - previousMessages.length;
  for (let index = 0; index < previousMessages.length; index += 1) {
    if (previousMessages[index].id !== nextMessages[index + offset]?.id) {
      return false;
    }
  }
  return true;
}

/** Every user-role message in `nextMessages` whose id did not exist in
 *  `previousMessages` at all, in array order - independent of POSITION or
 *  `createdAt`. A same-turn steer can carry the turn's own start time (not
 *  "now") and land ahead of a still-continuing, re-chunked live-assistant
 *  row rather than strictly at the tail or at a clean first-divergence
 *  point, so neither "newest `createdAt`" nor "first point of divergence"
 *  reliably finds it - "is this id simply new" does. */
function newUserMessages(
  previousMessages: ReadonlyArray<ChatMessageModel>,
  nextMessages: ReadonlyArray<ChatMessageModel>,
): ReadonlyArray<ChatMessageModel> {
  const previousIds = new Set(previousMessages.map((message) => message.id));
  return nextMessages.filter(
    (message) => isUserMessage(message) && !previousIds.has(message.id),
  );
}

function removedMessageSuffixAnchorIndex(
  previousMessages: ReadonlyArray<ChatMessageModel>,
  nextMessages: ReadonlyArray<ChatMessageModel>,
): number | null {
  if (nextMessages.length === 0) return null;
  if (nextMessages.length >= previousMessages.length) return null;
  for (let index = 0; index < nextMessages.length; index += 1) {
    if (previousMessages[index].id !== nextMessages[index]?.id) return null;
  }
  return nextMessages.length - 1;
}

/**
 * Ticket 17 (viewport-aware suffix removal, refines decision #14, root-cause:
 * rootcause-delete-landing report): a deleted user query is a suffix removal
 * whose landing depends on where the reader actually was, not just the mode
 * flag - the old unconditional `scroll-to-index`/`scroll-to-end` split
 * blindly overwrote LegendList's own MVCP preservation for a reader who never
 * even saw the deleted rows.
 *
 * - Already following-end: unchanged - force `scroll-to-end` (existing path).
 * - Free-scrolling AND the last visible row was strictly above the first
 *   removed index (`suffixRemovalViewportUntouched`): nothing in view
 *   changed - `none`, no write, no suppression; LegendList's own
 *   preservation already has it right (Scroll Engineering principle 13).
 * - Free-scrolling AND the viewport touched the removed suffix (or the
 *   reader's last-visible position is unknown): their place no longer
 *   exists - force `following-end` and land at the new true end, same as the
 *   already-following case. Unknown deliberately defaults here, never to the
 *   untouched case - a guessed "probably fine" is exactly the "unknown
 *   place" this ticket exists to eliminate.
 */
function classifySuffixRemoval(input: {
  readonly previousMessages: ReadonlyArray<ChatMessageModel>;
  readonly isFollowingEnd: boolean;
  readonly lastVisibleMessageId: string | null;
  readonly firstRemovedIndex: number;
}): ChatEdgeMutationOutcome {
  const {
    previousMessages,
    isFollowingEnd,
    lastVisibleMessageId,
    firstRemovedIndex,
  } = input;
  if (
    !isFollowingEnd &&
    suffixRemovalViewportUntouched(
      previousMessages,
      lastVisibleMessageId,
      firstRemovedIndex,
    )
  ) {
    return NONE_OUTCOME;
  }
  return { action: { kind: "scroll-to-end" }, nextMode: "following-end" };
}

function suffixRemovalViewportUntouched(
  previousMessages: ReadonlyArray<ChatMessageModel>,
  lastVisibleMessageId: string | null,
  firstRemovedIndex: number,
): boolean {
  if (lastVisibleMessageId === null) return false;
  const lastVisibleIndex = previousMessages.findIndex(
    (message) => message.id === lastVisibleMessageId,
  );
  return lastVisibleIndex !== -1 && lastVisibleIndex < firstRemovedIndex;
}

/** Every row kept the same id at the same index - a pure in-place content
 *  mutation with no change in row identity or order. */
function isSameMessageIdSequence(
  previousMessages: ReadonlyArray<ChatMessageModel>,
  nextMessages: ReadonlyArray<ChatMessageModel>,
): boolean {
  if (previousMessages.length !== nextMessages.length) return false;
  for (let index = 0; index < previousMessages.length; index += 1) {
    if (previousMessages[index].id !== nextMessages[index]?.id) return false;
  }
  return true;
}
