/**
 * Pure scroll-anchoring math for the chat timeline's three-mode policy
 * (following-end / anchoring-new-turn / free-scrolling), adapted to
 * `@legendapp/list`'s `LegendListState` shape. See decision log #11-13 for
 * the inset adaptations (pinned stack / queued surface join the base
 * offsets).
 */

export type ChatTimelineScrollMode =
  "following-end" | "anchoring-new-turn" | "free-scrolling";

/**
 * Minimum top offset for a newly anchored turn. The transcript's compact
 * fade header is 40px; wider layouts report a larger measured header and the
 * controller raises the live offset to match it. Keeping the minimum aligned
 * with the fade prevents a freshly sent query from being placed inside the
 * mask's clipped band before the first measurement arrives.
 */
export const CHAT_LIST_ANCHOR_OFFSET = 40;

/** The controller's initial ref/state seed for the three-mode policy, at
 *  mount, before any live event has run through the classifier or a real
 *  gesture. `initialAnchorMessageId` covers both a never-before-opened chat
 *  and a restored in-progress turn. Either takes precedence over
 *  `bottomFollowing`; a restored following-end tab keeps following. */
export interface ChatTimelineInitialModeSeed {
  readonly mode: ChatTimelineScrollMode;
  readonly isAtEnd: boolean;
  readonly liveFollowGeneration: number | null;
  readonly isFollowingEnd: boolean;
  readonly showScrollToBottom: boolean;
}

export function resolveChatTimelineInitialModeSeed(input: {
  readonly initialAnchorMessageId: string | null;
  readonly bottomFollowing: boolean;
}): ChatTimelineInitialModeSeed {
  if (input.initialAnchorMessageId !== null) {
    return {
      mode: "anchoring-new-turn",
      isAtEnd: true,
      liveFollowGeneration: 0,
      isFollowingEnd: false,
      showScrollToBottom: false,
    };
  }
  if (input.bottomFollowing) {
    return {
      mode: "following-end",
      isAtEnd: true,
      liveFollowGeneration: 0,
      isFollowingEnd: true,
      showScrollToBottom: false,
    };
  }
  return {
    mode: "free-scrolling",
    isAtEnd: false,
    liveFollowGeneration: null,
    isFollowingEnd: false,
    showScrollToBottom: true,
  };
}

export interface ChatTimelineListMeasurementState {
  readonly data: readonly unknown[];
  readonly scroll: number;
  readonly scrollLength: number;
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly sizeAtIndex: (index: number) => number | undefined;
}

export interface ChatAnchoredTurnMetrics {
  readonly anchorTop: number;
  readonly lastBottom: number;
  readonly turnHeight: number;
  readonly usableViewportHeight: number;
  readonly visibleUsableBottom: number;
  readonly overflowsUsableViewport: boolean;
  readonly targetScrollToRevealEnd: number;
  readonly scrollDeltaToRevealEnd: number;
}

/** The real bottom edge of a mounted row, or `null` when it isn't measured yet. */
export function getChatRowBottom(
  state: ChatTimelineListMeasurementState,
  index: number,
): number | null {
  const top = state.positionAtIndex(index);
  const height = state.sizeAtIndex(index);
  if (
    typeof top !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(top) ||
    !Number.isFinite(height)
  ) {
    return null;
  }

  return top + Math.max(1, height);
}

/**
 * Metrics for the anchored turn: how tall the anchored row + everything
 * after it is, and how far the list must scroll (from its CURRENT position)
 * to reveal the real end of that content within the usable viewport (the
 * viewport minus the bottom overlay inset and the top anchor offset).
 *
 * LegendList reports row positions in content-relative coordinates while
 * `state.scroll` includes its header/top pad. Normalize the scroll before
 * deriving every positional metric so the live-edge delta does not reach
 * zero one header-height early.
 */
export function getChatAnchoredTurnMetrics({
  state,
  anchorIndex,
  endInset,
  anchorOffset,
  topOffsetAdjustment,
}: {
  readonly state: ChatTimelineListMeasurementState;
  readonly anchorIndex: number;
  readonly endInset: number;
  readonly anchorOffset: number;
  readonly topOffsetAdjustment: number;
}): ChatAnchoredTurnMetrics | null {
  if (state.data.length === 0) {
    return null;
  }

  const boundedAnchorIndex = Math.max(
    0,
    Math.min(anchorIndex, state.data.length - 1),
  );
  const anchorTop = state.positionAtIndex(boundedAnchorIndex);
  const lastBottom = getChatRowBottom(state, state.data.length - 1);
  if (
    typeof anchorTop !== "number" ||
    !Number.isFinite(anchorTop) ||
    lastBottom === null
  ) {
    return null;
  }

  const usableViewportHeight = Math.max(
    0,
    state.scrollLength - endInset - anchorOffset,
  );
  const turnHeight = Math.max(0, lastBottom - anchorTop);
  const normalizedTopOffsetAdjustment = Number.isFinite(topOffsetAdjustment)
    ? topOffsetAdjustment
    : 0;
  const contentRelativeScroll = state.scroll - normalizedTopOffsetAdjustment;
  const visibleUsableBottom = contentRelativeScroll + usableViewportHeight;
  const targetScrollToRevealEnd = Math.max(
    0,
    lastBottom - usableViewportHeight,
  );
  const scrollDeltaToRevealEnd = Math.max(
    0,
    targetScrollToRevealEnd - contentRelativeScroll,
  );

  return {
    anchorTop,
    lastBottom,
    turnHeight,
    usableViewportHeight,
    visibleUsableBottom,
    overflowsUsableViewport: turnHeight > usableViewportHeight,
    targetScrollToRevealEnd,
    scrollDeltaToRevealEnd,
  };
}

