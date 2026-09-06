import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OfficeDrawable } from "@/lib/comm-graph/office/office-types";
import {
  officeBakesIntoStaticFloor,
  officeStaticLayerKeysMatch,
  OfficeStaticLayer,
  type OfficeStaticLayerKey,
  type OfficeStaticSurface,
} from "@/components/epic-canvas/comm-graph/office/office-static-layer";

const KEY: OfficeStaticLayerKey = {
  staticVersion: 1,
  theme: "dark",
  width: 320,
  height: 240,
};

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

    const first = layer.sync(KEY, paint);
    const second = layer.sync({ ...KEY }, paint);
    const third = layer.sync({ ...KEY }, paint);

    // The whole point: thirty frames a second cost one paint, not thirty.
    expect(paint).toHaveBeenCalledTimes(1);
    expect(layer.paintCount).toBe(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("repaints when the floor's version moves", () => {
    const { create } = fakeSurfaces();
    const layer = new OfficeStaticLayer(create);
    const paint = vi.fn();
    layer.sync(KEY, paint);

    layer.sync({ ...KEY, staticVersion: 2 }, paint);

    expect(paint).toHaveBeenCalledTimes(2);
  });

  it("repaints when the theme flips, since the palette is in the pixels", () => {
    const { create } = fakeSurfaces();
    const layer = new OfficeStaticLayer(create);
    const paint = vi.fn();
    layer.sync(KEY, paint);

    layer.sync({ ...KEY, theme: "light" }, paint);

    expect(paint).toHaveBeenCalledTimes(2);
  });

  it("reuses the bitmap for a repaint at the same size", () => {
    const { create, made } = fakeSurfaces();
    const layer = new OfficeStaticLayer(create);
    layer.sync(KEY, () => undefined);

    layer.sync({ ...KEY, theme: "light" }, () => undefined);

    // A theme flip is new pixels in the same box; allocating a second bitmap
    // to throw the first one away would be the expensive way to do that.
    expect(made).toHaveLength(1);
  });

  it("takes a new bitmap when the floor changes size", () => {
    const { create, made } = fakeSurfaces();
    const layer = new OfficeStaticLayer(create);
    layer.sync(KEY, () => undefined);

    layer.sync({ ...KEY, width: 640 }, () => undefined);

    expect(made).toHaveLength(2);
    // The old one is zeroed rather than left holding a floor's worth of pixels
    // until it is collected.
    expect(made[0].canvas.width).toBe(0);
    expect(made[0].canvas.height).toBe(0);
  });

  it("drops the bitmap on release and repaints if asked again", () => {
    const { create, made } = fakeSurfaces();
    const layer = new OfficeStaticLayer(create);
    const paint = vi.fn();
    layer.sync(KEY, paint);

    layer.release();

    expect(made[0].canvas.width).toBe(0);
    layer.sync(KEY, paint);
    expect(paint).toHaveBeenCalledTimes(2);
  });

  it("draws nothing for a floor with no area yet", () => {
    const { create } = fakeSurfaces();
    const layer = new OfficeStaticLayer(create);
    const paint = vi.fn();

    // The first frames of a tile that has not been laid out.
    expect(layer.sync({ ...KEY, width: 0 }, paint)).toBeNull();
    expect(layer.sync({ ...KEY, height: 0 }, paint)).toBeNull();
    expect(paint).not.toHaveBeenCalled();
  });

  it("reports no layer where the host has no 2D context at all", () => {
    // jsdom, and any canvas-less host. The caller draws the floor tile by tile
    // instead: the blit is an optimization, never a requirement.
    const layer = new OfficeStaticLayer(() => null);
    const paint = vi.fn();

    expect(layer.sync(KEY, paint)).toBeNull();
    expect(paint).not.toHaveBeenCalled();
  });
});

/**
 * One drawable of every kind the scene can emit. Written as a record keyed by
 * the kind so the compiler rejects a kind added to `OfficeDrawable` and
 * forgotten here - the partition below is only a partition if it covers all
 * of them.
 */
const ONE_OF_EACH: Readonly<Record<OfficeDrawable["kind"], OfficeDrawable>> = {
  sprite: { kind: "sprite", sprite: { name: "desk" }, x: 0, y: 0 },
  label: { kind: "label", text: "Reviewer", x: 0, y: 0, tone: "default" },
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

  it.each(["label", "clock", "envelope", "logo"] as const)(
    "leaves a %s to the per-frame path",
    (kind) => {
      // A label on the floor is drawn in SCREEN space, a clock needs hands
      // over it, and neither an envelope nor a logo is static by nature. Each
      // would have been silently dropped by a blitted floor that baked
      // everything, and silently duplicated by one that baked nothing.
      expect(officeBakesIntoStaticFloor(ONE_OF_EACH[kind])).toBe(false);
    },
  );
});
