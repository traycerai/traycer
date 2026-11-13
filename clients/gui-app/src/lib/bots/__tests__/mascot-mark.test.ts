/**
 * A bot's mascot: a pure function of the bot's id unless a person chose a
 * shape or colour, mirrored, with both eyes, kept inside the squircle's safe
 * area, and drawn in whole pixels at every avatar size.
 */
import { describe, expect, it } from "vitest";
import {
  BOT_APPEARANCE_UNRECOGNISED,
  BOT_MASCOT_SHAPES,
  BOT_UNRECOGNISED_MARK,
  type BotAppearance,
  type BotMascotShape,
} from "@traycer/protocol/host/bot/schemas";
import {
  DEFAULT_MASCOT_RAMP,
  DEFAULT_MASCOT_SHAPE,
  botMascot,
  drawMascotMark,
  ownMascotShape,
  mascotRampAt,
  mascotShading,
  type MascotMarkSize,
} from "@/lib/bots/mascot-mark";
import { derivedBotColorIndex } from "@/lib/providers/profile-accent-color";

const GRID = 12;

// Real-shaped ids from the browser contact sheet. A change to a shape here
// is a deliberate algorithm change: a bot keeps its mascot.
const PINNED: ReadonlyArray<{
  readonly botId: string;
  readonly shape: BotMascotShape;
}> = [
  { botId: "bot_019YFRXBQ551DN29WCTHKM3CEP", shape: "capsule" },
  { botId: "bot_0RVWRHPMH8WPT9KW1NGKJB319D", shape: "blob" },
  { botId: "bot_0YVZD4PHYFAZS1MCR0D9GABAGV", shape: "cat" },
  { botId: "bot_0CMZFWFPVBYBD82G65ECDKBFNW", shape: "shield" },
  { botId: "bot_0C6KRNMMJXMKYDJNMJZ6A69HG3", shape: "sun" },
  { botId: "bot_0HG4W993NK3PTMJDTPJVVBS6QJ", shape: "doc" },
];

const NO_CHOICE: BotAppearance = {
  mark: null,
  color: null,
  background: null,
};

/** The shape's filled cells as `[row, column]`. */
function filledCells(shape: BotMascotShape): Array<readonly [number, number]> {
  return mascotShading(shape).flatMap((row, y) =>
    row.flatMap((tone, x) => (tone === null ? [] : [[y, x] as const])),
  );
}

function isFilled(shape: BotMascotShape, y: number, x: number): boolean {
  return (mascotShading(shape)[y]?.[x] ?? null) !== null;
}

describe("a bot's own mascot", () => {
  it("gives fixed ids their exact shapes", () => {
    for (const pinned of PINNED) {
      expect(ownMascotShape(pinned.botId), pinned.botId).toBe(pinned.shape);
    }
  });
});

describe("every shape", () => {
  it("mirrors left to right, except the doc", () => {
    for (const shape of BOT_MASCOT_SHAPES) {
      const mirroredBy = filledCells(shape).filter(
        ([y, x]) => !isFilled(shape, y, GRID - 1 - x),
      );
      if (shape === "doc") {
        expect(mirroredBy.length, shape).toBeGreaterThan(0);
      } else {
        expect(mirroredBy, shape).toEqual([]);
      }
    }
  });

  it("has two eyes, two cells tall, each with body on both sides", () => {
    for (const shape of BOT_MASCOT_SHAPES) {
      const shading = mascotShading(shape);
      const eyes = shading.flatMap((row, y) =>
        row.flatMap((tone, x) => (tone === "eye" ? [[y, x] as const] : [])),
      );
      expect(eyes, shape).toHaveLength(4);
      const rows = [...new Set(eyes.map(([y]) => y))];
      const columns = [...new Set(eyes.map(([, x]) => x))];
      expect(rows, shape).toHaveLength(2);
      expect(columns, shape).toHaveLength(2);
      expect(rows[1] - rows[0], shape).toBe(1);
      for (const [y, x] of eyes) {
        for (const beside of [x - 1, x + 1]) {
          const tone = shading[y][beside];
          expect(
            tone,
            `${shape} ${String(y)},${String(beside)}`,
          ).not.toBeNull();
          expect(tone, `${shape} ${String(y)},${String(beside)}`).not.toBe(
            "eye",
          );
        }
      }
    }
  });

  it("stays inside the cells a squircle keeps at 24 px", () => {
    // Columns kept, by row: the corner rows keep 3-8, the next two 1-10.
    const keeps = (y: number): readonly [number, number] | null => {
      if (y === 0 || y === GRID - 1) return [3, 8];
      if (y === 1 || y === 2 || y === GRID - 3 || y === GRID - 2)
        return [1, 10];
      return null;
    };
    for (const shape of BOT_MASCOT_SHAPES) {
      const outside = filledCells(shape).filter(([y, x]) => {
        const range = keeps(y);
        return range !== null && (x < range[0] || x > range[1]);
      });
      expect(outside, shape).toEqual([]);
    }
  });
});

