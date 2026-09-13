import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  OfficeDrawable,
  OfficeRect,
  OfficeSize,
} from "@/lib/comm-graph/office/office-types";
import {
  officeBakesIntoStaticFloor,
  officeStaticChunkRect,
  officeStaticLayerKeysMatch,
  OFFICE_STATIC_CHUNK_BUDGET,
  OFFICE_STATIC_CHUNK_PX,
  OfficeStaticLayer,
  planOfficeStaticChunks,
  type OfficeStaticChunk,
  type OfficeStaticLayerKey,
  type OfficeStaticSurface,
} from "@/components/epic-canvas/comm-graph/office/office-static-layer";

const KEY: OfficeStaticLayerKey = {
  staticVersion: 1,
  theme: "dark",
  themeRevision: 1,
  width: 320,
  height: 240,
};

/** One chunk of a world that is only one chunk big. */
const ORIGIN_CHUNK: ReadonlyArray<OfficeStaticChunk> = [
  { chunkCol: 0, chunkRow: 0 },
];

/**
 * A typed 2D context borrowed from a temporary `getContext` stub - jsdom's own
 * returns null, and a chained cast to put the type back is banned here for the
 * same reason it is everywhere else.
 */
function stubGetContext(): () => void {
  const original = Object.getOwnPropertyDescriptor(
    HTMLCanvasElement.prototype,
    "getContext",
  );
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({
      setTransform: () => undefined,
      clearRect: () => undefined,
      imageSmoothingEnabled: true,
    }),
  });
  return () => {
    if (original === undefined) {
      Reflect.deleteProperty(HTMLCanvasElement.prototype, "getContext");
      return;
    }
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", original);
  };
}

let restoreGetContext: () => void = () => undefined;

beforeEach(() => {
  restoreGetContext = stubGetContext();
});

afterEach(() => {
  restoreGetContext();
});

/**
 * Surfaces whose context records nothing but the calls the layer makes of it,
 * plus the list of every surface handed out - which is how "reused" and
 * "reallocated" are told apart.
 */
function fakeSurfaces(): {
  readonly create: (width: number, height: number) => OfficeStaticSurface;
  readonly made: OfficeStaticSurface[];
} {
  const made: OfficeStaticSurface[] = [];
  return {
    made,
    create: (width, height) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (ctx === null) throw new Error("the stub returned no context");
      const surface: OfficeStaticSurface = { canvas, ctx };
      made.push(surface);
      return surface;
    },
  };
}

describe("officeStaticLayerKeysMatch", () => {
  it("matches a key against itself", () => {
    expect(officeStaticLayerKeysMatch(KEY, { ...KEY })).toBe(true);
  });

  it.each([
    ["staticVersion", { staticVersion: 2 }],
    ["theme", { theme: "light" as const }],
    ["width", { width: 321 }],
    ["height", { height: 241 }],
  ])("separates two keys differing only in %s", (_field, difference) => {
    expect(officeStaticLayerKeysMatch(KEY, { ...KEY, ...difference })).toBe(
      false,
    );
  });
});

