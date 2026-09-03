/**
 * The office's floor, drawn once and blitted thereafter.
 *
 * A floor is one sprite per TILE. On a large office that is thousands of
 * `drawImage` calls per frame, each one preceded by a cache lookup, to produce
 * an image identical to the one already on screen - and it is the single
 * largest thing the renderer was doing. The floor changes only when the LAYOUT
 * does, which is when the set of agents changes, so it is painted into an
 * offscreen canvas and copied under the camera transform instead.
 *
 * Kept in SPRITE space at 1x rather than at the camera's scale, so panning and
 * zooming never invalidate it. Smoothing is off on the way out, which is what
 * a per-sprite draw at the same transform would have done anyway.
 *
 * ONE per mounted office canvas, released on unmount.
 */
import type {
  OfficeDrawable,
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
export function officeBakesIntoStaticFloor(drawable: OfficeDrawable): boolean {
  return drawable.kind === "sprite";
}

/** Everything that changes what the static layer should contain. */
export interface OfficeStaticLayerKey {
  /** The scene's own version for its floor; see `OfficeFrame.staticVersion`. */
  readonly staticVersion: number;
  /** The palette is baked into the pixels, so a theme flip is a repaint. */
  readonly theme: OfficeTheme;
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

export class OfficeStaticLayer {
  private readonly create: OfficeStaticSurfaceFactory;
  private surface: OfficeStaticSurface | null = null;
  private key: OfficeStaticLayerKey | null = null;
  /** Counts repaints, so a test can prove a frame did NOT cause one. */
  private paints = 0;

  constructor(create: OfficeStaticSurfaceFactory) {
    this.create = create;
  }

  get paintCount(): number {
    return this.paints;
  }

  /**
   * The layer's canvas for this frame, repainting it only if `key` changed.
   *
   * `paint` receives a context in sprite space with the previous contents
   * already cleared, and is called only when a repaint is actually needed.
   */
  sync(
    key: OfficeStaticLayerKey,
    paint: (ctx: CanvasRenderingContext2D) => void,
  ): HTMLCanvasElement | null {
    if (key.width <= 0 || key.height <= 0) return null;
    const current = this.key;
    if (
      this.surface !== null &&
      current !== null &&
      officeStaticLayerKeysMatch(current, key)
    ) {
      return this.surface.canvas;
    }
    // The surface is REUSED unless the floor's size changed: a theme flip or a
    // re-layout at the same size repaints the pixels it already has rather
    // than allocating a second bitmap to throw the first one away.
    const sizeChanged =
      this.surface === null ||
      current === null ||
      current.width !== key.width ||
      current.height !== key.height;
    if (sizeChanged) {
      this.releaseSurface();
      this.surface = this.create(key.width, key.height);
    }
    const surface = this.surface;
    if (surface === null) {
      this.key = null;
      return null;
    }
    surface.ctx.setTransform(1, 0, 0, 1, 0, 0);
    surface.ctx.clearRect(0, 0, key.width, key.height);
    surface.ctx.imageSmoothingEnabled = false;
    paint(surface.ctx);
    this.paints += 1;
    this.key = key;
    return surface.canvas;
  }

  /** Drops the bitmap. Called on unmount - a floor's worth of pixels is real. */
  release(): void {
    this.releaseSurface();
    this.key = null;
  }

  private releaseSurface(): void {
    const surface = this.surface;
    if (surface === null) return;
    // Zeroing the dimensions frees the backing store now rather than whenever
    // the element itself is collected.
    surface.canvas.width = 0;
    surface.canvas.height = 0;
    this.surface = null;
  }
}
