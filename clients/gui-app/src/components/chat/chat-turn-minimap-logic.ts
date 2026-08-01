/**
 * Pure geometry helpers for `chat-turn-minimap.tsx` (decision log #20). Kept
 * dependency-free (no DOM reads) so they stay unit-testable without a
 * LegendList/jsdom harness.
 */

/**
 * Marks the rail's single keyboard hit-target so the transcript's window-
 * level Home/End/Arrow claiming (`chat-messages.tsx`'s `chatKeyboardScrollAction`)
 * yields to the rail's own in-widget keyboard navigation while it holds
 * focus - otherwise the transcript's capture-phase listener intercepts those
 * keys before the rail's own `onKeyDown` ever sees them.
 */
export const CHAT_TURN_MINIMAP_KEYBOARD_OWNER_ATTRIBUTE =
  "data-chat-turn-minimap-keyboard-owner";
export const CHAT_TURN_MINIMAP_KEYBOARD_OWNER_SELECTOR = `[${CHAT_TURN_MINIMAP_KEYBOARD_OWNER_ATTRIBUTE}]`;

export const CHAT_TURN_MINIMAP_ITEM_SPACING = 8;
/** Extra invisible pointer room above the first strip and below the last. */
export const CHAT_TURN_MINIMAP_END_HIT_PADDING = 12;
export const CHAT_TURN_MINIMAP_MIN_ITEMS = 1;
export const CHAT_TURN_MINIMAP_MAX_HEIGHT_CSS = "calc(100vh - 18rem)";
export const CHAT_TURN_MINIMAP_PANE_MAX_HEIGHT_CSS =
  "max(1px, calc(100% - 1rem))";

export function resolveChatTurnMinimapHeightStyle(itemCount: number): string {
  const naturalTrackHeight = Math.max(
    1,
    (itemCount - 1) * CHAT_TURN_MINIMAP_ITEM_SPACING,
  );
  const naturalHeight =
    naturalTrackHeight + CHAT_TURN_MINIMAP_END_HIT_PADDING * 2;
  return `min(${naturalHeight}px, ${CHAT_TURN_MINIMAP_MAX_HEIGHT_CSS}, ${CHAT_TURN_MINIMAP_PANE_MAX_HEIGHT_CSS})`;
}

export function resolveChatTurnMinimapTopPercent(
  index: number,
  itemCount: number,
): number {
  if (itemCount <= 1) {
    return 0;
  }
  return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100;
}

/**
 * Keeps the visible strips on their original evenly spaced track while the
 * button extends beyond both ends to make the endpoint targets easier to hit.
 */
export function resolveChatTurnMinimapTopStyle(
  index: number,
  itemCount: number,
): string {
  const percent = resolveChatTurnMinimapTopPercent(index, itemCount);
  const pixelOffset =
    CHAT_TURN_MINIMAP_END_HIT_PADDING * (1 - (percent * 2) / 100);
  if (pixelOffset === 0) return `${percent}%`;
  const operator = pixelOffset > 0 ? "+" : "-";
  return `calc(${percent}% ${operator} ${Math.abs(pixelOffset)}px)`;
}

export function resolveChatTurnMinimapIndexFromPointer(input: {
  readonly itemCount: number;
  readonly railTop: number;
  readonly railHeight: number;
  readonly pointerY: number;
}): number | null {
  if (input.itemCount <= 0 || input.railHeight <= 0) {
    return null;
  }
  if (input.itemCount === 1) {
    return 0;
  }

  const endPadding = Math.min(
    CHAT_TURN_MINIMAP_END_HIT_PADDING,
    Math.max(0, (input.railHeight - 1) / 2),
  );
  const trackTop = input.railTop + endPadding;
  const trackHeight = input.railHeight - endPadding * 2;
  const progress = Math.max(
    0,
    Math.min(1, (input.pointerY - trackTop) / trackHeight),
  );
  return Math.max(
    0,
    Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))),
  );
}

