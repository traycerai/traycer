import {
  type DecodedBitmap,
  bitmapCanvasToBlob,
  createBitmapCanvas,
  decodeBitmap,
} from "@/lib/images/bitmap-codec";

/**
 * The side, in pixels, a bot's uploaded picture is stored at: the largest
 * avatar (40 CSS pixels) at the densest screen the app runs on (3×). Nothing
 * draws it larger, so nothing larger is uploaded.
 */
export const BOT_PICTURE_PIXELS = 120;

/** A picture ready to upload: its bytes and the SHA-256 they are named by. */
export interface PreparedBotPicture {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly sha256: string;
}

function hex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * The image the person chose, cropped to its centre square and scaled to
 * {@link BOT_PICTURE_PIXELS}, as a PNG. `null` when the file is not an image
 * this device can read.
 */
export async function prepareBotPicture(
  file: Blob,
): Promise<PreparedBotPicture | null> {
  let bitmap: DecodedBitmap;
  try {
    bitmap = await decodeBitmap(file);
  } catch {
    return null;
  }
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    if (side === 0) return null;
    const canvas = createBitmapCanvas(BOT_PICTURE_PIXELS, BOT_PICTURE_PIXELS);
    const context = canvas.getContext("2d");
    if (context === null) return null;
    context.imageSmoothingQuality = "high";
    context.drawImage(
      bitmap.source,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      BOT_PICTURE_PIXELS,
      BOT_PICTURE_PIXELS,
    );
    const blob = await bitmapCanvasToBlob(canvas, "image/png", 1);
    if (blob === null) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return {
      bytes,
      sha256: hex(await crypto.subtle.digest("SHA-256", bytes)),
    };
  } finally {
    bitmap.close();
  }
}
