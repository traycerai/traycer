/**
 * Cell arithmetic behind the terminal's touch gestures.
 *
 * xterm draws the grid on a canvas and drives selection from MOUSE events it
 * never receives on a phone (its own touch recognizer cancels the compatibility
 * mouse events to keep a pan a scroll). So a touch selection is computed here,
 * from the finger's pixel position and the screen box, and handed to xterm
 * through its public `select` API in buffer coordinates. Pure functions, so the
 * geometry and the word rule are testable without a canvas.
 */
import type { ITerminalOptions } from "@xterm/xterm";

/** A cell on the visible screen: `row` counts from the viewport's first line. */
export interface TerminalScreenCell {
  readonly col: number;
  readonly row: number;
}

/** A cell in the buffer: `row` is absolute, scrollback included. */
export interface TerminalBufferCell {
  readonly col: number;
  readonly row: number;
}

/** What xterm's `select(column, row, length)` takes: a start cell and a run of cells that wraps across lines. */
export interface TerminalSelectionSpan {
  readonly column: number;
  readonly row: number;
  readonly length: number;
}

export interface TerminalClientPoint {
  readonly x: number;
  readonly y: number;
}

/** The screen element's box, as `getBoundingClientRect` reports it. */
export interface TerminalScreenBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The slice of an xterm buffer line a word lookup reads. `IBufferLine` satisfies it. */
export interface TerminalLineCells {
  getCell(x: number): { getChars(): string; getWidth(): number } | undefined;
}

/**
 * The slice of xterm's `Terminal` the touch gestures and their menu drive.
 * Satisfied structurally by the real engine; narrow so the recognizer can be
 * exercised against a stand-in.
 */
export interface TerminalTouchTarget {
  readonly element: HTMLElement | undefined;
  readonly cols: number;
  readonly rows: number;
  readonly options: Pick<ITerminalOptions, "wordSeparator">;
  readonly buffer: {
    readonly active: {
      readonly viewportY: number;
      getLine(y: number): TerminalLineCells | undefined;
    };
  };
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
  select(column: number, row: number, length: number): void;
  selectAll(): void;
  paste(data: string): void;
  focus(): void;
}

/**
 * The cell under a client point. Clamped to the grid, so a finger dragged past
 * an edge keeps extending the selection to that edge instead of dropping it.
 */
export function terminalCellAtPoint(args: {
  readonly point: TerminalClientPoint;
  readonly screen: TerminalScreenBox;
  readonly cols: number;
  readonly rows: number;
}): TerminalScreenCell {
  const { point, screen, cols, rows } = args;
  const cellWidth = cols > 0 ? screen.width / cols : 0;
  const cellHeight = rows > 0 ? screen.height / rows : 0;
  const col =
    cellWidth > 0 ? Math.floor((point.x - screen.left) / cellWidth) : 0;
  const row =
    cellHeight > 0 ? Math.floor((point.y - screen.top) / cellHeight) : 0;
  return {
    col: clamp(col, 0, Math.max(0, cols - 1)),
    row: clamp(row, 0, Math.max(0, rows - 1)),
  };
}

/**
 * The span from the cell the hold began on to the cell the finger is over now,
 * in either direction. Length counts cells across wrapped lines, which is how
 * xterm's `select` reads it.
 */
export function terminalSelectionSpan(
  anchor: TerminalBufferCell,
  head: TerminalBufferCell,
  cols: number,
): TerminalSelectionSpan {
  const anchorFirst =
    anchor.row < head.row ||
    (anchor.row === head.row && anchor.col <= head.col);
  const start = anchorFirst ? anchor : head;
  const end = anchorFirst ? head : anchor;
  return {
    column: start.col,
    row: start.row,
    length: (end.row - start.row) * cols + (end.col - start.col) + 1,
  };
}

/**
 * The word a column sits in, by xterm's own rule: a run of cells that are
 * neither blank nor one of the configured `wordSeparator`. A wide glyph's
 * trailing zero-width cell belongs to its leader, so a CJK word is one run.
 * `null` when the column is blank or a separator - there is nothing to select.
 */
export function terminalWordAtColumn(args: {
  readonly line: TerminalLineCells;
  readonly column: number;
  readonly cols: number;
  readonly separators: string;
}): { readonly column: number; readonly length: number } | null {
  const { line, column, cols, separators } = args;
  if (column < 0 || column >= cols) return null;
  const isWordCell = (x: number): boolean => {
    const cell = line.getCell(x);
    if (cell === undefined) return false;
    if (cell.getWidth() === 0) return true;
    const chars = cell.getChars();
    if (chars.length === 0 || chars.trim().length === 0) return false;
    return !separators.includes(chars);
  };
  if (!isWordCell(column)) return null;
  let start = column;
  while (start > 0 && isWordCell(start - 1)) start -= 1;
  let end = column;
  while (end + 1 < cols && isWordCell(end + 1)) end += 1;
  return { column: start, length: end - start + 1 };
}

/**
 * The screen box the engine paints into. `null` while the engine is not open
 * (no element) or its screen is not laid out, in which case there is no cell
 * to resolve a point to.
 */
export function terminalScreenBox(
  term: TerminalTouchTarget,
): TerminalScreenBox | null {
  const screen = term.element?.querySelector(".xterm-screen");
  if (screen === null || screen === undefined) return null;
  const rect = screen.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return rect;
}

/** The buffer cell under a client point, or `null` with no painted screen. */
export function terminalBufferCellAtPoint(
  term: TerminalTouchTarget,
  point: TerminalClientPoint,
): TerminalBufferCell | null {
  const screen = terminalScreenBox(term);
  if (screen === null) return null;
  const cell = terminalCellAtPoint({
    point,
    screen,
    cols: term.cols,
    rows: term.rows,
  });
  return { col: cell.col, row: term.buffer.active.viewportY + cell.row };
}

/** The word under a client point as a selectable span, or `null` when there is none. */
export function terminalWordAtPoint(
  term: TerminalTouchTarget,
  point: TerminalClientPoint,
): TerminalSelectionSpan | null {
  const cell = terminalBufferCellAtPoint(term, point);
  if (cell === null) return null;
  const line = term.buffer.active.getLine(cell.row);
  if (line === undefined) return null;
  const word = terminalWordAtColumn({
    line,
    column: cell.col,
    cols: term.cols,
    separators: term.options.wordSeparator ?? "",
  });
  if (word === null) return null;
  return { column: word.column, row: cell.row, length: word.length };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
