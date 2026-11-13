import {
  BOT_APPEARANCE_UNRECOGNISED,
  BOT_COLOR_COUNT,
  BOT_MASCOT_ACCESSORIES,
  BOT_MASCOT_EYEWEAR,
  type BotAppearance,
  type BotMascotAccessory,
  type BotMascotEyewear,
  type BotMascotShape,
} from "@traycer/protocol/host/bot/schemas";
import {
  botColorAt,
  derivedBotColorIndex,
} from "../providers/profile-accent-color";

/**
 * A bot's mascot: a pixel figure drawn straight on the page, with nothing
 * behind it. What it is (its
 * body, its colour, what it wears over its eyes and on its head) is each a
 * pure function of the bot's id unless a person chose one in the bot's
 * settings, so a rename changes none of it. What its eyes are doing follows
 * the bot ({@link MascotExpression}) and is no part of who it is.
 *
 * A choice this client cannot read (a newer writer's, read as
 * {@link BOT_APPEARANCE_UNRECOGNISED}) falls back per part to the default
 * mascot's: {@link DEFAULT_MASCOT_SHAPE}, {@link DEFAULT_MASCOT_RAMP}, and
 * nothing worn. A shape this client has no art for is no choice of shape.
 *
 * The tests pin fixed ids to their looks so a bot keeps its mascot.
 */

const GRID = 10;

/** The bodies this client draws, and a bot's settings offer. */
export const MASCOT_SHAPES = [
  "blob",
  "flame",
  "ghost",
  "capsule",
  "cat",
  "sun",
] as const satisfies readonly BotMascotShape[];
export type MascotShape = (typeof MASCOT_SHAPES)[number];

/** A shape written as its left half, mirrored. */
function mirrored(rows: readonly string[]): readonly string[] {
  return rows.map((row) => row + [...row].reverse().join(""));
}

/**
 * Each body's cells, `#` filled, row 0 on top. A body fills the grid's width
 * and its lower eight rows, which leaves the two above for what it carries.
 */
const SHAPE_CELLS: Readonly<Record<MascotShape, readonly string[]>> = {
  blob: mirrored([
    ".....",
    ".....",
    "...##",
    ".####",
    "#####",
    "#####",
    "#####",
    "#####",
    "#####",
    ".####",
  ]),
  flame: mirrored([
    ".....",
    ".....",
    "....#",
    "...##",
    "..###",
    ".####",
    "#####",
    "#####",
    "#####",
    ".####",
  ]),
  ghost: mirrored([
    ".....",
    ".....",
    "..###",
    ".####",
    "#####",
    "#####",
    "#####",
    "#####",
    "#####",
    "##.##",
  ]),
  capsule: mirrored([
    ".....",
    ".....",
    "..###",
    ".####",
    ".####",
    ".####",
    ".####",
    ".####",
    ".####",
    "..###",
  ]),
  cat: mirrored([
    ".....",
    ".....",
    "#....",
    "##...",
    "#####",
    "#####",
    "#####",
    "#####",
    "#####",
    ".####",
  ]),
  sun: mirrored([
    ".....",
    ".....",
    "..###",
    ".####",
    "#####",
    "#####",
    "#####",
    "#####",
    ".####",
    "..###",
  ]),
};

/**
 * What a cell is drawn in: a step of the body's ramp, darkest first, or a
 * named part. `accessory` is the colour of what the mascot carries
 * ({@link ACCESSORY_COLOURS}).
 */
export type MascotTone =
  | 0
  | 1
  | 2
  | 3
  | 4
  | "eye"
  | "white"
  | "lens"
  | "bridge"
  | "leaf"
  | "stem"
  | "accessory";

/** A mascot's cells by tone, `null` where the page shows. */
export type MascotCells = ReadonlyArray<ReadonlyArray<MascotTone | null>>;

const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

type Cells = readonly string[];

function isFilled(cells: Cells, x: number, y: number): boolean {
  return y >= 0 && y < GRID && x >= 0 && x < GRID && cells[y][x] === "#";
}

