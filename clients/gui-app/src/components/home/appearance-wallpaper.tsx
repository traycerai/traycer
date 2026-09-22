import { useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import {
  ditherRows,
  ditherRowsPerChannel,
  yieldImageWork,
  type AppearanceRamp,
  type AppearanceRampColor,
} from "@/lib/appearance/appearance-image-processing";
import { type StartPageWallpaper } from "@/stores/settings/settings-store";
import { useThemeRevision } from "@/providers/use-theme-revision";
import {
  retainWallpaperFrame,
  restoreWallpaperFrame,
  type WallpaperFrameSlot,
} from "@/components/home/appearance-wallpaper-frame";
import "./appearance-wallpaper.css";

/** One dither cell, in CSS px: the canvas is the element at 1/CELL scale. */
const CELL = 2;
/** Above this, the row loop yields between bands instead of blocking a frame. */
const SYNCHRONOUS_PIXEL_BUDGET = 600_000;
/**
 * A multiple of the 8x8 Bayer tile, so a band's local row index is congruent
 * (mod 8) to its absolute one and a banded pass is pixel-identical to a
 * whole-buffer one.
 */
const BAND_ROWS = 64;
const RESIZE_DEBOUNCE_MS = 100;

/**
 * A single reusable probe canvas for `paintColor`'s sRGB conversion, instead
 * of a fresh 1x1 `<canvas>` per call - `resolveRamp` calls it twice per
 * repaint, and a repaint can run on every debounced resize.
 */
let colorProbeCanvas: HTMLCanvasElement | null = null;

/**
 * Where the wallpaper is being painted, which decides how much of the
 * treatment applies.
 *
 * `page` is the start page: the effect's texture plus everything that settles
 * the image into the page - the neutral veil that clears the composer, the
 * fade into `--background` below, and the sub-1 opacity that lets the page
 * colour through.
 *
 * `preview` is a curated tile in Settings: the texture alone, at full opacity.
 * The page integration is sized for a full-height surface - at tile size the
 * veil's ellipse covers the whole tile and the fade takes its lower half, so
 * every wallpaper reads as grey fog and the three effects become
 * indistinguishable. What a tile has to answer is "what do the dots / the
 * grain look like on this picture at this strength", nothing more.
 */
export type WallpaperSurface = "page" | "preview";

/**
 * The personal start-page wallpaper, and - fed a catalog thumbnail as a
 * `preview` surface - what each curated tile in Settings shows under the
 * current effect, so the two can never drift apart. `photo` and `grain` are
 * the image itself under CSS; `dither` repaints it onto a low-resolution
 * canvas upscaled with `image-rendering: pixelated`, so the treatment is a
 * render-time property of the surface rather than a second set of bytes to
 * store and invalidate.
 */
export function AppearanceWallpaper(props: {
  readonly wallpaper: StartPageWallpaper | null;
  readonly url: string | null;
  /** Dither tint. `null` reads the theme accent (`--primary`) instead. */
  readonly tint: string | null;
  readonly surface: WallpaperSurface;
  /**
   * Which retained dither this page-sized surface owns. The landing page
   * and the sidebar both use `surface="page"` and rasterize at different
   * sizes, so they cannot share a frame. Previews never retain one.
   */
  readonly frameSlot?: WallpaperFrameSlot;
}) {
  const { wallpaper, url, tint, surface, frameSlot } = props;
  if (wallpaper === null || url === null) return null;
  const onPage = surface === "page";
  // Subtle leaves a 20% veil at the centre, strong reaches 65%. The same knob
  // scales the texture for dot pattern and film grain; for photo it is the
  // only thing the slider does.
  const scrim: CSSProperties & Record<string, string | number> = {
    "--wallpaper-scrim": (0.2 + wallpaper.intensity * 0.45).toFixed(3),
  };
  return (
    <div
      className="appearance-wallpaper pointer-events-none absolute inset-0 overflow-hidden"
      aria-hidden="true"
      style={scrim}
    >
      {wallpaper.style === "dither" ? (
        <DitheredWallpaper
          url={url}
          intensity={wallpaper.intensity}
          tint={tint}
          tintWithAccent={wallpaper.tintWithAccent}
          frameSlot={surface === "page" ? (frameSlot ?? "page") : null}
        />
      ) : (
        <img
          className="size-full object-cover"
          src={url}
          alt=""
          // The start page's own wallpaper is a blob URL, where a referrer is
          // moot; a curated tile in Settings loads its thumbnail from the
          // assets CDN, and no catalog request sends one.
          referrerPolicy="no-referrer"
          draggable={false}
          style={
            wallpaper.style === "grain"
              ? {
                  opacity: imageOpacity(wallpaper, onPage),
                  filter: "saturate(0.8) contrast(1.05)",
                }
              : { opacity: imageOpacity(wallpaper, onPage) }
          }
        />
      )}
      {wallpaper.style === "grain" ? (
        <div
          className="appearance-wallpaper-texture absolute inset-0"
          style={{ opacity: 0.15 + wallpaper.intensity * 0.5 }}
        />
      ) : null}
      {onPage ? (
        <div className="appearance-wallpaper-mask absolute inset-0" />
      ) : null}
    </div>
  );
}

/**
 * The `<img>` opacity of `photo` and `grain`. Grain's desaturation is texture
 * and applies on every surface; the sub-1 opacity is page integration - it
 * lets the page colour through - and applies on the page only.
 */
function imageOpacity(wallpaper: StartPageWallpaper, onPage: boolean): number {
  if (!onPage) return 1;
  if (wallpaper.style === "grain") return 0.9 - wallpaper.intensity * 0.4;
  return 0.85;
}

function wallpaperFrameStyle(args: {
  readonly url: string;
  readonly intensity: number;
  readonly tint: string | null;
  readonly tintWithAccent: boolean;
  readonly tintThemeRevision: number;
}): string {
  return [
    args.url,
    args.intensity,
    args.tint ?? "",
    args.tintWithAccent ? "1" : "0",
    args.tintThemeRevision,
  ].join("\u001f");
}

function DitheredWallpaper(props: {
  readonly url: string;
  readonly intensity: number;
  readonly tint: string | null;
  readonly tintWithAccent: boolean;
  readonly frameSlot: WallpaperFrameSlot | null;
}) {
  const { url, intensity, tint, tintWithAccent, frameSlot } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The theme is not readable as a value here - it lives in CSS custom
  // properties - so the revision is subscribed to purely as a repaint trigger
  // for the ramp the canvas bakes in. It bumps after the palette has reached
  // the cascade, and covers the OS flip under `theme: "system"` as well.
  const themeRevision = useThemeRevision();
  const tintThemeRevision = tintWithAccent ? themeRevision : 0;
  const frameStyle = wallpaperFrameStyle({
    url,
    intensity,
    tint,
    tintWithAccent,
    tintThemeRevision,
  });
  // Set by the layout effect, read by the paint effect in the same commit.
  // A restored frame is already the picture; the effect must not start a
  // pass that would clear the canvas on its way to drawing the same thing.
  const restoredStyleRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    if (frameSlot === null) {
      restoredStyleRef.current = null;
      return;
    }
    restoredStyleRef.current = restoreWallpaperFrame(
      frameSlot,
      frameStyle,
      canvas,
      {
        width: Math.round(canvas.clientWidth / CELL),
        height: Math.round(canvas.clientHeight / CELL),
      },
    )
      ? frameStyle
      : null;
  }, [frameSlot, frameStyle]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    let controller: AbortController | null = null;
    const image = new Image();
    let timer: number | null = null;
    let painted =
      restoredStyleRef.current === frameStyle &&
      canvas.width === Math.round(canvas.clientWidth / CELL) &&
      canvas.height === Math.round(canvas.clientHeight / CELL) &&
      canvas.width > 0;
    const paint = (): void => {
      controller?.abort();
      if (canvas.clientWidth === 0 || canvas.clientHeight === 0) {
        return;
      }
      // ResizeObserver also reports initial layout and hide/show. Reuse the
      // retained bitmap when the raster dimensions have not changed.
      if (
        painted &&
        canvas.width === Math.round(canvas.clientWidth / CELL) &&
        canvas.height === Math.round(canvas.clientHeight / CELL)
      ) {
        return;
      }
      const pass = new AbortController();
      controller = pass;
      void renderDither(
        canvas,
        image,
        { intensity, tint, tintWithAccent },
        pass.signal,
      )
        .then((complete) => {
          if (complete && !pass.signal.aborted) {
            painted = true;
            if (frameSlot !== null) {
              retainWallpaperFrame(frameSlot, frameStyle, canvas);
            }
          }
        })
        // Aborts (unmount, a newer pass) and a canvas-less environment are the
        // only failures here, and both mean "leave the last frame up".
        .catch(() => undefined);
    };
    const schedule = (): void => {
      if (timer !== null) clearTimeout(timer);
      if (canvas.clientWidth === 0 || canvas.clientHeight === 0) {
        controller?.abort();
        return;
      }
      timer = window.setTimeout(paint, RESIZE_DEBOUNCE_MS);
    };
    image.onload = paint;
    // A broken/unreachable URL never fires `onload`, so without this the
    // canvas would just sit blank (or stale) with nothing explaining why.
    // Same "leave the last frame up" outcome as an aborted render - there is
    // no broken-image placeholder to paint onto a dither canvas.
    image.onerror = () => undefined;
    image.referrerPolicy = "no-referrer";
    // A cross-origin image drawn without CORS taints the canvas, and the
    // dither pass then dies in `getImageData` - silently, into the catch
    // below - leaving the plain image upscaled `pixelated`: it LOOKS dithered
    // and reacts to nothing. The catalog thumbnails come from the assets CDN
    // (which serves `Access-Control-Allow-Origin: *`); the start page's own
    // blob URL is same-origin and unaffected either way.
    image.crossOrigin = "anonymous";
    // Always load, including after a restore. A later resize repaints from
    // this image; the restored frame only means the first paint is a no-op
    // while the raster size still matches.
    image.src = url;
    const observer = new ResizeObserver(schedule);
    observer.observe(canvas);
    return () => {
      controller?.abort();
      observer.disconnect();
      if (timer !== null) clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
    };
  }, [frameSlot, frameStyle, intensity, tint, tintWithAccent, url]);

  return (
    <canvas ref={canvasRef} className="appearance-wallpaper-canvas size-full" />
  );
}

