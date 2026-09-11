/**
 * The office's floor, baked in 512-pixel squares and blitted thereafter.
 *
 * A floor is one sprite per TILE. On a large office that is thousands of
 * `drawImage` calls per frame, each one preceded by a cache lookup, to produce
 * an image identical to the one already on screen - and it is the single
 * largest thing the renderer was doing. The floor changes only when the LAYOUT
 * does, which is when the set of agents changes, so it is painted into
 * offscreen canvases and copied under the camera transform instead.
 *
 * IN CHUNKS, not as one world. The whole-world bitmap this replaced was the
 * largest allocation the office made and the only one that scaled with the
 * epic: the review measured 55 MiB for a thousand agents in one root and 101
 * MiB for a thousand roots, with no cap in sight above that. A chunk is a
 * fixed 512 x 512 sprite pixels - a megabyte of RGBA - and a canvas holds at
 * most `OFFICE_STATIC_CHUNK_BUDGET` of them, so the ceiling is 24 MB however
 * large the office is. What is held is what the camera has been looking at:
 * chunks are baked when the view reaches them, kept while it stays, and
 * evicted least-recently-drawn once the budget is full.
 *
 * Kept in SPRITE space at 1x rather than at the camera's scale, so panning and
 * zooming never invalidate it. Smoothing is off on the way out, which is what
 * a per-sprite draw at the same transform would have done anyway.
 *
 * ONE per mounted office canvas, released on suspension and on unmount.
 */
import type {
  OfficeDrawable,
  OfficeLod,
  OfficePoint,
  OfficeRect,
  OfficeSize,
  OfficeTheme,
  OfficeTileRect,
} from "@/lib/comm-graph/office/office-types";
import type { OfficeProjector } from "@/lib/comm-graph/office/views/office-view";

/**
 * Whether a floor drawable is baked into the static layer.
 *
 * THE partition, used by both halves: the offscreen paints exactly the
 * drawables this admits, and the per-frame path draws exactly the ones it
 * does not. Sharing one predicate is what makes the two routes the same
 * floor - a label emitted onto the floor is drawn either way, rather than
 * appearing only when there is no offscreen surface to bake into.
 *
 * Only sprites qualify. Labels are drawn later in SCREEN space, clocks need
 * hands over them, and an envelope or a logo is not static by nature.
 */
export function officeBakesIntoStaticFloor(
  drawable: OfficeDrawable,
): drawable is Extract<OfficeDrawable, { kind: "sprite" }> {
  return drawable.kind === "sprite";
}

/**
 * The side of one chunk, in sprite pixels. 512 x 512 x 4 bytes is a megabyte,
 * which is the unit the budget below is counted in.
 *
 * It is also the side of the scene's frame-index chunk, deliberately: the two
 * grids answer different questions about the same world, and a viewport that
 * touches a dozen index chunks touches a dozen of these.
 */
export const OFFICE_STATIC_CHUNK_PX = 512;

/**
 * How many chunks one canvas may hold: 24 MB, a ceiling no world size exceeds
 * because it is a property of the VIEWPORT rather than of the epic.
 */
export const OFFICE_STATIC_CHUNK_BUDGET = 24;

/**
 * How far past its own edge a chunk's bake reaches for the art it draws.
 *
 * A sprite is anchored at a tile and spills off it - a wall, a plant, a
 * two-tile desk - so a chunk that asked only for the tiles inside itself would
 * lose every sprite anchored just outside it and leave a seam of missing
 * pixels down its edge. Each chunk therefore paints everything anchored within
 * this margin as well, CLIPPED to its own square: the chunks stay disjoint, so
 * a sprite straddling two of them is drawn once into each and composed whole,
 * never blended twice.
 *
 * Four times the largest sprite (32 px) and comfortably over the tallest thing
 * a painter stacks on a floor tile (a campus back wall, 24 px).
 */
export const OFFICE_STATIC_CHUNK_BLEED_PX = 128;

/** One chunk of the world, addressed on the chunk grid. */
export interface OfficeStaticChunk {
  readonly chunkCol: number;
  readonly chunkRow: number;
}