/** Each filled cell's distance in from the outside, the outline at 1. */
function depthsOf(cells: Cells): number[][] {
  const depth: number[][] = Array.from({ length: GRID }, () =>
    Array<number>(GRID).fill(0),
  );
  const queue: Array<readonly [number, number]> = [];
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const edge = NEIGHBOURS.some(
        ([dx, dy]) => !isFilled(cells, x + dx, y + dy),
      );
      if (isFilled(cells, x, y) && edge) {
        depth[y][x] = 1;
        queue.push([x, y]);
      }
    }
  }
  for (let at = 0; at < queue.length; at++) {
    const [x, y] = queue[at];
    for (const [dx, dy] of NEIGHBOURS) {
      if (isFilled(cells, x + dx, y + dy) && depth[y + dy][x + dx] === 0) {
        depth[y + dy][x + dx] = depth[y][x] + 1;
        queue.push([x + dx, y + dy]);
      }
    }
  }
  return depth;
}

/**
 * A cell's step of the ramp: the outline darkest except where it faces up,
 * the cell inside it the base, deeper cells the light step, and the bottom
 * of the figure a step darker.
 */
function bodyTone(
  depth: number,
  facesUp: boolean,
  low: boolean,
): 0 | 1 | 2 | 3 {
  if (depth === 1) return facesUp ? 1 : 0;
  if (depth === 2) return low ? 1 : 2;
  return low ? 2 : 3;
}

/** The eyes' columns: each is one cell wide and two tall. */
const EYE_LEFT = 2;
const EYE_RIGHT = 7;

/** Where a body's eyes sit: their top row, and the outer column of each. */
interface MascotEyes {
  readonly y: number;
  readonly left: number;
  readonly right: number;
  /** How far bare eyes move in a glance: a cell, or none on a narrow body. */
  readonly glance: 0 | 1;
}

/**
 * Where the eyes go: the first row a little above the middle where both
 * eyes' two cells sit at depth 2 or more. A glance moves them a cell to the
 * right where that keeps them off the outline.
 */
function eyesOf(
  cells: Cells,
  depth: readonly number[][],
  top: number,
  bottom: number,
): MascotEyes {
  const middleRow = Math.round(top + (bottom - top) * 0.42);
  for (const dy of [0, 1, -1, 2]) {
    const y = middleRow + dy;
    const inside = (x: number): boolean =>
      [y, y + 1].every((row) => isFilled(cells, x, row) && depth[row][x] >= 2);
    if (inside(EYE_LEFT) && inside(EYE_RIGHT)) {
      return {
        y,
        left: EYE_LEFT,
        right: EYE_RIGHT,
        glance: inside(EYE_RIGHT + 1) ? 1 : 0,
      };
    }
  }
  throw new Error("a mascot body with no room for its eyes");
}

/** A body before anything is drawn on it. */
interface MascotBody {
  readonly cells: Cells;
  /** The body lit from above, with its highlight and without its eyes. */
  readonly tones: ReadonlyArray<ReadonlyArray<0 | 1 | 2 | 3 | 4 | null>>;
  readonly eyes: MascotEyes;
}

/**
 * A shape lit from above ({@link bodyTone}), with a highlight up and left of
 * the centre, and where its eyes go ({@link eyesOf}).
 */
function bodyOf(shape: MascotShape): MascotBody {
  const cells = SHAPE_CELLS[shape];
  const depth = depthsOf(cells);
  const filledRows = cells.flatMap((row, y) => (row.includes("#") ? [y] : []));
  const top = filledRows[0];
  const bottom = filledRows[filledRows.length - 1];
  const tones: Array<Array<0 | 1 | 2 | 3 | 4 | null>> = cells.map((row, y) =>
    [...row].map((_, x) =>
      isFilled(cells, x, y)
        ? bodyTone(
            depth[y][x],
            !isFilled(cells, x, y - 1),
            (y - top) / (bottom - top) > 0.82,
          )
        : null,
    ),
  );
  const eyes = eyesOf(cells, depth, top, bottom);
  const centre = GRID / 2 - 1;
  const shine = Math.max(top + 1, eyes.y - 2);
  const highlight: ReadonlyArray<readonly [number, number, 3 | 4]> = [
    [centre, shine, 4],
    [centre - 1, shine, 4],
    [centre, shine - 1, 3],
    [centre - 1, shine + 1, 3],
  ];
  for (const [x, y, tone] of highlight) {
    if (isFilled(cells, x, y) && depth[y][x] >= 2) tones[y][x] = tone;
  }
  return { cells, tones, eyes };
}

const BODIES = new Map<MascotShape, MascotBody>();

