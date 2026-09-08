import {
  MAX_APPEARANCE_ICON_BYTES,
  MAX_APPEARANCE_WALLPAPER_BYTES,
} from "@traycer/protocol/host/workspace/appearance-schemas";
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
export const APPEARANCE_INPUT_MAX_PIXELS = 50_000_000;
export type AppearanceImageTarget = "wallpaper" | "icon";
export type AppearanceImageRequest =
  | {
      readonly kind: "normalize";
      readonly blob: Blob;
      readonly target: AppearanceImageTarget;
    }
  | { readonly kind: "dither"; readonly blob: Blob; readonly strength: number };
export interface ProcessedAppearanceImage {
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

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

function processingCanvas(
  width: number,
  height: number,
): HTMLCanvasElement | OffscreenCanvas {
  return typeof document === "undefined"
    ? new OffscreenCanvas(width, height)
    : createBitmapCanvas(width, height);
}

/** Color quantization with ordered Bayer thresholds; alpha is left intact. */
export function ditherAppearanceRows(
  pixels: ImageData,
  strength: number,
  start: number,
  end: number,
): void {
  const levels = 7 - Math.round(strength * 4);
  const step = 255 / (levels - 1);
  for (let y = start; y < end; y += 1) {
    for (let x = 0; x < pixels.width; x += 1) {
      const threshold = (BAYER[(y % 4) * 4 + (x % 4)] + 0.5) / 16 - 0.5;
      const offset = (y * pixels.width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const original = pixels.data[offset + channel];
        const quantized = Math.max(
          0,
          Math.min(255, Math.round(original / step + threshold) * step),
        );
        pixels.data[offset + channel] =
          original + (quantized - original) * strength;
      }
    }
  }
}

async function applyDither(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  strength: number,
  signal: AbortSignal,
): Promise<void> {
  const context = canvas.getContext("2d");
  if (context === null)
    throw new Error("Image processing is unavailable in this browser.");
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let row = 0; row < pixels.height; row += 16) {
    if (typeof document !== "undefined") await yieldImageWork(signal);
    ditherAppearanceRows(
      pixels,
      strength,
      row,
      Math.min(row + 16, pixels.height),
    );
  }
  context.putImageData(pixels, 0, 0);
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
    readonly request: AppearanceImageRequest;
    readonly scale: number;
    readonly maxBytes: number;
  },
  signal: AbortSignal,
): Promise<ProcessedAppearanceImage | null> {
  const width = Math.max(1, Math.round(args.image.width * args.scale));
  const height = Math.max(1, Math.round(args.image.height * args.scale));
  const canvas = processingCanvas(width, height);
  try {
    const context = canvas.getContext("2d");
    if (context === null)
      throw new Error("Image processing is unavailable in this browser.");
    await yieldImageWork(signal);
    context.drawImage(args.image.source, 0, 0, width, height);
    if (args.request.kind === "dither")
      await applyDither(canvas, args.request.strength, signal);
    const blob = await encodeCanvas(canvas, args.maxBytes, signal);
    return blob === null ? null : { blob, width, height };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

export async function processAppearanceImage(
  request: AppearanceImageRequest,
  signal: AbortSignal,
): Promise<ProcessedAppearanceImage> {
  signal.throwIfAborted();
  await validateAppearanceImage(request.blob);
  if (
    request.kind === "dither" &&
    (!Number.isFinite(request.strength) ||
      request.strength < 0 ||
      request.strength > 1)
  ) {
    throw new Error("Image strength must be between zero and one.");
  }
  await yieldImageWork(signal);
  const image = await decodeBitmap(request.blob);
  try {
    signal.throwIfAborted();
    validateDimensions(image);
    const icon = request.kind === "normalize" && request.target === "icon";
    const maxBytes = icon
      ? MAX_APPEARANCE_ICON_BYTES
      : MAX_APPEARANCE_WALLPAPER_BYTES;
    const scale = Math.min(
      1,
      (icon ? 256 : 2560) / Math.max(image.width, image.height),
    );
    for (const multiplier of [1, 0.75, 0.5]) {
      const result = await renderCandidate(
        { image, request, scale: scale * multiplier, maxBytes },
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
