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
  OfficeRect,
  OfficeSize,
  OfficeTheme,
} from "@/lib/comm-graph/office/office-types";

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
 * A chunk's bake reaches past its own edge for the art that spills into it -
 * `OFFICE_PROJECTION_BLEED_PX`, the same reach the scene uses for the floor it
 * draws per frame - and CLIPS the result to its own square. The chunks stay
 * disjoint, so a sprite straddling two of them is drawn once into each and
 * composed whole, never blended twice.
 */

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
  /**
   * The cascade's own revision, which moves for a theme change the MODE cannot
   * see: a custom palette repaints every token while `theme` stays "light".
   * These pixels are baked, not CSS, so nothing repaints them on our behalf.
   */
  readonly themeRevision: number;
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
    a.themeRevision === b.themeRevision &&
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
  const lastCol = lastChunkIndexOf(world.width);
  const lastRow = lastChunkIndexOf(world.height);
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

/**
 * The last chunk of a span that ENDS at `edge`, which the span does not itself
 * include.
 *
 * Not `chunkIndexOf(edge - 1)`. A camera is at a fractional world position and
 * a zoomed viewport is a fractional width, so an edge at 3072.5 lies one pixel
 * into chunk 6 while `edge - 1` lands at 3071.5, back in chunk 5 - and the
 * caller, believing its plan complete, suppresses the per-frame sprite path
 * over the half pixel nobody baked. Half-open arithmetic answers both: an edge
 * exactly on a boundary belongs to the chunk before it, and anything past one
 * belongs to the chunk it reaches into.
 */