async function renderDither(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  style: {
    readonly intensity: number;
    readonly tint: string | null;
    readonly tintWithAccent: boolean;
  },
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  const width = Math.max(1, Math.round(canvas.clientWidth / CELL));
  const height = Math.max(1, Math.round(canvas.clientHeight / CELL));
  if (image.naturalWidth === 0 || image.naturalHeight === 0) return false;
  // Process offscreen: yielding between bands must never expose the raw
  // photo or a partly dithered frame on the visible canvas.
  const buffer = document.createElement("canvas");
  buffer.width = width;
  buffer.height = height;
  const context = buffer.getContext("2d", { willReadFrequently: true });
  if (context === null) return false;
  // Tint is off by default (`ramp` stays `null`, meaning "dither each RGB
  // channel"); only bail when a tint was actually requested but couldn't be
  // resolved, tested once rather than twice.
  let ramp: AppearanceRamp | null = null;
  if (style.tintWithAccent) {
    ramp = resolveRamp(canvas, style.tint);
    if (ramp === null) return false;
  }
  const cover = Math.max(
    width / image.naturalWidth,
    height / image.naturalHeight,
  );
  const drawn = {
    width: image.naturalWidth * cover,
    height: image.naturalHeight * cover,
  };
  context.drawImage(
    image,
    (width - drawn.width) / 2,
    (height - drawn.height) / 2,
    drawn.width,
    drawn.height,
  );
  const levels = 2 + Math.round((1 - style.intensity) * 8);
  if (width * height <= SYNCHRONOUS_PIXEL_BUDGET) {
    const pixels = context.getImageData(0, 0, width, height);
    ditherPixels(pixels, levels, ramp);
    context.putImageData(pixels, 0, 0);
  } else {
    for (let row = 0; row < height; row += BAND_ROWS) {
      await yieldImageWork(signal);
      const band = context.getImageData(
        0,
        row,
        width,
        Math.min(BAND_ROWS, height - row),
      );
      ditherPixels(band, levels, ramp);
      context.putImageData(band, 0, row);
    }
  }
  signal.throwIfAborted();
  if (
    Math.round(canvas.clientWidth / CELL) !== width ||
    Math.round(canvas.clientHeight / CELL) !== height
  ) {
    return false;
  }
  const target = canvas.getContext("2d");
  if (target === null) return false;
  canvas.width = width;
  canvas.height = height;
  target.drawImage(buffer, 0, 0);
  return true;
}

