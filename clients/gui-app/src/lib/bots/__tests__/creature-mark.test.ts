/**
 * A bot's creature mark (Tracy Bots, T111): a pure function of the bot's id,
 * mirrored, with both eyes, never a degenerate mask, and drawn in whole
 * pixels at every avatar size.
 */
import { describe, expect, it } from "vitest";
import {
  CREATURE_MARK_VERSION,
  type CreatureMark,
  type CreatureMarkSize,
  type CreatureSilhouette,
  creatureMark,
  drawCreatureMark,
} from "@/lib/bots/creature-mark";

const GRID = 5;

/** `#` is a body cell and `.` an empty one, column 0 first. */
function rowsFromStrings(rows: readonly string[]): number[] {
  return rows.map((row) => {
    let value = 0;
    for (const [column, cell] of [...row].entries()) {
      if (cell === "#") value |= 1 << column;
    }
    return value;
  });
}

function hasCell(
  rows: readonly number[],
  row: number,
  column: number,
): boolean {
  return ((rows[row] >>> column) & 1) === 1;
}

function reverseFiveBits(value: number): number {
  let reversed = 0;
  for (let column = 0; column < GRID; column++) {
    if ((value >>> column) & 1) reversed |= 1 << (GRID - 1 - column);
  }
  return reversed;
}

function bodyCells(rows: readonly number[]): number {
  let count = 0;
  for (let row = 0; row < GRID; row++) {
    for (let column = 0; column < GRID; column++) {
      if (hasCell(rows, row, column)) count++;
    }
  }
  return count;
}

/** The body fills its whole bounding box. */
function isSolidRectangle(rows: readonly number[]): boolean {
  const cells: Array<readonly [number, number]> = [];
  for (let row = 0; row < GRID; row++) {
    for (let column = 0; column < GRID; column++) {
      if (hasCell(rows, row, column)) cells.push([row, column]);
    }
  }
  const rowsOf = cells.map(([row]) => row);
  const columnsOf = cells.map(([, column]) => column);
  const top = Math.min(...rowsOf);
  const bottom = Math.max(...rowsOf);
  const left = Math.min(...columnsOf);
  const right = Math.max(...columnsOf);
  return cells.length === (bottom - top + 1) * (right - left + 1);
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** `count` real-shaped ids, `bot_0` plus 25 base32 characters, from a seeded LCG. */
function syntheticBotIds(count: number): string[] {
  let state = 20261031;
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    let id = "bot_0";
    for (let char = 0; char < 25; char++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      id += CROCKFORD[state >>> 27];
    }
    ids.push(id);
  }
  return ids;
}

// A change to any row here is a deliberate algorithm change, and it bumps
// CREATURE_MARK_VERSION with it.
const PINNED: ReadonlyArray<{
  readonly botId: string;
  readonly silhouette: CreatureSilhouette;
  readonly rows: readonly string[];
}> = [
  {
    botId: "bot_019YFRXBQ551DN29WCTHKM3CEP",
    silhouette: "none",
    rows: [".###.", ".###.", "..#..", "#####", "#####"],
  },
  {
    botId: "bot_0RVWRHPMH8WPT9KW1NGKJB319D",
    silhouette: "none",
    rows: [".#.#.", ".#.#.", ".#.#.", "##.##", "....."],
  },
  {
    botId: "bot_0YVZD4PHYFAZS1MCR0D9GABAGV",
    silhouette: "ears",
    rows: ["#####", ".#.#.", "..#..", ".###.", "##.##"],
  },
  {
    botId: "bot_0G6666666666666666666666GG",
    silhouette: "feet",
    rows: ["#.#.#", ".#.#.", "#...#", "##.##", "#.#.#"],
  },
  {
    botId: "bot_0D3333333333333333333333DD",
    silhouette: "crest",
    rows: ["..#..", ".###.", "#####", "#####", "..#.."],
  },
];