/** A shape's body, worked out once. */
function mascotBody(shape: MascotShape): MascotBody {
  let body = BODIES.get(shape);
  if (body === undefined) {
    body = bodyOf(shape);
    BODIES.set(shape, body);
  }
  return body;
}

/**
 * What a mascot's eyes are doing, which follows the bot and is no part of
 * its look: `idle` looks ahead, `working` looks around and blinks, and
 * `away` has them closed.
 */
export type MascotExpression = "idle" | "working" | "away";

/** How many beats `working` cycles through: ahead, a glance, ahead, a blink. */
export const MASCOT_WORKING_BEATS = 4;

/** A mascot's eyes at one moment: its expression, and the beat of `working`. */
export interface MascotPose {
  readonly expression: MascotExpression;
  readonly beat: number;
}

/** A mascot looking ahead: how a picture that follows no bot is drawn. */
export const MASCOT_AT_REST: MascotPose = { expression: "idle", beat: 0 };

type Stamp = readonly [number, number, MascotTone];

/**
 * The face's cells over the body. The lens cells are the eye's own and the
 * cell inside each, so eyewear never widens the face; behind a dark lens the
 * eyes are hidden and its glint carries the pose instead.
 */
function faceOf(
  eyes: MascotEyes,
  eyewear: BotMascotEyewear,
  pose: MascotPose,
): readonly Stamp[] {
  const { y, left, right } = eyes;
  const beat =
    pose.expression === "working" ? pose.beat % MASCOT_WORKING_BEATS : 0;
  const glance = beat === 1;
  const blink = beat === 3;
  const shut = pose.expression === "away";
  const lensColumns = [left, left + 1, right - 1, right];
  const closed: readonly Stamp[] = lensColumns.map((x) => [x, y + 1, "eye"]);
  const lenses = (tone: MascotTone): Stamp[] => [
    ...[y, y + 1].flatMap((row) =>
      lensColumns.map((x): Stamp => [x, row, tone]),
    ),
  ];
  const bridge = (tone: MascotTone): Stamp[] =>
    Array.from({ length: right - left - 3 }, (_, at): Stamp => [
      left + 2 + at,
      y,
      tone,
    ]);
  if (eyewear === "glasses") {
    const pupils: readonly Stamp[] = glance
      ? [
          [left + 1, y, "eye"],
          [right, y, "eye"],
        ]
      : [
          [left + 1, y + 1, "eye"],
          [right - 1, y + 1, "eye"],
        ];
    const frame = [...lenses("white"), ...bridge("bridge")];
    if (shut) return [...frame, ...closed];
    return blink ? frame : [...frame, ...pupils];
  }
  if (eyewear === "shades") {
    const shift = glance || blink ? 1 : 0;
    const row = blink ? y + 1 : y;
    const glints: readonly Stamp[] = [
      [left + shift, row, "white"],
      [right - 1 + shift, row, "white"],
    ];
    return [...lenses("lens"), ...bridge("lens"), ...(shut ? [] : glints)];
  }
  if (eyewear === "visor") {
    const band = Array.from({ length: right - left + 1 }, (_, at): Stamp => [
      left + at,
      y,
      "lens",
    ]);
    return shut ? band : [...band, [left + 1 + beat, y, "white"]];
  }
  if (shut) return closed;
  if (blink) {
    return [
      [left, y + 1, "eye"],
      [right, y + 1, "eye"],
    ];
  }
  const shift = glance ? eyes.glance : 0;
  return [y, y + 1].flatMap((row): Stamp[] => [
    [left + shift, row, "eye"],
    [right + shift, row, "eye"],
  ]);
}

/**
 * What a mascot carries, as cells above its body: `top` is the first filled
 * row of a column.
 */
