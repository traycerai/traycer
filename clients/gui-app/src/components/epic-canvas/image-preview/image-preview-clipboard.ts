import { copyImageBlobToClipboard } from "@/lib/images/copy-image-to-clipboard";

/**
 * Canvas-converts a rendered `<img>` to PNG for the Clipboard API
 * (image-preview decision log, decision #16) - SVG copies its rasterized
 * on-screen rendering rather than raw markup, same as every other format,
 * since it goes through the same `<img>` -> canvas pipeline. This
 * normalization step stays (it's what makes GIF/WebP/SVG copyable at all -
 * the shared native clipboard allowlist is PNG/JPEG-only by design); only
 * the WRITE layer below is shared with the rest of the app.
 *
 * `ops` is an injected seam (mirrors `ImageBlobOps` in `image-blob-cache.ts`)
 * so tests can fake canvas/clipboard without a real browser.
 */
export interface ImageCopyOps {
  readonly createCanvas: () => HTMLCanvasElement;
  readonly writeClipboardPng: (blob: Blob) => Promise<void>;
}

export const browserImageCopyOps: ImageCopyOps = {
  createCanvas: () => document.createElement("canvas"),
  // `copyImageBlobToClipboard` (ticket 07) tries the browser Clipboard API
  // first, same as the inline call this replaces, then falls back to the
  // Electron `nativeImage` bridge when the renderer clipboard rejects the
  // write - a real desktop gap the previous browser-only call bypassed.
  writeClipboardPng: (blob) => copyImageBlobToClipboard(blob),
};

export async function copyImageToClipboard(
  image: HTMLImageElement,
  ops: ImageCopyOps,
): Promise<void> {
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (width <= 0 || height <= 0) {
    throw new Error("This image has no dimensions to copy.");
  }
  const canvas = ops.createCanvas();
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("This browser cannot render the image to copy it.");
  }
  context.drawImage(image, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/png");
  });
  if (blob === null) {
    throw new Error("This image could not be encoded to copy it.");
  }
  await ops.writeClipboardPng(blob);
}
