import { imageSize } from "image-size";
import { assertAppearanceAssetPolicy } from "@traycer/protocol/host/workspace/appearance-asset-policy";
import {
  canonicalImageMimeType,
  sniffImageMimeType,
} from "@/lib/composer/prompt-stash-image-signature";
import { decodeBitmap } from "@/lib/images/bitmap-codec";

/** Admission of stored originals, which must already satisfy the output policy. */
export async function validateAppearanceAssetBlob(blob: Blob): Promise<void> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const mediaType = sniffImageMimeType(bytes);
  // Not an admission check: `blob.type` (not the sniffed type) is what an
  // object URL created from this blob renders as, so a blob whose declared
  // type disagrees with its actual bytes is a trust-boundary problem even
  // once the sniffed bytes pass policy. Keep this even though it looks
  // redundant with the sniff above.
  if (mediaType === null || canonicalImageMimeType(blob.type) !== mediaType)
    throw new Error("Appearance images must be PNG, JPEG, or WebP.");
  const dimensions = imageSize(bytes);
  assertAppearanceAssetPolicy({
    bytes,
    mediaType,
    width: Number.isSafeInteger(dimensions.width) ? dimensions.width : null,
    height: Number.isSafeInteger(dimensions.height) ? dimensions.height : null,
  });
  // Decodability probe only: confirm the browser can actually decode these
  // bytes, then immediately discard the bitmap.
  const bitmap = await decodeBitmap(blob);
  bitmap.close();
}