function lastChunkIndexOf(edge: number): number {
  return Math.ceil(edge / OFFICE_STATIC_CHUNK_PX) - 1;
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
    lastCol: Math.max(firstCol, Math.min(lastCol, lastChunkIndexOf(right))),
    lastRow: Math.max(firstRow, Math.min(lastRow, lastChunkIndexOf(bottom))),
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

/** A chunk this frame wants, with the work of addressing it done once. */
interface WantedChunk {
  readonly id: string;
  readonly rect: OfficeRect;
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
   * The chunk keys the factory has already refused, BY KEY rather than as one
   * latch over the layer.
   *
   * A platform with no offscreen 2D context does not grow one between frames,
   * so a square that could not be made is not asked for again at frame
   * cadence - that would allocate a canvas a second to throw away. But a
   * refusal is not evidence about the OTHER squares: latching the whole layer
   * meant one null answer retired the cache for the life of the mount, and
   * every later frame returned before it had looked at the camera, the key or
   * the factory at all.
   *
   * Held only for as long as the KEY that gave those coordinates their meaning,
   * and dropped with the bitmaps whenever it changes - a coordinate under a new
   * world size names a different square, of a different size, that this host
   * has never been asked for. `release()` forgets them too, in case the layer
   * is reused somewhere they work.
   */
  private readonly unsupportedChunks = new Set<string>();
  /** Counts chunk repaints, so a test can prove a frame did NOT cause one. */
  private paints = 0;

  /**
   * The ceiling this layer holds itself to, in chunks.
   *
   * Taken rather than read off the module constant so the layer and the PLAN
   * it is handed are bound to one value. They were two: the planner refused a
   * span over the `budget` it was given, while `sync` measured the plan it got
   * back against `OFFICE_STATIC_CHUNK_BUDGET`. A caller planning with a larger
   * budget therefore handed over a legal plan that `sync` rejected wholesale -
   * releasing every held bitmap and returning no draws on every frame, with a
   * silently disabled cache and a slower floor as the only symptom.
   */
  private readonly budget: number;

  constructor(create: OfficeStaticSurfaceFactory, budget: number) {
    this.create = create;
    this.budget = budget;
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
    if (key.width <= 0 || key.height <= 0) {
      this.releaseChunks();
      return NO_DRAWS;
    }
    // A new plan, a new band or a new palette: every pixel in hand is stale.
    const current = this.key;
    if (current === null || !officeStaticLayerKeysMatch(current, key)) {
      this.releaseChunks();
      // AND EVERY REFUSAL WITH THEM. A refusal is remembered by coordinate, but
      // a coordinate only names a chunk while the key holds: the world's size
      // is part of the key, so the square at a given column and row under the
      // new one is a different square of a different size - an 88-wide strip
      // where a 512 failed, say. Keeping the old answer refuses a chunk this
      // host was never asked to make.
      this.unsupportedChunks.clear();
      this.key = key;
    }
    if (chunks.length === 0 || chunks.length > this.budget) {
      this.releaseChunks();
      return NO_DRAWS;
    }
    const world: OfficeSize = { width: key.width, height: key.height };
    const wanted: WantedChunk[] = [];
    for (const chunk of chunks) {
      const rect = officeStaticChunkRect(chunk, world);
      // Outside the world entirely: nothing to paint, and nothing to blit.
      if (rect.width <= 0 || rect.height <= 0) continue;
      const id = chunkIdOf(chunk);
      // A chunk this host has already failed to make. Asked for again at frame
      // cadence it would allocate and throw away a canvas a second and still
      // leave the frame a hole, so the whole frame draws itself instead.
      if (this.unsupportedChunks.has(id)) return NO_DRAWS;
      wanted.push({ id, rect });
    }
    // FREED BEFORE ALLOCATED. The budget is a ceiling on the pixels that
    // EXIST, not on the ones still held when the frame is over: baking this
    // frame's chunks while the ones they replace are still in hand doubles the
    // live backing stores for the width of a pan, which is exactly the moment
    // the office can least afford the memory.
    this.evictFor(wanted);
    const draws: OfficeStaticChunkDraw[] = [];
    for (const entry of wanted) {
      const held = this.hold(entry, paint);
      if (held === null) {
        // ISOLATED TO THE CHUNK. Whatever else is in hand stays: a frame that
        // does not need this square is still entitled to its cached floor, and
        // a host that cannot make one 512-square has not thereby lost the
        // ability to make the others.
        this.unsupportedChunks.add(entry.id);
        return NO_DRAWS;
      }
      draws.push({
        canvas: held.surface.canvas,
        x: entry.rect.x,
        y: entry.rect.y,
      });
    }
    return draws;
  }

  /** Drops every bitmap. Suspension and unmount; a floor's pixels are real. */
  release(): void {
    this.releaseChunks();
    this.key = null;
    this.unsupportedChunks.clear();
  }

  /** The chunk in hand, baked first if this is the first frame to want it. */
  private hold(
    entry: WantedChunk,
    paint: (ctx: CanvasRenderingContext2D, chunk: OfficeRect) => void,
  ): HeldChunk | null {
    const { id, rect } = entry;
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

  /**
   * Frees enough of what is NOT wanted this frame that the whole frame fits
   * inside the budget once it has been baked.
   *
   * The frame's own chunks are never candidates, so a pan that re-asks for a
   * square it already holds cannot evict it to make room for itself. What is
   * left over is kept in least-recently-drawn order, which is what makes a pan
   * back the way it came cheap.
   */
  private evictFor(wanted: ReadonlyArray<WantedChunk>): void {
    const keep = new Set(wanted.map((entry) => entry.id));
    const spare = Math.max(0, this.budget - keep.size);
    let extras = 0;
    for (const id of this.held.keys()) {
      if (!keep.has(id)) extras += 1;
    }
    // OLDEST FIRST, and only as many as the frame's own chunks need room for.
    // `held` is in least-recently-drawn order, so walking it forwards and
    // stopping once `spare` are left evicts the ones nothing has asked for in
    // longest - not the ones asked for most recently, which is what iterating
    // to a quota from the front would do.
    for (const id of [...this.held.keys()]) {
      if (extras <= spare) return;
      if (keep.has(id)) continue;
      const chunk = this.held.get(id);
      if (chunk === undefined) continue;
      this.held.delete(id);
      zeroSurface(chunk.surface);
      extras -= 1;
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
