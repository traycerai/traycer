import {
  BOT_APPEARANCE_UNRECOGNISED,
  BOT_MASCOT_SHAPES,
  BOT_COLOR_COUNT,
  type BotAppearance,
  type BotMascotShape,
} from "@traycer/protocol/host/bot/schemas";
import {
  botColorAt,
  derivedBotColorIndex,
} from "../providers/profile-accent-color";

/**
 * A bot's mascot: one of {@link BOT_MASCOT_SHAPES}, a 12×12 pixel figure
 * shaded in its colour's ramp, with two eyes, on a tile tinted with the same
 * hue. Shape and colour are each a pure function of the bot's id unless a
 * person chose one in the bot's settings, so a rename changes neither.
 *
 * A choice this client cannot read (a newer writer's shape, kind or colour,
 * read as {@link BOT_APPEARANCE_UNRECOGNISED}) draws the default mascot:
 * the teal blob, {@link DEFAULT_MASCOT_SHAPE} in {@link DEFAULT_MASCOT_RAMP}.
 *
 * The tests pin fixed ids to their shapes so a bot keeps its mascot.
 */

const GRID = 12;

/** A shape written as its left six columns, mirrored to twelve. */
function mirrored(rows: readonly string[]): readonly string[] {
  return rows.map((row) => row + [...row].reverse().join(""));
}

/**
 * Each shape's cells, `#` filled, row 0 on top. Every shape stays inside
 * the cells a squircle keeps at 24 px, where the grid fills the avatar: the
 * three corner cells of each corner, and the corner cell beside them on the
 * second and penultimate rows, are empty.
 */
const SHAPE_CELLS: Readonly<Record<BotMascotShape, readonly string[]>> = {
  blob: mirrored([
    "......",
    "......",
    "....##",
    "..####",
    ".#####",
    "######",
    "######",
    "######",
    "######",
    ".#####",
    ".#####",
    "......",
  ]),
  block: mirrored([
    "......",
    ".#####",
    ".#####",
    "######",
    "######",
    ".#####",
    ".#####",
    "######",
    "######",
    ".#####",
    ".#####",
    "......",
  ]),
  flame: mirrored([
    ".....#",
    "....##",
    "....##",
    "...###",
    "..####",
    ".#####",
    "######",
    "######",
    "######",
    ".#####",
    ".#####",
    "...###",
  ]),
  ghost: mirrored([
    "......",
    "....##",
    "..####",
    ".#####",
    "######",
    "######",
    "######",
    "######",
    "######",
    ".#####",
    ".#.###",
    "...#.#",
  ]),
  capsule: mirrored([
    "....##",
    "...###",
    "..####",
    "..####",
    "..####",
    "..####",
    "..####",
    "..####",
    "..####",
    "..####",
    "...###",
    "....##",
  ]),
  cat: mirrored([
    "......",
    ".#....",
    ".##...",
    "######",
    "######",
    "######",
    "######",
    "######",
    "######",
    ".#####",
    ".#####",
    "......",
  ]),
  shield: mirrored([
    "......",
    ".#####",
    ".#####",
    "######",
    "######",
    "######",
    ".#####",
    "..####",
    "..####",
    "...###",
    "....##",
    ".....#",
  ]),
  sun: mirrored([
    "......",
    "....##",
    "..####",
    ".#####",
    ".#####",
    "######",
    "######",
    ".#####",
    ".#####",
    "..####",
    "....##",
    "......",
  ]),
  diamond: mirrored([
    ".....#",
    "....##",
    "...###",
    "..####",
    ".#####",
    "######",
    "######",
    ".#####",
    "..####",
    "...###",
    "....##",
    ".....#",
  ]),
  doc: [
    "............",
    ".#######....",
    ".########...",
    ".#########..",
    ".##########.",
    ".##########.",
    ".##########.",
    ".##########.",
    ".##########.",
    ".##########.",
    ".##########.",
    "............",
  ],
};

/** What a cell is drawn in: a step of the ramp, darkest first, or an eye. */
export type MascotTone = 0 | 1 | 2 | 3 | 4 | "eye";

/** A shape's cells by tone, `null` where the shape has none. */
export type MascotShading = ReadonlyArray<ReadonlyArray<MascotTone | null>>;

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

/** The eyes' columns, widest first: each leaves a cell of body beside it. */
const EYE_COLUMNS: ReadonlyArray<readonly [number, number]> = [
  [3, 8],
  [4, 7],
];

/**
 * Where the eyes go: the first row around the middle, and the widest pair of
 * columns, where both eyes' two cells sit at depth 2 or more.
 */
function eyesOf(
  cells: Cells,
  depth: readonly number[][],
  top: number,
  bottom: number,
): { readonly y: number; readonly xs: readonly number[] } | null {
  const middleRow = Math.round(top + (bottom - top) * 0.48);
  for (const dy of [0, 1, -1, 2]) {
    const y = middleRow + dy;
    for (const xs of EYE_COLUMNS) {
      const fits = [y, y + 1].every((row) =>
        xs.every((x) => isFilled(cells, x, row) && depth[row][x] >= 2),
      );
      if (fits) return { y, xs };
    }
  }
  return null;
}

/**
 * A shape lit from above ({@link bodyTone}), with a highlight up and left of
 * the centre and two eyes, one cell wide and two tall ({@link eyesOf}).
 */