/** Whether the real (measured) content bottom extends past the usable viewport. */
export function chatTimelineRealContentOverflowsViewport(
  state: ChatTimelineListMeasurementState,
  endInset: number,
  anchorOffset: number,
): boolean {
  if (state.data.length === 0) {
    return false;
  }

  const lastRowIndex = state.data.length - 1;
  const lastRowBottom = getChatRowBottom(state, lastRowIndex);
  if (lastRowBottom === null) {
    return false;
  }

  const visibleScrollLength = Math.max(
    0,
    state.scrollLength - endInset - anchorOffset,
  );
  return lastRowBottom > visibleScrollLength;
}

export interface ChatListAnchoredEndSpace {
  readonly anchorIndex: number;
  readonly anchorOffset: number;
}

/**
 * Resolves the row index a pending anchor id currently occupies (searching
 * from the tail, since an anchored turn is always near the end of the
 * rendered history). `undefined` when there is no active anchor or the
 * anchored row hasn't arrived in `items` yet.
 */
export function resolveChatListAnchoredEndSpace<Item, AnchorId>(
  items: ReadonlyArray<Item>,
  anchorId: AnchorId | null,
  getAnchorId: (item: Item) => AnchorId | null,
  anchorOffset: number,
): ChatListAnchoredEndSpace | undefined {
  if (anchorId === null) {
    return undefined;
  }

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && getAnchorId(item) === anchorId) {
      return { anchorIndex: index, anchorOffset };
    }
  }

  return undefined;
}

/**
 * Whether an `anchoredEndSpace.onReady`/`onSizeChanged` notification for
 * `messageId` should still be acted on, or ignored as stale/abandoned. A
 * cancel (`cancelTimelineLiveFollowForUserNavigation`) clears both the
 * pending and positioned anchor refs to `null`; a late notification whose
 * `messageId` matches NEITHER is for an anchor request nothing currently
 * expects (superseded by a cancel, or by a newer anchor request) and must
 * not resurrect anchor tracking for it.
 */
export function shouldAcceptChatAnchorReadyEvent(input: {
  readonly messageId: string;
  readonly pendingAnchorMessageId: string | null;
  readonly positionedAnchorMessageId: string | null;
}): boolean {
  return (
    input.messageId === input.pendingAnchorMessageId ||
    input.messageId === input.positionedAnchorMessageId
  );
}

export interface ChatTimelineEndState {
  readonly isAtEnd?: boolean;
  readonly isNearEnd?: boolean;
}

/**
 * Only the strict live edge grants follow ownership. `isNearEnd` remains
 * available to callers as presentation/proximity data, but it must never
 * re-attach a reader who deliberately stopped short of the tail.
 */
export function resolveChatTimelineIsAtEnd(
  state: ChatTimelineEndState | undefined,
): boolean | undefined {
  return state?.isAtEnd;
}

/**
 * Ticket 5: how many px below (or, negative, above) the viewport top
 * `index`'s row currently sits - the exact `viewOffset` that would restore
 * this same pixel position via LegendList's `initialScrollIndex` /
 * `scrollToIndex` with `viewPosition: 0`. `undefined`/`null` (no list, no
 * resolvable index, or an unmeasured row) falls back to `0` (the row's own
 * top), matching `restoreChatTabState`'s stale-anchor fallback.
 *
 * LegendList's restore math is `scroll = positionAtIndex - viewOffset +
 * topOffsetAdjustment` (`getTopOffsetAdjustment`: header + style padding +
 * align-at-end pad). `positionAtIndex` is content-relative (excludes that
 * top pad), while DOM `scroll` includes it - so the viewOffset that
 * round-trips exact pixels is `(position + topOffsetAdjustment) - scroll`,
 * not bare `position - scroll` (decision #18).
 *
 * Reply-reserve geometry is persisted independently and recreated before
 * restore convergence, so this captures the real visible DOM coordinate
 * without clamping it into a different geometry. Save → restore → save is
 * therefore idempotent even while a detached turn keeps streaming.
 */
export interface ChatFreeScrollingMeasurementSource {
  readonly getState: () => {
    readonly positionAtIndex: (index: number) => number | undefined;
    readonly scroll: number;
    /**
     * LegendList top pad before row 0 (`headerSize` + `stylePaddingTop` +
     * `alignItemsAtEndPadding`). Same value restore adds via
     * `getTopOffsetAdjustment`. Omit or `0` when unknown; production save
     * passes the live measured value.
     */
    readonly topOffsetAdjustment?: number;
  };
}

export function captureChatFreeScrollingOffset(
  list: ChatFreeScrollingMeasurementSource | null,
  index: number | undefined,
): number {
  if (list === null || index === undefined) return 0;
  const state = list.getState();
  const position = state.positionAtIndex(index);
  if (typeof position !== "number" || !Number.isFinite(position)) return 0;
  const topOffset =
    typeof state.topOffsetAdjustment === "number" &&
    Number.isFinite(state.topOffsetAdjustment)
      ? state.topOffsetAdjustment
      : 0;
  return position + topOffset - state.scroll;
}
