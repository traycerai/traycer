/**
 * A bot's mascot: a pure function of the bot's id, and of whether it is its
 * environment's main bot, unless a person chose a part of it, mirrored, with
 * both eyes, and drawn in whole pixels inside its box at every avatar size,
 * the smallest from a drawing of its own. What its eyes are doing follows the
 * bot and changes none of what it is.
 */
import { describe, expect, it } from "vitest";
import {
  BOT_APPEARANCE_UNRECOGNISED,
  BOT_MASCOT_ACCESSORIES,
  BOT_MASCOT_EYEWEAR,
  BOT_UNRECOGNISED_MARK,
  type BotAppearance,
  type BotMascotAccessory,
  type BotMascotEyewear,
} from "@traycer/protocol/host/bot/schemas";
import {
  DEFAULT_MASCOT_RAMP,
  DEFAULT_MASCOT_SHAPE,
  MASCOT_AT_REST,
  MASCOT_SHAPES,
  MASCOT_WORKING_BEATS,
  botMascot,
  drawMascotMark,
  mascotCells,
  mascotRampAt,
  smallMascotCells,
  ownMascotAccessory,
  ownMascotEyewear,
  ownMascotShape,
  type MascotCells,
  type MascotExpression,
  type MascotLook,
  type MascotMarkDrawing,
  type MascotMarkSize,
  type MascotPose,
  type MascotShape,
  type MascotTone,
} from "@/lib/bots/mascot-mark";
import {
  BLOB_SHADES16,
  BLOB_SHADES32,
  BLOB_VISOR16,
  BLOB_VISOR32,
} from "@/lib/bots/__tests__/mascot-eyewear-pinned";
import { derivedBotColorIndex } from "@/lib/providers/profile-accent-color";

const GRID = 10;
const SMALL_GRID = 7;

// Real-shaped ids from the browser contact sheet. A change to a look here is
// a deliberate algorithm change: a bot keeps its mascot.
const PINNED: ReadonlyArray<{
  readonly botId: string;
  readonly shape: MascotShape;
  readonly eyewear: BotMascotEyewear;
  readonly accessory: BotMascotAccessory;
}> = [
  {
    botId: "bot_019YFRXBQ551DN29WCTHKM3CEP",
    shape: "cat",
    eyewear: "none",
    accessory: "none",
  },
  {
    botId: "bot_0RVWRHPMH8WPT9KW1NGKJB319D",
    shape: "ghost",
    eyewear: "none",
    accessory: "bow",
  },
  {
    botId: "bot_0YVZD4PHYFAZS1MCR0D9GABAGV",
    shape: "sun",
    eyewear: "none",
    accessory: "flag",
  },
  {
    botId: "bot_0CMZFWFPVBYBD82G65ECDKBFNW",
    shape: "ghost",
    eyewear: "none",
    accessory: "sprout",
  },
  {
    botId: "bot_0C6KRNMMJXMKYDJNMJZ6A69HG3",
    shape: "capsule",
    eyewear: "none",
    accessory: "sparkle",
  },
  {
    botId: "bot_0HG4W993NK3PTMJDTPJVVBS6QJ",
    shape: "flame",
    eyewear: "none",
    accessory: "antennae",
  },
  {
    botId: "bot_0KNEF4PC1F8D0H626S5VEKEQ8Y",
    shape: "flame",
    eyewear: "shades",
    accessory: "flag",
  },
  {
    botId: "bot_0HJWG5J1CBMN5G6P2TJKVM1BTC",
    shape: "cat",
    eyewear: "none",
    accessory: "bow",
  },
  {
    botId: "bot_0YNTD7R4TXXMB2NCTCPFWC9DWH",
    shape: "capsule",
    eyewear: "none",
    accessory: "flag",
  },
  {
    botId: "bot_04AVD8GCXRE2WBWS1B5301DZ2Z",
    shape: "cat",
    eyewear: "none",
    accessory: "none",
  },
  {
    botId: "bot_0BHAF30C73QHBSQ7G0M8C7W2PR",
    shape: "capsule",
    eyewear: "none",
    accessory: "antennae",
  },
  {
    botId: "bot_00RFW54YAGJKVQNHC91DDFA5BD",
    shape: "flame",
    eyewear: "none",
    accessory: "none",
  },
];

