import { MAX_APPEARANCE_ICON_BYTES } from "@traycer/protocol/host/workspace/appearance-schemas";
import { MAX_APPEARANCE_ICON_EDGE } from "@traycer/protocol/host/workspace/appearance-asset-policy";
import { imageSize } from "image-size";
import {
  canonicalImageMimeType,
  sniffImageMimeType,
} from "@/lib/composer/prompt-stash-image-signature";
import {
  bitmapCanvasToBlob,
  createBitmapCanvas,
  decodeBitmap,
  type DecodedBitmap,
} from "@/lib/images/bitmap-codec";

export const APPEARANCE_INPUT_MAX_BYTES = 20 * 1024 * 1024;
const APPEARANCE_INPUT_MAX_PIXELS = 50_000_000;
const APPEARANCE_WALLPAPER_MAX_EDGE = 2560;
/** The start-page wallpaper never leaves this machine, so it can be generous. */
const MAX_START_PAGE_WALLPAPER_BYTES = 4 * 1024 * 1024;
export interface ProcessedAppearanceImage {
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
}

/** One channel triple, 0..255, in the page's own color space. */
export type AppearanceRampColor = readonly [number, number, number];
/** Shadow, tint, highlight. Tone 0..0.5 walks the first pair, 0.5..1 the second. */
export type AppearanceRamp = readonly [
  AppearanceRampColor,
  AppearanceRampColor,
  AppearanceRampColor,
];

// prettier-ignore
const BAYER_8 = [
   0, 32,  8, 40,  2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44,  4, 36, 14, 46,  6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
   3, 35, 11, 43,  1, 33,  9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47,  7, 39, 13, 45,  5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
];

function rampSample(ramp: AppearanceRamp, tone: number, channel: number) {
  const second = tone >= 0.5;
  const from = second ? ramp[1] : ramp[0];
  const to = second ? ramp[2] : ramp[1];
  const mix = second ? (tone - 0.5) * 2 : tone * 2;
  return from[channel] + (to[channel] - from[channel]) * mix;
}

/**
 * Shared 8x8 ordered-Bayer traversal for both dither variants below: walks
 * every pixel, computes the tile threshold, hands the pixel off to `paint`,
 * then forces alpha opaque. `paint` is the only place the two variants
 * differ - how a pixel's quantized tone gets written back.
 */
function ditherWalk(
  pixels: ImageData,
  levels: number,
  paint: (
    data: Uint8ClampedArray,
    offset: number,
    threshold: number,
    steps: number,
  ) => void,
): void {
  const steps = Math.max(2, Math.round(levels)) - 1;
  const data = pixels.data;
  for (let y = 0; y < pixels.height; y += 1) {
    const bayerRow = (y % 8) * 8;
    for (let x = 0; x < pixels.width; x += 1) {
      const offset = (y * pixels.width + x) * 4;
      const threshold = (BAYER_8[bayerRow + (x % 8)] + 0.5) / 64 - 0.5;
      paint(data, offset, threshold, steps);
      data[offset + 3] = 255;
    }
  }
}

/**
 * In place, whole-buffer, pure: luminance through an 8x8 ordered Bayer
 * quantization into `levels` tones, each tone painted from `ramp`. Sized for a
 * low-resolution canvas the caller upscales with `image-rendering: pixelated`.
 */
export function ditherRows(
  pixels: ImageData,
  levels: number,
  ramp: AppearanceRamp,
): void {
  ditherWalk(pixels, levels, (data, offset, threshold, steps) => {
    const luminance =
      (0.2126 * data[offset] +
        0.7152 * data[offset + 1] +
        0.0722 * data[offset + 2]) /
      255;
    const quantized = Math.round(luminance ** 1.1 * steps + threshold);
    const tone = Math.max(0, Math.min(steps, quantized)) / steps;
    for (let channel = 0; channel < 3; channel += 1)
      data[offset + channel] = rampSample(ramp, tone, channel);
  });
}

/**
 * The untinted sibling of `ditherRows`: the same 8x8 Bayer threshold and the
 * same `levels`, applied to each RGB channel on its own, so the image keeps its
 * own colours instead of being repainted onto a ramp.
 */
export function ditherRowsPerChannel(pixels: ImageData, levels: number): void {
  ditherWalk(pixels, levels, (data, offset, threshold, steps) => {
    for (let channel = 0; channel < 3; channel += 1) {
      const quantized = Math.round(
        (data[offset + channel] / 255) * steps + threshold,
      );
      data[offset + channel] =
        (Math.max(0, Math.min(steps, quantized)) / steps) * 255;
    }
  });
}

export async function yieldImageWork(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  signal.throwIfAborted();
}