function accessoryOf(
  accessory: BotMascotAccessory,
  top: (x: number) => number,
): readonly Stamp[] {
  switch (accessory) {
    case "none":
      return [];
    case "antenna":
      return [
        [4, top(4) - 1, 0],
        [4, top(4) - 2, "accessory"],
      ];
    case "antennae":
      return [2, 7].flatMap((x): Stamp[] => [
        [x, top(x) - 1, 1],
        [x, top(x) - 2, 3],
      ]);
    case "sprout":
      return [
        [4, top(4) - 1, "stem"],
        [5, top(4) - 2, "leaf"],
        [3, top(4) - 2, "leaf"],
      ];
    case "bow": {
      const y = top(6) - 1;
      return [
        [5, y, "accessory"],
        [7, y, "accessory"],
        [6, y, 0],
        [5, y - 1, "accessory"],
        [7, y - 1, "accessory"],
      ];
    }
    case "sparkle":
      return [
        [7, 0, "accessory"],
        [6, 1, "accessory"],
        [7, 1, "accessory"],
        [8, 1, "accessory"],
        [7, 2, "accessory"],
      ];
    case "flag": {
      const y = top(5) - 1;
      return [
        [5, y, 0],
        [5, y - 1, 0],
        [6, y - 1, "accessory"],
        [7, y - 1, "accessory"],
      ];
    }
    case "horns":
      return [1, 8].flatMap((x): Stamp[] => [
        [x, top(x) - 1, "accessory"],
        [x, top(x) - 2, "accessory"],
      ]);
    case "halo": {
      const y = Math.max(top(4) - 2, 0);
      return [3, 4, 5, 6].map((x): Stamp => [x, y, "accessory"]);
    }
  }
}

/** What a mascot is drawn as: a body in a ramp, and what it wears. */
export interface MascotLook {
  readonly shape: MascotShape;
  readonly ramp: MascotRamp;
  readonly eyewear: BotMascotEyewear;
  readonly accessory: BotMascotAccessory;
}

/**
 * A mascot's cells in one pose: its body, its face over it, and what it
 * carries in the empty cells above.
 */
export function mascotCells(look: MascotLook, pose: MascotPose): MascotCells {
  const body = mascotBody(look.shape);
  const cells: Array<Array<MascotTone | null>> = body.tones.map((row) => [
    ...row,
  ]);
  for (const [x, y, tone] of faceOf(body.eyes, look.eyewear, pose)) {
    cells[y][x] = tone;
  }
  const top = (x: number): number => {
    const first = body.cells.findIndex((row) => row[x] === "#");
    return first === -1 ? GRID : first;
  };
  for (const [x, y, tone] of accessoryOf(look.accessory, top)) {
    const free = x >= 0 && x < GRID && y >= 0 && y < GRID;
    if (free && !isFilled(body.cells, x, y)) cells[y][x] = tone;
  }
  return cells;
}

const SMALL_GRID = 7;

/**
 * Each body at the smallest size, where a cell of the full drawing would be
 * one pixel: seven cells wide, on rows 1 to 6, with row 0 for what it
 * carries.
 */
const SMALL_SHAPE_CELLS: Readonly<Record<MascotShape, readonly string[]>> = {
  blob: [".#####.", "#######", "#######", "#######", "#######", ".#####."],
  flame: ["...#...", "..###..", ".#####.", "#######", "#######", ".#####."],
  ghost: [".#####.", "#######", "#######", "#######", "#######", "#.#.#.#"],
  capsule: ["..###..", ".#####.", ".#####.", ".#####.", ".#####.", "..###.."],
  cat: ["#.....#", "#######", "#######", "#######", "#######", ".#####."],
  sun: ["..###..", ".#####.", "#######", "#######", ".#####.", "..###.."],
};

/** The row the small drawing's eyes sit on; the flame's are below its tip. */
function smallEyeRow(shape: MascotShape): number {
  return shape === "flame" ? 4 : 3;
}

/** The small drawing's eyes, as columns of its eye row. */
function smallEyesOf(
  shut: boolean,
  blink: boolean,
  glance: boolean,
): ReadonlyArray<readonly [number, MascotTone]> {
  if (shut) {
    return [
      [2, 1],
      [4, 1],
    ];
  }
  if (blink) return [];
  const shift = glance ? 1 : 0;
  return [
    [2 + shift, "eye"],
    [4 + shift, "eye"],
  ];
}

/** The small face: one row, the eyes a cell each either side of the middle. */
function smallFaceOf(
  eyewear: BotMascotEyewear,
  pose: MascotPose,
): ReadonlyArray<readonly [number, MascotTone]> {
  const beat =
    pose.expression === "working" ? pose.beat % MASCOT_WORKING_BEATS : 0;
  const shut = pose.expression === "away";
  const blink = beat === 3;
  const band = (tone: MascotTone): Array<readonly [number, MascotTone]> =>
    [1, 2, 3, 4, 5].map((x) => [x, tone]);
  if (eyewear === "shades") {
    return shut ? band("lens") : [...band("lens"), [1 + beat, "white"]];
  }
  if (eyewear === "visor") {
    return shut ? band("lens") : [...band("lens"), [2 + beat, "white"]];
  }
  const eyes = smallEyesOf(shut, blink, beat === 1);
  if (eyewear === "none") return eyes;
  return [[1, "white"], [5, "white"], [3, "bridge"], ...eyes];
}