/** The pinned bot that wears shades and carries a flag. */
const STYLISH_BOT_ID = "bot_0KNEF4PC1F8D0H626S5VEKEQ8Y";

const NO_CHOICE: BotAppearance = {
  mark: null,
  color: null,
};

const EXPRESSIONS: readonly MascotExpression[] = ["idle", "working", "away"];

const BEATS: readonly number[] = Array.from(
  { length: MASCOT_WORKING_BEATS },
  (_, beat) => beat,
);

function lookOf(
  shape: MascotShape,
  eyewear: BotMascotEyewear,
  accessory: BotMascotAccessory,
): MascotLook {
  return { shape, ramp: DEFAULT_MASCOT_RAMP, eyewear, accessory };
}

/** Where the cells are filled, as `[x, y]`. */
function filledAt(cells: MascotCells): Array<readonly [number, number]> {
  return cells.flatMap((row, y) =>
    row.flatMap((tone, x) => (tone === null ? [] : [[x, y] as const])),
  );
}

/** Where `tone` is drawn, as `[x, y]`. */
function placesOf(
  cells: MascotCells,
  tone: MascotTone,
): Array<readonly [number, number]> {
  return cells.flatMap((row, y) =>
    row.flatMap((at, x) => (at === tone ? [[x, y] as const] : [])),
  );
}

/** The two drawings of a mascot: the full grid, and the smallest size's. */
const DRAWINGS: ReadonlyArray<
  readonly [string, (look: MascotLook, pose: MascotPose) => MascotCells]
> = [
  ["full", mascotCells],
  ["small", smallMascotCells],
];

/** A body with nothing on it, looking ahead. */
function bareBody(
  shape: MascotShape,
  draw: (look: MascotLook, pose: MascotPose) => MascotCells,
): MascotCells {
  return draw(lookOf(shape, "none", "none"), MASCOT_AT_REST);
}

function working(beat: number): MascotPose {
  return { expression: "working", beat };
}

describe("a bot's own mascot", () => {
  it("gives fixed ids their exact body, eyewear and accessory", () => {
    for (const pinned of PINNED) {
      expect(
        {
          shape: ownMascotShape(pinned.botId),
          eyewear: ownMascotEyewear(pinned.botId),
          accessory: ownMascotAccessory(pinned.botId),
        },
        pinned.botId,
      ).toEqual({
        shape: pinned.shape,
        eyewear: pinned.eyewear,
        accessory: pinned.accessory,
      });
    }
  });
});

describe("every body", () => {
  it("is mirrored left to right, in both drawings", () => {
    for (const [name, draw] of DRAWINGS) {
      for (const shape of MASCOT_SHAPES) {
        const body = bareBody(shape, draw);
        const filled = new Set(
          filledAt(body).map(([x, y]) => `${String(x)},${String(y)}`),
        );
        const unmatched = filledAt(body).filter(
          ([x, y]) =>
            !filled.has(`${String(body[0].length - 1 - x)},${String(y)}`),
        );
        expect(unmatched, `${name} ${shape}`).toEqual([]);
      }
    }
  });

  it("fills the lower eight rows of the grid and leaves the top two for what it carries", () => {
    for (const shape of MASCOT_SHAPES) {
      const body = bareBody(shape, mascotCells);
      const filled = filledAt(body);
      const rows = filled.map(([, y]) => y);
      expect(body, shape).toHaveLength(GRID);
      expect(Math.min(...rows), shape).toBe(2);
      expect(Math.max(...rows), shape).toBe(GRID - 1);
    }
  });

  it("fills the small grid's rows 1 to 6 and leaves row 0 for what it carries", () => {
    for (const shape of MASCOT_SHAPES) {
      const body = bareBody(shape, smallMascotCells);
      const rows = filledAt(body).map(([, y]) => y);
      expect(body, shape).toHaveLength(SMALL_GRID);
      expect(Math.min(...rows), shape).toBe(1);
      expect(Math.max(...rows), shape).toBe(SMALL_GRID - 1);
    }
  });

  it("has two eyes, two cells tall, in columns 2 and 7, each with body on both sides", () => {
    for (const shape of MASCOT_SHAPES) {
      const cells = bareBody(shape, mascotCells);
      const eyes = placesOf(cells, "eye");
      expect(eyes, shape).toHaveLength(4);
      const rows = [...new Set(eyes.map(([, y]) => y))];
      const columns = [...new Set(eyes.map(([x]) => x))];
      expect(rows, shape).toHaveLength(2);
      expect(columns, shape).toEqual([2, 7]);
      expect(rows[1] - rows[0], shape).toBe(1);
      for (const [x, y] of eyes) {
        for (const beside of [x - 1, x + 1]) {
          const tone = cells[y][beside];
          const where = `${shape} ${String(beside)},${String(y)}`;
          expect(tone, where).not.toBeNull();
          expect(tone, where).not.toBe("eye");
        }
      }
    }
  });

  it("has two eyes one cell tall on the small drawing's row 3, or 4 on the flame, at columns 2 and 4", () => {
    for (const shape of MASCOT_SHAPES) {
      const eyes = placesOf(bareBody(shape, smallMascotCells), "eye");
      const row = shape === "flame" ? 4 : 3;
      expect(eyes, shape).toEqual([
        [2, row],
        [4, row],
      ]);
    }
  });
});

