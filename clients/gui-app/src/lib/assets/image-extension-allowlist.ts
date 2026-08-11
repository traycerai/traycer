import type { AssetMediaType } from "@traycer/protocol/host/asset-stream-schemas";

/**
 * Single source for the client-side extension gate (image-preview decision
 * log, decision #6): the workspace file tile and git diff tile both check a
 * path against this allowlist BEFORE opening `workspace.streamAsset` /
 * `git.streamFileAsset`, so a non-image file never touches the asset stream.
 * The host still validates independently via magic bytes and answers with
 * the authoritative `mediaType` - this map only decides ROUTING, never what
 * gets rendered as.
 */
const EXTENSION_TO_CANDIDATE_MEDIA_TYPE: Readonly<
  Record<string, AssetMediaType>
> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

/**
 * The media type routing would candidate `path` to, from its extension alone
 * - `null` for anything outside the core five formats. Never trust this as
 * the actual media type: the host's magic-byte check is authoritative and
 * reports `mismatch` when the bytes disagree.
 */
export function candidateImageMediaType(path: string): AssetMediaType | null {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return null;
  const extension = path.slice(dot).toLowerCase();
  return EXTENSION_TO_CANDIDATE_MEDIA_TYPE[extension] ?? null;
}

/** Whether `path`'s extension routes to the image asset stream at all. */
export function isImageAssetPath(path: string): boolean {
  return candidateImageMediaType(path) !== null;
}

/**
 * SVG is text to git and valid UTF-8 to `readFile` (image-preview decision
 * log, decision #5) - both tiles route it to image preview by default with a
 * per-tile toggle back to the existing source view, unlike the other four
 * formats which have no source view at all.
 */
export function isSvgAssetPath(path: string): boolean {
  return candidateImageMediaType(path) === "image/svg+xml";
}