/** What the small drawing carries, on its top row. */
const SMALL_ACCESSORY_CELLS: Readonly<
  Record<BotMascotAccessory, ReadonlyArray<readonly [number, MascotTone]>>
> = {
  none: [],
  antenna: [[3, "accessory"]],
  antennae: [
    [1, 3],
    [5, 3],
  ],
  sprout: [
    [2, "leaf"],
    [3, "stem"],
    [4, "leaf"],
  ],
  bow: [
    [4, "accessory"],
    [5, "accessory"],
  ],
  sparkle: [[5, "accessory"]],
  flag: [
    [3, 0],
    [4, "accessory"],
  ],
  horns: [
    [0, "accessory"],
    [6, "accessory"],
  ],
  halo: [
    [2, "accessory"],
    [3, "accessory"],
    [4, "accessory"],
  ],
};

/**
 * The mascot at the smallest size in one pose: the same body, face and
 * accessory, each drawn in as few cells as still read at two pixels a cell.
 */
export function smallMascotCells(
  look: MascotLook,
  pose: MascotPose,
): MascotCells {
  const rows = SMALL_SHAPE_CELLS[look.shape];
  const filled = (x: number, y: number): boolean =>
    y >= 1 && y <= rows.length && rows[y - 1][x] === "#";
  const cells: Array<Array<MascotTone | null>> = Array.from(
    { length: SMALL_GRID },
    (_, y) =>
      Array.from({ length: SMALL_GRID }, (__, x): MascotTone | null => {
        if (!filled(x, y)) return null;
        if (y === rows.length) return 0;
        if (!filled(x, y - 1)) return 3;
        return filled(x - 1, y) && filled(x + 1, y) ? 2 : 1;
      }),
  );
  const eyeRow = smallEyeRow(look.shape);
  for (const [x, tone] of smallFaceOf(look.eyewear, pose)) {
    cells[eyeRow][x] = tone;
  }
  for (const [x, tone] of SMALL_ACCESSORY_CELLS[look.accessory]) {
    cells[0][x] = tone;
  }
  return cells;
}

/** The colours a mascot's body is drawn in. */
export interface MascotRamp {
  /** The body's hue, in degrees. */
  readonly hue: number;
  /** Darkest first: outline, shade, base, light, highlight. */
  readonly tones: readonly [string, string, string, string, string];
  readonly eye: string;
  /** The white of an eye behind glasses, and a glint on a dark lens. */
  readonly white: string;
}

function hsl(hue: number, saturation: number, lightness: number): string {
  const h = Math.round(((hue % 360) + 360) % 360);
  const s = Math.round(Math.min(Math.max(saturation, 0), 100));
  const l = Math.round(Math.min(Math.max(lightness, 0), 100));
  return `hsl(${String(h)} ${String(s)}% ${String(l)}%)`;
}

/**
 * A hue's ramp around a base lightness: the darker steps lean cooler and the
 * lighter warmer and paler, as a pixel-art ramp does.
 */
function rampAround(hue: number, saturation: number, base: number): MascotRamp {
  return {
    hue,
    tones: [
      hsl(hue - 6, saturation, base - 22),
      hsl(hue - 3, saturation, base - 11),
      hsl(hue, saturation, base),
      hsl(hue + 3, Math.max(saturation - 8, 10), Math.min(base + 12, 88)),
      hsl(hue + 6, Math.max(saturation - 20, 8), Math.min(base + 24, 95)),
    ],
    eye: hsl(hue, 45, 9),
    white: hsl(hue, 30, 97),
  };
}

/** The default mascot: the teal blob, wearing nothing. */
export const DEFAULT_MASCOT_SHAPE: MascotShape = "blob";
export const DEFAULT_MASCOT_RAMP: MascotRamp = rampAround(192, 32, 68);

/** A dark lens, whatever the body's colour, and the bridge of a pair of glasses. */
const LENS_COLOUR = hsl(220, 12, 7);
const BRIDGE_COLOUR = hsl(220, 12, 14);
const LEAF_COLOUR = hsl(128, 62, 56);
const STEM_COLOUR = hsl(134, 55, 36);

