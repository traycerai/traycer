import type { AppearanceUpload } from "@traycer/protocol/host/workspace/appearance-schemas";
import { isAppearanceAssetMediaType } from "@traycer/protocol/host/workspace/appearance-asset-policy";
import { bytesToBase64 } from "@/lib/composer/image-base64";
import {
  processAppearanceImage,
  type ProcessedAppearanceImage,
} from "./appearance-image-processing";

export interface PreparedAppearanceImage extends ProcessedAppearanceImage {
  readonly hash: string;
  readonly path: string;
  /** Ready to send as-is: the caller does no media-type checking or base64 packing of its own. */
  readonly upload: AppearanceUpload;
}

export async function appearanceContentHash(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await blob.arrayBuffer(),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Always re-encode: persisted originals are static, bounded, and reversible.
 * `processAppearanceImage` owns admission (it validates before it decodes),
 * so this does not validate the input a second time.
 */
export async function prepareAppearanceImage(
  blob: Blob,
  signal: AbortSignal,
): Promise<PreparedAppearanceImage> {
  signal.throwIfAborted();
  const result = await processAppearanceImage(blob, signal);
  signal.throwIfAborted();
  const hash = await appearanceContentHash(result.blob);
  signal.throwIfAborted();
  const mediaType = result.blob.type;
  if (!isAppearanceAssetMediaType(mediaType))
    throw new Error("Encoded appearance image has an unexpected format.");
  const extension = mediaType === "image/webp" ? "webp" : "png";
  const dataBase64 = bytesToBase64(
    new Uint8Array(await result.blob.arrayBuffer()),
  );
  signal.throwIfAborted();
  return {
    ...result,
    hash,
    path: `appearance/${hash}.${extension}`,
    upload: { mediaType, dataBase64 },
  };
}
