/** Restoration-only scroll math for the chat timeline. Bottom-follow itself is owned entirely by `@legendapp/list`'s strict `isAtEnd` (1px library epsilon); the app has no scroll-mode machinery of its own. */

export interface ChatTimelineEndState {
  readonly isAtEnd?: boolean;
  readonly isNearEnd?: boolean;
}

/** Only the strict live edge grants follow ownership. `isNearEnd` remains available to callers as presentation/proximity data, but it must never re-attach a reader who deliberately stopped short of the tail. */
export function resolveChatTimelineIsAtEnd(
  state: ChatTimelineEndState | undefined,
): boolean | undefined {
  return state?.isAtEnd;
}

/** How many px below (or, negative, above) the viewport top `index`'s row currently sits - the exact `viewOffset` that would restore this same pixel position via LegendList's `initialScrollIndex` / `scrollToIndex` with `viewPosition: 0`. */
export interface ChatFreeScrollingMeasurementSource {
  readonly getState: () => {
    readonly positionAtIndex: (index: number) => number | undefined;
    readonly scroll: number;
    /** LegendList top pad before row 0 (`headerSize` + `stylePaddingTop` + `alignItemsAtEndPadding`). Same value restore adds via `getTopOffsetAdjustment`. */
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