function shade(shape: BotMascotShape): MascotShading {
  const cells = SHAPE_CELLS[shape];
  const depth = depthsOf(cells);
  const filledRows = cells.flatMap((row, y) => (row.includes("#") ? [y] : []));
  const top = filledRows[0];
  const bottom = filledRows[filledRows.length - 1];
  const tones: Array<Array<MascotTone | null>> = cells.map((row, y) =>
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
  const shine = eyes === null ? top + 2 : Math.max(top + 1, eyes.y - 2);
  const highlight: ReadonlyArray<readonly [number, number, 3 | 4]> = [
    [centre, shine, 4],
    [centre - 1, shine, 4],
    [centre, shine - 1, 3],
    [centre - 1, shine + 1, 3],
  ];
  for (const [x, y, tone] of highlight) {
    if (isFilled(cells, x, y) && depth[y][x] >= 2) tones[y][x] = tone;
  }
  for (const y of eyes === null ? [] : [eyes.y, eyes.y + 1]) {
    for (const x of eyes?.xs ?? []) tones[y][x] = "eye";
  }
  return tones;
}

const SHADINGS = new Map<BotMascotShape, MascotShading>();

/** A shape's shading, worked out once. */
export function mascotShading(shape: BotMascotShape): MascotShading {
  let shading = SHADINGS.get(shape);
  if (shading === undefined) {
    shading = shade(shape);
    SHADINGS.set(shape, shading);
  }
  return shading;
}

/** The colours a mascot is drawn in: its five steps, its eyes, its tile. */
export interface MascotRamp {
  /** Darkest first: outline, shade, base, light, highlight. */
  readonly tones: readonly [string, string, string, string, string];
  readonly eye: string;
  /** The tile behind the mascot, in each theme. */
  readonly tile: { readonly light: string; readonly dark: string };
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
    tones: [
      hsl(hue - 6, saturation, base - 22),
      hsl(hue - 3, saturation, base - 11),
      hsl(hue, saturation, base),
      hsl(hue + 3, Math.max(saturation - 8, 10), Math.min(base + 12, 88)),
      hsl(hue + 6, Math.max(saturation - 20, 8), Math.min(base + 24, 95)),
    ],
    eye: hsl(hue, 45, 9),
    tile: {
      light: hsl(hue, Math.min(saturation, 60), 94),
      dark: hsl(hue, Math.min(saturation, 30), 11),
    },
  };
}

/** The default mascot's shape and colour: the teal blob. */
export const DEFAULT_MASCOT_SHAPE: BotMascotShape = "blob";
export const DEFAULT_MASCOT_RAMP: MascotRamp = rampAround(192, 32, 68);

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
 * a bot's shape stays fixed for its id.
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

/** The shape a bot shows when nothing was chosen, from its id alone. */
export function ownMascotShape(botId: string): BotMascotShape {
  return BOT_MASCOT_SHAPES[
    saltedHash("mascot-shape", botId) % BOT_MASCOT_SHAPES.length
  ];
}

/** What a mascot is drawn as: a shape in a ramp. */
export interface MascotLook {
  readonly shape: BotMascotShape;
  readonly ramp: MascotRamp;
}

/**
 * A bot's mascot: each choice its look names, else the one its id gives, and
 * the default mascot's for a choice this client cannot read.
 */
export function botMascot(
  botId: string,
  look: BotAppearance | null,
): MascotLook {
  return {
    shape: chosenShape(botId, look?.mark ?? null),
    ramp: chosenRamp(botId, look?.color ?? null),
  };
}

function chosenShape(
  botId: string,
  mark: BotAppearance["mark"],
): BotMascotShape {
  if (mark === null) return ownMascotShape(botId);
  return mark.kind === "mascot" ? mark.shape : DEFAULT_MASCOT_SHAPE;
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
 * Each size's cell: whole CSS pixels, the grid three quarters of the avatar
 * or more, and centred on whole pixels.
 */
const CELL: Readonly<Record<MascotMarkSize, number>> = {
  16: 1,
  24: 2,
  32: 2,
  40: 3,
};

export interface MascotMarkDrawing {
  readonly viewBox: string;
  /** One even-odd path per colour, darkest first, the eyes last. */
  readonly layers: ReadonlyArray<{
    readonly fill: string;
    readonly path: string;
  }>;
}

/** The mascot in whole CSS pixels at `size`, centred on the avatar. */
export function drawMascotMark(
  look: MascotLook,
  size: MascotMarkSize,
): MascotMarkDrawing {
  const cell = CELL[size];
  const offset = (size - GRID * cell) / 2;
  const paths = new Map<MascotTone, string[]>();
  for (const [y, row] of mascotShading(look.shape).entries()) {
    for (const [x, tone] of row.entries()) {
      if (tone === null) continue;
      const squares = paths.get(tone) ?? [];
      squares.push(
        `M${String(offset + x * cell)} ${String(offset + y * cell)}h${String(cell)}v${String(cell)}h-${String(cell)}z`,
      );
      paths.set(tone, squares);
    }
  }
  const order: readonly MascotTone[] = [0, 1, 2, 3, 4, "eye"];
  return {
    viewBox: `0 0 ${String(size)} ${String(size)}`,
    layers: order.flatMap((tone) => {
      const squares = paths.get(tone);
      if (squares === undefined) return [];
      return [
        {
          fill: tone === "eye" ? look.ramp.eye : look.ramp.tones[tone],
          path: squares.join(""),
        },
      ];
    }),
  };
}