describe("the face", () => {
  it("only recolours the body's cells, whatever the eyewear, expression and beat", () => {
    const poses = EXPRESSIONS.flatMap((expression) =>
      BEATS.map((beat): MascotPose => ({ expression, beat })),
    );
    for (const [name, draw] of DRAWINGS) {
      for (const shape of MASCOT_SHAPES) {
        const body = filledAt(bareBody(shape, draw));
        for (const eyewear of BOT_MASCOT_EYEWEAR) {
          for (const pose of poses) {
            expect(
              filledAt(draw(lookOf(shape, eyewear, "none"), pose)),
              `${name} ${shape} ${eyewear} ${pose.expression} ${String(pose.beat)}`,
            ).toEqual(body);
          }
        }
      }
    }
  });

  it("changes between the beats of working, and a blink is not the first beat", () => {
    for (const [name, draw] of DRAWINGS) {
      for (const shape of MASCOT_SHAPES) {
        for (const eyewear of BOT_MASCOT_EYEWEAR) {
          const look = lookOf(shape, eyewear, "none");
          const faces = BEATS.map((beat) =>
            JSON.stringify(draw(look, working(beat))),
          );
          const where = `${name} ${shape} ${eyewear}`;
          expect(faces[3], where).not.toBe(faces[0]);
        }
      }
    }
  });

  it("glances a cell aside on the second beat of working, on a body wide enough", () => {
    for (const [name, draw] of DRAWINGS) {
      const look = lookOf("blob", "none", "none");

      expect(placesOf(draw(look, working(1)), "eye"), name).not.toEqual(
        placesOf(draw(look, working(0)), "eye"),
      );
    }
  });

  it("starts its beats over after the last", () => {
    for (const [name, draw] of DRAWINGS) {
      const look = lookOf("blob", "glasses", "none");

      expect(draw(look, working(MASCOT_WORKING_BEATS + 1)), name).toEqual(
        draw(look, working(1)),
      );
    }
  });

  it("closes the eyes when away, which look ahead when idle", () => {
    for (const [name, draw] of DRAWINGS) {
      for (const shape of MASCOT_SHAPES) {
        for (const eyewear of BOT_MASCOT_EYEWEAR) {
          const look = lookOf(shape, eyewear, "none");
          expect(
            draw(look, { expression: "away", beat: 0 }),
            `${name} ${shape} ${eyewear}`,
          ).not.toEqual(draw(look, MASCOT_AT_REST));
        }
      }
    }
  });

  it("reads the beat only while working", () => {
    for (const [name, draw] of DRAWINGS) {
      const look = lookOf("blob", "visor", "none");

      for (const expression of ["idle", "away"] as const) {
        expect(
          draw(look, { expression, beat: 3 }),
          `${name} ${expression}`,
        ).toEqual(draw(look, { expression, beat: 0 }));
      }
    }
  });
});

