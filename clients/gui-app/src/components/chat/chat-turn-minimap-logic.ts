import {
  MINIMAP_TRACK_END_HIT_PADDING,
  MINIMAP_TRACK_ITEM_SPACING,
  resolveMinimapTrackHeightStyle,
  resolveMinimapTrackTopStyle,
} from "@/components/minimap/minimap-track-geometry";
import type { MinimapPlacement } from "@/stores/settings/settings-store";

/**
 * Whether the turn minimap mounts at all.
 *
 * `hide` unmounts it on a desktop viewport, exactly as before the phone tile
 * bar existed - the rail is the only consumer there, so nothing is left to
 * publish an outline for. On a phone viewport it stays mounted and suppresses
 * only its own rail, because the tile bar's button reads the outline it
 * registers and that button deliberately does not obey `hide`.
 */
export function shouldMountChatTurnMinimap(input: {
  readonly hasContent: boolean;
  readonly side: MinimapPlacement;
  readonly mobileViewport: boolean;
}): boolean {
  if (!input.hasContent) return false;
  return input.side !== "hide" || input.mobileViewport;
}

/**
 * Whether the hover rail can paint, and so whether its measure loop is worth
 * running.
 *
 * The rail is chrome for a pointer that can hover: the tile hides it below the
 * `md` breakpoint and its own markup is behind `@media(pointer:fine)`, so on a
 * phone it never draws a pixel. Its geometry effect (`ResizeObserver` +
 * `getBoundingClientRect` on the transcript container) is measured for that
 * rail alone, and a forced layout of the transcript while the virtualized list
 * is measuring its own rows makes the list commit sizes taken mid-reflow.
 * Rendering `null` further down is too late - the effect is above it.
 *
 * A pointer resolves to exactly one of `none`, `coarse` and `fine`, and the
 * question here is only whether a touch device is driving, so this asks the
 * negative: everything that is not coarse either paints the rail or has no
 * pointer at all.
 *
 * Registration of the turn outline is deliberately NOT gated on this - that is
 * the phone tile bar's data, and the whole point of publishing it.
 */
export function shouldRunChatTurnMinimapRail(input: {
  readonly side: MinimapPlacement;
  readonly coarsePointer: boolean;
  readonly mobileViewport: boolean;
}): boolean {
  return input.side !== "hide" && !input.coarsePointer && !input.mobileViewport;
}

export const CHAT_TURN_MINIMAP_KEYBOARD_OWNER_ATTRIBUTE =
  "data-chat-turn-minimap-keyboard-owner";
export const CHAT_TURN_MINIMAP_KEYBOARD_OWNER_SELECTOR = `[${CHAT_TURN_MINIMAP_KEYBOARD_OWNER_ATTRIBUTE}]`;

export const CHAT_TURN_MINIMAP_PANE_MAX_HEIGHT_CSS =
  "max(1px, calc(100% - 1rem))";
export const CHAT_TURN_MINIMAP_CONTENT_MAX_WIDTH_REM = 48;
const CHAT_TURN_MINIMAP_CONTENT_INLINE_PADDING_REM = 1.5;
export const CHAT_TURN_MINIMAP_EDGE_INSET_REM = 0.75;
export const CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH = 40;

export function resolveChatTurnMinimapHeightStyle(itemCount: number): string {
  return resolveMinimapTrackHeightStyle(
    {
      itemCount,
      itemSpacing: MINIMAP_TRACK_ITEM_SPACING,
      endHitPadding: MINIMAP_TRACK_END_HIT_PADDING,
    },
    [CHAT_TURN_MINIMAP_PANE_MAX_HEIGHT_CSS],
  );
}

export function resolveChatTurnMinimapTopStyle(
  index: number,
  itemCount: number,
): string {
  return resolveMinimapTrackTopStyle(
    index,
    itemCount,
    MINIMAP_TRACK_END_HIT_PADDING,
  );
}

/** Use the transcript's existing inline padding when a tile has no outer gutter. */
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

  const contentWidth = Math.min(
    input.viewportWidth,
    CHAT_TURN_MINIMAP_CONTENT_MAX_WIDTH_REM * input.rootFontSize,
  );
  const sideGutter =
    Math.max(0, (input.viewportWidth - contentWidth) / 2) +
    CHAT_TURN_MINIMAP_CONTENT_INLINE_PADDING_REM * input.rootFontSize;
  const availableWidth = Math.floor(
    sideGutter - CHAT_TURN_MINIMAP_EDGE_INSET_REM * input.rootFontSize,
  );
  return Math.min(CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH, availableWidth);
}

