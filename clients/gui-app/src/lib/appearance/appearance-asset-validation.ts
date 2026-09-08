import { imageSize } from "image-size";
import {
  MAX_APPEARANCE_ICON_BYTES,
  MAX_APPEARANCE_WALLPAPER_BYTES,
  type AppearanceUpload,
} from "@traycer/protocol/host/workspace/appearance-schemas";
import { assertStaticAppearanceImage } from "@traycer/protocol/host/workspace/appearance-image-validation";
import {
  canonicalImageMimeType,
  sniffImageMimeType,
} from "@/lib/composer/prompt-stash-image-signature";
import { decodeBitmap } from "@/lib/images/bitmap-codec";

/** Admission of stored originals, which must already satisfy the output policy. */
export async function validateAppearanceAssetBlob(
  blob: Blob,
  target: AppearanceUpload["target"],
): Promise<void> {
  const maxBytes =
    target === "icon"
      ? MAX_APPEARANCE_ICON_BYTES
      : MAX_APPEARANCE_WALLPAPER_BYTES;
  if (blob.size === 0 || blob.size > maxBytes)
    throw new Error(`Appearance ${target} exceeds its byte limit.`);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const mediaType = sniffImageMimeType(bytes);
  if (
    mediaType === null ||
    mediaType === "image/gif" ||
    mediaType !== canonicalImageMimeType(blob.type)
  ) {
    throw new Error("Appearance images must be PNG, JPEG, or WebP.");
  }
  const { width, height } = imageSize(bytes);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    Math.max(width, height) > (target === "icon" ? 256 : 2560)
  ) {
    throw new Error(`Appearance ${target} exceeds its dimension limit.`);
  }
  assertStaticAppearanceImage(bytes, mediaType);
  const bitmap = await decodeBitmap(blob);
  bitmap.close();
}