/**
 * Each accessory's own colour, as hue, saturation and lightness: an
 * antenna's red light, a pink bow, a gold sparkle, an orange flag, tan horns
 * and a gold halo, each mid enough to read on a light page and a dark one.
 * A sprout and a pair of antennae have no entry: the one is green, the other
 * the body's own steps.
 */
const ACCESSORY_COLOURS: Readonly<
  Partial<Record<BotMascotAccessory, readonly [number, number, number]>>
> = {
  antenna: [2, 85, 60],
  bow: [334, 80, 62],
  sparkle: [46, 96, 56],
  flag: [22, 95, 58],
  horns: [32, 38, 60],
  halo: [48, 96, 60],
};

/** How close two hues are before an accessory is lost on its body, in degrees. */
const SAME_HUE_WITHIN = 28;

/**
 * The colour of what a mascot carries: its accessory's own, a step lighter
 * on a body of nearly the same hue so it still reads apart from it.
 */
function accessoryColour(look: MascotLook): string {
  const [hue, saturation, lightness] = ACCESSORY_COLOURS[look.accessory] ?? [
    0, 0, 96,
  ];
  const apart = Math.abs(((((hue - look.ramp.hue) % 360) + 540) % 360) - 180);
  return hsl(
    hue,
    saturation,
    apart < SAME_HUE_WITHIN ? Math.min(lightness + 16, 92) : lightness,
  );
}

function fillOf(tone: MascotTone, look: MascotLook): string {
  switch (tone) {
    case "eye":
      return look.ramp.eye;
    case "white":
      return look.ramp.white;
    case "lens":
      return LENS_COLOUR;
    case "bridge":
      return BRIDGE_COLOUR;
    case "leaf":
      return LEAF_COLOUR;
    case "stem":
      return STEM_COLOUR;
    case "accessory":
      return accessoryColour(look);
    default:
      return look.ramp.tones[tone];
  }
}

/** A `#rrggbb` colour's hue (degrees) and HSL saturation and lightness (percent). */
function hexToHsl(hex: string): readonly [number, number, number] {
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const chroma = max - min;
  if (chroma === 0) return [0, 0, lightness * 100];
  const saturation = chroma / (1 - Math.abs(2 * lightness - 1));
  let sector = (r - g) / chroma + 4;
  if (max === r) sector = ((g - b) / chroma) % 6;
  else if (max === g) sector = (b - r) / chroma + 2;
  return [sector * 60, saturation * 100, lightness * 100];
}

/**
 * The ramp of colour `index`, on that colour's own hue: the first twelve
 * around a mid lightness, the deep twelve a step darker.
 */
function rampForColor(index: number): MascotRamp {
  const [hue, saturation] = hexToHsl(botColorAt(index));
  const deep = index >= BOT_COLOR_COUNT / 2;
  return rampAround(hue, Math.min(saturation, 85), deep ? 48 : 62);
}

const COLOR_RAMPS: readonly MascotRamp[] = Array.from(
  { length: BOT_COLOR_COUNT },
  (_, index) => rampForColor(index),
);

/** The ramp of colour `index`, one of {@link BOT_COLOR_COUNT}. */
export function mascotRampAt(index: number): MascotRamp {
  return COLOR_RAMPS[index] ?? DEFAULT_MASCOT_RAMP;
}

/**
 * FNV-1a 32-bit over `salt` then the id, finished with murmur3's mixer, so
 * what a bot's id gives it stays fixed.
 */