describe("OfficeStaticLayer", () => {
  it("paints once and blits the same canvas thereafter", () => {
    const { create } = fakeSurfaces();
    const layer = new OfficeStaticLayer(create, OFFICE_STATIC_CHUNK_BUDGET);
    const paint = vi.fn();

    const first = layer.sync({ key: KEY, chunks: ORIGIN_CHUNK, paint });
    const second = layer.sync({ key: { ...KEY }, chunks: ORIGIN_CHUNK, paint });
    const third = layer.sync({ key: { ...KEY }, chunks: ORIGIN_CHUNK, paint });

    // The whole point: thirty frames a second cost one paint, not thirty.
    expect(paint).toHaveBeenCalledTimes(1);
    expect(layer.paintCount).toBe(1);
    // Handing back NOTHING is a real answer from `sync` - a refused chunk is
    // simply absent - so the count is asserted before the canvases are read.
    // Indexing an empty result instead reports a TypeError about `canvas`,
    // which names neither the chunk that went missing nor the sync that
    // dropped it.
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(third).toHaveLength(1);
    expect(second[0].canvas).toBe(first[0].canvas);
    expect(third[0].canvas).toBe(first[0].canvas);
  });

  it("paints each chunk once and hands them back in the order asked for", () => {
    const { create } = fakeSurfaces();
    const layer = new OfficeStaticLayer(create, OFFICE_STATIC_CHUNK_BUDGET);
    const paint = vi.fn();
    const world: OfficeStaticLayerKey = { ...KEY, width: 1600, height: 1200 };
    const chunks: ReadonlyArray<OfficeStaticChunk> = [
      { chunkCol: 0, chunkRow: 0 },
      { chunkCol: 1, chunkRow: 0 },
      { chunkCol: 1, chunkRow: 1 },
    ];

    const drawn = layer.sync({ key: world, chunks, paint });
    const again = layer.sync({ key: world, chunks, paint });

    expect(paint).toHaveBeenCalledTimes(3);
    expect(layer.chunkCount).toBe(3);
    expect(drawn.map((chunk) => [chunk.x, chunk.y])).toEqual([
      [0, 0],
      [OFFICE_STATIC_CHUNK_PX, 0],
      [OFFICE_STATIC_CHUNK_PX, OFFICE_STATIC_CHUNK_PX],
    ]);
    expect(again.map((chunk) => chunk.canvas)).toEqual(
      drawn.map((chunk) => chunk.canvas),
    );
  });

  it("paints a chunk in world space, so a painter needs no chunk offset", () => {
    const { create, made } = fakeSurfaces();
    const layer = new OfficeStaticLayer(create, OFFICE_STATIC_CHUNK_BUDGET);
    const transforms: ReadonlyArray<number>[] = [];
    const surface = made;
    const chunk: OfficeStaticChunk = { chunkCol: 1, chunkRow: 2 };

    layer.sync({
      key: { ...KEY, width: 1600, height: 1600 },
      chunks: [chunk],
      paint: (ctx, rect) => {
        transforms.push([rect.x, rect.y, rect.width, rect.height]);
        // The context the painter is handed is already offset, so a sprite at
        // a world coordinate lands in the chunk without the painter knowing
        // there are chunks at all.
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      },
    });

    expect(transforms).toEqual([
      [
        OFFICE_STATIC_CHUNK_PX,
        OFFICE_STATIC_CHUNK_PX * 2,
        OFFICE_STATIC_CHUNK_PX,
        OFFICE_STATIC_CHUNK_PX,
      ],
    ]);
    expect(surface[0].canvas.width).toBe(OFFICE_STATIC_CHUNK_PX);
  });

  it("crops the chunks at the world's edge rather than over-allocating", () => {
    const { create, made } = fakeSurfaces();
    const layer = new OfficeStaticLayer(create, OFFICE_STATIC_CHUNK_BUDGET);

    layer.sync({
      key: { ...KEY, width: 600, height: 700 },
      chunks: [
        { chunkCol: 0, chunkRow: 0 },
        { chunkCol: 1, chunkRow: 1 },
      ],
      paint: () => undefined,
    });

    expect([made[0].canvas.width, made[0].canvas.height]).toEqual([
      OFFICE_STATIC_CHUNK_PX,
      OFFICE_STATIC_CHUNK_PX,
    ]);
    expect([made[1].canvas.width, made[1].canvas.height]).toEqual([
      600 - OFFICE_STATIC_CHUNK_PX,
      700 - OFFICE_STATIC_CHUNK_PX,
    ]);
  });

  it("repaints when the floor's version moves", () => {
    const { create } = fakeSurfaces();
    const layer = new OfficeStaticLayer(create, OFFICE_STATIC_CHUNK_BUDGET);
    const paint = vi.fn();
    layer.sync({ key: KEY, chunks: ORIGIN_CHUNK, paint });

    layer.sync({
      key: { ...KEY, staticVersion: 2 },
      chunks: ORIGIN_CHUNK,
      paint,
    });

    expect(paint).toHaveBeenCalledTimes(2);
  });

  it("repaints when the theme flips, since the palette is in the pixels", () => {
    const { create } = fakeSurfaces();
    const layer = new OfficeStaticLayer(create, OFFICE_STATIC_CHUNK_BUDGET);
    const paint = vi.fn();
    layer.sync({ key: KEY, chunks: ORIGIN_CHUNK, paint });

    layer.sync({
      key: { ...KEY, theme: "light" },
      chunks: ORIGIN_CHUNK,
      paint,
    });

    expect(paint).toHaveBeenCalledTimes(2);
  });

  it("drops every chunk it held when the key moves", () => {
    const { create, made } = fakeSurfaces();
    const layer = new OfficeStaticLayer(create, OFFICE_STATIC_CHUNK_BUDGET);
    layer.sync({ key: KEY, chunks: ORIGIN_CHUNK, paint: () => undefined });

    layer.sync({
      key: { ...KEY, staticVersion: 2 },
      chunks: ORIGIN_CHUNK,
      paint: () => undefined,
    });

    // A chunk of the previous plan is pixels of a floor that no longer exists,
    // and it is zeroed rather than left in hand until it is collected.
    expect(made).toHaveLength(2);
    expect(made[0].canvas.width).toBe(0);
    expect(made[0].canvas.height).toBe(0);
    expect(layer.chunkCount).toBe(1);
  });

  it("evicts the least recently drawn chunk past the budget", () => {
    const { create } = fakeSurfaces();
    const layer = new OfficeStaticLayer(create, OFFICE_STATIC_CHUNK_BUDGET);
    const key: OfficeStaticLayerKey = { ...KEY, width: 65_536, height: 1024 };
    const paint = vi.fn();
    const chunkAt = (col: number): OfficeStaticChunk => ({
      chunkCol: col,
      chunkRow: 0,
    });
    // A pan along a long floor, a chunk at a time, well past the budget.
    for (let col = 0; col < OFFICE_STATIC_CHUNK_BUDGET; col += 1) {
      layer.sync({ key, chunks: [chunkAt(col)], paint });
    }
    expect(layer.chunkCount).toBe(OFFICE_STATIC_CHUNK_BUDGET);
    // The oldest is re-drawn, which makes it the youngest; the SECOND chunk is
    // now the one nothing has asked for in longest.
    layer.sync({ key, chunks: [chunkAt(0)], paint });
    expect(paint).toHaveBeenCalledTimes(OFFICE_STATIC_CHUNK_BUDGET);

    layer.sync({ key, chunks: [chunkAt(OFFICE_STATIC_CHUNK_BUDGET)], paint });

    expect(layer.chunkCount).toBe(OFFICE_STATIC_CHUNK_BUDGET);
    // Chunk 0 is still in hand - insertion order would have evicted it - and
    // chunk 1 is the one that went.
    layer.sync({ key, chunks: [chunkAt(0)], paint });
    expect(paint).toHaveBeenCalledTimes(OFFICE_STATIC_CHUNK_BUDGET + 1);
    layer.sync({ key, chunks: [chunkAt(1)], paint });
    expect(paint).toHaveBeenCalledTimes(OFFICE_STATIC_CHUNK_BUDGET + 2);
  });

  it("admits a plan up to the budget it was constructed with, not the module's default ceiling", () => {
    // THE CONSTRUCTOR'S OWN NUMBER, not `OFFICE_STATIC_CHUNK_BUDGET`. Every
    // other case in this suite passes 24 for both, so a `sync` that measured
    // the plan against the module constant instead of `this.budget` would be
    // invisible here - a caller planning with a LARGER budget is the only
    // camera position that can tell the two apart, and this is it.
    const { create } = fakeSurfaces();
    const key: OfficeStaticLayerKey = {
      staticVersion: 1,
      theme: "dark",
      themeRevision: 0,
      width: 5120,
      height: 5120,
    };
    const chunks = planOfficeStaticChunks({
      world: key,
      view: { x: 512, y: 512, width: 1536, height: 1536 },
      lod: 1,
      budget: 25,
    });
    expect(chunks).toHaveLength(25);

    const layer = new OfficeStaticLayer(create, 25);
    const paint = vi.fn();

    const drawn = layer.sync({ key, chunks, paint });

    // Reverted to the module constant, `sync` would measure this legal
    // 25-chunk plan against 24, refuse the whole set, and draw nothing.
    expect(drawn).toHaveLength(25);
  });

  it("evicts down to the budget it was constructed with, not the module's default ceiling", () => {
    // THE CONSTRUCTOR'S OWN NUMBER, not `OFFICE_STATIC_CHUNK_BUDGET`, on the
    // other side of the same seam: a budget SMALLER than the module constant
    // is the only camera position that can tell `evictFor` apart from a
    // version that spared room for 24 regardless of what this layer was built
    // with.
    const { create } = fakeSurfaces();
    const layer = new OfficeStaticLayer(create, 2);
    const key: OfficeStaticLayerKey = { ...KEY, width: 65_536, height: 1024 };
    const paint = vi.fn();
    const chunkAt = (col: number): OfficeStaticChunk => ({
      chunkCol: col,
      chunkRow: 0,
    });

    // A pan along a long floor, a chunk at a time, well past this layer's own
    // two-chunk budget.
    for (let col = 0; col < 6; col += 1) {
      layer.sync({ key, chunks: [chunkAt(col)], paint });
    }

    // Reverted to the module constant, `evictFor` would spare room for 24 and
    // this six-chunk pan would still be sitting in it whole.
    expect(layer.heldPixels).toBe(2 * OFFICE_STATIC_CHUNK_PX ** 2);
    expect(layer.chunkCount).toBe(2);
  });

  it("never lets live surfaces exceed the budget while a sync is allocating, not only once it returns", () => {
    // THE PEAK DURING SYNC, not the retained total after. `sync()` used to
    // create every newly requested surface BEFORE evicting the ones the new
    // camera no longer needs, so the simultaneously live backing stores at
    // their worst moment could be nearly double the budget - three ordinary
    // views panned in turn plan 12, 12 and 24 chunks here, and before the fix
    // the peak measured 48 against this 24-chunk ceiling. Counting inside
    // the FACTORY is what catches this: `heldPixels`, read only after each
    // `sync()` returns, is the number the shipped "never holds more pixels"
    // case below already asserted, and it was green throughout.
    const made: HTMLCanvasElement[] = [];
    let peak = 0;
    const create = (width: number, height: number): OfficeStaticSurface => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (ctx === null) throw new Error("the stub returned no context");
      made.push(canvas);
      // A zeroed canvas (`evictFor` sets width and height to 0) contributes
      // nothing to this sum, so a surface freed before the next one is made
      // is not counted as still live.
      peak = Math.max(
        peak,
        made.reduce((sum, c) => sum + c.width * c.height, 0),
      );
      return { canvas, ctx };
    };
    const layer = new OfficeStaticLayer(create, OFFICE_STATIC_CHUNK_BUDGET);
    const world: OfficeSize = { width: 12000, height: 12000 };
    const plannedCounts: number[] = [];

    for (const at of [1000, 5000, 9000]) {
      const chunks = planOfficeStaticChunks({
        world,
        view: { x: at, y: at, width: 1280, height: 700 },
        lod: 1,
        budget: OFFICE_STATIC_CHUNK_BUDGET,
      });
      plannedCounts.push(chunks.length);
      layer.sync({
        key: { ...world, staticVersion: 1, theme: "dark", themeRevision: 1 },
        chunks,
        paint: () => undefined,
      });
    }

    // Anti-vacuity: the review's own fixture, which is what makes 24 a
    // ceiling actually under pressure rather than one no view here reaches.
    expect(plannedCounts).toEqual([12, 12, 24]);
    expect(peak).toBeLessThanOrEqual(
      OFFICE_STATIC_CHUNK_BUDGET * OFFICE_STATIC_CHUNK_PX ** 2,
    );
    expect(layer.heldPixels).toBeLessThanOrEqual(
      OFFICE_STATIC_CHUNK_BUDGET * OFFICE_STATIC_CHUNK_PX ** 2,
    );
  });

  it("never holds more pixels than the budget allows", () => {
    const { create } = fakeSurfaces();
    const layer = new OfficeStaticLayer(create, OFFICE_STATIC_CHUNK_BUDGET);
    const key: OfficeStaticLayerKey = { ...KEY, width: 65_536, height: 65_536 };
    for (let col = 0; col < 80; col += 1) {
      layer.sync({
        key,
        chunks: [{ chunkCol: col, chunkRow: col }],
        paint: () => undefined,
      });
    }

    expect(layer.heldPixels).toBeLessThanOrEqual(
      OFFICE_STATIC_CHUNK_BUDGET * OFFICE_STATIC_CHUNK_PX ** 2,
    );
  });

  it("holds nothing while the office is suspended", () => {
    const { create } = fakeSurfaces();
    const layer = new OfficeStaticLayer(create, OFFICE_STATIC_CHUNK_BUDGET);
    layer.sync({ key: KEY, chunks: ORIGIN_CHUNK, paint: () => undefined });
    expect(layer.heldPixels).toBeGreaterThan(0);

    // What the canvas does the moment the tile stops being eligible.
    layer.release();

    expect(layer.heldPixels).toBe(0);
    expect(layer.chunkCount).toBe(0);
  });

  it("drops the bitmap on release and repaints if asked again", () => {
    const { create, made } = fakeSurfaces();
    const layer = new OfficeStaticLayer(create, OFFICE_STATIC_CHUNK_BUDGET);
    const paint = vi.fn();
    layer.sync({ key: KEY, chunks: ORIGIN_CHUNK, paint });

    layer.release();

    expect(made[0].canvas.width).toBe(0);
    layer.sync({ key: KEY, chunks: ORIGIN_CHUNK, paint });
    expect(paint).toHaveBeenCalledTimes(2);
  });

  it("bakes nothing for a floor with no area yet", () => {
    const { create } = fakeSurfaces();
    const layer = new OfficeStaticLayer(create, OFFICE_STATIC_CHUNK_BUDGET);
    const paint = vi.fn();

    // The first frames of a tile that has not been laid out.
    expect(
      layer.sync({ key: { ...KEY, width: 0 }, chunks: ORIGIN_CHUNK, paint }),
    ).toEqual([]);
    expect(
      layer.sync({ key: { ...KEY, height: 0 }, chunks: ORIGIN_CHUNK, paint }),
    ).toEqual([]);
    expect(paint).not.toHaveBeenCalled();
  });

  it("bakes nothing when the plan holds no chunks", () => {
    const { create } = fakeSurfaces();
    const layer = new OfficeStaticLayer(create, OFFICE_STATIC_CHUNK_BUDGET);
    const paint = vi.fn();
    layer.sync({ key: KEY, chunks: ORIGIN_CHUNK, paint });

    // Overview: the planner answers with nothing, and the pixels go with it.
    const drawn = layer.sync({ key: KEY, chunks: [], paint });

    expect(drawn).toEqual([]);
    expect(layer.heldPixels).toBe(0);
    expect(paint).toHaveBeenCalledTimes(1);
  });

  it("reports no layer where the host has no 2D context at all", () => {
    // jsdom, and any canvas-less host. The caller draws the floor tile by tile
    // instead: the blit is an optimization, never a requirement.
    const layer = new OfficeStaticLayer(() => null, OFFICE_STATIC_CHUNK_BUDGET);
    const paint = vi.fn();

    expect(layer.sync({ key: KEY, chunks: ORIGIN_CHUNK, paint })).toEqual([]);
    expect(paint).not.toHaveBeenCalled();
  });

  it("hands back nothing rather than a half-baked set of chunks", () => {
    // Half the floor blitted and half of it drawn is the floor drawn TWICE
    // where the two meet, so a set that cannot be completed is not a set.
    let made = 0;
    const layer = new OfficeStaticLayer((width, height) => {
      made += 1;
      if (made > 1) return null;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (ctx === null) throw new Error("the stub returned no context");
      return { canvas, ctx };
    }, OFFICE_STATIC_CHUNK_BUDGET);

    const drawn = layer.sync({
      key: { ...KEY, width: 1600, height: 600 },
      chunks: [
        { chunkCol: 0, chunkRow: 0 },
        { chunkCol: 1, chunkRow: 0 },
      ],
      paint: () => undefined,
    });

    expect(drawn).toEqual([]);
    // THE SQUARE THAT WORKED IS KEPT, and this is the half of the rule that
    // changed: a refusal is evidence about ONE chunk, not about the layer. The
    // frame that needed both draws itself, and the bitmap that was made stays
    // in hand for the frame that needs only it - which the case below is.
    expect(layer.chunkCount).toBe(1);
  });

  it("isolates a refusal to the chunk that was refused", () => {
    // A whole cache retired by one null answer was the defect: every later
    // frame returned before it had looked at the camera, the key or the
    // factory, so an office whose second square happened to fail drew every
    // sprite of its floor by hand for the life of the mount.
    let made = 0;
    const attempted: string[] = [];
    const layer = new OfficeStaticLayer((width, height) => {
      made += 1;
      attempted.push(`${width}x${height}`);
      // The second square, and only the second.
      if (made === 2) return null;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (ctx === null) throw new Error("the stub returned no context");
      return { canvas, ctx };
    }, OFFICE_STATIC_CHUNK_BUDGET);
    const key = { ...KEY, width: 2048, height: 600 };

    const first = layer.sync({
      key,
      chunks: [{ chunkCol: 0, chunkRow: 0 }],
      paint: () => undefined,
    });
    const refused = layer.sync({
      key,
      chunks: [{ chunkCol: 1, chunkRow: 0 }],
      paint: () => undefined,
    });
    const again = layer.sync({
      key,
      chunks: [{ chunkCol: 1, chunkRow: 0 }],
      paint: () => undefined,
    });
    const elsewhere = layer.sync({
      key,
      chunks: [{ chunkCol: 2, chunkRow: 0 }],
      paint: () => undefined,
    });

    expect(first).toHaveLength(1);
    // The frame that needs the refused square draws itself, whole.
    expect(refused).toEqual([]);
    expect(again).toEqual([]);
    // And is not asked for a second time: two attempts for the two squares
    // that were tried once each, and a third for the unrelated one - never a
    // fourth for the one already known to fail.
    expect(attempted).toHaveLength(3);
    // The square nothing is wrong with is cached like any other.
    expect(elsewhere).toHaveLength(1);
  });

  it("forgets a chunk's failure once the layer key changes under it", () => {
    // A refusal is remembered by `chunkCol,chunkRow` alone, but a coordinate
    // only names one SQUARE while the key that produced it holds: the world
    // size is part of the key, so the same coordinates under a new width or
    // height are a different square, of a different size, that this host has
    // never actually been asked to make. Keeping the old refusal there
    // refuses a chunk on a flag no chunk could clear - the whole-layer latch
    // this suite already regressed once, reintroduced one coordinate at a
    // time instead of across the whole mount.
    const attempted: string[] = [];
    const layer = new OfficeStaticLayer((width, height) => {
      attempted.push(`${width}x${height}`);
      // The OLD key's square at (1, 0) is a full, uncropped 512x512 chunk,
      // and this host cannot make one; every other size below succeeds.
      if (width === 512 && height === 512) return null;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (ctx === null) throw new Error("the stub returned no context");
      return { canvas, ctx };
    }, OFFICE_STATIC_CHUNK_BUDGET);
    const chunk: OfficeStaticChunk = { chunkCol: 1, chunkRow: 0 };
    const failingKey: OfficeStaticLayerKey = {
      ...KEY,
      width: 1024,
      height: 512,
    };

    const first = layer.sync({
      key: failingKey,
      chunks: [chunk],
      paint: () => undefined,
    });

    // INVARIANT, kept green: no partial floor. A chunk this host cannot make
    // draws nothing at all, never a hole where it would have gone.
    expect(first).toEqual([]);
    expect(attempted).toEqual(["512x512"]);

    const again = layer.sync({
      key: failingKey,
      chunks: [chunk],
      paint: () => undefined,
    });

    // INVARIANT, kept green: no re-attempt at frame cadence for the SAME
    // failed key. A platform that cannot make one 512-square does not grow
    // one between frames, so asking again would only allocate and throw away
    // a canvas a second.
    expect(again).toEqual([]);
    expect(attempted).toEqual(["512x512"]);

    // THE FIX: a NEW key - here a narrower world, which is enough on its own
    // for `officeStaticLayerKeysMatch` to call it a different key - names a
    // different square at the very same (chunkCol, chunkRow): cropped to 88
    // wide against the old key's full 512. The failure recorded under the old
    // key says nothing about this square.
    const succeedingKey: OfficeStaticLayerKey = {
      ...KEY,
      width: 600,
      height: 512,
    };

    const drawn = layer.sync({
      key: succeedingKey,
      chunks: [chunk],
      paint: () => undefined,
    });

    // The factory IS asked for the replacement square, and it succeeds.
    expect(attempted).toEqual(["512x512", "88x512"]);
    expect(drawn).toHaveLength(1);
    expect(drawn[0].x).toBe(512);
    expect(drawn[0].y).toBe(0);
    expect(drawn[0].canvas.width).toBe(88);
    expect(drawn[0].canvas.height).toBe(512);
    expect(layer.chunkCount).toBe(1);
  });
});