describe("what a mascot carries", () => {
  const CARRIED = BOT_MASCOT_ACCESSORIES.filter(
    (accessory) => accessory !== "none",
  );

  it("only fills cells that are empty on the bare body", () => {
    for (const [name, draw] of DRAWINGS) {
      for (const shape of MASCOT_SHAPES) {
        const bare = bareBody(shape, draw);
        for (const accessory of CARRIED) {
          const carried = draw(
            lookOf(shape, "none", accessory),
            MASCOT_AT_REST,
          );
          const changed = carried.flatMap((row, y) =>
            row.flatMap((tone, x) =>
              tone === bare[y][x] ? [] : [[x, y] as const],
            ),
          );
          const where = `${name} ${shape} ${accessory}`;
          expect(changed.length, where).toBeGreaterThan(0);
          expect(
            changed.filter(([x, y]) => bare[y][x] !== null),
            where,
          ).toEqual([]);
        }
      }
    }
  });

  it("fills at least one cell of the small drawing's top row", () => {
    for (const shape of MASCOT_SHAPES) {
      for (const accessory of CARRIED) {
        const [top] = smallMascotCells(
          lookOf(shape, "none", accessory),
          MASCOT_AT_REST,
        );
        expect(
          top.filter((tone) => tone !== null).length,
          `${shape} ${accessory}`,
        ).toBeGreaterThan(0);
      }
    }
  });
});

describe("a bot's mascot from its look", () => {
  const botId = STYLISH_BOT_ID;

  it("is the id's own body, colour, eyewear and accessory when nothing was chosen", () => {
    for (const pinned of PINNED) {
      expect(botMascot(pinned.botId, null, false), pinned.botId).toEqual({
        shape: pinned.shape,
        ramp: mascotRampAt(derivedBotColorIndex(pinned.botId)),
        eyewear: pinned.eyewear,
        accessory: pinned.accessory,
      });
      expect(botMascot(pinned.botId, NO_CHOICE, false), pinned.botId).toEqual(
        botMascot(pinned.botId, null, false),
      );
    }
  });

  it("takes the id's own eyewear and accessory from a null choice, as from an absent one", () => {
    expect(
      botMascot(botId, { ...NO_CHOICE, eyewear: null, accessory: null }, false),
    ).toEqual(botMascot(botId, NO_CHOICE, false));
  });

  it("honours a chosen body, colour, eyewear and accessory, none included", () => {
    const chosen = botMascot(
      botId,
      {
        mark: { kind: "mascot", shape: "ghost" },
        color: 5,
        eyewear: "none",
        accessory: "halo",
      },
      false,
    );

    expect(chosen).toEqual({
      shape: "ghost",
      ramp: mascotRampAt(5),
      eyewear: "none",
      accessory: "halo",
    });
    expect(chosen).not.toEqual(botMascot(botId, null, false));
  });

  it("draws the bot's own body for a stored shape this client has no art for", () => {
    for (const shape of ["block", "shield", "diamond", "doc"] as const) {
      expect(
        botMascot(
          botId,
          { ...NO_CHOICE, mark: { kind: "mascot", shape } },
          false,
        ).shape,
        shape,
      ).toBe(ownMascotShape(botId));
    }
  });

  it("draws the default mascot for a mark it cannot read", () => {
    expect(
      botMascot(botId, { ...NO_CHOICE, mark: BOT_UNRECOGNISED_MARK }, false)
        .shape,
    ).toBe(DEFAULT_MASCOT_SHAPE);
  });

  it("draws the default colours for a colour it cannot read", () => {
    expect(
      botMascot(
        botId,
        { ...NO_CHOICE, color: BOT_APPEARANCE_UNRECOGNISED },
        false,
      ).ramp,
    ).toBe(DEFAULT_MASCOT_RAMP);
  });

  it("draws nothing worn for an eyewear or an accessory it cannot read", () => {
    const unreadable = botMascot(
      botId,
      {
        ...NO_CHOICE,
        eyewear: BOT_APPEARANCE_UNRECOGNISED,
        accessory: BOT_APPEARANCE_UNRECOGNISED,
      },
      false,
    );

    expect(unreadable.eyewear).toBe("none");
    expect(unreadable.accessory).toBe("none");
  });
});

