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
export const CHAT_TURN_MINIMAP_MIN_ITEMS = 2;
export const CHAT_TURN_MINIMAP_MAX_HEIGHT_CSS = "calc(100vh - 18rem)";
/** Matches `chat-timeline.tsx`'s row `max-w-3xl` (48rem = 768px). */
export const CHAT_TURN_MINIMAP_CONTENT_MAX_WIDTH = 768;
export const CHAT_TURN_MINIMAP_PERSISTENT_GUTTER = 48;

export function resolveChatTurnMinimapHeightStyle(itemCount: number): string {
  const naturalHeight = Math.max(
    1,
    (itemCount - 1) * CHAT_TURN_MINIMAP_ITEM_SPACING,
  );
  return `min(${naturalHeight}px, ${CHAT_TURN_MINIMAP_MAX_HEIGHT_CSS})`;
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

  const progress = Math.max(
    0,
    Math.min(1, (input.pointerY - input.railTop) / input.railHeight),
  );
  return Math.max(
    0,
    Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))),
  );
}

export function resolveChatTurnMinimapHasPersistentGutter(
  viewportWidth: number,
): boolean {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return false;
  }

  const contentWidth = Math.min(
    viewportWidth,
    CHAT_TURN_MINIMAP_CONTENT_MAX_WIDTH,
  );
  const sideGutter = Math.max(0, (viewportWidth - contentWidth) / 2);
  return sideGutter >= CHAT_TURN_MINIMAP_PERSISTENT_GUTTER;
}

export const CHAT_TURN_MINIMAP_HIT_STRIP_LEFT = 12;
export const CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH = 40;
export const CHAT_TURN_MINIMAP_EXPANDED_HIT_STRIP_WIDTH = "22rem";

/**
 * The minimap overlays the viewport's left edge while the content column is
 * centered, so the side gutter between them shrinks under browser zoom or a
 * narrow pane. A fixed-width hover strip would then sit on top of the message
 * text and swallow its pointer events. Cap the strip's width so it never
 * extends past the gutter into the content column; 0 disables the strip.
 */
export function resolveChatTurnMinimapHitStripWidth(
  viewportWidth: number,
): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return 0;
  }

  const contentWidth = Math.min(
    viewportWidth,
    CHAT_TURN_MINIMAP_CONTENT_MAX_WIDTH,
  );
  const sideGutter = Math.max(0, (viewportWidth - contentWidth) / 2);
  return Math.max(
    0,
    Math.min(
      CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH,
      Math.floor(sideGutter) - CHAT_TURN_MINIMAP_HIT_STRIP_LEFT,
    ),
  );
}

/**
 * Once the preview is open, keep the full preview and the space leading to it
 * interactive. The collapsed strip remains gutter-capped so it cannot block
 * selecting message text.
 */
export function resolveChatTurnMinimapInteractiveWidth(
  collapsedWidth: number,
  expanded: boolean,
): number | string {
  return expanded ? CHAT_TURN_MINIMAP_EXPANDED_HIT_STRIP_WIDTH : collapsedWidth;
}

interface ChatTurnMinimapListState {
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
  const topOffset =
    typeof state.topOffsetAdjustment === "number" &&
    Number.isFinite(state.topOffsetAdjustment)
      ? state.topOffsetAdjustment
      : 0;
  const scrollTop = (state.scroll ?? 0) - topOffset;
  const scrollBottom = scrollTop + (state.scrollLength ?? 0);
  const rowTop = resolveChatTurnMinimapRowTop(state, rowIndex);
  if (rowTop === null) return false;
  const rowHeight = resolveChatTurnMinimapRowHeight(state, rowIndex);
  return (
    rowTop < scrollBottom && rowTop + Math.max(1, rowHeight ?? 1) > scrollTop
  );
}
