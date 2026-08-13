export type ClipboardImageMediaType = "image/png" | "image/jpeg";

// Electron's native clipboard path accepts decoded raster images. SVG stays
// downloadable, while GIF and WebP require a deliberate rasterization step.
export const clipboardImageMediaTypes: ReadonlyArray<ClipboardImageMediaType> =
  ["image/png", "image/jpeg"];

const clipboardImageMediaTypeSet: ReadonlySet<string> = new Set(
  clipboardImageMediaTypes,
);

export function isClipboardImageMediaType(
  value: string | null,
): value is ClipboardImageMediaType {
  return value !== null && clipboardImageMediaTypeSet.has(value);
}