function saltedHash(salt: string, botId: string): number {
  const input = `${salt}:${botId}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/** The body a bot shows when nothing was chosen, from its id alone. */
export function ownMascotShape(botId: string): MascotShape {
  return MASCOT_SHAPES[
    saltedHash("mascot-shape", botId) % MASCOT_SHAPES.length
  ];
}

/**
 * One of `options` from a hash: the first, wearing nothing, for
 * `plainPerMille` ids in a thousand, and the rest shared evenly.
 */
function ownPart<Part extends string>(
  hash: number,
  plainPerMille: number,
  options: readonly [Part, ...Part[]],
): Part {
  if (hash % 1000 < plainPerMille) return options[0];
  return options[1 + ((hash >>> 10) % (options.length - 1))];
}

/** What a bot wears over its eyes when nothing was chosen: most wear nothing. */
export function ownMascotEyewear(botId: string): BotMascotEyewear {
  return ownPart(saltedHash("mascot-eyewear", botId), 600, BOT_MASCOT_EYEWEAR);
}

/** What a bot carries when nothing was chosen: a third carry nothing. */
export function ownMascotAccessory(botId: string): BotMascotAccessory {
  return ownPart(
    saltedHash("mascot-accessory", botId),
    340,
    BOT_MASCOT_ACCESSORIES,
  );
}

/**
 * A bot's mascot: each choice its look names, else the one its id gives, and
 * the default mascot's for a choice this client cannot read.
 */
export function botMascot(
  botId: string,
  look: BotAppearance | null,
): MascotLook {
  const eyewear = look?.eyewear ?? null;
  const accessory = look?.accessory ?? null;
  return {
    shape: chosenShape(botId, look?.mark ?? null),
    ramp: chosenRamp(botId, look?.color ?? null),
    eyewear: eyewear === null ? ownMascotEyewear(botId) : readablePart(eyewear),
    accessory:
      accessory === null ? ownMascotAccessory(botId) : readablePart(accessory),
  };
}

/** A chosen part, or `none` for one this client cannot read. */
function readablePart<Part extends string>(
  part: Part | typeof BOT_APPEARANCE_UNRECOGNISED,
): Part | "none" {
  return part === BOT_APPEARANCE_UNRECOGNISED ? "none" : part;
}

function isDrawn(shape: BotMascotShape): shape is MascotShape {
  return MASCOT_SHAPES.some((drawn) => drawn === shape);
}

function chosenShape(botId: string, mark: BotAppearance["mark"]): MascotShape {
  if (mark === null) return ownMascotShape(botId);
  if (mark.kind !== "mascot") return DEFAULT_MASCOT_SHAPE;
  return isDrawn(mark.shape) ? mark.shape : ownMascotShape(botId);
}

function chosenRamp(botId: string, color: BotAppearance["color"]): MascotRamp {
  if (color === null) return mascotRampAt(derivedBotColorIndex(botId));
  return color === BOT_APPEARANCE_UNRECOGNISED
    ? DEFAULT_MASCOT_RAMP
    : mascotRampAt(color);
}

/** The avatar sizes a mascot is drawn at, in CSS pixels. */
export type MascotMarkSize = 16 | 24 | 32 | 40;

/**
 * Each size's drawing: its cells, and a cell's side in whole CSS pixels. The
 * largest cell that fits is used, so the figure takes most of the avatar,
 * and the smallest size has a drawing of its own.
 */
function cellsAt(
  look: MascotLook,
  size: MascotMarkSize,
  pose: MascotPose,
): { readonly cells: MascotCells; readonly cell: number } {
  switch (size) {
    case 16:
      return { cells: smallMascotCells(look, pose), cell: 2 };
    case 24:
      return { cells: mascotCells(look, pose), cell: 2 };
    case 32:
      return { cells: mascotCells(look, pose), cell: 3 };
    case 40:
      return { cells: mascotCells(look, pose), cell: 4 };
  }
}

export interface MascotMarkDrawing {
  readonly viewBox: string;
  /** One path per colour, each a run of whole-pixel squares. */
  readonly layers: ReadonlyArray<{
    readonly fill: string;
    readonly path: string;
  }>;
}

/** The mascot in whole CSS pixels at `size`, centred on the avatar. */
export function drawMascotMark(
  look: MascotLook,
  size: MascotMarkSize,
  pose: MascotPose,
): MascotMarkDrawing {
  const { cells, cell } = cellsAt(look, size, pose);
  const offset = (size - cells.length * cell) / 2;
  const paths = new Map<string, string[]>();
  for (const [y, row] of cells.entries()) {
    for (const [x, tone] of row.entries()) {
      if (tone === null) continue;
      const fill = fillOf(tone, look);
      const squares = paths.get(fill) ?? [];
      squares.push(
        `M${String(offset + x * cell)} ${String(offset + y * cell)}h${String(cell)}v${String(cell)}h-${String(cell)}z`,
      );
      paths.set(fill, squares);
    }
  }
  return {
    viewBox: `0 0 ${String(size)} ${String(size)}`,
    layers: [...paths].map(([fill, squares]) => ({
      fill,
      path: squares.join(""),
    })),
  };
}