/** With a ramp the tones are accent-tinted; without one each channel dithers. */
function ditherPixels(
  pixels: ImageData,
  levels: number,
  ramp: AppearanceRamp | null,
): void {
  if (ramp === null) ditherRowsPerChannel(pixels, levels);
  else ditherRows(pixels, levels, ramp);
}

/** Page background -> tint -> a 55% lift of the tint toward white. */
function resolveRamp(
  element: HTMLElement,
  tint: string | null,
): AppearanceRamp | null {
  const styles = getComputedStyle(element);
  const background = paintColor(styles.getPropertyValue("--background"));
  const accent = paintColor(tint ?? styles.getPropertyValue("--primary"));
  if (background === null || accent === null) return null;
  return [background, accent, mixColor(accent, [255, 255, 255], 0.55)];
}

function mixColor(
  from: AppearanceRampColor,
  to: AppearanceRampColor,
  amount: number,
): AppearanceRampColor {
  return [
    from[0] + (to[0] - from[0]) * amount,
    from[1] + (to[1] - from[1]) * amount,
    from[2] + (to[2] - from[2]) * amount,
  ];
}

/**
 * Resolves any CSS color (the theme tokens are `oklch(...)`) to sRGB bytes by
 * painting it. `getComputedStyle` would hand back the authored color function
 * verbatim; a 1x1 canvas fill is the browser's own conversion.
 */
function paintColor(value: string): AppearanceRampColor | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (colorProbeCanvas === null) {
    colorProbeCanvas = document.createElement("canvas");
    colorProbeCanvas.width = 1;
    colorProbeCanvas.height = 1;
  }
  const context = colorProbeCanvas.getContext("2d");
  if (context === null) return null;
  context.fillStyle = "#000000";
  context.fillStyle = trimmed;
  context.fillRect(0, 0, 1, 1);
  const data = context.getImageData(0, 0, 1, 1).data;
  return [data[0], data[1], data[2]];
}