export async function validateAppearanceImage(blob: Blob): Promise<void> {
  if (blob.size === 0 || blob.size > APPEARANCE_INPUT_MAX_BYTES) {
    throw new Error("Choose an image no larger than 20 MiB.");
  }
  const declared = canonicalImageMimeType(blob.type);
  const actual = sniffImageMimeType(
    new Uint8Array(await blob.slice(0, 12).arrayBuffer()),
  );
  if (actual === null || actual === "image/gif" || actual !== declared) {
    throw new Error(
      "Choose a PNG, JPEG, or WebP image with a matching file format.",
    );
  }
  // Bounds pixel count from the declared header BEFORE `createImageBitmap`
  // allocates anything, so a decompression-bomb image is rejected without
  // ever being decoded.
  const dimensions = imageSize(new Uint8Array(await blob.arrayBuffer()));
  validateDimensions(dimensions);
}

function validateDimensions(image: {
  readonly width: number;
  readonly height: number;
}): void {
  if (
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    image.width * image.height > APPEARANCE_INPUT_MAX_PIXELS
  ) {
    throw new Error(
      "Choose an image with valid dimensions, no larger than 50 megapixels.",
    );
  }
}

async function encodeCanvas(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Blob | null> {
  for (const quality of [0.9, 0.75, 0.55]) {
    await yieldImageWork(signal);
    const blob = await bitmapCanvasToBlob(canvas, "image/webp", quality);
    signal.throwIfAborted();
    // Canvas falls back to PNG when WebP encoding is unavailable; it keeps alpha.
    if (
      blob !== null &&
      (blob.type === "image/webp" || blob.type === "image/png") &&
      blob.size > 0 &&
      blob.size <= maxBytes
    )
      return blob;
  }
  return null;
}

async function renderCandidate(
  args: {
    readonly image: DecodedBitmap;
    readonly scale: number;
    readonly maxBytes: number;
  },
  signal: AbortSignal,
): Promise<ProcessedAppearanceImage | null> {
  const width = Math.max(1, Math.round(args.image.width * args.scale));
  const height = Math.max(1, Math.round(args.image.height * args.scale));
  const canvas = createBitmapCanvas(width, height);
  try {
    const context = canvas.getContext("2d");
    if (context === null)
      throw new Error("Image processing is unavailable in this browser.");
    await yieldImageWork(signal);
    context.drawImage(args.image.source, 0, 0, width, height);
    const blob = await encodeCanvas(canvas, args.maxBytes, signal);
    return blob === null ? null : { blob, width, height };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/**
 * Re-encodes a chosen image down to `maxEdge` and `maxBytes`, backing the scale
 * off twice before giving up. One normalizer, two budgets: a committed repo
 * logo (small, travels over RPC) and the local start-page wallpaper (large,
 * never leaves this machine).
 */
async function normalizeAppearanceImage(
  blob: Blob,
  limits: { readonly maxEdge: number; readonly maxBytes: number },
  signal: AbortSignal,
): Promise<ProcessedAppearanceImage> {
  signal.throwIfAborted();
  await validateAppearanceImage(blob);
  await yieldImageWork(signal);
  const image = await decodeBitmap(blob);
  try {
    signal.throwIfAborted();
    // Re-check against the DECODED bitmap, not just the declared header: the
    // pre-decode check above is a fast reject on a lying/oversized header,
    // this one is the guarantee that actually held once the browser decoded it.
    validateDimensions(image);
    const scale = Math.min(
      1,
      limits.maxEdge / Math.max(image.width, image.height),
    );
    for (const multiplier of [1, 0.75, 0.5]) {
      const result = await renderCandidate(
        { image, scale: scale * multiplier, maxBytes: limits.maxBytes },
        signal,
      );
      if (result !== null) return result;
    }
    throw new Error(
      "This image could not be reduced to the artwork size limit. Choose a smaller image.",
    );
  } finally {
    image.close();
  }
}

/** Normalizes a chosen logo to the committed icon budget (256 px, 256 KiB). */
export function processAppearanceImage(
  blob: Blob,
  signal: AbortSignal,
): Promise<ProcessedAppearanceImage> {
  return normalizeAppearanceImage(
    blob,
    {
      maxEdge: MAX_APPEARANCE_ICON_EDGE,
      maxBytes: MAX_APPEARANCE_ICON_BYTES,
    },
    signal,
  );
}

/** Normalizes a chosen start-page wallpaper to 2560 px / 4 MiB. */
export function processStartPageWallpaperImage(
  blob: Blob,
  signal: AbortSignal,
): Promise<ProcessedAppearanceImage> {
  return normalizeAppearanceImage(
    blob,
    {
      maxEdge: APPEARANCE_WALLPAPER_MAX_EDGE,
      maxBytes: MAX_START_PAGE_WALLPAPER_BYTES,
    },
    signal,
  );
}
