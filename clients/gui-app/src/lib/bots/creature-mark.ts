/**
 * A bot's creature mark: a 5×5 pixel creature, mirrored
 * left to right, with two eyes, drawn in the swatch's ink on the bot's
 * swatch. A pure function of the bot's id: the title never enters, so a
 * rename changes neither the creature nor its colour.
 *
 * The id's hash fills the left three columns row by row and the right two
 * mirror them. Row 1, columns 1 and 3 are the eyes and must be body cells; a
 * mask without them, a body that is one solid rectangle, or a body of fewer
 * than {@link MIN_BODY_CELLS} cells is rejected and the next hash state is
 * tried. A separately salted hash picks the silhouette, the cells outside
 * the grid: none, ears above the top corners, feet below the bottom corners,
 * or a crest above the centre.
 *
 * A change to anything that moves a bot's creature bumps
 * {@link CREATURE_MARK_VERSION}; the tests pin fixed ids to their masks.
 */
export const CREATURE_MARK_VERSION = 1;

export type CreatureSilhouette = "none" | "ears" | "feet" | "crest";

export interface CreatureMark {
  /**
   * The body's five rows, top first; bit `c` of a row is column `c`, so a
   * row and its mirror image are the same number read either way.
   */
  readonly rows: readonly number[];
  readonly silhouette: CreatureSilhouette;
}

const GRID = 5;
const HALF = 3;
const EYE_ROW = 1;
const EYE_COLUMNS: readonly number[] = [1, 3];
const MIN_BODY_CELLS = 6;
/** Hash states tried before {@link FALLBACK_ROWS}; each passes about half the time. */
const MAX_ROLLS = 32;
/** An accepted body, for an id no roll passes. */
const FALLBACK_ROWS: readonly number[] = [
  0b01110, 0b11011, 0b11111, 0b01110, 0b10001,
];
const SILHOUETTES: readonly CreatureSilhouette[] = [
  "none",
  "ears",
  "feet",
  "crest",
];

/**
 * FNV-1a 32-bit over `salt` then the id (`hashProfileIdToColorIndex`'s
 * idiom), finished with murmur3's mixer: FNV-1a's low bits depend only on
 * the low bits of the characters, and the mask reads fifteen of them.
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

/** Fifteen bits of a hash as the left three columns, mirrored to five. */
function mirroredRows(bits: number): number[] {
  const rows: number[] = [];
  for (let row = 0; row < GRID; row++) {
    let value = 0;
    for (let column = 0; column < HALF; column++) {
      if ((bits >>> (row * HALF + column)) & 1) {
        value |= (1 << column) | (1 << (GRID - 1 - column));
      }
    }
    rows.push(value);
  }
  return rows;
}

function isBodyCell(
  rows: readonly number[],
  row: number,
  column: number,
): boolean {
  return ((rows[row] >>> column) & 1) === 1;
}

/** The body cells the silhouette's cells stand on, so they never float. */
function withAnchors(
  rows: readonly number[],
  silhouette: CreatureSilhouette,
): number[] {
  const anchored = [...rows];
  const corners = (1 << 0) | (1 << (GRID - 1));
  if (silhouette === "ears") anchored[0] |= corners;
  if (silhouette === "feet") anchored[GRID - 1] |= corners;
  if (silhouette === "crest") anchored[0] |= 1 << 2;
  return anchored;
}

function bodyCellCount(rows: readonly number[]): number {
  let count = 0;
  for (const row of rows) {
    for (let column = 0; column < GRID; column++) {
      count += (row >>> column) & 1;
    }
  }
  return count;
}

/** Every cell of the body's bounding box is a body cell. */
function isSolidBlock(rows: readonly number[]): boolean {
  const filled = rows.flatMap((row, index) => (row === 0 ? [] : [index]));
  if (filled.length === 0) return true;
  const union = rows.reduce((all, row) => all | row, 0);
  const lowest = 31 - Math.clz32(union & -union);
  const highest = 31 - Math.clz32(union);
  const box = ((1 << (highest + 1)) - 1) & ~((1 << lowest) - 1);
  for (let row = filled[0]; row <= filled[filled.length - 1]; row++) {
    if (rows[row] !== box) return false;
  }
  return true;
}

function isAcceptedMask(rows: readonly number[]): boolean {
  return (
    EYE_COLUMNS.every((column) => isBodyCell(rows, EYE_ROW, column)) &&
    bodyCellCount(rows) >= MIN_BODY_CELLS &&
    !isSolidBlock(rows)
  );
}

export function creatureMark(botId: string): CreatureMark {
  const silhouette =
    SILHOUETTES[saltedHash("creature-silhouette", botId) % SILHOUETTES.length];
  for (let roll = 0; roll < MAX_ROLLS; roll++) {
    const bits = saltedHash(`creature-body-${String(roll)}`, botId);
    const rows = withAnchors(mirroredRows(bits), silhouette);
    if (isAcceptedMask(rows)) return { rows, silhouette };
  }
  return { rows: withAnchors(FALLBACK_ROWS, silhouette), silhouette };
}

/** The avatar sizes a creature is drawn at, in CSS pixels. */
export type CreatureMarkSize = 16 | 24 | 32 | 40;

export interface CreatureMarkDrawing {
  readonly viewBox: string;
  /** Body and silhouette in one even-odd path; each eye is a hole in it. */
  readonly path: string;
}

/**
 * The creature in whole CSS pixels at `size`: cells of `size / 8`, the
 * drawn rows (the body and any silhouette row) centred on the box, the
 * remainder of an odd split going below and to the right. An eye's hole
 * leaves a one-pixel rim of its cell, so at 16 px, whose cells are two
 * pixels, the eyes are drawn as body cells without one.
 */
export function drawCreatureMark(
  mark: CreatureMark,
  size: CreatureMarkSize,
): CreatureMarkDrawing {
  const cell = size / 8;
  const silhouetteRow = mark.silhouette === "none" ? 0 : 1;
  const drawnRows = GRID + silhouetteRow;
  const left = Math.floor((size - GRID * cell) / 2);
  const top = Math.floor((size - drawnRows * cell) / 2);
  // The body's first row, below an ears or crest row.
  const bodyTop =
    mark.silhouette === "ears" || mark.silhouette === "crest"
      ? top + cell
      : top;
  const squares: string[] = [];
  const square = (x: number, y: number, side: number): void => {
    squares.push(
      `M${String(x)} ${String(y)}h${String(side)}v${String(side)}h-${String(side)}z`,
    );
  };
  for (const [row, value] of mark.rows.entries()) {
    for (let column = 0; column < GRID; column++) {
      if ((value >>> column) & 1) {
        square(left + column * cell, bodyTop + row * cell, cell);
      }
    }
  }
  const above = bodyTop - cell;
  const below = bodyTop + GRID * cell;
  if (mark.silhouette === "ears") {
    square(left, above, cell);
    square(left + (GRID - 1) * cell, above, cell);
  } else if (mark.silhouette === "feet") {
    square(left, below, cell);
    square(left + (GRID - 1) * cell, below, cell);
  } else if (mark.silhouette === "crest") {
    square(left + 2 * cell, above, cell);
  }
  const hole = cell - 2;
  if (hole > 0) {
    for (const column of EYE_COLUMNS) {
      square(left + column * cell + 1, bodyTop + EYE_ROW * cell + 1, hole);
    }
  }
  return {
    viewBox: `0 0 ${String(size)} ${String(size)}`,
    path: squares.join(""),
  };
}