/** Everything that changes what the static layer should contain. */
export interface OfficeStaticLayerKey {
  /** The scene's own version for its floor; see `OfficeFrame.staticVersion`. */
  readonly staticVersion: number;
  /** The palette is baked into the pixels, so a theme flip is a repaint. */
  readonly theme: OfficeTheme;
  /** The WORLD's size in sprite pixels, which is what the chunk grid covers. */
  readonly width: number;
  readonly height: number;
}

export interface OfficeStaticSurface {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
}

/**
 * Makes an offscreen surface, or reports that this host cannot. Injected so
 * the caching logic can be exercised where there is no 2D context at all.
 */
export type OfficeStaticSurfaceFactory = (
  width: number,
  height: number,
) => OfficeStaticSurface | null;

/** A held chunk's bitmap and where in the world it goes. */
export interface OfficeStaticChunkDraw {
  readonly canvas: HTMLCanvasElement;
  readonly x: number;
  readonly y: number;
}

export interface OfficeStaticSyncArgs {
  readonly key: OfficeStaticLayerKey;
  /** What to hold this frame, from `planOfficeStaticChunks`. */
  readonly chunks: ReadonlyArray<OfficeStaticChunk>;
  /**
   * Paints one chunk. The context is in WORLD sprite space - the chunk's own
   * offset is already in the transform - with the previous contents cleared,
   * and is called only for a chunk that is not already held.
   */
  readonly paint: (ctx: CanvasRenderingContext2D, chunk: OfficeRect) => void;
}

export function officeStaticLayerKeysMatch(
  a: OfficeStaticLayerKey,
  b: OfficeStaticLayerKey,
): boolean {
  return (
    a.staticVersion === b.staticVersion &&
    a.theme === b.theme &&
    a.width === b.width &&
    a.height === b.height
  );
}

/** Browser surface factory. Separate from the class so tests need no canvas. */
export function createOfficeStaticSurface(
  width: number,
  height: number,
): OfficeStaticSurface | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  // jsdom throws rather than returning null, so this is a capability probe.
  try {
    const ctx = canvas.getContext("2d");
    if (ctx === null) return null;
    return { canvas, ctx };
  } catch {
    return null;
  }
}

export interface OfficeStaticChunkPlanInput {
  /** The world in sprite pixels: the projector's bounds. */
  readonly world: OfficeSize;
  /** What the camera can see, in world sprite pixels. */
  readonly view: OfficeRect;
  readonly lod: OfficeLod;
  readonly budget: number;
}

const NO_CHUNKS: ReadonlyArray<OfficeStaticChunk> = [];
const NO_DRAWS: ReadonlyArray<OfficeStaticChunkDraw> = [];

/**
 * Which chunks to hold for this view of this world - the whole memory policy,
 * as a pure function of four numbers and testable without a canvas.
 *
 * Three rules, in order:
 *
 * 1. **Nothing at overview.** At lod 0 the floor is a few dozen filled rects
 *    covering the view, and baking a world's worth of bitmap to blit them
 *    would be the largest allocation the office makes to draw the cheapest
 *    thing it draws.
 * 2. **Everything the view touches, plus a chunk of margin.** The margin is
 *    what a pan crosses into: without it the chunk at the leading edge is
 *    baked on the frame it becomes visible, which is the frame that can least
 *    afford it.
 * 3. **Never more than the budget.** The margin goes first, since it is only
 *    a prediction. If the view alone still needs more than the budget - a very
 *    large tile at the bottom of the office band - NOTHING is held and the
 *    caller draws the floor per frame as it does on a host with no offscreen
 *    surface at all. That path is bounded by the viewport too; it is slower,
 *    not unbounded, and it is the only answer that never leaves a hole where a
 *    chunk was refused.
 */
export function planOfficeStaticChunks(
  input: OfficeStaticChunkPlanInput,
): ReadonlyArray<OfficeStaticChunk> {
  const { budget, lod, view, world } = input;
  if (lod === 0) return NO_CHUNKS;
  if (budget < 1) return NO_CHUNKS;
  if (world.width <= 0 || world.height <= 0) return NO_CHUNKS;
  if (view.width <= 0 || view.height <= 0) return NO_CHUNKS;
  const lastCol = chunkIndexOf(world.width - 1);
  const lastRow = chunkIndexOf(world.height - 1);
  const seen = clampedSpan({ view, lastCol, lastRow });
  if (seen === null) return NO_CHUNKS;
  if (spanCount(seen) > budget) return NO_CHUNKS;
  const grown: ChunkSpan = {
    firstCol: Math.max(0, seen.firstCol - 1),
    lastCol: Math.min(lastCol, seen.lastCol + 1),
    firstRow: Math.max(0, seen.firstRow - 1),
    lastRow: Math.min(lastRow, seen.lastRow + 1),
  };
  const kept = spanCount(grown) > budget ? seen : grown;
  const chunks: OfficeStaticChunk[] = [];
  for (let row = kept.firstRow; row <= kept.lastRow; row += 1) {
    for (let col = kept.firstCol; col <= kept.lastCol; col += 1) {
      chunks.push({ chunkCol: col, chunkRow: row });
    }
  }
  return chunks;
}