describe("the generator", () => {
  it("is version 1 and gives fixed ids their exact masks and silhouettes", () => {
    expect(CREATURE_MARK_VERSION).toBe(1);
    for (const pinned of PINNED) {
      expect(creatureMark(pinned.botId), pinned.botId).toEqual({
        rows: rowsFromStrings(pinned.rows),
        silhouette: pinned.silhouette,
      });
    }
  });

  describe("over 2,000 real-shaped ids", () => {
    const marks: ReadonlyArray<{
      readonly botId: string;
      readonly mark: CreatureMark;
    }> = syntheticBotIds(2000).map((botId) => ({
      botId,
      mark: creatureMark(botId),
    }));

    it("gives one id the same mark every time", () => {
      for (const { botId, mark } of marks) {
        expect(creatureMark(botId)).toEqual(mark);
      }
    });

    it("mirrors every mask left to right", () => {
      for (const { mark } of marks) {
        expect(mark.rows.map(reverseFiveBits)).toEqual(mark.rows);
      }
    });

    it("gives every mask both eyes on row 1, columns 1 and 3", () => {
      for (const { mark } of marks) {
        expect(hasCell(mark.rows, 1, 1)).toBe(true);
        expect(hasCell(mark.rows, 1, 3)).toBe(true);
      }
    });

    it("gives every mask at least six body cells and never a solid rectangle", () => {
      for (const { mark } of marks) {
        expect(bodyCells(mark.rows)).toBeGreaterThanOrEqual(6);
        expect(isSolidRectangle(mark.rows)).toBe(false);
      }
    });

    it("stands each silhouette's cells on body cells", () => {
      for (const { mark } of marks) {
        if (mark.silhouette === "ears") {
          expect(hasCell(mark.rows, 0, 0)).toBe(true);
          expect(hasCell(mark.rows, 0, 4)).toBe(true);
        } else if (mark.silhouette === "feet") {
          expect(hasCell(mark.rows, 4, 0)).toBe(true);
          expect(hasCell(mark.rows, 4, 4)).toBe(true);
        } else if (mark.silhouette === "crest") {
          expect(hasCell(mark.rows, 0, 2)).toBe(true);
        }
      }
    });

    it("draws all four silhouette families", () => {
      expect(new Set(marks.map(({ mark }) => mark.silhouette))).toEqual(
        new Set<CreatureSilhouette>(["none", "ears", "feet", "crest"]),
      );
    });
  });
});

interface Square {
  readonly x: number;
  readonly y: number;
  readonly side: number;
}

/** The path's `M x y h a v a h -a z` squares; null for any other text. */
function parseSquares(path: string): Square[] | null {
  if (!/^(M\d+ \d+h\d+v\d+h-\d+z)+$/.test(path)) return null;
  const squares: Square[] = [];
  for (const match of path.matchAll(/M(\d+) (\d+)h(\d+)v(\d+)h-(\d+)z/g)) {
    const [, x, y, across, down, back] = match.map(Number);
    if (across !== down || across !== back) return null;
    squares.push({ x, y, side: across });
  }
  return squares;
}

describe("drawing a creature", () => {
  const SIZES: readonly CreatureMarkSize[] = [16, 24, 32, 40];
  // One id of each silhouette family.
  const drawnIds = PINNED.map((pinned) => pinned.botId);

  it("sets a viewBox the size of the avatar", () => {
    const mark = creatureMark(drawnIds[0]);
    for (const size of SIZES) {
      expect(drawCreatureMark(mark, size).viewBox).toBe(
        `0 0 ${String(size)} ${String(size)}`,
      );
    }
  });

  it("draws only whole-pixel squares that lie inside the box", () => {
    for (const botId of drawnIds) {
      for (const size of SIZES) {
        const squares = parseSquares(
          drawCreatureMark(creatureMark(botId), size).path,
        );
        expect(squares, `${botId} at ${String(size)}`).not.toBeNull();
        for (const square of squares ?? []) {
          expect(square.x).toBeGreaterThanOrEqual(0);
          expect(square.y).toBeGreaterThanOrEqual(0);
          expect(square.x + square.side).toBeLessThanOrEqual(size);
          expect(square.y + square.side).toBeLessThanOrEqual(size);
        }
      }
    }
  });

  it("cuts two eye holes of a cell less two pixels at 24, 32 and 40, and none at 16", () => {
    for (const botId of drawnIds) {
      const mark = creatureMark(botId);
      for (const size of SIZES) {
        const cell = size / 8;
        const squares = parseSquares(drawCreatureMark(mark, size).path) ?? [];
        const holes = squares.filter((square) => square.side === cell - 2);
        expect(holes, `${botId} at ${String(size)}`).toHaveLength(
          size === 16 ? 0 : 2,
        );
      }
    }
  });
});
