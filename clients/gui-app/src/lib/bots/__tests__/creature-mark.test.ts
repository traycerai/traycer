/**
 * A bot's creature mark: a pure function of the bot's id,
 * mirrored, with both eyes, never a degenerate mask, and drawn in whole
 * pixels at every avatar size.
 */
import { describe, expect, it } from "vitest";
import { BOT_CREATURE_SEED_MAX } from "@traycer/protocol/host/bot/schemas";
import {
  type CreatureChoice,
  type CreatureMark,
  type CreatureMarkSize,
  type CreatureSilhouette,
  CREATURE_SHEET_SIZE,
  chosenCreatureMark,
  creatureMark,
  creatureSheet,
  drawCreatureMark,
  nextCreatureSheet,
  ownCreature,
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

// A change to any row here is a deliberate algorithm change.
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
  it("gives fixed ids their exact masks and silhouettes", () => {
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

describe("the creature sheet", () => {
  const botIds = syntheticBotIds(60);

  it("is the same for one bot id every time", () => {
    for (const botId of botIds) {
      expect(creatureSheet(botId)).toEqual(creatureSheet(botId));
    }
  });

  it("offers the bot's own creature first", () => {
    for (const botId of botIds) {
      const [own] = creatureSheet(botId);
      expect(own.seed).toBe(0);
      expect(chosenCreatureMark(botId, own)).toEqual(creatureMark(botId));
    }
  });

  it("offers twelve creatures, none drawn like another", () => {
    for (const botId of botIds) {
      const sheet = creatureSheet(botId);
      expect(sheet).toHaveLength(CREATURE_SHEET_SIZE);
      const looks = sheet.map((choice) => {
        const mark = chosenCreatureMark(botId, choice);
        return `${mark.silhouette}:${mark.rows.join(",")}`;
      });
      expect(new Set(looks).size).toBe(looks.length);
    }
  });

  it("regrows from a stored family and seed the mask the sheet showed", () => {
    for (const botId of botIds) {
      for (const choice of creatureSheet(botId)) {
        const stored = JSON.parse(JSON.stringify(choice)) as typeof choice;
        expect(chosenCreatureMark(botId, stored)).toEqual(
          chosenCreatureMark(botId, choice),
        );
        expect(chosenCreatureMark(botId, stored).silhouette).toBe(
          choice.family,
        );
      }
    }
  });

  it("grows another body from another seed", () => {
    const [botId] = botIds;
    const [own, second] = creatureSheet(botId);
    expect(chosenCreatureMark(botId, second).rows).not.toEqual(
      chosenCreatureMark(botId, { ...own, family: second.family }).rows,
    );
  });
});

describe("regenerating the sheet", () => {
  const botIds = syntheticBotIds(40);

  /** What a creature looks like: its silhouette and body rows. */
  function lookOf(botId: string, choice: CreatureChoice): string {
    const mark = chosenCreatureMark(botId, choice);
    return `${mark.silhouette}:${mark.rows.join(",")}`;
  }

  /** A shown creature other than the sheet's first, as a person's choice. */
  function currentOf(botId: string): CreatureChoice {
    return creatureSheet(botId)[3];
  }

  it("names the bot's own creature, the sheet's first", () => {
    for (const botId of botIds) {
      expect(ownCreature(botId)).toEqual(creatureSheet(botId)[0]);
    }
  });

  it("is the same for the same sheet and current creature every time", () => {
    for (const botId of botIds) {
      const first = creatureSheet(botId);
      const current = currentOf(botId);
      expect(nextCreatureSheet(botId, first, current)).toEqual(
        nextCreatureSheet(botId, first, current),
      );
    }
  });

  it("offers twelve creatures, none drawn like another", () => {
    for (const botId of botIds) {
      const next = nextCreatureSheet(
        botId,
        creatureSheet(botId),
        currentOf(botId),
      );
      expect(next).toHaveLength(CREATURE_SHEET_SIZE);
      const looks = next.map((choice) => lookOf(botId, choice));
      expect(new Set(looks).size).toBe(looks.length);
    }
  });

  it("offers none drawn like one it replaces or like the creature shown now", () => {
    for (const botId of botIds) {
      const first = creatureSheet(botId);
      const current = currentOf(botId);
      const avoided = new Set(
        [...first, current].map((choice) => lookOf(botId, choice)),
      );
      for (const choice of nextCreatureSheet(botId, first, current)) {
        expect(avoided.has(lookOf(botId, choice)), botId).toBe(false);
      }
    }
  });

  it("starts after the last seed of the sheet it is given, however short it is", () => {
    for (const botId of botIds) {
      const previous: readonly CreatureChoice[] = [
        { family: "none", seed: 100 },
      ];
      const next = nextCreatureSheet(botId, previous, currentOf(botId));
      expect(next[0].seed).toBe(101);
      for (const choice of next) {
        expect(choice.seed).toBeGreaterThan(100);
      }
    }
  });

  it("offers each seed in the family its seed hashes to, so a choice regrows the same mask", () => {
    for (const botId of botIds) {
      for (const choice of nextCreatureSheet(
        botId,
        creatureSheet(botId),
        currentOf(botId),
      )) {
        const stored = JSON.parse(JSON.stringify(choice)) as CreatureChoice;
        expect(chosenCreatureMark(botId, stored)).toEqual(
          chosenCreatureMark(botId, choice),
        );
        expect(chosenCreatureMark(botId, stored).silhouette).toBe(
          choice.family,
        );
      }
    }
  });

  it("never offers the same sheet twice in a row", () => {
    for (const botId of botIds) {
      const first = creatureSheet(botId);
      const current = ownCreature(botId);
      const second = nextCreatureSheet(botId, first, current);
      const third = nextCreatureSheet(botId, second, current);
      const seeds = (sheet: readonly CreatureChoice[]): number[] =>
        sheet.map((choice) => choice.seed);
      expect(seeds(second)).not.toEqual(seeds(first));
      expect(seeds(third)).not.toEqual(seeds(second));
      expect(seeds(third).some((seed) => seeds(second).includes(seed))).toBe(
        false,
      );
    }
  });

  it("wraps past the largest seed to 1 and never offers the bot's own seed 0", () => {
    for (const botId of botIds) {
      const previous: readonly CreatureChoice[] = [
        { family: "none", seed: BOT_CREATURE_SEED_MAX },
      ];
      // The shown creature is another one, so the bot's own is not avoided.
      const next = nextCreatureSheet(botId, previous, currentOf(botId));
      expect(next.length).toBeGreaterThan(0);
      expect(next[0].seed).toBe(1);
      for (const choice of next) {
        expect(choice.seed).not.toBe(0);
      }
    }
  });
});
