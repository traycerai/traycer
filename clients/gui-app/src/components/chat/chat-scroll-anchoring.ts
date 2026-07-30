/**
 * Pure scroll-anchoring math for the chat timeline's three-mode policy
 * (following-end / anchoring-new-turn / free-scrolling). Near-verbatim port
 * of T3's `timelineScrollAnchoring.ts` + the anchor-lookup helper from
 * `packages/shared/chatList.ts`, adapted to `@legendapp/list`'s
 * `LegendListState` shape. See decision log #11-13 for the Traycer-specific
 * inset adaptations (pinned stack / queued surface join the base offsets).
 */

export type ChatTimelineScrollMode =
  "following-end" | "anchoring-new-turn" | "free-scrolling";

export const CHAT_LIST_ANCHOR_OFFSET = 16;

/** The controller's initial ref/state seed for the three-mode policy, at
 *  mount, before any live event has run through the classifier or a real
 *  gesture. `freshOpenAnchorMessageId` (decision #15) takes precedence over
 *  `bottomFollowing` (the restored scroll-state cache) - a never-before-
 *  opened chat anchors the last user message instead of parking at the
 *  tail; a restored following-end tab keeps following. */
export interface ChatTimelineInitialModeSeed {
  readonly mode: ChatTimelineScrollMode;
  readonly isAtEnd: boolean;
  readonly liveFollowGeneration: number | null;
  readonly isFollowingEnd: boolean;
  readonly showScrollToBottom: boolean;
}

export function resolveChatTimelineInitialModeSeed(input: {
  readonly freshOpenAnchorMessageId: string | null;
  readonly bottomFollowing: boolean;
}): ChatTimelineInitialModeSeed {
  if (input.freshOpenAnchorMessageId !== null) {
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
 */
export function getChatAnchoredTurnMetrics({
  state,
  anchorIndex,
  endInset,
  anchorOffset,
}: {
  readonly state: ChatTimelineListMeasurementState;
  readonly anchorIndex: number;
  readonly endInset: number;
  readonly anchorOffset: number;
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
  const visibleUsableBottom = state.scroll + usableViewportHeight;
  const targetScrollToRevealEnd = Math.max(
    0,
    lastBottom - usableViewportHeight,
  );
  const scrollDeltaToRevealEnd = Math.max(
    0,
    targetScrollToRevealEnd - state.scroll,
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

/**
 * Ticket 5 / F3: the maximum DOM `scrollTop` reachable once
 * `anchoredEndSpace` is gone (plain free-scrolling restore).
 *
 * LegendList's content length (installed 3.2.0) is
 * `headerSize + footerSize + totalSize + contentInsetBottom` (plus unused
 * style/align pads our chat timeline never sets). With content-relative
 * positions, `lastBottom` is the bottom of the last real row (= totalSize
 * when fully measured). Max scroll is content length minus the viewport:
 *
 *   max(0, header + footer + lastBottom + endInset - viewportLength)
 *
 * This is NOT `targetScrollToRevealEnd` from `getChatAnchoredTurnMetrics` -
 * that is the anchor engine's reveal target
 * (`lastBottom - (viewport - endInset - anchorOffset)`), which under-clamps
 * the no-reserve max by `header + footer - anchorOffset` and would leave a
 * mid-anchor remount 88/104px short of the true natural end on the fade
 * header. Keep the reveal metric for the reveal pass; use this only for the
 * save-time F3 clamp.
 */
export function getChatNaturalMaxScrollWithoutAnchorReserve(input: {
  readonly headerSize: number;
  readonly footerSize: number;
  readonly lastBottom: number;
  readonly endInset: number;
  readonly viewportLength: number;
}): number {
  return Math.max(
    0,
    input.headerSize +
      input.footerSize +
      input.lastBottom +
      input.endInset -
      input.viewportLength,
  );
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

/** `isNearEnd` (library default 10% threshold) restores follow before the strict `isAtEnd`. */
export function resolveChatTimelineIsAtEnd(
  state: ChatTimelineEndState | undefined,
): boolean | undefined {
  return state?.isNearEnd ?? state?.isAtEnd;
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
 * `naturalMaxScroll` (F3 fix): the current live `scroll` may exceed the
 * content's natural (no-`anchoredEndSpace`-reserve) scrollable range while
 * `anchoring-new-turn` is reserving trailing blank space below the anchor for
 * a still-streaming reply - a scroll position only reachable BECAUSE of that
 * reserve. Restoring later as plain `free-scrolling` has no reserve, so
 * capturing the raw `scroll` would produce an offset the browser clamps on
 * restore, dropping the row from where it should land. Pass
 * `getChatNaturalMaxScrollWithoutAnchorReserve` (NOT
 * `targetScrollToRevealEnd` - that is the reveal-pass target and under-clamps
 * the true no-reserve max). Clamp is applied to `scroll` before subtracting;
 * top-offset is independent of the reserve and is still added. `null` for the
 * ordinary (never-anchoring) free-scrolling case, where no such reserve
 * exists and the raw `scroll` is already valid.
 */
export interface ChatFreeScrollingMeasurementSource {
  readonly getState: () => {
    readonly positionAtIndex: (index: number) => number;
    readonly scroll: number;
    /**
     * LegendList top pad before row 0 (`headerSize` + `stylePaddingTop` +
     * `alignItemsAtEndPadding`). Same value restore adds via
     * `getTopOffsetAdjustment`. Omit or `0` when unknown (unit tests of pure
     * clamp arithmetic); production save path passes the live measured value.
     */
    readonly topOffsetAdjustment?: number;
  };
}

export function captureChatFreeScrollingOffset(
  list: ChatFreeScrollingMeasurementSource | null,
  index: number | undefined,
  naturalMaxScroll: number | null,
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
  const scroll =
    naturalMaxScroll === null
      ? state.scroll
      : Math.min(state.scroll, naturalMaxScroll);
  return position + topOffset - scroll;
}