/** A rectangle of the chunk grid, inclusive at both ends. */
interface ChunkSpan {
  readonly firstCol: number;
  readonly lastCol: number;
  readonly firstRow: number;
  readonly lastRow: number;
}

function chunkIndexOf(pixel: number): number {
  return Math.floor(pixel / OFFICE_STATIC_CHUNK_PX);
}

function spanCount(span: ChunkSpan): number {
  return (
    (span.lastCol - span.firstCol + 1) * (span.lastRow - span.firstRow + 1)
  );
}

/** The chunks a view rect reaches, or `null` where it misses the world. */
function clampedSpan(args: {
  readonly view: OfficeRect;
  readonly lastCol: number;
  readonly lastRow: number;
}): ChunkSpan | null {
  const { lastCol, lastRow, view } = args;
  const right = view.x + view.width;
  const bottom = view.y + view.height;
  if (right <= 0 || bottom <= 0) return null;
  const firstCol = Math.max(0, chunkIndexOf(view.x));
  const firstRow = Math.max(0, chunkIndexOf(view.y));
  if (firstCol > lastCol || firstRow > lastRow) return null;
  return {
    firstCol,
    firstRow,
    // Never behind the first: a view under a pixel wide still touches the one
    // chunk it is standing in.
    lastCol: Math.max(firstCol, Math.min(lastCol, chunkIndexOf(right - 1))),
    lastRow: Math.max(firstRow, Math.min(lastRow, chunkIndexOf(bottom - 1))),
  };
}

/** One chunk's box in world sprite pixels, cropped to the world's edge. */
export function officeStaticChunkRect(
  chunk: OfficeStaticChunk,
  world: OfficeSize,
): OfficeRect {
  const x = chunk.chunkCol * OFFICE_STATIC_CHUNK_PX;
  const y = chunk.chunkRow * OFFICE_STATIC_CHUNK_PX;
  return {
    x,
    y,
    width: Math.ceil(Math.min(OFFICE_STATIC_CHUNK_PX, world.width - x)),
    height: Math.ceil(Math.min(OFFICE_STATIC_CHUNK_PX, world.height - y)),
  };
}

/**
 * The tiles a painter has to be asked for to fill one chunk of world pixels.
 *
 * A chunk is a square of the PROJECTED world and a painter takes a rectangle
 * of TILES, so this is the projection run backwards. Every projector the views
 * ship is affine - the identity for the flat and oblique ones, a shear for the
 * two isometric ones - so the mapping is recovered from three points of
 * `project` and inverted; two more points are checked against what was
 * recovered, and anything that does not agree falls back to the whole world,
 * which is slower and still correct.
 *
 * The chunk is grown by `OFFICE_STATIC_CHUNK_BLEED_PX` first, so the answer
 * includes the tiles whose art reaches into the chunk from outside it.
 */
