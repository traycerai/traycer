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

export function acceptExhaustedPersistedRestoreFallback<T>(
  restorePersistencePendingRef: { current: boolean },
  pendingMeasuredRestoreRef: { current: T | null },
): void {
  restorePersistencePendingRef.current = false;
  pendingMeasuredRestoreRef.current = null;
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

function isHumanUserMessage(message: ChatMessageModel): boolean {
  return message.role === "user" && message.agentSenderInfo === null;
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
   * (chat-scroll-restoration.ts) - omit or `0` when unknown.
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
