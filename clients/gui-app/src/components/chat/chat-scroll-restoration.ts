/**
 * Restoration-only scroll math for the chat timeline. Bottom-follow itself is
 * owned entirely by `@legendapp/list`'s strict `isAtEnd` (1px library
 * epsilon); the app has no scroll-mode machinery of its own. This module
 * covers only what restoring an exact saved reading position still needs:
 * reading the library's strict edge signal, and capturing the exact
 * row-plus-pixel-offset coordinate to persist.
 */

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
 * How many px below (or, negative, above) the viewport top `index`'s row
 * currently sits - the exact `viewOffset` that would restore this same pixel
 * position via LegendList's `initialScrollIndex` / `scrollToIndex` with
 * `viewPosition: 0`. `undefined`/`null` (no list, no resolvable index, or an
 * unmeasured row) falls back to `0` (the row's own top), matching
 * `restoreChatTabState`'s stale-anchor fallback.
 *
 * LegendList's restore math is `scroll = positionAtIndex - viewOffset +
 * topOffsetAdjustment` (`getTopOffsetAdjustment`: header + style padding +
 * align-at-end pad). `positionAtIndex` is content-relative (excludes that
 * top pad), while DOM `scroll` includes it - so the viewOffset that
 * round-trips exact pixels is `(position + topOffsetAdjustment) - scroll`,
 * not bare `position - scroll` (decision #18).
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
