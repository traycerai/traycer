import { useEffect, useRef } from "react";
import {
  ditherRows,
  ditherRowsPerChannel,
  yieldImageWork,
  type AppearanceRamp,
  type AppearanceRampColor,
} from "@/lib/appearance/appearance-image-processing";
import { type StartPageWallpaper } from "@/stores/settings/settings-store";
import { useThemeRevision } from "@/providers/use-theme-revision";
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
 * The personal start-page wallpaper. `photo` and `grain` are the image itself
 * under CSS; `dither` repaints it onto a low-resolution canvas upscaled with
 * `image-rendering: pixelated`, so the treatment is a render-time property of
 * the surface rather than a second set of bytes to store and invalidate.
 */
export function AppearanceWallpaper(props: {
  readonly wallpaper: StartPageWallpaper | null;
  readonly url: string | null;
  /** Dither tint. `null` reads the theme accent (`--primary`) instead. */
  readonly tint: string | null;
}) {
  const { wallpaper, url, tint } = props;
  if (wallpaper === null || url === null) return null;
  return (
    <div
      className="appearance-wallpaper pointer-events-none absolute inset-0 overflow-hidden"
      aria-hidden="true"
    >
      {wallpaper.style === "dither" ? (
        <DitheredWallpaper
          url={url}
          intensity={wallpaper.intensity}
          tint={tint}
          tintWithAccent={wallpaper.tintWithAccent}
        />
      ) : (
        <img
          className="size-full object-cover"
          src={url}
          alt=""
          draggable={false}
          style={
            wallpaper.style === "grain"
              ? {
                  opacity: 0.9 - wallpaper.intensity * 0.4,
                  filter: "saturate(0.8) contrast(1.05)",
                }
              : { opacity: 0.85 }
          }
        />
      )}
      {wallpaper.style === "grain" ? (
        <div
          className="appearance-wallpaper-texture absolute inset-0"
          style={{ opacity: 0.15 + wallpaper.intensity * 0.5 }}
        />
      ) : null}
      <div className="appearance-wallpaper-mask absolute inset-0" />
    </div>
  );
}

function DitheredWallpaper(props: {
  readonly url: string;
  readonly intensity: number;
  readonly tint: string | null;
  readonly tintWithAccent: boolean;
}) {
  const { url, intensity, tint, tintWithAccent } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The theme is not readable as a value here - it lives in CSS custom
  // properties - so the revision is subscribed to purely as a repaint trigger
  // for the ramp the canvas bakes in. It bumps after the palette has reached
  // the cascade, and covers the OS flip under `theme: "system"` as well.
  const themeRevision = useThemeRevision();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const controller = new AbortController();
    const image = new Image();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const paint = (): void => {
      void renderDither(
        canvas,
        image,
        { intensity, tint, tintWithAccent },
        controller.signal,
      )
        // Aborts (unmount, a newer pass) and a canvas-less environment are the
        // only failures here, and both mean "leave the last frame up".
        .catch(() => undefined);
    };
    const schedule = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(paint, RESIZE_DEBOUNCE_MS);
    };
    image.onload = paint;
    image.src = url;
    const observer = new ResizeObserver(schedule);
    observer.observe(canvas);
    return () => {
      controller.abort();
      observer.disconnect();
      if (timer !== null) clearTimeout(timer);
      image.onload = null;
    };
  }, [url, intensity, tint, tintWithAccent, themeRevision]);

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
): Promise<void> {
  signal.throwIfAborted();
  const width = Math.max(1, Math.round(canvas.clientWidth / CELL));
  const height = Math.max(1, Math.round(canvas.clientHeight / CELL));
  if (image.naturalWidth === 0 || image.naturalHeight === 0) return;
  const context = canvas.getContext("2d");
  if (context === null) return;
  const ramp = style.tintWithAccent ? resolveRamp(canvas, style.tint) : null;
  if (style.tintWithAccent && ramp === null) return;
  canvas.width = width;
  canvas.height = height;
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
    return;
  }
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
  const probe = document.createElement("canvas");
  probe.width = 1;
  probe.height = 1;
  const context = probe.getContext("2d");
  if (context === null) return null;
  context.fillStyle = "#000000";
  context.fillStyle = trimmed;
  context.fillRect(0, 0, 1, 1);
  const data = context.getImageData(0, 0, 1, 1).data;
  return [data[0], data[1], data[2]];
}
