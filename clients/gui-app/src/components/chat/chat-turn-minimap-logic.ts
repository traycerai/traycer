import {
  MINIMAP_TRACK_END_HIT_PADDING,
  MINIMAP_TRACK_ITEM_SPACING,
  resolveMinimapTrackHeightStyle,
  resolveMinimapTrackTopStyle,
} from "@/components/minimap/minimap-track-geometry";
import type { MinimapListEntry } from "@/components/minimap/minimap-list-card";
import type { TranscriptListRow } from "@/stores/chats/transcript-list-rows";
import type { TranscriptWindow } from "@/stores/chats/transcript-window";
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

/**
 * One rail entry: a human-sent turn, and the row span it covers.
 *
 * `rowIndex` / `endRowIndex` are LIST indexes - what `positionAtIndex` takes -
 * and not transcript ordinals, which on the windowed line differ wherever a
 * renderer policy withheld a row.
 */
export interface ChatTurnMinimapItem extends MinimapListEntry {
  readonly endRowIndex: number;
  readonly messageId: string;
  readonly rowIndex: number;
}

/**
 * Whether a row is a HUMAN-sent user turn - the only kind the rail lists.
 * Answerable for unhydrated rows too: the skeleton carries `role`,
 * `sentByAgent` and `preview` precisely so the minimap can list a turn whose
 * body has not arrived (see `row-skeleton.ts`).
 */
function isHumanUserRow(row: TranscriptListRow): boolean {
  if (row.kind === "hydrated") {
    return row.model.role === "user" && row.model.agentSenderInfo === null;
  }
  return (
    row.entry !== null &&
    row.entry.role === "user" &&
    row.entry.sentByAgent !== true
  );
}

function chatTurnMinimapRowLabel(row: TranscriptListRow): string {
  const text =
    row.kind === "hydrated" ? row.model.content : (row.entry?.preview ?? "");
  return compactChatTurnMinimapPreview(text) ?? "Untitled message";
}

function deriveChatTurnMinimapItems(
  rows: ReadonlyArray<TranscriptListRow>,
): ReadonlyArray<ChatTurnMinimapItem> {
  const humanRows: number[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    if (isHumanUserRow(rows[index])) humanRows.push(index);
  }

  return humanRows.map((rowIndex, index) => {
    const row = rows[rowIndex];
    return {
      key: row.key,
      label: chatTurnMinimapRowLabel(row),
      level: 1,
      messageId: row.key,
      rowIndex,
      endRowIndex: (humanRows[index + 1] ?? rows.length) - 1,
    };
  });
}

/**
 * What must move for the derive to re-run, beyond the window's own identity.
 *
 * `rows.length` is here because a PLACED row can leave the list without the
 * window changing at all: `rendered` is post-filter, and the pinned-todo pass
 * drops an assistant row whose only segments were lifted into the dock
 * (`transcript-list-rows.ts` documents this as OMITTED, not placeholder'd).
 * That state is decided by the live turn, which folds into `messages` alone -
 * exactly the churn the window's identity is stable across - so the suppression
 * can flip per token while `TranscriptWindow` identity and the trailing
 * unplaced keys both hold still.
 *
 * The items cache LIST indexes (`rowIndex` / `endRowIndex`, see their doc), so
 * reusing a derive across that flip points `positionAtIndex` one row past every
 * turn below the omitted one - the rail's marks slide against the transcript
 * with nothing on screen to explain it.
 *
 * Both halves are bounded: the length is a number, and the unplaced keys are
 * the trailing run only.
 */
function deriveCacheKey(rows: ReadonlyArray<TranscriptListRow>): string {
  return `${rows.length}:${unplacedRowKeys(rows)}`;
}

/**
 * The keys of the rows that own no ordinal - the live turn, pending sends, and
 * records the index has not placed yet.
 *
 * Bounded, and that is the whole reason it exists: `transcriptListRows` appends
 * every ordinal-less row AFTER all the placed ones, so this walks back from the
 * end and stops at the first placed row rather than scanning the transcript.
 */
