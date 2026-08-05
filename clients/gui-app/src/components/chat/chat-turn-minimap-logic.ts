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
/** Matches `chat-timeline.tsx`'s rem-based `max-w-3xl`. */
export const CHAT_TURN_MINIMAP_CONTENT_MAX_WIDTH_REM = 48;

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

/** Matches the rem-based `left-3` / `right-3` interaction-region inset. */
export const CHAT_TURN_MINIMAP_EDGE_INSET_REM = 0.75;
export const CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH = 40;
/** Matches the widest painted marker (`w-6`) in `chat-turn-minimap.tsx`. */
export const CHAT_TURN_MINIMAP_MAX_MARKER_WIDTH_REM = 1.5;

/**
 * The minimap overlays a viewport edge while the transcript column is
 * centered. Cap the transparent hit target to the side gutter so it cannot
 * cover message text; a zero-width result makes the control inert in narrow
 * and tiled panes where the content column consumes the full viewport.
 */
export function resolveChatTurnMinimapHitStripWidth(input: {
  readonly rootFontSize: number;
  readonly viewportWidth: number;
}): number {
  if (
    !Number.isFinite(input.viewportWidth) ||
    input.viewportWidth <= 0 ||
    !Number.isFinite(input.rootFontSize) ||
    input.rootFontSize <= 0
  ) {
    return 0;
  }

  const contentMaxWidth =
    CHAT_TURN_MINIMAP_CONTENT_MAX_WIDTH_REM * input.rootFontSize;
  const contentWidth = Math.min(input.viewportWidth, contentMaxWidth);
  const sideGutter = Math.max(0, (input.viewportWidth - contentWidth) / 2);
  const edgeInset = CHAT_TURN_MINIMAP_EDGE_INSET_REM * input.rootFontSize;
  return Math.max(
    0,
    Math.min(
      CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH,
      Math.floor(sideGutter - edgeInset),
    ),
  );
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

/** Every preview is clamped to three lines on screen (and one is also reused
 * as a jump target's accessible name), so nothing past this is perceivable. */
export const CHAT_TURN_MINIMAP_PREVIEW_MAX_CHARS = 200;

/**
 * Builds the rail's preview text for one message.
 *
 * The slice comes BEFORE the whitespace collapse on purpose. Normalizing
 * first allocates a string as long as the whole turn, so the rail retained a
 * second full-length copy of every user message and every final assistant
 * message in the transcript - a heap snapshot of a long session found exactly
 * that duplication. Reading a bounded head keeps the retained preview
 * proportional to what can actually be shown.
 */
/**
 * `String.prototype.slice` cuts on UTF-16 code units, so a cut landing
 * between the halves of a surrogate pair leaves a lone surrogate that
 * renders as a replacement glyph. This preview doubles as the jump
 * target's accessible name, so a screen reader would announce the
 * malformed character too - drop a trailing high surrogate instead.
 */
function sliceWholeCodePoints(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  const cut = text.slice(0, maxUnits);
  const last = cut.charCodeAt(cut.length - 1);
  const endsOnLeadingSurrogate = last >= 0xd800 && last <= 0xdbff;
  return endsOnLeadingSurrogate ? cut.slice(0, -1) : cut;
}

/**
 * Collapse whitespace while walking the source, stopping as soon as enough
 * VISIBLE characters have been collected.
 *
 * A fixed-length prefix would be wrong twice over: scanning the whole string
 * allocates a second full copy of every turn (the cost this preview exists to
 * avoid), but slicing a fixed prefix first means a turn whose opening is
 * mostly whitespace - pasted content after a long run of blank lines -
 * normalizes to nothing and loses its preview and its accessible name
 * entirely. Walking with an output budget bounds the work by what is shown
 * rather than by the turn's length, and never runs out of input early.
 */
const WHITESPACE_RE = /\s/;

/**
 * Hard ceiling on how much source the preview scan will read.
 *
 * The output budget alone does not bound the loop: a whitespace-only turn, or
 * one with a very long whitespace prefix, emits nothing and would walk the
 * entire message. This runs for every user and assistant preview, so a single
 * large message would cost renderer work proportional to its whole length.
 *
 * Generous enough that no realistic leading-whitespace run reaches it - which
 * is the case the scan was widened for in the first place - while keeping the
 * worst case constant.
 */
const PREVIEW_SOURCE_SCAN_LIMIT = 16_384;

function collapseWhitespaceUpTo(text: string, maxOut: number): string {
  let out = "";
  let pendingSpace = false;
  const scanLimit = Math.min(text.length, PREVIEW_SOURCE_SCAN_LIMIT);
  for (let index = 0; index < scanLimit; index += 1) {
    const ch = text[index];
    if (WHITESPACE_RE.test(ch)) {
      if (out.length > 0) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      out += " ";
      pendingSpace = false;
    }
    out += ch;
    // One past the budget is enough to know truncation is needed, and keeps a
    // trailing surrogate pair intact for the caller to trim whole.
    if (out.length > maxOut + 1) break;
  }
  return out;
}

export function compactChatTurnMinimapPreview(
  text: string | null | undefined,
): string | null {
  if (text === null || text === undefined) return null;
  const compact = collapseWhitespaceUpTo(
    text,
    CHAT_TURN_MINIMAP_PREVIEW_MAX_CHARS,
  );
  if (compact.length === 0) return null;
  if (compact.length <= CHAT_TURN_MINIMAP_PREVIEW_MAX_CHARS) return compact;
  return `${sliceWholeCodePoints(
    compact,
    CHAT_TURN_MINIMAP_PREVIEW_MAX_CHARS,
  ).trimEnd()}…`;
}
