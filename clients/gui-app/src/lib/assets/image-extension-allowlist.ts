/**
 * Single source for the client-side extension gate (image-preview decision
 * log, decision #6): the workspace file tile and git diff tile both check a
 * path against this allowlist BEFORE opening `workspace.streamAsset` /
 * `git.streamFileAsset`, so a non-image file never touches the asset stream.
 * The host still validates independently via magic bytes and answers with
 * the authoritative `mediaType` - routing only ever needs a boolean here,
 * never a candidate media type to trust.
 */
const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
]);

function extensionOf(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return null;
  return path.slice(dot).toLowerCase();
}

/** Whether `path`'s extension routes to the image asset stream at all. */
export function isImageAssetPath(path: string): boolean {
  const extension = extensionOf(path);
  return extension !== null && IMAGE_EXTENSIONS.has(extension);
}

/**
 * SVG is text to git and valid UTF-8 to `readFile` (image-preview decision
 * log, decision #5) - both tiles route it to image preview by default with a
 * per-tile toggle back to the existing source view, unlike the other four
 * formats which have no source view at all.
 */
export function isSvgAssetPath(path: string): boolean {
  return extensionOf(path) === ".svg";
}