function unplacedRowKeys(rows: ReadonlyArray<TranscriptListRow>): string {
  let key = "";
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.ordinal !== null) break;
    key = key.length === 0 ? row.key : `${row.key} ${key}`;
  }
  return key;
}

/**
 * The last derive, per transcript window and per legacy `rows` array.
 *
 * `WeakMap`s, and one slot inside the windowed one, for the same reason
 * `transcript-list-rows.ts` caches placeholders per skeleton: the value is a
 * pure function of the key, it dies with the object it describes, and it needs
 * no invalidation. One slot rather than a map because the key it guards moves
 * only when an unplaced row is added or removed, which is not a churn pattern
 * worth retaining alternatives for.
 */
const lastDeriveByWindow = new WeakMap<
  object,
  { readonly key: string; readonly items: ReadonlyArray<ChatTurnMinimapItem> }
>();
const lastDeriveByRows = new WeakMap<
  object,
  ReadonlyArray<ChatTurnMinimapItem>
>();

/**
 * The rail's turn list, derived at most once per structural change.
 *
 * ## Why this is not `useMemo(..., [rows])`
 *
 * `rows` is rebuilt on every streaming token - `transcriptListRows` is memoized
 * on `[transcriptWindow, messages]` and `messages` moves per token - so keying
 * on it ran a whole-transcript scan, a per-turn object allocation and a
 * per-turn preview compaction dozens of times a second. On a 20k-row chat that
 * is O(history) work on the hottest path in the app, inside the structure
 * introduced to make long chats cheap. It was harmless while the rail listed
 * only hydrated messages, because that set was bounded; teaching it to list
 * COLD turns is exactly what widened the scan to the whole history.
 *
 * ## What the answer actually depends on
 *
 * The `TranscriptWindow` object, and the ordinal-less tail. A block delta - the
 * per-token event - folds into `messages` alone and never touches the window
 * (`applyBufferedDeltas`), so the window's identity is stable across exactly
 * the churn this is avoiding, while every input that CAN change a rail entry
 * moves it:
 *
 * - a row's label, and whether it is a human turn at all, comes from the
 *   skeleton entry for a cold row and from the model for a hydrated one - and a
 *   user row's body changes only by an edit, which arrives as an index
 *   `updated` and rebuilds the window;
 * - which ordinals a renderer policy withholds is decided by the models the
 *   spans hold, and those arrive in range responses, which rebuild the window;
 * - rows the index has not placed are an input the window does not version, so
 *   their keys are compared directly. They are bounded.
 *
 * Two inputs escape the window, not one, and the second is easy to miss
 * because it moves a row the window DOES version: a placed row can be dropped
 * from `rows` outright by the pinned-todo pass, which reads the live turn and
 * therefore moves per token. `deriveCacheKey` carries both.
 *
 * The legacy line has no window and no ordinals, so it keys on the `rows` array
 * itself - which is exactly the memo this replaced, and bounded there because
 * that line hydrates the whole transcript anyway.
 */
export function chatTurnMinimapItems(input: {
  readonly rows: ReadonlyArray<TranscriptListRow>;
  readonly window: TranscriptWindow | null;
}): ReadonlyArray<ChatTurnMinimapItem> {
  const { rows, window } = input;
  if (window === null) {
    const cached = lastDeriveByRows.get(rows);
    if (cached !== undefined) return cached;
    const items = deriveChatTurnMinimapItems(rows);
    lastDeriveByRows.set(rows, items);
    return items;
  }
  const key = deriveCacheKey(rows);
  const cached = lastDeriveByWindow.get(window);
  if (cached !== undefined && cached.key === key) return cached.items;
  const items = deriveChatTurnMinimapItems(rows);
  lastDeriveByWindow.set(window, { key, items });
  return items;
}