// ---- The planner ------------------------------------------------------- //

/** The review's largest world: a thousand independent roots, in sprite px. */
const BIG_WORLD: OfficeSize = { width: 3456, height: 7696 };

function viewAt(args: {
  readonly x: number;
  readonly y: number;
  readonly viewport: OfficeSize;
  readonly zoom: number;
}): OfficeRect {
  const { viewport, x, y, zoom } = args;
  return {
    x,
    y,
    width: viewport.width / zoom,
    height: viewport.height / zoom,
  };
}

function chunkSpanOf(chunks: ReadonlyArray<OfficeStaticChunk>): {
  readonly firstCol: number;
  readonly lastCol: number;
  readonly firstRow: number;
  readonly lastRow: number;
} {
  const cols = chunks.map((chunk) => chunk.chunkCol);
  const rows = chunks.map((chunk) => chunk.chunkRow);
  return {
    firstCol: Math.min(...cols),
    lastCol: Math.max(...cols),
    firstRow: Math.min(...rows),
    lastRow: Math.max(...rows),
  };
}

describe("planOfficeStaticChunks", () => {
  it("holds nothing at overview, whatever the camera can see", () => {
    // The lod-0 floor is a few dozen filled rects; a world's worth of bitmap
    // to blit them is the largest allocation the office makes, for the
    // cheapest thing it draws.
    expect(
      planOfficeStaticChunks({
        world: BIG_WORLD,
        view: { x: 0, y: 0, width: BIG_WORLD.width, height: BIG_WORLD.height },
        lod: 0,
        budget: OFFICE_STATIC_CHUNK_BUDGET,
      }),
    ).toEqual([]);
  });

  it.each([0.7, 0.9, 1, 1.6, 2, 4])(
    "never exceeds the budget at zoom %f, wherever the camera is",
    (zoom) => {
      for (const viewport of [
        { width: 1280, height: 700 },
        { width: 2560, height: 1400 },
        { width: 680, height: 440 },
      ]) {
        for (let x = -1024; x < BIG_WORLD.width + 1024; x += 377) {
          for (let y = -1024; y < BIG_WORLD.height + 1024; y += 613) {
            const chunks = planOfficeStaticChunks({
              world: BIG_WORLD,
              view: viewAt({ x, y, viewport, zoom }),
              lod: 1,
              budget: OFFICE_STATIC_CHUNK_BUDGET,
            });
            expect(chunks.length).toBeLessThanOrEqual(
              OFFICE_STATIC_CHUNK_BUDGET,
            );
          }
        }
      }
    },
  );

  it("covers the whole view wherever it holds anything at all", () => {
    // The renderer skips the floor's sprites the moment it is handed a chunk,
    // so a plan that covered only part of the view would leave a hole in the
    // floor rather than a slower frame.
    for (let x = -600; x < BIG_WORLD.width + 600; x += 311) {
      for (let y = -600; y < BIG_WORLD.height + 600; y += 517) {
        const view = viewAt({
          x,
          y,
          viewport: { width: 1280, height: 700 },
          zoom: 1,
        });
        const chunks = planOfficeStaticChunks({
          world: BIG_WORLD,
          view,
          lod: 1,
          budget: OFFICE_STATIC_CHUNK_BUDGET,
        });
        if (chunks.length === 0) continue;
        const span = chunkSpanOf(chunks);
        const left = Math.max(0, view.x);
        const top = Math.max(0, view.y);
        const right = Math.min(BIG_WORLD.width, view.x + view.width);
        const bottom = Math.min(BIG_WORLD.height, view.y + view.height);
        expect(span.firstCol * OFFICE_STATIC_CHUNK_PX).toBeLessThanOrEqual(
          left,
        );
        expect(span.firstRow * OFFICE_STATIC_CHUNK_PX).toBeLessThanOrEqual(top);
        expect(
          (span.lastCol + 1) * OFFICE_STATIC_CHUNK_PX,
        ).toBeGreaterThanOrEqual(right);
        expect(
          (span.lastRow + 1) * OFFICE_STATIC_CHUNK_PX,
        ).toBeGreaterThanOrEqual(bottom);
      }
    }
  });

  it("bakes one chunk of margin around what the camera can see", () => {
    // What a pan crosses into. Without it the chunk at the leading edge is
    // baked on the frame it becomes visible, which is the frame least able to
    // afford it.
    const chunks = planOfficeStaticChunks({
      world: { width: 4096, height: 4096 },
      view: { x: 1100, y: 1100, width: 100, height: 100 },
      lod: 1,
      budget: OFFICE_STATIC_CHUNK_BUDGET,
    });

    expect(chunkSpanOf(chunks)).toEqual({
      firstCol: 1,
      lastCol: 3,
      firstRow: 1,
      lastRow: 3,
    });
    expect(chunks).toHaveLength(9);
  });

  it("clamps the margin to the world rather than planning chunks off it", () => {
    const chunks = planOfficeStaticChunks({
      world: { width: 700, height: 700 },
      view: { x: 0, y: 0, width: 100, height: 100 },
      lod: 1,
      budget: OFFICE_STATIC_CHUNK_BUDGET,
    });

    expect(chunks).toEqual([
      { chunkCol: 0, chunkRow: 0 },
      { chunkCol: 1, chunkRow: 0 },
      { chunkCol: 0, chunkRow: 1 },
      { chunkCol: 1, chunkRow: 1 },
    ]);
  });

  it("drops the margin before it drops a chunk the camera can see", () => {
    // Six by four is the budget exactly; the margin ring around it is not.
    const chunks = planOfficeStaticChunks({
      world: BIG_WORLD,
      view: {
        x: OFFICE_STATIC_CHUNK_PX,
        y: OFFICE_STATIC_CHUNK_PX,
        width: OFFICE_STATIC_CHUNK_PX * 6,
        height: OFFICE_STATIC_CHUNK_PX * 4,
      },
      lod: 1,
      budget: OFFICE_STATIC_CHUNK_BUDGET,
    });

    expect(chunks).toHaveLength(OFFICE_STATIC_CHUNK_BUDGET);
    expect(chunkSpanOf(chunks)).toEqual({
      firstCol: 1,
      lastCol: 6,
      firstRow: 1,
      lastRow: 4,
    });
  });

  it("holds nothing rather than part of a floor too large for the budget", () => {
    const chunks = planOfficeStaticChunks({
      world: BIG_WORLD,
      view: {
        x: 0,
        y: 0,
        width: OFFICE_STATIC_CHUNK_PX * 7,
        height: OFFICE_STATIC_CHUNK_PX * 4,
      },
      lod: 1,
      budget: OFFICE_STATIC_CHUNK_BUDGET,
    });

    expect(chunks).toEqual([]);
  });

  it("holds nothing for a view that misses the world", () => {
    expect(
      planOfficeStaticChunks({
        world: BIG_WORLD,
        view: { x: -4000, y: -4000, width: 1280, height: 700 },
        lod: 1,
        budget: OFFICE_STATIC_CHUNK_BUDGET,
      }),
    ).toEqual([]);
  });

  it("holds nothing for a world with no area yet", () => {
    expect(
      planOfficeStaticChunks({
        world: { width: 0, height: 0 },
        view: { x: 0, y: 0, width: 1280, height: 700 },
        lod: 1,
        budget: OFFICE_STATIC_CHUNK_BUDGET,
      }),
    ).toEqual([]);
  });

  it("covers a fractional viewport edge even where the margin is dropped for the budget", () => {
    // NOT `chunkIndexOf(edge - 1)`. A camera sits at a fractional world
    // position and a zoomed viewport is a fractional width, so an edge at x
    // 3072.5 lies one pixel into chunk 6 while `edge - 1` lands at 3071.5,
    // back in chunk 5 - and the caller, believing its plan complete,
    // suppresses the per-frame sprite path over the half pixel nobody baked.
    // World 12000x12000 at zoom 0.7 pushes the margin over the 24-chunk
    // budget, so this is the plan's raw visible span with no margin to paper
    // over a shortfall - exactly where the bug showed a background pixel.
    const world: OfficeSize = { width: 12000, height: 12000 };
    const rect: OfficeRect = {
      x: 1243.9285714285713,
      y: 1100,
      width: 1828.5714285714287,
      height: 1000.0000000000001,
    };

    const chunks = planOfficeStaticChunks({
      world,
      view: rect,
      lod: 1,
      budget: 24,
    });
    const right = Math.max(
      ...chunks.map((chunk) => (chunk.chunkCol + 1) * OFFICE_STATIC_CHUNK_PX),
    );
    const bottom = Math.max(
      ...chunks.map((chunk) => (chunk.chunkRow + 1) * OFFICE_STATIC_CHUNK_PX),
    );

    expect(chunks.length).toBeGreaterThan(0);
    expect(right).toBeGreaterThanOrEqual(rect.x + rect.width);
    expect(bottom).toBeGreaterThanOrEqual(rect.y + rect.height);
  });

  it("covers an integer viewport edge that lands exactly on a chunk boundary", () => {
    // The other direction from the fractional case above: an edge exactly ON
    // a chunk boundary belongs to the chunk BEFORE it, so the plan must not
    // reach one chunk further than the view needs. Half-open coverage is a
    // claim about BOTH directions, and a fixture whose edges are all
    // fractional cannot show a plan that over-covers by rounding the wrong
    // way at an exact boundary.
    const world: OfficeSize = { width: 12000, height: 12000 };
    const rect: OfficeRect = { x: 1024, y: 1024, width: 2048, height: 1536 };

    const chunks = planOfficeStaticChunks({
      world,
      view: rect,
      lod: 1,
      budget: 24,
    });
    const right = Math.max(
      ...chunks.map((chunk) => (chunk.chunkCol + 1) * OFFICE_STATIC_CHUNK_PX),
    );
    const bottom = Math.max(
      ...chunks.map((chunk) => (chunk.chunkRow + 1) * OFFICE_STATIC_CHUNK_PX),
    );

    expect(chunks.length).toBeGreaterThan(0);
    expect(right).toBeGreaterThanOrEqual(rect.x + rect.width);
    expect(bottom).toBeGreaterThanOrEqual(rect.y + rect.height);
    // Tight, not just sufficient - the boundary must not pull in the chunk
    // past it.
    expect(right).toBe(rect.x + rect.width);
    expect(bottom).toBe(rect.y + rect.height);
  });
});

