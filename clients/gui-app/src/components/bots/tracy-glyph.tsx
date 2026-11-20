import type { ReactElement } from "react";
import { cn } from "@/lib/utils";

export type TracyGlyphSize = "xs" | "sm" | "default" | "lg";

/** A glyph's cells, row 0 on top: `#` drawn, `o` an eye left open. */
type GlyphRows = readonly string[];

/** The mascot's body at the smallest size, where a cell is two pixels. */
const SMALL_ROWS: GlyphRows = [
  ".#####.",
  "#######",
  "##o#o##",
  "##o#o##",
  "#######",
  ".#####.",
];

/** The mascot's body on its own ten-cell grid, for every larger size. */
const ROWS: GlyphRows = [
  "...####...",
  ".########.",
  "##########",
  "##o####o##",
  "##o####o##",
  "##########",
  "##########",
  ".########.",
];

/** Each size's box in pixels, its rows, and the whole pixels of one cell. */
const GLYPH: Readonly<
  Record<
    TracyGlyphSize,
    {
      readonly box: number;
      readonly rows: GlyphRows;
      readonly cell: number;
      readonly className: string;
    }
  >
> = {
  xs: { box: 16, rows: SMALL_ROWS, cell: 2, className: "size-4" },
  sm: { box: 24, rows: ROWS, cell: 2, className: "size-6" },
  default: { box: 32, rows: ROWS, cell: 3, className: "size-8" },
  lg: { box: 40, rows: ROWS, cell: 4, className: "size-10" },
};

/** The drawn cells as one path, centred in the box. */
function glyphPath(box: number, rows: GlyphRows, cell: number): string {
  const left = (box - rows[0].length * cell) / 2;
  const top = (box - rows.length * cell) / 2;
  const c = String(cell);
  return rows
    .flatMap((row, y) =>
      [...row].flatMap((mark, x) =>
        mark === "#"
          ? [
              `M${String(left + x * cell)} ${String(top + y * cell)}h${c}v${c}h-${c}z`,
            ]
          : [],
      ),
    )
    .join("");
}

/**
 * Tracy as a kind, where no one bot is meant: the mascot's body in one
 * colour, the text colour of where it sits, with its eyes left open. It has
 * no fill behind it and reads nothing of any bot, so it is the same picture
 * for everyone and in every theme, and a tab kind can name it without
 * reaching back into the tab registry. A bot's own picture is its avatar.
 */
export function TracyGlyph(props: {
  readonly size: TracyGlyphSize;
  readonly className: string | undefined;
}): ReactElement {
  const { box, rows, cell, className } = GLYPH[props.size];
  return (
    <svg
      viewBox={`0 0 ${String(box)} ${String(box)}`}
      aria-hidden="true"
      focusable="false"
      shapeRendering="crispEdges"
      fill="currentColor"
      data-testid="tracy-glyph"
      className={cn("shrink-0", className, props.className)}
    >
      <path d={glyphPath(box, rows, cell)} />
    </svg>
  );
}
