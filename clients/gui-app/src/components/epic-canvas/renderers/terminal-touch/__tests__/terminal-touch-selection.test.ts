import { describe, expect, it } from "vitest";

import {
  terminalCellAtPoint,
  terminalSelectionSpan,
  terminalWordAtColumn,
  terminalWordAtPoint,
  type TerminalLineCells,
  type TerminalScreenBox,
  type TerminalTouchTarget,
} from "../terminal-touch-selection";

const SCREEN: TerminalScreenBox = {
  left: 100,
  top: 50,
  width: 800,
  height: 480,
};

/** A line whose cells are `[chars, width]`; indices past the end are `undefined`. */
function lineOf(
  cells: ReadonlyArray<readonly [string, number]>,
): TerminalLineCells {
  return {
    getCell: (x) => {
      const cell = cells.at(x);
      if (cell === undefined) return undefined;
      return { getChars: () => cell[0], getWidth: () => cell[1] };
    },
  };
}

function lineOfText(text: string): TerminalLineCells {
  return lineOf(Array.from(text, (ch): readonly [string, number] => [ch, 1]));
}

describe("terminalCellAtPoint", () => {
  it("divides the screen box into cols x rows cells", () => {
    // 80 cols over 800px = 10px cells; 24 rows over 480px = 20px rows.
    expect(
      terminalCellAtPoint({
        point: { x: 100 + 10 * 7 + 3, y: 50 + 20 * 4 + 19 },
        screen: SCREEN,
        cols: 80,
        rows: 24,
      }),
    ).toEqual({ col: 7, row: 4 });
  });

  it("clamps a point left of or above the screen to the first cell", () => {
    expect(
      terminalCellAtPoint({
        point: { x: -500, y: -500 },
        screen: SCREEN,
        cols: 80,
        rows: 24,
      }),
    ).toEqual({ col: 0, row: 0 });
  });

  it("clamps a point right of or below the screen to the last cell", () => {
    expect(
      terminalCellAtPoint({
        point: { x: 5000, y: 5000 },
        screen: SCREEN,
        cols: 80,
        rows: 24,
      }),
    ).toEqual({ col: 79, row: 23 });
  });

  it("yields cell zero when the grid has no columns or rows", () => {
    expect(
      terminalCellAtPoint({
        point: { x: 300, y: 300 },
        screen: SCREEN,
        cols: 0,
        rows: 0,
      }),
    ).toEqual({ col: 0, row: 0 });
  });
});

describe("terminalSelectionSpan", () => {
  it("gives the same span for a same-line drag in either direction", () => {
    const forward = terminalSelectionSpan(
      { col: 5, row: 3 },
      { col: 9, row: 3 },
      80,
    );
    const backward = terminalSelectionSpan(
      { col: 9, row: 3 },
      { col: 5, row: 3 },
      80,
    );
    expect(forward).toEqual({ column: 5, row: 3, length: 5 });
    expect(backward).toEqual(forward);
  });

  it("counts cells across wrapped lines as rows * cols + column delta + 1", () => {
    expect(
      terminalSelectionSpan({ col: 70, row: 2 }, { col: 4, row: 4 }, 80),
    ).toEqual({ column: 70, row: 2, length: 2 * 80 + (4 - 70) + 1 });
  });

  it("starts at the head when it lies on an earlier line than the anchor", () => {
    expect(
      terminalSelectionSpan({ col: 3, row: 6 }, { col: 10, row: 5 }, 80),
    ).toEqual({ column: 10, row: 5, length: 80 + (3 - 10) + 1 });
  });
});

describe("terminalWordAtColumn", () => {
  const separators = " ()";

  it("returns the whole run when the column is in the middle of a word", () => {
    expect(
      terminalWordAtColumn({
        line: lineOfText("hello world"),
        column: 2,
        cols: 80,
        separators,
      }),
    ).toEqual({ column: 0, length: 5 });
  });

  it("returns null on a blank cell", () => {
    expect(
      terminalWordAtColumn({
        line: lineOfText("hello world"),
        column: 5,
        cols: 80,
        separators,
      }),
    ).toBeNull();
  });

  it("returns null on a separator and stops a word at one", () => {
    const line = lineOfText("f(abc)");
    expect(
      terminalWordAtColumn({ line, column: 1, cols: 80, separators }),
    ).toBeNull();
    expect(
      terminalWordAtColumn({ line, column: 3, cols: 80, separators }),
    ).toEqual({ column: 2, length: 3 });
  });

  it("treats a wide glyph and its zero-width trailing cell as one run", () => {
    const line = lineOf([
      ["a", 1],
      ["世", 2],
      ["", 0],
      ["b", 1],
      [" ", 1],
    ]);
    expect(
      terminalWordAtColumn({ line, column: 2, cols: 80, separators }),
    ).toEqual({ column: 0, length: 4 });
  });

  it("ends the word at cells past the end of the line", () => {
    expect(
      terminalWordAtColumn({
        line: lineOfText("abc"),
        column: 1,
        cols: 80,
        separators,
      }),
    ).toEqual({ column: 0, length: 3 });
  });

  it("returns null for a column outside the grid", () => {
    expect(
      terminalWordAtColumn({
        line: lineOfText("abc"),
        column: 80,
        cols: 80,
        separators,
      }),
    ).toBeNull();
  });
});

function createTarget(args: {
  readonly box: TerminalScreenBox;
  readonly viewportY: number;
  readonly lines: ReadonlyMap<number, TerminalLineCells>;
}): TerminalTouchTarget {
  const element = document.createElement("div");
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  screen.getBoundingClientRect = () => ({
    ...args.box,
    right: args.box.left + args.box.width,
    bottom: args.box.top + args.box.height,
    x: args.box.left,
    y: args.box.top,
    toJSON: () => ({}),
  });
  element.appendChild(screen);
  return {
    element,
    cols: 80,
    rows: 24,
    options: { wordSeparator: " ()" },
    buffer: {
      active: {
        viewportY: args.viewportY,
        getLine: (y) => args.lines.get(y),
      },
    },
    hasSelection: () => false,
    getSelection: () => "",
    clearSelection: () => undefined,
    select: () => undefined,
    selectAll: () => undefined,
    paste: () => undefined,
    focus: () => undefined,
  };
}

describe("terminalWordAtPoint", () => {
  it("resolves the word under the point on the buffer row offset by viewportY", () => {
    const term = createTarget({
      box: SCREEN,
      viewportY: 100,
      lines: new Map([[102, lineOfText("say hello now")]]),
    });
    // Screen row 2, column 6 -> buffer row 102, inside "hello" (cols 4-8).
    expect(
      terminalWordAtPoint(term, { x: 100 + 10 * 6 + 1, y: 50 + 20 * 2 + 1 }),
    ).toEqual({ column: 4, row: 102, length: 5 });
  });

  it("returns null when the buffer has no line under the point", () => {
    const term = createTarget({
      box: SCREEN,
      viewportY: 0,
      lines: new Map(),
    });
    expect(terminalWordAtPoint(term, { x: 110, y: 60 })).toBeNull();
  });

  it("returns null when the screen box has zero size", () => {
    const term = createTarget({
      box: { left: 0, top: 0, width: 0, height: 0 },
      viewportY: 0,
      lines: new Map([[0, lineOfText("hello")]]),
    });
    expect(terminalWordAtPoint(term, { x: 1, y: 1 })).toBeNull();
  });
});
