import { imageSize } from "image-size";
import { MAX_APPEARANCE_ICON_BYTES } from "@traycer/protocol/host/workspace/appearance-schemas";
import { assertStaticAppearanceImage } from "@traycer/protocol/host/workspace/appearance-image-validation";
import {
  canonicalImageMimeType,
  sniffImageMimeType,
} from "@/lib/composer/prompt-stash-image-signature";
import { decodeBitmap } from "@/lib/images/bitmap-codec";
import { APPEARANCE_ICON_MAX_EDGE } from "./appearance-image-processing";

/** Admission of stored originals, which must already satisfy the output policy. */
export async function validateAppearanceAssetBlob(blob: Blob): Promise<void> {
  if (blob.size === 0 || blob.size > MAX_APPEARANCE_ICON_BYTES)
    throw new Error("Appearance icon exceeds its byte limit.");
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
    Math.max(width, height) > APPEARANCE_ICON_MAX_EDGE
  ) {
    throw new Error("Appearance icon exceeds its dimension limit.");
  }
  assertStaticAppearanceImage(bytes, mediaType);
  const bitmap = await decodeBitmap(blob);
  bitmap.close();
}