/** Always-on edge hit target, including narrow and tiled transcript panes. */
export const CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH = 40;
export const CHAT_TURN_MINIMAP_EXPANDED_HIT_STRIP_WIDTH =
  "min(22rem, calc(100vw - 1rem))";

/**
 * Once the preview is open, keep the full preview and the space leading to it
 * interactive. The collapsed rail keeps a compact fixed edge target so it
 * remains usable in narrow and tiled panes.
 */
export function resolveChatTurnMinimapInteractiveWidth(
  collapsedWidth: number,
  expanded: boolean,
): number | string {
  return expanded ? CHAT_TURN_MINIMAP_EXPANDED_HIT_STRIP_WIDTH : collapsedWidth;
}

export interface ChatTurnMinimapListState {
  readonly scroll?: number;
  readonly scrollLength?: number;
  readonly positionAtIndex?: (index: number) => number | undefined;
  readonly sizeAtIndex?: (index: number) => number | undefined;
  /**
   * LegendList top pad before row 0 (`headerSize` + `stylePaddingTop` +
   * `alignItemsAtEndPadding` - `getTopOffsetAdjustment`). `positionAtIndex`
   * is content-relative and excludes it; `scroll` includes it - same field
   * name/contract as `ChatViewportAnchorListState.topOffsetAdjustment`
   * (chat-messages-scroll-helpers.ts). Omit or `0` when unknown.
   */
  readonly topOffsetAdjustment?: number;
}

export function resolveChatTurnMinimapRowTop(
  state: ChatTurnMinimapListState,
  rowIndex: number,
): number | null {
  const top = state.positionAtIndex?.(rowIndex);
  return typeof top === "number" && Number.isFinite(top) ? top : null;
}

export function resolveChatTurnMinimapRowHeight(
  state: ChatTurnMinimapListState,
  rowIndex: number,
): number | null {
  const height = state.sizeAtIndex?.(rowIndex);
  return typeof height === "number" && Number.isFinite(height) ? height : null;
}

/**
 * Whether the row at `rowIndex` intersects the currently scrolled viewport
 * band. `positionAtIndex`/`sizeAtIndex` are content-relative (exclude the
 * header pad); `scroll` includes it - the band is computed in content-
 * relative space (`scroll - topOffsetAdjustment`), matching LegendList's own
 * `computeViewability`'s `scroll = scrollState - topPad` (same fix as
 * `chatViewportAnchorRowIndex`, decision #18's `topOffsetAdjustment`).
 */
export function resolveChatTurnMinimapRowInView(
  state: ChatTurnMinimapListState,
  rowIndex: number,
): boolean {
  const distance = resolveChatTurnMinimapRowViewportDistance(state, rowIndex);
  return distance !== null && distance < 0;
}

/**
 * Distance between a measured row and the usable viewport band. A negative
 * value marks an intersection, zero marks a touching edge, and a positive
 * value is the pixel gap. `null` means the row has no usable position.
 *
 * Encoding both visibility and proximity in one number lets the scroll path
 * resolve every marker with one geometry pass and no per-row object churn.
 */
export function resolveChatTurnMinimapRowViewportDistance(
  state: ChatTurnMinimapListState,
  rowIndex: number,
): number | null {
  const topOffset =
    typeof state.topOffsetAdjustment === "number" &&
    Number.isFinite(state.topOffsetAdjustment)
      ? state.topOffsetAdjustment
      : 0;
  const scrollTop = (state.scroll ?? 0) - topOffset;
  const scrollBottom = scrollTop + Math.max(0, state.scrollLength ?? 0);
  const rowTop = resolveChatTurnMinimapRowTop(state, rowIndex);
  if (rowTop === null) return null;
  const rowHeight = resolveChatTurnMinimapRowHeight(state, rowIndex);
  const rowBottom = rowTop + Math.max(1, rowHeight ?? 1);
  if (rowTop < scrollBottom && rowBottom > scrollTop) return -1;
  if (rowBottom <= scrollTop) return scrollTop - rowBottom;
  return Math.max(0, rowTop - scrollBottom);
}