export interface ChatTurnMinimapListState {
  readonly scroll?: number;
  readonly scrollLength?: number;
  readonly positionAtIndex?: (index: number) => number | undefined;
  readonly sizeAtIndex?: (index: number) => number | undefined;
  readonly topOffsetAdjustment?: number;
}

export interface ChatTurnMinimapTurnRange {
  readonly rowIndex: number;
  readonly endRowIndex: number;
}

function finiteValue(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function turnBounds(
  state: ChatTurnMinimapListState,
  turns: ReadonlyArray<ChatTurnMinimapTurnRange>,
  index: number,
): { readonly top: number; readonly bottom: number } | null {
  const turn = turns[index];
  const top = finiteValue(state.positionAtIndex?.(turn.rowIndex));
  if (top === null) return null;

  const nextTop =
    index + 1 >= turns.length
      ? null
      : finiteValue(state.positionAtIndex?.(turns[index + 1].rowIndex));
  if (nextTop !== null) return { top, bottom: Math.max(top + 1, nextTop) };

  const endTop = finiteValue(state.positionAtIndex?.(turn.endRowIndex)) ?? top;
  const endHeight =
    finiteValue(state.sizeAtIndex?.(turn.endRowIndex)) ??
    finiteValue(state.sizeAtIndex?.(turn.rowIndex)) ??
    1;
  return { top, bottom: Math.max(top + 1, endTop + Math.max(1, endHeight)) };
}

function mostVisibleQueryIndex(
  state: ChatTurnMinimapListState,
  turns: ReadonlyArray<ChatTurnMinimapTurnRange>,
  viewportTop: number,
  viewportBottom: number,
): number | null {
  let bestIndex: number | null = null;
  let bestOverlap = 0;
  for (let index = 0; index < turns.length; index += 1) {
    const top = finiteValue(state.positionAtIndex?.(turns[index].rowIndex));
    if (top === null) continue;
    const height = Math.max(
      1,
      finiteValue(state.sizeAtIndex?.(turns[index].rowIndex)) ?? 1,
    );
    const overlap = Math.max(
      0,
      Math.min(top + height, viewportBottom) - Math.max(top, viewportTop),
    );
    // Equal overlap keeps the earlier query current.
    if (overlap > bestOverlap) {
      bestIndex = index;
      bestOverlap = overlap;
    }
  }
  return bestIndex;
}

/**
 * A visible user query is current. Otherwise, the reply occupying most of the
 * viewport keeps its triggering query current.
 */
export function resolveChatTurnMinimapCurrentIndex(
  state: ChatTurnMinimapListState,
  turns: ReadonlyArray<ChatTurnMinimapTurnRange>,
): number | null {
  if (turns.length === 0) return null;
  const topOffset = finiteValue(state.topOffsetAdjustment) ?? 0;
  const viewportTop = (finiteValue(state.scroll) ?? 0) - topOffset;
  const viewportBottom =
    viewportTop + Math.max(0, finiteValue(state.scrollLength) ?? 0);
  const visibleQuery = mostVisibleQueryIndex(
    state,
    turns,
    viewportTop,
    viewportBottom,
  );
  if (visibleQuery !== null) return visibleQuery;

  let bestIndex: number | null = null;
  let bestOverlap = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < turns.length; index += 1) {
    const bounds = turnBounds(state, turns, index);
    if (bounds === null) continue;
    const overlap = Math.max(
      0,
      Math.min(bounds.bottom, viewportBottom) -
        Math.max(bounds.top, viewportTop),
    );
    let distance = 0;
    if (overlap === 0 && bounds.bottom <= viewportTop) {
      distance = viewportTop - bounds.bottom;
    } else if (overlap === 0) {
      distance = bounds.top - viewportBottom;
    }
    if (
      overlap > bestOverlap ||
      (overlap === bestOverlap && distance < bestDistance)
    ) {
      bestIndex = index;
      bestOverlap = overlap;
      bestDistance = distance;
    }
  }
  return bestIndex;
}

export const CHAT_TURN_MINIMAP_PREVIEW_MAX_CHARS = 200;
const PREVIEW_SOURCE_SCAN_LIMIT = 16_384;
const WHITESPACE_RE = /\s/;

function sliceWholeCodePoints(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  const cut = text.slice(0, maxUnits);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

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