describe("an environment's main bot's mascot", () => {
  const botId = STYLISH_BOT_ID;

  it("is the plain default mascot in the id's own colours when nothing was chosen", () => {
    expect(ownMascotShape(botId)).not.toBe(DEFAULT_MASCOT_SHAPE);

    expect(botMascot(botId, null, true)).toEqual({
      shape: DEFAULT_MASCOT_SHAPE,
      ramp: botMascot(botId, null, false).ramp,
      eyewear: "none",
      accessory: "none",
    });
  });

  it("still wears a chosen eyewear, accessory or shape", () => {
    expect(botMascot(botId, { ...NO_CHOICE, eyewear: "visor" }, true)).toEqual({
      ...botMascot(botId, null, true),
      eyewear: "visor",
    });
    expect(botMascot(botId, { ...NO_CHOICE, accessory: "halo" }, true)).toEqual(
      { ...botMascot(botId, null, true), accessory: "halo" },
    );
    expect(
      botMascot(
        botId,
        { ...NO_CHOICE, mark: { kind: "mascot", shape: "cat" } },
        true,
      ),
    ).toEqual({ ...botMascot(botId, null, true), shape: "cat" });
  });

  it("draws the default mascot for a stored shape this client has no art for, where another bot draws its own", () => {
    const retired: BotAppearance = {
      ...NO_CHOICE,
      mark: { kind: "mascot", shape: "doc" },
    };

    expect(botMascot(botId, retired, true).shape).toBe(DEFAULT_MASCOT_SHAPE);
    expect(botMascot(botId, retired, false).shape).toBe(ownMascotShape(botId));
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

/** Every square the drawing paints. */
function squaresOf(drawing: MascotMarkDrawing): Square[] {
  return drawing.layers.flatMap((layer) => {
    const parsed = parseSquares(layer.path);
    expect(parsed, layer.fill).not.toBeNull();
    return parsed ?? [];
  });
}

describe("drawing a mascot", () => {
  /** Each size, its cell's side and where the drawing starts in the box. */
  const SIZES: ReadonlyArray<readonly [MascotMarkSize, number, number]> = [
    [16, 2, 1],
    [24, 2, 2],
    [32, 3, 1],
    [40, 4, 0],
  ];

  it("draws whole-pixel squares inside the box, one per filled cell, one path per colour", () => {
    for (const shape of MASCOT_SHAPES) {
      const look = lookOf(shape, "glasses", "bow");
      const pose = working(1);
      for (const [size, cell, offset] of SIZES) {
        const cells =
          size === 16 ? smallMascotCells(look, pose) : mascotCells(look, pose);
        const drawing = drawMascotMark(look, size, pose);
        const where = `${shape} at ${String(size)}`;
        const squares = squaresOf(drawing);
        for (const square of squares) {
          expect(square.side, where).toBe(cell);
          expect(square.x, where).toBeGreaterThanOrEqual(offset);
          expect(square.y, where).toBeGreaterThanOrEqual(offset);
          expect(square.x + square.side, where).toBeLessThanOrEqual(size);
          expect(square.y + square.side, where).toBeLessThanOrEqual(size);
        }
        // No two squares share a place, so the even-odd fill never cancels.
        expect(
          new Set(
            squares.map((square) => `${String(square.x)},${String(square.y)}`),
          ).size,
          where,
        ).toBe(squares.length);
        const area = squares.reduce((sum, square) => sum + square.side ** 2, 0);
        expect(area, where).toBe(filledAt(cells).length * cell * cell);
        const fills = drawing.layers.map((layer) => layer.fill);
        expect(new Set(fills).size, where).toBe(fills.length);
      }
    }
  });

  it("draws 16 px from seven cells across and 24 px from ten", () => {
    const look = lookOf("blob", "none", "none");
    const cellsAcross = (size: MascotMarkSize): number => {
      const squares = squaresOf(drawMascotMark(look, size, MASCOT_AT_REST));
      const left = Math.min(...squares.map((square) => square.x));
      const right = Math.max(
        ...squares.map((square) => square.x + square.side),
      );
      return (right - left) / squares[0].side;
    };

    expect(cellsAcross(16)).toBe(SMALL_GRID);
    expect(cellsAcross(24)).toBe(GRID);
  });
});

/** The fill of the square the 24 px drawing paints for cell `[x, y]`, from offset 2. */
function fillAt(
  drawing: MascotMarkDrawing,
  [x, y]: readonly [number, number],
): string {
  const square = `M${String(2 + x * 2)} ${String(2 + y * 2)}h2v2h-2z`;
  const layer = drawing.layers.find((candidate) =>
    candidate.path.includes(square),
  );
  if (layer === undefined) throw new Error(`no square at ${square}`);
  return layer.fill;
}

/** The fill of the first cell of `tone` in the look's 24 px drawing. */
function toneFill(look: MascotLook, tone: MascotTone): string {
  const [place] = placesOf(mascotCells(look, MASCOT_AT_REST), tone);
  return fillAt(drawMascotMark(look, 24, MASCOT_AT_REST), place);
}

function lightnessOf(fill: string): number {
  const match = /(\d+)%\)$/.exec(fill);
  if (match === null) throw new Error(`no lightness in ${fill}`);
  return Number(match[1]);
}

describe("the colours of what a mascot wears", () => {
  const FAR_RAMPS = [DEFAULT_MASCOT_RAMP, mascotRampAt(0)] as const;
  const AMBER = mascotRampAt(2);
  const HALO_HUE = 48;

  function hueGap(hue: number): number {
    return Math.abs(((((hue - HALO_HUE) % 360) + 540) % 360) - 180);
  }

  it("draws a bow, a sparkle and horns in their own colours", () => {
    const own = (accessory: BotMascotAccessory): string =>
      toneFill(lookOf("blob", "none", accessory), "accessory");

    expect(own("bow")).toBe("hsl(334 80% 62%)");
    expect(own("sparkle")).toBe("hsl(46 96% 56%)");
    expect(own("horns")).toBe("hsl(32 38% 60%)");
  });

  it("draws every cell of a sparkle in its colour, with no white at its centre", () => {
    const cells = mascotCells(
      lookOf("blob", "none", "sparkle"),
      MASCOT_AT_REST,
    );
    const bare = bareBody("blob", mascotCells);
    const sparkle = cells.flatMap((row, y) =>
      row.flatMap((tone, x) => (tone === bare[y][x] ? [] : [tone])),
    );

    expect(sparkle).toHaveLength(5);
    expect(new Set(sparkle)).toEqual(new Set(["accessory"]));
  });

  it("draws antennae in the body's own darker and lighter steps", () => {
    const cells = mascotCells(
      lookOf("blob", "none", "antennae"),
      MASCOT_AT_REST,
    );
    const bare = bareBody("blob", mascotCells);
    const added = cells.flatMap((row, y) =>
      row.flatMap((tone, x) => (tone === bare[y][x] ? [] : [tone])),
    );

    expect(added.toSorted()).toEqual([1, 1, 3, 3]);
  });

  it("draws shades' lenses the same on two different bot colours", () => {
    const lenses = FAR_RAMPS.map((ramp) =>
      toneFill({ ...lookOf("blob", "shades", "none"), ramp }, "lens"),
    );

    expect(lenses[0]).toBe(lenses[1]);
    expect(FAR_RAMPS[0].tones[2]).not.toBe(FAR_RAMPS[1].tones[2]);
  });

  it("draws a halo the same on two bodies far from its hue", () => {
    for (const ramp of FAR_RAMPS) {
      expect(hueGap(ramp.hue)).toBeGreaterThanOrEqual(28);
    }
    const [first, second] = FAR_RAMPS.map((ramp) =>
      toneFill({ ...lookOf("blob", "none", "halo"), ramp }, "accessory"),
    );

    expect(first).toBe(second);
  });

  it("draws a halo lighter on a body of nearly its hue", () => {
    expect(hueGap(AMBER.hue)).toBeLessThan(28);
    const far = toneFill(lookOf("blob", "none", "halo"), "accessory");
    const near = toneFill(
      { ...lookOf("blob", "none", "halo"), ramp: AMBER },
      "accessory",
    );

    expect(lightnessOf(near)).toBeGreaterThan(lightnessOf(far));
  });
});

describe("glasses, drawn as wide eyes", () => {
  const SIZES: ReadonlyArray<readonly [MascotMarkSize, number, number]> = [
    [16, 2, 1],
    [24, 2, 2],
    [32, 3, 1],
    [40, 4, 0],
  ];
  const SHUT: MascotPose = { expression: "away", beat: 0 };
  const BLINK = working(3);
  const GLANCE = working(1);
  const OPEN: readonly MascotPose[] = [
    MASCOT_AT_REST,
    working(0),
    GLANCE,
    working(2),
  ];

  function drawn(
    shape: MascotShape,
    eyewear: BotMascotEyewear,
    size: MascotMarkSize,
    pose: MascotPose,
  ): MascotMarkDrawing {
    return drawMascotMark(lookOf(shape, eyewear, "none"), size, pose);
  }

  /** Each square's fill, by the pixel it starts at as "x,y". */
  function fillsByOrigin(drawing: MascotMarkDrawing): Map<string, string> {
    return new Map(
      drawing.layers.flatMap((layer) =>
        (parseSquares(layer.path) ?? []).map((square): [string, string] => [
          `${String(square.x)},${String(square.y)}`,
          layer.fill,
        ]),
      ),
    );
  }

  /**
   * The pixel origins of the cells between the two eyes, on the rows the
   * eyes are on, found from a bare body's eyes.
   */
  function betweenTheEyes(
    shape: MascotShape,
    size: MascotMarkSize,
    cell: number,
    offset: number,
  ): string[] {
    const bare = (size === 16 ? smallMascotCells : mascotCells)(
      lookOf(shape, "none", "none"),
      MASCOT_AT_REST,
    );
    const eyes = placesOf(bare, "eye");
    const columns = eyes.map(([x]) => x);
    const gap = size === 16 ? 1 : 2;
    const origins: string[] = [];
    for (const row of new Set(eyes.map(([, y]) => y))) {
      for (
        let x = Math.min(...columns) + gap;
        x <= Math.max(...columns) - gap;
        x += 1
      ) {
        origins.push(
          `${String(offset + x * cell)},${String(offset + row * cell)}`,
        );
      }
    }
    return origins;
  }

  const CASES = MASCOT_SHAPES.flatMap((shape) =>
    SIZES.map((entry) => [shape, ...entry] as const),
  );

  it.each(CASES)(
    "closes a wide eye to a dash as wide as the eye, with no white, whether shut or blinking, as a %s does at %i px",
    (shape, size) => {
      const shut = drawn(shape, "none", size, SHUT);
      if (size === 16) {
        expect(drawn(shape, "glasses", size, SHUT)).toEqual(shut);
        expect(drawn(shape, "glasses", size, BLINK)).toEqual(
          drawn(shape, "none", size, BLINK),
        );
      } else {
        expect(drawn(shape, "glasses", size, SHUT)).toEqual(shut);
        expect(drawn(shape, "glasses", size, BLINK)).toEqual(shut);
      }
    },
  );

  it.each(CASES)(
    "draws white around the open eyes, in no colour but the body's, the eye's and white, as a %s does at %i px",
    (shape, size) => {
      const { ramp } = lookOf(shape, "glasses", "none");
      const allowed = new Set([...ramp.tones, ramp.eye, ramp.white]);
      for (const pose of OPEN) {
        const fills = drawn(shape, "glasses", size, pose).layers.map(
          (layer) => layer.fill,
        );

        expect(fills).toContain(ramp.white);
        expect(fills.filter((fill) => !allowed.has(fill))).toEqual([]);
      }
    },
  );

  it.each(CASES)(
    "leaves what lies between the open eyes as the bare body has it, as a %s does at %i px",
    (shape, size, cell, offset) => {
      const between = betweenTheEyes(shape, size, cell, offset);
      expect(between.length).toBeGreaterThan(0);
      const poses = size === 16 ? OPEN.filter((pose) => pose !== GLANCE) : OPEN;
      for (const pose of poses) {
        const wide = fillsByOrigin(drawn(shape, "glasses", size, pose));
        const bare = fillsByOrigin(drawn(shape, "none", size, pose));

        expect(between.map((origin) => wide.get(origin))).toEqual(
          between.map((origin) => bare.get(origin)),
        );
      }
    },
  );

  /** The pixel origins of the squares drawn in `fill`, as numbers. */
  function originsOf(
    drawing: MascotMarkDrawing,
    fill: string,
  ): Array<readonly [number, number]> {
    return [...fillsByOrigin(drawing)].flatMap(([origin, drawnFill]) => {
      const [x, y] = origin.split(",").map(Number);
      return drawnFill === fill ? [[x, y] as const] : [];
    });
  }

  const SMALL_CASES = MASCOT_SHAPES.map((shape) => [shape] as const);

  it.each(SMALL_CASES)(
    "gives each open eye of a %s at 16 px one white beside its pupil, a different white for each, and no other white",
    (shape) => {
      const { ramp } = lookOf(shape, "glasses", "none");
      for (const pose of OPEN) {
        const drawing = drawn(shape, "glasses", 16, pose);
        const whites = originsOf(drawing, ramp.white);
        const pupils = originsOf(drawing, ramp.eye);
        const beside = pupils.map(([px, py]) =>
          whites.filter(([wx, wy]) => wy === py && Math.abs(wx - px) === 2),
        );

        expect(whites).toHaveLength(2);
        expect(pupils).toHaveLength(2);
        expect(beside.every((own) => own.length > 0)).toBe(true);
        expect(new Set(beside.flat().map(([x]) => x)).size).toBe(2);
      }
    },
  );

  it.each(CASES.filter(([, size]) => size !== 16))(
    "gives each open eye of a %s at %i px a white cell touching its pupil",
    (shape, size, cell) => {
      const { ramp } = lookOf(shape, "glasses", "none");
      for (const pose of OPEN) {
        const drawing = drawn(shape, "glasses", size, pose);
        const whites = originsOf(drawing, ramp.white);
        const pupils = originsOf(drawing, ramp.eye);

        expect(pupils).toHaveLength(2);
        for (const [px, py] of pupils) {
          expect(
            whites.some(
              ([wx, wy]) => Math.abs(wx - px) + Math.abs(wy - py) === cell,
            ),
          ).toBe(true);
        }
      }
    },
  );

  it.each(SMALL_CASES)(
    "joins a %s's two eyes at 16 px on the glance as white then pupil across columns 2 to 5, with the body as bare outside them",
    (shape) => {
      const { ramp } = lookOf(shape, "glasses", "none");
      const wide = drawn(shape, "glasses", 16, GLANCE);
      const bare = fillsByOrigin(drawn(shape, "none", 16, GLANCE));
      const row = [...fillsByOrigin(wide)]
        .filter(([, fill]) => fill === ramp.white || fill === ramp.eye)
        .map(([origin]) => origin.split(",").map(Number));
      const rowY = new Set(row.map(([, y]) => y));

      expect([...rowY]).toHaveLength(1);
      const column = (x: number): number => 1 + x * 2;
      expect(row.map(([x]) => x).toSorted((a, b) => a - b)).toEqual(
        [2, 3, 4, 5].map(column),
      );
      const outside = [...rowY].flatMap((y) =>
        [0, 1, 6].map((x) => `${String(column(x))},${String(y)}`),
      );
      const wideFills = fillsByOrigin(wide);
      expect(outside.map((origin) => wideFills.get(origin))).toEqual(
        outside.map((origin) => bare.get(origin)),
      );
    },
  );

  it.each([
    ["shades", 16, BLOB_SHADES16],
    ["shades", 32, BLOB_SHADES32],
    ["visor", 16, BLOB_VISOR16],
    ["visor", 32, BLOB_VISOR32],
  ] as const)(
    "draws a blob's %s at %i px as it always has, looking ahead",
    (eyewear, size, pinned) => {
      expect(drawn("blob", eyewear, size, MASCOT_AT_REST).layers).toEqual(
        pinned,
      );
    },
  );
});
