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
    const layer = new OfficeStaticLayer(create);
    const paint = vi.fn();

    const first = layer.sync({ key: KEY, chunks: ORIGIN_CHUNK, paint });
    const second = layer.sync({ key: { ...KEY }, chunks: ORIGIN_CHUNK, paint });
    const third = layer.sync({ key: { ...KEY }, chunks: ORIGIN_CHUNK, paint });

    // The whole point: thirty frames a second cost one paint, not thirty.
    expect(paint).toHaveBeenCalledTimes(1);
    expect(layer.paintCount).toBe(1);
    expect(second[0].canvas).toBe(first[0].canvas);
    expect(third[0].canvas).toBe(first[0].canvas);
  });

  it("paints each chunk once and hands them back in the order asked for", () => {
    const { create } = fakeSurfaces();
    const layer = new OfficeStaticLayer(create);
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
    const layer = new OfficeStaticLayer(create);
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
    const layer = new OfficeStaticLayer(create);

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
    const layer = new OfficeStaticLayer(create);
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
    const layer = new OfficeStaticLayer(create);
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
    const layer = new OfficeStaticLayer(create);
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
    const layer = new OfficeStaticLayer(create);
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

  it("never holds more pixels than the budget allows", () => {
    const { create } = fakeSurfaces();
    const layer = new OfficeStaticLayer(create);
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
    const layer = new OfficeStaticLayer(create);
    layer.sync({ key: KEY, chunks: ORIGIN_CHUNK, paint: () => undefined });
    expect(layer.heldPixels).toBeGreaterThan(0);

    // What the canvas does the moment the tile stops being eligible.
    layer.release();

    expect(layer.heldPixels).toBe(0);
    expect(layer.chunkCount).toBe(0);
  });

  it("drops the bitmap on release and repaints if asked again", () => {
    const { create, made } = fakeSurfaces();
    const layer = new OfficeStaticLayer(create);
    const paint = vi.fn();
    layer.sync({ key: KEY, chunks: ORIGIN_CHUNK, paint });

    layer.release();

    expect(made[0].canvas.width).toBe(0);
    layer.sync({ key: KEY, chunks: ORIGIN_CHUNK, paint });
    expect(paint).toHaveBeenCalledTimes(2);
  });

  it("bakes nothing for a floor with no area yet", () => {
    const { create } = fakeSurfaces();
    const layer = new OfficeStaticLayer(create);
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
    const layer = new OfficeStaticLayer(create);
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
    const layer = new OfficeStaticLayer(() => null);
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
    });

    const drawn = layer.sync({
      key: { ...KEY, width: 1600, height: 600 },
      chunks: [
        { chunkCol: 0, chunkRow: 0 },
        { chunkCol: 1, chunkRow: 0 },
      ],
      paint: () => undefined,
    });

    expect(drawn).toEqual([]);
    expect(layer.heldPixels).toBe(0);
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

  it.each(["label", "clock", "envelope", "logo", "pip", "block"] as const)(
    "leaves a %s to the per-frame path",
    (kind) => {
      // A label on the floor is drawn in SCREEN space, a clock needs hands
      // over it, and neither an envelope nor a logo is static by nature. A
      // pip is overview-only and a block is a lod-0 stand-in for the very
      // floor this layer bakes, so baking either here would double-draw the
      // overview and never repaint once the lod changed back. Each of the six
      // would have been silently dropped by a blitted floor that baked
      // everything, and silently duplicated by one that baked nothing.
      expect(officeBakesIntoStaticFloor(ONE_OF_EACH[kind])).toBe(false);
    },
  );
});
