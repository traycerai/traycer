import {
  processAppearanceImage,
  validateAppearanceImage,
  type ProcessedAppearanceImage,
} from "./appearance-image-processing";

export interface PreparedAppearanceImage extends ProcessedAppearanceImage {
  readonly hash: string;
  readonly path: string;
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

/** Always re-encode: persisted originals are static, bounded, and reversible. */
export async function prepareAppearanceImage(
  blob: Blob,
  signal: AbortSignal,
): Promise<PreparedAppearanceImage> {
  signal.throwIfAborted();
  await validateAppearanceImage(blob);
  const result = await processAppearanceImage(blob, signal);
  signal.throwIfAborted();
  const hash = await appearanceContentHash(result.blob);
  signal.throwIfAborted();
  const extension = result.blob.type === "image/webp" ? "webp" : "png";
  return { ...result, hash, path: `appearance/${hash}.${extension}` };
}