describe("officeStaticChunkRect", () => {
  it("places a chunk on the grid and crops it at the world's edge", () => {
    const world: OfficeSize = { width: 1200, height: 600 };

    expect(officeStaticChunkRect({ chunkCol: 0, chunkRow: 0 }, world)).toEqual({
      x: 0,
      y: 0,
      width: OFFICE_STATIC_CHUNK_PX,
      height: OFFICE_STATIC_CHUNK_PX,
    });
    expect(officeStaticChunkRect({ chunkCol: 2, chunkRow: 1 }, world)).toEqual({
      x: OFFICE_STATIC_CHUNK_PX * 2,
      y: OFFICE_STATIC_CHUNK_PX,
      width: 1200 - OFFICE_STATIC_CHUNK_PX * 2,
      height: 600 - OFFICE_STATIC_CHUNK_PX,
    });
  });
});

// ---- Chunk to tiles ---------------------------------------------------- //

/**
 * The projection run backwards - which tiles a chunk was drawn from - is
 * `officeTileRectOf`, shared with the scene's own per-frame floor query and
 * covered in `lib/comm-graph/office/__tests__/office-projection.test.ts`.
 * There is one inversion, so there is one suite for it.
 */

/**
 * One drawable of every kind the scene can emit. Written as a record keyed by
 * the kind so the compiler rejects a kind added to `OfficeDrawable` and
 * forgotten here - the partition below is only a partition if it covers all
 * of them.
 */
