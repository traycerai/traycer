import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type { TranscriptListRow } from "@/stores/chats/transcript-list-rows";

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

/**
 * Row key → LIST index, over the same array the list renders. On the windowed
 * line placeholders occupy real indexes, so an index derived from `messages`
 * would address the wrong row - every scroll/navigation index in this family
 * must come from this map. A placeholder's key is its skeleton row id, so an
 * unhydrated row is a perfectly good navigation target.
 */
export function buildRowKeyToIndex(
  rows: ReadonlyArray<TranscriptListRow>,
): ReadonlyMap<string, number> {
  return new Map(rows.map((row, index) => [row.key, index] as const));
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
export function chatTimelineGetItemType(item: TranscriptListRow): string {
  // A placeholder gets its OWN item types, never a real row's. LegendList
  // recycles measured sizes per item type, so sharing a type would let a
  // placeholder's estimated height stand in for a measured one - and a
  // hydrated row would inherit the estimate it was supposed to correct.
  if (item.kind === "placeholder") {
    return `placeholder:${item.entry === null ? "unknown" : item.entry.role}`;
  }
  const model = item.model;
  if (model.role === "user") {
    return model.agentSenderInfo === null ? "user:human" : "user:a2a";
  }
  return model.role;
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
 * The hydrated message nearest the anchor row, searching at-or-before first
 * and then after. `selectActiveUserMessageId` reasons over message SEMANTICS
 * (roles, A2A senders), which a placeholder cannot answer - so when the
 * reading line sits inside unhydrated history, the nearest hydrated row is
 * the honest stand-in for "which turn is the reader inside". Transient by
 * construction: viewport-driven hydration is already fetching the rows the
 * reader is looking at.
 */
/**
 * The indexes of the hydrated rows, ascending, built once per `rows` array.
 *
 * The scan below runs on every scroll frame, and a reading line inside a large
 * unhydrated region walked the entire placeholder run - backwards to the start
 * of the chat, then forwards to its end - before answering. That is O(rowCount)
 * per frame, on a structure whose whole point is that `rowCount` may be tens of
 * thousands.
 *
 * `rows` is safe to key on and is exactly the right granularity: scrolling does
 * not rebuild it (it changes only when the window or the rendered set does), so
 * a scroll gesture pays one build and then binary-searches. A `WeakMap` because
 * the answer is only ever valid for the array it was derived from, and keying
 * on it makes staleness unrepresentable rather than something to invalidate.
 */
const hydratedIndexesByRows = new WeakMap<object, readonly number[]>();

function hydratedIndexes(
  rows: ReadonlyArray<TranscriptListRow>,
): readonly number[] {
  const cached = hydratedIndexesByRows.get(rows);
  if (cached !== undefined) return cached;
  const indexes: number[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index].kind === "hydrated") indexes.push(index);
  }
  hydratedIndexesByRows.set(rows, indexes);
  return indexes;
}

function nearestHydratedMessageId(
  rows: ReadonlyArray<TranscriptListRow>,
  anchorRowIndex: number,
): string | null {
  const indexes = hydratedIndexes(rows);
  if (indexes.length === 0) return null;
  const anchor = Math.min(anchorRowIndex, rows.length - 1);
  // The last hydrated index at or before the anchor. Same at-or-before-then-
  // after preference as the linear walk it replaces, so the row chosen is
  // unchanged - only the cost of finding it is.
  let low = 0;
  let high = indexes.length - 1;
  let atOrBefore: number | null = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const candidate = indexes[mid];
    if (candidate <= anchor) {
      atOrBefore = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  // `low` now points at the first index PAST the anchor, which is the forward
  // fallback when nothing sits at or before it.
  const chosen =
    atOrBefore ?? (low < indexes.length ? indexes[low] : indexes[0]);
  const row = rows[chosen];
  return row.kind === "hydrated" ? row.model.id : null;
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
 * the anchor row's own key (already resolved, any role, hydrated or not) is
 * the natural role-agnostic fallback. `selectActiveUserMessageId` itself is
 * untouched, so the minimap rail and find-controller's own call to it stay
 * strictly human-only as before.
 *
 * Geometry comes from `rows` (the array the list actually renders - on the
 * windowed line placeholders occupy real indexes); semantics come from
 * `messages` (hydrated bodies only). An anchor row that is a placeholder is
 * collapsed via {@link nearestHydratedMessageId} before the semantic pass.
 */
export function viewportActiveUserMessageId(
  state: ChatViewportAnchorListState,
  rows: ReadonlyArray<TranscriptListRow>,
  messages: ReadonlyArray<ChatMessageModel>,
): string | null {
  const rowIndex = chatViewportAnchorRowIndex(
    state,
    rows.length,
    VIEWPORT_ACTIVE_ANCHOR_OFFSET_PX,
  );
  if (rowIndex === null) return null;
  const anchorRow = rows[rowIndex];
  const semanticAnchorId = nearestHydratedMessageId(rows, rowIndex);
  if (semanticAnchorId === null) return anchorRow.key;
  return (
    selectActiveUserMessageId(messages, semanticAnchorId, false) ??
    anchorRow.key
  );
}

/**
 * Resolves the actual measured transcript row at the viewport reading line.
 * Unlike `viewportActiveUserMessageId`, this deliberately does not collapse
 * an assistant/tool/A2A row back to the preceding human query. Scroll
 * restoration needs the physical row the reader was inside so its saved
 * pixel offset remains local to that row, including for very tall replies.
 * A placeholder is a fine answer here: its key is the real row id, so a
 * position saved against it restores correctly once the row hydrates.
 */
export function viewportAnchorRowKey(
  state: ChatViewportAnchorListState,
  rows: ReadonlyArray<TranscriptListRow>,
): string | null {
  const rowIndex = chatViewportAnchorRowIndex(
    state,
    rows.length,
    VIEWPORT_ACTIVE_ANCHOR_OFFSET_PX,
  );
  return rowIndex === null ? null : (rows[rowIndex]?.key ?? null);
}