export function officeStaticChunkTiles(args: {
  readonly projector: OfficeProjector;
  readonly cols: number;
  readonly rows: number;
  readonly chunk: OfficeRect;
}): OfficeTileRect {
  const { chunk, cols, projector, rows } = args;
  const whole: OfficeTileRect = { col: 0, row: 0, cols, rows };
  const origin = projector.project(0, 0);
  const alongCol = delta(projector.project(1, 0), origin);
  const alongRow = delta(projector.project(0, 1), origin);
  const determinant = alongCol.x * alongRow.y - alongRow.x * alongCol.y;
  if (determinant === 0) return whole;
  // Probed at the near corner AND at the far one: a projection that bends only
  // over distance agrees with its own first step and disagrees across a world.
  if (
    !projectsAffinely({ projector, origin, alongCol, alongRow, col: 1, row: 1 })
  ) {
    return whole;
  }
  if (
    !projectsAffinely({
      projector,
      origin,
      alongCol,
      alongRow,
      col: cols,
      row: rows,
    })
  ) {
    return whole;
  }
  const bleed = OFFICE_STATIC_CHUNK_BLEED_PX;
  const left = chunk.x - bleed;
  const top = chunk.y - bleed;
  const right = chunk.x + chunk.width + bleed;
  const bottom = chunk.y + chunk.height + bleed;
  let minCol = Number.POSITIVE_INFINITY;
  let maxCol = Number.NEGATIVE_INFINITY;
  let minRow = Number.POSITIVE_INFINITY;
  let maxRow = Number.NEGATIVE_INFINITY;
  for (const corner of [
    { x: left, y: top },
    { x: right, y: top },
    { x: left, y: bottom },
    { x: right, y: bottom },
  ]) {
    const offsetX = corner.x - origin.x;
    const offsetY = corner.y - origin.y;
    const col = (offsetX * alongRow.y - alongRow.x * offsetY) / determinant;
    const row = (alongCol.x * offsetY - offsetX * alongCol.y) / determinant;
    minCol = Math.min(minCol, col);
    maxCol = Math.max(maxCol, col);
    minRow = Math.min(minRow, row);
    maxRow = Math.max(maxRow, row);
  }
  const firstCol = Math.max(0, Math.floor(minCol));
  const firstRow = Math.max(0, Math.floor(minRow));
  const endCol = Math.min(cols, Math.ceil(maxCol) + 1);
  const endRow = Math.min(rows, Math.ceil(maxRow) + 1);
  return {
    col: firstCol,
    row: firstRow,
    cols: Math.max(0, endCol - firstCol),
    rows: Math.max(0, endRow - firstRow),
  };
}

/** Sub-pixel slack for the affinity check; a projector is built from integers. */
const AFFINE_TOLERANCE_PX = 0.001;

/** Whether one probe lands where the recovered mapping says it should. */
function projectsAffinely(args: {
  readonly projector: OfficeProjector;
  readonly origin: OfficePoint;
  readonly alongCol: OfficePoint;
  readonly alongRow: OfficePoint;
  readonly col: number;
  readonly row: number;
}): boolean {
  const { alongCol, alongRow, col, origin, projector, row } = args;
  const probe = delta(projector.project(col, row), origin);
  return (
    Math.abs(probe.x - (alongCol.x * col + alongRow.x * row)) <=
      AFFINE_TOLERANCE_PX &&
    Math.abs(probe.y - (alongCol.y * col + alongRow.y * row)) <=
      AFFINE_TOLERANCE_PX
  );
}

function delta(point: OfficePoint, origin: OfficePoint): OfficePoint {
  return { x: point.x - origin.x, y: point.y - origin.y };
}

/** One chunk of the floor, painted. */
interface HeldChunk {
  readonly rect: OfficeRect;
  readonly surface: OfficeStaticSurface;
}

function chunkIdOf(chunk: OfficeStaticChunk): string {
  return `${chunk.chunkCol},${chunk.chunkRow}`;
}

export class OfficeStaticLayer {
  private readonly create: OfficeStaticSurfaceFactory;
  /**
   * The bitmaps in hand, in INSERTION order - which is what makes eviction
   * least-recently-drawn: a chunk the frame asks for again is deleted and
   * re-inserted, so the oldest key is the one nothing has drawn in longest.
   */
  private readonly held = new Map<string, HeldChunk>();
  private key: OfficeStaticLayerKey | null = null;
  /**
   * Set once the factory has answered `null` for a real size: a platform with
   * no offscreen 2D context does not grow one between frames, so asking again
   * at frame cadence would only allocate a canvas per frame to throw away.
   * `release()` forgets it, in case the layer is reused somewhere it works.
   */
  private unsupported = false;
  /** Counts chunk repaints, so a test can prove a frame did NOT cause one. */
  private paints = 0;

  constructor(create: OfficeStaticSurfaceFactory) {
    this.create = create;
  }

  get paintCount(): number {
    return this.paints;
  }

  /** How many chunks are held. The budget is asserted on this. */
  get chunkCount(): number {
    return this.held.size;
  }