const ONE_OF_EACH: Readonly<Record<OfficeDrawable["kind"], OfficeDrawable>> = {
  sprite: { kind: "sprite", sprite: { name: "desk" }, x: 0, y: 0 },
  label: {
    kind: "label",
    text: "Reviewer",
    x: 0,
    y: 0,
    tone: "default",
    ownerAgentId: null,
    fitTiles: null,
  },
  clock: { kind: "clock", x: 0, y: 0, timeMs: 0 },
  envelope: {
    kind: "envelope",
    x: 0,
    y: 0,
    pulseKind: "request",
    progress: 0.5,
    edgeId: "a|b",
  },
  logo: { kind: "logo", harnessId: "claude", x: 0, y: 0 },
  pip: {
    kind: "pip",
    x: 0,
    y: 0,
    status: "idle",
    glyph: "none",
    agentId: "alpha",
  },
  block: {
    kind: "block",
    x: 0,
    y: 0,
    width: 16,
    height: 16,
    fill: "room",
  },
  quad: {
    kind: "quad",
    points: [
      { x: 0, y: 0 },
      { x: 16, y: 8 },
      { x: 0, y: 16 },
      { x: -16, y: 8 },
    ],
    fill: "room",
  },
};

/**
 * The two floor paths - blitted and drawn - have to contain the same things.
 * The offscreen paints exactly what this admits and the per-frame path draws
 * exactly what it does not, so anything it got wrong would be a drawable that
 * appears on one kind of host and not the other.
 */
describe("officeBakesIntoStaticFloor", () => {
  it("bakes a sprite, which is what a floor is made of", () => {
    expect(officeBakesIntoStaticFloor(ONE_OF_EACH.sprite)).toBe(true);
  });

  it.each([
    "label",
    "clock",
    "envelope",
    "logo",
    "pip",
    "block",
    "quad",
  ] as const)("leaves a %s to the per-frame path", (kind) => {
    // A label on the floor is drawn in SCREEN space, a clock needs hands
    // over it, and neither an envelope nor a logo is static by nature. A
    // pip is overview-only, and a block and a quad are both the lod-0
    // stand-in for the very floor this layer bakes - one axis-aligned, one
    // sheared by an isometric projector - so baking any of them here would
    // double-draw the overview and never repaint once the lod changed back.
    // Each of the seven would have been silently dropped by a blitted floor
    // that baked everything, and silently duplicated by one that baked
    // nothing.
    expect(officeBakesIntoStaticFloor(ONE_OF_EACH[kind])).toBe(false);
  });
});
