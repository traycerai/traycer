import {
  MASCOT_AT_REST,
  botMascot,
  drawMascotMark,
  type MascotMarkSize,
} from "@/lib/bots/mascot-mark";

/** The `d` of each path of the mascot drawn inside `root`, in draw order. */
export function renderedMascotPaths(root: Element): string[] {
  return [...root.querySelectorAll('[data-slot="bot-mascot"] path')].map(
    (path) => path.getAttribute("d") ?? "",
  );
}

/** The paths a bot's mascot at rest draws at `size`, from the real drawing. */
export function mascotPathsAt(
  botId: string,
  main: boolean,
  size: MascotMarkSize,
): string[] {
  return drawMascotMark(
    botMascot(botId, null, main),
    size,
    MASCOT_AT_REST,
  ).layers.map((layer) => layer.path);
}

/** What the Tracy glyph drawn inside `root` reads as. */
export interface TracyGlyphRead {
  readonly viewBox: string | null;
  readonly fill: string | null;
  readonly pathCount: number;
  readonly cell: number;
  /** Each drawn cell's pixel origin as "x,y", sorted. */
  readonly cells: string[];
}

const GLYPH_CELL = /M(\d+) (\d+)h(\d+)v\d+h-\d+z/g;

function sortedOrigins(origins: readonly string[]): string[] {
  return [...origins].sort();
}

/** Each Tracy glyph drawn inside `root`, read from its markup alone. */
export function renderedTracyGlyphs(root: Element): TracyGlyphRead[] {
  return [...root.querySelectorAll('[data-testid="tracy-glyph"]')].map(
    (glyph) => {
      const paths = [...glyph.querySelectorAll("path")];
      const d = paths.map((path) => path.getAttribute("d") ?? "").join("");
      const squares = [...d.matchAll(GLYPH_CELL)];
      return {
        viewBox: glyph.getAttribute("viewBox"),
        fill: glyph.getAttribute("fill"),
        pathCount: paths.length,
        cell: squares.length === 0 ? 0 : Number(squares[0][3]),
        cells: sortedOrigins(
          squares.map((square) => `${square[1]},${square[2]}`),
        ),
      };
    },
  );
}

/** Whether `root` draws a coloured mascot or the box a bot's picture sits in. */
export function drawsColouredMascot(root: Element): boolean {
  return (
    root.querySelector('[data-slot="bot-mascot"], [data-identity="bot"]') !==
    null
  );
}

interface GlyphSpec {
  readonly rows: readonly string[];
  readonly cell: number;
  readonly left: number;
  readonly top: number;
}

const GLYPH_SPECS: Readonly<Record<16 | 24 | 40, GlyphSpec>> = {
  16: {
    rows: [".#####.", "#######", "##o#o##", "##o#o##", "#######", ".#####."],
    cell: 2,
    left: 1,
    top: 2,
  },
  24: {
    rows: [
      "...####...",
      ".########.",
      "##########",
      "##o####o##",
      "##o####o##",
      "##########",
      "##########",
      ".########.",
    ],
    cell: 2,
    left: 2,
    top: 4,
  },
  40: {
    rows: [
      "...####...",
      ".########.",
      "##########",
      "##o####o##",
      "##o####o##",
      "##########",
      "##########",
      ".########.",
    ],
    cell: 4,
    left: 0,
    top: 4,
  },
};

/** The one Tracy glyph a place at `box` pixels draws, written out by hand. */
export function expectedTracyGlyph(box: 16 | 24 | 40): TracyGlyphRead {
  const { rows, cell, left, top } = GLYPH_SPECS[box];
  return {
    viewBox: `0 0 ${String(box)} ${String(box)}`,
    fill: "currentColor",
    pathCount: 1,
    cell,
    cells: sortedOrigins(
      rows.flatMap((row, y) =>
        [...row].flatMap((mark, x) =>
          mark === "#"
            ? [`${String(left + x * cell)},${String(top + y * cell)}`]
            : [],
        ),
      ),
    ),
  };
}

/** Whether `root` draws the lucide robot glyph the mascot replaces. */
export function drawsRobotGlyph(root: Element): boolean {
  return root.querySelector("svg.lucide-bot") !== null;
}