  /**
   * Every pixel this layer is holding. Suspension has to take it to zero, and
   * "zero bitmaps" is the only form of that claim a test can check.
   */
  get heldPixels(): number {
    let pixels = 0;
    for (const chunk of this.held.values()) {
      pixels += chunk.surface.canvas.width * chunk.surface.canvas.height;
    }
    return pixels;
  }

  /**
   * The chunks to blit this frame, in the order they were asked for, baking
   * whichever of them are not already in hand.
   *
   * EMPTY MEANS DRAW THE FLOOR. A caller gets nothing back when there is no
   * offscreen surface to be had, when the plan holds no chunks (overview, or a
   * view too large for the budget), or when any one chunk of the set could not
   * be made - never a partial set, because a floor half blitted and half drawn
   * is a floor drawn twice where the two halves meet.
   */
  sync(args: OfficeStaticSyncArgs): ReadonlyArray<OfficeStaticChunkDraw> {
    const { chunks, key, paint } = args;
    if (this.unsupported) return NO_DRAWS;
    if (key.width <= 0 || key.height <= 0) {
      this.releaseChunks();
      return NO_DRAWS;
    }
    // A new plan, a new band or a new palette: every pixel in hand is stale.
    const current = this.key;
    if (current === null || !officeStaticLayerKeysMatch(current, key)) {
      this.releaseChunks();
      this.key = key;
    }
    if (chunks.length === 0 || chunks.length > OFFICE_STATIC_CHUNK_BUDGET) {
      this.releaseChunks();
      return NO_DRAWS;
    }
    const world: OfficeSize = { width: key.width, height: key.height };
    const draws: OfficeStaticChunkDraw[] = [];
    for (const chunk of chunks) {
      const rect = officeStaticChunkRect(chunk, world);
      // Outside the world entirely: nothing to paint, and nothing to blit.
      if (rect.width <= 0 || rect.height <= 0) continue;
      const held = this.hold(chunk, rect, paint);
      if (held === null) {
        this.unsupported = true;
        this.releaseChunks();
        return NO_DRAWS;
      }
      draws.push({ canvas: held.surface.canvas, x: rect.x, y: rect.y });
    }
    this.evict();
    return draws;
  }

  /** Drops every bitmap. Suspension and unmount; a floor's pixels are real. */
  release(): void {
    this.releaseChunks();
    this.key = null;
    this.unsupported = false;
  }

  /** The chunk in hand, baked first if this is the first frame to want it. */
  private hold(
    chunk: OfficeStaticChunk,
    rect: OfficeRect,
    paint: (ctx: CanvasRenderingContext2D, chunk: OfficeRect) => void,
  ): HeldChunk | null {
    const id = chunkIdOf(chunk);
    const existing = this.held.get(id);
    if (existing !== undefined) {
      // Re-inserted, so this one is now the youngest; see `held`.
      this.held.delete(id);
      this.held.set(id, existing);
      return existing;
    }
    const surface = this.create(rect.width, rect.height);
    if (surface === null) return null;
    surface.ctx.setTransform(1, 0, 0, 1, 0, 0);
    surface.ctx.clearRect(0, 0, rect.width, rect.height);
    surface.ctx.imageSmoothingEnabled = false;
    // The painter works in world coordinates and this square is a window onto
    // them, so the offset goes in the transform rather than into every sprite.
    // Whatever reaches past the square is clipped by the bitmap itself, which
    // is what lets neighbouring chunks each draw the sprite they share.
    surface.ctx.setTransform(1, 0, 0, 1, -rect.x, -rect.y);
    paint(surface.ctx, rect);
    this.paints += 1;
    const held: HeldChunk = { rect, surface };
    this.held.set(id, held);
    return held;
  }

  private evict(): void {
    while (this.held.size > OFFICE_STATIC_CHUNK_BUDGET) {
      const oldest = this.held.entries().next();
      if (oldest.done === true) return;
      const [id, chunk] = oldest.value;
      this.held.delete(id);
      zeroSurface(chunk.surface);
    }
  }

  private releaseChunks(): void {
    for (const chunk of this.held.values()) zeroSurface(chunk.surface);
    this.held.clear();
  }
}

/**
 * Zeroing the dimensions frees the backing store now rather than whenever the
 * element itself is collected.
 */
function zeroSurface(surface: OfficeStaticSurface): void {
  surface.canvas.width = 0;
  surface.canvas.height = 0;
}