describe("a bot's mascot from its look", () => {
  const [{ botId }] = PINNED;

  it("is the id's own shape and colour when nothing was chosen", () => {
    for (const pinned of PINNED) {
      expect(botMascot(pinned.botId, null), pinned.botId).toEqual({
        shape: pinned.shape,
        ramp: mascotRampAt(derivedBotColorIndex(pinned.botId)),
      });
      expect(botMascot(pinned.botId, NO_CHOICE), pinned.botId).toEqual(
        botMascot(pinned.botId, null),
      );
    }
  });

  it("honours a chosen shape and a chosen colour", () => {
    const chosen = botMascot(botId, {
      mark: { kind: "mascot", shape: "flame" },
      color: 5,
      background: null,
    });
    expect(chosen.shape).toBe("flame");
    expect(chosen.ramp).toEqual(mascotRampAt(5));
    expect(chosen.ramp).not.toEqual(botMascot(botId, null).ramp);
  });

  it("draws the default mascot for a mark it cannot read", () => {
    expect(
      botMascot(botId, { ...NO_CHOICE, mark: BOT_UNRECOGNISED_MARK }).shape,
    ).toBe(DEFAULT_MASCOT_SHAPE);
  });

  it("draws the default colours for a colour it cannot read", () => {
    expect(
      botMascot(botId, { ...NO_CHOICE, color: BOT_APPEARANCE_UNRECOGNISED })
        .ramp,
    ).toBe(DEFAULT_MASCOT_RAMP);
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

describe("drawing a mascot", () => {
  const CELLS: ReadonlyArray<readonly [MascotMarkSize, number]> = [
    [16, 1],
    [24, 2],
    [32, 2],
    [40, 3],
  ];

  it("draws whole-pixel squares inside the box, one per filled cell", () => {
    for (const shape of BOT_MASCOT_SHAPES) {
      for (const [size, cell] of CELLS) {
        const drawing = drawMascotMark(
          { shape, ramp: DEFAULT_MASCOT_RAMP },
          size,
        );
        const squares = drawing.layers.flatMap((layer) => {
          const parsed = parseSquares(layer.path);
          expect(parsed, `${shape} at ${String(size)}`).not.toBeNull();
          return parsed ?? [];
        });
        for (const square of squares) {
          expect(square.side).toBe(cell);
          expect(square.x).toBeGreaterThanOrEqual(0);
          expect(square.y).toBeGreaterThanOrEqual(0);
          expect(square.x + square.side).toBeLessThanOrEqual(size);
          expect(square.y + square.side).toBeLessThanOrEqual(size);
        }
        // No two squares share a place, so the even-odd fill never cancels.
        expect(
          new Set(
            squares.map((square) => `${String(square.x)},${String(square.y)}`),
          ).size,
          `${shape} at ${String(size)}`,
        ).toBe(squares.length);
        const area = squares.reduce((sum, square) => sum + square.side ** 2, 0);
        expect(area, `${shape} at ${String(size)}`).toBe(
          filledCells(shape).length * cell * cell,
        );
      }
    }
  });
});
